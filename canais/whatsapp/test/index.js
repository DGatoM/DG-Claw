// Ponto de entrada para `node --test canais/whatsapp/test/` (o Node 22 nao expande pasta
// sozinho: ele procura o index.js dela). Carrega todos os arquivos *.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
for (const nome of fs.readdirSync(aqui).sort()) {
  if (nome.endsWith('.test.mjs')) await import(pathToFileURL(path.join(aqui, nome)).href);
}
