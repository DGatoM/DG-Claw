'use strict';
// Vigia de atenção: transições, supressão por "vendo", anti-spam, primeira leitura, preferências e resumo sem segredo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp } = require('./ajuda');
const { criarVigiaAtencao, CORPO_TERMINOU } = require('../lib/vigia-atencao');
const { criarPrefsAtencao } = require('../lib/prefs-atencao');

const CHAVE_FALSA = ['sk', 'ant', 'api03'].join('-') + '-' + 'Y'.repeat(95);

function montar(opcoes) {
  const o = opcoes || {};
  let agora = 1_800_000_000_000;
  const enviados = [];
  const logs = [];
  const base = { ana: { estado: 'ocioso', resumo: null } };
  let msgs = [];
  const prefs = criarPrefsAtencao({ arquivo: path.join(pastaTemp('prefs'), 'push', 'preferencias.json'), log: (n, m) => logs.push(`${n} ${m}`) });
  const vigia = criarVigiaAtencao({
    registro: { estado: () => ({ ok: true, agentes: [{ slug: 'ana', nome: 'Ana' }] }) },
    estados: { doRunner: async (a) => base[a.slug] },
    lerThread: async () => (o.threadLenta ? new Promise(() => {}) : { msgs }),
    push: { enviar: async (aviso) => { enviados.push(aviso); return { inscricoes: 1, ok: 1, removidas: 0, falhas: [] }; } },
    prefs, relogio: () => agora, log: (n, m) => logs.push(`${n} ${m}`),
  });
  return {
    vigia, enviados, logs, prefs,
    muda: (est, resumo) => { base.ana = { estado: est, resumo: resumo || null }; },
    passa: (ms) => { agora += ms; },
    agoraS: () => agora / 1000,
    fala: (texto, epOffsetS) => { msgs = msgs.concat([{ origin: 'agente', ep: agora / 1000 + (epOffsetS || 0), text: texto, sistema: false }]); },
  };
}

test('primeira leitura só grava: nada dispara no boot, nem com o agente já esperando você', async () => {
  const t = montar();
  t.muda('precisa_de_voce', 'fez uma pergunta');
  await t.vigia.tick();
  assert.equal(t.enviados.length, 0);
  t.passa(5000);
  await t.vigia.tick();
  assert.equal(t.enviados.length, 0, 'continuar no mesmo estado não é transição');
});

test('entrou em precisa_de_voce: aviso com resumo, tag, url e exigir_interacao; sem botões de aprovar', async () => {
  const t = montar();
  await t.vigia.tick();
  t.muda('trabalhando');
  t.passa(5000); await t.vigia.tick();
  t.muda('precisa_de_voce', 'pede permissão para rodar Bash');
  t.passa(5000); await t.vigia.tick();
  assert.equal(t.enviados.length, 1);
  const a = t.enviados[0];
  assert.equal(a.titulo, 'Ana precisa de você');
  assert.equal(a.corpo, 'pede permissão para rodar Bash');
  assert.equal(a.tag, 'atencao-ana');
  assert.equal(a.url, '/a/ana');
  assert.equal(a.exigir_interacao, true);
  assert.equal(a.acoes, undefined);
});

test('terminou: working -> ocioso com resposta nova manda só o texto genérico, nunca a resposta; sem resposta nova não manda', async () => {
  const t = montar();
  await t.vigia.tick();
  t.muda('trabalhando'); t.passa(5000); await t.vigia.tick();
  t.passa(5000);
  t.fala(`Sua senha é TesteLocal!42\n${CHAVE_FALSA}`);
  t.muda('ocioso'); await t.vigia.tick();
  assert.equal(t.enviados.length, 1);
  assert.equal(t.enviados[0].titulo, 'Ana terminou');
  assert.equal(t.enviados[0].corpo, CORPO_TERMINOU);
  assert.ok(!JSON.stringify(t.enviados[0]).includes('TesteLocal'), 'nada da resposta vai para a tela bloqueada');
  assert.equal(t.enviados[0].tag, 'fim-ana');
  assert.equal(t.enviados[0].exigir_interacao, undefined);

  // novo turno sem resposta do agente (ex.: rotina): silêncio
  t.passa(120000);
  t.muda('trabalhando'); await t.vigia.tick();
  t.passa(5000); t.muda('ocioso'); await t.vigia.tick();
  assert.equal(t.enviados.length, 1);
});

test('supressão: quem está olhando a conversa (vendo há menos de 45 s) não recebe aviso', async () => {
  const t = montar();
  await t.vigia.tick();
  t.vigia.vendo('ana');
  t.passa(10000);
  t.muda('precisa_de_voce', 'fez uma pergunta'); await t.vigia.tick();
  assert.equal(t.enviados.length, 0);
  // 50 s depois ele parou de olhar: a próxima transição avisa
  t.passa(50000);
  t.muda('trabalhando'); await t.vigia.tick();
  t.muda('precisa_de_voce', 'fez uma pergunta'); await t.vigia.tick();
  assert.equal(t.enviados.length, 1);
});

test('anti-spam: no máximo 1 aviso por agente e tipo a cada 60 s', async () => {
  const t = montar();
  await t.vigia.tick();
  for (let i = 0; i < 3; i += 1) {
    t.muda('precisa_de_voce', 'fez uma pergunta'); t.passa(5000); await t.vigia.tick();
    t.muda('trabalhando'); t.passa(5000); await t.vigia.tick();
  }
  assert.equal(t.enviados.length, 1, 'três entradas em 30 s viram um aviso');
  t.passa(60000);
  t.muda('precisa_de_voce', 'fez uma pergunta'); await t.vigia.tick();
  assert.equal(t.enviados.length, 2);
});

test('sem sinal do runner não é transição: volta ao mesmo estado e não avisa de novo', async () => {
  const t = montar();
  t.muda('precisa_de_voce', 'fez uma pergunta');
  await t.vigia.tick(); // primeira leitura
  t.muda('sem_sinal'); t.passa(5000); await t.vigia.tick();
  t.muda('precisa_de_voce', 'fez uma pergunta'); t.passa(5000); await t.vigia.tick();
  assert.equal(t.enviados.length, 0);
});

test('preferências desligadas calam o tipo; ligar de novo volta a avisar', async () => {
  const t = montar();
  await t.vigia.tick();
  t.prefs.grava('dono', { precisa_de_voce: false });
  t.muda('precisa_de_voce', 'fez uma pergunta'); t.passa(5000); await t.vigia.tick();
  assert.equal(t.enviados.length, 0);
  t.prefs.grava('dono', { precisa_de_voce: true, terminou: false });
  t.muda('trabalhando'); t.passa(5000); await t.vigia.tick();
  t.fala('feito');
  t.muda('ocioso'); t.passa(5000); await t.vigia.tick();
  assert.equal(t.enviados.length, 0, 'terminou está desligado');
  t.muda('trabalhando'); t.passa(5000); await t.vigia.tick();
  t.muda('precisa_de_voce', 'fez uma pergunta'); t.passa(5000); await t.vigia.tick();
  assert.equal(t.enviados.length, 1);
});

test('push que falha não derruba o vigia: registra o erro e segue', async () => {
  const logs = [];
  let agora = 1_800_000_000_000;
  let estado = 'ocioso';
  const prefs = criarPrefsAtencao({ arquivo: path.join(pastaTemp('prefs'), 'p', 'preferencias.json'), log: () => {} });
  const vigia = criarVigiaAtencao({
    registro: { estado: () => ({ ok: true, agentes: [{ slug: 'ana', nome: 'Ana' }] }) },
    estados: { doRunner: async () => ({ estado, resumo: 'fez uma pergunta' }) },
    lerThread: async () => ({ msgs: [] }),
    push: { enviar: async () => { throw new Error('arquivo de chaves ilegível'); } },
    prefs, relogio: () => agora, log: (n, m) => logs.push(`${n} ${m}`),
  });
  await vigia.tick();
  estado = 'precisa_de_voce'; agora += 5000;
  await vigia.tick();
  assert.ok(logs.some((l) => l.startsWith('erro') && l.includes('não saiu') && l.includes('arquivo de chaves ilegível')), logs.join('\n'));
});

test('preferências ilegíveis: avisos suspensos, gravação recusada e nenhuma escolha apagada', () => {
  // Revisão adversarial do PR #58: um usuário malformado deixava o cache pela metade e a gravação
  // seguinte apagava o "terminou: false" do dono; e a falha de leitura religava os avisos.
  const arquivo = path.join(pastaTemp('prefs'), 'preferencias.json');
  const original = JSON.stringify({ versao: 1, usuarios: { falho: null, dono: { terminou: false } } });
  fs.writeFileSync(arquivo, original);
  const prefs = criarPrefsAtencao({ arquivo, log: () => {} });
  assert.equal(prefs.alguemQuer('terminou'), false);
  assert.equal(prefs.alguemQuer('terminou'), false, 'a segunda consulta também não religa');
  assert.equal(prefs.alguemQuer('precisa_de_voce'), false);
  assert.throws(() => prefs.grava('dono', { precisa_de_voce: true }), (e) => e.status === 503);
  assert.equal(fs.readFileSync(arquivo, 'utf8'), original, 'o arquivo não foi reescrito');
});
