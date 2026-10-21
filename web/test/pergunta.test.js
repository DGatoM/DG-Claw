'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { teclasDaResposta, validarRespostas } = require('../lib/conversa');
const { descrevePerguntas } = require('../lib/trilha');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const op = (rotulo) => ({ rotulo, descricao: '' });
const Q = (multipla, n = 3) => ({ pergunta: 'Qual?', cabecalho: 'Q', multipla, opcoes: Array.from({ length: n }, (_, i) => op('o' + (i + 1))) });

// ── teclas (função pura) ────────────────────────────────────────────────────
test('teclasDaResposta: escolha única com uma pergunta é só o dígito', () => {
  assert.deepEqual(teclasDaResposta([Q(false)], [{ opcao: 2 }]), ['2']);
});

test('teclasDaResposta: texto livre = dígito "Type something" (opções+1), texto, Enter', () => {
  assert.deepEqual(teclasDaResposta([Q(false, 3)], [{ texto: 'outra coisa' }]), ['4', 'outra coisa', '\r']);
});

test('teclasDaResposta: múltipla marca cada opção, avança com Tab e confirma na revisão', () => {
  assert.deepEqual(teclasDaResposta([Q(true)], [{ opcoes: [1, 3] }]), ['1', '3', '\t', '1']);
});

test('teclasDaResposta: duas perguntas avançam uma a uma e fecham com o 1 da revisão', () => {
  assert.deepEqual(teclasDaResposta([Q(false), Q(false, 2)], [{ opcao: 3 }, { texto: 'x' }]), ['3', '3', 'x', '\r', '1']);
});

test('teclasDaResposta: única seguida de múltipla (última é múltipla) tem revisão', () => {
  assert.deepEqual(teclasDaResposta([Q(false), Q(true)], [{ opcao: 1 }, { opcoes: [2] }]), ['1', '2', '\t', '1']);
});

test('validarRespostas: aponta o problema e diz que nada foi enviado', () => {
  const um = [Q(false, 3)], mult = [Q(true, 3)];
  const casos = [
    [um, [], /uma resposta para cada pergunta/],
    [um, [{ opcao: 4 }], /fora do intervalo/],
    [um, [{ opcao: 1.5 }], /fora do intervalo/],
    [um, [{ opcao: 1, texto: 'a' }], /exatamente um/],
    [um, [{ opcoes: [1] }], /aceita uma escolha só/],
    [um, [{ texto: '   ' }], /vazio/],
    [um, [{ texto: 'a'.repeat(2001) }], /limite é 2000/],
    [um, [{ texto: 'a\nb' }], /quebra de linha/],
    [um, [{ texto: 'a\x1bb' }], /quebra de linha ou caractere de controle/],
    [mult, [{ texto: 'a' }], /aba Sessões/],
    [mult, [{ opcao: 1 }], /use "opcoes"/],
    [mult, [{ opcoes: [] }], /pelo menos um/],
    [mult, [{ opcoes: [1, 1] }], /repete/],
    [mult, [{ opcoes: [0] }], /fora do intervalo/],
  ];
  for (const [perguntas, resp, rx] of casos) {
    const m = validarRespostas(perguntas, resp);
    assert.match(m || '', rx, JSON.stringify(resp));
    assert.match(m, /Nada foi enviado/);
  }
  assert.equal(validarRespostas(um, [{ texto: 'tudo certo' }]), null);
  assert.equal(validarRespostas(mult, [{ opcoes: [3, 1] }]), null);
});

test('descrevePerguntas: lê o input do AskUserQuestion e recusa formato que não dá para dirigir', () => {
  const ok = descrevePerguntas({ questions: [{ question: 'Qual?', header: 'Cor', multiSelect: true, options: [{ label: 'a', description: 'da' }, { label: 'b' }] }] });
  assert.deepEqual(ok, [{ pergunta: 'Qual?', cabecalho: 'Cor', multipla: true, opcoes: [{ rotulo: 'a', descricao: 'da' }, { rotulo: 'b', descricao: '' }] }]);
  assert.equal(descrevePerguntas({}), null);
  assert.equal(descrevePerguntas({ questions: [{ question: 'x', options: [{ label: 'só uma' }] }] }), null);
  assert.equal(descrevePerguntas({ questions: [{ question: 'x', options: Array.from({ length: 9 }, () => ({ label: 'a' })) }] }), null);
});

// ── rotas ───────────────────────────────────────────────────────────────────
const linha = (o) => JSON.stringify(Object.assign({ isSidechain: false }, o));
const usoPergunta = (ts, id, questions) => linha({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const resultado = (ts, id) => linha({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const perg = (multi, n = 3) => ({ question: 'Qual cor?', header: 'Cor', multiSelect: multi, options: Array.from({ length: n }, (_, i) => ({ label: 'cor' + (i + 1), description: 'd' + (i + 1) })) });

async function cenario(opRunner, perguntas) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1', status: 'waiting_input', motivo: 'pergunta' }, opRunner));
  const porta = await runner.ouvir();
  const tr = pastaTemp('tr');
  if (perguntas !== null) fs.writeFileSync(path.join(tr, 'sess-0001-aaaa.jsonl'), usoPergunta('2026-10-19T10:00:01.000Z', 'tuP', perguntas || [perg(false)]) + '\n');
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: tr, home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  return { t, runner, tr, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const responde = (s, corpo) => s.t.c.post('/api/v1/agents/ana/pergunta', { json: corpo });
// O web não escreve mais tecla nenhuma: só entrega ao runner o pedido da pergunta (e é ele que digita).
const escrito = (s) => s.runner.rec.inputs.concat(s.runner.rec.perguntas);
const pedidos = (s) => s.runner.rec.perguntas;

test('pergunta: sucesso escreve as teclas na ordem, cru e sem enviar', async () => {
  const s = await cenario({}, [perg(false), perg(true)]);
  try {
    const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ texto: 'azul' }, { opcoes: [1, 3] }] });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, agente: 'ana', tool_use_id: 'tuP' });
    assert.equal(s.runner.rec.inputs.length, 0, 'o web não digita: o runner é quem escreve');
    assert.equal(pedidos(s).length, 1);
    assert.deepEqual(pedidos(s)[0], { tool_use_id: 'tuP', teclas: ['4', 'azul', '\r', '1', '3', '\t', '1'] });
  } finally { await s.fechar(); }
});

test('pergunta: cancelar escreve só o Esc', async () => {
  const s = await cenario();
  try {
    const r = await responde(s, { tool_use_id: 'tuP', cancelar: true });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(pedidos(s), [{ tool_use_id: 'tuP', teclas: ['\x1b'] }]);
  } finally { await s.fechar(); }
});

test('pergunta: tool_use_id que não é o da pergunta atual => 409 sem escrita', async () => {
  const s = await cenario();
  try {
    const r = await responde(s, { tool_use_id: 'outro', respostas: [{ opcao: 1 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /já não é a que está na tela/);
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('pergunta: pergunta já respondida no transcript => 409 sem escrita', async () => {
  const s = await cenario();
  try {
    fs.appendFileSync(path.join(s.tr, 'sess-0001-aaaa.jsonl'), resultado('2026-10-19T10:00:09.000Z', 'tuP') + '\n');
    const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ opcao: 1 }] });
    assert.equal(r.status, 409);
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('pergunta: agente que não está em pergunta (trabalhando, ocioso, permissão) => 409 sem escrita', async () => {
  for (const o of [{ status: 'working', motivo: null }, { status: 'idle', motivo: null }, { status: 'waiting_input', motivo: 'permissao' }]) {
    const s = await cenario(o);
    try {
      const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ opcao: 1 }] });
      assert.equal(r.status, 409, JSON.stringify(o));
      assert.match(r.json.erro, /Atualize a conversa/);
      assert.equal(escrito(s).length, 0);
    } finally { await s.fechar(); }
  }
});

test('pergunta: pergunta ilegível no transcript => 409 mandando ir ao terminal', async () => {
  const s = await cenario({}, null);
  try {
    const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ opcao: 1 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /aba Sessões/);
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('pergunta: validações => 400 sem escrita', async () => {
  const s = await cenario({}, [perg(false), perg(true)]);
  try {
    const corpos = [
      {},
      { tool_use_id: 'tuP' },
      { tool_use_id: 'tuP', cancelar: false },
      { tool_use_id: 'tuP', cancelar: true, respostas: [] },
      { tool_use_id: 'tuP', respostas: [{ opcao: 1 }] },
      { tool_use_id: 'tuP', respostas: [{ opcao: 9 }, { opcoes: [1] }] },
      { tool_use_id: 'tuP', respostas: [{ texto: 'a\nb' }, { opcoes: [1] }] },
      { tool_use_id: 'tuP', respostas: [{ opcao: 1 }, { texto: 'livre' }] },
      { tool_use_id: 'tuP', respostas: [{ opcao: 1 }, { opcoes: [2, 2] }] },
    ];
    for (const c of corpos) {
      const r = await responde(s, c);
      assert.equal(r.status, 400, JSON.stringify(c) + ' ' + r.texto);
      assert.ok(r.json.erro);
    }
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('pergunta: sem Origin e sem sessão', async () => {
  const s = await cenario();
  try {
    assert.equal((await s.t.c.post('/api/v1/agents/ana/pergunta', { json: { tool_use_id: 'tuP', cancelar: true }, origin: false })).status, 403);
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/pergunta', { json: { tool_use_id: 'tuP', cancelar: true } })).status, 401);
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('pergunta: o runner parou no meio (estado mudou) => 409 com o motivo e o que fazer', async () => {
  const corpo = { success: false, error: 'A resposta parou na tecla 1 de 3: o terminal saiu da pergunta.', howToFix: 'conferir o terminal do agente na aba Sessões e terminar por lá', code: 'PERGUNTA_MUDOU' };
  const s = await cenario({ falhaPergunta: { status: 409, corpo } }, [perg(false), perg(false)]);
  try {
    const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ opcao: 1 }, { opcao: 2 }] });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /parou na tecla 1 de 3/);
    assert.match(r.json.erro, /aba Sessões/);
  } finally { await s.fechar(); }
});

test('pergunta: o terminal já mexeu na pergunta => 409 PERGUNTA_JA_MEXIDA com motivo, o que fazer e código para a tela', async () => {
  const corpo = { success: false, error: 'A pergunta já recebeu teclas pelo terminal desde que abriu.', howToFix: 'terminar pelo terminal, na aba Sessões', code: 'PERGUNTA_JA_MEXIDA' };
  const s = await cenario({ falhaPergunta: { status: 409, corpo } }, [perg(false), perg(false)]);
  try {
    const r = await responde(s, { tool_use_id: 'tuP', respostas: [{ opcao: 1 }, { opcao: 2 }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'PERGUNTA_JA_MEXIDA');
    assert.match(r.json.erro, /já recebeu teclas pelo terminal/);
    assert.match(r.json.erro, /Nada foi enviado/);
    assert.match(r.json.howToFix, /aba Sessões/);
  } finally { await s.fechar(); }
});

test('pergunta: runner com erro inesperado => 502; runner antigo sem a rota => 501 mandando atualizar', async () => {
  let s = await cenario({ falhaPergunta: { status: 500, corpo: { success: false, error: 'quebrou' } } });
  try {
    const r = await responde(s, { tool_use_id: 'tuP', cancelar: true });
    assert.equal(r.status, 502);
    assert.match(r.json.erro, /quebrou/);
  } finally { await s.fechar(); }
  s = await cenario({ semRotaPergunta: true });
  try {
    const r = await responde(s, { tool_use_id: 'tuP', cancelar: true });
    assert.equal(r.status, 501);
    assert.match(r.json.erro, /Atualize o agente pelo Admin/);
    assert.match(r.json.erro, /terminal/);
  } finally { await s.fechar(); }
});

test('pergunta: runner fora do ar => 503 sem escrita', async () => {
  const s = await cenario();
  try {
    await s.runner.fechar();
    const r = await responde(s, { tool_use_id: 'tuP', cancelar: true });
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /Nada foi enviado/);
  } finally { await s.t.fechar(); }
});

test('send: com pergunta pendente => 409 PERGUNTA_PENDENTE e nada é enfileirado', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi, tudo bem?' } });
    assert.equal(r.status, 409, r.texto);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.codigo, 'PERGUNTA_PENDENTE');
    assert.match(r.json.erro, /Ana está esperando você responder uma pergunta de escolha; a mensagem não foi enviada\./);
    assert.match(r.json.howToFix, /Responda no cartão da pergunta/);
    assert.equal(escrito(s).length, 0);
  } finally { await s.fechar(); }
});

test('send: permissão e trabalhando continuam enfileirando como antes', async () => {
  for (const o of [{ status: 'waiting_input', motivo: 'permissao' }, { status: 'working', motivo: null }]) {
    const s = await cenario(o);
    try {
      const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi' } });
      assert.equal(r.status, 200, r.texto);
      assert.equal(escrito(s).length, 1);
    } finally { await s.fechar(); }
  }
});

function lerAtividade(porta, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: '/api/v1/agents/ana/stream', headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      const fim = setTimeout(() => { req.destroy(); reject(new Error('sem evento de atividade')); }, 5000);
      res.on('data', (d) => {
        buf += d;
        const m = /event: atividade\ndata: (.*)\n/.exec(buf);
        if (m) { clearTimeout(fim); req.destroy(); resolve(JSON.parse(m[1]).agentes.ana); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}
const cookieDe = (s) => Object.entries(s.t.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

test('atividade: pergunta pendente traz o objeto da pergunta; sem leitura vem null; permissão não vaza pergunta', async () => {
  let s = await cenario();
  try {
    const a = await lerAtividade(s.t.porta, cookieDe(s));
    assert.equal(a.alerta, 'pergunta');
    assert.equal(a.pergunta.id, 'tuP');
    assert.deepEqual(a.pergunta.perguntas[0].opcoes[1], { rotulo: 'cor2', descricao: 'd2' });
    assert.equal(a.pergunta.perguntas[0].multipla, false);
    assert.equal(a.permissao, undefined);
  } finally { await s.fechar(); }
  s = await cenario({}, null);
  try {
    const a = await lerAtividade(s.t.porta, cookieDe(s));
    assert.equal(a.alerta, 'pergunta');
    assert.equal(a.pergunta, null);
  } finally { await s.fechar(); }
});

test('atividade: a pergunta não aparece como comando no cartão de permissão', async () => {
  const s = await cenario({ motivo: 'permissao' });
  try {
    const a = await lerAtividade(s.t.porta, cookieDe(s));
    assert.equal(a.alerta, 'permissao');
    assert.equal(a.permissao, null);
  } finally { await s.fechar(); }
});

test('conversa: a página tem o cartão da pergunta', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.html'), 'utf8');
  assert.ok(html.includes('id="perguntaCartao"'));
});
