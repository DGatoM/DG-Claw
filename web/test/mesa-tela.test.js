'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/mesa');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const base = { id: 12, agente: 'luna', titulo: 'Roteiro', estado: 'fazendo', aberta: true, parada: false, progresso: 50,
  progresso_origem: 'passos', motivo: null, nota: 'escrevendo', passos: [{ texto: 'pesquisa', feito: true }, { texto: 'roteiro', feito: false }],
  link: null, anexos: [], origem: 'Dono, 05/10 15h42: faz', atualizada_ha_min: 3, versao: '7' };

test('rótulo do estado cobre todos os casos', () => {
  assert.equal(M.rotuloEstado(base).texto, 'fazendo');
  assert.equal(M.rotuloEstado({ ...base, parada: true }).texto, 'parada?');
  assert.equal(M.rotuloEstado({ ...base, estado: 'travada' }).texto, 'travada');
  assert.equal(M.rotuloEstado({ ...base, estado: 'esperando_dono' }).texto, 'esperando você');
  assert.equal(M.rotuloEstado({ ...base, estado: 'esperando_danilo' }).texto, 'esperando você');
  assert.equal(M.rotuloEstado({ ...base, estado: 'concluida' }).texto, 'concluída ✓');
  assert.equal(M.rotuloEstado({ ...base, estado: 'cancelada' }).texto, 'cancelada');
});

test('progresso: null é "sem medida", 0 é 0%', () => {
  assert.equal(M.textoProgresso(null), 'sem medida');
  assert.equal(M.textoProgresso(undefined), 'sem medida');
  assert.equal(M.textoProgresso(0), '0%');
  assert.equal(M.textoProgresso(66.6), '67%');
  assert.equal(M.textoProgresso(100), '100%');
});

test('há X min', () => {
  assert.equal(M.haMin(0), 'atualizada agora mesmo');
  assert.equal(M.haMin(3), 'atualizada há 3 min');
  assert.equal(M.haMin(125), 'atualizada há 2 h');
  assert.equal(M.haMin(3000), 'atualizada há 2 d');
  assert.match(M.haMin(null), /sem registro/);
});

test('agrupamento segue a ordem dos agentes e mantém a ordem das tarefas', () => {
  const agentes = [{ id: 'marina', nome: 'Marina' }, { id: 'luna', nome: 'Luna' }, { id: 'lara', nome: 'Lara' }];
  const tarefas = [{ id: 1, agente: 'luna' }, { id: 2, agente: 'marina' }, { id: 3, agente: 'luna' }, { id: 4, agente: 'fantasma' }];
  const g = M.agrupaPorAgente(tarefas, agentes);
  assert.deepEqual(g.map(x => x.agente.id), ['marina', 'luna', 'lara', 'fantasma']);
  assert.deepEqual(g[1].tarefas.map(t => t.id), [1, 3]);
  assert.equal(g[2].tarefas.length, 0);
});

test('texto padrão da origem', () => {
  assert.equal(M.textoOrigem(new Date(2026, 9, 5, 15, 42)), 'Dono, 05/10 15h42: ');
  assert.equal(M.textoOrigem(new Date(2026, 0, 9, 7, 5)), 'Dono, 09/01 07h05: ');
});

test('cartão escapa tudo o que vem da API', () => {
  const h = M.htmlCartao({ ...base, titulo: '<script>alert(1)</script>', nota: '<img src=x onerror=1>', motivo: '"><b>x</b>',
    estado: 'travada', origem: '<i>o</i>', passos: [{ texto: '<u>p</u>', feito: false }] }, {});
  assert.doesNotMatch(h, /<script>/);
  assert.doesNotMatch(h, /<img src=x/);
  assert.doesNotMatch(h, /<u>p/);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(h, /Travou porque/);
});

test('cartão: progresso null mostra "sem medida" e nunca 0%; zero mostra 0%', () => {
  const nulo = M.htmlCartao({ ...base, progresso: null, progresso_origem: null, passos: [] }, {});
  assert.match(nulo, /sem medida/);
  assert.doesNotMatch(nulo, /0%/);
  const zero = M.htmlCartao({ ...base, progresso: 0 }, {});
  assert.match(zero, /0%/);
  assert.doesNotMatch(zero, /sem medida/);
});

test('cartão: links só http(s) ou caminho do Web, abrem em nova aba com noopener', () => {
  const h = M.htmlCartao({ ...base, link: 'javascript:alert(1)', anexos: [{ rotulo: 'Planilha', url: 'https://x.com/a?b=1&c=2' }] }, {});
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /href="https:\/\/x\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"/);
  assert.equal(M.urlSegura('//evil.com'), '');
  assert.equal(M.urlSegura('/aulas/x'), '/aulas/x');
});

test('ações do cartão aberto dependem do estado', () => {
  const esp = M.htmlCartao({ ...base, estado: 'esperando_dono', motivo: 'A ou B?' }, { aberto: true });
  assert.match(esp, /data-acao="responder"/);
  assert.match(esp, /data-acao="concluir"/);
  const fazendo = M.htmlCartao(base, { aberto: true });
  assert.doesNotMatch(fazendo, /data-acao="responder"/);
  const fechada = M.htmlCartao({ ...base, estado: 'concluida' }, { aberto: true });
  assert.match(fechada, /data-acao="reabrir"/);
  assert.doesNotMatch(fechada, /data-acao="concluir"/);
  assert.doesNotMatch(M.htmlCartao(base, {}), /mz-detalhes/);
});

test('erro da API: frase e erros campo a campo, escapados', () => {
  const f = M.fraseErro({ ok: false, erro: 'Dados inválidos', erros: { motivo: 'obrigatório quando o estado é travada' } }, 400);
  assert.equal(f.texto, 'Dados inválidos');
  assert.equal(f.campos.motivo, 'obrigatório quando o estado é travada');
  assert.match(M.fraseErro(null, 503).texto, /503/);
  const h = M.htmlFormCartao(base, { tipo: 'editar', valores: {}, erro: { texto: '<b>x</b>', campos: { titulo: '<i>' } } });
  assert.doesNotMatch(h, /<b>x<\/b>/);
});

test('histórico aceita formatos diferentes e escapa', () => {
  assert.match(M.htmlHistorico(null), /Carregando/);
  assert.match(M.htmlHistorico([]), /Ainda não há/);
  const h = M.htmlHistorico([{ por: 'dono (<x>)', acao: 'atualizou', mudancas: { nota: { antes: null, depois: 'oi' } } }]);
  assert.match(h, /nota: vazio → oi/);
  assert.doesNotMatch(h, /<x>/);
});

test('mesa.html: ordem dos scripts, casca no lugar do cabeçalho antigo e o Quadro de avisos ligado', () => {
  const h = pub('mesa.html');
  assert.ok(h.indexOf('<script src="/tour.js">') < h.indexOf('<script src="/mesa.js">'));
  assert.ok(h.indexOf('<script src="/menu-lado.js">') < h.indexOf('<script src="/casca.js">'));
  assert.ok(h.indexOf('<script src="/casca.js">') < h.indexOf('<script src="/mesa.js">'));
  assert.ok(h.indexOf('href="/casca.css"') < h.indexOf('href="/menu-lado.css"'), 'casca.css vem antes do menu-lado.css');
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'mesa', titulo: 'Mesa de tarefas'/);
  assert.doesNotMatch(h, /mz-volta|mz-topo/);
  assert.match(h, /^<link rel="stylesheet" href="\/avisos\.css">$/m);
  assert.match(h, /^<script src="\/avisos\.js"><\/script>$/m);
});

test('o menu da conversa tem o item Mesa de tarefas', () => {
  assert.match(pub('conversa.html'), /<a class="ml-tab" href="\/mesa"><span class="ml-ico" aria-hidden="true">▦<\/span>Mesa de tarefas<\/a>/);
});
