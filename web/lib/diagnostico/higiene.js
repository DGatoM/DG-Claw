'use strict';
// Higienização de TUDO o que vem de log, arquivo ou comando antes de entrar no diagnóstico.
// Função única de propósito: se um dia aparecer um segredo novo, o conserto é aqui e vale para todas as verificações.

const { mascararDados, OCULTO } = require('../mascara');

const PROTEGIDO = '[arquivo protegido]';
// ANSI e caracteres de controle (menos \t e \n, que viram espaço logo depois).
const RX_CONTROLE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x1f\x7f]/g;
// Qualquer coisa que pareça caminho e cite segredo, token, cofre, .env ou /etc/dgclaw.
const RX_CAMINHO_PROTEGIDO = /\S*\/etc\/dgclaw\S*|\S*\/\S*(?:segredo|secret|token|cofre|credenc|senha|passw|\.env|\.pem|\.key|id_rsa|auth\.json)\S*/gi;
// Texto entre aspas com mais de 60 caracteres costuma ser frase de usuário ou de modelo, não de sistema.
const RX_ASPAS_LONGAS = /"[^"\n]{60,}"|'[^'\n]{60,}'|“[^”\n]{60,}”/g;

/** Tira cor, caracteres de controle e espaços repetidos. */
function limpaControle(texto) {
  return String(texto == null ? '' : texto).replace(RX_CONTROLE, ' ').replace(/\s+/g, ' ').trim();
}

function corta(texto, max) {
  const letras = Array.from(texto);
  return letras.length > max ? `${letras.slice(0, max - 1).join('')}…` : texto;
}

/**
 * Texto de log, arquivo ou comando pronto para sair na API: sem segredo, sem dado de pessoa, sem caminho
 * de arquivo protegido, sem trecho longo entre aspas, cortado em `max` caracteres.
 */
function higienizar(texto, max = 200) {
  let t = limpaControle(texto);
  t = t.replace(RX_CAMINHO_PROTEGIDO, PROTEGIDO);
  t = t.replace(RX_ASPAS_LONGAS, '"[trecho omitido]"');
  t = mascararDados(t);
  return corta(t, max);
}

/**
 * Passada final nos textos que o próprio diagnóstico escreveu (motivo, o que fazer, prompt). Não corta nem
 * mexe em caminhos: só garante que nenhum segredo ou dado de pessoa que tenha entrado numa frase saia.
 */
function protege(texto) {
  if (texto == null) return null;
  const linhas = String(texto).split('\n').map((l) => mascararDados(limpaControle(l))).filter(Boolean);
  return linhas.join('\n');
}

module.exports = { higienizar, protege, limpaControle, corta, PROTEGIDO, OCULTO };
