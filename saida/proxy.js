'use strict';
// Proxy de saída dos agentes (bloco H). Um servidor HTTP por agente, escutando no gateway da rede dele
// (10.89.<N>.1:3128). Quem pediu é descoberto pelo endereço em que a conexão chegou, nunca por cabeçalho.
//
// Arquivos lidos (o serviço roda sem privilégio, então tudo é só leitura):
//   <etc>/saida/geral.json    {modo, retencao_dias, agentes:{slug:{n, provedor}}}  gravado pela CLI (root)
//   <etc>/saida/<slug>.json   {modo?, permitidos:[...]}                             lista do agente
//   <baseArq>                 {comuns:[...], claude:[...], codex:[...]}             lista base por provedor
// Tudo é relido quando o arquivo muda, sem reiniciar.
//
// Registro: <logDir>/<slug>.jsonl, uma linha por conexão: ts, host, porta, decisao, bytes_up, bytes_down, duracao
// (ms) e, quando não foi permitido, motivo. Nunca URL, caminho nem cabeçalho.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const dns = require('node:dns');
const { MODOS, SLUG_RX, modoMaisForte, normalizarHost, validarEntrada, casa, ipBloqueado } = require('./lista');

const OCIOSO_MS = 10 * 60 * 1000;
const CONECTAR_MS = 15 * 1000;
const MAX_ATIVAS = 512;
const DIA_MS = 86400000;
const SALTA = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function criarProxy(opc) {
  const dirSaida = path.join(opc.etc, 'saida');
  const logDir = opc.logDir;
  const baseArq = opc.baseArq;
  const porta = opc.porta === undefined ? 3128 : opc.porta;
  const enderecoDe = opc.enderecoDe || ((n) => `10.89.${n}.1`);
  const origemOk = opc.origemOk || ((n, ip) => ip.startsWith(`10.89.${n}.`));
  const intervaloMs = opc.intervaloMs === undefined ? 3000 : opc.intervaloMs;
  const resolver = opc.resolver || (async (h) => (await dns.promises.lookup(h, { all: true })).map((x) => x.address));
  const excecoes = new Set(opc.excecoesIp || []); // só para teste: destinos de laboratório em 127.0.0.1
  const agora = opc.agora || (() => Date.now());
  const log = opc.log || ((nivel, msg) => (nivel === 'erro' ? console.error : console.log)(`[dgclaw-saida] ${msg}`));

  const cacheJson = new Map();
  const avisados = new Map();
  const servidores = new Map(); // slug -> {server, n, sockets, ativas}
  const filas = new Map();
  let timer = null;
  let timerPoda = null;

  // Avisa uma vez por mensagem diferente, para um arquivo quebrado não encher o log a cada pedido.
  function avisarUmaVez(chave, nivel, msg) {
    if (avisados.get(chave) === msg) return;
    avisados.set(chave, msg);
    log(nivel, msg);
  }

  // lerJson: {valor} | {ausente:true} | {erro}
  function lerJson(arq) {
    let st;
    try { st = fs.statSync(arq); } catch (e) {
      cacheJson.delete(arq);
      if (e.code === 'ENOENT') return { ausente: true };
      return { erro: `não consegui ler ${arq} (${e.code}): confira a permissão do grupo dgclaw-saida` };
    }
    const c = cacheJson.get(arq);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.res;
    let res;
    try { res = { valor: JSON.parse(fs.readFileSync(arq, 'utf8')) }; } catch (e) {
      res = { erro: `${arq} não é um JSON válido (${e.message}): corrija o arquivo ou refaça com dgclaw saida` };
    }
    cacheJson.set(arq, { mtimeMs: st.mtimeMs, size: st.size, res });
    return res;
  }

  function lerGeral() {
    const r = lerJson(path.join(dirSaida, 'geral.json'));
    if (r.erro) { avisarUmaVez('geral', 'erro', `${r.erro}. Sem esse arquivo nenhum agente recebe proxy.`); return null; }
    if (r.ausente || !r.valor || typeof r.valor !== 'object') return null;
    return r.valor;
  }

  function lerBase() {
    const r = lerJson(baseArq);
    if (r.erro || r.ausente) {
      avisarUmaVez('base', 'erro', r.erro || `a lista base ${baseArq} não existe: só vale o que está na lista de cada agente. Reinstale o DG Claw para recolocá-la.`);
      return {};
    }
    return r.valor || {};
  }

  // politica(slug): {modo, entradas}. Modo desconhecido no geral.json conta como bloqueio (falha para o lado seguro).
  function politica(slug) {
    const geral = lerGeral();
    const info = geral && geral.agentes && geral.agentes[slug];
    if (!geral || !info) return { modo: 'livre', entradas: [] };
    const modoGeral = MODOS.includes(geral.modo) ? geral.modo : 'bloqueio';
    const ag = lerJson(path.join(dirSaida, `${slug}.json`));
    let modoAg;
    let permitidos = [];
    if (ag.erro) avisarUmaVez(`ag-${slug}`, 'erro', `${ag.erro} (agente ${slug}). Enquanto isso vale só a lista base.`);
    else if (ag.valor) {
      if (MODOS.includes(ag.valor.modo)) modoAg = ag.valor.modo;
      if (Array.isArray(ag.valor.permitidos)) permitidos = ag.valor.permitidos;
    }
    const modo = modoGeral === 'livre' ? 'livre' : modoMaisForte(modoGeral, modoAg);
    const base = lerBase();
    const brutas = [...(base.comuns || []), ...(base[info.provedor] || []), ...permitidos];
    const entradas = [];
    for (const b of brutas) {
      const v = validarEntrada(b);
      if (v.valor) entradas.push(v.valor);
      else avisarUmaVez(`ent-${slug}-${String(b).slice(0, 40)}`, 'erro', `entrada ignorada na lista do agente ${slug}: ${v.erro}. ${v.como}.`);
    }
    return { modo, entradas };
  }

  function registrar(slug, ent) {
    const linha = JSON.stringify({
      ts: new Date(agora()).toISOString(),
      host: ent.host,
      porta: ent.porta,
      decisao: ent.decisao,
      bytes_up: ent.bytes_up || 0,
      bytes_down: ent.bytes_down || 0,
      duracao: ent.duracao || 0,
      ...(ent.motivo ? { motivo: ent.motivo } : {}),
    }) + '\n';
    enfileirar(slug, async () => {
      await fsp.mkdir(logDir, { recursive: true, mode: 0o750 });
      await fsp.appendFile(path.join(logDir, `${slug}.jsonl`), linha, { mode: 0o640 });
    }, 'gravar o registro');
  }

  function enfileirar(slug, fn, oque) {
    const ant = filas.get(slug) || Promise.resolve();
    const prox = ant.then(fn).catch((e) => {
      avisarUmaVez(`log-${slug}`, 'erro', `não consegui ${oque} de ${slug} em ${logDir} (${e.code || e.message}). Confira se a pasta existe e é do usuário dgclaw-saida. O proxy continua decidindo, mas esta conexão ficou sem registro.`);
    });
    filas.set(slug, prox);
    return prox;
  }

  // decidir: {ok, motivo, ip}. A resolução é do proxy; a conexão sai para o IP validado, nunca para o nome de novo.
  async function decidir(slug, host, porta_) {
    const pol = politica(slug);
    if (pol.modo === 'livre') return { ok: false, motivo: 'agente-sem-proxy' };
    if (pol.modo === 'bloqueio' && !casa(pol.entradas, host)) return { ok: false, motivo: 'fora-da-lista' };
    let ips;
    if (net.isIP(host)) ips = [host];
    else {
      try { ips = await resolver(host); } catch (e) { return { ok: false, motivo: 'dns-falhou', detalhe: e.code || e.message }; }
    }
    if (!ips || ips.length === 0) return { ok: false, motivo: 'dns-falhou' };
    if (ips.some((ip) => ipBloqueado(ip) && !excecoes.has(ip))) return { ok: false, motivo: 'destino-interno' };
    return { ok: true, ip: ips[0], porta: porta_ };
  }

  function recusa(res, codigo, slug, host, motivo) {
    const por = {
      'fora-da-lista': `o destino ${host} não está na lista de saída deste agente. Peça ao TI: dgclaw saida permitir ${slug} ${host}`,
      'destino-interno': `o destino ${host} aponta para uma rede interna e o proxy não leva ninguém para lá.`,
      'dns-falhou': `não consegui resolver o nome ${host}.`,
      'conexao-falhou': `não consegui conectar em ${host}.`,
      origem: 'a conexão não veio da rede deste agente.',
      'pedido-invalido': 'o pedido não está no formato que o proxy entende.',
      'muitas-conexoes': 'há conexões demais abertas por este agente. Tente de novo em instantes.',
    }[motivo] || 'saída recusada.';
    const corpo = `DG Claw: ${por}\n`;
    const cab = `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(corpo)}\r\nConnection: close\r\n`;
    if (typeof res.writeHead === 'function') {
      res.writeHead(codigo, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo), Connection: 'close' });
      res.end(corpo);
    } else {
      res.end(`HTTP/1.1 ${codigo} ${codigo === 403 ? 'Forbidden' : codigo === 503 ? 'Service Unavailable' : codigo === 502 ? 'Bad Gateway' : 'Bad Request'}\r\n${cab}\r\n${corpo}`);
    }
  }

  function parseAlvo(url) {
    const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(url || '');
    if (!m) return null;
    const p = Number(m[2]);
    const host = normalizarHost(m[1]);
    if (!host || p < 1 || p > 65535) return null;
    return { host, porta: p };
  }

  function aoConectar(slug, n, estado, req, cli, head) {
    const t0 = agora();
    cli.on('error', () => {}); // o fim da conexão é registrado no 'close'
    const alvo = parseAlvo(req.url);
    const falhar = (codigo, motivo, host, porta_) => {
      registrar(slug, { host: host || '(invalido)', porta: porta_ || 0, decisao: 'recusado', motivo, duracao: agora() - t0 });
      recusa(cli, codigo, slug, host || '', motivo);
    };
    if (!origemOk(n, cli.remoteAddress || '')) { falhar(403, 'origem'); return; }
    if (!alvo) { falhar(400, 'pedido-invalido'); return; }
    if (estado.ativas >= MAX_ATIVAS) { falhar(503, 'muitas-conexoes', alvo.host, alvo.porta); return; }
    estado.ativas++;
    let liberado = false;
    const liberar = () => { if (!liberado) { liberado = true; estado.ativas--; } };
    cli.once('close', liberar);
    decidir(slug, alvo.host, alvo.porta).then((d) => {
      if (!d.ok) {
        registrar(slug, { host: alvo.host, porta: alvo.porta, decisao: 'recusado', motivo: d.motivo, duracao: agora() - t0 });
        recusa(cli, d.motivo === 'dns-falhou' ? 502 : 403, slug, alvo.host, d.motivo);
        return;
      }
      let up = 0;
      let down = 0;
      let conectou = false;
      let fechado = false;
      const dest = net.connect({ host: d.ip, port: alvo.porta });
      dest.setTimeout(CONECTAR_MS);
      const fim = (decisao, motivo) => {
        if (fechado) return;
        fechado = true;
        registrar(slug, { host: alvo.host, porta: alvo.porta, decisao, motivo, bytes_up: up, bytes_down: down, duracao: agora() - t0 });
        dest.destroy();
        cli.destroy();
      };
      dest.on('timeout', () => {
        if (!conectou) { recusa(cli, 502, slug, alvo.host, 'conexao-falhou'); fim('erro', 'conexao-demorou'); } else fim('permitido');
      });
      dest.on('error', (e) => {
        if (!conectou) { recusa(cli, 502, slug, alvo.host, 'conexao-falhou'); fim('erro', e.code || 'conexao-falhou'); } else fim('permitido');
      });
      dest.once('connect', () => {
        conectou = true;
        dest.setTimeout(OCIOSO_MS);
        cli.setTimeout(OCIOSO_MS);
        cli.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dgclaw-saida\r\n\r\n');
        if (head && head.length) { dest.write(head); up += head.length; }
        cli.on('data', (c) => { up += c.length; });
        dest.on('data', (c) => { down += c.length; });
        cli.pipe(dest);
        dest.pipe(cli);
      });
      cli.on('timeout', () => fim('permitido'));
      cli.on('close', () => fim('permitido'));
      dest.on('close', () => fim(conectou ? 'permitido' : 'erro', conectou ? undefined : 'conexao-falhou'));
    }).catch((e) => {
      log('erro', `falha inesperada ao decidir ${alvo.host} para ${slug}: ${e.stack || e.message}`);
      cli.destroy();
    });
  }

  function aoPedirHttp(slug, n, estado, req, res) {
    const t0 = agora();
    const ip = (req.socket.remoteAddress || '');
    let u = null;
    try { if (/^http:\/\//i.test(req.url)) u = new URL(req.url); } catch { u = null; }
    const host = u ? normalizarHost(u.hostname) : null;
    const falhar = (codigo, motivo) => {
      registrar(slug, { host: host || '(invalido)', porta: u ? Number(u.port || 80) : 0, decisao: 'recusado', motivo, duracao: agora() - t0 });
      recusa(res, codigo, slug, host || '', motivo);
      req.resume();
    };
    if (!origemOk(n, ip)) { falhar(403, 'origem'); return; }
    if (!u || !host) { falhar(400, 'pedido-invalido'); return; }
    if (estado.ativas >= MAX_ATIVAS) { falhar(503, 'muitas-conexoes'); return; }
    const alvoPorta = Number(u.port || 80);
    estado.ativas++;
    let liberado = false;
    const liberar = () => { if (!liberado) { liberado = true; estado.ativas--; } };
    res.once('close', liberar);
    decidir(slug, host, alvoPorta).then((d) => {
      if (!d.ok) { falhar(d.motivo === 'dns-falhou' ? 502 : 403, d.motivo); return; }
      let up = 0;
      let down = 0;
      let gravou = false;
      const fim = (decisao, motivo) => {
        if (gravou) return;
        gravou = true;
        registrar(slug, { host, porta: alvoPorta, decisao, motivo, bytes_up: up, bytes_down: down, duracao: agora() - t0 });
      };
      const cab = {};
      for (const [k, v] of Object.entries(req.headers)) if (!SALTA.has(k) && k !== 'host') cab[k] = v;
      cab.host = u.host;
      const preq = http.request({ host: d.ip, port: alvoPorta, method: req.method, path: `${u.pathname}${u.search}`, headers: cab, agent: false, timeout: CONECTAR_MS * 2 });
      req.on('data', (c) => { up += c.length; });
      req.pipe(preq);
      preq.on('response', (pres) => {
        const saida = {};
        for (const [k, v] of Object.entries(pres.headers)) if (!SALTA.has(k)) saida[k] = v;
        saida.connection = 'close';
        res.writeHead(pres.statusCode, saida);
        pres.on('data', (c) => { down += c.length; });
        pres.pipe(res);
        pres.on('end', () => fim('permitido'));
        pres.on('error', () => { fim('permitido'); res.destroy(); });
      });
      preq.on('timeout', () => preq.destroy(Object.assign(new Error('tempo esgotado'), { code: 'ETIMEDOUT' })));
      preq.on('error', (e) => {
        fim('erro', e.code || 'conexao-falhou');
        if (!res.headersSent) recusa(res, 502, slug, host, 'conexao-falhou'); else res.destroy();
      });
      res.on('close', () => fim('permitido'));
    }).catch((e) => {
      log('erro', `falha inesperada ao decidir ${host} para ${slug}: ${e.stack || e.message}`);
      res.destroy();
    });
  }

  function abrir(slug, n) {
    const estado = { n, sockets: new Set(), ativas: 0, server: null, escutando: false };
    const server = http.createServer((req, res) => aoPedirHttp(slug, n, estado, req, res));
    server.on('connect', (req, cli, head) => aoConectar(slug, n, estado, req, cli, head));
    server.on('connection', (s) => { estado.sockets.add(s); s.on('close', () => estado.sockets.delete(s)); s.on('error', () => {}); });
    server.on('clientError', (_e, s) => { if (s.writable) s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else s.destroy(); });
    server.on('error', (e) => {
      avisarUmaVez(`bind-${slug}`, 'erro', `não consegui escutar em ${enderecoDe(n)}:${porta} para o agente ${slug} (${e.code}). A rede do agente talvez ainda não exista ou a porta está ocupada; tento de novo em ${Math.round(intervaloMs / 1000)}s.`);
      if (servidores.get(slug) === estado) servidores.delete(slug);
    });
    server.listen({ host: enderecoDe(n), port: porta }, () => {
      estado.escutando = true;
      avisados.delete(`bind-${slug}`);
      log('info', `agente ${slug}: proxy escutando em ${enderecoDe(n)}:${server.address().port}`);
    });
    estado.server = server;
    servidores.set(slug, estado);
  }

  function fechar(slug) {
    const s = servidores.get(slug);
    if (!s) return;
    servidores.delete(slug);
    s.server.close();
    for (const sock of s.sockets) sock.destroy();
    log('info', `agente ${slug}: proxy fechado`);
  }

  function reconciliar() {
    const geral = lerGeral();
    const desejados = new Map();
    if (geral && geral.agentes && typeof geral.agentes === 'object') {
      for (const [slug, info] of Object.entries(geral.agentes)) {
        if (!SLUG_RX.test(slug) || !info || !Number.isInteger(info.n) || info.n < 1 || info.n > 250) {
          avisarUmaVez(`slug-${slug.slice(0, 40)}`, 'erro', `ignorei o agente "${slug.slice(0, 40)}" em geral.json: nome ou número inválido. Refaça com: dgclaw saida sincronizar`);
          continue;
        }
        if (politica(slug).modo !== 'livre') desejados.set(slug, info.n);
      }
    }
    for (const [slug, s] of [...servidores]) if (desejados.get(slug) !== s.n) fechar(slug);
    for (const [slug, n] of desejados) if (!servidores.has(slug)) abrir(slug, n);
  }

  // Tira do registro as linhas mais velhas que retencao_dias (0 = sem prazo). Linha que não é JSON fica.
  async function podar() {
    const geral = lerGeral();
    const dias = geral && Number.isInteger(geral.retencao_dias) ? geral.retencao_dias : 0;
    if (dias <= 0) return 0;
    let nomes;
    try { nomes = await fsp.readdir(logDir); } catch (e) {
      if (e.code === 'ENOENT') return 0;
      avisarUmaVez('poda-dir', 'erro', `não consegui ler ${logDir} para aplicar a retenção (${e.code}). Os registros velhos continuam lá.`);
      return 0;
    }
    const corte = agora() - dias * DIA_MS;
    let total = 0;
    for (const nome of nomes.filter((x) => x.endsWith('.jsonl'))) {
      const slug = nome.slice(0, -6);
      await enfileirar(slug, async () => {
        const arq = path.join(logDir, nome);
        const linhas = (await fsp.readFile(arq, 'utf8')).split('\n').filter(Boolean);
        const ficam = linhas.filter((l) => {
          try { const t = Date.parse(JSON.parse(l).ts); return Number.isNaN(t) || t >= corte; } catch { return true; }
        });
        if (ficam.length === linhas.length) return;
        total += linhas.length - ficam.length;
        const tmp = `${arq}.tmp`;
        await fsp.writeFile(tmp, ficam.length ? `${ficam.join('\n')}\n` : '', { mode: 0o640 });
        await fsp.rename(tmp, arq);
      }, 'aplicar a retenção ao registro');
    }
    if (total > 0) log('info', `retenção de ${dias} dia(s): ${total} linha(s) velhas saíram do registro`);
    return total;
  }

  return {
    decidir,
    politica,
    reconciliar,
    podar,
    portaDe: (slug) => { const s = servidores.get(slug); return s && s.escutando ? s.server.address().port : null; },
    escutando: () => [...servidores].filter(([, s]) => s.escutando).map(([slug]) => slug).sort(),
    iniciar() {
      reconciliar();
      timer = setInterval(reconciliar, intervaloMs);
      podar().catch((e) => log('erro', `a retenção do registro falhou: ${e.message}`));
      timerPoda = setInterval(() => podar().catch((e) => log('erro', `a retenção do registro falhou: ${e.message}`)), 6 * 3600 * 1000);
    },
    async parar() {
      if (timer) clearInterval(timer);
      if (timerPoda) clearInterval(timerPoda);
      timer = null; timerPoda = null;
      for (const slug of [...servidores.keys()]) fechar(slug);
      await Promise.all([...filas.values()]);
    },
    // espera o registro pendente ir para o disco (teste e parada limpa)
    esperarRegistro: () => Promise.all([...filas.values()]),
  };
}

module.exports = { criarProxy };
