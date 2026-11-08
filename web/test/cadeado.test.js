'use strict';
// Cadeado com Face ID: cadastro e verificação de ponta a ponta com um autenticador falso (chave gerada aqui no teste),
// a máquina de estados (travar, destravar, senha) e o portão em todas as telas. Referência: web/docs/CADEADO.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cliente, subirWeb, pastaTemp, gerarHash } = require('./ajuda');
const { cenario: cenarioBase, colaboradorAtivo } = require('./colab-ajuda');
const W = require('../lib/webauthn');

const MIN = 60 * 1000;
const PUBLICO_REAL = path.join(__dirname, '..', 'public');

/** As telas reais do cadeado e do Face ID na pasta pública do servidor de teste. */
function comTelas(t) {
  for (const f of ['cadeado.html', 'face-id.html']) fs.copyFileSync(path.join(PUBLICO_REAL, f), path.join(t.publico, f));
  return t;
}
async function cenario(o) { const s = await cenarioBase(o); comTelas(s.t); return s; }
const sha = (v) => crypto.createHash('sha256').update(v).digest();

// ── CBOR mínimo só para montar o attestationObject do autenticador falso ─────
function cbor(v) {
  const cab = (maior, n) => {
    if (n < 24) return Buffer.from([(maior << 5) | n]);
    if (n < 256) return Buffer.from([(maior << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (maior << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([cab(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([cab(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? cab(0, v) : cab(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([cab(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('tipo CBOR de teste não previsto');
}

/** Um aparelho de mentira com uma chave ES256 (ou RS256) que ele mesmo gerou. */
function aparelhoFalso(opcoes) {
  const o = opcoes || {};
  const rsa = o.alg === 'RS256';
  const par = rsa
    ? crypto.generateKeyPairSync('rsa', { modulusLength: o.bits || 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = par.publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const cose = rsa
    ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const ap = {
    credId, contador: o.contadorInicial || 0,
    clientData(tipo, challenge, origem, extra) { return Buffer.from(JSON.stringify(Object.assign({ type: tipo, challenge, origin: origem, crossOrigin: false }, extra || {}))); },
    /** Resposta do navegador a navigator.credentials.create(). `ruim` estraga um detalhe. */
    cria(pk, origem, ruim) {
      const r = ruim || {};
      const rpHash = sha(r.rpId || pk.rp.id);
      const flags = 0x01 | (r.semUV ? 0 : 0x04) | 0x40 | (r.be ? 0x08 : 0);
      const cont = Buffer.alloc(4);
      const ad = Buffer.concat([rpHash, Buffer.from([flags]), cont, Buffer.alloc(16), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(credId.length); return b; })(), credId, cbor(cose)]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
      const cdj = ap.clientData(r.tipo || 'webauthn.create', r.challenge || pk.challenge, r.origin || origem);
      return { id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: cdj.toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] } };
    },
    /** Resposta a navigator.credentials.get(). */
    assina(pk, origem, ruim) {
      const r = ruim || {};
      if (r.contador === undefined) ap.contador += 1; else ap.contador = r.contador;
      const cont = Buffer.alloc(4); cont.writeUInt32BE(ap.contador);
      const ad = Buffer.concat([sha(r.rpId || pk.rpId), Buffer.from([0x01 | (r.semUV ? 0 : 0x04)]), cont]);
      const cdj = ap.clientData('webauthn.get', r.challenge || pk.challenge, r.origin || origem);
      const dados = Buffer.concat([ad, sha(cdj)]);
      let sig = rsa ? crypto.sign('sha256', dados, par.privateKey) : crypto.sign('sha256', dados, par.privateKey);
      if (r.assinaturaErrada) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; sig[10] ^= 0x55; }
      const resp = { clientDataJSON: cdj.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') };
      if (r.userHandle) resp.userHandle = r.userHandle;
      return { id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key', response: resp };
    },
  };
  return ap;
}

/** Cliente de teste que se apresenta como localhost (o Face ID só vale em HTTPS ou localhost). */
function pessoa(s) {
  const porta = s.t.porta;
  const c = cliente(porta);
  const origem = `http://localhost:${porta}`;
  const p = {
    c, origem, jar: c.jar,
    pedir: (m, caminho, o) => c.pedir(m, caminho, Object.assign({ origin: origem }, o || {}, { headers: Object.assign({ Host: `localhost:${porta}` }, (o && o.headers) || {}) })),
    get: (caminho, o) => p.pedir('GET', caminho, o),
    post: (caminho, json, o) => p.pedir('POST', caminho, Object.assign({ json: json === undefined ? {} : json }, o || {})),
    async login(usuario, senha) {
      const r = await p.post('/login', { usuario, senha });
      assert.equal(r.status, 200, r.texto);
      return r;
    },
    async cadastra(ap, nome, ruim) {
      const op = await p.get('/api/v1/cadeado/cadastro/opcoes');
      assert.equal(op.status, 200, op.texto);
      const pk = op.json.publicKey;
      return p.post('/api/v1/cadeado/cadastro', { nome, credencial: ap.cria(pk, origem, ruim) });
    },
    async opcoes() {
      const op = await p.get('/api/v1/cadeado/verificar/opcoes');
      return op;
    },
    async destrava(ap, ruim) {
      const op = await p.opcoes();
      assert.equal(op.status, 200, op.texto);
      return p.post('/api/v1/cadeado/verificar', { credencial: ap.assina(op.json.publicKey, origem, ruim) });
    },
  };
  return p;
}

async function dono(s) {
  const p = pessoa(s);
  await p.login('dono', s.t.senha);
  return p;
}

const verde = async (s, fn) => { try { await fn(); } finally { await s.fechar(); } };

test('cadastro e verificação: o Face ID destrava a sessão que já entrou com a senha', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.ativo, false, 'sem cadastro, o cadeado não existe');
    const ap = aparelhoFalso();
    const r = await d.cadastra(ap, 'iPhone do dono');
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.passkey.nome, 'iPhone do dono');
    assert.equal(r.json.passkey.alg, 'ES256');
    assert.equal(r.json.passkey.este_aparelho, true);
    assert.equal(r.json.estado.ativo, true);
    // cookie por aparelho: HttpOnly, SameSite=Lax, longa duração; em http puro não leva Secure
    const sc = [].concat(r.headers['set-cookie']).find((x) => x.startsWith('dgclaw_aparelho='));
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Max-Age=34560000/); assert.doesNotMatch(sc, /Secure/);
    assert.match(sc, /^dgclaw_aparelho=[A-Za-z0-9_-]{43};/);
    // no disco: arquivo 600, só o hash do aparelho, nunca o valor do cookie
    const arq = path.join(s.t.dados, 'passkeys.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    const valor = /dgclaw_aparelho=([^;]+)/.exec(sc)[1];
    assert.ok(!fs.readFileSync(arq, 'utf8').includes(valor));
    await s.t.web.cadeado.aguardar();
    assert.equal(fs.readdirSync(s.t.dados).filter((n) => n.endsWith('.tmp')).length, 0);
    // recém cadastrada: a sessão fica destravada
    assert.equal((await d.get('/api/v1/agents')).status, 200);
    // passa o tempo: trava
    s.relogio.t += 16 * MIN;
    const t = await d.get('/api/v1/agents');
    assert.equal(t.status, 423, t.texto);
    assert.equal(t.json.ok, false); assert.equal(t.json.travado, true); assert.match(t.json.erro, /travada/);
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.travado, true);
    // o Face ID destrava
    const v = await d.destrava(ap);
    assert.equal(v.status, 200, v.texto);
    assert.equal(v.json.estado.travado, false);
    assert.equal((await d.get('/api/v1/agents')).status, 200);
    // nada de assinatura, desafio ou chave no log
    assert.doesNotMatch(s.t.log.texto(), /signature|challenge|"x":|"y":/);
  });
});

test('RS256 de 2048 bits funciona; RSA de 1024 bits é recusado', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ruim = await d.cadastra(aparelhoFalso({ alg: 'RS256', bits: 1024 }), 'fraco');
    assert.equal(ruim.status, 400, ruim.texto); assert.equal(ruim.json.motivo, 'chave'); assert.match(ruim.json.erro, /2048/);
    const rsa = aparelhoFalso({ alg: 'RS256' });
    const r = await d.cadastra(rsa, 'notebook');
    assert.equal(r.status, 201, r.texto); assert.equal(r.json.passkey.alg, 'RS256');
    s.relogio.t += 16 * MIN;
    assert.equal((await d.destrava(rsa)).status, 200);
  });
});

test('autenticador que marca backup eligible (passkey sincronizada) é aceito', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const r = await d.cadastra(aparelhoFalso(), 'iCloud', { be: true });
    assert.equal(r.status, 201, r.texto); assert.equal(r.json.passkey.sincronizada, true);
  });
});

test('o Face ID nunca cria sessão nem faz login', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    assert.equal((await d.cadastra(ap, 'iPhone')).status, 201);
    const aparelho = d.jar.dgclaw_aparelho;
    // outro navegador com o cookie de aparelho e sem sessão
    const anon = pessoa(s);
    anon.jar.dgclaw_aparelho = aparelho;
    const op = await anon.get('/api/v1/cadeado/verificar/opcoes');
    assert.equal(op.status, 401);
    // mesmo com um desafio válido de outra sessão e uma assinatura certa, sem sessão não entra nada
    const opDono = await d.opcoes();
    const v = await anon.post('/api/v1/cadeado/verificar', { credencial: ap.assina(opDono.json.publicKey, anon.origem) });
    assert.equal(v.status, 401);
    assert.equal(anon.jar.dgclaw_sessao, undefined, 'nenhuma sessão nasceu');
    assert.equal((await anon.get('/api/v1/agents')).status, 401);
    assert.ok(!(v.headers['set-cookie'] || []).some((x) => x.startsWith('dgclaw_sessao=')));
  });
});

test('travada: 423 na API, redireciona a página, recusa /p/ e WebSocket; o que destrava continua passando', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    s.relogio.t += 20 * MIN;
    const api = await d.get('/api/v1/agents/ana/messages');
    assert.equal(api.status, 423); assert.equal(api.json.travado, true);
    for (const rota of ['/api/v1/tarefas', '/api/v1/lembretes', '/api/v1/cadeado/passkeys', '/api/v1/cadeado/docs.md']) {
      assert.equal((await d.get(rota)).status, 423, rota);
    }
    assert.equal((await d.post('/api/v1/agents/ana/send', { text: 'oi' })).status, 423);
    for (const pagina of ['/', '/a/ana', '/mesa', '/face-id', '/conversa.html']) {
      const r = await d.get(pagina, { headers: { Accept: 'text/html' } });
      assert.equal(r.status, 302, pagina);
      assert.match(r.headers.location, /^\/cadeado\?next=%2F/, pagina);
    }
    const alvo = await d.get('/a/ana?x=1', { headers: { Accept: 'text/html' } });
    assert.equal(decodeURIComponent(alvo.headers.location.split('next=')[1]), '/a/ana?x=1');
    // /p/**: HTML vira redirecionamento, o resto vira 423 (e o painel nem é consultado)
    const ph = await d.get('/p/ana/', { headers: { Accept: 'text/html' } });
    assert.equal(ph.status, 302); assert.match(ph.headers.location, /^\/cadeado\?next=/);
    const pa = await d.get('/p/ana/api/sessoes');
    assert.equal(pa.status, 423); assert.equal(pa.json.travado, true);
    assert.equal((await d.post('/p/ana/api/chat/enviar', {})).status, 423);
    // WebSocket recusado
    const ws = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/p/ana/tela/websockify', headers: { Host: `localhost:${s.t.porta}`, Origin: d.origem, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Cookie: `dgclaw_sessao=${d.jar.dgclaw_sessao}; dgclaw_aparelho=${d.jar.dgclaw_aparelho}` } });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('upgrade', () => resolve('upgrade'));
      req.on('error', reject);
      req.end();
    });
    assert.equal(ws, 423);
    // passam: a tela do cadeado, os estáticos, estado, opções e verificação
    const tela = await d.get('/cadeado', { headers: { Accept: 'text/html' } });
    assert.equal(tela.status, 200, tela.texto.slice(0, 200)); assert.match(tela.headers['cache-control'], /no-store/);
    assert.equal((await d.get('/app.js')).status, 200);
    assert.equal((await d.get('/api/v1/cadeado/estado')).status, 200);
    assert.equal((await d.opcoes()).status, 200);
    // quem não saiu da fila de /uso, de cadastro e de ajustes: tudo 423
    assert.equal((await d.post('/api/v1/cadeado/uso')).status, 423);
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 30 } })).status, 423);
    assert.equal((await d.get('/api/v1/cadeado/cadastro/opcoes')).status, 423);
    // destravada, volta tudo
    assert.equal((await d.destrava(ap)).status, 200);
    assert.equal((await d.get('/a/ana', { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await d.get('/cadeado', { headers: { Accept: 'text/html' } })).status, 302, 'destravada, a tela do cadeado devolve para a página');
  });
});

test('a caixa do agente e os pedidos internos nunca travam, e não alcançam o cadeado', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    s.relogio.t += 20 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    const cab = { 'X-DGClaw-Caixa': s.t.web.caixa.segredo, 'X-DGClaw-Agente': 'ana' };
    const viaCaixa = await d.get('/api/v1/lembretes', { headers: cab, semCookie: true });
    assert.notEqual(viaCaixa.status, 423, viaCaixa.texto);
    // com os cookies do dono travado junto, a caixa continua sendo caixa
    const comCookie = await d.get('/api/v1/lembretes', { headers: cab });
    assert.notEqual(comCookie.status, 423, comCookie.texto);
    const cad = await d.get('/api/v1/cadeado/estado', { headers: cab });
    assert.equal(cad.status, 403);
    assert.equal((await d.get('/api/v1/cadeado/docs.md', { headers: cab })).status, 403, 'a doc do Face ID não é rota da caixa');
  });
});

test('sem o cookie de aparelho uma sessão que nunca esteve ligada a ele não trava (o cadeado é por aparelho)', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    // outro navegador que nunca ativou o Face ID, com a própria sessão
    const outro = pessoa(s);
    await outro.login('dono', s.t.senha);
    s.relogio.t += 60 * MIN;
    assert.equal((await outro.get('/api/v1/agents')).status, 200);
    assert.equal((await outro.get('/api/v1/cadeado/estado')).json.ativo, false);
    assert.equal((await d.get('/api/v1/agents')).status, 423);
    // cookie de aparelho inventado: não está ligado a passkey nenhuma, não trava
    const falso = pessoa(s);
    await falso.login('dono', s.t.senha);
    falso.jar.dgclaw_aparelho = crypto.randomBytes(32).toString('base64url');
    assert.equal((await falso.get('/api/v1/agents')).status, 200);
  });
});

test('a senha destrava: sair e entrar de novo cria sessão destravada, mesmo com o aparelho travado', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    s.relogio.t += 30 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 423);
    const antiga = d.jar.dgclaw_sessao;
    const sair = await d.post('/sair', undefined);
    assert.equal(sair.status, 303);
    assert.equal(d.jar.dgclaw_sessao, undefined);
    assert.ok(d.jar.dgclaw_aparelho, 'o cookie do aparelho continua');
    await d.login('dono', s.t.senha);
    assert.notEqual(d.jar.dgclaw_sessao, antiga);
    assert.equal((await d.get('/api/v1/agents')).status, 200);
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.travado, false);
    // e ela trava de novo por falta de uso
    s.relogio.t += 16 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 423);
  });
});

test('"uso" estica a trava a cada aviso (a gravação em disco é que fica em no máximo uma por minuto); fetch comum não conta', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    s.relogio.t += 10 * MIN;
    await d.get('/api/v1/agents'); // fetch em segundo plano: não conta
    const u = await d.post('/api/v1/cadeado/uso');
    assert.equal(u.status, 200); assert.ok(u.json.resta_s > 14 * 60 - 5 && u.json.resta_s <= 15 * 60);
    await s.t.web.cadeado.aguardar();
    const arqEstado = path.join(s.t.dados, 'cadeado-sessoes.json');
    const gravado1 = fs.readFileSync(arqEstado, 'utf8');
    s.relogio.t += 30 * 1000;
    const u2 = await d.post('/api/v1/cadeado/uso');
    assert.ok(u2.json.resta_s > 15 * 60 - 5, 'o segundo aviso, 30 s depois, já estica o prazo');
    await s.t.web.cadeado.aguardar();
    assert.equal(fs.readFileSync(arqEstado, 'utf8'), gravado1, 'dentro do mesmo minuto o disco não é regravado');
    s.relogio.t += 31 * 1000;
    await d.post('/api/v1/cadeado/uso');
    await s.t.web.cadeado.aguardar();
    assert.notEqual(fs.readFileSync(arqEstado, 'utf8'), gravado1, 'passado um minuto, grava');
    s.relogio.t += 14 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 200, 'o aviso de uso esticou o prazo');
    s.relogio.t += 16 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 423);
  });
});

test('o tempo de trava é por titular, de 1 a 120 minutos, e mudar exige sessão destravada', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    for (const ruim of [0, 121, 1.5, '10', null]) {
      const r = await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: ruim } });
      assert.equal(r.status, 400, String(ruim)); assert.match(r.json.erro, /1 e 120/);
    }
    const ok = await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 5 } });
    assert.equal(ok.status, 200); assert.equal(ok.json.estado.trava_min, 5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.t.dados, 'passkeys.json'), 'utf8')).ajustes.dono.trava_min, 5);
    s.relogio.t += 6 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 423);
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 60 } })).status, 423);
  });
});

test('gerenciar: lista sem segredo, renomear e remover; remover a última desliga o cadeado deste aparelho', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    const c = await d.cadastra(ap, '  iPhone\u0007 do dono  ');
    const id = c.json.passkey.id;
    const lista = await d.get('/api/v1/cadeado/passkeys');
    assert.equal(lista.json.passkeys.length, 1);
    assert.equal(lista.json.passkeys[0].nome, 'iPhone do dono');
    assert.doesNotMatch(lista.texto, /jwk|credencial_id|aparelho_hash|"x"|"y"/);
    const ren = await d.pedir('PATCH', `/api/v1/cadeado/passkeys/${id}`, { json: { nome: 'Celular' } });
    assert.equal(ren.status, 200); assert.equal(ren.json.passkey.nome, 'Celular');
    assert.equal((await d.pedir('PATCH', `/api/v1/cadeado/passkeys/${id}`, { json: { nome: '' } })).status, 400);
    assert.equal((await d.pedir('PATCH', `/api/v1/cadeado/passkeys/${id}`, { json: { nome: 'x'.repeat(61) } })).status, 400);
    assert.equal((await d.pedir('DELETE', '/api/v1/cadeado/passkeys/pk_000000000000')).status, 404);
    assert.equal((await d.pedir('DELETE', '/api/v1/cadeado/passkeys/../x')).status, 404);
    const del = await d.pedir('DELETE', `/api/v1/cadeado/passkeys/${id}`);
    assert.equal(del.status, 200); assert.equal(del.json.estado.ativo, false); assert.equal(del.json.estado.passkeys, 0);
    s.relogio.t += 60 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status, 200, 'sem passkey ligada ao cookie, nada trava');
  });
});

test('desafio: reuso, vencimento, outra sessão e tipo errado são recusados', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    s.relogio.t += 20 * MIN;
    // reuso
    const op1 = await d.opcoes();
    const cred1 = ap.assina(op1.json.publicKey, d.origem);
    assert.equal((await d.post('/api/v1/cadeado/verificar', { credencial: cred1 })).status, 200);
    s.relogio.t += 20 * MIN;
    const reuso = await d.post('/api/v1/cadeado/verificar', { credencial: cred1 });
    assert.equal(reuso.status, 400); assert.equal(reuso.json.motivo, 'desafio'); assert.match(reuso.json.erro, /já foi usado|não existe/);
    // vencido
    const op2 = await d.opcoes();
    s.relogio.t += 3 * MIN;
    const venc = await d.post('/api/v1/cadeado/verificar', { credencial: ap.assina(op2.json.publicKey, d.origem) });
    assert.equal(venc.status, 400); assert.match(venc.json.erro, /venceu/);
    // desafio de outra sessão
    const outra = pessoa(s);
    await outra.login('dono', s.t.senha);
    outra.jar.dgclaw_aparelho = d.jar.dgclaw_aparelho;
    s.relogio.t += 20 * MIN;
    const opOutra = await outra.opcoes();
    const roubado = await d.post('/api/v1/cadeado/verificar', { credencial: ap.assina(opOutra.json.publicKey, d.origem) });
    assert.equal(roubado.status, 403); assert.match(roubado.json.erro, /outra sessão/);
    // desafio de cadastro usado como verificação
    s.relogio.t += 1 * MIN;
    const cad = await d.get('/api/v1/cadeado/cadastro/opcoes');
    assert.equal(cad.status, 423, 'travada nem pede opções de cadastro');
  });
});

test('recusas da verificação: origin, rpId, assinatura, UV, type e contador', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    s.relogio.t += 20 * MIN;
    const casos = [
      [{ origin: 'https://site-do-golpista.com' }, 403, 'origin', /origin/],
      [{ rpId: 'outro.exemplo.com' }, 403, 'rpid', /rpIdHash/],
      [{ assinaturaErrada: true }, 403, 'assinatura', /assinatura/],
      [{ semUV: true }, 400, 'uv', /UV/],
    ];
    for (const [ruim, status, motivo, rx] of casos) {
      const r = await d.destrava(ap, ruim);
      assert.equal(r.status, status, JSON.stringify(ruim) + r.texto);
      assert.equal(r.json.motivo, motivo);
      assert.match(r.json.erro, rx);
      assert.equal((await d.get('/api/v1/agents')).status, 423, 'continua travada depois de ' + motivo);
    }
    // contador: sobe uma vez, depois volta
    assert.equal((await d.destrava(ap, { contador: 10 })).status, 200);
    s.relogio.t += 20 * MIN;
    const volta = await d.destrava(ap, { contador: 9 });
    assert.equal(volta.status, 403); assert.equal(volta.json.motivo, 'contador'); assert.match(volta.json.erro, /não subiu/);
    const igual = await d.destrava(ap, { contador: 10 });
    assert.equal(igual.status, 403);
    assert.equal((await d.destrava(ap, { contador: 11 })).status, 200);
    // type errado: cadastro usado no lugar de get
    s.relogio.t += 20 * MIN;
    const op = await d.opcoes();
    const cred = ap.assina(op.json.publicKey, d.origem);
    const cdj = JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString());
    cdj.type = 'webauthn.create';
    cred.response.clientDataJSON = Buffer.from(JSON.stringify(cdj)).toString('base64url');
    const tipo = await d.post('/api/v1/cadeado/verificar', { credencial: cred });
    assert.equal(tipo.status, 400); assert.equal(tipo.json.motivo, 'tipo');
    assert.doesNotMatch(s.t.log.texto(), new RegExp(cred.response.signature.slice(0, 20)));
  });
});

test('cadastro recusado: UV ausente, origin errado, rpId errado, desafio de outro tipo, campo gigante', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const uv = await d.cadastra(aparelhoFalso(), 'sem rosto', { semUV: true });
    assert.equal(uv.status, 400); assert.equal(uv.json.motivo, 'uv'); assert.match(uv.json.erro, /Face ID|rosto/);
    const org = await d.cadastra(aparelhoFalso(), 'golpe', { origin: 'https://golpe.com' });
    assert.equal(org.status, 403); assert.equal(org.json.motivo, 'origin');
    const rp = await d.cadastra(aparelhoFalso(), 'rp', { rpId: 'golpe.com' });
    assert.equal(rp.status, 403); assert.equal(rp.json.motivo, 'rpid');
    const op = await d.get('/api/v1/cadeado/cadastro/opcoes');
    const gigante = aparelhoFalso().cria(op.json.publicKey, d.origem);
    gigante.response.attestationObject = 'A'.repeat(40 * 1024);
    const g = await d.post('/api/v1/cadeado/cadastro', { credencial: gigante });
    assert.equal(g.status, 400); assert.equal(g.json.motivo, 'formato');
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 0);
    assert.equal(fs.existsSync(path.join(s.t.dados, 'passkeys.json')), false, 'nada foi gravado');
    // desafio de verificação usado no cadastro
    const opv = await d.opcoes().catch(() => null);
    assert.equal(opv.status, 404, 'sem passkey ainda: não há o que verificar');
  });
});

test('passkey de outro titular não destrava a sessão; cada pessoa só enxerga as próprias', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const apDono = aparelhoFalso();
    await d.cadastra(apDono, 'iPhone do dono');
    // colaboradora com o próprio aparelho
    const conv = await s.convida({ agente: 'ana', email: 'maria@x.com', nome: 'Maria' });
    const m = pessoa(s);
    await m.login('maria@x.com', conv.json.convite.senha_temporaria);
    // com senha temporária pendente ela não cadastra
    const antes = await m.get('/api/v1/cadeado/cadastro/opcoes');
    assert.equal(antes.status, 403); assert.equal(antes.json.trocar_senha, true);
    const nova = 'minha-senha-nova-1';
    assert.equal((await m.post('/api/v1/eu/senha', { nova, confirmacao: nova })).status, 200);
    const apMaria = aparelhoFalso();
    const rm = await m.cadastra(apMaria, 'Celular da Maria');
    assert.equal(rm.status, 201, rm.texto);
    assert.equal((await m.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys[0].nome, 'iPhone do dono');
    s.relogio.t += 20 * MIN;
    // a Maria tenta destravar com a passkey do dono, e o dono com a da Maria
    const opM = await m.opcoes();
    const cruz = await m.post('/api/v1/cadeado/verificar', { credencial: apDono.assina(opM.json.publicKey, m.origem) });
    assert.equal(cruz.status, 403); assert.equal(cruz.json.motivo, 'titular');
    const opD = await d.opcoes();
    assert.equal((await d.post('/api/v1/cadeado/verificar', { credencial: apMaria.assina(opD.json.publicKey, d.origem) })).status, 403);
    assert.equal((await m.get('/api/v1/agents')).status, 423);
    assert.equal((await d.get('/api/v1/agents')).status, 423);
    // userHandle de outra pessoa
    const opM2 = await m.opcoes();
    const uh = await m.post('/api/v1/cadeado/verificar', { credencial: apMaria.assina(opM2.json.publicKey, m.origem, { userHandle: Buffer.from('outra-pessoa').toString('base64url') }) });
    assert.equal(uh.status, 403);
    // cada uma com a sua
    assert.equal((await m.destrava(apMaria)).status, 200);
    assert.equal((await d.destrava(apDono)).status, 200);
    // o id de uma passkey alheia não existe para o outro
    const idDono = (await d.get('/api/v1/cadeado/passkeys')).json.passkeys[0].id;
    assert.equal((await m.pedir('DELETE', `/api/v1/cadeado/passkeys/${idDono}`)).status, 404);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1);
  });
});

test('o colaborador alcança só as rotas do Face ID (e as telas dele), nada além do escopo de sempre', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const col = await colaboradorAtivo(s);
    const m = pessoa(s);
    m.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    m.jar.dgclaw_papel = 'colaborador';
    assert.equal((await m.get('/api/v1/cadeado/estado')).status, 200);
    assert.equal((await m.get('/api/v1/cadeado/passkeys')).status, 200);
    assert.equal((await m.get('/api/v1/cadeado/docs.md')).status, 200);
    assert.equal((await m.get('/face-id', { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await m.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 20 } })).status, 200);
    // o que continua fechado
    assert.equal((await m.get('/api/v1/cadeado/inventada')).status, 403);
    assert.equal((await m.pedir('PUT', '/api/v1/cadeado/estado', { json: {} })).status, 405);
    assert.equal((await m.get('/api/v1/colaboradores')).status, 403);
    assert.equal((await m.get('/api/v1/agents/bob/messages')).status, 403);
    assert.equal((await m.get('/seguranca', { headers: { Accept: 'text/html' } })).status, 302);
    // a rota do cadeado não vale para a caixa, e a lista fechada de escopo não foi alargada
    const { avaliar } = require('../lib/escopo');
    const colab = { usuario: 'm@x.com', papel: 'colaborador', agente: 'ana', trocar_senha: false };
    assert.equal(avaliar(colab, 'GET', '/api/v1/cadeado/passkeys').ok, true);
    assert.equal(avaliar(colab, 'DELETE', '/api/v1/cadeado/passkeys/pk_0123456789ab').ok, true);
    assert.equal(avaliar(colab, 'GET', '/api/v1/cadeado/qualquer-coisa').ok, false);
    assert.equal(avaliar(colab, 'DELETE', '/api/v1/cadeado/passkeys/..%2Fx').ok, false);
    assert.equal(avaliar(Object.assign({}, colab, { trocar_senha: true }), 'GET', '/api/v1/cadeado/estado').ok, false);
    assert.equal(s.t.web.caixa.rotaPermitida('/api/v1/cadeado/estado'), false);
  });
});

test('revogar o colaborador apaga as passkeys e o estado dele; as do dono ficam', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone do dono');
    const col = await colaboradorAtivo(s);
    const m = pessoa(s);
    m.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    assert.equal((await m.cadastra(aparelhoFalso(), 'Celular da Maria')).status, 201);
    const arq = path.join(s.t.dados, 'passkeys.json');
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).passkeys.length, 2);
    const rev = await d.pedir('DELETE', `/api/v1/colaboradores/${col.id}`);
    assert.equal(rev.status, 200, rev.texto);
    await s.t.web.cadeado.aguardar();
    const depois = JSON.parse(fs.readFileSync(arq, 'utf8'));
    assert.deepEqual(depois.passkeys.map((p) => p.titular), ['dono']);
    assert.equal(Object.keys(depois.ajustes).filter((k) => k.startsWith('colaborador:')).length, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(s.t.dados, 'cadeado-sessoes.json'), 'utf8'), /colaborador:/);
  });
});

test('arquivo ilegível fecha: o cadeado segue ligado para quem tem o cookie, só a senha destrava, e nada é regravado', async () => {
  const dados = pastaTemp('cad-ruim');
  const lixo = '{"passkeys": [ {oops';
  fs.writeFileSync(path.join(dados, 'passkeys.json'), lixo, { mode: 0o600 });
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  try {
    assert.match(t.log.texto(), /passkeys\.json está ilegível/);
    const sem = pessoa({ t });
    await sem.login('dono', t.senha);
    assert.equal((await sem.get('/api/v1/cadeado/estado')).json.ativo, false, 'sem cookie de aparelho, nada muda');
    assert.equal((await sem.get('/api/v1/cadeado/estado')).json.aviso.includes('ilegível'), true);
    // quem tem o cookie de aparelho: trava, e só a senha abre
    const d = pessoa({ t });
    d.jar.dgclaw_aparelho = crypto.randomBytes(32).toString('base64url');
    await d.login('dono', t.senha);
    assert.notEqual((await d.get('/api/v1/lembretes')).status, 423, 'o login por senha nasce destravado');
    relogio.t += 16 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    const op = await d.get('/api/v1/cadeado/verificar/opcoes');
    assert.equal(op.status, 503); assert.match(op.json.erro, /ilegível/);
    await d.post('/sair');
    await d.login('dono', t.senha);
    assert.notEqual((await d.get('/api/v1/lembretes')).status, 423);
    // cadastrar, apagar e ajustar ficam recusados, com a causa
    relogio.t += 1 * MIN;
    assert.equal((await d.get('/api/v1/cadeado/cadastro/opcoes')).status, 503);
    const aj = await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 30 } });
    assert.equal(aj.status, 503); assert.match(aj.json.erro, /ilegível/);
    await t.web.cadeado.aguardar();
    assert.equal(fs.readFileSync(path.join(dados, 'passkeys.json'), 'utf8'), lixo, 'o arquivo ruim não foi regravado');
  } finally { await t.fechar(); }
});

test('HTTPS: sem ele (e fora de localhost) o cadastro explica o motivo; atrás do proxy com HTTPS o cookie leva Secure', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = pessoa(s);
    await d.login('dono', s.t.senha);
    // http puro num nome que não é localhost
    const http1 = await d.get('/api/v1/cadeado/cadastro/opcoes', { headers: { Host: 'painel.exemplo.com' } });
    assert.equal(http1.status, 400); assert.equal(http1.json.motivo, 'ambiente'); assert.match(http1.json.erro, /HTTPS/);
    const est = await d.get('/api/v1/cadeado/estado', { headers: { Host: 'painel.exemplo.com' } });
    assert.equal(est.json.https, null); assert.match(est.json.ambiente_erro, /HTTPS/);
    // IP não serve de rpId
    const ip = await d.get('/api/v1/cadeado/cadastro/opcoes', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': '203.0.113.7' } });
    assert.equal(ip.status, 400); assert.match(ip.json.erro, /IP/);
    // proxy local avisando https (como o Caddy faz)
    const cab = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'painel.exemplo.com' };
    const origem = 'https://painel.exemplo.com';
    const op = await d.pedir('GET', '/api/v1/cadeado/cadastro/opcoes', { headers: cab });
    assert.equal(op.status, 200, op.texto); assert.equal(op.json.publicKey.rp.id, 'painel.exemplo.com'); assert.equal(op.json.publicKey.rp.name, 'DG Claw');
    assert.equal(op.json.publicKey.authenticatorSelection.userVerification, 'required');
    const ap = aparelhoFalso();
    const r = await d.pedir('POST', '/api/v1/cadeado/cadastro', { origin: origem, headers: cab, json: { nome: 'iPhone', credencial: ap.cria(op.json.publicKey, origem) } });
    assert.equal(r.status, 201, r.texto);
    assert.match([].concat(r.headers['set-cookie']).find((x) => x.startsWith('dgclaw_aparelho=')), /; Secure/);
    // a passkey é presa ao endereço: em outro endereço não há o que verificar
    const outro = await d.get('/api/v1/cadeado/verificar/opcoes', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'outro.exemplo.com' } });
    assert.equal(outro.status, 404); assert.equal(outro.json.motivo, 'sem_passkey');
  });
});

test('tentativas erradas de verificação têm limite por sessão', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    s.relogio.t += 20 * MIN;
    let ultimo;
    for (let i = 0; i < 10; i++) ultimo = await d.destrava(ap, { assinaturaErrada: true });
    assert.equal(ultimo.status, 403);
    const op = await d.opcoes();
    const bloq = await d.post('/api/v1/cadeado/verificar', { credencial: ap.assina(op.json.publicKey, d.origem) });
    assert.equal(bloq.status, 429, bloq.texto); assert.ok(bloq.headers['retry-after']);
    // a senha continua valendo, e passados os 10 minutos o Face ID volta
    s.relogio.t += 11 * MIN;
    assert.equal((await d.destrava(ap)).status, 200);
  });
});

test('o stream da conversa para e avisa com "event: travado"', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    const texto = await new Promise((resolve, reject) => {
      let acumulado = '';
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/api/v1/agents/ana/stream', headers: { Host: `localhost:${s.t.porta}`, Cookie: `dgclaw_sessao=${d.jar.dgclaw_sessao}; dgclaw_aparelho=${d.jar.dgclaw_aparelho}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => {
          acumulado += c.toString();
          if (/event: ola/.test(acumulado) && !/event: travado/.test(acumulado) && !req.travou) { req.travou = true; s.relogio.t += 20 * MIN; }
        });
        res.on('end', () => resolve(acumulado));
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); resolve(`TEMPO ESGOTADO\n${'x'}`); });
      req.end();
    });
    assert.match(texto, /event: travado\ndata: \{[^}]*"travado":true/);
    assert.ok(texto.indexOf('event: travado') > texto.indexOf('event: ola'));
  });
});

// ── WebSocket já aberto quando a sessão trava ───────────────────────────────
function painelComWebSocket() {
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    pedidos.push(`${req.method} ${req.url}`); req.resume();
    if (req.url.includes('/poder-desligado')) { res.writeHead(423, { 'Content-Type': 'application/json' }); return res.end('{"error":"power_not_installed"}'); }
    res.writeHead(200); res.end('{}');
  });
  const abertos = new Set();
  const seguros = []; // upgrades em /lento esperam o teste mandar o 101
  servidor.on('upgrade', (req, socket) => {
    abertos.add(socket); socket.on('close', () => abertos.delete(socket));
    const responde = () => { if (!socket.destroyed) socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); };
    if (req.url.includes('/lento')) seguros.push(responde); else responde();
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => socket.destroy());
  });
  return {
    pedidos, seguros,
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))),
    fechar: () => new Promise((r) => { for (const x of abertos) x.destroy(); servidor.closeAllConnections(); servidor.close(() => r()); }),
  };
}
async function cenarioWs() {
  const painel = painelComWebSocket();
  const porta = await painel.ouvir();
  const dir = pastaTemp('cad-ws');
  const segredo = path.join(dir, 'proxy.txt');
  fs.writeFileSync(segredo, 'segredo-de-teste\n');
  const agentes = [{ slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'a1', porta_painel: porta, proxy_segredo_arquivo: segredo }];
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ agentes, opcoesServidor: { agora: () => relogio.t } }));
  return { t, relogio, painel, fechar: async () => { await t.fechar(); await painel.fechar(); } };
}
/** Abre o WebSocket da Tela e devolve { socket, fechou: Promise }. */
function abreWs(s, p, comAparelho) {
  const cookie = `dgclaw_sessao=${p.jar.dgclaw_sessao}` + (comAparelho && p.jar.dgclaw_aparelho ? `; dgclaw_aparelho=${p.jar.dgclaw_aparelho}` : '');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: '/p/ana/tela/websockify', headers: { Host: `localhost:${s.t.porta}`, Origin: p.origem, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Cookie: cookie } });
    req.on('upgrade', (res, socket) => {
      const fechou = new Promise((r) => socket.on('close', () => r(true)));
      socket.on('error', () => {});
      resolve({ socket, fechou });
    });
    req.on('response', (res) => { res.resume(); reject(new Error(`o upgrade foi recusado com ${res.statusCode}`)); });
    req.on('error', reject);
    req.on('close', () => reject(new Error(`a conexão fechou sem upgrade. Log do Web:\n${s.t.log.texto()}`)));
    req.setTimeout(3000, () => { req.destroy(); reject(new Error(`o upgrade não respondeu em 3 s. Log do Web:\n${s.t.log.texto()}`)); });
    req.end();
  });
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

test('WebSocket aberto antes de travar cai na revalidação do proxy; sem cadeado a conexão fica', async () => {
  const s = await cenarioWs();
  try {
    // dono SEM cadeado: nada é conferido, a conexão fica aberta mesmo com o tempo passando
    const livre = pessoa(s);
    await livre.login('dono', s.t.senha);
    const wsLivre = await abreWs(s, livre, false);
    s.relogio.t += 60 * MIN;
    s.t.web.proxy.revalidar();
    await espera(150);
    assert.equal(wsLivre.socket.destroyed, false, 'sem Face ID a conexão do dono é conferida e segue aberta');
    wsLivre.socket.destroy();

    // dono COM cadeado: a Tela abre destravada e cai quando a sessão trava
    const d = pessoa(s);
    await d.login('dono', s.t.senha);
    const ap = aparelhoFalso();
    assert.equal((await d.cadastra(ap, 'iPhone')).status, 201);
    const ws = await abreWs(s, d, true);
    s.t.web.proxy.revalidar();
    await espera(150);
    assert.equal(ws.socket.destroyed, false, 'destravada, segue aberta');
    s.relogio.t += 16 * MIN;
    s.t.web.proxy.revalidar();
    assert.equal(await Promise.race([ws.fechou, espera(1000).then(() => false)]), true, 'travou: o WebSocket é fechado');
    assert.match(s.t.log.texto(), /fechei um WebSocket cuja sessão deixou de valer ou travou/);
    // destravar não reabre sozinho, mas a Tela volta a abrir
    assert.equal((await d.destrava(ap)).status, 200);
    const outro = await abreWs(s, d, true);
    outro.socket.destroy();
  } finally { await s.fechar(); }
});

test('WebSocket aberto ANTES de ativar o Face ID também cai quando a sessão trava', async () => {
  const s = await cenarioWs();
  try {
    const d = pessoa(s);
    await d.login('dono', s.t.senha);
    const ws = await abreWs(s, d, false); // aberta sem Face ID e sem cookie de aparelho
    const ap = aparelhoFalso();
    assert.equal((await d.cadastra(ap, 'iPhone')).status, 201); // a mesma sessão liga o Face ID depois
    s.t.web.proxy.revalidar();
    await espera(150);
    assert.equal(ws.socket.destroyed, false, 'destravada, segue aberta');
    s.relogio.t += 16 * MIN;
    s.t.web.proxy.revalidar();
    assert.equal(await Promise.race([ws.fechou, espera(1000).then(() => false)]), true, 'a Tela aberta antes do Face ID cai quando a sessão trava');
  } finally { await s.fechar(); }
});

test('casca.js carrega o trava.js nas páginas do painel e não duplica onde já há a tag', () => {
  const vm = require('node:vm');
  const codigo = fs.readFileSync(path.join(PUBLICO_REAL, 'casca.js'), 'utf8');
  const monta = (comTag, comObjeto) => {
    const anexados = [];
    const document = {
      head: { appendChild: (e) => anexados.push(e.src) },
      createElement: () => ({}),
      // como o navegador: depois de anexada, a tag passa a ser achada
      querySelector: (sel) => ((comTag || anexados.length) && sel === 'script[src="/trava.js"]' ? {} : null),
      getElementById: () => null,
    };
    const janela = { document, console };
    janela.window = janela;
    if (comObjeto) janela.DGTrava = {};
    vm.createContext(janela);
    vm.runInContext(codigo, janela, { filename: 'casca.js' });
    janela.DGCasca.carregaTrava();
    janela.DGCasca.carregaTrava();
    return anexados;
  };
  assert.deepEqual(monta(false, false), ['/trava.js'], 'sem nada carregado a tag entra, uma vez só mesmo chamando duas vezes');
  assert.equal(monta(true, false).length, 0, 'tag já no HTML: não duplica');
  assert.equal(monta(false, true).length, 0, 'objeto já carregado: não duplica');
  // o casca.js só roda nas telas logadas: o login, a troca de senha e o primeiro acesso não o carregam
  for (const t of ['login', 'trocar-senha', 'primeiro-acesso']) assert.doesNotMatch(fs.readFileSync(path.join(PUBLICO_REAL, `${t}.html`), 'utf8'), /casca\.js/, t);
});

// ── exigência presa à sessão, remoção de aparelho, concorrência e tela sem rede ──
const DIA_MS = 24 * 60 * MIN;

test('a trava não depende do cookie: sem ele, com ele adulterado, depois de reiniciar o módulo e depois de 4 dias parada', async () => {
  const dados = pastaTemp('cad-exige');
  const relogio = { t: Date.now() };
  const hash = gerarHash('senha-certa-123'); // a mesma nas duas partidas: senão as sessões antigas são descartadas de propósito
  const abre = async () => comTelas(await subirWeb({ env: { DGCLAW_PANEL_PASSWORD_HASH: hash }, opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  let t = await abre();
  const s = { t };
  let d = pessoa(s);
  await d.login('dono', t.senha);
  const ap = aparelhoFalso();
  assert.equal((await d.cadastra(ap, 'iPhone')).status, 201);
  const cookieOk = d.jar.dgclaw_aparelho;
  relogio.t += 16 * MIN;
  const sessao = d.jar.dgclaw_sessao;
  try {
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    delete d.jar.dgclaw_aparelho;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423, 'sem o cookie, a sessão ligada segue travada');
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.ativo, true);
    d.jar.dgclaw_aparelho = crypto.randomBytes(32).toString('base64url');
    assert.equal((await d.get('/api/v1/lembretes')).status, 423, 'cookie adulterado também');
    // o Face ID destrava mesmo sem o cookie original, e o tempo volta a contar
    delete d.jar.dgclaw_aparelho;
    assert.equal((await d.destrava(ap)).status, 200);
    assert.notEqual((await d.get('/api/v1/lembretes')).status, 423);
    relogio.t += 16 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    // reinicia o painel (mesma pasta de dados): a exigência vem do disco
    await t.fechar();
    t = await abre();
    d = pessoa({ t });
    d.jar.dgclaw_sessao = sessao;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423, 'depois de reiniciar, sem cookie, continua travada');
    // 4 dias parada: o registro com exigência não some
    relogio.t += 4 * DIA_MS;
    d.jar.dgclaw_aparelho = cookieOk;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423, 'depois de 4 dias o registro ainda existe');
    delete d.jar.dgclaw_aparelho;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    assert.match(fs.readFileSync(path.join(dados, 'cadeado-sessoes.json'), 'utf8'), /"exige":true/);
  } finally { await t.fechar(); }
});

test('o cookie válido que aparece numa sessão ainda não ligada a prende ao aparelho; entrar com o cookie já nasce ligada e destravada', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    // sessão que entrou sem o cookie: livre, até um pedido dela trazer o cookie válido
    const b = pessoa(s);
    await b.login('dono', s.t.senha);
    assert.notEqual((await b.get('/api/v1/lembretes')).status, 423, 'sem cookie e sem ligação: livre');
    b.jar.dgclaw_aparelho = d.jar.dgclaw_aparelho;
    assert.equal((await b.get('/api/v1/lembretes')).status, 423, 'sessão sem registro com cookie válido: nasce travada, como sempre');
    delete b.jar.dgclaw_aparelho;
    assert.equal((await b.get('/api/v1/lembretes')).status, 423, 'e sem o cookie continua travada');
    // entrar com o cookie na mão: destravada e presa ao aparelho
    const c = pessoa(s);
    c.jar.dgclaw_aparelho = d.jar.dgclaw_aparelho;
    await c.login('dono', s.t.senha);
    assert.notEqual((await c.get('/api/v1/lembretes')).status, 423);
    delete c.jar.dgclaw_aparelho;
    s.relogio.t += 16 * MIN;
    assert.equal((await c.get('/api/v1/lembretes')).status, 423);
  });
});

test('DELETE concorrente: A, B e B seguidos não apagam a passkey de ninguém além da própria', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone do dono');
    const col = await colaboradorAtivo(s);
    const m = pessoa(s);
    m.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    const a = (await m.cadastra(aparelhoFalso(), 'A')).json.passkey.id;
    const b = (await m.cadastra(aparelhoFalso(), 'B')).json.passkey.id;
    const [r1, r2, r3] = await Promise.all([a, b, b].map((id) => m.pedir('DELETE', `/api/v1/cadeado/passkeys/${id}`)));
    assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 404]);
    assert.equal(r3.json.motivo, 'inexistente');
    assert.equal((await m.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 0);
    const doDono = (await d.get('/api/v1/cadeado/passkeys')).json.passkeys;
    assert.equal(doDono.length, 1, 'a passkey do dono continua lá');
    assert.equal(doDono[0].nome, 'iPhone do dono');
    // PATCH de passkey inexistente ou alheia: 404, sem estourar
    const idDono = doDono[0].id;
    assert.equal((await m.pedir('PATCH', `/api/v1/cadeado/passkeys/${idDono}`, { json: { nome: 'x' } })).status, 404);
    assert.equal((await m.pedir('PATCH', `/api/v1/cadeado/passkeys/${a}`, { json: { nome: 'x' } })).status, 404);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys[0].nome, 'iPhone do dono');
  });
});

test('remover o aparelho encerra as sessões presas a ele (401, stream e WebSocket fechados) e a de quem removeu segue', async () => {
  const painel = painelComWebSocket();
  const porta = await painel.ouvir();
  const dir = pastaTemp('cad-rem');
  const segredo = path.join(dir, 'proxy.txt');
  fs.writeFileSync(segredo, 'segredo-de-teste\n');
  const agentes = [{ slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'a1', porta_painel: porta, proxy_segredo_arquivo: segredo }];
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ agentes, opcoesServidor: { agora: () => relogio.t } }));
  const s = { t, relogio };
  try {
    // celular: liga o Face ID e abre stream e Tela
    const celular = pessoa(s);
    await celular.login('dono', t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const ws = await abreWs(s, celular, true);
    const fluxo = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.porta, path: '/api/v1/agents/ana/stream', headers: { Host: `localhost:${t.porta}`, Cookie: `dgclaw_sessao=${celular.jar.dgclaw_sessao}; dgclaw_aparelho=${celular.jar.dgclaw_aparelho}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        let texto = '';
        const fim = new Promise((r) => res.on('close', () => r(texto)));
        res.on('data', (c) => { texto += c.toString(); });
        resolve({ fim, req });
      });
      req.on('error', reject);
      req.end();
    });
    // computador: outra sessão do dono, com o próprio Face ID (outro aparelho)
    const pc = pessoa(s);
    await pc.login('dono', t.senha);
    const apPc = aparelhoFalso();
    assert.equal((await pc.cadastra(apPc, 'computador')).status, 201);
    assert.notEqual(pc.jar.dgclaw_aparelho, celular.jar.dgclaw_aparelho);
    assert.notEqual((await celular.get('/api/v1/lembretes')).status, 423);
    const idCelular = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const rem = await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCelular}`);
    assert.equal(rem.status, 200, rem.texto);
    assert.equal(rem.json.sessoes_encerradas, 1);
    // celular: sessão encerrada (401), stream e WebSocket fechados
    assert.equal((await celular.get('/api/v1/agents')).status, 401);
    const texto = await Promise.race([fluxo.fim, espera(3000).then(() => 'NAO FECHOU')]);
    assert.notEqual(texto, 'NAO FECHOU', 'o stream da conversa fechou');
    assert.match(texto, /sessao_encerrada/);
    assert.equal(await Promise.race([ws.fechou, espera(1500).then(() => false)]), true, 'a Tela (WebSocket) fechou');
    // computador: segue, e continua com o cadeado dele
    assert.notEqual((await pc.get('/api/v1/lembretes')).status, 401);
    relogio.t += 16 * MIN;
    assert.equal((await pc.get('/api/v1/lembretes')).status, 423);
    assert.equal((await pc.destrava(apPc)).status, 200);

    // remover o próprio aparelho: a sessão continua, sem cadeado; outra sessão do mesmo aparelho cai
    const outraDoPc = pessoa(s);
    outraDoPc.jar.dgclaw_aparelho = pc.jar.dgclaw_aparelho;
    await outraDoPc.login('dono', t.senha);
    assert.notEqual((await outraDoPc.get('/api/v1/lembretes')).status, 401);
    const idPc = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys[0].id;
    const rem2 = await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idPc}`);
    assert.equal(rem2.json.sessoes_encerradas, 1);
    assert.equal((await outraDoPc.get('/api/v1/agents')).status, 401);
    relogio.t += 60 * MIN;
    assert.notEqual((await pc.get('/api/v1/lembretes')).status, 423, 'a sessão de quem removeu segue, agora sem cadeado');
    assert.equal((await pc.get('/api/v1/cadeado/estado')).json.ativo, false);
  } finally { await t.fechar(); await painel.fechar(); }
});

test('remover uma passkey de um aparelho que ainda tem outra da mesma pessoa não derruba nada', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'primeira');
    await d.cadastra(aparelhoFalso(), 'segunda'); // mesmo navegador: reaproveita o cookie do aparelho
    const outro = pessoa(s);
    outro.jar.dgclaw_aparelho = d.jar.dgclaw_aparelho;
    await outro.login('dono', s.t.senha);
    assert.notEqual((await outro.get('/api/v1/lembretes')).status, 423);
    const lista = (await d.get('/api/v1/cadeado/passkeys')).json.passkeys;
    const r = await d.pedir('DELETE', `/api/v1/cadeado/passkeys/${lista[0].id}`);
    assert.equal(r.json.sessoes_encerradas, 0);
    assert.notEqual((await outro.get('/api/v1/agents')).status, 401);
    s.relogio.t += 16 * MIN;
    assert.equal((await outro.get('/api/v1/lembretes')).status, 423, 'o cadeado do aparelho segue valendo');
  });
});

test('tela: o prazo vencido cobre a tela sem depender do servidor e só descobre quando o servidor confirma', async () => {
  const vm = require('node:vm');
  const codigo = fs.readFileSync(path.join(PUBLICO_REAL, 'trava.js'), 'utf8');
  let agora = 1_000_000;
  let rede = true;
  let travado = false;
  const intervalos = [];
  const elementos = {};
  const el = (id) => elementos[id] || (elementos[id] = {
    id, textContent: '', hidden: false, disabled: false, innerHTML: '', style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, setAttribute() {}, querySelector: (sel) => el(sel), blur() {},
  });
  const html = { classList: { added: [], removed: [], add(c) { this.added.push(c); }, remove(c) { this.removed.push(c); } } };
  const document = {
    readyState: 'complete', visibilityState: 'visible', documentElement: html, activeElement: null,
    head: { appendChild() {} }, body: { appendChild(x) { x.montado = true; }, hasAttribute: () => false },
    createElement: (tag) => el('novo-' + tag), addEventListener() {}, querySelectorAll: () => [],
  };
  const resposta = (status, corpo) => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(corpo) });
  const janela = {
    document, console, URLSearchParams, Promise, Date: { now: () => agora }, TypeError,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 5 }, location: { search: '', pathname: '/a/ana', host: 'x.com' },
    addEventListener() {}, setInterval: (fn) => { intervalos.push(fn); return intervalos.length; }, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
    fetch: (url) => {
      if (!rede) return Promise.reject(new TypeError('Failed to fetch'));
      if (url.endsWith('/estado')) return resposta(200, { ok: true, ativo: true, travado, resta_s: travado ? 0 : 60, trava_min: 1 });
      return resposta(200, { ok: true });
    },
  };
  janela.window = janela;
  vm.createContext(janela);
  vm.runInContext(codigo, janela, { filename: 'trava.js' });
  const vazio = () => new Promise((r) => setImmediate(r));
  await vazio(); await vazio();
  const raiz = () => elementos['novo-div'];
  assert.ok(!raiz() || raiz().hidden !== false, 'destravada: a tela não está coberta');
  // o prazo passa e a rede cai
  rede = false;
  agora += 61 * 1000;
  for (const fn of intervalos) fn();
  await vazio(); await vazio(); await vazio();
  assert.equal(raiz().hidden, false, 'coberta localmente, sem resposta do servidor');
  assert.ok(html.classList.added.includes('dgclaw-travado'));
  assert.match(elementos['#dgclawTravaMsg'].textContent, /Sem conexão.*internet para destravar/);
  // volta a rede, o servidor diz que ainda está travada: continua coberta
  rede = true; travado = true;
  for (const fn of intervalos) fn();
  await vazio(); await vazio(); await vazio();
  assert.equal(raiz().hidden, false);
  // o servidor confirma o destravamento: aí a tela se descobre
  travado = false;
  await janela.DGTrava.confere();
  assert.equal(raiz().hidden, true, 'descoberta só depois da confirmação do servidor');
});

// ── saturação do estado ─────────────────────────────────────────────────────
test('saturação: a colaboradora com Face ID faz muitos logins e o registro do dono continua (a sessão dele segue 423 sem cookie)', async () => {
  const s = await cenarioBase({ opcoesServidor: { cadeadoEstadoMax: 20 } });
  comTelas(s.t);
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone do dono');
    const col = await colaboradorAtivo(s);
    const m0 = pessoa(s);
    m0.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    assert.equal((await m0.cadastra(aparelhoFalso(), 'Celular da Maria')).status, 201);
    for (let i = 0; i < 40; i++) {
      const m = pessoa(s);
      m.jar.dgclaw_aparelho = m0.jar.dgclaw_aparelho;
      await m.login(col.email, col.nova);
    }
    const arq = JSON.parse(fs.readFileSync(path.join(s.t.dados, 'cadeado-sessoes.json'), 'utf8')).sessoes;
    assert.ok(Object.keys(arq).length <= 12, `só as sessões vivas ficam (${Object.keys(arq).length})`);
    // o dono perde o cookie e passa o tempo: continua travado
    delete d.jar.dgclaw_aparelho;
    s.relogio.t += 16 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
  });
});

test('saturação: se todos os registros são de sessão viva, a mais antiga é encerrada em vez de liberada', async () => {
  const s = await cenarioBase({ opcoesServidor: { cadeadoEstadoMax: 3 } });
  comTelas(s.t);
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone do dono');
    const col = await colaboradorAtivo(s);
    const m0 = pessoa(s);
    m0.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    await m0.cadastra(aparelhoFalso(), 'Celular da Maria');
    const sessoes = [];
    for (let i = 0; i < 6; i++) {
      const m = pessoa(s);
      m.jar.dgclaw_aparelho = m0.jar.dgclaw_aparelho;
      await m.login(col.email, col.nova);
      sessoes.push(m);
    }
    delete d.jar.dgclaw_aparelho;
    for (const p of [d, ...sessoes]) delete p.jar.dgclaw_aparelho;
    s.relogio.t += 16 * MIN;
    const vivas = [];
    for (const p of [d, m0, ...sessoes]) {
      const st = (await p.get('/api/v1/agents')).status;
      assert.notEqual(st, 200, 'nenhuma sessão com Face ID fica liberada sem o cookie');
      assert.ok(st === 423 || st === 401, `status ${st}`);
      vivas.push(st);
    }
    assert.ok(vivas.includes(401), 'as descartadas foram encerradas');
    assert.match(s.t.log.texto(), /encerrei a sessão mais antiga/);
    const arq = JSON.parse(fs.readFileSync(path.join(s.t.dados, 'cadeado-sessoes.json'), 'utf8')).sessoes;
    assert.ok(Object.keys(arq).length <= 3);
  });
});

test('trava de 1 minuto: avisos de uso em 1, 10, 30 e 59 s mantêm a sessão aberta aos 61 s', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 1 } })).status, 200);
    const t0 = s.relogio.t;
    for (const seg of [1, 10, 30, 59]) {
      s.relogio.t = t0 + seg * 1000;
      assert.equal((await d.post('/api/v1/cadeado/uso')).status, 200, `aviso aos ${seg} s`);
    }
    s.relogio.t = t0 + 61 * 1000;
    assert.equal((await d.get('/api/v1/agents')).status, 200, 'quem está usando não é travado');
    s.relogio.t = t0 + 125 * 1000;
    assert.equal((await d.get('/api/v1/agents')).status, 423, 'sem novos avisos, trava');
  });
});

// ── a exigência também vive no registro que autentica a sessão (sessoes.json) ──
async function reinicia(preparaDados) {
  const dados = pastaTemp('cad-marca');
  const relogio = { t: Date.now() };
  const hash = gerarHash('senha-certa-123');
  const abre = async () => comTelas(await subirWeb({ env: { DGCLAW_PANEL_PASSWORD_HASH: hash }, opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  if (preparaDados) preparaDados(dados);
  let t = await abre();
  const d = pessoa({ t });
  await d.login('dono', t.senha);
  assert.equal((await d.cadastra(aparelhoFalso(), 'iPhone')).status, 201);
  const sessao = d.jar.dgclaw_sessao;
  return { dados, relogio, t, d, sessao, abre };
}

test('a gravação do estado falha (disco cheio) e o painel reinicia: a sessão ligada continua 423 sem o cookie', async () => {
  // um diretório no lugar do arquivo faz toda gravação do estado falhar
  const c = await reinicia((dados) => fs.mkdirSync(path.join(dados, 'cadeado-sessoes.json')));
  let t = c.t;
  try {
    assert.match(t.log.texto(), /não li .*cadeado-sessoes\.json|não gravei .*cadeado-sessoes\.json/);
    await t.web.cadeado.aguardar();
    await t.fechar();
    t = await c.abre();
    const d = pessoa({ t });
    d.jar.dgclaw_sessao = c.sessao;
    c.relogio.t += 1 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423, 'sem registro de estado nem cookie, a marca do auth trava a sessão');
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.ativo, true);
  } finally { await t.fechar(); }
});

test('o estado do cadeado fica corrompido e o painel reinicia: a sessão ligada continua 423 sem o cookie', async () => {
  const c = await reinicia();
  let t = c.t;
  try {
    await t.web.cadeado.aguardar();
    await t.fechar();
    fs.writeFileSync(path.join(c.dados, 'cadeado-sessoes.json'), '{"sessoes": [oops');
    t = await c.abre();
    assert.match(t.log.texto(), /não li .*cadeado-sessoes\.json/);
    const d = pessoa({ t });
    d.jar.dgclaw_sessao = c.sessao;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
  } finally { await t.fechar(); }
});

test('a marca no sessoes.json sobrevive às reescritas do auth e não derruba a sessão; se não der para gravá-la, a sessão é encerrada', async () => {
  const c = await reinicia();
  const t = c.t;
  try {
    const arq = path.join(c.dados, 'sessoes.json');
    const lido = () => Object.values(JSON.parse(fs.readFileSync(arq, 'utf8')).sessoes);
    assert.equal(lido().filter((x) => x.cadeado_exige === true).length, 1);
    // outro login (o auth reescreve o arquivo inteiro): a marca continua e a sessão ainda vale
    const outra = pessoa({ t });
    await outra.login('dono', t.senha);
    assert.equal(lido().filter((x) => x.cadeado_exige === true).length, 1);
    assert.notEqual((await c.d.get('/api/v1/agents')).status, 401);
    // sem poder gravar o sessoes.json, a sessão que já devia estar travada responde travada e a marca fica na memória
    const b = pessoa({ t });
    await b.login('dono', t.senha);
    b.jar.dgclaw_aparelho = c.d.jar.dgclaw_aparelho;
    const tmp = `${arq}.${process.pid}.tmp`;
    fs.mkdirSync(tmp); // a troca atômica do arquivo passa a falhar, e o arquivo antigo fica como está
    assert.equal((await b.get('/api/v1/agents')).status, 423, 'travada, não encerrada');
    assert.match(t.log.texto(), /segue travada e a marca fica na memória/);
    fs.rmdirSync(tmp);
    // na próxima gravação do auth a marca entra no arquivo
    const c2 = pessoa({ t });
    await c2.login('dono', t.senha);
    assert.equal(lido().filter((x) => x.cadeado_exige === true).length, 2, 'a marca retida foi gravada depois');
  } finally { await t.fechar(); }
});

// ── a marca vai para o disco antes de qualquer promessa de cadeado ───────────
const lerSessoes = (dados) => JSON.parse(fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8')).sessoes;
const shaHex = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('sessão criada num aparelho com cookie válido leva a marca na MESMA gravação que a cria', async () => {
  const c = await reinicia();
  const t = c.t;
  try {
    const antes = fs.readFileSync(path.join(c.dados, 'sessoes.json'), 'utf8');
    const tmp = path.join(c.dados, `sessoes.json.${process.pid}.tmp`);
    fs.mkdirSync(tmp); // toda gravação do sessoes.json falha, e o arquivo antigo é preservado
    const nova = pessoa({ t });
    nova.jar.dgclaw_aparelho = c.d.jar.dgclaw_aparelho;
    await nova.login('dono', t.senha);
    assert.equal(fs.readFileSync(path.join(c.dados, 'sessoes.json'), 'utf8'), antes, 'o arquivo antigo ficou como estava');
    const hash = shaHex(nova.jar.dgclaw_sessao);
    assert.deepEqual(t.web.auth.leCadeado(hash), { exige: true, aparelho_hash: shaHex(`dgclaw-cadeado-aparelho:${nova.jar.dgclaw_aparelho}`), pendente: true }, 'na memória a sessão já nasceu marcada, e a marca ainda é só da memória');
    fs.rmdirSync(tmp);
    await t.web.auth.encerraPorHash('inexistente'); // não grava nada
    const outra = pessoa({ t });
    await outra.login('dono', t.senha); // próxima gravação do auth
    const reg = lerSessoes(c.dados)[hash];
    assert.ok(reg, 'a sessão chegou ao arquivo');
    assert.equal(reg.cadeado_exige, true, 'e chegou já com a marca: nunca existiu no disco sem ela');
  } finally { await t.fechar(); }
});

test('cadastro: se a marca não pode ser gravada, nada é criado, responde 500 com a causa e a sessão segue normal e sem cadeado', async () => {
  const dados = pastaTemp('cad-b');
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  try {
    const d = pessoa({ t });
    await d.login('dono', t.senha);
    const antes = fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8');
    const tmp = path.join(dados, `sessoes.json.${process.pid}.tmp`);
    fs.mkdirSync(tmp);
    const r = await d.cadastra(aparelhoFalso(), 'iPhone');
    assert.equal(r.status, 500, r.texto); assert.equal(r.json.motivo, 'arquivo'); assert.match(r.json.erro, /disco cheio.*não foi ligado.*sem o cadeado/);
    fs.rmdirSync(tmp);
    assert.equal(fs.existsSync(path.join(dados, 'passkeys.json')), false, 'a passkey não foi criada');
    assert.equal(fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8'), antes);
    assert.equal(t.web.auth.leCadeado(shaHex(d.jar.dgclaw_sessao)), null, 'a marca foi desfeita na memória');
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.ativo, false);
    relogio.t += 60 * MIN;
    assert.equal((await d.get('/api/v1/agents')).status !== 423, true, 'sessão normal, nunca prometida ao cadeado');
    // e, resolvido o disco, o cadastro funciona
    assert.equal((await d.cadastra(aparelhoFalso(), 'iPhone')).status, 201);
  } finally { await t.fechar(); }
});

test('verificação: se a marca não pode ser gravada, responde 500, a passkey continua e a sessão segue travada', async () => {
  const dados = pastaTemp('cad-c');
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  try {
    // dois aparelhos do dono, cada um com a sua passkey e o seu cookie
    const celular = pessoa({ t }); await celular.login('dono', t.senha);
    const apCel = aparelhoFalso(); assert.equal((await celular.cadastra(apCel, 'celular')).status, 201);
    const pc = pessoa({ t }); await pc.login('dono', t.senha);
    const apPc = aparelhoFalso(); assert.equal((await pc.cadastra(apPc, 'pc')).status, 201);
    // a sessão do celular, presa ao celular, vê o cookie do pc e verifica com a passkey do pc
    const sessaoCel = celular.jar.dgclaw_sessao;
    celular.jar.dgclaw_aparelho = pc.jar.dgclaw_aparelho;
    relogio.t += 16 * MIN;
    assert.equal((await celular.get('/api/v1/agents')).status, 423);
    const tmp = path.join(dados, `sessoes.json.${process.pid}.tmp`);
    fs.mkdirSync(tmp);
    const r = await celular.destrava(apPc);
    assert.equal(r.status, 500, r.texto); assert.equal(r.json.motivo, 'arquivo');
    assert.equal((await celular.get('/api/v1/agents')).status, 423, 'não destravou');
    fs.rmdirSync(tmp);
    assert.ok(sessaoCel);
    assert.equal((await celular.destrava(apPc)).status, 200, 'resolvido o disco, destrava');
    assert.equal((await celular.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 2, 'as passkeys continuaram o tempo todo');
  } finally { await t.fechar(); }
});

test('corpo que termina depois de a sessão travar: 423 e nada muda (ajustes, nome e cadastro)', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    const c = await d.cadastra(ap, 'iPhone');
    const id = c.json.passkey.id;
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 1 } })).status, 200);
    const cookie = `dgclaw_sessao=${d.jar.dgclaw_sessao}; dgclaw_aparelho=${d.jar.dgclaw_aparelho}`;
    /** Manda o começo do corpo, deixa o tempo passar e só então termina. */
    const lento = (metodo, caminho, comeco, fim) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: caminho, method: metodo, headers: { Host: `localhost:${s.t.porta}`, Origin: d.origem, 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
        const partes = []; res.on('data', (x) => partes.push(x)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString() }));
      });
      req.on('error', reject);
      req.write(comeco);
      setTimeout(() => { s.relogio.t += 61 * 1000; req.end(fim); }, 100);
    });
    s.relogio.t += 30 * 1000;
    const aj = await lento('PUT', '/api/v1/cadeado/ajustes', '{"trava_min":', '120}');
    assert.equal(aj.status, 423, aj.texto);
    assert.equal((await d.get('/api/v1/cadeado/estado')).json.trava_min, 1, 'o tempo não mudou');
    assert.equal((await d.destrava(ap)).status, 200);
    const nm = await lento('PATCH', `/api/v1/cadeado/passkeys/${id}`, '{"nome":', '"Trocado"}');
    assert.equal(nm.status, 423, nm.texto);
    assert.equal((await d.destrava(ap)).status, 200);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys[0].nome, 'iPhone');
    // cadastro: a sessão trava durante o Face ID
    const op = await d.get('/api/v1/cadeado/cadastro/opcoes');
    const cred = aparelhoFalso().cria(op.json.publicKey, d.origem);
    const cad = await lento('POST', '/api/v1/cadeado/cadastro', '{"nome":"outro","credencial":', `${JSON.stringify(cred)}}`);
    assert.equal(cad.status, 423, cad.texto);
    assert.equal((await d.destrava(ap)).status, 200);
    assert.equal((await d.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1);
  });
});

// ── corpo que termina depois de travar, em qualquer rota que escreve ────────────
/** Manda o começo do corpo, deixa o tempo passar (+61 s no relógio do teste) e só então termina. */
function corpoLento(s, p, metodo, caminho, comeco, fim, tipo) {
  const cookie = `dgclaw_sessao=${p.jar.dgclaw_sessao}; dgclaw_aparelho=${p.jar.dgclaw_aparelho}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: caminho, method: metodo, headers: { Host: `localhost:${s.t.porta}`, Origin: p.origem, 'Content-Type': tipo || 'application/json', Cookie: cookie } }, (res) => {
      const partes = []; res.on('data', (x) => partes.push(x)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString() }));
    });
    req.on('error', reject);
    req.write(comeco);
    setTimeout(() => { s.relogio.t += 61 * 1000; req.end(fim); }, 100);
  });
}

test('mensagem ao agente cujo corpo termina depois de a tela travar: 423 e nada é entregue (send, upload e permissão)', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 1 } })).status, 200);
    s.relogio.t += 20 * 1000;
    const envio = await corpoLento(s, d, 'POST', '/api/v1/agents/ana/send', '{"text":"apaga tudo', ' agora"}');
    assert.equal(envio.status, 423, envio.texto);
    assert.equal(JSON.parse(envio.texto).travado, true);
    assert.equal(s.rAna.rec.inputs.length, 0, 'nenhuma entrega ao agente');
    assert.equal((await d.destrava(ap)).status, 200);
    s.relogio.t += 20 * 1000;
    const perm = await corpoLento(s, d, 'POST', '/api/v1/agents/ana/permissao', '{"decisao":', '"allow"}');
    assert.equal(perm.status, 423, perm.texto);
    assert.deepEqual(s.rAna.rec.permissoes, []);
    assert.equal((await d.destrava(ap)).status, 200);
    s.relogio.t += 20 * 1000;
    const limite = '----limite';
    const corpo = `--${limite}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nconteudo\r\n--${limite}--\r\n`;
    const up = await corpoLento(s, d, 'POST', '/api/v1/agents/ana/upload', corpo.slice(0, 40), corpo.slice(40), `multipart/form-data; boundary=${limite}`);
    assert.equal(up.status, 423, up.texto);
    assert.equal(s.rAna.rec.inputs.length, 0);
    // sem pressa (destravada o tempo todo) a mesma mensagem passa
    assert.equal((await d.destrava(ap)).status, 200);
    const ok = await d.post('/api/v1/agents/ana/send', { text: 'oi' });
    assert.notEqual(ok.status, 423);
  });
});

test('escrita pelo proxy /p/: dono com Face ID tem o corpo lido antes e 423 se travou; sem Face ID nada muda', async () => {
  const s = await cenarioWs();
  try {
    const d = pessoa(s);
    await d.login('dono', s.t.senha);
    // sem Face ID: o corpo segue direto ao painel, como sempre
    const livre = await corpoLento(s, d, 'POST', '/p/ana/api/rotinas', '{"a":', '1}');
    assert.equal(livre.status, 200);
    assert.equal(s.painel.pedidos.length, 1);
    // com Face ID
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 1 } })).status, 200);
    s.relogio.t += 20 * 1000;
    const antes = s.painel.pedidos.length;
    const r = await corpoLento(s, d, 'POST', '/p/ana/api/rotinas', '{"a":', '1}');
    assert.equal(r.status, 423, r.texto);
    assert.equal(JSON.parse(r.texto).travado, true);
    assert.equal(s.painel.pedidos.length, antes, 'o painel não recebeu nada');
    // destravada: passa pelo proxy normalmente
    assert.equal((await d.destrava(ap)).status, 200);
    const ok = await d.post('/p/ana/api/rotinas', { a: 1 });
    assert.equal(ok.status, 200);
    assert.equal(s.painel.pedidos.length, antes + 1);
  } finally { await s.fechar(); }
});

test('marca pendente (só na memória) nunca vale como gravada: a verificação regrava e exige sucesso antes de destravar', async () => {
  const dados = pastaTemp('cad-pend');
  const relogio = { t: Date.now() };
  const t = comTelas(await subirWeb({ opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  try {
    const d = pessoa({ t });
    await d.login('dono', t.senha);
    const ap = aparelhoFalso();
    assert.equal((await d.cadastra(ap, 'iPhone')).status, 201);
    // outra sessão do dono, sem cookie, que passa a trazer o cookie num momento em que o sessoes.json não grava
    const b = pessoa({ t });
    await b.login('dono', t.senha);
    b.jar.dgclaw_aparelho = d.jar.dgclaw_aparelho;
    const tmp = path.join(dados, `sessoes.json.${process.pid}.tmp`);
    fs.mkdirSync(tmp);
    assert.equal((await b.get('/api/v1/agents')).status, 423);
    const hash = shaHex(b.jar.dgclaw_sessao);
    assert.equal(t.web.auth.leCadeado(hash).pendente, true, 'a marca existe só na memória');
    const falha = await b.destrava(ap);
    assert.equal(falha.status, 500, falha.texto); assert.equal(falha.json.motivo, 'arquivo');
    assert.equal((await b.get('/api/v1/agents')).status, 423, 'continua travada');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8')).sessoes[hash].cadeado_exige, undefined, 'e o arquivo não tem a marca');
    // o disco volta: a verificação grava a marca e só então destrava
    fs.rmdirSync(tmp);
    assert.equal((await b.destrava(ap)).status, 200);
    assert.equal(t.web.auth.leCadeado(hash).pendente, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8')).sessoes[hash].cadeado_exige, true);
    assert.doesNotMatch(fs.readFileSync(path.join(dados, 'sessoes.json'), 'utf8'), /cadeado_pendente/);
    assert.notEqual((await b.get('/api/v1/agents')).status, 423);
  } finally { await t.fechar(); }
});

// ── sessão encerrada enquanto o corpo chegava ───────────────────────────────
/** Começa o corpo, roda `evento` (outra sessão fazendo algo) e só então termina o corpo. */
function corpoComEvento(s, p, metodo, caminho, comeco, fim, evento) {
  const cookie = `dgclaw_sessao=${p.jar.dgclaw_sessao}; dgclaw_aparelho=${p.jar.dgclaw_aparelho}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: caminho, method: metodo, headers: { Host: `localhost:${s.t.porta}`, Origin: p.origem, 'Content-Type': 'application/json', Cookie: cookie } }, (res) => {
      const partes = []; res.on('data', (x) => partes.push(x)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString() }));
    });
    req.on('error', reject);
    req.write(comeco);
    setTimeout(() => { Promise.resolve(evento()).then(() => req.end(fim), reject); }, 100);
  });
}

test('dono com Face ID: aparelho removido por outra sessão enquanto o corpo chega dá 401 e nada chega ao painel (/p/)', async () => {
  const s = await cenarioWs();
  try {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    const idCel = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const remove = async () => { assert.equal((await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`)).status, 200); };
    // pelo proxy /p/
    const antes = s.painel.pedidos.length;
    const viaPainel = await corpoComEvento(s, celular, 'POST', '/p/ana/api/rotinas', '{"a":', '1}', remove);
    assert.equal(viaPainel.status, 401, viaPainel.texto);
    assert.equal(s.painel.pedidos.length, antes, 'nada chegou ao painel');
  } finally { await s.fechar(); }
});

test('send com corpo incompleto e o aparelho removido por outra sessão: 401 e nada chega ao runner', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    const idCel = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const r = await corpoComEvento(s, celular, 'POST', '/api/v1/agents/ana/send', '{"text":"apaga', ' tudo"}', async () => {
      assert.equal((await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`)).status, 200);
    });
    assert.equal(r.status, 401, r.texto);
    assert.equal(s.rAna.rec.inputs.length, 0, 'nada foi entregue ao agente');
    assert.equal((await celular.get('/api/v1/agents')).status, 401);
    assert.notEqual((await pc.get('/api/v1/agents')).status, 401, 'a sessão de quem removeu segue');
  });
});

// ── contador gravado antes de destravar; só o 423 do cadeado cobre a tela ───────
test('verificação: se o contador não puder ser gravado, responde 500 e a sessão segue travada; com disco, destrava', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    const ap = aparelhoFalso();
    await d.cadastra(ap, 'iPhone');
    s.relogio.t += 20 * MIN;
    const original = fs.promises.writeFile;
    fs.promises.writeFile = async (alvo, ...resto) => {
      if (String(alvo).includes('passkeys.json')) throw Object.assign(new Error('sem espaço'), { code: 'ENOSPC' });
      return original(alvo, ...resto);
    };
    try {
      const r = await d.destrava(ap);
      assert.equal(r.status, 500, r.texto); assert.equal(r.json.motivo, 'arquivo');
      assert.equal((await d.get('/api/v1/agents')).status, 423, 'continua travada');
    } finally { fs.promises.writeFile = original; }
    // o contador em memória voltou ao que era: a mesma tentativa, agora com disco, passa e o contador sobe
    assert.equal((await d.destrava(ap)).status, 200);
    s.relogio.t += 20 * MIN;
    assert.equal((await d.destrava(ap, { contador: 1 })).status, 403, 'contador que volta continua recusado');
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(s.t.dados, 'passkeys.json'), 'utf8')).passkeys[0].sign_count, 0);
  });
});

test('trava.js: só o 423 com travado:true cobre a tela; outro 423 passa para a página', async () => {
  const vm = require('node:vm');
  const codigo = fs.readFileSync(path.join(PUBLICO_REAL, 'trava.js'), 'utf8');
  const elementos = {};
  const el = (id) => elementos[id] || (elementos[id] = {
    id, textContent: '', hidden: false, disabled: false, innerHTML: '', style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, setAttribute() {}, querySelector: (sel) => el(sel), blur() {},
  });
  const document = {
    readyState: 'complete', visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } }, activeElement: null,
    head: { appendChild() {} }, body: { appendChild() {}, hasAttribute: () => false },
    createElement: (tag) => el('novo-' + tag), addEventListener() {}, querySelectorAll: () => [],
  };
  const resp = (status, corpo) => { const r = { status, ok: status < 400, json: () => Promise.resolve(corpo), clone: () => resp(status, corpo) }; return r; };
  const janela = {
    document, console, URLSearchParams, Promise, Date, TypeError,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 5 }, location: { search: '', pathname: '/a/ana', host: 'x.com' },
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    fetch: (url) => Promise.resolve(
      url.endsWith('/estado') ? resp(200, { ok: true, ativo: false, travado: false, resta_s: null, trava_min: 15 })
        : url.includes('alheio') ? resp(423, { error: 'power_not_installed' })
          : url.includes('semjson') ? { status: 423, ok: false, clone: () => ({ json: () => Promise.reject(new SyntaxError('sem json')) }), json: () => Promise.reject(new SyntaxError('sem json')) }
            : resp(423, { ok: false, erro: 'travada', travado: true })),
  };
  janela.window = janela;
  vm.createContext(janela);
  vm.runInContext(codigo, janela, { filename: 'trava.js' });
  const vazio = () => new Promise((r) => setImmediate(r));
  await vazio(); await vazio();
  const lido = await janela.fetch('/api/painel/alheio');
  await vazio(); await vazio();
  assert.equal(lido.status, 423);
  assert.equal(await lido.json().then((d) => d.error), 'power_not_installed', 'quem pediu ainda lê o corpo original');
  await janela.fetch('/api/painel/semjson');
  await vazio(); await vazio();
  assert.equal(elementos['novo-div'], undefined, '423 alheio (ou sem JSON) não cobre a tela');
  await janela.fetch('/api/qualquer');
  await vazio(); await vazio();
  assert.equal(elementos['novo-div'].hidden, false, 'o 423 do cadeado cobre');
});

test('um 423 do painel repassado pelo proxy chega como o painel mandou, sem travado:true', async () => {
  const s = await cenarioWs();
  try {
    const d = pessoa(s);
    await d.login('dono', s.t.senha);
    const r = await d.get('/p/ana/api/poder-desligado');
    assert.equal(r.status, 423);
    assert.deepEqual(r.json, { error: 'power_not_installed' });
    // e o Face ID ligado nem o coloca na lista de quem trava: a pessoa continua usando
    await d.cadastra(aparelhoFalso(), 'iPhone');
    const r2 = await d.get('/p/ana/api/poder-desligado');
    assert.deepEqual(r2.json, { error: 'power_not_installed' });
  } finally { await s.fechar(); }
});

// ── corrida no upgrade e camada com hidden ───────────────────────────────────
/** Abre o WebSocket com um socket cru, para contar os bytes que chegam ao navegador. */
function upgradeCru(s, p, caminho) {
  const net = require('node:net');
  const sock = net.connect(s.t.porta, '127.0.0.1');
  const r = { bytes: 0, fechou: new Promise((res) => sock.on('close', () => res(true))) };
  sock.on('data', (d) => { r.bytes += d.length; });
  sock.on('error', () => {});
  sock.write([`GET ${caminho} HTTP/1.1`, `Host: localhost:${s.t.porta}`, `Origin: ${p.origem}`, 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Cookie: dgclaw_sessao=${p.jar.dgclaw_sessao}; dgclaw_aparelho=${p.jar.dgclaw_aparelho || ''}`, '', ''].join('\r\n'));
  r.socket = sock;
  return r;
}
const ate = async (cond, ms) => { const fim = Date.now() + (ms || 3000); while (!cond() && Date.now() < fim) await espera(20); };

test('upgrade: o 101 do painel chega depois de o aparelho ser removido, os dois sockets fecham e nenhum byte vai ao navegador', async () => {
  const s = await cenarioWs();
  try {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    const idCel = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const cru = upgradeCru(s, celular, '/p/ana/lento');
    await ate(() => s.painel.seguros.length === 1);
    assert.equal(s.painel.seguros.length, 1, 'o painel recebeu o upgrade e ainda não respondeu');
    assert.equal((await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`)).status, 200);
    s.painel.seguros[0](); // agora o painel manda o 101
    assert.equal(await Promise.race([cru.fechou, espera(2000).then(() => false)]), true, 'a conexão do navegador fechou');
    assert.equal(cru.bytes, 0, 'nenhum byte chegou ao navegador');
    assert.match(s.t.log.texto(), /enquanto o painel abria o WebSocket/);
  } finally { await s.fechar(); }
});

test('upgrade: dono sem Face ID e com sessão válida abre normalmente; a sessão encerrada derruba a conexão aberta', async () => {
  const s = await cenarioWs();
  try {
    const d = pessoa(s); await d.login('dono', s.t.senha);
    const cru = upgradeCru(s, d, '/p/ana/lento');
    await ate(() => s.painel.seguros.length === 1);
    s.painel.seguros[0]();
    await ate(() => cru.bytes > 0);
    assert.ok(cru.bytes > 0, 'o 101 chegou ao navegador');
    // sair encerra a sessão; a conferência de 30 s do proxy fecha a conexão
    assert.equal((await d.post('/sair')).status, 303);
    s.t.web.proxy.revalidar();
    assert.equal(await Promise.race([cru.fechou, espera(2000).then(() => false)]), true);
  } finally { await s.fechar(); }
});

test('trava.js: a camada tem a regra [hidden]{display:none!important} (display:flex vencia o atributo hidden)', () => {
  const codigo = fs.readFileSync(path.join(PUBLICO_REAL, 'trava.js'), 'utf8');
  assert.match(codigo, /#dgclawTrava\[hidden\]\{display:none!important\}/);
  assert.match(codigo, /raiz\.id = 'dgclawTrava'/);
});

// ── remoção na ordem certa, vários aparelhos por passkey e migração ──────────────
test('remoção com o disco falhando: 500, a passkey continua, repetir regrava e, depois de reiniciar, o cookie revogado não vale', async () => {
  const dados = pastaTemp('cad-rem-disco');
  const relogio = { t: Date.now() };
  const hash = gerarHash('senha-certa-123');
  const abre = async () => comTelas(await subirWeb({ env: { DGCLAW_PANEL_PASSWORD_HASH: hash }, opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  let t = await abre();
  try {
    const celular = pessoa({ t }); await celular.login('dono', t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa({ t }); await pc.login('dono', t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    const idCel = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const cookieCel = celular.jar.dgclaw_sessao;
    // 1) o disco não aceita o sessoes.json: nada de "removido"
    const origSync = fs.writeFileSync;
    fs.writeFileSync = (alvo, ...resto) => { if (String(alvo).includes('sessoes.json')) throw Object.assign(new Error('sem espaço'), { code: 'ENOSPC' }); return origSync(alvo, ...resto); };
    try {
      const r = await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`);
      assert.equal(r.status, 500, r.texto); assert.equal(r.json.motivo, 'arquivo'); assert.match(r.json.erro, /NÃO foi removida.*repita a remoção/);
    } finally { fs.writeFileSync = origSync; }
    assert.equal((await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 2, 'a passkey continua');
    // 2) repetir: regrava as sessões e remove
    const ok = await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`);
    assert.equal(ok.status, 200, ok.texto);
    assert.equal((await celular.get('/api/v1/agents')).status, 401);
    await t.web.cadeado.aguardar();
    await t.fechar();
    t = await abre();
    const depois = pessoa({ t });
    depois.jar.dgclaw_sessao = cookieCel;
    assert.equal((await depois.get('/api/v1/agents')).status, 401, 'depois do reinício o cookie revogado não vale');
  } finally { await t.fechar(); }
});

test('remoção: se a gravação da passkey falha depois das sessões, 500 diz que as sessões já caíram e repetir conclui', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    const idCel = (await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.find((p) => p.nome === 'celular').id;
    const original = fs.promises.writeFile;
    fs.promises.writeFile = async (alvo, ...resto) => { if (String(alvo).includes('passkeys.json')) throw Object.assign(new Error('sem espaço'), { code: 'ENOSPC' }); return original(alvo, ...resto); };
    try {
      const r = await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`);
      assert.equal(r.status, 500, r.texto); assert.match(r.json.erro, /sessões deste aparelho já foram encerradas.*repita a remoção/);
    } finally { fs.promises.writeFile = original; }
    assert.equal((await celular.get('/api/v1/agents')).status, 401, 'as sessões já tinham caído');
    assert.equal((await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 2, 'a passkey continua cadastrada');
    assert.equal((await pc.pedir('DELETE', `/api/v1/cadeado/passkeys/${idCel}`)).status, 200);
    assert.equal((await pc.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1);
  });
});

test('migração: o campo antigo aparelho_hash vira a lista aparelhos na leitura, sem perder o aparelho', async () => {
  const dados = pastaTemp('cad-migra');
  const relogio = { t: Date.now() };
  const hash = gerarHash('senha-certa-123');
  const abre = async () => comTelas(await subirWeb({ env: { DGCLAW_PANEL_PASSWORD_HASH: hash }, opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  let t = await abre();
  const d = pessoa({ t }); await d.login('dono', t.senha);
  assert.equal((await d.cadastra(aparelhoFalso(), 'iPhone')).status, 201);
  const cookie = d.jar.dgclaw_aparelho;
  await t.web.cadeado.aguardar(); await t.fechar();
  const arq = path.join(dados, 'passkeys.json');
  const doc = JSON.parse(fs.readFileSync(arq, 'utf8'));
  doc.passkeys[0].aparelho_hash = doc.passkeys[0].aparelhos[0]; delete doc.passkeys[0].aparelhos; // formato antigo
  fs.writeFileSync(arq, JSON.stringify(doc));
  t = await abre();
  try {
    const novo = pessoa({ t });
    novo.jar.dgclaw_aparelho = cookie;
    await novo.login('dono', t.senha);
    const est = (await novo.get('/api/v1/cadeado/estado')).json;
    assert.equal(est.aviso, null); assert.equal(est.ativo, true); assert.equal(est.neste_aparelho, true);
    relogio.t += 16 * MIN;
    assert.equal((await novo.get('/api/v1/agents')).status, 423);
    assert.equal(t.log.texto().includes('ilegível'), false);
  } finally { await t.fechar(); }
});

test('vincular: uma passkey existente passa a valer em outro aparelho; alheia é recusada; remover derruba os dois', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    const ap = aparelhoFalso();
    assert.equal((await celular.cadastra(ap, 'iPhone')).status, 201);
    // o Mac: outra sessão do dono, sem cookie, ainda sem cadeado
    const mac = pessoa(s); await mac.login('dono', s.t.senha);
    assert.equal((await mac.get('/api/v1/cadeado/estado')).json.neste_aparelho, false);
    // criar outra passkey no Mac é recusado pelo aparelho (iCloud); o caminho é vincular
    const op = await mac.get('/api/v1/cadeado/aparelho/opcoes');
    assert.equal(op.status, 200, op.texto);
    assert.equal(op.json.publicKey.allowCredentials.length, 1);
    const ruim = await mac.post('/api/v1/cadeado/aparelho', { credencial: ap.assina(op.json.publicKey, mac.origem, { assinaturaErrada: true }) });
    assert.equal(ruim.status, 403); assert.equal(ruim.json.motivo, 'assinatura');
    const op2 = await mac.get('/api/v1/cadeado/aparelho/opcoes');
    const r = await mac.post('/api/v1/cadeado/aparelho', { credencial: ap.assina(op2.json.publicKey, mac.origem) });
    assert.equal(r.status, 200, r.texto);
    const sc = [].concat(r.headers['set-cookie']).find((x) => x.startsWith('dgclaw_aparelho='));
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
    assert.notEqual(mac.jar.dgclaw_aparelho, celular.jar.dgclaw_aparelho, 'cookie próprio do Mac');
    assert.equal(r.json.estado.ativo, true); assert.equal(r.json.estado.neste_aparelho, true);
    assert.equal(r.json.passkey.este_aparelho, true);
    assert.equal((await mac.get('/api/v1/cadeado/passkeys')).json.passkeys.length, 1, 'nenhuma passkey nova');
    // o Mac passou a travar, com e sem o cookie; o desafio de "aparelho" não serve para destravar
    s.relogio.t += 16 * MIN;
    assert.equal((await mac.get('/api/v1/agents')).status, 423);
    delete mac.jar.dgclaw_aparelho;
    assert.equal((await mac.get('/api/v1/agents')).status, 423);
    assert.equal((await mac.post('/api/v1/cadeado/aparelho', {})).status, 423, 'travada não vincula');
    mac.jar.dgclaw_aparelho = sc.split(';')[0].split('=')[1];
    assert.equal((await mac.destrava(ap)).status, 200);
    // uma passkey de OUTRA pessoa não liga o aparelho
    const col = await colaboradorAtivo(s);
    const m = pessoa(s); m.jar.dgclaw_sessao = col.c.jar.dgclaw_sessao;
    const apMaria = aparelhoFalso();
    assert.equal((await m.cadastra(apMaria, 'Celular da Maria')).status, 201);
    const outro = pessoa(s); await outro.login('dono', s.t.senha);
    const opO = await outro.get('/api/v1/cadeado/aparelho/opcoes');
    const alheia = await outro.post('/api/v1/cadeado/aparelho', { credencial: apMaria.assina(opO.json.publicKey, outro.origem) });
    assert.equal(alheia.status, 403); assert.equal(alheia.json.motivo, 'titular');
    assert.equal((await outro.get('/api/v1/cadeado/estado')).json.neste_aparelho, false);
    // o colaborador alcança as rotas novas (escopo)
    assert.equal((await m.get('/api/v1/cadeado/aparelho/opcoes')).status, 200);
    // remover a passkey, por uma terceira sessão do dono, derruba as sessões dos DOIS aparelhos
    const id = (await outro.get('/api/v1/cadeado/passkeys')).json.passkeys[0].id;
    const rem = await outro.pedir('DELETE', `/api/v1/cadeado/passkeys/${id}`);
    assert.equal(rem.status, 200, rem.texto); assert.equal(rem.json.sessoes_encerradas, 2);
    assert.equal((await celular.get('/api/v1/agents')).status, 401);
    assert.equal((await mac.get('/api/v1/agents')).status, 401);
    assert.notEqual((await outro.get('/api/v1/agents')).status, 401);
  });
});

// ── o instante em que a sessão trava é gravado no uso (vence) ────────────────────
test('vence: trava de 1 min, 2 min inativa, painel reinicia com o passkeys.json corrompido: continua 423 e a senha reabre', async () => {
  const dados = pastaTemp('cad-vence');
  const relogio = { t: Date.now() };
  const hash = gerarHash('senha-certa-123');
  const abre = async () => comTelas(await subirWeb({ env: { DGCLAW_PANEL_PASSWORD_HASH: hash }, opcoesServidor: { dataDir: dados, agora: () => relogio.t } }));
  let t = await abre();
  try {
    const d = pessoa({ t }); await d.login('dono', t.senha);
    assert.equal((await d.cadastra(aparelhoFalso(), 'iPhone')).status, 201);
    assert.equal((await d.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 1 } })).status, 200);
    const cookieAp = d.jar.dgclaw_aparelho; const sessao = d.jar.dgclaw_sessao;
    relogio.t += 2 * MIN;
    assert.equal((await d.get('/api/v1/lembretes')).status, 423);
    await t.web.cadeado.aguardar(); await t.fechar();
    fs.writeFileSync(path.join(dados, 'passkeys.json'), '{"passkeys": [oops'); // os ajustes (1 min) se perdem junto
    t = await abre();
    const volta = pessoa({ t });
    volta.jar.dgclaw_sessao = sessao;
    assert.equal((await volta.get('/api/v1/lembretes')).status, 423, 'o bloqueio já vencido não se desfaz');
    // a senha continua reabrindo: a sessão nova nasce destravada
    const nova = pessoa({ t });
    nova.jar.dgclaw_aparelho = cookieAp;
    await nova.login('dono', t.senha);
    assert.notEqual((await nova.get('/api/v1/lembretes')).status, 423);
  } finally { await t.fechar(); }
});

test('vence: o celular já vencido não é destravado quando o computador aumenta o tempo; só Face ID ou senha reabrem', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    const apCel = aparelhoFalso(); assert.equal((await celular.cadastra(apCel, 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    const apPc = aparelhoFalso(); assert.equal((await pc.cadastra(apPc, 'computador')).status, 201);
    s.relogio.t += 20 * MIN; // os dois passam dos 15 min
    assert.equal((await celular.get('/api/v1/lembretes')).status, 423);
    assert.equal((await pc.destrava(apPc)).status, 200);
    assert.equal((await pc.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 120 } })).status, 200);
    assert.equal((await celular.get('/api/v1/lembretes')).status, 423, 'aumentar o tempo não destrava ninguém');
    assert.equal((await celular.post('/api/v1/cadeado/uso')).status, 423, 'e o /uso de quem já venceu não renova');
    // o Face ID reabre, já com o tempo novo
    assert.equal((await celular.destrava(apCel)).status, 200);
    assert.ok((await celular.get('/api/v1/cadeado/estado')).json.resta_s > 119 * 60);
    s.relogio.t += 100 * MIN;
    assert.notEqual((await celular.get('/api/v1/lembretes')).status, 423);
  });
});

test('vence: a sessão em uso ganha o prazo novo no próximo /uso (aumentar ou diminuir)', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const celular = pessoa(s); await celular.login('dono', s.t.senha);
    assert.equal((await celular.cadastra(aparelhoFalso(), 'celular')).status, 201);
    const pc = pessoa(s); await pc.login('dono', s.t.senha);
    assert.equal((await pc.cadastra(aparelhoFalso(), 'computador')).status, 201);
    s.relogio.t += 5 * MIN;
    assert.equal((await pc.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 120 } })).status, 200);
    // antes do próximo uso, o celular segue com o prazo antigo (15 min contados do cadastro)
    assert.ok((await celular.get('/api/v1/cadeado/estado')).json.resta_s <= 10 * 60);
    const u = await celular.post('/api/v1/cadeado/uso');
    assert.ok(u.json.resta_s > 119 * 60, 'o próximo uso aplica o tempo novo');
    s.relogio.t += 100 * MIN;
    assert.notEqual((await celular.get('/api/v1/lembretes')).status, 423);
    // diminuir também vale a partir do próximo uso
    assert.equal((await pc.pedir('PUT', '/api/v1/cadeado/ajustes', { json: { trava_min: 2 } })).status, 200);
    assert.notEqual((await celular.get('/api/v1/lembretes')).status, 423, 'ninguém é travado de repente');
    await celular.post('/api/v1/cadeado/uso');
    s.relogio.t += 3 * MIN;
    assert.equal((await celular.get('/api/v1/lembretes')).status, 423);
  });
});
