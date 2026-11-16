'use strict';
// Regra geral de "cor sobre cor": o utilitário (ds/contraste.js), a varredura dos tokens (claro e escuro),
// a marca configurável (marca.css) e a conferência de que o botão de gravar usa a regra.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../public/ds/contraste.js');
const { criarMarca } = require('../lib/marca');
const { pastaTemp } = require('./ajuda');

const DS = path.join(__dirname, '..', 'public', 'ds');
const TOKENS = fs.readFileSync(path.join(DS, 'tokens.css'), 'utf8');

test('utilitário: vermelho e cores escuras pedem branco; amarelo claro e azul-céu pedem escuro', () => {
  assert.equal(c.corSobre('#C62828'), c.BRANCO);
  assert.equal(c.corSobre('#c0392b'), c.BRANCO);
  assert.equal(c.corSobre('#000000'), c.BRANCO);
  assert.equal(c.corSobre('#1B7F4B'), c.BRANCO);
  assert.equal(c.corSobre('#FFE066'), c.ESCURO);
  assert.equal(c.corSobre('#00B4FF'), c.ESCURO);
  assert.equal(c.corSobre('#FFFFFF'), c.ESCURO);
  assert.equal(c.corSobre('#fa0'), c.ESCURO);
});

test('utilitário: a escolha sempre dá pelo menos 4,5:1 em uma varredura de cores', () => {
  let pior = 99;
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    const f = [r, g, b];
    const razao = c.razao(f, c.corSobre(f));
    pior = Math.min(pior, razao);
    assert.ok(razao >= c.MIN_TEXTO, `fundo rgb(${f}) deu só ${razao.toFixed(2)}:1`);
  }
  assert.ok(pior >= 4.5);
});

test('utilitário: lê rgb(), recusa lixo e transparente', () => {
  assert.deepEqual(c.lerCor('rgb(198, 40, 40)'), [198, 40, 40]);
  assert.deepEqual(c.lerCor('rgba(10 20 30 / 0.5)'), [10, 20, 30]);
  assert.equal(c.lerCor('rgba(0, 0, 0, 0)'), null);
  assert.equal(c.lerCor('vermelho'), null);
  assert.throws(() => c.luminancia('vermelho'), /não entendi a cor/);
  assert.ok(Math.abs(c.razao('#000', '#fff') - 21) < 0.001);
});

// ---- varredura dos tokens ----
function bloco(inicio) {
  const i = TOKENS.indexOf(inicio);
  assert.ok(i >= 0, `bloco ${inicio} não achado em tokens.css`);
  return TOKENS.slice(TOKENS.indexOf('{', i) + 1, TOKENS.indexOf('\n}', i));
}
function vars(texto) {
  const m = {};
  for (const x of texto.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m[x[1]] = x[2].trim();
  return m;
}
const CLARO = vars(bloco(':root{'));
const ESCURO = { ...CLARO, ...vars(bloco('html[data-tema="escuro"]{')) };
function resolve(mapa, nome, fundo = 0) {
  assert.ok(fundo < 8, `var(${nome}) circular ou funda demais`);
  const v = mapa[nome];
  assert.ok(v !== undefined, `token ${nome} não existe em tokens.css`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return ref ? resolve(mapa, ref[1], fundo + 1) : v;
}

// [fundo, texto/ícone, mínimo]. Texto 4,5:1. Os pares de ícone sozinho (sem texto) valem 3:1, e aqui exigimos o de texto.
const PARES = [
  ['--cor-acento', '--cor-sobre-acento'],
  ['--cor-perigo', '--cor-sobre-perigo'],
  ['--cor-sucesso', '--cor-sobre-sucesso'],
  ['--cor-aviso', '--cor-sobre-aviso'],
  ['--cor-gravando', '--cor-sobre-gravando'],
  ['--cor-atencao', '--cor-sobre-atencao'],
  ['--botao-fundo', '--botao-texto'],
  ['--botao-perigo-fundo', '--botao-perigo-texto'],
  ['--botao2-fundo', '--botao2-texto'],
  ['--campo-fundo', '--campo-texto'],
  ['--cor-fundo', '--cor-texto'],
  ['--cor-superficie', '--cor-texto'],
  ['--cor-superficie', '--cor-texto-2'],
  ['--cor-superficie', '--cor-link'],
  ['--cor-perigo-fundo', '--cor-perigo'],
  ['--cor-sucesso-fundo', '--cor-sucesso'],
  ['--cor-aviso-fundo', '--cor-aviso'],
  ['--balao-meu-fundo', '--balao-meu-texto'],
  ['--balao-agente-fundo', '--balao-agente-texto'],
];

for (const [nome, mapa] of [['claro', CLARO], ['escuro', ESCURO]]) {
  test(`tokens (${nome}): todo par fundo/sobre passa de 4,5:1 (texto) e portanto de 3:1 (ícone)`, () => {
    for (const [f, t] of PARES) {
      const rf = resolve(mapa, f);
      const rt = resolve(mapa, t);
      const razao = c.razao(rf, rt);
      assert.ok(razao >= c.MIN_TEXTO, `${nome}: ${t} (${rt}) sobre ${f} (${rf}) dá ${razao.toFixed(2)}:1; o mínimo é ${c.MIN_TEXTO}:1. Troque o token "sobre" pelo que a regra escolhe (${c.corSobre(rf)}).`);
      assert.ok(razao >= c.MIN_ICONE);
    }
  });
}

test('tokens: todo --cor-sobre-X tem um fundo --cor-X e está na tabela de pares (nenhum fundo forte fica sem regra)', () => {
  const tabela = new Set(PARES.map((p) => p[1]));
  for (const nome of Object.keys(CLARO).filter((k) => k.startsWith('--cor-sobre-'))) {
    const fundo = '--cor-' + nome.slice('--cor-sobre-'.length);
    assert.ok(CLARO[fundo] !== undefined, `${nome} não tem o fundo ${fundo} em tokens.css`);
    assert.ok(tabela.has(nome), `${nome} existe mas não está na tabela de pares deste teste: acrescente [${fundo}, ${nome}]`);
    assert.ok(ESCURO[nome] !== undefined);
  }
});

test('o navegador confere os mesmos pares que o teste (PARES_TOKENS cobre todos os fundos fortes)', () => {
  const navegador = new Set(c.PARES_TOKENS.map((p) => p.join('|')));
  for (const [f, t] of PARES.slice(0, 8)) assert.ok(navegador.has(f + '|' + t), `${f}/${t} não está em PARES_TOKENS de contraste.js`);
});

test('botão de gravar: o estado gravando usa fundo e cor "sobre" dos tokens, e o ícone herda currentColor', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.css'), 'utf8');
  assert.match(css, /#btnMic\.gravando\{background:var\(--cor-gravando\);color:var\(--cor-sobre-gravando\)\}/);
  assert.match(fs.readFileSync(path.join(DS, 'componentes.css'), 'utf8'), /\.ds-ico\{[^}]*stroke:currentColor/);
  const sprite = fs.readFileSync(path.join(DS, 'icones.svg'), 'utf8');
  assert.ok(!/(?:fill|stroke)="#[0-9a-fA-F]{3,6}"/.test(sprite), 'o sprite de ícones tem cor fixa: use currentColor');
});

test('as páginas que carregam o tokens.css também carregam o contraste.js', () => {
  const pub = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(pub).filter((n) => n.endsWith('.html'))) {
    const h = fs.readFileSync(path.join(pub, f), 'utf8');
    if (h.includes('/ds/tokens.css')) assert.ok(h.includes('/ds/contraste.js'), `${f} usa o design system mas não carrega /ds/contraste.js`);
  }
});

// ---- marca configurável ----
function cssDaMarca(json) {
  const dir = pastaTemp('marca-contraste');
  fs.writeFileSync(path.join(dir, 'marca.json'), JSON.stringify(json));
  const m = criarMarca({ dir, padraoJson: path.join(__dirname, '..', 'marca-padrao.json'), padraoDir: path.join(DS, 'marca-padrao'), log: () => {} });
  return m.css();
}

test('marca: fundo escuro sem "sobre" ganha branco; fundo claro ganha escuro; escolha explícita boa é mantida', () => {
  let css = cssDaMarca({ cores: { 'botao-fundo': '#0b1f4d', 'cor-gravando': '#ffe066' } });
  assert.match(css, /--botao-texto:#ffffff;/);
  assert.match(css, /--cor-sobre-gravando:#1b2430;/);
  css = cssDaMarca({ cores: { 'botao-fundo': '#0b1f4d', 'botao-texto': '#f0f0f0' } });
  assert.match(css, /--botao-texto:#f0f0f0;/, 'uma escolha explícita que passa de 4,5:1 não pode ser trocada');
  css = cssDaMarca({ cores: { 'botao-fundo': '#0b1f4d', 'botao-texto': '#222222' } });
  assert.match(css, /--botao-texto:#ffffff;/, 'uma escolha explícita que reprova é corrigida');
});

test('marca: o escuro também recebe a regra', () => {
  const css = cssDaMarca({ cores_escuro: { 'cor-perigo': '#ff9999' } });
  assert.match(css, /html\[data-tema="escuro"\]:root\{[^}]*--cor-sobre-perigo:#1b2430;/);
});
