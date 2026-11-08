'use strict';
// Tela do Face ID e o trava.js: as partes sem DOM, a ligação nas telas e o que o service worker não pode guardar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLICO = path.join(__dirname, '..', 'public');
const le = (n) => fs.readFileSync(path.join(PUBLICO, n), 'utf8');
const F = require('../public/face-id.js');
const T = require('../public/trava.js');

test('rótulo da biometria conforme o aparelho', () => {
  assert.equal(T.rotuloBiometria('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5), 'Face ID');
  assert.equal(T.rotuloBiometria('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5), 'Face ID', 'iPad que se apresenta como Mac');
  assert.equal(T.rotuloBiometria('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0), 'Touch ID');
  assert.equal(T.rotuloBiometria('Mozilla/5.0 (Windows NT 10.0)', 0), 'biometria');
  assert.equal(T.comArtigo('Face ID'), 'o Face ID');
  assert.equal(T.comArtigo('biometria'), 'a biometria');
});

test('base64url ida e volta e destino seguro do cadeado', () => {
  const bytes = Uint8Array.from([251, 255, 0, 1, 2, 250]);
  assert.deepEqual([...new Uint8Array(T.b64uParaBuf(T.bufParaB64u(bytes.buffer)))], [...bytes]);
  assert.equal(T.destinoSeguro('/a/ana?x=1'), '/a/ana?x=1');
  for (const ruim of ['//evil.com', 'https://evil.com', '/\\evil', '/cadeado?next=/', '/login', '/sair', '', null, '/a\nb']) assert.equal(T.destinoSeguro(ruim), '/', String(ruim));
});

test('erros do navegador viram português que diz o que fazer', () => {
  assert.match(T.traduzErro({ name: 'NotAllowedError' }, 'destravar', true, 'Face ID'), /cancelado.*entre com a senha/);
  assert.match(T.traduzErro(null, 'destravar', false, 'Touch ID'), /Entre com a senha/);
  assert.match(T.traduzErro({ name: 'SecurityError' }, 'cadastrar', true, 'Face ID', 'x.com'), /x\.com.*HTTPS/);
  assert.match(T.traduzErro({ name: 'InvalidStateError' }, 'cadastrar', true, 'Face ID'), /já tem/);
});

test('tela Face ID: sem HTTPS, sem WebAuthn e sem biometria explicam o motivo e dizem que a senha vale', () => {
  const base = { seguro: true, temApi: true, plataforma: true, rotulo: 'Face ID', host: 'painel.exemplo.com', ambienteErro: null };
  const ok = F.notasDoAmbiente(base);
  assert.equal(ok.podeLigar, true); assert.equal(ok.notas.length, 0);
  const semHttps = F.notasDoAmbiente(Object.assign({}, base, { seguro: false, host: '203.0.113.7' }));
  assert.equal(semHttps.podeLigar, false);
  assert.match(semHttps.notas[0].texto, /HTTPS/); assert.match(semHttps.notas[0].texto, /203\.0\.113\.7/); assert.match(semHttps.notas[0].texto, /senha continua valendo/);
  const semApi = F.notasDoAmbiente(Object.assign({}, base, { temApi: false }));
  assert.equal(semApi.podeLigar, false); assert.match(semApi.notas[0].texto, /senha continua valendo/);
  const semBio = F.notasDoAmbiente(Object.assign({}, base, { plataforma: false, rotulo: 'biometria' }));
  assert.equal(semBio.podeLigar, false); assert.match(semBio.notas[0].titulo, /biometria/); assert.match(semBio.notas[0].texto, /senha/);
  assert.equal(F.notasDoAmbiente(Object.assign({}, base, { plataforma: null })).podeLigar, true, 'não medido não bloqueia');
});

test('lista de aparelhos: escapa HTML, marca este aparelho e abre a edição do nome', () => {
  const agora = Date.parse('2026-11-08T12:00:00Z');
  const p = { id: 'pk_0123456789ab', nome: '<img onerror=x>', criada_em: '2026-11-08T11:50:00Z', ultimo_uso: '2026-11-07T10:00:00Z', este_aparelho: true, sincronizada: true };
  const h = F.listaHtml([p], agora, null);
  assert.doesNotMatch(h, /<img onerror/); assert.match(h, /&lt;img onerror=x&gt;/);
  assert.match(h, /este aparelho/); assert.match(h, /há 10 min/); assert.match(h, /data-acao="remover"/);
  assert.match(F.listaHtml([p], agora, p.id), /data-acao="salvar-nome"/);
  assert.match(F.listaHtml([], agora, null), /Nenhum aparelho/);
  assert.match(F.opcoesMinutos(15), /value="15" selected/);
  assert.match(F.opcoesMinutos(45), /value="45" selected/, 'um valor fora da lista aparece mesmo assim');
});

test('o tutorial da tela tem o que é, como e por que em todos os passos, e cada âncora existe no HTML', () => {
  const html = le('face-id.html');
  for (const p of F.passosPagina('Face ID')) {
    assert.ok(p.titulo && p.oque && p.como && p.porque, p.titulo);
    if (p.alvo.startsWith('[data-tour=')) assert.ok(html.includes(p.alvo.slice(1, -1).replace('=', '=')) , p.alvo);
  }
  assert.match(html, /DGCasca\.monta\(\{ pagina: 'face-id'/);
  assert.match(html, /user-scalable=no/);
  assert.doesNotMatch(html, /autofocus/);
  assert.match(le('face-id.css'), /font-size:16px/);
});

test('o trava.js entra em todas as telas logadas e fica fora do login; o service worker não guarda a tela travada', () => {
  for (const t of ['anonimizar', 'avisos', 'colaboradores', 'conectar', 'conversa', 'lembretes', 'mesa', 'seguranca', 'face-id', 'cadeado']) {
    assert.match(le(`${t}.html`), /<script src="\/trava\.js"><\/script>/, t);
  }
  for (const t of ['login', 'primeiro-acesso', 'trocar-senha']) assert.doesNotMatch(le(`${t}.html`), /trava\.js/, t);
  assert.match(le('cadeado.html'), /<body data-cadeado-pagina>/);
  const sw = le('sw.js');
  assert.match(sw, /PROIBIDOS = \[[^\]]*\\\/cadeado[^\]]*\\\/face-id/);
  assert.match(sw, /'\/trava\.js'/);
  assert.doesNotMatch(sw, /'\/cadeado'|cadeado\.html/, 'a página travada nunca entra na lista de cópias');
});

test('o menu leva ao Face ID para dono e colaborador', () => {
  const M = require('../public/menu-lado.js');
  assert.equal(M.LINK_FACEID.href, '/face-id');
  assert.equal(M.chaveDoHref('/face-id?a=ana'), 'face-id');
});

test('botões da tela Face ID: com passkey neste endereço e aparelho não ligado, o principal usa a que existe', () => {
  const F2 = require('../public/face-id.js');
  const a = F2.botoesDaTela({ ligado: false, temPasskeyAqui: true, rotulo: 'Face ID' });
  assert.equal(a.vincular, true); assert.equal(a.ligarPrincipal, false); assert.match(a.ligarTexto, /nova/);
  const b = F2.botoesDaTela({ ligado: false, temPasskeyAqui: false, rotulo: 'Face ID' });
  assert.equal(b.vincular, false); assert.equal(b.ligarPrincipal, true); assert.match(b.ligarTexto, /Ligar o Face ID/);
  assert.equal(F2.botoesDaTela({ ligado: true, temPasskeyAqui: true, rotulo: 'Face ID' }).vincular, false);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'face-id.html'), 'utf8');
  assert.match(html, /Usar minha passkey neste aparelho/);
});
