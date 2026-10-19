// A lista de permitidos (permitidos.json), relida quando o arquivo muda.
import fs from 'node:fs';
import { normalizar, mesmoNumero } from './numeros.mjs';
import { motivoErro } from './util.mjs';

/**
 * `aoMudarLista` roda quando a lista muda com a ponte ja em uso (a ponte pede de novo o LID de
 * cada numero ao WhatsApp).
 */
export function criarPermitidos({ arqPermitidos, registrar, aoMudarLista }) {
  // ===========================================================================
  let listaCache = { chave: null, numeros: [] };

  function lerPermitidos() {
    let st;
    try {
      st = fs.statSync(arqPermitidos);
    } catch (e) {
      const chave = 'ausente:' + e.code;
      if (listaCache.chave !== chave) {
        listaCache = { chave, numeros: [] };
        registrar(`a lista de permitidos nao pode ser lida (${arqPermitidos}: ${motivoErro(e)}); ninguem pode falar com o agente. Rode "dgclaw-agente canal whatsapp permitir <numero>".`);
      }
      return listaCache.numeros;
    }
    const chave = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (listaCache.chave === chave) return listaCache.numeros;
    let numeros = [];
    try {
      const j = JSON.parse(fs.readFileSync(arqPermitidos, 'utf8'));
      if (!j || !Array.isArray(j.numeros)) throw new Error('faltou o campo "numeros" (esperado {"versao":1,"numeros":["+5511987654321"]})');
      const invalidos = [];
      for (const n of j.numeros) {
        const norm = normalizar(n);
        if (norm) numeros.push(norm); else invalidos.push(String(n).slice(0, 30));
      }
      if (invalidos.length) {
        registrar(`a lista de permitidos (${arqPermitidos}) tem ${invalidos.length} numero(s) invalido(s) que foram ignorados. Rode "dgclaw-agente canal whatsapp remover <numero>" e permita de novo no formato +5511987654321.`);
      }
    } catch (e) {
      numeros = [];
      registrar(`a lista de permitidos esta ilegivel (${arqPermitidos}: ${motivoErro(e)}); ninguem pode falar com o agente. Rode "dgclaw-agente canal whatsapp permitir <numero>" para refazer.`);
    }
    const mudou = listaCache.chave !== null;
    listaCache = { chave, numeros };
    // Lista nova com a ponte conectada: confere de novo o LID de cada numero.
    if (mudou) aoMudarLista();
    return numeros;
  }

  const estaPermitido = (numero) => lerPermitidos().some((p) => mesmoNumero(p, numero));

  return { lerPermitidos, estaPermitido };
}
