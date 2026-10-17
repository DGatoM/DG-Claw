// test-menu-unico.mjs - o painel sob a plataforma (BASE = /p/<slug>) tem a conversa do chat
// como tela principal: "voltar" leva a /a/<slug>, e cada agente do seletor usa a PRÓPRIA foto.
//
// Sobe o painel de verdade (com BASE e senha de teste), loga e confere o HTML entregue.
// A parte do front (htmlSeletorPlataforma) é extraída do app.js e rodada isolada.
// Uso: node test-menu-unico.mjs (precisa de express: panel/node_modules ou NODE_PATH)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
let falhas = 0;
const ok = (cond, msg) => { console.log(cond ? `  ok   ${msg}` : `  FALHOU  ${msg}`); if (!cond) falhas++; };

// ── 1. Front: o seletor sob a plataforma ─────────────────────────────────────
const app = fs.readFileSync(path.join(AQUI, 'public/js/app.js'), 'utf-8');
const ini = app.indexOf('function htmlSeletorPlataforma');
const fim = app.indexOf('/** Itens do seletor de um painel solto');
ok(ini > 0 && fim > ini, 'achei htmlSeletorPlataforma no app.js');
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const htmlSeletorPlataforma = new Function('escapeHtml', `${app.slice(ini, fim)}; return htmlSeletorPlataforma;`)(escapeHtml);

const agentes = [
  { id: 'ana', nome: 'Ana', subtitulo: 'Claude', cor: '#aa0000', avatar: 'A', avatar_img: '/fotos/ana.png' },
  { id: 'bento', nome: 'Bento', subtitulo: 'Codex', cor: '#00aa00', avatar: 'B', avatar_img: '/fotos/bento.png' },
  { id: 'caio', nome: 'Caio', subtitulo: 'Claude', cor: '#0000aa', avatar: '🦊', avatar_img: null },
];
const html = htmlSeletorPlataforma(agentes, 'ana', '/p/ana/assets/sprites/ana-atual.png');
ok(html.includes('src="/fotos/bento.png"'), 'seletor: o Bento usa a foto dele');
ok(!html.includes('avatar.jpg'), 'seletor: ninguém cai na foto padrão compartilhada');
ok(html.includes('src="/p/ana/assets/sprites/ana-atual.png"'), 'seletor: o atual usa a foto do APP_CONFIG');
ok(/background:#0000aa[^>]*>🦊</.test(html), 'seletor: sem foto, círculo com a cor e o emoji do agente');
ok(html.includes('href="/a/bento"') && html.includes('href="/a/caio"'), 'seletor: cada item leva a /a/<id>');
ok(!/target="_blank"/.test(html), 'seletor: abre na mesma janela');
ok(!html.includes('href="/a/ana"'), 'seletor: o atual não é link');

// ── 2. Servidor: {{VOLTAR}} sob a plataforma ─────────────────────────────────
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-unico-'));
const PORTA = 18700 + Math.floor(Math.random() * 200);
const SENHA = 'senha-de-teste-bem-longa-123';
const subir = (base) => {
  const env = { ...process.env, HOME: RAIZ, DGCLAW_PANEL_PORT: String(PORTA), DGCLAW_PANEL_HOST: '127.0.0.1',
    DGCLAW_PANEL_PASSWORD: SENHA, DGCLAW_PANEL_BASE: base, DGCLAW_SAUDE_CHECAR_LOGIN: 'off' };
  if (process.env.DGCLAW_TEST_NODE_PATH) env.NODE_PATH = process.env.DGCLAW_TEST_NODE_PATH;
  return spawn('node', ['server.js'], { cwd: AQUI, env, stdio: 'ignore' });
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function paginaInicial(base) {
  const filho = subir(base);
  try {
    let login;
    for (let i = 0; i < 40 && !login; i++) {
      try { login = await fetch(`http://127.0.0.1:${PORTA}${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(SENHA)}` }); }
      catch { await dormir(250); }
    }
    if (!login) return null;
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const r = await fetch(`http://127.0.0.1:${PORTA}${base}/`, { headers: { Cookie: cookie } });
    return await r.text();
  } finally { filho.kill(); await dormir(300); }
}

const sob = await paginaInicial('/p/ana');
if (sob == null) { console.log('  pulado: o painel não subiu (falta express? use NODE_PATH ou npm i em panel/)'); process.exit(3); }
ok(/<a class="btn-voltar" href="\/a\/ana" aria-label="voltar para a conversa">/.test(sob), 'sob a plataforma: voltar aponta para /a/ana');
ok(sob.includes('btn-voltar-texto">conversa<'), 'sob a plataforma: o rótulo é "conversa"');
ok(!sob.includes('meus assistentes'), 'sob a plataforma: sumiu "meus assistentes"');

// {{CASCA}}: sob a plataforma o index.html carrega o cabeçalho e o menu da Conversa (casca.js)
ok(sob.includes('<link rel="stylesheet" href="/casca.css">') && sob.includes('<link rel="stylesheet" href="/menu-lado.css">'), 'sob a plataforma: links do casca.css e do menu-lado.css');
ok(sob.indexOf('/casca.css') < sob.indexOf('/menu-lado.css'), 'sob a plataforma: casca.css vem antes do menu-lado.css');
ok(['/tour.js', '/menu-lado.js', '/casca.js'].every((u) => sob.includes(`<script src="${u}"></script>`)), 'sob a plataforma: scripts tour, menu-lado e casca');
ok(sob.indexOf('/menu-lado.js') < sob.indexOf('/casca.js') && sob.indexOf('/casca.js') < sob.indexOf('/js/app.js'), 'sob a plataforma: a casca carrega antes do app.js');
ok(!sob.includes('{{CASCA}}'), 'sob a plataforma: placeholder trocado');

const solto = await paginaInicial('');
ok(solto != null && !solto.includes('btn-voltar'), 'painel solto: sem botão de voltar, como antes');
ok(solto != null && !/casca|menu-lado/.test(solto), 'painel solto: nada da casca (sem links nem placeholder)');

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
