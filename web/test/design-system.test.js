'use strict';
// Guarda do design system "Névoa": base, login, conversa e as demais telas do Web e do painel. A lista de telas migradas cresce a cada etapa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const ler = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');

const HTML_MIGRADOS = ['login.html', 'primeiro-acesso.html', 'trocar-senha.html', 'conversa.html', 'mesa.html', 'lembretes.html', 'avisos.html', 'seguranca.html', 'anonimizar.html', 'colaboradores.html', 'conectar.html'];
const CSS_MIGRADOS = ['sigilo.css', 'login.css', 'trocar-senha.css', 'chat.css', 'conversa.css', 'menu-lado.css', 'casca.css', 'mesa.css', 'lembretes.css', 'avisos.css', 'seguranca.css', 'anonimizar.css', 'colaboradores.css',
  'conectar-cartoes.css', 'foco-tela.css', 'campo-cofre.css', 'atualizacao-faixa.css', 'onboarding.css'];
const JS_MIGRADOS = ['sigilo.js', 'login.js', 'conversa.js', 'conversa-puro.js', 'menu-lado.js', 'casca.js', 'mesa.js', 'lembretes.js', 'lembretes-faixa.js', 'avisos.js', 'seguranca.js', 'seguranca-resumo.js',
  'anonimizar.js', 'colaboradores.js', 'conectar.js', 'conectar-cartoes.js', 'atualizacao-faixa.js', 'foco-tela.js', 'campo-cofre.js', 'onboarding.js', 'barra.js', 'dgvis.js'];
const PAINEL = path.join(__dirname, '..', '..', 'panel', 'public');
const lerPainel = (rel) => fs.readFileSync(path.join(PAINEL, rel), 'utf8');
// Faixas Unicode de emoji e de símbolo de interface (setas, formas geométricas, dingbats). ● e → ficam de fora de propósito:
// são pontuação (gravando, separador de versões), e cada uso restante está listado no relatório da etapa.
const RX_SIMBOLO = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u23E0-\u23FF\u25A0-\u25CE\u25D0-\u25FF\u2190\u2191\u2193-\u21FF]/u;

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
  const SEM_NOME_LITERAL = ['conversa.js', 'casca.js', 'menu-lado.js', 'avisos.js', 'conectar.js', 'colaboradores.js', 'lembretes.js', 'lembretes-faixa.js', 'seguranca-resumo.js', 'login.js', 'trocar-senha.js', 'campo-cofre.js'];
  for (const f of SEM_NOME_LITERAL) assert.ok(!/['"`][^'"`\n]*DG Claw[^'"`\n]*['"`]/.test(ler(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\|\| 'DG Claw'/g, '').replace(/: 'DG Claw'\)/g, ')')), `${f} tem texto "DG Claw" visível`);
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
  assert.match(sw, /VERSAO = 'dgclaw-estaticos-v37'/);
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

test('as telas migradas não têm emoji nem símbolo de interface (só ícone do sprite)', () => {
  for (const f of [...HTML_MIGRADOS, ...JS_MIGRADOS, ...CSS_MIGRADOS, 'dgvis.css', 'lembretes-faixa.js']) {
    const t = ler(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!RX_SIMBOLO.test(t), `${f} tem emoji ou símbolo de interface: ${(t.match(RX_SIMBOLO) || [''])[0]}`);
  }
});

test('todo ícone citado nas telas do Web e no painel existe no sprite, e o nome é sempre literal', () => {
  const sprite = ler('ds/icones.svg');
  const existentes = new Set([...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const usados = new Map();
  const anota = (n, f) => { if (!usados.has(n)) usados.set(n, f); };
  for (const f of fs.readdirSync(PUB).filter((n) => /\.(html|js)$/.test(n) && n !== 'sw.js')) {
    const t = ler(f);
    for (const m of t.matchAll(/dsIcone\('([a-z0-9-]+)'/g)) anota(m[1], f);
    for (const m of t.matchAll(/icones\.svg#i-([a-z0-9-]+)/g)) anota(m[1], f);
  }
  const doPainel = [];
  for (const sub of ['', 'js/']) for (const f of fs.readdirSync(path.join(PAINEL, sub)).filter((n) => /\.(html|js)$/.test(n))) doPainel.push(sub + f);
  for (const f of doPainel) {
    const t = lerPainel(f);
    for (const m of t.matchAll(/dsIcone\('([a-z0-9-]+)'/g)) anota(m[1], 'painel/' + f);
    for (const m of t.matchAll(/icones\.svg#i-([a-z0-9-]+)/g)) anota(m[1], 'painel/' + f);
    for (const m of t.matchAll(/icon: '([a-z0-9-]+)', dica/g)) anota(m[1], 'painel/' + f);
    for (const m of t.matchAll(/typeIcons = \{([^}]*)\}|tierIcons = \{([^}]*)\}/g)) for (const q of (m[1] || m[2]).matchAll(/: '([a-z0-9-]+)'/g)) anota(q[1], 'painel/' + f);
    // Nome vindo de tabela do próprio código (ex.: tierIcons[f.tier]) é aceito: só sai valor da tabela, e dsIcone ainda valida o formato.
  }
  assert.ok(usados.size >= 40, `só achei ${usados.size} ícones usados`);
  const faltam = [...usados].filter(([n]) => !existentes.has(n)).map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(faltam, [], `ícones usados que não existem no sprite: ${faltam}`);
});

test('painel: sem emoji de interface, sem o roxo antigo e com os mesmos tokens do Web', () => {
  const lista = ['index.html', 'login.html', ...fs.readdirSync(path.join(PAINEL, 'js')).map((n) => 'js/' + n), ...fs.readdirSync(path.join(PAINEL, 'css')).map((n) => 'css/' + n)];
  const RX_PAINEL = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u23E0-\u23FF\u25A0-\u25FF\u2191\u2193\u21BB\u2715\u2716]/u;
  // js/visualizador.js só tem setas em comentário (a conferência as ignora).
  for (const f of lista) {
    const t = lerPainel(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!RX_PAINEL.test(t), `painel/${f} tem emoji ou símbolo de interface: ${(t.match(RX_PAINEL) || [''])[0]}`);
    assert.ok(!/#4f46e5|#8b5cf6|#4a9eff/i.test(t), `painel/${f} ainda usa o acento antigo`);
  }
  for (const f of ['index.html', 'login.html']) {
    const t = lerPainel(f);
    for (const css of ['/ds/tokens.css', '/marca.css']) assert.ok(t.includes(css), `painel/${f} sem ${css}`);
    assert.ok(t.indexOf('/ds/tokens.css') < t.indexOf('/marca.css'), `painel/${f}: marca.css antes de tokens.css`);
  }
  assert.match(lerPainel('index.html'), /\/ds\/icone\.js/);
  assert.match(lerPainel('css/main.css'), /--acento1:var\(--cor-acento\)/);
  assert.match(lerPainel('css/main.css'), /\.tab\.active\{background:var\(--botao-fundo\);color:var\(--botao-texto\);/);
});

test('painel solto: o server.js serve /ds e a marca padrão só quando não há prefixo do Web', () => {
  const srv = fs.readFileSync(path.join(PAINEL, '..', 'server.js'), 'utf8');
  assert.match(srv, /if \(!BASE && fs\.existsSync\(path\.join\(DS_DIR, 'icones\.svg'\)\)\)/);
  assert.match(srv, /app\.use\('\/ds', express\.static\(DS_DIR/);
});
