// ponte.mjs - A ponte do WhatsApp do DG Claw.
//
// Liga um numero SECUNDARIO do dono ao agente, pelo Baileys (protocolo do WhatsApp Web,
// que NAO e uma API oficial). Contrato completo em docs/CANAL-WHATSAPP.md.
//
//   node ponte.mjs                    modo servico: recebe, filtra pela lista e entrega ao runner;
//                                     atende as tools de resposta pelo socket unix
//   node ponte.mjs --parear <digitos> modo pareamento: pede o codigo e espera o dono digita-lo
//   node ponte.mjs --logout           desconecta o aparelho no WhatsApp e sai
//
// Ambiente: HOME, DGCLAW_RUNNER_URL, DGCLAW_AGENTE_ID (ou o "id" do DGCLAW_RUNNER_JSON),
// RUNNER_TOKEN_FILE (relido a cada envio).
//
// Regras que nao se negociam:
//   - NUNCA vai para o log (nem para lugar nenhum) o corpo de uma mensagem, o codigo de
//     pareamento, o token do runner ou qualquer pedaco da sessao.
//   - Tudo o que a ponte cria nasce 700 (pasta) ou 600 (arquivo).
//   - Quem nao esta em permitidos.json nao recebe resposta nenhuma: nem "voce nao pode".
//     Responder confirmaria a um desconhecido que o numero esta vivo.
//
// So builtins do node + Baileys + pino. Os testes injetam um Baileys falso em iniciar().

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FUSO = 'America/Sao_Paulo';
const LIMITE_MIDIA_ENTRADA = 25 * 1024 * 1024;
const LIMITE_ARQUIVO_SAIDA = 64 * 1024 * 1024;
const LIMITE_LINHA_SOCKET = 64 * 1024;
const LIMITE_TEXTO = 32000;
const GUARDAR_IDS = 500;

// ---------------------------------------------------------------------------
// Numeros
// ---------------------------------------------------------------------------

/**
 * Entrada humana para E.164 com "+". Aceita espaco, traco, parenteses e ponto. Sem "+" e
 * com 10 ou 11 digitos, e Brasil (prefixo 55). Fora de 10 a 15 digitos: null.
 * @param {unknown} entrada
 * @returns {string|null}
 */
export function normalizar(entrada) {
  if (typeof entrada !== 'string' && typeof entrada !== 'number') return null;
  const bruto = String(entrada).trim();
  if (!/^\+?[\d\s().-]+$/.test(bruto)) return null;
  let d = bruto.replace(/\D/g, '');
  if (!bruto.startsWith('+') && (d.length === 10 || d.length === 11)) d = '55' + d;
  if (d.length < 10 || d.length > 15) return null;
  return '+' + d;
}

/**
 * Por que a entrada nao serve, em portugues, para a mensagem de erro ao dono.
 * @param {unknown} entrada
 */
export function motivoNumeroInvalido(entrada) {
  return `o numero "${String(entrada).slice(0, 40)}" nao e valido: use o formato +5511987654321 ` +
    '(DDD e numero; de 10 a 15 digitos no total)';
}

/**
 * Dois numeros sao o mesmo? Alem da igualdade, vale a equivalencia do nono digito do Brasil:
 * 55 + DDD + 9 + 8 digitos e 55 + DDD + os mesmos 8 digitos (contas antigas no WhatsApp).
 */
export function mesmoNumero(a, b) {
  const x = normalizar(a);
  const y = normalizar(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const longo = x.length >= y.length ? x : y;
  const curto = x.length >= y.length ? y : x;
  // "+55" + DDD(2) + 9 + 8 = 14 caracteres; sem o 9 sao 13.
  if (!/^\+55\d{11}$/.test(longo) || !/^\+55\d{10}$/.test(curto)) return false;
  return longo.slice(3, 5) === curto.slice(3, 5) && longo[5] === '9' && longo.slice(6) === curto.slice(5);
}

/** "5511987654321:12@s.whatsapp.net" -> "+5511987654321"; outra coisa -> null. */
function numeroDeJid(jid) {
  if (typeof jid !== 'string') return null;
  const m = /^(\d{8,20})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(jid);
  return m ? '+' + m[1] : null;
}

// ---------------------------------------------------------------------------
// Pequenos utilitarios
// ---------------------------------------------------------------------------

/** Escapa o corpo para nenhum texto de fora fechar o envelope nem forjar um <dgchat>. */
export function escaparCorpo(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function horaLocal(data) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(data);
}

function dataLocal(data) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(data);
}

function numeroDe(x) {
  if (x == null) return NaN;
  if (typeof x === 'object') return Number(x.toString());
  return Number(x);
}

function formatarCodigo(bruto) {
  const c = String(bruto).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function motivoErro(e) {
  return e && e.message ? String(e.message) : String(e);
}

const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

function extensaoDe(mimetype, nomeArquivo) {
  const doNome = nomeArquivo ? path.extname(String(nomeArquivo)).slice(1) : '';
  if (/^[A-Za-z0-9]{1,8}$/.test(doNome)) return doNome.toLowerCase();
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (EXT_POR_MIME[mime]) return EXT_POR_MIME[mime];
  const sub = mime.split('/')[1] || '';
  return /^[a-z0-9]{1,5}$/.test(sub) ? sub : 'bin';
}

// ---------------------------------------------------------------------------
// A ponte
// ---------------------------------------------------------------------------

/**
 * Inicia a ponte. Devolve, depois de a conexao ser disparada, um controle:
 *   concluido          Promise com o codigo de saida (0, 1...), quando a ponte termina
 *   encerrar()         pede para terminar (SIGTERM/SIGINT)
 *   aguardarOciosa()   espera as mensagens em andamento (para os testes)
 *   estado()           estado atual em memoria
 *
 * @param {object} [opcoes]
 */
export async function iniciar(opcoes = {}) {
  // Tudo o que nascer daqui em diante nasce sem permissao para grupo e outros.
  process.umask(0o077);

  const env = process.env;
  const home = opcoes.home || env.HOME || os.homedir();
  const modo = opcoes.modo || 'servico';
  const agora = opcoes.agora || (() => new Date());
  const runnerUrl = (opcoes.runnerUrl || env.DGCLAW_RUNNER_URL || 'http://127.0.0.1:4300').replace(/\/+$/, '');
  const tokenFile = opcoes.tokenFile || env.RUNNER_TOKEN_FILE || '/run/dgclaw/segredos/runner.token';
  const runnerJson = opcoes.runnerJson || env.DGCLAW_RUNNER_JSON || '/etc/dgclaw-runner/runner.json';
  const esperasEntrega = opcoes.esperasEntregaMs || [2000, 5000, 15000];
  const esperaReconInicial = opcoes.esperaReconexaoInicialMs ?? 2000;
  const esperaReconMax = opcoes.esperaReconexaoMaxMs ?? 60000;
  const tempoPareamento = opcoes.tempoPareamentoMs ?? 300000;
  const tempoLogout = opcoes.tempoLogoutMs ?? 30000;
  const timeoutLeitura = opcoes.timeoutLeituraSocketMs ?? 30000;
  const timeoutExecTexto = opcoes.timeoutExecTextoMs ?? 30000;
  const timeoutExecArquivo = opcoes.timeoutExecArquivoMs ?? 120000;
  const saida = opcoes.saida || ((l) => process.stdout.write(l + '\n'));

  const dirDgclaw = path.join(home, '.dgclaw');
  const dir = path.join(dirDgclaw, 'whatsapp');
  const dirSessao = path.join(dir, 'sessao');
  const arqPermitidos = path.join(dir, 'permitidos.json');
  const arqEstado = path.join(dir, 'estado.json');
  const arqCodigo = path.join(dir, 'codigo');
  const arqUltimo = path.join(dir, 'ultimo.json');
  const arqSocket = path.join(dir, 'ponte.sock');
  const dirLogs = path.join(dirDgclaw, 'logs');
  const arqLog = path.join(dirLogs, 'whatsapp.log');
  const dirUploads = path.join(home, 'uploads', 'whatsapp');

  // --- pastas ---------------------------------------------------------------
  for (const d of [dirDgclaw, dir, dirLogs]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // O mkdir nao muda a permissao de pasta que ja existia; o chmod garante.
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(dirLogs, 0o700);

  // --- log --------------------------------------------------------------------
  function registrar(msg) {
    const linha = 'whatsapp: ' + String(msg).replace(/[\r\n]+/g, ' ');
    try {
      const fd = fs.openSync(arqLog, 'a', 0o600);
      fs.writeSync(fd, linha + '\n');
      fs.closeSync(fd);
      fs.chmodSync(arqLog, 0o600);
    } catch (e) {
      // O log em disco falhou; o stdout (journal) ainda leva a informacao, e o motivo vai junto.
      saida(`whatsapp: nao consegui gravar o log ${arqLog}: ${motivoErro(e)}. Confira o espaco em disco e as permissoes da pasta.`);
    }
    saida(linha);
  }

  // --- escrita atomica ------------------------------------------------------------
  function gravarAtomico(arquivo, conteudo) {
    const tmp = `${arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, conteudo, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, arquivo);
  }

  // --- estado ---------------------------------------------------------------------
  let estadoAtual = null;
  let motivoAtual = null;
  let desde = null;
  let numeroBot = null;

  function definirEstado(estado, motivo = null) {
    if (estado === estadoAtual && motivo === motivoAtual) return;
    if (estado !== estadoAtual) desde = agora().toISOString();
    estadoAtual = estado;
    motivoAtual = motivo;
    try {
      gravarAtomico(arqEstado, JSON.stringify({
        versao: 1, estado, desde, numero_bot: numeroBot, motivo,
      }, null, 2) + '\n');
    } catch (e) {
      registrar(`nao consegui gravar ${arqEstado} (estado ${estado}): ${motivoErro(e)}. Confira o espaco em disco e as permissoes de ${dir}.`);
    }
  }

  function numeroDoUser(user) {
    const id = user && user.id ? String(user.id) : '';
    const m = /^(\d{6,20})(?::\d+)?(?:@|$)/.exec(id);
    return m ? '+' + m[1] : null;
  }

  // --- fim ----------------------------------------------------------------------
  let resolverFim;
  const concluido = new Promise((r) => { resolverFim = r; });
  let encerrando = false;
  let sockAtual = null;
  let servidor = null;
  const timers = new Set();
  // Gravacoes de credenciais em andamento. Sair antes de elas terminarem deixaria o celular
  // com o aparelho conectado e o creds.json incompleto: a ponte de servico nao abriria.
  const gravacoesPendentes = new Set();
  const tetoGravacaoMs = opcoes.tetoGravacaoMs ?? 10000;
  const folgaPosPareamento = opcoes.folgaPosPareamentoMs ?? 5000;

  function dormir(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
      timers.add(t);
    });
  }

  function fecharSocketBaileys() {
    const s = sockAtual;
    sockAtual = null;
    if (!s) return;
    try { s.end(undefined); } catch (e) {
      registrar(`erro ao fechar a conexao com o WhatsApp: ${motivoErro(e)}`);
    }
  }

  function finalizar(codigo) {
    if (encerrando) return;
    encerrando = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    fecharSocketBaileys();
    if (servidor) {
      try { servidor.close(); } catch (e) { registrar(`erro ao fechar o socket ${arqSocket}: ${motivoErro(e)}`); }
      servidor = null;
      try {
        if (fs.lstatSync(arqSocket).isSocket()) fs.unlinkSync(arqSocket);
      } catch (e) {
        if (e.code !== 'ENOENT') registrar(`nao consegui apagar ${arqSocket}: ${motivoErro(e)}`);
      }
    }
    // So resolve (e o processo so sai) depois de as credenciais terminarem de ser gravadas.
    let teto;
    const estouro = new Promise((r) => { teto = setTimeout(() => r('estourou'), tetoGravacaoMs); });
    Promise.race([Promise.allSettled([...gravacoesPendentes]), estouro]).then((r) => {
      clearTimeout(teto);
      if (r === 'estourou') {
        registrar(`${gravacoesPendentes.size} gravacao(oes) de credenciais em ${dirSessao} nao terminaram em ${Math.round(tetoGravacaoMs / 1000)} segundos; a sessao pode estar incompleta. Se a ponte nao abrir, rode "dgclaw-agente canal whatsapp desligar --apagar" e pareie de novo.`);
      }
      // Um tick a mais, para o fechamento do servidor assentar antes de o chamador sair.
      setImmediate(() => resolverFim(codigo));
    });
  }

  // --- Baileys ---------------------------------------------------------------------
  let baileys = opcoes.baileys;
  if (!baileys) {
    try {
      baileys = await import('@whiskeysockets/baileys');
    } catch (e) {
      registrar(`nao consegui carregar o Baileys: ${motivoErro(e)}. Rode "npm ci --omit=dev --ignore-scripts" em canais/whatsapp.`);
      definirEstado('erro', 'o Baileys nao esta instalado (rode npm ci em canais/whatsapp)');
      finalizar(1);
      return { concluido, encerrar: () => finalizar(0), aguardarOciosa: async () => {}, estado: () => estadoAtual };
    }
  }
  const criarSocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = baileys;
  const LOGGED_OUT = (DisconnectReason && DisconnectReason.loggedOut) || 401;
  const RESTART_REQUIRED = (DisconnectReason && DisconnectReason.restartRequired) || 515;

  let logger = opcoes.logger;
  if (!logger) {
    const pino = (await import('pino')).default;
    // Silencioso: o logger do Baileys despeja trafego, e nada dele pode vazar para o nosso log.
    logger = pino({ level: 'silent' });
  }

  /** Cria um socket novo com a sessao do disco. Devolve { sock, state }. */
  async function abrirSocket() {
    fs.mkdirSync(dirSessao, { recursive: true, mode: 0o700 });
    fs.chmodSync(dirSessao, 0o700);
    const { state, saveCreds } = await useMultiFileAuthState(dirSessao);
    apertarSessao();
    const sock = criarSocket({
      auth: state,
      logger,
      // O pareamento por codigo exige um navegador "de verdade" na identificacao.
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', () => {
      const p = (async () => {
        try {
          await saveCreds();
          apertarSessao();
        } catch (e) {
          registrar(`nao consegui gravar as credenciais em ${dirSessao}: ${motivoErro(e)}. Confira o espaco em disco; sem isso o pareamento se perde.`);
        }
      })().finally(() => gravacoesPendentes.delete(p));
      gravacoesPendentes.add(p);
    });
    return { sock, state };
  }

  /** As credenciais sao segredo: tudo 600 dentro da pasta da sessao. */
  function apertarSessao() {
    try {
      for (const nome of fs.readdirSync(dirSessao)) {
        const f = path.join(dirSessao, nome);
        const st = fs.lstatSync(f);
        if (st.isFile()) fs.chmodSync(f, 0o600);
      }
    } catch (e) {
      registrar(`nao consegui ajustar as permissoes de ${dirSessao}: ${motivoErro(e)}`);
    }
  }

  // ===========================================================================
  // Mapa LID -> numero (lids.json). O WhatsApp pode entregar o remetente como "123@lid" e nem
  // sempre manda o numero junto; sem este mapa o dono permitido seria recusado como oculto.
  // ===========================================================================
  const arqLids = path.join(dir, 'lids.json');
  const lids = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(arqLids, 'utf8'));
    for (const [lid, n] of Object.entries((j && j.lids) || {})) {
      const norm = normalizar(n);
      if (/@lid$/.test(lid) && norm) lids.set(lid, norm);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') registrar(`o ${arqLids} esta ilegivel (${motivoErro(e)}); o mapa de LID recomeca vazio e se refaz sozinho.`);
  }

  function aprenderLid(lid, numero) {
    const norm = normalizar(numero);
    if (typeof lid !== 'string' || !lid.endsWith('@lid') || !norm) return;
    if (lids.get(lid) === norm) return;
    lids.delete(lid);
    lids.set(lid, norm);
    if (lids.size > 5000) lids.delete(lids.keys().next().value);
    try {
      gravarAtomico(arqLids, JSON.stringify({ versao: 1, lids: Object.fromEntries(lids) }) + '\n');
    } catch (e) {
      registrar(`nao consegui gravar ${arqLids}: ${motivoErro(e)}. O mapa vale so ate a ponte reiniciar.`);
    }
  }

  let sincronizandoLids = false;
  let sincronizarDeNovo = false;
  /** Pergunta ao WhatsApp o LID de cada numero da lista de permitidos. Falha vira linha de log. */
  async function sincronizarLids() {
    const sock = sockAtual;
    if (!sock || !conectado) return;
    if (sincronizandoLids) { sincronizarDeNovo = true; return; }
    sincronizandoLids = true;
    try {
      do {
        sincronizarDeNovo = false;
        for (const numero of lerPermitidos()) {
          try {
            const r = await sock.onWhatsApp(numero.slice(1));
            const achado = Array.isArray(r) ? r.find((x) => x && x.exists !== false && x.lid) : null;
            if (achado) aprenderLid(String(achado.lid).includes('@') ? String(achado.lid) : `${achado.lid}@lid`, numero);
          } catch (e) {
            registrar(`nao consegui perguntar ao WhatsApp o LID de ${numero}: ${motivoErro(e)}. Se ele escrever e for recusado como numero oculto, mande a mensagem de novo depois de a ponte reconectar.`);
          }
        }
      } while (sincronizarDeNovo && !encerrando);
    } finally {
      sincronizandoLids = false;
    }
  }

  function agendarSincronizacaoLids() {
    const p = sincronizarLids()
      .catch((e) => registrar(`erro ao sincronizar os LID: ${motivoErro(e)}`))
      .finally(() => pendentes.delete(p));
    pendentes.add(p);
  }

  // ===========================================================================
  // Lista de permitidos (relida quando o mtime muda)
  // ===========================================================================
  let listaCache = { chave: null, numeros: [] };

  function lerPermitidos() {
    let st;
    try {
      st = fs.statSync(arqPermitidos);
    } catch (e) {
      const chave = 'ausente:' + e.code;
      if (listaCache.chave !== chave) {
        listaCache = { chave, numeros: [] };
        registrar(`a lista de permitidos nao pode ser lida (${arqPermitidos}: ${motivoErro(e)}); ninguem pode falar com o agente. Rode "dgclaw-agente canal whatsapp permitir <numero>".`);
      }
      return listaCache.numeros;
    }
    const chave = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (listaCache.chave === chave) return listaCache.numeros;
    let numeros = [];
    try {
      const j = JSON.parse(fs.readFileSync(arqPermitidos, 'utf8'));
      if (!j || !Array.isArray(j.numeros)) throw new Error('faltou o campo "numeros" (esperado {"versao":1,"numeros":["+5511987654321"]})');
      const invalidos = [];
      for (const n of j.numeros) {
        const norm = normalizar(n);
        if (norm) numeros.push(norm); else invalidos.push(String(n).slice(0, 30));
      }
      if (invalidos.length) {
        registrar(`a lista de permitidos (${arqPermitidos}) tem ${invalidos.length} numero(s) invalido(s) que foram ignorados. Rode "dgclaw-agente canal whatsapp remover <numero>" e permita de novo no formato +5511987654321.`);
      }
    } catch (e) {
      numeros = [];
      registrar(`a lista de permitidos esta ilegivel (${arqPermitidos}: ${motivoErro(e)}); ninguem pode falar com o agente. Rode "dgclaw-agente canal whatsapp permitir <numero>" para refazer.`);
    }
    const mudou = listaCache.chave !== null;
    listaCache = { chave, numeros };
    // Lista nova com a ponte conectada: confere de novo o LID de cada numero.
    if (mudou && conectado && sockAtual) agendarSincronizacaoLids();
    return numeros;
  }

  const estaPermitido = (numero) => lerPermitidos().some((p) => mesmoNumero(p, numero));

  // ===========================================================================
  // Entrada: WhatsApp -> agente
  // ===========================================================================
  const idsVistos = new Set();
  const pendentes = new Set();

  const recusasRecentes = new Map();
  const intervaloRecusa = opcoes.intervaloRecusaMs ?? 600000;
  function deveLogarRecusa(chave) {
    const t = agora().getTime();
    const ultima = recusasRecentes.get(chave);
    if (ultima !== undefined && t - ultima < intervaloRecusa) return false;
    recusasRecentes.delete(chave);
    recusasRecentes.set(chave, t);
    if (recusasRecentes.size > 1000) recusasRecentes.delete(recusasRecentes.keys().next().value);
    return true;
  }

  function jaVisto(id) {
    if (!id) return false;
    if (idsVistos.has(id)) return true;
    idsVistos.add(id);
    if (idsVistos.size > GUARDAR_IDS) idsVistos.delete(idsVistos.values().next().value);
    return false;
  }

  function desembrulhar(m) {
    let atual = m;
    for (let i = 0; i < 4 && atual; i++) {
      const dentro = atual.ephemeralMessage?.message || atual.viewOnceMessage?.message ||
        atual.viewOnceMessageV2?.message || atual.viewOnceMessageV2Extension?.message ||
        atual.documentWithCaptionMessage?.message || atual.editedMessage?.message;
      if (!dentro) break;
      atual = dentro;
    }
    return atual;
  }

  function remetente(key) {
    const jid = key.remoteJid;
    if (typeof jid !== 'string') return null;
    if (jid.endsWith('@lid')) {
      // Em LID o numero de verdade pode vir em outro campo (e entao aprendemos o par), ou estar no
      // mapa que a ponte foi guardando. Sem nenhum dos dois, nao ha como conferir a lista.
      const pn = numeroDeJid(key.senderPn) || numeroDeJid(key.participantPn) || numeroDeJid(key.remoteJidAlt);
      if (pn) { aprenderLid(jid, pn); return pn; }
      return lids.get(jid) || null;
    }
    return numeroDeJid(jid);
  }

  const ROTULO_MIDIA = { imageMessage: 'imagem', audioMessage: 'áudio', videoMessage: 'vídeo', documentMessage: 'documento' };

  async function montarCorpo(msg, conteudo, tipo, id) {
    if (tipo === 'conversation') return String(conteudo.conversation);
    if (tipo === 'extendedTextMessage') return String(conteudo.extendedTextMessage.text || '');
    if (ROTULO_MIDIA[tipo]) {
      const m = conteudo[tipo];
      const rotulo = ROTULO_MIDIA[tipo];
      const legenda = m.caption ? String(m.caption) : '';
      const tamanho = numeroDe(m.fileLength);
      let marca;
      if (Number.isFinite(tamanho) && tamanho > LIMITE_MIDIA_ENTRADA) {
        marca = `[${rotulo} acima de 25 MB, que a ponte não baixa]`;
      } else {
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {});
          if (buf.length > LIMITE_MIDIA_ENTRADA) {
            marca = `[${rotulo} acima de 25 MB, que a ponte não guarda]`;
          } else {
            const pasta = path.join(dirUploads, dataLocal(agora()));
            fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
            const arq = path.join(pasta, `${id}.${extensaoDe(m.mimetype, m.fileName)}`);
            fs.writeFileSync(arq, buf, { mode: 0o600 });
            fs.chmodSync(arq, 0o600);
            marca = `[${rotulo} salvo em ${arq}]`;
          }
        } catch (e) {
          registrar(`nao consegui baixar a midia ${id} (${rotulo}): ${motivoErro(e)}. A mensagem segue sem o arquivo.`);
          marca = `[${rotulo} que a ponte não conseguiu baixar]`;
        }
      }
      return legenda ? `${marca}\n${legenda}` : marca;
    }
    return `[mensagem do tipo ${tipo}, que a ponte ainda não lê]`;
  }

  async function lerTokenEAgente() {
    let token;
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch (e) {
      throw new Error(`nao consegui ler o token do runner em ${tokenFile} (${motivoErro(e)}); confira se o agente esta ligado`);
    }
    if (!token) throw new Error(`o arquivo de token ${tokenFile} esta vazio; reinicie o agente`);
    let id = opcoes.agenteId || env.DGCLAW_AGENTE_ID;
    if (!id) {
      try {
        id = JSON.parse(fs.readFileSync(runnerJson, 'utf8')).id;
      } catch (e) {
        throw new Error(`nao achei o id do agente: DGCLAW_AGENTE_ID nao esta definido e ${runnerJson} nao pôde ser lido (${motivoErro(e)})`);
      }
    }
    if (!id) throw new Error(`o campo "id" falta em ${runnerJson}`);
    return { token, id };
  }

  /** Um POST ao runner. Devolve { ok, definitivo, motivo }. Nunca loga corpo nem token. */
  async function postar(envelope) {
    let credenciais;
    try {
      credenciais = await lerTokenEAgente();
    } catch (e) {
      return { ok: false, definitivo: false, motivo: motivoErro(e) };
    }
    try {
      const r = await fetch(`${runnerUrl}/api/agents/${encodeURIComponent(credenciais.id)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credenciais.token}` },
        body: JSON.stringify({ text: envelope, submit: true, injectWhenIdle: true }),
        signal: AbortSignal.timeout(15000),
      });
      await r.arrayBuffer().catch(() => {});
      if (r.status >= 200 && r.status < 300) return { ok: true };
      if (r.status === 409) {
        return { ok: false, definitivo: true, status: 409, motivo: 'o runner respondeu 409: o agente esta sem login ou sem chave. Abra o painel do DG Claw e entre com a assinatura' };
      }
      if (r.status >= 500) return { ok: false, definitivo: false, motivo: `o runner respondeu ${r.status}` };
      return { ok: false, definitivo: true, status: r.status, motivo: `o runner recusou com ${r.status}` };
    } catch (e) {
      return { ok: false, definitivo: false, motivo: `nao consegui falar com o runner em ${runnerUrl} (${motivoErro(e)})` };
    }
  }

  async function entregar(envelope) {
    let ultimo = null;
    for (let i = 0; i <= esperasEntrega.length; i++) {
      ultimo = await postar(envelope);
      if (ultimo.ok || ultimo.definitivo || encerrando) return ultimo;
      if (i < esperasEntrega.length) await dormir(esperasEntrega[i]);
    }
    return ultimo;
  }

  async function processarMensagem(sock, msg) {
    const key = msg && msg.key;
    if (!key || key.fromMe) return;
    const jid = key.remoteJid;
    if (typeof jid !== 'string') return;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    if (!msg.message) return;
    const conteudo = desembrulhar(msg.message);
    if (!conteudo) return;
    const tipo = Object.keys(conteudo).find((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
    if (!tipo || tipo === 'reactionMessage' || tipo === 'protocolMessage') return;
    const numero = remetente(key);
    if (!numero || !estaPermitido(numero)) {
      // No maximo uma linha por numero a cada 10 minutos: um desconhecido insistente nao
      // enche o log. O id dele tambem nao entra no Set de ids vistos (so aceitos entram).
      if (deveLogarRecusa(numero || 'oculto')) {
        const hora = horaLocal(agora());
        registrar(numero ? `recusado ${numero} às ${hora}` : `recusado (número oculto) às ${hora}`);
      }
      return;
    }
    if (jaVisto(key.id)) return;

    const id = String(key.id || '').replace(/[^A-Za-z0-9_-]/g, '') || 'sem-id';
    const corpo = await montarCorpo(msg, conteudo, tipo, id);
    const seg = numeroDe(msg.messageTimestamp);
    const quando = Number.isFinite(seg) && seg > 0 ? new Date(seg * 1000) : agora();
    const envelope = `<canal-externo origem="whatsapp" de="${numero}" msg="${id}" ts="${quando.toISOString()}">${escaparCorpo(corpo)}</canal-externo>`;

    const r = await entregar(envelope);
    if (!r.ok) {
      registrar(`nao entreguei a mensagem ${id} de ${numero} ao agente: ${r.motivo}`);
      const aviso = r.status === 409
        ? 'Sua mensagem não chegou ao agente: ele está sem login ou sem chave. Avise o dono para abrir o painel do DG Claw.'
        : 'Sua mensagem não chegou ao agente agora. Tente de novo daqui a pouco.';
      try {
        await sock.sendMessage(jid, { text: aviso });
      } catch (e) {
        registrar(`nao consegui avisar ${numero} que a mensagem ${id} falhou: ${motivoErro(e)}`);
      }
      return;
    }
    try {
      gravarAtomico(arqUltimo, JSON.stringify({ numero, ts: agora().toISOString() }) + '\n');
    } catch (e) {
      registrar(`nao consegui gravar ${arqUltimo}: ${motivoErro(e)}. Respostas sem destino explicito podem falhar.`);
    }
    try {
      await sock.readMessages([key]);
    } catch (e) {
      registrar(`nao consegui marcar a mensagem ${id} como lida: ${motivoErro(e)}`);
    }
  }

  function aoReceber(sock, { messages, type }) {
    if (type !== 'notify' || !Array.isArray(messages)) return;
    for (const msg of messages) {
      const p = processarMensagem(sock, msg)
        .catch((e) => registrar(`erro ao tratar uma mensagem recebida: ${motivoErro(e)}`))
        .finally(() => pendentes.delete(p));
      pendentes.add(p);
    }
  }

  // ===========================================================================
  // Saida: agente -> WhatsApp (socket unix)
  // ===========================================================================
  let conectado = false;
  const jids = new Map();

  function falha(codigo, erro) { return { ok: false, codigo, erro }; }

  // Sem "para", so ha destino padrao quando a lista tem exatamente um numero. Com dois ou mais,
  // "quem mandou a ultima mensagem" seria um palpite: uma resposta ao dono podia sair para outra
  // pessoa liberada. O agente passa sempre o "para" do envelope que esta respondendo.
  function destinoPadrao() {
    const lista = lerPermitidos();
    return lista.length === 1 ? lista[0] : null;
  }

  // Lista de PERMITIDAS, nao de proibidas: o arquivo tem que estar na casa do agente e nenhum
  // pedaco do caminho, a partir da raiz, pode comecar com ponto. Isso barra ~/.dgclaw, ~/.claude,
  // ~/.codex, ~/.ssh, ~/.config e qualquer segredo futuro sem precisar lembrar de cada um.
  // So a casa e raiz: nada de pasta em /tmp, que qualquer processo poderia trocar por um atalho.
  // A raiz tem que ser ela mesma (realpath igual ao caminho); raiz que e atalho e recusada.
  const raizesArquivo = opcoes.raizesArquivo || [home];

  function dentroDeRaizPermitida(alvo) {
    return raizesArquivo.some((r) => {
      const rel = path.relative(path.resolve(r), alvo);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      return !rel.split(path.sep).some((parte) => parte.startsWith('.'));
    });
  }

  /**
   * Valida e ABRE o arquivo uma vez so. Devolve { fd, tamanho } (quem chama fecha o fd) ou
   * { erro }. Depois da abertura tudo o que se confere e se le vem do fd, nunca do caminho:
   * trocar o arquivo por um atalho entre a conferencia e a leitura nao muda nada.
   */
  function validarArquivo(caminho) {
    const ondeFica = 'copie o arquivo para uma pasta da sua casa que nao comece com ponto, como ~/saida/, e envie de la';
    const recusa = (msg) => ({ erro: falha('ARQUIVO', msg) });
    if (typeof caminho !== 'string' || !path.isAbsolute(caminho)) {
      return recusa(`o caminho "${String(caminho).slice(0, 80)}" nao e absoluto; informe o caminho completo, como ${home}/saida/relatorio.pdf`);
    }
    for (const r of raizesArquivo) {
      let real;
      try { real = fs.realpathSync(r); } catch { continue; }
      if (real !== path.resolve(r)) {
        return recusa(`a pasta liberada ${r} e um atalho para ${real}; por seguranca nada sai por ela. Avise o dono para conferir quem criou esse atalho`);
      }
    }
    const pedido = path.resolve(caminho);
    let lst;
    let real;
    try {
      lst = fs.lstatSync(pedido);
      real = fs.realpathSync(pedido);
    } catch (e) {
      return recusa(`nao achei o arquivo ${caminho} (${e.code || motivoErro(e)}); confira o caminho`);
    }
    if (!dentroDeRaizPermitida(pedido) || !dentroDeRaizPermitida(real)) {
      return recusa(`${caminho} fica fora das pastas liberadas para envio (a sua casa, sem pastas que comecem com ponto); ${ondeFica}`);
    }
    if (!lst.isFile()) {
      return recusa(`${caminho} nao e um arquivo comum (e pasta, atalho, fila ou dispositivo); envie o arquivo em si`);
    }
    let fd = null;
    try {
      // O_NOFOLLOW: se alguem trocou o arquivo por um atalho agora, a abertura falha.
      fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return recusa(`${caminho} nao e um arquivo comum; envie o arquivo em si`);
      if (st.dev !== lst.dev || st.ino !== lst.ino) {
        return recusa(`${caminho} mudou enquanto era conferido; tente de novo`);
      }
      if (st.nlink > 1) {
        return recusa(`${caminho}: o arquivo tem mais de um nome no disco; copie para ~/saida/ com cp e mande a copia`);
      }
      if (st.size > LIMITE_ARQUIVO_SAIDA) {
        return recusa(`${caminho} tem ${Math.round(st.size / 1048576)} MB e o limite e 64 MB; envie uma versao menor`);
      }
      // Onde o fd aponta de verdade agora (o kernel responde, nao o nome).
      const doFd = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!dentroDeRaizPermitida(doFd)) {
        return recusa(`${caminho} aponta para fora das pastas liberadas; ${ondeFica}`);
      }
      const aberto = fd;
      fd = null;
      return { fd: aberto, tamanho: st.size };
    } catch (e) {
      return recusa(`nao consegui abrir ${caminho} com seguranca (${e.code || motivoErro(e)}); confira se e um arquivo comum da sua casa`);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  async function resolverJid(sock, numero) {
    const chave = numero.replace(/\D/g, '');
    if (jids.has(chave)) return jids.get(chave);
    const r = await sock.onWhatsApp(chave);
    const achado = Array.isArray(r) ? r.find((x) => x && x.exists !== false && x.jid) : null;
    if (!achado) return null;
    jids.set(chave, achado.jid);
    return achado.jid;
  }

  const MIME_AUDIO = { ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
  const MIME_DOC = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip' };

  function montarEnvioArquivo(fd, nomeOriginal, legenda) {
    const buf = fs.readFileSync(fd);
    const ext = path.extname(nomeOriginal).slice(1).toLowerCase();
    const cap = legenda ? { caption: legenda } : {};
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return { image: buf, ...cap };
    if (MIME_AUDIO[ext]) return { audio: buf, mimetype: MIME_AUDIO[ext] };
    if (ext === 'mp4') return { video: buf, ...cap };
    return { document: buf, mimetype: MIME_DOC[ext] || 'application/octet-stream', fileName: path.basename(nomeOriginal), ...cap };
  }

  async function tratarPedido(linha) {
    let p;
    try {
      p = JSON.parse(linha);
    } catch (e) {
      return falha('PEDIDO_INVALIDO', `a linha nao e JSON valido (${motivoErro(e)}); mande uma linha como {"acao":"enviar","texto":"..."}`);
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return falha('PEDIDO_INVALIDO', 'o pedido tem que ser um objeto JSON');
    if (p.acao !== 'enviar' && p.acao !== 'arquivo') {
      return falha('PEDIDO_INVALIDO', `acao "${String(p.acao).slice(0, 30)}" desconhecida; use "enviar" ou "arquivo"`);
    }
    if (p.acao === 'enviar') {
      if (typeof p.texto !== 'string' || !p.texto.trim()) return falha('PEDIDO_INVALIDO', 'o texto esta vazio; escreva a mensagem');
      if (p.texto.length > LIMITE_TEXTO) return falha('PEDIDO_INVALIDO', `o texto tem ${p.texto.length} caracteres e o limite e ${LIMITE_TEXTO}; divida em mensagens menores`);
    } else {
      if (typeof p.caminho !== 'string' || !p.caminho) return falha('PEDIDO_INVALIDO', 'falta o campo "caminho" (caminho absoluto do arquivo)');
      if (p.legenda != null && typeof p.legenda !== 'string') return falha('PEDIDO_INVALIDO', 'a legenda tem que ser texto');
    }

    let numero;
    if (p.para != null && p.para !== '') {
      numero = normalizar(p.para);
      if (!numero) return falha('PEDIDO_INVALIDO', motivoNumeroInvalido(p.para));
      if (!estaPermitido(numero)) {
        return falha('FORA_DA_LISTA', `${numero} nao esta na lista de permitidos; so o dono pode liberar, com "dgclaw-agente canal whatsapp permitir ${numero}"`);
      }
    } else {
      numero = destinoPadrao();
      if (!numero) {
        const n = lerPermitidos().length;
        return falha('SEM_DESTINO', n === 0
          ? 'a lista de permitidos esta vazia; o dono libera um numero com "dgclaw-agente canal whatsapp permitir <numero>"'
          : 'ha mais de um numero na lista; passe em "para" o numero do atributo "de" do envelope que voce esta respondendo');
      }
    }

    let arq = null;
    if (p.acao === 'arquivo') {
      arq = validarArquivo(p.caminho);
      if (arq.erro) return arq.erro;
    }
    // O fd fecha em qualquer saida daqui para baixo (erro, DESCONECTADO, sucesso).
    try {
      const sock = sockAtual;
      if (!conectado || !sock) {
        return falha('DESCONECTADO', 'a ponte nao esta conectada ao WhatsApp agora (reconectando ou deslogada); tente de novo em instantes ou confira "dgclaw-agente canal status"');
      }

      let jid;
      try {
        jid = await resolverJid(sock, numero);
      } catch (e) {
        return falha('FALHA_ENVIO', `nao consegui perguntar ao WhatsApp se ${numero} tem conta (${motivoErro(e)}); tente de novo`);
      }
      if (!jid) return falha('SEM_WHATSAPP', `${numero} nao tem conta no WhatsApp; confira o numero`);

      try {
        const conteudo = p.acao === 'enviar'
          ? { text: p.texto }
          : montarEnvioArquivo(arq.fd, p.caminho, p.legenda);
        const r = await sock.sendMessage(jid, conteudo);
        return { ok: true, para: numero, id: (r && r.key && r.key.id) || null };
      } catch (e) {
        return falha('FALHA_ENVIO', `o WhatsApp recusou o envio para ${numero} (${motivoErro(e)}); tente de novo`);
      }
    } finally {
      if (arq && arq.fd != null) fs.closeSync(arq.fd);
    }
  }

  function subirSocketUnix() {
    return new Promise((resolve, reject) => {
      try {
        const st = fs.lstatSync(arqSocket);
        if (!st.isSocket()) {
          reject(new Error(`${arqSocket} existe e nao e um socket; apague-o a mao ou rode "dgclaw-agente canal whatsapp desligar"`));
          return;
        }
        fs.unlinkSync(arqSocket);
      } catch (e) {
        if (e.code !== 'ENOENT') { reject(e); return; }
      }
      const srv = net.createServer((c) => {
        let buf = Buffer.alloc(0);
        let respondido = false;
        const responder = (obj) => {
          if (respondido) return;
          respondido = true;
          clearTimeout(timeout);
          c.end(JSON.stringify(obj) + '\n');
        };
        // Prazo para o cliente mandar a linha. Cai assim que a linha chega; a execucao do
        // pedido tem prazo proprio, maior (enviar arquivo grande demora).
        const timeout = setTimeout(() => {
          responder(falha('PEDIDO_INVALIDO', `a conexao ficou ${Math.round(timeoutLeitura / 1000)} segundos sem mandar a linha do pedido`));
        }, timeoutLeitura);
        timeout.unref();
        let timeoutExec = null;
        const tratar = (bytes) => {
          clearTimeout(timeout);
          const linha = bytes.toString('utf8').trim();
          let acao = null;
          try { acao = JSON.parse(linha).acao; } catch { /* o tratarPedido explica a linha invalida */ }
          const limite = acao === 'arquivo' ? timeoutExecArquivo : timeoutExecTexto;
          const estouro = new Promise((r) => {
            timeoutExec = setTimeout(() => r(falha('FALHA_ENVIO', `o envio passou de ${Math.round(limite / 1000)} segundos sem resposta; a mensagem pode ou nao ter saido. Nao repita as cegas: confira no celular antes de mandar de novo`)), limite);
          });
          Promise.race([
            tratarPedido(linha).catch((e) => {
              registrar(`erro inesperado ao tratar um pedido do socket: ${motivoErro(e)}`);
              return falha('FALHA_ENVIO', `erro inesperado na ponte (${motivoErro(e)}); veja ${arqLog}`);
            }),
            estouro,
          ]).then((r) => { clearTimeout(timeoutExec); responder(r); });
        };
        let recebido = false;
        c.on('data', (parte) => {
          if (respondido || recebido) return;
          buf = Buffer.concat([buf, parte]);
          const nl = buf.indexOf(0x0a);
          if (nl >= 0) { recebido = true; tratar(buf.subarray(0, nl)); return; }
          if (buf.length > LIMITE_LINHA_SOCKET) {
            responder(falha('PEDIDO_INVALIDO', `a linha passou de ${LIMITE_LINHA_SOCKET} bytes; para arquivos use a acao "arquivo" com o caminho`));
          }
        });
        c.on('end', () => {
          // Cliente que fechou sem enviar "\n": trata o que veio.
          if (respondido || recebido) return;
          if (buf.length > 0) { recebido = true; tratar(buf); } else {
            responder(falha('PEDIDO_INVALIDO', 'a conexao fechou sem mandar nenhum pedido'));
          }
        });
        c.on('error', (e) => registrar(`erro numa conexao do socket ${arqSocket}: ${motivoErro(e)}`));
      });
      srv.once('error', reject);
      srv.listen(arqSocket, () => {
        try {
          fs.chmodSync(arqSocket, 0o600);
        } catch (e) {
          srv.close();
          reject(new Error(`nao consegui fechar a permissao de ${arqSocket} (${motivoErro(e)})`));
          return;
        }
        servidor = srv;
        resolve();
      });
    });
  }

  // ===========================================================================
  // Conexao
  // ===========================================================================
  let geracao = 0;

  /** Laco de reconexao comum aos tres modos. `aoAbrir` e `aoQr` variam por modo. */
  async function conectar({ aoAbrir, aoQr, aoFechar }) {
    let espera = esperaReconInicial;
    while (!encerrando) {
      const minha = ++geracao;
      let aberto = false;
      let fechou;
      const fim = new Promise((r) => { fechou = r; });
      let sock;
      let state;
      try {
        ({ sock, state } = await abrirSocket());
      } catch (e) {
        registrar(`nao consegui abrir a sessao em ${dirSessao}: ${motivoErro(e)}. Confira as permissoes da pasta.`);
        definirEstado('erro', `nao consegui abrir a sessao (${motivoErro(e)})`);
        finalizar(1);
        return;
      }
      sockAtual = sock;
      if (opcoes.aoCriarSocket) opcoes.aoCriarSocket(sock);
      sock.ev.on('chats.phoneNumberShare', (d) => {
        if (minha === geracao && modo === 'servico' && d) aprenderLid(d.lid, numeroDeJid(d.jid));
      });
      sock.ev.on('messages.upsert', (u) => { if (minha === geracao && modo === 'servico') aoReceber(sock, u); });
      sock.ev.on('connection.update', async (u) => {
        if (minha !== geracao || encerrando) return;
        try {
          if (u.qr && aoQr) await aoQr(sock, state);
          if (u.connection === 'open') {
            aberto = true;
            espera = esperaReconInicial;
            await aoAbrir(sock, state);
          }
          if (u.connection === 'close') {
            conectado = false;
            const codigo = u.lastDisconnect?.error?.output?.statusCode ?? u.lastDisconnect?.error?.statusCode ?? null;
            fechou({ codigo, erro: u.lastDisconnect?.error });
          }
        } catch (e) {
          registrar(`erro ao tratar um evento de conexao: ${motivoErro(e)}`);
        }
      });
      const { codigo, erro } = await fim;
      if (minha !== geracao || encerrando) return;
      const decisao = await aoFechar({ codigo, erro, aberto });
      if (decisao === 'parar' || encerrando) return;
      if (decisao === 'imediato') { continue; }
      await dormir(espera);
      espera = Math.min(esperaReconMax, espera * 2);
    }
  }

  // --- modo servico ----------------------------------------------------------------
  async function modoServico() {
    {
      const { state } = await abrirSocketSoLeitura();
      if (!state.creds || !state.creds.registered) {
        registrar('a ponte ainda nao foi pareada: nao ha sessao em ' + dirSessao + '. Rode "dgclaw-agente canal whatsapp parear <numero-secundario>".');
        definirEstado('erro', 'ainda não pareado');
        finalizar(0);
        return;
      }
      numeroBot = numeroDoUser(state.creds.me);
    }
    try {
      await subirSocketUnix();
    } catch (e) {
      registrar(`nao consegui abrir o socket ${arqSocket}: ${motivoErro(e)}`);
      definirEstado('erro', `nao consegui abrir o socket (${motivoErro(e)})`);
      finalizar(1);
      return;
    }
    definirEstado('reconectando', null);
    await conectar({
      aoAbrir: async (sock) => {
        conectado = true;
        agendarSincronizacaoLids();
        numeroBot = numeroDoUser(sock.user) || numeroBot;
        definirEstado('conectado', null);
        registrar('conectado ao WhatsApp' + (numeroBot ? ` como ${numeroBot}` : ''));
      },
      aoFechar: async ({ codigo }) => {
        if (codigo === LOGGED_OUT) {
          registrar('o WhatsApp encerrou este aparelho (401). Pareie de novo com "dgclaw-agente canal whatsapp parear <numero-secundario>".');
          definirEstado('deslogado', 'o WhatsApp encerrou o aparelho; é preciso parear de novo');
          finalizar(0);
          return 'parar';
        }
        registrar(`conexao caiu (codigo ${codigo ?? 'desconhecido'}); reconectando`);
        definirEstado('reconectando', `conexão caiu (código ${codigo ?? 'desconhecido'})`);
        return codigo === RESTART_REQUIRED ? 'imediato' : 'esperar';
      },
    });
  }

  /** Le a sessao do disco sem abrir conexao, so para saber se ja foi pareada. */
  async function abrirSocketSoLeitura() {
    fs.mkdirSync(dirSessao, { recursive: true, mode: 0o700 });
    fs.chmodSync(dirSessao, 0o700);
    const r = await useMultiFileAuthState(dirSessao);
    apertarSessao();
    return r;
  }

  // --- modo pareamento ------------------------------------------------------------
  async function modoParear() {
    const norm = normalizar(opcoes.numeroParear);
    if (!norm) {
      registrar(`${motivoNumeroInvalido(opcoes.numeroParear)}. Rode de novo com o numero do chip secundario.`);
      definirEstado('erro', 'número inválido para o pareamento');
      finalizar(2);
      return;
    }
    const digitos = norm.slice(1);
    {
      const { state } = await abrirSocketSoLeitura();
      if (state.creds && state.creds.registered) {
        // Nao mexe no estado.json: ele descreve uma ponte que funciona.
        registrar('este agente ja esta pareado; para trocar de numero rode "dgclaw-agente canal whatsapp desligar --apagar" e pareie de novo.');
        finalizar(1);
        return;
      }
    }
    definirEstado('aguardando_codigo', null);
    const expirar = setTimeout(() => {
      timers.delete(expirar);
      apagarCodigo();
      registrar('o codigo de pareamento expirou sem ser digitado; rode o pareamento de novo.');
      definirEstado('erro', 'o código expirou');
      finalizar(1);
    }, tempoPareamento);
    timers.add(expirar);

    let pediu = false;
    await conectar({
      aoQr: async (sock, state) => {
        if (pediu || state.creds.registered) return;
        pediu = true;
        try {
          const bruto = await sock.requestPairingCode(digitos);
          gravarAtomico(arqCodigo, formatarCodigo(bruto) + '\n');
          definirEstado('codigo_pronto', null);
          registrar('codigo de pareamento pronto; digite-o no WhatsApp do numero secundario.');
        } catch (e) {
          registrar(`o WhatsApp nao deu o codigo de pareamento para +${digitos}: ${motivoErro(e)}. Confira o numero e tente de novo.`);
          apagarCodigo();
          definirEstado('erro', `não consegui o código de pareamento (${motivoErro(e)})`);
          finalizar(1);
        }
      },
      aoAbrir: async (sock) => {
        numeroBot = numeroDoUser(sock.user);
        // Folga com a conexao ainda aberta: logo depois do 'open' o WhatsApp manda as ultimas
        // atualizacoes de credencial, e fechar na hora as perderia.
        if (folgaPosPareamento > 0) await dormir(folgaPosPareamento);
        if (encerrando) return;
        apagarCodigo();
        definirEstado('pareado', null);
        registrar('pareamento concluido' + (numeroBot ? ` (${numeroBot})` : ''));
        // Nunca logout aqui: derrubaria o aparelho que acabou de ser conectado.
        finalizar(0);
      },
      aoFechar: async ({ codigo }) => {
        if (codigo === RESTART_REQUIRED) return 'imediato';
        if (codigo === LOGGED_OUT) {
          apagarCodigo();
          registrar('o WhatsApp recusou o pareamento (401). Tente de novo.');
          definirEstado('erro', 'o WhatsApp recusou o pareamento');
          finalizar(1);
          return 'parar';
        }
        pediu = false;
        return 'esperar';
      },
    });
  }

  function apagarCodigo() {
    try {
      fs.unlinkSync(arqCodigo);
    } catch (e) {
      if (e.code !== 'ENOENT') registrar(`nao consegui apagar ${arqCodigo}: ${motivoErro(e)}; apague-o a mao, ele ja nao vale.`);
    }
  }

  // --- modo logout ------------------------------------------------------------------
  async function modoLogout() {
    const { state } = await abrirSocketSoLeitura();
    if (!state.creds || !state.creds.registered) {
      registrar('nao ha sessao pareada; nada para desconectar no WhatsApp.');
      finalizar(0);
      return;
    }
    const limite = setTimeout(() => {
      timers.delete(limite);
      registrar(`o logout passou de ${Math.round(tempoLogout / 1000)} segundos sem concluir; o aparelho pode continuar na lista do celular (Aparelhos conectados).`);
      finalizar(1);
    }, tempoLogout);
    timers.add(limite);
    await conectar({
      aoAbrir: async (sock) => {
        try {
          await sock.logout();
          registrar('aparelho desconectado no WhatsApp.');
          finalizar(0);
        } catch (e) {
          registrar(`o logout falhou: ${motivoErro(e)}. O aparelho pode continuar na lista do celular (Aparelhos conectados).`);
          finalizar(1);
        }
      },
      aoFechar: async ({ codigo }) => {
        if (codigo === LOGGED_OUT) {
          registrar('o aparelho ja estava desconectado no WhatsApp.');
          finalizar(0);
          return 'parar';
        }
        return codigo === RESTART_REQUIRED ? 'imediato' : 'esperar';
      },
    });
  }

  // --- parte ----------------------------------------------------------------------
  const rodar = modo === 'parear' ? modoParear : modo === 'logout' ? modoLogout : modoServico;
  rodar().catch((e) => {
    registrar(`a ponte parou por um erro inesperado: ${motivoErro(e)}. Veja ${arqLog} e rode de novo.`);
    try { definirEstado('erro', `erro inesperado (${motivoErro(e)})`); } catch { /* ja registrado acima */ }
    finalizar(1);
  });

  return {
    concluido,
    encerrar: () => finalizar(0),
    aguardarOciosa: async () => { while (pendentes.size) await Promise.allSettled([...pendentes]); },
    estado: () => estadoAtual,
  };
}

// ---------------------------------------------------------------------------
// Execucao direta
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opcoes = { modo: 'servico' };
  if (args[0] === '--parear') {
    opcoes.modo = 'parear';
    opcoes.numeroParear = args[1];
    if (!args[1]) {
      console.error('whatsapp: falta o numero. Uso: node ponte.mjs --parear <digitos do numero secundario>');
      process.exit(2);
    }
  } else if (args[0] === '--logout') {
    opcoes.modo = 'logout';
  } else if (args.length) {
    console.error(`whatsapp: argumento "${args[0]}" desconhecido. Uso: node ponte.mjs [--parear <digitos> | --logout]`);
    process.exit(2);
  }
  const ponte = await iniciar(opcoes);
  const sair = () => ponte.encerrar();
  process.on('SIGTERM', sair);
  process.on('SIGINT', sair);
  process.exit(await ponte.concluido);
}
