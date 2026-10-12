// Testes do catalogo.mjs. Rodar: node --test scripts/provedores/test_catalogo.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { carregar, validar, rotulo, modelos, ErroCatalogo } from './catalogo.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalogo.mjs');
const cat = carregar();

function codexHomeFalso() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'));
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-x', display_name: 'GPT-X', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-so-assinatura', display_name: 'GPT Só Assinatura', visibility: 'list', supported_in_api: false },
      { slug: 'gpt-escondido', display_name: 'Escondido', visibility: 'hide', supported_in_api: true },
    ],
  }));
  return dir;
}

test('validar aceita id e apelido e devolve o id canônico', () => {
  assert.equal(validar(cat, 'claude', 'assinatura', 'opus').modelo, 'claude-opus-5-5');
  assert.equal(validar(cat, 'claude', 'api', 'claude-haiku-5-5').modelo, 'claude-haiku-5-5');
  assert.equal(validar(cat, 'claude', 'assinatura', '').modelo, '');
});

test('validar recusa provedor, auth e modelo desconhecidos, com mensagem em português', () => {
  assert.throws(() => validar(cat, 'xyz', 'api'), (e) => e instanceof ErroCatalogo && /não existe/.test(e.message));
  assert.throws(() => validar(cat, 'claude', 'grátis'), /assinatura, token ou api/);
  assert.throws(() => validar(cat, 'claude', 'api', 'gpt-5'), /Os válidos: claude-opus-5-5/);
});

test('provedor indisponível é recusado com o motivo', () => {
  assert.throws(() => validar(cat, 'gemini', 'api'), /Gemini CLI ainda não está disponível: desenhado/);
});

test('rótulo', () => {
  assert.equal(rotulo(cat, 'claude', 'assinatura', 'opus'), 'Claude Opus 5.5, na assinatura');
  assert.equal(rotulo(cat, 'codex', 'api', ''), 'Codex (modelo padrão), na API');
});

test('modelos do codex: cache falso manda; --api filtra; sem cache usa a reserva', () => {
  const home = codexHomeFalso();
  assert.deepEqual(modelos(cat, 'codex', { codexHome: home }).map((m) => m.id), ['gpt-x', 'gpt-so-assinatura']);
  assert.deepEqual(modelos(cat, 'codex', { codexHome: home, soApi: true }).map((m) => m.id), ['gpt-x']);
  assert.equal(validar(cat, 'codex', 'assinatura', 'gpt-so-assinatura', { codexHome: home }).modelo, 'gpt-so-assinatura');
  assert.throws(() => validar(cat, 'codex', 'api', 'gpt-so-assinatura', { codexHome: home }), /Os válidos: gpt-x/);
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'codexvazio-'));
  assert.ok(modelos(cat, 'codex', { codexHome: vazio }).some((m) => m.id === 'gpt-5.6-terra'));
});

test('CLI: exit 0 com id canônico, exit 2 com mensagem', () => {
  let r = spawnSync('node', [CLI, 'validar', 'claude', 'assinatura', 'sonnet'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'claude-sonnet-5-5');
  r = spawnSync('node', [CLI, 'validar', 'gemini', 'api'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /não está disponível/);
  r = spawnSync('node', [CLI, 'rotulo', 'codex', 'api'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'Codex (modelo padrão), na API');
});
