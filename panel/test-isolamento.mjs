// test-isolamento.mjs - o painel dentro da moldura do Web (iframe sandbox, origem opaca).
//
// O Web serve o painel por /pv/<token>/... e avisa o painel em X-DGClaw-Base. Aqui se confere que:
//   1. o painel só usa essa base quando o segredo do proxy confere E a base tem o formato /pv/<token> (senão ignora);
//   2. dentro da moldura o HTML não carrega a casca do Web (/casca.js, /menu-lado.js, /tour.js) e carrega o casca-ponte.js;
//   3. sem o cabeçalho (ou painel solto) o HTML é o de sempre;
//   4. o casca-ponte.js fala com a moldura só por postMessage, com dados sem segredo, e só ouve a janela de cima;
//   5. nenhum acesso a localStorage/sessionStorage do painel fica fora de try/catch (origem opaca lança erro).
// Tudo que parece segredo aqui é falso. Uso: node test-isolamento.mjs (precisa do express: NODE_PATH ou panel/node_modules).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
let falhas = 0;
const ok = (cond, msg) => { console.log(cond ? `  ok   ${msg}` : `  FALHOU  ${msg}`); if (!cond) falhas++; };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'isolamento-'));
const PORTA = 19300 + Math.floor(Math.random() * 300);
const CHAVE_DO_PROXY = 'valor-do-proxy-so-para-teste-isolamento';
// Preenchimento óbvio no lugar do identificador: o formato (/pv/ + 20 a 400 caracteres de caminho) é o que o painel confere.
const BASE_PV = `/pv/${'t'.repeat(24)}.${'m'.repeat(43)}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const arquivoDoProxy = path.join(RAIZ, 'proxy.valor');
fs.writeFileSync(arquivoDoProxy, `${CHAVE_DO_PROXY}\n`, { mode: 0o600 });

async function comPainel(base, env, fn) {
  const pasta = path.join(RAIZ, `p-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(pasta, { recursive: true });
  const cfg = path.join(pasta, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    agentName: 'Agente de Teste', agentSlug: 'ana', agentDir: pasta, authSalt: 'sal-de-teste', creatorName: 'Dono de Teste',
    cofreDir: path.join(pasta, 'cofre'), cofreChaveMestra: path.join(pasta, 'cofre.chave'), cofreRuntimeDir: path.join(pasta, 'run'), cofreUnidade: 'dgclaw-teste-que-nao-existe-000',
  }));
  const penv = {
    ...process.env, HOME: pasta, DGCLAW_PANEL_PORT: String(PORTA), DGCLAW_PANEL_HOST: '127.0.0.1', DGCLAW_PANEL_PASSWORD: 'senha-de-teste-bem-longa-123',
    DGCLAW_PANEL_PASSWORD_HASH: '', DGCLAW_PANEL_USER: '', DGCLAW_PANEL_BASE: base, DGCLAW_PANEL_CONFIG: cfg, DGCLAW_SAUDE_CHECAR_LOGIN: 'off',
    DGCLAW_PANEL_PROXY_SECRET: '', DGCLAW_PANEL_PROXY_SECRET_FILE: '', ...env,
  };
  if (process.env.DGCLAW_TEST_NODE_PATH) penv.NODE_PATH = process.env.DGCLAW_TEST_NODE_PATH;
  const filho = spawn('node', ['server.js'], { cwd: AQUI, env: penv, stdio: 'ignore' });
  try {
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORTA}${base}/login.html`); pronto = r.status > 0; } catch { await dormir(250); }
    }
    if (!pronto) return false;
    const pedir = async (caminho, { cab = {}, metodo = 'GET' } = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORTA}${base}${caminho}`, { method: metodo, redirect: 'manual', headers: cab });
      return { status: r.status, headers: r.headers, texto: await r.text() };
    };
    await fn(pedir);
    return true;
  } finally { filho.kill(); await dormir(300); }
}

const doProxy = { 'x-dgclaw-proxy': CHAVE_DO_PROXY };
let isolado; let normal; let loginIsolado; let logout; let solto;
const outras = {};
const subiu = await comPainel('/p/ana', { DGCLAW_PANEL_PROXY_SECRET_FILE: arquivoDoProxy }, async (pedir) => {
  isolado = (await pedir('/', { cab: { ...doProxy, 'x-dgclaw-base': BASE_PV } })).texto;
  normal = (await pedir('/', { cab: doProxy })).texto;
  const ruins = {
    'segredo errado': { 'x-dgclaw-proxy': 'valor-errado', 'x-dgclaw-base': BASE_PV },
    'sem segredo': { 'x-dgclaw-base': BASE_PV },
    'token curto demais': { ...doProxy, 'x-dgclaw-base': '/pv/curto' },
    'caminho depois do token': { ...doProxy, 'x-dgclaw-base': `${BASE_PV}/x` },
    'barra dupla': { ...doProxy, 'x-dgclaw-base': '//evil.example' },
    'prefixo errado': { ...doProxy, 'x-dgclaw-base': `/p/${'t'.repeat(30)}` },
    'aspas e tag': { ...doProxy, 'x-dgclaw-base': `/pv/${'a'.repeat(30)}"><script>alert(1)</script>` },
    'barra final': { ...doProxy, 'x-dgclaw-base': `${BASE_PV}/` },
    'longo demais': { ...doProxy, 'x-dgclaw-base': `/pv/${'a'.repeat(401)}` },
  };
  for (const [nome, cab] of Object.entries(ruins)) outras[nome] = (await pedir('/', { cab })).texto;
  loginIsolado = (await pedir('/login.html', { cab: { ...doProxy, 'x-dgclaw-base': BASE_PV } })).texto;
  logout = await pedir('/logout', { metodo: 'POST', cab: { ...doProxy, 'x-dgclaw-base': BASE_PV } });
});
if (!subiu) { console.log('  pulado: o painel não subiu (falta express? use NODE_PATH ou npm i em panel/)'); process.exit(3); }

console.log('\nHTML dentro da moldura (segredo do proxy certo + X-DGClaw-Base válido)');
ok(isolado.includes(`window.DGCLAW_BASE="${BASE_PV}"`), 'DGCLAW_BASE é a base do pedido');
ok(isolado.includes('window.DGCLAW_ISOLADO={"slug":"ana"}'), 'DGCLAW_ISOLADO diz o agente');
const links = [...isolado.matchAll(/(?:href|src)="([^"]*\/(?:css|js|assets)\/[^"]+)"/g)].map((m) => m[1]);
ok(links.length >= 20 && links.every((u) => u.startsWith(`${BASE_PV}/`)), `os ${links.length} css/js/assets usam a base do token`);
ok(!isolado.includes('/p/ana'), 'nenhum caminho /p/ana sobrou no HTML');
ok(!/\{\{[A-Z_]+\}\}/.test(isolado), 'nenhum marcador sobrou sem trocar');
ok(!/\/(casca|menu-lado|tour)\.(css|js)/.test(isolado), 'a casca do Web (/casca.js, /menu-lado.js, /tour.js e os css) não entra');
ok(isolado.includes(`src="${BASE_PV}/js/casca-ponte.js?v=`), 'entra o casca-ponte.js, com ?v=');
ok(isolado.indexOf('casca-ponte.js') < isolado.indexOf('/js/app.js'), 'o casca-ponte vem antes do app.js');
ok(/<html lang="pt-BR" class="casca carregando">/.test(isolado), 'a classe da casca fica (esconde o menu antigo do painel)');
ok(isolado.includes('data-dgclaw-ir="/a/ana"') && !/class="btn-voltar" href="\/a\/ana"/.test(isolado), 'o link "voltar para a conversa" pede à moldura em vez de navegar');
ok(loginIsolado.includes(`${BASE_PV}/`) && !loginIsolado.includes('/p/ana'), 'a tela de login também usa a base do pedido');
ok(logout.status === 302 && logout.headers.get('location') === `${BASE_PV}/login.html`, 'sair redireciona para a base do pedido');

console.log('\nSem o cabeçalho, ou com cabeçalho que o painel não aceita, tudo fica como era');
ok(normal.includes('window.DGCLAW_BASE="/p/ana"') && normal.includes('window.DGCLAW_ISOLADO=null'), 'sem X-DGClaw-Base: base fixa e não isolado');
ok(/\/casca\.js/.test(normal) && /\/menu-lado\.js/.test(normal) && /\/tour\.js/.test(normal) && !normal.includes('casca-ponte'), 'sem X-DGClaw-Base: a casca do Web, sem a ponte');
ok(/class="btn-voltar" href="\/a\/ana"/.test(normal) && !normal.includes('data-dgclaw-ir'), 'sem X-DGClaw-Base: o link de voltar é o de sempre');
for (const [nome, html] of Object.entries(outras)) {
  // Sem o segredo certo o painel nem autentica o pedido (vai ao login): o que importa é a base nunca aparecer.
  if (nome === 'segredo errado' || nome === 'sem segredo') ok(!html.includes(BASE_PV) && !html.includes('DGCLAW_ISOLADO={"'), `X-DGClaw-Base sem o segredo certo (${nome}): ignorado, nada da base na resposta`);
  else ok(html === normal, `X-DGClaw-Base ignorado (${nome}): o HTML é o de sempre`);
}

console.log('\nPainel solto (sem plataforma)');
await comPainel('', { DGCLAW_PANEL_PROXY_SECRET_FILE: arquivoDoProxy }, async (pedir) => { solto = (await pedir('/', { cab: { ...doProxy, 'x-dgclaw-base': BASE_PV } })).texto; });
ok(solto.includes('window.DGCLAW_BASE=""') && solto.includes('window.DGCLAW_ISOLADO=null') && !/\/(casca|menu-lado)\./.test(solto) && /<html lang="pt-BR">/.test(solto), 'sem BASE: igual a antes, mesmo que mandem o cabeçalho com o segredo certo');

// ── casca-ponte.js ───────────────────────────────────────────────────────────
console.log('\ncasca-ponte.js');
function montaAmbiente(comPai) {
  const enviadas = []; const ouvintes = {}; const docOuvintes = {};
  const pai = { postMessage: (m, alvo) => enviadas.push({ m, alvo }) };
  const loc = { hash: '' };
  const janela = {
    location: loc, addEventListener: (t, f) => { ouvintes[t] = f; },
    document: { addEventListener: (t, f) => { docOuvintes[t] = f; }, documentElement: { dataset: {} } },
  };
  janela.window = janela;
  janela.parent = comPai ? pai : janela;
  const ctx = vm.createContext({ window: janela, document: janela.document, location: loc, console, Promise, Object, Array, String, JSON });
  vm.runInContext(fs.readFileSync(path.join(AQUI, 'public/js/casca-ponte.js'), 'utf8'), ctx);
  return { janela, enviadas, ouvintes, docOuvintes, pai, loc };
}
{
  const a = montaAmbiente(true);
  ok(a.enviadas.length === 1 && a.enviadas[0].m.tipo === 'pronto' && a.enviadas[0].m.dgclaw === 1 && a.enviadas[0].alvo === '*', 'ao carregar, avisa a moldura que está pronto');
  const C = a.janela.DGCasca;
  ok(['monta', 'ativa', 'extras', 'tutorialMenu'].every((f) => typeof C[f] === 'function'), 'tem a interface que o app.js usa (monta, ativa, extras, tutorialMenu)');
  let tutoriais = 0;
  C.monta({ pagina: 'status', titulo: 'Status', aoTutorial: () => { tutoriais++; } });
  C.ativa('memory', 'Memória'); C.ativa('memory');
  C.extras([{ chave: 'posts', ico: '📷', nome: 'Posts', outro: 'não vai' }, null, { nome: 'sem chave' }]);
  C.tutorialMenu();
  const tipos = a.enviadas.slice(1).map((e) => e.m);
  ok(tipos[0].tipo === 'ativa' && tipos[0].pagina === 'status' && tipos[0].titulo === 'Status', 'monta repassa a página e o título');
  ok(tipos[1].pagina === 'memory' && tipos[1].titulo === 'Memória' && tipos[2].titulo === null, 'ativa repassa a página e o título (ou null quando não vem)');
  ok(tipos[3].tipo === 'extras' && JSON.stringify(tipos[3].lista) === JSON.stringify([{ chave: 'posts', ico: '📷', nome: 'Posts' }]), 'extras manda só chave, ícone e nome');
  ok(tipos[4].tipo === 'tutorial-menu', 'tutorialMenu pede o tutorial do menu à moldura');
  C.ir('/a/ana');
  ok(a.enviadas.at(-1).m.tipo === 'ir' && a.enviadas.at(-1).m.para === '/a/ana', 'ir pede a página à moldura');
  const alvo = { getAttribute: () => '/a/bob' };
  let evitou = false;
  a.docOuvintes.click({ target: { closest: (s) => (s === '[data-dgclaw-ir]' ? alvo : null) }, preventDefault: () => { evitou = true; } });
  ok(evitou && a.enviadas.at(-1).m.para === '/a/bob', 'clique em [data-dgclaw-ir] vira pedido à moldura, sem navegar');
  const n = a.enviadas.length;
  a.docOuvintes.click({ target: { closest: () => null }, preventDefault: () => { throw new Error('não devia'); } });
  ok(a.enviadas.length === n, 'clique em outro lugar não faz nada');

  const recebe = (dados, fonte) => a.ouvintes.message({ source: fonte === undefined ? a.pai : fonte, data: dados });
  recebe({ dgclaw: 1, tipo: 'aba', chave: 'costs' });
  ok(a.loc.hash === '#aba=costs', "mensagem 'aba' da moldura troca o #aba= (o app.js ouve o hashchange)");
  a.loc.hash = '';
  recebe({ dgclaw: 1, tipo: 'aba', chave: 'costs' }, { outra: 1 });
  recebe({ dgclaw: 1, tipo: 'aba', chave: '../x' });
  recebe({ dgclaw: 1, tipo: 'aba', chave: 'a b' });
  recebe({ tipo: 'aba', chave: 'costs' });
  recebe('texto');
  ok(a.loc.hash === '', 'mensagem de outra janela, sem formato ou com chave inválida é ignorada');
  recebe({ dgclaw: 1, tipo: 'tutorial' });
  ok(tutoriais === 1, "mensagem 'tutorial' chama o tutorial da página");
  recebe({ dgclaw: 1, tipo: 'tema', valor: 'escuro' });
  ok(a.janela.document.documentElement.dataset.tema === 'escuro', "mensagem 'tema' aplica o tema");
  recebe({ dgclaw: 1, tipo: 'tema', valor: '<x>' });
  ok(a.janela.document.documentElement.dataset.tema === 'escuro', 'tema fora de claro/escuro é ignorado');
}
{
  // aberta direto, sem janela de cima: não quebra e não manda nada
  const b = montaAmbiente(false);
  b.janela.DGCasca.ativa('status', 'x');
  b.janela.DGCasca.ir('/a/ana');
  ok(b.enviadas.length === 0, 'sem janela de cima, a ponte fica calada em vez de quebrar');
}

// ── storage em origem opaca ──────────────────────────────────────────────────
console.log('\nlocalStorage e sessionStorage (lançam erro em origem opaca)');
{
  const dirJs = path.join(AQUI, 'public/js');
  const soltos = [];
  for (const nome of fs.readdirSync(dirJs).filter((n) => n.endsWith('.js'))) {
    const linhas = fs.readFileSync(path.join(dirJs, nome), 'utf8').split('\n');
    linhas.forEach((l, i) => {
      if (!/\b(?:localStorage|sessionStorage)\b/.test(l) || /^\s*(?:\/\/|\*)/.test(l)) return;
      const janela = linhas.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!/\btry\b/.test(janela)) soltos.push(`${nome}:${i + 1}`);
    });
  }
  ok(soltos.length === 0, `todo acesso a storage está em try/catch${soltos.length ? ` (soltos: ${soltos.join(', ')})` : ''}`);
  const app = fs.readFileSync(path.join(dirJs, 'app.js'), 'utf8');
  ok(!/credentials: 'include'/.test(app), "nenhum fetch do painel usa credentials 'include' (CORS com origem * não aceita)");
}

fs.rmSync(RAIZ, { recursive: true, force: true });
process.exit(falhas ? 1 : 0);
