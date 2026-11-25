// Memoria curta (so em RAM, nada em disco) do texto das mensagens que o AGENTE enviou, por JID da
// conversa e id. Serve para dizer ao agente a que pergunta dele uma reacao se refere.
import { GUARDAR_IDS } from './limites.mjs';

const TAMANHO_TRECHO = 200;
// Normalizar so um prefixo: a regex de quebras de linha e quadratica em texto cheio de espacos.
const PREFIXO_MAX = 1000;

export function criarMemoriaMensagens({ teto = GUARDAR_IDS } = {}) {
  const trechos = new Map();
  const chave = (jid, id) => `${jid}\n${id}`;

  function lembrar(jid, id, texto) {
    if (!jid || !id || typeof texto !== 'string') return;
    const inicio = texto.trimStart();
    const plano = inicio.slice(0, PREFIXO_MAX).replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!plano) return;
    const chars = Array.from(plano);
    const cortou = chars.length > TAMANHO_TRECHO || inicio.length > PREFIXO_MAX;
    const k = chave(jid, id);
    trechos.delete(k);
    trechos.set(k, (chars.length > TAMANHO_TRECHO ? chars.slice(0, TAMANHO_TRECHO).join('') : plano) + (cortou ? '…' : ''));
    if (trechos.size > teto) trechos.delete(trechos.keys().next().value);
  }

  const trecho = (jid, id) => trechos.get(chave(jid, id)) || null;

  // Mensagem editada ou apagada: nunca citar a versao original. So esquece, nao regrava.
  const esquecer = (jid, id) => { trechos.delete(chave(jid, id)); };

  function esquecerConversa(jid) {
    for (const k of [...trechos.keys()]) if (k.startsWith(jid + '\n')) trechos.delete(k);
  }

  return { lembrar, trecho, esquecer, esquecerConversa };
}
