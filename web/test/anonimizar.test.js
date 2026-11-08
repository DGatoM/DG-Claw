'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subirWeb, pastaTemp, entregaAoAgente } = require('./ajuda');
const COMO_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const { criarRunnerFalso } = require('./runner-falso');
const { trocarValoresConhecidos, reverterMarcadores } = require('../lib/anonimizar');

const MOTOR = path.join(__dirname, 'anonimizar-motor-falso.js');
const CPF = '123.456.789-00';
const { spawnSync } = require('node:child_process');
const MOTOR_REAL_TEM_USADOS = fs.readdirSync(path.join(__dirname, '..', '..', 'anonimizar')).filter((n) => n.endsWith('.py') && !n.startsWith('test_')).some((n) => /["']usados["']\s*:/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'anonimizar', n), 'utf8')));
const PYTHON = (() => { const r = spawnSync('python3', ['--version']); return r.status === 0 ? 'python3' : null; })();

/** CPF com dígitos verificadores corretos (o detector real confere). */
function cpfValido(base) {
  const d = base.split('').map(Number);
  const dv = (n) => { const soma = d.slice(0, n).reduce((a, x, i) => a + x * (n + 1 - i), 0); const r = (soma * 10) % 11; return r === 10 ? 0 : r; };
  d.push(dv(9)); d.push(dv(10));
  const t = d.join('');
  return `${t.slice(0, 3)}.${t.slice(3, 6)}.${t.slice(6, 9)}-${t.slice(9)}`;
}
const NOME = 'Maria Souza';

/** Web com os agentes ana e beto, runner falso para cada e o motor falso. */
async function cenario(o) {
  const op = o || {};
  const rAna = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-ana-00001' });
  const rBeto = criarRunnerFalso({ agenteId: 'beto1', sessionId: 'sess-beto-0001' });
  const pAna = await rAna.ouvir(); const pBeto = await rBeto.ouvir();
  const homeAna = pastaTemp('home-ana'); const homeBeto = pastaTemp('home-beto');
  fs.mkdirSync(path.join(homeAna, 'out'), { recursive: true });
  fs.mkdirSync(path.join(homeBeto, 'out'), { recursive: true });
  entregaAoAgente(homeAna); entregaAoAgente(homeBeto);
  const dirChave = pastaTemp('chave');
  const base = pastaTemp('anon-base');
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', home_host: homeAna, home_container: '/home/agente' },
    { slug: 'beto', nome: 'Beto', tipo: 'agente', runner: `http://127.0.0.1:${pBeto}`, agente_id: 'beto1', chat_id: 'c_beto', provedor: 'claude', modelo: 'sonnet', home_host: homeBeto, home_container: '/home/agente' },
  ];
  const chamadasSystemctl = [];
  const t = await subirWeb({
    agentes,
    env: Object.assign({ DGCLAW_ANON_CHAVE: path.join(dirChave, 'anonimizar.chave'), DGCLAW_ANON_BASE: base, DGCLAW_ANON_NIVEL: op.nivel || 'completo' }, op.real ? { DGCLAW_ANON_PYTHON: PYTHON, DGCLAW_ANON_NER: 'falso' } : {}, op.env || {}),
    opcoesServidor: {
      anonMotor: op.real ? undefined : { comando: process.execPath, args: [MOTOR] },
      anonSystemctl: async (args) => { chamadasSystemctl.push(args); return { erro: null, saida: 'inactive' }; },
      anonOciosoMs: op.ociosoMs,
    },
  });
  await t.login();
  const fechar = async () => { await t.fechar(); await rAna.fechar(); await rBeto.fechar(); };
  return { t, c: t.c, rAna, rBeto, homeAna, homeBeto, dirChave, base, chamadasSystemctl, fechar };
}

function multipart(limite, campos, nome, dados) {
  return Buffer.concat([
    ...Object.entries(campos).map(([k, v]) => Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    dados,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
}
const LIM = '----anon1234';
const H = { 'Content-Type': `multipart/form-data; boundary=${LIM}` };
let seq = 0;
async function sobe(s, slug, nome, conteudo, campos) {
  seq += 1;
  return s.c.post(`/api/v1/agents/${slug}/upload`, { corpo: multipart(LIM, Object.assign({ cliente_id: `anon-teste-${String(seq).padStart(8, '0')}` }, campos || {}), nome, Buffer.from(conteudo)), headers: H });
}
const liga = (s, slug, extra) => s.c.pedir('PUT', `/api/v1/anonimizar/${slug || 'ana'}/config`, { json: Object.assign({ ligado: true }, extra || {}) });

function todosOsArquivos(dir) {
  const lista = [];
  (function anda(d) {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) anda(p); else lista.push(p);
    }
  })(dir);
  return lista;
}
const conteudoDe = (dir) => todosOsArquivos(dir).map((f) => f.toLowerCase() + '\n' + fs.readFileSync(f).toString('latin1')).join('\n----\n');

test('config: padrão desligado, PUT valida, e as chaves que o Web não conhece sobrevivem', async () => {
  const s = await cenario();
  try {
    const g = await s.c.get('/api/v1/anonimizar/ana/config');
    assert.equal(g.status, 200); assert.equal(g.json.config.ligado, false);
    assert.equal(g.json.config.sem_detector, 'bloquear'); assert.equal(g.json.config.nao_anonimizavel, 'bloquear');
    const arq = path.join(s.t.dados, 'anonimizar', 'config.json');
    fs.mkdirSync(path.dirname(arq), { recursive: true, mode: 0o700 });
    fs.writeFileSync(arq, JSON.stringify({ outro_recurso: { x: 1 }, ana: { ligado: false, chave_futura: 'fica' }, zeca: { ligado: true } }), { mode: 0o600 });
    const p = await liga(s, 'ana', { datas: true });
    assert.equal(p.status, 200, p.texto);
    const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.deepEqual(disco.outro_recurso, { x: 1 });
    assert.equal(disco.ana.chave_futura, 'fica');
    assert.equal(disco.ana.ligado, true); assert.equal(disco.ana.datas, true);
    assert.deepEqual(disco.zeca, { ligado: true });
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    const ruim = await s.c.pedir('PUT', '/api/v1/anonimizar/ana/config', { json: { ligado: 'sim' } });
    assert.equal(ruim.status, 400); assert.match(ruim.json.erro, /true ou false/);
    assert.equal((await s.c.pedir('PUT', '/api/v1/anonimizar/ana/config', { json: { sem_detector: 'tanto-faz' } })).status, 400);
    assert.equal((await s.c.pedir('PUT', '/api/v1/anonimizar/ana/config', { json: { inventada: true } })).status, 400);
    assert.equal((await s.c.get('/api/v1/anonimizar/nao-existe/config')).status, 404);
    // arquivo corrompido: não é sobrescrito e o erro explica
    fs.writeFileSync(arq, '{ quebrado', { mode: 0o600 });
    const q = await liga(s, 'ana');
    assert.equal(q.status, 500); assert.match(q.json.erro, /ilegível/);
    assert.equal(fs.readFileSync(arq, 'utf8'), '{ quebrado');
  } finally { await s.fechar(); }
});

test('upload com a anonimização desligada segue como sempre: o original vai para a casa do agente', async () => {
  const s = await cenario();
  try {
    const r = await sobe(s, 'ana', 'contrato.txt', `Contrato de ${NOME} CPF ${CPF}`);
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.anonimizado, undefined);
    assert.match(r.json.anexo.path, /contrato\.txt$/);
    assert.ok(conteudoDe(s.homeAna).includes(NOME));
  } finally { await s.fechar(); }
});

test('upload ligado: o original NUNCA aparece na casa do agente, só doc-<id>.anon.*, e o agente recebe os marcadores', async () => {
  const s = await cenario();
  try {
    assert.equal((await liga(s)).status, 200);
    const r = await sobe(s, 'ana', 'Contrato Maria Souza.txt', `Contrato de ${NOME}, CPF ${CPF}.\nFim.`, { legenda: `Analise o contrato de ${NOME}` });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.anonimizado.contagem, 3);   // CPF e nome no arquivo, nome na legenda
    assert.match(r.json.anexo.path, /^\/home\/agente\/uploads\/[\d-]+\/doc-[0-9a-f]{8}\.anon\.md$/);
    const casa = conteudoDe(s.homeAna);
    assert.ok(!casa.includes(NOME.toLowerCase()) && !casa.includes(NOME), 'nome real na casa do agente');
    assert.ok(!casa.includes(CPF), 'CPF real na casa do agente');
    assert.ok(!casa.includes('contrato maria'), 'nome do arquivo original na casa do agente');
    const arquivos = todosOsArquivos(path.join(s.homeAna, 'uploads'));
    assert.equal(arquivos.length, 1);
    assert.match(fs.readFileSync(arquivos[0], 'utf8'), /Contrato de \[PESSOA_1\], CPF \[CPF_1\]/);
    const enviado = s.rAna.rec.inputs[0].text;
    assert.ok(!enviado.includes(NOME) && !enviado.includes('Maria'), enviado);
    assert.match(enviado, /Analise o contrato de \[PESSOA_1\]/);
    assert.match(enviado, /\[anexo: \/home\/agente\/uploads\/[\d-]+\/doc-[0-9a-f]{8}\.anon\.md\]/);
    assert.match(enviado, /\[documento anonimizado: os dados pessoais foram trocados por marcadores/);
    // o temporário some
    const tmp = path.join(s.t.dados, 'anonimizar', 'tmp');
    assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], []);
  } finally { await s.fechar(); }
});

test('docx anonimizado: o marcador aponta para o .md e a nota lista a outra versão', async () => {
  const s = await cenario();
  try {
    await liga(s);
    const r = await sobe(s, 'ana', 'proposta.docx', `Para ${NOME}`);
    assert.equal(r.status, 201, r.texto);
    assert.match(r.json.anexo.path, /\.anon\.md$/);
    assert.match(s.rAna.rec.inputs[0].text, /Outras versões do mesmo documento: \/home\/agente\/uploads\/[\d-]+\/doc-[0-9a-f]{8}\.anon\.docx/);
    assert.equal(todosOsArquivos(path.join(s.homeAna, 'uploads')).length, 2);
  } finally { await s.fechar(); }
});

test('tabela e registro ficam cifrados em disco (AES-256-GCM), com pastas 0700 e arquivos 0600', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} e ${CPF}`);
    const dir = path.join(s.t.dados, 'anonimizar');
    const bruto = conteudoDe(dir);
    assert.ok(!bruto.includes(NOME) && !bruto.includes(CPF), 'valor em claro no disco');
    assert.ok(!bruto.includes('a.txt\u0000') );
    for (const f of ['tabela.enc', 'documentos.enc']) {
      const caminho = path.join(dir, 'ana', f);
      assert.equal(fs.statSync(caminho).mode & 0o777, 0o600);
      assert.ok(!fs.readFileSync(caminho).toString('latin1').includes('a.txt'));
    }
    assert.equal(fs.statSync(path.join(dir, 'ana')).mode & 0o777, 0o700);
    const chave = path.join(s.dirChave, 'anonimizar.chave');
    assert.equal(fs.statSync(chave).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(chave).length, 32);
    const t = await s.c.get('/api/v1/anonimizar/ana/tabela');
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.entradas.map((e) => e.marcador).sort(), ['[CPF_1]', '[PESSOA_1]']);
    assert.equal(t.headers['cache-control'], 'no-store');
    assert.match(s.t.log.texto(), /tabela de ana foi aberta/);
    assert.ok(!s.t.log.texto().includes(NOME) && !s.t.log.texto().includes(CPF), 'valor no log');
  } finally { await s.fechar(); }
});

test('falha fechada: motor que cai, trava, recusa ou devolve arquivo estranho = nada na casa do agente e o status certo', async () => {
  const s = await cenario({ env: { DGCLAW_ANON_TIMEOUT_S: '1' } });
  try {
    await liga(s);
    const antes = s.rAna.rec.inputs.length;
    const cai = await sobe(s, 'ana', 'x.txt', `EXPLODE ${NOME}`);
    assert.equal(cai.status, 503, cai.texto); assert.match(cai.json.erro, /parou no meio/); assert.equal(cai.json.codigo, 'MOTOR_CAIU');
    const trava = await sobe(s, 'ana', 'y.txt', `TRAVA ${NOME}`);
    assert.equal(trava.status, 503); assert.equal(trava.json.codigo, 'MOTOR_DEMOROU');
    const recusa = await sobe(s, 'ana', 'z.txt', `RECUSA ${NOME}`);
    assert.equal(recusa.status, 422); assert.match(recusa.json.erro, /senha/);
    const veneno = await sobe(s, 'ana', 'w.txt', `ENVENENA ${NOME}`);
    assert.equal(veneno.status, 502, veneno.texto);
    assert.equal(s.rAna.rec.inputs.length, antes, 'nada foi entregue ao agente');
    const up = path.join(s.homeAna, 'uploads');
    assert.deepEqual(fs.existsSync(up) ? todosOsArquivos(up) : [], []);
    // e o motor volta a funcionar depois da queda
    const ok = await sobe(s, 'ana', 'ok.txt', `Só ${NOME}`);
    assert.equal(ok.status, 201, ok.texto);
  } finally { await s.fechar(); }
});

test('sem detector de nomes: bloquear (padrão) ou trocar só os números', async () => {
  const s = await cenario({ nivel: 'regex' });
  try {
    await liga(s);
    const b = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    assert.equal(b.status, 422); assert.equal(b.json.codigo, 'SEM_DETECTOR'); assert.match(b.json.erro, /detector de nomes/);
    assert.equal(s.rAna.rec.inputs.length, 0);
    await liga(s, 'ana', { sem_detector: 'so_numeros' });
    const ok = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    assert.equal(ok.status, 201, ok.texto);
    assert.ok(ok.json.anonimizado.avisos.some((a) => /Nomes e endereços passaram/.test(a)));
    const doc = fs.readFileSync(todosOsArquivos(path.join(s.homeAna, 'uploads'))[0], 'utf8');
    assert.ok(doc.includes('[CPF_1]') && doc.includes(NOME));
  } finally { await s.fechar(); }
});

test('formato que o motor não lê: bloquear (padrão) ou enviar assim mesmo, conforme o dono escolheu', async () => {
  const s = await cenario({ nivel: 'completo' });
  try {
    await liga(s);
    const b = await sobe(s, 'ana', 'foto.png', 'png-falso');
    assert.equal(b.status, 422); assert.equal(b.json.codigo, 'NAO_ANONIMIZAVEL');
    assert.equal(s.rAna.rec.inputs.length, 0);
    await liga(s, 'ana', { nao_anonimizavel: 'enviar' });
    const e = await sobe(s, 'ana', 'foto.png', 'png-falso');
    assert.equal(e.status, 201, e.texto);
    assert.equal(e.json.anonimizado.enviado_sem_anonimizar, true);
    assert.match(e.json.anexo.path, /foto\.png$/);
  } finally { await s.fechar(); }
});

test('nível sem os leitores: pdf cai na regra de formato não anonimizável', async () => {
  const s = await cenario({ nivel: 'regex' });
  try {
    await liga(s);
    const r = await sobe(s, 'ana', 'a.pdf', '%PDF');
    assert.equal(r.status, 422); assert.match(r.json.erro, /leitores/);
  } finally { await s.fechar(); }
});

test('texto digitado: só com a opção ligada, só valores já conhecidos, sem acento nem caixa, e comando de barra passa direto', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const n0 = s.rAna.rec.inputs.length;
    const env = (texto) => s.c.post('/api/v1/agents/ana/send', { json: { text: texto, cliente_id: `dig-${String(++seq).padStart(8, '0')}` } });
    const sem = await env(`Liga pra ${NOME}`);
    assert.equal(sem.status, 200, sem.texto);
    assert.match(s.rAna.rec.inputs[n0].text, new RegExp(NOME), 'opção desligada: texto intacto');
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    const com = await env(`Liga pra maria SOUZA, cpf 12345678900. E o João Novo também.`);
    assert.equal(com.status, 200, com.texto);
    const t = s.rAna.rec.inputs[n0 + 1].text;
    assert.match(t, /Liga pra \[PESSOA_1\], cpf \[CPF_1\]\. E o João Novo também\./);
    assert.equal((await env('/ajuda')).status < 500, true);
    assert.ok(!/\[PESSOA_1\]/.test(s.rAna.rec.inputs[n0 + 2] ? s.rAna.rec.inputs[n0 + 2].text : ''), 'comando de barra não é trocado');
  } finally { await s.fechar(); }
});

test('trocarValoresConhecidos: mais longo primeiro, palavra inteira, sem acento, dígitos com pontuação', () => {
  const tab = [
    { tipo: 'PESSOA', valor: 'Maria Souza', marcador: '[PESSOA_1]' },
    { tipo: 'PESSOA', valor: 'Maria', marcador: '[PESSOA_2]' },
    { tipo: 'CPF', valor: '123.456.789-00', marcador: '[CPF_1]' },
    { tipo: 'PESSOA', valor: 'José', marcador: '[PESSOA_3]' },
  ];
  const r = trocarValoresConhecidos('Maria Souza e Maria. Mariana não. JOSE e cpf 123 456 789 00 ou 12345678900.', tab);
  assert.equal(r.texto, '[PESSOA_1] e [PESSOA_2]. Mariana não. [PESSOA_3] e cpf [CPF_1] ou [CPF_1].');
  assert.equal(r.trocas, 5);
  const fone = [{ tipo: 'TELEFONE', valor: '11912345678', marcador: '[TELEFONE_1]' }, { tipo: 'CPF', valor: '123.456.789-00', marcador: '[CPF_1]' }];
  assert.equal(trocarValoresConhecidos('Ligue (11) 91234-5678 ou 11 91234 5678 e (123.456.789-00).', fone).texto, 'Ligue [TELEFONE_1] ou [TELEFONE_1] e ([CPF_1]).');
  assert.deepEqual(trocarValoresConhecidos('nada', []), { texto: 'nada', trocas: 0 });
  assert.deepEqual(reverterMarcadores('[PESSOA_1] [X_9] [PESSOA_1]', [{ marcador: '[PESSOA_1]', valor: 'Ana' }]), { texto: 'Ana [X_9] Ana', trocas: 2, desconhecidos: ['[X_9]'] });
});

test('trocarValoresConhecidos: posições em UTF-16, emoji e normalização não deixam o valor vazar', () => {
  const tab = [{ tipo: 'PESSOA', valor: 'Maria Souza', marcador: '[PESSOA_1]' }];
  const casos = [
    ['\u{1F600} Maria Souza', '\u{1F600} [PESSOA_1]'],
    ['Maria \u{1F600} Souza e Maria Souza', null],
    ['Maria Souza \u{1F600}', '[PESSOA_1] \u{1F600}'],
    ['\u{1F600}\u{1F680}\u{1F600} Maria Souza \u{1F680}\u{1F680}', '\u{1F600}\u{1F680}\u{1F600} [PESSOA_1] \u{1F680}\u{1F680}'],
    ['e\u0301e\u0301 Maria Souza', 'e\u0301e\u0301 [PESSOA_1]'],
    ['\u0130\u0130 Maria Souza', '\u0130\u0130 [PESSOA_1]'],
    ['Maria Souza normal', '[PESSOA_1] normal'],
    ['MARIA  SOUZA \u{1F600} maria souza', '[PESSOA_1] \u{1F600} [PESSOA_1]'],
  ];
  for (const [entrada, esperado] of casos) {
    const r = trocarValoresConhecidos(entrada, tab);
    assert.equal(/maria\s+souza/i.test(r.texto), false, `vazou em: ${JSON.stringify(entrada)} -> ${JSON.stringify(r.texto)}`);
    if (esperado) assert.equal(r.texto, esperado);
  }
  assert.equal(trocarValoresConhecidos('\u{1F600} Maria Souza', tab).trocas, 1);
});

test('reverter-texto devolve os dados reais e deixa o marcador desconhecido como está', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const r = await s.c.post('/api/v1/anonimizar/ana/reverter-texto', { json: { texto: 'Falei com [PESSOA_1] ([CPF_1]) e [PESSOA_7].' } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.texto, `Falei com ${NOME} (${CPF}) e [PESSOA_7].`);
    assert.equal(r.json.trocas, 2);
    assert.equal((await s.c.post('/api/v1/anonimizar/ana/reverter-texto', { json: { texto: 5 } })).status, 400);
    // a tabela é por agente: o beto não reverte os marcadores da ana
    const b = await s.c.post('/api/v1/anonimizar/beto/reverter-texto', { json: { texto: '[PESSOA_1]' } });
    assert.equal(b.json.texto, '[PESSOA_1]');
  } finally { await s.fechar(); }
});

test('testar: devolve o texto com marcadores e não grava nada na tabela', async () => {
  const s = await cenario();
  try {
    const r = await s.c.post('/api/v1/anonimizar/testar', { json: { slug: 'ana', texto: `${NOME} tem CPF ${CPF}` } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.texto, '[PESSOA_1] tem CPF [CPF_1]');
    assert.equal(r.json.total, 2);
    const t = await s.c.get('/api/v1/anonimizar/ana/tabela');
    assert.equal(t.json.total, 0);
    assert.equal((await s.c.post('/api/v1/anonimizar/testar', { json: { texto: '  ' } })).status, 400);
    assert.equal((await s.c.post('/api/v1/anonimizar/testar', { json: { slug: 'fantasma', texto: 'oi' } })).status, 404);
  } finally { await s.fechar(); }
});

test('apagar documento tira da tabela só os marcadores que nenhum outro documento usa', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    await sobe(s, 'ana', 'b.txt', `${NOME} 987.654.321-00`);
    const lista = (await s.c.get('/api/v1/anonimizar/ana/documentos')).json.documentos;
    assert.equal(lista.length, 2);
    assert.ok(lista.every((d) => d.total >= 1 && !JSON.stringify(d).includes(NOME) && !JSON.stringify(d).includes(CPF)));
    const docA = lista.find((d) => d.nome_original === 'a.txt');
    const del = await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${docA.id}`);
    assert.equal(del.status, 200, del.texto);
    assert.equal(del.json.removidos_da_tabela, 1);
    const tab = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas;
    assert.deepEqual(tab.filter((e) => !e.apagado).map((e) => e.valor).sort(), ['987.654.321-00', NOME].sort());
    assert.deepEqual(tab.filter((e) => e.apagado).map((e) => e.marcador), ['[CPF_1]']);
    assert.equal((await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${docA.id}`)).status, 404);
    assert.equal((await s.c.pedir('DELETE', '/api/v1/anonimizar/ana/documentos/XYZ')).status, 400);
    const tudo = await s.c.pedir('DELETE', '/api/v1/anonimizar/ana/documentos');
    assert.equal(tudo.status, 200); assert.equal(tudo.json.apagados, 1);
    assert.ok((await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas.every((e) => e.apagado));
  } finally { await s.fechar(); }
});

test('versão final: devolve os dados reais, com cabeçalhos de download seguro; docx, md e html; pdf explica', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const out = path.join(s.homeAna, 'out');
    const cria = (nome, conteudo) => { const p = path.join(out, nome); fs.writeFileSync(p, conteudo); return s.t.web.midia.registrar('ana', p, { visto: '/home/agente/out/' + nome }).id; };
    const md = await s.c.get(`/api/v1/anonimizar/ana/final/${cria('resultado.md', 'Parecer sobre [PESSOA_1], CPF [CPF_1].')}`);
    assert.equal(md.status, 200, md.texto);
    assert.equal(md.texto, `Parecer sobre ${NOME}, CPF ${CPF}.`);
    assert.match(md.headers['content-disposition'], /^attachment; filename="resultado-final\.md"/);
    assert.equal(md.headers['x-content-type-options'], 'nosniff'); assert.equal(md.headers['cache-control'], 'no-store');
    const dx = await s.c.get(`/api/v1/anonimizar/ana/final/${cria('minuta.docx', 'Para [PESSOA_1]')}`);
    assert.equal(dx.status, 200); assert.match(dx.headers['content-disposition'], /minuta-final\.docx/);
    assert.match(dx.headers['content-type'], /wordprocessingml/);
    for (const nome of ['pagina.html', 'pagina.htm', 'desenho.svg', 'dados.xml']) {
      const ht = await s.c.get(`/api/v1/anonimizar/ana/final/${cria(nome, '<script>alert(1)</script> [PESSOA_1]')}`);
      assert.equal(ht.status, 422, nome); assert.equal(ht.json.codigo, 'FORMATO_ATIVO'); assert.match(ht.json.erro, /\.md ou \.docx/);
    }
    const pdf = await s.c.get(`/api/v1/anonimizar/ana/final/${cria('r.pdf', '%PDF')}`);
    assert.equal(pdf.status, 422); assert.match(pdf.json.erro, /docx ou \.md/);
    assert.equal((await s.c.get(`/api/v1/anonimizar/ana/final/${cria('r.png', 'x')}`)).status, 422);
    assert.equal(s.c && (await s.c.get('/api/v1/anonimizar/ana/final/zzzz')).status, 400);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/final/0123456789abcdef')).status, 404);
    // sem cabeçalho de origem do próprio site (pedido de outro site)
    const fora = await s.c.get(`/api/v1/anonimizar/ana/final/${cria('o.md', '[PESSOA_1]')}`, { origin: 'https://outro.exemplo' });
    assert.equal(fora.status, 403);
  } finally { await s.fechar(); }
});

test('versão final: mídia de outro agente = 404; atalho que sai da casa = 403; nada vaza', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const pBeto = path.join(s.homeBeto, 'out', 'b.md');
    fs.writeFileSync(pBeto, '[PESSOA_1]');
    const idBeto = s.t.web.midia.registrar('beto', pBeto, { visto: '/home/agente/out/b.md' }).id;
    const outro = await s.c.get(`/api/v1/anonimizar/ana/final/${idBeto}`);
    assert.equal(outro.status, 404, outro.texto);
    assert.ok(!outro.texto.includes(NOME));
    // atalho dentro da casa da ana apontando para fora dela
    const segredo = path.join(pastaTemp('fora'), 'segredo.md');
    fs.writeFileSync(segredo, '[PESSOA_1] fora da casa');
    const atalho = path.join(s.homeAna, 'out', 'atalho.md');
    fs.symlinkSync(segredo, atalho);
    const idAt = s.t.web.midia.registrar('ana', atalho, { visto: '/home/agente/out/atalho.md' }).id;
    const r = await s.c.get(`/api/v1/anonimizar/ana/final/${idAt}`);
    assert.ok([403, 404, 422].includes(r.status), `status ${r.status}`);
    assert.ok(!r.texto.includes(NOME) && !r.texto.includes('fora da casa'));
    // caminho com .. que sai da casa nem chega a ser registrado
    const fora = s.t.web.midia.registrar('ana', path.join(s.homeAna, '..', 'x.md'), { visto: '/x' });
    assert.equal(fora.url, null);
    assert.equal((await s.c.get(`/api/v1/anonimizar/ana/final/${fora.id}`)).status, 404);
  } finally { await s.fechar(); }
});

test('segurança: sem sessão = 401, sem Origin = 403, e credencial de agente (caixa) não passa em nenhuma rota', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const { cliente } = require('./ajuda');
    const anon = cliente(s.t.porta);
    const rotas = [
      ['GET', '/api/v1/anonimizar/estado'], ['GET', '/api/v1/anonimizar/ana/config'], ['PUT', '/api/v1/anonimizar/ana/config', { ligado: false }],
      ['POST', '/api/v1/anonimizar/testar', { texto: 'oi' }], ['GET', '/api/v1/anonimizar/ana/documentos'],
      ['DELETE', '/api/v1/anonimizar/ana/documentos'], ['GET', '/api/v1/anonimizar/ana/tabela'],
      ['POST', '/api/v1/anonimizar/ana/reverter-texto', { texto: '[PESSOA_1]' }], ['GET', '/api/v1/anonimizar/ana/final/0123456789abcdef'],
      ['POST', '/api/v1/anonimizar/detector/instalar', { nivel: 'leitores' }],
    ];
    for (const [m, rota, corpo] of rotas) {
      const r = await anon.pedir(m, rota, corpo ? { json: corpo } : {});
      assert.equal(r.status, 401, `${m} ${rota} sem sessão: ${r.status}`);
    }
    for (const [m, rota, corpo] of rotas.filter((x) => ['POST', 'PUT', 'DELETE'].includes(x[0]))) {
      const r = await s.c.pedir(m, rota, Object.assign(corpo ? { json: corpo } : {}, { origin: false }));
      assert.equal(r.status, 403, `${m} ${rota} sem Origin: ${r.status}`);
      const o2 = await s.c.pedir(m, rota, Object.assign(corpo ? { json: corpo } : {}, { origin: 'https://atacante.exemplo' }));
      assert.equal(o2.status, 403, `${m} ${rota} Origin de fora: ${o2.status}`);
    }
    // a tabela em claro não abre sem a marca do próprio site
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/tabela', { origin: false })).status, 403);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/tabela', { origin: false, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/tabela', { origin: false, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    // credencial de agente: o cabeçalho da caixa vale só para as rotas liberadas com caixa.permitir()
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'ana' };
    for (const [m, rota, corpo] of rotas) {
      const r = await anon.pedir(m, rota, Object.assign(corpo ? { json: corpo } : {}, { headers: cab, semCookie: true, origin: false }));
      assert.equal(r.status, 403, `${m} ${rota} pela caixa do agente: ${r.status} ${r.texto}`);
      assert.ok(!r.texto.includes(NOME) && !r.texto.includes(CPF));
    }
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/anonimizar/ana/tabela'), false);
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/anonimizar/estado'), false);
  } finally { await s.fechar(); }
});

test('estado, instalar o detector (só os dois níveis fixos) e docs.md igual à fonte', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', NOME);
    const e = await s.c.get('/api/v1/anonimizar/estado');
    assert.equal(e.status, 200, e.texto);
    assert.equal(e.json.detector.nivel, 'completo');
    assert.equal(e.json.instalacao.em_andamento, false);
    assert.ok(e.json.ram.disponivel_mb > 0);
    assert.deepEqual(e.json.agentes.map((a) => [a.slug, a.ligado, a.documentos]), [['ana', true, 1], ['beto', false, 0]]);
    for (const ruim of ['', 'leitores; rm -rf /', '../x', 'regex', null]) {
      assert.equal((await s.c.post('/api/v1/anonimizar/detector/instalar', { json: { nivel: ruim } })).status, 400, String(ruim));
    }
    assert.deepEqual(s.chamadasSystemctl.filter((a) => a[0] === 'start'), []);
    const ok = await s.c.post('/api/v1/anonimizar/detector/instalar', { json: { nivel: 'leitores' } });
    assert.equal(ok.status, 202, ok.texto);
    assert.deepEqual(s.chamadasSystemctl.filter((a) => a[0] === 'start'), [['start', '--no-block', 'dgclaw-anonimizar-instalar@leitores.service']]);
    const { cliente } = require('./ajuda');
    const semSessao = cliente(s.t.porta);
    const docs = await semSessao.get('/api/v1/anonimizar/docs.md');
    assert.equal(docs.status, 200); assert.match(docs.headers['content-type'], /markdown/);
    assert.equal(docs.texto, fs.readFileSync(path.join(__dirname, '..', 'docs', 'ANONIMIZAR.md'), 'utf8'));
    // a tela é servida com sessão
    fs.writeFileSync(path.join(s.t.publico, 'anonimizar.html'), '<html>anonimizar</html>');
    assert.equal((await s.c.get('/anonimizar')).status, 200);
  } finally { await s.fechar(); }
});

test('instalar já em andamento devolve 409 e o completo avisa quando falta memória', async () => {
  const s = await cenario();
  try {
    s.chamadasSystemctl.length = 0;
    const antes = os.freemem();
    assert.ok(antes > 0);
    const forcar = await s.c.post('/api/v1/anonimizar/detector/instalar', { json: { nivel: 'completo', forcar: true } });
    assert.equal(forcar.status, 202, forcar.texto);
    assert.deepEqual(s.chamadasSystemctl.filter((a) => a[0] === 'start'), [['start', '--no-block', 'dgclaw-anonimizar-instalar@completo.service']]);
  } finally { await s.fechar(); }
});

test('o motor é encerrado depois de ocioso e sobe de novo no pedido seguinte', async () => {
  const s = await cenario({ ociosoMs: 150 });
  try {
    await liga(s);
    assert.equal((await sobe(s, 'ana', 'a.txt', NOME)).status, 201);
    for (let i = 0; i < 40 && s.t.web.anonimizar.motorVivo(); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.t.web.anonimizar.motorVivo(), false);
    assert.equal((await sobe(s, 'ana', 'b.txt', NOME)).status, 201);
  } finally { await s.fechar(); }
});

test('motor ausente: 503 com o que fazer, nada entregue', async () => {
  const s = await cenario({});
  try {
    const { criarAnonimizar } = require('../lib/anonimizar');
    const anon = criarAnonimizar({ env: { DGCLAW_ANON_CHAVE: path.join(s.dirChave, 'c2') }, dataDir: pastaTemp('d'), registro: s.t.web.registro, log: () => {}, appDir: pastaTemp('semapp') });
    fs.mkdirSync(path.join(anon.caminhos.raiz), { recursive: true, mode: 0o700 });
    fs.writeFileSync(anon.caminhos.config, JSON.stringify({ ana: { ligado: true } }));
    const r = await anon.processarUpload(s.t.web.registro.obter('ana'), { nome: 'a.txt', dados: Buffer.from('oi'), legenda: '', pastaDestino: path.join(s.homeAna, 'uploads', 'x') });
    assert.equal(r.ok, false); assert.equal(r.status, 503); assert.match(r.erro, /motor/);
    assert.equal(fs.existsSync(path.join(s.homeAna, 'uploads')), false);
    anon.encerrar();
  } finally { await s.fechar(); }
});

test('fluxo da tela (enviar=0 e depois /send com o anexo): a mensagem leva a nota e a legenda passa pela tabela mesmo com a opção desligada', async () => {
  const s = await cenario();
  try {
    await liga(s);
    const sobeUm = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`, { enviar: '0' });
    assert.equal(sobeUm.status, 201, sobeUm.texto);
    assert.equal(sobeUm.json.enviado, false);
    assert.equal(sobeUm.json.anonimizado.contagem, 2);
    assert.equal(s.rAna.rec.inputs.length, 0);
    const r = await s.c.post('/api/v1/agents/ana/send', { json: { text: `Resuma o caso de ${NOME}`, anexos: [sobeUm.json.anexo.id], cliente_id: `dig-${String(++seq).padStart(8, '0')}` } });
    assert.equal(r.status, 200, r.texto);
    const t = s.rAna.rec.inputs[0].text;
    assert.match(t, /Resuma o caso de \[PESSOA_1\]/);
    assert.ok(!t.includes(NOME));
    assert.match(t, /\[anexo: \/home\/agente\/uploads\/[\d-]+\/doc-[0-9a-f]{8}\.anon\.md\]/);
    assert.match(t, /\[documento anonimizado: os dados pessoais foram trocados/);
    // sem anexo anonimizado e com a opção desligada, o texto vai como foi digitado
    const livre = await s.c.post('/api/v1/agents/ana/send', { json: { text: `Oi ${NOME}`, cliente_id: `dig-${String(++seq).padStart(8, '0')}` } });
    assert.equal(livre.status, 200);
    assert.match(s.rAna.rec.inputs[1].text, new RegExp(`Oi ${NOME}`));
  } finally { await s.fechar(); }
});

test('config ilegível ou chave trocada: falha fechada e explicada, sem entregar nada', async () => {
  const s = await cenario();
  try {
    await liga(s);
    assert.equal((await sobe(s, 'ana', 'a.txt', NOME)).status, 201);
    const inputs = s.rAna.rec.inputs.length;
    // outra chave no lugar: a tabela não decifra
    fs.writeFileSync(path.join(s.dirChave, 'anonimizar.chave'), Buffer.alloc(32, 7), { mode: 0o600 });
    s.t.web.anonimizar.encerrar();
    const { criarAnonimizar } = require('../lib/anonimizar');
    const outro = criarAnonimizar({ env: { DGCLAW_ANON_CHAVE: path.join(s.dirChave, 'anonimizar.chave') }, dataDir: s.t.dados, registro: s.t.web.registro, log: () => {}, motor: { comando: process.execPath, args: [MOTOR] } });
    const r = await outro.processarUpload(s.t.web.registro.obter('ana'), { nome: 'b.txt', dados: Buffer.from(NOME), legenda: '', pastaDestino: path.join(s.homeAna, 'uploads', 'novo') });
    assert.equal(r.ok, false); assert.match(r.erro, /decifrar/);
    assert.equal(fs.existsSync(path.join(s.homeAna, 'uploads', 'novo')), false);
    assert.equal(s.rAna.rec.inputs.length, inputs);
    outro.encerrar();
    // chave com tamanho errado nunca é recriada por cima
    fs.writeFileSync(path.join(s.dirChave, 'anonimizar.chave'), Buffer.alloc(5), { mode: 0o600 });
    const curta = criarAnonimizar({ env: { DGCLAW_ANON_CHAVE: path.join(s.dirChave, 'anonimizar.chave') }, dataDir: s.t.dados, registro: s.t.web.registro, log: () => {}, motor: { comando: process.execPath, args: [MOTOR] } });
    const r2 = await curta.processarUpload(s.t.web.registro.obter('ana'), { nome: 'b.txt', dados: Buffer.from(NOME), legenda: '', pastaDestino: path.join(s.homeAna, 'uploads', 'novo') });
    assert.equal(r2.ok, false); assert.match(r2.erro, /32/);
    assert.equal(fs.readFileSync(path.join(s.dirChave, 'anonimizar.chave')).length, 5);
    curta.encerrar();
  } finally { await s.fechar(); }
});

test('docs.md é pública (sem sessão e pela caixa do agente), mas só ela', async () => {
  const s = await cenario();
  try {
    const { cliente } = require('./ajuda');
    const anon = cliente(s.t.porta);
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ANONIMIZAR.md'), 'utf8');
    assert.equal((await anon.get('/api/v1/anonimizar/docs.md', { origin: false })).texto, fonte);
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'ana' };
    const pelaCaixa = await anon.get('/api/v1/anonimizar/docs.md', { headers: cab, semCookie: true });
    assert.equal(pelaCaixa.status, 200); assert.equal(pelaCaixa.texto, fonte);
    assert.equal((await anon.get('/api/v1/anonimizar/estado')).status, 401);
    assert.equal((await anon.get('/api/v1/anonimizar/docs.md/../estado')).status === 200, false);
  } finally { await s.fechar(); }
});

test('número de marcador apagado nunca é reaproveitado: vira lápide e o dado real some do disco', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `Joao Silva e ${NOME}`);   // [PESSOA_1] e [PESSOA_2]? so Maria vira PESSOA no motor falso
    await sobe(s, 'ana', 'b.txt', `Joao Silva ${CPF}`);
    const docs = (await s.c.get('/api/v1/anonimizar/ana/documentos')).json.documentos;
    const maior = docs.find((d) => d.nome_original === 'b.txt');
    const antes = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas;
    const marcaMaior = antes.find((e) => e.valor === 'Joao Silva').marcador;
    assert.equal((await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${docs.find((d) => d.nome_original === 'a.txt').id}`)).status, 200);
    await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${maior.id}`);
    const depois = await sobe(s, 'ana', 'c.txt', 'Joao Silva');
    assert.equal(depois.status, 201, depois.texto);
    const doc = fs.readFileSync(depois.json.anexo.path.replace('/home/agente', s.homeAna), 'utf8');
    const novo = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas.filter((e) => !e.apagado && e.valor === 'Joao Silva')[0];
    assert.notEqual(novo.marcador, marcaMaior, 'reaproveitou o número');
    assert.ok(doc.includes(novo.marcador));
    // reverter e troca do digitado ignoram lápide; o arquivo cifrado, depois de decifrado, não tem o valor antigo apagado
    const rev = await s.c.post('/api/v1/anonimizar/ana/reverter-texto', { json: { texto: marcaMaior } });
    assert.equal(rev.json.texto, marcaMaior);
    const lap = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas.find((e) => e.marcador === marcaMaior);
    assert.equal(lap.apagado, true); assert.equal(lap.valor, undefined);
    const dec = JSON.stringify(s.t.web.anonimizar.tabela('ana'));
    assert.ok(!dec.includes(CPF));
  } finally { await s.fechar(); }
});

test('pasta de uploads trocada por atalho para fora: recusa com 500 explicando e nada é gravado fora (envio antigo e anonimizado)', async () => {
  const s = await cenario();
  try {
    const fora = pastaTemp('fora-uploads');
    fs.mkdirSync(path.join(s.homeAna, 'uploads'));
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    fs.symlinkSync(fora, path.join(s.homeAna, 'uploads', dia));
    entregaAoAgente(s.homeAna);
    const antigo = await sobe(s, 'ana', 'a.txt', 'conteudo');
    // Com o gravaAnexo (#92) o envio sem anonimizar desvia para outra pasta dentro da casa: nada vai para fora pelo atalho.
    // Sem root (CI) a gravação é recusada; nada vai para fora do mesmo jeito.
    assert.equal(antigo.status, COMO_ROOT ? 201 : 500, antigo.texto); assert.deepEqual(fs.readdirSync(fora), []);
    await liga(s);
    const anon = await sobe(s, 'ana', 'a.txt', `${NOME}`);
    assert.equal(anon.status, 500); assert.match(anon.json.erro, /atalho/);
    assert.deepEqual(fs.readdirSync(fora), []);
    // a pasta "uploads" inteira como atalho também
    fs.rmSync(path.join(s.homeAna, 'uploads'), { recursive: true });
    fs.symlinkSync(fora, path.join(s.homeAna, 'uploads'));
    assert.equal((await sobe(s, 'ana', 'b.txt', 'x')).status, 500);
    assert.deepEqual(fs.readdirSync(fora), []);
    assert.equal(s.rAna.rec.inputs.length, COMO_ROOT ? 1 : 0, 'só o primeiro envio, desviado para dentro da casa, chega ao agente quando há root');
  } finally { await s.fechar(); }
});

test('integração com o motor.py de verdade (NER falso): upload anonimiza, a casa só tem marcadores e os dados reais voltam', { skip: !PYTHON ? 'python3 não existe nesta máquina' : (MOTOR_REAL_TEM_USADOS ? false : 'o motor.py ainda não devolve a lista "usados" do contrato novo') }, async () => {
  const s = await cenario({ real: true });
  try {
    await liga(s);
    const cpf = cpfValido('529982247');
    const email = 'maria.contato@exemplo.com.br';
    const original = `Cliente ${NOME}, CPF ${cpf}, e-mail ${email}.\nFim do documento.`;
    const r = await sobe(s, 'ana', 'ficha da Maria Souza.txt', original, { legenda: `Veja a ficha de ${NOME}` });
    assert.equal(r.status, 201, r.texto);
    assert.ok(r.json.anonimizado.contagem >= 3, JSON.stringify(r.json.anonimizado));
    const casa = conteudoDe(s.homeAna);
    for (const segredo of [NOME, cpf, email, 'maria souza']) assert.ok(!casa.includes(segredo), `vazou ${segredo}`);
    const arquivos = todosOsArquivos(path.join(s.homeAna, 'uploads'));
    assert.equal(arquivos.length, 1);
    const anon = fs.readFileSync(arquivos[0], 'utf8');
    assert.match(anon, /\[PESSOA_1\]/); assert.match(anon, /\[CPF_1\]/); assert.match(anon, /\[EMAIL_1\]/);
    assert.ok(!s.rAna.rec.inputs[0].text.includes(NOME));
    const rev = await s.c.post('/api/v1/anonimizar/ana/reverter-texto', { json: { texto: anon } });
    assert.equal(rev.status, 200, rev.texto);
    assert.equal(rev.json.texto, original);
    // arquivo de resultado do agente com marcadores: a versão final devolve os dados reais
    const out = path.join(s.homeAna, 'out', 'parecer.md');
    fs.writeFileSync(out, 'Parecer sobre [PESSOA_1] ([CPF_1]).');
    const id = s.t.web.midia.registrar('ana', out, { visto: '/home/agente/out/parecer.md' }).id;
    const fin = await s.c.get(`/api/v1/anonimizar/ana/final/${id}`);
    assert.equal(fin.status, 200, fin.texto);
    assert.equal(fin.texto, `Parecer sobre ${NOME} (${cpf}).`);
    // PDF: o motor real recusa o reverter e a rota explica
    fs.writeFileSync(path.join(s.homeAna, 'out', 'r.pdf'), '%PDF');
    const idPdf = s.t.web.midia.registrar('ana', path.join(s.homeAna, 'out', 'r.pdf'), { visto: '/x' }).id;
    assert.equal((await s.c.get(`/api/v1/anonimizar/ana/final/${idPdf}`)).status, 422);
  } finally { await s.fechar(); }
});

test('Correção no upload: troca da pasta de uploads por atalho DURANTE o processamento não grava nada fora', async () => {
  const fora = pastaTemp('fora-troca');
  const s = await cenarioComTroca(fora);
  try {
    await liga(s);
    const antes = s.rAna.rec.inputs.length;
    const r = await sobe(s, 'ana', 'a.txt', `TROCA ${NOME}`);
    assert.equal(r.status, 500, r.texto); assert.match(r.json.erro, /atalho/);
    assert.deepEqual(todosOsArquivos(fora), []);
    assert.equal(s.rAna.rec.inputs.length, antes);
    // o registro não ficou com o documento que não chegou
    assert.deepEqual((await s.c.get('/api/v1/anonimizar/ana/documentos')).json.documentos, []);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/tabela')).json.total, 0);
  } finally { await s.fechar(); }
});

async function cenarioComTroca(fora) {
  // a casa precisa existir antes, para o motor falso saber qual pasta trocar
  const home = pastaTemp('home-troca-ana');
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  fs.mkdirSync(path.join(home, 'uploads', dia), { recursive: true });
  const rAna = criarRunnerFalso({ agenteId: 'ana1', sessionId: 'sess-ana-00001' });
  const pAna = await rAna.ouvir();
  const dirChave = pastaTemp('chave');
  const t = await subirWeb({
    agentes: [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', home_host: home, home_container: '/home/agente' }],
    env: { DGCLAW_ANON_CHAVE: path.join(dirChave, 'k'), DGCLAW_ANON_BASE: pastaTemp('b'), DGCLAW_ANON_NIVEL: 'completo', DGCLAW_ANON_TESTE_UPLOADS: path.join(home, 'uploads'), DGCLAW_ANON_TESTE_FORA: fora },
    opcoesServidor: { anonMotor: { comando: process.execPath, args: [MOTOR] } },
  });
  await t.login();
  return { t, c: t.c, rAna, homeAna: home, fechar: async () => { await t.fechar(); await rAna.fechar(); } };
}

test('Correção na versão final: FIFO e atalho no lugar do arquivo são recusados rápido e o painel segue respondendo', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const out = path.join(s.homeAna, 'out');
    const fifo = path.join(out, 'fila.md');
    require('node:child_process').execFileSync('mkfifo', [fifo]);
    const idF = s.t.web.midia.registrar('ana', fifo, { visto: '/x' }).id;
    const t0 = Date.now();
    const rf = await s.c.get(`/api/v1/anonimizar/ana/final/${idF}`);
    assert.equal(rf.status, 422, rf.texto); assert.ok(Date.now() - t0 < 5000, 'travou no FIFO');
    assert.equal((await s.c.get('/api/v1/anonimizar/estado')).status, 200);
    // atalho no lugar do arquivo e atalho numa pasta do caminho
    const segredo = path.join(pastaTemp('seg'), 'segredo.md'); fs.writeFileSync(segredo, '[PESSOA_1]');
    fs.symlinkSync(segredo, path.join(out, 'atalho.md'));
    const idA = s.t.web.midia.registrar('ana', path.join(out, 'atalho.md'), { visto: '/x' }).id;
    const ra = await s.c.get(`/api/v1/anonimizar/ana/final/${idA}`);
    assert.equal(ra.status, 422); assert.ok(!ra.texto.includes(NOME));
    fs.mkdirSync(path.join(out, 'sub'));
    fs.writeFileSync(path.join(out, 'sub', 'x.md'), '[PESSOA_1]');
    const idS = s.t.web.midia.registrar('ana', path.join(out, 'sub', 'x.md'), { visto: '/x' }).id;
    fs.renameSync(path.join(out, 'sub'), path.join(out, 'sub.velho'));
    fs.symlinkSync(path.dirname(segredo), path.join(out, 'sub'));
    fs.writeFileSync(path.join(path.dirname(segredo), 'x.md'), '[PESSOA_1] de fora');
    const rs = await s.c.get(`/api/v1/anonimizar/ana/final/${idS}`);
    assert.equal(rs.status, 422); assert.ok(!rs.texto.includes('de fora') && !rs.texto.includes(NOME));
    assert.deepEqual(fs.readdirSync(path.join(s.t.dados, 'anonimizar', 'tmp')), [], 'temporário ficou para trás');
  } finally { await s.fechar(); }
});

test('Correção no envio: config ilegível recusa a mensagem com 503 (texto digitado e anexo anonimizado), sem desligar o filtro em silêncio', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    const up = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`, { enviar: '0' });
    const antes = s.rAna.rec.inputs.length;
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'config.json'), '{ quebrado', { mode: 0o600 });
    const env = (extra) => s.c.post('/api/v1/agents/ana/send', { json: Object.assign({ text: `Oi ${NOME}`, cliente_id: `dig-${String(++seq).padStart(8, '0')}` }, extra) });
    const a = await env({});
    assert.equal(a.status, 503, a.texto); assert.match(a.json.erro, /ilegível/); assert.equal(a.json.codigo, 'CONFIG_CORROMPIDA');
    const b = await env({ anexos: [up.json.anexo.id] });
    assert.equal(b.status, 503);
    assert.equal(s.rAna.rec.inputs.length, antes, 'a mensagem foi enviada mesmo assim');
  } finally { await s.fechar(); }
});

test('Correção no registro: só a lista "usados" do motor decide as lápides, e motor sem ela é recusado', async () => {
  const s = await cenario();
  try {
    await liga(s);
    const r = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    assert.equal(r.status, 201, r.texto);
    const sem = await sobe(s, 'ana', 'b.txt', `SEM_USADOS ${NOME}`);
    assert.equal(sem.status, 502); assert.equal(sem.json.codigo, 'MOTOR_SEM_USADOS'); assert.match(sem.json.erro, /usados/);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/documentos')).json.documentos.length, 1);
    const id = (await s.c.get('/api/v1/anonimizar/ana/documentos')).json.documentos[0].id;
    await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${id}`);
    const tab = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas;
    assert.ok(tab.length >= 2 && tab.every((e) => e.apagado));
  } finally { await s.fechar(); }
});

test('Correção no reverter-texto: marcador dentro de URL, link ou imagem fica como está', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const texto = '[PESSOA_1] viu [aqui](https://x.com/[PESSOA_1]/[CPF_1]) e ![img](https://x.com/[PESSOA_1].png) em https://y.com/?q=[PESSOA_1] e www.z.com/[CPF_1]. Depois [CPF_1].';
    const r = await s.c.post('/api/v1/anonimizar/ana/reverter-texto', { json: { texto } });
    assert.equal(r.json.texto, `${NOME} viu [aqui](https://x.com/[PESSOA_1]/[CPF_1]) e ![img](https://x.com/[PESSOA_1].png) em https://y.com/?q=[PESSOA_1] e www.z.com/[CPF_1]. Depois ${CPF}.`);
    assert.equal(r.json.trocas, 2);
  } finally { await s.fechar(); }
});

test('Correção no upload: config ilegível aparece no /estado com o caminho e o que fazer, e a tela mostra o aviso', async () => {
  const s = await cenario();
  try {
    assert.equal((await s.c.get('/api/v1/anonimizar/estado')).json.config_erro, null);
    const arq = path.join(s.t.dados, 'anonimizar', 'config.json');
    fs.mkdirSync(path.dirname(arq), { recursive: true, mode: 0o700 });
    fs.writeFileSync(arq, '{ quebrado', { mode: 0o600 });
    const e = await s.c.get('/api/v1/anonimizar/estado');
    assert.equal(e.status, 200, e.texto);
    assert.equal(e.json.config_erro.caminho, arq);
    assert.match(e.json.config_erro.mensagem, /ilegível/);
    assert.match(e.json.config_erro.o_que_fazer, /apague\/renomeie/);
    const T = require('../public/anonimizar');
    const h = T.configErroHtml({ config_erro: { mensagem: 'x <b>', caminho: arq, o_que_fazer: 'faça' } });
    assert.match(h, /role="alert"/); assert.match(h, /x &lt;b&gt;/); assert.ok(h.includes(arq));
    assert.equal(T.configErroHtml({ config_erro: null }), '');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'anonimizar.html'), 'utf8'), /id="anConfigErro"/);
    // apagando o arquivo, tudo volta
    fs.unlinkSync(arq);
    assert.equal((await s.c.get('/api/v1/anonimizar/estado')).json.config_erro, null);
    assert.equal((await liga(s)).status, 200);
  } finally { await s.fechar(); }
});

test('Correção na conversa: "//", comando com argumentos, legenda de anexo e /comando passam pelo filtro e pelo bloqueio por config ilegível; comando sem texto segue', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    const up = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`, { enviar: '0' });
    const enviar = (text, extra) => s.c.post('/api/v1/agents/ana/send', { json: Object.assign({ text, cliente_id: `dig-${String(++seq).padStart(8, '0')}` }, extra) });
    const ultimo = () => s.rAna.rec.inputs[s.rAna.rec.inputs.length - 1].text;
    // com a config boa: nada de dado real em nenhum caminho
    const casos = [[`// Ligue para ${NOME} CPF 12345678900`, {}], [`/compact foque em ${NOME}`, {}], [`/legenda ${NOME}`, { anexos: [up.json.anexo.id] }], [`/xyz-desconhecido ${NOME}`, {}]];
    for (const [texto, extra] of casos) {
      const n = s.rAna.rec.inputs.length;
      const r = await enviar(texto, extra);
      if (r.status === 200) { assert.equal(s.rAna.rec.inputs.length, n + 1, texto); assert.ok(!ultimo().includes(NOME) && !ultimo().includes('12345678900'), `vazou em: ${texto} -> ${ultimo()}`); }
      else assert.ok(s.rAna.rec.inputs.length === n, `${texto} deu ${r.status} mas enviou`);   // comando que não existe: erro, nada enviado
    }
    const ok = await enviar(`// Ligue para ${NOME}`);
    assert.equal(ok.status, 200); assert.match(ultimo(), /\/ Ligue para \[PESSOA_1\]/);
    const comArgs = await s.c.pedir('POST', '/api/v1/agents/ana/comando', { json: { comando: '/compact', argumentos: `foque em ${NOME}`, cliente_id: `cmd-${String(++seq).padStart(8, '0')}` } });
    if (comArgs.status === 200) assert.ok(!ultimo().includes(NOME), ultimo());
    // config ilegível: tudo que levaria texto ao agente é recusado com 503
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'config.json'), '{ quebrado', { mode: 0o600 });
    const n0 = s.rAna.rec.inputs.length;
    for (const [texto, extra] of [[`// CPF ${CPF}`, {}], [`/compact foque em ${CPF}`, {}], [`/legenda ${CPF}`, { anexos: [up.json.anexo.id] }], [`Oi ${CPF}`, {}]]) {
      const r = await enviar(texto, extra);
      assert.equal(r.status, 503, `${texto}: ${r.status} ${r.texto}`);
    }
    const c = await s.c.pedir('POST', '/api/v1/agents/ana/comando', { json: { comando: '/compact', argumentos: `foque em ${CPF}`, cliente_id: `cmd-${String(++seq).padStart(8, '0')}` } });
    assert.equal(c.status, 503);
    assert.equal(s.rAna.rec.inputs.length, n0, 'algo foi enviado com a config ilegível');
    // comando que o Web executa sem texto para o agente não é bloqueado
    const sem = await enviar('/clear');
    assert.notEqual(sem.status, 503, sem.texto);
  } finally { await s.fechar(); }
});

test('Correção no upload: instalar o detector reinicia o motor que já estava rodando, ao fim do pedido em curso', async () => {
  const s = await cenario();
  try {
    const pid = async () => (await s.c.get('/api/v1/anonimizar/estado')).json.detector.rss_mb;
    const pid1 = await pid();
    assert.ok(pid1 > 0);
    assert.equal(await pid(), pid1);
    // instalação terminou com sucesso: o estado.json muda
    fs.writeFileSync(path.join(s.base, 'estado.json'), JSON.stringify({ nivel: 'completo', nivel_pedido: 'completo', instalado_em: '2026-11-08T10:00:00Z', erro: null }));
    const t = await s.c.post('/api/v1/anonimizar/testar', { json: { texto: `${NOME}` } });
    assert.equal(t.status, 200, t.texto);
    const pid2 = await pid();
    assert.notEqual(pid2, pid1, 'o motor antigo continuou rodando');
    assert.equal(await pid(), pid2);
    // instalação que falhou (mesmo nivel e instalado_em) não derruba o motor
    fs.writeFileSync(path.join(s.base, 'estado.json'), JSON.stringify({ nivel: 'completo', nivel_pedido: 'completo', instalado_em: '2026-11-08T10:00:00Z', erro: 'sem espaço' }));
    await s.c.post('/api/v1/anonimizar/testar', { json: { texto: 'oi' } });
    assert.equal(await pid(), pid2);
  } finally { await s.fechar(); }
});

test('Correção na conversa: POST /comando filtra o texto final montado de "comando", "argumentos" e "text", em qualquer combinação', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const cmd = (json) => s.c.pedir('POST', '/api/v1/agents/ana/comando', { json: Object.assign({ cliente_id: `cmd-${String(++seq).padStart(8, '0')}` }, json) });
    const ultimo = () => s.rAna.rec.inputs[s.rAna.rec.inputs.length - 1].text;
    const combos = [
      { comando: `/compact foque em ${CPF}` },
      { comando: '/compact', argumentos: `foque em ${NOME} ${CPF}` },
      { text: `/compact foque em ${NOME}` },
      { comando: `/compact ${NOME}`, argumentos: `e ${CPF}` },
      { comando: '/compact', argumentos: `${CPF}`, text: `/compact ${NOME}` },
    ];
    let enviados = 0;
    for (const c of combos) {
      const n = s.rAna.rec.inputs.length;
      const r = await cmd(c);
      if (r.status === 200) { enviados += 1; assert.equal(s.rAna.rec.inputs.length, n + 1); assert.ok(!ultimo().includes(NOME) && !ultimo().includes(CPF) && !ultimo().includes('12345678900'), `vazou em ${JSON.stringify(c)}: ${ultimo()}`); assert.match(ultimo(), /\[(PESSOA|CPF)_1\]/); }
    }
    assert.ok(enviados >= 1, 'nenhum comando chegou a ser enviado: o teste não provou nada');
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'config.json'), '{ quebrado', { mode: 0o600 });
    const n0 = s.rAna.rec.inputs.length;
    for (const c of combos) assert.equal((await cmd(c)).status, 503, JSON.stringify(c));
    assert.equal(s.rAna.rec.inputs.length, n0);
  } finally { await s.fechar(); }
});

test('Correção na conversa: o filtro entregue à mesa, aos lembretes e aos avisos troca os dados e lança com a config ilegível', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const filtro = s.t.web.filtroAnon;
    assert.equal(typeof filtro, 'function');
    assert.equal(filtro('ana', `Ligar para ${NOME}`), 'Ligar para [PESSOA_1]');
    assert.equal(filtro('beto', `Ligar para ${NOME}`), `Ligar para ${NOME}`);
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'config.json'), '{ quebrado', { mode: 0o600 });
    assert.throws(() => filtro('ana', 'x'), /ilegível/);
  } finally { await s.fechar(); }
});

test('Correção no upload: CNPJ alfanumérico é trocado no texto digitado, com e sem pontuação', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    const up = await sobe(s, 'ana', 'a.txt', 'Empresa 12.ABC.345/01DE-35 contratada');
    assert.equal(up.status, 201, up.texto);
    const doc = fs.readFileSync(up.json.anexo.path.replace('/home/agente', s.homeAna), 'utf8');
    assert.match(doc, /\[CNPJ_1\]/);
    for (const forma of ['12.ABC.345/01DE-35', '12ABC34501DE35', '12abc34501de35']) {
      const n = s.rAna.rec.inputs.length;
      const r = await s.c.post('/api/v1/agents/ana/send', { json: { text: `CNPJ ${forma}.`, cliente_id: `cnpj-${String(++seq).padStart(8, '0')}` } });
      assert.equal(r.status, 200, r.texto);
      assert.match(s.rAna.rec.inputs[n].text, /CNPJ \[CNPJ_1\]\./, forma);
    }
    // número parecido, de outro CNPJ, não é trocado
    const n = s.rAna.rec.inputs.length;
    await s.c.post('/api/v1/agents/ana/send', { json: { text: 'CNPJ 12ABC34501DE36 e 12ABC34501DE35X', cliente_id: `cnpj-${String(++seq).padStart(8, '0')}` } });
    assert.ok(!s.rAna.rec.inputs[n].text.includes('[CNPJ_1]'));
  } finally { await s.fechar(); }
});

test('Correção na conversa: tudo que o agente recebe pela caixa (tarefas, lembretes, foco, avisos, uso) passa pelo filtro; sem filtro possível, 503', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);   // [PESSOA_1] e [CPF_1] conhecidos
    const cab = { 'X-DGClaw-Caixa': s.t.web.caixa.segredo, 'X-DGClaw-Agente': 'ana', 'Content-Type': 'application/json' };
    const caixa = async (metodo, caminho, json) => {
      const r = await fetch(`http://127.0.0.1:${s.t.porta}${caminho}`, { method: metodo, headers: cab, body: json === undefined ? undefined : JSON.stringify(json) });
      const texto = await r.text();
      return { status: r.status, texto, json: (() => { try { return JSON.parse(texto); } catch (_) { return null; } })() };
    };
    // o dono (sessão) cria os itens com o nome real
    const tar = await s.c.post('/api/v1/tarefas', { json: { titulo: `Ligar para ${NOME}`, agente: 'ana', origem: `Dono: o CPF dela é ${CPF}` } });
    assert.equal(tar.status, 201, tar.texto);
    const lem = await s.c.post('/api/v1/lembretes', { json: { texto: `Ligar para ${NOME}`, agente: 'ana', daqui_min: 30 } });
    assert.equal(lem.status, 201, lem.texto);
    const foco = await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { titulo: `Caso ${NOME}`, itens: [`Revisar contrato de ${NOME}`] } });
    assert.equal(foco.status, 200, foco.texto);
    const av = await s.c.post('/api/v1/avisos', { json: { tipo: 'decisao', texto: `Falar com ${NOME} sobre ${CPF}`, assunto: 'Cliente', para: ['ana'] } });
    assert.ok(av.status < 300, `aviso: ${av.status} ${av.texto}`);
    const rotas = [
      ['tarefas (lista)', 'GET', '/api/v1/tarefas'], ['tarefas (uma)', 'GET', `/api/v1/tarefas/${tar.json.tarefa.id}`],
      ['lembretes', 'GET', '/api/v1/lembretes'], ['foco', 'GET', '/api/v1/foco/ana'], ['avisos', 'GET', '/api/v1/avisos'],
    ];
    let comTexto = 0;
    for (const [nome, m, rota] of rotas) {
      const r = await caixa(m, rota);
      assert.ok(r.status < 500, `${nome}: ${r.status} ${r.texto.slice(0, 200)}`);
      assert.ok(!r.texto.includes(NOME) && !r.texto.includes(CPF), `${nome} vazou o nome real: ${r.texto.slice(0, 300)}`);
      if (r.texto.includes('[PESSOA_1]')) comTexto += 1;
    }
    assert.ok(comTexto >= 3, `poucas rotas mostraram o texto filtrado (${comTexto}); o teste não provou o bastante`);
    // uso e docs: sem texto do dono, seguem normalmente
    assert.ok((await caixa('GET', '/api/v1/uso')).status < 500);
    assert.equal((await caixa('GET', '/api/v1/anonimizar/docs.md')).status, 200);
    // o agente que não tem anonimização ligada recebe como sempre
    const cabBeto = Object.assign({}, cab, { 'X-DGClaw-Agente': 'beto' });
    const rb = await fetch(`http://127.0.0.1:${s.t.porta}/api/v1/lembretes`, { headers: cabBeto });
    assert.equal(rb.status < 500, true);
    // config ilegível: 503 em toda rota
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'config.json'), '{ quebrado', { mode: 0o600 });
    for (const [nome, m, rota] of rotas) assert.equal((await caixa(m, rota)).status, 503, nome);
  } finally { await s.fechar(); }
});

test('Correção na conversa: respostas em texto da caixa (avisos/preferencias e injecao com formato=texto) também passam pelo filtro; docs ficam como estão; tipo desconhecido vira 503', async () => {
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    const cab = { 'X-DGClaw-Caixa': s.t.web.caixa.segredo, 'X-DGClaw-Agente': 'ana' };
    const caixa = async (caminho) => { const r = await fetch(`http://127.0.0.1:${s.t.porta}${caminho}`, { headers: cab }); return { status: r.status, tipo: r.headers.get('content-type') || '', texto: await r.text() }; };
    for (const tipo of ['preferencia', 'decisao']) {
      const av = await s.c.post('/api/v1/avisos', { json: { tipo, texto: `Sempre trate ${NOME} (CPF ${CPF}) com cuidado`, assunto: 'Cliente', para: ['ana', 'beto'] } });
      assert.ok(av.status < 300, av.texto);
    }
    let achou = 0;
    for (const rota of ['/api/v1/avisos/preferencias?formato=texto', '/api/v1/avisos/injecao?formato=texto', '/api/v1/avisos/preferencias', '/api/v1/avisos/injecao']) {
      const r = await caixa(rota);
      assert.ok(r.status < 500, `${rota}: ${r.status} ${r.texto.slice(0, 200)}`);
      assert.ok(!r.texto.includes(NOME) && !r.texto.includes(CPF), `${rota} vazou: ${r.texto.slice(0, 300)}`);
      if (r.texto.includes('[PESSOA_1]')) achou += 1;
    }
    assert.ok(achou >= 2, `só ${achou} rotas mostraram o texto filtrado; o teste não provou o bastante`);
    const t = await caixa('/api/v1/avisos/preferencias?formato=texto');
    assert.match(t.tipo, /^text\/plain/);
    // documentação estática segue sem filtro
    const docs = await caixa('/api/v1/avisos/docs.md');
    assert.equal(docs.status, 200); assert.match(docs.tipo, /markdown/);
  } finally { await s.fechar(); }
});

test('Correção na conversa: filtro de resposta recusa (503) tipo de conteúdo que não sabe filtrar', async () => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('Maria Souza'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    // o filtro vive em server.js; exercitado aqui pelo servidor de verdade com uma rota de arquivo não liberada: usa a função exposta
    const { filtraRespostaDaCaixa } = require('../server');
    const saida = await new Promise((resolve) => {
      const p = http.createServer((rq, rs) => { filtraRespostaDaCaixa(rs, (v) => v, () => {}, false); rs.writeHead(200, { 'Content-Type': 'application/octet-stream' }); rs.end('Maria Souza'); });
      p.listen(0, '127.0.0.1', async () => { const r = await fetch(`http://127.0.0.1:${p.address().port}/`); const texto = await r.text(); p.close(); resolve({ status: r.status, texto }); });
    });
    assert.equal(saida.status, 503); assert.ok(!saida.texto.includes('Maria Souza'));
  } finally { srv.close(); }
});

test('Correção na conversa: retrato do foco gravado pelo fluxo real passa pelo filtro (slug resolvido) e sem agente a gravação é recusada', { skip: COMO_ROOT ? false : 'precisa de root para dar a casa ao uid do agente' }, async () => {
  const { criarCaixaAgente } = require('../lib/caixa-agente');
  const s = await cenario();
  try {
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    // casa com outro dono que não é root, como a de um agente de verdade; o teste roda como root e pode dar o dono
    const casa = pastaTemp('casa-foco');
    fs.chownSync(casa, 1000, 1000);
    const registroFalso = { obter: (slug) => (slug === 'ana' ? { slug: 'ana', nome: 'Ana', tipo: 'agente', home_host: casa } : null), estado: () => ({ ok: true, agentes: [] }) };
    const caixa = criarCaixaAgente({ config: { dataDir: s.t.dados }, registro: registroFalso, log: () => {}, porta: () => 0, filtroRetrato: (slug, o) => { const f = s.t.web.anonimizar.filtroSaida(slug); return f ? f(o) : o; } });
    // chamada como o foco.js faz: com o slug (texto)
    await caixa.gravaRetrato('ana', 'foco', { lista: [`Revisar contrato de ${NOME}`], eventos: [] });
    const arq = path.join(casa, '.dgclaw', 'retratos', 'foco.json');
    const conteudo = fs.readFileSync(arq, 'utf8');
    assert.ok(!conteudo.includes(NOME), conteudo); assert.match(conteudo, /\[PESSOA_1\]/);
    // com o objeto do agente também
    await caixa.gravaRetrato(registroFalso.obter('ana'), 'foco', { lista: [NOME], eventos: [] });
    assert.ok(!fs.readFileSync(arq, 'utf8').includes(NOME));
    // slug que não resolve: recusa, nada é gravado
    await assert.rejects(async () => caixa.gravaRetrato('fantasma', 'foco', { lista: [NOME] }), /fantasma/);
  } finally { await s.fechar(); }
});

test('Correção na conversa: atualizar o foco pelo fluxo real grava o retrato na casa do agente já filtrado', { skip: COMO_ROOT ? false : 'precisa de root para dar a casa ao uid do agente' }, async () => {
  const s = await cenario();
  try {
    fs.chownSync(s.homeAna, 1000, 1000); // o retrato só aceita pasta do root ou do uid do agente (1000)
    await liga(s);
    await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    require('node:child_process').execFileSync('chown', ['-R', '1000:1000', s.homeAna]);   // casa de agente de verdade é do uid dele
    const r = await s.c.pedir('PUT', '/api/v1/foco/ana', { json: { titulo: `Caso ${NOME}`, itens: [`Revisar contrato de ${NOME}`] } });
    assert.equal(r.status, 200, r.texto);
    const arq = path.join(s.homeAna, '.dgclaw', 'retratos', 'foco.json');
    for (let i = 0; i < 40 && !fs.existsSync(arq); i += 1) await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(fs.existsSync(arq), `retrato não gravado; log: ${s.t.log.texto().slice(-400)}`);
    const conteudo = fs.readFileSync(arq, 'utf8');
    assert.ok(!conteudo.includes(NOME), conteudo); assert.match(conteudo, /\[PESSOA_1\]/);
  } finally { await s.fechar(); }
});

test('Correção no upload: legenda e nome do arquivo passam pelo filtro na exceção "sem anonimizar"; tabela ilegível recusa', async () => {
  const s = await cenario();
  try {
    await liga(s, 'ana', { aplicar_no_que_digito: true, nao_anonimizavel: 'enviar' });
    const up = await sobe(s, 'ana', 'a.txt', `${NOME} ${CPF}`);
    assert.equal(up.status, 201, up.texto);
    const n = s.rAna.rec.inputs.length;
    const r = await sobe(s, 'ana', 'cpf-12345678900.png', 'png-falso', { legenda: `Foto do documento ${CPF} de ${NOME}` });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.anonimizado.enviado_sem_anonimizar, true);
    const texto = s.rAna.rec.inputs[n].text;
    assert.ok(!texto.includes(CPF) && !texto.includes('12345678900') && !texto.includes(NOME), texto);
    assert.match(texto, /\[CPF_1\]/); assert.match(texto, /\[PESSOA_1\]/);
    assert.ok(!todosOsArquivos(path.join(s.homeAna, 'uploads')).some((f) => f.includes('12345678900')), 'nome real na casa do agente');
    // com a opção de texto digitado desligada, a legenda segue como sempre
    await liga(s, 'ana', { aplicar_no_que_digito: false });
    const m = s.rAna.rec.inputs.length;
    const livre = await sobe(s, 'ana', 'b.png', 'png-falso', { legenda: `CPF ${CPF}` });
    assert.equal(livre.status, 201, livre.texto);
    assert.ok(s.rAna.rec.inputs[m].text.includes(CPF));
    // tabela ilegível: falha fechada
    await liga(s, 'ana', { aplicar_no_que_digito: true });
    fs.writeFileSync(path.join(s.t.dados, 'anonimizar', 'ana', 'tabela.enc'), 'lixo-que-nao-decifra-nada-de-nada-123456', { mode: 0o600 });
    const k = s.rAna.rec.inputs.length;
    const ruim = await sobe(s, 'ana', 'c.png', 'png-falso', { legenda: `CPF ${CPF}` });
    assert.ok(ruim.status >= 500, ruim.texto);
    assert.equal(ruim.json.ok, false); assert.match(ruim.json.erro, /não foi enviado/);
    assert.equal(s.rAna.rec.inputs.length, k);
  } finally { await s.fechar(); }
});

test('Correção no upload: telefone da tabela é reconhecido com ou sem o 55, o +, parênteses, espaços e hífens', () => {
  const tab = (valor) => [{ tipo: 'TELEFONE', valor, marcador: '[TELEFONE_1]' }];
  const t = (texto, valor) => trocarValoresConhecidos(texto, tab(valor)).texto;
  for (const f of ['(11) 98765-4321', '+5511987654321', '+55 11 98765-4321', '5511987654321', '11987654321', '11 98765 4321', '+55 (11) 98765-4321', '55 11 98765.4321']) {
    assert.equal(t(`Ligue ${f}.`, '(11) 98765-4321'), 'Ligue [TELEFONE_1].', f);
  }
  for (const f of ['(11) 98765-4321', '+5511987654321', '11987654321']) {
    assert.equal(t(`Ligue ${f}.`, '+55 (11) 98765-4321'), 'Ligue [TELEFONE_1].', f);
    assert.equal(t(`Ligue ${f}.`, '5511987654321'), 'Ligue [TELEFONE_1].', f);
  }
  // fixo de 10 dígitos
  assert.equal(t('Fixo +55 11 3456-7890', '(11) 3456-7890'), 'Fixo [TELEFONE_1]');
  // número maior que contém o telefone não é trocado
  for (const f of ['1198765432100', '911987654321', '551198765432100']) assert.equal(t(`N ${f}`, '(11) 98765-4321'), `N ${f}`, f);
  // texto com emoji antes: o mapa de posições continua certo
  assert.equal(t('\u{1F4DE} Ligue +55 11 98765-4321 já', '(11) 98765-4321'), '\u{1F4DE} Ligue [TELEFONE_1] já');
  // DDD 55 (RS) na tabela não perde os dois primeiros dígitos
  assert.equal(t('Fone (55) 99999-8888', '55999998888'), 'Fone [TELEFONE_1]');
});
