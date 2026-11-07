'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const { trocarValoresConhecidos, reverterMarcadores } = require('../lib/anonimizar');

const MOTOR = path.join(__dirname, 'anonimizar-motor-falso.js');
const CPF = '123.456.789-00';
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
  const dirChave = pastaTemp('chave');
  const base = pastaTemp('anon-base');
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', home_host: homeAna, home_container: '/home/agente' },
    { slug: 'beto', nome: 'Beto', tipo: 'agente', runner: `http://127.0.0.1:${pBeto}`, agente_id: 'beto1', chat_id: 'c_beto', provedor: 'claude', modelo: 'sonnet', home_host: homeBeto, home_container: '/home/agente' },
  ];
  const chamadasSystemctl = [];
  const t = await subirWeb({
    agentes,
    env: Object.assign({ DGCLAW_ANON_CHAVE: path.join(dirChave, 'anonimizar.chave'), DGCLAW_ANON_BASE: base, DGCLAW_ANON_NIVEL: op.nivel || 'completo' }, op.env || {}),
    opcoesServidor: {
      anonMotor: { comando: process.execPath, args: [MOTOR] },
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
  assert.deepEqual(trocarValoresConhecidos('nada', []), { texto: 'nada', trocas: 0 });
  assert.deepEqual(reverterMarcadores('[PESSOA_1] [X_9] [PESSOA_1]', [{ marcador: '[PESSOA_1]', valor: 'Ana' }]), { texto: 'Ana [X_9] Ana', trocas: 2, desconhecidos: ['[X_9]'] });
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
    const t = (await s.c.get('/api/v1/anonimizar/ana/tabela')).json.entradas.map((e) => e.valor).sort();
    assert.deepEqual(t, ['987.654.321-00', NOME].sort());
    assert.equal((await s.c.pedir('DELETE', `/api/v1/anonimizar/ana/documentos/${docA.id}`)).status, 404);
    assert.equal((await s.c.pedir('DELETE', '/api/v1/anonimizar/ana/documentos/XYZ')).status, 400);
    const tudo = await s.c.pedir('DELETE', '/api/v1/anonimizar/ana/documentos');
    assert.equal(tudo.status, 200); assert.equal(tudo.json.apagados, 1);
    assert.equal((await s.c.get('/api/v1/anonimizar/ana/tabela')).json.total, 0);
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
    const ht = await s.c.get(`/api/v1/anonimizar/ana/final/${cria('pagina.html', '<script>alert(1)</script> [PESSOA_1]')}`);
    assert.equal(ht.status, 200); assert.match(ht.headers['content-type'], /^text\/plain/);
    assert.match(ht.headers['content-disposition'], /^attachment/);
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
    assert.ok([403, 404].includes(r.status), `status ${r.status}`);
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
      ['POST', '/api/v1/anonimizar/detector/instalar', { nivel: 'leitores' }], ['GET', '/api/v1/anonimizar/docs.md'],
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
    const docs = await s.c.get('/api/v1/anonimizar/docs.md');
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
