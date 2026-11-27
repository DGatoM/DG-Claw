#!/usr/bin/env node
// Catálogos locais são a fonte; o bundle público é derivado, sem serviço externo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pasta = path.join(raiz, 'web', 'i18n');
const destino = path.join(raiz, 'web/public/ds/idiomas.js');
const hash = fonte => crypto.createHash('sha256').update(fonte).digest('hex').slice(0, 12);
const placeholders = v => (v.match(/\{\{[^}]+\}\}|\{[a-z_][a-z_0-9]*\}/g) || []).sort().join('|');
function ler() {
  const reunido = new Map();
  for (const arquivo of fs.readdirSync(pasta).filter(n => /^[a-z0-9-]+\.json$/.test(n)).sort()) {
    const dados = JSON.parse(fs.readFileSync(path.join(pasta, arquivo), 'utf8'));
    if (!dados || Array.isArray(dados) || typeof dados !== 'object') throw new Error('Catálogo inválido: ' + arquivo);
    for (const [pt, en] of Object.entries(dados)) {
      if (!pt || typeof en !== 'string' || !en || placeholders(pt) !== placeholders(en)) throw new Error('Texto ou placeholders inválidos em ' + arquivo + ': ' + pt);
      const anterior = reunido.get(pt);
      if (anterior && anterior.en !== en) throw new Error('Traduções conflitantes entre ' + anterior.arquivo + ' e ' + arquivo + ': ' + pt);
      reunido.set(pt, { en, arquivo });
    }
  }
  const entradas = [...reunido].map(([pt, v]) => [hash(pt), { 'pt-BR': pt, en: v.en }]).sort(([a], [b]) => a.localeCompare(b));
  const catalogo = Object.fromEntries(entradas);
  if (Object.keys(catalogo).length !== entradas.length) throw new Error('Colisão de chaves; o bundle não foi alterado.');
  return { catalogo, reunido };
}
function compilar() {
  const { catalogo } = ler();
  const codigo = "'use strict';\n// Gerado por scripts/idiomas.mjs --compilar a partir de web/i18n/*.json.\n// Só textos próprios da interface; valores de pessoas não são fontes de tradução.\n(function (root, value) {\n  if (typeof module === 'object' && module.exports) module.exports = value;\n  else root.DGIdiomas = value;\n})(typeof globalThis !== 'undefined' ? globalThis : this, " + JSON.stringify(catalogo, null, 2) + ');\n';
  fs.writeFileSync(destino, codigo);
  console.log(Object.keys(catalogo).length + ' entradas compiladas.');
}
const [acao = '--verificar', pt, en, ...opcoes] = process.argv.slice(2);
if (acao === '--adicionar') {
  if (!pt || !en || pt.length > 20000 || en.length > 20000 || placeholders(pt) !== placeholders(en)) throw new Error('Use --adicionar "fonte PT" "English" [--catalogo nome.json], com placeholders iguais.');
  const { reunido } = ler();
  const arq = opcoes[0] === '--catalogo' ? opcoes[1] : (reunido.get(pt)?.arquivo || 'base.json');
  if (!/^[a-z0-9-]+\.json$/.test(arq || '')) throw new Error('Nome de catálogo inválido.');
  const alvo = path.join(pasta, arq);
  const dados = fs.existsSync(alvo) ? JSON.parse(fs.readFileSync(alvo, 'utf8')) : {};
  dados[pt] = en;
  fs.writeFileSync(alvo, JSON.stringify(dados, null, 2) + '\n');
  compilar();
  console.log('Chave: ' + hash(pt));
} else if (acao === '--compilar') compilar();
else if (acao === '--verificar') {
  const { catalogo } = ler();
  const publico = require(destino);
  if (JSON.stringify(publico) !== JSON.stringify(catalogo)) throw new Error('Bundle desatualizado. Rode node scripts/idiomas.mjs --compilar.');
  console.log(Object.keys(catalogo).length + ' entradas verificadas; bundle em dia.');
} else throw new Error('Use --verificar, --compilar ou --adicionar.');
