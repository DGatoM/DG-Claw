'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { subirWeb } = require('./ajuda');

// Valores falsos, só para o teste. Começam com "sk-" porque a troca de modelo da OpenAI confere o prefixo.
const CHAVE = 'sk-teste-valor-secreto-de-teste-9999aaaa';
const OUTRA = 'sk-teste-outro-valor-secreto-de-teste-7777bbbb';

/** Servidor falso que guarda tudo o que recebe (serve de painel e de runner). */
function falso(resposta) {
  const visto = [];
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      visto.push({ metodo: req.method, url: req.url, headers: req.headers, corpo: Buffer.concat(partes).toString('utf8') });
      const r = resposta ? resposta(req) : { status: 200, corpo: { ok: true } };
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.corpo));
    });
  });
  return {
    visto,
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}

async function cenario(opcoes) {
  const o = opcoes || {};
  const painel = falso(o.painelResposta ? () => o.painelResposta : undefined);
  const runner = falso((req) => {
    if (req.url === '/api/provedor' && req.method === 'POST') return o.runnerResposta || { status: 200, corpo: { ok: true, rotulo: 'Codex, pela chave de API' } };
    if (req.url === '/api/agents/a2/input' && req.method === 'POST') return { status: 202, corpo: { ok: true } };
    if (req.url === '/api/agents/a1/input' && req.method === 'POST') return o.inputResposta ? o.inputResposta() : { status: 202, corpo: { ok: true } };
    return { status: 404, corpo: { error: 'sem rota' } };
  });
  const pPainel = await painel.ouvir();
  const pRunner = await runner.ouvir();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-rotas-'));
  const casa = path.join(raiz, 'casa-ana');
  fs.mkdirSync(path.join(casa, 'cofre'), { recursive: true }); fs.mkdirSync(path.join(casa, 'config'));
  fs.chmodSync(casa, 0o711); fs.chmodSync(path.join(casa, 'cofre'), 0o700); fs.chmodSync(path.join(casa, 'config'), 0o755);
  const segredo = path.join(raiz, 'proxy.txt'); fs.writeFileSync(segredo, 'segredo-do-proxy\n');
  const reinicios = [];
  const agentes = [
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'a0' },
    { slug: 'ana', nome: 'Ana', runner: `http://127.0.0.1:${pRunner}`, agente_id: 'a1', porta_painel: pPainel, proxy_segredo_arquivo: segredo, cofre_arquivo: path.join(casa, 'cofre', 'cofre.env') },
    { slug: 'velha', nome: 'Velha', runner: `http://127.0.0.1:${pRunner}`, agente_id: 'a2', porta_painel: pPainel, proxy_segredo_arquivo: segredo },
  ];
  const t = await subirWeb({ agentes, reiniciarCofre: o.reiniciar || (async (a) => { reinicios.push(a.slug); }), opcoesServidor: Object.assign({ esperaAvisoMs: 5 }, o.voz ? { voz: o.voz } : {}) });
  await t.login();
  return {
    t, painel, runner, casa, reinicios, cofreEnv: path.join(casa, 'cofre', 'cofre.env'),
    tudo: () => JSON.stringify(painel.visto) + JSON.stringify(runner.visto),
    fechar: async () => { await t.fechar(); await painel.fechar(); await runner.fechar(); fs.rmSync(raiz, { recursive: true, force: true }); },
  };
}

test('GET/POST/DELETE em /p/ana/api/cofre são respondidos pelo Web e nunca chegam ao painel', async () => {
  const s = await cenario();
  try {
    const g0 = await s.t.c.get('/p/ana/api/cofre');
    assert.equal(g0.status, 200); assert.equal(g0.json.guarda.motor, 'host'); assert.deepEqual(g0.json.chaves, []);
    assert.equal(g0.headers['cache-control'], 'no-store');
    const p = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, provedor: 'openai' } });
    assert.equal(p.status, 200, p.texto); assert.equal(p.json.ok, true); assert.equal(p.json.ultimos4, 'bbbb');
    assert.ok(!p.texto.includes(OUTRA));
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `OPENAI_API_KEY='${OUTRA}'\n`);
    const g1 = await s.t.c.get('/p/ana/api/cofre');
    assert.equal(g1.json.chaves[0].cadastradaPor, 'dono'); assert.equal(g1.json.chaves[0].origem, 'tela');
    assert.ok(!g1.texto.includes(OUTRA));
    const put = await s.t.c.pedir('PUT', '/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA.replace('7777', '8888') } });
    assert.equal(put.json.trocada, true);
    const ruim = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'NODE_OPTIONS', valor: OUTRA } });
    assert.equal(ruim.status, 400); assert.ok(ruim.json.error && ruim.json.howToFix);
    const d = await s.t.c.pedir('DELETE', '/p/ana/api/cofre?envName=openai_api_key');
    assert.equal(d.status, 200); assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), '');
    assert.equal((await s.t.c.pedir('DELETE', '/p/ana/api/cofre?envName=OPENAI_API_KEY')).status, 409);
    assert.equal(s.painel.visto.length, 0, 'o painel não recebeu nada');
    assert.ok(!s.t.log.texto().includes(OUTRA));
    // caixa diferente e barra final também são pegas
    assert.equal((await s.t.c.get('/p/ana/API/Cofre/')).json.guarda.motor, 'host');
    assert.equal(s.painel.visto.length, 0);
  } finally { await s.fechar(); }
});

test('aplicar:true guarda e reinicia; falha do reinício mantém a chave e diz as duas coisas; /aplicar reinicia', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true } });
    assert.equal(r.status, 200); assert.equal(r.json.aplicado.ok, true); assert.deepEqual(s.reinicios, ['ana']);
    const a = await s.t.c.post('/p/ana/api/cofre/aplicar', { json: {} });
    assert.equal(a.status, 200); assert.match(a.json.feito, /reiniciado/); assert.deepEqual(s.reinicios, ['ana', 'ana']);
    assert.equal(s.painel.visto.length, 0);
  } finally { await s.fechar(); }
  const f = await cenario({ reiniciar: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  try {
    const r = await f.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true } });
    assert.equal(r.status, 500); assert.match(r.json.error, /^A chave foi guardada\./);
    assert.equal(r.json.guardado.ok, true); assert.equal(r.json.aplicado.ok, false);
    assert.ok(fs.readFileSync(f.cofreEnv, 'utf8').includes(OUTRA));
    assert.ok(!r.texto.includes(OUTRA));
    const a = await f.t.c.post('/p/ana/api/cofre/aplicar', { json: {} });
    assert.equal(a.status, 500); assert.match(a.json.error, /podman/);
  } finally { await f.fechar(); }
});

test('POST /api/provedor com chave: o Web guarda, fala com o runner, reinicia; a chave não chega ao painel nem ao runner', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api', modelo: '', chave: CHAVE } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true); assert.equal(r.json.reiniciando, true); assert.equal(r.json.rotulo, 'Codex, pela chave de API'); assert.match(r.json.feito, /reiniciado/);
    assert.deepEqual(s.reinicios, ['ana']);
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `OPENAI_API_KEY='${CHAVE}'\n`);
    assert.equal(s.painel.visto.length, 0);
    assert.equal(s.runner.visto.length, 1);
    const corpo = JSON.parse(s.runner.visto[0].corpo);
    assert.deepEqual(Object.keys(corpo).sort(), ['auth', 'modelo', 'provedor', 'reiniciar', 'sessao']);
    assert.equal(corpo.sessao, 'ana'); assert.equal(corpo.reiniciar, false); assert.equal(corpo.provedor, 'codex'); assert.equal(corpo.auth, 'api');
    assert.ok(!s.tudo().includes(CHAVE));
    assert.ok(!r.texto.includes(CHAVE) && !s.t.log.texto().includes(CHAVE));
    const meta = fs.readdirSync(path.join(s.t.dados, 'cofre'));
    assert.deepEqual(meta, ['ana.json']);
    // sem chave, mas ela já está no cofre: também resolvido pelo Web
    const r2 = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api', modelo: '' } });
    assert.equal(r2.status, 200, r2.texto); assert.equal(s.painel.visto.length, 0); assert.equal(s.runner.visto.length, 2);
  } finally { await s.fechar(); }
});

test('POST /api/provedor: prefixo errado, chave ausente do cofre e runner que recusa', async () => {
  const s = await cenario({ runnerResposta: { status: 409, corpo: { error: 'o agente está ocupado', howToFix: 'espere' } } });
  try {
    const errada = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'claude', auth: 'api', chave: OUTRA } });
    assert.equal(errada.status, 400); assert.match(errada.json.error, /Anthropic/); assert.ok(!errada.texto.includes(OUTRA));
    assert.equal(fs.existsSync(s.cofreEnv), false);
    const falta = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api' } });
    assert.equal(falta.status, 409); assert.equal(falta.json.precisaChave, 'OPENAI_API_KEY');
    const recusa = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api', chave: CHAVE } });
    assert.equal(recusa.status, 409); assert.match(recusa.json.error, /ocupado/); assert.match(recusa.json.howToFix, /já ficou guardada/);
    assert.deepEqual(s.reinicios, []);
    assert.equal(s.painel.visto.length, 0);
    assert.ok(!s.tudo().includes(CHAVE) && !recusa.texto.includes(CHAVE));
    const invalido = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api', modelo: 'modelo-que-nao-existe', chave: CHAVE } });
    assert.equal(invalido.status, 400);
  } finally { await s.fechar(); }
});

test('POST /api/provedor sem chave segue para o painel com o corpo intacto; assinatura com chave leva o corpo sem ela', async () => {
  const s = await cenario();
  try {
    const exato = '{"provedor":"claude","auth":"assinatura","modelo":""}';
    const r = await s.t.c.pedir('POST', '/p/ana/api/provedor', { corpo: exato, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200);
    assert.equal(s.painel.visto.length, 1);
    assert.equal(s.painel.visto[0].corpo, exato);
    assert.equal(s.painel.visto[0].headers['content-length'], String(Buffer.byteLength(exato)));
    assert.equal(s.painel.visto[0].headers['x-dgclaw-proxy'], 'segredo-do-proxy');
    const r2 = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'claude', auth: 'assinatura', modelo: '', chave: CHAVE } });
    assert.equal(r2.status, 200);
    assert.equal(s.painel.visto.length, 2);
    assert.deepEqual(JSON.parse(s.painel.visto[1].corpo), { provedor: 'claude', auth: 'assinatura', modelo: '' });
    assert.equal(s.painel.visto[1].headers['content-length'], String(Buffer.byteLength(s.painel.visto[1].corpo)));
    assert.ok(!s.tudo().includes(CHAVE));
    assert.equal(s.runner.visto.length, 0);
    // as outras rotas do painel passam como sempre
    assert.equal((await s.t.c.get('/p/ana/api/status')).status, 200);
    assert.equal((await s.t.c.get('/p/ana/api/provedor')).status, 200);
    assert.equal(s.painel.visto.length, 4);
  } finally { await s.fechar(); }
});

test('agente sem cofre_arquivo: tudo repassa ao painel, inclusive o cofre', async () => {
  const s = await cenario();
  try {
    assert.equal((await s.t.c.get('/p/velha/api/cofre')).status, 200);
    assert.equal((await s.t.c.post('/p/velha/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA } })).status, 200);
    assert.equal((await s.t.c.post('/p/velha/api/provedor', { json: { provedor: 'codex', auth: 'api', chave: CHAVE } })).status, 200);
    assert.equal(s.painel.visto.length, 3);
    assert.equal(s.runner.visto.length, 0);
  } finally { await s.fechar(); }
});

test('corpo acima de 64 KB nessas rotas: 413 claro, sem chegar ao painel', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: 'x'.repeat(70 * 1024) } });
    assert.equal(r.status, 413); assert.match(r.json.error, /64 KB/);
    const r2 = await s.t.c.post('/p/ana/api/provedor', { json: { provedor: 'codex', auth: 'api', chave: 'x'.repeat(70 * 1024) } });
    assert.equal(r2.status, 413);
    const r3 = await s.t.c.pedir('POST', '/p/ana/api/cofre', { corpo: '{quebrado', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r3.status, 400); assert.match(r3.json.error, /JSON/);
    assert.equal(s.painel.visto.length, 0);
  } finally { await s.fechar(); }
});

test('sem sessão ou com Origin de fora, nada do cofre responde', async () => {
  const s = await cenario();
  try {
    const anon = require('./ajuda').cliente(s.t.porta);
    assert.equal((await anon.get('/p/ana/api/cofre')).status, 401);
    assert.equal((await anon.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA } })).status, 401);
    assert.equal((await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA }, origin: 'http://evil.example' })).status, 403);
    assert.equal(fs.existsSync(s.cofreEnv), false);
  } finally { await s.fechar(); }
});

/** Voz falsa: sem rede. Guarda o que recebeu para o teste conferir. */
function vozFalsa(microfone) {
  const chamadas = [];
  return {
    chamadas, microfone,
    async transcrever(dados, nome, mime) { chamadas.push({ bytes: dados.length, nome, mime }); return { texto: 'olá, tudo bem' }; },
  };
}

test('POST /p/ana/api/chat/transcrever: o Web transcreve com a voz da plataforma e devolve {texto}', async () => {
  const voz = vozFalsa(true);
  const s = await cenario({ voz });
  try {
    const r = await s.t.c.post('/p/ana/API/chat/transcrever/', { corpo: Buffer.alloc(4096, 1), headers: { 'Content-Type': 'audio/webm;codecs=opus' } });
    assert.equal(r.status, 200, r.texto); assert.deepEqual(r.json, { texto: 'olá, tudo bem' });
    assert.deepEqual(voz.chamadas, [{ bytes: 4096, nome: 'audio.webm', mime: 'audio/webm' }]);
    const curto = await s.t.c.post('/p/ana/api/chat/transcrever', { corpo: Buffer.alloc(100, 1), headers: { 'Content-Type': 'audio/webm' } });
    assert.equal(curto.status, 400); assert.match(curto.json.error, /menos de 1 KB/); assert.ok(curto.json.howToFix);
    assert.equal(voz.chamadas.length, 1);
    assert.equal(s.painel.visto.length, 0, 'o painel não recebeu o áudio');
  } finally { await s.fechar(); }
});

test('transcrever sem chave de voz responde 503 com howToFix e não chega ao painel', async () => {
  const s = await cenario({ voz: vozFalsa(false) });
  try {
    const r = await s.t.c.post('/p/ana/api/chat/transcrever', { corpo: Buffer.alloc(4096, 1), headers: { 'Content-Type': 'audio/webm' } });
    assert.equal(r.status, 503); assert.ok(r.json.error);
    assert.match(r.json.howToFix, /ativa o microfone/);
    assert.equal(s.painel.visto.length, 0);
  } finally { await s.fechar(); }
});

test('agente sem cofre_arquivo continua tendo o transcrever encaminhado ao painel', async () => {
  const voz = vozFalsa(true);
  const s = await cenario({ voz });
  try {
    await s.t.c.post('/p/velha/api/chat/transcrever', { corpo: Buffer.alloc(4096, 1), headers: { 'Content-Type': 'audio/webm' } });
    assert.equal(s.painel.visto.length, 1); assert.equal(s.painel.visto[0].url, '/p/velha/api/chat/transcrever');
    assert.equal(voz.chamadas.length, 0);
  } finally { await s.fechar(); }
});

const entregasDe = (s, id) => s.runner.visto.filter((v) => v.url === `/api/agents/${id}/input`).map((v) => JSON.parse(v.corpo));
const entregas = (s) => s.runner.visto.filter((v) => v.url === '/api/agents/a1/input').map((v) => JSON.parse(v.corpo));
const esperar = async (cond, ms = 2000) => { const ate = Date.now() + ms; while (!cond() && Date.now() < ate) await new Promise((r) => setTimeout(r, 10)); };

test('avisar:true entrega ao agente "[cofre] NOME guardada (final xxxx)." montado no servidor, sem o valor', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.aviso, '[cofre] OPENAI_API_KEY guardada (final bbbb).');
    assert.equal(r.json.aviso_agendado, true);
    await esperar(() => entregas(s).length >= 1);
    const e = entregas(s);
    assert.equal(e.length, 1);
    assert.equal(e[0].submit, true);
    assert.match(e[0].text, /\[cofre\] OPENAI_API_KEY guardada \(final bbbb\)\./);
    assert.ok(!r.texto.includes(OUTRA) && !JSON.stringify(e).includes(OUTRA) && !s.t.log.texto().includes(OUTRA));
  } finally { await s.fechar(); }
});

test('sem avisar ninguém é avisado; texto e aviso forjados no corpo são ignorados', async () => {
  const s = await cenario();
  try {
    const sem = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true } });
    assert.equal(sem.status, 200); assert.equal(sem.json.aviso_agendado, undefined);
    const falso1 = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: 'true', aviso: 'FORJADO', texto: 'FORJADO' } });
    assert.equal(falso1.json.aviso_agendado, undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(entregas(s).length, 0);
    const forjado = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true, aviso: 'FORJADO', texto: 'FORJADO' } });
    assert.match(forjado.json.aviso, /^\[cofre\] OPENAI_API_KEY guardada/);
    await esperar(() => entregas(s).length >= 1);
    assert.ok(!JSON.stringify(entregas(s)).includes('FORJADO'));
  } finally { await s.fechar(); }
});

test('avisar: reinício que falhou acrescenta a frase ao aviso e a resposta segue com status de erro', async () => {
  const s = await cenario({ reiniciar: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  try {
    const r = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true } });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /^A chave foi guardada\./);
    assert.match(r.json.aviso, / O agente ainda não reiniciou para usar a chave\.$/);
    await esperar(() => entregas(s).length >= 1);
    assert.match(entregas(s)[0].text, /O agente ainda não reiniciou para usar a chave\./);
  } finally { await s.fechar(); }
});

test('avisar: entrega que falha é tentada de novo, cada falha vai ao log, e a desistência também', async () => {
  let n = 0;
  const s = await cenario({ inputResposta: () => (++n < 3 ? { status: 503, corpo: { error: 'reiniciando' } } : { status: 202, corpo: { ok: true } }) });
  try {
    const r = await s.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true } });
    assert.equal(r.status, 200);
    await esperar(() => n >= 3);
    assert.equal(n, 3);
    const log = s.t.log.texto();
    assert.equal((log.match(/ainda não recebeu o aviso da chave/g) || []).length, 2);
    assert.ok(!log.includes(OUTRA));
  } finally { await s.fechar(); }
  const d = await cenario({ inputResposta: () => ({ status: 503, corpo: { error: 'reiniciando' } }) });
  try {
    await d.t.c.post('/p/ana/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true } });
    await esperar(() => /desisti de avisar/.test(d.t.log.texto()));
    assert.match(d.t.log.texto(), /desisti de avisar o agente depois de 5 tentativas/);
    assert.equal(entregas(d).length, 5);
    assert.ok(!d.t.log.texto().includes(OUTRA));
  } finally { await d.fechar(); }
});

// ── agente legado (sem cofre_arquivo): quem guarda é o painel; o aviso sai do Web ──
function cenarioLegado(respostaPainel) {
  return cenario({ painelResposta: respostaPainel });
}

test('legado: painel guarda com sucesso e avisar:true entrega o texto montado da resposta do painel', async () => {
  const s = await cenarioLegado({ status: 200, corpo: { ok: true, envName: 'OPENAI_API_KEY', ultimos4: 'bbbb' } });
  try {
    const r = await s.t.c.post('/p/velha/api/cofre', { json: { envName: 'FORJADO', valor: OUTRA, avisar: true, texto: 'FORJADO' } });
    assert.equal(r.status, 200, r.texto);
    await esperar(() => entregasDe(s, 'a2').length >= 1);
    const e = entregasDe(s, 'a2');
    assert.equal(e.length, 1);
    assert.match(e[0].text, />\[cofre\] OPENAI_API_KEY guardada \(final bbbb\)\.<\/dgchat>$/);
    assert.ok(!e[0].text.includes('FORJADO'));
    assert.ok(!JSON.stringify(e).includes(OUTRA) && !s.t.log.texto().includes(OUTRA));
    assert.equal(JSON.parse(s.painel.visto[0].corpo).valor, OUTRA, 'o painel recebeu o corpo intacto');
  } finally { await s.fechar(); }
});

test('legado: sem avisar:true nada é entregue', async () => {
  const s = await cenarioLegado({ status: 200, corpo: { ok: true, envName: 'OPENAI_API_KEY', ultimos4: 'bbbb' } });
  try {
    const r = await s.t.c.post('/p/velha/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA } });
    assert.equal(r.status, 200);
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(entregasDe(s, 'a2').length, 0);
  } finally { await s.fechar(); }
});

test('legado: resposta de erro do painel não entrega nada', async () => {
  const s = await cenarioLegado({ status: 400, corpo: { error: 'Chave inválida' } });
  try {
    const r = await s.t.c.post('/p/velha/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, avisar: true } });
    assert.equal(r.status, 400);
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(entregasDe(s, 'a2').length, 0);
  } finally { await s.fechar(); }
});

test('legado: reinício que falhou no painel (erro com guardado) avisa com a frase de não aplicado', async () => {
  const s = await cenarioLegado({ status: 500, corpo: { error: 'A chave foi guardada. falhou', guardado: { ok: true, envName: 'OPENAI_API_KEY', ultimos4: 'bbbb' } } });
  try {
    const r = await s.t.c.post('/p/velha/api/cofre', { json: { envName: 'OPENAI_API_KEY', valor: OUTRA, aplicar: true, avisar: true } });
    assert.equal(r.status, 500);
    await esperar(() => entregasDe(s, 'a2').length >= 1);
    assert.match(entregasDe(s, 'a2')[0].text, /guardada \(final bbbb\)\. O agente ainda não reiniciou/);
  } finally { await s.fechar(); }
});
