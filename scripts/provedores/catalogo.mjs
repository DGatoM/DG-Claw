#!/usr/bin/env node
// catalogo.mjs - le providers/catalogo.json (fonte unica de provedores) e valida escolhas.
// Uso como CLI (bash chama isto):
//   catalogo.mjs validar <provedor> <auth> [modelo]   exit 0 e imprime o id canonico do modelo; exit 2 com motivo
//   catalogo.mjs rotulo  <provedor> <auth> [modelo]   ex.: "Claude Opus 5.5, na assinatura"
//   catalogo.mjs modelos <provedor> [--codex-home DIR] [--api]   JSON da lista
//   catalogo.mjs campo   <provedor> <caminho.com.pontos>         valor de um campo (ex.: auth.api.variavel)
// Como modulo: exporta carregar, validar, rotulo, modelos, campo.
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
  const p = cat.provedores?.[id];
  if (!p) {
    throw new ErroCatalogo(`Provedor '${id}' não existe. Os que existem: ${Object.keys(cat.provedores).join(', ')}.`);
  }
  return p;
}

// Lista de modelos de um provedor. Para o codex, o cache do proprio Codex (models_cache.json)
// manda; sem ele, vale a lista de reserva do catalogo.
export function modelos(cat, id, { codexHome, soApi = false } = {}) {
  const p = provedorDe(cat, id);
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
  if (!p.auth?.[auth]) {
    throw new ErroCatalogo(`Forma de pagar '${auth}' não existe para ${p.nome}. Use: ${listaPt(Object.keys(p.auth))}.`);
  }
  if (!modelo) return { provedor: id, auth, modelo: '' };
  const lista = modelos(cat, id, { ...opcoes, soApi: auth === 'api' });
  const m = modelo.toLowerCase();
  const achado = lista.find((x) => x.id.toLowerCase() === m || (x.apelidos || []).some((a) => a.toLowerCase() === m));
  if (!achado) {
    const ids = lista.map((x) => x.id).join(', ') || '(nenhum)';
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

function cli(argv) {
  const [cmd, ...resto] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < resto.length; i++) {
    if (resto[i] === '--codex-home') flags.codexHome = resto[++i];
    else if (resto[i] === '--api') flags.soApi = true;
    else pos.push(resto[i]);
  }
  try {
    const cat = carregar();
    const opc = { codexHome: flags.codexHome };
    if (cmd === 'validar') {
      if (pos.length < 2) throw new ErroCatalogo('Uso: catalogo.mjs validar <provedor> <auth> [modelo]');
      process.stdout.write(validar(cat, pos[0], pos[1], pos[2] || '', opc).modelo + '\n');
    } else if (cmd === 'rotulo') {
      if (pos.length < 2) throw new ErroCatalogo('Uso: catalogo.mjs rotulo <provedor> <auth> [modelo]');
      process.stdout.write(rotulo(cat, pos[0], pos[1], pos[2] || '', opc) + '\n');
    } else if (cmd === 'modelos') {
      if (!pos[0]) throw new ErroCatalogo('Uso: catalogo.mjs modelos <provedor> [--codex-home DIR] [--api]');
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
