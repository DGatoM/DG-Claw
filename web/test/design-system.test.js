'use strict';
// Guarda do design system "Névoa" (Etapa A: base, login e conversa). A lista de telas migradas cresce a cada etapa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const ler = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');

const HTML_MIGRADOS = ['login.html', 'primeiro-acesso.html', 'trocar-senha.html', 'conversa.html'];
const CSS_MIGRADOS = ['sigilo.css', 'login.css', 'trocar-senha.css', 'chat.css', 'conversa.css', 'menu-lado.css', 'casca.css'];
const JS_MIGRADOS = ['sigilo.js', 'login.js', 'conversa.js', 'conversa-puro.js', 'menu-lado.js', 'casca.js'];

// Emojis e símbolos de interface que viraram ícones do sprite (o ● de "gravando" é pontuação, não ícone).
const EMOJIS_DE_INTERFACE = ['✕', '☰', '✓', '🎤', '🖥', '🎧', '📎', '👁', '📄', '⚠', '📊', '⬇', '🔒', '🔊', '🔇', '➤', '📷', '✦', '🛡', '🔁',
  '🎬', '✅', '🎯', '⚿', '⚙', '⭐', '📜', '📚', '❤', '⚔', '🤖', '⚡', '✏', '👥', '🔑', '🕶', '⏰', '📋', '✉', '🔔', '🌐', '↻', '↓', '▶', '▾', '▴',
  '⛶', '⏸', '⏳', '↪', '🗜', '📝', '📽', '🧩', '🖼', '📦', '◔', '◉', '▦', '⤓', '🦞'];

test('tokens.css: o acento é o azul #00B4FF com texto escuro, e o botão segue o acento', () => {
  const t = ler('ds/tokens.css');
  assert.match(t, /--p-azul:#00B4FF/);
  assert.match(t, /--cor-acento:var\(--p-azul\)/);
  assert.match(t, /--cor-sobre-acento:var\(--p-grafite\)/);
  assert.match(t, /--botao-fundo:var\(--cor-acento\)/);
  assert.match(t, /--botao-texto:var\(--cor-sobre-acento\)/);
  assert.match(t, /html\[data-tema="escuro"\]\{/);
  assert.ok(!/prefers-color-scheme/.test(t), 'nada de tema escuro automático');
});

test('tokens.css: a conversa mantém o fundo verde e os balões de hoje, em tokens próprios', () => {
  const t = ler('ds/tokens.css');
  assert.match(t, /--conversa-fundo:[\s\S]*?linear-gradient\(165deg,#e6f2df 0%,#d8ead1 45%,#cde3c6 100%\)/);
  assert.match(t, /--balao-meu-fundo:#e4fbcd/);
  assert.match(t, /--balao-agente-fundo:#ffffff/);
  for (const n of ['--balao-meu-texto', '--balao-agente-texto', '--logo-no', '--logo-centro', '--fonte-base', '--fonte-mono']) assert.ok(t.includes(n), n);
  assert.match(ler('chat.css'), /background:var\(--conversa-fundo\)/);
});

test('acentos dos CSS migrados vêm de var(--cor-acento) e var(--botao-fundo), sem o verde antigo solto', () => {
  for (const f of CSS_MIGRADOS) {
    const c = ler(f);
    assert.ok(!/#2f9e5e/i.test(c), `${f} ainda tem o verde #2f9e5e solto`);
    assert.ok(!/color:#fff;?[^}]*background:var\(--accent\)|background:var\(--accent\);color:#fff/.test(c), `${f}: botão de acento com texto branco (reprova AA no azul)`);
  }
  assert.match(ler('login.css'), /background:var\(--botao-fundo\);color:var\(--botao-texto\)/);
  assert.match(ler('conversa.css'), /#btnEnviar\{[^}]*background:var\(--botao-fundo\);color:var\(--botao-texto\)/);
  assert.match(ler('chat.css'), /--accent:var\(--cor-acento\)/);
});

// Só os ícones mais complexos levam a assinatura da constelação (nós cheios); os comuns têm a forma clássica.
const COM_NOS = ['monitor', 'presentation', 'chart', 'board', 'settings', 'activity', 'gauge', 'vault', 'layers', 'package', 'archive', 'key',
  'file-text', 'scroll', 'clipboard', 'bot', 'brain', 'globe', 'code', 'inbox', 'film', 'id', 'layout'];

test('ícones: todo i-<nome> usado nas telas migradas existe em ds/icones.svg, e cada ícone segue a assinatura', () => {
  const sprite = ler('ds/icones.svg');
  const existentes = new Set([...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.ok(existentes.size >= 90, `só ${existentes.size} ícones`);
  const usados = new Set();
  for (const f of [...HTML_MIGRADOS, ...JS_MIGRADOS]) {
    const t = ler(f);
    for (const m of t.matchAll(/icones\.svg#i-([a-z0-9-]+)/g)) usados.add(m[1]);
    for (const m of t.matchAll(/['"]i-([a-z0-9-]+)['"]/g)) usados.add(m[1]);
    for (const m of t.matchAll(/(?:dsIcone|\bico|icoHtml)\(([^()]*)\)/g)) for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) usados.add(q[1].replace(/^i-/, ''));
    for (const m of t.matchAll(/\bico: '([a-z0-9-]+)'/g)) usados.add(m[1].replace(/^i-/, ''));
  }
  const conv = ler('conversa.js');
  for (const bloco of [/const ICONES_ARQ = \[([\s\S]*?)\];/, /const ICONE_DOC = \{([^}]*)\}/]) {
    for (const q of conv.match(bloco)[1].matchAll(/'([a-z0-9-]+)'/g)) usados.add(q[1]);
  }
  for (const m of conv.matchAll(/marca\([^,]+, '[a-z-]+', '([a-z0-9-]+)'/g)) usados.add(m[1]);
  assert.ok(usados.size >= 25, `só achei ${usados.size} nomes usados`);
  const faltam = [...usados].filter((n) => !existentes.has(n) && !/^(i-)$/.test(n));
  assert.deepEqual(faltam, [], `ícones usados que não existem no sprite: ${faltam}`);
  for (const m of sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
    const [, nome, corpo] = m;
    assert.match(corpo, /stroke-width="1\.5"/, nome);
    assert.match(corpo, /stroke-linecap="round" stroke-linejoin="round"/, nome);
    const nos = (corpo.match(/<circle [^>]*r="1\.6"/g) || []).length;
    if (COM_NOS.includes(nome)) assert.ok(nos >= 1 && nos <= 3, `${nome}: ${nos} nós r=1,6 (esperado de 1 a 3)`);
    else assert.equal(nos, 0, `${nome}: ícone comum e clássico não leva nó`);
  }
});

test('login, conversa, menu e seus JS não têm emojis de interface, nem 🦞', () => {
  for (const f of [...HTML_MIGRADOS, ...JS_MIGRADOS, ...CSS_MIGRADOS]) {
    const t = ler(f);
    for (const e of EMOJIS_DE_INTERFACE) assert.ok(!t.includes(e), `${f} ainda tem ${e}`);
  }
});

test('os HTML migrados não têm "DG Claw" literal: o nome vem de {{MARCA_NOME}}', () => {
  for (const f of HTML_MIGRADOS) {
    const t = ler(f);
    assert.ok(!/DG Claw/.test(t), `${f} tem "DG Claw" literal`);
    assert.match(t, /data-tema="\{\{MARCA_TEMA\}\}"/, f);
    assert.match(t, /<meta name="marca-nome" content="\{\{MARCA_NOME\}\}">/, f);
    for (const css of ['/ds/tokens.css', '/ds/componentes.css', '/marca.css']) assert.ok(t.includes(css), `${f} sem ${css}`);
    assert.ok(t.indexOf('/ds/tokens.css') < t.indexOf('/marca.css'), `${f}: marca.css precisa vir depois de tokens.css`);
  }
  for (const f of ['conversa.js', 'casca.js', 'menu-lado.js']) assert.ok(!/['"`][^'"`\n]*DG Claw[^'"`\n]*['"`]/.test(ler(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\|\| 'DG Claw'/g, '')), `${f} tem texto "DG Claw" visível`);
});

test('toda página .html de web/public: o único {{ ... }} é de MARCA_*', () => {
  for (const f of fs.readdirSync(PUB).filter((n) => n.endsWith('.html'))) {
    for (const m of ler(f).matchAll(/\{\{([^}]*)\}\}/g)) assert.match(m[1], /^MARCA_[A-Z_]+$/, `${f}: {{${m[1]}}} não é da marca`);
  }
});

test('componentes.css e carregando.css só usam tokens (sem cor, medida de tempo ou sombra literal)', () => {
  for (const f of ['ds/componentes.css', 'ds/carregando.css']) {
    const c = ler(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(c), `${f} tem cor literal`);
  }
  assert.match(ler('ds/componentes.css'), /:focus-visible/);
  const car = ler('ds/carregando.css');
  assert.match(car, /prefers-reduced-motion:reduce/);
  assert.match(car, /var\(--tempo-carregando\)/);
});

test('service worker: nova versão, /ds/* no cache e /marca* fora', () => {
  const sw = ler('sw.js');
  assert.match(sw, /VERSAO = 'dgclaw-estaticos-v36'/);
  for (const a of ['/ds/tokens.css', '/ds/icones.svg', '/ds/carregando.js', '/ds/icone.js']) assert.ok(sw.includes(`'${a}'`), a);
  assert.match(sw, /PROIBIDOS = \[\/\^\\\/marca\//);
  assert.ok(!/ESTATICOS = \[[\s\S]*?'\/marca[\s\S]*?\];/.test(sw), '/marca* não pode estar na lista de cache');
});

test('dsIcone valida o nome e carregando traz role=status e a geometria do símbolo', () => {
  const vm = require('node:vm');
  const ctx = { window: {}, console };
  vm.runInNewContext(ler('ds/icone.js'), ctx);
  vm.runInNewContext(ler('ds/carregando.js'), ctx);
  assert.match(ctx.window.dsIcone('x'), /<use href="\/ds\/icones\.svg#i-x"\/>/);
  assert.equal(ctx.window.dsIcone('x"><script>'), '');
  assert.equal(ctx.window.dsIcone('A'), '');
  const c = ctx.window.dsCarregando({ rotulo: 'Abrindo "a conversa"' });
  assert.match(c, /role="status" aria-label="Abrindo &quot;a conversa&quot;"/);
  for (const n of ['translate(498 438)', 'r="57"', 'L-97 -134', 'L181 48', 'L-76 139', 'r="33"']) assert.ok(c.includes(n), n);
});
