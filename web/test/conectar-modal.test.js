'use strict';
// O modal "Faça o login nos seus agentes" da conversa: decisões puras, lista de IAs, validação do servidor
// e a ligação estática (scripts, dialog, segredos, vídeo, convivência com o pop-up de login expirado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/conectar-puro');
const PV = require('../public/provedores');
const { subirWeb, pastaTemp } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');

const PUB = path.join(__dirname, '..', 'public');
const lePub = (n) => fs.readFileSync(path.join(PUB, n), 'utf8');
const semComentario = (n) => lePub(n).replace(/\/\*[\s\S]*?\*\//g, '');
const S = (chave) => ({ chave });

test('deveAbrirModal: só falta ou expirou abrem', () => {
  assert.equal(P.deveAbrirModal([S('conectado'), S('falta')]), true);
  assert.equal(P.deveAbrirModal([S('expirou'), S('conectado')]), true);
  assert.equal(P.deveAbrirModal([S('conectado'), S('conectado')]), false);
  for (const k of ['api', 'sem_resposta', 'conectado', 'andamento']) assert.equal(P.deveAbrirModal([S(k)]), false, k);
  assert.equal(P.deveAbrirModal([]), false);
  assert.equal(P.deveAbrirModal(null), false);
});

test('modalCompleto: tudo conectado, ignora chave de API, exige ao menos um', () => {
  assert.equal(P.modalCompleto([S('conectado'), S('conectado')]), true);
  assert.equal(P.modalCompleto([S('conectado'), S('api')]), true);
  assert.equal(P.modalCompleto([S('conectado'), S('andamento')]), false);
  assert.equal(P.modalCompleto([S('api')]), false);
  assert.equal(P.modalCompleto([]), false);
});

test('textosModal: 1, 2 e 3 ou mais agentes, sem travessão', () => {
  const um = P.textosModal(1), dois = P.textosModal(2), tres = P.textosModal(3), cinco = P.textosModal(5);
  assert.equal(um.titulo, 'Faça o login no seu agente');
  assert.equal(um.tituloFim, 'Login efetuado no seu agente');
  assert.equal(dois.titulo, 'Faça o login nos seus agentes');
  assert.equal(dois.tituloFim, 'Login efetuado nos dois agentes');
  assert.equal(tres.tituloFim, 'Login efetuado nos seus 3 agentes');
  assert.equal(cinco.tituloFim, 'Login efetuado nos seus 5 agentes');
  assert.equal(tres.titulo, 'Faça o login nos seus agentes');
  for (const t of [um, dois, tres]) {
    assert.equal(t.depois, 'Fazer depois');
    assert.equal(t.comecar, 'Começar a usar');
    for (const v of Object.values(t)) for (const x of [].concat(v)) assert.ok(!/[—–]/.test(x), x);
  }
  assert.ok(P.textosModal(2, { principalNome: 'Sofia' }).itens.some((i) => i.startsWith('Sofia:')));
});

test('provedoresDoAgente: só as IAs ativas e compatíveis; hoje uma só, a do próprio agente', () => {
  assert.deepEqual(P.provedoresDoAgente({ provedor: 'claude' }), [{ id: 'claude', nome: 'Claude' }]);
  assert.deepEqual(P.provedoresDoAgente({ provedor: 'codex' }), [{ id: 'codex', nome: 'Codex' }]);
  assert.deepEqual(P.provedoresDoAgente({}), [{ id: 'claude', nome: 'Claude' }]);
  assert.deepEqual(P.provedoresDoAgente(null), [{ id: 'claude', nome: 'Claude' }]);
  const ia = P.escolhaDeIA({ provedor: 'codex' });
  assert.equal(ia.pergunta, 'Com qual IA este agente vai entrar?');
  assert.equal(ia.escolhido.nome, 'Codex');
  assert.equal(ia.seletor, false);
});

test('o cartão traz a IA escolhida (o provedor que o runner informou vale mais que o do registro)', () => {
  const v = P.visaoCartao({ estado: 'nenhum', provedor: 'codex', auth: 'assinatura', conferido: { ok: false }, precisa_login: true }, { agente: { id: 'x', nome: 'X', provedor: 'claude' } });
  assert.equal(v.ia.escolhido.id, 'codex');
});

test('lista de IAs: valida() cobre ausente, desconhecido, inativo, ok e diferente do agente', () => {
  assert.deepEqual(PV.valida(undefined, 'claude'), { ok: true });
  assert.deepEqual(PV.valida('', 'claude'), { ok: true });
  assert.deepEqual(PV.valida('claude', 'claude'), { ok: true });
  assert.deepEqual(PV.valida('CODEX', 'codex'), { ok: true });
  assert.match(PV.valida('gemini', 'claude').erro, /Não conheço a IA "gemini"/);
  assert.match(PV.valida(5, 'claude').erro, /precisa ser um texto/);
  const lista = [{ id: 'claude', nome: 'Claude', ativo: true }, { id: 'xis', nome: 'Xis', ativo: false }];
  assert.match(PV.valida('xis', 'claude', lista).erro, /Xis ainda não está disponível/);
  const dif = PV.valida('codex', 'claude');
  assert.equal(dif.ok, false);
  assert.match(dif.erro, /usa Claude e trocar para Codex ainda não está disponível/);
  for (const p of PV.PROVEDORES) assert.ok(p.id && p.nome && typeof p.ativo === 'boolean');
});

async function cenario(opcoesServidor) {
  const runner = criarRunnerFalso({ agenteId: 'ana1' });
  const porta = await runner.ouvir();
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: `http://127.0.0.1:${porta}`, agente_id: 'ana1', chat_id: 'c_ana', provedor: 'claude', modelo: 'sonnet', transcripts_dir: pastaTemp('tr'), home_host: pastaTemp('home') }];
  const t = await subirWeb({ agentes, opcoesServidor });
  await t.login();
  return { t, fechar: async () => { await t.fechar(); await runner.fechar(); } };
}

test('servidor: POST /login valida o campo provedor (ausente e igual passam; desconhecido, inativo e diferente dão 400)', async () => {
  const s = await cenario({ provedores: [{ id: 'claude', nome: 'Claude', ativo: true }, { id: 'codex', nome: 'Codex', ativo: true }, { id: 'xis', nome: 'Xis', ativo: false }] });
  try {
    const post = (json) => s.t.c.post('/api/v1/agents/ana/login', { json });
    const sem = await post({});
    assert.notEqual(sem.status, 400, 'sem provedor: comportamento de sempre');
    await s.t.c.pedir('DELETE', '/api/v1/agents/ana/login');
    assert.notEqual((await post({ provedor: 'claude' })).status, 400);
    await s.t.c.pedir('DELETE', '/api/v1/agents/ana/login');
    const desc = await post({ provedor: 'gemini' });
    assert.equal(desc.status, 400); assert.match(desc.json.erro, /Não conheço a IA/);
    const inat = await post({ provedor: 'xis' });
    assert.equal(inat.status, 400); assert.match(inat.json.erro, /ainda não está disponível/);
    const dif = await post({ provedor: 'codex' });
    assert.equal(dif.status, 400); assert.match(dif.json.erro, /trocar para Codex ainda não está disponível/);
    const g = await s.t.c.get('/api/v1/agents/ana/login');
    assert.equal(g.json.provedor, 'claude', 'GET devolve o provedor');
  } finally { await s.fechar(); }
});

test('conversa.html: dialog do modal e scripts na ordem certa', () => {
  const html = lePub('conversa.html');
  assert.match(html, /<dialog id="dlgModalLogin"[^>]*aria-labelledby="mlTit"/);
  assert.match(html, /<link rel="stylesheet" href="\/conectar-cartoes\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/modal-login\.css">/);
  const ordem = ['/login-cartao.js', '/provedores.js', '/conectar-puro.js', '/conectar-cartoes.js', '/modal-login.js', '/conversa.js'].map((s) => html.indexOf('<script src="' + s + '">'));
  assert.ok(ordem.every((i) => i > 0), 'falta algum script: ' + ordem);
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, 'ordem dos scripts');
  const sw = lePub('sw.js');
  for (const s of ['/conectar-cartoes.js', '/conectar-cartoes.css', '/provedores.js', '/modal-login.js', '/modal-login.css']) assert.ok(sw.includes("'" + s + "'"), 'sw sem ' + s);
  assert.match(lePub('conectar.html'), /conectar-cartoes\.js[\s\S]*conectar\.js/);
  assert.match(lePub('conectar.html'), /class="cn cn-escopo"/);
});

test('modal-login.js e conectar-cartoes.js: sem innerHTML, sem localStorage, sem console com link ou código', () => {
  for (const f of ['modal-login.js', 'conectar-cartoes.js']) {
    const js = semComentario(f);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(js), 'HTML montado em ' + f);
    assert.ok(!/localStorage/.test(js), 'localStorage em ' + f);
    assert.ok(!/\.title\s*=|setAttribute\(['"]title/.test(js), 'title em ' + f);
    for (const m of js.matchAll(/console\.\w+\([^;]*\)/g)) assert.ok(!/\b(link|codigo|código)\b/.test(m[0].replace(/'[^']*'/g, '')), 'console com dado sensível: ' + m[0]);
  }
  assert.ok(!/console\./.test(semComentario('conectar-cartoes.js')), 'cartões não escrevem no console');
  assert.ok(!/[—–]/.test(lePub('modal-login.js') + lePub('modal-login.css') + lePub('conectar-puro.js') + lePub('conversa.html')));
});

test('modal-login.js: vídeo, escolha guardada no servidor, 401 volta para a conversa e só as rotas do modal', () => {
  const js = semComentario('modal-login.js');
  assert.match(js, /preload = 'none'/);
  assert.match(js, /playsInline = true/);
  assert.match(js, /controls = true/);
  assert.match(js, /\/videos\/conhecendo-o-dgclaw\.jpg/);
  assert.match(js, /\/videos\/conhecendo-o-dgclaw\.mp4/);
  assert.match(js, /addEventListener\('error', \(\) => \{ bloco\.hidden = true; \}\)/);
  assert.ok(!/sessionStorage|localStorage/.test(js), 'a escolha mora no servidor, não no navegador');
  assert.match(js, /nao_mostrar_mais: true/);
  assert.match(js, /agentesNovosParaModal/);
  assert.match(js, /voltarPara: location\.pathname \+ location\.search/);
  assert.match(js, /CustomEvent\('dgmodallogin:abriu'\)/);
  assert.match(js, /window\.DGModalLogin = \{ aberto/);
  const rotas = [...js.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...rotas].sort(), ['/api/v1/agents', '/api/v1/modal-login/preferencia']);
  assert.match(js, /ROTA_PREF = '\/api\/v1\/modal-login\/preferencia'/);
});

test('conversa.js: o pop-up de login expirado respeita o modal (aberto ou já aberto nesta carga)', () => {
  const js = semComentario('conversa.js');
  assert.match(js, /function leAbre\(\) \{\s*if \(!LE \|\| !leDlg \|\| le\.aberto \|\| leModalLoginAtivo\(\)\) return;/);
  assert.match(js, /m\.aberto\(\) \|\| m\.abriuNestaCarga\(\)/);
  assert.match(js, /addEventListener\('dgmodallogin:abriu', \(\) => leFecha\(false\)\)/);
});

test('segue valendo: o POST do cartão manda o provedor escolhido', () => {
  assert.match(semComentario('conectar-cartoes.js'), /\{ provedor: ia\.escolhido\.id \}/);
});

test('agentesNovosParaModal: aparece uma vez; agente novo reabre; "não mostrar mais" cala tudo', () => {
  const ids = ['admin', 'sofia', 'rita'];
  const selos = [S('conectado'), S('falta'), S('expirou')];
  assert.deepEqual(P.agentesNovosParaModal(ids, selos, { vistos: [], nao_mostrar_mais: false }), ['sofia', 'rita']);
  assert.deepEqual(P.agentesNovosParaModal(ids, selos, { vistos: ['sofia', 'rita'], nao_mostrar_mais: false }), []);
  assert.deepEqual(P.agentesNovosParaModal(ids, selos, { vistos: ['sofia'] }), ['rita']);
  assert.deepEqual(P.agentesNovosParaModal(ids, selos, { vistos: [], nao_mostrar_mais: true }), []);
  assert.deepEqual(P.agentesNovosParaModal(ids, [S('api'), S('andamento'), S('sem_resposta')], {}), []);
  assert.deepEqual(P.agentesNovosParaModal(ids, selos, null), ['sofia', 'rita']);
  assert.deepEqual(P.agentesNovosParaModal(null, null, null), []);
  assert.equal(P.textosModal(2).nunca, 'Não mostrar mais');
});
