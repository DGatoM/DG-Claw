'use strict';
// Auditoria completa no Web: mutações da API, painel aberto, mídia baixada, comandos de agente, a tela /auditoria e a
// API (só TI), conferência da corrente, exportação, e nada disso no nível pessoal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { cenarioEnt, criarUsuario } = require('./ent-usuarios-ajuda');
const { cliente } = require('./ajuda');
const trilha = require('../lib/trilha');

const PUBLICO = path.join(__dirname, '../public');
// Chave de API de mentira, montada na hora (nenhuma chave, nem falsa, fica escrita no arquivo): serve só para provar a máscara.
const CHAVE_FALSA = ['sk', 'ant', 'api03', 'Z'.repeat(48)].join('-');

async function montar(opcoes) {
  const c = await cenarioEnt(Object.assign({ nivel: 'empresa' }, opcoes || {}));
  fs.copyFileSync(path.join(PUBLICO, 'auditoria.html'), path.join(c.s.publico, 'auditoria.html'));
  const ti = (await c.entrar('dono', c.senhaTi)).cli;
  return { c, ti };
}
const eventos = (c, nome) => c.eventos().filter((e) => e.evento === nome);

test('nível pessoal: nem a tela nem a API existem, e nada é gravado', async () => {
  const c = await cenarioEnt({ nivel: 'pessoal' });
  try {
    const cli = c.s.c;
    await cli.post('/login', { json: { usuario: 'dono', senha: c.senhaTi } });
    const r = await cli.get('/api/v1/auditoria');
    assert.equal(r.status, 404, r.texto);
    const t = await cli.get('/auditoria', { headers: { Accept: 'text/html' } });
    assert.equal(t.status, 404);
    assert.equal(fs.existsSync(c.auditoriaPath), false);
  } finally { await c.fechar(); }
});

test('nível básico (escritório): a tela e a API funcionam, mas as mutações da API não viram evento', async () => {
  const { c, ti } = await montar({ nivel: 'escritorio' });
  try {
    const t = await ti.post('/api/v1/tarefas', { json: { agente: 'ana', titulo: 'x', origem: 'teste' } });
    assert.equal(t.status, 201, t.texto);
    assert.equal(eventos(c, 'api_mutacao').length, 0);
    const r = await ti.get('/api/v1/auditoria');
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.nivel, 'basica');
    assert.equal(r.json.externa, null);
  } finally { await c.fechar(); }
});

test('completa: toda mutação da API vira evento, sem valores de query, com status, quem e agente alvo', async () => {
  const { c, ti } = await montar();
  try {
    const t = await ti.post('/api/v1/tarefas?token=VALOR-SECRETO-DA-URL&x=1', { json: { agente: 'ana', titulo: 'x', origem: 'teste' } });
    assert.equal(t.status, 201, t.texto);
    const f = await ti.pedir('PUT', '/api/v1/foco/ana', { json: { itens: [{ texto: 'a' }] } });
    assert.ok(f.status < 400, f.texto);
    const ruim = await ti.post('/api/v1/tarefas', { json: {} });
    assert.ok(ruim.status >= 400);
    await ti.get('/api/v1/tarefas?agente=ana');   // leitura não entra

    const ev = eventos(c, 'api_mutacao');
    assert.equal(ev.length, 3);
    assert.deepEqual(ev[0].dados.consulta, ['token', 'x']);
    assert.equal(ev[0].dados.metodo, 'POST');
    assert.equal(ev[0].dados.rota, '/api/v1/tarefas');
    assert.equal(ev[0].dados.status, 201);
    assert.equal(ev[0].quem, 'dono');
    assert.equal(ev[1].dados.agente, 'ana');
    assert.equal(ev[1].dados.metodo, 'PUT');
    assert.ok(ev[2].dados.status >= 400, 'a tentativa que falhou também fica registrada, com o status');
    assert.ok(ev[0].dados.ip);
    assert.equal(fs.readFileSync(c.auditoriaPath, 'utf8').includes('VALOR-SECRETO-DA-URL'), false);
  } finally { await c.fechar(); }
});

test('completa: o agente que escreve pela caixa aparece com a credencial dele', async () => {
  const { c } = await montar();
  try {
    const cli = cliente(c.s.porta);
    const r = await cli.pedir('POST', '/api/v1/tarefas', {
      origin: false, semCookie: true, json: { agente: 'ana', titulo: 'do agente', origem: 'agente' },
      headers: { 'x-dgclaw-caixa': c.s.web.caixa.segredo, 'x-dgclaw-agente': 'ana' },
    });
    assert.equal(r.status, 201, r.texto);
    const ev = eventos(c, 'api_mutacao');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].quem, 'agente:ana');
    assert.equal(ev[0].dados.credencial, 'caixa-do-agente');
    assert.equal(ev[0].dados.agente, undefined, 'a caixa não carrega o agente na URL desta rota');
  } finally { await c.fechar(); }
});

test('completa: painel aberto (só quando abre) e mídia baixada (só com ?baixar=1)', async () => {
  const { c, ti } = await montar();
  const painel = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('painel'); });
  await new Promise((r) => painel.listen(0, '127.0.0.1', r));
  try {
    const reg = JSON.parse(fs.readFileSync(c.s.agentesPath, 'utf8'));
    const segredoProxy = path.join(c.s.dir, 'proxy.txt');
    fs.writeFileSync(segredoProxy, 'segredo-do-proxy-so-para-teste\n');
    Object.assign(reg.agentes.find((a) => a.slug === 'ana'), { porta_painel: painel.address().port, proxy_segredo_arquivo: segredoProxy });
    fs.writeFileSync(c.s.agentesPath, JSON.stringify(reg));
    const semBarra = await ti.get('/p/ana', { headers: { Accept: 'text/html' } });
    assert.equal(semBarra.status, 302);
    const aberto = await ti.get('/p/ana/', { headers: { Accept: 'text/html' } });
    assert.equal(aberto.status, 200, aberto.texto);
    const semPainel = await ti.get('/p/marina/', { headers: { Accept: 'text/html' } });
    assert.ok(semPainel.status >= 400);
    const ev = eventos(c, 'painel_aberto');
    assert.equal(ev.length, 1, 'só a abertura que deu certo, uma vez');
    assert.equal(ev[0].dados.agente, 'ana');

    const home = c.agentes.find((a) => a.slug === 'ana').home_host;
    fs.mkdirSync(path.join(home, 'out'), { recursive: true });
    const arq = path.join(home, 'out', 'relatorio.pdf');
    fs.writeFileSync(arq, '0123456789');
    const m = c.s.web.midia.registrar('ana', arq, { visto: '/out/relatorio.pdf' });
    assert.equal((await ti.get(m.url)).status, 200);
    assert.equal(eventos(c, 'midia_baixada').length, 0, 'ver na tela não é baixar');
    assert.equal((await ti.get(`${m.url}${m.url.includes('?') ? '&' : '?'}baixar=1`)).status, 200);
    const md = eventos(c, 'midia_baixada');
    assert.equal(md.length, 1);
    assert.match(md[0].dados.midia, /^[0-9a-f]{16}$/);
  } finally { await new Promise((r) => painel.close(r)); await c.fechar(); }
});

test('completa: comando de agente vira agente_comando (título mascarado, nunca a saída), sem duplicar depois de um restart', async () => {
  const { c } = await montar();
  try {
    const uso = trilha.descreveUso('Bash', { command: `curl -H "Authorization: Bearer ${CHAVE_FALSA}" https://x.com`, description: `chama a API com ${CHAVE_FALSA}` });
    assert.equal(uso.titulo.includes(CHAVE_FALSA), false, 'a máscara da trilha já tirou a chave do título');
    const agora = c.tempo.ms() / 1000;
    trilha.avisaUso('ana', 'toolu_1', agora - 100, uso);   // de antes de ligar: o leitor só relê o transcript
    trilha.avisaUso('ana', 'toolu_2', agora + 1, uso);
    trilha.avisaUso('ana', 'toolu_3', agora + 1, uso);     // mesmo instante, outro id: entra
    trilha.avisaUso('ana', 'toolu_2', agora + 1, uso);     // repetido: não entra
    trilha.avisaUso('ana', 'toolu_0', agora + 0.5, uso);   // mais velho que o último registrado: não entra
    const ev = eventos(c, 'agente_comando');
    assert.equal(ev.length, 2);
    assert.equal(ev[0].quem, 'agente:ana');
    assert.equal(ev[0].dados.ferramenta, 'Bash');
    assert.deepEqual(Object.keys(ev[0].dados).sort(), ['agente', 'ferramenta', 'titulo']);
    assert.equal(fs.readFileSync(c.auditoriaPath, 'utf8').includes(CHAVE_FALSA), false);
    assert.equal(fs.statSync(path.join(c.dataDir, 'auditoria-comandos.json')).mode & 0o777, 0o600);
  } finally { await c.fechar(); }
});

test('o leitor de transcript avisa a auditoria de cada tool_use, uma vez cada', () => {
  const { criarLeitor } = require('../lib/thread');
  const { pastaTemp } = require('./ajuda');
  const visto = [];
  trilha.definirOuvinteDeUso((d) => visto.push(d));
  try {
    const dir = pastaTemp('tr');
    const arq = path.join(dir, 'sess.jsonl');
    const linha = (o) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(arq, linha({ type: 'assistant', timestamp: '2026-10-18T12:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls -la', description: 'lista a pasta' } }] } }));
    const agente = { slug: 'ana', nome: 'Ana', chat_id: 'c_ana', home_host: dir };
    const leitor = criarLeitor({ log: () => {}, tz: 'America/Sao_Paulo', canalTelegram: 'x', midia: { registrar: () => null } });
    leitor.ler(arq, agente);
    leitor.ler(arq, agente);
    assert.equal(visto.length, 1);
    assert.equal(visto[0].slug, 'ana');
    assert.equal(visto[0].id, 'toolu_a');
    assert.equal(visto[0].uso.titulo, 'lista a pasta');
  } finally { trilha.definirOuvinteDeUso(null); }
});

test('escritório: agente_comando não é registrado', async () => {
  const { c } = await montar({ nivel: 'escritorio' });
  try {
    trilha.avisaUso('ana', 'toolu_9', Date.now() / 1000 + 5, trilha.descreveUso('Bash', { command: 'ls' }));
    assert.equal(eventos(c, 'agente_comando').length, 0);
  } finally { await c.fechar(); }
});

test('a tela e a API são só do TI: funcionário e agente levam 403 e o acesso negado fica registrado', async () => {
  const { c, ti } = await montar();
  try {
    const u = await criarUsuario(c, ti, { usuario: 'fran', nome: 'Fran', papel: 'funcionario', agentes: ['ana'] });
    const fran = (await c.entrar('fran', u.senha)).cli;
    for (const caminho of ['/api/v1/auditoria', '/api/v1/auditoria/exportar', '/api/v1/auditoria/externa']) {
      const r = await fran.get(caminho);
      assert.equal(r.status, 403, caminho);
      assert.match(r.json.erro, /só do TI/);
    }
    const tela = await fran.get('/auditoria', { headers: { Accept: 'text/html' } });
    assert.equal(tela.status, 403);
    assert.ok(eventos(c, 'acesso_negado').length >= 4);
    const anon = await cliente(c.s.porta).get('/api/v1/auditoria');
    assert.equal(anon.status, 401);
    const telaAnon = await cliente(c.s.porta).get('/auditoria', { headers: { Accept: 'text/html' } });
    assert.equal(telaAnon.status, 302);
    const ok = await ti.get('/auditoria', { headers: { Accept: 'text/html' } });
    assert.equal(ok.status, 200);
    assert.match(ok.texto, /auditoriaRaiz/);
    const w = await ti.post('/api/v1/auditoria', { json: { evento: 'falso' } });
    assert.equal(w.status, 405, 'ninguém escreve na trilha pela API');
  } finally { await c.fechar(); }
});

test('lista: filtros, paginação, opções de filtro e a corrente íntegra; adulterar mostra a linha', async () => {
  const { c, ti } = await montar();
  try {
    for (let i = 0; i < 7; i += 1) await ti.post('/api/v1/tarefas', { json: { agente: 'ana', titulo: `t${i}`, origem: 'teste' } });
    const todos = await ti.get('/api/v1/auditoria?por=5');
    assert.equal(todos.status, 200, todos.texto);
    assert.equal(todos.json.eventos.length, 5);
    assert.ok(todos.json.total >= 7);
    assert.equal(todos.json.paginas, Math.ceil(todos.json.total / 5));
    assert.ok(Date.parse(todos.json.eventos[0].ts) >= Date.parse(todos.json.eventos[4].ts), 'do mais novo para o mais antigo');
    assert.deepEqual(todos.json.integridade, { ok: true, linhas: todos.json.total });
    assert.ok(todos.json.opcoes.eventos.includes('api_mutacao') && todos.json.opcoes.eventos.includes('login_ok'));
    assert.ok(todos.json.opcoes.origens.includes('web'));

    const so = await ti.get('/api/v1/auditoria?evento=api_mutacao&por=200');
    assert.ok(so.json.eventos.every((e) => e.evento === 'api_mutacao'));
    const q = await ti.get('/api/v1/auditoria?q=tarefas&por=200');
    assert.ok(q.json.total >= 7);
    assert.equal((await ti.get('/api/v1/auditoria?de=2030-01-01')).json.total, 0);
    const ruim = await ti.get('/api/v1/auditoria?de=ontem');
    assert.equal(ruim.status, 400);
    assert.match(ruim.json.erro, /data inicial/);
    assert.equal((await ti.get('/api/v1/auditoria?por=5&pagina=2')).json.pagina, 2);

    const ls = fs.readFileSync(c.auditoriaPath, 'utf8').split('\n').filter(Boolean);
    ls[2] = ls[2].replace(/"quem":"[^"]*"/, '"quem":"intruso"');
    fs.writeFileSync(c.auditoriaPath, `${ls.join('\n')}\n`);
    const quebrada = await ti.get('/api/v1/auditoria?por=5');
    assert.equal(quebrada.json.integridade.ok, false);
    assert.equal(quebrada.json.integridade.quebradaEm, 3);
    assert.match(quebrada.json.integridade.motivo, /alterada/);
  } finally { await c.fechar(); }
});

test('exportar: jsonl com as linhas originais, csv, filtros, e a exportação fica registrada', async () => {
  const { c, ti } = await montar();
  try {
    await ti.post('/api/v1/tarefas', { json: { agente: 'ana', titulo: 'x', origem: 'teste' } });
    const j = await ti.get('/api/v1/auditoria/exportar?formato=jsonl&evento=api_mutacao');
    assert.equal(j.status, 200);
    assert.match(j.headers['content-disposition'], /attachment; filename="auditoria-inicio-a-agora\.jsonl"/);
    const linhas = j.texto.trim().split('\n');
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0]).evento, 'api_mutacao');
    assert.ok(fs.readFileSync(c.auditoriaPath, 'utf8').includes(linhas[0]), 'a linha exportada é igual à original');
    assert.equal(j.headers['x-total-eventos'], '1');

    const csv = await ti.get('/api/v1/auditoria/exportar?formato=csv&de=2026-10-01&ate=2026-10-31');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.texto, /"ts","evento","quem","origem","dados","ant","hash"/);

    const exp = eventos(c, 'auditoria_exportada');
    assert.equal(exp.length, 2);
    assert.deepEqual(exp[0].dados.filtros, { evento: 'api_mutacao' });
    assert.equal(exp[0].dados.total, 1);
    assert.equal(exp[0].dados.formato, 'jsonl');
    assert.equal((await ti.get('/api/v1/auditoria/exportar?formato=xml')).status, 400);
  } finally { await c.fechar(); }
});

test('tela: arquivos ligados, funções puras escapam o texto e há tutorial por seção', () => {
  const A = require('../public/auditoria');
  const html = fs.readFileSync(path.join(PUBLICO, 'auditoria.html'), 'utf8');
  for (const s of ['/tour.js', '/auditoria.js', '/auditoria.css', '/conta-comum.js', '/casca.js']) assert.ok(html.includes(s), s);
  assert.match(html, /pagina: 'auditoria'/);
  assert.match(fs.readFileSync(path.join(PUBLICO, 'ent-conta.js'), 'utf8'), /\/auditoria/);
  assert.match(A.htmlIntegridade({ ok: true, linhas: 12 }), /Corrente íntegra: 12/);
  const q = A.htmlIntegridade({ ok: false, linhas: 4, quebradaEm: 5, arquivo: 'auditoria-2026-09.jsonl', linhaNoArquivo: 2, motivo: 'o hash não bate' });
  assert.match(q, /Corrente quebrada na linha 5 \(auditoria-2026-09\.jsonl, linha 2\)/);
  const e = A.htmlEvento({ ts: '2026-10-18T12:00:00Z', evento: 'login_falha', quem: '<b>x</b>', origem: 'web', dados: { a: '<img src=x>' }, hash: 'a'.repeat(64) });
  assert.doesNotMatch(e, /<b>x<\/b>|<img/);
  assert.match(e, /au-alerta/);
  assert.match(A.htmlLista({ eventos: [], pagina: 1, paginas: 1, total: 0 }), /Nenhum evento/);
  assert.equal(A.urlDeExportar({ de: '2026-01-01', evento: 'a b' }, 'csv'), '/api/v1/auditoria/exportar?de=2026-01-01&evento=a+b&formato=csv');
  for (const chave of ['pagina', 'corrente', 'filtros', 'lista', 'exportar']) {
    for (const p of A.PASSOS[chave]) assert.ok(p.oque && p.como && p.porque, `${chave}: o que é / como funciona / por que está aqui`);
  }
  assert.doesNotMatch(JSON.stringify(A.PASSOS), /—|–/);
});
