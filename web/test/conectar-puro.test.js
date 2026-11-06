'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/conectar-puro');

const LINK = 'https://claude.ai/oauth/authorize?state=ESTADO-SECRETO-123';
const ADMIN = { id: 'admin', nome: 'Admin', tipo: 'admin', provedor: 'claude' };
const ANA = { id: 'ana', nome: 'Ana', tipo: 'agente', subtitulo: 'Atendimento', provedor: 'claude' };
const BIA = { id: 'bia', nome: 'Bia', tipo: 'agente', provedor: 'codex' };
const OK = { estado: 'nenhum', provedor: 'claude', auth: 'assinatura', conferido: { ok: true }, precisa_login: false };
const FALTA = { estado: 'nenhum', provedor: 'claude', auth: 'assinatura', conferido: { ok: false }, precisa_login: true };

test('ordem: Admin primeiro, os demais na ordem de entrada, sem mexer na lista', () => {
  const entrada = [ANA, ADMIN, BIA];
  assert.deepEqual(P.ordenar(entrada).map(a => a.id), ['admin', 'ana', 'bia']);
  assert.deepEqual(entrada.map(a => a.id), ['ana', 'admin', 'bia']);
  assert.deepEqual(P.ordenar(null), []);
});

test('rótulos: Admin, principal (primeiro agente de trabalho) e demais, com o papel de cada um', () => {
  assert.equal(P.principal([ANA, ADMIN, BIA]).id, 'ana');
  assert.equal(P.principal([ADMIN]), null);
  const adm = P.papel(ADMIN, false);
  assert.equal(adm.rotulo, 'Agente admin');
  assert.equal(adm.papel, 'Para administrar: atualizar o DG Claw, criar agentes e configurar.');
  const pri = P.papel(ANA, true);
  assert.equal(pri.rotulo, 'Agente principal');
  assert.equal(pri.papel, 'O seu agente do dia a dia: é com ele que você conversa e pede tarefas.');
  assert.equal(pri.subtitulo, 'Atendimento');
  const dem = P.papel(BIA, false);
  assert.equal(dem.rotulo, 'Agente de trabalho');
  assert.equal(dem.subtitulo, '');
  // o nome do agente continua na visão, junto do rótulo
  const v = P.visaoCartao(OK, { agente: ANA, principal: true });
  assert.equal(v.rotulo, 'Agente principal'); assert.equal(v.nome, 'Ana');
  assert.equal(P.visaoCartao(OK, { agente: BIA, principal: false }).rotulo, 'Agente de trabalho');
  assert.equal(P.visaoCartao(OK, { agente: ADMIN }).rotulo, 'Agente admin');
});

test('mini tutorial: endereço, usuário, itens e legenda do vídeo; nunca senha', () => {
  const t = P.pronto({ usuario: 'danilo', principalNome: 'Lucro FC', endereco: 'https://x.test/' });
  assert.equal(t.titulo, 'Tudo pronto! Agora é só usar');
  assert.equal(t.passo1, '1. Acesse o seu painel:');
  assert.equal(t.endereco, 'https://x.test/');
  assert.equal(t.passo2, '2. Entre com o usuário danilo e a mesma senha que você usou para entrar aqui.');
  assert.equal(t.passo3, '3. O que você vai ver:');
  assert.deepEqual(t.itens, ['Admin: para administrar (atualizar o DG Claw, criar agentes e configurar).',
    'Lucro FC: o seu agente do dia a dia. Você pode trocar o nome dele depois, é só pedir ao Admin.']);
  assert.equal(t.legendaVideo, 'Veja em menos de 1 minuto');
  assert.equal(P.pronto({ endereco: 'x' }).itens.length, 1);
  assert.match(P.pronto({ endereco: 'x' }).passo2, /usuário que você escolheu/);
  assert.ok(!/[—–]/.test(JSON.stringify(t)));
});

test('selos: conectado, falta, expirou, api, token, sem resposta e andamento', () => {
  assert.deepEqual(P.selo(OK), { chave: 'conectado', texto: 'Conectado', cor: 'verde' });
  assert.deepEqual(P.selo(FALTA), { chave: 'falta', texto: 'Falta conectar', cor: 'ambar' });
  assert.deepEqual(P.selo(Object.assign({}, FALTA, { login_expirado: true })), { chave: 'expirou', texto: 'Login expirou', cor: 'vermelho' });
  assert.deepEqual(P.selo(Object.assign({}, OK, { auth: 'api' })), { chave: 'api', texto: 'Usa chave de API', cor: 'cinza' });
  assert.equal(P.selo(Object.assign({}, OK, { auth: 'token' })).chave, 'api');
  assert.deepEqual(P.selo(null), { chave: 'sem_resposta', texto: 'Não consegui conferir', cor: 'cinza' });
  assert.equal(P.selo(OK, { erroConferir: 'x' }).chave, 'sem_resposta');
  assert.equal(P.selo(Object.assign({}, FALTA, { estado: 'aguardando_codigo' })).chave, 'andamento');
  // runner que não confirma (conferido null) não vira "Conectado"
  assert.equal(P.selo({ estado: 'nenhum', auth: null, conferido: null, precisa_login: false }).chave, 'falta');
});

test('selo: concluído nesta página vira Conectado; concluído que sobrou de antes não', () => {
  const conc = Object.assign({}, FALTA, { estado: 'concluido' });
  assert.equal(P.selo(conc, { concluiuAgora: true }).chave, 'conectado');
  assert.equal(P.selo(conc).chave, 'falta');
});

test('cartão: cada fase mostra só o que precisa', () => {
  const v = (d, ctx) => P.visaoCartao(d, Object.assign({ agente: ANA }, ctx));
  const falta = v(FALTA);
  assert.equal(falta.fase, 'inicio'); assert.equal(falta.gerar, true); assert.equal(falta.gerarRotulo, 'Gerar link de login');
  const exp = v(Object.assign({}, FALTA, { login_expirado: true }));
  assert.match(exp.texto, /expirou/);
  const ok = v(OK);
  assert.equal(ok.fase, 'conectado'); assert.equal(ok.entrarOutra, true); assert.equal(ok.gerar, false);
  const prep = v({ estado: 'aguardando_link', provedor: 'claude' }, { iniciado: true });
  assert.equal(prep.fase, 'preparando'); assert.equal(prep.cancelar, true);
  const cod = v({ estado: 'aguardando_codigo', provedor: 'claude', link: LINK }, { iniciado: true });
  assert.equal(cod.fase, 'codigo'); assert.equal(cod.link, LINK); assert.equal(cod.campoCodigo, true);
  assert.equal(cod.cancelar, true); assert.equal(cod.novoLink, true);
  const nav = v({ estado: 'aguardando_navegador', provedor: 'codex', link: LINK, codigoDispositivo: 'ABCD-1234' }, { iniciado: true });
  assert.equal(nav.fase, 'navegador'); assert.equal(nav.codigoDispositivo, 'ABCD-1234'); assert.equal(nav.campoCodigo, false);
  const conc = v({ estado: 'concluido', provedor: 'claude' }, { iniciado: true, concluiuAgora: true });
  assert.equal(conc.fase, 'concluido'); assert.equal(conc.texto, 'Seu agente DG Claw já está conectado.'); assert.equal(conc.selo.chave, 'conectado');
  const fal = v({ estado: 'falhou', provedor: 'claude', mensagem: 'O login não foi concluído em 15 minutos e foi cancelado. Inicie de novo.' }, { iniciado: true });
  assert.equal(fal.fase, 'falhou'); assert.match(fal.texto, /15 minutos/); assert.equal(fal.gerarRotulo, 'Gerar novo link');
  // falhou que sobrou de antes não aparece como novidade
  assert.equal(v({ estado: 'falhou', provedor: 'claude', mensagem: 'x' }, {}).fase, 'inicio');
});

test('cartão: agente com chave de API não tem botão; sem resposta tem a causa', () => {
  const api = P.visaoCartao(Object.assign({}, OK, { auth: 'api' }), { agente: ANA });
  assert.equal(api.fase, 'api'); assert.equal(api.gerar, false); assert.equal(api.entrarOutra, false);
  assert.match(api.texto, /chave de API/);
  const sem = P.visaoCartao(null, { agente: ANA, erroConferir: 'O programa de Ana não respondeu (ECONNREFUSED).' });
  assert.equal(sem.fase, 'sem_resposta'); assert.match(sem.texto, /ECONNREFUSED/); assert.equal(sem.gerar, false);
});

test('cartão: outro login em andamento bloqueia o botão com a frase certa', () => {
  const c = P.visaoCartao(FALTA, { agente: ANA, outroNome: 'Bia' });
  assert.equal(c.gerar, false); assert.equal(c.gerarBloqueio, 'Termine o login do Bia primeiro.');
});

test('o link só aparece nas fases de link', () => {
  const estados = [
    FALTA, OK, Object.assign({}, OK, { auth: 'api' }), null,
    { estado: 'aguardando_link', link: LINK }, { estado: 'concluido', link: LINK }, { estado: 'falhou', link: LINK, mensagem: 'x' },
    Object.assign({}, FALTA, { link: LINK }),
  ];
  for (const d of estados) {
    const v = P.visaoCartao(d, { agente: ANA, iniciado: true, concluiuAgora: d && d.estado === 'concluido' });
    const conteudo = JSON.stringify(v);
    assert.ok(!conteudo.includes('ESTADO-SECRETO'), 'vazou o link na fase ' + v.fase);
    assert.equal(v.link, null);
  }
  for (const est of ['aguardando_codigo', 'aguardando_navegador']) {
    assert.equal(P.visaoCartao({ estado: est, link: LINK }, { agente: ANA, iniciado: true }).link, LINK);
  }
  // link que não é https nunca vira botão
  assert.equal(P.visaoCartao({ estado: 'aguardando_codigo', link: 'javascript:alert(1)' }, { agente: ANA, iniciado: true }).link, null);
  assert.equal(P.visaoCartao({ estado: 'aguardando_codigo', link: 'http://x.test/' }, { agente: ANA, iniciado: true }).link, null);
});

test('tudoConectado: ignora quem usa chave de API e exige ao menos um conectado', () => {
  const s = chave => ({ chave });
  assert.equal(P.tudoConectado([s('conectado'), s('api')]), true);
  assert.equal(P.tudoConectado([s('conectado'), s('falta')]), false);
  assert.equal(P.tudoConectado([s('api')]), false);
  assert.equal(P.tudoConectado([]), false);
});

test('limpaCodigo tira só as pontas e não conserta o meio', () => {
  assert.equal(P.limpaCodigo('  abc#def \n'), 'abc#def');
  assert.equal(P.limpaCodigo('abc def'), 'abc def');
  assert.equal(P.limpaCodigo('abc\ndef'), 'abc\ndef');
  assert.equal(P.limpaCodigo(null), '');
});

test('erros traduzidos: cada um diz o que houve e o que fazer', () => {
  const t = (s, m, a, n) => P.traduzErro(s, m, a, n);
  const e401 = t(401, 'x', 'gerar'); assert.equal(e401.sessaoExpirada, true); assert.match(e401.texto, /login/);
  const e503 = t(503, 'connect ECONNREFUSED', 'gerar', 'Ana');
  assert.match(e503.texto, /Ana/); assert.match(e503.texto, /ECONNREFUSED/); assert.match(e503.texto, /Status|reiniciá-lo/);
  const e409 = t(409, 'já há um login', 'gerar', 'Ana'); assert.match(e409.texto, /login em andamento/); assert.match(e409.texto, /Cancelar/);
  const srv = 'O código tem espaço ou quebra de linha no meio. Copie só o código. Nada foi enviado.';
  assert.equal(t(400, srv, 'codigo').texto, srv);
  assert.equal(t(400, srv, 'codigo').sessaoExpirada, false);
  const venc = t(422, 'código inválido ou expirado', 'codigo');
  assert.equal(venc.texto, 'O código não valeu. Ele vence em poucos minutos e só serve uma vez. Toque em Gerar novo link e cole o código novo logo em seguida.');
  assert.match(t(500, 'O login não foi concluído em 15 minutos e foi cancelado.', 'conferir').texto, /15 minutos/);
  assert.match(t(504, 'não ficou pronto em 60 s', 'oi', 'Ana').texto, /Ana/);
  const rede = t(0, 'Failed to fetch', 'gerar'); assert.match(rede.texto, /Failed to fetch/); assert.match(rede.texto, /internet/);
  const outro = t(502, 'algo', 'cancelar'); assert.match(outro.texto, /502/); assert.match(outro.texto, /algo/);
  const vazio = t(500, '', 'gerar'); assert.ok(vazio.texto.length > 20);
});

test('falha do runner: código ruim e prazo viram frase de leigo; o resto passa como veio', () => {
  assert.match(P.traduzFalha('O login do Claude não terminou. Confira se o código colado é o da página de autorização e inicie de novo.'), /O código não valeu/);
  assert.match(P.traduzFalha('O login não foi concluído em 15 minutos e foi cancelado. Inicie de novo'), /prazo de 15 minutos/);
  assert.equal(P.traduzFalha('Outra coisa específica.'), 'Outra coisa específica.');
  assert.match(P.traduzFalha(''), /Gerar link de login/);
});

test('nenhum texto da parte pura tem travessão', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'conectar-puro.js'), 'utf8');
  assert.ok(!/[—–]/.test(src));
  for (const f of ['conectar.js', 'conectar.html', 'conectar-cartoes.js', 'conectar-cartoes.css', 'provedores.js']) assert.ok(!/[—–]/.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')), f);
});

test('segredo: a página e o módulo dos cartões não mandam link nem código para console, storage ou title', () => {
  const le = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['conectar.js', 'conectar-cartoes.js']) {
    const js = le(f);
    assert.ok(!/console\./.test(js), 'console em ' + f);
    assert.ok(!/localStorage|sessionStorage/.test(js), f);
    assert.ok(!/\.title\s*=|setAttribute\(['"]title/.test(js), f);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(js), 'HTML montado com texto do servidor em ' + f);
  }
  assert.match(le('conectar.js'), /addEventListener\('error', \(\) => \{ bloco\.hidden = true; \}\)/);
  assert.match(le('conectar.js'), /preload = 'metadata'/);
  assert.match(le('conectar-cartoes.js'), /rel = 'noopener noreferrer'/);
  assert.match(le('conectar-cartoes.js'), /autocapitalize/);
});
