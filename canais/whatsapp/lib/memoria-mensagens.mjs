// Memoria curta (so em RAM, nada em disco) do texto das mensagens, por id do WhatsApp.
// Serve para dizer ao agente a que mensagem uma reacao se refere. Some quando a ponte reinicia.
import { GUARDAR_IDS } from './limites.mjs';

const TAMANHO_TRECHO = 200;

export function criarMemoriaMensagens({ teto = GUARDAR_IDS } = {}) {
  const trechos = new Map();

  function lembrar(id, texto, numero) {
    if (typeof id !== 'string' || !id || typeof texto !== 'string' || !numero) return;
    const plano = texto.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!plano) return;
    const chars = Array.from(plano);
    const trecho = chars.length > TAMANHO_TRECHO ? chars.slice(0, TAMANHO_TRECHO).join('') + '…' : plano;
    trechos.delete(id);
    trechos.set(id, { trecho, numero });
    if (trechos.size > teto) trechos.delete(trechos.keys().next().value);
  }

  // So devolve o trecho para o numero da conversa de onde ele veio.
  function trecho(id, numero) {
    const achado = typeof id === 'string' ? trechos.get(id) : null;
    return achado && achado.numero === numero ? achado.trecho : null;
  }

  return { lembrar, trecho };
}
