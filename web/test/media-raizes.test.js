'use strict';
// A rota de mídia só serve a casa do agente e as subpastas de mídia do dataDir; o resto do dataDir
// (sessões, chaves de push, cofre) nunca sai por ela, mesmo que o agente cite o caminho na conversa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarMidia } = require('../lib/media');

function temp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), `dgclaw-${p}-`)); }

test('mídia: arquivo do dataDir fora das subpastas de mídia não é servido; subpasta de mídia e casa do agente continuam', async () => {
  const dados = temp('dados'); const home = temp('casa');
  try {
    fs.mkdirSync(path.join(dados, 'avatares'));
    fs.mkdirSync(path.join(dados, 'push'));
    fs.writeFileSync(path.join(dados, 'sessoes.json'), '{"segredo":1}');
    fs.writeFileSync(path.join(dados, 'push', 'chaves.json'), '{"privada":1}');
    fs.writeFileSync(path.join(dados, 'avatares', 'ana.png'), 'png');
    fs.writeFileSync(path.join(home, 'foto.png'), 'png');
    const agente = { slug: 'ana', nome: 'Ana', home_host: home };
    const midia = criarMidia({ dataDir: dados, log() {}, registro: { obter: () => agente } });

    for (const proibido of [path.join(dados, 'sessoes.json'), path.join(dados, 'push', 'chaves.json')]) {
      const m = midia.registrar('ana', proibido);
      assert.equal(m.disponivel, false, `${proibido} não pode estar disponível`);
      assert.equal(m.url, null, 'sem url');
      assert.equal(midia.obter(m.id), null, 'nem entra no registro');
    }
    const permitida = midia.registrar('ana', path.join(dados, 'avatares', 'ana.png'));
    assert.equal(permitida.disponivel, true);
    assert.match(permitida.url, /^\/api\/v1\/media\//);
    const daCasa = midia.registrar('ana', path.join(home, 'foto.png'));
    assert.equal(daCasa.disponivel, true);

    // atalho dentro de uma subpasta permitida apontando para um arquivo proibido também é recusado
    fs.symlinkSync(path.join(dados, 'sessoes.json'), path.join(dados, 'avatares', 'esperto.png'));
    const atalho = midia.registrar('ana', path.join(dados, 'avatares', 'esperto.png'));
    assert.equal(atalho.disponivel, false);
  } finally { fs.rmSync(dados, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
