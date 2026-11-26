'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { lerDocumento } = require('../lib/documento-idioma');
const { criarManual } = require('../lib/manual');
const hash = fonte => createHash('sha256').update(fonte).digest('hex');
test('tradução de documento exige fonte atual e idioma allowlist; falta ou divergência aparece na leitura', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-doc-idioma-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'en'));
  const origem = path.join(dir, 'a.md'), fonte = '# Fonte\n', en = '# English {#fonte}\n';
  fs.writeFileSync(origem, fonte);
  fs.writeFileSync(path.join(dir, 'en/a.md'), en);
  fs.writeFileSync(path.join(dir, 'en/fontes.json'), JSON.stringify({ 'a.md': hash(fonte) }));
  assert.equal(lerDocumento(origem, 'pt-BR'), fonte);
  assert.equal(lerDocumento(origem, '../../en'), fonte);
  assert.equal(lerDocumento(origem, 'en'), en);
  fs.writeFileSync(origem, fonte + 'Nova regra.\n');
  const obsoleto = lerDocumento(origem, 'en');
  assert.match(obsoleto, /^> English translation unavailable/);
  assert.ok(obsoleto.endsWith('Nova regra.\n'));
  fs.unlinkSync(path.join(dir, 'en/fontes.json'));
  assert.match(lerDocumento(origem, 'en'), /^> English translation unavailable/);
});
test('manual inglês tem todas as fontes atuais e títulos sem sufixos de âncora', () => {
  const dir = path.join(__dirname, '../../docs/manual');
  const fontes = JSON.parse(fs.readFileSync(path.join(dir, 'en/fontes.json'), 'utf8'));
  const nomes = fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort();
  assert.deepEqual(Object.keys(fontes).sort(), nomes);
  for (const nome of nomes) {
    assert.equal(fontes[nome], hash(fs.readFileSync(path.join(dir, nome))), nome);
    const traduzido = lerDocumento(path.join(dir, nome), 'en');
    assert.doesNotMatch(traduzido, /^> English translation unavailable/);
    assert.ok(traduzido.length > 100, nome);
  }
  const manual = criarManual({ dir });
  assert.match(manual.ler('README', 'en'), /^# DG Claw manual/i);
  for (const p of manual.listar('en').paginas) assert.doesNotMatch(p.titulo, /\{#/);
});
test('tradução não pode seguir atalho para fora da pasta inglesa', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-doc-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, 'a.md'), 'fonte');
  fs.writeFileSync(path.join(dir, 'fora.md'), 'nao mostrar');
  fs.writeFileSync(path.join(dir, 'en/fontes.json'), JSON.stringify({ 'a.md': hash('fonte') }));
  fs.symlinkSync('../fora.md', path.join(dir, 'en/a.md'));
  const resultado = lerDocumento(path.join(dir, 'a.md'), 'en');
  assert.match(resultado, /^> English translation unavailable/);
  assert.doesNotMatch(resultado, /nao mostrar/);
});
