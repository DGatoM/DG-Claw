'use strict';
// Apoio dos testes: pastas temporárias, hash de senha, servidor de teste e cliente com cookie.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { criarServidor } = require('../server');

function pastaTemp(prefixo) { return fs.mkdtempSync(path.join(os.tmpdir(), `dgclaw-web-${prefixo || 't'}-`)); }

/** Gera um hash no formato scrypt$N$r$p$sal$hash (N pequeno para o teste ser rápido). */
function gerarHash(senha, N) {
  const n = N || 1024; const r = 8; const p = 1;
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha.normalize('NFKC'), sal, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${n}$${r}$${p}$${sal.toString('base64url')}$${hash.toString('base64url')}`;
}

function capturaLog() {
  const linhas = [];
  const log = (nivel, msg) => { linhas.push(`[${nivel}] ${msg}`); };
  return { log, linhas, texto: () => linhas.join('\n') };
}

/** Cliente HTTP mínimo com cookie e Origin. */
function cliente(porta) {
  const jar = {};
  async function pedir(metodo, caminho, opcoes) {
    const o = opcoes || {};
    const headers = Object.assign({}, o.headers || {});
    if (o.origin !== false) headers.Origin = o.origin || `http://127.0.0.1:${porta}`;
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck && !o.semCookie) headers.Cookie = [ck, headers.Cookie].filter(Boolean).join('; ');
    let corpo = o.corpo;
    if (o.json !== undefined) { corpo = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; }
    if (o.form) { corpo = new URLSearchParams(o.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(partes);
          for (const sc of res.headers['set-cookie'] || []) {
            const [par] = sc.split(';'); const i = par.indexOf('=');
            const nome = par.slice(0, i); const valor = par.slice(i + 1);
            if (valor === '' || /Max-Age=0/i.test(sc)) delete jar[nome]; else jar[nome] = valor;
          }
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* não é JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, buf, texto: buf.toString('utf8'), json });
        });
      });
      req.on('error', reject);
      if (corpo) req.write(corpo);
      req.end();
    });
  }
  return { pedir, jar, get: (c, o) => pedir('GET', c, o), post: (c, o) => pedir('POST', c, o) };
}

/**
 * Sobe um Web de teste. `agentes` é a lista do registro; `env` o ambiente.
 * Devolve { web, porta, c (cliente), dados, publico, log, fechar }.
 */
async function subirWeb(opcoes) {
  const o = opcoes || {};
  const dir = pastaTemp('srv');
  const dados = path.join(dir, 'dados');
  const publico = path.join(dir, 'public');
  fs.mkdirSync(publico, { recursive: true });
  fs.writeFileSync(path.join(publico, 'login.html'), '<html>login de teste</html>');
  fs.writeFileSync(path.join(publico, 'conversa.html'), '<html>conversa de teste</html>');
  fs.writeFileSync(path.join(publico, 'app.js'), 'console.log(1)');
  const agentesPath = path.join(dir, 'agentes.json');
  fs.writeFileSync(agentesPath, JSON.stringify({ versao: 1, agentes: o.agentes || [] }));
  const senha = o.senha || 'senha-certa-123';
  const env = Object.assign({
    DGCLAW_PANEL_USER: 'dono',
    DGCLAW_PANEL_PASSWORD_HASH: o.semHash ? '' : gerarHash(senha),
  }, o.env || {});
  const cap = capturaLog();
  const web = criarServidor({ env, agentesPath, dataDir: dados, publicDir: publico, log: cap.log, tz: 'America/Sao_Paulo', tickSseMs: 80 });
  const addr = await web.ouvir(0, '127.0.0.1');
  const c = cliente(addr.port);
  return {
    web, porta: addr.port, c, dados, publico, dir, agentesPath, senha, log: cap, env,
    async login(cli) {
      const r = await (cli || c).post('/login', { json: { usuario: 'dono', senha } });
      if (r.status !== 200) throw new Error(`login de teste falhou: ${r.status} ${r.texto}`);
      return r;
    },
    fechar: () => web.fechar(),
  };
}

module.exports = { pastaTemp, gerarHash, capturaLog, cliente, subirWeb };
