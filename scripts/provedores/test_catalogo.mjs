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

// --- OpenCode (OpenRouter) ---------------------------------------------------------------------
import { filtrarModelosOpenRouter, atualizarCacheOpenRouter, cacheOpenRouterVelho, lerCacheOpenRouter } from './catalogo.mjs';

const API_FALSA = {
  data: [
    { id: 'z-ai/glm-5.3-prime', name: 'Z.ai: GLM 5.3 Prime', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0.00000168', completion: '0.00000528' } },
    { id: 'z-ai/glm-5.3-prime:batch', name: 'lote', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'google/gemini-nano-banana-2.1', name: 'Imagem', architecture: { output_modalities: ['image'] }, supported_parameters: ['tools'] },
    { id: 'x/sem-ferramentas', name: 'Sem ferramentas', architecture: { output_modalities: ['text'] }, supported_parameters: ['temperature'] },
    { id: 'id invalido com espaço', name: 'ruim', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'novo/modelo-x', name: 'Novo X', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } },
  ],
};

function cacheFalso(dados = API_FALSA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orcache-'));
  const arquivo = path.join(dir, 'openrouter-models.json');
  fs.writeFileSync(arquivo, JSON.stringify({ buscadoEm: new Date().toISOString(), modelos: filtrarModelosOpenRouter(dados) }));
  return arquivo;
}

test('opencode: só abre card, só na API, e o modelo padrão do catálogo entra quando vem vazio', () => {
  assert.throws(() => validar(cat, 'opencode', 'api', 'glm'), /OpenCode abre só cards/);
  assert.throws(() => validar(cat, 'opencode', 'assinatura', '', { paraCard: true }), /Use: api/);
  const v = validar(cat, 'opencode', 'api', '', { paraCard: true, cacheOpenRouter: '/nao/existe.json' });
  assert.equal(v.modelo, cat.provedores.opencode.modeloPadrao);
  assert.equal(cat.provedores.opencode.auth.api.variavel, 'OPENROUTER_API_KEY');
  assert.match(cat.provedores.opencode.auth.api.explica, /paga só pelo que usar/);
});

test('opencode: filtro da API deixa só texto com ferramentas, sem lote e sem id estranho', () => {
  const ids = filtrarModelosOpenRouter(API_FALSA).map((m) => m.id);
  assert.deepEqual(ids, ['z-ai/glm-5.3-prime', 'novo/modelo-x']);
  assert.equal(filtrarModelosOpenRouter(API_FALSA)[1].entradaPorMilhao, 1);
});

test('opencode: o cache manda, os apelidos da reserva continuam valendo, e modelo fora da lista é recusado', () => {
  const cache = cacheFalso();
  const opc = { paraCard: true, cacheOpenRouter: cache };
  assert.equal(validar(cat, 'opencode', 'api', 'novo/modelo-x', opc).modelo, 'novo/modelo-x');
  assert.equal(validar(cat, 'opencode', 'api', 'glm', opc).modelo, 'z-ai/glm-5.3-prime');
  assert.throws(() => validar(cat, 'opencode', 'api', 'moonshotai/kimi-k3.1-pro', opc), /Os válidos: z-ai\/glm-5.3-prime, novo\/modelo-x/);
  assert.equal(rotulo(cat, 'opencode', 'api', 'novo/modelo-x', opc), 'Novo X, na API (OpenRouter)');
});

test('opencode: sem cache vale a lista de reserva do catálogo', () => {
  const ids = modelos(cat, 'opencode', { cacheOpenRouter: '/nao/existe.json' }).map((m) => m.id);
  assert.ok(ids.includes('moonshotai/kimi-k3.1-pro') && ids.includes('z-ai/glm-5.3-prime'));
});

test('opencode: atualizarCacheOpenRouter grava o cache, e falha sem lançar nem apagar o cache antigo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbusca-'));
  const arquivo = path.join(dir, 'sub', 'c.json');
  const bom = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(API_FALSA) });
  const r = await atualizarCacheOpenRouter({ arquivo, buscar: bom });
  assert.deepEqual(r, { ok: true, quantos: 2 });
  assert.equal(lerCacheOpenRouter(arquivo).modelos.length, 2);
  assert.equal(cacheOpenRouterVelho(arquivo), false);
  assert.equal(cacheOpenRouterVelho(arquivo, Date.now() + 13 * 3600 * 1000), true);
  const fora = async () => ({ ok: false, status: 503, text: async () => '' });
  const r2 = await atualizarCacheOpenRouter({ arquivo, buscar: fora });
  assert.equal(r2.ok, false);
  assert.match(r2.erro, /503/);
  const quebra = async () => { throw new Error('sem rede'); };
  const r3 = await atualizarCacheOpenRouter({ arquivo, buscar: quebra });
  assert.match(r3.erro, /sem rede/);
  const vazio = async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' });
  assert.match((await atualizarCacheOpenRouter({ arquivo, buscar: vazio })).erro, /vazia/);
  assert.equal(lerCacheOpenRouter(arquivo).modelos.length, 2, 'o cache antigo sobrevive às falhas');
});

test('CLI opencode: --card libera, e sem ele recusa com exit 2', () => {
  const env = { ...process.env, DGCLAW_OPENROUTER_CACHE: '/nao/existe.json' };
  let r = spawnSync('node', [CLI, 'validar', 'opencode', 'api', 'kimi', '--card'], { encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'moonshotai/kimi-k3.1-pro');
  r = spawnSync('node', [CLI, 'validar', 'opencode', 'api', 'kimi'], { encoding: 'utf8', env });
  assert.equal(r.status, 2);
});
