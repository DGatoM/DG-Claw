'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { criarLeitor } = require('../lib/thread');
const { criarMidia } = require('../lib/media');
const { mascarar, OCULTO } = require('../lib/mascara');
const { descreveUso } = require('../lib/trilha');
const TR = require('../public/trilha-tela');
const { subirWeb, pastaTemp, capturaLog, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

// Valores de mentira, montados em tempo de execução. Nenhum é credencial de verdade.
const FALSA_ANT = ['sk', 'ant', 'valor-falso-de-teste-1234567890'].join('-');
const FALSA_GH = 'ghp_' + 'a'.repeat(36);
const FALSA_BEARER = 'abcdefghijklmnopqrstuvwxyz' + '0123456789';

// ── mascaramento ────────────────────────────────────────────────────────────
test('mascara: chaves conhecidas, Bearer e atribuições com cara de segredo', () => {
  const casos = [
    [`curl -H "Authorization: Bearer ${FALSA_BEARER}"`, FALSA_BEARER],
    ['export MINHA_API_KEY=valor-super-reservado-123', 'valor-super-reservado-123'],
    ['{"password": "minha-senha-x"}', 'minha-senha-x'],
    ['bot 123456789:' + 'A'.repeat(35), 'A'.repeat(35)],
    [`valor ${FALSA_ANT}`, FALSA_ANT],
    [`token ${FALSA_GH}`, FALSA_GH],
  ];
  for (const [entrada, segredo] of casos) {
    const saida = mascarar(entrada);
    assert.ok(!saida.includes(segredo), `vazou em: ${saida}`);
    assert.ok(saida.includes(OCULTO));
  }
  assert.equal(mascarar('ls -la /tmp'), 'ls -la /tmp');
  assert.equal(mascarar(null), '');
});

test('descreveUso: Bash usa a description; Write/Edit resumem; leitura e dgchat ficam de fora; segredo é mascarado', () => {
  assert.equal(descreveUso('Bash', { command: 'npm test', description: 'Roda os testes' }).titulo, 'Roda os testes');
  assert.equal(descreveUso('Bash', { command: 'ls   -la\n/tmp' }).titulo, 'ls -la /tmp');
  assert.equal(descreveUso('Write', { file_path: '/a/b.json', content: 'xx' }).titulo, 'gravou /a/b.json');
  assert.match(descreveUso('Edit', { file_path: '/a/b', old_string: 'a', new_string: 'bcd' }).comando, /troca de 1 por 3/);
  assert.equal(descreveUso('Read', { file_path: '/a' }), null);
  assert.equal(descreveUso('mcp__dgchat__reply', { text: 'oi' }), null);
  assert.equal(descreveUso('Bash', { command: '   ' }), null);
  assert.ok(!descreveUso('Bash', { command: 'echo TOKEN=reservado-12345678' }).comando.includes('reservado-12345678'));
});

// ── extração do transcript ──────────────────────────────────────────────────
const linha = (o) => JSON.stringify(Object.assign({ isSidechain: false }, o));
const dono = (ts, msg, txt) => linha({ type: 'user', timestamp: ts, message: { role: 'user', content: `<dgchat from="pessoa" chat="c_ana" msg="${msg}" ts="${ts}">${txt}</dgchat>` } });
const uso = (ts, id, name, input) => linha({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultado = (ts, id, content, isError) => linha({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const resposta = (ts, txt) => uso(ts, 'r' + ts, 'mcp__dgchat__reply', { text: txt, chat: 'c_ana' });

function leitorDe() {
  const home = pastaTemp('home');
  const agente = { slug: 'ana', nome: 'Ana', chat_id: 'c_ana', home_host: home, home_container: '/home/agente' };
  const cap = capturaLog();
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro: { obter: () => agente } });
  return { agente, leitor: criarLeitor({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia }) };
}

test('trilha: comandos NÃO viram item no histórico (só dono e agente aparecem) e a pendência é resolvida pelo tool_result', () => {
  const { agente, leitor } = leitorDe();
  const arq = path.join(pastaTemp('tr'), 's.jsonl');
  fs.writeFileSync(arq, [
    dono('2026-10-16T10:00:00.000Z', 'm1', 'roda os testes'),
    uso('2026-10-16T10:00:01.000Z', 'tu1', 'Bash', { command: 'npm test', description: 'Roda os testes' }),
    uso('2026-10-16T10:00:02.000Z', 'tu2', 'Bash', { command: 'cat .env' }),
    resultado('2026-10-16T10:00:03.000Z', 'tu1', 'ok 1\nok 2\n' + Array.from({ length: 20 }, (_, i) => 'linha ' + i).join('\n')),
    resultado('2026-10-16T10:00:04.000Z', 'tu2', [{ type: 'text', text: 'MINHA_API_KEY=' + FALSA_ANT }], true),
    uso('2026-10-16T10:00:05.000Z', 'tu3', 'Read', { file_path: '/x' }),
    resposta('2026-10-16T10:00:06.000Z', 'Pronto'),
  ].join('\n') + '\n');
  const { eventos } = leitor.ler(arq, agente);
  assert.deepEqual(eventos.map((e) => e.origin), ['dono', 'agente']);
  assert.ok(!JSON.stringify(eventos).includes('rodou:'));
  assert.equal(leitor.pendente(arq, 'ana'), null); // os dois tool_result chegaram: nada pendente
});

test('trilha: tool_use Bash sem resultado não gera item, mas fica pendente (cartão de permissão) até o tool_result', () => {
  const { agente, leitor } = leitorDe();
  const arq = path.join(pastaTemp('tr'), 's.jsonl');
  fs.writeFileSync(arq, [
    dono('2026-10-16T10:00:00.000Z', 'm1', 'roda'),
    uso('2026-10-16T10:00:01.000Z', 'tu1', 'Bash', { command: 'npm test', description: 'Roda os testes' }),
  ].join('\n') + '\n');
  assert.deepEqual(leitor.ler(arq, agente).eventos.map((e) => e.origin), ['dono']);
  assert.equal(leitor.pendente(arq, 'ana').titulo, 'Roda os testes');
  assert.equal(leitor.pendente(arq, 'ana').id, 'tu1', 'o id do tool_use vai junto, para a tela mandá-lo na decisão');
  fs.appendFileSync(arq, resultado('2026-10-16T10:00:03.000Z', 'tu1', 'ok') + '\n');
  assert.deepEqual(leitor.ler(arq, agente).eventos.map((e) => e.origin), ['dono']);
  assert.equal(leitor.pendente(arq, 'ana'), null);
});

test('trilha: pendente aparece até o resultado chegar, e o resultado não cria item no histórico', () => {
  const { agente, leitor } = leitorDe();
  const arq = path.join(pastaTemp('tr'), 's.jsonl');
  fs.writeFileSync(arq, [
    dono('2026-10-16T10:00:00.000Z', 'm1', 'grava a config'),
    uso('2026-10-16T10:00:01.000Z', 'tu1', 'Write', { file_path: '/home/agente/config.json', content: '{}' }),
  ].join('\n') + '\n');
  const r = leitor.ler(arq, agente);
  assert.deepEqual(r.eventos.map((e) => e.origin), ['dono']);
  const pend = leitor.pendente(arq, 'ana');
  assert.equal(pend.ferramenta, 'Write');
  assert.equal(pend.titulo, 'gravou /home/agente/config.json');
  fs.appendFileSync(arq, [dono('2026-10-16T10:00:02.000Z', 'm2', 'e aí?'), resultado('2026-10-16T10:05:00.000Z', 'tu1', 'File created')].join('\n') + '\n');
  const depois = leitor.ler(arq, agente);
  assert.deepEqual(depois.eventos.map((e) => e.origin), ['dono', 'dono']);
  assert.equal(leitor.pendente(arq, 'ana'), null);
});

// ── parte pura da tela ──────────────────────────────────────────────────────
test('trilha-tela: agrupa só os comandos seguidos, rótulos e textos de fila e de pedido', () => {
  const t = (id, erro) => ({ id, origin: 'trilha', trilha: { titulo: 'x' + id, erro: !!erro } });
  const m = (id) => ({ id, origin: 'agente' });
  const g = TR.agrupa([m('a'), t('1'), t('2', true), m('b'), t('3')]);
  assert.deepEqual(g.map((x) => (x.trilha ? x.trilha.length : x.msg.id)), ['a', 2, 'b', 1]);
  assert.equal(TR.rotuloGrupo(g[1].trilha), 'rodou 2 comandos (1 com erro)');
  assert.equal(TR.rotuloGrupo(g[3].trilha), 'rodou: x3');
  assert.equal(TR.textoFila('permissao'), 'na fila: o agente está esperando a sua permissão');
  assert.equal(TR.textoFila('resposta'), 'na fila: o agente ainda está respondendo a anterior');
  assert.equal(TR.textoFila('resposta', true), 'na fila: o agente está esperando a sua permissão');
  assert.equal(TR.textoFila(null), '');
  assert.equal(TR.descricaoPedido({ ferramenta: 'Bash', titulo: 't', comando: 'rm x' }), 'Bash: rm x');
  assert.match(TR.descricaoPedido(null), /não informou/);
});

test('conversa: a página carrega o trilha-tela.js antes da tela, tem o cartão e o service worker o guarda', () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'conversa.html'), 'utf8');
  assert.ok(html.indexOf('/trilha-tela.js') > 0 && html.indexOf('/trilha-tela.js') < html.indexOf('/conversa.js'));
  assert.ok(html.includes('id="permCartao"'));
  assert.match(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), /trilha-tela\.js/);
});

// ── rotas ───────────────────────────────────────────────────────────────────
async function cenario(opRunner) {
  const runner = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opRunner));
  const porta = await runner.ouvir();
  const tr = pastaTemp('tr');
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: tr, home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor: { tickSseMs: 60 } });
  await t.login();
  return { t, runner, tr, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}
const pede = (s, decisao) => s.t.c.post('/api/v1/agents/ana/permissao', { json: { decisao } });

test('permissao: agente esperando => aprova e nega, repassando ao runner', async () => {
  const s = await cenario({ status: 'waiting_input' });
  try {
    let r = await pede(s, 'aprovar');
    assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.decisao, 'aprovar');
    r = await pede(s, 'negar');
    assert.equal(r.status, 200);
    assert.deepEqual(s.runner.rec.permissoes, ['aprovar', 'negar']);
  } finally { await s.fechar(); }
});

test('permissao: o id do pedido que a tela mostra é repassado ao runner; sem id segue como antes', async () => {
  const s = await cenario({ status: 'waiting_input', motivo: 'permissao' });
  try {
    let r = await s.t.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 'toolu_X' } });
    assert.equal(r.status, 200, r.texto);
    r = await pede(s, 'negar');
    assert.equal(r.status, 200);
    assert.deepEqual(s.runner.rec.permissaoIds, ['toolu_X', null]);
    r = await s.t.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar', tool_use_id: 42 } });
    assert.equal(r.status, 400);
    assert.equal(s.runner.rec.permissoes.length, 2);
  } finally { await s.fechar(); }
});

test('permissao: com pergunta de escolha aberta => 409 sem chamar o runner', async () => {
  const s = await cenario({ status: 'waiting_input', motivo: 'pergunta' });
  try {
    const r = await pede(s, 'aprovar');
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /pergunta de escolha, não uma permissão/);
    assert.match(r.json.erro, /cartão da pergunta/);
    assert.equal(s.runner.rec.permissoes.length, 0);
  } finally { await s.fechar(); }
});

test('permissao: agente que não espera => 409 com motivo, e nada vai ao runner', async () => {
  const s = await cenario({ status: 'working' });
  try {
    const r = await pede(s, 'aprovar');
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /não está esperando permissão/);
    assert.equal(s.runner.rec.permissoes.length, 0);
  } finally { await s.fechar(); }
});

test('permissao: decisão inválida, sem Origin e sem sessão', async () => {
  const s = await cenario({ status: 'waiting_input' });
  try {
    assert.equal((await pede(s, 'talvez')).status, 400);
    assert.equal((await s.t.c.post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar' }, origin: false })).status, 403);
    assert.equal((await cliente(s.t.porta).post('/api/v1/agents/ana/permissao', { json: { decisao: 'aprovar' } })).status, 401);
    assert.equal(s.runner.rec.permissoes.length, 0);
  } finally { await s.fechar(); }
});

test('permissao: runner antigo (sem a rota) => 501 dizendo isso; runner recusando => 502 com o motivo', async () => {
  let s = await cenario({ status: 'waiting_input', semRotaPermissao: true });
  try {
    const r = await pede(s, 'aprovar');
    assert.equal(r.status, 501);
    assert.match(r.json.erro, /versão antiga e não tem a rota de permissão/);
  } finally { await s.fechar(); }
  s = await cenario({ status: 'waiting_input', falhaPermissao: { status: 500, corpo: { success: false, error: 'o terminal sumiu', howToFix: 'reinicie o agente' } } });
  try {
    const r = await pede(s, 'negar');
    assert.equal(r.status, 502);
    assert.match(r.json.erro, /o terminal sumiu reinicie o agente/);
  } finally { await s.fechar(); }
});

test('permissao: runner fora do ar => 503 com o que fazer', async () => {
  const s = await cenario({ status: 'waiting_input' });
  try {
    await s.runner.fechar();
    const r = await pede(s, 'aprovar');
    assert.equal(r.status, 503);
    assert.match(r.json.erro, /Nada foi enviado/);
  } finally { await s.t.fechar(); }
});

test('fila: /send com o agente ocupado ou esperando permissão avisa o motivo; ocioso não avisa', async () => {
  for (const [status, motivo] of [['working', 'resposta'], ['waiting_input', 'permissao'], ['idle', null]]) {
    const s = await cenario({ status });
    try {
      const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi ' + status } });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.fila ? r.json.fila.motivo : null, motivo, status);
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

test('atividade: esperando permissão traz o comando pendente do transcript', async () => {
  const s = await cenario({ status: 'waiting_input' });
  try {
    fs.writeFileSync(path.join(s.tr, 'sess-0001-aaaa.jsonl'), [
      dono('2026-10-16T10:00:00.000Z', 'm1', 'muda a config'),
      uso('2026-10-16T10:00:01.000Z', 'tu1', 'Bash', { command: "echo '{}' > /home/agente/config.json", description: 'Grava a config' }),
    ].join('\n') + '\n');
    const cookie = Object.entries(s.t.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const a = await lerAtividade(s.t.porta, cookie);
    assert.equal(a.alerta, 'permissao');
    assert.equal(a.acao, 'esperando permissão');
    assert.equal(a.permissao.ferramenta, 'Bash');
    assert.equal(a.permissao.id, 'tu1');
    assert.match(a.permissao.comando, /config\.json/);
    assert.equal(a.detalhe, 'Bash: Grava a config');
  } finally { await s.fechar(); }
});
