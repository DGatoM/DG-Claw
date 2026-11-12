'use strict';
// Seção Logs: sessões do Codex autenticado por chave de API (<casa>/.plataforma/codex-api/<id>/sessions) e mais um caso de
// argumento de shell com vírgula depois da aspa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarLeitor, limpaCamadaAntiga: limpa } = require('../lib/logs-leitor');

const U = (n) => `${String(n).padStart(8, '0')}-6666-4666-8666-666666666666`;
const BASE_T = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(BASE_T + ms).toISOString();
const jl = (ls) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
const ic = (ms, item) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'item_completed', item } });
const msg = (ms, t) => ic(ms, { type: 'UserMessage', content: [{ type: 'text', text: t }] });
const casa = () => {
  const home = pastaTemp('logs-api');
  return { home, ag: { slug: 'ana', nome: 'Ana', tipo: 'agente', provedor: 'codex', home_host: home, home_container: '/home/agente' } };
};
const rolloutEm = (dirSessions, uuid, linhas) => {
  const d = path.join(dirSessions, '2026', '11', '01');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `rollout-x-${uuid}.jsonl`), jl(linhas));
};
const assinatura = (c, uuid, linhas) => rolloutEm(path.join(c.home, '.codex', 'sessions'), uuid, linhas);
const viaApi = (c, id, uuid, linhas) => rolloutEm(path.join(c.home, '.plataforma', 'codex-api', id, 'sessions'), uuid, linhas);
const fonteCodex = (r) => r.fontes.find((f) => f.motor === 'codex');

test('Codex por chave de API: só a pasta da API lê as sessões e a fonte não diz "nunca rodou"', async () => {
  const c = casa();
  viaApi(c, 'AbC123_x', U(1), [msg(1000, 'pergunta pela API'), ic(2000, { type: 'CommandExecution', command: ['bash', '-lc', 'ls'], exit_code: 0, status: 'completed', aggregated_output: 'ok' })]);
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.tipo), ['comando', 'mensagem']);
  assert.equal(r.eventos[0].sessao, U(1));
  const f = fonteCodex(r);
  assert.equal(f.estado, 'ok');
  assert.equal(f.arquivos, 1);
  assert.ok(!/nunca rodou/.test(f.motivo || ''));
  const s = await l.sessoes(c.ag, { limite: 10, cursor: null });
  assert.equal(s.sessoes.length, 1);
  assert.ok(!JSON.stringify(s).includes(c.home));
  assert.equal((await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'codex').arquivos, 1);
});

test('Codex misto (assinatura e API): as duas pastas entram na mesma fonte, mesmo com nomes iguais de arquivo', async () => {
  const c = casa();
  assinatura(c, U(1), [msg(1000, 'pela assinatura')]);
  viaApi(c, 'sessao-a', U(1), [msg(2000, 'pela API a')]);   // mesmo caminho relativo e mesmo uuid: o id do arquivo não pode colidir
  viaApi(c, 'sessao-b', U(2), [msg(3000, 'pela API b')]);
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.texto), ['pela API b', 'pela API a', 'pela assinatura']);
  assert.equal(new Set(r.eventos.map((e) => e.id.split(':')[0])).size, 3, 'ids de arquivo distintos');
  assert.equal(fonteCodex(r).arquivos, 3);
  const ids = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const p = await l.eventos(c.ag, { limite: 1, cursor });
    ids.push(...p.eventos.map((e) => e.id));
    if (!p.proximo) break;
    cursor = require('../lib/logs-leitor').decodificaCursor(p.proximo);
  }
  assert.deepEqual(ids, r.eventos.map((e) => e.id));
});

test('Codex: sem nada em nenhuma das duas pastas a fonte continua "ausente"', async () => {
  const c = casa();
  const r = await criarLeitor().resumoDasFontes(c.ag);
  const f = r.fontes.find((x) => x.motor === 'codex');
  assert.equal(f.estado, 'ausente');
  assert.match(f.motivo, /nunca rodou/);
});

test('Codex API: atalhos maliciosos em .plataforma não são seguidos', async () => {
  const fora = pastaTemp('logs-api-fora');
  rolloutEm(path.join(fora, 'codex-api', 'x', 'sessions'), U(9), [msg(1000, 'CONTEUDO-ALHEIO')]);

  // 1. .plataforma inteira é atalho para fora da casa
  let c = casa();
  fs.symlinkSync(fora, path.join(c.home, '.plataforma'));
  let r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 0);
  assert.equal(fonteCodex(r).estado, 'ilegivel');
  assert.match(fonteCodex(r).motivo, /fora da pasta do agente/);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));

  // 2. codex-api é atalho
  c = casa();
  fs.mkdirSync(path.join(c.home, '.plataforma'));
  fs.symlinkSync(path.join(fora, 'codex-api'), path.join(c.home, '.plataforma', 'codex-api'));
  r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.equal(r.eventos.length, 0);
  assert.equal(fonteCodex(r).estado, 'ilegivel');

  // 3. <id> é atalho (ignorado e contado) e <id>/sessions é atalho (recusado)
  c = casa();
  const api = path.join(c.home, '.plataforma', 'codex-api');
  fs.mkdirSync(api, { recursive: true });
  fs.symlinkSync(path.join(fora, 'codex-api', 'x'), path.join(api, 'id-atalho'));
  fs.mkdirSync(path.join(api, 'sessions-atalho'));
  fs.symlinkSync(path.join(fora, 'codex-api', 'x', 'sessions'), path.join(api, 'sessions-atalho', 'sessions'));
  viaApi(c, 'legitimo', U(1), [msg(5000, 'legítimo')]);
  r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.texto), ['legítimo']);
  assert.ok(r.contagens.atalhos_ignorados >= 1);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  assert.equal(fonteCodex(r).estado, 'ok');
});

test('Codex API: <id> fora da regex fechada é ignorado', async () => {
  const c = casa();
  const api = path.join(c.home, '.plataforma', 'codex-api');
  for (const ruim of ['a b', 'a.b', 'ç', 'x'.repeat(65), '..%2f']) {
    rolloutEm(path.join(api, ruim, 'sessions'), U(3), [msg(1000, `ruim-${ruim.length}`)]);
  }
  rolloutEm(path.join(api, 'x'.repeat(64), 'sessions'), U(4), [msg(2000, 'id-no-limite')]);
  const r = await criarLeitor().eventos(c.ag, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => e.texto), ['id-no-limite']);
});

test('Admin: sessões por chave de API na casa dele aparecem; sem elas o Admin não ganha fonte do Codex', async () => {
  const casaAdmin = pastaTemp('logs-api-adm');
  const tr = pastaTemp('logs-api-adm-tr');
  fs.writeFileSync(path.join(tr, `${U(5)}.jsonl`), JSON.stringify({ type: 'user', timestamp: iso(500), sessionId: U(5), message: { role: 'user', content: 'do claude' } }) + '\n');
  const adm = { slug: 'admin', nome: 'Admin', tipo: 'admin', transcripts_dir: tr, home_host: casaAdmin, home_container: casaAdmin };
  const l = criarLeitor();
  assert.deepEqual((await l.resumoDasFontes(adm)).fontes.map((f) => f.motor), ['claude']);
  rolloutEm(path.join(casaAdmin, '.plataforma', 'codex-api', 'admin', 'sessions'), U(6), [msg(1000, 'admin pela API')]);
  const r = await l.eventos(adm, { limite: 50, cursor: null });
  assert.deepEqual(r.eventos.map((e) => [e.motor, e.texto]), [['codex', 'admin pela API'], ['claude', 'do claude']]);
  assert.equal(fonteCodex(r).estado, 'ok');
});

test('Codex API: teto de pastas e de entradas deixa a fonte parcial, com motivo', async () => {
  const c = casa();
  for (let i = 0; i < 6; i++) viaApi(c, `s${i}`, U(10 + i), [msg(1000 + i, `m${i}`)]);
  const l = criarLeitor({ orcamento: { maxArquivos: 3 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'codex');
  assert.equal(f.estado, 'parcial');
  assert.ok(f.arquivos <= 3 && f.arquivos >= 1);
});

// ── argumento de shell: `,` `}` `]` depois da aspa fazem parte do valor ────
const SUF = 'SUFIXO' + 'ALHEIO' + '456';
const SHELL = [
  `curl -u "usuario:",${SUF} https://x depois`,
  `curl -u "usuario:"}${SUF} https://x depois`,
  `curl --user 'a b']${SUF} https://x depois`,
  `app --password="x",${SUF} depois`,
  `app --token='a b'}${SUF} depois`,
  `app --secret "a"]${SUF} depois`,
  `mysql -u root -p"a b",${SUF} db depois`,
  `mysql -u root -p'a'}${SUF} db depois`,
];

test('limpa: em argumento de shell a vírgula, a chave e o colchete depois da aspa fazem parte do valor', () => {
  for (const c of SHELL) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c} => ${r}`);
    assert.match(r, /depois$/);
  }
  const k = 'sen' + 'ha';
  const r = limpa(`{"${k}":"x","outro":"visivel"}`);
  assert.ok(r.includes('"outro":"visivel"'), 'a exceção de JSON continua valendo na atribuição');
});

test('resposta e busca nos dois motores: o valor de argumento de shell com vírgula depois da aspa não vaza', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), SHELL.map((t, i) => JSON.stringify({ type: 'user', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'user', content: t } })).join('\n') + '\n');
  rolloutEm(path.join(c.home, '.plataforma', 'codex-api', 'x', 'sessions'), U(2), SHELL.map((t, i) => msg(5000 + i, t)));
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 100, cursor: null });
  assert.equal(r.eventos.length, SHELL.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [SUF, 'ALHEIO']) assert.equal((await l.eventos(c.ag, { limite: 100, cursor: null, q })).eventos.length, 0);
});

// ── tetos e prazo da enumeração de .plataforma/codex-api ────────────────────
const apiDir = (c) => { const d = path.join(c.home, '.plataforma', 'codex-api'); fs.mkdirSync(d, { recursive: true }); return d; };

test('Codex API: arquivos, atalhos e nomes inválidos em excesso respeitam o teto de entradas e deixam a fonte parcial', async () => {
  const c = casa();
  const api = apiDir(c);
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(api, `arquivo-${i}.txt`), 'x');
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(api, `nome invalido ${i}`));
  viaApi(c, 'legitimo', U(1), [msg(1000, 'legítimo')]);
  const l = criarLeitor({ orcamento: { maxEntradas: 30 } });
  const r = await l.eventos(c.ag, { limite: 50, cursor: null });
  const f = fonteCodex(r);
  assert.equal(f.estado, 'parcial');
  assert.match(f.motivo, /entradas demais/);
  assert.ok(r.avisos.some((a) => a.tipo === 'limite' || /entradas demais/.test(a.motivo || '')) || /entradas demais/.test(f.motivo));
});

test('Codex API: o prazo da enumeração também vale (relógio de teste)', async () => {
  const c = casa();
  const api = apiDir(c);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(api, `arquivo-${i}.txt`), 'x');
  let t = 0;
  const l = criarLeitor({ agora: () => (t += 1000), orcamento: { descobertaMs: 5000 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'codex');
  assert.equal(f.estado, 'parcial');
  assert.match(f.motivo, /passou de 5000 ms/);
});

test('Codex API: 201 pastas devolvem as 200 primeiras e a fonte parcial, com motivo', async () => {
  const c = casa();
  for (let i = 0; i < 201; i++) viaApi(c, `p${String(i).padStart(3, '0')}`, U(100 + i), [msg(1000 + i, `m${i}`)]);
  const l = criarLeitor({ orcamento: { descobertaMs: 120000 } });
  const f = (await l.resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'codex');
  assert.equal(f.estado, 'parcial');
  assert.equal(f.arquivos, 200);
  assert.match(f.motivo, /mais de 200 pastas/);
  const s = await l.sessoes(c.ag, { limite: 200, cursor: null });
  assert.equal(s.sessoes.length, 200);
  assert.ok(s.avisos.some((a) => a.tipo === 'limite'));
});

test('Codex API: pastas todas ilegíveis não viram "nunca rodou"', async () => {
  const c = casa();
  const fora = pastaTemp('logs-api-fora2');
  fs.mkdirSync(path.join(fora, 'sessions'), { recursive: true });
  const api = apiDir(c);
  fs.mkdirSync(path.join(api, 'a'));
  fs.symlinkSync(path.join(fora, 'sessions'), path.join(api, 'a', 'sessions'));
  const f = (await criarLeitor().resumoDasFontes(c.ag)).fontes.find((x) => x.motor === 'codex');
  assert.equal(f.estado, 'ilegivel');
  assert.ok(!/nunca rodou/.test(f.motivo));
});

// ── atribuição com = é argumento de shell; com : é propriedade ──────────────
const IGUAL = [
  `PASSWORD="prefixo",${SUF} programa`,
  `senha='a b'}${SUF} programa`,
  `token=x"a b"]${SUF} programa`,
  `API_KEY="a",${SUF}`.replace(/$/, ' programa'),
  `chave=a"b",c}${SUF} programa`,
];

test('limpa: atribuição com "=" consome todos os pedaços adjacentes, com "," "}" "]" depois da aspa', () => {
  for (const c of IGUAL) {
    const r = limpa(c);
    assert.ok(!r.includes(SUF), `sobrou o sufixo em: ${c} => ${r}`);
    assert.match(r, /programa$/);
  }
  const k = 'sen' + 'ha';
  assert.ok(limpa(`{"${k}":"x","outro":"visivel"}`).includes('"outro":"visivel"'), 'com ":" a exceção de JSON continua');
  assert.ok(limpa(`${k}: "x", outro: "y"`).includes('outro: "y"'), 'também em YAML inline');
});

test('resposta e busca nos dois motores: atribuição com "=" e vírgula depois da aspa não vaza', async () => {
  const c = casa();
  const d = path.join(c.home, '.claude', 'projects', '-ws');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${U(1)}.jsonl`), IGUAL.map((t, i) => JSON.stringify({ type: 'user', timestamp: iso(1000 + i), sessionId: U(1), message: { role: 'user', content: t } })).join('\n') + '\n');
  assinatura(c, U(2), IGUAL.map((t, i) => msg(5000 + i, t)));
  const l = criarLeitor();
  const r = await l.eventos(c.ag, { limite: 100, cursor: null });
  assert.equal(r.eventos.length, IGUAL.length * 2);
  assert.ok(!JSON.stringify(r).includes('ALHEIO'));
  for (const q of [SUF, 'ALHEIO']) assert.equal((await l.eventos(c.ag, { limite: 100, cursor: null, q })).eventos.length, 0);
});
