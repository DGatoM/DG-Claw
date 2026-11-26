// Adaptador da Z-API (https://developer.z-api.io/message/send-text): manda UM texto por chamada.
// Quem decide se pode mandar, e quando, e o envio-seguro.mjs; aqui so se fala com a Z-API.
//
// Credenciais (nunca no log, nunca no erro): instancia, token da instancia e Client-Token da conta.
import { idDeGrupoValido, limparNome } from './grupos.mjs';

const BASE = 'https://api.z-api.io';

export function criarAdaptadorZapi({ instancia, token, clientToken, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  for (const [nome, v] of [['ZAPI_INSTANCE', instancia], ['ZAPI_TOKEN', token], ['ZAPI_CLIENT_TOKEN', clientToken]]) {
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`falta ${nome}; guarde as tres chaves da Z-API no cofre do agente (ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN)`);
    }
  }
  // O token vai no caminho da URL, entao nada que volte daqui pode conter a URL nem o token.
  const limpar = (s) => String(s)
    .split(token).join('***').split(clientToken).join('***').split(instancia).join('***')
    .replace(/\s+/g, ' ').slice(0, 300);

  const raiz = `${BASE}/instances/${encodeURIComponent(instancia)}/token/${encodeURIComponent(token)}`;

  /** Chama a Z-API e devolve o corpo JSON; erro sai em portugues e sem credencial. */
  async function chamar(caminho, init, oQue) {
    let resp;
    try {
      resp = await fetchImpl(`${raiz}/${caminho}`, {
        ...init,
        headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`nao consegui falar com a Z-API (${limpar(e && e.message ? e.message : e)})`);
    }
    let corpo = null;
    try { corpo = await resp.json(); } catch { /* corpo nao e JSON */ }
    if (!resp.ok) {
      const motivo = corpo && !Array.isArray(corpo) && (corpo.error || corpo.message) ? limpar(corpo.error || corpo.message) : 'sem detalhe';
      throw new Error(`a Z-API recusou ${oQue} (HTTP ${resp.status}: ${motivo})`);
    }
    return corpo;
  }

  /**
   * `destino`: um numero (texto; so os digitos vao) ou { tipo: 'numero' | 'grupo', valor }.
   * O ID de grupo vai intacto no campo phone (a Z-API aceita o ID do grupo ali).
   */
  async function enviarTexto(destino, texto) {
    const d = destino && typeof destino === 'object' ? destino : { tipo: 'numero', valor: destino };
    const phone = d.tipo === 'grupo' ? String(d.valor) : String(d.valor).replace(/\D/g, '');
    const corpo = await chamar('send-text', { method: 'POST', body: JSON.stringify({ phone, message: texto }) }, 'o envio');
    // Resposta de sucesso traz zaapId/messageId. Sem nenhum dos dois, nao se sabe se saiu.
    const id = corpo && (corpo.messageId || corpo.zaapId || corpo.id);
    if (!id) throw new Error('a Z-API respondeu sem id de mensagem; nao da para confirmar que saiu');
    return { id: String(id) };
  }

  /**
   * Lista os grupos da instancia (GET groups, paginado). Avanca pelo tamanho da pagina recebida, com ou sem filtro.
   * Para ao receber pagina curta, pagina so de repetidos ou no teto de paginas.
   * `omitidos` conta os grupos que nao tem o ID no formato novo (sufixo -group) e por isso ficam de fora.
   */
  async function listarGrupos({ tamanhoPagina = 50, maxPaginas = 20 } = {}) {
    const vistos = new Map();
    const crus = new Set();
    let omitidos = 0;
    let truncado = false;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const corpo = await chamar(`groups?page=${pagina}&pageSize=${tamanhoPagina}`, { method: 'GET' }, 'a lista de grupos');
      if (!Array.isArray(corpo)) throw new Error('a Z-API respondeu a lista de grupos num formato inesperado (esperava uma lista)');
      let novos = 0;
      for (const g of corpo) {
        const id = g && typeof g.phone === 'string' ? g.phone : null;
        if (id === null || crus.has(id)) continue;
        crus.add(id);
        novos += 1;
        if (!idDeGrupoValido(id)) { omitidos += 1; continue; }
        vistos.set(id, limparNome(g.name));
      }
      if (corpo.length < tamanhoPagina) break;
      if (novos === 0 || pagina === maxPaginas) { truncado = true; break; }
    }
    return { grupos: [...vistos].map(([id, nome]) => ({ id, nome })), truncado, omitidos };
  }

  return { enviarTexto, listarGrupos };
}
