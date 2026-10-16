'use strict';
// Visuais na conversa: rota /api/v1/media/<id>/visual e o endurecimento do arquivo cru.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { CSP_VISUAL, CSP_MIDIA_ATIVA } = require('../lib/media');

const HTML_AGENTE = '<div class="dv-numero">42</div><script>window.__agente = 1</script>';

/** Web com a agente ana, uma pasta home e arquivos mandados no send_file do dgchat. */
async function cenario(arquivos) {
  const r = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-ana-00001' });
  const porta = await r.ouvir();
  const home = pastaTemp('home-vis');
  const transcripts = path.join(pastaTemp('tr-vis'), 'projects');
  fs.mkdirSync(path.join(transcripts, '-home-agente'), { recursive: true });
  fs.mkdirSync(path.join(home, 'out'), { recursive: true });
  const linhas = [];
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(home, 'out', nome), conteudo);
    linhas.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'u-' + nome, name: 'mcp__dgchat__send_file', input: { chat: 'c_ana', path: `/home/agente/out/${nome}`, caption: nome } }] } }));
  }
  fs.writeFileSync(path.join(transcripts, '-home-agente', 'sess-ana-00001.jsonl'), linhas.join('\n') + '\n');
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', avatar: '🌿', cor: '#2f9e5e', provedor: 'claude', modelo: 'sonnet', transcripts_dir: transcripts, home_host: home, home_container: '/home/agente' }];
  const t = await subirWeb({ agentes });
  await t.login();
  const msgs = (await t.c.get('/api/v1/agents/ana/messages')).json.msgs;
  const id = (nome) => msgs.find((m) => m.media && m.media.nome === nome).media.id;
  return { t, home, id, fechar: async () => { await t.fechar(); await r.fechar(); } };
}

test('visual: 200 com o CSP exato, no-store, nosniff e o documento montado com a base dgvis', async () => {
  const s = await cenario({ 'vis-teste.html': HTML_AGENTE });
  try {
    const r = await s.t.c.get(`/api/v1/media/${s.id('vis-teste.html')}/visual?tema=escuro`);
    assert.equal(r.status, 200, r.texto.slice(0, 300));
    const h = r.headers;
    assert.equal(h['content-security-policy'], CSP_VISUAL);
    assert.ok(h['content-security-policy'].startsWith('sandbox allow-scripts'));
    assert.ok(h['content-security-policy'].includes("connect-src 'none'"));
    assert.ok(h['content-security-policy'].includes("frame-ancestors 'self'"));
    assert.ok(!h['content-security-policy'].includes('allow-same-origin'));
    assert.equal(h['cache-control'], 'private, no-store, no-transform');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'no-referrer');
    assert.match(h['content-type'], /^text\/html/);
    assert.ok(r.texto.startsWith('<!doctype html>'));
    assert.match(r.texto, /data-tema="escuro" data-dgvis="1" data-linhas-base="\d+"/);
    assert.ok(r.texto.includes('<style id="dgvis-css">') && r.texto.includes('<script id="dgvis-js">'));
    assert.ok(r.texto.indexOf('id="dgvis-js"') < r.texto.indexOf(HTML_AGENTE));
    assert.ok(r.texto.trimEnd().endsWith(HTML_AGENTE));
    const head = await s.t.c.pedir('HEAD', `/api/v1/media/${s.id('vis-teste.html')}/visual`);
    assert.equal(head.status, 200); assert.equal(head.headers['content-security-policy'], CSP_VISUAL); assert.equal(head.buf.length, 0);
  } finally { await s.fechar(); }
});

test('visual: tema inválido vira claro e BOM some', async () => {
  const s = await cenario({ 'vis-bom.html': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>olá</p>')]) });
  try {
    const id = s.id('vis-bom.html');
    for (const [q, esperado] of [['escuro', 'escuro'], ['claro', 'claro'], ['roxo', 'claro'], ['%22%3E%3Cscript%3Ex', 'claro'], ['', 'claro']]) {
      const r = await s.t.c.get(`/api/v1/media/${id}/visual?tema=${q}`);
      assert.ok(r.texto.includes(`data-tema="${esperado}"`), q);
    }
    const r = await s.t.c.get(`/api/v1/media/${id}/visual`);
    assert.ok(r.texto.includes('<p>olá</p>') && !r.texto.includes('﻿'));
  } finally { await s.fechar(); }
});

test('visual: sem sessão responde 401 e não entrega o documento', async () => {
  const s = await cenario({ 'vis-teste.html': HTML_AGENTE });
  try {
    const id = s.id('vis-teste.html');
    const r = await s.t.c.get(`/api/v1/media/${id}/visual`, { semCookie: true });
    assert.equal(r.status, 401);
    assert.ok(!r.texto.includes(HTML_AGENTE));
    assert.equal((await s.t.c.get(`/api/v1/media/${id}`, { semCookie: true })).status, 401);
  } finally { await s.fechar(); }
});

test('visual: id inexistente, anexo que não é .html e arquivo grande demais viram página HTML com o motivo', async () => {
  const s = await cenario({ 'vis-nota.txt': 'oi', 'vis-<b>x.txt': 'oi', 'vis-grande.html': 'x'.repeat(2 * 1024 * 1024 + 1) });
  try {
    let r = await s.t.c.get('/api/v1/media/0000000000000000/visual');
    assert.equal(r.status, 404);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['content-security-policy'], CSP_VISUAL);
    assert.ok(r.texto.includes('dv-cartao dv-alerta') && r.texto.includes('parent.postMessage'));
    r = await s.t.c.get(`/api/v1/media/${s.id('vis-nota.txt')}/visual`);
    assert.equal(r.status, 415);
    assert.equal(r.headers['content-security-policy'], CSP_VISUAL);
    assert.ok(r.texto.includes('vis-nota.txt') && r.texto.includes('"tipo":"erro"'));
    r = await s.t.c.get(`/api/v1/media/${s.id('vis-<b>x.txt')}/visual`);
    assert.ok(!r.texto.includes('<b>x') && r.texto.includes('&lt;b&gt;x'), 'o nome do arquivo é escapado');
    r = await s.t.c.get(`/api/v1/media/${s.id('vis-grande.html')}/visual`);
    assert.equal(r.status, 413);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.ok(r.texto.includes('teto'));
  } finally { await s.fechar(); }
});

test('visual: arquivo apagado do disco dá 410 com o motivo', async () => {
  const s = await cenario({ 'vis-sumiu.html': HTML_AGENTE });
  try {
    const id = s.id('vis-sumiu.html');
    fs.unlinkSync(path.join(s.home, 'out', 'vis-sumiu.html'));
    const r = await s.t.c.get(`/api/v1/media/${id}/visual`);
    assert.equal(r.status, 410);
    assert.equal(r.headers['content-security-policy'], CSP_VISUAL);
  } finally { await s.fechar(); }
});

test('mídia crua: html e svg saem com o CSP de sandbox e nosniff; png não leva CSP', async () => {
  const s = await cenario({ 'qualquer.html': '<script>1</script>', 'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'a.png': 'png' });
  try {
    for (const nome of ['qualquer.html', 'a.svg']) {
      for (const sufixo of ['', '?baixar=1']) {
        const r = await s.t.c.get(`/api/v1/media/${s.id(nome)}${sufixo}`);
        assert.equal(r.status, 200, nome);
        assert.equal(r.headers['content-security-policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:", nome + sufixo);
        assert.equal(r.headers['content-security-policy'], CSP_MIDIA_ATIVA);
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
      }
    }
    const png = await s.t.c.get(`/api/v1/media/${s.id('a.png')}`);
    assert.equal(png.headers['content-security-policy'], undefined);
  } finally { await s.fechar(); }
});
