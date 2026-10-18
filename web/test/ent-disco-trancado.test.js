'use strict';
// Bloco J, dados trancados: com disco_cifrado = externo e o volume cifrado fechado, o Web diz "dados trancados" em vez de quebrar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp } = require('./ajuda');

const AGENTE = { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'luna', chat_id: 'c_luna', porta_painel: null };

async function cenario({ ajustes, volume, casas, metodo }) {
  const dir = pastaTemp('disco');
  const protecoesPath = path.join(dir, 'protecoes.json');
  if (ajustes) fs.writeFileSync(protecoesPath, JSON.stringify({ nivel: 'pessoal', ajustes }));
  const arq = path.join(dir, 'dados.luks');
  if (volume) fs.writeFileSync(arq, 'LUKS');
  if (metodo) fs.writeFileSync(path.join(dir, 'disco-externo.json'), JSON.stringify({ metodo }));
  const pastaCasas = casas || path.join(dir, 'agentes');
  fs.mkdirSync(pastaCasas, { recursive: true });
  const s = await subirWeb({ agentes: [AGENTE], env: { DGCLAW_DISCO_ARQUIVO: arq, DGCLAW_CASAS: pastaCasas }, opcoesServidor: { protecoesPath } });
  await s.login();
  return s;
}

test('nível pessoal (disco_cifrado = nao): nada muda', async () => {
  const s = await cenario({ volume: true });
  try {
    assert.equal((await s.c.get('/api/v1/agents')).status, 200);
    const d = await s.c.get('/api/v1/disco');
    assert.deepEqual({ trancado: d.json.trancado }, { trancado: false });
  } finally { await s.fechar(); }
});

test('externo com o volume fechado: APIs e páginas dos agentes dizem "dados trancados" (503) e o TI continua alcançando as telas dele', async () => {
  const s = await cenario({ ajustes: { disco_cifrado: 'externo' }, volume: true, metodo: 'manual' });
  try {
    const api = await s.c.get('/api/v1/agents');
    assert.equal(api.status, 503);
    assert.equal(api.json.trancado, true);
    assert.match(api.json.erro, /Dados trancados, aguardando desbloqueio/);
    assert.match(api.json.erro, /dgclaw disco desbloquear/);
    assert.equal(api.headers['retry-after'], '30');
    const pag = await s.c.get('/a/luna', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 503);
    assert.match(pag.texto, /Dados trancados/);
    assert.match(pag.texto, /dgclaw disco desbloquear/);
    assert.equal((await s.c.get('/', { headers: { Accept: 'text/html' } })).status, 503);
    assert.equal((await s.c.get('/p/luna/')).status, 503);
    assert.equal((await s.c.post('/api/v1/onboarding', { json: {} })).status, 503);
    const disco = await s.c.get('/api/v1/disco');
    assert.equal(disco.status, 200);
    assert.deepEqual({ trancado: disco.json.trancado, metodo: disco.json.metodo }, { trancado: true, metodo: 'manual' });
    const eu = await s.c.get('/api/v1/eu');
    assert.equal(eu.status, 200, 'a sessão e as telas do TI continuam');
    fs.writeFileSync(path.join(s.publico, 'protecoes.html'), '<html>protecoes</html>');
    assert.equal((await s.c.get('/protecoes')).status, 200);
  } finally { await s.fechar(); }
});

test('com Tang a mensagem manda abrir pelo servidor de chaves, não digitar frase', async () => {
  const s = await cenario({ ajustes: { disco_cifrado: 'externo' }, volume: true, metodo: 'tang' });
  try {
    const pag = await s.c.get('/a/luna', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 503);
    assert.match(pag.texto, /Tang/);
    assert.match(pag.texto, /dgclaw disco abrir/);
  } finally { await s.fechar(); }
});

test('externo mas o volume ainda não existe (disco não cifrado): não tranca', async () => {
  const s = await cenario({ ajustes: { disco_cifrado: 'externo' }, volume: false });
  try {
    assert.equal((await s.c.get('/api/v1/agents')).status, 200);
    assert.equal((await s.c.get('/api/v1/disco')).json.trancado, false);
  } finally { await s.fechar(); }
});

test('externo com a pasta dos agentes montada (device diferente do pai): abre', async (t) => {
  if (!fs.existsSync('/dev/shm')) { t.skip('sem /dev/shm neste sistema'); return; }
  const s = await cenario({ ajustes: { disco_cifrado: 'externo' }, volume: true, casas: '/dev/shm' });
  try {
    assert.equal((await s.c.get('/api/v1/agents')).status, 200);
    assert.equal((await s.c.get('/api/v1/disco')).json.trancado, false);
  } finally { await s.fechar(); }
});

test('sem sessão a rota do disco pede login', async () => {
  const s = await cenario({ ajustes: { disco_cifrado: 'externo' }, volume: true });
  try {
    const { cliente } = require('./ajuda');
    assert.equal((await cliente(s.porta).get('/api/v1/disco')).status, 401);
  } finally { await s.fechar(); }
});
