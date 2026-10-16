'use strict';
// Proxy /p/<slug>/* para o painel do agente em 127.0.0.1:<porta_painel>.
// Só chega aqui quem tem sessão (o server.js confere antes). Acrescenta os cabeçalhos de
// confiança X-DGClaw-Proxy (segredo) e X-DGClaw-Usuario, e apaga os que vieram do navegador.
// O segredo nunca vai para log nem para resposta.

const fs = require('node:fs');
const http = require('node:http');
const { erroJson, paginaErro, ipDoPedido, esquemaDoPedido, hostDoPedido } = require('./http');
const { NOME_COOKIE } = require('./auth');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const PROIBIDOS_DO_NAVEGADOR = new Set(['x-dgclaw-proxy', 'x-dgclaw-usuario']);

/** Tira o cookie de sessão do Web do que vai para o painel (ele não precisa do nosso token). */
function limpaCookie(c) {
  if (!c) return null;
  const resto = String(c).split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${NOME_COOKIE}=`));
  return resto.length ? resto.join('; ') : null;
}

/** Valor de cabeçalho seguro: só ASCII imprimível; o resto vira percent-encoding. */
function valorSeguro(v) {
  const s = String(v == null ? '' : v);
  return /^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s);
}

function criarProxy({ config, registro, log, cofreRotas }) {
  const cacheSegredo = new Map(); // caminho -> { mtimeMs, valor }
  const socketsAbertos = new Set(); // conexões WebSocket, para fechar junto com o servidor

  function lerSegredo(agente) {
    const arq = agente.proxy_segredo_arquivo;
    if (!arq) return { erro: `O agente ${agente.nome} não tem proxy_segredo_arquivo no registro; sem o segredo o painel não confia no Web. Rode o instalador para configurar o painel.` };
    try {
      const st = fs.statSync(arq);
      const c = cacheSegredo.get(arq);
      if (c && c.mtimeMs === st.mtimeMs) return { segredo: c.valor };
      const valor = fs.readFileSync(arq, 'utf8').trim();
      if (!valor) return { erro: `O arquivo do segredo do painel de ${agente.nome} (${arq}) está vazio.` };
      cacheSegredo.set(arq, { mtimeMs: st.mtimeMs, valor });
      return { segredo: valor };
    } catch (e) {
      return { erro: `Não consegui ler o segredo do painel de ${agente.nome} (${arq}): ${e.code || e.name}. Confira se o arquivo existe e se este serviço roda como root.` };
    }
  }

  /** Resolve o destino. Devolve { agente, segredo } ou { status, motivo }. */
  function destino(slug) {
    const est = registro.estado();
    if (!est.ok) return { status: 503, motivo: est.erro };
    const agente = est.agentes.find((a) => a.slug === slug);
    if (!agente) return { status: 404, motivo: `Não existe agente com o nome "${slug}".` };
    if (!agente.porta_painel) return { status: 404, motivo: `${agente.nome} não tem painel (porta_painel vazia no registro). A conversa fica em /a/${agente.slug}.` };
    const s = lerSegredo(agente);
    if (s.erro) { log('erro', s.erro); return { status: 500, motivo: s.erro }; }
    return { agente, segredo: s.segredo };
  }

  function cabecalhosParaPainel(req, usuario, segredo, agente) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const nome = k.toLowerCase();
      if (HOP.has(nome) || PROIBIDOS_DO_NAVEGADOR.has(nome) || nome === 'cookie') continue;
      h[nome] = v;
    }
    const ck = limpaCookie(req.headers.cookie);
    if (ck) h.cookie = ck;
    h['x-forwarded-for'] = ipDoPedido(req, config.proxiesConfiaveis);
    h['x-forwarded-proto'] = esquemaDoPedido(req, config.proxiesConfiaveis);
    h['x-forwarded-host'] = hostDoPedido(req, config.proxiesConfiaveis);
    h['x-dgclaw-proxy'] = segredo;
    h['x-dgclaw-usuario'] = valorSeguro(usuario);
    return h;
  }

  /**
   * Agente da v1 (com cofre_arquivo): as rotas do cofre e a troca de modelo com chave são
   * respondidas pelo Web (./cofre-rotas) e nunca chegam ao painel. Se o Web leu o corpo para
   * decidir e a rota é do painel, o corpo lido segue como Buffer.
   */
  function responder(req, res, slug, usuario) {
    const agente = cofreRotas ? registro.obter(slug) : null;
    const qual = agente && agente.cofre_arquivo ? cofreRotas.casa(req, slug) : null;
    if (!qual) return encaminhar(req, res, slug, usuario, null);
    cofreRotas.tratar(req, res, agente, usuario, qual).then((repasse) => {
      if (repasse && repasse.corpo) encaminhar(req, res, slug, usuario, repasse.corpo);
    }).catch((e) => {
      log('erro', `Proxy /p/${slug}: o tratamento do cofre quebrou (${e && e.message}).`);
      if (!res.headersSent) erroJson(res, 500, 'Não consegui atender o pedido do cofre. Veja o registro do DG Claw Web.');
      else res.destroy();
    });
    return undefined;
  }

  function encaminhar(req, res, slug, usuario, corpoLido) {
    const d = destino(slug);
    if (d.status) {
      if (/\btext\/html\b/.test(String(req.headers.accept || ''))) paginaErro(res, d.status, 'Painel indisponível', d.motivo);
      else erroJson(res, d.status, d.motivo);
      return;
    }
    const { agente, segredo } = d;
    const opcoes = {
      host: '127.0.0.1', port: agente.porta_painel, method: req.method, path: req.url,
      headers: cabecalhosParaPainel(req, usuario, segredo, agente),
    };
    if (corpoLido) opcoes.headers['content-length'] = String(corpoLido.length);
    const preq = http.request(opcoes, (pres) => {
      const h = {};
      for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(pres.statusCode, pres.statusMessage, h);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    });
    preq.on('error', (e) => {
      const motivo = `O painel de ${agente.nome} (porta ${agente.porta_painel}) não está respondendo (${e.code || e.message}). Confira se o serviço do painel está ligado.`;
      log('erro', `Proxy /p/${slug}: ${motivo}`);
      if (res.headersSent) { res.destroy(); return; }
      if (/\btext\/html\b/.test(String(req.headers.accept || ''))) paginaErro(res, 502, 'Painel fora do ar', motivo);
      else erroJson(res, 502, motivo);
    });
    res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
    if (corpoLido) preq.end(corpoLido); else req.pipe(preq);
  }

  /** WebSocket/Upgrade: abre a mesma conexão no painel e liga os dois lados. */
  function upgrade(req, socket, head, slug, usuario) {
    const d = destino(slug);
    if (d.status) {
      socket.write(`HTTP/1.1 ${d.status} Erro\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${d.motivo}`);
      socket.destroy();
      return;
    }
    const { agente, segredo } = d;
    const h = cabecalhosParaPainel(req, usuario, segredo, agente);
    h.connection = 'Upgrade';
    h.upgrade = req.headers.upgrade;
    const preq = http.request({ host: '127.0.0.1', port: agente.porta_painel, method: req.method, path: req.url, headers: h });
    preq.on('upgrade', (pres, psocket, phead) => {
      let cab = `HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\n`;
      for (let i = 0; i < pres.rawHeaders.length; i += 2) cab += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
      socket.write(`${cab}\r\n`);
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psocket.write(head);
      socketsAbertos.add(socket); socketsAbertos.add(psocket);
      socket.on('close', () => socketsAbertos.delete(socket));
      psocket.on('close', () => socketsAbertos.delete(psocket));
      psocket.pipe(socket); socket.pipe(psocket);
      psocket.on('error', () => socket.destroy());
      socket.on('error', () => psocket.destroy());
      socket.on('close', () => psocket.destroy());
      psocket.on('close', () => socket.destroy());
    });
    preq.on('response', (pres) => {
      // o painel respondeu sem aceitar o upgrade: repassa o status e fecha
      socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\nConnection: close\r\n\r\n`);
      pres.resume();
      socket.destroy();
    });
    preq.on('error', (e) => {
      log('erro', `Proxy /p/${slug} (WebSocket): o painel de ${agente.nome} não respondeu (${e.code || e.message}).`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    preq.end();
  }

  return { responder, upgrade, destino, fecharTudo() { for (const x of socketsAbertos) x.destroy(); socketsAbertos.clear(); } };
}

module.exports = { criarProxy, limpaCookie };
