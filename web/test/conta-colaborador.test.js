'use strict';
// Conta de IA conectada pelo colaborador (web/lib/conta-colaborador.js): quando pode, corrida, vazamento, expiração.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');

const LINK = 'https://claude.ai/oauth/authorize?state=segredo-do-link-123';
const CODIGO_DISP = 'WXYZ-1234';
const SEM_CONTA = { status: 'errored', statusReason: 'runner:sem-login', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: false, motivo: 'sem_credencial' } } };
const COM_CONTA = { status: 'idle', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: true, email: 'conta-secreta@gmail.com' } } };
const MIN15 = 15 * 60 * 1000;

/** O estado do runner tem cache de 2 s no relógio do Web: avança o relógio do cenário para o novo estado valer. */
function muda(s, opcoes) { Object.assign(s.rAna.opcoes, opcoes); s.relogio.t += 3000; }
const naoVazou = (texto) => assert.ok(!/segredo-do-link|claude\.ai|WXYZ|conta-secreta|"auth"|"conferido"/.test(texto), `vazou: ${texto}`);
const LOGIN = '/api/v1/agents/ana/login';

async function comColab(opcoes, fn) {
  const s = await cenario({ runnerAna: Object.assign({}, SEM_CONTA, opcoes || {}) });
  try { const x = await colaboradorAtivo(s); await fn(s, x); } finally { await s.fechar(); }
}

test('GET com conta: só { ok, conectado, precisa_login, provedor }, sem conferido, e-mail da conta, auth, link ou código', async () => {
  await comColab(COM_CONTA, async (s, x) => {
    s.rAna.opcoes.login = { estado: 'aguardando_codigo', link: LINK, codigoDispositivo: CODIGO_DISP };
    const r = await x.c.get(LOGIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, conectado: true, precisa_login: false, provedor: 'claude' });
    naoVazou(r.texto);
    const dono = await s.dono.get(LOGIN);
    assert.equal(dono.json.conferido.email, 'conta-secreta@gmail.com', 'o dono continua vendo tudo');
  });
});

test('agente com conta: o colaborador não consegue começar, mandar código, cancelar nem o oi; o runner não é tocado', async () => {
  await comColab(COM_CONTA, async (s, x) => {
    const posta = await x.c.post(LOGIN, { json: {} });
    assert.equal(posta.status, 409); assert.match(posta.json.erro, /já está conectado/);
    const cod = await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    assert.equal(cod.status, 403);
    assert.equal((await x.c.pedir('DELETE', LOGIN)).status, 403);
    assert.equal((await x.c.post(LOGIN + '/oi', { json: {} })).status, 403);
    assert.equal(s.rAna.rec.loginPosts, 0); assert.equal(s.rAna.rec.loginDeletes, 0); assert.deepEqual(s.rAna.rec.codigos, []);
    assert.equal(s.rAna.rec.inputs.length, 0, 'nenhum oi chegou ao agente');
  });
});

test('sem conta: o colaborador começa, vê o link dele, manda o código, e o GET registra quem conectou', async () => {
  await comColab({}, async (s, x) => {
    const antes = await x.c.get(LOGIN);
    assert.equal(antes.status, 200);
    assert.deepEqual(Object.keys(antes.json).sort(), ['conectado', 'estado', 'ok', 'precisa_login', 'provedor']);
    assert.equal(antes.json.precisa_login, true);
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 202, p.texto);
    assert.deepEqual(Object.keys(p.json).sort(), ['estado', 'ok']);
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK, auth: 'x', conferido: { ok: true } } });
    const g = await x.c.get(LOGIN);
    assert.equal(g.json.link, LINK, 'a reserva é dele: o link aparece');
    assert.equal(g.json.auth, undefined); assert.equal(g.json.conferido, undefined);
    const c = await x.c.post(LOGIN + '/codigo', { json: { codigo: 'codigo-bom-1' } });
    assert.equal(c.status, 200, c.texto);
    assert.deepEqual(s.rAna.rec.codigos, ['codigo-bom-1']);
    // a conta entra
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    const fim = await x.c.get(LOGIN);
    assert.deepEqual(fim.json, { ok: true, conectado: true, precisa_login: false, provedor: 'claude' });
    const arq = path.join(s.t.dados, 'conta-agentes.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    const reg = JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana;
    assert.equal(reg.por, 'colaborador'); assert.equal(reg.email, 'maria@x.com'); assert.equal(reg.colaborador_id, x.id); assert.ok(reg.instancia);
    const log = s.t.log.texto();
    assert.match(log, /Conta de IA do agente ana conectada por maria@x\.com \(colaborador\)/);
    assert.ok(!log.includes('segredo-do-link') && !log.includes('codigo-bom-1'), 'link e código não vão para o log');
    // o oi sai para quem conectou
    assert.equal((await x.c.post(LOGIN + '/oi', { json: {} })).status, 200);
  });
});

test('corrida: o dono começa primeiro e o colaborador recebe 409 sem ver o link; o inverso também', async () => {
  await comColab({}, async (s, x) => {
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202);
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    const g = await x.c.get(LOGIN);
    assert.equal(g.json.ocupado, true); assert.equal(g.json.link, undefined); naoVazou(g.texto);
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 409); assert.match(p.json.erro, /Outra pessoa está conectando/);
    assert.equal((await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc' } })).status, 409);
    assert.equal((await x.c.pedir('DELETE', LOGIN)).status, 403, 'não cancela o login de outra pessoa');
    assert.equal(s.rAna.rec.loginPosts, 1); assert.deepEqual(s.rAna.rec.codigos, []);
    assert.equal((await s.dono.get(LOGIN)).json.link, LINK, 'o dono vê o dele');
  });
  await comColab({}, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202);
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    const dono = await s.dono.post(LOGIN, { json: {} });
    assert.equal(dono.status, 409); assert.match(dono.json.erro, /maria@x\.com/);
    const verDono = await s.dono.get(LOGIN);
    assert.equal(verDono.json.login_de, 'colaborador'); assert.equal(verDono.json.login_de_email, 'maria@x.com');
    assert.equal(verDono.json.link, undefined); assert.ok(!verDono.texto.includes('segredo-do-link'));
    assert.equal((await s.dono.post(LOGIN + '/codigo', { json: { codigo: 'abc' } })).status, 409, 'o código do dono não completa o login dele');
    const cancela = await s.dono.pedir('DELETE', LOGIN);
    assert.equal(cancela.status, 200, 'o dono pode cancelar');
    assert.equal(s.rAna.rec.loginDeletes, 1);
    assert.equal((await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc' } })).status, 403, 'sem reserva, o colaborador não manda código');
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202, 'e o dono pode começar');
  });
});

test('corrida: dois pedidos ao mesmo tempo, um só chega ao runner', async () => {
  await comColab({}, async (s, x) => {
    const [a, b] = await Promise.all([x.c.post(LOGIN, { json: {} }), s.dono.post(LOGIN, { json: {} })]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    assert.equal(s.rAna.rec.loginPosts, 1);
  });
});

test('a reserva vence em 15 minutos e solta o agente', async () => {
  await comColab({}, async (s, x) => {
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202);
    s.relogio.t += MIN15 - 1000;
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 409, 'ainda dentro dos 15 minutos');
    s.relogio.t += 2000;
    s.rAna.opcoes.login = { estado: 'nenhum' };
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202, 'depois de 15 minutos a reserva do dono venceu');
    assert.match(s.t.log.texto(), /reserva de login do agente ana .* venceu/);
  });
});

test('código com a conta já conectada no meio: 409 e nada vai ao runner', async () => {
  await comColab({}, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202);
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'aguardando_codigo', link: LINK } })); // o dono conectou por fora
    const c = await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc' } });
    assert.equal(c.status, 409); assert.match(c.json.erro, /já está conectado/);
    assert.deepEqual(s.rAna.rec.codigos, []);
    // a reserva soltou: nenhum registro foi gravado, a conta conta como do dono
    assert.equal(fs.existsSync(path.join(s.t.dados, 'conta-agentes.json')), false);
  });
});

test('login expirado: só é dele se foi ele quem conectou; senão o dono reconecta', async () => {
  const EXPIRADO = { status: 'errored', statusReason: 'runner:login-expirado', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: false } } };
  await comColab(EXPIRADO, async (s, x) => {
    const g = await x.c.get(LOGIN);
    assert.equal(g.json.so_dono, true); assert.equal(g.json.precisa_login, false);
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 409); assert.match(p.json.erro, /só o dono do DG Claw reconecta/);
    assert.equal(s.rAna.rec.loginPosts, 0);
  });
  await comColab({}, async (s, x) => {
    // ele conecta (registro dele) e depois a conta expira
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    muda(s, Object.assign({}, EXPIRADO, { login: { estado: 'nenhum' } }));
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 202, p.texto);
  });
});

test('na dúvida recusa: runner sem provedor, chave de API e estado ambíguo', async () => {
  await comColab({ provedor: null }, async (s, x) => {
    for (const r of [await x.c.get(LOGIN), await x.c.post(LOGIN, { json: {} })]) { assert.equal(r.status, 503); assert.match(r.json.erro, /Não consegui confirmar/); }
    assert.equal(s.rAna.rec.loginPosts, 0);
  });
  await comColab({ provedor: { provedor: 'claude', auth: 'api', conferido: { ok: false } } }, async (s, x) => {
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 409); assert.match(p.json.erro, /chave de API/);
    assert.equal((await x.c.get(LOGIN)).json.chave_api, true);
  });
  await comColab({ status: 'idle', provedor: { provedor: 'claude', auth: 'assinatura', conferido: null } }, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 503, 'conferido nulo');
  });
  await comColab({ falhaEstado: true }, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 503, 'estado do runner indisponível');
    assert.equal(s.rAna.rec.loginPosts, 0);
  });
});

test('o painel continua sem a conta de IA: /p/<dele>/api/provedor* é 403 em qualquer método', async () => {
  await comColab({}, async (s, x) => {
    for (const m of ['GET', 'POST', 'DELETE']) for (const p of ['/p/ana/api/provedor', '/p/ana/api/provedor/login', '/p/ana/api/provedor/login/codigo']) {
      assert.equal((await x.c.pedir(m, p, m === 'GET' ? {} : { json: {} })).status, 403, `${m} ${p}`);
    }
  });
});

test('cancelar a própria reserva funciona; colaborador sem reserva recebe 403', async () => {
  await comColab({}, async (s, x) => {
    assert.equal((await x.c.pedir('DELETE', LOGIN)).status, 403);
    await x.c.post(LOGIN, { json: {} });
    assert.equal((await x.c.pedir('DELETE', LOGIN)).status, 200);
    assert.equal(s.rAna.rec.loginDeletes, 1);
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202, 'a reserva foi solta');
  });
});

test('outro agente: o colaborador da ana não chega ao login do bob', async () => {
  await comColab({}, async (s, x) => {
    for (const [m, p] of [['GET', '/api/v1/agents/bob/login'], ['POST', '/api/v1/agents/bob/login'], ['POST', '/api/v1/agents/bob/login/codigo'], ['DELETE', '/api/v1/agents/bob/login']]) {
      assert.equal((await x.c.pedir(m, p, m === 'GET' ? {} : { json: { codigo: 'a' } })).status, 403, `${m} ${p}`);
    }
    assert.equal(s.rBob.rec.loginPosts, 0);
  });
});

test('revogar quem conectou a conta: a conta fica, o log e a resposta avisam o dono', async () => {
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    const r = await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`);
    assert.equal(r.status, 200); assert.deepEqual(r.json.contas_de_ia, ['ana']);
    assert.match(s.t.log.texto(), /maria@x\.com conectou, ou deixou em andamento, a conta de IA do agente ana/);
    assert.equal(s.rAna.rec.loginDeletes, 0, 'não desconecta sozinho');
  });
});

function enviaEmPartes(porta, cookie, caminho, corpo, aoMeio) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'POST', path: caminho, headers: {
      Cookie: cookie, Origin: `http://127.0.0.1:${porta}`, 'Content-Type': 'application/json', 'Content-Length': corpo.length } }, (res) => {
      const partes = []; res.on('data', (d) => partes.push(d)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(corpo.subarray(0, 2));
    setTimeout(async () => { try { await aoMeio(); req.end(corpo.subarray(2)); } catch (e) { reject(e); } }, 100);
  });
}
const cookieDe = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');

test('colaborador revogado no meio do corpo não começa nem manda código', async () => {
  await comColab({}, async (s, x) => {
    const r = await enviaEmPartes(s.t.porta, cookieDe(x.c), LOGIN, Buffer.from('{"provedor":"claude"}'), async () => { assert.equal((await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 200); });
    assert.equal(r.status, 401, r.texto);
    assert.equal(s.rAna.rec.loginPosts, 0);
  });
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    const r = await enviaEmPartes(s.t.porta, cookieDe(x.c), LOGIN + '/codigo', Buffer.from(JSON.stringify({ codigo: 'abc123' })), async () => { assert.equal((await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`)).status, 200); });
    assert.equal(r.status, 401, r.texto);
    assert.deepEqual(s.rAna.rec.codigos, []);
  });
});

test('registro durável de outra instância do agente não vale: agente recriado começa sem registro', async () => {
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    const arq = path.join(s.t.dados, 'conta-agentes.json');
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    j.agentes.ana.instancia = 'casa:0:1';
    fs.writeFileSync(arq, JSON.stringify(j));
    fs.utimesSync(arq, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // o Web relê quando o mtime muda
    muda(s, Object.assign({}, { status: 'errored', statusReason: 'runner:login-expirado', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: false } }, login: { estado: 'nenhum' } }));
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 409, 'expirado e o registro é de outra instância: só o dono');
  });
});

test('atividade: sem_login diz que ele pode conectar; login_expirado manda avisar o dono, sem link nem código', async () => {
  const lerAtividade = (porta, cookie) => new Promise((resolve) => {
    let txt = '';
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/api/v1/agents/ana/stream', headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8'); res.on('data', (d) => { txt += d; }); setTimeout(() => { req.destroy(); resolve(txt); }, 800);
    });
    req.on('error', () => undefined);
  });
  await comColab({ erroEstado: `abra ${LINK}`, motivo: `abra ${LINK}` }, async (s, x) => {
    const txt = await lerAtividade(s.t.porta, cookieDe(x.c));
    assert.match(txt, /sem_login/); assert.match(txt, /Conectar conta/); naoVazou(txt);
  });
  await comColab({ status: 'errored', statusReason: 'runner:login-expirado', motivo: `abra ${LINK}` }, async (s, x) => {
    const txt = await lerAtividade(s.t.porta, cookieDe(x.c));
    assert.match(txt, /login_expirado/); assert.match(txt, /Avise o dono/); naoVazou(txt);
  });
});

test('conta conectada pelo dono é registrada como do dono e vale por cima da do colaborador', async () => {
  await comColab({}, async (s, x) => {
    // o colaborador conecta primeiro
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    const arq = path.join(s.t.dados, 'conta-agentes.json');
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana.por, 'colaborador');
    // o dono troca a conta: começa, manda o código, a conta aparece
    muda(s, Object.assign({}, SEM_CONTA, { login: { estado: 'nenhum' } }));
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202);
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    assert.equal((await s.dono.post(LOGIN + '/codigo', { json: { codigo: 'codigo-do-dono' } })).status, 200);
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await s.dono.get(LOGIN);
    const reg = JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana;
    assert.equal(reg.por, 'dono'); assert.equal(reg.colaborador_id, null);
    assert.match(s.t.log.texto(), /Conta de IA do agente ana conectada por dono \(dono\)/);
    assert.ok(!s.t.log.texto().includes('codigo-do-dono'));
    // agora a conta expirou: não é mais dele
    muda(s, { status: 'errored', statusReason: 'runner:login-expirado', provedor: { provedor: 'claude', auth: 'assinatura', conferido: { ok: false } }, login: { estado: 'nenhum' } });
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 409);
  });
});

// ── correções da revisão do Codex ──
test('conferido falho por tempo, ilegível ou sem o campo `motivo` (runner antigo) é dúvida: recusa, Claude e Codex', async () => {
  for (const provedor of ['claude', 'codex']) {
    for (const conferido of [{ ok: false, motivo: 'tempo' }, { ok: false, motivo: 'ilegivel' }, { ok: false, motivo: 'metodo_diferente' }, { ok: false }, { ok: false, motivo: 'sem_binario' }]) {
      await comColab({ status: 'idle', provedor: { provedor, auth: 'assinatura', conferido } }, async (s, x) => {
        const g = await x.c.get(LOGIN);
        const p = await x.c.post(LOGIN, { json: {} });
        assert.ok([503, 409].includes(p.status) && g.status === 503, `${provedor} ${JSON.stringify(conferido)}: GET ${g.status} POST ${p.status}`);
        assert.equal(s.rAna.rec.loginPosts, 0);
        assert.equal((await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc' } })).status, 403);
        assert.deepEqual(s.rAna.rec.codigos, []);
      });
    }
  }
});

test('só motivo sem_credencial libera o colaborador (e a reconferência antes de iniciar pega a conta que apareceu)', async () => {
  await comColab({ status: 'idle', provedor: { provedor: 'codex', auth: 'assinatura', conferido: { ok: false, motivo: 'sem_credencial' } } }, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202);
  });
});

test('device-auth do dono com a credencial antiga ainda conectada: a reserva fica, e a conta nova sai como do dono', async () => {
  await comColab({}, async (s, x) => {
    // o colaborador conectou antes
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    const arq = path.join(s.t.dados, 'conta-agentes.json');
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana.por, 'colaborador');
    // o dono começa a trocar: a autoria antiga some na hora
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202);
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana, undefined, 'sem registro = conta do dono');
    // device-auth aguardando, credencial antiga ainda conectada: o GET não pode soltar a reserva
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'aguardando_navegador', link: LINK, codigoDispositivo: CODIGO_DISP } }));
    await s.dono.get(LOGIN); await s.dono.get(LOGIN);
    const g = await x.c.get(LOGIN);
    assert.equal(g.json.conectado, true); naoVazou(g.texto);
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await s.dono.get(LOGIN);
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana.por, 'dono');
    muda(s, { status: 'errored', statusReason: 'runner:login-expirado', login: { estado: 'nenhum' } });
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 409, 'o colaborador antigo não reconecta a conta nova do dono');
  });
});

test('a reserva do dono em device-auth não é solta pelo GET enquanto o login está em andamento', async () => {
  await comColab(COM_CONTA, async (s, x) => {
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202);
    muda(s, { login: { estado: 'aguardando_navegador', link: LINK } });
    await s.dono.get(LOGIN);
    // trocar a conta pelo colaborador exigiria reserva livre; aqui só confirma que a reserva do dono ainda existe
    muda(s, Object.assign({}, SEM_CONTA, { login: { estado: 'aguardando_navegador', link: LINK } }));
    const p = await x.c.post(LOGIN, { json: {} });
    assert.equal(p.status, 409); assert.match(p.json.erro, /Outra pessoa/);
  });
});

test('o dono começando o login pelo painel (/p/<slug>/api/provedor/login) apaga a autoria e respeita a reserva do colaborador', async () => {
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await x.c.get(LOGIN);
    const arq = path.join(s.t.dados, 'conta-agentes.json');
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana.por, 'colaborador');
    await s.dono.post('/p/ana/api/provedor/login', { json: {} });   // o painel de teste não existe: o efeito é o que importa
    assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).agentes.ana, undefined);
  });
  await comColab({}, async (s, x) => {
    assert.equal((await x.c.post(LOGIN, { json: {} })).status, 202);
    for (const [m, p] of [['POST', '/p/ana/api/provedor/login'], ['POST', '/p/ana/API/provedor/login/'], ['POST', '/p/ana/api/provedor/login/codigo']]) {
      const r = await s.dono.pedir(m, p, { json: { codigo: 'x' } });
      assert.equal(r.status, 409, `${p}: ${r.texto}`); assert.match(r.json.erro, /maria@x\.com/);
    }
    assert.equal((await s.dono.pedir('DELETE', '/p/ana/api/provedor/login')).status !== 409, true, 'o dono pode cancelar');
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202, 'depois do cancelamento a reserva é do dono');
  });
});

test('revogar com reserva cancela o login no runner uma vez, antes de soltar a reserva; /codigo depois é recusado', async () => {
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    const r = await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`);
    assert.equal(r.status, 200); assert.deepEqual(r.json.avisos, []); assert.deepEqual(r.json.contas_de_ia, []);
    assert.equal(s.rAna.rec.loginDeletes, 1);
    assert.equal((await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } })).status, 401);
    assert.deepEqual(s.rAna.rec.codigos, []);
    assert.equal((await s.dono.post(LOGIN, { json: {} })).status, 202, 'reserva solta');
  });
  // reenviar convite também derruba as sessões: mesma limpeza
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    const r = await s.dono.post(`/api/v1/colaboradores/${x.id}/reenviar`, { json: {} });
    assert.equal(r.status, 200); assert.deepEqual(r.json.avisos, []);
    assert.equal(s.rAna.rec.loginDeletes, 1);
  });
});

test('se o cancelamento falha, o dono é avisado e a conta que entrar depois fica registrada como de colaborador revogado', async () => {
  await comColab({}, async (s, x) => {
    await x.c.post(LOGIN, { json: {} });
    muda(s, { login: { estado: 'aguardando_codigo', link: LINK } });
    await x.c.post(LOGIN + '/codigo', { json: { codigo: 'abc123' } });
    s.rAna.opcoes.loginRecusa = { status: 500, corpo: { success: false, error: 'runner engasgou' } };
    const r = await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.avisos.length, 1); assert.match(r.json.avisos[0], /não consegui cancelar/i);
    assert.deepEqual(r.json.contas_de_ia, ['ana']);
    assert.match(s.t.log.texto(), /Não consegui cancelar o login pendente de maria@x\.com/);
    // a tentativa dele conclui mesmo assim
    s.rAna.opcoes.loginRecusa = null;
    muda(s, Object.assign({}, COM_CONTA, { login: { estado: 'concluido' } }));
    await s.dono.get(LOGIN);
    const reg = JSON.parse(fs.readFileSync(path.join(s.t.dados, 'conta-agentes.json'), 'utf8')).agentes.ana;
    assert.equal(reg.por, 'colaborador'); assert.equal(reg.revogado, true);
    assert.match(s.t.log.texto(), /depois de o acesso dele ser revogado/);
  });
});
