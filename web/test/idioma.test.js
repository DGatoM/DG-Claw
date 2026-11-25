'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const I = require('../public/ds/idioma');
const C = require('../public/ds/idiomas');
const { carregaConfig, lerEnvArquivo } = require('../lib/config');
const { renderizarIdioma } = require('../lib/idioma');
const { subirWeb, pastaTemp } = require('./ajuda');
const pub = path.join(__dirname, '..', 'public');
const chave = fonte => Object.keys(C).find(k => C[k]['pt-BR'] === fonte);

test('idioma é uma allowlist: cookie explícito vence padrão; conteúdo arbitrário não vira idioma', () => {
  assert.equal(I.doCookie('outro=1; dgclaw_idioma=pt-BR; a=2', 'en'), 'pt-BR');
  assert.equal(I.doCookie('dgclaw_idioma=en', 'pt-BR'), 'en');
  for (const cookie of ['dgclaw_idioma=../../etc/passwd', 'dgclaw_idioma=en<script>', 'dgclaw_idioma=%65n', 'x_dgclaw_idioma=en']) {
    assert.equal(I.doCookie(cookie, 'pt-BR'), 'pt-BR');
  }
  assert.equal(I.doCookie('', 'en'), 'en');
  assert.equal(I.doCookie('', '<script>'), 'pt-BR');
});

test('configuração é só leitura: idioma não apaga outras linhas do web.env', () => {
  const dir = pastaTemp('idioma'); const arq = path.join(dir, 'web.env');
  const antes = '# personalizado\nOUTRA_CONFIG=preservar\nDGCLAW_WEB_IDIOMA=en\n';
  fs.writeFileSync(arq, antes);
  assert.equal(carregaConfig({ env: lerEnvArquivo(arq).vars }, () => {}).idioma, 'en');
  assert.equal(fs.readFileSync(arq, 'utf8'), antes);
  const logs = [];
  assert.equal(carregaConfig({ env: { DGCLAW_WEB_IDIOMA: 'invalido' } }, (n, s) => logs.push(s)).idioma, 'pt-BR');
  assert.match(logs.join(''), /DGCLAW_WEB_IDIOMA inválido/);
  assert.equal(carregaConfig({ env: {} }, () => {}).idioma, 'pt-BR');
});

test('renderer só traduz marcações de interface, antes de interpolar dados da marca', () => {
  const k = chave('Senha');
  const origem = '<html lang="pt-BR"><body><p>Senha</p><!--dg-i18n:' + k + '-->Senha<!--/dg-i18n--><span>{{MARCA_NOME}}</span></body></html>';
  const en = renderizarIdioma(origem, { headers: {} }, 'en');
  assert.match(en, /lang="en"/); assert.match(en, /<p>Senha<\/p>/);
  assert.match(en, /-->Password<!--/); assert.match(en, /\{\{MARCA_NOME\}\}/);
  assert.match(renderizarIdioma(origem, { headers: { cookie: 'dgclaw_idioma=pt-BR' } }, 'en'), /-->Senha<!--/);
  assert.equal(I.t('conteúdo de uma pessoa'), 'conteúdo de uma pessoa');
});

test('templates e atributos usam chaves existentes e traduções preservam placeholders', () => {
  for (const [id, v] of Object.entries(C)) {
    assert.match(id, /^[a-f0-9]{12}$/);
    assert.equal(id, crypto.createHash('sha256').update(v['pt-BR']).digest('hex').slice(0, 12));
    assert.equal(typeof v.en, 'string'); assert.ok(v.en.length);
    assert.deepEqual(v.en.match(/\{\{[^}]+\}\}/g), v['pt-BR'].match(/\{\{[^}]+\}\}/g), v['pt-BR']);
  }
  for (const dir of [pub, path.join(__dirname, '../../panel/public')]) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [, k] of html.matchAll(/(?:dg-i18n:|data-dg-i18n(?:-[a-z-]+)?=")([a-f0-9]{12})/g)) assert.ok(C[k], file + ': ' + k);
      const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      for (const [, k, fallback] of html.matchAll(/<!--dg-i18n:([a-f0-9]{12})-->([^<]*)<!--\/dg-i18n-->/g)) assert.equal(decode(fallback), C[k]['pt-BR'], file + ': fallback desatualizado ' + k);
      for (const [, k, fallback] of html.matchAll(/<title data-dg-i18n="([a-f0-9]{12})">([^<]*)<\/title>/g)) assert.equal(decode(fallback), C[k]['pt-BR'], file + ': título desatualizado');
      for (const [tag] of html.matchAll(/<[^!][^>]*\sdata-dg-i18n-(?:title|placeholder|aria-label|alt)="[a-f0-9]{12}"[^>]*>/g)) {
        for (const [, attr, k] of tag.matchAll(/data-dg-i18n-(title|placeholder|aria-label|alt)="([a-f0-9]{12})"/g)) {
          const valor = new RegExp('(?:^|\\s)' + attr + '="([^"]*)"').exec(tag);
          assert.ok(valor, file + ': falta o fallback de ' + attr);
          assert.equal(decode(valor[1]), C[k]['pt-BR'], file + ': atributo desatualizado ' + k);
        }
      }
      const en = I.html(html, 'en');
      assert.ok(en.includes('/ds/idioma.js'), file);
      assert.equal((en.match(/<!--dg-i18n:/g) || []).length, (en.match(/<!--\/dg-i18n-->/g) || []).length, file);
    }
  }
  const html = I.html(fs.readFileSync(path.join(pub, 'login.html'), 'utf8'), 'en');
  assert.match(html, /aria-label="Show password"/);
  assert.match(html, /<title[^>]*>Sign in - \{\{MARCA_NOME\}\}/);
  assert.doesNotMatch(html, /title="Mostrar senha"/);
});

test('HTTP: inglês por instalação, português explícito e assets públicos sem liberar APIs', async () => {
  const s = await subirWeb({ env: { DGCLAW_WEB_IDIOMA: 'en' }, opcoesServidor: { publicDir: pub } });
  try {
    const en = await s.c.get('/login');
    assert.equal(en.status, 200); assert.match(en.texto, /lang="en"/);
    assert.match(en.texto, /-->Username<!--/); assert.match(en.texto, /-->Sign in<!--/);
    assert.match(en.texto, /Sign in to talk to your agents\./);
    assert.match(en.texto, /Your agents, on your server\./);
    assert.equal(Number(en.headers['content-length']), en.buf.length);
    assert.equal(en.headers['cache-control'], 'no-store');
    assert.equal(en.headers['content-language'], 'en');
    const pt = await s.c.get('/login', { headers: { Cookie: 'dgclaw_idioma=pt-BR' } });
    assert.match(pt.texto, /lang="pt-BR"/); assert.match(pt.texto, /-->Usuário<!--/);
    for (const asset of ['idioma.js', 'idiomas.js', 'idioma.css']) assert.equal((await s.c.get('/ds/' + asset)).status, 200);
    assert.equal((await s.c.get('/api/v1/agents', { headers: { Cookie: 'dgclaw_idioma=en' } })).status, 401);
    await s.login();
    const en2 = await s.c.get('/login.html'); assert.match(en2.texto, /lang="en"/);
  } finally { await s.fechar(); }
});

test('painel: o cache guarda template, nunca o HTML no idioma de outra pessoa', () => {
  const build = require('../../panel/lib/html-template');
  const servidor = path.join(__dirname, '../../panel');
  const render = build({ BASE: '/p/demo', CONFIG: {}, serverDir: servidor, getAuth: () => ({ trancado: false, usuarioObrigatorio: true }) });
  const resposta = () => ({ headers: {}, status() { return this; }, type() { return this; }, set(k, v) { this.headers[k] = v; return this; }, send(body) { this.body = body; return this; } });
  const en = resposta(); const pt = resposta();
  render.renderHtmlTemplate(render.INDEX_HTML)({ headers: { cookie: 'dgclaw_idioma=en' } }, en);
  render.renderHtmlTemplate(render.INDEX_HTML)({ headers: { cookie: 'dgclaw_idioma=pt-BR' } }, pt);
  assert.match(en.body, /<html lang="en"/); assert.match(en.body, /Agent profile/);
  assert.match(pt.body, /<html lang="pt-BR"/); assert.match(pt.body, /Perfil do agente/);
  assert.equal(en.headers['Cache-Control'], 'no-store'); assert.equal(pt.headers['Cache-Control'], 'no-store');
});
