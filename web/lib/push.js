'use strict';
const dgIdiomaBackend = require("./idioma-contexto");
// Avisos no aparelho: Web Push com VAPID (RFC 8292) e conteúdo aes128gcm (RFC 8291), só com
// node:crypto e node:https. Contrato e rotas em web/docs/AVISOS-NO-APARELHO.md.
//
// Nada de segredo vai para o log: nem a chave privada, nem o JWT, nem as chaves do aparelho,
// nem o endereço inteiro do endpoint (funciona como senha). No log vai o host e o id.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const H = require('./http');

const HOSTS_FIXOS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const SUFIXOS = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];
const TTL_S = 3600;
const TIMEOUT_MS = 15000;
const CACHE_JWT_MS = 12 * 3600 * 1000;
const VALIDADE_JWT_S = 18 * 3600;   // maior que o cache: um JWT em cache nunca chega vencido ao serviço
const MAX_PAYLOAD = 3993;           // os serviços aceitam 4096 bytes no corpo: menos o cabeçalho (86), o delimitador (1) e a tag (16)
const RX_B64URL = /^[A-Za-z0-9_-]+$/;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(s, 'base64url');

function hostPermitido(hostname) {
  const h = String(hostname || '').toLowerCase();
  return HOSTS_FIXOS.has(h) || SUFIXOS.some((s) => h.endsWith(s) && h.length > s.length);
}

/** Confere o endpoint de uma inscrição. Devolve { url } ou { erro } (em português). */
function validaEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2000) {
    return { erro: dgIdiomaBackend.mensagem("O \"endpoint\" da inscrição precisa ser um texto com o endereço https do serviço de push (até 2000 caracteres).") };
  }
  let u;
  try { u = new URL(endpoint); } catch (e) {
    return { erro: dgIdiomaBackend.mensagem("O \"endpoint\" não é um endereço válido ({p0}). Ative os avisos de novo no aparelho.", {p0: (e.message)}) };
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    return { erro: dgIdiomaBackend.mensagem("O \"endpoint\" precisa ser https, sem usuário nem porta diferente de 443.") };
  }
  if (!hostPermitido(u.hostname)) {
    return { erro: dgIdiomaBackend.mensagem("O serviço de push {p0} não é um dos aceitos (fcm.googleapis.com, updates.push.services.mozilla.com, *.push.apple.com, *.notify.windows.com, *.push.services.mozilla.com).", {p0: (u.hostname.slice(0, 80))}) };
  }
  return { url: u };
}

/**
 * Cifra `payload` (Buffer) para o aparelho, no formato aes128gcm (RFC 8291). Devolve o corpo
 * do pedido: cabeçalho (sal, tamanho do registro, chave pública nossa) + registro cifrado.
 * `opcoes.efemera` e `opcoes.sal` só existem para o teste reproduzir um exemplo fixo.
 */
function cifrar(payload, p256dh, auth, opcoes) {
  const o = opcoes || {};
  const uaPublica = deB64u(p256dh);
  const segredoAuth = deB64u(auth);
  if (uaPublica.length !== 65 || uaPublica[0] !== 4) throw new TypeError('A chave p256dh da inscrição precisa ter 65 bytes (ponto P-256 não comprimido).');
  if (segredoAuth.length !== 16) throw new TypeError('O segredo auth da inscrição precisa ter 16 bytes.');
  if (payload.length > MAX_PAYLOAD) throw new TypeError(`O aviso tem ${payload.length} bytes depois de montado e o teto é ${MAX_PAYLOAD}. Encurte o título, o corpo ou as ações.`);

  const ecdh = crypto.createECDH('prime256v1');
  if (o.efemera) ecdh.setPrivateKey(o.efemera); else ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const segredoEcdh = ecdh.computeSecret(uaPublica);

  const infoChave = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', segredoEcdh, segredoAuth, infoChave, 32));
  const sal = o.sal || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, sal, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const registro = Buffer.concat([cifra.update(Buffer.concat([payload, Buffer.from([2])])), cifra.final(), cifra.getAuthTag()]);
  const cab = Buffer.alloc(21);
  sal.copy(cab, 0);
  cab.writeUInt32BE(4096, 16);
  cab[20] = asPublica.length;
  return Buffer.concat([cab, asPublica, registro]);
}

function caminhoRelativo(valor, nome) {
  if (typeof valor !== 'string' || !valor.startsWith('/') || valor.startsWith('//') || valor.startsWith('/\\') || /[\x00-\x1f]/.test(valor) || valor.length > 500) {
    throw new TypeError(`O campo "${nome}" do aviso precisa ser um caminho do próprio Web começando por "/" (ex.: "/a/luna"); recebi ${JSON.stringify(String(valor).slice(0, 80))}. Corrija a frente que monta o aviso.`);
  }
  return valor;
}

/** Valida o aviso e monta o JSON que o service worker lê. TypeError = erro de programação da frente. */
function montaPayload(aviso) {
  if (!aviso || typeof aviso !== 'object') throw new TypeError('push.enviar precisa de um objeto de aviso com pelo menos "titulo".');
  if (typeof aviso.titulo !== 'string' || !aviso.titulo.trim()) throw new TypeError('O aviso precisa de "titulo" (texto não vazio).');
  if (aviso.corpo != null && typeof aviso.corpo !== 'string') throw new TypeError('O "corpo" do aviso precisa ser texto.');
  if (aviso.tag != null && (typeof aviso.tag !== 'string' || aviso.tag.length > 100)) throw new TypeError('A "tag" do aviso precisa ser um texto de até 100 caracteres.');
  let acoes = [];
  if (aviso.acoes != null) {
    if (!Array.isArray(aviso.acoes) || aviso.acoes.length > 2) throw new TypeError('"acoes" precisa ser uma lista de no máximo 2 botões.');
    acoes = aviso.acoes.map((a, i) => {
      if (!a || typeof a.acao !== 'string' || !a.acao || typeof a.titulo !== 'string' || !a.titulo) throw new TypeError(`A ação ${i} do aviso precisa de "acao" e "titulo" (texto).`);
      return { acao: a.acao, titulo: a.titulo, post: a.post == null ? null : caminhoRelativo(a.post, `acoes[${i}].post`) };
    });
  }
  return {
    titulo: aviso.titulo,
    corpo: aviso.corpo || '',
    tag: aviso.tag || null,
    url: aviso.url == null ? '/' : caminhoRelativo(aviso.url, 'url'),
    imagem: aviso.imagem == null ? null : caminhoRelativo(aviso.imagem, 'imagem'),
    acoes,
    exigir_interacao: !!aviso.exigir_interacao,
  };
}

/** Envio padrão: HTTPS direto, sem seguir redirecionamento. Rejeita só por falha de rede. */
function enviarHttps({ url, headers, corpo, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      const partes = []; let total = 0;
      res.on('data', (c) => { if (total < 2048) { partes.push(c); total += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(dgIdiomaBackend.mensagem("sem resposta em {p0} s", {p0: (Math.round(timeoutMs / 1000))}))));
    req.on('error', reject);
    req.end(corpo);
  });
}

function criarPush({ dataDir, log, agora, enviarHttp }) {
  const relogio = agora || (() => Date.now());
  const enviarPedido = enviarHttp || enviarHttps;
  const pasta = path.join(dataDir, 'push');
  const arqVapid = path.join(pasta, 'vapid.json');
  const arqInsc = path.join(pasta, 'inscricoes.json');
  let chaves = null;
  const cacheJwt = new Map();

  function garantePasta() {
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    fs.chmodSync(pasta, 0o700);
  }

  /** Grava `texto` em `destino` por tmp + rename (0600). Com `semSobrescrever`, usa link e nunca troca um arquivo existente. */
  function grava(destino, texto, semSobrescrever) {
    garantePasta();
    const tmp = `${destino}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, texto, { mode: 0o600, flag: 'wx' });
    try {
      if (semSobrescrever) { fs.linkSync(tmp, destino); fs.unlinkSync(tmp); } else fs.renameSync(tmp, destino);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { if (e2.code !== 'ENOENT') log('aviso', `Não consegui apagar o temporário ${tmp} (${e2.code || e2.message}). Pode apagá-lo.`); }
      throw e;
    }
  }

  function erroChaves(causa) {
    return new Error(dgIdiomaBackend.mensagem("O arquivo de chaves dos avisos ({p0}) não pôde ser lido ({p1}). Não apague: restaure do backup ou, se aceitar que todos os aparelhos ativem os avisos de novo, mova o arquivo e reinicie o Web.", {p0: (arqVapid), p1: (causa)}));
  }

  function leChaves() {
    let texto;
    try { texto = fs.readFileSync(arqVapid, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw erroChaves(e.code || e.message);
    }
    let j;
    try { j = JSON.parse(texto); } catch (e) { throw erroChaves(`JSON inválido: ${e.message}`); }
    const pub = j && typeof j.publica === 'string' && RX_B64URL.test(j.publica) ? deB64u(j.publica) : null;
    const priv = j && typeof j.privada === 'string' && RX_B64URL.test(j.privada) ? deB64u(j.privada) : null;
    if (!pub || pub.length !== 65 || pub[0] !== 4 || !priv || priv.length !== 32) throw erroChaves('faltam as chaves "publica" (65 bytes) e "privada" (32 bytes) em base64url');
    let chavePrivada;
    try {
      chavePrivada = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(priv) }, format: 'jwk' });
    } catch (e) { throw erroChaves(`o par não forma uma chave P-256 válida: ${e.message}`); }
    return { publica: j.publica, privada: j.privada, chavePrivada, criada: false };
  }

  /** Lê o par VAPID; se não existe, cria. Nunca sobrescreve: arquivo ruim lança erro. */
  function garantirChaves() {
    if (chaves) return chaves;
    let c = leChaves();
    if (!c) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      const publica = b64u(Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)]));
      const novo = { publica, privada: jwk.d, criado_em: new Date(relogio()).toISOString() };
      try {
        grava(arqVapid, JSON.stringify(novo, null, 2) + '\n', true);
        log('info', `Criei o par de chaves dos avisos no aparelho em ${arqVapid}. Ele entra no backup; não apague.`);
      } catch (e) {
        if (e.code !== 'EEXIST') throw new Error(dgIdiomaBackend.mensagem("Não consegui criar as chaves dos avisos em {p0} ({p1}). Confira a permissão e o espaço da pasta de dados do Web.", {p0: (arqVapid), p1: (e.code || e.message)}));
      }
      c = leChaves();
      if (!c) throw erroChaves('o arquivo sumiu logo depois de criado');
      c.criada = true;
    }
    chaves = c;
    return chaves;
  }

  function chavePublica() { return garantirChaves().publica; }

  function jwtPara(aud) {
    const t = relogio();
    const ja = cacheJwt.get(aud);
    if (ja && t < ja.ate) return ja.jwt;
    const c = garantirChaves();
    const sub = process.env.DGCLAW_PUSH_SUB || 'mailto:dgclaw@localhost';
    const corpo = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp: Math.floor(t / 1000) + VALIDADE_JWT_S, sub }))}`;
    const assinatura = crypto.sign('sha256', Buffer.from(corpo), { key: c.chavePrivada, dsaEncoding: 'ieee-p1363' });
    const jwt = `${corpo}.${b64u(assinatura)}`;
    cacheJwt.set(aud, { jwt, ate: t + CACHE_JWT_MS });
    return jwt;
  }

  // ── inscrições ─────────────────────────────────────────────────────────────
  function erroInscricoes(causa) {
    return new Error(dgIdiomaBackend.mensagem("O arquivo de inscrições dos avisos ({p0}) não pôde ser lido ({p1}). Não apague: restaure do backup ou, se aceitar que os aparelhos ativem os avisos de novo, mova o arquivo.", {p0: (arqInsc), p1: (causa)}));
  }

  function lerInscricoes() {
    let texto;
    try { texto = fs.readFileSync(arqInsc, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { versao: 1, itens: [] };
      throw erroInscricoes(e.code || e.message);
    }
    let j;
    try { j = JSON.parse(texto); } catch (e) { throw erroInscricoes(`JSON inválido: ${e.message}`); }
    if (!j || j.versao !== 1 || !Array.isArray(j.itens)) throw erroInscricoes('o formato esperado é {"versao":1,"itens":[...]}');
    return j;
  }

  const salvarInscricoes = (d) => grava(arqInsc, JSON.stringify(d, null, 2) + '\n', false);
  const agoraIso = () => new Date(relogio()).toISOString();
  const servicoDe = (ins) => { try { return new URL(ins.endpoint).hostname; } catch (e) { return '(endpoint inválido)'; } };

  /** Valida o PushSubscription.toJSON() do navegador. */
  function validaInscricao(corpo) {
    if (!corpo || typeof corpo !== 'object') return { erro: dgIdiomaBackend.mensagem("Mande o PushSubscription.toJSON() do navegador: endpoint e keys.p256dh/keys.auth.") };
    const ep = validaEndpoint(corpo.endpoint);
    if (ep.erro) return { erro: ep.erro };
    const k = corpo.keys;
    const p256dh = k && typeof k.p256dh === 'string' && RX_B64URL.test(k.p256dh) ? deB64u(k.p256dh) : null;
    const auth = k && typeof k.auth === 'string' && RX_B64URL.test(k.auth) ? deB64u(k.auth) : null;
    if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return { erro: dgIdiomaBackend.mensagem("A chave \"keys.p256dh\" precisa ser base64url de 65 bytes (ponto P-256). Ative os avisos de novo no aparelho.") };
    if (!auth || auth.length !== 16) return { erro: dgIdiomaBackend.mensagem("O segredo \"keys.auth\" precisa ser base64url de 16 bytes. Ative os avisos de novo no aparelho.") };
    let aparelho = null;
    if (corpo.aparelho != null) {
      if (typeof corpo.aparelho !== 'string' || corpo.aparelho.trim().length > 60) return { erro: dgIdiomaBackend.mensagem("O nome do \"aparelho\" precisa ser um texto de até 60 caracteres.") };
      aparelho = corpo.aparelho.trim() || null;
    }
    return { endpoint: corpo.endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, aparelho };
  }

  // ── envio ──────────────────────────────────────────────────────────────────
  async function enviarUma(ins, corpoCifrado) {
    const u = new URL(ins.endpoint);
    const headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': corpoCifrado.length,
      TTL: String(TTL_S),
      Urgency: 'high',
      Authorization: `vapid t=${jwtPara(u.origin)}, k=${garantirChaves().publica}`,
    };
    return enviarPedido({ url: ins.endpoint, headers, corpo: corpoCifrado, timeoutMs: TIMEOUT_MS });
  }

  /**
   * Manda o aviso para os aparelhos inscritos (ou só para o `endpoint` dado).
   * Devolve { inscricoes, ok, removidas, falhas }. Lança TypeError se o aviso for inválido
   * e Error se o arquivo de chaves estiver ilegível; falha de entrega nunca lança.
   */
  async function enviar(aviso, opcoes) {
    const payload = Buffer.from(JSON.stringify(montaPayload(aviso)), 'utf8');
    garantirChaves();
    let dados;
    try { dados = lerInscricoes(); } catch (e) {
      log('erro', e.message);
      return { inscricoes: 0, ok: 0, removidas: 0, falhas: [{ id: null, servico: null, status: null, motivo: e.message }] };
    }
    const so = opcoes && opcoes.endpoint;
    const alvos = dados.itens.filter((i) => !so || i.endpoint === so);
    const resultado = { inscricoes: alvos.length, ok: 0, removidas: 0, falhas: [] };
    if (!alvos.length) return resultado;

    const saidas = await Promise.all(alvos.map(async (ins) => {
      try {
        const r = await enviarUma(ins, cifrar(payload, ins.keys.p256dh, ins.keys.auth));
        return { ins, status: r.status, corpo: r.corpo };
      } catch (e) {
        return { ins, erroRede: e.message || String(e) };
      }
    }));

    const atual = lerInscricoes();
    const t = agoraIso();
    for (const s of saidas) {
      const id = s.ins.id; const servico = servicoDe(s.ins);
      const viva = atual.itens.find((i) => i.id === id);
      if (s.erroRede) {
        resultado.falhas.push({ id, servico, status: null, motivo: s.erroRede });
        if (viva) viva.ultima_falha = { em: t, status: null, motivo: s.erroRede };
        log('aviso', `Aviso no aparelho ${id} (${servico}): falha de rede (${s.erroRede}). Tento de novo no próximo aviso.`);
      } else if (s.status === 200 || s.status === 201 || s.status === 202) {
        resultado.ok++;
        if (viva) { viva.ultimo_ok_em = t; viva.ultima_falha = null; }
      } else if (s.status === 404 || s.status === 410) {
        resultado.removidas++;
        atual.itens = atual.itens.filter((i) => i.id !== id);
        log('info', `Aviso no aparelho ${id} (${servico}): inscrição morta (HTTP ${s.status}); removi. O aparelho precisa ativar os avisos de novo.`);
      } else {
        const motivo = String(s.corpo || '').slice(0, 300);
        resultado.falhas.push({ id, servico, status: s.status, motivo });
        if (viva) viva.ultima_falha = { em: t, status: s.status, motivo };
        log('aviso', `Aviso no aparelho ${id} (${servico}): o serviço de push respondeu HTTP ${s.status}${motivo ? ` (${motivo})` : ''}.`);
      }
    }
    try { salvarInscricoes(atual); } catch (e) {
      log('erro', `Não consegui gravar ${arqInsc} depois do envio (${e.code || e.message}). Confira espaço e permissão da pasta de dados do Web.`);
    }
    return resultado;
  }

  // ── rotas ──────────────────────────────────────────────────────────────────
  const aviso503 = (res, e) => { log('erro', e.message); return H.erroJson(res, 503, e.message); };

  /** Trata /api/v1/push/*. Devolve true se respondeu; false se a rota não é daqui. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname;
    const m = req.method;
    if (p !== '/api/v1/push' && !p.startsWith('/api/v1/push/')) return false;
    if (sessao && sessao.via === 'caixa') {
      H.erroJson(res, 403, dgIdiomaBackend.mensagem("Os avisos no aparelho são do dono: um agente não usa as rotas /api/v1/push. Se precisa avisar o dono, use a frente que já envia o aviso (lembretes)."));
      return true;
    }
    const metodoErrado = (usar) => { H.erroJson(res, 405, dgIdiomaBackend.mensagem("Use {p0} em {p1}.", {p0: (usar), p1: (p)})); return true; };

    try {
      if (p === '/api/v1/push/chave') {
        if (m !== 'GET') return metodoErrado('GET');
        H.enviaJson(res, 200, { ok: true, chave_publica: chavePublica() });
        return true;
      }

      if (p === '/api/v1/push/inscricoes') {
        if (m === 'GET') {
          const lista = lerInscricoes().itens.map((i) => ({ id: i.id, aparelho: i.aparelho, servico: servicoDe(i), criada_em: i.criada_em, ultimo_ok_em: i.ultimo_ok_em, ultima_falha: i.ultima_falha }));
          H.enviaJson(res, 200, { ok: true, inscricoes: lista });
          return true;
        }
        if (m !== 'POST') return metodoErrado('GET para listar ou POST para inscrever');
        const v = validaInscricao(await H.lerJson(req, 8 * 1024));
        if (v.erro) { H.erroJson(res, 400, v.erro); return true; }
        const dados = lerInscricoes();
        const t = agoraIso();
        const antiga = dados.itens.find((i) => i.endpoint === v.endpoint);
        if (antiga) {
          antiga.keys = v.keys;
          if (v.aparelho) antiga.aparelho = v.aparelho;
          antiga.atualizada_em = t;
        } else {
          dados.itens.push({ id: `ins_${crypto.randomBytes(8).toString('hex')}`, endpoint: v.endpoint, keys: v.keys, aparelho: v.aparelho, criada_em: t, ultimo_ok_em: null, ultima_falha: null });
        }
        salvarInscricoes(dados);
        const ins = antiga || dados.itens[dados.itens.length - 1];
        log('info', `Aparelho ${antiga ? 'atualizado' : 'inscrito'} nos avisos: ${ins.id} (${servicoDe(ins)}).`);
        H.enviaJson(res, antiga ? 200 : 201, { ok: true, id: ins.id, nova: !antiga });
        return true;
      }

      if (p === '/api/v1/push/inscricoes/confere') {
        if (m !== 'POST') return metodoErrado('POST');
        const c = await H.lerJson(req, 4 * 1024);
        const ins = lerInscricoes().itens.find((i) => i.endpoint === c.endpoint);
        H.enviaJson(res, 200, { ok: true, inscrito: !!ins, id: ins ? ins.id : null });
        return true;
      }

      if (p === '/api/v1/push/inscricoes/remover') {
        if (m !== 'POST') return metodoErrado('POST');
        const c = await H.lerJson(req, 4 * 1024);
        if (typeof c.endpoint !== 'string' && typeof c.id !== 'string') { H.erroJson(res, 400, dgIdiomaBackend.mensagem("Mande {\"endpoint\":\"...\"} ou {\"id\":\"ins_...\"} para dizer qual inscrição remover.")); return true; }
        const dados = lerInscricoes();
        const alvo = dados.itens.find((i) => (typeof c.id === 'string' && i.id === c.id) || (typeof c.endpoint === 'string' && i.endpoint === c.endpoint));
        if (!alvo) { H.erroJson(res, 404, dgIdiomaBackend.mensagem("Não achei essa inscrição. Veja as existentes em GET /api/v1/push/inscricoes.")); return true; }
        dados.itens = dados.itens.filter((i) => i.id !== alvo.id);
        salvarInscricoes(dados);
        log('info', `Aparelho ${alvo.id} (${servicoDe(alvo)}) saiu dos avisos.`);
        H.enviaJson(res, 200, { ok: true, id: alvo.id });
        return true;
      }

      if (p === '/api/v1/push/teste') {
        if (m !== 'POST') return metodoErrado('POST');
        const c = await H.lerJson(req, 4 * 1024);
        const r = await enviar({ titulo: 'DG Claw', corpo: 'Aviso de teste: se você está lendo isto, os avisos neste aparelho funcionam.', tag: 'teste-aviso', url: '/' }, typeof c.endpoint === 'string' ? { endpoint: c.endpoint } : undefined);
        if (r.inscricoes === 0) { H.erroJson(res, 409, dgIdiomaBackend.mensagem("Nenhum aparelho está com os avisos ativados. Toque em \"Ativar avisos neste aparelho\" e tente de novo."), r); return true; }
        if (r.ok === 0 && r.falhas.length) {
          const f = r.falhas[0];
          H.erroJson(res, 502, dgIdiomaBackend.mensagem("O serviço de push recusou o aviso de teste ({p0}, status {p1}: {p2}). Se persistir, desative e ative os avisos de novo no aparelho.", {p0: (f.servico || 'serviço desconhecido'), p1: (f.status == null ? 'sem resposta' : f.status), p2: (f.motivo || 'sem motivo')}), r);
          return true;
        }
        if (r.ok === 0) { H.erroJson(res, 409, dgIdiomaBackend.mensagem("A inscrição deste aparelho tinha vencido e foi removida. Ative os avisos de novo e repita o teste."), r); return true; }
        H.enviaJson(res, 200, { ok: true, inscricoes: r.inscricoes, enviados: r.ok, removidas: r.removidas, falhas: r.falhas });
        return true;
      }

      H.erroJson(res, 404, dgIdiomaBackend.mensagem("Não existe {p0} {p1}. As rotas estão em GET /api/v1/push/docs.md.", {p0: (m), p1: (p)}));
      return true;
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message); return true; }
      aviso503(res, e);
      return true;
    }
  }

  return { chavePublica, enviar, rotas, garantirChaves };
}

module.exports = { criarPush, cifrar, montaPayload, validaEndpoint, hostPermitido };
