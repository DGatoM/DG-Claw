'use strict';
// POST /api/v1/agents/<slug>/parar: o botão Parar (um Esc na sessão), com toda falha explicada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { cenario: cenarioColab, colaboradorAtivo } = require('./colab-ajuda');

async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const para = (s) => s.t.c.post('/api/v1/agents/ana/parar', { json: {} });

test('parar: trabalhando => 200 com trabalhando e a mensagem de interrupção', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const r = await para(s);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.agente, 'ana');
    assert.equal(r.json.trabalhando, true);
    assert.notEqual(r.json.enviado_em, '2020-01-01T00:00:00.000Z', 'o horário é o medido pelo Web, não o do runner');
    assert.ok(Math.abs(Date.parse(r.json.enviado_em) - Date.now()) < 10000);
    assert.match(r.json.mensagem, /Mandei um Esc para Ana/);
    assert.match(r.json.mensagem, /pode continuar executando/);
    assert.match(r.json.mensagem, /pode continuar/);
    assert.doesNotMatch(r.json.mensagem, /foi interrompido|para na hora/);
    assert.equal(s.runner.rec.interrupcoes, 1);
  } finally { await s.fechar(); }
});

test('parar: sem corpo também vale', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/parar', {});
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.trabalhando, true);
  } finally { await s.fechar(); }
});

test('parar: runner diz que não está trabalhando (409 NAO_TRABALHANDO) => 409 claro, sem ramo de sucesso', async () => {
  const s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'ocioso', code: 'NAO_TRABALHANDO' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'NAO_TRABALHANDO');
    assert.equal(r.json.erro, 'Ana não está trabalhando agora, então não mandei nada.');
  } finally { await s.fechar(); }
});

test('parar: 2xx que não confirma o envio (204 vazio, success:false, sem enviado) => 504 INCERTO', async () => {
  let s = await cenario({ vazioInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 504);
    assert.equal(r.json.codigo, 'INCERTO');
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 200, corpo: { success: false, error: 'não deu' } } });
  try { assert.equal((await para(s)).status, 504); } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 200, corpo: { success: true, data: {} } } });
  try { assert.equal((await para(s)).status, 504); } finally { await s.fechar(); }
});

test('parar: runner fora do ar => 503 dizendo que nada foi enviado', async () => {
  const s = await cenario({});
  try {
    await s.runner.fechar();
    const r = await para(s);
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.match(r.json.erro, /Não consegui falar com o runner de Ana/);
    assert.match(r.json.erro, /O pedido de parar não foi enviado\. Tente de novo\./);
  } finally { await s.t.fechar(); }
});

test('parar: conexão derrubada DEPOIS do envio => 504 sem afirmar que não foi enviado', async () => {
  const s = await cenario({ derrubaInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 504);
    assert.match(r.json.erro, /Não sei se o pedido de parar chegou/);
    assert.match(r.json.erro, /Olhe a conversa antes de apertar de novo/);
    assert.doesNotMatch(r.json.erro, /não foi enviado/);
  } finally { await s.fechar(); }
});

test('parar: trava de 3 s do runner => 429 repassando espere_s', async () => {
  const s = await cenario({ falhaInterromper: { status: 429, corpo: { success: false, error: 'Esc há pouco', howToFix: 'esperar', code: 'MUITO_RAPIDO', espereS: 2.4 } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 429);
    assert.equal(r.json.espere_s, 2.4);
    assert.equal(r.json.codigo, 'MUITO_RAPIDO');
    assert.match(r.json.erro, /Espere 2\.4 s/);
  } finally { await s.fechar(); }
});

test('parar: sem terminal (NO_PTY) => 409; outro 409 => 409 com o motivo; erro do runner => 502', async () => {
  let s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'sem pty', code: 'NO_PTY' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'NO_PTY');
    assert.equal(r.json.erro, 'Ana não tem sessão aberta agora, então não há o que parar.');
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'respondendo pergunta', code: 'RESPOSTA_EM_ANDAMENTO' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /resposta de uma pergunta/);
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 500, corpo: { success: false, error: 'quebrou' } } });
  try { assert.equal((await para(s)).status, 502); } finally { await s.fechar(); }
});

test('parar: runner antigo (sem a rota) => 501 mandando atualizar pelo Admin', async () => {
  const s = await cenario({ semRotaInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 501);
    assert.equal(r.json.codigo, 'RUNNER_ANTIGO');
    assert.match(r.json.erro, /Atualize o agente pelo Admin/);
  } finally { await s.fechar(); }
});

test('parar: sem login => 401, sem Origin => 403, GET => 405, e nada chega ao runner', async () => {
  const s = await cenario({});
  try {
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/parar', { json: {} })).status, 401);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/parar', { json: {}, origin: false })).status, 403);
    assert.equal((await s.t.c.get('/api/v1/agents/ana/parar')).status, 405);
    assert.equal(s.runner.rec.interrupcoes, 0);
  } finally { await s.fechar(); }
});

test('parar: a doc abre para quem está logado e fala da trava de 3 s', async () => {
  const s = await cenario({});
  try {
    const r = await s.t.c.get('/api/v1/parar/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.texto, /3 s/);
  } finally { await s.fechar(); }
});

test('parar: colaborador recebe sempre 403 e o runner nunca é chamado, nem no turno dele', async () => {
  const s = await cenarioColab();
  try {
    const x = await colaboradorAtivo(s);
    const sem = await x.c.post('/api/v1/agents/ana/parar', { json: {} });
    assert.equal(sem.status, 403, sem.texto);
    assert.equal(sem.json.erro, 'Só o dono do DG Claw pode parar o agente.');
    assert.equal((await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'faz isso' } })).status, 200);
    assert.equal((await x.c.post('/api/v1/agents/ana/parar', { json: {} })).status, 403);
    assert.equal((await x.c.post('/api/v1/agents/ana/send', { json: { text: 'agora é comigo' } })).status, 200);
    assert.equal((await x.c.post('/api/v1/agents/ana/parar', { json: {} })).status, 403, 'nem no turno que ele mesmo começou');
    assert.equal((await x.c.post('/api/v1/agents/bob/parar', { json: {} })).status, 403);
    assert.equal(s.rAna.rec.interrupcoes, 0);
    assert.equal(s.rBob.rec.interrupcoes, 0);
    assert.match(s.t.log.texto(), /\[aviso\] Parar ana: colaborador:/);
    assert.equal((await s.dono.post('/api/v1/agents/ana/parar', { json: {} })).status, 200, 'o dono continua podendo');
  } finally { await s.fechar(); }
});

test('parar: runner esperando decisão (409 ESPERANDO_DECISAO) => 409 mandando responder no cartão', async () => {
  const s = await cenario({ falhaInterromper: { status: 409, corpo: { success: false, error: 'espera', code: 'ESPERANDO_DECISAO' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'ESPERANDO_DECISAO');
    assert.match(r.json.erro, /cartão da permissão ou da pergunta/);
  } finally { await s.fechar(); }
});

test('parar: resposta do runner maior que o limite => 504 (entrega incerta)', async () => {
  const s = await cenario({ grandeInterromper: true });
  try {
    const r = await para(s);
    assert.equal(r.status, 504);
    assert.equal(r.json.codigo, 'INCERTO');
    assert.match(r.json.erro, /Não sei se o pedido de parar chegou/);
  } finally { await s.fechar(); }
});

test('parar: 404 AGENTE_DE_OUTRO_RUNNER => 502 sem falar em versão antiga; 404 sem code => 501', async () => {
  let s = await cenario({ falhaInterromper: { status: 404, corpo: { success: false, error: 'não é deste runner', code: 'AGENTE_DE_OUTRO_RUNNER' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 502);
    assert.equal(r.json.codigo, 'AGENTE_DE_OUTRO_RUNNER');
    assert.match(r.json.erro, /reparar o agente/);
    assert.doesNotMatch(r.json.erro, /versão antiga/);
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 404, corpo: { success: false, code: 'ROTA_INEXISTENTE' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 501);
    assert.equal(r.json.codigo, 'RUNNER_ANTIGO');
  } finally { await s.fechar(); }
});

test('parar: log sem quebra de linha nem controle; statusAntes desconhecido vira ?', async () => {
  let s = await cenario({ statusAntesInterromper: 'working\nFALSO [info] linha forjada' });
  try {
    const r = await para(s);
    assert.equal(r.status, 200);
    const linha = s.t.log.linhas.find((l) => l.includes('Parar ana: Esc enviado'));
    assert.ok(linha, s.t.log.texto());
    assert.match(linha, /estado antes: \?\)/);
    assert.doesNotMatch(linha, /[\n\r]/);
    assert.doesNotMatch(linha, /2020-01-01/);
  } finally { await s.fechar(); }
  s = await cenario({ falhaInterromper: { status: 502, corpo: { success: false, error: 'ruim\n[erro] linha forjada\u0007' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 502);
    for (const l of s.t.log.linhas) assert.doesNotMatch(l, /^\[erro\] linha forjada/);
    const linha = s.t.log.linhas.find((l) => l.includes('Parar ana') && l.includes('recusado pelo runner'));
    assert.ok(linha, s.t.log.texto());
    assert.doesNotMatch(linha, /[\n\r\u0007]/);
  } finally { await s.fechar(); }
});

test('parar: a tela tira o botão do colaborador e o passo do tutorial só entra para o dono', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'conversa.js'), 'utf8');
  assert.match(js, /if \(COLAB\) for \(const id of \[[^\]]*'btnPararAgente'/);
  assert.match(js, /if \(!COLAB\) passos\.push\(\{ alvo: '#btnPararAgente'/);
});

test('parar: texto livre do runner (com credencial) não aparece no log nem na resposta; code estranho vira "código desconhecido"', async () => {
  const s = await cenario({ falhaInterromper: { status: 500, corpo: { success: false, error: 'Authorization: Bearer xyz-segredo', howToFix: 'use a chave xyz-segredo', code: 'bobagem com espaço' } } });
  try {
    const r = await para(s);
    assert.equal(r.status, 502);
    assert.doesNotMatch(r.texto, /xyz-segredo|Bearer/);
    assert.doesNotMatch(s.t.log.texto(), /xyz-segredo|Bearer/);
    assert.match(s.t.log.texto(), /código desconhecido/);
  } finally { await s.fechar(); }
  const s2 = await cenario({ falhaInterromper: { status: 429, corpo: { success: false, error: 'Bearer xyz-segredo', code: 'MUITO_RAPIDO', espereS: 9999 } } });
  try {
    const r = await para(s2);
    assert.equal(r.status, 429);
    assert.equal(r.json.espere_s, null, 'espereS fora de 0 a 10 é descartado');
    assert.doesNotMatch(r.texto, /xyz-segredo/);
  } finally { await s2.fechar(); }
});
