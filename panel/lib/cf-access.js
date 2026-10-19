// Entrada sem senha para quem o Cloudflare Access já conferiu. O porquê, as variáveis de
// ambiente e o que cada recusa significa estão no comentário logo abaixo.
const nodeCrypto = require('crypto');

module.exports = function buildCfAccess({ auth }) {
  // ─── Cloudflare Access (entrada sem senha para quem o Access já conferiu) ─────
  //
  // POR QUE EXISTE. Quando o painel fica atrás de um túnel Cloudflare com Access, o
  // dono já provou quem é no Access (login por e-mail) antes de a requisição chegar
  // aqui. Pedir a senha do painel de novo é atrito à toa. Então: se o Cloudflare
  // mandou um JWT do Access válido, para o app certo e para um e-mail da lista, a
  // requisição segue como se tivesse o cookie dash_token.
  //
  // DESLIGADO POR PADRÃO. Sem DGCLAW_PANEL_CF_ACCESS_AUD nada aqui roda e o painel se
  // comporta exatamente como antes. Qualquer coisa errada (JWT ausente, inválido,
  // vencido, e-mail fora da lista, JWKS fora do ar) cai no fluxo antigo: pede a senha.
  //
  // Envs:
  //   DGCLAW_PANEL_CF_ACCESS_AUD  aud do app do Access (Zero Trust > Access > app > Overview)
  //   DGCLAW_PANEL_CF_TEAM        domínio do time, ex.: meutime.cloudflareaccess.com
  //   DGCLAW_PANEL_CF_EMAILS      e-mails aceitos, separados por vírgula
  //   DGCLAW_PANEL_CF_CERTS_URL   SÓ PARA TESTE: troca a URL do JWKS por um servidor local.
  //                               Em produção fica vazia (usa https://<team>/cdn-cgi/access/certs).
  //
  // O JWT vem no header Cf-Access-Jwt-Assertion (ou, na falta, no cookie
  // CF_Authorization). Conferimos: RS256, assinatura contra as chaves públicas do time,
  // iss, aud, exp (60s de tolerância) e e-mail. Nunca logamos o JWT.
  const CF_AUD = (process.env.DGCLAW_PANEL_CF_ACCESS_AUD || '').trim();
  const CF_TEAM = (process.env.DGCLAW_PANEL_CF_TEAM || '').trim()
    .replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const CF_EMAILS = (process.env.DGCLAW_PANEL_CF_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const CF_CERTS_URL = (process.env.DGCLAW_PANEL_CF_CERTS_URL || '').trim() ||
    (CF_TEAM ? `https://${CF_TEAM}/cdn-cgi/access/certs` : '');
  const CF_ISS = CF_TEAM ? `https://${CF_TEAM}` : '';
  let CF_ENABLED = false;
  if (CF_AUD) {
    if (!CF_TEAM || CF_EMAILS.length === 0) {
      console.error('[painel] Cloudflare Access DESLIGADO: DGCLAW_PANEL_CF_ACCESS_AUD está definida, ' +
        `mas falta ${!CF_TEAM ? 'DGCLAW_PANEL_CF_TEAM' : 'DGCLAW_PANEL_CF_EMAILS'}. ` +
        'O painel segue pedindo a senha. Para ligar, defina as três envs no drop-in do serviço.');
    } else {
      CF_ENABLED = true;
      console.log(`[painel] Cloudflare Access ligado: time ${CF_TEAM}, e-mails aceitos ${CF_EMAILS.join(', ')}, ` +
        `chaves em ${CF_CERTS_URL}`);
    }
  }

  const CF_JWKS_TTL_MS = 60 * 60 * 1000;   // cache das chaves: 1h
  const CF_JWKS_RETRY_MS = 60 * 1000;      // kid desconhecido: no máximo 1 recarga por minuto
  let _cfKeys = null;                      // Map kid -> KeyObject
  let _cfKeysAt = 0;
  let _cfKeysFetching = null;
  let _cfLastForced = 0;

  function cfB64url(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  // Log de recusa com freio: o navegador pede css/js/api em rajada e cada pedido traria
  // o mesmo JWT; uma linha por motivo a cada 10 minutos já explica o problema.
  const _cfLogAt = new Map();
  function cfLogOnce(key, msg) {
    const now = Date.now();
    if (now - (_cfLogAt.get(key) || 0) < 10 * 60 * 1000) return;
    _cfLogAt.set(key, now);
    console.error(msg);
  }

  async function cfFetchKeys() {
    if (_cfKeysFetching) return _cfKeysFetching;
    _cfKeysFetching = (async () => {
      try {
        const r = await fetch(CF_CERTS_URL, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const map = new Map();
        for (const jwk of (body && body.keys) || []) {
          if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
          try {
            map.set(jwk.kid, nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' }));
          } catch { /* chave que não abre não entra no mapa */ }
        }
        if (map.size === 0) throw new Error('resposta sem nenhuma chave RSA utilizável');
        _cfKeys = map;
        _cfKeysAt = Date.now();
        return map;
      } catch (err) {
        cfLogOnce('jwks', `[painel] Cloudflare Access: não consegui baixar as chaves públicas de ${CF_CERTS_URL} ` +
          `(${err && err.message ? err.message : err}). Enquanto isso o painel pede a senha. ` +
          'O que fazer: conferir se a VPS alcança esse endereço (curl na URL) e se DGCLAW_PANEL_CF_TEAM está certo.');
        return _cfKeys; // chave velha ainda serve se já tínhamos alguma
      } finally {
        _cfKeysFetching = null;
      }
    })();
    return _cfKeysFetching;
  }

  async function cfGetKey(kid) {
    let keys = _cfKeys;
    if (!keys || Date.now() - _cfKeysAt > CF_JWKS_TTL_MS) keys = await cfFetchKeys();
    if (keys && keys.has(kid)) return keys.get(kid);
    // kid novo (o Cloudflare gira as chaves): recarrega uma vez, com freio.
    if (Date.now() - _cfLastForced > CF_JWKS_RETRY_MS) {
      _cfLastForced = Date.now();
      keys = await cfFetchKeys();
      if (keys && keys.has(kid)) return keys.get(kid);
    }
    return null;
  }

  // Devolve { ok: true, email } ou { ok: false, reason }.
  async function cfVerifyAccessJwt(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) return { ok: false, reason: 'JWT malformado' };
    let header, payload;
    try {
      header = JSON.parse(cfB64url(parts[0]).toString('utf8'));
      payload = JSON.parse(cfB64url(parts[1]).toString('utf8'));
    } catch {
      return { ok: false, reason: 'JWT com cabeçalho ou corpo ilegível' };
    }
    if (!header || header.alg !== 'RS256') return { ok: false, reason: `algoritmo ${header && header.alg} não aceito` };
    const key = await cfGetKey(header.kid);
    if (!key) return { ok: false, reason: `chave ${String(header.kid).slice(0, 12)}… não encontrada no JWKS` };
    const valid = nodeCrypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      key, cfB64url(parts[2]));
    if (!valid) return { ok: false, reason: 'assinatura inválida' };
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== CF_ISS) return { ok: false, reason: `iss ${payload.iss} diferente de ${CF_ISS}` };
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(CF_AUD)) return { ok: false, reason: 'aud não é o deste painel' };
    if (typeof payload.exp !== 'number' || payload.exp + 60 < now) return { ok: false, reason: 'JWT vencido' };
    if (typeof payload.nbf === 'number' && payload.nbf - 60 > now) return { ok: false, reason: 'JWT ainda não vale (nbf)' };
    const email = String(payload.email || '').toLowerCase();
    if (!email || !CF_EMAILS.includes(email)) return { ok: false, reason: `e-mail ${email || '(nenhum)'} fora da lista` };
    return { ok: true, email };
  }

  function cfAccessAuth(req, res, next) {
    if (!CF_ENABLED) return next();
    if (auth.conferirToken(req.cookies && req.cookies.dash_token)) return next();
    const token = req.get('Cf-Access-Jwt-Assertion') || (req.cookies && req.cookies.CF_Authorization) || '';
    if (!token) return next();
    cfVerifyAccessJwt(token).then((r) => {
      if (r.ok) {
        // Sinal explícito para o requireAuth logo abaixo, só nesta requisição. Antes isto
        // fabricava um cookie, o que obrigava o token de sessão a ser um valor fixo e
        // conhecido. Não gravamos cookie no navegador: a confiança fica presa ao Access.
        req.dgclawAuth = 'cf-access';
      } else {
        cfLogOnce(`deny:${r.reason}`, `[painel] Cloudflare Access: JWT recusado em ${req.method} ${req.originalUrl} ` +
          `(${r.reason}). Caiu na senha do painel. Se era para entrar direto, conferir ` +
          'DGCLAW_PANEL_CF_ACCESS_AUD, DGCLAW_PANEL_CF_TEAM e DGCLAW_PANEL_CF_EMAILS no drop-in do serviço.');
      }
      next();
    }).catch((err) => {
      cfLogOnce('crash', `[painel] Cloudflare Access: erro inesperado ao conferir o JWT (${err && err.message}). Caiu na senha.`);
      next();
    });
  }

  return { cfAccessAuth };
};
