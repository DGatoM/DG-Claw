'use strict';
// A conversa de um agente em Codex: o rollout vira as mesmas mensagens do transcript do Claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarLeitorRollout, acharRollout, ehRollout } = require('../lib/rollout');
const { criarMidia } = require('../lib/media');
const { subirWeb, pastaTemp, capturaLog } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const FIXTURE = path.join(__dirname, 'fixtures', 'rollout-codex-ana.jsonl');
const SID = '0194aaaa-1111-7222-8333-444455556666';

function preparar() {
  const home = pastaTemp('home');
  fs.mkdirSync(path.join(home, 'out'), { recursive: true });
  fs.writeFileSync(path.join(home, 'out', 'relatorio.pdf'), 'pdf');
  const agente = { slug: 'ana', nome: 'Ana', chat_id: 'c_ana', home_host: home, home_container: '/home/agente' };
  const cap = capturaLog();
  const registro = { obter: (s) => (s === 'ana' ? agente : null) };
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro });
  const leitor = criarLeitorRollout({ log: cap.log, tz: 'America/Sao_Paulo', midia });
  return { agente, leitor, home };
}

/** Grava um rollout temporário a partir de linhas do fixture (por índice) e de linhas extras. */
function gravar(linhas) {
  const f = path.join(pastaTemp('rol'), `rollout-2026-10-12T15-00-00-${SID}.jsonl`);
  fs.writeFileSync(f, linhas.join('\n') + '\n');
  return f;
}
const fixtureLinhas = () => fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
const msg = (role, text, ts, phase) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: Object.assign({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }, phase ? { phase } : {}) });
const dg = (m, t, ts) => msg('user', `<dgchat from="Marta" chat="c_ana" msg="${m}" ts="${ts}">${t}</dgchat>`, ts);

test('rollout: o que entra e o que some (duplicata por turno)', () => {
  const { agente, leitor } = preparar();
  const { eventos } = leitor.ler(FIXTURE, agente);
  assert.deepEqual(eventos.map((e) => e.text), [
    'Oi, tudo bem?',                // dono
    'Tudo certo!',                  // reply + texto final igual: uma vez só
    'Qual o resumo?',
    'Resumo pronto: tudo em dia.',  // turno sem reply: vale o texto final, nunca o commentary
    'Manda o relatório',
    'Segue o relatório',            // send_file (a legenda), e o "Enviei o arquivo." some
    'Aviso por conta própria',      // reply de turno de rotina
    'Teste de outra tool',
    'Texto final do turno quatro.', // a tool de outro servidor não conta como reply
  ]);
  const textos = eventos.map((e) => e.text).join('|');
  for (const sumiu of ['AGENTS', 'environment_context', 'Persona', 'hora do resumo', 'Rotina concluida', 'outro chat', 'Vou olhar', 'Enviei o arquivo']) {
    assert.ok(!textos.includes(sumiu), `não podia aparecer: ${sumiu}`);
  }
});

test('rollout: mesmo formato do Claude (id sha1, ep da linha, hhmm, dia, origem, via)', () => {
  const { agente, leitor } = preparar();
  const { eventos } = leitor.ler(FIXTURE, agente);
  const por = (t) => eventos.find((e) => e.text === t);
  const e = por('Oi, tudo bem?');
  assert.match(e.id, /^[0-9a-f]{16}$/);
  assert.equal(e.ep, Date.parse('2026-10-12T15:00:05.100Z') / 1000);
  assert.equal(e.hhmm, '12:00');
  assert.match(e.dia, /^\d\d\/\d\d\/\d{4}$/);
  assert.deepEqual([e.origin, e.via, e.kind, e.fmt, e.editada, e.reacoes, e.cita, e.media, e.quem], ['dono', 'plataforma', 'text', 'text', false, [], null, null, 'Marta']);
  assert.equal(por('Tudo certo!').origin, 'agente');
  assert.equal(por('Resumo pronto: tudo em dia.').origin, 'agente');
  assert.equal(por('Aviso por conta própria').origin, 'rotina');
  const ids = new Set(eventos.map((x) => x.id));
  assert.equal(ids.size, eventos.length, 'ids únicos');
  const segunda = leitor.ler(FIXTURE, agente).eventos.map((x) => x.id);
  assert.deepEqual(segunda, eventos.map((x) => x.id), 'ids estáveis entre leituras');
});

test('rollout: send_file vira mídia com o caminho de dentro traduzido para o host', () => {
  const { agente, leitor, home } = preparar();
  const pdf = leitor.ler(FIXTURE, agente).eventos.find((e) => e.text === 'Segue o relatório');
  assert.equal(pdf.kind, 'document');
  assert.equal(pdf.media.nome, 'relatorio.pdf');
  assert.equal(pdf.media.path, '/home/agente/out/relatorio.pdf');
  assert.equal(pdf.media.bytes, 3);
  assert.ok(fs.existsSync(path.join(home, 'out', 'relatorio.pdf')));
});

test('rollout: linha truncada no fim é ignorada sem erro e a leitura continua depois', () => {
  const { agente, leitor } = preparar();
  const base = fixtureLinhas();
  const f = gravar(base);
  const inteira = dg('m7', 'Mensagem completa', '2026-10-12T16:00:00.000Z');
  fs.appendFileSync(f, inteira.slice(0, 60)); // o CLI está no meio da escrita
  const antes = leitor.ler(f, agente);
  assert.ok(!antes.eventos.some((e) => e.text === 'Mensagem completa'));
  assert.equal(antes.eventos.length, 9);
  fs.appendFileSync(f, inteira.slice(60) + '\n');
  const depois = leitor.ler(f, agente);
  assert.equal(depois.eventos[depois.eventos.length - 1].text, 'Mensagem completa');
  assert.equal(depois.eventos.length, 10);
  assert.equal(depois.versao, antes.versao + 1);
});

test('rollout: texto final do turno em andamento fica escondido até o sinal de fim', () => {
  const { agente, leitor } = preparar();
  const f = gravar([
    JSON.stringify({ timestamp: '2026-10-12T15:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    dg('m1', 'Pergunta ainda sem resposta', '2026-10-12T15:00:05.000Z'),
    msg('assistant', 'rascunho que ainda vai mudar', '2026-10-12T15:00:06.000Z', 'commentary'),
    msg('assistant', 'Resposta quase pronta', '2026-10-12T15:00:07.000Z', 'final_answer'),
  ]);
  assert.deepEqual(leitor.ler(f, agente).eventos.map((e) => e.text), ['Pergunta ainda sem resposta']);
  fs.appendFileSync(f, JSON.stringify({ timestamp: '2026-10-12T15:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  assert.deepEqual(leitor.ler(f, agente).eventos.map((e) => e.text), ['Pergunta ainda sem resposta', 'Resposta quase pronta']);
  // um turno novo do dono também fecha o anterior, mesmo sem sinal
  const g = gravar([
    dg('m1', 'Primeira', '2026-10-12T15:00:05.000Z'),
    msg('assistant', 'Resposta um', '2026-10-12T15:00:06.000Z', 'final_answer'),
    dg('m2', 'Segunda', '2026-10-12T15:01:05.000Z'),
  ]);
  assert.deepEqual(leitor.ler(g, agente).eventos.map((e) => e.text), ['Primeira', 'Resposta um', 'Segunda']);
});

test('rollout sem nenhum sinal de fim de turno: mostra a última fala do assistente mesmo assim', () => {
  const { agente, leitor } = preparar();
  const f = gravar([
    dg('m1', 'Oi', '2026-10-12T15:00:05.000Z'),
    msg('assistant', 'Olá!', '2026-10-12T15:00:06.000Z'),
  ]);
  assert.deepEqual(leitor.ler(f, agente).eventos.map((e) => e.text), ['Oi', 'Olá!']);
});

test('rollout: chamada com status de falha não vira mensagem, e o texto final aparece no lugar', () => {
  const { agente, leitor } = preparar();
  const falha = JSON.stringify({ timestamp: '2026-10-12T15:00:06.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'dgchat', tool: 'reply', arguments: { chat: 'c_ana', text: 'não saiu' }, status: 'failed' } } });
  const f = gravar([dg('m1', 'Oi', '2026-10-12T15:00:05.000Z'), falha, msg('assistant', 'Falei por texto', '2026-10-12T15:00:07.000Z', 'final_answer'), JSON.stringify({ timestamp: '2026-10-12T15:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete' } })]);
  const textos = leitor.ler(f, agente).eventos.map((e) => e.text);
  assert.ok(!textos.includes('não saiu'));
  // a entrega falhou, então o turno segue "sem reply" e o texto final aparece
  assert.deepEqual(textos, ['Oi', 'Falei por texto']);
});

test('achar rollout: com codexHome traduz para o host e procura só ali', () => {
  const { agente, home } = preparar();
  const dir = path.join(home, '.plataforma', 'codex-api', 'ana', 'sessions', '2026', '10', '12');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `rollout-2026-10-12T15-00-00-${SID}.jsonl`);
  fs.writeFileSync(arq, '{}\n');
  const r = acharRollout(agente, SID, '/home/agente/.plataforma/codex-api/ana');
  assert.equal(r.arquivo, arq);
  assert.ok(ehRollout(arq));
  assert.ok(!ehRollout('/x/sess-ana-00001.jsonl'));
});

test('achar rollout: codexHome fora da casa do agente é recusado, e ../ também', () => {
  const { agente, home } = preparar();
  for (const ruim of ['/etc', '/home/agente/../../etc', '/home/agente/../outro/.codex']) {
    const r = acharRollout(agente, SID, ruim);
    assert.equal(r.arquivo, null, ruim);
    assert.match(r.erro, /fora da casa do agente/, ruim);
  }
  // um caminho que já é do host e está dentro também passa
  const dentro = path.join(home, '.codex');
  fs.mkdirSync(path.join(dentro, 'sessions', '2026', '10', '12'), { recursive: true });
  const arq = path.join(dentro, 'sessions', '2026', '10', '12', `rollout-x-${SID}.jsonl`);
  fs.writeFileSync(arq, '{}\n');
  assert.equal(acharRollout(agente, SID, dentro).arquivo, arq);
  // sem home_host não há como traduzir
  assert.match(acharRollout({ nome: 'Ana', slug: 'ana' }, SID, '/home/agente/.codex').erro, /home_host/);
});

test('achar rollout: sem codexHome tenta codex-api/*/sessions e depois .codex/sessions; lista o que procurou', () => {
  const { agente, home } = preparar();
  const vazio = acharRollout(agente, SID, null);
  assert.equal(vazio.arquivo, null);
  assert.deepEqual(vazio.procurados, [path.join(home, '.codex', 'sessions')]);
  const pasta = path.join(home, '.codex', 'sessions', '2026', '10', '12');
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, `rollout-2026-10-12T15-00-00-${SID}.jsonl`);
  fs.writeFileSync(arq, '{}\n');
  assert.equal(acharRollout(agente, SID, null).arquivo, arq, 'assinatura: .codex');
  // o modo api vem primeiro
  const api = path.join(home, '.plataforma', 'codex-api', 'ana', 'sessions', '2026', '10', '12');
  fs.mkdirSync(api, { recursive: true });
  const arqApi = path.join(api, `rollout-2026-10-12T15-00-00-${SID}.jsonl`);
  fs.writeFileSync(arqApi, '{}\n');
  assert.equal(acharRollout(agente, SID, null).arquivo, arqApi, 'api antes da assinatura');
  assert.equal(acharRollout(agente, 'não é um id!', null).arquivo, null);
});

// ── rota ────────────────────────────────────────────────────────────────────

async function cenarioCodex({ codexHome, copiarPara }) {
  const runner = criarRunnerFalso({ agenteId: 'cx1', sessionId: SID, provedor: { sessao: 's', provedor: 'codex', auth: 'api', rotulo: 'Codex, na API' }, codexHome });
  const porta = await runner.ouvir();
  const home = pastaTemp('home-cx');
  const dir = path.join(home, copiarPara, 'sessions', '2026', '10', '12');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, `rollout-2026-10-12T15-00-00-${SID}.jsonl`));
  fs.mkdirSync(path.join(home, 'out'), { recursive: true });
  fs.writeFileSync(path.join(home, 'out', 'relatorio.pdf'), 'pdf');
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'cx1', chat_id: 'c_ana', provedor: 'codex', modelo: 'gpt', transcripts_dir: path.join(pastaTemp('vazio'), 'projects'), home_host: home, home_container: '/home/agente' }];
  const t = await subirWeb({ agentes });
  await t.login();
  return { t, runner, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}

test('rota messages: agente em Codex com codexHome vindo do runner', async () => {
  const s = await cenarioCodex({ codexHome: '/home/agente/.plataforma/codex-api/ana', copiarPara: '.plataforma/codex-api/ana' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/messages');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.avisos, []);
    assert.deepEqual(r.json.msgs.map((m) => m.text).slice(0, 4), ['Oi, tudo bem?', 'Tudo certo!', 'Qual o resumo?', 'Resumo pronto: tudo em dia.']);
    assert.equal(r.json.msgs.length, 9);
    // paginação igual à do Claude
    const pag = await s.t.c.get('/api/v1/agents/ana/messages?limit=3');
    assert.equal(pag.json.msgs.length, 3); assert.equal(pag.json.mais_antigas, true);
    const antes = await s.t.c.get(`/api/v1/agents/ana/messages?before=${pag.json.msgs[0].ep}&limit=2`);
    assert.deepEqual(antes.json.msgs.map((m) => m.id), r.json.msgs.slice(4, 6).map((m) => m.id));
    const depois = await s.t.c.get(`/api/v1/agents/ana/messages?after=${r.json.msgs[6].ep}`);
    assert.deepEqual(depois.json.msgs.map((m) => m.text), ['Teste de outra tool', 'Texto final do turno quatro.']);
    // wait devolve na hora o que o agente já disse depois do "since"
    const w = await s.t.c.get(`/api/v1/agents/ana/wait?since=${Date.parse('2026-10-12T15:00:00Z') / 1000}&timeout=2`);
    assert.equal(w.json.timeout, false);
    assert.equal(w.json.msgs[0].text, 'Oi, tudo bem?');
  } finally { await s.fechar(); }
});

test('rota messages: Codex sem codexHome acha em .codex/sessions pelo id da sessão', async () => {
  const s = await cenarioCodex({ codexHome: undefined, copiarPara: '.codex' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/messages');
    assert.equal(r.status, 200);
    assert.equal(r.json.msgs.length, 9);
    assert.deepEqual(r.json.avisos, []);
  } finally { await s.fechar(); }
});

test('rota messages: codexHome fora da casa vira aviso com o motivo, sem ler nada', async () => {
  const s = await cenarioCodex({ codexHome: '/etc', copiarPara: '.codex' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/messages');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.msgs, []);
    assert.match(r.json.avisos[0], /fora da casa do agente/);
    assert.match(s.t.log.texto(), /fora da casa do agente/);
  } finally { await s.fechar(); }
});

test('rota messages: Codex sem rollout em lugar nenhum avisa onde procurou', async () => {
  const s = await cenarioCodex({ codexHome: '/home/agente/.plataforma/codex-api/ana', copiarPara: 'lixo' });
  try {
    const r = await s.t.c.get('/api/v1/agents/ana/messages');
    assert.deepEqual(r.json.msgs, []);
    assert.match(r.json.avisos[0], /Não achei o registro Codex da sessão .* Procurei em .*codex-api.*sessions/);
  } finally { await s.fechar(); }
});

// ── atalhos (symlink) não furam a casa do agente ─────────────────────────────
function casaComRollout(base) {
  const home = pastaTemp('casa');
  const dir = path.join(base(home), 'sessions', '2026', '10', '12');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

test('realpath: rollout-*.jsonl que é atalho para arquivo de fora é recusado, nada lido', () => {
  const { home, dir } = casaComRollout((h) => path.join(h, '.codex'));
  const fora = path.join(pastaTemp('fora'), 'segredo.jsonl');
  fs.writeFileSync(fora, 'x\n');
  fs.symlinkSync(fora, path.join(dir, `rollout-2026-10-12T15-00-00-${SID}.jsonl`));
  const agente = { slug: 'ana', nome: 'Ana', home_host: home, home_container: '/home/agente' };
  const r = acharRollout(agente, SID, null);
  assert.equal(r.arquivo, null);
  assert.match(r.erro, /Recusei/);
  assert.match(r.erro, /fora de/);
  assert.match(r.erro, /Nada foi lido/);
});

test('realpath: .codex/sessions como atalho para pasta de fora é recusado', () => {
  const home = pastaTemp('casa');
  const fora = pastaTemp('fora');
  const dir = path.join(fora, '2026', '10', '12');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-10-12T15-00-00-${SID}.jsonl`), 'x\n');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.symlinkSync(fora, path.join(home, '.codex', 'sessions'));
  const agente = { slug: 'ana', nome: 'Ana', home_host: home, home_container: '/home/agente' };
  const r = acharRollout(agente, SID, null);
  assert.equal(r.arquivo, null);
  assert.match(r.erro, /pasta de sessões/);
  assert.match(r.erro, /Nada foi lido/);
});

test('realpath: codexHome do runner que é atalho para fora é recusado', () => {
  const home = pastaTemp('casa');
  const fora = pastaTemp('fora');
  fs.mkdirSync(path.join(home, 'x'), { recursive: true });
  fs.symlinkSync(fora, path.join(home, 'x', 'codex'));
  const agente = { slug: 'ana', nome: 'Ana', home_host: home, home_container: '/home/agente' };
  const r = acharRollout(agente, SID, '/home/agente/x/codex');
  assert.equal(r.arquivo, null);
  assert.match(r.erro, /Recusei/);
});

test('realpath: atalho DENTRO da casa é aceito', () => {
  const home = pastaTemp('casa');
  const real = path.join(home, 'guardado', 'sessions', '2026', '10', '12');
  fs.mkdirSync(real, { recursive: true });
  const arq = path.join(real, `rollout-2026-10-12T15-00-00-${SID}.jsonl`);
  fs.writeFileSync(arq, 'x\n');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.symlinkSync(path.join(home, 'guardado', 'sessions'), path.join(home, '.codex', 'sessions'));
  const agente = { slug: 'ana', nome: 'Ana', home_host: home, home_container: '/home/agente' };
  const r = acharRollout(agente, SID, null);
  assert.equal(r.erro, undefined);
  assert.equal(r.arquivo, fs.realpathSync(arq));
});

const FIXTURE_WA = path.join(__dirname, 'fixtures', 'rollout-codex-whatsapp.jsonl');

test('rollout: WhatsApp, entrada, tools de envio, sem duplicata e falha de entrega', () => {
  const { agente, leitor, home } = preparar();
  fs.mkdirSync(path.join(home, 'uploads', 'whatsapp', '2026-10-17'), { recursive: true });
  fs.writeFileSync(path.join(home, 'uploads', 'whatsapp', '2026-10-17', 'ABC.jpg'), 'jpg');
  const { eventos } = leitor.ler(FIXTURE_WA, agente);
  assert.deepEqual(eventos.map((e) => [e.via, e.origin, e.text]), [
    ['whatsapp', 'dono', 'Veja <dgchat from="x"> & isso'],
    ['whatsapp', 'agente', 'Recebi a foto, já olho.'],   // tool + texto final igual: uma vez só
    ['whatsapp', 'dono', 'manda o PDF'],
    ['whatsapp', 'agente', 'Segue o PDF'],               // "Enviei." some
    ['whatsapp', 'dono', 'e agora?'],                     // reply com status failed não aparece como fala via whatsapp
    ['plataforma', 'agente', 'Só texto final sem entrega.'], // sem chamada que deu certo, vale o texto final (regra existente)
    ['whatsapp', 'dono', 'sem tool'],
    ['plataforma', 'agente', 'Texto final do turno sem tool de envio.'], // turno aberto por canal-externo é do dono
    ['plataforma', 'dono', 'Oi pelo painel'],
    ['plataforma', 'agente', 'Resposta no painel'],
  ]);
});
