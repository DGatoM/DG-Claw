// lock.test.mjs - Confere o package-lock.json da ponte do WhatsApp.
//
// O lock e a unica coisa que garante que a imagem sai com os mesmos bytes hoje e daqui a
// seis meses. O que pode estragar isso em silencio: um pacote sem "integrity" ou uma
// dependencia git (que anda e ainda exige o GitHub na instalacao).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.join(AQUI, '..', 'package-lock.json'), 'utf8'));
const pacotes = Object.entries(lock.packages).filter(([nome]) => nome !== '');

test('nenhum pacote do lock vem de git, e o libsignal vem do registro com integrity', () => {
  // O install.sh constroi a imagem na maquina do aluno: dependencia git tornaria o GitHub
  // obrigatorio na instalacao de todo mundo. O libsignal e fixado por "overrides".
  for (const [nome, p] of pacotes) {
    assert.ok(p.resolved, `${nome} esta no lock sem "resolved"`);
    assert.ok(!/^(git|github:|http:)/.test(p.resolved) && p.resolved.startsWith('https://registry.npmjs.org/'),
      `${nome} esta em ${p.resolved}; so pacotes do registro npm entram no lock`);
  }
  const l = lock.packages['node_modules/libsignal'];
  assert.equal(l.version, '6.0.0');
  assert.match(l.integrity, /^sha512-/);
  const pkg = JSON.parse(fs.readFileSync(path.join(AQUI, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.overrides.libsignal, '6.0.0');
});

test('todo pacote de registro tem integrity, e o Baileys esta na versao exata', () => {
  for (const [nome, p] of pacotes) {
    assert.ok(p.integrity, `${nome} esta no lock sem integrity`);
  }
  const b = lock.packages['node_modules/@whiskeysockets/baileys'];
  assert.equal(b.version, '6.7.24');
  assert.match(b.integrity, /^sha512-/);
});

test('o package.json fixa versoes exatas', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(AQUI, '..', 'package.json'), 'utf8'));
  for (const [nome, v] of Object.entries(pkg.dependencies)) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${nome} esta em "${v}"; use versao exata`);
  }
});
