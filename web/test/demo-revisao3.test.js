'use strict';
// Terceira revisão do modo demonstração: anexo lido de dentro do container, marca da pasta de dados, o reset chamado
// pelo painel e o envio do CPDF sempre pelo telefone aprovado (docs/MODO-DEMONSTRACAO.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirDemo } = require('./demo-ajuda');
const { pastaTemp } = require('./ajuda');

const ROTAS = { contato: '/api/demo/v1/contato', envio: '/api/demo/v1/envio' };

async function comTeste(opcoes, corpo) {
  const w = await subirDemo(opcoes);
  try { await corpo(w); } finally { await w.fechar(); }
}

test('anexo é lido de dentro do container, com o argv exato, e o disco do host não é tocado', () => comTeste({}, async (w) => {
  fs.writeFileSync(path.join(w.casa, 'saida', 'proposta.pdf'), 'PDF-DE-DENTRO');
  const ref = await w.liberaContato();
  const tocados = [];
  const originais = {};
  for (const nome of ['lstatSync', 'statSync', 'openSync', 'readFileSync', 'realpathSync', 'readdirSync', 'accessSync', 'existsSync']) {
    originais[nome] = fs[nome];
    fs[nome] = function (alvo, ...resto) {
      if (typeof alvo === 'string' && alvo.startsWith(w.casa)) tocados.push(`${nome} ${alvo}`);
      return originais[nome].call(fs, alvo, ...resto);
    };
  }
  let r;
  try {
    r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi', anexos: ['/home/agente/saida/proposta.pdf'] });
  } finally { Object.assign(fs, originais); }
  assert.equal(r.status, 201, r.texto);
  assert.deepEqual(tocados, [], 'nenhum caminho da casa do agente no host pode ser aberto');
  assert.equal(w.execChamadas.length, 1);
  assert.equal(w.execChamadas[0].arq, 'podman');
  assert.deepEqual(w.execChamadas[0].args, ['exec', '-u', 'agente', 'dgclaw-nova', 'cat', '--', '/home/agente/saida/proposta.pdf']);
  assert.ok(w.execChamadas[0].opc.timeout > 0, 'a leitura tem prazo');
  assert.ok(w.execChamadas[0].opc.maxBuffer <= 20 * 1024 * 1024 + 1, 'a leitura tem limite de tamanho');
  // O sha256 do cartão é conferido de novo no envio, lendo outra vez de dentro do container.
  fs.writeFileSync(path.join(w.casa, 'saida', 'proposta.pdf'), 'OUTRO CONTEUDO');
  const d = await w.decide(r.json.id, { decisao: 'confirmar' });
  assert.equal(d.json.codigo, 'ANEXO_MUDOU');
  assert.equal(w.execChamadas.length, 2);
}));

test('anexo acima de 20 MB e falha do container têm resposta com motivo', () => comTeste({
  opcoesServidor: {
    demoExec: async (arq, args) => {
      if (args[6].endsWith('grande.bin')) throw Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      throw Object.assign(new Error('Error: no container with name'), { code: 125, stderr: 'Error: no container with name or ID "dgclaw-nova" found' });
    },
  },
}, async (w) => {
  const ref = await w.liberaContato();
  const g = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi', anexos: ['/home/agente/saida/grande.bin'] });
  assert.equal(g.json.codigo, 'ANEXO_GRANDE');
  const f = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi', anexos: ['/home/agente/saida/x.pdf'] });
  assert.equal(f.json.codigo, 'ANEXO_ILEGIVEL');
  assert.match(f.json.erro, /dgclaw-nova/);
}));

test('o painel grava a marca <dados>/demo/INSTANCIA com o slug do agente e a instância', () => comTeste({}, async (w) => {
  assert.equal(fs.readFileSync(path.join(w.dados, 'demo', 'INSTANCIA'), 'utf8'), 'nova\ninstancia=nova\n');
}));

test('o reset chamado pelo painel leva DGCLAW_DEMO_PELO_PAINEL=1 no ambiente', async () => {
  const dir = pastaTemp('demo-pelo-painel');
  const saida = path.join(dir, 'env.txt');
  const script = path.join(dir, 'reset-falso.sh');
  fs.writeFileSync(script, `#!/usr/bin/env bash\necho "PELO_PAINEL=$DGCLAW_DEMO_PELO_PAINEL" >${saida}\necho "==> ok"\nexit 0\n`, { mode: 0o755 });
  await comTeste({ opcoesServidor: { demoResetBin: script } }, async (w) => {
    const r = await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } });
    assert.equal(r.status, 202, r.texto);
    for (let i = 0; i < 100 && !fs.existsSync(saida); i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(fs.readFileSync(saida, 'utf8').trim(), 'PELO_PAINEL=1');
  });
});

test('CPDF: o envio com ref sai pelo telefone aprovado no cartão, nunca pelo contactId', () => comTeste({}, async (w) => {
  const ref = await w.liberaContato('ct-1', 'isa');
  const r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'isa', ref, texto: 'oi pelo CPDF' });
  assert.equal(r.status, 201, r.texto);
  await w.decide(r.json.id, { decisao: 'confirmar' });
  assert.equal((await w.esperaFim(r.json.id)).estado, 'enviado');
  assert.equal(w.fake.envios.length, 1);
  const corpo = w.fake.envios[0].corpo;
  assert.equal(corpo.phone, '5511988887777');
  assert.equal('contactId' in corpo, false, 'contactId (mutável) não pode ir');
}));

test('CPDF: contato sem número não vira envio (não há telefone exato para aprovar)', () => comTeste({
  opcoesServidor: {
    demoFetch: async (url, init) => {
      const u = new URL(url);
      const resp = (st, c) => new Response(JSON.stringify(c), { status: st, headers: { 'Content-Type': 'application/json' } });
      if (u.host === 'cpdf.teste' && u.pathname.endsWith('/contacts')) return resp(200, { items: [{ id: 'ct-9', displayName: 'Isa Sem Numero', phone: null }] });
      return resp(404, { error: 'nao previsto' });
    },
  },
}, async (w) => {
  const ref = await w.liberaContato('ct-9', 'isa');
  const r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'isa', ref, texto: 'oi' });
  assert.equal(r.json.codigo, 'CONTATO_SEM_NUMERO');
  assert.equal(r.status, 422);
}));
