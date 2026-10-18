'use strict';
// Apoio dos testes do SSO: um provedor OIDC falso (servidor HTTP local, chaves geradas na hora) e um `fetch` que
// redireciona qualquer https://<host>/... para ele. Nada aqui sai da máquina e nenhuma chave fica escrita no código.
const crypto = require('node:crypto');
const http = require('node:http');

const b64 = (v) => Buffer.from(v).toString('base64url');

function par(tipo) {
  if (tipo === 'ES256') return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function assinar(chaves, kid, alg, claims) {
  const cab = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const corpo = b64(JSON.stringify(claims));
  const dados = Buffer.from(`${cab}.${corpo}`);
  const assinatura = alg === 'ES256'
    ? crypto.sign('sha256', dados, { key: chaves.privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', dados, chaves.privateKey);
  return `${cab}.${corpo}.${assinatura.toString('base64url')}`;
}

/**
 * opcoes: { emissor (https://...), clientId, segredo, alg ('RS256' | 'ES256'), agora: () => ms }
 * Devolve { fetch, fechar, emitir(opcoesDoToken) => code, trocas, trocarChaves }.
 */
async function criarIdp(opcoes) {
  const o = opcoes;
  const alg = o.alg || 'RS256';
  const kid = 'chave-1';
  const chaves = par(alg);
  const outraChave = par(alg);
  const codigos = new Map();
  const trocas = [];
  let jwksDeAgora = () => [{ ...chaves.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg }];
  const host = new URL(o.emissor).host;
  const prefixo = `/${host}`;
  const caminhoEmissor = new URL(o.emissor).pathname.replace(/\/+$/, '');
  // os campos da descoberta, na forma do protocolo OIDC (campo -> caminho no provedor falso)
  const ENDPOINTS = [['authorization_endpoint', '/authorize'], ['token_endpoint', '/token'], ['jwks_uri', '/jwks']];

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rota = url.pathname.startsWith(prefixo) ? url.pathname.slice(prefixo.length) : null;
    const json = (status, corpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpo)); };
    if (rota === `${caminhoEmissor}/.well-known/openid-configuration`) {
      const doc = Object.fromEntries(ENDPOINTS.map(([campo, caminho]) => [campo, `https://${host}${caminho}`]));
      doc.issuer = o.emissorAnunciado || o.emissor;
      doc.id_token_signing_alg_values_supported = [alg];
      return json(200, doc);
    }
    if (rota === '/jwks') return json(200, { keys: jwksDeAgora() });
    if (rota === '/token' && req.method === 'POST') {
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(Buffer.concat(partes).toString('utf8')));
        trocas.push(f);
        const reg = codigos.get(f.code);
        if (!reg) return json(400, { error: 'invalid_grant', error_description: 'código desconhecido ou já usado' });
        codigos.delete(f.code);
        if (f.client_id !== o.clientId || f.client_secret !== o.segredo) return json(401, { error: 'invalid_client' });
        if (f.redirect_uri !== reg.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri diferente' });
        const desafio = crypto.createHash('sha256').update(String(f.code_verifier)).digest('base64url');
        if (desafio !== reg.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE não confere' });
        return json(200, { token_type: 'Bearer', id_token: reg.idToken });
      });
      return undefined;
    }
    return json(404, { error: 'nao_existe', caminho: url.pathname });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  /** fetch do Web: https://<host>/x vira http://127.0.0.1:<porta>/<host>/x. Outros hosts falham como se estivessem fora do ar. */
  const fetchFalso = async (url, init) => {
    const u = new URL(url);
    if (u.host !== host) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return fetch(`http://127.0.0.1:${porta}/${u.host}${u.pathname}${u.search}`, init);
  };

  /**
   * Simula o provedor depois do login da pessoa: guarda um code e o id_token que ele vai devolver.
   * t: { nonce, challenge, redirectUri, claims (sobrepõe os padrões; undefined apaga), assinadoPorOutra }
   */
  function emitir(t) {
    const agoraS = Math.floor(o.agora() / 1000);
    const claims = Object.assign({
      iss: o.emissor, aud: o.clientId, sub: 'u-1', iat: agoraS, exp: agoraS + 3600, nonce: t.nonce,
      email: 'ana@empresa.com.br', email_verified: true, name: 'Ana Silva',
    }, t.claims || {});
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const idToken = assinar(t.assinadoPorOutra ? outraChave : chaves, kid, alg, claims);
    const code = crypto.randomBytes(12).toString('hex');
    codigos.set(code, { challenge: t.challenge, redirectUri: t.redirectUri, idToken });
    return code;
  }

  return {
    fetch: fetchFalso, emitir, trocas, porta,
    trocarChaves(lista) { jwksDeAgora = lista; },
    chavePublica: () => ({ ...chaves.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg }),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

/** Lê o que o Web mandou ao provedor (a URL do /authorize) e devolve o necessário para o provedor falso responder. */
function pedidoDeAutorizacao(location) {
  const u = new URL(location);
  return {
    state: u.searchParams.get('state'), nonce: u.searchParams.get('nonce'),
    challenge: u.searchParams.get('code_challenge'), metodo: u.searchParams.get('code_challenge_method'),
    redirectUri: u.searchParams.get('redirect_uri'), clientId: u.searchParams.get('client_id'),
    escopo: u.searchParams.get('scope'), tipo: u.searchParams.get('response_type'), url: u,
  };
}

module.exports = { criarIdp, pedidoDeAutorizacao };
