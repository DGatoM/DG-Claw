'use strict';
// Auditoria externa (nível regulado): cada linha da corrente também sai da VPS, para um destino da empresa.
//
// Destino, em /etc/dgclaw/auditoria-externa.json (600):
//   { "tipo": "http",   "url": "https://siem.empresa.com/coletor", "token": "...", "timeout_s": 10 }
//   { "tipo": "syslog", "host": "logs.empresa.com", "porta": 6514, "ca": "/etc/dgclaw/ca-logs.pem" }   (RFC 5425, TLS)
// O token fica só no arquivo: não aparece em log, em status nem em argv.
//
// A fila é o próprio arquivo de auditoria: o estado (auditoria-externa-estado.json, na pasta de dados do Web) guarda
// o hash da última linha já entregue, e tudo que vem depois dela está pendente. Nada é copiado para outro arquivo,
// então não existe fila que possa se perder ou divergir da corrente. Falhou? O ponto não anda, e o próximo envio
// recomeça dali. Pendente há mais de 1 hora é alerta (o monitor do bloco F lê o estado: lib/enterprise/auditoria-cli.sh).
//
// Selo: a cada hora o hash da última linha da corrente é enviado também como "selo". Quem recebe guarda os selos; se o
// arquivo local for reescrito depois, a corrente não produz mais o hash que o destino guardou, e a diferença aparece.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const os = require('node:os');
const { gravaArquivoSeguro } = require('./grava-seguro');
const corrente = require('./auditoria-corrente');

const LOTE = 100;
const MAX_LOTES_POR_RODADA = 50;
const SELO_A_CADA_MS = 60 * 60 * 1000;
const ALERTA_APOS_MS = 60 * 60 * 1000;
const TIMEOUT_PADRAO_S = 10;
const TRAVA_VELHA_MS = 5 * 60 * 1000;
const PRI_SYSLOG = 13 * 8 + 6;   // facility "log audit", severidade informativa

class ErroExterna extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroExterna';
  }
}

/** Valida a configuração do destino. Lança ErroExterna dizendo o que corrigir. */
function validarConfig(bruto, opcoes) {
  const o = opcoes || {};
  const c = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : null;
  if (!c) throw new ErroExterna('O auditoria-externa.json precisa ser um objeto JSON com "tipo" (http ou syslog). Refaça com: dgclaw auditoria externa configurar');
  const tipo = String(c.tipo || '').toLowerCase();
  const timeout = c.timeout_s == null ? TIMEOUT_PADRAO_S : Number(c.timeout_s);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) throw new ErroExterna('timeout_s precisa estar entre 1 e 120 segundos.');
  if (tipo === 'http') {
    let u;
    try { u = new URL(String(c.url || '')); } catch (_) { throw new ErroExterna(`A url do coletor ${JSON.stringify(String(c.url || '').slice(0, 120))} não é um endereço válido. Exemplo: https://siem.empresa.com/coletor`); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(o.aceitaSemTls && u.protocol === 'http:' && loopback)) throw new ErroExterna(`O coletor ${u.origin} precisa ser https://. A trilha de auditoria não sai da VPS em texto aberto.`);
    return { tipo, url: u.href, token: c.token ? String(c.token) : '', timeout_s: timeout };
  }
  if (tipo === 'syslog') {
    const host = String(c.host || '').trim();
    if (!host) throw new ErroExterna('Falta o host do servidor syslog. Exemplo: logs.empresa.com');
    const porta = c.porta == null ? 6514 : Number(c.porta);
    if (!Number.isInteger(porta) || porta < 1 || porta > 65535) throw new ErroExterna(`A porta ${JSON.stringify(c.porta)} não é válida (1 a 65535). A porta padrão do syslog sobre TLS é 6514.`);
    const semTls = c.tls === false;
    if (semTls && !o.aceitaSemTls) throw new ErroExterna('O syslog sem TLS não é aceito: a trilha de auditoria não sai da VPS em texto aberto. Use um servidor com TLS (RFC 5425), normalmente na porta 6514.');
    return { tipo, host, porta, tls: !semTls, ca: c.ca ? String(c.ca) : '', timeout_s: timeout };
  }
  throw new ErroExterna(`O tipo de destino ${JSON.stringify(String(c.tipo || '').slice(0, 20))} não existe. Use http ou syslog.`);
}

function lerConfig(caminho, opcoes) {
  const log = (opcoes && opcoes.log) || (() => {});
  let st;
  try { st = fs.statSync(caminho); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ErroExterna(`Não consegui ler ${caminho} (${e.code || e.message}). Confira a permissão do arquivo.`);
  }
  if (st.mode & 0o077) log('aviso', `${caminho} está com modo ${(st.mode & 0o777).toString(8)} e pode guardar o token do coletor. Rode: chmod 600 ${caminho}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (e) {
    throw new ErroExterna(`${caminho} não é um JSON válido (${e.message}). Refaça com: dgclaw auditoria externa configurar`);
  }
  try { return validarConfig(j, opcoes); } catch (e) {
    if (e instanceof ErroExterna) throw new ErroExterna(`${caminho}: ${e.message}`);
    throw e;
  }
}

function gravarConfig(caminho, bruto, opcoes) {
  const cfg = validarConfig(bruto, opcoes);
  gravaArquivoSeguro(caminho, `${JSON.stringify(cfg, null, 2)}\n`, { raiz: path.dirname(caminho), modo: 0o600 });
  return cfg;
}

/** Descrição do destino sem o token. */
function destinoPublico(cfg) {
  if (!cfg) return null;
  if (cfg.tipo === 'http') { const u = new URL(cfg.url); return `${u.origin}${u.pathname}`; }
  return `${cfg.host}:${cfg.porta}${cfg.tls ? ' (TLS)' : ' (sem TLS, só laboratório)'}`;
}

function criarExterna(opcoes) {
  const o = opcoes;
  const { base, dataDir, caminhoConfig } = o;
  const log = o.log || (() => {});
  const agora = o.agora || Date.now;
  const buscar = o.fetch || fetch;
  const estadoPath = path.join(dataDir, 'auditoria-externa-estado.json');
  const instalacao = o.instalacao || os.hostname();
  const optsConfig = { log, aceitaSemTls: !!o.aceitaSemTls };

  function lerEstado() {
    try { return JSON.parse(fs.readFileSync(estadoPath, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new ErroExterna(`Não consegui ler o estado do envio externo ${estadoPath} (${e.code || e.message}). Apague-o para recomeçar o envio do início (o destino recebe linhas repetidas, que ele deve ignorar pelo hash).`);
    }
  }
  function gravarEstado(est) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    gravaArquivoSeguro(estadoPath, `${JSON.stringify(Object.assign({}, est, { atualizado_em: new Date(agora()).toISOString() }), null, 2)}\n`, { raiz: dataDir, modo: 0o600 });
  }

  /** As linhas ainda não entregues: [{ texto, obj, arquivo, indice }] e o aviso de corrente alterada, se for o caso. */
  function pendentes(estado, maximo) {
    const arquivos = corrente.arquivosDaCorrente(base);
    const lista = [];
    let comecaEm = { i: 0, linha: 0 };
    let achou = !estado.hash;
    const texto = new Map();
    const linhasDe = (a) => {
      if (!texto.has(a.caminho)) texto.set(a.caminho, fs.readFileSync(a.caminho, 'utf8').split('\n').filter(Boolean));
      return texto.get(a.caminho);
    };
    if (estado.hash) {
      const tentativa = arquivos.findIndex((a) => a.nome === estado.arquivo);
      const confere = (ls, n) => n >= 1 && n <= ls.length && corrente.RX_HASH.exec(ls[n - 1]) && corrente.RX_HASH.exec(ls[n - 1])[1] === estado.hash;
      if (tentativa >= 0 && confere(linhasDe(arquivos[tentativa]), estado.linhas)) {
        comecaEm = { i: tentativa, linha: estado.linhas }; achou = true;
      } else {
        // o arquivo vivo foi fechado no virar do mês (mudou de nome): procura o hash nos arquivos
        for (let i = 0; i < arquivos.length && !achou; i += 1) {
          const ls = linhasDe(arquivos[i]);
          const n = ls.findIndex((l) => { const m = corrente.RX_HASH.exec(l); return m && m[1] === estado.hash; });
          if (n >= 0) { comecaEm = { i, linha: n + 1 }; achou = true; }
        }
      }
    }
    if (!achou) return { lista: [], alterada: `a linha de hash ${String(estado.hash).slice(0, 12)}…, que já foi entregue, não existe mais na corrente local` };
    let primeiroDoArquivo = true;
    for (let i = comecaEm.i; i < arquivos.length; i += 1) {
      const ls = linhasDe(arquivos[i]);
      for (let n = primeiroDoArquivo ? comecaEm.linha : 0; n < ls.length; n += 1) {
        let obj;
        try { obj = JSON.parse(ls[n]); } catch (_) { return { lista, alterada: `a linha ${n + 1} de ${arquivos[i].nome} não é JSON válido; rode: dgclaw auditoria verificar` }; }
        lista.push({ texto: ls[n], obj, arquivo: arquivos[i].nome, indice: n + 1 });
        if (maximo && lista.length >= maximo) return { lista, mais: true };
      }
      primeiroDoArquivo = false;
    }
    return { lista };
  }

  // ── envio ──────────────────────────────────────────────────────────────
  async function enviarHttp(cfg, corpo) {
    const cab = { 'Content-Type': 'application/json', 'User-Agent': 'dgclaw-auditoria' };
    if (cfg.token) cab.Authorization = `Bearer ${cfg.token}`;
    let r;
    try {
      r = await buscar(cfg.url, { method: 'POST', headers: cab, body: JSON.stringify(corpo), signal: AbortSignal.timeout(cfg.timeout_s * 1000), redirect: 'error' });
    } catch (e) {
      throw new ErroExterna(`Não consegui entregar ao coletor ${destinoPublico(cfg)}: ${e.cause && e.cause.code ? e.cause.code : e.message}. Confira o endereço, o firewall e o certificado do coletor.`);
    }
    if (!r.ok) throw new ErroExterna(`O coletor ${destinoPublico(cfg)} respondeu ${r.status} ${String(r.statusText || '').slice(0, 40)}. Confira o token e a regra de entrada do coletor.`);
  }

  function enviarSyslog(cfg, mensagens) {
    return new Promise((resolve, reject) => {
      const fim = (erro) => { clearTimeout(t); sock.destroy(); if (erro) reject(erro); else resolve(); };
      const conectado = () => {
        // enquadramento por contagem de octetos (RFC 6587, usado pela RFC 5425): "<tamanho> <mensagem>"
        const quadros = mensagens.map((m) => { const b = Buffer.from(m, 'utf8'); return Buffer.concat([Buffer.from(`${b.length} `), b]); });
        sock.write(Buffer.concat(quadros), (e) => {
          if (e) return fim(new ErroExterna(`Não consegui escrever no syslog ${destinoPublico(cfg)}: ${e.code || e.message}.`));
          // fecha com FIN e espera o outro lado fechar: só assim sabemos que tudo foi lido
          sock.end();
          return undefined;
        });
      };
      let sock;
      let ca;
      if (cfg.tls && cfg.ca) {
        try { ca = fs.readFileSync(cfg.ca); } catch (e) { reject(new ErroExterna(`Não consegui ler o certificado da autoridade do syslog (${cfg.ca}): ${e.code || e.message}.`)); return; }
      }
      const t = setTimeout(() => fim(new ErroExterna(`O syslog ${destinoPublico(cfg)} não respondeu em ${cfg.timeout_s} s.`)), cfg.timeout_s * 1000);
      if (cfg.tls) sock = tls.connect({ host: cfg.host, port: cfg.porta, servername: net.isIP(cfg.host) ? undefined : cfg.host, ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, conectado);
      else sock = net.connect({ host: cfg.host, port: cfg.porta }, conectado);
      sock.on('error', (e) => fim(new ErroExterna(`Não consegui falar com o syslog ${destinoPublico(cfg)}: ${e.code || e.message}. ${cfg.tls ? 'Confira o certificado do servidor (e "ca" no auditoria-externa.json, se ele for de uma autoridade própria), o nome e a porta.' : 'Confira o nome e a porta.'}`)));
      sock.on('close', () => fim(null));
      sock.resume();
    });
  }

  const rfc5424 = (msgid, dados, texto) => `<${PRI_SYSLOG}>1 ${new Date(agora()).toISOString()} ${instalacao.replace(/[^\x21-\x7e]/g, '-').slice(0, 255) || '-'} dgclaw - ${msgid} [dgclaw@32473 ${dados}] ${texto}`;

  async function entregar(cfg, tipo, itens) {
    if (cfg.tipo === 'http') {
      await enviarHttp(cfg, tipo === 'selo'
        ? { tipo: 'selo', instalacao, selo: itens }
        : { tipo: 'auditoria', instalacao, eventos: itens.map((l) => l.obj), brutas: itens.map((l) => l.texto) });
    } else if (tipo === 'selo') {
      await enviarSyslog(cfg, [rfc5424('SELO', `hash="${itens.hash}"`, JSON.stringify(Object.assign({ tipo: 'selo', instalacao }, itens)))]);
    } else {
      await enviarSyslog(cfg, itens.map((l) => rfc5424('AUDITORIA', `hash="${l.obj.hash}" evento="${String(l.obj.evento).replace(/["\]\\]/g, '_')}"`, l.texto)));
    }
  }

  let travaDentro = false;
  function pegarTrava() {
    const trava = `${estadoPath}.trava`;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (let tentativa = 0; tentativa < 2; tentativa += 1) {
      try { fs.mkdirSync(trava); return trava; } catch (e) {
        if (e.code !== 'EEXIST') throw new ErroExterna(`Não consegui criar a trava do envio externo ${trava} (${e.code || e.message}).`);
        let idade = 0;
        try { idade = Date.now() - fs.statSync(trava).mtimeMs; } catch (_) { continue; }
        if (idade <= TRAVA_VELHA_MS) return null;
        log('aviso', `A trava ${trava} tinha ${Math.round(idade / 1000)} s; o envio que a criou provavelmente morreu. Estou removendo e seguindo.`);
        try { fs.rmdirSync(trava); } catch (e2) { if (e2.code !== 'ENOENT') throw e2; }
      }
    }
    return null;
  }

  /**
   * Entrega o que está pendente (até MAX_LOTES_POR_RODADA lotes) e, se passou 1 h, o selo.
   * Devolve { enviadas, selo, erro, pendentes }. Nunca lança por falha de rede: o erro vai no resultado e no estado.
   */
  async function enviar() {
    if (travaDentro) return { enviadas: 0, selo: false, ocupado: true };
    const cfg = lerConfig(caminhoConfig, optsConfig);
    if (!cfg) return { enviadas: 0, selo: false, erro: `Falta o destino externo: ${caminhoConfig}. Configure com: dgclaw auditoria externa configurar` };
    travaDentro = true;
    const trava = pegarTrava();
    if (!trava) { travaDentro = false; return { enviadas: 0, selo: false, ocupado: true }; }
    try {
      const estado = lerEstado();
      let enviadas = 0;
      let seloEnviado = false;
      let erro = null;
      for (let lote = 0; lote < MAX_LOTES_POR_RODADA; lote += 1) {
        const p = pendentes(estado, LOTE);
        if (p.alterada) { erro = `A corrente local mudou atrás do ponto já entregue: ${p.alterada}. Isto pode ser adulteração; investigue antes de reenviar (dgclaw auditoria verificar).`; estado.corrente_alterada = true; break; }
        if (!p.lista.length) { delete estado.pendentes_desde; break; }
        estado.pendentes_desde = p.lista[0].obj.ts;
        try { await entregar(cfg, 'eventos', p.lista); } catch (e) {
          if (!(e instanceof ErroExterna)) throw e;
          erro = e.message;
          break;
        }
        const ult = p.lista[p.lista.length - 1];
        estado.arquivo = ult.arquivo; estado.linhas = ult.indice; estado.hash = ult.obj.hash;
        estado.ultimo_ok_em = new Date(agora()).toISOString();
        delete estado.corrente_alterada;
        enviadas += p.lista.length;
        gravarEstado(estado);
        if (!p.mais) { delete estado.pendentes_desde; break; }
      }
      // selo: só com tudo entregue, para o destino ter as linhas que o hash do selo cobre
      if (!erro && !estado.pendentes_desde) {
        const ultimo = corrente.ultimoHash(base);
        const devido = !estado.selo_em || agora() - Date.parse(estado.selo_em) >= SELO_A_CADA_MS;
        if (ultimo && devido) {
          const selo = { ts: new Date(agora()).toISOString(), hash: ultimo.hash, arquivo: ultimo.arquivo };
          try { await entregar(cfg, 'selo', selo); estado.selo_em = selo.ts; estado.selo_hash = selo.hash; seloEnviado = true; } catch (e) {
            if (!(e instanceof ErroExterna)) throw e;
            erro = e.message;
          }
        }
      }
      if (erro) { estado.ultimo_erro = erro; estado.ultimo_erro_em = new Date(agora()).toISOString(); log('aviso', `Auditoria externa: ${erro}`); } else { delete estado.ultimo_erro; delete estado.ultimo_erro_em; }
      gravarEstado(estado);
      return { enviadas, selo: seloEnviado, erro, pendentes: !!estado.pendentes_desde };
    } finally {
      try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') log('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}). Apague a pasta se ela ficar para trás.`); }
      travaDentro = false;
    }
  }

  /** Manda uma mensagem de teste que não faz parte da corrente (tipo "teste"), para conferir o destino. */
  async function testar() {
    const cfg = lerConfig(caminhoConfig, optsConfig);
    if (!cfg) throw new ErroExterna(`Falta o destino externo: ${caminhoConfig}. Configure com: dgclaw auditoria externa configurar`);
    const t = { ts: new Date(agora()).toISOString(), tipo: 'teste', instalacao };
    if (cfg.tipo === 'http') await enviarHttp(cfg, t);
    else await enviarSyslog(cfg, [rfc5424('TESTE', 'tipo="teste"', JSON.stringify(t))]);
    return { destino: destinoPublico(cfg), tipo: cfg.tipo };
  }

  /** Situação para a tela, o `dgclaw status` e o monitor. */
  function status() {
    let cfg = null; let erroConfig = null;
    try { cfg = lerConfig(caminhoConfig, optsConfig); } catch (e) {
      if (!(e instanceof ErroExterna)) throw e;
      erroConfig = e.message;
    }
    const est = lerEstado();
    let atrasoS = 0;
    if (est.pendentes_desde) atrasoS = Math.max(0, Math.round((agora() - Date.parse(est.pendentes_desde)) / 1000));
    let pend = null;
    if (cfg) {
      const p = pendentes(est, 0);
      pend = p.alterada ? null : p.lista.length;
    }
    return {
      configurado: !!cfg, erro_config: erroConfig, tipo: cfg ? cfg.tipo : null, destino: destinoPublico(cfg),
      pendentes: pend, pendentes_desde: est.pendentes_desde || null, atraso_s: atrasoS,
      alerta: !!cfg && (atrasoS * 1000 > ALERTA_APOS_MS || est.corrente_alterada === true),
      corrente_alterada: est.corrente_alterada === true,
      ultimo_envio_ok: est.ultimo_ok_em || null, ultimo_erro: est.ultimo_erro || null, ultimo_erro_em: est.ultimo_erro_em || null,
      selo_em: est.selo_em || null, selo_hash: est.selo_hash || null,
    };
  }

  return { enviar, testar, status, lerConfig: () => lerConfig(caminhoConfig, optsConfig), estadoPath };
}

module.exports = { criarExterna, ErroExterna, validarConfig, lerConfig, gravarConfig, destinoPublico, ALERTA_APOS_MS, SELO_A_CADA_MS, LOTE };
