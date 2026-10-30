// test-tela.mjs: a aba Tela: senha no formato rfbauth, API de status e de troca de senha, e o
// proxy autenticado do noVNC (arquivos por HTTP e WebSocket em bytes crus).
//
// Nada aqui toca um agente de verdade: o "websockify" é um servidor falso numa porta livre, que
// responde HTTP, aceita o upgrade e devolve em eco o que recebe. O painel sobe de verdade
// (server.js) com pasta temporária, como no test-auth.mjs. Todo segredo abaixo é falso.
// `node test-tela.mjs` na pasta do painel (precisa do `npm i` feito).

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const { validarSenha, gerarRfbauth, gravarRfbauth } = require('./lib/tela-senha.js');
const { buildChavesApi } = require('./lib/chaves-api.js');

let falhas = 0;
function ok(condicao, oQue) {
  if (condicao) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'tela-teste-'));
const SENHA_PAINEL = 'senha-de-teste-bem-longa';
const SEGREDO_PROXY = 'segredo-do-proxy-de-teste';
const modo = (f) => (fs.statSync(f).mode & 0o777).toString(8);

// ─── O formato rfbauth ───────────────────────────────────────────────────────
console.log('\nO arquivo rfbauth (vetores gerados pelo x11vnc -storepasswd)');
ok(gerarRfbauth('Ab3$xY7!').toString('hex') === 'a8efe10f95b88508', "'Ab3$xY7!' -> a8efe10f95b88508");
ok(gerarRfbauth('abc123').toString('hex') === '275ea8d255b012f2', "'abc123' -> 275ea8d255b012f2 (completada com zeros)");
ok(gerarRfbauth('abc123').length === 8, 'sempre 8 bytes');

console.log('\nValidação da senha');
ok(validarSenha('abc123').ok && validarSenha('12345678').ok, '6 e 8 caracteres passam');
ok(!validarSenha('abc12').ok, '5 caracteres: recusa');
{
  const v = validarSenha('123456789');
  ok(!v.ok && /no máximo 8/.test(v.erro) && /só olha os 8 primeiros/.test(v.erro) && v.howToFix, '9 caracteres: recusa e explica o porquê, sem truncar');
}
ok(!validarSenha('senhaçã1').ok && /sem acento/.test(validarSenha('senhaçã1').erro), 'acento: recusa com motivo');
ok(!validarSenha(undefined).ok && !validarSenha('').ok && !validarSenha(123456).ok, 'ausente, vazia e não-texto: recusa');
ok(validarSenha('ab cd 1').ok, 'espaço é caractere imprimível e passa');

console.log('\nGravação atômica');
{
  const arq = path.join(RAIZ, 'g', 'tela', 'vnc.senha');
  gravarRfbauth(arq, 'abc123');
  ok(fs.readFileSync(arq).toString('hex') === '275ea8d255b012f2', 'o arquivo tem os 8 bytes certos');
  ok(modo(arq) === '600', 'o arquivo é modo 600');
  ok(modo(path.dirname(arq)) === '700', 'a pasta criada é modo 700');
  gravarRfbauth(arq, 'Ab3$xY7!');
  ok(fs.readFileSync(arq).toString('hex') === 'a8efe10f95b88508', 'regravar troca o conteúdo');
  ok(fs.readdirSync(path.dirname(arq)).join() === 'vnc.senha', 'nenhum temporário sobra');
  ok(!fs.readFileSync(arq).includes('abc123') && !fs.readFileSync(arq).includes('Ab3$xY7!'), 'a senha em claro não está no disco');
  let msg = '';
  const comum = path.join(RAIZ, 'arquivo-comum');
  fs.writeFileSync(comum, 'x');
  try { gravarRfbauth(path.join(comum, 'vnc.senha'), 'abc123'); } catch (e) { msg = e.message; }
  ok(/Não consegui gravar/.test(msg) && !msg.includes('abc123'), 'falha de gravação diz o que houve, sem a senha');
}

console.log('\nbin/tela-senha.js');
{
  const arq = path.join(RAIZ, 'cli', 'vnc.senha');
  const rodar = (entrada, args) => spawnSync(process.execPath, [path.join(AQUI, 'bin/tela-senha.js'), ...args], { input: entrada, encoding: 'utf8' });
  let r = rodar('abc123\n', ['--arquivo', arq]);
  ok(r.status === 0 && fs.readFileSync(arq).toString('hex') === '275ea8d255b012f2' && modo(arq) === '600', 'lê do STDIN e grava (modo 600)');
  r = rodar('123456789\n', ['--arquivo', arq]);
  ok(r.status === 1 && /no máximo 8/.test(r.stderr), '9 caracteres: sai com 1 e explica');
  ok(fs.readFileSync(arq).toString('hex') === '275ea8d255b012f2', 'a recusa não mexe no arquivo');
  r = rodar('abc123\n', []);
  ok(r.status === 2 && /uso:/.test(r.stderr), 'sem --arquivo: sai com 2 e mostra o uso');
  r = rodar('abc123\n', ['--arquivo', arq, 'abc123']);
  ok(r.status === 2, 'senha como argumento é recusada');
}

// ─── A conta dos caminhos no navegador ───────────────────────────────────────
console.log('\nO caminho do websockify calculado da URL da página (js/tela.js)');
{
  const fonte = fs.readFileSync(path.join(AQUI, 'public/js/tela.js'), 'utf-8');
  const janela = { DGCLAW_BASE: '' };
  new Function('window', 'document', fonte)(janela, { readyState: 'complete', querySelector: () => null });
  const { contaDosCaminhos: conta, passosDoTutorial } = janela.DGTela;
  let c = conta('/');
  ok(c.path === 'tela/websockify' && c.websockify === '/tela/websockify', 'na raiz: path tela/websockify, sem barra no começo');
  ok(c.novnc === '/tela/novnc/vnc.html?path=tela%2Fwebsockify&autoconnect=1&resize=scale', 'na raiz: a URL do noVNC');
  c = conta('/p/ana/');
  ok(c.path === 'p/ana/tela/websockify' && c.novnc.startsWith('/p/ana/tela/novnc/vnc.html?path=p%2Fana%2Ftela%2Fwebsockify&'), 'atrás do /p/<agente>/: o prefixo entra no path');
  c = conta('/agente/ana/painel/index.html');
  ok(c.prefixo === '/agente/ana/painel' && c.path === 'agente/ana/painel/tela/websockify', 'com BASE e index.html: o prefixo é o do painel');
  ok(conta('/p/ana').path === 'p/ana/tela/websockify', 'sem barra no fim dá o mesmo caminho');

  const passos = passosDoTutorial();
  ok(passos.length >= 4 && passos[0].alvo === null && passos.every((p) => p.titulo && p.corpo && p.porque), 'o tutorial: todo passo responde o que é, como funciona e por que está aqui');
  ok(passos.some((p) => /nunca passa pela conversa/.test(p.corpo)), 'o tutorial diz o porquê da tela (a senha nunca passa pela conversa)');
  const html = fs.readFileSync(path.join(AQUI, 'public/index.html'), 'utf-8');
  ok(html.includes('data-tab="tela"') && html.includes('id="panel-tela"') && html.includes('js/tela.js') && html.includes('css/tela.css'), 'o menu, o painel, o script e o css estão no index.html');
  const alvos = [...fonte.matchAll(/alvo: '#([^']+)'/g)].map((m) => m[1]);
  ok(alvos.length === 3 && alvos.every((id) => fonte.includes(`id="${id}"`)), 'todo alvo de passo existe no HTML que o js desenha');
  const dados = [...fonte.matchAll(/data-tutorial="([^"]+)"/g)].map((m) => m[1]);
  ok(dados.every((k) => passos.some((p) => p.chave === k)), 'todo "?" abre um passo que existe');
  ok(!/[—–]/.test(fonte), 'sem travessão no texto da tela');
}

// ─── O websockify falso ──────────────────────────────────────────────────────
async function livre() {
  return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

const visto = { cabecalhos: null, caminho: null };
const conexoesFalsas = new Set();
const falso = http.createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : (req.url.startsWith('/vnc.html') ? 200 : 404), { 'content-type': 'text/html' });
  res.end(req.url.startsWith('/vnc.html') ? 'NOVNC-FALSO' : 'ok');
});
falso.on('upgrade', (req, socket) => {
  visto.cabecalhos = req.headers;
  visto.caminho = req.url;
  conexoesFalsas.add(socket);
  const aceite = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${aceite}\r\n\r\n`);
  socket.on('data', (d) => socket.write(d)); // eco de bytes crus
  socket.on('error', () => {});
});
await new Promise((r) => falso.listen(0, '127.0.0.1', r));
const PORTA_FALSA = falso.address().port;
const cdpFalso = http.createServer((req, res) => {
  if (req.url === '/json/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"Browser":"Chrome/falso"}'); } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => cdpFalso.listen(0, '127.0.0.1', r));
const PORTA_CDP = cdpFalso.address().port;

async function subir(env, nome) {
  const pasta = path.join(RAIZ, nome);
  fs.mkdirSync(pasta, { recursive: true });
  const cfg = path.join(pasta, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    agentName: 'Agente de Teste', agentSlug: 'teste', agentDir: pasta, authSalt: 'sal-de-teste', creatorName: 'Dono de Teste',
    cofreDir: path.join(pasta, 'cofre'), cofreChaveMestra: path.join(pasta, 'cofre.chave'),
    cofreRuntimeDir: path.join(pasta, 'run'), cofreUnidade: 'dgclaw-teste-que-nao-existe-000',
  }));
  const p = await livre();
  const proc = spawn(process.execPath, [path.join(AQUI, 'server.js')], {
    cwd: AQUI,
    env: {
      ...process.env,
      DGCLAW_PANEL_PASSWORD: SENHA_PAINEL, DGCLAW_PANEL_PASSWORD_HASH: '', DGCLAW_PANEL_USER: '',
      DGCLAW_PANEL_PROXY_SECRET: SEGREDO_PROXY, DGCLAW_PANEL_PROXY_SECRET_FILE: '', DGCLAW_PANEL_BASE: '',
      DGCLAW_PANEL_CONFIG: cfg, DGCLAW_PANEL_PORT: String(p), DGCLAW_PANEL_HOST: '127.0.0.1',
      DGCLAW_TELA_NOVNC: `127.0.0.1:${PORTA_FALSA}`, DGCLAW_TELA_CDP: `127.0.0.1:${PORTA_CDP}`,
      DGCLAW_TELA_SENHA_ARQUIVO: path.join(pasta, 'tela', 'vnc.senha'), DGCLAW_TELA_URL_EXTERNA: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const painel = { pasta, porta: p, host: `127.0.0.1:${p}`, saida: '', proc, arquivoSenha: path.join(pasta, 'tela', 'vnc.senha'), fechar: () => proc.kill() };
  painel.url = `http://${painel.host}`;
  proc.stdout.on('data', (d) => { painel.saida += d; });
  proc.stderr.on('data', (d) => { painel.saida += d; });
  for (let i = 0; i < 100 && !/rodando|NÃO SUBI/.test(painel.saida); i++) await new Promise((r) => setTimeout(r, 100));
  return painel;
}

async function entrar(p, base = '') {
  const r = await fetch(`${p.url}${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: SENHA_PAINEL }).toString(),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

/** Um cliente WebSocket cru: manda o pedido de upgrade e devolve { status, resto, socket }. */
function upgrade(p, caminho, cabecalhos = {}) {
  return new Promise((resolve) => {
    const s = net.connect(p.porta, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let respondeu = false;
    const extra = Object.entries(cabecalhos).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    s.on('connect', () => s.write(`GET ${caminho} HTTP/1.1\r\nHost: ${p.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const fim = buf.indexOf('\r\n\r\n');
      if (fim === -1 || respondeu) return;
      respondeu = true;
      const cab = buf.subarray(0, fim).toString();
      // O corpo da recusa chega num segundo pacote: espera um instante antes de entregar.
      setTimeout(() => resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(cab)[1]), cab, corpo: buf.subarray(fim + 4).toString(), socket: s }), 150);
    });
    s.on('error', () => { if (!respondeu) { respondeu = true; resolve({ status: 0, cab: '', corpo: '', socket: s }); } });
    s.on('close', () => { if (!respondeu) { respondeu = true; resolve({ status: 0, cab: '', corpo: buf.toString(), socket: s }); } });
    setTimeout(() => { if (!respondeu) { respondeu = true; resolve({ status: -1, cab: '', corpo: '', socket: s }); } }, 4000);
  });
}

function eco(socket, texto) {
  return new Promise((resolve) => {
    let got = '';
    const t = setTimeout(() => resolve(got), 3000);
    socket.on('data', (d) => { got += d.toString(); if (got.includes(texto)) { clearTimeout(t); resolve(got); } });
    socket.write(texto);
  });
}

// ─── O painel de verdade ─────────────────────────────────────────────────────
const p = await subir({}, 'com-tela');
try {
  console.log('\nGET /api/tela');
  let r = await fetch(`${p.url}/api/tela`);
  ok(r.status === 401, 'sem login: 401');
  const cookie = await entrar(p);
  ok(cookie.startsWith('dash_token='), 'o login do teste funcionou');
  r = await fetch(`${p.url}/api/tela`, { headers: { cookie } });
  let corpo = await r.json();
  ok(r.status === 200 && corpo.ok === true && corpo.instalada === true && corpo.cdp === true, 'websockify e CDP falsos: instalada e cdp verdadeiros');
  ok(corpo.senha_definida === false && corpo.url_externa === null && corpo.caminho_websockify === '/tela/websockify', 'sem rfbauth: senha_definida falso; sem URL externa; caminho do websockify');

  console.log('\nPUT /api/tela/senha');
  const put = (senha, extra) => fetch(`${p.url}/api/tela/senha`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ senha }),
  });
  r = await put('abc123');
  ok(r.status === 401, 'sem login: 401');
  ok(!fs.existsSync(p.arquivoSenha), 'e nada foi gravado');
  r = await put('123456789', { cookie });
  corpo = await r.json();
  ok(r.status === 400 && /no máximo 8/.test(corpo.error) && corpo.howToFix, '9 caracteres: 400 com o motivo em português');
  ok(!fs.existsSync(p.arquivoSenha), 'a recusa não grava nada');
  r = await put('abc123', { cookie });
  corpo = await r.json();
  ok(r.status === 200 && corpo.ok === true && /desconectado/.test(corpo.aviso), 'senha válida: 200 com o aviso de desconexão');
  ok(fs.readFileSync(p.arquivoSenha).toString('hex') === '275ea8d255b012f2' && modo(p.arquivoSenha) === '600', 'o rfbauth foi gravado, modo 600');
  ok(modo(path.dirname(p.arquivoSenha)) === '700', 'a pasta nasceu com modo 700');
  ok(!p.saida.includes('abc123'), 'a senha não está no log do painel');
  r = await fetch(`${p.url}/api/tela`, { headers: { cookie } });
  ok((await r.json()).senha_definida === true, 'o status passa a dizer senha_definida');

  const chaves = buildChavesApi({ agentDir: p.pasta, creatorName: 'Dono de Teste' });
  const chave = chaves.criar({ nome: 'Teste da tela', quem: 'teste' }).token;
  r = await put('outra123', { Authorization: `Bearer ${chave}` });
  corpo = await r.json();
  ok(r.status === 403 && /chave de API/.test(corpo.error) && corpo.howToFix, 'com chave de API Bearer: 403 com motivo');
  ok(fs.readFileSync(p.arquivoSenha).toString('hex') === '275ea8d255b012f2', 'e a senha não mudou');
  r = await fetch(`${p.url}/api/tela`, { headers: { Authorization: `Bearer ${chave}` } });
  ok(r.status === 200, 'a chave de API LÊ o status (só não troca a senha)');

  console.log('\nOs arquivos do noVNC por HTTP');
  r = await fetch(`${p.url}/tela/novnc/vnc.html?autoconnect=1`, { redirect: 'manual' });
  ok(r.status === 302, 'sem login: não entrega o noVNC (redireciona para o login)');
  r = await fetch(`${p.url}/tela/novnc/vnc.html?autoconnect=1`, { headers: { cookie } });
  ok(r.status === 200 && (await r.text()) === 'NOVNC-FALSO', 'com login: o arquivo vem do noVNC falso');
  r = await fetch(`${p.url}/tela/novnc/%2e%2e%2f%2e%2e%2fetc/passwd`, { headers: { cookie } });
  ok(r.status === 400, 'caminho com .. codificado: 400');
  r = await fetch(`${p.url}/tela/novnc/vnc.html`, { headers: { Authorization: `Bearer ${chave}` }, redirect: 'manual' });
  ok(r.status === 302 || r.status === 401, 'chave de API não abre o noVNC');

  console.log('\nO WebSocket');
  let u = await upgrade(p, '/tela/websockify');
  ok(u.status === 401 && /entrar no painel/.test(u.corpo), 'sem login: 401 com motivo escrito no socket');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { Authorization: `Bearer ${chave}` });
  ok(u.status === 401, 'com chave de API Bearer: 401 (chave não abre a tela)');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { Cookie: cookie, Origin: 'https://site-do-mal.exemplo.com' });
  ok(u.status === 403 && /outro|não do endereço/.test(u.corpo), 'cookie com Origin de outro site: 403');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' });
  ok(u.status === 403, 'cookie com Sec-Fetch-Site cross-site: 403');
  u.socket.destroy();
  u = await upgrade(p, '/outra/coisa', { Cookie: cookie });
  ok(u.status === 404, 'outro caminho de upgrade: 404');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { 'X-DGClaw-Proxy': 'segredo-errado' });
  ok(u.status === 401, 'segredo do proxy errado: 401');
  u.socket.destroy();

  u = await upgrade(p, '/tela/websockify', { Cookie: cookie, Origin: p.url });
  ok(u.status === 101, 'cookie com Origin da mesma origem: 101');
  ok(visto.caminho === '/websockify', 'o websockify recebeu o caminho /websockify');
  ok(!visto.cabecalhos.cookie && !visto.cabecalhos.origin && !visto.cabecalhos['x-dgclaw-proxy'], 'e não recebeu cookie, Origin nem segredo');
  const bytes = 'bytes-crus-\x00\x01\x02-do-vnc';
  ok((await eco(u.socket, bytes)).includes(bytes), 'os bytes vão e voltam em eco, pelo repasse');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { 'X-DGClaw-Proxy': SEGREDO_PROXY, 'X-DGClaw-Usuario': 'Dono' });
  ok(u.status === 101 && (await eco(u.socket, 'via-proxy')).includes('via-proxy'), 'pelo segredo do proxy do DG Claw Web: 101 e eco');
  u.socket.destroy();
  u = await upgrade(p, '/tela/websockify', { Cookie: cookie });
  ok(u.status === 101, 'cookie sem Origin (cliente que não é navegador): 101');
  // Quando o lado de lá cai, o do navegador fecha.
  const fechou = new Promise((res) => u.socket.once('close', () => res(true)));
  for (const c of conexoesFalsas) c.destroy(); // o http.Server não fecha sozinho as conexões já promovidas a WebSocket
  ok(await Promise.race([fechou, new Promise((res) => setTimeout(() => res(false), 3000))]), 'quando o websockify cai, a conexão do navegador fecha também');
  ok(/WebSocket de .* recusado \(401\)/.test(p.saida) && !p.saida.includes(cookie.split('=')[1]), 'a recusa foi registrada no log, sem o cookie');
} finally {
  p.fechar();
}

console.log('\nAtrás de um prefixo (DGCLAW_PANEL_BASE=/p/ana)');
const pb = await subir({ DGCLAW_PANEL_BASE: '/p/ana', DGCLAW_TELA_URL_EXTERNA: 'https://tela-ana.exemplo.com' }, 'com-base');
try {
  const cookie = await entrar(pb, '/p/ana');
  let r = await fetch(`${pb.url}/p/ana/api/tela`, { headers: { cookie } });
  const corpo = await r.json();
  ok(r.status === 200 && corpo.caminho_websockify === '/p/ana/tela/websockify' && corpo.url_externa === 'https://tela-ana.exemplo.com', 'a API responde sob o prefixo, com caminho e URL externa');
  r = await fetch(`${pb.url}/p/ana/tela/novnc/vnc.html`, { headers: { cookie } });
  ok(r.status === 200, 'os arquivos do noVNC saem sob o prefixo');
  let u = await upgrade(pb, '/p/ana/tela/websockify', { Cookie: cookie, Origin: pb.url });
  ok(u.status === 101 && (await eco(u.socket, 'com-base')).includes('com-base'), 'o WebSocket sob o prefixo repassa em eco');
  u.socket.destroy();
  u = await upgrade(pb, '/tela/websockify', { Cookie: cookie });
  ok(u.status === 404, 'o caminho sem o prefixo não existe: 404');
  u.socket.destroy();
} finally {
  pb.fechar();
}

console.log('\nSem websockify (a tela não está instalada)');
const sem = await subir({ DGCLAW_TELA_NOVNC: `127.0.0.1:${await livre()}`, DGCLAW_TELA_CDP: `127.0.0.1:${await livre()}`, DGCLAW_TELA_URL_EXTERNA: 'javascript:alert(1)' }, 'sem-tela');
try {
  const cookie = await entrar(sem);
  const r = await fetch(`${sem.url}/api/tela`, { headers: { cookie } });
  const corpo = await r.json();
  ok(r.status === 200 && corpo.instalada === false && corpo.cdp === false && corpo.senha_definida === false, 'instalada, cdp e senha_definida falsos');
  ok(corpo.url_externa === null && /DGCLAW_TELA_URL_EXTERNA/.test(sem.saida), 'URL externa que não é http(s) é ignorada, com aviso no log');
  const u = await upgrade(sem, '/tela/websockify', { Cookie: cookie });
  ok(u.status === 502 && /não respondeu/.test(u.corpo), 'WebSocket sem tela: 502 com motivo');
  u.socket.destroy();
  const h = await fetch(`${sem.url}/tela/novnc/vnc.html`, { headers: { cookie } });
  ok(h.status === 502 && /ainda não tem tela/.test(await h.text()), 'arquivo do noVNC sem tela: 502 com motivo');
} finally {
  sem.fechar();
}

falso.close(); cdpFalso.close();
fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
