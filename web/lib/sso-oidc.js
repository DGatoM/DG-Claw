'use strict';
// Cliente OIDC mínimo (authorization code + PKCE S256), só com fetch e node:crypto. Sem biblioteca de terceiros.
//
// O que confere no id_token: assinatura (RS256 ou ES256, pela chave do JWKS com o mesmo `kid`), `iss`, `aud` (e `azp`
// quando há mais de uma audiência), `exp`, `iat` (com folga de 2 min para relógio adiantado), `nonce`, e no Entra o `tid`.
// Recusa `alg: none`, HS256 e qualquer outro algoritmo: o servidor decide o algoritmo, nunca o token.
// O e-mail, o `hd` do Google e o domínio permitido são conferidos aqui também, para quem chama só receber uma identidade pronta.

const crypto = require('node:crypto');
const { emissorEfetivo } = require('./sso-config');

const FOLGA_RELOGIO_S = 120;
const CACHE_DISCOVERY_MS = 60 * 60 * 1000;
const CACHE_JWKS_MS = 60 * 60 * 1000;
const RECARGA_JWKS_MIN_MS = 60 * 1000;
const TEMPO_MAX_REDE_MS = 10 * 1000;
const ALGORITMOS = new Set(['RS256', 'ES256']);

class ErroOidc extends Error {
  /** codigo: estado | provedor | token | dominio | email. A mensagem é para o log/TI; a tela mostra só o código. */
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroOidc';
    this.codigo = codigo;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest();

/** Verificador e desafio do PKCE (S256). */
function novoPkce() {
  const verificador = b64url(crypto.randomBytes(48));
  return { verificador, desafio: b64url(sha256(verificador)) };
}
const aleatorio = (n) => b64url(crypto.randomBytes(n || 24));

function jsonDoSegmento(seg, o) {
  try { return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')); } catch (_) {
    throw new ErroOidc('token', `O id_token está malformado (${o} não é JSON).`);
  }
}

function criarOidc(opcoes) {
  const o = opcoes || {};
  const buscar = o.fetch || fetch;
  const agora = o.agora || Date.now;
  const log = o.log || (() => {});
  const aceitaLoopback = !!o.aceitaLoopback;
  const discovery = new Map();   // emissor -> { doc, ate }
  const jwks = new Map();        // jwks_uri -> { chaves: Map(kid -> KeyObject), sem_kid: KeyObject[], ate, carregadoEm }

  function exigeUrl(u, que, emissor) {
    let x;
    try { x = new URL(u); } catch (_) { throw new ErroOidc('provedor', `O provedor ${emissor} devolveu ${que} inválido (${String(u).slice(0, 80)}).`); }
    const ok = x.protocol === 'https:' || (aceitaLoopback && x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname));
    if (!ok) throw new ErroOidc('provedor', `O provedor ${emissor} devolveu ${que} que não é https:// (${x.protocol}//${x.host}). Por segurança só uso endereços https.`);
    return x.href;
  }

  async function pegarJson(url, que, init) {
    let r;
    try {
      r = await buscar(url, Object.assign({ signal: AbortSignal.timeout(TEMPO_MAX_REDE_MS), redirect: 'error' }, init || {}));
    } catch (e) {
      throw new ErroOidc('provedor', `Não consegui falar com o provedor em ${que} (${url}): ${e.cause && e.cause.code ? e.cause.code : e.message}. Confira se o servidor alcança esse endereço (firewall, DNS, proxy).`);
    }
    const texto = await r.text();
    let j = null;
    try { j = JSON.parse(texto); } catch (_) { /* tratado abaixo */ }
    if (!r.ok) {
      const motivo = j && (j.error_description || j.error) ? `${j.error || ''} ${j.error_description || ''}`.trim() : texto.slice(0, 120);
      throw new ErroOidc('provedor', `O provedor respondeu ${r.status} em ${que} (${url}): ${motivo}`);
    }
    if (!j || typeof j !== 'object') throw new ErroOidc('provedor', `O provedor respondeu algo que não é JSON em ${que} (${url}).`);
    return j;
  }

  /** O documento de descoberta, com cache de 1 h. Confere que o `issuer` anunciado é o esperado. */
  async function descobrir(cfg) {
    const emissor = emissorEfetivo(cfg);
    const c = discovery.get(emissor);
    if (c && c.ate > agora()) return c.doc;
    const url = `${emissor}/.well-known/openid-configuration`;
    const doc = await pegarJson(url, 'a descoberta (discovery)');
    if (String(doc.issuer || '').replace(/\/+$/, '') !== emissor) {
      throw new ErroOidc('provedor', `O provedor em ${url} anuncia o emissor ${JSON.stringify(String(doc.issuer).slice(0, 120))}, e o configurado é ${emissor}. Corrija o emissor (ou o tenant) no sso.json.`);
    }
    for (const campo of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (!doc[campo]) throw new ErroOidc('provedor', `A descoberta de ${emissor} não traz ${campo}.`);
      doc[campo] = exigeUrl(doc[campo], campo, emissor);
    }
    if (Array.isArray(doc.id_token_signing_alg_values_supported) && !doc.id_token_signing_alg_values_supported.some((a) => ALGORITMOS.has(a))) {
      throw new ErroOidc('provedor', `O provedor ${emissor} só assina o id_token com ${doc.id_token_signing_alg_values_supported.join(', ')}, e eu aceito RS256 ou ES256. Peça ao TI do provedor para habilitar RS256.`);
    }
    discovery.set(emissor, { doc, ate: agora() + CACHE_DISCOVERY_MS });
    return doc;
  }

  async function carregarJwks(uri) {
    const j = await pegarJson(uri, 'as chaves de assinatura (JWKS)');
    if (!Array.isArray(j.keys)) throw new ErroOidc('provedor', `O JWKS em ${uri} não tem a lista "keys".`);
    const chaves = new Map();
    const semKid = [];
    for (const k of j.keys) {
      if (!k || (k.use && k.use !== 'sig') || !['RSA', 'EC'].includes(k.kty)) continue;
      let obj;
      try { obj = crypto.createPublicKey({ key: k, format: 'jwk' }); } catch (e) {
        log('aviso', `Ignorei uma chave do JWKS ${uri} que não consegui ler (${e.message}).`);
        continue;
      }
      if (k.kid) chaves.set(k.kid, obj); else semKid.push(obj);
    }
    const reg = { chaves, sem_kid: semKid, ate: agora() + CACHE_JWKS_MS, carregadoEm: agora() };
    jwks.set(uri, reg);
    return reg;
  }

  async function acharChave(uri, kid) {
    let reg = jwks.get(uri);
    if (!reg || reg.ate <= agora()) reg = await carregarJwks(uri);
    const pegar = (r) => (kid ? r.chaves.get(kid) : (r.sem_kid[0] || (r.chaves.size === 1 ? [...r.chaves.values()][0] : null)));
    let k = pegar(reg);
    // chave nova no provedor (rotação): recarrega uma vez, mas não mais que uma por minuto (não deixa o token forjado martelar o provedor)
    if (!k && agora() - reg.carregadoEm > RECARGA_JWKS_MIN_MS) { reg = await carregarJwks(uri); k = pegar(reg); }
    return k || null;
  }

  function urlDeAutorizacao(cfg, doc, p) {
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', cfg.client_id);
    u.searchParams.set('redirect_uri', p.redirect_uri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.desafio);
    u.searchParams.set('code_challenge_method', 'S256');
    if (cfg.provedor === 'google' && cfg.dominios_permitidos.length === 1) u.searchParams.set('hd', cfg.dominios_permitidos[0]);   // só uma dica de tela; a conferência de verdade é no token
    if (cfg.provedor === 'microsoft') u.searchParams.set('response_mode', 'query');
    return u.href;
  }

  /** Troca o `code` pelo id_token. O segredo vai no corpo POST (client_secret_post), nunca na URL. */
  async function trocarCodigo(cfg, doc, p) {
    const corpo = new URLSearchParams({
      grant_type: 'authorization_code', code: p.codigo, redirect_uri: p.redirect_uri,
      client_id: cfg.client_id, client_secret: cfg.client_secret, code_verifier: p.verificador,
    });
    const j = await pegarJson(doc.token_endpoint, 'a troca do código', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: corpo.toString(),
    });
    if (typeof j.id_token !== 'string' || !j.id_token) throw new ErroOidc('provedor', `O provedor respondeu sem id_token em ${doc.token_endpoint}. Confira se o aplicativo pede o escopo "openid".`);
    return j.id_token;
  }

  /**
   * Valida o id_token e devolve a identidade { email, nome, sub, hd, tid, claims }. Lança ErroOidc.
   * p: { nonce }.
   */
  async function validarIdToken(cfg, doc, token, p) {
    const partes = String(token).split('.');
    if (partes.length !== 3 || partes.some((x) => !x)) throw new ErroOidc('token', 'O id_token não tem as três partes (cabeçalho, conteúdo e assinatura).');
    const cab = jsonDoSegmento(partes[0], 'o cabeçalho');
    if (!ALGORITMOS.has(cab.alg)) throw new ErroOidc('token', `O id_token usa o algoritmo ${JSON.stringify(String(cab.alg).slice(0, 20))}, e só aceito RS256 e ES256.`);
    const chave = await acharChave(doc.jwks_uri, cab.kid);
    if (!chave) throw new ErroOidc('token', `Não achei no JWKS do provedor a chave ${JSON.stringify(String(cab.kid || '(sem kid)').slice(0, 60))} que assinou o token.`);
    if ((cab.alg === 'RS256') !== (chave.asymmetricKeyType === 'rsa')) throw new ErroOidc('token', `O algoritmo ${cab.alg} do token não combina com o tipo da chave do provedor (${chave.asymmetricKeyType}).`);
    const dados = Buffer.from(`${partes[0]}.${partes[1]}`);
    const assinatura = Buffer.from(partes[2], 'base64url');
    let valida = false;
    try {
      valida = cab.alg === 'RS256'
        ? crypto.verify('sha256', dados, chave, assinatura)
        : crypto.verify('sha256', dados, { key: chave, dsaEncoding: 'ieee-p1363' }, assinatura);
    } catch (e) {
      throw new ErroOidc('token', `Não consegui conferir a assinatura do id_token (${e.message}).`);
    }
    if (!valida) throw new ErroOidc('token', 'A assinatura do id_token não confere com a chave do provedor.');

    const c = jsonDoSegmento(partes[1], 'o conteúdo');
    const esperado = emissorEfetivo(cfg);
    if (String(c.iss || '').replace(/\/+$/, '') !== esperado) throw new ErroOidc('token', `O emissor do token (${JSON.stringify(String(c.iss).slice(0, 120))}) não é o configurado (${esperado}).`);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(cfg.client_id)) throw new ErroOidc('token', 'O token foi emitido para outro aplicativo (aud não é o client_id configurado).');
    if (aud.length > 1 && c.azp !== cfg.client_id) throw new ErroOidc('token', 'O token tem mais de uma audiência e o azp não é o client_id configurado.');
    const agoraS = Math.floor(agora() / 1000);
    if (!Number.isFinite(c.exp) || c.exp <= agoraS) throw new ErroOidc('token', `O token já venceu (exp ${c.exp}, agora ${agoraS}).`);
    if (!Number.isFinite(c.iat) || c.iat > agoraS + FOLGA_RELOGIO_S) throw new ErroOidc('token', `O token diz ter sido emitido no futuro (iat ${c.iat}, agora ${agoraS}). Confira o relógio do servidor.`);
    if (typeof c.nonce !== 'string' || !seguroIgual(c.nonce, p.nonce)) throw new ErroOidc('token', 'O nonce do token não é o desta tentativa de login.');
    if (cfg.provedor === 'microsoft' && String(c.tid || '').toLowerCase() !== cfg.tenant) throw new ErroOidc('token', `O token é de outro diretório da Microsoft (tid ${JSON.stringify(String(c.tid).slice(0, 40))}, o configurado é ${cfg.tenant}).`);

    let email = typeof c.email === 'string' ? c.email : '';
    if (!email && cfg.provedor === 'microsoft') email = typeof c.preferred_username === 'string' && c.preferred_username.includes('@') ? c.preferred_username : '';
    email = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroOidc('email', 'O token não traz um e-mail. Peça ao TI do provedor para incluir a permissão "email" (escopo email) no aplicativo.');
    if (cfg.provedor === 'google' && c.email_verified !== true) throw new ErroOidc('email', 'O Google não marcou o e-mail como verificado (email_verified).');
    if (c.email_verified === false) throw new ErroOidc('email', 'O provedor marcou o e-mail como não verificado (email_verified = false).');
    const dominio = email.slice(email.lastIndexOf('@') + 1);
    if (cfg.dominios_permitidos.length && !cfg.dominios_permitidos.includes(dominio)) throw new ErroOidc('dominio', `O e-mail ${email} é de um domínio fora da lista permitida (${cfg.dominios_permitidos.join(', ')}).`);
    if (cfg.provedor === 'google') {
      const hd = String(c.hd || '').toLowerCase();
      if (!hd || !cfg.dominios_permitidos.includes(hd)) throw new ErroOidc('dominio', `A conta Google não pertence a um domínio permitido (hd ${JSON.stringify(hd || '(nenhum)')}); contas pessoais do Gmail não entram.`);
    }
    return { email, nome: typeof c.name === 'string' ? c.name : '', sub: String(c.sub || ''), hd: c.hd || null, tid: c.tid || null };
  }

  return { descobrir, urlDeAutorizacao, trocarCodigo, validarIdToken, limparCache() { discovery.clear(); jwks.clear(); } };
}

function seguroIgual(a, b) {
  const x = sha256(String(a));
  const y = sha256(String(b));
  return crypto.timingSafeEqual(x, y);
}

module.exports = { criarOidc, ErroOidc, novoPkce, aleatorio, seguroIgual, FOLGA_RELOGIO_S };
