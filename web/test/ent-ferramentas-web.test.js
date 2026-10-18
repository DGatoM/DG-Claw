'use strict';
// Bloco I, lado do Web: as rotas /api/v1/ferramentas pela caixa, a auditoria, a entrega de relatório com prazo e o nível pessoal.
// O serviço de ferramentas roda de verdade num socket temporário, com o executor em Python e a base SQLite sintética.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, cliente } = require('./ajuda');
const { cenarioEnt } = require('./ent-usuarios-ajuda');
const { criarServidor } = require('../../ferramentas/servidor');
const { varrer } = require('../lib/entregas-expiram');
const { pastaFerramentas } = require('./ent-ferramentas-ajuda');

const CPF = '529.982.247-25';
const CSV = "import os\nfrom dgclaw_ferramenta import resultado, pasta_saida\nopen(os.path.join(pasta_saida(), 'resumo.csv'), 'w').write(CONTEUDO)\nresultado({'gerado': True}, registros_lidos=12, arquivo='resumo.csv')\n";

/** Cenário: Web (ana, marina e o Admin), ferramentas no ar e, se pedido, o nível com a proteção ligada. */
async function cenario(opcoes) {
  const o = opcoes || {};
  const antes = process.env.DGCLAW_AUDITORIA_ESPERA_DS;
  if (o.esperaCurtaAuditoria) process.env.DGCLAW_AUDITORIA_ESPERA_DS = '1';
  const c = await cenarioEnt({ nivel: o.nivel || 'escritorio', ajustes: o.ajustes === undefined ? { kit_sensivel: true } : o.ajustes });
  if (antes === undefined) delete process.env.DGCLAW_AUDITORIA_ESPERA_DS; else process.env.DGCLAW_AUDITORIA_ESPERA_DS = antes;
  // O Admin em container (bloco C) tem papel "admin" e por isso chega à caixa; aqui ele precisa ser recusado pelas ferramentas.
  const lista = JSON.parse(fs.readFileSync(c.s.agentesPath, 'utf8'));
  for (const a of lista.agentes) if (a.slug === 'admin') a.papel = 'admin';
  fs.writeFileSync(c.s.agentesPath, JSON.stringify(lista, null, 2));
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  p.criar('relatorio', CSV.replace('CONTEUDO', "'grupo,pessoas\\na,12\\n'"), { gera_arquivo: true, retencao_dias: 30 });
  p.criar('relatorio-vaza', CSV.replace('CONTEUDO', `'cliente,${CPF}\\n'`), { gera_arquivo: true });
  p.criar('cpf', `from dgclaw_ferramenta import resultado\nresultado({'obs': '${CPF}'}, registros_lidos=3)\n`);
  let servidor = null;
  const socket = path.join(pastaTemp('fsock'), 'f.sock');
  const guardado = process.env.DGCLAW_FERRAMENTAS_SOCK;
  process.env.DGCLAW_FERRAMENTAS_SOCK = socket;
  if (!o.semServico) {
    servidor = criarServidor({ socket, dir: p.dir, tmpBase: p.tmpBase, log: () => {} });
    await servidor.ouvir();
  }
  const ana = c.agentes.find((a) => a.slug === 'ana');
  fs.mkdirSync(path.join(ana.home_host, '.dgclaw'), { recursive: true });
  const comoAgente = (slug) => {
    const cli = cliente(c.s.porta);
    const h = { 'X-DGClaw-Caixa': c.s.web.caixa.segredo, 'X-DGClaw-Agente': slug };
    return {
      post: (rota, json) => cli.pedir('POST', rota, { json, headers: h, origin: false }),
      get: (rota) => cli.pedir('GET', rota, { headers: h, origin: false }),
    };
  };
  const fechar = async () => {
    if (servidor) await servidor.fechar();
    await c.fechar();
    if (guardado === undefined) delete process.env.DGCLAW_FERRAMENTAS_SOCK; else process.env.DGCLAW_FERRAMENTAS_SOCK = guardado;
  };
  const usadas = () => c.eventos().filter((e) => e.evento === 'ferramenta_usada');
  return { c, p, ana, comoAgente, fechar, usadas, entregas: () => path.join(ana.home_host, '.dgclaw', 'entregas') };
}

const RESUMO = { params: { periodo: '2026-09', agrupar_por: 'faixa_etaria' } };

test('agente listado executa pela caixa e recebe o resultado agregado; a auditoria registra o acesso sem o dado', async () => {
  const k = await cenario();
  try {
    const ana = k.comoAgente('ana');
    const lista = await ana.get('/api/v1/ferramentas');
    assert.equal(lista.status, 200, lista.texto);
    assert.deepEqual(lista.json.ferramentas.map((f) => f.nome).sort(), ['cpf', 'relatorio', 'relatorio-vaza', 'carteira.resumo'].sort());
    assert.equal(lista.texto.includes('credenciais'), false);
    const r = await ana.post('/api/v1/ferramentas/carteira.resumo', RESUMO);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.verificador, 'aprovado');
    assert.equal(r.json.resultado.grupos.find((g) => g.grupo === '60+').pessoas, 'menos de 10');
    for (const s of k.p.segredos()) assert.equal(r.texto.includes(s), false);
    const ev = k.usadas();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].quem, 'agente:ana');
    assert.equal(ev[0].origem, 'ferramentas');
    assert.equal(ev[0].dados.ferramenta, 'carteira.resumo');
    assert.equal(ev[0].dados.decisao, 'liberado');
    assert.equal(ev[0].dados.registros_lidos, 60);
    assert.match(ev[0].dados.hash_resultado, /^[0-9a-f]{64}$/);
    assert.equal(typeof ev[0].dados.duracao_ms, 'number');
    assert.deepEqual(ev[0].dados.parametros, RESUMO.params);
    const linhaCrua = JSON.stringify(ev[0]);
    assert.equal(linhaCrua.includes('menos de'), false, 'o resultado não vai para a trilha');
    for (const s of k.p.segredos()) assert.equal(linhaCrua.includes(s), false);
  } finally { await k.fechar(); }
});

test('agente que não está na lista da ferramenta recebe 403, e não vê a ferramenta na listagem', async () => {
  const k = await cenario();
  try {
    const marina = k.comoAgente('marina');
    assert.deepEqual((await marina.get('/api/v1/ferramentas')).json.ferramentas, []);
    const r = await marina.post('/api/v1/ferramentas/carteira.resumo', RESUMO);
    assert.equal(r.status, 403, r.texto);
    assert.equal(r.json.motivo, 'agente_nao_autorizado');
    const ev = k.usadas();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].dados.decisao, 'recusado');
    assert.equal(ev[0].dados.motivo, 'agente_nao_autorizado');
  } finally { await k.fechar(); }
});

test('Admin, navegador (TI) e quem não tem sessão não usam as ferramentas', async () => {
  const k = await cenario();
  try {
    assert.equal((await k.comoAgente('admin').post('/api/v1/ferramentas/carteira.resumo', RESUMO)).status, 403);
    assert.equal((await k.comoAgente('admin').get('/api/v1/ferramentas')).status, 403);
    const ti = (await k.c.entrar('dono', k.c.senhaTi)).cli;
    const r = await ti.get('/api/v1/ferramentas');
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /só pelos agentes|só dos agentes|usadas só pelos agentes/);
    assert.equal((await ti.post('/api/v1/ferramentas/carteira.resumo', RESUMO)).status, 403);
    assert.equal((await cliente(k.c.s.porta).get('/api/v1/ferramentas')).status, 401);
  } finally { await k.fechar(); }
});

test('parâmetro fora do esquema volta 400 com o motivo; ferramenta que não existe volta 404; método errado volta 405', async () => {
  const k = await cenario();
  try {
    const ana = k.comoAgente('ana');
    const a = await ana.post('/api/v1/ferramentas/carteira.resumo', { params: { periodo: '2026-09', agrupar_por: 'cpf' } });
    assert.equal(a.status, 400);
    assert.equal(a.json.motivo, 'parametros');
    assert.match(a.json.erro, /precisa ser um destes: faixa_etaria, plano/);
    assert.equal((await ana.post('/api/v1/ferramentas/carteira.resumo', { params: { periodo: '2026-09', sql: 'SELECT 1' } })).status, 400);
    assert.equal((await ana.post('/api/v1/ferramentas/nao.existe', {})).status, 404);
    assert.equal((await ana.post('/api/v1/ferramentas/..%2Fx', {})).status, 404);
    assert.equal((await ana.get('/api/v1/ferramentas/carteira.resumo')).status, 405);
    assert.equal((await ana.post('/api/v1/ferramentas', {})).status, 405);
  } finally { await k.fechar(); }
});

test('resultado bloqueado pelo verificador volta 422 sem o dado, e a auditoria guarda o motivo e os tipos, nunca o dado', async () => {
  const k = await cenario();
  try {
    const r = await k.comoAgente('ana').post('/api/v1/ferramentas/cpf', { params: {} });
    assert.equal(r.status, 422, r.texto);
    assert.equal(r.json.motivo, 'bloqueado_pelo_verificador');
    assert.match(r.json.erro, /bloqueado porque continha dado pessoal \(tipo CPF\)/);
    assert.equal(r.texto.includes('529'), false);
    const ev = k.usadas();
    assert.equal(ev[0].dados.decisao, 'bloqueado');
    assert.deepEqual(ev[0].dados.tipos, ['cpf']);
    assert.equal(ev[0].dados.hash_resultado, null, 'hash de resultado bloqueado poderia ser quebrado por força bruta (CPF tem pouco espaço)');
    assert.equal(ev[0].dados.registros_lidos, 3);
    assert.equal(JSON.stringify(ev).includes('529'), false);
  } finally { await k.fechar(); }
});

test('relatório em arquivo vai para a pasta de entregas com .expira e a varredura apaga no prazo', async () => {
  const k = await cenario();
  try {
    const r = await k.comoAgente('ana').post('/api/v1/ferramentas/relatorio', { params: {} });
    assert.equal(r.status, 200, r.texto);
    assert.match(r.json.arquivo.caminho, /^\/home\/ana\/\.dgclaw\/entregas\/\d{8}T\d{6}-resumo\.csv$/);
    const nome = path.basename(r.json.arquivo.caminho);
    const arq = path.join(k.entregas(), nome);
    assert.equal(fs.readFileSync(arq, 'utf8'), 'grupo,pessoas\na,12\n');
    assert.equal((fs.statSync(arq).mode & 0o777), 0o600);
    const expira = fs.readFileSync(`${arq}.expira`, 'utf8').trim();
    assert.equal(expira, r.json.arquivo.expira_em);
    const dias = (Date.parse(expira) - k.c.tempo.ms()) / 86400000;
    assert.ok(Math.abs(dias - 30) < 0.01, `prazo de 30 dias (deu ${dias})`);
    assert.equal(k.usadas()[0].dados.arquivo, nome);

    const log = [];
    const cedo = varrer({ agentes: k.c.agentes, agora: k.c.tempo.ms() + 29 * 86400000, log: (n, m) => log.push(m) });
    assert.deepEqual(cedo, { apagadas: 0, orfas: 0, erros: 0 });
    assert.ok(fs.existsSync(arq));
    const tarde = varrer({ agentes: k.c.agentes, agora: k.c.tempo.ms() + 31 * 86400000, log: (n, m) => log.push(m) });
    assert.deepEqual(tarde, { apagadas: 1, orfas: 0, erros: 0 });
    assert.equal(fs.existsSync(arq), false);
    assert.equal(fs.existsSync(`${arq}.expira`), false);
    assert.deepEqual(log, []);
  } finally { await k.fechar(); }
});

test('relatório com dado pessoal dentro do arquivo é bloqueado e nada é gravado na pasta de entregas', async () => {
  const k = await cenario();
  try {
    const r = await k.comoAgente('ana').post('/api/v1/ferramentas/relatorio-vaza', { params: {} });
    assert.equal(r.status, 422, r.texto);
    assert.equal(fs.existsSync(k.entregas()), false);
  } finally { await k.fechar(); }
});

test('varredura: marca sem data, atalho no lugar da pasta de entregas e órfão', async () => {
  const k = await cenario();
  try {
    const pasta = k.entregas();
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, 'a.csv.expira'), 'isto nao e data\n');
    fs.writeFileSync(path.join(pasta, 'a.csv'), 'x');
    fs.writeFileSync(path.join(pasta, 'orfa.csv.expira'), '2020-01-01T00:00:00Z\n');
    const log = [];
    const r = varrer({ agentes: k.c.agentes, agora: k.c.tempo.ms(), log: (n, m) => log.push(m) });
    assert.deepEqual(r, { apagadas: 0, orfas: 1, erros: 1 });
    assert.ok(fs.existsSync(path.join(pasta, 'a.csv')), 'sem data válida o relatório fica');
    assert.ok(log.some((m) => /não tem uma data ISO válida/.test(m)));
    fs.rmSync(pasta, { recursive: true });
    const alvo = pastaTemp('alvo');
    fs.writeFileSync(path.join(alvo, 'x.expira'), '2020-01-01T00:00:00Z\n');
    fs.writeFileSync(path.join(alvo, 'x'), 'nao apagar');
    fs.symlinkSync(alvo, pasta);
    const r2 = varrer({ agentes: k.c.agentes, agora: k.c.tempo.ms(), log: (n, m) => log.push(m) });
    assert.equal(r2.erros, 1);
    assert.ok(fs.existsSync(path.join(alvo, 'x')), 'não entra em atalho');
    assert.ok(log.some((m) => /não é uma pasta comum/.test(m)));
  } finally { await k.fechar(); }
});

test('se a auditoria não grava, o resultado NÃO é entregue (sem registro de acesso, sem dado)', async () => {
  const k = await cenario({ esperaCurtaAuditoria: true });
  try {
    fs.mkdirSync(`${k.c.auditoriaPath}.trava`);
    const r = await k.comoAgente('ana').post('/api/v1/ferramentas/carteira.resumo', RESUMO);
    assert.equal(r.status, 503, r.texto);
    assert.equal(r.json.motivo, 'auditoria_indisponivel');
    assert.equal(r.json.resultado, undefined);
    assert.equal(r.texto.includes('menos de'), false);
  } finally { await k.fechar(); }
});

test('serviço de ferramentas fora do ar: 503 com o que fazer', async () => {
  const k = await cenario({ semServico: true });
  try {
    const r = await k.comoAgente('ana').post('/api/v1/ferramentas/carteira.resumo', RESUMO);
    assert.equal(r.status, 503, r.texto);
    assert.equal(r.json.motivo, 'ferramentas_fora');
    assert.match(r.json.erro, /systemctl status dgclaw-ferramentas/);
  } finally { await k.fechar(); }
});

test('nível sem a proteção kit_sensivel (escritório) e nível pessoal: as rotas não existem e nada é registrado', async () => {
  for (const o of [{ nivel: 'escritorio', ajustes: {} }, { nivel: 'pessoal', ajustes: {} }]) {
    const k = await cenario(o);
    try {
      const ana = k.comoAgente('ana');
      const g = await ana.get('/api/v1/ferramentas');
      assert.equal(g.status, 404, `${o.nivel}: ${g.texto}`);
      const p = await ana.post('/api/v1/ferramentas/carteira.resumo', RESUMO);
      assert.equal(p.status, 404, `${o.nivel}: ${p.texto}`);
      assert.deepEqual(k.usadas(), []);
      assert.equal(p.texto.includes('menos de'), false);
    } finally { await k.fechar(); }
  }
});

test('nível empresa liga o kit sozinho (kit_sensivel na matriz) e as rotas respondem', async () => {
  const k = await cenario({ nivel: 'empresa', ajustes: {} });
  try {
    const r = await k.comoAgente('ana').get('/api/v1/ferramentas');
    assert.equal(r.status, 200, r.texto);
  } finally { await k.fechar(); }
});
