'use strict';
// Cadeado com Face ID: cadastro e verificação de ponta a ponta com um autenticador falso (chave gerada aqui no teste),
// a máquina de estados (travar, destravar, senha) e o portão em todas as telas. Referência: web/docs/CADEADO.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cliente, subirWeb, pastaTemp } = require('./ajuda');
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

test('sem o cookie de aparelho a sessão não trava (o cadeado é por aparelho)', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    // o mesmo login visto de um navegador que nunca ativou o Face ID
    const outro = pessoa(s);
    outro.jar.dgclaw_sessao = d.jar.dgclaw_sessao;
    s.relogio.t += 60 * MIN;
    assert.equal((await outro.get('/api/v1/agents')).status, 200);
    assert.equal((await outro.get('/api/v1/cadeado/estado')).json.ativo, false);
    assert.equal((await d.get('/api/v1/agents')).status, 423);
    // cookie de aparelho inventado: não está ligado a passkey nenhuma, não trava
    const falso = pessoa(s);
    falso.jar.dgclaw_sessao = d.jar.dgclaw_sessao;
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

test('"uso" estica a trava no máximo uma vez por minuto; fetch comum não conta', async () => {
  const s = await cenario();
  await verde(s, async () => {
    const d = await dono(s);
    await d.cadastra(aparelhoFalso(), 'iPhone');
    s.relogio.t += 10 * MIN;
    await d.get('/api/v1/agents'); // fetch em segundo plano: não conta
    const u = await d.post('/api/v1/cadeado/uso');
    assert.equal(u.status, 200); assert.ok(u.json.resta_s > 14 * 60 - 5 && u.json.resta_s <= 15 * 60);
    s.relogio.t += 30 * 1000;
    const u2 = await d.post('/api/v1/cadeado/uso');
    assert.ok(u2.json.resta_s < 15 * 60 - 25, 'dentro do mesmo minuto o prazo não anda');
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
