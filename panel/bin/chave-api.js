#!/usr/bin/env node
//
// chave-api.js — cria, lista e revoga as chaves de API do painel SEM abrir a tela.
//
// QUEM USA: quem administra a máquina (por exemplo o agente Admin, ao criar um
// agente novo). Uma chave de API NÃO consegue gerenciar chaves pelo painel, então
// a primeira chave de um agente nasce aqui ou na aba Cofre, nunca por Bearer.
//
// USO:
//   node panel/bin/chave-api.js criar "Admin"   imprime SÓ o token, no stdout
//   node panel/bin/chave-api.js listar          código, nome, estado (sem hash, sem token)
//   node panel/bin/chave-api.js revogar <id>
//
// O agente é o do config do painel (DGCLAW_PANEL_CONFIG ou panel/config.json), igual
// ao cofre-materializar.js. O token aparece UMA vez: o painel guarda só o hash.

const path = require('path');
const { loadConfig } = require('../lib/config');
const { buildChavesApi } = require('../lib/chaves-api');

const config = loadConfig(path.join(__dirname, '..'));
const chaves = buildChavesApi(config);
const [, , comando, ...resto] = process.argv;

function falhar(msg, code) {
  process.stderr.write(`${msg}\n`);
  process.exit(code || 1);
}

function resultado(r) {
  if (r && r.erro) falhar(`${r.erro}${r.howToFix ? ` ${r.howToFix}` : ''}`);
  return r;
}

if (comando === 'criar') {
  const r = resultado(chaves.criar({ nome: resto.join(' '), quem: 'CLI (administrador da máquina)' }));
  process.stderr.write(`Chave "${r.nome}" criada (código ${r.id}). ${r.aviso}\n`);
  process.stdout.write(`${r.token}\n`);
} else if (comando === 'listar') {
  const lista = chaves.listar();
  if (!lista.length) process.stderr.write('Nenhuma chave de API criada neste agente.\n');
  for (const c of lista) {
    process.stdout.write(`${c.id}\t${c.nome}\t${c.revogadaEm ? `revogada em ${c.revogadaEm.slice(0, 10)}` : 'ativa'}\t` +
      `criada ${c.criadaEm.slice(0, 10)} por ${c.criadaPor}\tfinal ${c.ultimos4}\tultimo uso ${c.ultimoUsoEm || 'nunca'}\n`);
  }
} else if (comando === 'revogar') {
  const r = resultado(chaves.revogar(resto[0], 'CLI (administrador da máquina)'));
  process.stdout.write(`${r.aviso}\n`);
} else {
  falhar('Uso: node panel/bin/chave-api.js criar "<nome>" | listar | revogar <código>', 2);
}
