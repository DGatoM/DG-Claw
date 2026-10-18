'use strict';
// Bloco E, HTTPS endurecido: CSP em cada página, cabeçalhos, cookie com __Host- (e a migração do nome antigo) e o nível
// pessoal sem mudança. Também confere, nos arquivos reais de web/public, que nenhuma página tem script inline sem hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cenarioEnt } = require('./ent-usuarios-ajuda');
const { hashesDeScripts } = require('../lib/ent/seguranca-web');

const PUBLICO = path.join(__dirname, '..', 'public');
const PAGINAS = fs.readdirSync(PUBLICO).filter((n) => n.endsWith('.html'));

async function com(nivel, fn, opcoes) {
  const c = await cenarioEnt(Object.assign({ nivel }, opcoes || {}));
  for (const n of PAGINAS) fs.copyFileSync(path.join(PUBLICO, n), path.join(c.s.publico, n));
  try { await fn(c); } finally { await c.fechar(); }
}

test('pessoal: nenhum cabeçalho de segurança novo e o cookie continua com o nome de sempre', async () => {
  await com('pessoal', async (c) => {
    const r = await c.s.c.get('/login');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], undefined);
    assert.equal(r.headers['permissions-policy'], undefined);
    assert.equal(r.headers['strict-transport-security'], undefined);
    const l = await c.s.c.post('/login', { json: { usuario: 'dono', senha: c.s.senha } });
    assert.match(l.headers['set-cookie'][0], /^dgclaw_sessao=/);
  });
});

test('escritório: a CSP chega nas páginas com frame-ancestors, object-src, base-uri e form-action', async () => {
  await com('escritorio', async (c) => {
    for (const rota of ['/login', '/primeiro-acesso']) {
      const r = await c.s.c.get(rota);
      assert.equal(r.status, 200, rota);
      const csp = r.headers['content-security-policy'];
      assert.ok(csp, `${rota} sem CSP`);
      for (const d of ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) assert.ok(csp.includes(d), `${rota}: falta ${d} em ${csp}`);
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src não pode ter unsafe-inline nas páginas do Web');
      assert.ok(!/unsafe-eval/.test(csp));
      assert.match(r.headers['permissions-policy'], /microphone=\(self\)/);
      assert.match(r.headers['permissions-policy'], /camera=\(self\)/);
    }
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    let vistas = 0;
    for (const rota of ['/aprovacoes', '/auditoria', '/usuarios', '/protecoes', '/conta']) {
      const r = await cli.get(rota, { headers: { Accept: 'text/html' } });
      if (r.status !== 200) continue; // a tela pode não existir neste nível; as que existem têm de trazer a CSP
      vistas += 1;
      assert.ok(r.headers['content-security-policy'], `${rota} sem CSP`);
    }
    assert.ok(vistas >= 3, `só ${vistas} telas do TI carregaram; o teste não provou a CSP nelas`);
  });
});

test('escritório: o hash de cada <script> inline das páginas reais está na política (a tela de aprovações, a de auditoria e a do SSO carregam)', async () => {
  await com('escritorio', async (c) => {
    const r = await c.s.c.get('/login');
    const csp = r.headers['content-security-policy'];
    let total = 0;
    for (const n of PAGINAS) {
      for (const h of hashesDeScripts(fs.readFileSync(path.join(PUBLICO, n), 'utf8'))) { total += 1; assert.ok(csp.includes(h), `${n}: o hash ${h} não está na CSP`); }
    }
    assert.ok(total >= 5, `esperava vários scripts inline nas páginas, achei ${total}`);
  });
});

test('as páginas reais não têm manipulador inline (onclick=, onerror=...), javascript: nem eval', () => {
  for (const n of PAGINAS) {
    const t = fs.readFileSync(path.join(PUBLICO, n), 'utf8');
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(t.replace(/<script[\s\S]*?<\/script>/gi, '')), `${n} tem manipulador de evento inline`);
    assert.ok(!/href\s*=\s*["']javascript:/i.test(t), `${n} tem href javascript:`);
  }
  for (const n of fs.readdirSync(PUBLICO).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(PUBLICO, n), 'utf8');
    assert.ok(!/<[a-z]+[^>]*\son(error|click|load|change|input|submit)\s*=\s*["']/i.test(t), `${n} monta HTML com manipulador inline`);
    assert.ok(!/\beval\(|new Function\(/.test(t), `${n} usa eval ou new Function`);
  }
});

test('o painel do agente (/p/) recebe uma política própria, com script inline permitido', async () => {
  await com('escritorio', async (c) => {
    const cli = (await c.entrar('dono', c.senhaTi)).cli;
    const r = await cli.get('/p/ana/', { headers: { Accept: 'text/html' } });
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, `sem CSP em /p/ana/ (status ${r.status})`);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /object-src 'none'/);
  });
});

test('cookie: com HTTPS (proxy confiável) leva __Host-, Secure, HttpOnly e SameSite=Lax; sem HTTPS fica o nome antigo', async () => {
  await com('escritorio', async (c) => {
    const sem = await c.s.c.post('/login', { json: { usuario: 'dono', senha: c.s.senha } });
    assert.match(sem.headers['set-cookie'][0], /^dgclaw_sessao=/, 'sem HTTPS o prefixo __Host- não seria aceito pelo navegador');
  }, { web: { env: { DGCLAW_WEB_PROXIES_CONFIAVEIS: '127.0.0.1,::1,::ffff:127.0.0.1' } } });
});

test('cookie __Host-: aceita o nome antigo por enquanto e o logout apaga os dois', async () => {
  await com('escritorio', async (c) => {
    const porta = c.s.porta;
    const https = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': `127.0.0.1:${porta}` };
    const origin = `https://127.0.0.1:${porta}`;
    const cli = c.s.c;
    const l = await cli.post('/login', { json: { usuario: 'dono', senha: c.s.senha }, headers: https, origin });
    assert.equal(l.status, 200, l.texto);
    const cookie = l.headers['set-cookie'][0];
    assert.match(cookie, /^__Host-dgclaw_sessao=/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; Path=\//);
    assert.ok(!/Domain=/i.test(cookie), '__Host- não pode ter Domain');
    assert.match(l.headers['strict-transport-security'] || '', /max-age=31536000/);
    // o token vale também sob o nome antigo (sessão de antes da proteção)
    const token = cookie.split(';')[0].split('=')[1];
    const velho = await cli.pedir('GET', '/api/login-estado', { semCookie: true, headers: { Cookie: `dgclaw_sessao=${token}` } });
    assert.equal(velho.status, 200);
    const sair = await cli.pedir('POST', '/sair', { headers: https, origin });
    const apagados = (sair.headers['set-cookie'] || []).join('\n');
    assert.match(apagados, /__Host-dgclaw_sessao=; .*Max-Age=0/);
    assert.match(apagados, /(^|\n)dgclaw_sessao=; .*Max-Age=0/);
  }, { web: { env: { DGCLAW_WEB_PROXIES_CONFIAVEIS: '127.0.0.1,::1,::ffff:127.0.0.1' } } });
});
