#!/usr/bin/env node
// roteiro-navegacao.mjs: o QA de navegação do DG Claw. Roda ANTES de abrir qualquer PR que mexa
// em tela (web/public, panel/public, casca, menu). Ver docs/QA.md.
//
// O que faz: entra como o dono, abre a Conversa e CLICA, no menu da esquerda, em cada item (Conversa,
// Mesa, Lembretes e as abas do painel). Em cada tela, em 1440x900 e 390x844, mede o cabeçalho, o avatar,
// o nome do agente, o menu e a tipografia, compara com a Conversa e REPROVA (saída 1) quando algo diverge
// ou quando a tela rola para o lado. Também confere o balão final da conversa com a faixa de foco e de
// lembretes ligadas. Prints e medidas vão para FORA do git (padrão /root/claude/qa-dgclaw-padrao/).
//
// Uso:
//   node qa/roteiro-navegacao.mjs                         sobe tudo numa pasta temporária e testa
//   node qa/roteiro-navegacao.mjs --url https://x --cookie <valor de dgclaw_sessao> [--agente tina]
//   opções: --saida <pasta> --sufixo <texto no nome da pasta> --larguras 1440x900,390x844 --so-avisar (não reprova, só relata)
// Playwright: PLAYWRIGHT_PATH (pasta node_modules ou do pacote) ou o primeiro que achar na máquina.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { montarAmbiente, REPO } from './montar-ambiente.mjs';

const arg = (n, p = null) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };
const tem = (n) => process.argv.includes(`--${n}`);

function carregarPlaywright() {
  const lugares = [process.env.PLAYWRIGHT_PATH, path.join(REPO, 'node_modules'),
    '/root/claude/projetos/tutorial-bot/node_modules', '/root/claude/temp/carrossel-animado-exemplo/node_modules',
    '/root/.npm/_npx/e41f203b7505f1fb/node_modules', '/root/.npm/_npx/9833c18b2d85bc59/node_modules'].filter(Boolean);
  for (const l of lugares) {
    for (const cand of [l, path.join(l, 'playwright')]) {
      try {
        if (!fs.existsSync(path.join(cand, 'package.json')) && !fs.existsSync(path.join(cand, 'playwright'))) continue;
        const req = createRequire(path.join(cand, 'package.json'));
        return req(fs.existsSync(path.join(cand, 'package.json')) ? cand : 'playwright');
      } catch { /* tenta o próximo */ }
    }
  }
  throw new Error('Não achei o Playwright. Aponte PLAYWRIGHT_PATH para uma pasta node_modules que tenha o pacote "playwright" (ex.: /root/claude/projetos/tutorial-bot/node_modules) ou rode npm i playwright numa pasta temporária.');
}

const TELAS_PAINEL = [
  ['Status', 'status'], ['Skills', 'skills'], ['Rotinas', 'rotinas'], ['Cofre (chaves)', 'cofre'], ['Pasta do agente', 'arquivos'],
  ['Memória', 'memory'], ['Operações', 'operations'], ['Custos', 'costs'], ['Como funciona', 'como'], ['Identidade', 'identity'],
  ['Personalidade', 'personality'], ['Apps', 'apps'], ['Socorro', 'socorro'],
];
// A ordem do menu, igual em TODAS as telas: Sessões é item fixo logo depois da Mesa (só some quando o painel diz ligado:false,
// o que este agente de teste não faz) e Avisos tem item próprio, depois dos Lembretes.
const ITENS_ESPERADOS = [['Conversa', 'conversa'], ['Mesa de tarefas', 'mesa'], ['Sessões', 'sessoes'], ...TELAS_PAINEL, ['Lembretes', 'lembretes'], ['Avisos', 'avisos']];

const larguras = String(arg('larguras', '1440x900,390x844')).split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const agoraStr = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const saida = path.join(arg('saida', '/root/claude/qa-dgclaw-padrao'), agoraStr + (arg('sufixo') ? `-${arg('sufixo')}` : ''));
const falhas = [];   // { tela, largura, medida, esperado, obtido }
const avisos = [];
const falha = (largura, tela, medida, esperado, obtido) => { falhas.push({ largura, tela, medida, esperado, obtido }); console.log(`  REPROVOU  [${largura}] ${tela}: ${medida}. Esperado ${esperado}, obtido ${obtido}.`); };
const avisa = (largura, tela, texto) => { avisos.push({ largura, tela, texto }); console.log(`  aviso     [${largura}] ${tela}: ${texto}`); };
const slugArq = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Medição, roda dentro da página ─────────────────────────────────────── */
function medirNaPagina() {
  const r2 = (n) => Math.round(n * 10) / 10;
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: r2(b.x), y: r2(b.y), w: r2(b.width), h: r2(b.height) }; };
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const visivel = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const q = (s) => document.querySelector(s);
  const estilo = (el) => { const s = cs(el); return s ? { fonte: s.fontFamily, tam: s.fontSize, peso: s.fontWeight, cor: s.color, fundo: s.backgroundColor, linha: s.lineHeight } : null; };
  const cab = q('#cabecalho');
  const av = q('#cabecalho #av');
  const avImg = av && av.querySelector('img');
  const menu = q('aside#menu');
  const foto = q('#mlMoldura .ml-foto');
  const fotoImg = foto && foto.querySelector('img');
  const ativo = q('#mlTabs .ml-tab.ativo');
  const conteudo = q('#chat') || q('main') || q('.principal') || document.body;
  const principal = q('#chat') ? 'chat' : q('main') ? 'main' : q('.principal') ? 'principal' : 'body';
  // avatares "soltos" visíveis dentro do conteúdo (o painel tem o dele, vindo de outra fonte)
  const soltos = [...document.querySelectorAll('img')].filter((i) => visivel(i) && !(cab && cab.contains(i)) && !(menu && menu.contains(i)) &&
    /avatar|sprite|retrato/i.test(i.id + ' ' + i.className + ' ' + (i.alt || '') + ' ' + i.src)).map((i) => ({ id: i.id || i.className || 'img', src: i.currentSrc || i.src, rect: rect(i) }));
  const lado = q('.lado');
  const headerPainel = q('.header');
  const sd = document.scrollingElement || document.documentElement;
  return {
    url: location.pathname + location.search + location.hash, titulo: document.title, principal,
    cabecalho: cab ? { rect: rect(cab), ...estilo(cab), borda: cs(cab).borderBottom, sombra: cs(cab).boxShadow, pos: cs(cab).position } : null,
    avatar: av ? { rect: rect(av), fundo: cs(av).backgroundColor, raio: cs(av).borderRadius, tipo: avImg ? 'img' : 'texto', src: avImg ? (avImg.currentSrc || avImg.src) : null, texto: avImg ? null : av.textContent.trim() } : null,
    nome: q('#nomeAgente') ? { texto: q('#nomeAgente').textContent.trim(), rect: rect(q('#nomeAgente')), ...estilo(q('#nomeAgente')) } : null,
    estado: q('#estado') ? { texto: q('#estado').textContent.trim(), cor: cs(q('#estado')).color, tam: cs(q('#estado')).fontSize } : null,
    menu: menu ? { rect: rect(menu), fundo: cs(menu).backgroundColor, pos: cs(menu).position, visivel: visivel(menu) && rect(menu).x > -5, borda: cs(menu).borderRight } : null,
    menuFoto: foto ? { tipo: fotoImg ? 'img' : 'texto', src: fotoImg ? (fotoImg.currentSrc || fotoImg.src) : null, texto: fotoImg ? null : foto.textContent.trim(), fundo: cs(foto).backgroundColor } : null,
    menuNome: q('#mlNome') ? { texto: q('#mlNome').textContent.trim(), ...estilo(q('#mlNome')) } : null,
    ativo: ativo ? { texto: ativo.textContent.replace(/\s+/g, ' ').trim(), fundo: cs(ativo).backgroundImage !== 'none' ? cs(ativo).backgroundImage : cs(ativo).backgroundColor, cor: cs(ativo).color, fonte: cs(ativo).fontFamily, tam: cs(ativo).fontSize } : null,
    itemMenu: q('#mlTabs .ml-tab:not(.ativo)') ? { fonte: cs(q('#mlTabs .ml-tab:not(.ativo)')).fontFamily, tam: cs(q('#mlTabs .ml-tab:not(.ativo)')).fontSize } : null,
    corpo: { ...estilo(document.body), margem: cs(document.body).margin },
    acento: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    conteudo: { rect: rect(conteudo), ...estilo(conteudo) },
    rolagemX: { doc: sd.scrollWidth, cliente: sd.clientWidth, estoura: sd.scrollWidth > sd.clientWidth + 1 },
    btnSessoes: q('#btnSessoes') ? { visivel: visivel(q('#btnSessoes')), href: q('#btnSessoes').getAttribute('href'), rect: rect(q('#btnSessoes')), texto: q('#btnSessoes').textContent.replace(/\s+/g, ' ').trim(), rotuloVisivel: visivel(q('#btnSessoes .lbl')) } : null,
    ladoAntigoVisivel: visivel(lado), headerPainelVisivel: visivel(headerPainel), headerPainelTexto: headerPainel ? headerPainel.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    avataresSoltos: soltos,
    itensMenu: [...document.querySelectorAll('#mlTabs .ml-tab')].map((el) => el.textContent.replace(/\s+/g, ' ').trim().replace(/^\S\s*/, '')),
    classes: document.documentElement.className,
  };
}

/* Painel SEM a casca (versão antiga rodando no container): mede o que ele mostra, para o relatório. */
function medirPainelAntigo() {
  const q = (s) => document.querySelector(s);
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const ativo = q('.lado .tab.active');
  const img = q('#sprite-img');
  const mini = q('.troca .mini img, .troca img');
  return {
    url: location.pathname + location.hash, titulo: document.title,
    scriptsCasca: [...document.scripts].map((x) => x.src).filter((x) => /casca|menu-lado/.test(x)),
    temDGCasca: typeof window.DGCasca !== 'undefined',
    lado: r(q('.lado')), ladoFundo: q('.lado') ? getComputedStyle(q('.lado')).backgroundColor : null,
    abasDoMenuAntigo: [...document.querySelectorAll('.lado .tab')].filter((t) => !t.hidden).map((t) => t.textContent.trim()),
    ativo: ativo ? { texto: ativo.textContent.trim(), fundo: getComputedStyle(ativo).backgroundImage } : null,
    avatarMenu: img ? { src: img.currentSrc || img.src, rect: r(img) } : null,
    avatarSeletor: mini ? { src: mini.currentSrc || mini.src } : null,
    corpoFonte: getComputedStyle(document.body).fontFamily,
    tituloAba: (q('#titulo-aba') || {}).textContent || null,
    rolagemX: { doc: document.documentElement.scrollWidth, cliente: document.documentElement.clientWidth },
  };
}

/* ── Comparação com a Conversa ──────────────────────────────────────────── */
const perto = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
function compara(largura, tela, base, m, agente, opc = {}) {
  const celular = !largura.startsWith('1440');
  const igual = (medida, esp, obt) => { if (JSON.stringify(esp) !== JSON.stringify(obt)) falha(largura, tela, medida, JSON.stringify(esp), JSON.stringify(obt)); };
  const rect = (medida, esp, obt, chaves = ['x', 'y', 'w', 'h'], tol = 1.5) => { if (!esp || !obt) { falha(largura, tela, medida, 'existir', 'não existe'); return; } if (!chaves.every((k) => perto(esp[k], obt[k], tol))) falha(largura, tela, medida, `${esp.x},${esp.y} ${esp.w}x${esp.h}`, `${obt.x},${obt.y} ${obt.w}x${obt.h}`); };
  if (!m.cabecalho) { falha(largura, tela, 'cabeçalho', 'existir (#cabecalho)', 'não existe'); return; }
  // no celular a Conversa tem uma segunda fileira (as ferramentas), por isso lá a altura do cabeçalho não entra
  rect('posição e tamanho do cabeçalho', base.cabecalho.rect, m.cabecalho.rect, celular ? ['x', 'y', 'w'] : ['x', 'y', 'w', 'h']);
  for (const k of ['fonte', 'tam', 'fundo', 'cor', 'borda']) igual(`cabeçalho: ${k}`, base.cabecalho[k], m.cabecalho[k]);
  if (!m.avatar) falha(largura, tela, 'avatar do cabeçalho', 'existir', 'não existe');
  else {
    rect('posição e tamanho do avatar', base.avatar.rect, m.avatar.rect, ['x', 'y', 'w', 'h'], celular ? 4 : 1.5);
    igual('avatar: tipo (foto ou letra)', base.avatar.tipo, m.avatar.tipo);
    igual('avatar: foto (src)', base.avatar.src, m.avatar.src);
    igual('avatar: letra ou emoji', base.avatar.texto, m.avatar.texto);
    igual('avatar: cor de fundo', base.avatar.fundo, m.avatar.fundo);
  }
  if (!m.nome) falha(largura, tela, 'nome do agente', 'existir', 'não existe');
  else {
    igual('nome do agente: texto', agente.nome, m.nome.texto);
    for (const k of ['fonte', 'tam', 'peso', 'cor']) igual(`nome do agente: ${k}`, base.nome[k], m.nome[k]);
    rect('posição do nome', base.nome.rect, m.nome.rect, ['x', 'y', 'h'], celular ? 4 : 1.5);
  }
  igual('cor de destaque (--accent)', base.acento, m.acento);
  igual('tipografia do corpo da página (font-family)', base.corpo.fonte, m.corpo.fonte);
  if (m.menu && base.menu) {
    igual('menu: fundo', base.menu.fundo, m.menu.fundo);
    igual('menu: posição CSS', base.menu.pos, m.menu.pos);
    if (largura.startsWith('1440')) { rect('menu: posição e tamanho', base.menu.rect, m.menu.rect); if (!m.menu.visivel) falha(largura, tela, 'menu lateral visível', 'visível', 'escondido'); }
  } else falha(largura, tela, 'menu lateral', 'existir', 'não existe');
  if (m.menuFoto && base.menuFoto) { igual('menu: foto do agente (src)', base.menuFoto.src, m.menuFoto.src); igual('menu: letra do agente', base.menuFoto.texto, m.menuFoto.texto); igual('menu: cor da foto', base.menuFoto.fundo, m.menuFoto.fundo); }
  if (m.menuNome) for (const k of ['texto', 'fonte', 'tam', 'peso']) igual(`menu: nome do agente (${k})`, base.menuNome[k], m.menuNome[k]);
  if (m.ativo && base.ativo) { igual('item ativo do menu: fundo', base.ativo.fundo, m.ativo.fundo); igual('item ativo do menu: cor do texto', base.ativo.cor, m.ativo.cor); igual('item ativo: fonte', base.ativo.fonte, m.ativo.fonte); igual('item ativo: tamanho', base.ativo.tam, m.ativo.tam); }
  else if (!opc.semItem) falha(largura, tela, 'item ativo do menu', 'um item marcado', 'nenhum marcado');
  if (JSON.stringify(base.itensMenu) !== JSON.stringify(m.itensMenu)) {
    const faltam = base.itensMenu.filter((x) => !m.itensMenu.includes(x)); const sobram = m.itensMenu.filter((x) => !base.itensMenu.includes(x));
    falha(largura, tela, 'itens do menu (têm de ser os mesmos em todas as telas)', `os da Conversa: ${base.itensMenu.join(', ')}`, `${sobram.length ? 'a mais: ' + sobram.join(', ') + '. ' : ''}${faltam.length ? 'a menos: ' + faltam.join(', ') : ''}`.trim() || 'ordem diferente');
  }
  if (m.ladoAntigoVisivel) falha(largura, tela, 'menu antigo do painel (.lado)', 'escondido', 'visível');
  if (m.headerPainelVisivel) falha(largura, tela, 'segundo cabeçalho do painel (.header)', 'escondido (só o cabeçalho da casca)', `visível: "${m.headerPainelTexto}"`);
  // o botão 🖥 Sessões está no cabeçalho de todas as telas, com alvo de toque de pelo menos 32px; no celular só o ícone
  if (!m.btnSessoes || !m.btnSessoes.visivel) falha(largura, tela, 'botão 🖥 Sessões no cabeçalho', 'visível', m.btnSessoes ? 'escondido' : 'não existe');
  else {
    if (m.btnSessoes.rect.h < 32 || m.btnSessoes.rect.w < 32) falha(largura, tela, 'botão 🖥 Sessões: alvo de toque', '>= 32x32', `${m.btnSessoes.rect.w}x${m.btnSessoes.rect.h}`);
    if (!/#aba=sessoes$/.test(m.btnSessoes.href || '')) falha(largura, tela, 'botão 🖥 Sessões: destino', 'termina em #aba=sessoes', String(m.btnSessoes.href));
    if (celular && m.btnSessoes.rotuloVisivel) falha(largura, tela, 'botão 🖥 Sessões no celular', 'só o ícone (sem o rótulo)', 'o rótulo está visível');
    if (!celular && !m.btnSessoes.rotuloVisivel) falha(largura, tela, 'botão 🖥 Sessões no computador', 'ícone e rótulo "Sessões"', 'sem o rótulo');
  }
  if (m.rolagemX.estoura) falha(largura, tela, 'rolagem horizontal', `scrollWidth <= ${m.rolagemX.cliente}`, `scrollWidth = ${m.rolagemX.doc}`);
  for (const s of m.avataresSoltos) {
    const esperado = agente.avatarSrc;
    if (s.src !== esperado) falha(largura, tela, `avatar solto no conteúdo (${s.id})`, `a foto do agente (${esperado || 'letra'})`, s.src);
  }
}

/* ── Fluxo ───────────────────────────────────────────────────────────────── */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function aguardaAssentar(page) {
  await page.waitForLoadState('load').catch(() => {});
  const noPainel = /\/p\/[^/]+\//.test(page.url());
  const achou = await page.waitForSelector('#cabecalho #nomeAgente', { timeout: noPainel ? 8000 : 20000 }).then(() => true, () => false);
  if (!achou) return false;
  await page.waitForFunction(() => { const n = document.querySelector('#nomeAgente'); return n && n.textContent.trim() && n.textContent.trim() !== 'DG Claw' && document.querySelector('#mlTabs .ml-tab.ativo'); }, null, { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await dormir(700);
  return true;
}

async function abrirMenuSeCelular(page) {
  const btn = page.locator('#btnMenu');
  if (await btn.isVisible().catch(() => false)) {
    if (!(await page.locator('aside#menu.abre').count())) await btn.click();
    await page.waitForSelector('aside#menu.abre', { timeout: 5000 });
    await dormir(350);
  }
}

async function login(contexto, page, base, opts) {
  if (opts.cookie) {
    await contexto.addCookies([{ name: 'dgclaw_sessao', value: opts.cookie, url: base }]);
    return;
  }
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="usuario"]', opts.usuario);
  await page.fill('input[name="senha"]', opts.senha);
  await Promise.all([page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 }), page.click('button[type="submit"]')]);
}

/* O botão 🖥 Sessões do cabeçalho da Conversa leva à aba Sessões DENTRO da casca (mesmo cabeçalho, item Sessões ativo). */
async function verificaBotaoSessoes(page, rotulo, opts, w) {
  const tela = 'Conversa: botão 🖥 Sessões';
  const btn = page.locator('#btnSessoes');
  if (!(await btn.count()) || !(await btn.isVisible().catch(() => false))) { falha(rotulo, tela, 'botão 🖥 Sessões no cabeçalho da Conversa', 'existe e está visível', 'não existe ou está escondido'); return; }
  const antesDaConversa = page.url();
  if (await page.locator('aside#menu.abre').count()) { await page.locator('#btnFechaMenu').click().catch(() => {}); await dormir(350); }   // a gaveta do celular cobre o botão
  try {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await Promise.all([page.waitForURL(/\/p\/[^/]+\/.*#aba=sessoes$/, { timeout: 15000 }), btn.click({ timeout: 8000 })]);
  } catch (e) { falha(rotulo, tela, 'clicar no botão 🖥 leva a /p/<agente>/#aba=sessoes', 'abrir a aba Sessões', e.message.split('\n')[0]); return; }
  if (!(await aguardaAssentar(page))) { falha(rotulo, tela, 'a aba Sessões aberta pelo botão 🖥 mantém a casca (cabeçalho e menu)', 'o mesmo cabeçalho da Conversa', `sem #cabecalho em ${page.url()}`); return; }
  const ativoNoMenu = await page.evaluate(() => { const a = document.querySelector('#mlTabs .ml-tab.ativo'); return a ? a.textContent.replace(/\s+/g, ' ').trim() : null; });
  if (!ativoNoMenu || !ativoNoMenu.includes('Sessões')) falha(rotulo, tela, 'item ativo do menu depois do botão 🖥', 'Sessões', String(ativoNoMenu));
  const aba = await page.evaluate(() => { const p = document.getElementById('panel-sessoes'); return p ? { ativa: p.classList.contains('active'), visivel: p.getBoundingClientRect().height > 0 } : null; });
  if (!aba || !aba.ativa || !aba.visivel) falha(rotulo, tela, 'a aba Sessões (#panel-sessoes) aparece na tela', 'ativa e visível', JSON.stringify(aba));
  console.log(`  botão 🖥 Sessões: leva a ${new URL(page.url()).pathname}${new URL(page.url()).hash}, item ativo "${ativoNoMenu}"`);
  await page.goto(antesDaConversa, { waitUntil: 'domcontentloaded' });
  await aguardaAssentar(page);
  await abrirMenuSeCelular(page);
}

async function rodaLargura(browser, base, opts, { w, h }) {
  const rotulo = `${w}x${h}`;
  console.log(`\n=== ${rotulo} ===`);
  const dir = path.join(saida, String(w));
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 700, hasTouch: w < 700 });
  await ctx.route('https://avatar.qa.invalid/**', (rota) => rota.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }));
  const page = await ctx.newPage();
  const problemas = new Map();   // tela -> [texto]
  let telaAtual = 'login';
  const nota = (t) => { if (!problemas.has(telaAtual)) problemas.set(telaAtual, []); problemas.get(telaAtual).push(t); };
  page.on('pageerror', (e) => nota(`erro de JavaScript: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { const u = new URL(r.url()); if (r.status() >= 400 && u.hostname !== 'avatar.qa.invalid') nota(`${/\.(css|js|png|gif|jpg|svg|woff2?)$/.test(u.pathname) ? 'arquivo estático' : 'pedido'} respondeu ${r.status()}: ${r.request().method()} ${u.pathname}`); });
  await login(ctx, page, base, opts);
  await page.goto(`${base}/a/${opts.agente}`, { waitUntil: 'domcontentloaded' });
  telaAtual = 'Conversa';
  await aguardaAssentar(page);

  const medidas = {};
  let baseMed = null;
  const registra = async (tela, esperadoAtivo, rotuloItem) => {
    telaAtual = tela;
    if (!(await aguardaAssentar(page))) {
      const antigo = await page.evaluate(medirPainelAntigo).catch(() => null);
      const causa = antigo && !antigo.temDGCasca && !antigo.scriptsCasca.length
        ? 'o painel entregou uma página SEM o casca.js (é uma versão antiga do painel: o código do painel mora dentro da imagem do container do agente e só muda quando a imagem é reconstruída e o container recriado)'
        : 'a página carregou o casca.js mas o cabeçalho não montou (veja o console do navegador)';
      falha(rotulo, tela, 'cabeçalho e menu da casca (#cabecalho) no painel', 'a mesma casca da Conversa', `ausente em ${page.url()}: ${causa}`);
      medidas[tela] = { erro: 'a casca não montou', causa, painelAntigo: antigo };
      await page.screenshot({ path: path.join(dir, `${String(Object.keys(medidas).length).padStart(2, '0')}-${slugArq(tela)}-SEM-CASCA.png`) }).catch(() => {});
      return null;
    }
    const m = await page.evaluate(medirNaPagina);
    m.avatarSrcAgente = opts.agenteInfo.avatarSrc;
    if (!baseMed) { baseMed = m; }
    const agente = opts.agenteInfo;
    if (m.ativo && esperadoAtivo && !m.ativo.texto.includes(esperadoAtivo)) falha(rotulo, tela, 'item ativo do menu', `"${esperadoAtivo}"`, `"${m.ativo.texto}"`);
    compara(rotulo, tela, baseMed, m, agente, { semItem: esperadoAtivo === null });
    for (const t of problemas.get(tela) || []) avisa(rotulo, tela, t);
    medidas[tela] = m;
    await page.screenshot({ path: path.join(dir, `${String(Object.keys(medidas).length).padStart(2, '0')}-${slugArq(tela)}.png`), fullPage: false });
    if (w < 700) {   // no celular o menu é uma gaveta: mede e fotografa aberta também
      await abrirMenuSeCelular(page);
      const aberto = await page.evaluate(medirNaPagina);
      medidas[`${tela} (menu aberto)`] = { menu: aberto.menu, menuFoto: aberto.menuFoto, menuNome: aberto.menuNome, ativo: aberto.ativo };
      if (baseMed.menu && aberto.menu) {
        if (!perto(aberto.menu.rect.x, 0, 2)) falha(rotulo, tela, 'gaveta do menu aberta (posição x)', '0', String(aberto.menu.rect.x));
        if (baseMed.menuAberto && !['w', 'h'].every((k) => perto(baseMed.menuAberto.rect[k], aberto.menu.rect[k]))) falha(rotulo, tela, 'tamanho da gaveta do menu', `${baseMed.menuAberto.rect.w}x${baseMed.menuAberto.rect.h}`, `${aberto.menu.rect.w}x${aberto.menu.rect.h}`);
        if (!baseMed.menuAberto) baseMed.menuAberto = aberto.menu;
      }
      await page.screenshot({ path: path.join(dir, `${String(Object.keys(medidas).length).padStart(2, '0')}-${slugArq(tela)}-menu.png`), fullPage: false });
    }
    return m;
  };

  if (!(await registra('Conversa', 'Conversa'))) throw new Error(`A Conversa (/a/${opts.agente}) não montou o cabeçalho da casca. Sem ela não há com o que comparar. Veja o print em ${dir}.`);

  // lista real de itens do menu, lida da tela (o que o dono enxerga)
  await abrirMenuSeCelular(page);
  const noMenu = await page.evaluate(() => [...document.querySelectorAll('#mlTabs .ml-tab')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  console.log(`  itens no menu: ${noMenu.join(' | ')}`);
  const nome = (x) => noMenu.find((t) => t.replace(/^\S\s*/, '').trim() === x || t.endsWith(x) || t.includes(x));
  for (const [x] of ITENS_ESPERADOS) {
    if (!nome(x)) falha(rotulo, 'menu', `item "${x}" no menu da Conversa`, 'presente', 'ausente');
  }
  // a ordem também é parte do combinado
  const ordemLida = ITENS_ESPERADOS.map(([x]) => noMenu.findIndex((t) => t.replace(/^\S\s*/, '').trim() === x || t.endsWith(x))).filter((i) => i >= 0);
  if (ordemLida.some((v, i) => i > 0 && v < ordemLida[i - 1])) falha(rotulo, 'menu', 'ordem dos itens do menu', ITENS_ESPERADOS.map(([x]) => x).join(', '), noMenu.join(', '));
  await verificaBotaoSessoes(page, rotulo, opts, w);

  // clica um por um, em ordem, como o dono faria
  for (const [x] of ITENS_ESPERADOS) {
    if (x === 'Conversa') continue;
    // o menu é relido a cada passo: item que só aparece depois de visitar o painel (Sessões) entra na lista
    const atuais = await page.evaluate(() => [...document.querySelectorAll('#mlTabs .ml-tab')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())).catch(() => []);
    for (const t of atuais) if (!noMenu.includes(t)) noMenu.push(t);
    const rot = nome(x);
    if (!rot) continue;
    telaAtual = x;
    const semCasca = await page.evaluate(() => !document.getElementById('cabecalho')).catch(() => false);
    if (semCasca) {   // o painel antigo tem o menu dele: segue clicando nele para registrar o que o dono viu
      const curto = x.replace(' (chaves)', '').replace('Pasta do agente', 'Pasta');
      const botaoMenu = page.locator('.btn-menu');
      if (await botaoMenu.isVisible().catch(() => false)) { await botaoMenu.click().catch(() => {}); await dormir(300); }
      const aba = page.locator('.lado .tab', { hasText: curto }).first();
      if (!(await aba.count())) { avisa(rotulo, x, 'o menu antigo do painel não tem este item'); continue; }
      try { await aba.click({ timeout: 5000 }); } catch (e) { avisa(rotulo, x, `não consegui clicar no menu antigo: ${e.message.split('\n')[0]}`); continue; }
      await dormir(1200);
      await registra(x, null);
      continue;
    }
    await abrirMenuSeCelular(page);
    const link = page.locator('#mlTabs .ml-tab', { hasText: x }).first();
    try { await link.click({ timeout: 8000 }); } catch (e) { falha(rotulo, x, 'clique no item do menu', 'clicável', e.message.split('\n')[0]); continue; }
    await registra(x, x.replace(/ \(.*/, '').replace('Pasta do agente', 'Pasta'));
  }
  // volta pela Conversa do menu: tem de ser igual à primeira vez
  await abrirMenuSeCelular(page);
  await page.locator('#mlTabs .ml-tab', { hasText: 'Conversa' }).first().click();
  const volta = await (async () => { telaAtual = 'Conversa (de volta)'; return registra('Conversa (de volta)', 'Conversa'); })();
  void volta;
  await ctx.close();

  // o balão final, com a faixa de foco e de lembretes ligadas
  await testeBalao(browser, base, opts, { w, h }, dir, rotulo);
  fs.writeFileSync(path.join(dir, 'medidas.json'), JSON.stringify(medidas, null, 2));
}

async function testeBalao(browser, base, opts, { w, h }, dir, rotulo) {
  const tela = 'Conversa: último balão com faixas';
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 700, hasTouch: w < 700 });
  await ctx.route('https://avatar.qa.invalid/**', (rota) => rota.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }));
  const page = await ctx.newPage();
  // Os lembretes chegam DEPOIS de a conversa já estar aberta e rolada até o fim: é o caso que empurra o conteúdo.
  // Tudo simulado no navegador (nenhum dado é criado no servidor, serve também contra a instalação real).
  await page.route('**/api/v1/lembretes', async (rota) => {
    if (rota.request().method() !== 'GET') return rota.continue();
    await dormir(3500);
    return rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, insistindo: [
      { id: 'oc1', agente: opts.agente, agente_nome: 'Tina', texto: 'Ligar para a Carla sobre a proposta', envio: 2, teto: 12 },
      { id: 'oc2', agente: opts.agente, agente_nome: 'Tina', texto: 'Revisar o contrato antes de sexta', envio: 1, teto: 12 }] }) });
  });
  await login(ctx, page, base, opts);
  await page.goto(`${base}/a/${opts.agente}`, { waitUntil: 'domcontentloaded' });
  await aguardaAssentar(page);
  await page.waitForSelector('#wrap .bub', { timeout: 15000 }).catch(() => {});
  await dormir(1500);   // a conversa abre rolada até o fim
  const medeBalao = (forcaRolar) => page.evaluate(async (forca) => {
    const chat = document.querySelector('#chat');
    if (forca) { chat.scrollTop = chat.scrollHeight; await new Promise((r) => setTimeout(r, 500)); }
    const baloes = [...document.querySelectorAll('#wrap .bub')];
    const ultimo = baloes[baloes.length - 1];
    const barra = document.querySelector('.barra');
    const c = chat.getBoundingClientRect();
    const u = ultimo ? ultimo.getBoundingClientRect() : null;
    const b = barra ? barra.getBoundingClientRect() : null;
    return { qtd: baloes.length, chat: { top: c.top, bottom: c.bottom }, ultimo: u && { top: u.top, bottom: u.bottom },
      barra: b && { top: b.top, bottom: b.bottom }, janela: innerHeight,
      faltaParaOFim: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
      corpoRola: document.documentElement.scrollHeight > innerHeight + 1,
      faixas: [...document.querySelectorAll('#faixaLembretes, .foco')].filter((e) => !e.hidden && e.getBoundingClientRect().height).map((e) => ({ id: e.id || e.className, h: Math.round(e.getBoundingClientRect().height) })) };
  }, forcaRolar);
  // Visual/imagem que CRESCE logo depois de a conversa rolar ao fim (o caso do dgvis e das imagens): o scrollTop é posto
  // e, no mesmo quadro, o conteúdo cresce, antes do evento de scroll chegar. Quem estava no fim tem de continuar no fim.
  const crescimento = await page.evaluate(async () => {
    const chat = document.querySelector('#chat'), wrap = document.querySelector('#wrap');
    if (!wrap) return null;
    const espaco = document.createElement('div');
    espaco.style.cssText = 'height:0;flex:none';
    wrap.appendChild(espaco);
    await new Promise((r) => setTimeout(r, 200));
    chat.scrollTop = 0;                                  // sai do fim (senão o scroll nem dispara)
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#btnFim').click();           // vai ao fim pelo mesmo caminho do primeiro carregamento (rolagem.aoFim)
    espaco.style.height = '1200px';                      // e o conteúdo cresce antes do evento de scroll
    await new Promise((r) => setTimeout(r, 600));
    const falta = Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop);
    espaco.remove();
    return falta;
  });
  console.log(`  crescimento depois do fim: faltam ${crescimento}px`);
  if (crescimento != null && crescimento > 80) falha(rotulo, tela, 'conteúdo que cresce depois de a conversa rolar ao fim deixou a conversa para trás', 'falta <= 80px para o fim', `faltam ${crescimento}px`);
  const antes = await medeBalao(false);
  await page.screenshot({ path: path.join(dir, '98-balao-antes-das-faixas.png') });
  await page.waitForSelector('#faixaLembretes:not([hidden])', { timeout: 15000 }).catch(() => avisa(rotulo, tela, 'A faixa de lembretes não apareceu.'));
  await page.evaluate((agente) => window.dispatchEvent(new CustomEvent('dgclaw:foco', { detail: { agente, lista: { titulo: 'Fechar hoje', versao: 1, itens: [
    { id: 1, texto: 'Mandar a proposta', feito: true, ordem: 1 }, { id: 2, texto: 'Revisar o roteiro', feito: false, ordem: 2 }, { id: 3, texto: 'Responder o Lucas', feito: false, ordem: 3 }] } } })), opts.agente);
  await page.waitForSelector('.foco:not([hidden])', { timeout: 4000 }).catch(() => avisa(rotulo, tela, 'A faixa de foco não apareceu (só a de lembretes foi testada).'));
  await dormir(900);
  const depois = await medeBalao(false);          // sem o dono mexer: o fim da conversa tem de continuar à vista
  const rolado = await medeBalao(true);           // e rolando até o fim, o balão tem de caber inteiro
  await page.screenshot({ path: path.join(dir, '99-balao-com-faixas.png') });
  const f = depois.faixas.map((x) => `${x.id} ${x.h}px`).join(', ') || 'nenhuma';
  console.log(`  balão: ${rolado.qtd} balões; faixas: ${f}; sem rolar: falta ${depois.faltaParaOFim}px para o fim e o último balão termina em ${depois.ultimo ? Math.round(depois.ultimo.bottom) : '?'} (conversa termina em ${Math.round(depois.chat.bottom)}); antes das faixas faltava ${antes.faltaParaOFim}px`);
  if (!rolado.ultimo) { falha(rotulo, tela, 'histórico da conversa', 'balões na tela', 'nenhum balão (o histórico falso não carregou?)'); await ctx.close(); return; }
  if (depois.ultimo && depois.ultimo.bottom > depois.chat.bottom + 1) falha(rotulo, tela, 'último balão cortado embaixo depois que a faixa empurrou a conversa (sem rolar)', `bottom <= ${Math.round(depois.chat.bottom)}`, `bottom = ${Math.round(depois.ultimo.bottom)} (corte de ${Math.round(depois.ultimo.bottom - depois.chat.bottom)}px)`);
  if (depois.faltaParaOFim > 2 && antes.faltaParaOFim <= 2) falha(rotulo, tela, 'a conversa saiu do fim quando a faixa apareceu', 'continuar no fim (falta <= 2px)', `faltam ${depois.faltaParaOFim}px`);
  if (rolado.ultimo.bottom > rolado.chat.bottom + 1) falha(rotulo, tela, 'último balão cortado embaixo, mesmo rolando até o fim', `bottom <= ${Math.round(rolado.chat.bottom)}`, `bottom = ${Math.round(rolado.ultimo.bottom)} (corte de ${Math.round(rolado.ultimo.bottom - rolado.chat.bottom)}px)`);
  if (rolado.barra && rolado.ultimo.bottom > rolado.barra.top + 1) falha(rotulo, tela, 'último balão escondido atrás da barra de digitação', `bottom <= ${Math.round(rolado.barra.top)}`, `bottom = ${Math.round(rolado.ultimo.bottom)}`);
  // balão mais alto que a própria conversa (cartão com gráfico, por exemplo) começa acima do topo por natureza
  if (rolado.ultimo.bottom - rolado.ultimo.top < rolado.chat.bottom - rolado.chat.top && rolado.ultimo.top < rolado.chat.top - 1) falha(rotulo, tela, 'último balão sobe para fora da área da conversa', `top >= ${Math.round(rolado.chat.top)}`, `top = ${Math.round(rolado.ultimo.top)}`);
  if (rolado.barra && rolado.barra.bottom > rolado.janela + 1) falha(rotulo, tela, 'barra de digitação para fora da janela', `bottom <= ${rolado.janela}`, `bottom = ${Math.round(rolado.barra.bottom)}`);
  if (rolado.chat.bottom > (rolado.barra ? rolado.barra.top : rolado.janela) + 1) falha(rotulo, tela, 'a área da conversa invade a barra de digitação', `bottom <= ${rolado.barra ? Math.round(rolado.barra.top) : rolado.janela}`, `bottom = ${Math.round(rolado.chat.bottom)}`);
  if (rolado.corpoRola) falha(rotulo, tela, 'a página inteira rola (só a conversa devia rolar)', 'sem rolagem do corpo', 'o corpo rola');
  await ctx.close();
}

async function principal() {
  const { chromium } = carregarPlaywright();
  const url = arg('url');
  let amb = null;
  const opts = { agente: arg('agente', 'tina'), cookie: arg('cookie', process.env.DGCLAW_QA_COOKIE || null), usuario: null, senha: null };
  let base;
  if (url) {
    if (!opts.cookie) throw new Error('Com --url preciso do --cookie (o valor do cookie dgclaw_sessao de uma sessão aberta). Entre no site, copie o cookie e rode de novo.');
    base = url.replace(/\/+$/, '');
  } else {
    amb = await montarAmbiente({ repo: REPO });
    base = amb.url; opts.usuario = amb.usuario; opts.senha = amb.senha; opts.agente = amb.agente.slug;
  }
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  try {
    // o que o servidor diz sobre o agente é a verdade: o roteiro compara tudo com isso
    const tmp = await browser.newContext();
    const p0 = await tmp.newPage();
    await login(tmp, p0, base, opts);
    const r = await tmp.request.get(`${base}/api/v1/agents`);
    if (!r.ok()) throw new Error(`GET /api/v1/agents respondeu ${r.status()}. O login falhou ou o cookie não vale mais.`);
    const lista = (await r.json()).agentes || [];
    const ag = lista.find((a) => a.id === opts.agente) || lista.find((a) => a.tipo !== 'admin');
    if (!ag) throw new Error('O servidor não devolveu nenhum agente (GET /api/v1/agents veio vazio).');
    opts.agente = ag.id;
    opts.agenteInfo = { nome: ag.nome, avatarSrc: ag.avatar_img || null, cor: ag.cor, avatar: ag.avatar };
    console.log(`Agente testado: ${ag.nome} (${ag.id}), avatar ${ag.avatar_img ? 'foto ' + ag.avatar_img : 'letra/emoji ' + ag.avatar}, cor ${ag.cor}`);
    await tmp.close();
    fs.mkdirSync(saida, { recursive: true });
    for (const l of larguras) await rodaLargura(browser, base, opts, l);
  } finally {
    await browser.close();
    if (amb) await amb.parar();
  }
  const resumo = { quando: agoraStr, url: url || 'ambiente local', falhas, avisos };
  fs.writeFileSync(path.join(saida, 'resultado.json'), JSON.stringify(resumo, null, 2));
  console.log(`\nPrints e medidas em ${saida}`);
  if (falhas.length) {
    console.log(`\nREPROVADO: ${falhas.length} divergência(s) em ${new Set(falhas.map((f) => f.tela)).size} tela(s).`);
    const porTela = new Map();
    for (const f of falhas) { const k = f.tela; porTela.set(k, (porTela.get(k) || 0) + 1); }
    for (const [t, n] of porTela) console.log(`  - ${t}: ${n}`);
    if (!tem('so-avisar')) process.exit(1);
  } else console.log('\nAPROVADO: todas as telas batem com a Conversa, sem rolagem horizontal e com o balão inteiro.');
}

principal().catch((e) => { console.error(`\nO roteiro quebrou: ${e.message}`); process.exit(2); });
