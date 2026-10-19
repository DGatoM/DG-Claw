'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LE = require('../public/login-expirado');

const pub = (n) => fs.readFileSync(path.join(__dirname, '..', 'public', n), 'utf8');
const EXP = { alerta: 'login_expirado', expirou_em: '2026-10-19T17:05:00Z', desde: '2026-10-19T17:06:00Z', provedor: 'claude' };

test('hora: formata no fuso do painel e devolve vazio para ISO inválido', () => {
  assert.equal(LE.hora('2026-10-19T17:05:00Z'), '14:05');
  assert.equal(LE.hora('lixo'), '');
  assert.equal(LE.hora(null), '');
});

test('chave do incidente: agente + instante do erro (cai no desde sem ele)', () => {
  assert.equal(LE.chaveDoIncidente('ana', EXP), 'ana|2026-10-19T17:05:00Z');
  assert.equal(LE.chaveDoIncidente('ana', { desde: 'D' }), 'ana|D');
  assert.notEqual(LE.chaveDoIncidente('ana', EXP), LE.chaveDoIncidente('bia', EXP));
});

test('deveMostrar: só com o alerta, e não se aquele incidente foi dispensado; recusa de envio abre sempre', () => {
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: EXP, dispensados: {} }), true);
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: { alerta: 'sem_login' }, dispensados: {} }), false);
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: null, dispensados: {} }), false);
  const dispensados = LE.dispensar({}, 'ana', EXP);
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: EXP, dispensados }), false, 'dispensado');
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: Object.assign({}, EXP, { expirou_em: '2026-10-19T20:00:00Z' }), dispensados }), true, 'outro incidente do mesmo agente');
  assert.equal(LE.deveMostrar({ agenteId: 'bia', est: EXP, dispensados }), true, 'outro agente');
  assert.equal(LE.deveMostrar({ agenteId: 'ana', est: null, dispensados, forcado: true }), true, '409 LOGIN_EXPIRADO');
});

test('dispensar não muda o mapa recebido', () => {
  const antes = { x: true };
  const depois = LE.dispensar(antes, 'ana', EXP);
  assert.deepEqual(antes, { x: true });
  assert.equal(depois['ana|2026-10-19T17:05:00Z'], true);
});

test('decisao: abre com o alerta, não reabre dispensado, e espera a volta quando o alerta some com o pop-up aberto', () => {
  const d = (o) => LE.decisao(Object.assign({ aberto: false, fase: 'aviso', agenteId: 'ana', est: EXP, dispensados: {} }, o));
  assert.equal(d({}), 'abrir');
  assert.equal(d({ dispensados: LE.dispensar({}, 'ana', EXP) }), 'nada');
  assert.equal(d({ aberto: true }), 'nada');
  assert.equal(d({ aberto: true, fase: 'reiniciando' }), 'nada');
  assert.equal(d({ aberto: true, est: { estado: 'ocioso', alerta: null } }), 'aguardar_volta');
  assert.equal(d({ aberto: true, fase: 'cartao', est: { estado: 'sem_sinal' } }), 'aguardar_volta');
  assert.equal(d({ aberto: true, fase: 'reiniciando', est: { estado: 'ocioso' } }), 'nada', 'já esperando');
  assert.equal(d({ aberto: false, est: { estado: 'ocioso' } }), 'nada');
});

test('textos: título e botões por provedor, hora do erro, nome do agente e sem travessão', () => {
  const t = LE.textos({ nome: 'Ana', provedor: 'claude', expirouEm: EXP.expirou_em });
  assert.equal(t.titulo, 'Seu login do Claude expirou');
  assert.equal(t.primario, 'Reconectar conta do Claude');
  assert.equal(t.secundario, 'Reiniciar a sessão');
  assert.equal(t.agoraNao, 'Agora não');
  assert.equal(t.corpo, 'A sessão de Ana parou de responder às 14:05 porque a conta do Claude saiu. O que você mandou desde então ficou sem resposta. Reconecte a conta e eu reinicio a sessão dela sozinho.');
  assert.equal(t.reiniciando, 'Reiniciando a sessão de Ana…');
  assert.equal(t.pronto, 'Pronto, Ana voltou.');
  const c = LE.textos({ nome: 'Ana', provedor: 'codex', expirouEm: null, motivo: 'a conta continua sem login' });
  assert.equal(c.titulo, 'Seu login do Codex expirou');
  assert.ok(!c.corpo.includes(' às '), 'sem hora, não inventa');
  assert.match(c.naoVoltou, /a conta continua sem login/);
  for (const v of Object.values(Object.assign({}, t, c))) assert.ok(!/[—–]/.test(v), 'travessão em: ' + v);
});

test('prazos: 90 s para a volta e 3 s para o "Pronto" fechar', () => {
  assert.equal(LE.PRAZO_VOLTA_MS, 90000);
  assert.equal(LE.FECHA_PRONTO_MS, 3000);
});

test('a página carrega o módulo e o estilo, o pop-up é um dialog modal acessível e o service worker guarda os dois', () => {
  const html = pub('conversa.html');
  assert.ok(html.indexOf('/login-expirado.js') > 0 && html.indexOf('/login-expirado.js') < html.indexOf('/conversa.js'));
  assert.match(html, /<link rel="stylesheet" href="\/login-expirado\.css">/);
  assert.match(html, /<dialog id="dlgLoginExpirado"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="leTit"/);
  for (const id of ['lePrimario', 'leSecundario', 'leAgoraNao', 'leCartao', 'leErro', 'leEstado']) assert.ok(html.includes(`id="${id}"`), id);
  const sw = pub('sw.js');
  assert.ok(sw.includes("'/login-expirado.js'") && sw.includes("'/login-expirado.css'"));
  const css = pub('login-expirado.css');
  assert.match(css, /max-width:600px[\s\S]*margin:auto 0 0 0/, 'folha de baixo no celular');
  assert.match(css, /min-height:44px/, 'alvo de toque de 44 px');
});

test('conversa.js liga o pop-up: Esc vira "Agora não", 409 LOGIN_EXPIRADO não apaga o texto e o cartão não pede o oi', () => {
  const js = pub('conversa.js');
  assert.match(js, /leDlg\.addEventListener\('cancel', ev => \{ ev\.preventDefault\(\); leFecha\(true\); \}\)/);
  assert.match(js, /e\.codigo === 'LOGIN_EXPIRADO'/);
  assert.match(js, /if \(!entrada\.value\.trim\(\)\) \{ entrada\.value = pend\.texto; ajustaCampo\(\); \}/);
  assert.match(js, /if \(!lc\.expirado\) \{\s*api\(LOGIN_API \+ '\/oi'/);
  assert.match(js, /leSincroniza\(\);/);
  assert.match(js, /reiniciaSessao = dispara;/);
  for (const m of js.matchAll(/\bLE\.(\w+)/g)) assert.ok(m[1] in LE, 'LE.' + m[1] + ' não existe em login-expirado.js');
});
