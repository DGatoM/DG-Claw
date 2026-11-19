#!/usr/bin/env node
// catalogo.mjs - le providers/catalogo.json (fonte unica de provedores) e valida escolhas.
// Uso como CLI (bash chama isto):
//   catalogo.mjs validar <provedor> <auth> [modelo]   exit 0 e imprime o id canonico do modelo; exit 2 com motivo
//   catalogo.mjs rotulo  <provedor> <auth> [modelo]   ex.: "Claude Opus 5.5, na assinatura"
//   catalogo.mjs modelos <provedor> [--codex-home DIR] [--api] [--atualizar]   JSON da lista (--atualizar busca a do OpenRouter)
//   Em validar e rotulo, --card libera o provedor que so abre cards (opencode).
//   catalogo.mjs campo   <provedor> <caminho.com.pontos>         valor de um campo (ex.: auth.api.variavel)
// Como modulo: exporta carregar, validar, rotulo, modelos, campo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
function listaPt(xs) {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ou ${xs[xs.length - 1]}`;
}

export const CATALOGO_PADRAO = path.resolve(AQUI, '..', '..', 'providers', 'catalogo.json');

export class ErroCatalogo extends Error {}

export function carregar(arquivo = process.env.DGCLAW_CATALOGO || CATALOGO_PADRAO) {
  let bruto;
  try { bruto = fs.readFileSync(arquivo, 'utf8'); }
  catch (e) { throw new ErroCatalogo(`Não consegui ler o catálogo de provedores em ${arquivo}: ${e.message}`); }
  try { return JSON.parse(bruto); }
  catch (e) { throw new ErroCatalogo(`O catálogo de provedores em ${arquivo} não é um JSON válido: ${e.message}`); }
}

function provedorDe(cat, id) {
  const p = cat.provedores && Object.hasOwn(cat.provedores, id) ? cat.provedores[id] : undefined;
  if (!p) {
    throw new ErroCatalogo(`Provedor '${id}' não existe. Os que existem: ${Object.keys(cat.provedores).join(', ')}.`);
  }
  return p;
}

// --- OpenRouter (provedor opencode) -----------------------------------------------------------
// A lista de modelos vem da API publica do OpenRouter, guardada num cache em disco (a leitura do
// catalogo e sincrona; quem quer a lista fresca chama atualizarCacheOpenRouter antes). Sem cache,
// vale a lista de reserva do catalogo.
export const URL_MODELOS_OPENROUTER = 'https://openrouter.ai/api/v1/models';
export const VALIDADE_CACHE_OPENROUTER_MS = 12 * 60 * 60 * 1000;
const LIMITE_RESPOSTA_OPENROUTER = 8 * 1024 * 1024;

export function arquivoCacheOpenRouter() {
  return process.env.DGCLAW_OPENROUTER_CACHE?.trim() || path.join(os.homedir(), '.cache', 'dgclaw', 'openrouter-models.json');
}

// Do JSON da API para o que o DG Claw guarda: so modelos de texto que aceitam ferramentas (o OpenCode
// trabalha por ferramentas) e sem as variantes ":batch". Preco por milhao de tokens, quando informado.
export function filtrarModelosOpenRouter(json) {
  const dados = Array.isArray(json?.data) ? json.data : [];
  const porMilhao = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
  };
  const saida = [];
  for (const m of dados) {
    if (!m || typeof m.id !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(m.id)) continue;
    if (m.id.endsWith(':batch')) continue;
    if (!(m.architecture?.output_modalities ?? ['text']).includes('text')) continue;
    if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')) continue;
    saida.push({
      id: m.id,
      nome: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id,
      apelidos: [],
      entradaPorMilhao: porMilhao(m.pricing?.prompt),
      saidaPorMilhao: porMilhao(m.pricing?.completion),
    });
  }
  return saida;
}

// O cache fica em pasta que o agente escreve: abre sem seguir link (O_NOFOLLOW) e sem bloquear
// (O_NONBLOCK, para um FIFO nao travar), e confere pelo descritor que e arquivo comum e pequeno.
export function lerCacheOpenRouter(arquivo = arquivoCacheOpenRouter()) {
  let fd = null;
  try {
    fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LIMITE_RESPOSTA_OPENROUTER) return null;
    const c = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (Array.isArray(c.modelos) && c.modelos.length) return c;
  } catch { /* sem cache legivel: vale a reserva do catalogo */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ja fechado */ } }
  }
  return null;
}

export function cacheOpenRouterVelho(arquivo = arquivoCacheOpenRouter(), agora = Date.now()) {
  const c = lerCacheOpenRouter(arquivo);
  const quando = c ? Date.parse(c.buscadoEm) : NaN;
  return !Number.isFinite(quando) || agora - quando > VALIDADE_CACHE_OPENROUTER_MS;
}

// Le o corpo contando os bytes DURANTE a leitura: passou do teto, cancela (sem guardar tudo antes de conferir).
async function lerCorpoLimitado(resp) {
  const declarado = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(declarado) && declarado > LIMITE_RESPOSTA_OPENROUTER) {
    await resp.body?.cancel?.().catch(() => {});
    return { grande: true };
  }
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const texto = await resp.text();
    return Buffer.byteLength(texto) > LIMITE_RESPOSTA_OPENROUTER ? { grande: true } : { texto };
  }
  const leitor = resp.body.getReader();
  const pedacos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITE_RESPOSTA_OPENROUTER) { await leitor.cancel().catch(() => {}); return { grande: true }; }
    pedacos.push(value);
  }
  return { texto: Buffer.concat(pedacos).toString('utf8') };
}

const emCurso = new Map();

// Busca a lista publica (sem chave) e grava o cache de forma atomica. Nunca lanca: devolve
// { ok, quantos } ou { ok:false, erro } com o motivo em portugues, e o cache antigo segue valendo.
// Uma atualizacao por vez por arquivo.
export function atualizarCacheOpenRouter({ arquivo = arquivoCacheOpenRouter(), buscar = globalThis.fetch, url = URL_MODELOS_OPENROUTER, prazoMs = 8000 } = {}) {
  const rodando = emCurso.get(arquivo);
  if (rodando) return rodando;
  const p = atualizarDeVerdade({ arquivo, buscar, url, prazoMs }).finally(() => emCurso.delete(arquivo));
  emCurso.set(arquivo, p);
  return p;
}

async function atualizarDeVerdade({ arquivo, buscar, url, prazoMs }) {
  let tmp = null;
  try {
    const resp = await buscar(url, { signal: AbortSignal.timeout(prazoMs), headers: { accept: 'application/json' } });
    if (!resp.ok) return { ok: false, erro: `o OpenRouter respondeu ${resp.status} ao pedir a lista de modelos` };
    const corpo = await lerCorpoLimitado(resp);
    if (corpo.grande) return { ok: false, erro: 'a lista de modelos do OpenRouter veio grande demais; mantive a anterior' };
    const lista = filtrarModelosOpenRouter(JSON.parse(corpo.texto));
    if (!lista.length) return { ok: false, erro: 'a lista de modelos do OpenRouter veio vazia ou em formato novo; mantive a anterior' };
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    // Temporario com nome aleatorio e abertura exclusiva ('wx'): um link plantado no nome previsivel nao
    // faz a gravacao truncar outro arquivo.
    tmp = `${arquivo}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ buscadoEm: new Date().toISOString(), modelos: lista }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, arquivo);
    tmp = null;
    return { ok: true, quantos: lista.length };
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ja nao existe */ } }
    return { ok: false, erro: `não consegui buscar a lista de modelos do OpenRouter (${e instanceof Error ? e.message : e}); vale a lista guardada ou a de reserva` };
  }
}

// Lista de modelos de um provedor. Para o codex, o cache do proprio Codex (models_cache.json)
// manda; para o opencode, o cache do OpenRouter; sem eles, vale a lista de reserva do catalogo.
export function modelos(cat, id, { codexHome, soApi = false, cacheOpenRouter } = {}) {
  const p = provedorDe(cat, id);
  if (p.modelosDe === 'openrouter_api') {
    const c = lerCacheOpenRouter(cacheOpenRouter);
    if (c) {
      // Os apelidos (glm, kimi...) vivem na lista de reserva do catalogo e valem tambem para o cache.
      const apelidos = new Map((p.modelos || []).map((m) => [m.id, m.apelidos || []]));
      return c.modelos.map((m) => ({ ...m, apelidos: apelidos.get(m.id) || m.apelidos || [] }));
    }
  }
  if (p.modelosDe === 'codex_models_cache') {
    const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
      if (Array.isArray(cache.models) && cache.models.length) {
        return cache.models
          .filter((m) => m.visibility === 'list' && (!soApi || m.supported_in_api === true))
          .map((m) => ({ id: m.slug, nome: m.display_name || m.slug, apelidos: [] }));
      }
    } catch { /* sem cache legivel: cai na reserva */ }
  }
  return (p.modelos || []).map((m) => ({ ...m }));
}

// Devolve { provedor, auth, modelo } com o modelo no id canonico ('' = padrao do provedor).
// Lanca ErroCatalogo com mensagem em portugues se algo nao existe.
export function validar(cat, id, auth, modelo = '', opcoes = {}) {
  const p = provedorDe(cat, id);
  if (!p.disponivel) {
    throw new ErroCatalogo(`O provedor ${p.nome} ainda não está disponível: ${p.motivo || 'em preparo'}.`);
  }
  if (!p.auth || !Object.hasOwn(p.auth, auth)) {
    throw new ErroCatalogo(`Forma de pagar '${auth}' não existe para ${p.nome}. Use: ${listaPt(Object.keys(p.auth))}.`);
  }
  // Provedor que so abre cards (OpenCode) nunca serve de motor da conversa principal.
  if (p.soCard && !opcoes.paraCard) {
    throw new ErroCatalogo(`O ${p.nome} ${p.motivoSoCard || 'abre só cards'}. Escolha Claude ou Codex para a conversa principal.`);
  }
  // No OpenCode o modelo sempre vai explicito (o programa nao tem padrao proprio na API): vazio vira o padrao do catalogo.
  if (!modelo && p.modelosDe === 'openrouter_api') modelo = p.modeloPadrao || '';
  if (!modelo) return { provedor: id, auth, modelo: '' };
  const lista = modelos(cat, id, { ...opcoes, soApi: auth === 'api' });
  const m = modelo.toLowerCase();
  const achado = lista.find((x) => x.id.toLowerCase() === m || (x.apelidos || []).some((a) => a.toLowerCase() === m));
  if (!achado) {
    const ids = lista.length > 12 ? `${lista.slice(0, 12).map((x) => x.id).join(', ')} e mais ${lista.length - 12} (lista completa: catalogo.mjs modelos ${id})` : lista.map((x) => x.id).join(', ') || '(nenhum)';
    throw new ErroCatalogo(`Modelo '${modelo}' não existe para ${p.nome} ${p.auth[auth].nome}. Os válidos: ${ids}.`);
  }
  return { provedor: id, auth, modelo: achado.id };
}

export function rotulo(cat, id, auth, modelo = '', opcoes = {}) {
  const v = validar(cat, id, auth, modelo, opcoes);
  const p = cat.provedores[id];
  let nomeModelo;
  if (v.modelo) {
    const m = modelos(cat, id, { ...opcoes, soApi: auth === 'api' }).find((x) => x.id === v.modelo);
    nomeModelo = m?.nome || v.modelo;
  } else {
    nomeModelo = `${p.nome} (modelo padrão)`;
  }
  return `${nomeModelo}, ${p.auth[auth].nome}`;
}

export function campo(cat, id, caminho) {
  const p = provedorDe(cat, id);
  let v = p;
  for (const k of caminho.split('.')) v = v?.[k];
  return v === undefined || v === null ? '' : v;
}

async function cli(argv) {
  const [cmd, ...resto] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < resto.length; i++) {
    if (resto[i] === '--codex-home') flags.codexHome = resto[++i];
    else if (resto[i] === '--api') flags.soApi = true;
    else if (resto[i] === '--card') flags.paraCard = true;
    else if (resto[i] === '--atualizar') flags.atualizar = true;
    else pos.push(resto[i]);
  }
  try {
    const cat = carregar();
    const opc = { codexHome: flags.codexHome, paraCard: !!flags.paraCard };
    if (flags.atualizar && cacheOpenRouterVelho()) {
      const r = await atualizarCacheOpenRouter();
      if (!r.ok) process.stderr.write(`catalogo: ${r.erro}\n`);
    }
    if (cmd === 'validar') {
      if (pos.length < 2) throw new ErroCatalogo('Uso: catalogo.mjs validar <provedor> <auth> [modelo]');
      process.stdout.write(validar(cat, pos[0], pos[1], pos[2] || '', opc).modelo + '\n');
    } else if (cmd === 'rotulo') {
      if (pos.length < 2) throw new ErroCatalogo('Uso: catalogo.mjs rotulo <provedor> <auth> [modelo]');
      process.stdout.write(rotulo(cat, pos[0], pos[1], pos[2] || '', opc) + '\n');
    } else if (cmd === 'modelos') {
      if (!pos[0]) throw new ErroCatalogo('Uso: catalogo.mjs modelos <provedor> [--codex-home DIR] [--api] [--atualizar]');
      process.stdout.write(JSON.stringify(modelos(cat, pos[0], { ...opc, soApi: !!flags.soApi })) + '\n');
    } else if (cmd === 'campo') {
      if (pos.length < 2) throw new ErroCatalogo('Uso: catalogo.mjs campo <provedor> <caminho>');
      const v = campo(cat, pos[0], pos[1]);
      process.stdout.write((typeof v === 'object' ? JSON.stringify(v) : String(v)) + '\n');
    } else {
      throw new ErroCatalogo('Subcomandos: validar, rotulo, modelos, campo.');
    }
  } catch (e) {
    if (!(e instanceof ErroCatalogo)) throw e;
    process.stderr.write(`catalogo: ${e.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
