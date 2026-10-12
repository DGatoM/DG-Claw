'use strict';
/**
 * extensions.js — Descobre quais extensoes estao instaladas no agente.
 *
 * O DG Claw sozinho e um profissional: ele nao tem humor, nao tem emocao e o painel dele
 * nao mostra nada disso. Quem instala a extensao DG Alive ganha o estado emocional, e o
 * painel passa a mostrar a aba de humor e as expressoes do avatar.
 *
 * A deteccao e por pasta: .dgclaw/ext/<nome>/ existe = extensao instalada. Nada de flag
 * escondida em config, pra que "desinstalar" seja simplesmente apagar a pasta.
 */

const fs = require('fs');
const path = require('path');

/**
 * Lista os nomes das extensoes instaladas.
 * Pasta inexistente ou ilegivel devolve lista vazia (o painel funciona igual, so sem extras).
 *
 * `legacyAlive` e o caminho do state.json da instalacao ANTIGA (persona/, de antes da
 * fusao). Quem tem esse arquivo tem vida emocional instalada, so que no lugar antigo:
 * conta como a extensao 'alive' ligada, senao o painel apagaria o humor de um agente que
 * tem humor. O migrador arruma a pasta; ate la o painel enxerga os dois jeitos.
 */
function listExtensions(extDir, legacyAlive) {
  let nomes = [];
  try {
    nomes = fs
      .readdirSync(extDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(
        `[painel] nao consegui ler a pasta de extensoes ${extDir} (${err.code}): ${err.message}. ` +
          `O painel vai subir sem os widgets de extensao.`
      );
    }
  }
  if (!nomes.includes('alive') && legacyAlive) {
    try {
      if (fs.existsSync(legacyAlive)) nomes.push('alive');
    } catch { /* caminho ilegivel conta como ausente */ }
  }
  return nomes.sort();
}

/** Atalho: a extensao de emocoes (DG Alive) esta instalada? */
function hasAlive(extDir, legacyAlive) {
  return listExtensions(extDir, legacyAlive).includes('alive');
}

/**
 * Escolhe o arquivo de estado que existe: o novo (.dgclaw/ext/alive/) ou o da instalacao
 * antiga (persona/). Se nenhum existir, devolve o caminho novo mesmo, pra quem chamou
 * seguir o caminho normal de "arquivo ausente" (que no DG Claw puro e o caso esperado,
 * nao um erro). Nunca devolve null, pra nao explodir em quem so quer ler.
 */
function resolveStateFile(primary, legacy) {
  for (const p of [primary, legacy]) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* caminho ilegivel conta como ausente */
    }
  }
  return primary;
}

module.exports = { listExtensions, hasAlive, resolveStateFile };
