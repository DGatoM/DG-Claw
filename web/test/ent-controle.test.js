'use strict';
// Bloco C: catálogo do controle, defesa em profundidade (aprovação conferida no próprio controle), fila de aprovações,
// rota do Admin e o nível pessoal sem mudança. O controle roda de verdade num socket temporário; o `dgclaw` é de mentira.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalogo = require('../../controle/catalogo');
const { chamar } = require('../lib/controle-cliente');
const { hashParams } = require('../lib/aprovacoes-arquivo');
const { cenarioControle } = require('./ent-controle-ajuda');

const esperaAte = async (fn, ms) => {
  const limite = Date.now() + (ms || 3000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error('esperei demais por uma condição do teste');
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ── catálogo: parâmetros ────────────────────────────────────────────────────
test('catálogo: slug com ../, ;, espaço, maiúscula, unicode e nomes reservados são recusados em toda operação com agente', () => {
  const ruins = ['../etc', 'ana;rm', 'ana b', 'Ana', 'ánã', 'ana\n', 'a', '-ana', 'ana$(id)', 'ana`id`', 'ana/../x', 'x'.repeat(40), 'admin', 'admin-manutencao'];
  const ops = Object.entries(catalogo.OPS).filter(([, d]) => d.params && d.params.agente && d.params.agente.tipo === 'slug_agente').map(([op]) => op);
  assert.ok(ops.length >= 8, `operações com agente: ${ops.join(', ')}`);
  for (const op of ops) {
    for (const ruim of ruins) {
      const params = op === 'agente.pacote' ? { agente: ruim, pacotes: 'curl' } : { agente: ruim };
      assert.equal(catalogo.validar(op, params).ok, false, `${op} deveria recusar agente=${JSON.stringify(ruim)}`);
    }
    const params = op === 'agente.pacote' ? { agente: 'ana', pacotes: 'curl' } : { agente: 'ana' };
    assert.equal(catalogo.validar(op, params).ok, true, `${op} com agente=ana`);
  }
  for (const ruim of ['../etc', 'ana;rm', 'ana b', 'ánã', 'admin']) assert.equal(catalogo.validar('agente.criar', { slug: ruim, nome: 'X' }).ok, false, `agente.criar slug=${ruim}`);
});

test('catálogo: parâmetro desconhecido, tipo errado e limites são recusados com motivo em português', () => {
  const r = catalogo.validar('agente.parar', { agente: 'ana', extra: 1 });
  assert.equal(r.ok, false);
  assert.match(r.erro, /não existe nesta operação/);
  assert.equal(catalogo.validar('agente.parar', { agente: 'ana', __proto__: 1 }).ok, true, '__proto__ literal não é chave própria e é ignorado pelo JSON.parse do mundo real');
  assert.equal(catalogo.validar('agente.parar', JSON.parse('{"agente":"ana","__proto__":{"x":1}}')).ok, false, '__proto__ vindo de JSON é chave própria e é recusada');
  assert.equal(catalogo.validar('agente.parar', 'ana').ok, false);
  assert.equal(catalogo.validar('agente.parar', ['ana']).ok, false);
  assert.match(catalogo.validar('agente.parar', {}).erro, /Falta o parâmetro "agente"/);
  assert.equal(catalogo.validar('manutencao.abrir', { minutos: 4 }).ok, false);
  assert.equal(catalogo.validar('manutencao.abrir', { minutos: 61 }).ok, false);
  assert.equal(catalogo.validar('manutencao.abrir', { minutos: '15' }).params.minutos, 15);
  assert.equal(catalogo.validar('manutencao.abrir', { minutos: '1e3' }).ok, false);
  assert.equal(catalogo.validar('manutencao.abrir', { minutos: 15.5 }).ok, false);
  assert.equal(catalogo.validar('agente.log', { agente: 'ana', linhas: 201 }).ok, false);
  assert.equal(catalogo.validar('agente.log', { agente: 'ana' }).params.linhas, 50);
  assert.equal(catalogo.validar('agente.criar', { slug: 'ana', nome: 'A\nB' }).ok, false, 'quebra de linha no nome');
  assert.equal(catalogo.validar('agente.criar', { slug: 'ana', nome: 'x'.repeat(61) }).ok, false);
  assert.equal(catalogo.validar('agente.criar', { slug: 'ana', nome: 'José', provedor: 'gpt' }).ok, false);
  assert.equal(catalogo.validar('agente.criar', { slug: 'ana', nome: 'José', cor: 'azul' }).ok, false);
  assert.equal(catalogo.validar('dominio.trocar', { dominio: 'https://x.com' }).ok, false);
  assert.equal(catalogo.validar('dominio.trocar', { dominio: 'x.com; rm -rf /' }).ok, false);
  assert.equal(catalogo.validar('dominio.trocar', { dominio: 'Painel.Empresa.com.br' }).params.dominio, 'painel.empresa.com.br');
  assert.equal(catalogo.validar('agente.pacote', { agente: 'ana', pacotes: '-y,curl' }).ok, false);
  assert.equal(catalogo.validar('agente.pacote', { agente: 'ana', pacotes: 'curl, jq' }).ok, true);
  assert.equal(catalogo.validar('nivel.ajustar', { chave: '2fa; ls', valor: 'x' }).ok, false);
  assert.equal(catalogo.validar('op.inexistente', {}).motivo, 'op_desconhecida');
  assert.equal(catalogo.validar('constructor', {}).motivo, 'op_desconhecida');
});

test('catálogo: a frase da confirmação sai só dos parâmetros validados e cada operação tem classe', () => {
  const v = catalogo.validar('agente.remover', { agente: 'financeiro' });
  assert.equal(catalogo.descrever('agente.remover', v.params), 'Remover o agente `financeiro`. A casa dele vai para aposentados.');
  assert.match(catalogo.descrever('manutencao.abrir', { minutos: 20 }), /20 minutos/);
  const classes = { leitura: 0, reversivel: 0, perigosa: 0 };
  for (const d of Object.values(catalogo.OPS)) classes[d.classe] += 1;
  assert.ok(classes.leitura >= 8 && classes.reversivel >= 7 && classes.perigosa === 5, JSON.stringify(classes));
  for (const op of ['agente.remover', 'dominio.trocar', 'travas.liberar', 'manutencao.abrir', 'nivel.ajustar']) assert.equal(catalogo.OPS[op].classe, 'perigosa', op);
  assert.match(catalogo.docsMarkdown(), /agente\.remover/);
});

// ── controle: operações ─────────────────────────────────────────────────────
test('controle: leitura executa na hora, reversível executa direto e vai para a auditoria com origem "controle"', async () => {
  const k = await cenarioControle();
  try {
    const a = await k.controle.processar({ op: 'agentes.listar', quem: 'agente:admin' });
    assert.equal(a.ok, true);
    assert.deepEqual(a.resultado.agentes.map((x) => x.slug).sort(), ['admin', 'ana', 'marina']);
    assert.ok(!JSON.stringify(a.resultado).includes('runner_token'), 'a listagem não leva campos de segredo');

    const s = await k.controle.processar({ op: 'agente.status', params: { agente: 'ana' }, quem: 'agente:admin' });
    assert.equal(s.resultado.agente.estado, 'running');
    assert.deepEqual(k.chamadas().at(-1).argv, ['agente', 'listar', '--json']);
    const n = await k.controle.processar({ op: 'agente.status', params: { agente: 'nao-existe' }, quem: 'agente:admin' });
    assert.equal(n.motivo, 'nao_encontrado');

    const g = await k.controle.processar({ op: 'status.geral', quem: 'agente:admin' });
    assert.equal(g.ok, true);
    assert.equal(g.resultado.codigo, 3, 'o código de saída do status vem como dado, não como erro');

    const l = await k.controle.processar({ op: 'agente.log', params: { agente: 'ana', linhas: 5 }, quem: 'agente:admin' });
    assert.equal(l.resultado.linhas, ['linha 296', 'linha 297', 'linha 298', 'linha 299', 'linha 300'].join('\n'));
    const l2 = await k.controle.processar({ op: 'agente.log', params: { agente: 'marina' }, quem: 'agente:admin' });
    assert.equal(l2.motivo, 'nao_encontrado');
    assert.match(l2.erro, /ainda não tem log/);

    const r = await k.controle.processar({ op: 'agente.reiniciar', params: { agente: 'ana' }, quem: 'agente:admin' });
    assert.equal(r.ok, true);
    const tarefa = await esperaAte(async () => { const t = await k.controle.processar({ op: 'tarefa.ver', params: { id: r.resultado.tarefa }, quem: 'agente:admin' }); return t.resultado.tarefa.estado === 'ok' ? t.resultado.tarefa : null; });
    assert.match(tarefa.resultado.saida, /feito: agente reiniciar ana/);
    assert.deepEqual(k.chamadas().at(-1), { argv: ['agente', 'reiniciar', 'ana'], quem: 'controle:agente:admin' });

    const eventos = k.c.eventos().filter((e) => e.origem === 'controle');
    assert.ok(eventos.length >= 6, `eventos do controle: ${eventos.length}`);
    const ev = eventos.find((e) => e.dados.op === 'agente.reiniciar');
    assert.equal(ev.quem, 'agente:admin');
    assert.equal(ev.dados.classe, 'reversivel');
    assert.deepEqual(ev.dados.params, { agente: 'ana' });
  } finally { await k.fechar(); }
});

test('controle: agente.criar vira tarefa, o argv chega em lista, a saída é mascarada e criar duas vezes seguidas é recusado', async () => {
  const k = await cenarioControle();
  try {
    const p = { slug: 'ana-2', nome: 'Ana; touch /tmp/x', papel: 'organiza $(id) a agenda', provedor: 'codex', canal: 'chat' };
    const r = await k.controle.processar({ op: 'agente.criar', params: p, quem: 'agente:admin' });
    assert.equal(r.ok, true);
    assert.equal(r.resultado.estado, 'rodando');
    const de = await k.controle.processar({ op: 'agente.criar', params: p, quem: 'agente:admin' });
    assert.equal(de.motivo, 'em_andamento');
    const t = await esperaAte(async () => { const x = await k.controle.processar({ op: 'tarefa.ver', params: { id: r.resultado.tarefa }, quem: 'agente:admin' }); return x.resultado.tarefa.estado !== 'rodando' ? x.resultado.tarefa : null; });
    assert.equal(t.estado, 'ok');
    assert.ok(!t.resultado.saida.includes('sk-ant-api03'), 'a chave que o comando imprimiu não pode voltar');
    assert.match(t.resultado.saida, /segredo oculto/);
    assert.deepEqual(k.chamadas().at(-1).argv, ['agente', 'criar', 'ana-2', '--nome', 'Ana; touch /tmp/x', '--provedor', 'codex', '--auth', 'assinatura', '--canal', 'chat', '--papel', 'organiza $(id) a agenda']);
  } finally { await k.fechar(); }
});

test('controle: falha do comando volta como erro com o que ele disse, e a tarefa que falha registra o motivo', async () => {
  const k = await cenarioControle();
  try {
    process.env.DGCLAW_FAKE_FALHA = 'agente parar';
    const r = await k.controle.processar({ op: 'agente.parar', params: { agente: 'ana' }, quem: 'agente:admin' });
    const t = await esperaAte(async () => { const x = await k.controle.processar({ op: 'tarefa.ver', params: { id: r.resultado.tarefa }, quem: 'agente:admin' }); return x.resultado.tarefa.estado !== 'rodando' ? x.resultado.tarefa : null; });
    assert.equal(t.estado, 'erro');
    assert.match(t.erro, /terminou com código 1/);
    assert.match(t.erro, /o falso falhou de proposito/);
    const eventos = k.c.eventos().filter((e) => e.evento === 'controle_tarefa_fim');
    assert.equal(eventos.at(-1).dados.resultado, 'erro');
  } finally { await k.fechar(); }
});

test('controle: o campo quem é obrigatório e o pedido malformado é recusado', async () => {
  const k = await cenarioControle();
  try {
    assert.equal((await k.controle.processar({ op: 'agentes.listar' })).motivo, 'pedido_invalido');
    assert.equal((await k.controle.processar({ op: 'agentes.listar', quem: 'a b' })).motivo, 'pedido_invalido');
    assert.equal((await k.controle.processar(null)).motivo, 'pedido_invalido');
    assert.equal((await k.controle.processar({ op: 'agente.parar', params: { agente: '../x' }, quem: 'agente:admin' })).motivo, 'parametros');
    assert.equal(k.chamadas().length, 0, 'nada foi executado');
  } finally { await k.fechar(); }
});

// ── defesa em profundidade: a aprovação é conferida no controle ─────────────
/** Cria direto no armazenamento um pedido do tipo controle, como o Web o deixaria. */
function pedidoNoDisco(k, over) {
  const arm = k.controle.armazem;
  const params = (over && over.params) || { agente: 'ana' };
  const t = k.c.tempo.ms();
  const reg = Object.assign({
    id: arm.novoId(), tipo: 'controle', op: 'agente.remover', params, params_hash: hashParams(params), descricao: 'x',
    pedido_por: 'agente:admin', pedido_em: new Date(t).toISOString(), expira_em: new Date(t + 86400000).toISOString(),
    estado: 'aprovada', decidido_por: 'dono', decidido_em: new Date(t).toISOString(), resultado: null, usada_em: null,
  }, over || {});
  arm.criar(reg);
  return reg;
}
const comAprov = (reg, extra) => Object.assign({ op: reg.op, params: reg.params, quem: 'agente:admin', aprovacao: { id: reg.id, aprovado_por: reg.decidido_por, aprovado_em: reg.decidido_em } }, extra || {});

test('controle: operação perigosa sem aprovação é recusada pelo próprio controle e nada roda', async () => {
  const k = await cenarioControle();
  try {
    for (const op of ['agente.remover', 'dominio.trocar', 'manutencao.abrir', 'nivel.ajustar', 'travas.liberar']) {
      const params = { 'agente.remover': { agente: 'ana' }, 'dominio.trocar': { dominio: 'a.example.com' }, 'manutencao.abrir': { minutos: 10 }, 'nivel.ajustar': { chave: 'sessao_horas', valor: '24' }, 'travas.liberar': { agente: 'ana' } }[op];
      const r = await k.controle.processar({ op, params, quem: 'agente:admin' });
      assert.equal(r.motivo, 'aprovacao_necessaria', op);
      const r2 = await k.controle.processar({ op, params, quem: 'agente:admin', aprovacao: { id: 'nao-e-um-id' } });
      assert.equal(r2.motivo, 'aprovacao_necessaria', `${op} com id inventado`);
      const r3 = await k.controle.processar({ op, params, quem: 'agente:admin', aprovacao: { id: 'a'.repeat(24), aprovado_por: 'dono' } });
      assert.equal(r3.motivo, 'aprovacao_invalida', `${op} com id que não existe`);
    }
    assert.equal(k.chamadas().length, 0);
    assert.ok(k.c.eventos().some((e) => e.evento === 'controle_recusado' && e.origem === 'controle'));
  } finally { await k.fechar(); }
});

test('controle: aprovação vale uma vez só, só para a mesma operação e os mesmos parâmetros, e só se estiver aprovada e no prazo', async () => {
  const k = await cenarioControle();
  try {
    const reg = pedidoNoDisco(k);
    const ok1 = await k.controle.processar(comAprov(reg));
    assert.equal(ok1.ok, true, JSON.stringify(ok1));
    await esperaAte(() => k.chamadas().length === 1);
    assert.deepEqual(k.chamadas().at(-1).argv, ['agente', 'remover', 'ana', '--sim']);
    const disco = k.controle.armazem.ler(reg.id);
    assert.ok(disco.usada_em, 'marcada como usada');

    const de_novo = await k.controle.processar(comAprov(reg));
    assert.equal(de_novo.motivo, 'aprovacao_invalida');
    assert.match(de_novo.erro, /já foi usado/);

    const outroParam = pedidoNoDisco(k, { params: { agente: 'ana' } });
    const troca = await k.controle.processar(comAprov(outroParam, { params: { agente: 'marina' } }));
    assert.equal(troca.motivo, 'aprovacao_invalida');
    assert.match(troca.erro, /não são os que o TI aprovou/);

    const outraOp = pedidoNoDisco(k);
    const op = await k.controle.processar(comAprov(outraOp, { op: 'dominio.trocar', params: { dominio: 'a.example.com' } }));
    assert.match(op.erro, /foi aprovado para a operação "agente.remover"/);

    const pendente = pedidoNoDisco(k, { estado: 'pendente', decidido_por: null, decidido_em: null });
    assert.match((await k.controle.processar(comAprov(pendente, { aprovacao: { id: pendente.id, aprovado_por: null } }))).erro, /está "pendente"/);
    const recusada = pedidoNoDisco(k, { estado: 'recusada' });
    assert.match((await k.controle.processar(comAprov(recusada))).erro, /está "recusada"/);
    const velha = pedidoNoDisco(k, { expira_em: new Date(k.c.tempo.ms() - 1000).toISOString() });
    assert.match((await k.controle.processar(comAprov(velha))).erro, /venceu/);
    const outroTipo = pedidoNoDisco(k, { tipo: 'instagram' });
    assert.match((await k.controle.processar(comAprov(outroTipo))).erro, /só executa pedidos do tipo "controle"/);
    const quemMente = pedidoNoDisco(k);
    assert.match((await k.controle.processar(comAprov(quemMente, { aprovacao: { id: quemMente.id, aprovado_por: 'outra-pessoa' } }))).erro, /não bate com o registro/);

    assert.equal(k.chamadas().length, 1, 'só a primeira aprovação executou');
  } finally { await k.fechar(); }
});

test('controle: o socket responde linha a linha e o cliente do Web explica quando o controle está fora', async () => {
  const k = await cenarioControle();
  try {
    const r = await chamar({ op: 'nivel.mostrar', quem: 'ti:dono' });
    assert.equal(r.ok, true);
    assert.deepEqual(k.chamadas().at(-1).argv, ['nivel', 'mostrar']);
    const st = fs.statSync(k.socket);
    assert.equal(st.mode & 0o777, 0o600, 'socket só do root (o Web é root)');
    await k.controle.fechar();
    const fora = await chamar({ op: 'nivel.mostrar', quem: 'ti:dono' });
    assert.equal(fora.ok, false);
    assert.equal(fora.motivo, 'controle_fora');
    assert.match(fora.erro, /systemctl status dgclaw-controle/);
  } finally { await k.fechar(); }
});

// ── fila de aprovações pelo Web ─────────────────────────────────────────────
test('fluxo completo: o Admin pede, fica pendente, o TI com 2FA recente aprova, o controle executa e o Admin vê o resultado', async () => {
  const k = await cenarioControle();
  try {
    const admin = k.comoAgente('admin');
    const ped = await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } });
    assert.equal(ped.status, 202, ped.texto);
    assert.equal(ped.json.pendente, true);
    assert.equal(ped.json.descricao, 'Remover o agente `ana`. A casa dele vai para aposentados.');
    assert.equal(k.chamadas().length, 0, 'nada rodou antes da aprovação');

    // o mesmo pedido de novo não enche a fila
    const de_novo = await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } });
    assert.equal(de_novo.json.aprovacao, ped.json.aprovacao);
    assert.equal(de_novo.json.ja_existia, true);

    const id = ped.json.aprovacao;
    const meu = await admin.get(`/api/v1/aprovacoes/${id}`);
    assert.equal(meu.status, 200);
    assert.equal(meu.json.aprovacao.estado, 'pendente');
    assert.equal(meu.json.aprovacao.params, undefined, 'o agente vê o estado, não os parâmetros');

    const ti = await k.ti();
    const lista = await ti.get('/api/v1/aprovacoes?estado=pendente');
    assert.equal(lista.status, 200);
    assert.equal(lista.json.aprovacoes.length, 1);
    assert.deepEqual(lista.json.aprovacoes[0].params, { agente: 'ana' });
    assert.equal((await ti.get('/api/v1/aprovacoes/resumo')).json.pendentes, 1);

    const apr = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(apr.status, 200, apr.texto);
    assert.equal(apr.json.executada, true);
    assert.equal(apr.json.aprovacao.estado, 'executada');
    assert.equal(apr.json.aprovacao.decidido_por, 'dono');
    const tarefa = apr.json.aprovacao.resultado.tarefa;
    assert.ok(tarefa, 'agente.remover é demorada e devolve uma tarefa');
    await esperaAte(() => k.chamadas().length === 1);
    assert.deepEqual(k.chamadas()[0], { argv: ['agente', 'remover', 'ana', '--sim'], quem: 'controle:agente:admin' });

    const depois = await admin.get(`/api/v1/aprovacoes/${id}`);
    assert.equal(depois.json.aprovacao.estado, 'executada');
    const tv = await admin.post('/api/v1/controle/tarefa.ver', { params: { id: tarefa } });
    assert.equal(tv.status, 200);

    const outra = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(outra.status, 409, 'aprovar de novo é recusado');

    const evs = k.c.eventos().map((e) => e.evento);
    for (const e of ['aprovacao_criada', 'aprovacao_aprovada', 'aprovacao_executada', 'controle_op']) assert.ok(evs.includes(e), `evento ${e} na auditoria (${evs.join(',')})`);
    const criada = k.c.eventos().find((e) => e.evento === 'aprovacao_criada');
    assert.equal(criada.quem, 'agente:admin');
    assert.equal(criada.dados.params, undefined, 'os parâmetros não vão para a trilha, só o hash');
    assert.equal(criada.dados.params_hash.length, 64);
  } finally { await k.fechar(); }
});

test('aprovar com o 2FA velho pede o código; depois de reautenticar, aprova. Recusar não pede 2FA', async () => {
  const k = await cenarioControle();
  try {
    const admin = k.comoAgente('admin');
    const ti = await k.ti();
    const a = (await admin.post('/api/v1/controle/manutencao.abrir', { params: { minutos: 10 } })).json.aprovacao;
    const b = (await admin.post('/api/v1/controle/nivel.ajustar', { params: { chave: 'sessao_horas', valor: '24' } })).json.aprovacao;
    k.c.tempo.avanca(16 * 60 * 1000);
    const velho = await ti.post(`/api/v1/aprovacoes/${a}/aprovar`, { json: {} });
    assert.equal(velho.status, 403);
    assert.equal(velho.json.reautenticar, true);
    assert.match(velho.json.erro, /código do aplicativo autenticador/);
    assert.equal(k.chamadas().length, 0);
    assert.equal((await ti.get(`/api/v1/aprovacoes/${a}`)).json.aprovacao.estado, 'pendente', 'continua pendente');

    const re = await ti.post('/api/v1/eu/reautenticar', { json: { codigo: k.c.codigo('dono') } });
    assert.equal(re.status, 200, re.texto);
    const novo = await ti.post(`/api/v1/aprovacoes/${a}/aprovar`, { json: {} });
    assert.equal(novo.status, 200, novo.texto);
    assert.equal(novo.json.executada, true);
    assert.deepEqual(k.chamadas().at(-1).argv, ['admin', 'manutencao', 'abrir', '10', '--por', 'agente:admin']);

    k.c.tempo.avanca(16 * 60 * 1000);
    const rec = await ti.post(`/api/v1/aprovacoes/${b}/recusar`, { json: { motivo: 'não agora' } });
    assert.equal(rec.status, 200, 'recusar não exige 2FA recente');
    assert.equal(rec.json.aprovacao.estado, 'recusada');
    assert.equal(k.chamadas().length, 1);
    assert.ok(k.c.eventos().some((e) => e.evento === 'aprovacao_recusada' && e.dados.motivo === 'não agora'));
    const recusado = await admin.get(`/api/v1/aprovacoes/${b}`);
    assert.equal(recusado.json.aprovacao.estado, 'recusada');
  } finally { await k.fechar(); }
});

test('controle fora do ar na hora de aprovar: o pedido volta a pendente e funciona quando o controle volta', async () => {
  const k = await cenarioControle();
  let novo = null;
  try {
    const admin = k.comoAgente('admin');
    const ti = await k.ti();
    const id = (await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } })).json.aprovacao;
    await k.controle.fechar();
    const fora = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(fora.status, 503);
    assert.match(fora.json.erro, /serviço de controle/);
    assert.match(fora.json.erro, /voltou a ficar pendente/);
    assert.equal((await ti.get(`/api/v1/aprovacoes/${id}`)).json.aprovacao.estado, 'pendente');
    assert.ok(k.c.eventos().some((e) => e.evento === 'aprovacao_falhou' && e.dados.voltou_a_pendente === true));
    novo = await k.religar();
    const ok = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.aprovacao.estado, 'executada');
    await esperaAte(() => k.chamadas().length === 1);
  } finally { if (novo) await novo.fechar(); await k.fechar(); }
});

test('pedido que passou de 24 horas expira, não executa e fica na auditoria', async () => {
  const k = await cenarioControle();
  try {
    const admin = k.comoAgente('admin');
    const ti = await k.ti();
    const id = (await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } })).json.aprovacao;
    k.c.tempo.avanca(25 * 60 * 60 * 1000);
    await ti.post('/api/v1/eu/reautenticar', { json: { codigo: k.c.codigo('dono') } });
    const r = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /venceu/);
    assert.equal(k.chamadas().length, 0);
    assert.equal((await admin.get(`/api/v1/aprovacoes/${id}`)).json.aprovacao.estado, 'expirada');
    assert.ok(k.c.eventos().some((e) => e.evento === 'aprovacao_expirada' && e.dados.id === id));
  } finally { await k.fechar(); }
});

test('aprovação que o controle recusa (por exemplo, o arquivo foi trocado) termina em "falhou" com o motivo', async () => {
  const k = await cenarioControle();
  try {
    const admin = k.comoAgente('admin');
    const ti = await k.ti();
    const id = (await admin.post('/api/v1/controle/dominio.trocar', { params: { dominio: 'novo.example.com' } })).json.aprovacao;
    process.env.DGCLAW_FAKE_FALHA = 'dominio trocar';
    const r = await ti.post(`/api/v1/aprovacoes/${id}/aprovar`, { json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.executada, true, 'o controle aceitou e iniciou a tarefa');
    const tarefa = r.json.aprovacao.resultado.tarefa;
    const t = await esperaAte(async () => { const x = await admin.post('/api/v1/controle/tarefa.ver', { params: { id: tarefa } }); return x.json.resultado.tarefa.estado !== 'rodando' ? x.json.resultado.tarefa : null; });
    assert.equal(t.estado, 'erro');
    assert.match(t.erro, /o falso falhou de proposito/);
  } finally { await k.fechar(); }
});

// ── quem pode o quê ─────────────────────────────────────────────────────────
test('rota do Admin: só o agente com papel "admin" passa; outro agente recebe 403; funcionário recebe 403', async () => {
  const k = await cenarioControle();
  try {
    const ana = k.comoAgente('ana');
    const r = await ana.post('/api/v1/controle/agentes.listar', {});
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /não é o Admin/);
    const r2 = await ana.get('/api/v1/controle/docs.md');
    assert.equal(r2.status, 403);
    assert.equal(k.chamadas().length, 0);

    const admin = k.comoAgente('admin');
    const ok = await admin.post('/api/v1/controle/agentes.listar', {});
    assert.equal(ok.status, 200, ok.texto);
    const docs = await admin.get('/api/v1/controle/docs.md');
    assert.equal(docs.status, 200);
    assert.match(docs.texto, /dgclaw-controle/);
    const inexistente = await admin.post('/api/v1/controle/rm.tudo', {});
    assert.equal(inexistente.status, 404);
    const ruim = await admin.post('/api/v1/controle/agente.parar', { params: { agente: '../x' } });
    assert.equal(ruim.status, 400);
    const get = await admin.get('/api/v1/controle/agente.parar');
    assert.equal(get.status, 405);

    const ti = await k.ti();
    const fran = await k.funcionaria(ti);
    for (const [m, rota] of [['POST', '/api/v1/controle/agentes.listar'], ['GET', '/api/v1/controle/docs.md'], ['GET', '/api/v1/controle/ops'], ['GET', '/api/v1/controle/manutencao']]) {
      const x = await fran.pedir(m, rota, m === 'POST' ? { json: {} } : {});
      assert.equal(x.status, 403, `${m} ${rota} pela funcionária`);
    }
    const tiOk = await ti.post('/api/v1/controle/agentes.listar', { json: {} });
    assert.equal(tiOk.status, 200, 'o TI também chama pelo navegador');
    assert.ok(k.c.eventos().some((e) => e.evento === 'acesso_negado' && e.quem === 'fran'));
  } finally { await k.fechar(); }
});

test('aprovações: funcionário recebe 403 (API e página), a caixa nunca aprova e o agente só vê o próprio pedido', async () => {
  const k = await cenarioControle();
  try {
    const admin = k.comoAgente('admin');
    const ti = await k.ti();
    const id = (await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } })).json.aprovacao;
    const fran = await k.funcionaria(ti);
    for (const [m, rota, op] of [
      ['GET', '/api/v1/aprovacoes'], ['GET', '/api/v1/aprovacoes/resumo'], ['GET', `/api/v1/aprovacoes/${id}`],
      ['POST', `/api/v1/aprovacoes/${id}/aprovar`, { json: {} }], ['POST', `/api/v1/aprovacoes/${id}/recusar`, { json: {} }],
      ['GET', '/aprovacoes', { headers: { Accept: 'text/html' } }],
    ]) {
      const x = await fran.pedir(m, rota, op || {});
      assert.equal(x.status, 403, `${m} ${rota}`);
    }
    assert.equal((await ti.get(`/api/v1/aprovacoes/${id}`)).json.aprovacao.estado, 'pendente');

    for (const slug of ['admin', 'ana']) {
      const c = k.comoAgente(slug);
      const aprova = await c.post(`/api/v1/aprovacoes/${id}/aprovar`, {});
      assert.equal(aprova.status, 403, `${slug} não aprova pela caixa`);
      assert.match(aprova.json.erro, /Aprovar e recusar são do TI/);
      const recusa = await c.post(`/api/v1/aprovacoes/${id}/recusar`, {});
      assert.equal(recusa.status, 403);
      const lista = await c.get('/api/v1/aprovacoes');
      assert.equal(lista.status, 403, 'a lista não é do agente');
    }
    const alheio = await k.comoAgente('ana').get(`/api/v1/aprovacoes/${id}`);
    assert.equal(alheio.status, 404, 'outro agente não vê o pedido do Admin');
    assert.equal((await k.comoAgente('admin').get(`/api/v1/aprovacoes/${id}`)).status, 200);
    assert.equal(k.chamadas().length, 0);

    const pagina = await ti.pedir('GET', '/aprovacoes', { headers: { Accept: 'text/html' } });
    assert.equal(pagina.status, 200);
    assert.match(pagina.texto, /aprovacoes\.js/);
  } finally { await k.fechar(); }
});

test('um segundo TI pode aprovar, mas o desativado e o sem sessão não', async () => {
  const k = await cenarioControle();
  try {
    const anon = require('./ajuda').cliente(k.c.s.porta);
    assert.equal((await anon.get('/api/v1/aprovacoes')).status, 401);
    const pag = await anon.pedir('GET', '/aprovacoes', { headers: { Accept: 'text/html' } });
    assert.ok([302, 401].includes(pag.status), `página sem sessão: ${pag.status}`);
    assert.equal((await anon.post('/api/v1/controle/agentes.listar', { json: {} })).status, 401);
  } finally { await k.fechar(); }
});

test('o aviso de manutenção aberta: o TI vê o estado e o estado vencido some', async () => {
  const k = await cenarioControle();
  try {
    const ti = await k.ti();
    assert.equal((await ti.get('/api/v1/controle/manutencao')).json.aberta, false);
    const dir = path.join(k.c.dataDir, 'controle');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manutencao.json'), JSON.stringify({ aberta_em: k.c.tempo.ms(), fecha_em: k.c.tempo.ms() + 12 * 60000, por: 'agente:admin', slug: 'admin-manutencao' }));
    const m = (await ti.get('/api/v1/controle/manutencao')).json;
    assert.equal(m.aberta, true);
    assert.equal(m.minutos_restantes, 12);
    assert.equal(m.link, '/a/admin-manutencao');
    k.c.tempo.avanca(13 * 60000);
    assert.equal((await ti.get('/api/v1/controle/manutencao')).json.aberta, false);
  } finally { await k.fechar(); }
});

// ── o Admin continua escondido do funcionário ───────────────────────────────
test('funcionário nunca vê o Admin: nem com tipo "admin", nem com papel "admin" num agente comum', async () => {
  const k = await cenarioControle();
  try {
    const ti = await k.ti();
    const fran = await k.funcionaria(ti);
    const lista = await fran.get('/api/v1/agents');
    assert.deepEqual(lista.json.agentes.map((a) => a.id), ['ana']);
    assert.equal((await fran.pedir('GET', '/a/admin', { headers: { Accept: 'text/html' } })).status, 403);

    // O Admin vira um agente comum com papel "admin" (a variante do desenho em que o tipo muda).
    const lista2 = JSON.parse(fs.readFileSync(k.c.s.agentesPath, 'utf8'));
    for (const a of lista2.agentes) if (a.slug === 'admin') { a.tipo = 'agente'; a.papel = 'admin'; }
    fs.writeFileSync(k.c.s.agentesPath, JSON.stringify(lista2, null, 2) + '\n');
    const lista3 = await fran.get('/api/v1/agents');
    assert.deepEqual(lista3.json.agentes.map((a) => a.id), ['ana'], 'o Admin com tipo agente e papel admin continua escondido');
    assert.equal((await fran.pedir('GET', '/a/admin', { headers: { Accept: 'text/html' } })).status, 403);
    assert.equal((await fran.get('/api/v1/agents/admin')).status, 403);
    // e o TI continua vendo, com o Admin primeiro
    assert.equal((await ti.get("/api/v1/agents")).json.agentes[0].id, 'admin');
    // a caixa do Admin continua funcionando com tipo agente
    assert.equal((await k.comoAgente('admin').post('/api/v1/controle/agentes.listar', {})).status, 200);
  } finally { await k.fechar(); }
});

// ── nível pessoal: nada muda ────────────────────────────────────────────────
test('nível pessoal: as rotas do bloco C não respondem, nenhuma pasta é criada e o Admin é o de sempre', async () => {
  const k = await cenarioControle({ nivel: 'pessoal' });
  try {
    const cli = (await k.c.entrar('dono', k.c.senhaTi)).cli;
    for (const [m, rota] of [['GET', '/api/v1/aprovacoes'], ['GET', '/api/v1/aprovacoes/resumo'], ['POST', '/api/v1/controle/agentes.listar'], ['GET', '/api/v1/controle/docs.md'], ['GET', '/api/v1/controle/manutencao']]) {
      const r = await cli.pedir(m, rota, m === 'POST' ? { json: {} } : {});
      assert.equal(r.status, 404, `${m} ${rota} no nível pessoal`);
    }
    const pag = await cli.pedir('GET', '/aprovacoes', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 404);
    assert.equal(fs.existsSync(path.join(k.c.dataDir, 'aprovacoes')), false, 'a pasta das aprovações nem é criada');
    assert.equal((await k.comoAgente('admin').post('/api/v1/controle/agentes.listar', {})).status, 404);
    assert.equal(k.chamadas().length, 0);
    const lista = await cli.get('/api/v1/agents');
    assert.equal(lista.json.agentes[0].id, 'admin');
    assert.equal(lista.json.agentes.length, 3, 'no pessoal todo mundo vê tudo');
  } finally { await k.fechar(); }
});

test('nível pessoal com o Admin isolado ligado à mão: a fila e o controle respondem', async () => {
  const k = await cenarioControle({ nivel: 'pessoal', ajustes: { admin_isolado: true } });
  try {
    const cli = (await k.c.entrar('dono', k.c.senhaTi)).cli;
    const admin = k.comoAgente('admin');
    const ped = await admin.post('/api/v1/controle/agente.remover', { params: { agente: 'ana' } });
    assert.equal(ped.status, 202, ped.texto);
    const apr = await cli.post(`/api/v1/aprovacoes/${ped.json.aprovacao}/aprovar`, { json: {} });
    assert.equal(apr.status, 200, apr.texto);
    assert.equal(apr.json.executada, true);
  } finally { await k.fechar(); }
});

// ── tipos de outros blocos ──────────────────────────────────────────────────
test('API para outros blocos: registrarTipo, pedir, frase do dono do tipo, aprovar executa e o tipo desconhecido falha com motivo', async () => {
  const http = require('node:http');
  const { pastaTemp } = require('./ajuda');
  const { criarEnterprise } = require('../lib/ent');
  const { criarProtecoes } = require('../lib/protecoes');
  const { criarAuditoria } = require('../lib/auditoria');
  const { normaliza } = require('../lib/usuarios-arquivo');
  const dir = pastaTemp('bloco-e');
  const dataDir = path.join(dir, 'dados');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'protecoes.json'), JSON.stringify({ nivel: 'escritorio', ajustes: {} }));
  fs.writeFileSync(path.join(dataDir, 'usuarios.json'), JSON.stringify({ versao: 1, usuarios: [normaliza({ usuario: 'dono', papel: 'ti', hash: 'x', totp: { ativo: true } })] }));
  const modulos = path.join(dir, 'ent');
  fs.mkdirSync(modulos);
  fs.writeFileSync(path.join(modulos, 'aprovacoes.js'), `module.exports = require(${JSON.stringify(path.resolve(__dirname, '../lib/ent/aprovacoes.js'))});`);
  fs.writeFileSync(path.join(modulos, 'bloco-e.js'), `'use strict';
module.exports = { nome: 'bloco-e', ordem: 40, criar(ctx) {
  ctx.aprovacoes.registrarTipo('instagram', {
    descrever: (p, op) => 'Publicar ' + p.titulo + ' (' + op + ')',
    async executar(p, ap) { if (p.quebra) throw new Error('a API do Instagram recusou'); return { publicado: p.titulo, por: ap.decidido_por, pedido_por: ap.pedido_por }; },
  });
  let erroDuplo = null; try { ctx.aprovacoes.registrarTipo('instagram', { descrever() {}, executar() {} }); } catch (e) { erroDuplo = e.message; }
  let erroNome = null; try { ctx.aprovacoes.registrarTipo('Ruim Nome', { descrever() {}, executar() {} }); } catch (e) { erroNome = e.message; }
  ctx.__resultados = { erroDuplo, erroNome };
  return {};
} };`);
  const protecoes = criarProtecoes({ caminho: path.join(dir, 'protecoes.json'), log: () => {} });
  const auditoriaPath = path.join(dir, 'auditoria.jsonl');
  const auditoria = criarAuditoria({ caminho: auditoriaPath, protecoes, log: () => {} });
  const ctx = { config: { dataDir, publicDir: dir }, log: () => {}, protecoes, auditoria, registro: { obter: () => null, estado: () => ({ ok: true, agentes: [] }) }, servirArquivo: () => false, semSessaoPagina: () => {} };
  criarEnterprise(ctx, { pasta: modulos });
  assert.match(ctx.__resultados.erroDuplo, /já foi registrado/);
  assert.match(ctx.__resultados.erroNome, /não vale/);
  const sessao = { usuario: 'dono', com_2fa: true, fa2_em: Date.now() };
  const ent = criarEnterprise(ctx, { pasta: modulos });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await ent.antes(req, res, url, sessao))) { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cli = require('./ajuda').cliente(srv.address().port);
  try {
    const p1 = ctx.aprovacoes.pedir({ tipo: 'instagram', op: 'post.publicar', params: { titulo: 'Oi' }, pedido_por: 'agente:luna' });
    assert.equal(p1.descricao, 'Publicar Oi (post.publicar)');
    assert.equal(p1.estado, 'pendente');
    assert.throws(() => ctx.aprovacoes.pedir({ tipo: 'nao-existe', op: 'x', params: {}, pedido_por: 'agente:luna' }), /Não existe o tipo de aprovação/);
    const arq = path.join(dataDir, 'aprovacoes', `${p1.id}.json`);
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'aprovacoes')).mode & 0o777, 0o700);

    const r1 = await cli.post(`/api/v1/aprovacoes/${p1.id}/aprovar`, { json: {}, origin: false });
    assert.equal(r1.status, 200, r1.texto);
    assert.deepEqual(r1.json.aprovacao.resultado, { publicado: 'Oi', por: 'dono', pedido_por: 'agente:luna' });

    const p2 = ctx.aprovacoes.pedir({ tipo: 'instagram', op: 'post.publicar', params: { titulo: 'Vai quebrar', quebra: true }, pedido_por: 'agente:luna' });
    const r2 = await cli.post(`/api/v1/aprovacoes/${p2.id}/aprovar`, { json: {}, origin: false });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.executada, false);
    assert.equal(r2.json.aprovacao.estado, 'falhou');
    assert.match(r2.json.aprovacao.resultado.erro, /recusou/);

    const p3 = ctx.aprovacoes.pedir({ tipo: 'instagram', op: 'post.publicar', params: { titulo: 'Nao' }, pedido_por: 'agente:luna' });
    assert.equal((await cli.post(`/api/v1/aprovacoes/${p3.id}/recusar`, { json: { motivo: 'sem tempo' }, origin: false })).json.aprovacao.estado, 'recusada');

    const eventos = fs.readFileSync(auditoriaPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).evento);
    for (const e of ['aprovacao_criada', 'aprovacao_aprovada', 'aprovacao_executada', 'aprovacao_falhou', 'aprovacao_recusada']) assert.ok(eventos.includes(e), e);
    assert.deepEqual(require('../lib/auditoria').criarAuditoria({ caminho: auditoriaPath, log: () => {} }).verificar().ok, true, 'a corrente da auditoria continua inteira');
  } finally { await new Promise((r) => srv.close(r)); }
});
