'use strict';
/**
 * tela.js: a aba Tela do painel. O dono abre, de dentro do painel, o navegador do agente
 * (Chrome num Xvfb, visto por x11vnc + noVNC) para fazer login nos sistemas que o agente
 * vai usar. O agente usa depois esse mesmo Chrome já logado, por CDP, e a senha do dono
 * nunca passa pela conversa.
 *
 *   GET /api/tela             status: { ok, instalada, senha_definida, cdp, url_externa, caminho_websockify }
 *   PUT /api/tela/senha       { senha } grava o rfbauth (só humano: chave de API recebe 403)
 *   GET /tela/novnc/*         os arquivos do noVNC, buscados por HTTP em DGCLAW_TELA_NOVNC
 *   WS  /tela/websockify      o WebSocket do noVNC, repassado em bytes crus (server.on('upgrade'))
 *
 * A PORTA 6080 NUNCA SAI DAQUI SEM LOGIN. Tudo acima passa pelo requireAuth do painel (o
 * upgrade, que não passa por middleware do Express, repete a mesma regra em
 * auth.autenticarUpgrade). A segunda senha é a do próprio VNC: o noVNC pede, o x11vnc confere.
 * Este módulo não guarda a senha da tela em lugar nenhum além do rfbauth.
 *
 * Variáveis de ambiente (todas opcionais):
 *   DGCLAW_TELA_NOVNC           127.0.0.1:6080  onde estão o websockify e os arquivos do noVNC
 *   DGCLAW_TELA_SENHA_ARQUIVO   /home/agente/.dgclaw/tela/vnc.senha  o rfbauth do x11vnc
 *   DGCLAW_TELA_URL_EXTERNA     (vazia)  endereço alternativo, para quando a fachada não deixa o WebSocket passar
 *   DGCLAW_TELA_CDP             127.0.0.1:9222  só para o status ("o navegador respondeu?")
 *
 * Quem reinicia o x11vnc depois da troca de senha NÃO é o painel: uma unidade .path do container
 * observa o arquivo. O painel só grava.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { validarSenha, gravarRfbauth } = require('./tela-senha');

const PADRAO_NOVNC = '127.0.0.1:6080';
const PADRAO_SENHA = '/home/agente/.dgclaw/tela/vnc.senha';
const PADRAO_CDP = '127.0.0.1:9222';
const SONDA_MS = 2000;
const CONEXAO_MS = 5000;

/** "127.0.0.1:6080" ou "http://127.0.0.1:6080" -> { host, port } ou { erro }. */
function lerHostPorta(texto, variavel) {
  const limpo = String(texto).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const m = /^([A-Za-z0-9.\-_]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(limpo);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    return { erro: `${variavel} vale "${texto}", e eu esperava host:porta (por exemplo ${variavel === 'DGCLAW_TELA_CDP' ? PADRAO_CDP : PADRAO_NOVNC}).` };
  }
  return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) };
}

/** Só http(s): o valor vira href na tela e "javascript:" não pode passar. */
function lerUrlExterna(texto, log) {
  const url = String(texto || '').trim();
  if (!url) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    log(`[painel] DGCLAW_TELA_URL_EXTERNA vale "${url.slice(0, 80)}", que não começa com http:// nem https://. Ignorei o valor; corrija na configuração do painel.`);
    return '';
  }
  return url;
}

/** Escreve a recusa no socket (antes do upgrade) e fecha. */
function recusar(socket, status, motivo) {
  const corpo = Buffer.from(String(motivo), 'utf8');
  try {
    socket.write(`HTTP/1.1 ${status} Recusado\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${corpo.length}\r\n\r\n`);
    socket.end(corpo);
  } catch { /* o navegador já desligou: não há a quem explicar */ }
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** GET simples; resolve true se algo respondeu em HTTP (qualquer status, ou o status certo se `soStatus`). */
function sondar(destino, caminho, soStatus) {
  return new Promise((resolve) => {
    const req = http.request({ host: destino.host, port: destino.port, path: caminho, method: 'GET', timeout: SONDA_MS }, (res) => {
      res.resume();
      resolve(soStatus ? res.statusCode === soStatus : true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * @param {object} router  o router do painel, já depois de cfAccess + requireAuth + csrf
 * @param {object} o
 * @param {object} o.env
 * @param {string} o.base  DGCLAW_PANEL_BASE
 * @param {function} o.quemFez  (req) => nome, para o registro
 * @param {function} [o.log]
 * @returns {{ aoUpgrade: function, config: object }}
 */
function registrar(router, o) {
  const env = o.env || process.env;
  const base = o.base || '';
  const log = o.log || ((...a) => console.error(...a));

  const novnc = lerHostPorta(env.DGCLAW_TELA_NOVNC || PADRAO_NOVNC, 'DGCLAW_TELA_NOVNC');
  const cdp = lerHostPorta(env.DGCLAW_TELA_CDP || PADRAO_CDP, 'DGCLAW_TELA_CDP');
  const arquivoSenha = String(env.DGCLAW_TELA_SENHA_ARQUIVO || '').trim() || PADRAO_SENHA;
  const urlExterna = lerUrlExterna(env.DGCLAW_TELA_URL_EXTERNA, log);
  if (novnc.erro) log(`[painel] Tela DESLIGADA: ${novnc.erro} Corrija na configuração do painel; até lá a aba Tela diz que a tela não está instalada.`);
  if (cdp.erro) log(`[painel] ${cdp.erro} O status da Tela vai mostrar "não consegui ver" para o navegador.`);

  const caminhoWebsockify = `${base}/tela/websockify`;

  function senhaDefinida() {
    try {
      const st = fs.statSync(arquivoSenha);
      return st.isFile() && st.size === 8;
    } catch (err) {
      if (err.code !== 'ENOENT') log(`[painel] Tela: não consegui olhar o arquivo da senha (${arquivoSenha}): ${err.code || err.message}.`);
      return false;
    }
  }

  // ─── API ───────────────────────────────────────────────────────────────────

  router.get('/api/tela', async (req, res) => {
    try {
      const [instalada, cdpOk] = await Promise.all([
        novnc.erro ? false : sondar(novnc, '/'),
        cdp.erro ? false : sondar(cdp, '/json/version', 200),
      ]);
      res.json({
        ok: true,
        instalada,
        senha_definida: senhaDefinida(),
        cdp: cdpOk,
        url_externa: urlExterna || null,
        caminho_websockify: caminhoWebsockify,
      });
    } catch (err) {
      log(`[painel] Tela: GET /api/tela quebrou: ${err.stack || err.message}`);
      res.status(500).json({ error: `Não consegui montar o status da tela: ${err.message}`, howToFix: 'Veja o registro do painel e tente de novo.' });
    }
  });

  const limiteSenha = rateLimit({
    windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
      error: 'Muitas trocas de senha da tela em pouco tempo.',
      howToFix: 'Espere um minuto e tente de novo.',
    }),
  });

  router.put('/api/tela/senha', limiteSenha, (req, res) => {
    if (req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api') {
      return res.status(403).json({
        error: 'Uma chave de API não pode trocar a senha da tela.',
        howToFix: 'Troque pela aba Tela do painel, entrando com a senha, ou pela máquina com "node panel/bin/tela-senha.js".',
      });
    }
    const senha = (req.body || {}).senha;
    const v = validarSenha(senha);
    if (!v.ok) return res.status(400).json({ error: v.erro, howToFix: v.howToFix });
    try {
      gravarRfbauth(arquivoSenha, senha);
    } catch (err) {
      log(`[painel] Tela: a troca de senha de ${o.quemFez(req)} falhou: ${err.message}`);
      return res.status(500).json({ error: err.message, howToFix: 'Peça a quem instalou o agente para conferir a pasta da senha da tela e as permissões dela.' });
    }
    log(`[painel] Tela: a senha da tela foi trocada por ${o.quemFez(req)}.`);
    return res.json({ ok: true, aviso: 'quem estava vendo a tela foi desconectado' });
  });

  // ─── Os arquivos do noVNC (proxy HTTP) ─────────────────────────────────────

  router.get('/tela/novnc/*', (req, res) => {
    if (novnc.erro) {
      return res.status(503).type('text/plain; charset=utf-8').send(`A tela não está configurada: ${novnc.erro}`);
    }
    const bruto = req.url.slice('/tela/novnc'.length) || '/';
    // Sobe nenhum diretório: o websockify serve uma pasta, e ".." (inclusive codificado)
    // abriria o resto do disco do container.
    let decodificado;
    try { decodificado = decodeURIComponent(bruto.split('?')[0]); } catch { decodificado = '..'; }
    if (decodificado.split(/[\\/]/).includes('..') || decodificado.includes('\0')) {
      return res.status(400).type('text/plain; charset=utf-8').send('Caminho inválido para a tela.');
    }
    const preq = http.request({
      host: novnc.host, port: novnc.port, path: bruto, method: 'GET', timeout: 10000,
      headers: { accept: req.headers.accept || '*/*', host: `${novnc.host}:${novnc.port}` },
    }, (pres) => {
      const h = {};
      for (const k of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
        if (pres.headers[k]) h[k] = pres.headers[k];
      }
      res.writeHead(pres.statusCode, h);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    });
    preq.on('timeout', () => preq.destroy(new Error('demorou mais de 10 s')));
    preq.on('error', (err) => {
      log(`[painel] Tela: não consegui buscar ${decodificado.slice(0, 100)} em ${novnc.host}:${novnc.port} (${err.code || err.message}).`);
      if (res.headersSent) { res.destroy(); return; }
      res.status(502).type('text/plain; charset=utf-8')
        .send('A tela não respondeu. Este agente ainda não tem tela ligada, ou ela caiu. Peça a quem instalou para conferir o serviço da tela.');
    });
    res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
    return preq.end();
  });

  // ─── O WebSocket ───────────────────────────────────────────────────────────

  /**
   * Para o evento 'upgrade' do servidor http.
   * @param {function} autenticar async (req) => { ok, via } | { ok:false, status, motivo }
   */
  async function aoUpgrade(req, socket, head, autenticar) {
    // Sem este ouvinte um RST do navegador, durante o await abaixo, derrubaria o painel inteiro.
    socket.on('error', () => {});
    const quem = req.socket && req.socket.remoteAddress;
    let caminho = '';
    try { caminho = new URL(req.url, 'http://local').pathname; } catch { caminho = ''; }
    if (caminho !== caminhoWebsockify) {
      log(`[painel] WebSocket em ${caminho.slice(0, 80) || '(endereço ilegível)'} recusado (404): só ${caminhoWebsockify} aceita WebSocket.`);
      return recusar(socket, 404, `Neste painel só ${caminhoWebsockify} aceita WebSocket.`);
    }
    let r;
    try {
      r = await autenticar(req);
    } catch (err) {
      log(`[painel] Tela: a conferência do login do WebSocket quebrou (${err.message}).`);
      return recusar(socket, 500, 'Não consegui conferir o seu login. Tente de novo; se repetir, avise quem instalou.');
    }
    if (!r.ok) {
      log(`[painel] Tela: WebSocket de ${quem} recusado (${r.status}): ${r.motivo}`);
      return recusar(socket, r.status, r.motivo);
    }
    if (novnc.erro) {
      log(`[painel] Tela: WebSocket recusado (503): ${novnc.erro}`);
      return recusar(socket, 503, 'A tela não está configurada neste painel. Peça a quem instalou para conferir DGCLAW_TELA_NOVNC.');
    }

    const SEM_REPASSE = new Set(['host', 'cookie', 'authorization', 'origin', 'x-dgclaw-proxy', 'x-dgclaw-usuario',
      'sec-websocket-extensions', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
    let pedido = `GET /websockify HTTP/1.1\r\nHost: ${novnc.host}:${novnc.port}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const nome = req.rawHeaders[i];
      if (SEM_REPASSE.has(nome.toLowerCase())) continue;
      pedido += `${nome}: ${String(req.rawHeaders[i + 1]).replace(/[\r\n]/g, ' ')}\r\n`;
    }
    pedido += '\r\n';

    const destino = net.connect({ host: novnc.host, port: novnc.port });
    let conectou = false;
    const prazo = setTimeout(() => destino.destroy(new Error('sem resposta em 5 s')), CONEXAO_MS);
    destino.on('connect', () => {
      conectou = true;
      clearTimeout(prazo);
      destino.setNoDelay(true);
      destino.setKeepAlive(true, 30000);
      socket.setNoDelay(true);
      destino.write(pedido);
      if (head && head.length) destino.write(head);
      destino.pipe(socket);
      socket.pipe(destino);
    });
    destino.on('error', (err) => {
      clearTimeout(prazo);
      if (!conectou) {
        log(`[painel] Tela: WebSocket recusado (502): não consegui falar com ${novnc.host}:${novnc.port} (${err.code || err.message}).`);
        recusar(socket, 502, 'A tela não respondeu. Este agente ainda não tem tela ligada, ou ela caiu. Peça a quem instalou para conferir o serviço da tela.');
      } else {
        log(`[painel] Tela: a conexão com ${novnc.host}:${novnc.port} caiu no meio (${err.code || err.message}); fechei o lado do navegador.`);
        socket.destroy();
      }
    });
    destino.on('close', () => { clearTimeout(prazo); socket.destroy(); });
    socket.on('close', () => destino.destroy());
    return undefined;
  }

  return { aoUpgrade, config: { novnc, cdp, arquivoSenha, urlExterna, caminhoWebsockify } };
}

module.exports = { registrar, lerHostPorta, lerUrlExterna };
