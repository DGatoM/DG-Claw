// test-troca-sem-casca-antiga.mjs - ao trocar de página no painel sob a plataforma (BASE = /p/<slug>) o
// layout antigo (retrato, "--", "carregando a conversa") nunca pode aparecer, e os css/js ficam em cache.
//
// Parte 1 sobe o painel de verdade (com e sem BASE), loga e confere o HTML e os cabeçalhos de cache.
// Parte 2 lê o app.js, o index.html e o main.css e confere a ordem do boot e as três saídas do estado
// "carregando" (a aba abriu, o init falhou, passou de 8 segundos). As funções de saída rodam isoladas num
// documento de mentira.
// Uso: node test-troca-sem-casca-antiga.mjs (precisa de express: panel/node_modules ou NODE_PATH)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
let falhas = 0;
const ok = (cond, msg) => { console.log(cond ? `  ok   ${msg}` : `  FALHOU  ${msg}`); if (!cond) falhas++; };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'troca-sem-casca-'));
const PORTA = 18900 + Math.floor(Math.random() * 200);
const SENHA = 'senha-de-teste-bem-longa-123';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const subir = (base) => {
  const env = { ...process.env, HOME: RAIZ, DGCLAW_PANEL_PORT: String(PORTA), DGCLAW_PANEL_HOST: '127.0.0.1',
    DGCLAW_PANEL_PASSWORD: SENHA, DGCLAW_PANEL_BASE: base, DGCLAW_SAUDE_CHECAR_LOGIN: 'off' };
  if (process.env.DGCLAW_TEST_NODE_PATH) env.NODE_PATH = process.env.DGCLAW_TEST_NODE_PATH;
  return spawn('node', ['server.js'], { cwd: AQUI, env, stdio: 'ignore' });
};

// Sobe o painel, loga e devolve uma função get(caminho, {semCookie}) -> { status, headers, texto }.
async function comPainel(base, fn) {
  const filho = subir(base);
  try {
    let login;
    for (let i = 0; i < 40 && !login; i++) {
      try { login = await fetch(`http://127.0.0.1:${PORTA}${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(SENHA)}` }); }
      catch { await dormir(250); }
    }
    if (!login) return false;
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const get = async (caminho, o = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORTA}${base}${caminho}`, { redirect: 'manual', headers: o.semCookie ? {} : { Cookie: cookie } });
      return { status: r.status, headers: r.headers, texto: await r.text() };
    };
    await fn(get);
    return true;
  } finally { filho.kill(); await dormir(300); }
}

// ── 1. Servidor ──────────────────────────────────────────────────────────────
let sob = null; let solto = null; let loginSob = null; let cacheSob = null;
const subiu = await comPainel('/p/ana', async (get) => {
  sob = (await get('/')).texto;
  const v = (/\/css\/main\.css\?v=([0-9a-f]+)"/.exec(sob) || [])[1];
  const outra = (await get('/')).texto;
  cacheSob = { v, estavel: (/\/css\/main\.css\?v=([0-9a-f]+)"/.exec(outra) || [])[1] === v };
  if (v) {
    const com = await get(`/css/main.css?v=${v}`);
    const js = await get(`/js/app.js?v=${v}`);
    const sem = await get('/css/main.css');
    const ruim = await get('/css/main.css?v=zz');
    const html = await get(`/index.html?v=${v}`);
    const anonimo = await get(`/js/app.js?v=${v}`, { semCookie: true });
    Object.assign(cacheSob, { com, js, sem, ruim, html, anonimo });
  }
  loginSob = (await get('/login.html', { semCookie: true })).texto;
});
if (!subiu) { console.log('  pulado: o painel não subiu (falta express? use NODE_PATH ou npm i em panel/)'); process.exit(3); }

ok(/<html lang="pt-BR" class="casca carregando">/.test(sob), 'sob a plataforma: o servidor já entrega <html class="casca carregando">');
ok(!sob.includes('{{HTML_CLASSE}}'), 'sob a plataforma: marcador da classe trocado');
ok(/<noscript><style>[^<]*html\.casca\.carregando/.test(sob), 'sob a plataforma: noscript anula o estado carregando');
ok(/setTimeout\(function\(\)\{[^]*?\},8000\)/.test(sob) && /remove\('carregando'\)/.test(sob), 'sob a plataforma: vigia de 8 segundos no HTML');
const links = [...sob.matchAll(/(?:href|src)="(\/p\/ana\/(?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
ok(links.length >= 20 && links.every((u) => /\?v=[0-9a-f]{10}$/.test(u)), `os ${links.length} css/js do painel levam ?v=<versão>`);
ok(cacheSob.estavel, 'a versão não muda entre dois pedidos seguidos');
ok(!/\/(casca|menu-lado|tour)\.(css|js)\?v=/.test(sob), 'arquivos da raiz (casca, menu-lado, tour) não ganham ?v= (são do Web)');
ok(cacheSob.com?.headers.get('cache-control') === 'private, max-age=31536000, immutable', 'css com ?v=: Cache-Control private, 1 ano, immutable');
ok(cacheSob.js?.status === 200 && cacheSob.js.headers.get('cache-control') === 'private, max-age=31536000, immutable', 'js com ?v=: idem');
ok(cacheSob.sem?.status === 200 && !/immutable|31536000/.test(cacheSob.sem.headers.get('cache-control') || ''), 'sem ?v=: comportamento de antes (sem immutable)');
ok(!/immutable/.test(cacheSob.ruim?.headers.get('cache-control') || ''), '?v= malformado não ganha cache longo');
ok(!/immutable/.test(cacheSob.html?.headers.get('cache-control') || ''), 'a página (HTML) nunca ganha cache longo, nem com ?v=');
ok(cacheSob.anonimo?.status !== 200 && !/immutable/.test(cacheSob.anonimo?.headers.get('cache-control') || ''), `sem login o arquivo continua negado (status ${cacheSob.anonimo?.status})`);
ok(!/class="casca/.test(loginSob), 'tela de login: sem a classe da casca');

await comPainel('', async (get) => { solto = (await get('/')).texto; });
ok(/<html lang="pt-BR">/.test(solto), 'painel solto: <html> sem classe (a tela fica como era)');
ok(!/\/(casca|menu-lado)\./.test(solto), 'painel solto: nada da casca');

// ── 2. Boot (app.js) ─────────────────────────────────────────────────────────
const app = fs.readFileSync(path.join(AQUI, 'public/js/app.js'), 'utf-8');
const iniInit = app.indexOf('(async function init() {');
const fimInit = app.indexOf('})().catch(falhaNoBoot);');
ok(iniInit > 0 && fimInit > iniInit, 'o init termina com .catch(falhaNoBoot) (init que rejeita não deixa tela presa)');
const corpoInit = app.slice(iniInit, fimInit);
const primeiroAwait = corpoInit.indexOf('await ');
ok(primeiroAwait > 0 && corpoInit.slice(0, primeiroAwait).includes('montaCascaCedo('), 'init: a casca é montada ANTES do primeiro await');
const iniMonta = app.indexOf('function montaCascaCedo');
const corpoMonta = app.slice(iniMonta, app.indexOf('function ligaExtrasDaCasca'));
ok(corpoMonta.includes('window.DGCasca.monta(') && corpoMonta.includes('moveEstadoParaConteudo()'), 'montaCascaCedo: monta a casca e move o estado para o conteúdo');
ok(!corpoMonta.includes('sincronizaCasca'), 'montaCascaCedo: os extras do menu esperam o initPowers (sem piscar item de poder desligado)');
ok(/await Promise\.all\(\[initConfig\(\), initPowers\(\)\]\)/.test(corpoInit), 'init: config e powers rodam em paralelo');
ok(corpoInit.indexOf('ligaExtrasDaCasca()') > corpoInit.indexOf('Promise.all'), 'init: os extras do menu entram depois do initPowers');
ok(/\.finally\(sairDoCarregando\)/.test(corpoInit) && corpoInit.indexOf('abrirAba(abaInicial, botaoInicial)') < corpoInit.indexOf('.finally(sairDoCarregando)'), 'saída 1: sai do carregando depois de abrir a aba inicial');

// As funções de saída rodam isoladas, num documento de mentira.
function mundo() {
  const classes = new Set(['casca', 'carregando']);
  const avisos = []; const erros = []; const inseridos = [];
  const el = (tag) => ({ tag, className: '', textContent: '', attrs: {}, filhos: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...a) { this.filhos.push(...a); },
    insertBefore(n) { inseridos.push(n); }, get firstChild() { return null; } });
  const doc = { documentElement: { classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) } },
    createElement: el, querySelector: () => null, body: el('body') };
  const ctx = vm.createContext({ document: doc, window: {}, console: { warn: (...a) => avisos.push(a.join(' ')), error: (...a) => erros.push(a.join(' ')) }, NA_PLATAFORMA: true,
    rotuloDaAba: () => '', tutorialDaCasca: () => {}, moveEstadoParaConteudo: () => {} });
  const corte = (de, ate) => app.slice(app.indexOf(de), app.indexOf(ate));
  vm.runInContext(corte('function sairDoCarregando', '// Monta o cabeçalho e o menu da casca na hora') + corte('function montaCascaCedo', 'function ligaExtrasDaCasca'), ctx);
  return { ctx, classes, avisos, erros, inseridos };
}
{
  const m = mundo();
  vm.runInContext('sairDoCarregando()', m.ctx);
  ok(!m.classes.has('carregando') && m.classes.has('casca'), 'saída 1: sairDoCarregando tira só o "carregando" e mantém a casca');
}
{
  const m = mundo();
  vm.runInContext("falhaNoBoot(new Error('o servidor não respondeu'))", m.ctx);
  const aviso = m.inseridos[0];
  ok(!m.classes.has('carregando'), 'saída 2: init que falha tira o carregando');
  ok(m.erros.length === 1 && m.erros[0].includes('o servidor não respondeu'), 'saída 2: console.error com o motivo');
  ok(aviso && aviso.attrs.role === 'alert' && aviso.filhos.some((f) => typeof f === 'string' && f.includes('o servidor não respondeu') && f.includes('O que fazer')), 'saída 2: mensagem em português na própria tela, com a causa e o que fazer');
  ok(app.includes('titulo.textContent') && !/aviso\.innerHTML/.test(app), 'saída 2: o motivo entra como texto (sem innerHTML)');
}
{
  const m = mundo();
  const comCasca = vm.runInContext('montaCascaCedo("status")', m.ctx);
  ok(comCasca === false && !m.classes.has('casca') && !m.classes.has('carregando'), 'saída 3: sem window.DGCasca saem as duas classes e o menu antigo aparece');
  ok(m.avisos.length === 1 && m.avisos[0].includes('/casca.js'), 'saída 3: o console.warn existente continua');
}
ok(/setTimeout\(function\(\)\{var h=document\.documentElement;if\(!h\.classList\.contains\('carregando'\)\)return;h\.classList\.remove\('carregando'\);if\(!document\.getElementById\('cabecalho'\)\)h\.classList\.remove\('casca'\)[^]*?,8000\)/.test(sob), 'saída 4: o vigia de 8 segundos libera a tela (e devolve o menu antigo se a casca não montou)');
ok(!/<noscript>|setTimeout/.test(solto), 'painel solto: sem o vigia nem o noscript do carregando');

// ── 3. CSS ───────────────────────────────────────────────────────────────────
const css = fs.readFileSync(path.join(AQUI, 'public/css/main.css'), 'utf-8');
ok(/html\.casca \.content\{max-width:none/.test(css), 'css: sob a casca o conteúdo usa a largura toda');
const regrasCarregando = css.split('\n').filter((l) => l.includes('carregando') && l.includes('{'));
ok(regrasCarregando.length >= 5 && regrasCarregando.every((l) => /^(\s*|@media \(prefers-reduced-motion:reduce\)\{)html\.casca\.carregando/.test(l)), 'css: toda regra do carregando está sob html.casca.carregando (o painel solto não é afetado)');
ok(/prefers-reduced-motion:reduce\)\{html\.casca\.carregando \.app::after\{animation:none\}/.test(css), 'css: respeita prefers-reduced-motion');
const blocoCarregando = css.slice(css.indexOf('html.casca.carregando body{'), css.indexOf('.erro-boot'));
ok(!/scale\(/.test(blocoCarregando) && !/#(?:[0-9a-f]{2})?(?:7c3aed|8b5cf6|4f46e5|a855f7)/i.test(blocoCarregando), 'css: sem transform scale e sem roxo no carregando');
ok(!/avatar|default\.gif/.test(blocoCarregando), 'css: o carregando não mostra avatar nem texto de agente');

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
