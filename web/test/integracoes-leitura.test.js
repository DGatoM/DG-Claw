'use strict';
// Leitura blindada do estado.json de um agente (web/lib/integracoes-leitura.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lerEstado, lerDesligadas, MAX_BYTES } = require('../lib/integracoes-leitura');

const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const UID_AGENTE = 65534;

const ITEM = (extra) => Object.assign({
  id: 'whatsapp', estado: 'vermelho', ultimoEvento: '2026-11-16T10:00:00Z', ultimoResultado: 'desconectado',
  ultimoOk: null, ultimaTentativaReal: '2026-11-16T10:00:00Z', ultimaFalha: '2026-11-16T10:00:00Z', ultimaFalhaResultado: 'desconectado',
}, extra || {});
const ESTADO = (itens) => JSON.stringify({ versao: 1, geradoEm: '2026-11-16T10:00:00Z', integracoes: itens || [ITEM()] });

/** Casa de teste. Como root, entrega tudo ao UID do agente (o Web recusa casa de root). */
function casa(opcoes) {
  const o = opcoes || {};
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-int-'));
  const home = path.join(raiz, 'home');
  const pasta = path.join(home, '.dgclaw', 'integracoes');
  fs.mkdirSync(pasta, { recursive: true });
  if (o.estado !== undefined && o.estado !== null) fs.writeFileSync(path.join(pasta, 'estado.json'), o.estado);
  const entrega = () => {
    if (!souRoot) return;
    const vai = (p) => { fs.lchownSync(p, UID_AGENTE, UID_AGENTE); if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) vai(path.join(p, f)); };
    vai(home);
  };
  fs.chmodSync(raiz, 0o700); // a raiz fica de root e fechada; só home (entregue abaixo) vai ao outro UID
  entrega();
  return { raiz, home, pasta, entrega, agente: { slug: 'luna', tipo: 'agente', home_host: home } };
}
const limpa = (c) => fs.rmSync(c.raiz, { recursive: true, force: true });
const semUidDoAgente = { skip: !souRoot && 'precisa ser root para entregar a casa a outro UID (sem isso o dono é o mesmo do teste, e só a casa de root é recusada)' };

function ruim(r) {
  assert.equal(r.medido, false);
  assert.equal(r.itens, undefined, 'nunca devolve itens em caso de falha');
  assert.equal(typeof r.motivo, 'string');
}

test('arquivo bom: devolve os itens medidos', { skip: !souRoot && 'o dono precisa ser outro UID que não o do teste' }, () => {
  const c = casa({ estado: ESTADO() });
  try {
    const r = lerEstado(c.agente);
    assert.equal(r.medido, true);
    assert.equal(r.itens.length, 1);
    assert.equal(r.itens[0].id, 'whatsapp');
    assert.equal(r.itens[0].ultimaTentativaReal, '2026-11-16T10:00:00Z');
  } finally { limpa(c); }
});

test('arquivo ausente e pasta ausente: lista vazia medida', semUidDoAgente, () => {
  const c = casa({});
  try {
    assert.deepEqual(lerEstado(c.agente), { medido: true, itens: [] });
    fs.rmSync(path.join(c.home, '.dgclaw'), { recursive: true });
    assert.deepEqual(lerEstado(c.agente), { medido: true, itens: [] });
  } finally { limpa(c); }
});

test('atalho no lugar do estado.json: recusa', semUidDoAgente, () => {
  const c = casa({});
  try {
    const alvo = path.join(c.raiz, 'segredo.json');
    fs.writeFileSync(alvo, ESTADO());
    fs.symlinkSync(alvo, path.join(c.pasta, 'estado.json'));
    c.entrega();
    const r = lerEstado(c.agente);
    ruim(r);
    assert.ok(!r.motivo.includes(alvo), 'o motivo não cita o destino do atalho');
  } finally { limpa(c); }
});

test('atalho no meio do caminho (.dgclaw ou integracoes): recusa', semUidDoAgente, () => {
  for (const nivel of ['.dgclaw', 'integracoes']) {
    const c = casa({ estado: ESTADO() });
    try {
      const fora = path.join(c.raiz, 'fora');
      fs.mkdirSync(path.join(fora, 'integracoes'), { recursive: true });
      fs.writeFileSync(path.join(fora, 'integracoes', 'estado.json'), ESTADO());
      fs.writeFileSync(path.join(fora, 'estado.json'), ESTADO());
      if (nivel === '.dgclaw') {
        fs.rmSync(path.join(c.home, '.dgclaw'), { recursive: true });
        fs.symlinkSync(fora, path.join(c.home, '.dgclaw'));
      } else {
        fs.rmSync(c.pasta, { recursive: true });
        fs.symlinkSync(fora, c.pasta);
      }
      c.entrega();
      ruim(lerEstado(c.agente));
    } finally { limpa(c); }
  }
});

test('FIFO no lugar do arquivo: recusa sem travar', semUidDoAgente, () => {
  const c = casa({});
  try {
    execFileSync('mkfifo', [path.join(c.pasta, 'estado.json')]);
    c.entrega();
    ruim(lerEstado(c.agente));
  } finally { limpa(c); }
});

test('arquivo de 64 KiB + 1 byte: recusa tudo; exatamente 64 KiB passa do limite de tamanho', semUidDoAgente, () => {
  const c = casa({ estado: ' '.repeat(MAX_BYTES + 1) });
  try {
    ruim(lerEstado(c.agente));
    fs.writeFileSync(path.join(c.pasta, 'estado.json'), ESTADO() + ' '.repeat(MAX_BYTES - ESTADO().length));
    c.entrega();
    assert.equal(lerEstado(c.agente).medido, true);
  } finally { limpa(c); }
});

test('UID errado: arquivo de root dentro da casa do agente é recusado', semUidDoAgente, () => {
  const c = casa({ estado: ESTADO() });
  try {
    fs.chownSync(path.join(c.pasta, 'estado.json'), 0, 0);
    ruim(lerEstado(c.agente));
    // e pasta do caminho de outro UID
    fs.chownSync(path.join(c.pasta, 'estado.json'), UID_AGENTE, UID_AGENTE);
    fs.chownSync(c.pasta, 1234, 1234);
    ruim(lerEstado(c.agente));
  } finally { limpa(c); }
});

test('casa de root: recusa', () => {
  const c = casa({ estado: ESTADO() });
  try {
    if (!souRoot) {
      // sem ser root não dá para criar casa de root: confere ao menos que o agente sem home_host e o Admin não são medidos
      ruim(lerEstado({ slug: 'x', tipo: 'agente', home_host: null }));
      ruim(lerEstado({ slug: 'admin', tipo: 'admin', home_host: c.home }));
      return;
    }
    fs.chownSync(c.home, 0, 0);
    ruim(lerEstado(c.agente));
  } finally { limpa(c); }
});

test('esquema inválido e JSON quebrado: recusa', semUidDoAgente, () => {
  const ruins = [
    '{nao e json', '[]', JSON.stringify({ versao: 2, integracoes: [] }),
    ESTADO([ITEM({ id: 'Maiuscula!' })]), ESTADO([ITEM({ estado: 'azul' })]), ESTADO([ITEM({ ultimoResultado: 'invento' })]),
    ESTADO([ITEM({ ultimaTentativaReal: 'ontem' })]), ESTADO(Array.from({ length: 51 }, (_, i) => ITEM({ id: `i${i}` }))),
  ];
  for (const t of ruins) {
    const c = casa({ estado: t });
    try { ruim(lerEstado(c.agente)); } finally { limpa(c); }
  }
});

test('preferencias.json: lista as desligadas; falha vira nenhuma', semUidDoAgente, () => {
  const c = casa({});
  try {
    assert.deepEqual(lerDesligadas(c.agente), []);
    fs.writeFileSync(path.join(c.pasta, 'preferencias.json'), JSON.stringify({ desligadas: ['whatsapp', 'Ruim!', 7] }));
    c.entrega();
    assert.deepEqual(lerDesligadas(c.agente), ['whatsapp']);
    fs.writeFileSync(path.join(c.pasta, 'preferencias.json'), '{quebrado');
    assert.equal(lerDesligadas(c.agente), null, 'existe mas está quebrado: null (não medido), não "nenhuma desligada"');
    fs.writeFileSync(path.join(c.pasta, 'preferencias.json'), JSON.stringify({ outra: 1 }));
    c.entrega();
    assert.equal(lerDesligadas(c.agente), null, 'existe mas sem a lista: null');
  } finally { limpa(c); }
});

test('estado.json: id que não é texto ou que se repete recusa a lista inteira', semUidDoAgente, () => {
  for (const itens of [[ITEM({ id: ['whatsapp'] })], [ITEM(), ITEM()]]) {
    const c = casa({ estado: ESTADO(itens) });
    try { ruim(lerEstado(c.agente)); } finally { limpa(c); }
  }
});
