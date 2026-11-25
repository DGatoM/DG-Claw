#!/usr/bin/env node
// Manutenção do catálogo: sem rede, serviço de tradução ou alteração de dados da instalação.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const catalogo = require('../web/public/ds/idiomas');
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = fonte => crypto.createHash('sha256').update(fonte).digest('hex').slice(0, 12);
const [acao = '--verificar', pt, en] = process.argv.slice(2);
if (acao === '--adicionar') {
  if (!pt || !en || pt.length > 20000 || en.length > 20000) throw new Error('Use --adicionar "texto em português" "English translation" (até 20000 caracteres).');
  const placeholders = v => (v.match(/\{\{[^}]+\}\}|\{[a-z_]+\}/g) || []).sort().join('|');
  if (placeholders(pt) !== placeholders(en)) throw new Error('Os placeholders precisam ser iguais nos dois idiomas.');
  const id = hash(pt);
  if (catalogo[id] && catalogo[id]['pt-BR'] !== pt) throw new Error('Colisão de chave: o catálogo não foi alterado.');
  catalogo[id] = { 'pt-BR': pt, en };
  const codigo = "'use strict';\n// Catálogo de textos próprios da interface. Dados de pessoas nunca são chaves.\n(function (root, value) {\n  if (typeof module === 'object' && module.exports) module.exports = value;\n  else root.DGIdiomas = value;\n})(typeof globalThis !== 'undefined' ? globalThis : this, " + JSON.stringify(catalogo, null, 2) + ');\n';
  fs.writeFileSync(path.join(raiz, 'web/public/ds/idiomas.js'), codigo);
  console.log('Chave: ' + id);
  console.log('Texto HTML: <!--dg-i18n:' + id + '-->' + pt + '<!--/dg-i18n-->');
  console.log('JavaScript: DGI18n.t(' + JSON.stringify(pt) + ')');
} else if (acao === '--verificar') {
  for (const [id, v] of Object.entries(catalogo)) {
    if (!v['pt-BR'] || !v.en || hash(v['pt-BR']) !== id) throw new Error('Entrada inválida: ' + id);
  }
  console.log(Object.keys(catalogo).length + ' entradas válidas. Os testes de idioma conferem os fallbacks e as referências HTML.');
} else throw new Error('Use --verificar ou --adicionar.');
