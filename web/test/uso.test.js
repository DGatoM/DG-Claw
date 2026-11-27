'use strict';
// Uso da assinatura: GET /api/v1/uso (junta o runner de cada agente), a doc e as peças do menu ☰.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const M = require('../public/menu-lado');

const EM_BREVE = new Date(Date.now() + 3 * 3600_000).toISOString();
const PASSADO = new Date(Date.now() - 3600_000).toISOString();
const USO_ANA = { provedor: 'claude', sessao_5h: { usado_pct: 42.5, zera_em: EM_BREVE, vencida: false }, semanal: { usado_pct: 0, zera_em: EM_BREVE, vencida: false }, plano: null, medido_em: new Date().toISOString(), fonte: 'statusline' };

async function cenario(opAna, opBia, opWeb) {
  const rAna = criarRunnerFalso(Object.assign({ agenteId: 'ana1' }, opAna));
  const rBia = criarRunnerFalso(Object.assign({ agenteId: 'bia1' }, opBia));
  const pAna = await rAna.ouvir(); const pBia = await rBia.ouvir();
  const agentes = [
    { slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${pAna}`, agente_id: 'ana1', home_host: pastaTemp('home') },
    { slug: 'bia', nome: 'Bia', tipo: 'agente', runner: `http://127.0.0.1:${pBia}`, agente_id: 'bia1', home_host: pastaTemp('home') },
  ];
  const t = await subirWeb({ agentes, opcoesServidor: opWeb });
  await t.login();
  return { t, rAna, rBia, fechar: async () => { await t.fechar(); await rAna.fechar(); await rBia.fechar(); } };
}

test('GET /api/v1/uso sem sessão: 401', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await cliente(s.t.porta).get('/api/v1/uso');
    assert.equal(r.status, 401);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: um agente medido, outro nunca medido (null, nunca 0) e o motivo vem junto', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.deepEqual(Object.keys(r.json.agentes).sort(), ['ana', 'bia']);
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.equal(r.json.agentes.ana.uso.semanal.usado_pct, 0, 'zero medido continua zero');
    assert.equal(r.json.agentes.bia.uso.sessao_5h, null);
    assert.equal(r.json.agentes.bia.uso.semanal, null);
    assert.match(r.json.agentes.bia.motivo, /próxima resposta do agente/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso pela caixa de um agente: só o uso dele, nunca o dos outros', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/uso'), true);
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'bia' };
    const r = await cliente(s.t.porta).pedir('GET', '/api/v1/uso', { headers: cab });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(Object.keys(r.json.agentes), ['bia']);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: um runner com erro vira erro só dele, e os outros seguem', async () => {
  const s = await cenario({ uso: USO_ANA }, { falhaUso: { status: 500, corpo: { success: false, error: 'o medidor quebrou', howToFix: 'reiniciar o runner' } } });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.status, 200);
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.equal(r.json.agentes.bia.uso, null);
    assert.match(r.json.agentes.bia.erro, /o medidor quebrou/);
    assert.match(r.json.agentes.bia.erro, /reiniciar o runner/);
    assert.match(s.t.log.texto(), /Uso da assinatura de Bia/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: runner antigo (404 sem code) e runner fora do ar explicam o que fazer', async () => {
  const s = await cenario({ uso: USO_ANA }, { falhaUso: { status: 404, corpo: { success: false, error: 'Not found' } } });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.match(r.json.agentes.bia.erro, /versão antiga/);
    await s.rBia.fechar();
    const r2 = await s.t.c.get('/api/v1/uso');
    assert.equal(r2.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.match(r2.json.agentes.bia.erro, /Confira se o serviço do agente está rodando/);
  } finally { await s.t.fechar(); await s.rAna.fechar(); }
});

test('GET /api/v1/uso: runner lento estoura o prazo e não segura a resposta dos outros', async () => {
  const s = await cenario({ uso: USO_ANA }, { uso: USO_ANA, atrasoUsoMs: 1500 }, { timeoutUsoMs: 200 });
  try {
    const antes = Date.now();
    const r = await s.t.c.get('/api/v1/uso');
    assert.ok(Date.now() - antes < 1400, 'não esperou o runner lento até o fim');
    assert.equal(r.json.agentes.ana.uso.sessao_5h.usado_pct, 42.5);
    assert.match(r.json.agentes.bia.erro, /não (respondeu|terminou de responder)/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso: janela vencida passa adiante com vencida:true; método errado é 405', async () => {
  const vencida = Object.assign({}, USO_ANA, { sessao_5h: { usado_pct: 99, zera_em: PASSADO, vencida: true } });
  const s = await cenario({ uso: vencida });
  try {
    const r = await s.t.c.get('/api/v1/uso');
    assert.equal(r.json.agentes.ana.uso.sessao_5h.vencida, true);
    const p = await s.t.c.post('/api/v1/uso', { json: {} });
    assert.equal(p.status, 405);
    assert.match(p.json.erro, /Use GET/);
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso/docs.md serve a doc e a caixa do agente libera a rota', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const r = await s.t.c.get('/api/v1/uso/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /markdown/);
    assert.match(r.texto, /GET \/api\/v1\/uso/);
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /caixa\.permitir\('\/api\/v1\/uso'\)/);
  } finally { await s.fechar(); }
});

test('menu: bloco de uso sempre à mostra, depois de #mlTroca e antes de #mlTabs, sem <details>; colaborador não recebe', () => {
  const casca = require('../public/casca');
  const m = casca.MARCACAO_MENU;
  assert.match(m, /<section class="ml-uso-bloco" id="mlUso" data-tour="gm-uso" aria-label="Uso da assinatura" role="status" aria-live="polite">/);
  assert.doesNotMatch(m, /<details|mlUsoDet|mlUsoLista/);
  assert.ok(m.indexOf('id="mlTroca"') < m.indexOf('id="mlUso"'));
  assert.ok(m.indexOf('id="mlUso"') < m.indexOf('id="mlTabs"'));
  assert.ok(m.indexOf('</div><section class="ml-uso-bloco"') > 0, 'logo depois do fechamento de .ml-marca');
  assert.doesNotMatch(casca.MARCACAO_MENU_COLAB, /id="mlTroca"/);
  assert.match(m, /<button type="button" class="gm-tut" id="gmTutorial" aria-label="Tutorial do menu" title="Tutorial: o que é cada parte e por que está aqui">\?<\/button>/);
  assert.doesNotMatch(m, />Tutorial</);
  const css = fs.readFileSync(path.join(__dirname, '../public/menu-lado.css'), 'utf8');
  assert.match(css, /aside#menu \.gm-tut\{position:absolute;top:calc\(12px \+ env\(safe-area-inset-top\)\);left:10px;z-index:2;width:32px;height:32px;/);
  assert.match(css, /\.ml-uso-zera\{grid-column:1\/-1;[^}]*margin-bottom:3px;[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  assert.doesNotMatch(css.match(/\.ml-uso-zera\{[^}]*\}/)[0], /padding-left/);
  assert.match(css, /\.ml-uso-card\{display:grid;grid-template-columns:max-content minmax\(0,1fr\) auto;column-gap:8px;row-gap:2px;/);
  assert.match(css, /\.ml-uso-lin\{display:contents\}/);
  assert.match(css, /\.ml-uso-tit\{grid-column:1\/-1;/);
  assert.doesNotMatch(css + fs.readFileSync(path.join(__dirname, '../public/menu-lado.js'), 'utf8'), /ml-uso-cols/);
  const js = fs.readFileSync(path.join(__dirname, '../public/menu-lado.js'), 'utf8');
  assert.doesNotMatch(js, /mlUsoDet|mlUsoLista|miniBarraUso|itemUso/);
});

const AGORA = new Date(2026, 9, 19, 12, 0).getTime();
const iso = (...a) => new Date(...a).toISOString();
const uso = (prov, pct5, pctS, zeraS, medido) => ({ uso: { provedor: prov,
  sessao_5h: pct5 == null ? null : { usado_pct: pct5, zera_em: iso(2026, 9, 19, 18, 40), vencida: false },
  semanal: pctS == null ? null : { usado_pct: pctS, zera_em: zeraS, vencida: false },
  plano: null, medido_em: medido, fonte: 'statusline' } });

test('sem agente selecionado: cartão sem números pedindo para escolher um agente', () => {
  const z = iso(2026, 9, 24, 9, 0);
  const h = M.usoHtml({ a: uso('claude', 10, 20, z, iso(2026, 9, 19, 11, 0)), b: uso('codex', 5, 8, z, iso(2026, 9, 19, 11, 0)) }, {}, AGORA);
  assert.equal((h.match(/class="ml-uso-card"/g) || []).length, 1);
  assert.match(h, /escolha um agente/);
  assert.match(h, /title="O uso mostrado é o da assinatura do agente selecionado\."/);
  assert.doesNotMatch(h, /10%|20%|medido há/);
  for (const v of [undefined, null, '']) assert.match(M.usoHtml({ a: uso('claude', 1, 1, z, iso(2026, 9, 19, 11, 0)) }, {}, AGORA, v), /escolha um agente/);
});

test('agente sem medição: bloco "sem dado" com rodapé "sem medição ainda" e o motivo só no title', () => {
  const h = M.usoHtml({ a: { uso: null, motivo: 'falhou <b>feio</b>' } }, {}, AGORA, 'a');
  assert.match(h, /sem dado/);
  assert.match(h, /sem medição ainda/);
  assert.match(h, /title="falhou &lt;b&gt;feio&lt;\/b&gt;"/);
  assert.doesNotMatch(h, /<b>|0%/);
  assert.doesNotMatch(M.usoHtml({ a: { uso: null, erro: 'x' } }, {}, AGORA, 'a'), /ml-uso-nota/);
});

test('bloco: faixas de cor, "sem dado" no lugar de 0%, vencida, vírgula decimal e zero real', () => {
  assert.equal(M.corUso(69.9), 'verde');
  assert.equal(M.corUso(70), 'ambar');
  assert.equal(M.corUso(89.9), 'ambar');
  assert.equal(M.corUso(90), 'vermelho');
  const semDado = M.janelaUso('5 horas', null);
  assert.match(semDado, /sem dado/);
  assert.doesNotMatch(semDado, /0%/);
  const vencida = M.janelaUso('5 horas', { usado_pct: 99, zera_em: PASSADO, vencida: true });
  assert.match(vencida, /ml-uso-pct verde">0%/);
  assert.match(vencida, /ml-uso-bar verde" role="img" aria-label="5 horas: zerou"><i style="width:0%"/);
  assert.match(vencida, /ml-uso-zera">zerou às \d+h/);
  assert.doesNotMatch(vencida, /99%|>zerou</);
  assert.doesNotMatch(semDado, /ml-uso-zera/);
  const medida = M.janelaUso('Semana', { usado_pct: 93.5, zera_em: EM_BREVE, vencida: false });
  assert.match(medida, /93,5%/);
  assert.match(medida, /ml-uso-bar vermelho/);
  assert.match(medida, /width:93\.5%/);
  assert.match(M.janelaUso('Semana', { usado_pct: 37, zera_em: EM_BREVE, vencida: false }), /ml-uso-pct verde">37%/);
  assert.match(M.janelaUso('Semana', { usado_pct: 0, zera_em: EM_BREVE, vencida: false }), /ml-uso-pct verde">0%/);
  assert.doesNotMatch(M.janelaUso('Semana', { usado_pct: null, zera_em: EM_BREVE }), /%/);
});

test('bloco: linhas empilhadas na ordem 5h, frase, Semana, frase, rodapé', () => {
  const z = iso(2026, 9, 24, 9, 0);
  const h = M.usoHtml({ a: uso('claude', 37.5, 72, z, iso(2026, 9, 19, 11, 59)) }, {}, AGORA, 'a');
  const pos = s => h.indexOf(s);
  const ordem = ['ml-uso-tit', '>5 horas<', 'zera hoje às 18h40', '>Semana<', 'zera sáb às 9h', 'ml-uso-rodape'].map(pos);
  assert.ok(ordem.every(n => n >= 0), 'todas as peças existem');
  assert.deepEqual(ordem, ordem.slice().sort((a, b) => a - b));
  assert.doesNotMatch(h, /ml-uso-cols| · /);
  const v = M.usoHtml({ a: { uso: { provedor: 'claude', sessao_5h: { usado_pct: 90, zera_em: iso(2026, 9, 19, 14, 0), vencida: true }, semanal: null, medido_em: iso(2026, 9, 19, 11, 59) } } }, {}, AGORA, 'a');
  assert.match(v, /ml-uso-zera">zerou às 14h</);
  assert.equal((v.match(/ml-uso-zera/g) || []).length, 1, 'janela sem dado não tem frase');
});

test('bloco: horário de zerar em hoje, amanhã, dia da semana e data', () => {
  assert.equal(M.quandoZeraUso(iso(2026, 9, 19, 18, 40), AGORA), 'hoje às 18h40');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 19, 14, 0), AGORA), 'hoje às 14h');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 20, 9, 5), AGORA), 'amanhã às 9h05');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 21, 9, 0), AGORA), 'qua às 9h');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 25, 9, 0), AGORA), 'dom às 9h');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 26, 9, 0), AGORA), '26/10 às 9h');
  assert.equal(M.quandoZeraUso(iso(2026, 9, 28, 9, 0), AGORA), '28/10 às 9h');
  assert.equal(M.quandoZeraUso('lixo', AGORA), '');
});

test('bloco: "medido há ..." e âmbar acima de 30 minutos', () => {
  const t = min => M.tempoMedidoUso(new Date(AGORA - min * 60000).toISOString(), AGORA);
  assert.equal(t(0.2).texto, 'medido agora');
  assert.equal(t(1).texto, 'medido há 1 minuto');
  assert.equal(t(5).texto, 'medido há 5 minutos');
  assert.equal(t(60).texto, 'medido há 1 hora');
  assert.equal(t(180).texto, 'medido há 3 horas');
  assert.equal(t(47 * 60).texto, 'medido há 47 horas');
  assert.equal(t(72 * 60).texto, 'medido há 3 dias');
  assert.equal(t(30).velho, false);
  assert.equal(t(31).velho, true);
  const z = iso(2026, 9, 24, 9, 0);
  assert.match(M.usoHtml({ a: uso('claude', 1, 1, z, new Date(AGORA - 40 * 60000).toISOString()) }, {}, AGORA, 'a'), /ml-uso-rodape velho">medido há 40 minutos/);
});

test('bloco: escape de HTML no título, no motivo e no erro; erro da API em vermelho com causa no title', () => {
  const z = iso(2026, 9, 24, 9, 0);
  const h = M.usoHtml({ a: uso('claude', 1, 1, z, iso(2026, 9, 19, 11, 59)) }, { a: '<img src=x>' }, AGORA, 'a');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x&gt;/);
  const e = M.usoErroHtml('não consegui ler o uso (resposta 500)', 'causa "feia" <script>');
  assert.match(e, /ml-uso-rodape erro" title="causa &quot;feia&quot; &lt;script&gt;">não consegui ler o uso \(resposta 500\)/);
  assert.doesNotMatch(e, /<script>/);
});

test('agente selecionado: duas contas Claude com semanais a 6 min, cada atualId mostra a medição do próprio agente', () => {
  const ag = {
    a: uso('claude', 98, 98, iso(2026, 9, 24, 9, 0), iso(2026, 9, 19, 11, 0)),
    b: uso('claude', 2, 2, iso(2026, 9, 24, 9, 6), iso(2026, 9, 19, 11, 30)),
  };
  const nomes = { a: 'Ana', b: 'Bia' };
  const ha = M.usoHtml(ag, nomes, AGORA, 'a');
  assert.equal((ha.match(/class="ml-uso-card"/g) || []).length, 1);
  assert.match(ha, /98%/);
  assert.doesNotMatch(ha, /2%\b(?<!98%)/);
  assert.match(ha, /Medido pelo agente: Ana/);
  const hb = M.usoHtml(ag, nomes, AGORA, 'b');
  assert.equal((hb.match(/class="ml-uso-card"/g) || []).length, 1);
  assert.match(hb, /2%/);
  assert.doesNotMatch(hb, /98%/);
  assert.match(hb, /Medido pelo agente: Bia/);
  assert.doesNotMatch(hb, /\(Bia\)/);
});

test('agente selecionado: Codex sem medição mostra sem medição ainda, não o 11% do Claude', () => {
  const ag = { a: uso('claude', 11, 21, iso(2026, 9, 24, 9, 0), iso(2026, 9, 19, 11, 0)), c: { uso: null, motivo: 'ainda não respondeu' } };
  const h = M.usoHtml(ag, {}, AGORA, 'c');
  assert.equal((h.match(/class="ml-uso-card"/g) || []).length, 1);
  assert.match(h, /sem medição ainda/);
  assert.match(h, /ainda não respondeu/);
  assert.doesNotMatch(h, /11%/);
});

test('agente selecionado: com dois provedores o título leva o provedor do agente', () => {
  const ag = { a: uso('claude', 11, 21, iso(2026, 9, 24, 9, 0), iso(2026, 9, 19, 11, 0)), c: uso('codex', 5, 6, iso(2026, 9, 25, 9, 0), iso(2026, 9, 19, 11, 0)) };
  assert.match(M.usoHtml(ag, {}, AGORA, 'c'), /Uso da assinatura ChatGPT/);
  assert.match(M.usoHtml(ag, {}, AGORA, 'a'), /Uso da assinatura Claude/);
});

test('agente selecionado: falhas diferentes em A e B, a dica é a do agente selecionado', () => {
  const ag = { a: { uso: null, erro: 'sem login da Ana' }, b: { uso: null, erro: 'runner da Bia fora do ar' },
    c: uso('claude', 11, 21, iso(2026, 9, 24, 9, 0), iso(2026, 9, 19, 11, 0)) };
  const hb = M.usoHtml(ag, {}, AGORA, 'b');
  assert.match(hb, /runner da Bia fora do ar/);
  assert.doesNotMatch(hb, /sem login da Ana|11%/);
  assert.match(M.usoHtml(ag, {}, AGORA, 'a'), /sem login da Ana/);
});

test('atualId ausente da resposta: cartão sem números, agente indisponível', () => {
  const ag = { a: uso('claude', 11, 21, iso(2026, 9, 24, 9, 0), iso(2026, 9, 19, 11, 0)) };
  const h = M.usoHtml(ag, {}, AGORA, 'zzz');
  assert.equal((h.match(/class="ml-uso-card"/g) || []).length, 1);
  assert.match(h, /agente indisponível/);
  assert.match(h, /Este agente não está no registro; recarregue a página\./);
  assert.doesNotMatch(h, /11%/);
});

test('agente selecionado sem medição: erro vira "não consegui ler o uso", motivo fica "sem medição ainda"', () => {
  const ag = { a: { uso: null, erro: 'falhou X' }, b: { uso: null, motivo: 'sem login' } };
  const ha = M.usoHtml(ag, {}, AGORA, 'a');
  assert.match(ha, /ml-uso-rodape erro"[^>]*title="falhou X">não consegui ler o uso/);
  assert.doesNotMatch(ha, /sem medição ainda/);
  const hb = M.usoHtml(ag, {}, AGORA, 'b');
  assert.match(hb, /sem medição ainda/);
  assert.match(hb, /title="sem login"/);
});

test('GET /api/v1/uso?agente=: só o agente pedido, sem esperar o runner lento', async () => {
  const s = await cenario({ uso: USO_ANA, atrasoUsoMs: 4000 }, { uso: USO_ANA });
  try {
    const t0 = Date.now();
    const r = await s.t.c.get('/api/v1/uso?agente=bia');
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(Object.keys(r.json.agentes), ['bia']);
    assert.ok(Date.now() - t0 < 2000, 'não esperou o runner lento');
    const x = await s.t.c.get('/api/v1/uso?agente=nao-existe');
    assert.deepEqual(x.json.agentes, {});
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso?agente= inválido: 400 com motivo', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    for (const v of ['a%20b', '..%2Fx', 'a'.repeat(65), '']) {
      const r = await s.t.c.get('/api/v1/uso?agente=' + v);
      assert.equal(r.status, 400, v);
      assert.match(r.json.erro, /agente/);
    }
  } finally { await s.fechar(); }
});

test('GET /api/v1/uso pela caixa ignora a query agente', async () => {
  const s = await cenario({ uso: USO_ANA });
  try {
    const cab = { 'x-dgclaw-caixa': s.t.web.caixa.segredo, 'x-dgclaw-agente': 'bia' };
    const r = await cliente(s.t.porta).pedir('GET', '/api/v1/uso?agente=ana', { headers: cab });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(Object.keys(r.json.agentes), ['bia']);
  } finally { await s.fechar(); }
});
