'use strict';
// O runner do agente exige `Authorization: Bearer <token>`. O token fica num arquivo
// (modo 600) cujo caminho vem de CONFIG.runnerTokenFile ou de RUNNER_TOKEN_FILE.
// Sem caminho configurado nada muda: o alvo pode ser o Bunker antigo, que ignora o
// cabeçalho. O arquivo é relido quando o mtime muda, para trocar o token sem
// reiniciar o painel. O token nunca vai para log.

const fs = require('fs');

let memo = { caminho: null, mtimeMs: 0, token: null };
const jaAvisados = new Set();

function avisarUmaVez(caminho, erro) {
  const chave = `${caminho}|${erro}`;
  if (jaAvisados.has(chave)) return;
  jaAvisados.add(chave);
  console.error(
    `[runner-token] não consegui usar o arquivo do token do runner em ${caminho}: ${erro}. ` +
    'As chamadas ao runner seguem sem o cabeçalho Authorization e ele vai responder 401. ' +
    'Confira se o arquivo existe, não está vazio e se o usuário do painel consegue lê-lo.'
  );
}

function lerToken(caminho) {
  try {
    const { mtimeMs } = fs.statSync(caminho);
    if (memo.caminho === caminho && memo.mtimeMs === mtimeMs && memo.token) return memo.token;
    const token = fs.readFileSync(caminho, 'utf8').trim();
    if (!token) {
      avisarUmaVez(caminho, 'arquivo vazio');
      return null;
    }
    memo = { caminho, mtimeMs, token };
    return token;
  } catch (e) {
    avisarUmaVez(caminho, e.code || e.message);
    return null;
  }
}

/** Caminho do arquivo do token, ou null. É o que vai para o ambiente dos filhos. */
function caminhoDoToken(config) {
  return (config && config.runnerTokenFile) || process.env.RUNNER_TOKEN_FILE || null;
}

/** `{ Authorization: 'Bearer ...' }` ou `{}` (sem token configurado ou ilegível). */
function cabecalhoDoRunner(config) {
  const caminho = caminhoDoToken(config);
  if (!caminho) return {};
  const token = lerToken(caminho);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

module.exports = { cabecalhoDoRunner, caminhoDoToken };
