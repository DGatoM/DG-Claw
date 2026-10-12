'use strict';
// Ponto de entrada para `node --test web/test/` (o Node 22 não expande pasta sozinho:
// ele procura o index.js dela). Carrega todos os arquivos *.test.js.
const fs = require('node:fs');
const path = require('node:path');

for (const nome of fs.readdirSync(__dirname).sort()) {
  if (nome.endsWith('.test.js')) require(path.join(__dirname, nome));
}
