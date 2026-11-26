// Adaptador da Z-API (https://developer.z-api.io/message/send-text): manda UM texto por chamada.
// Quem decide se pode mandar, e quando, e o envio-seguro.mjs; aqui so se fala com a Z-API.
//
// Credenciais (nunca no log, nunca no erro): instancia, token da instancia e Client-Token da conta.
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

  async function enviarTexto(numero, texto) {
    const url = `${BASE}/instances/${encodeURIComponent(instancia)}/token/${encodeURIComponent(token)}/send-text`;
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: String(numero).replace(/\D/g, ''), message: texto }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`nao consegui falar com a Z-API (${limpar(e && e.message ? e.message : e)})`);
    }
    let corpo = null;
    try { corpo = await resp.json(); } catch { /* corpo nao e JSON */ }
    if (!resp.ok) {
      const motivo = corpo && (corpo.error || corpo.message) ? limpar(corpo.error || corpo.message) : 'sem detalhe';
      throw new Error(`a Z-API recusou o envio (HTTP ${resp.status}: ${motivo})`);
    }
    // Resposta de sucesso traz zaapId/messageId. Sem nenhum dos dois, nao se sabe se saiu.
    const id = corpo && (corpo.messageId || corpo.zaapId || corpo.id);
    if (!id) throw new Error('a Z-API respondeu sem id de mensagem; nao da para confirmar que saiu');
    return { id: String(id) };
  }

  return { enviarTexto };
}
