'use strict';
// Segunda revisão adversarial do modo demonstração: decisões concorrentes no mesmo cartão e reset durante a
// leitura lenta do corpo de um pedido do agente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { subirDemo, TOKEN } = require('./demo-ajuda');
const { pastaTemp } = require('./ajuda');

const ROTAS = { contato: '/api/demo/v1/contato', envio: '/api/demo/v1/envio' };
const json = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
const MARIA = { id: 'chat-maria-silva', name: 'Maria Silva', remoteJid: '5511999990001@s.whatsapp.net', isGroup: false };

async function comTeste(opcoes, corpo) {
  const w = await subirDemo(opcoes);
  try { await corpo(w); } finally { await w.fechar(); }
}

/** Provedor que segura a busca de candidatos até `solta()`. */
function provedorLento() {
  const est = { segurando: false, solta: null, preso: null };
  est.espera = new Promise((ok) => { est.preso = ok; });
  const portao = new Promise((ok) => { est.solta = ok; });
  est.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/chats')) {
      if (est.segurando) { est.segurando = false; est.preso(); await portao; }
      return json(200, { success: true, data: [MARIA] });
    }
    return json(404, { error: 'nao previsto' });
  };
  return est;
}

test('confirmar e recusar ao mesmo tempo no mesmo cartão: uma só decisão vale e o estado final bate com as respostas', async () => {
  const p = provedorLento();
  await comTeste({ opcoesServidor: { demoFetch: p.fetch } }, async (w) => {
    const id = (await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' })).json.id;
    p.segurando = true;
    const confirmar = w.decide(id, { decisao: 'confirmar', candidato: 'chat-maria-silva' });
    await p.espera; // a confirmação está esperando os candidatos
    const recusar = w.decide(id, { decisao: 'recusar' });
    await new Promise((ok) => setTimeout(ok, 50));
    p.solta();
    const [rc, rr] = await Promise.all([confirmar, recusar]);
    const final = (await w.portao('GET', `${ROTAS.contato}/${id}`)).json.estado;
    const vencedoras = [rc, rr].filter((r) => r.status === 200);
    assert.equal(vencedoras.length, 1, `${rc.status} / ${rr.status}`);
    assert.equal([rc, rr].find((r) => r.status !== 200).status, 409);
    assert.equal(final, vencedoras[0].json.estado, 'o estado gravado é o da decisão que respondeu 200');
    const gravado = JSON.parse(fs.readFileSync(path.join(w.dados, 'demo', 'cartoes', `${id}.json`), 'utf8'));
    assert.equal(gravado.estado, final);
  });
});

test('cartão que expira enquanto os candidatos são buscados não vira liberado', async () => {
  const p = provedorLento();
  await comTeste({ opcoesServidor: { demoFetch: p.fetch } }, async (w) => {
    const id = (await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' })).json.id;
    p.segurando = true;
    const confirmar = w.decide(id, { decisao: 'confirmar', candidato: 'chat-maria-silva' });
    await p.espera;
    w.relogio.t += 11 * 60 * 1000;
    p.solta();
    const r = await confirmar;
    assert.equal(r.status, 409, r.texto);
    assert.equal((await w.portao('GET', `${ROTAS.contato}/${id}`)).json.estado, 'expirado');
  });
});

/** Manda um POST cujo corpo chega em duas partes; `entreAsPartes()` roda no intervalo. Devolve { status, texto }. */
function postLento(porta, caminho, corpo, entreAsPartes) {
  return new Promise((ok, falha) => {
    const bruto = JSON.stringify(corpo);
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bruto) } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => ok({ status: res.statusCode, texto: t }));
    });
    req.on('error', falha);
    req.write(bruto.slice(0, 5));
    Promise.resolve(entreAsPartes()).then(() => { req.end(bruto.slice(5)); }, falha);
  });
}

for (const [nome, caminho, corpo] of [
  ['contato', ROTAS.contato, { linha: 'danilo', nome: 'maria' }],
  ['envio', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', telefone: '5511999990001', texto: 'cliente antigo' }],
]) {
  test(`reset no meio da leitura lenta do corpo do pedido de ${nome}: nenhum 201 e nenhum cartão do cliente antigo`, async () => {
    const dir = pastaTemp('demo-corpo-lento');
    const script = path.join(dir, 'reset-falso.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho "==> ok"\nexit 0\n', { mode: 0o755 });
    await comTeste({ opcoesServidor: { demoResetBin: script, demoFetch: async (url) => (new URL(url).pathname.endsWith('/chats') ? json(200, { success: true, data: [MARIA] }) : json(404, {})) } }, async (w) => {
      const r = await postLento(w.porta, caminho, corpo, async () => {
        assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
        for (let i = 0; i < 100; i++) { if ((await w.c.get('/api/demo/reset/estado')).json.fase !== 'em_andamento') break; await new Promise((ok) => setTimeout(ok, 20)); }
      });
      assert.notEqual(r.status, 201, r.texto);
      assert.equal(r.status, 503, r.texto);
      const pasta = path.join(w.dados, 'demo', 'cartoes');
      assert.deepEqual(fs.existsSync(pasta) ? fs.readdirSync(pasta) : [], []);
    });
  });
}
