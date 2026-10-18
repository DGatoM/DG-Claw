'use strict';
// Auditoria externa: a corrente sai da VPS para um coletor HTTP ou um syslog (RFC 5425), com ponto de retomada,
// selo de hora em hora, alerta de atraso e detecção de corrente alterada. Coletor e syslog são falsos, locais.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { criarAuditoria } = require('../lib/auditoria');
const { criarProtecoes } = require('../lib/protecoes');
const { criarExterna, validarConfig, ALERTA_APOS_MS } = require('../lib/auditoria-externa');
const { cenarioEnt } = require('./ent-usuarios-ajuda');
const { pastaTemp, capturaLog } = require('./ajuda');

// Credencial de mentira, gerada na hora: nada de segredo escrito no arquivo.
const CREDENCIAL = `coletor-${crypto.randomBytes(12).toString('hex')}`;

function cenario(nivel) {
  const raiz = pastaTemp('ext');
  const etc = path.join(raiz, 'etc');
  const log = path.join(raiz, 'log');
  const dados = path.join(raiz, 'dados');
  for (const d of [etc, log, dados]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(etc, 'protecoes.json'), JSON.stringify({ versao: 1, nivel: nivel || 'regulado', ajustes: {} }));
  const cap = capturaLog();
  let agora = Date.parse('2026-10-18T12:00:00Z');
  const protecoes = criarProtecoes({ caminho: path.join(etc, 'protecoes.json'), log: cap.log });
  const base = path.join(log, 'auditoria.jsonl');
  const aud = criarAuditoria({ caminho: base, protecoes, log: cap.log, agora: () => agora });
  return {
    base, aud, cap, dados, etc, protecoes, ms: () => agora, avanca: (ms) => { agora += ms; }, ir: (iso) => { agora = Date.parse(iso); },
    caminhoConfig: path.join(etc, 'auditoria-externa.json'),
    externa: (extra) => criarExterna(Object.assign({ base, dataDir: dados, caminhoConfig: path.join(etc, 'auditoria-externa.json'), log: cap.log, agora: () => agora, aceitaSemTls: true, instalacao: 'vps-teste' }, extra)),
  };
}

/** Coletor HTTP falso. `modo.falha` = status de erro a devolver (null = aceita). */
async function coletor() {
  const recebidos = [];
  const modo = { falha: null };
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
      if (modo.falha) { res.writeHead(modo.falha); res.end('fora'); return; }
      recebidos.push({ corpo, auth: req.headers.authorization });
      res.writeHead(204); res.end();
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { recebidos, modo, url: `http://127.0.0.1:${servidor.address().port}/coletor`, fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }) };
}

/** Lê quadros "tamanho mensagem" (octet-counting) de um fluxo. */
function lerQuadros(buf) {
  const msgs = [];
  let i = 0;
  while (i < buf.length) {
    const esp = buf.indexOf(0x20, i);
    const n = Number(buf.slice(i, esp).toString());
    msgs.push(buf.slice(esp + 1, esp + 1 + n).toString('utf8'));
    i = esp + 1 + n;
  }
  return msgs;
}

async function syslogFalso(opcoesTls) {
  const quadros = [];
  const aceitar = (sock) => {
    const partes = [];
    sock.on('data', (d) => partes.push(d));
    sock.on('end', () => { quadros.push(...lerQuadros(Buffer.concat(partes))); sock.end(); });
    sock.on('error', () => sock.destroy());
  };
  const servidor = opcoesTls ? tls.createServer(opcoesTls, aceitar) : net.createServer(aceitar);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { quadros, porta: servidor.address().port, fechar: () => new Promise((r) => servidor.close(r)) };
}

const gravaConfig = (c, cfg) => fs.writeFileSync(c.caminhoConfig, JSON.stringify(cfg), { mode: 0o600 });

test('validarConfig: explica o que corrigir e nunca aceita texto aberto', () => {
  assert.throws(() => validarConfig({ tipo: 'ftp' }), /http ou syslog/);
  assert.throws(() => validarConfig({ tipo: 'http', url: 'http://siem.empresa.com/x' }), /https/);
  assert.throws(() => validarConfig({ tipo: 'http', url: 'isso não é url' }), /endereço válido/);
  assert.throws(() => validarConfig({ tipo: 'syslog' }), /host/);
  assert.throws(() => validarConfig({ tipo: 'syslog', host: 'logs.empresa.com', porta: 99999 }), /porta/);
  assert.throws(() => validarConfig({ tipo: 'syslog', host: 'logs.empresa.com', tls: false }), /sem TLS não é aceito/);
  assert.throws(() => validarConfig({ tipo: 'http', url: 'https://x.com', timeout_s: 500 }), /timeout_s/);
  assert.equal(validarConfig({ tipo: 'syslog', host: 'logs.empresa.com' }).porta, 6514);
  assert.equal(validarConfig({ tipo: 'syslog', host: 'logs.empresa.com' }).tls, true);
  assert.equal(validarConfig({ tipo: 'http', url: 'https://siem.empresa.com/c', token: CREDENCIAL }).token, CREDENCIAL);
});

test('HTTP: entrega em lotes com a credencial, recomeça do ponto certo e o status não a mostra', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url, token: CREDENCIAL });
    for (let i = 0; i < 250; i += 1) c.aud.registrar('evento', { i }, 'ana');
    const ext = c.externa();
    let r = await ext.enviar();
    assert.equal(r.enviadas, 250);
    assert.equal(col.recebidos.length, 3 + 1, 'três lotes de eventos e um selo');
    assert.ok(col.recebidos.every((x) => x.auth === `Bearer ${CREDENCIAL}`));
    const lote = col.recebidos[0].corpo;
    assert.equal(lote.tipo, 'auditoria');
    assert.equal(lote.eventos.length, 100);
    assert.equal(lote.brutas.length, 100);
    assert.deepEqual(JSON.parse(lote.brutas[0]), lote.eventos[0]);
    assert.equal(col.recebidos[3].corpo.tipo, 'selo');
    assert.match(col.recebidos[3].corpo.selo.hash, /^[0-9a-f]{64}$/);
    const todas = col.recebidos.slice(0, 3).flatMap((x) => x.corpo.brutas);
    assert.deepEqual(todas, fs.readFileSync(c.base, 'utf8').trim().split('\n'), 'todas as linhas, na ordem, sem repetir');

    const antes = col.recebidos.length;
    r = await ext.enviar();
    assert.equal(r.enviadas, 0);
    assert.equal(col.recebidos.length, antes, 'nada novo: não reenvia');

    c.aud.registrar('novo', {}, 'ana');
    r = await ext.enviar();
    assert.equal(r.enviadas, 1);
    assert.equal(col.recebidos[antes].corpo.brutas.length, 1);

    const st = ext.status();
    assert.equal(st.configurado, true);
    assert.equal(st.pendentes, 0);
    assert.equal(st.alerta, false);
    assert.equal(JSON.stringify(st).includes(CREDENCIAL), false);
    assert.equal(fs.readFileSync(ext.estadoPath, 'utf8').includes(CREDENCIAL), false);
    assert.equal(fs.statSync(ext.estadoPath).mode & 0o777, 0o600);
    assert.equal(c.cap.texto().includes(CREDENCIAL), false);
  } finally { await col.fechar(); }
});

test('HTTP fora do ar: nada se perde, o erro se explica, e ao voltar sai tudo uma vez', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url, token: CREDENCIAL });
    const ext = c.externa();
    c.aud.registrar('a', {}, 'ana');
    c.aud.registrar('b', {}, 'ana');
    col.modo.falha = 503;
    let r = await ext.enviar();
    assert.equal(r.enviadas, 0);
    assert.match(r.erro, /respondeu 503/);
    let st = ext.status();
    assert.equal(st.pendentes, 2);
    assert.equal(st.alerta, false, 'menos de 1 hora de atraso ainda não é alerta');
    assert.match(st.ultimo_erro, /503/);
    assert.equal(st.pendentes_desde, '2026-10-18T12:00:00.000Z');

    c.avanca(ALERTA_APOS_MS + 60 * 1000);
    r = await ext.enviar();
    st = ext.status();
    assert.equal(st.alerta, true, 'mais de 1 hora sem esvaziar é alerta');
    assert.equal(st.atraso_s > 3600, true);

    col.modo.falha = null;
    r = await ext.enviar();
    assert.equal(r.enviadas, 2);
    assert.equal(col.recebidos.filter((x) => x.corpo.tipo === 'auditoria').flatMap((x) => x.corpo.brutas).length, 2);
    st = ext.status();
    assert.equal(st.alerta, false);
    assert.equal(st.pendentes, 0);
    assert.equal(st.ultimo_erro, null);
  } finally { await col.fechar(); }
});

test('selo: uma vez por hora, só com tudo entregue, e leva o hash da última linha', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url });
    const ext = c.externa();
    const l1 = JSON.parse(c.aud.registrar('a', {}, 'ana'));
    await ext.enviar();
    const selos = () => col.recebidos.filter((x) => x.corpo.tipo === 'selo');
    assert.equal(selos().length, 1);
    assert.equal(selos()[0].corpo.selo.hash, l1.hash);
    c.avanca(30 * 60 * 1000);
    const l2 = JSON.parse(c.aud.registrar('b', {}, 'ana'));
    await ext.enviar();
    assert.equal(selos().length, 1, 'meia hora depois ainda não é hora de outro selo');
    c.avanca(31 * 60 * 1000);
    await ext.enviar();
    assert.equal(selos().length, 2);
    assert.equal(selos()[1].corpo.selo.hash, l2.hash, 'o selo novo cobre a linha nova');
    c.avanca(61 * 60 * 1000);
    c.aud.registrar('c', {}, 'ana');
    col.modo.falha = 500;
    await ext.enviar();
    col.modo.falha = null;
    assert.equal(selos().length, 2, 'com o coletor fora do ar não sai selo: ele cobriria linhas que o destino não tem');
    await ext.enviar();
    assert.equal(selos().length, 3);
  } finally { await col.fechar(); }
});

test('a corrente atravessa a virada do mês sem perder nem repetir linhas', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url });
    const ext = c.externa();
    c.ir('2026-10-30T10:00:00Z');
    c.aud.registrar('a', {}, 'ana'); c.aud.registrar('b', {}, 'ana');
    await ext.enviar();
    c.ir('2026-11-02T10:00:00Z');
    c.aud.registrar('c', {}, 'ana'); c.aud.registrar('d', {}, 'ana');
    assert.ok(fs.existsSync(path.join(path.dirname(c.base), 'auditoria-2026-10.jsonl')), 'o mês de outubro foi fechado');
    const r = await ext.enviar();
    assert.equal(r.enviadas, 2);
    const eventos = col.recebidos.filter((x) => x.corpo.tipo === 'auditoria').flatMap((x) => x.corpo.eventos.map((e) => e.evento));
    assert.deepEqual(eventos, ['a', 'b', 'c', 'd']);
  } finally { await col.fechar(); }
});

test('corrente alterada atrás do ponto já entregue: não envia nada novo e acusa', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url });
    const ext = c.externa();
    c.aud.registrar('a', {}, 'ana'); c.aud.registrar('b', {}, 'ana');
    await ext.enviar();
    const ls = fs.readFileSync(c.base, 'utf8').trim().split('\n');
    ls[1] = ls[1].replace('"evento":"b"', '"evento":"forjado"');
    fs.writeFileSync(c.base, `${ls.join('\n')}\n`);
    const r = await ext.enviar();
    assert.equal(r.enviadas, 0);
    assert.match(r.erro, /mudou atrás do ponto já entregue/);
    assert.match(r.erro, /dgclaw auditoria verificar/);
    const st = ext.status();
    assert.equal(st.corrente_alterada, true);
    assert.equal(st.alerta, true);
  } finally { await col.fechar(); }
});

test('sem destino configurado: o envio explica o que fazer e o status diz que não está configurado', async () => {
  const c = cenario();
  const ext = c.externa();
  c.aud.registrar('a', {}, 'ana');
  const r = await ext.enviar();
  assert.match(r.erro, /dgclaw auditoria externa configurar/);
  const st = ext.status();
  assert.equal(st.configurado, false);
  assert.equal(st.alerta, false);
  await assert.rejects(() => ext.testar(), /Falta o destino externo/);
});

test('testar: manda uma mensagem de teste que não entra na corrente', async () => {
  const c = cenario();
  const col = await coletor();
  try {
    gravaConfig(c, { tipo: 'http', url: col.url, token: CREDENCIAL });
    const ext = c.externa();
    const r = await ext.testar();
    assert.equal(r.tipo, 'http');
    assert.equal(col.recebidos[0].corpo.tipo, 'teste');
    assert.equal(fs.existsSync(c.base), false, 'o teste não escreve na auditoria');
    gravaConfig(c, { tipo: 'http', url: 'http://127.0.0.1:1/x' });
    await assert.rejects(() => ext.testar(), /Não consegui entregar ao coletor/);
  } finally { await col.fechar(); }
});

test('syslog por TCP (laboratório): quadros RFC 5424 com contagem de octetos, SELO e linha original no corpo', async () => {
  const c = cenario();
  const sl = await syslogFalso();
  try {
    gravaConfig(c, { tipo: 'syslog', host: '127.0.0.1', porta: sl.porta, tls: false });
    const ext = c.externa();
    const l1 = JSON.parse(c.aud.registrar('login_ok', { texto: 'ação com acento e "aspas"' }, 'ana'));
    const l2 = c.aud.registrar('outro', {}, 'ana');
    const r = await ext.enviar();
    assert.equal(r.enviadas, 2);
    assert.equal(sl.quadros.length, 3);
    const m1 = /^<110>1 (\S+) vps-teste dgclaw - AUDITORIA \[dgclaw@32473 hash="([0-9a-f]{64})" evento="login_ok"\] (.*)$/s.exec(sl.quadros[0]);
    assert.ok(m1, sl.quadros[0]);
    assert.equal(m1[2], l1.hash);
    assert.equal(JSON.parse(m1[3]).dados.texto, 'ação com acento e "aspas"');
    assert.equal(sl.quadros[1].endsWith(l2), true, 'o corpo é a linha exatamente como foi escrita');
    assert.match(sl.quadros[2], / dgclaw - SELO \[dgclaw@32473 hash="[0-9a-f]{64}"\] \{"tipo":"selo"/);
    const t = await ext.testar();
    assert.equal(t.tipo, 'syslog');
    assert.match(sl.quadros[3], / TESTE /);
  } finally { await sl.fechar(); }
});

test('syslog: servidor fora do ar não perde nada', async () => {
  const c = cenario();
  gravaConfig(c, { tipo: 'syslog', host: '127.0.0.1', porta: 1, tls: false });
  const ext = c.externa();
  c.aud.registrar('a', {}, 'ana');
  const r = await ext.enviar();
  assert.equal(r.enviadas, 0);
  assert.match(r.erro, /Não consegui falar com o syslog 127\.0\.0\.1:1/);
  assert.equal(ext.status().pendentes, 1);
});

let temOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); } catch (_) { temOpenssl = false; }

test('syslog sobre TLS (RFC 5425): confere o certificado do servidor pela autoridade configurada', { skip: !temOpenssl && 'sem openssl nesta máquina' }, async () => {
  const c = cenario();
  const pasta = pastaTemp('tls');
  const chave = path.join(pasta, 'k.pem');
  const cert = path.join(pasta, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', chave, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
  const sl = await syslogFalso({ key: fs.readFileSync(chave), cert: fs.readFileSync(cert) });
  try {
    c.aud.registrar('a', {}, 'ana');
    // sem a autoridade: o certificado de mentira é recusado e nada é entregue
    gravaConfig(c, { tipo: 'syslog', host: 'localhost', porta: sl.porta });
    let r = await c.externa({ aceitaSemTls: false }).enviar();
    assert.equal(r.enviadas, 0);
    assert.match(r.erro, /Confira o certificado do servidor/);
    // com a autoridade certa: entrega
    gravaConfig(c, { tipo: 'syslog', host: 'localhost', porta: sl.porta, ca: cert });
    r = await c.externa({ aceitaSemTls: false }).enviar();
    assert.equal(r.enviadas, 1, r.erro);
    assert.equal(sl.quadros.length, 2);
  } finally { await sl.fechar(); }
});

test('no Web: com auditoria=externa o temporizador entrega a corrente e a API mostra o estado (só TI)', async () => {
  const col = await coletor();
  const c = await cenarioEnt({
    nivel: 'empresa', ajustes: { auditoria: 'externa' },
    opcoesServidor: { auditoriaExterna: { aceitaSemTls: true, intervaloMs: 40, primeiraMs: 0 } },
  });
  try {
    fs.writeFileSync(path.join(path.dirname(c.protecoesPath), 'auditoria-externa.json'), JSON.stringify({ tipo: 'http', url: col.url, token: CREDENCIAL }), { mode: 0o600 });
    fs.copyFileSync(path.join(__dirname, '../public/auditoria.html'), path.join(c.s.publico, 'auditoria.html'));
    const ti = (await c.entrar('dono', c.senhaTi)).cli;
    let st;
    for (let i = 0; i < 100; i += 1) {
      st = await ti.get('/api/v1/auditoria/externa');
      if (st.json && st.json.ultimo_envio_ok && st.json.pendentes === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.status, 200, st.texto);
    assert.equal(st.json.nivel, 'externa');
    assert.equal(st.json.configurado, true);
    assert.equal(st.json.pendentes, 0);
    assert.ok(col.recebidos.some((x) => x.corpo.tipo === 'auditoria'));
    assert.ok(col.recebidos.some((x) => x.corpo.tipo === 'selo'));
    assert.equal(JSON.stringify(st.json).includes(CREDENCIAL), false);
    const lista = await ti.get('/api/v1/auditoria');
    assert.equal(lista.json.externa.configurado, true);
    assert.equal(lista.json.integridade.ok, true);
  } finally { await c.fechar(); await col.fechar(); }
});
