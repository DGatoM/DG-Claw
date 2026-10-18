'use strict';
// A tela de entrada com o login único: o login.js roda aqui num documento de mentira (node:vm) e o teste confere o que
// cada modo mostra, esconde e escreve. Sem navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODIGO = fs.readFileSync(path.join(__dirname, '../public/login.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');

function elemento(extra) {
  const e = Object.assign({ hidden: false, textContent: '', value: '', style: {}, href: '', children: [], listeners: {} }, extra || {});
  e.classList = { add: (c) => { e.classes = (e.classes || []).concat(c); } };
  e.addEventListener = (n, f) => { e.listeners[n] = f; };
  e.focus = () => { e.focado = true; };
  return e;
}

/** Roda o login.js com a resposta de /api/login-estado e a query dadas. Devolve os elementos para o teste olhar. */
async function rodar(estado, query) {
  const ids = ['next', 'erro', 'usuario', 'form', 'sso', 'ssoBotao', 'ssoSenha'];
  const els = Object.fromEntries(ids.map((i) => [i, elemento({ hidden: ['erro', 'sso', 'ssoSenha'].includes(i) })]));
  const ordem = [];
  els.form.parentNode = { insertBefore: (novo, ref) => ordem.push([novo === els.sso ? 'sso' : '?', ref === els.form ? 'form' : '?']) };
  const contexto = {
    document: { getElementById: (id) => els[id] },
    location: { search: query || '' },
    URLSearchParams,
    encodeURIComponent,
    fetch: async () => ({ json: async () => estado }),
  };
  vm.runInNewContext(CODIGO, contexto);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { els, ordem };
}

test('o HTML tem o botão e o link do login único, escondidos até o servidor mandar', () => {
  assert.match(HTML, /id="sso" class="sso" hidden/);
  assert.match(HTML, /id="ssoBotao"/);
  assert.match(HTML, /id="ssoSenha" class="sso-senha" hidden/);
});

test('sem sso na resposta (nível pessoal): nada aparece', async () => {
  const { els } = await rodar({ ok: true, sem_senha: false });
  assert.equal(els.sso.hidden, true);
  assert.equal(els.form.hidden, false);
});

test('opcional: botão ao lado do formulário, que continua visível', async () => {
  const { els, ordem } = await rodar({ ok: true, sso: { provedor: 'Google', modo: 'opcional', url: '/sso/entrar' } });
  assert.equal(els.sso.hidden, false);
  assert.equal(els.ssoBotao.textContent, 'Entrar com Google');
  assert.equal(els.ssoBotao.href, '/sso/entrar?next=%2F');
  assert.equal(els.form.hidden, false);
  assert.equal(els.ssoSenha.hidden, true);
  assert.deepEqual(ordem, []);
});

test('padrão: botão em destaque antes do formulário, senha atrás do link, e o destino (next) segue no botão', async () => {
  const { els, ordem } = await rodar({ ok: true, sso: { provedor: 'Microsoft', modo: 'padrao', url: '/sso/entrar' } }, '?next=%2Flembretes');
  assert.deepEqual(ordem, [['sso', 'form']]);
  assert.ok(els.sso.classes.includes('sso-destaque'));
  assert.equal(els.form.hidden, true);
  assert.equal(els.ssoSenha.hidden, false);
  assert.equal(els.ssoSenha.textContent, 'Entrar com senha');
  assert.equal(els.ssoBotao.href, '/sso/entrar?next=%2Flembretes');
  els.ssoSenha.listeners.click();
  assert.equal(els.form.hidden, false);
  assert.equal(els.ssoSenha.hidden, true);
  assert.equal(els.usuario.focado, true);
});

test('obrigatório: o link discreto é da conta de emergência', async () => {
  const { els } = await rodar({ ok: true, sso: { provedor: 'a conta da empresa', modo: 'obrigatorio', url: '/sso/entrar' } });
  assert.equal(els.ssoSenha.textContent, 'Sou a conta de emergência do TI');
  assert.equal(els.form.hidden, true);
  assert.equal(els.ssoBotao.textContent, 'Entrar com a conta da empresa');
});

test('obrigatório sem configuração: diz o motivo em vez de esconder tudo', async () => {
  const { els } = await rodar({ ok: true, sso: { modo: 'obrigatorio', indisponivel: true, provedor: null, url: null } });
  assert.equal(els.erro.hidden, false);
  assert.match(els.erro.textContent, /obrigatório neste servidor, mas ainda não está configurado/);
  assert.equal(els.ssoBotao.hidden, true);
  assert.equal(els.ssoSenha.hidden, false);
});

test('os erros do login único viram frases e texto da barra de endereço desconhecido nunca é mostrado', async () => {
  let r = await rodar({ ok: true }, '?erro=sso_dominio');
  assert.match(r.els.erro.textContent, /domínio autorizado/);
  r = await rodar({ ok: true }, '?erro=sso_obrigatorio');
  assert.match(r.els.erro.textContent, /só pelo login único/);
  r = await rodar({ ok: true }, '?erro=sso_inventado%3Cb%3E');
  assert.equal(r.els.erro.textContent, 'Não foi possível entrar. Confira os dados e tente de novo.');
});
