// Grupos de WhatsApp pela Z-API: formato do ID, nome vindo de fora e a lista que o dono liberou
// (grupos-liberados.json, na mesma pasta e com o mesmo modelo de risco do permitidos.json).
import fs from 'node:fs';
import { motivoErro } from './util.mjs';

// ID de grupo da Z-API: digitos seguidos de "-group". O bin/dgclaw-agente repete esta regra em bash (ID_GRUPO).
const ID_GRUPO = /^\d{10,30}-group$/;
export const TAMANHO_MAX_NOME = 100;

export function idDeGrupoValido(entrada) {
  return typeof entrada === 'string' && ID_GRUPO.test(entrada);
}

export function motivoGrupoInvalido(entrada) {
  return `o grupo "${String(entrada).slice(0, 40)}" nao e valido: o ID tem digitos seguidos de "-group" ` +
    '(por exemplo 120363000000000000-group). Para achar o ID pelo nome, rode "enviar-zapi.mjs grupos"';
}

/** Nome de grupo vem de fora: tira controle e quebra de linha e corta no tamanho maximo. */
export function limparNome(nome) {
  return String(nome ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TAMANHO_MAX_NOME);
}

/**
 * Le a lista de grupos liberados. Arquivo ausente: nenhum grupo liberado.
 * Arquivo que existe e nao le (ou tem formato errado) NUNCA libera: devolve { erro }.
 * @returns {{ grupos: Array<{id:string,nome:string,liberado_em:string}> } | { erro: string }}
 */
export function lerGruposLiberados(arquivo) {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { grupos: [] };
    return { erro: `nao consegui ler ${arquivo} (${motivoErro(e)}); confira a permissao do arquivo` };
  }
  try {
    const o = JSON.parse(bruto);
    if (!o || !Array.isArray(o.grupos)) throw new Error('faltou o campo "grupos"');
    const grupos = [];
    for (const g of o.grupos) {
      if (!g || !idDeGrupoValido(g.id)) throw new Error(`ha um ID de grupo invalido (${JSON.stringify(g && g.id).slice(0, 40)})`);
      grupos.push({ id: g.id, nome: limparNome(g.nome), liberado_em: String(g.liberado_em ?? '') });
    }
    return { grupos };
  } catch (e) {
    return { erro: `${arquivo} esta ilegivel (${motivoErro(e)}); nenhum grupo esta liberado. O dono corrige ou apaga o arquivo e libera de novo com "dgclaw-agente canal whatsapp grupo liberar <id>"` };
  }
}
