'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/conversa-puro');

const H = 3600 * 1000;

test('assinaturaAviso: número vira #, então 92% e 93% são o mesmo aviso', () => {
  assert.equal(P.assinaturaAviso('A cota de voz está em 92% (9.200 de 10.000)'), P.assinaturaAviso('A cota de voz está em 93% (9.300 de 10.000)'));
  assert.notEqual(P.assinaturaAviso('A cota de voz está no limite'), P.assinaturaAviso('A cota de texto está no limite'));
});

test('aviso fechado descansa 48 h, nem um minuto a mais', () => {
  const t0 = 1_000_000_000_000;
  const mapa = P.registraFechamento({}, 'Cota em 92%', t0);
  assert.equal(P.avisoDescansando(mapa, 'Cota em 93%', t0 + 47 * H), true);
  assert.equal(P.avisoDescansando(mapa, 'Cota em 93%', t0 + 48 * H), false);
  assert.equal(P.avisoDescansando(mapa, 'Outro aviso qualquer', t0 + H), false);
  assert.equal(P.avisoDescansando({}, 'Cota em 92%', t0), false);
  assert.equal(P.avisoDescansando(null, 'Cota em 92%', t0), false);
});

test('registraFechamento limpa as assinaturas vencidas e mantém as vivas', () => {
  const t0 = 1_000_000_000_000;
  const velho = { 'aviso velho': t0 - 49 * H, 'aviso vivo': t0 - 2 * H, lixo: 'x' };
  const novo = P.registraFechamento(velho, 'Aviso novo 5', t0);
  assert.deepEqual(Object.keys(novo).sort(), ['Aviso novo #', 'aviso vivo']);
  assert.equal(velho['aviso velho'], t0 - 49 * H, 'o mapa original não é alterado');
});

test('áudio transcrito: envio direto leva o prefixo exato; envio para revisar não leva', () => {
  assert.equal(P.MARCA_AUDIO, '[áudio transcrito] ');
  assert.equal(P.textoDaFala('quero o relatório', true), '[áudio transcrito] quero o relatório');
  assert.equal(P.textoDaFala('quero o relatório', false), 'quero o relatório');
});

test('separaAudio: esconde o prefixo e avisa; texto sem prefixo fica igual', () => {
  assert.deepEqual(P.separaAudio('[áudio transcrito] oi, tudo bem?'), { audio: true, texto: 'oi, tudo bem?' });
  assert.deepEqual(P.separaAudio('oi, tudo bem?'), { audio: false, texto: 'oi, tudo bem?' });
  // só vale no começo da mensagem
  assert.deepEqual(P.separaAudio('ele disse [áudio transcrito] oi'), { audio: false, texto: 'ele disse [áudio transcrito] oi' });
  assert.deepEqual(P.separaAudio(null), { audio: false, texto: '' });
  assert.equal(P.separaAudio(P.marcaAudio('x')).texto, 'x');
});

test('conversa.js: só o envio direto marca o áudio, o caminho do campo não', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  const ini = fonte.indexOf('async function entregaTranscricao(');
  const corpo = fonte.slice(ini, fonte.indexOf('\n}\n', ini));
  const ramoCampo = corpo.slice(corpo.indexOf('if (!manda) {'), corpo.indexOf('await enviarTexto('));
  assert.ok(ramoCampo.includes('entrada.value'), 'achou o ramo do campo');
  assert.ok(!/textoDaFala|marcaAudio/.test(ramoCampo), 'o ramo do campo não marca');
  assert.match(corpo, /enviarTexto\(PURO\.textoDaFala\(texto, true\)\)/);
});

test('conversa.html carrega o conversa-puro.js antes do conversa.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.html'), 'utf8');
  assert.ok(html.indexOf('/conversa-puro.js') > 0 && html.indexOf('/conversa-puro.js') < html.indexOf('/conversa.js'));
});

test('conversa.js não usa DGConversaPuro direto: tudo passa pelo PURO, que tem reserva se o arquivo não carregar', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  assert.ok(!/DGConversaPuro\./.test(fonte), 'achou DGConversaPuro. direto em conversa.js: use PURO.');
  assert.match(fonte, /const PURO = window\.DGConversaPuro \|\|/);
  const reserva = fonte.slice(fonte.indexOf('const PURO ='), fonte.indexOf('})();', fonte.indexOf('const PURO =')));
  assert.match(reserva, /console\.warn\([^)]*conversa-puro\.js não carregou/);
  for (const nome of ['avisoDescansando', 'registraFechamento', 'separaAudio', 'textoDaFala', 'avaliaVolta', 'baixarNoPwaIos']) assert.ok(reserva.includes(nome + ':'), 'a reserva precisa ter ' + nome);
  // todo PURO.x usado existe no módulo real
  for (const m of fonte.matchAll(/\bPURO\.(\w+)/g)) assert.equal(typeof P[m[1]], 'function', 'PURO.' + m[1] + ' não existe em conversa-puro.js');
});

test('avaliaVolta: só conta retrato novo, posterior ao pedido e diferente do anterior', () => {
  const foto = (agora, estado, extra) => ({ agora, agentes: { ana: Object.assign({ estado }, extra) } });
  const base = { marco: 100, ultimoAgora: null, vivas: 0, agenteId: 'ana', streamAberto: true, decorridoMs: 5000 };
  // foto velha (anterior ao pedido) não conta, mesmo com o agente "vivo"
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(99, 'ocioso') })).vivas, 0);
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(100, 'ocioso') })).acao, 'esperar');
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: null })).acao, 'esperar');
  // a mesma foto lida duas vezes conta uma só
  let v = P.avaliaVolta(Object.assign({}, base, { foto: foto(101, 'ocioso') }));
  assert.deepEqual([v.acao, v.vivas, v.ultimoAgora], ['esperar', 1, 101]);
  v = P.avaliaVolta(Object.assign({}, base, { foto: foto(101, 'ocioso'), vivas: v.vivas, ultimoAgora: v.ultimoAgora }));
  assert.deepEqual([v.acao, v.vivas], ['esperar', 1]);
  // segundo retrato novo fecha
  v = P.avaliaVolta(Object.assign({}, base, { foto: foto(103, 'ocioso'), vivas: 1, ultimoAgora: 101 }));
  assert.equal(v.acao, 'voltou');
  // sem_sinal zera; stream fechado ou menos de 3 s não contam
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(103, 'sem_sinal'), vivas: 1, ultimoAgora: 101 })).vivas, 0);
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(103, 'ocioso'), streamAberto: false })).vivas, 0);
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(103, 'ocioso'), decorridoMs: 2000 })).vivas, 0);
  // sem_login: só de retrato posterior ao pedido
  assert.equal(P.avaliaVolta(Object.assign({}, base, { foto: foto(90, 'ocioso', { alerta: 'sem_login' }) })).acao, 'esperar');
  v = P.avaliaVolta(Object.assign({}, base, { foto: foto(110, 'ocioso', { alerta: 'sem_login', motivo: 'conecte' }) }));
  assert.deepEqual([v.acao, v.motivo], ['sem_login', 'conecte']);
});

test('avaliaVolta: login_expirado só falha depois dos 3 s (antes pode ser retrato do estado de antes do reinício)', () => {
  const foto = (agora, extra) => ({ agora, agentes: { ana: Object.assign({ estado: 'sem_sinal' }, extra) } });
  const base = { marco: 100, ultimoAgora: null, vivas: 0, agenteId: 'ana', streamAberto: true };
  const exp = { alerta: 'login_expirado', motivo: 'o login expirou' };
  let v = P.avaliaVolta(Object.assign({}, base, { decorridoMs: 1000, foto: foto(101, exp) }));
  assert.deepEqual([v.acao, v.vivas], ['esperar', 0]);
  v = P.avaliaVolta(Object.assign({}, base, { decorridoMs: 4000, foto: foto(105, exp) }));
  assert.deepEqual([v.acao, v.motivo], ['login_expirado', 'o login expirou']);
  // retrato anterior ao pedido nunca conta
  assert.equal(P.avaliaVolta(Object.assign({}, base, { decorridoMs: 4000, foto: foto(90, exp) })).acao, 'esperar');
});

// ── baixar no app instalado do iPhone ───────────────────────────────────────
function depsBaixar(sobre) {
  const chamadas = { abriu: [], buscou: [] };
  const deps = Object.assign({
    fetch: async (u) => { chamadas.buscou.push(u); return { ok: true, headers: { get: () => null }, blob: async () => ({ type: 'text/plain' }) }; },
    criarArquivo: (blob, nome, tipo) => ({ blob, nome, tipo }),
    abrir: (u) => chamadas.abriu.push(u),
    cache: {},
    nav: {},
  }, sobre);
  return { deps, chamadas };
}

test('baixar no PWA do iPhone: compartilha o arquivo e nunca navega a janela do app', async () => {
  const compartilhados = [];
  const { deps, chamadas } = depsBaixar({ nav: { canShare: () => true, share: async (d) => { compartilhados.push(d); } } });
  const r = await P.baixarNoPwaIos('/api/v1/media/m1', 'relatorio.pdf', deps);
  assert.equal(r.via, 'compartilhado');
  assert.equal(compartilhados[0].files[0].nome, 'relatorio.pdf');
  assert.deepEqual(chamadas.abriu, []);
});

test('baixar no PWA do iPhone: aparelho sem compartilhar arquivo abre a aba direto no toque, sem buscar antes', async () => {
  const { deps, chamadas } = depsBaixar({ nav: {} });
  const r = await P.baixarNoPwaIos('/api/v1/media/m1', 'a.pdf', deps);
  assert.equal(r.via, 'aba');
  assert.deepEqual(chamadas.abriu, ['/api/v1/media/m1?baixar=1']);
  assert.deepEqual(chamadas.buscou, []);
});

test('baixar no PWA do iPhone: tipo que não compartilha espera o segundo toque para abrir a aba', async () => {
  const { deps, chamadas } = depsBaixar({ nav: { canShare: () => false, share: async () => {} } });
  assert.equal((await P.baixarNoPwaIos('/u', 'a.bin', deps)).via, 'segundo-toque');
  assert.deepEqual(chamadas.abriu, [], 'depois da busca não há mais toque: nada abre sozinho');
  assert.equal((await P.baixarNoPwaIos('/u', 'a.bin', deps)).via, 'aba');
  assert.deepEqual(chamadas.abriu, ['/u?baixar=1']);
  assert.equal(chamadas.buscou.length, 1);
});

test('baixar no PWA do iPhone: cancelar a folha não é erro; recusa por falta de toque guarda o arquivo para o segundo toque', async () => {
  let n = 0;
  const share = async () => { n += 1; if (n === 1) { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; } };
  const { deps, chamadas } = depsBaixar({ nav: { canShare: () => true, share } });
  assert.equal((await P.baixarNoPwaIos('/u', 'a.txt', deps)).via, 'segundo-toque');
  assert.equal((await P.baixarNoPwaIos('/u', 'a.txt', deps)).via, 'compartilhado');
  assert.equal(chamadas.buscou.length, 1, 'o segundo toque usa o arquivo já baixado');
  const { deps: d2 } = depsBaixar({ nav: { canShare: () => true, share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } } });
  assert.equal((await P.baixarNoPwaIos('/u', 'a.txt', d2)).via, 'cancelado');
});

test('baixar no PWA do iPhone: resposta de erro vira motivo, sem lançar', async () => {
  const { deps } = depsBaixar({ nav: { canShare: () => true, share: async () => {} }, fetch: async () => ({ ok: false, status: 404 }) });
  const r = await P.baixarNoPwaIos('/u', 'a', deps);
  assert.equal(r.via, 'erro'); assert.match(r.erro, /404/);
});

test('baixar no PWA do iPhone: arquivo grande não vira Blob; guarda só o endereço e abre a aba no segundo toque', async () => {
  let leu = false;
  const { deps, chamadas } = depsBaixar({
    nav: { canShare: () => true, share: async () => {} },
    fetch: async () => ({ ok: true, headers: { get: (k) => (k === 'Content-Length' ? String(200 * 1024 * 1024) : null) }, blob: async () => { leu = true; return {}; }, body: { cancel() {} } }),
  });
  assert.equal((await P.baixarNoPwaIos('/v', 'v.mp4', deps)).via, 'segundo-toque');
  assert.equal(leu, false);
  assert.equal((await P.baixarNoPwaIos('/v', 'v.mp4', deps)).via, 'aba');
  assert.deepEqual(chamadas.abriu, ['/v?baixar=1']);
});

test('baixar no PWA do iPhone: recusa repetida de compartilhar cai na aba em vez de prender no segundo toque', async () => {
  const share = async () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; };
  const { deps, chamadas } = depsBaixar({ nav: { canShare: () => true, share } });
  assert.equal((await P.baixarNoPwaIos('/u', 'a.txt', deps)).via, 'segundo-toque');
  assert.equal((await P.baixarNoPwaIos('/u', 'a.txt', deps)).via, 'aba');
  assert.deepEqual(chamadas.abriu, ['/u?baixar=1']);
});

test('baixar no PWA do iPhone: sem Content-Length, conta os bytes lidos e desiste ao passar do limite', async () => {
  const pedaco = { length: 30 * 1024 * 1024 };
  let lidas = 0, cancelou = false;
  const leitor = { read: async () => { lidas += 1; return lidas > 5 ? { done: true } : { done: false, value: pedaco }; }, cancel: async () => { cancelou = true; } };
  const { deps, chamadas } = depsBaixar({
    nav: { canShare: () => true, share: async () => {} },
    fetch: async () => ({ ok: true, headers: { get: () => null }, body: { getReader: () => leitor } }),
  });
  assert.equal((await P.baixarNoPwaIos('/v', 'v.txt', deps)).via, 'segundo-toque');
  assert.equal(cancelou, true);
  assert.equal(lidas, 2, 'parou assim que passou de 40 MiB');
  assert.equal((await P.baixarNoPwaIos('/v', 'v.txt', deps)).via, 'aba');
  assert.deepEqual(chamadas.abriu, ['/v?baixar=1']);
});
