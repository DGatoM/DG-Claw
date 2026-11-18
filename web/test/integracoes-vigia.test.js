'use strict';
// Vigia das integrações: incidentes, silêncio, lembrar, automático e rotas (web/lib/integracoes-vigia.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarIntegracoesVigia, textoDoPedido, CATEGORIAS } = require('../lib/integracoes-vigia');
const { subirWeb } = require('./ajuda');

const T0 = Date.parse('2026-11-17T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', home_host: null },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', home_host: '/x/luna' },
  { slug: 'ana', nome: 'Ana <script>alert(1)</script>', tipo: 'agente', home_host: '/x/ana' },
];
const registro = (agentes) => ({ estado: () => ({ ok: true, agentes: agentes || AGENTES }) });
const item = (extra) => Object.assign({
  id: 'whatsapp', estado: 'vermelho', ultimoEvento: iso(T0 - H), ultimoResultado: 'desconectado',
  ultimoOk: null, ultimaTentativaReal: iso(T0 - H), ultimaFalha: iso(T0 - H), ultimaFalhaResultado: 'desconectado',
}, extra || {});

/** Leitura falsa: `dados[slug] = { itens, desligadas, medido }`, que o teste muda à vontade. */
function leituraFalsa(dados) {
  return {
    lerEstado: (ag) => { const d = dados[ag.slug]; if (!d) return { medido: true, itens: [] }; return d.medido === false ? { medido: false, motivo: 'teste' } : { medido: true, itens: d.itens || [] }; },
    lerDesligadas: (ag) => (dados[ag.slug] && dados[ag.slug].desligadas !== undefined ? dados[ag.slug].desligadas : []),
  };
}
function runnerFalso(opcoes) {
  const o = opcoes || {};
  const r = { chamadas: [], input: async (agente, corpo) => { r.chamadas.push({ agente: agente.slug, corpo }); return o.falha ? { ok: false, erro: 'o terminal sumiu', ...(o.antesDoEnvio ? { antesDoEnvio: true } : {}) } : { ok: true }; } };
  return r;
}
function montar(opcoes) {
  const o = opcoes || {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-vigia-'));
  const dados = o.dados || {};
  const logs = [];
  const runner = o.runner || runnerFalso();
  const reg = o.registro || registro();
  const criar = () => criarIntegracoesVigia({ dataDir, registro: reg, runner, log: (n, m) => logs.push(`[${n}] ${m}`), agora: () => T0, leitura: leituraFalsa(dados), ...(o.extra || {}) });
  return { dataDir, dados, logs, runner, criar, v: criar(), limpa: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('elegibilidade: vermelho com tentativa real há 8 dias não abre; nova tentativa abre', async () => {
  const t = montar({ dados: { luna: { itens: [item({ ultimaTentativaReal: iso(T0 - 8 * D), ultimoEvento: iso(T0 - 8 * D) })] } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.visiveis(T0).length, 0);
    assert.equal(t.v.estado().incidentes.length, 0);
    t.dados.luna.itens = [item({ ultimaTentativaReal: iso(T0 - H), ultimoEvento: iso(T0 - H) })];
    await t.v.reavaliar(T0);
    assert.equal(t.v.visiveis(T0).length, 1);
    // sem tentativa real, vale o último evento
    t.dados.luna.itens = [item({ ultimaTentativaReal: null, ultimoEvento: iso(T0 - 9 * D), id: 'groq' })];
    await t.v.reavaliar(T0);
    assert.equal(t.v.visiveis(T0).filter((i) => i.integracao === 'groq').length, 0);
  } finally { t.limpa(); }
});

test('deduplicação: duas reavaliações dão um incidente com o mesmo id; recarregar do disco mantém', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    await t.v.reavaliar(T0);
    const id = t.v.estado().incidentes[0].id;
    await t.v.reavaliar(T0 + 60000);
    assert.equal(t.v.estado().incidentes.length, 1);
    assert.equal(t.v.estado().incidentes[0].id, id);
    const v2 = t.criar();
    assert.equal(v2.estado().incidentes.length, 1);
    assert.equal(v2.estado().incidentes[0].id, id);
    await v2.reavaliar(T0 + 120000);
    assert.equal(v2.estado().incidentes.length, 1);
    assert.equal(v2.estado().incidentes[0].categoria, 'desconectado');
    for (const arq of ['incidentes.json']) assert.equal(fs.statSync(path.join(t.dataDir, 'integracoes', arq)).mode & 0o777, 0o600);
  } finally { t.limpa(); }
});

test('fecha ao ficar verde, ao ser desligada, ao sumir da lista e quando o agente sai do registro; amarelo mantém', async () => {
  const t = montar({ dados: { luna: { itens: [item(), item({ id: 'groq' })] } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 2);
    t.dados.luna.itens = [item({ estado: 'amarelo' }), item({ id: 'groq' })];
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 2, 'amarelo não fecha');
    assert.equal(t.v.visiveis(T0).length, 1, 'mas sai da faixa');
    t.dados.luna.itens = [item({ estado: 'verde' }), item({ id: 'groq' })];
    await t.v.reavaliar(T0);
    assert.deepEqual(t.v.estado().incidentes.map((i) => i.integracao), ['groq']);
    t.dados.luna.desligadas = ['groq'];
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 0);
    t.dados.luna = { itens: [item()] };
    await t.v.reavaliar(T0);
    t.dados.luna = { itens: [] };
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 0, 'sumiu da lista');
  } finally { t.limpa(); }
  const t2 = montar({ dados: { luna: { itens: [item()] } } });
  try {
    await t2.v.reavaliar(T0);
    assert.equal(t2.v.estado().incidentes.length, 1);
    const reg2 = registro(AGENTES.filter((a) => a.slug !== 'luna'));
    const v2 = criarIntegracoesVigia({ dataDir: t2.dataDir, registro: reg2, runner: t2.runner, log: () => {}, agora: () => T0, leitura: leituraFalsa(t2.dados) });
    await v2.reavaliar(T0);
    assert.equal(v2.estado().incidentes.length, 0, 'agente fora do registro');
  } finally { t2.limpa(); }
});

test('desligada no preferencias.json não abre; não medido não abre nem fecha', async () => {
  const t = montar({ dados: { luna: { itens: [item()], desligadas: ['whatsapp'] } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 0);
    t.dados.luna.desligadas = [];
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 1);
    t.dados.luna = { medido: false };
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 1, 'não medido não fecha');
    assert.equal(t.v.estado().naFaixaIds.size, 1, 'o incidente já aberto continua na faixa: sem medir, não se diz que se recuperou');
  } finally { t.limpa(); }
});

test('preferências ilegíveis: o agente vira não medido, sem abrir incidente novo', async () => {
  const t = montar({ dados: { luna: { itens: [item()], desligadas: null } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 0);
    await t.v.reavaliar(T0);
    const r = await chamar(t.v, 'GET', '/api/v1/integracoes', { papel: 'dono' });
    assert.deepEqual(r.json.naoMedidos, [{ agente: 'luna', agenteNome: 'Luna', motivo: 'as preferências do agente estão ilegíveis' }]);
  } finally { t.limpa(); }
});

test('categoria por tabela fixa', async () => {
  const t = montar({ dados: { luna: { itens: [
    item({ id: 'a1', ultimaFalhaResultado: 'credencial_recusada' }), item({ id: 'a2', ultimaFalhaResultado: 'sem_saldo' }),
    item({ id: 'a3', ultimaFalhaResultado: 'fora_do_ar' }), item({ id: 'a4', ultimaFalhaResultado: null, ultimoResultado: 'desconectado' }),
    item({ id: 'a5', ultimaFalhaResultado: 'rede', ultimoResultado: 'rede' }),
  ] } } });
  try {
    await t.v.reavaliar(T0);
    const cat = Object.fromEntries(t.v.estado().incidentes.map((i) => [i.integracao, i.categoria]));
    assert.deepEqual(cat, { a1: 'credencial_recusada', a2: 'sem_saldo', a3: 'fora_do_ar', a4: 'desconectado', a5: 'outra' });
  } finally { t.limpa(); }
});

test('silenciar tira da faixa e do automático; reativar traz de volta; lembrar adia 1 hora', async () => {
  const t = montar({ dados: { luna: { itens: [item(), item({ id: 'groq' })] } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.visiveis(T0).length, 2);
    t.v.silenciar('luna', 'groq');
    assert.deepEqual(t.v.visiveis(T0).map((i) => i.integracao), ['whatsapp']);
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes.length, 1, 'silenciada não reabre');
    assert.equal(t.criar().estado().silenciadas.length, 1, 'o silêncio persiste');
    assert.equal(t.v.lembrar(T0), 1);
    assert.equal(t.v.visiveis(T0 + 59 * 60000).length, 0);
    assert.equal(t.v.visiveis(T0 + H + 1).length, 1, 'passada a hora a faixa volta');
    t.v.reativar('luna', 'groq');
    await t.v.reavaliar(T0 + 2 * H);
    assert.equal(t.v.visiveis(T0 + 2 * H).length, 2);
  } finally { t.limpa(); }
});

test('automático: desligado de fábrica não envia; ligado envia 1 por incidente ao ABRIR', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 0, 'desligado não envia');
    // liga pela rota interna do estado: usa o disco como o Web faria
    t.v.parar();
    const v = ligado(t);
    t.dados.luna.itens = [item({ id: 'groq' })];
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 1);
    const c = t.runner.chamadas[0];
    assert.equal(c.agente, 'admin');
    assert.equal(c.corpo.submit, true);
    assert.equal(c.corpo.injectWhenIdle, true);
    assert.match(c.corpo.text, /Agente luna/);
    await v.reavaliar(T0 + 60000);
    assert.equal(t.runner.chamadas.length, 1, 'um por incidente');
  } finally { t.limpa(); }
});

function ligado(t) {
  fs.mkdirSync(path.join(t.dataDir, 'integracoes'), { recursive: true });
  fs.writeFileSync(path.join(t.dataDir, 'integracoes', 'automatico.json'), JSON.stringify({ ligado: true, alteradoEm: iso(T0), envios: [] }));
  return t.criar();
}

test('automático: no máximo 1 a cada 6 h por integração e 5 por dia no total', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const v = ligado(t);
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 1);
    // o incidente fecha e a integração cai de novo 2 h depois: mesmo par, dentro das 6 h
    t.dados.luna.itens = [item({ estado: 'verde' })];
    await v.reavaliar(T0 + 1 * H);
    t.dados.luna.itens = [item()];
    await v.reavaliar(T0 + 2 * H);
    assert.equal(t.runner.chamadas.length, 1, 'barrado: 6 h por integração');
    assert.ok(t.logs.some((l) => l.startsWith('[info]') && /6 horas/.test(l)), 'o motivo vai ao log como info');
    // passadas as 6 h, volta a poder
    t.dados.luna.itens = [item({ estado: 'verde' })];
    await v.reavaliar(T0 + 7 * H);
    t.dados.luna.itens = [item()];
    await v.reavaliar(T0 + 8 * H);
    assert.equal(t.runner.chamadas.length, 2);
  } finally { t.limpa(); }
  // cinco por dia no total
  const itens = Array.from({ length: 7 }, (_, i) => item({ id: `sis${i}` }));
  const t2 = montar({ dados: { luna: { itens } } });
  try {
    const v = ligado(t2);
    await v.reavaliar(T0);
    assert.equal(t2.runner.chamadas.length, 5);
    assert.ok(t2.logs.some((l) => /nas últimas 24 horas/.test(l)));
    // envios antigos (mais de 7 dias) saem do arquivo
    const arq = path.join(t2.dataDir, 'integracoes', 'automatico.json');
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    j.envios.push({ em: iso(T0 - 8 * D), agente: 'luna', integracao: 'velho', incidente: 'x' });
    fs.writeFileSync(arq, JSON.stringify(j));
    const v3 = t2.criar();
    await v3.reavaliar(T0 + 10);
    assert.ok(!JSON.parse(fs.readFileSync(arq, 'utf8')).envios.some((e) => e.integracao === 'velho'));
  } finally { t2.limpa(); }
});

test('automático: falha do runner SÓ devolve a reserva quando garante que nada foi enfileirado (antesDoEnvio)', async () => {
  // timeout (ok:false sem antesDoEnvio): incerto, mantém a reserva e loga
  const t0 = montar({ dados: { luna: { itens: [item()] } }, runner: runnerFalso({ falha: true }) });
  try {
    const v = ligado(t0);
    await v.reavaliar(T0);
    assert.equal(v.estado().automatico.envios.length, 1, 'a reserva continua');
    assert.ok(v.estado().incidentes[0].pedidoAutomaticoEm);
    assert.ok(t0.logs.some((l) => l.startsWith('[erro]') && /incerto/.test(l) && /não será reenviado/.test(l)));
  } finally { t0.limpa(); }
  const t = montar({ dados: { luna: { itens: [item()] } }, runner: runnerFalso({ falha: true, antesDoEnvio: true }) });
  try {
    const v = ligado(t);
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 1);
    assert.ok(t.logs.some((l) => l.startsWith('[erro]') && /não chegou ao runner/.test(l)));
    assert.equal(v.estado().automatico.envios.length, 0);
    assert.equal(v.estado().incidentes[0].pedidoAutomaticoEm, null);
  } finally { t.limpa(); }
});

test('automático: o runner lançar exceção ou não responder deixa o envio contado (incerto) e não reenvia', async () => {
  for (const input of [async () => { throw new Error('conexão caiu'); }, async () => undefined]) {
    const t = montar({ dados: { luna: { itens: [item()] } }, runner: { chamadas: [], input } });
    try {
      const v = ligado(t);
      await v.reavaliar(T0);
      assert.equal(v.estado().automatico.envios.length, 1, 'continua contado como enviado');
      assert.ok(v.estado().incidentes[0].pedidoAutomaticoEm);
      assert.ok(t.logs.some((l) => /incert/.test(l) && /não será reenviado/.test(l)));
      const gravado = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'integracoes', 'automatico.json'), 'utf8'));
      assert.equal(gravado.envios.length, 1, 'a reserva está no disco');
    } finally { t.limpa(); }
  }
});

test('automático: se a reserva não grava no disco, o pedido não é enviado', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const v = ligado(t);
    fs.rmSync(path.join(t.dataDir, 'integracoes', 'automatico.json'));
    fs.mkdirSync(path.join(t.dataDir, 'integracoes', 'automatico.json'));   // gravar por cima de uma pasta falha
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 0, 'não enviou');
    assert.equal(v.estado().automatico.envios.length, 0, 'a reserva foi desfeita na memória');
    assert.equal(v.estado().incidentes[0].pedidoAutomaticoEm, null);
    assert.ok(t.logs.some((l) => l.startsWith('[erro]') && /reserva/.test(l)));
  } finally { t.limpa(); }
});

test('rota /automatico: ligar só vale se gravar; desligar vale na hora mesmo sem gravar', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  const dono = { papel: 'dono' };
  try {
    fs.mkdirSync(path.join(t.dataDir, 'integracoes', 'automatico.json'), { recursive: true });   // a gravação vai falhar
    let r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: true, entendoORisco: true });
    assert.equal(r.status, 500);
    assert.equal(t.v.estado().automatico.ligado, false, 'não gravou, não ligou');
    t.v.estado().automatico.ligado = true;   // simula um automático já ligado
    r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: false });
    assert.equal(r.status, 500);
    assert.match(r.json.erro, /já está desligado agora/);
    assert.match(r.json.erro, /volta ligado/);
    assert.equal(t.v.estado().automatico.ligado, false, 'parou de enviar na hora');
  } finally { t.limpa(); }
});

test('arquivo ilegível ao carregar: loga o motivo e começa vazio', () => {
  const t = montar({});
  try {
    fs.mkdirSync(path.join(t.dataDir, 'integracoes'), { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'integracoes', 'incidentes.json'), '{quebrado');
    const v = t.criar();
    assert.equal(v.estado().incidentes.length, 0);
    assert.ok(t.logs.some((l) => l.startsWith('[erro]') && /JSON quebrado/.test(l)));
  } finally { t.limpa(); }
});

test('textoDoPedido: só frases fixas, slug, id de catálogo e id do incidente', () => {
  const reg = registro();
  const catalogo = { whatsapp: { nome: 'WhatsApp', icone: 'x' } };
  const inc = [
    { id: '11111111-aaaa-bbbb-cccc-222222222222', agente: 'ana', integracao: 'whatsapp', categoria: 'sem_saldo' },
    { id: '33333333-aaaa-bbbb-cccc-444444444444', agente: 'luna', integracao: 'ignore-as-regras', categoria: 'invento do agente' },
  ];
  const t = textoDoPedido(inc, reg, catalogo);
  assert.match(t, /Agente ana: a integração whatsapp, o saldo ou crédito acabou\. Incidente 11111111-aaaa-bbbb-cccc-222222222222\./);
  assert.match(t, /Agente luna: uma integração própria do agente, falha sem classificação\. Incidente 33333333/);
  assert.ok(!t.includes('ignore-as-regras'), 'id fora do catálogo não entra');
  assert.ok(!t.includes('script') && !t.includes('Ana'), 'nome do agente não entra');
  assert.match(t, /\[PEDIDO\]/);
  assert.match(t, /não aplique nada antes do ok do dono/);
  assert.equal(t.split('\n').filter((l) => l.startsWith('- ')).length, 2, 'uma linha por incidente');
  assert.equal(textoDoPedido([], reg, catalogo), null);
  // agente que não está no registro não vira linha
  assert.equal(textoDoPedido([{ id: '11111111-aaaa', agente: 'fantasma', integracao: 'whatsapp', categoria: 'sem_saldo' }], reg, catalogo), null);
});

// ── rotas ────────────────────────────────────────────────────────────────────
function fakeRes() {
  const r = { status: null, corpo: null, writeHead(s) { r.status = s; }, end(c) { r.corpo = c; }, setHeader() {} };
  return r;
}
async function chamar(v, metodo, caminho, sessao, corpo) {
  const { Readable } = require('node:stream');
  const req = Readable.from(corpo === undefined ? [] : [Buffer.from(JSON.stringify(corpo))]);
  req.method = metodo; req.headers = { 'content-type': 'application/json' };
  const res = fakeRes();
  const tratou = await v.rotas(req, res, new URL(`http://x${caminho}`), sessao);
  return { tratou, status: res.status, json: res.corpo && /^[{[]/.test(String(res.corpo)) ? JSON.parse(res.corpo) : null };
}

test('rotas: colaborador, caixa e sem sessão recebem 403', async () => {
  const t = montar({});
  try {
    for (const s of [null, { via: 'caixa' }, { papel: 'colaborador', agente: 'luna' }]) {
      for (const [m, p] of [['GET', '/api/v1/integracoes'], ['POST', '/api/v1/integracoes/lembrar'], ['POST', '/api/v1/integracoes/silenciar'], ['POST', '/api/v1/integracoes/reativar'], ['POST', '/api/v1/integracoes/automatico'], ['GET', '/api/v1/integracoes/docs.md']]) {
        const r = await chamar(t.v, m, p, s, {});
        assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(s)}`);
      }
    }
    const r = await chamar(t.v, 'GET', '/api/v1/integracoes', { papel: 'dono' });
    assert.equal(r.status, 200);
  } finally { t.limpa(); }
});

test('rotas: ligar sem entendoORisco = 400; com ele liga; desligar é direto; silenciar valida o par', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  const dono = { papel: 'dono' };
  try {
    let r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: true });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /entendoORisco/);
    r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: 'sim' });
    assert.equal(r.status, 400);
    r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: true, entendoORisco: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.automatico.ligado, true);
    assert.equal(fs.statSync(path.join(t.dataDir, 'integracoes', 'automatico.json')).mode & 0o777, 0o600);
    await t.v.reavaliar(T0);   // o GET só devolve a última avaliação
    r = await chamar(t.v, 'GET', '/api/v1/integracoes', dono);
    assert.equal(r.json.automatico.ligado, true);
    assert.equal(r.json.faixa.length, 1);
    assert.equal(r.json.faixa[0].integracaoNome, 'WhatsApp');
    assert.equal(typeof r.json.pedido, 'string');
    r = await chamar(t.v, 'POST', '/api/v1/integracoes/automatico', dono, { ligado: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.automatico.ligado, false);
    // silenciar
    assert.equal((await chamar(t.v, 'POST', '/api/v1/integracoes/silenciar', dono, { agente: '../x', integracao: 'whatsapp' })).status, 400);
    assert.equal((await chamar(t.v, 'POST', '/api/v1/integracoes/silenciar', dono, { agente: 'fantasma', integracao: 'whatsapp' })).status, 404);
    assert.equal((await chamar(t.v, 'POST', '/api/v1/integracoes/silenciar', dono, { agente: 'luna', integracao: 'whatsapp' })).status, 200);
    r = await chamar(t.v, 'GET', '/api/v1/integracoes', dono);
    assert.equal(r.json.faixa.length, 0);
    assert.deepEqual(r.json.silenciadas, [{ agente: 'luna', integracao: 'whatsapp' }]);
    assert.equal((await chamar(t.v, 'POST', '/api/v1/integracoes/reativar', dono, { agente: 'luna', integracao: 'whatsapp' })).status, 200);
    await t.v.reavaliar(T0);
    r = await chamar(t.v, 'GET', '/api/v1/integracoes', dono);
    assert.equal(r.json.faixa.length, 1);
    r = await chamar(t.v, 'POST', '/api/v1/integracoes/lembrar', dono, {});
    assert.equal(r.json.adiados, 1);
    assert.equal((await chamar(t.v, 'GET', '/api/v1/integracoes/lembrar', dono)).status, 405);
    assert.equal((await chamar(t.v, 'GET', '/api/v1/integracoes/nada', dono)).status, 404);
    assert.equal(fs.statSync(path.join(t.dataDir, 'integracoes', 'incidentes.json')).mode & 0o777, 0o600);
  } finally { t.limpa(); }
});

test('servidor inteiro: sem sessão 401, POST sem Origin recusado e docs.md servido', async () => {
  const w = await subirWeb({ agentes: [{ slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'admin' }, { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna', home_host: '/nao/existe' }] });
  try {
    assert.equal((await w.c.get('/api/v1/integracoes')).status, 401);
    await w.login();
    const g = await w.c.get('/api/v1/integracoes');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.faixa, []);
    assert.equal(g.json.naoMedidos.length, 1, 'casa inexistente é não medido, nunca verde');
    for (const p of ['lembrar', 'silenciar', 'reativar', 'automatico']) {
      const r = await w.c.post(`/api/v1/integracoes/${p}`, { json: { ligado: false, agente: 'luna', integracao: 'x' }, origin: false });
      assert.equal(r.status, 403, `${p} sem Origin`);
      const r2 = await w.c.post(`/api/v1/integracoes/${p}`, { json: {}, origin: 'http://outro.exemplo' });
      assert.equal(r2.status, 403, `${p} com Origin errado`);
    }
    const d = await w.c.get('/api/v1/integracoes/docs.md');
    assert.equal(d.status, 200);
    assert.match(d.texto, /Integrações com defeito/);
  } finally { await w.fechar(); }
});

test('anonimização: o pedido automático passa pelo filtro do /send, com o slug do Admin, antes da reserva', async () => {
  const chamadasFiltro = [];
  const filtro = (slug, texto) => { chamadasFiltro.push(slug); return texto.replace('Agente luna', 'Agente PESSOA-1'); };
  const t = montar({ dados: { luna: { itens: [item()] } }, extra: { filtro } });
  try {
    const v = ligado(t);
    await v.reavaliar(T0);
    assert.deepEqual(chamadasFiltro, ['admin']);
    assert.equal(t.runner.chamadas.length, 1);
    assert.match(t.runner.chamadas[0].corpo.text, /Agente PESSOA-1/);
    assert.doesNotMatch(t.runner.chamadas[0].corpo.text, /Agente luna/);
  } finally { t.limpa(); }
});

test('anonimização: se o filtro lança, não envia, não reserva e loga', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } }, extra: { filtro: () => { throw new Error('tabela ilegível'); } } });
  try {
    const v = ligado(t);
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 0);
    assert.equal(v.estado().automatico.envios.length, 0);
    assert.equal(v.estado().incidentes[0].pedidoAutomaticoEm, null);
    assert.ok(t.logs.some((l) => l.startsWith('[erro]') && /filtro de anonimização falhou/.test(l) && /tabela ilegível/.test(l)));
  } finally { t.limpa(); }
});

test('incidentes.json existe mas está ruim: guarda cópia, suspende o automático até o dono mexer no interruptor', async () => {
  for (const ruim of ['{quebrado', JSON.stringify({ versao: 1, outraCoisa: true })]) {
    const t = montar({ dados: { luna: { itens: [item()] } } });
    try {
      const dir = path.join(t.dataDir, 'integracoes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'incidentes.json'), ruim);
      fs.writeFileSync(path.join(dir, 'incidentes.json.corrompido'), 'cópia antiga');
      fs.writeFileSync(path.join(dir, 'automatico.json'), JSON.stringify({ ligado: true, alteradoEm: iso(T0), envios: [] }));
      const v = t.criar();
      assert.equal(fs.readFileSync(path.join(dir, 'incidentes.json.corrompido'), 'utf8'), ruim, 'a cópia nova sobrescreve a antiga');
      await v.reavaliar(T0);
      assert.equal(t.runner.chamadas.length, 0, 'suspenso: não envia');
      assert.ok(t.logs.some((l) => /suspenso/.test(l) && /incidentes\.json/.test(l)));
      // o incidente foi aberto e gravado por cima, mas a cópia do arquivo ruim continua
      assert.equal(fs.readFileSync(path.join(dir, 'incidentes.json.corrompido'), 'utf8'), ruim);
      // o dono mexe no interruptor: volta ao normal
      const r = await chamar(v, 'POST', '/api/v1/integracoes/automatico', { papel: 'dono' }, { ligado: true, entendoORisco: true });
      assert.equal(r.status, 200);
      t.dados.luna.itens = [item({ id: 'groq' })];
      await v.reavaliar(T0 + 60000);
      assert.equal(t.runner.chamadas.length, 1, 'depois de mexer no interruptor, envia');
    } finally { t.limpa(); }
  }
  // ausente = primeira instalação: segue normal e sem cópia
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const v = ligado(t);
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 1);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'integracoes', 'incidentes.json.corrompido')));
  } finally { t.limpa(); }
});

test('se nem a suspensão pôde ser gravada, o incidentes.json ruim não é regravado até o dono mexer no interruptor', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const dir = path.join(t.dataDir, 'integracoes');
    fs.mkdirSync(path.join(dir, 'automatico.json'), { recursive: true });   // pasta no lugar do arquivo: a gravação falha
    fs.writeFileSync(path.join(dir, 'incidentes.json'), '{quebrado');
    const v = t.criar();
    await v.reavaliar(T0);
    assert.equal(t.runner.chamadas.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'incidentes.json'), 'utf8'), '{quebrado', 'o arquivo ruim continua como estava');
    assert.ok(t.logs.some((l) => /suspensão do automático não foi gravada/.test(l)));
  } finally { t.limpa(); }
});

test('suspensão por incidentes.json ruim sobrevive a um segundo início, mesmo com o arquivo já regravado', async () => {
  const t = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const dir = path.join(t.dataDir, 'integracoes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'incidentes.json'), '{quebrado');
    fs.writeFileSync(path.join(dir, 'automatico.json'), JSON.stringify({ ligado: true, alteradoEm: iso(T0), envios: [] }));
    const v1 = t.criar();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'automatico.json'), 'utf8')).suspenso, true, 'a suspensão já está no disco antes de regravar o incidentes.json');
    await v1.reavaliar(T0);   // regrava o incidentes.json, agora válido
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'incidentes.json'), 'utf8')));
    assert.equal(t.runner.chamadas.length, 0);
    // segundo início, no mesmo dataDir, com incidente novo
    const v2 = t.criar();
    t.dados.luna.itens = [item({ id: 'groq' })];
    await v2.reavaliar(T0 + 60000);
    assert.equal(t.runner.chamadas.length, 0, 'continua suspenso: o arquivo bom não limpa a suspensão');
    // só o dono, no interruptor, limpa
    const r = await chamar(v2, 'POST', '/api/v1/integracoes/automatico', { papel: 'dono' }, { ligado: true, entendoORisco: true });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'automatico.json'), 'utf8')).suspenso, false);
    t.dados.luna.itens = [item({ id: 'openai' })];
    await v2.reavaliar(T0 + 120000);
    assert.equal(t.runner.chamadas.length, 1);
  } finally { t.limpa(); }
});

test('instância: slug reaproveitado com instância nova não herda incidente nem silêncio; registro antigo adota a atual', async () => {
  const inst = { luna: 'i:um' };
  const t = montar({ dados: { luna: { itens: [item()] } }, extra: { instancia: (a) => inst[a.slug] || null } });
  try {
    await t.v.reavaliar(T0);
    assert.equal(t.v.estado().incidentes[0].instancia, 'i:um', 'o incidente guarda a instância');
    t.v.silenciar('luna', 'groq');
    assert.equal(t.v.estado().silenciadas[0].instancia, 'i:um');
    // o agente é removido e recriado com o mesmo slug: instância nova
    inst.luna = 'i:dois';
    t.dados.luna.itens = [];
    await t.v.reavaliar(T0 + 60000);
    assert.equal(t.v.estado().incidentes.length, 0, 'o incidente do agente antigo some');
    assert.equal(t.v.estado().silenciadas.length, 0, 'o silêncio do agente antigo não é herdado');
  } finally { t.limpa(); }
  // registro antigo (sem instância) adota a atual na primeira reavaliação
  const t2 = montar({ dados: { luna: { itens: [item()] } } });
  try {
    const dir = path.join(t2.dataDir, 'integracoes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'incidentes.json'), JSON.stringify({ versao: 1, incidentes: [], silenciadas: [{ agente: 'luna', integracao: 'groq' }] }));
    const v = criarIntegracoesVigia({ dataDir: t2.dataDir, registro: registro(), runner: t2.runner, log: () => {}, agora: () => T0, leitura: leituraFalsa(t2.dados), instancia: () => 'i:atual' });
    await v.reavaliar(T0);
    assert.deepEqual(v.estado().silenciadas, [{ agente: 'luna', integracao: 'groq', instancia: 'i:atual' }]);
  } finally { t2.limpa(); }
});

test('pedido manual longo: no máximo 9 linhas, com a frase fixa do excedente, e cabe nos 2.000 caracteres do ?texto= da conversa', () => {
  const slug = 'a'.repeat(32);
  const integ = 'x'.repeat(32);
  const reg = { estado: () => ({ agentes: [{ slug, nome: 'A', tipo: 'agente' }] }) };
  const cat = { [integ]: { nome: 'N' } };
  const inc = (n, categoria) => Array.from({ length: n }, () => ({ id: 'a'.repeat(40), agente: slug, integracao: integ, categoria }));
  const pior = textoDoPedido(inc(9, 'desconectado'), reg, cat);
  assert.equal(pior.split('\n').filter((l) => l.startsWith('- ')).length, 9);
  assert.doesNotMatch(pior, /e mais/);
  const longo = textoDoPedido(inc(25, 'desconectado'), reg, cat);
  assert.equal(longo.split('\n').filter((l) => l.startsWith('- ')).length, 9);
  assert.ok(longo.endsWith('e mais 16 integrações com defeito; a lista completa está na faixa do painel.'));
  assert.ok(textoDoPedido(inc(10, 'desconectado'), reg, cat).endsWith('e mais 1 integração com defeito; a lista completa está na faixa do painel.'));
  // web/public/conversa.js corta o ?texto= em 2000 caracteres: o pior caso de cada categoria tem que caber
  for (const categoria of Object.keys(CATEGORIAS)) {
    const t = textoDoPedido(inc(500, categoria), reg, cat);
    assert.ok(t.length <= 2000, `com a categoria ${categoria} o pedido tem ${t.length} caracteres`);
  }
});
