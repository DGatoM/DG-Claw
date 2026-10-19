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
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarEntrada } from './lib/entrada.mjs';
import { criarEntregaRunner } from './lib/entrega-runner.mjs';
import { criarEnvioArquivo } from './lib/envio-arquivo.mjs';
import { criarLids } from './lib/lids.mjs';
import { motivoNumeroInvalido, normalizar, numeroDeJid } from './lib/numeros.mjs';
import { criarPedidos } from './lib/pedidos.mjs';
import { criarPermitidos } from './lib/permitidos.mjs';
import { subirSocketUnix } from './lib/servidor-unix.mjs';
import { formatarCodigo, motivoErro } from './lib/util.mjs';

// A API que os testes e os outros arquivos importam daqui.
export { mesmoNumero, motivoNumeroInvalido, normalizar } from './lib/numeros.mjs';
export { escaparCorpo } from './lib/util.mjs';


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
  // Pecas da ponte (lib/): cada uma recebe so o que usa
  // ===========================================================================
  const pendentes = new Set();
  let conectado = false;

  const { lerPermitidos, estaPermitido } = criarPermitidos({
    arqPermitidos,
    registrar,
    // Lista nova com a ponte conectada: confere de novo o LID de cada numero.
    aoMudarLista: () => { if (conectado && sockAtual) agendarSincronizacaoLids(); },
  });
  const { lids, aprenderLid, agendarSincronizacaoLids } = criarLids({
    dir,
    registrar,
    gravarAtomico,
    lerPermitidos,
    obterSocketConectado: () => (conectado ? sockAtual : null),
    estaEncerrando: () => encerrando,
    pendentes,
  });
  const { entregar } = criarEntregaRunner({
    opcoes, env, runnerUrl, tokenFile, runnerJson, esperasEntrega, dormir, estaEncerrando: () => encerrando,
  });
  const { aoReceber } = criarEntrada({
    opcoes, registrar, agora, lids, aprenderLid, estaPermitido, entregar, gravarAtomico,
    arqUltimo, dirUploads, downloadMediaMessage, pendentes,
  });
  const raizesArquivo = opcoes.raizesArquivo || [home];
  const { validarArquivo, montarEnvioArquivo } = criarEnvioArquivo({ home, raizesArquivo });
  const { tratarPedido } = criarPedidos({
    lerPermitidos,
    estaPermitido,
    validarArquivo,
    montarEnvioArquivo,
    ligacao: () => ({ conectado, sock: sockAtual }),
  });
  const abrirServidorUnix = () => subirSocketUnix({
    arqSocket, arqLog, timeoutLeitura, timeoutExecTexto, timeoutExecArquivo, tratarPedido, registrar,
    aoSubir: (srv) => { servidor = srv; },
  });

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
      await abrirServidorUnix();
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
