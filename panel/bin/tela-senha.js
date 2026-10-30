#!/usr/bin/env node
'use strict';
// tela-senha.js: grava o arquivo de senha da Tela (rfbauth do x11vnc) sem a senha passar por argumento.
//
//   printf '%s\n' "$SENHA" | node panel/bin/tela-senha.js --arquivo /home/agente/.dgclaw/tela/vnc.senha
//
// A senha vem de UMA linha do STDIN (nunca de argv, que aparece em `ps`). Regras: 6 a 8
// caracteres ASCII imprimíveis, as mesmas do painel. Sai com 0 se gravou, 1 se a senha foi
// recusada ou a gravação falhou, 2 se o uso estava errado; a mensagem diz o que fazer.

const fs = require('fs');
const path = require('path');
const { validarSenha, gravarRfbauth } = require('../lib/tela-senha');

function falhar(codigo, msg) {
  process.stderr.write(`tela-senha: ${msg}\n`);
  process.exit(codigo);
}

const args = process.argv.slice(2);
const i = args.indexOf('--arquivo');
if (i === -1 || !args[i + 1] || args.length !== 2) {
  falhar(2, 'uso: node tela-senha.js --arquivo <caminho do rfbauth>, com a senha em uma linha no STDIN. ' +
    'A senha não vai como argumento porque argumentos aparecem em `ps` e em log.');
}
const arquivo = path.resolve(args[i + 1]);

let entrada;
try {
  entrada = fs.readFileSync(0, 'utf8');
} catch (err) {
  falhar(2, `não consegui ler a senha do STDIN (${err.code || err.message}). Mande a senha por pipe: printf '%s\\n' "$SENHA" | node tela-senha.js --arquivo ...`);
}
// Tira só a quebra de linha do fim: espaço no começo ou no meio faz parte da senha.
const senha = entrada.replace(/\r?\n$/, '');
if (senha.includes('\n')) falhar(2, 'o STDIN trouxe mais de uma linha; mande só a senha, em uma linha.');

const v = validarSenha(senha);
if (!v.ok) falhar(1, `${v.erro} ${v.howToFix}`);
try {
  gravarRfbauth(arquivo, senha);
} catch (err) {
  falhar(1, err.message);
}
process.stdout.write(`senha da tela gravada em ${arquivo}\n`);
