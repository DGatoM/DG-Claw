#!/usr/bin/env node
//
// senha-hash.js — transforma a senha do painel na linha de hash que vai no ambiente.
//
// USO:
//   node panel/bin/senha-hash.js                  (pede a senha, sem mostrar na tela)
//   printf '%s' "$SENHA" | node panel/bin/senha-hash.js   (senha por stdin, com ou sem quebra de linha)
//
// Imprime SÓ a linha `scrypt$...` no stdout, para quem chama poder capturá-la com
// `$(...)`. Pergunta, aviso e erro vão para o stderr.
//
// A SENHA NÃO VEM POR ARGUMENTO, de propósito: o que vai na linha de comando
// aparece no `ps` e no histórico do shell de qualquer usuário da máquina.
//
// MÍNIMO DE 12 CARACTERES: este login é a única porta de entrada para um agente que
// roda como administrador da máquina. Senha curta aqui é a máquina inteira com senha
// curta.

const { gerarHash, MIN_SENHA } = require('../lib/auth');

function falhar(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

/** Lê uma linha do terminal sem eco. */
function lerSemEco(pergunta) {
  return new Promise((ok) => {
    const stdin = process.stdin;
    process.stderr.write(pergunta);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let texto = '';
    const aoTecla = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', aoTecla);
          process.stderr.write('\n');
          return ok(texto);
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') texto = texto.slice(0, -1);
        else texto += c;
      }
    };
    stdin.on('data', aoTecla);
  });
}

function lerTudo() {
  return new Promise((ok, falha) => {
    const partes = [];
    process.stdin.on('data', (d) => partes.push(d));
    process.stdin.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    process.stdin.on('error', falha);
  });
}

(async () => {
  let senha;
  if (process.stdin.isTTY) {
    senha = await lerSemEco('Senha do painel: ');
    const de_novo = await lerSemEco('Repita a senha: ');
    if (senha !== de_novo) falhar('As duas senhas não são iguais, então não gerei nada. Rode de novo.');
  } else {
    // Só a quebra de linha do FINAL sai; espaço no fim faz parte da senha.
    senha = (await lerTudo()).replace(/\r?\n$/, '');
  }
  if (senha.length < MIN_SENHA) {
    falhar(`A senha precisa ter pelo menos ${MIN_SENHA} caracteres (a sua tem ${senha.length}). ` +
      'Este login é a única porta para um agente que roda como administrador da máquina, então senha curta não serve. ' +
      'Uma frase com quatro palavras soltas resolve e é fácil de lembrar.');
  }
  if (senha.toLowerCase() === 'admin') falhar('A senha "admin" é a primeira que qualquer pessoa tenta. Escolha outra.');
  process.stdout.write(`${await gerarHash(senha)}\n`);
})().catch((e) => falhar(`Não consegui gerar o hash: ${e.message}`));
