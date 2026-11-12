'use strict';
// Colaborador de ponta a ponta: convite, login, troca de senha, isolamento, reenvio e revogação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cliente, pastaTemp } = require('./ajuda');

const { DIA, cenario, colaboradorAtivo } = require('./colab-ajuda');

test('convite: cria, devolve a senha temporária só ali, manda o e-mail e nunca devolve hash', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: ' Maria@X.com ', nome: 'Maria' });
    assert.equal(r.status, 201, r.texto);
    const cv = r.json.convite;
    assert.equal(cv.usuario, 'maria@x.com');
    assert.match(cv.senha_temporaria, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{12}$/);
    assert.equal(cv.email_enviado, true); assert.equal(cv.email_motivo, null);
    assert.match(cv.link, /^http:\/\/127\.0\.0\.1:\d+\/login\?usuario=maria%40x\.com$/);
    assert.ok(cv.texto.includes(cv.senha_temporaria) && cv.texto.includes('Ana') && cv.texto.includes(cv.link));
    assert.ok(cv.expira > Date.now() + 6.9 * DIA && cv.expira < Date.now() + 7.1 * DIA);
    assert.equal(r.json.colaborador.estado, 'aguardando_primeiro_acesso');
    assert.equal(s.enviados.length, 1); assert.equal(s.enviados[0].para, 'maria@x.com');
    assert.match(s.enviados[0].texto, new RegExp(cv.senha_temporaria));
    assert.doesNotMatch(r.texto.replace(cv.senha_temporaria, ''), /scrypt/);

    const lista = await s.dono.get('/api/v1/colaboradores');
    assert.equal(lista.status, 200);
    assert.equal(lista.json.colaboradores.length, 1);
    assert.ok(!lista.texto.includes('scrypt') && !lista.texto.includes('"hash"') && !lista.texto.includes(cv.senha_temporaria));
    assert.equal((await s.dono.get('/api/v1/colaboradores?agente=bob')).json.colaboradores.length, 0);

    const arq = path.join(s.t.dados, 'colaboradores.json');
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.ok(!s.t.log.texto().includes(cv.senha_temporaria), 'a senha temporária não pode ir para o log');
  } finally { await s.fechar(); }
});

test('convite: quando o e-mail não sai, a resposta diz por quê e traz o texto para copiar', async () => {
  const s = await cenario({ emailFalha: 'O servidor SMTP respondeu "535 5.7.8 Authentication failed".' });
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com' });
    assert.equal(r.status, 201);
    assert.equal(r.json.convite.email_enviado, false);
    assert.match(r.json.convite.email_motivo, /535/);
    assert.ok(r.json.convite.texto.includes(r.json.convite.senha_temporaria));
  } finally { await s.fechar(); }
});

test('convite: um colaborador por agente, um agente por colaborador, Admin e e-mail do dono recusados', async () => {
  const s = await cenario({ env: { DGCLAW_PANEL_USER: 'dono@x.com' } });
  try {
    assert.equal((await s.convida({ agente: 'ana', email: 'maria@x.com' })).status, 201);
    const outro = await s.convida({ agente: 'ana', email: 'joao@x.com' });
    assert.equal(outro.status, 409); assert.match(outro.json.erro, /já tem um colaborador ativo/);
    const mesmo = await s.convida({ agente: 'bob', email: 'MARIA@x.com' });
    assert.equal(mesmo.status, 409); assert.match(mesmo.json.erro, /agente ana/);
    const adm = await s.convida({ agente: 'admin', email: 'novo@x.com' });
    assert.equal(adm.status, 400); assert.match(adm.json.erro, /Admin nunca pode ser compartilhado/);
    assert.equal((await s.convida({ agente: 'fantasma', email: 'novo@x.com' })).status, 404);
    const dono = await s.convida({ agente: 'bob', email: 'Dono@X.com' });
    assert.equal(dono.status, 400); assert.match(dono.json.erro, /dono/);
    assert.equal((await s.convida({ agente: 'bob', email: 'sem-arroba' })).status, 400);
    assert.equal((await s.convida({ agente: 'bob', email: 'a@b.com\r\nBcc: x@y.com' })).status, 400);
    assert.equal((await s.convida({ agente: 'bob', email: 'a@b.com', nome: 'Maria <b>' })).status, 400);
    assert.equal((await s.convida({ agente: 'bob', email: 'a@b.com', nome: 'x'.repeat(81) })).status, 400);
    assert.equal((await s.convida({ email: 'a@b.com' })).status, 400);
  } finally { await s.fechar(); }
});

test('login do colaborador: temporária leva à troca, a API fica fechada até trocar, depois entra só no agente dele', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com', nome: 'Maria' });
    const temp = r.json.convite.senha_temporaria;
    const c = cliente(s.t.porta);
    const l = await c.post('/login', { json: { usuario: 'Maria@X.com', senha: temp } });
    assert.equal(l.status, 200); assert.equal(l.json.destino, '/trocar-senha');
    assert.ok((l.headers['set-cookie'] || []).some((x) => /^dgclaw_papel=colaborador/.test(x)));

    const eu = await c.get('/api/v1/eu');
    assert.deepEqual(eu.json, { ok: true, usuario: 'maria@x.com', papel: 'colaborador', agente: 'ana', nome: 'Maria', trocar_senha: true });
    const ag = await c.get('/api/v1/agents');
    assert.equal(ag.status, 403); assert.equal(ag.json.trocar_senha, true);
    assert.equal(ag.json.erro, 'Troque a senha temporária antes de continuar.');
    const pag = await c.get('/a/ana', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 302); assert.equal(pag.headers.location, '/trocar-senha');
    assert.equal((await c.get('/', { headers: { Accept: 'text/html' } })).headers.location, '/trocar-senha');

    // regras da senha nova
    const pedir = (j) => c.post('/api/v1/eu/senha', { json: j });
    assert.equal((await pedir({ nova: 'curta', confirmacao: 'curta' })).status, 400);
    assert.equal((await pedir({ nova: 'x'.repeat(129), confirmacao: 'x'.repeat(129) })).status, 400);
    assert.equal((await pedir({ nova: 'uma-senha-boa-1', confirmacao: 'outra-coisa-12' })).status, 400);
    const igual = await pedir({ nova: temp, confirmacao: temp });
    assert.equal(igual.status, 400); assert.match(igual.json.erro, /diferente da senha temporária/);

    const nova = 'uma-senha-boa-1';
    const ok = await pedir({ nova, confirmacao: nova });
    assert.equal(ok.status, 200); assert.equal(ok.json.destino, '/a/ana');

    assert.equal((await c.get('/a/ana', { headers: { Accept: 'text/html' } })).status, 200);
    const agentes = await c.get('/api/v1/agents');
    assert.equal(agentes.status, 200);
    assert.deepEqual(agentes.json.agentes.map((a) => a.id), ['ana']);
    assert.equal((await c.get('/api/v1/eu')).json.trocar_senha, false);

    // a senha temporária deixou de valer
    const outro = cliente(s.t.porta);
    assert.equal((await outro.post('/login', { json: { usuario: 'maria@x.com', senha: temp } })).status, 401);
    const novo = await outro.post('/login', { json: { usuario: 'maria@x.com', senha: nova } });
    assert.equal(novo.status, 200); assert.equal(novo.json.destino, '/a/ana');
    const lista = (await s.dono.get('/api/v1/colaboradores')).json.colaboradores[0];
    assert.equal(lista.estado, 'ativo'); assert.ok(lista.ultimo_login > 0);

    // trocar de novo exige a senha atual
    const sem = await outro.post('/api/v1/eu/senha', { json: { nova: 'terceira-senha-12', confirmacao: 'terceira-senha-12' } });
    assert.equal(sem.status, 400);
    const errada = await outro.post('/api/v1/eu/senha', { json: { atual: 'errada-errada', nova: 'terceira-senha-12', confirmacao: 'terceira-senha-12' } });
    assert.equal(errada.status, 403);
    const certa = await outro.post('/api/v1/eu/senha', { json: { atual: nova, nova: 'terceira-senha-12', confirmacao: 'terceira-senha-12' } });
    assert.equal(certa.status, 200);
    // a troca derruba as outras sessões
    assert.equal((await c.get('/api/v1/agents')).status, 401);
  } finally { await s.fechar(); }
});

test('isolamento: só o agente dele, nada do dono, mídia de outro agente dá 404 e o painel é negado', async () => {
  const s = await cenario();
  try {
    const { c } = await colaboradorAtivo(s);
    for (const p of ['/api/v1/agents/bob/messages', '/api/v1/agents/admin/messages', '/api/v1/agents/bob/login', '/api/v1/agents/bob']) {
      assert.equal((await c.get(p)).status, 403, p);
    }
    assert.equal((await c.post('/api/v1/agents/bob/send', { json: { text: 'oi' } })).status, 403);
    assert.equal((await c.get('/api/v1/agents/ana/messages')).status, 200);
    const pagOutro = await c.get('/a/bob', { headers: { Accept: 'text/html' } });
    assert.equal(pagOutro.status, 302); assert.equal(pagOutro.headers.location, '/a/ana');
    assert.equal((await c.get('/mesa', { headers: { Accept: 'text/html' } })).headers.location, '/a/ana');
    assert.equal((await c.get('/', { headers: { Accept: 'text/html' } })).headers.location, '/a/ana');

    // o painel do agente dele passa pelo escopo (aqui o agente nem tem painel, então o proxy responde 404); o de outro é negado
    assert.equal((await c.get('/p/ana/', { headers: { Accept: 'application/json' } })).status, 404);
    const outro = await c.get('/p/bob/', { headers: { Accept: 'text/html' } });
    assert.equal(outro.status, 403); assert.match(outro.texto, /só tem acesso ao agente para o qual foi convidado/);
    assert.equal((await c.get('/p/bob/', { headers: { Accept: 'application/json' } })).status, 403);

    for (const p of ['/api/v1/colaboradores', '/api/v1/cofre', '/api/v1/estados', '/api/v1/uso', '/api/v1/lembretes', '/api/v1/onboarding', '/api/v1/push/chave']) {
      assert.equal((await c.get(p)).status, 403, p);
    }
    assert.equal((await c.post('/api/v1/colaboradores', { json: { agente: 'bob', email: 'x@y.com' } })).status, 403);

    const nl = await c.get('/api/v1/nao-lidas');
    assert.equal(nl.status, 200); assert.deepEqual(Object.keys(nl.json.agentes), ['ana']);

    assert.equal((await c.get(`/api/v1/media/${s.idAna}`)).status, 200);
    const bob = await c.get(`/api/v1/media/${s.idBob}`);
    assert.equal(bob.status, 404);
    const inexistente = await c.get('/api/v1/media/0123456789abcdef');
    assert.equal(inexistente.status, 404);
    assert.equal(bob.json.erro, inexistente.json.erro, 'a resposta não pode revelar que o id existe');
    assert.equal((await c.get(`/api/v1/media/${s.idBob}/thumb`)).status, 404);
    assert.equal((await c.get(`/api/v1/media/${s.idBob}/visual`)).status, 404);
    // o dono continua vendo tudo
    assert.equal((await s.dono.get(`/api/v1/media/${s.idBob}`)).status, 200);
    assert.deepEqual((await s.dono.get('/api/v1/agents')).json.agentes.map((a) => a.id), ['admin', 'ana', 'bob']);
    assert.equal((await s.dono.get('/api/v1/eu')).json.papel, 'dono');

    // páginas que não existem para ele, sem expor o HTML do dono
    assert.equal((await c.get('/mesa.html', { headers: { Accept: 'text/html' } })).status, 302);
    assert.equal((await c.get('/app.js')).status, 200);
  } finally { await s.fechar(); }
});

test('WebSocket: colaborador abre só o do agente dele; o de outro agente e o de fora do painel são recusados', async () => {
  const s = await cenario();
  try {
    const { c } = await colaboradorAtivo(s);
    const cookie = Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const abre = (caminho) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.t.porta, path: caminho, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: `http://127.0.0.1:${s.t.porta}`, Cookie: cookie } }); // gitleaks:allow
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('upgrade', (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(await abre('/p/bob/tela/websockify'), 403);
    assert.equal(await abre('/p/ana/api/cofre'), 403);
    assert.equal(await abre('/p/ana/%2e%2e/bob/tela/websockify'), 403);
    assert.match(s.t.log.texto(), /WebSocket .* recusado para o colaborador maria@x\.com/);
    // a Tela é só do dono, mesmo no agente dele
    assert.equal(await abre('/p/ana/tela/websockify'), 403);
  } finally { await s.fechar(); }
});

test('mensagem do colaborador chega ao agente marcada como colaborador; a do dono continua "pessoa"', async () => {
  const s = await cenario();
  try {
    const { c } = await colaboradorAtivo(s);
    const r = await c.post('/api/v1/agents/ana/send', { json: { text: 'oi, sou eu' } });
    assert.equal(r.status, 200, r.texto);
    assert.match(s.rAna.rec.inputs[0].text, /^<dgchat from="colaborador: Maria \(maria@x\.com\)" chat="c_ana"/);
    await s.dono.post('/api/v1/agents/ana/send', { json: { text: 'e eu sou o dono' } });
    assert.match(s.rAna.rec.inputs[1].text, /^<dgchat from="pessoa" chat="c_ana"/);
    // texto de barra do colaborador vai dentro do envelope, nunca como comando
    await c.post('/api/v1/agents/ana/send', { json: { text: '/model opus' } });
    assert.match(s.rAna.rec.inputs[2].text, /^<dgchat from="colaborador: Maria/);
    assert.equal((await c.post('/api/v1/agents/ana/comando', { json: { comando: '/compact' } })).status, 403);
  } finally { await s.fechar(); }
});

test('reenviar: senha nova, trocar_senha de novo e a sessão antiga cai no pedido seguinte', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    assert.equal((await x.c.get('/api/v1/agents')).status, 200);
    const r = await s.dono.post(`/api/v1/colaboradores/${x.id}/reenviar`);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.colaborador.estado, 'aguardando_primeiro_acesso');
    assert.equal(s.enviados.length, 2);
    assert.equal((await x.c.get('/api/v1/agents')).status, 401, 'a sessão antiga cai');
    const velha = await cliente(s.t.porta).post('/login', { json: { usuario: x.email, senha: x.nova } });
    assert.equal(velha.status, 401);
    const c2 = cliente(s.t.porta);
    const l = await c2.post('/login', { json: { usuario: x.email, senha: r.json.convite.senha_temporaria } });
    assert.equal(l.json.destino, '/trocar-senha');
    assert.equal((await c2.get('/api/v1/agents')).status, 403);
  } finally { await s.fechar(); }
});

test('revogar: data o registro, derruba a sessão no pedido seguinte e libera o agente para outro convite', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    assert.equal((await x.c.get('/api/v1/agents')).status, 200);
    const r = await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`);
    assert.equal(r.status, 200); assert.equal(r.json.colaborador.estado, 'revogado'); assert.ok(r.json.colaborador.revogado_em > 0);
    assert.equal((await x.c.get('/api/v1/agents')).status, 401);
    assert.equal((await x.c.get('/a/ana', { headers: { Accept: 'text/html' } })).status, 302);
    const outra = await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`);
    assert.equal(outra.status, 409); assert.match(outra.json.erro, /já foi revogado/);
    assert.equal((await s.dono.post(`/api/v1/colaboradores/${x.id}/reenviar`)).status, 409);
    assert.equal((await cliente(s.t.porta).post('/login', { json: { usuario: x.email, senha: x.nova } })).status, 401);
    // o registro continua no arquivo, datado
    const lista = (await s.dono.get('/api/v1/colaboradores')).json.colaboradores;
    assert.equal(lista.length, 1); assert.equal(lista[0].estado, 'revogado');
    const noDisco = JSON.parse(fs.readFileSync(path.join(s.t.dados, 'colaboradores.json'), 'utf8'));
    assert.equal(noDisco.colaboradores.length, 1); assert.ok(noDisco.colaboradores[0].revogado_em);
    // e a ana pode receber outra pessoa
    assert.equal((await s.convida({ agente: 'ana', email: 'joao@x.com' })).status, 201);
    assert.equal((await s.dono.pedir('DELETE', '/api/v1/colaboradores/idquenaoexiste1')).status, 404);
  } finally { await s.fechar(); }
});

test('login: usuário inexistente e senha errada dão a mesma mensagem; temporária vencida é recusada', async () => {
  const s = await cenario();
  try {
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com' });
    const temp = r.json.convite.senha_temporaria;
    const c = cliente(s.t.porta);
    const errada = await c.post('/login', { json: { usuario: 'maria@x.com', senha: 'senha-errada-123' } });
    const fantasma = await c.post('/login', { json: { usuario: 'ninguem@x.com', senha: 'senha-errada-123' } });
    assert.equal(errada.status, 401); assert.equal(fantasma.status, 401);
    assert.equal(errada.json.erro, fantasma.json.erro);
    s.relogio.t += 8 * DIA;
    const vencida = await c.post('/login', { json: { usuario: 'maria@x.com', senha: temp } });
    assert.equal(vencida.status, 401);
    assert.equal(vencida.json.erro, 'A senha temporária venceu. Peça ao dono do DG Claw um convite novo.');
    assert.equal((await s.dono.get('/api/v1/colaboradores')).json.colaboradores[0].estado, 'temporaria_vencida');
    // o dono manda de novo e a pessoa entra
    const id = (await s.dono.get('/api/v1/colaboradores')).json.colaboradores[0].id;
    const nova = await s.dono.post(`/api/v1/colaboradores/${id}/reenviar`);
    assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: nova.json.convite.senha_temporaria } })).status, 200);
  } finally { await s.fechar(); }
});

test('login do colaborador continua limitado, e o limite do dono é só dele', async () => {
  const s = await cenario();
  try {
    await s.convida({ agente: 'ana', email: 'maria@x.com' });
    const c = cliente(s.t.porta);
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: 'errada-errada-1' } })).status, 401);
    assert.equal((await c.post('/login', { json: { usuario: 'maria@x.com', senha: 'errada-errada-1' } })).status, 429);
    // os erros do colaborador não trancam o dono: cada identidade tem o seu contador (o teto por IP é bem maior)
    assert.equal((await c.post('/login', { json: { usuario: 'dono', senha: s.t.senha } })).status, 200);
  } finally { await s.fechar(); }
});

test('login por formulário: o next fora do escopo do colaborador é ignorado', async () => {
  const s = await cenario();
  try {
    const { email, nova } = await colaboradorAtivo(s);
    const c = cliente(s.t.porta);
    const r = await c.post('/login', { form: { usuario: email, senha: nova, next: '/mesa' } });
    assert.equal(r.status, 303); assert.equal(r.headers.location, '/a/ana');
    const c2 = cliente(s.t.porta);
    const r2 = await c2.post('/login', { form: { usuario: email, senha: nova, next: '/conectar' } });
    assert.equal(r2.headers.location, '/conectar');
    assert.equal((await c2.get('/login', { headers: { Accept: 'text/html' } })).headers.location, '/a/ana');
  } finally { await s.fechar(); }
});

test('arquivo ilegível: não é apagado, vale "nenhum colaborador" e gravar é recusado com o motivo', async () => {
  const s = await cenario();
  try {
    const arq = path.join(s.t.dados, 'colaboradores.json');
    fs.writeFileSync(arq, '{ isto não é json', { mode: 0o600 });
    const lista = await s.dono.get('/api/v1/colaboradores');
    assert.equal(lista.status, 200); assert.deepEqual(lista.json.colaboradores, []);
    assert.match(s.t.log.texto(), new RegExp(`${arq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} está ilegível`));
    const r = await s.convida({ agente: 'ana', email: 'maria@x.com' });
    assert.equal(r.status, 500); assert.match(r.json.erro, /ilegível/);
    assert.equal(fs.readFileSync(arq, 'utf8'), '{ isto não é json');
    // corrigido à mão, volta a funcionar sem reiniciar
    fs.writeFileSync(arq, JSON.stringify({ versao: 1, colaboradores: [] }), { mode: 0o600 });
    fs.utimesSync(arq, new Date(), new Date(Date.now() + 5000));
    assert.equal((await s.convida({ agente: 'ana', email: 'maria@x.com' })).status, 201);
  } finally { await s.fechar(); }
});

test('rotas do dono: caixa do agente e colaborador recebem 403; a documentação sai para o dono', async () => {
  const s = await cenario();
  try {
    const { c } = await colaboradorAtivo(s);
    for (const [m, p] of [['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/colaboradores'], ['DELETE', '/api/v1/colaboradores/abcdefgh12'], ['POST', '/api/v1/colaboradores/abcdefgh12/reenviar'], ['GET', '/api/v1/colaboradores/docs.md']]) {
      assert.equal((await c.pedir(m, p, { json: {} })).status, 403, `${m} ${p}`);
    }
    const doc = await s.dono.get('/api/v1/colaboradores/docs.md');
    assert.equal(doc.status, 200); assert.match(doc.texto, /Colaboradores/);
    // dono não troca senha por aqui
    const r = await s.dono.post('/api/v1/eu/senha', { json: { nova: 'qualquer-senha-12', confirmacao: 'qualquer-senha-12' } });
    assert.equal(r.status, 403); assert.match(r.json.erro, /sudo dgclaw senha/);
  } finally { await s.fechar(); }
});

test('a configuração nova só LÊ o web.env: a linha alheia sobrevive a um convite', async () => {
  const dir = pastaTemp('webenv');
  const webEnv = path.join(dir, 'web.env');
  const conteudo = "DGCLAW_PANEL_USER=dono\nOUTRA=valor-alheio\nDGCLAW_SMTP_HOST=smtp.exemplo.com\nDGCLAW_SMTP_SENHA='segredo'\n";
  fs.writeFileSync(webEnv, conteudo, { mode: 0o600 });
  const s = await cenario({ env: { DGCLAW_WEB_ENV: webEnv, DGCLAW_SMTP_HOST: 'smtp.exemplo.com' } });
  try {
    assert.equal((await s.convida({ agente: 'ana', email: 'maria@x.com' })).status, 201);
    const id = (await s.dono.get('/api/v1/colaboradores')).json.colaboradores[0].id;
    await s.dono.post(`/api/v1/colaboradores/${id}/reenviar`);
    await s.dono.pedir('DELETE', `/api/v1/colaboradores/${id}`);
    assert.equal(fs.readFileSync(webEnv, 'utf8'), conteudo);
  } finally { await s.fechar(); }
});

test('revogar fecha também o stream aberto da conversa do colaborador', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const cookie = Object.entries(x.c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const fechou = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o stream continuou aberto depois da revogação')), 5000);
      const req = http.get({ host: '127.0.0.1', port: s.t.porta, path: '/api/v1/agents/ana/stream', headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', async () => { await s.dono.pedir('DELETE', `/api/v1/colaboradores/${x.id}`); });
        res.on('close', () => { clearTimeout(timer); resolve(); });
        res.on('error', () => undefined);
      });
      req.on('error', () => undefined);
    });
    await fechou;
  } finally { await s.fechar(); }
});
