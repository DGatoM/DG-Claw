// Numeros de telefone: normalizacao E.164, comparacao e leitura de JID.

// ---------------------------------------------------------------------------
// Numeros
// ---------------------------------------------------------------------------

/**
 * Entrada humana para E.164 com "+". Aceita espaco, traco, parenteses e ponto. Sem "+" e
 * com 10 ou 11 digitos, e Brasil (prefixo 55). Fora de 10 a 15 digitos: null.
 * @param {unknown} entrada
 * @returns {string|null}
 */
export function normalizar(entrada) {
  if (typeof entrada !== 'string' && typeof entrada !== 'number') return null;
  const bruto = String(entrada).trim();
  if (!/^\+?[\d\s().-]+$/.test(bruto)) return null;
  let d = bruto.replace(/\D/g, '');
  if (!bruto.startsWith('+') && (d.length === 10 || d.length === 11)) d = '55' + d;
  if (d.length < 10 || d.length > 15) return null;
  return '+' + d;
}

/**
 * Por que a entrada nao serve, em portugues, para a mensagem de erro ao dono.
 * @param {unknown} entrada
 */
export function motivoNumeroInvalido(entrada) {
  return `o numero "${String(entrada).slice(0, 40)}" nao e valido: use o formato +5511987654321 ` +
    '(DDD e numero; de 10 a 15 digitos no total)';
}

/**
 * Dois numeros sao o mesmo? Alem da igualdade, vale a equivalencia do nono digito do Brasil:
 * 55 + DDD + 9 + 8 digitos e 55 + DDD + os mesmos 8 digitos (contas antigas no WhatsApp).
 */
export function mesmoNumero(a, b) {
  const x = normalizar(a);
  const y = normalizar(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const longo = x.length >= y.length ? x : y;
  const curto = x.length >= y.length ? y : x;
  // "+55" + DDD(2) + 9 + 8 = 14 caracteres; sem o 9 sao 13.
  if (!/^\+55\d{11}$/.test(longo) || !/^\+55\d{10}$/.test(curto)) return false;
  return longo.slice(3, 5) === curto.slice(3, 5) && longo[5] === '9' && longo.slice(6) === curto.slice(5);
}

/** "5511987654321:12@s.whatsapp.net" -> "+5511987654321"; outra coisa -> null. */
export function numeroDeJid(jid) {
  if (typeof jid !== 'string') return null;
  const m = /^(\d{8,20})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(jid);
  return m ? '+' + m[1] : null;
}
