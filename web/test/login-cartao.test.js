'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LC = require('../public/login-cartao');

test('ehComandoLogin: só "/login" exato, sem diferenciar caixa nem espaços nas pontas', () => {
  for (const t of ['/login', '  /LOGIN ', '/Login\n']) assert.equal(LC.ehComandoLogin(t), true, t);
  for (const t of ['/login agora', 'login', '/logins', '/ login', '', null, undefined, 42]) assert.equal(LC.ehComandoLogin(t), false, String(t));
});

test('nomeProvedor escolhe Claude ou Codex', () => {
  assert.equal(LC.nomeProvedor('codex'), 'Codex'); assert.equal(LC.nomeProvedor('Codex CLI'), 'Codex');
  assert.equal(LC.nomeProvedor('claude'), 'Claude'); assert.equal(LC.nomeProvedor(undefined), 'Claude');
});

test('linkSeguro só aceita https', () => {
  assert.equal(LC.linkSeguro('https://claude.ai/x'), 'https://claude.ai/x');
  assert.equal(LC.linkSeguro('javascript:alert(1)'), null); assert.equal(LC.linkSeguro('http://x.com'), null); assert.equal(LC.linkSeguro(null), null);
});

test('visao: início usa o texto e o nome do provedor', () => {
  const v = LC.visao({ estado: 'nenhum', provedor: 'claude', precisa_login: true }, { agente: 'Ana' });
  assert.equal(v.fase, 'inicio'); assert.equal(v.titulo, 'Conectar o seu Claude'); assert.equal(v.botao, 'Conectar');
  assert.equal(v.texto, 'Ana precisa da sua conta do Claude para responder. Conecte aqui, sem terminal.');
  assert.equal(LC.visao({ estado: 'nenhum', provedor: 'codex' }, {}).titulo, 'Conectar o seu Codex');
});

test('visao: Claude aguardando código mostra link, 2 passos, campo e cancelar', () => {
  const v = LC.visao({ estado: 'aguardando_codigo', provedor: 'claude', link: 'https://claude.ai/o' }, {});
  assert.equal(v.fase, 'codigo'); assert.equal(v.link, 'https://claude.ai/o'); assert.equal(v.campoCodigo, true);
  assert.equal(v.passos.length, 2); assert.equal(v.cancelar, true); assert.equal(v.codigoDispositivo, null);
});

test('visao: Codex aguardando navegador mostra link e código de dispositivo, sem campo', () => {
  const v = LC.visao({ estado: 'aguardando_navegador', provedor: 'codex', link: 'https://auth.openai.com/d', codigoDispositivo: 'ABCD-1234' }, {});
  assert.equal(v.fase, 'navegador'); assert.equal(v.codigoDispositivo, 'ABCD-1234'); assert.equal(v.campoCodigo, false); assert.equal(v.link, 'https://auth.openai.com/d');
});

test('visao: link que não é https nunca vira botão', () => {
  assert.equal(LC.visao({ estado: 'aguardando_codigo', link: 'javascript:x' }, {}).link, null);
});

test('visao: aguardando_link, falhou e concluido', () => {
  assert.equal(LC.visao({ estado: 'aguardando_link' }, {}).texto, 'Preparando o link…');
  const f = LC.visao({ estado: 'falhou', mensagem: 'prazo estourado' }, { iniciado: true });
  assert.equal(f.fase, 'falhou'); assert.equal(f.texto, 'prazo estourado'); assert.equal(f.botao, 'Tentar de novo');
  assert.equal(LC.visao({ estado: 'concluido' }, { iniciado: true }).titulo, 'Conectado!');
});

test('visao: concluido ou falhou antigos, de antes de abrir o cartão, não aparecem', () => {
  assert.equal(LC.visao({ estado: 'concluido', provedor: 'claude' }, { iniciado: false }).fase, 'inicio');
  assert.equal(LC.visao({ estado: 'falhou', mensagem: 'velho' }, { iniciado: false }).fase, 'inicio');
});

test('visao: /login com a conta conferida mostra "já conectada" com Fechar e Entrar de novo', () => {
  const v = LC.visao({ estado: 'nenhum', provedor: 'claude', conferido: { ok: true }, precisa_login: false }, {});
  assert.equal(v.fase, 'ja_conectado'); assert.equal(v.titulo, 'Esta conta já está conectada'); assert.equal(v.fechar, true); assert.equal(v.entrarDeNovo, true);
});

test('conversa.js: /login é interceptado antes do envio, e a página carrega o login-cartao.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  const corpo = /function enviarDoCampo\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  const iLogin = corpo.indexOf('lcInterceptaLogin(t)'); const iEnvio = corpo.indexOf('enviarTexto(');
  assert.ok(iLogin > 0 && iLogin < iEnvio, 'a interceptação vem antes do enviarTexto');
  assert.match(corpo, /lcInterceptaLogin\(t\)\) return/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.html'), 'utf8');
  assert.ok(html.indexOf('/login-cartao.js') > 0 && html.indexOf('/login-cartao.js') < html.indexOf('/conversa.js'));
  assert.match(html, /id="loginCartao"[^>]*role="region"/);
});
