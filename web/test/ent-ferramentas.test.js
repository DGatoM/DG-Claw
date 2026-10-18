'use strict';
// Bloco I: verificador de saída, esquema, núcleo do serviço de ferramentas (executor em processo filho de verdade, em Python),
// o socket e o teste sintético do exemplo. Nada de rede: a "base da empresa" é um SQLite falso gerado na hora.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { verificar, cpfValido } = require('../../ferramentas/verificador');
const esquema = require('../../ferramentas/esquema');
const { criarNucleo } = require('../../ferramentas/nucleo');
const { criarServidor } = require('../../ferramentas/servidor');
const { testarFerramenta } = require('../../ferramentas/testar');
const { chamar } = require('../lib/ferramentas-cliente');
const { pastaFerramentas, EXEMPLO } = require('./ent-ferramentas-ajuda');
const { pastaTemp } = require('./ajuda');

const nucleoDe = (p, extra) => criarNucleo(Object.assign({ dir: p.dir, tmpBase: p.tmpBase, log: () => {} }, extra));
const CPF = '529.982.247-25';

// ── verificador ─────────────────────────────────────────────────────────────
test('verificador: CPF com e sem pontuação, com dígito verificador válido', () => {
  assert.ok(cpfValido('52998224725'));
  assert.deepEqual(verificar({ a: `cliente ${CPF}` }).tipos, ['cpf']);
  assert.deepEqual(verificar({ a: '52998224725' }).tipos, ['cpf']);
  assert.deepEqual(verificar('cpf 529.98224725').tipos, ['cpf']);
  assert.equal(verificar({ a: '529.982.247-26' }).achou, false, 'dígito errado não é CPF');
  assert.equal(verificar({ a: '11111111111' }).achou, false, 'dígitos repetidos não são CPF');
});

test('verificador: CNPJ, e-mail, telefone, cartão e data de nascimento', () => {
  assert.deepEqual(verificar({ x: '11.222.333/0001-81' }).tipos, ['cnpj']);
  assert.deepEqual(verificar({ x: 'maria@empresa.com.br' }).tipos, ['email']);
  assert.deepEqual(verificar({ x: '(11) 91234-5678' }).tipos, ['telefone']);
  assert.deepEqual(verificar({ x: '+55 21 3456-7890' }).tipos, ['telefone']);
  assert.deepEqual(verificar({ x: '11912345678' }).tipos, ['telefone']);
  assert.deepEqual(verificar({ x: '4111 1111 1111 1111' }).tipos, ['cartao']);
  assert.equal(verificar({ x: '4111 1111 1111 1112' }).achou, false, 'Luhn inválido não é cartão');
  assert.deepEqual(verificar({ x: '15/03/1985' }, { agora: Date.parse('2026-10-18') }).tipos, ['data_nascimento']);
  assert.deepEqual(verificar({ x: '1985-03-15' }, { agora: Date.parse('2026-10-18') }).tipos, ['data_nascimento']);
  assert.equal(verificar({ x: '1985-03-15' }, { agora: Date.parse('2026-10-18'), permitir: ['data_nascimento'] }).achou, false, 'a ferramenta pode renunciar à data');
});

test('verificador: números e períodos de um relatório agregado não disparam alarme', () => {
  const lixo = { periodo: '2026-09', pessoas: 22, valor_total: 12345678.9, soma: 1234567890, faixa: '18-29', mes_ref: '09/2026', intervalo: '2025-2026', dia: '2026-10-01', taxa: 0.0525 };
  assert.deepEqual(verificar(lixo, { agora: Date.parse('2026-10-18') }), { achou: false, tipos: [], quantidade: {} });
});

test('verificador: nomes da base, sem diferenciar acento nem maiúscula, e só palavras inteiras', () => {
  const nomes = ['José da Conceição', 'Ana Maria Braga', 'Li'];
  assert.deepEqual(verificar({ obs: 'cliente JOSE DA CONCEICAO comprou' }, { nomes }).tipos, ['nome']);
  assert.deepEqual(verificar({ obs: 'ana maria braga' }, { nomes }).tipos, ['nome']);
  assert.equal(verificar({ obs: 'Anamaria Bragança' }, { nomes }).achou, false);
  assert.equal(verificar({ obs: 'Li' }, { nomes }).achou, false, 'nome de menos de 4 letras é ignorado (gera falso alarme demais)');
});

test('verificador: devolve só tipo e quantidade, nunca o dado achado', () => {
  const r = verificar({ a: CPF, b: 'x@y.com' });
  assert.equal(JSON.stringify(r).includes('529'), false);
  assert.equal(JSON.stringify(r).includes('x@y'), false);
  assert.deepEqual(r.quantidade, { cpf: 1, email: 1 });
});

// ── esquema ─────────────────────────────────────────────────────────────────
test('esquema: ferramenta.json aceito, com os padrões preenchidos', () => {
  const def = JSON.parse(fs.readFileSync(path.join(EXEMPLO, 'ferramenta.json'), 'utf8'));
  const r = esquema.validarDefinicao(def, 'carteira.resumo');
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.def.minimo_grupo, 10);
  assert.equal(r.def.gera_arquivo, false);
});

test('esquema: campo desconhecido, nome diferente da pasta, sem agente e texto PREENCHER são recusados com o motivo', () => {
  const base = JSON.parse(fs.readFileSync(path.join(EXEMPLO, 'ferramenta.json'), 'utf8'));
  const ruim = (mudanca, trecho) => {
    const r = esquema.validarDefinicao(Object.assign({}, base, mudanca), 'carteira.resumo');
    assert.equal(r.ok, false, JSON.stringify(mudanca));
    assert.match(r.erro, trecho);
  };
  ruim({ consulta_livre: 'SELECT 1' }, /campo "consulta_livre"/);
  ruim({ nome: 'outra' }, /diferente do nome da pasta/);
  ruim({ agentes: [] }, /pelo menos um slug/);
  ruim({ finalidade: 'PREENCHER: por que' }, /ainda está com o texto PREENCHER/);
  ruim({ timeout_s: 90 }, /1 a 25/);
  ruim({ permitir_tipos: ['cpf'] }, /só aceita data_nascimento/);
  ruim({ parametros: { sql: { tipo: 'texto' } } }, /precisa de "regex"/);
  ruim({ parametros: { x: { tipo: 'livre' } } }, /tipo "livre"/);
});

test('esquema: parâmetros fora do esquema, tipo errado e limites', () => {
  const ps = {
    periodo: { tipo: 'periodo', obrigatorio: true },
    por: { tipo: 'enum', valores: ['a', 'b'], padrao: 'a' },
    n: { tipo: 'inteiro', min: 1, max: 10 },
    d: { tipo: 'data' },
    t: { tipo: 'texto', regex: '^[a-z]+$', max: 5 },
  };
  const v = (x) => esquema.validarParametros(ps, x);
  assert.deepEqual(v({ periodo: '2026-09' }).params, { periodo: '2026-09', por: 'a' });
  assert.match(v({}).erro, /Falta o parâmetro "periodo"/);
  assert.match(v({ periodo: '2026-09', sql: '1' }).erro, /não existe nesta ferramenta/);
  assert.match(v({ periodo: '2026-13' }).erro, /AAAA-MM/);
  assert.match(v({ periodo: '2026-09', por: 'c' }).erro, /precisa ser um destes: a, b/);
  assert.equal(v({ periodo: '2026-09', n: '7' }).params.n, 7, 'inteiro vindo da linha de comando (texto) vale');
  assert.match(v({ periodo: '2026-09', n: 11 }).erro, /no máximo 10/);
  assert.match(v({ periodo: '2026-09', n: '1e3' }).erro, /inteiro/);
  assert.match(v({ periodo: '2026-09', d: '2026-02-30' }).erro, /data real/);
  assert.match(v({ periodo: '2026-09', t: 'abc\n' }).erro, /quebra de linha|formato/);
  assert.match(v({ periodo: '2026-09', t: 'abcdefg' }).erro, /passa de 5/);
  assert.match(v([]).erro, /objeto JSON/);
  assert.match(v(JSON.parse('{"periodo":"2026-09","__proto__":{"x":1}}')).erro, /__proto__/);
});

// ── núcleo: o exemplo de ponta a ponta ──────────────────────────────────────
test('exemplo carteira.resumo: números agregados, grupo pequeno suprimido e NENHUM nome ou CPF da base na saída', async () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  const n = nucleoDe(p);
  const r = await n.executar({ ferramenta: 'carteira.resumo', agente: 'ana', usuario: 'dono', params: { periodo: '2026-09', agrupar_por: 'faixa_etaria' } });
  assert.equal(r.ok, true, r.erro);
  const texto = JSON.stringify(r.resultado);
  for (const s of p.segredos()) assert.equal(texto.includes(s), false, `vazou: ${s.slice(0, 4)}...`);
  const grupos = Object.fromEntries(r.resultado.grupos.map((g) => [g.grupo, g]));
  assert.equal(grupos['18-29'].pessoas, 22);
  assert.equal(grupos['30-44'].pessoas, 25, 'a linha de agosto ficou de fora');
  assert.equal(grupos['60+'].pessoas, 'menos de 10');
  assert.equal(grupos['60+'].valor_total, 'suprimido');
  assert.equal(r.meta.registros_lidos, 60);
  assert.match(r.meta.hash_resultado, /^[0-9a-f]{64}$/);
  assert.equal(r.meta.verificador, 'aprovado');
  assert.equal(Object.hasOwn(r.meta, 'nomes_proibidos'), false);
});

test('exemplo: o teste sintético da própria ferramenta passa (nenhum nome ou CPF vaza, o malicioso é bloqueado)', async () => {
  const r = await testarFerramenta(EXEMPLO);
  assert.deepEqual(r.casos.filter((c) => !c.ok), []);
  assert.equal(r.ok, true);
  assert.equal(r.casos.length, 7);
});

test('teste sintético acusa o vazamento quando o executor devolve o CPF e o verificador está de olho', async () => {
  const p = pastaFerramentas();
  const pasta = p.instalarExemplo(['ana']);
  const ex = path.join(pasta, 'executor.py');
  // um executor que ignora a regra e imprime o nome da primeira pessoa em "grupos": o teste do kit precisa falhar
  fs.writeFileSync(ex, fs.readFileSync(ex, 'utf8').replace('resumo = agregar', 'resumo = [{"grupo": nomes[0], "pessoas": 99}]  # vaza\n    _ = agregar'));
  const r = await testarFerramenta(pasta);
  assert.equal(r.ok, false);
  assert.ok(r.casos.some((c) => !c.ok && /esperava "ok" e veio "bloqueado_pelo_verificador"/.test(c.detalhe)));
});

test('agente que não está na lista da ferramenta não executa (agente_nao_autorizado)', async () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  const n = nucleoDe(p);
  const r = await n.executar({ ferramenta: 'carteira.resumo', agente: 'marina', params: { periodo: '2026-09' } });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'agente_nao_autorizado');
  assert.deepEqual(n.listar('marina').ferramentas, []);
  assert.equal(n.listar('ana').ferramentas.length, 1);
});

test('parâmetro fora do esquema é recusado e o executor nem chega a rodar', async () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  const n = nucleoDe(p);
  for (const params of [{ periodo: '2026-09', agrupar_por: 'cpf' }, { periodo: '2026-09', consulta: 'SELECT * FROM carteira' }, { agrupar_por: 'plano' }, { periodo: "2026-09'; DROP TABLE carteira;--" }]) {
    const r = await n.executar({ ferramenta: 'carteira.resumo', agente: 'ana', params });
    assert.equal(r.motivo, 'parametros', JSON.stringify(params));
  }
  assert.deepEqual(p.arquivosNoTmp(), [], 'recusa antes de criar pasta temporária');
});

test('nome de ferramenta com ../ ou fora do formato não sai da pasta', async () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  const n = nucleoDe(p);
  for (const nome of ['../ferramentas', 'carteira.resumo/../../x', '/etc/passwd', 'Carteira', 'a b']) {
    const r = await n.executar({ ferramenta: nome, agente: 'ana', params: {} });
    assert.equal(r.motivo, 'ferramenta_desconhecida', nome);
  }
});

test('executor que estoura o tempo é morto, reportado, e a pasta temporária some', async () => {
  const p = pastaFerramentas();
  p.criar('lento', 'import time, subprocess\nsubprocess.Popen(["sleep", "30"])\ntime.sleep(30)\n', { timeout_s: 1 });
  const n = nucleoDe(p);
  const t0 = Date.now();
  const r = await n.executar({ ferramenta: 'lento', agente: 'ana', params: {} });
  assert.equal(r.motivo, 'tempo_esgotado');
  assert.ok(Date.now() - t0 < 6000, 'matou em vez de esperar os 30 s');
  assert.match(r.erro, /passou de 1 s/);
  assert.deepEqual(p.arquivosNoTmp(), []);
  assert.equal(n.emExecucao(), 0);
});

test('executor que estoura a memória é reportado como memoria_esgotada', async () => {
  const p = pastaFerramentas();
  p.criar('guloso', 'x = bytearray(2 * 1024 * 1024 * 1024)\n', { memoria_mb: 128 });
  const r = await nucleoDe(p).executar({ ferramenta: 'guloso', agente: 'ana', params: {} });
  assert.equal(r.motivo, 'memoria_esgotada');
});

test('a pasta temporária existe durante a execução, é do executor e some no fim, também quando ele falha', async () => {
  const p = pastaFerramentas();
  const cod = 'import os, json\nfrom dgclaw_ferramenta import resultado, pasta_saida\nopen(os.path.join(pasta_saida(), "lixo.txt"), "w").write("segredo-em-disco")\nresultado({"tmp": os.environ["TMPDIR"], "home": os.environ["HOME"]}, registros_lidos=0)\n';
  p.criar('rastro', cod);
  p.criar('quebra', 'raise SystemExit(3)\n');
  const n = nucleoDe(p);
  const r = await n.executar({ ferramenta: 'rastro', agente: 'ana', params: {} });
  assert.equal(r.ok, true, r.erro);
  assert.ok(r.resultado.tmp.startsWith(p.tmpBase), 'o executor trabalha dentro da pasta temporária');
  assert.equal(fs.existsSync(r.resultado.tmp), false);
  const q = await n.executar({ ferramenta: 'quebra', agente: 'ana', params: {} });
  assert.equal(q.motivo, 'falha_execucao');
  assert.deepEqual(p.arquivosNoTmp(), []);
});

test('o executor roda com ambiente limpo: só a credencial da própria ferramenta, nada do host', async () => {
  const p = pastaFerramentas();
  p.criar('ambiente', 'import os\nfrom dgclaw_ferramenta import resultado\nresultado({"chaves": sorted(os.environ)}, registros_lidos=0)\n');
  fs.writeFileSync(path.join(p.dir, 'ambiente', 'credenciais.env'), '# senha do banco\nBANCO_SENHA=abc\nBANCO_URL="postgres://x"\n', { mode: 0o600 });
  process.env.SEGREDO_DO_HOST_DO_TESTE = 'nao-pode-aparecer';
  try {
    const r = await nucleoDe(p).executar({ ferramenta: 'ambiente', agente: 'ana', params: {} });
    assert.equal(r.ok, true, r.erro);
    assert.ok(r.resultado.chaves.includes('BANCO_SENHA'));
    assert.ok(r.resultado.chaves.includes('BANCO_URL'));
    assert.equal(r.resultado.chaves.includes('SEGREDO_DO_HOST_DO_TESTE'), false);
    assert.equal(r.resultado.chaves.includes('ANTHROPIC_API_KEY'), false);
  } finally { delete process.env.SEGREDO_DO_HOST_DO_TESTE; }
});

test('credencial com permissão aberta ou com nome reservado recusa a execução e diz o que fazer', async () => {
  const p = pastaFerramentas();
  p.criar('cred', 'from dgclaw_ferramenta import resultado\nresultado({}, registros_lidos=0)\n');
  const arq = path.join(p.dir, 'cred', 'credenciais.env');
  const logs = [];
  const n = nucleoDe(p, { log: (nivel, m) => logs.push(m) });
  fs.writeFileSync(arq, 'A=1\n', { mode: 0o644 });
  fs.chmodSync(arq, 0o644);
  assert.equal((await n.executar({ ferramenta: 'cred', agente: 'ana', params: {} })).motivo, 'credencial');
  assert.ok(logs.some((m) => /precisa ser 600.*chmod 600/.test(m)));
  fs.writeFileSync(arq, 'PATH=/tmp\n');
  fs.chmodSync(arq, 0o600);
  assert.equal((await n.executar({ ferramenta: 'cred', agente: 'ana', params: {} })).motivo, 'credencial');
  assert.ok(logs.some((m) => /nome PATH não pode ser usado/.test(m)));
});

test('verificador no serviço: executor malicioso que devolve CPF, e-mail ou nome da base tem a resposta inteira bloqueada, sem o dado', async () => {
  const p = pastaFerramentas();
  p.criar('cpf', `from dgclaw_ferramenta import resultado\nresultado({"total": 5, "obs": "cliente ${CPF}"}, registros_lidos=5)\n`);
  p.criar('email', 'from dgclaw_ferramenta import resultado\nresultado({"total": 5, "obs": "fulano@empresa.com"}, registros_lidos=5)\n');
  p.criar('nome', 'from dgclaw_ferramenta import resultado\nresultado({"total": 5, "obs": "Hermenegildo Quintanilha"}, registros_lidos=5, nomes_proibidos=["Hermenegildo Quintanilha"])\n');
  p.criar('arquivo-nomes', 'from dgclaw_ferramenta import resultado\nresultado({"obs": "Epaminondas Souza"}, registros_lidos=1)\n');
  fs.writeFileSync(path.join(p.dir, 'arquivo-nomes', 'nomes-proibidos.txt'), 'Epaminondas Souza\n');
  const n = nucleoDe(p);
  for (const [nome, tipo] of [['cpf', 'cpf'], ['email', 'email'], ['nome', 'nome'], ['arquivo-nomes', 'nome']]) {
    const r = await n.executar({ ferramenta: nome, agente: 'ana', params: {} });
    assert.equal(r.ok, false, nome);
    assert.equal(r.motivo, 'bloqueado_pelo_verificador');
    assert.deepEqual(r.tipos, [tipo]);
    assert.match(r.erro, /O resultado foi bloqueado porque continha dado pessoal/);
    assert.equal(r.resultado, undefined, 'nenhum pedaço do resultado volta');
    assert.equal(r.meta.registros_lidos != null, true, 'a auditoria ainda sabe quantos registros foram lidos');
    for (const dado of ['529', 'fulano@', 'Hermenegildo', 'Epaminondas']) assert.equal(JSON.stringify(r).includes(dado), false, `${nome} vazou ${dado}`);
  }
});

test('saída que não é JSON, grande demais ou executor sem o resultado() viram erro explicado', async () => {
  const p = pastaFerramentas();
  p.criar('texto', 'print("oi")\n');
  p.criar('enorme', 'import sys\nsys.stdout.write("x" * (300 * 1024))\n');
  const n = nucleoDe(p);
  assert.equal((await n.executar({ ferramenta: 'texto', agente: 'ana', params: {} })).motivo, 'saida_invalida');
  const e = await n.executar({ ferramenta: 'enorme', agente: 'ana', params: {} });
  assert.equal(e.motivo, 'saida_invalida');
  assert.match(e.erro, /limite/);
});

test('registros_lidos que o executor não informa vira null (não medido), nunca zero', async () => {
  const p = pastaFerramentas();
  p.criar('mudo', 'import json\nprint(json.dumps({"total": 3}))\n');
  const r = await nucleoDe(p).executar({ ferramenta: 'mudo', agente: 'ana', params: {} });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.meta.registros_lidos, null);
});

test('pseudonimizar: estável, diferente por valor, e muda com outra chave; sem chave dá erro que diz o que fazer', async () => {
  const p = pastaFerramentas();
  const cod = 'from dgclaw_ferramenta import pseudonimizar, resultado\nresultado({"a": pseudonimizar("52998224725"), "b": pseudonimizar("52998224725"), "c": pseudonimizar("outro")}, registros_lidos=2)\n';
  p.criar('pseudo', cod);
  const n = nucleoDe(p);
  const r1 = await n.executar({ ferramenta: 'pseudo', agente: 'ana', params: {} });
  assert.equal(r1.ok, true, r1.erro);
  assert.equal(r1.resultado.a, r1.resultado.b);
  assert.notEqual(r1.resultado.a, r1.resultado.c);
  assert.match(r1.resultado.a, /^p_[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(r1).includes('52998224725'), false);
  fs.writeFileSync(p.chave, 'b'.repeat(64));
  const r2 = await n.executar({ ferramenta: 'pseudo', agente: 'ana', params: {} });
  assert.notEqual(r2.resultado.a, r1.resultado.a, 'outra chave, outro pseudônimo');
  fs.rmSync(p.chave);
  const logs = [];
  const r3 = await nucleoDe(p, { log: (nivel, m) => logs.push(m) }).executar({ ferramenta: 'pseudo', agente: 'ana', params: {} });
  assert.equal(r3.motivo, 'falha_execucao');
  assert.ok(logs.some((m) => /dgclaw ferramenta chave/.test(m)), 'o log do servidor diz como criar a chave');
});

test('agregar: grupo abaixo do mínimo vira "menos de N" e o mínimo da ferramenta manda', async () => {
  const p = pastaFerramentas();
  const cod = 'from dgclaw_ferramenta import agregar, resultado\nl = [{"g": "a", "v": 1}] * 5 + [{"g": "b", "v": 2}] * 4 + [{"g": "c", "v": 3}] * 2\nresultado({"r": agregar(l, por="g", medidas={"soma": ("soma", "v")})}, registros_lidos=11)\n';
  p.criar('agrega', cod, { minimo_grupo: 5 });
  const r = await nucleoDe(p).executar({ ferramenta: 'agrega', agente: 'ana', params: {} });
  assert.deepEqual(r.resultado.r, [
    { g: 'a', pessoas: 5, soma: 5 },
    { g: 'b', pessoas: 'menos de 5', soma: 'suprimido' },
    { g: 'c', pessoas: 'menos de 5', soma: 'suprimido' },
  ]);
});

test('executor em JavaScript também funciona (mesmo protocolo: stdin, stdout e canal 3)', async () => {
  const p = pastaFerramentas();
  p.criar('js', 'const fs = require("node:fs");\nconst e = JSON.parse(fs.readFileSync(0, "utf8"));\nfs.writeSync(3, JSON.stringify({ registros_lidos: 4, nomes_proibidos: [] }));\nprocess.stdout.write(JSON.stringify({ eco: e.params, minimo: e.minimo_grupo }));\n', { parametros: { n: { tipo: 'inteiro' } } }, { ext: 'js' });
  const r = await nucleoDe(p).executar({ ferramenta: 'js', agente: 'ana', params: { n: '3' } });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(r.resultado, { eco: { n: 3 }, minimo: 10 });
  assert.equal(r.meta.registros_lidos, 4);
});

test('concorrência: acima do limite o serviço responde ocupado em vez de empilhar', async () => {
  const p = pastaFerramentas();
  p.criar('devagar', 'import time\nfrom dgclaw_ferramenta import resultado\ntime.sleep(1)\nresultado({}, registros_lidos=0)\n');
  const n = nucleoDe(p, { maxConcorrentes: 1 });
  const [a, b] = await Promise.all([n.executar({ ferramenta: 'devagar', agente: 'ana', params: {} }), n.executar({ ferramenta: 'devagar', agente: 'ana', params: {} })]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal([a, b].find((x) => !x.ok).motivo, 'ocupado');
});

// ── socket ──────────────────────────────────────────────────────────────────
test('socket: listar e executar; o campo executor (só do teste local) é ignorado; pedido torto vira erro', async () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  const socket = path.join(pastaTemp('sock'), 'f.sock');
  const s = criarServidor({ socket, dir: p.dir, tmpBase: p.tmpBase, log: () => {} });
  await s.ouvir();
  const env = { DGCLAW_FERRAMENTAS_SOCK: socket };
  try {
    assert.equal((fs.statSync(socket).mode & 0o777), 0o600);
    const l = await chamar({ op: 'listar', agente: 'ana' }, { env });
    assert.equal(l.ok, true);
    assert.deepEqual(l.ferramentas.map((f) => f.nome), ['carteira.resumo']);
    assert.equal(JSON.stringify(l).includes('credenciais'), false);
    assert.equal(JSON.stringify(l).includes('base_legal'), false, 'o agente vê esquema e descrição, não a ficha do RIPD');
    assert.deepEqual((await chamar({ op: 'listar', agente: 'marina' }, { env })).ferramentas, []);
    const r = await chamar({ op: 'executar', ferramenta: 'carteira.resumo', agente: 'ana', params: { periodo: '2026-09', agrupar_por: 'plano' } }, { env });
    assert.equal(r.ok, true, r.erro);
    const m = await chamar({ op: 'executar', ferramenta: 'carteira.resumo', agente: 'ana', executor: 'teste/executor_malicioso.py', params: { periodo: '2026-09', agrupar_por: 'plano' } }, { env });
    assert.equal(m.ok, true, 'o executor malicioso não foi usado: o pedido por socket nunca troca o executor');
    assert.equal((await chamar({ op: 'apagar' }, { env })).motivo, 'pedido_invalido');
    assert.equal((await chamar({ op: 'executar', ferramenta: 'carteira.resumo', agente: 'Ana Maria' }, { env })).motivo, 'pedido_invalido');
    assert.equal((await chamar([1], { env })).motivo, 'pedido_invalido');
  } finally { await s.fechar(); }
  const fora = await chamar({ op: 'listar', agente: 'ana' }, { env });
  assert.equal(fora.motivo, 'ferramentas_fora');
  assert.match(fora.erro, /systemctl status dgclaw-ferramentas/);
});

test('ferramenta com defeito não derruba as outras: aparece na lista de defeituosas e no log', () => {
  const p = pastaFerramentas();
  p.instalarExemplo(['ana']);
  fs.mkdirSync(path.join(p.dir, 'quebrada'));
  fs.writeFileSync(path.join(p.dir, 'quebrada', 'ferramenta.json'), '{ isto nao e json');
  const logs = [];
  const l = nucleoDe(p, { log: (n, m) => logs.push(m) }).listar(null);
  assert.equal(l.ferramentas.length, 1);
  assert.equal(l.defeituosas[0].nome, 'quebrada');
  assert.ok(logs.some((m) => /quebrada.*não abre/.test(m)));
  assert.equal(os.tmpdir().length > 0, true);
});
