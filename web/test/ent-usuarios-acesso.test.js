'use strict';
// Bloco B, autorização: o funcionário recebe 403 com motivo em português em TODA rota de um agente que não é dele
// (e no Admin); o TI acessa tudo; nada vaza em listas. Cada rota abaixo é uma linha do inventário do relatório.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { cenarioEnt, criarUsuario } = require('./ent-usuarios-ajuda');

const HTML = { headers: { Accept: 'text/html' } };

/** Primeira linha da resposta a um pedido de WebSocket (o servidor recusa ou segue para o painel). */
function pedirWebSocket(porta, caminho, cookie) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(porta, '127.0.0.1');
    let dados = '';
    sock.on('data', (d) => { dados += d.toString('utf8'); });
    sock.on('close', () => resolve(dados.split('\r\n')[0]));
    sock.on('error', reject);
    sock.write(`GET ${caminho} HTTP/1.1\r\nHost: 127.0.0.1:${porta}\r\nOrigin: http://127.0.0.1:${porta}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: dgclaw_sessao=${cookie}\r\n\r\n`);
    setTimeout(() => sock.destroy(), 1500);
  });
}

/** Cenário com o TI, a Fran (funcionária, só a ana) e dados criados pelo TI para as duas agentes. */
async function montar() {
  const c = await cenarioEnt();
  const ti = (await c.entrar('dono', c.senhaTi)).cli;
  const u = await criarUsuario(c, ti, { usuario: 'fran', nome: 'Fran', papel: 'funcionario', agentes: ['ana'] });
  const fran = (await c.entrar('fran', u.senha)).cli;
  const dados = {};
  for (const slug of ['ana', 'marina']) {
    const t = await ti.post('/api/v1/tarefas', { json: { agente: slug, titulo: `tarefa da ${slug}`, origem: 'teste' } });
    assert.equal(t.status, 201, t.texto);
    dados[`tarefa_${slug}`] = t.json.tarefa.id;
    const l = await ti.post('/api/v1/lembretes', { json: { agente: slug, texto: `lembrete da ${slug}`, daqui_min: 30 } });
    assert.equal(l.status, 201, l.texto);
    dados[`lembrete_${slug}`] = l.json.lembrete.id;
    const home = c.agentes.find((a) => a.slug === slug).home_host;
    fs.mkdirSync(path.join(home, 'out'), { recursive: true });
    const arq = path.join(home, 'out', 'relatorio.pdf');
    fs.writeFileSync(arq, '0123456789');
    dados[`midia_${slug}`] = c.s.web.midia.registrar(slug, arq, { visto: '/out/relatorio.pdf' }).url;
  }
  return { c, ti, fran, dados };
}

/** [metodo, caminho, opcoes] de cada rota que recebe o slug de um agente. */
function rotasDoAgente(slug, d) {
  const A = `/api/v1/agents/${slug}`;
  return [
    ['GET', `/a/${slug}`, HTML],
    ['GET', `/p/${slug}/`, HTML],
    ['GET', `/p/${slug}/qualquer/coisa`, HTML],
    ['GET', A],
    ['GET', `${A}/messages`],
    ['GET', `${A}/messages?after=0`],
    ['GET', `${A}/stream`],
    ['GET', `${A}/wait?since=1&timeout=1`],
    ['POST', `${A}/send`, { json: { text: 'oi' } }],
    ['POST', `${A}/comando`, { json: { comando: 'status' } }],
    ['POST', `${A}/permissao`, { json: { decisao: 'sim' } }],
    ['POST', `${A}/upload`, { corpo: 'x' }],
    ['GET', `${A}/comandos`],
    ['GET', `${A}/compartilhados?tipo=midias&limite=5`],
    ['GET', `${A}/alertas`],
    ['POST', `${A}/alertas/aaaaaaaaaaaaaaaaaaaaaaaa/visto`, { json: {} }],
    ['GET', `${A}/login`],
    ['POST', `${A}/login`, { json: {} }],
    ['POST', `${A}/login/codigo`, { json: { codigo: 'x' } }],
    ['POST', `${A}/login/oi`, { json: {} }],
    ['GET', d[`midia_${slug}`]],
    ['POST', '/api/v1/tts', { json: { text: 'oi', agent_id: slug } }],
    ['GET', `/api/v1/tarefas?agente=${slug}`],
    ['POST', '/api/v1/tarefas', { json: { agente: slug, titulo: 'x', origem: 'teste' } }],
    ['GET', `/api/v1/tarefas/${d[`tarefa_${slug}`]}`],
    ['PATCH', `/api/v1/tarefas/${d[`tarefa_${slug}`]}`, { json: { nota: 'oi' } }],
    ['DELETE', `/api/v1/tarefas/${d[`tarefa_${slug}`]}`],
    ['GET', `/api/v1/lembretes?agente=${slug}`],
    ['POST', '/api/v1/lembretes', { json: { agente: slug, texto: 'x', daqui_min: 10 } }],
    ['POST', '/api/v1/lembretes/disparar', { json: { agente: slug, texto: 'x' } }],
    ['GET', `/api/v1/lembretes/${d[`lembrete_${slug}`]}`],
    ['PATCH', `/api/v1/lembretes/${d[`lembrete_${slug}`]}`, { json: { texto: 'novo' } }],
    ['DELETE', `/api/v1/lembretes/${d[`lembrete_${slug}`]}`],
    ['POST', `/api/v1/lembretes/${d[`lembrete_${slug}`]}/pausar`, { json: {} }],
    ['POST', `/api/v1/lembretes/${d[`lembrete_${slug}`]}/retomar`, { json: {} }],
    ['GET', `/api/v1/lembretes/${d[`lembrete_${slug}`]}/ocorrencias`],
    ['GET', `/api/v1/foco/${slug}`],
    ['PUT', `/api/v1/foco/${slug}`, { json: { itens: [{ texto: 'a' }] } }],
    ['DELETE', `/api/v1/foco/${slug}`],
    ['POST', `/api/v1/foco/${slug}/itens`, { json: { texto: 'a' } }],
    ['GET', `/api/v1/foco/${slug}/eventos`],
  ];
}

/** Áreas que não têm slug mas são só do TI. */
const AREAS_DO_TI = [
  ['GET', '/api/v1/avisos'], ['POST', '/api/v1/avisos', { json: { texto: 'x' } }], ['GET', '/avisos', HTML],
  ['GET', '/api/v1/push/chave'], ['POST', '/api/v1/push/inscricoes', { json: {} }],
  ['GET', '/api/v1/onboarding'], ['POST', '/api/v1/onboarding', { json: {} }],
  ['GET', '/api/v1/protecoes'], ['GET', '/protecoes', HTML],
  ['GET', '/api/v1/usuarios'], ['POST', '/api/v1/usuarios', { json: { usuario: 'zed', papel: 'ti' } }],
  ['GET', '/api/v1/usuarios/dono'], ['PATCH', '/api/v1/usuarios/dono', { json: { nome: 'x' } }], ['DELETE', '/api/v1/usuarios/dono'],
  ['GET', '/api/v1/usuarios/dono/sessoes'], ['DELETE', '/api/v1/usuarios/dono/sessoes'],
  ['POST', '/api/v1/usuarios/dono/link', { json: {} }], ['POST', '/api/v1/usuarios/dono/zerar-2fa', { json: {} }],
  ['GET', '/usuarios', HTML],
];

async function pede(cli, [metodo, caminho, opcoes]) {
  return cli.pedir(metodo, caminho, opcoes);
}

test('funcionário: 403 com motivo em português em cada rota de um agente que não é dele', async () => {
  const { c, fran, dados } = await montar();
  try {
    for (const slug of ['marina', 'admin']) {
      for (const rota of rotasDoAgente(slug, Object.assign({ midia_admin: dados.midia_marina, tarefa_admin: dados.tarefa_marina, lembrete_admin: dados.lembrete_marina }, dados))) {
        // o ponto de partida do admin reaproveita os ids da marina: o 403 vem pela rota do slug ou pelo dono do recurso
        const r = await pede(fran, rota);
        assert.equal(r.status, 403, `${rota[0]} ${rota[1]} devolveu ${r.status}: ${r.texto.slice(0, 120)}`);
        const motivo = r.json ? r.json.erro : r.texto;
        assert.match(motivo, /acesso|Peça ao TI/, `${rota[0]} ${rota[1]}: o motivo precisa explicar (${motivo.slice(0, 100)})`);
      }
    }
    assert.ok(c.eventos().filter((e) => e.evento === 'acesso_negado').length >= 40, 'cada recusa fica na auditoria');
    const ev = c.eventos().find((e) => e.evento === 'acesso_negado');
    assert.equal(ev.quem, 'fran');
    assert.ok(ev.dados.recurso);
  } finally { await c.fechar(); }
});

test('funcionário: WebSocket do painel de outro agente é recusado com 403', async () => {
  const { c, fran, ti } = await montar();
  try {
    assert.match(await pedirWebSocket(c.s.porta, '/p/marina/ws', fran.jar.dgclaw_sessao), /^HTTP\/1\.1 403/);
    assert.match(await pedirWebSocket(c.s.porta, '/p/admin/ws', fran.jar.dgclaw_sessao), /^HTTP\/1\.1 403/);
    // o TI passa da regra de acesso (aí o painel, que não existe no teste, responde outra coisa)
    assert.doesNotMatch(await pedirWebSocket(c.s.porta, '/p/marina/ws', ti.jar.dgclaw_sessao), /^HTTP\/1\.1 403/);
    assert.match(await pedirWebSocket(c.s.porta, '/p/marina/ws', 'cookie-invalido'), /^HTTP\/1\.1 401/);
  } finally { await c.fechar(); }
});

test('funcionário: as áreas só do TI (avisos, push, criar agente, proteções, usuários) recusam com 403', async () => {
  const { c, fran } = await montar();
  try {
    for (const rota of AREAS_DO_TI) {
      const r = await pede(fran, rota);
      assert.equal(r.status, 403, `${rota[0]} ${rota[1]} devolveu ${r.status}: ${r.texto.slice(0, 120)}`);
    }
  } finally { await c.fechar(); }
});

test('TI: nenhuma rota de agente recusa por acesso (200 ou o erro natural da rota), em todos os agentes', async () => {
  const { c, ti, dados } = await montar();
  try {
    for (const slug of ['ana', 'marina', 'admin']) {
      for (const rota of rotasDoAgente(slug, Object.assign({ midia_admin: dados.midia_marina, tarefa_admin: dados.tarefa_marina, lembrete_admin: dados.lembrete_marina }, dados))) {
        if (rota[0] !== 'GET' && !/\/(a|p)\//.test(rota[1])) continue;   // o TI só lê aqui: não gasta o dado de teste apagando e pausando
        if (rota[1].endsWith('/stream') || rota[1].includes('/wait')) continue;
        const r = await pede(ti, rota);
        assert.notEqual(r.status, 403, `${rota[0]} ${rota[1]} recusou o TI: ${r.texto.slice(0, 120)}`);
      }
    }
    for (const rota of AREAS_DO_TI.filter((r) => r[0] === 'GET')) {
      const r = await pede(ti, rota);
      assert.notEqual(r.status, 403, `${rota[1]} recusou o TI`);
    }
    // a raiz é a do main: o último agente do cookie, senão o primeiro que não é o Admin
    assert.equal((await ti.get('/', HTML)).headers.location, '/a/ana');
    assert.deepEqual((await ti.get('/api/v1/agents')).json.agentes.map((a) => a.id), ['admin', 'ana', 'marina']);
  } finally { await c.fechar(); }
});

test('funcionário: no que é dele tudo funciona; as listas e a raiz mostram só os agentes dele', async () => {
  const { c, fran, dados } = await montar();
  try {
    assert.deepEqual((await fran.get('/api/v1/agents')).json.agentes.map((a) => a.id), ['ana']);
    const raiz = await fran.get('/', HTML);
    assert.equal(raiz.status, 302);
    assert.equal(raiz.headers.location, '/a/ana');
    // o cookie do último agente (do main) não pode apontar para um agente que o funcionário não vê
    const comCookie = await fran.get('/', { headers: { Accept: 'text/html', Cookie: 'dgclaw_agente=marina' } });
    assert.equal(comCookie.headers.location, '/a/ana');
    const cookieValido = await fran.get('/', { headers: { Accept: 'text/html', Cookie: 'dgclaw_agente=ana' } });
    assert.equal(cookieValido.headers.location, '/a/ana');
    assert.equal((await fran.get('/a/ana', HTML)).status, 200);
    assert.equal((await fran.get('/api/v1/agents/ana')).status, 200);
    assert.equal((await fran.get('/api/v1/agents/ana/messages')).status, 200);
    assert.equal((await fran.get(dados.midia_ana)).status, 200);
    assert.equal((await fran.get('/api/v1/foco/ana')).status, 200);
    assert.equal((await fran.get('/conta', HTML)).status, 200);
    assert.equal((await fran.get('/api/v1/eu')).status, 200);
    assert.equal((await fran.get('/usuarios', HTML)).status, 403);

    // mesa: só as tarefas da ana, sem vazar as da marina nem o nome dela
    const mesa = await fran.get('/api/v1/tarefas?dia=todos');
    assert.equal(mesa.status, 200);
    assert.deepEqual(mesa.json.tarefas.map((t) => t.agente), ['ana']);
    assert.equal(mesa.json.contagem.abertas, 1);
    const p = await fran.post('/api/v1/tarefas', { json: { agente: 'ana', titulo: 'minha', origem: 'teste' } });
    assert.equal(p.status, 201);
    const erroNome = await fran.post('/api/v1/tarefas', { json: { agente: 'inexistente', titulo: 'x', origem: 'teste' } });
    assert.equal(erroNome.status, 400);
    assert.doesNotMatch(erroNome.texto, /marina/, 'a mensagem de erro não lista agentes de outros');
    // o ETag da lista depende de quem pergunta: o do funcionário nunca serve para o TI
    const etagFran = (await fran.get('/api/v1/tarefas')).headers.etag;
    const comEtag = await fran.get('/api/v1/tarefas', { headers: { 'If-None-Match': etagFran } });
    assert.equal(comEtag.status, 304);

    // lembretes: só os da ana; sem "agente" o padrão é o único agente dele
    const lem = await fran.get('/api/v1/lembretes');
    assert.deepEqual(lem.json.lembretes.map((l) => l.agente), ['ana']);
    const criado = await fran.post('/api/v1/lembretes', { json: { texto: 'sem dizer o agente', daqui_min: 15 } });
    assert.equal(criado.status, 201, criado.texto);
    assert.equal(criado.json.lembrete.agente, 'ana');
    assert.equal((await fran.get(`/api/v1/lembretes/${dados.lembrete_ana}`)).status, 200);
  } finally { await c.fechar(); }
});

test('mudar os agentes do funcionário vale na hora, sem novo login', async () => {
  const { c, ti, fran } = await montar();
  try {
    assert.equal((await fran.get('/api/v1/agents/marina')).status, 403);
    await ti.pedir('PATCH', '/api/v1/usuarios/fran', { json: { agentes: ['ana', 'marina'] } });
    assert.equal((await fran.get('/api/v1/agents/marina')).status, 200);
    assert.deepEqual((await fran.get('/api/v1/agents')).json.agentes.map((a) => a.id), ['ana', 'marina']);
    await ti.pedir('PATCH', '/api/v1/usuarios/fran', { json: { agentes: [] } });
    assert.equal((await fran.get('/api/v1/agents/ana')).status, 403);
    const raiz = await fran.get('/', HTML);
    assert.equal(raiz.status, 403);
    assert.match(raiz.texto, /nenhum agente liberado/i);
  } finally { await c.fechar(); }
});

test('o agente que fala pela caixa continua como antes: não passa por papel e não alcança rotas de usuário', async () => {
  const { c } = await montar();
  try {
    const caixa = c.s.web.caixa;
    assert.ok(caixa, 'a caixa existe');
    // sessão de caixa: a regra única diz sim (o agente fala por si)
    assert.equal(c.s.web.ent.podeVerAgente({ usuario: 'agente:marina', via: 'caixa', agente: 'marina' }, 'marina'), true);
    assert.equal(c.s.web.ent.podeVerAgente({ usuario: 'agente:marina', via: 'caixa', agente: 'marina' }, 'ana'), true, 'a caixa decide por conta própria quem é quem');
    // e as rotas de usuário não estão liberadas para a caixa
    assert.equal(caixa.rotaPermitida('/api/v1/usuarios'), false);
    assert.equal(caixa.rotaPermitida('/api/v1/eu/senha'), false);
  } finally { await c.fechar(); }
});
