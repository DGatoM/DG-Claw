// Memoria curta (so em RAM, nada em disco) do texto das mensagens, por conversa, direcao e id do WhatsApp.
// Serve para dizer ao agente a que mensagem uma reacao se refere. Some quando a ponte reinicia.
import { GUARDAR_IDS } from './limites.mjs';
import { mesmoNumero } from './numeros.mjs';

const TAMANHO_TRECHO = 200;
// Normalizar so um prefixo: a regex de quebras de linha e quadratica em texto cheio de espacos.
const PREFIXO_MAX = 1000;

/** direcao: 'enviada' (pelo agente) ou 'recebida' (do contato). */
export function criarMemoriaMensagens({ teto = GUARDAR_IDS } = {}) {
  const trechos = new Map();
  const chave = (direcao, id) => `${direcao}:${id}`;

  function lembrar(id, texto, numero, direcao) {
    if (typeof id !== 'string' || !id || typeof texto !== 'string' || !numero) return;
    if (direcao !== 'enviada' && direcao !== 'recebida') return;
    const inicio = texto.trimStart();
    const plano = inicio.slice(0, PREFIXO_MAX).replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!plano) return;
    const chars = Array.from(plano);
    const cortou = chars.length > TAMANHO_TRECHO || inicio.length > PREFIXO_MAX;
    const trecho = (chars.length > TAMANHO_TRECHO ? chars.slice(0, TAMANHO_TRECHO).join('') : plano) + (cortou ? '…' : '');
    const k = chave(direcao, id);
    trechos.delete(k);
    trechos.set(k, { trecho, numero });
    if (trechos.size > teto) trechos.delete(trechos.keys().next().value);
  }

  // So devolve o trecho para o numero da conversa e a direcao de onde ele veio.
  function trecho(id, numero, direcao) {
    const achado = typeof id === 'string' ? trechos.get(chave(direcao, id)) : null;
    return achado && mesmoNumero(achado.numero, numero) ? achado.trecho : null;
  }

  // Mensagem editada ou apagada: nunca citar a versao original. So esquece, nao regrava.
  function esquecer(id) {
    if (typeof id !== 'string' || !id) return;
    trechos.delete(chave('enviada', id));
    trechos.delete(chave('recebida', id));
  }

  return { lembrar, trecho, esquecer };
}
