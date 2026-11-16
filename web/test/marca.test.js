'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarMarca } = require('../lib/marca');
const { subirWeb, pastaTemp, capturaLog } = require('./ajuda');

const PADRAO_JSON = path.join(__dirname, '..', 'marca-padrao.json');
const PADRAO_DIR = path.join(__dirname, '..', 'public', 'ds', 'marca-padrao');
// PNG quadrado mínimo (cabeçalho IHDR) de 512x512; só o cabeçalho importa para a validação.
function pngFalso(lado) {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(lado, 16); b.writeUInt32BE(lado, 20);
  return b;
}
function pasta(json, arquivos) {
  const dir = pastaTemp('marca');
  if (json !== undefined) fs.writeFileSync(path.join(dir, 'marca.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [n, c] of Object.entries(arquivos || {})) fs.writeFileSync(path.join(dir, n), c);
  return dir;
}
function marcaDe(dir) {
  const cap = capturaLog();
  return { m: criarMarca({ dir, padraoJson: PADRAO_JSON, padraoDir: PADRAO_DIR, log: cap.log }), cap };
}

test('marca: sem pasta nem marca.json, vale o padrão de fábrica e nada é logado', () => {
  const { m, cap } = marcaDe(path.join(pastaTemp('vazia'), 'nao-existe'));
  const d = m.obter();
  assert.equal(d.nome, 'DG Claw'); assert.equal(d.tema, 'claro'); assert.equal(d.logo, null);
  assert.equal(cap.linhas.length, 0);
  assert.equal(m.arquivo('logo').caminho, path.join(PADRAO_DIR, 'logo.svg'));
  assert.match(m.html('<h1>{{MARCA_NOME}}</h1>'), /<h1>DG Claw<\/h1>/);
});

test('marca: campos válidos entram (nome, cor de botão, logo, fonte, tema)', () => {
  const dir = pasta({
    nome: 'Acme Bot', nome_curto: 'Acme', slogan: 'Fala com o Acme', titulo_login: 'Bem-vindo', tema: 'escuro', logo_tem_nome: true,
    logo: 'logo.png', cores: { 'botao-fundo': '#FF0000', 'botao-texto': '#ffffff' }, cores_escuro: { 'cor-fundo': '#101010' },
    fontes: { base: { familia: 'Inter Tight', arquivo: 'inter.woff2' } },
  }, { 'logo.png': pngFalso(64), 'inter.woff2': Buffer.from('wOF2....') });
  const { m, cap } = marcaDe(dir);
  const css = m.css();
  assert.match(css, /--botao-fundo:#ff0000;/);
  assert.match(css, /html\[data-tema="escuro"\]:root\{--cor-fundo:#101010;\}/);
  assert.match(css, /font-family:"Inter Tight"/);
  assert.match(css, /\.ds-carregando-logo\{display:block;background:url\("\/marca\/logo"\)/);
  assert.match(m.html('<html data-tema="{{MARCA_TEMA}}">{{MARCA_NOME}}|{{MARCA_TITULO_LOGIN}}'), /data-tema="escuro">Acme Bot\|Bem-vindo/);
  assert.equal(JSON.parse(m.manifest()).name, 'Acme Bot');
  assert.equal(m.arquivo('logo').tipo, 'image/png');
  assert.equal(m.arquivo('fonte', 'base').tipo, 'font/woff2');
  assert.equal(m.arquivo('fonte', 'mono'), null);
  assert.equal(cap.linhas.length, 0);
});

test('marca: campo malicioso cai no padrão só daquele campo, o resto sobrevive e nada malicioso sai no CSS nem no HTML', () => {
  const dir = pasta({
    nome: '<script>alert(1)</script>', nome_curto: 'Acme', titulo_login: 'Entre no Acme',
    cores: { 'botao-fundo': 'red;}body{background:url(//x)', 'cor-acento': '#00AA00', 'nome-inventado': '#000000' },
    fontes: { base: { familia: 'X</style><script>', arquivo: '../../etc/passwd' }, mono: { familia: 'Fira Code', arquivo: '../../etc/passwd' } },
    logo: '../../etc/passwd', favicon: 'link.png', icone_app: 'pequeno.png',
    campo_desconhecido: { qualquer: 'coisa' },
  }, { 'pequeno.png': pngFalso(32) });
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link.png'));
  const original = fs.readFileSync(path.join(dir, 'marca.json'), 'utf8');
  const { m, cap } = marcaDe(dir);
  const css = m.css();
  const pagina = m.html('<title>{{MARCA_NOME}}</title><h1>{{MARCA_TITULO_LOGIN}}</h1><i>{{MARCA_SLOGAN}}</i>');
  assert.match(css, /--cor-acento:#00aa00;/);                       // o campo bom passou
  assert.match(pagina, /Entre no Acme/);
  assert.match(pagina, /<title>DG Claw<\/title>/);                  // nome inválido: padrão só dele
  for (const saida of [css, pagina, m.manifest()]) {
    assert.ok(!/<script|<\/style|passwd|background:url\(\/\/x|\}body\{/.test(saida), saida);
  }
  assert.ok(!css.includes('botao-fundo') && !css.includes('nome-inventado'));
  const d = m.obter();
  assert.equal(d.logo, null); assert.equal(d.favicon, null); assert.equal(d.icone_app, null); assert.deepEqual(d.fontes, {});
  const log = cap.texto();
  assert.match(log, /campo "nome"/); assert.match(log, /campo "logo"/); assert.match(log, /campo "favicon"/);
  assert.match(log, /campo "icone_app"/); assert.match(log, /fontes\.base\.familia/); assert.match(log, /Corrija|Coloque|Use|Exporte|Veja|Escolha|Copie|Confira/);
  // o código nunca grava no marca.json: a linha desconhecida continua lá, igual ao que o dono escreveu
  assert.equal(fs.readFileSync(path.join(dir, 'marca.json'), 'utf8'), original);
  assert.ok(JSON.parse(original).campo_desconhecido);
});

test('marca: JSON quebrado volta ao padrão inteiro com aviso; e a marca muda sem reiniciar (cache por mtime)', () => {
  const dir = pasta('{ isso nao e json');
  const { m, cap } = marcaDe(dir);
  assert.equal(m.obter().nome, 'DG Claw');
  assert.match(cap.linhas.join('\n'), /não consegui ler .*marca\.json/);
  fs.writeFileSync(path.join(dir, 'marca.json'), JSON.stringify({ nome: 'Novo Nome' }));
  const futuro = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'marca.json'), futuro, futuro);
  assert.equal(m.obter().nome, 'Novo Nome');
});

test('marca: ícone do app só vale PNG quadrado de pelo menos 192', () => {
  const dir = pasta({ icone_app: 'icone.png' }, { 'icone.png': pngFalso(512) });
  const { m } = marcaDe(dir);
  assert.equal(JSON.parse(m.manifest()).icons[0].src, '/marca/icone-app');
  assert.equal(JSON.parse(m.manifest()).icons[0].sizes, '512x512');
});

test('marca: rotas públicas do Web (sem sessão), logo SVG isolado, manifesto dinâmico e sem vazar caminho', async () => {
  const dir = pasta({
    nome: 'Acme Bot', titulo_login: 'Entre no Acme', logo: 'logo.svg', logo_tem_nome: false,
    cores: { 'botao-fundo': '#ff0000', 'botao-texto': 'oops' }, favicon: '../x.png',
  }, { 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' });
  const t = await subirWeb({ agentes: [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a1' }], env: { DGCLAW_MARCA_DIR: dir } });
  try {
    fs.writeFileSync(path.join(t.publico, 'login.html'), '<html data-tema="{{MARCA_TEMA}}"><title>{{MARCA_NOME}}</title><h1>{{MARCA_TITULO_LOGIN}}</h1>{{OUTRA_COISA}}</html>');
    const css = await t.c.get('/marca.css');
    assert.equal(css.status, 200); assert.match(css.headers['content-type'], /text\/css/);
    assert.match(css.texto, /--botao-fundo:#ff0000;/); assert.ok(!css.texto.includes(dir));
    assert.ok(!css.texto.includes('botao-texto'));
    const logo = await t.c.get('/marca/logo');
    assert.equal(logo.status, 200); assert.equal(logo.headers['content-type'], 'image/svg+xml');
    assert.equal(logo.headers['x-content-type-options'], 'nosniff');
    assert.equal(logo.headers['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    const fav = await t.c.get('/marca/favicon');                    // favicon inválido: cai no padrão de fábrica
    assert.equal(fav.status, 200); assert.equal(fav.headers['content-type'], 'image/png');
    assert.equal((await t.c.get('/marca/icone-app')).status, 200);
    assert.equal((await t.c.get('/marca/fonte/base')).status, 404);
    assert.equal((await t.c.get('/marca/fonte/outra')).status, 404);
    assert.equal((await t.c.get('/marca/../../etc/passwd')).status, 404);
    const man = await t.c.get('/manifest.webmanifest');
    assert.equal(man.status, 200); assert.equal(man.json.name, 'Acme Bot');
    const lg = await t.c.get('/login');
    assert.equal(lg.status, 200); assert.match(lg.texto, /<title>Acme Bot<\/title><h1>Entre no Acme<\/h1>\{\{OUTRA_COISA\}\}/);
    assert.match(lg.texto, /data-tema="claro"/);
    assert.equal((await t.c.pedir('POST', '/marca.css')).status === 200, false);
    assert.equal((await t.c.pedir('HEAD', '/marca/logo')).status, 200);
    for (const r of [css, logo, fav, man, lg]) assert.ok(!r.texto.includes(dir) && !String(r.headers['content-type']).includes(dir));
    // sem sessão: nada além das rotas da marca abriu (uma rota qualquer continua pedindo login)
    assert.notEqual((await t.c.get('/api/v1/agents')).status, 200);
    const log = t.log.texto();
    assert.match(log, /campo "cores\.botao-texto"/); assert.match(log, /campo "favicon"/);
  } finally { await t.fechar(); }
});

test('marca: nome e slogan com HTML são rejeitados e não viram marcação em página nenhuma', async () => {
  const dir = pasta({ nome: 'A"><img src=x onerror=alert(1)>', slogan: 'ok <b>' });
  const t = await subirWeb({ agentes: [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a1' }], env: { DGCLAW_MARCA_DIR: dir } });
  try {
    fs.writeFileSync(path.join(t.publico, 'login.html'), '<meta name="marca-nome" content="{{MARCA_NOME}}"><p>{{MARCA_SLOGAN}}</p>');
    const lg = await t.c.get('/login');
    assert.equal(lg.texto, '<meta name="marca-nome" content="DG Claw"><p>Seus agentes, no seu servidor.</p>');
  } finally { await t.fechar(); }
});
