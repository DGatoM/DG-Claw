'use strict';
// `dgclaw ferramenta listar`: uma linha por ferramenta da pasta (nome, agentes, estado da credencial) e o defeito das que não carregam.
// Uso: node listar.js <pasta-das-ferramentas>

const fs = require('node:fs');
const path = require('node:path');
const { criarNucleo } = require('./nucleo');

const dir = process.argv[2];
if (!dir) { process.stderr.write('Uso: node listar.js <pasta-das-ferramentas>\n'); process.exit(2); }
const avisos = [];
const nucleo = criarNucleo({ dir, log: (n, m) => { if (n !== 'info') avisos.push(m); } });
const { ferramentas, defeituosas } = nucleo.listar(null);

function estadoCredencial(nome) {
  const p = path.join(dir, nome);
  if (fs.existsSync(path.join(p, 'credenciais.env.cred'))) return 'cifrada';
  if (fs.existsSync(path.join(p, 'credenciais.env'))) return 'em claro (600)';
  return 'ausente';
}

if (!ferramentas.length && !defeituosas.length) process.stdout.write(`Nenhuma ferramenta em ${dir}. Crie uma com: dgclaw ferramenta criar <nome> --agente <slug> --responsavel "<nome>"\n`);
for (const d of ferramentas) {
  process.stdout.write(`${d.nome}\n  agentes: ${d.agentes.join(', ')}\n  responsavel: ${d.responsavel}\n  credencial: ${estadoCredencial(d.nome)}\n  grupo minimo: ${d.minimo_grupo}\n`);
}
for (const d of defeituosas) process.stdout.write(`${d.nome}\n  COM DEFEITO: ${d.erro}\n`);
for (const a of avisos) process.stderr.write(`aviso: ${a}\n`);
process.exit(defeituosas.length ? 1 : 0);
