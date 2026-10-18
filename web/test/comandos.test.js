'use strict';
// Comandos de barra: reconhecimento, leitura de skills, a thread (eco e resultado do comando) e as rotas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarComandos, lerSkillsDoDisco } = require('../lib/comandos');
const { criarConversa } = require('../lib/conversa');
const { criarLeitor } = require('../lib/thread');
const { criarRunner } = require('../lib/runner');
const { criarMidia } = require('../lib/media');
const { criarRunnerFalso } = require('./runner-falso');
const { subirWeb, pastaTemp, capturaLog } = require('./ajuda');

const escreveSkill = (dir, pasta, cab, corpo) => {
  fs.mkdirSync(path.join(dir, pasta), { recursive: true });
  fs.writeFileSync(path.join(dir, pasta, 'SKILL.md'), `${cab}\n${corpo || 'Corpo da skill.\n'}`);
};
const cabecalho = (nome, desc) => `---\nname: ${nome}\ndescription: ${desc}\n---\n`;

/** Um agente com a casa numa pasta temporária que tem skills. `provedor` vai no registro; o runner falso não responde /api/provedor. */
function montaAgente(provedor) {
  const home = pastaTemp('home-cmd');
  const skills = path.join(home, '.claude', 'skills');
  escreveSkill(skills, 'agenda', cabecalho('agenda', 'Agenda lembretes e rotinas'));
  const agente = { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:9', agente_id: 'ana1', chat_id: 'c_ana', provedor, home_host: home, home_container: '/home/agente' };
  return { agente, home, skills };
}
const runnerSemRota = { provedor: async () => ({ ok: false, erro: 'sem rota no teste' }) };
const comandosDe = () => criarComandos({ runner: runnerSemRota, log: () => {} });

test('reconhece: /compact e /model com argumento vão crus; /model sem argumento pede o nome (400)', async () => {
  const { agente } = montaAgente('claude');
  const c = comandosDe();
  const d = await c.decidir(agente, '/compact');
  assert.equal(d.tipo, 'comando'); assert.equal(d.entregue_como, 'cru'); assert.equal(d.textoParaRunner, '/compact');
  assert.deepEqual(d.comando, { nome: '/compact', tipo: 'nativo', espera_resposta: false });
  const com = await c.decidir(agente, '  /compact foque nas decisões de hoje ');
  assert.equal(com.textoParaRunner, '/compact foque nas decisões de hoje');
  assert.equal((await c.decidir(agente, '/model sonnet')).textoParaRunner, '/model sonnet');
  const sem = await c.decidir(agente, '/model');
  assert.equal(sem.erro.status, 400); assert.equal(sem.erro.codigo, 'COMANDO_PEDE_ARGUMENTO');
  assert.equal(sem.erro.exemplo, '/model sonnet'); assert.match(sem.erro.erro, /\/model sonnet/);
});

test('reconhece: caminho, "//texto" e mensagem com anexo seguem como texto', async () => {
  const { agente } = montaAgente('claude');
  const c = comandosDe();
  assert.deepEqual(await c.decidir(agente, '/root/x.txt'), { tipo: 'texto' });
  assert.deepEqual(await c.decidir(agente, 'oi /compact'), { tipo: 'texto' });
  assert.deepEqual(await c.decidir(agente, '//compact agora'), { tipo: 'texto', texto: '/compact agora' });
  assert.deepEqual(await c.decidir(agente, '/compact', { temAnexos: true }), { tipo: 'texto' });
});

test('reconhece: comando inexistente dá 404 com sugestões (até 5) e lembra do //', async () => {
  const { agente } = montaAgente('claude');
  const d = await comandosDe().decidir(agente, '/compat');
  assert.equal(d.erro.status, 404); assert.equal(d.erro.codigo, 'COMANDO_INEXISTENTE');
  assert.ok(d.erro.sugestoes.includes('/compact'));
  assert.ok(d.erro.sugestoes.length <= 5);
  assert.match(d.erro.erro, /\/\/compat/);
  const longe = await comandosDe().decidir(agente, '/zzzzzzzz');
  assert.deepEqual(longe.erro.sugestoes, []);
});

test('reconhece: /config não roda (422 com motivo), /login é da tela (422)', async () => {
  const { agente } = montaAgente('claude');
  const c = comandosDe();
  const cfg = await c.decidir(agente, '/config');
  assert.equal(cfg.erro.status, 422); assert.equal(cfg.erro.codigo, 'COMANDO_NAO_RODA');
  assert.match(cfg.erro.motivo, /^Abre uma tela de configuração no terminal\./);
  const lg = await c.decidir(agente, '/login');
  assert.equal(lg.erro.status, 422); assert.equal(lg.erro.codigo, 'COMANDO_DA_TELA');
  assert.match(lg.erro.erro, /login\/docs\.md/);
});

test('reconhece: no Codex /clear vira /new, /model não roda e o catálogo é o do Codex', async () => {
  const { agente } = montaAgente('codex');
  const c = comandosDe();
  const d = await c.decidir(agente, '/clear');
  assert.equal(d.entregue_como, 'cru'); assert.equal(d.textoParaRunner, '/new');
  assert.equal(d.comando.executado_como, '/new');
  assert.equal((await c.decidir(agente, '/model gpt')).erro.codigo, 'COMANDO_NAO_RODA');
  assert.equal((await c.decidir(agente, '/context')).erro.codigo, 'COMANDO_INEXISTENTE');
  const cat = await c.catalogo(agente);
  assert.equal(cat.provedor, 'codex');
});

test('reconhece: skill vai crua no Claude e dentro do envelope no Codex', async () => {
  const cl = montaAgente('claude');
  const d = await comandosDe().decidir(cl.agente, '/agenda me lembra amanhã às 9h');
  assert.equal(d.entregue_como, 'cru'); assert.equal(d.textoParaRunner, '/agenda me lembra amanhã às 9h');
  assert.deepEqual(d.comando, { nome: '/agenda', tipo: 'skill', espera_resposta: true });
  const cx = montaAgente('codex');
  const e = await comandosDe().decidir(cx.agente, '/agenda me lembra amanhã às 9h');
  assert.equal(e.entregue_como, 'envelope');
  assert.equal(e.textoParaRunner, 'Rode a skill "agenda" (arquivo .claude/skills/agenda/SKILL.md): leia o SKILL.md e siga o roteiro com estes argumentos: me lembra amanhã às 9h');
});

test('catálogo: sem runner e sem provedor no registro assume Claude e avisa', async () => {
  const { agente } = montaAgente('');
  const cat = await comandosDe().catalogo(agente);
  assert.equal(cat.provedor, 'claude');
  assert.ok(cat.avisos.some((a) => /Assumi o Claude Code/.test(a)));
  const comReg = await comandosDe().catalogo(montaAgente('codex').agente);
  assert.ok(comReg.avisos.some((a) => /registro do agente/.test(a)));
});

test('catálogo: o provedor do runner ganha do registro', async () => {
  const { agente } = montaAgente('claude');
  const c = criarComandos({ runner: { provedor: async () => ({ ok: true, dados: { provedor: 'codex' } }) }, log: () => {} });
  const cat = await c.catalogo(agente);
  assert.equal(cat.provedor, 'codex'); assert.deepEqual(cat.avisos, []);
});

test('skills: atalho para /opt/dgclaw/app é traduzido; atalho quebrado e cabeçalho ausente viram aviso', () => {
  const { agente, home, skills } = montaAgente('claude');
  const raiz = pastaTemp('repo');
  escreveSkill(path.join(raiz, 'skills'), 'x', cabecalho('x', 'Skill de fábrica '.repeat(20)));
  fs.symlinkSync('/opt/dgclaw/app/skills/x', path.join(skills, 'x'));
  fs.symlinkSync('/opt/dgclaw/app/skills/sumiu', path.join(skills, 'sumiu'));
  fs.symlinkSync('/home/agente/coisas/y', path.join(skills, 'y'));
  escreveSkill(path.join(home, 'coisas'), 'y', cabecalho('y', 'Skill na casa do agente'));
  escreveSkill(skills, 'semcab', 'sem cabeçalho nenhum');
  const r = lerSkillsDoDisco(agente, raiz);
  const nomes = r.skills.map((s) => s.nome).sort();
  assert.deepEqual(nomes, ['agenda', 'x', 'y']);
  assert.ok(r.skills.find((s) => s.nome === 'x').descricao.length <= 160);
  assert.ok(r.skills.find((s) => s.nome === 'x').descricao.endsWith('…'));
  assert.equal(r.avisos.length, 2);
  assert.ok(r.avisos.some((a) => /"sumiu"/.test(a) && /não existe/.test(a)));
  assert.ok(r.avisos.some((a) => /"semcab"/.test(a) && /cabeçalho/.test(a)));
  assert.deepEqual(r.pastas, [{ caminho: skills, existe: true }]);
});

test('skills: pasta ausente não é erro; skill com nome de nativo perde e vira aviso', async () => {
  const vazio = { slug: 'v', nome: 'V', home_host: pastaTemp('vazia'), home_container: '/home/agente', provedor: 'claude' };
  const r = lerSkillsDoDisco(vazio, pastaTemp('repo'));
  assert.deepEqual(r.skills, []); assert.deepEqual(r.avisos, []); assert.equal(r.pastas[0].existe, false);
  const { agente, skills } = montaAgente('claude');
  escreveSkill(skills, 'compact', cabecalho('compact', 'Tentando roubar o nome'));
  const cat = await comandosDe().catalogo(agente);
  const compact = cat.comandos.filter((c) => c.nome === '/compact');
  assert.equal(compact.length, 1); assert.equal(compact[0].tipo, 'nativo');
  assert.ok(cat.avisos.some((a) => /"compact"/.test(a) && /nativo/.test(a)));
});

// ── thread ─────────────────────────────────────────────────────────────────

const ts = (s) => new Date(Date.UTC(2026, 9, 12, 15, 0, 0) + s * 1000).toISOString();
const linhaUser = (s, content) => JSON.stringify({ type: 'user', timestamp: ts(s), message: { role: 'user', content } }) + '\n';

async function threadDe(linhas) {
  const raiz = pastaTemp('thr');
  const transcripts = path.join(raiz, 'projects');
  fs.mkdirSync(transcripts, { recursive: true });
  const rf = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-cmd-0001' });
  const porta = await rf.ouvir();
  fs.writeFileSync(path.join(transcripts, 'sess-cmd-0001.jsonl'), linhas.join(''));
  const agente = { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', transcripts_dir: transcripts, home_host: pastaTemp('home'), home_container: '/home/agente' };
  const cap = capturaLog();
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro: { obter: () => agente } });
  const leitor = criarLeitor({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia });
  const conversa = criarConversa({ config: {}, runner: criarRunner({ log: cap.log }), leitor, midia, log: cap.log });
  try { return await conversa.thread(agente); } finally { await rf.fechar(); }
}

test('thread: o eco do comando vira fala do dono, o stdout vira "comando" sem ANSI e o caveat some', async () => {
  const t = await threadDe([
    linhaUser(0, '<local-command-caveat>Caveat: mensagens abaixo foram geradas pelo usuário</local-command-caveat>'),
    linhaUser(1, '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args>foque em X</command-args>'),
    linhaUser(2, '<local-command-stdout>\u001b[1mContexto\u001b[22m: \u001b[32m12%\u001b[0m usado</local-command-stdout>'),
    linhaUser(3, [{ type: 'text', text: '<command-message>agenda is running…</command-message>\n<command-name>/agenda</command-name>\n<command-args>amanhã às 9h</command-args>' }]),
    linhaUser(4, '<local-command-stdout></local-command-stdout>'),
    linhaUser(5, '<local-command-stderr>falhou: x</local-command-stderr>'),
  ]);
  assert.deepEqual(t.msgs.map((m) => [m.origin, m.text]), [
    ['dono', '/context foque em X'],
    ['comando', 'Contexto: 12% usado'],
    ['dono', '/agenda amanhã às 9h'],
    ['comando', 'falhou: x'],
  ]);
  const dono = t.msgs[0];
  assert.equal(dono.via, 'plataforma'); assert.equal(dono.quem, 'pessoa'); assert.equal(dono.kind, 'text');
  const saida = t.msgs[1];
  assert.deepEqual(saida.comando, { saida: 'stdout', cortado: false });
  assert.equal(saida.kind, 'text'); assert.equal(saida.media, null);
  assert.ok(saida.id && saida.hhmm && saida.dia && saida.ep > 0);
  assert.equal(t.msgs[3].comando.saida, 'stderr');
});

test('thread: saída muito longa é cortada em 4000 caracteres com aviso', async () => {
  const t = await threadDe([linhaUser(0, `<local-command-stdout>${'a'.repeat(5000)}</local-command-stdout>`)]);
  const m = t.msgs[0];
  assert.equal(m.origin, 'comando'); assert.equal(m.comando.cortado, true);
  assert.ok(m.text.startsWith('a'.repeat(4000) + '\n[saída cortada'));
  assert.match(m.text, /5000 caracteres/);
});

// ── compactação: avisos da agente no lugar do eco e do "resultado do comando" ──────────────────

const cts = (s) => new Date(Date.UTC(2026, 9, 18, 19, 6, 31, 464) + s * 1000).toISOString();
const compactInicio = (s = 0) => linhaUserEm(cts(s), '/compact');
const linhaUserEm = (iso, content, extra) => JSON.stringify(Object.assign({ type: 'user', timestamp: iso, message: { role: 'user', content } }, extra)) + '\n';
const boundary = (s, trigger = 'manual') => JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: cts(s), compactMetadata: { trigger } }) + '\n';
const ecoCompact = (s = 0) => linhaUserEm(cts(s), '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>');
const stdoutCompact = (s) => linhaUserEm(cts(s), '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n\u001b[2mPreCompact [runner-hook.mjs] completed successfully\u001b[22m</local-command-stdout>');
const resumo = (s) => linhaUserEm(cts(s), 'This session is being continued from a previous conversation... <dgchat from="x" chat="c_ana" msg="1">oi</dgchat>', { isCompactSummary: true });
const caveat = (s) => linhaUserEm(cts(s), '<local-command-caveat>Caveat: x</local-command-caveat>', { isMeta: true });
const resumoMsgs = (t) => t.msgs.map((m) => [m.origin, m.text]);
const AVISOS = [['agente', 'Tô compactando a conversa pra voltar mais leve... já volto'], ['agente', 'Voltei, conversa compactada.']];

test('compactação: a sequência real vira dois avisos da agente, sem balão do dono nem "resultado do comando"', async () => {
  const t = await threadDe([compactInicio(0), boundary(45.8), resumo(45.5), caveat(0.008), ecoCompact(0.008), stdoutCompact(45.9)]);
  assert.deepEqual(resumoMsgs(t), AVISOS);
  assert.equal(t.msgs[0].via, 'plataforma'); assert.equal(t.msgs[0].quem, 'agente');
  assert.ok(t.msgs[0].ep < t.msgs[1].ep);
});

test('compactação: só o eco e a saída (sem a linha "/compact" inicial) também dão dois avisos, na ordem certa', async () => {
  // ordem real do arquivo: boundary primeiro, eco (com o timestamp do início) depois
  const a = await threadDe([boundary(45.8), resumo(45.5), caveat(0.008), ecoCompact(0.008), stdoutCompact(45.9)]);
  assert.deepEqual(resumoMsgs(a), AVISOS);
  assert.ok(a.msgs[0].ep < a.msgs[1].ep);
  // versão que grava o eco ANTES do fim
  const b = await threadDe([ecoCompact(0), stdoutCompact(45.9), boundary(45.8)]);
  assert.deepEqual(resumoMsgs(b), AVISOS);
});

test('compactação: compact_boundary automático sozinho dá os dois avisos', async () => {
  const t = await threadDe([boundary(10, 'auto'), resumo(9)]);
  assert.deepEqual(resumoMsgs(t), AVISOS);
  assert.ok(t.msgs[0].ep < t.msgs[1].ep);
});

test('compactação: "/compact" inicial sem boundary só mostra o aviso de início, e não duplica', async () => {
  const t = await threadDe([compactInicio(0), compactInicio(5)]);
  assert.deepEqual(resumoMsgs(t), [AVISOS[0]]);
});

const INTERROMPIDA = ['agente', 'A compactação não terminou, sigo com a conversa como estava.'];

test('compactação: uma tentativa que nunca terminou (prazo) é fechada como interrompida antes da próxima', async () => {
  const t = await threadDe([compactInicio(0), compactInicio(3600), boundary(3640)]);
  assert.deepEqual(resumoMsgs(t), [AVISOS[0], INTERROMPIDA, AVISOS[0], AVISOS[1]]);
});

test('compactação: "/compact" cru seguido de fala do dono = início + interrompida, sem "Voltei"', async () => {
  const dono = linhaUserEm(cts(30), '<dgchat from="Danilo" chat="c_ana" msg="m9" ts="1">oi, voltou?</dgchat>');
  const t = await threadDe([compactInicio(0), dono]);
  assert.deepEqual(resumoMsgs(t), [AVISOS[0], INTERROMPIDA, ['dono', 'oi, voltou?']]);
  assert.ok(t.msgs[1].ep < t.msgs[2].ep);
  assert.equal(t.msgs[1].sistema, 'compactacao');
});

test('compactação: resposta da agente em texto puro (sem dgchat nem ferramenta) também prova a interrupção', async () => {
  // Caso real da Tina (18/10/2026): a caixa foi trocada no meio do /compact e a próxima linha útil foi uma
  // resposta em texto puro, que o pré-filtro descartava; o "já volto" ficava pendurado até vencer o prazo.
  const fala = JSON.stringify({ type: 'assistant', timestamp: cts(120), message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } }) + '\n';
  const t = await threadDe([compactInicio(0), fala]);
  assert.deepEqual(resumoMsgs(t), [AVISOS[0], INTERROMPIDA]);
});

test('compactação: outro comando de barra (/context) segue como fala do dono e "resultado do comando"', async () => {
  const t = await threadDe([
    linhaUserEm(cts(0), '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>'),
    linhaUserEm(cts(1), '<local-command-stdout>12% usado</local-command-stdout>'),
  ]);
  assert.deepEqual(resumoMsgs(t), [['dono', '/context'], ['comando', '12% usado']]);
});

test('compactação: falha (stderr) vira aviso da agente com a primeira linha do erro, sem "Voltei"', async () => {
  const t = await threadDe([compactInicio(0), ecoCompact(0.008), linhaUserEm(cts(5), '<local-command-stderr>\u001b[31mError: Not enough messages to compact.\u001b[0m\nmais detalhe</local-command-stderr>')]);
  assert.deepEqual(resumoMsgs(t), [AVISOS[0], ['agente', 'Não consegui compactar a conversa: Error: Not enough messages to compact.']]);
});

test('compactação: o resultado do /compact não vaza para o comando seguinte', async () => {
  const t = await threadDe([ecoCompact(0), stdoutCompact(1), boundary(1), linhaUserEm(cts(100), '<local-command-stdout>12% usado</local-command-stdout>')]);
  assert.deepEqual(resumoMsgs(t), [...AVISOS, ['comando', '12% usado']]);
});

test('compactação: reconstrução do zero dá o mesmo resultado da leitura incremental', () => {
  const { criarLeitor: criar } = require('../lib/thread');
  const raiz = pastaTemp('inc');
  const arq = path.join(raiz, 's.jsonl');
  const agente = { slug: 'ana', nome: 'Ana', chat_id: 'c_ana', home_host: raiz, home_container: '/home/agente' };
  const cap = capturaLog();
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro: { obter: () => agente } });
  const novo = () => criar({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia });
  const partes = [compactInicio(0), boundary(45.8), resumo(45.5), caveat(0.008), ecoCompact(0.008), stdoutCompact(45.9)];
  const inc = novo();
  fs.writeFileSync(arq, '');
  for (const p of partes) { fs.appendFileSync(arq, p); inc.ler(arq, agente); }
  const completo = novo().ler(arq, agente).eventos;
  assert.deepEqual(inc.ler(arq, agente).eventos, completo);
  assert.deepEqual(completo.map((m) => m.text), AVISOS.map((a) => a[1]));
});

// ── rotas ──────────────────────────────────────────────────────────────────

async function cenario(opRunner) {
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1', sessionId: 'sess-ana-00001' }, opRunner));
  const pAna = await rAna.ouvir();
  const { agente, home } = montaAgente('claude');
  const reg = Object.assign({}, agente, { runner: `http://127.0.0.1:${pAna}`, transcripts_dir: path.join(pastaTemp('tr'), 'projects') });
  const t = await subirWeb({ agentes: [reg] });
  await t.login();
  return { t, rAna, home, fechar: async () => { await t.fechar(); await rAna.fechar(); } };
}

test('rotas: /send com "/compact" chega cru; "oi" e "//compact" chegam no envelope; o 200 traz "comando"', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '/compact' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.comando, { nome: '/compact', tipo: 'nativo', espera_resposta: false, entregue_como: 'cru' });
    await s.t.c.post('/api/v1/agents/ana/send', { json: { text: 'oi' } });
    const esc = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '//compact' } });
    assert.equal(esc.json.comando, undefined);
    const [a, b, c] = s.rAna.rec.inputs.map((i) => i.text);
    assert.equal(a, '/compact');
    assert.match(b, /^<dgchat from="pessoa" chat="c_ana"[^>]*>oi<\/dgchat>$/);
    assert.match(c, /^<dgchat [^>]*>\/compact<\/dgchat>$/);
  } finally { await s.fechar(); }
});

test('rotas: /send de comando inexistente ou que não roda é recusado sem chegar no runner', async () => {
  const s = await cenario();
  try {
    const nao = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '/compat' } });
    assert.equal(nao.status, 404); assert.equal(nao.json.ok, false); assert.equal(nao.json.codigo, 'COMANDO_INEXISTENTE');
    const cfg = await s.t.c.post('/api/v1/agents/ana/send', { json: { text: '/config' } });
    assert.equal(cfg.status, 422); assert.equal(cfg.json.codigo, 'COMANDO_NAO_RODA');
    assert.equal(s.rAna.rec.inputs.length, 0);
  } finally { await s.fechar(); }
});

test('rotas: GET /comandos lista nativos e skills; POST /comando aceita {comando, argumentos} e {text}', async () => {
  const s = await cenario();
  try {
    const l = await s.t.c.get('/api/v1/agents/ana/comandos');
    assert.equal(l.status, 200); assert.equal(l.json.provedor, 'claude'); assert.equal(l.json.agente, 'ana');
    const nomes = l.json.comandos.map((c) => c.nome);
    assert.ok(nomes.includes('/compact') && nomes.includes('/agenda') && nomes.includes('/login'));
    assert.equal(l.json.comandos.find((c) => c.nome === '/config').roda, false);
    assert.equal(l.json.pastas_de_skills[0].existe, true);

    const a = await s.t.c.post('/api/v1/agents/ana/comando', { json: { comando: '/agenda', argumentos: 'ligar pro contador' } });
    assert.equal(a.status, 200); assert.equal(a.json.comando.tipo, 'skill');
    const b = await s.t.c.post('/api/v1/agents/ana/comando', { json: { text: '/compact foque' } });
    assert.equal(b.status, 200);
    assert.deepEqual(s.rAna.rec.inputs.map((i) => i.text), ['/agenda ligar pro contador', '/compact foque']);

    const inex = await s.t.c.post('/api/v1/agents/ana/comando', { json: { comando: '/compat' } });
    assert.equal(inex.status, 404); assert.ok(inex.json.sugestoes.includes('/compact'));
    const mal = await s.t.c.post('/api/v1/agents/ana/comando', { json: { comando: 'compact' } });
    assert.equal(mal.status, 400); assert.equal(mal.json.codigo, 'COMANDO_MALFORMADO');
    assert.equal((await s.t.c.post('/api/v1/agents/ana/comando', { json: {} })).json.codigo, 'COMANDO_MALFORMADO');
    assert.equal((await s.t.c.post('/api/v1/agents/ana/comando', { json: { comando: '/model' } })).json.codigo, 'COMANDO_PEDE_ARGUMENTO');
    assert.equal((await s.t.c.post('/api/v1/agents/ana/comando', { json: { comando: '/login' } })).json.codigo, 'COMANDO_DA_TELA');
    assert.equal((await s.t.c.get('/api/v1/agents/ana/comando')).status, 405, 'GET em /comando: a ação existe e o método não');
  } finally { await s.fechar(); }
});

test('rotas: /api/v1/comandos/docs.md serve a especificação', async () => {
  const s = await cenario();
  try {
    const r = await s.t.c.get('/api/v1/comandos/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.corpo || r.texto || JSON.stringify(r.json), /Comandos de barra na conversa/);
  } finally { await s.fechar(); }
});
