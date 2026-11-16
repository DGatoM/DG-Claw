'use strict';
// Higienização de TUDO o que vem de log, arquivo ou comando antes de entrar no diagnóstico.
// Função única de propósito: se um dia aparecer um segredo novo, o conserto é aqui e vale para todas as verificações.

const { mascararDados, OCULTO } = require('../mascara');

const PROTEGIDO = '[arquivo protegido]';
// ANSI e caracteres de controle (menos \t e \n, que viram espaço logo depois).
const RX_CONTROLE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x1f\x7f]/g;
// Palavras que, depois de uma barra no mesmo token, indicam caminho de segredo, token, cofre, .env ou /etc/dgclaw.
// Testada em cada token já separado, com literais só: custo linear (o padrão antigo, com \S* dos dois lados, não era).
const RX_PALAVRA_PROTEGIDA = /segredo|secret|token|cofre|credenc|senha|passw|\.env|\.pem|\.key|id_rsa|auth\.json/i;
// Limites aplicados ANTES de qualquer expressão regular: o texto vem de fora e pode ter centenas de KiB.
const MAX_LINHA = 1000;
const MAX_TOTAL = 8 * 1024;
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

/** No máximo 1000 caracteres por linha e 8 KB no total. Nenhuma regex roda antes disto. */
function limitaEntrada(texto) {
  const bruto = String(texto == null ? '' : texto).slice(0, MAX_TOTAL);
  return bruto.split('\n').map((l) => l.slice(0, MAX_LINHA));
}

/** Chave privada PEM: do cabeçalho até o fim do texto vira OCULTO (sem regex, o corpo pode ser enorme). */
function cortaChavePrivada(texto) {
  const fim = texto.indexOf('PRIVATE KEY-----');
  if (fim < 0) return texto;
  const ini = texto.lastIndexOf('-----BEGIN', fim);
  return ini < 0 ? texto : `${texto.slice(0, ini)}${OCULTO}`;
}

function protegeCaminhos(linha) {
  return linha.split(' ').map((tok) => {
    if (tok.includes('/etc/dgclaw')) return PROTEGIDO;
    const i = tok.indexOf('/');
    return i >= 0 && RX_PALAVRA_PROTEGIDA.test(tok.slice(i + 1)) ? PROTEGIDO : tok;
  }).join(' ');
}

/**
 * Texto de log, arquivo ou comando pronto para sair em LOG DO SERVIDOR: sem segredo, sem dado de pessoa, sem
 * caminho de arquivo protegido, sem trecho longo entre aspas, cortado em `max` caracteres.
 * Nada disto vai para a resposta da API: lá, linha de log nunca sai (ver classificar.js).
 */
function higienizar(texto, max = 200) {
  const linhas = cortaChavePrivada(limitaEntrada(texto).join('\n')).split('\n');
  const partes = linhas.map((l) => {
    let t = protegeCaminhos(limpaControle(l));
    t = t.replace(RX_ASPAS_LONGAS, '"[trecho omitido]"');
    return mascararDados(t);
  }).filter(Boolean);
  return corta(partes.join(' '), max);
}

/**
 * Passada final nos textos que o próprio diagnóstico escreveu (motivo, o que fazer, prompt). Não corta nem
 * mexe em caminhos: só garante que nenhum segredo ou dado de pessoa que tenha entrado numa frase saia.
 */
function protege(texto) {
  if (texto == null) return null;
  const linhas = limitaEntrada(texto).map((l) => mascararDados(limpaControle(l))).filter(Boolean);
  return linhas.join('\n');
}

module.exports = { higienizar, protege, limpaControle, corta, limitaEntrada, PROTEGIDO, OCULTO, MAX_LINHA, MAX_TOTAL };
