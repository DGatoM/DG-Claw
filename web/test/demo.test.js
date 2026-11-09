'use strict';
// Modo demonstração: o Portão do agente, os cartões, a auditoria, os anexos e o Reset (docs/MODO-DEMONSTRACAO.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirDemo, CHAVES, TOKEN } = require('./demo-ajuda');
const { criarDemo, carregarConfig } = require('../lib/demo');
const { pastaTemp, capturaLog } = require('./ajuda');
const { escreveConfig } = require('./demo-ajuda');

const ROTAS = { contato: '/api/demo/v1/contato', envio: '/api/demo/v1/envio' };
const lerAuditoria = (w) => fs.readFileSync(path.join(w.dados, 'demo', 'auditoria.jsonl'), 'utf8');
const TEXTO = 'Oi Maria,\nsegue a <proposta> de R$ 1.500 & prazo de 10 dias.\nAbraço!';

async function comTeste(opcoes, corpo) {
  const w = await subirDemo(opcoes);
  try { await corpo(w); } finally { await w.fechar(); }
}

/** Cria um envio de WhatsApp para o contato liberado e devolve o id. */
async function pedeEnvio(w, extra) {
  const ref = await w.liberaContato();
  const r = await w.portao('POST', ROTAS.envio, Object.assign({ canal: 'whatsapp', linha: 'danilo', ref, texto: TEXTO }, extra || {}));
  assert.equal(r.status, 201, r.texto);
  return r.json.id;
}

// ── desligado ────────────────────────────────────────────────────────────────
test('sem DGCLAW_DEMO_CONFIG tudo responde 404 e a conversa não carrega a tela dos cartões', () => comTeste({ semDemo: true }, async (w) => {
  for (const [m, p] of [['GET', '/api/demo/v1/envio/x'], ['POST', ROTAS.contato], ['POST', ROTAS.envio]]) {
    const r = await w.portao(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.json.codigo, 'DEMO_DESLIGADO');
  }
  for (const [m, p] of [['GET', '/api/demo/cartoes'], ['GET', '/api/demo/reset/estado']]) {
    assert.equal((await w.c.pedir(m, p)).status, 404, p);
  }
  assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 404);
  const pagina = await w.c.get('/a/nova');
  assert.equal(pagina.status, 200);
  assert.ok(!pagina.texto.includes('demo-cartoes'), 'a conversa não pode carregar a tela do modo demonstração');
}));

test('a conversa carrega a tela dos cartões só no modo demonstração', () => comTeste({}, async (w) => {
  const pagina = await w.c.get('/a/nova');
  assert.ok(pagina.texto.includes('/demo-cartoes.js') && pagina.texto.includes('/demo-cartoes.css'));
  for (const f of ['demo-cartoes.js', 'demo-cartoes.css']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), `falta public/${f}`);
}));

test('configuração defeituosa deixa o modo desligado e explica o motivo (nunca meio ligado)', async () => {
  for (const [nome, opcoes, motivo] of [
    ['chave com permissão aberta', { modoChave: 0o644 }, /permissão aberta demais/],
    ['demo.json com permissão aberta', { modoArquivo: 0o644 }, /permissão aberta demais/],
    ['token sem hash', { ajusta: (j) => { delete j.token_agente_sha256; } }, /token_agente_sha256/],
    ['linha de tipo desconhecido', { ajusta: (j) => { j.linhas_whatsapp[0].tipo = 'zapzap'; } }, /organizap ou cpdf/],
    ['arquivo de chave faltando', { ajusta: (j) => { j.linhas_whatsapp[0].chave_arquivo = '/nao/existe.key'; } }, /não existe/],
  ]) {
    await comTeste(opcoes, async (w) => {
      const r = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' });
      assert.equal(r.status, 503, nome);
      assert.equal(r.json.codigo, 'DEMO_COM_DEFEITO', nome);
      assert.match(r.json.erro, motivo, nome);
      const t = await w.c.get('/api/demo/cartoes');
      assert.equal(t.status, 503, nome);
      assert.match(t.json.erro, motivo, nome);
      assert.match(w.log.texto(), /Modo demonstração DESLIGADO/, nome);
    });
  }
});

// ── Portão: autenticação e superfície ────────────────────────────────────────
test('token errado ou ausente é 401, e o token certo passa', () => comTeste({}, async (w) => {
  for (const tk of ['errado', '', null]) {
    const r = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' }, tk);
    assert.equal(r.status, 401, `token ${JSON.stringify(tk)}`);
    assert.equal(r.json.codigo, 'TOKEN_INVALIDO');
  }
  assert.equal((await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' })).status, 201);
  assert.equal(w.fake.chamadas.length, 0, 'pedir o contato não consulta o provedor: só a tela busca, depois do cartão');
}));

test('não existe rota de listar conversas nem contatos', () => comTeste({}, async (w) => {
  for (const p of ['/api/demo/v1/conversas', '/api/demo/v1/contatos', '/api/demo/v1/chats', '/api/demo/v1/envios', '/api/demo/v1/']) {
    const r = await w.portao('GET', p);
    assert.equal(r.status, 404, p);
    assert.equal(r.json.codigo, 'ROTA_INEXISTENTE');
  }
  assert.ok((await w.portao('GET', ROTAS.contato)).status >= 400, 'GET /contato não lista nada');
  assert.equal(w.fake.chamadas.length, 0);
}));

test('o Portão limita a 60 pedidos por minuto', () => comTeste({}, async (w) => {
  let ultimo;
  for (let i = 0; i < 61; i++) ultimo = await w.portao('GET', '/api/demo/v1/envio/inexistente');
  assert.equal(ultimo.status, 429);
  assert.equal(ultimo.json.codigo, 'MUITOS_PEDIDOS');
  assert.ok(ultimo.headers.get('retry-after'));
  w.relogio.t += 61000;
  assert.equal((await w.portao('GET', '/api/demo/v1/envio/inexistente')).status, 404);
}));

// ── contato e leitura ────────────────────────────────────────────────────────
test('nome com menos de 3 caracteres é recusado, e linha desconhecida também', () => comTeste({}, async (w) => {
  const curto = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'Ma' });
  assert.equal(curto.status, 400);
  assert.equal(curto.json.codigo, 'NOME_CURTO');
  assert.equal((await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: '  ab ' })).status, 400);
  const linha = await w.portao('POST', ROTAS.contato, { linha: 'nenhuma', nome: 'maria' });
  assert.equal(linha.status, 404);
  assert.equal(linha.json.codigo, 'LINHA_DESCONHECIDA');
  assert.equal(fs.existsSync(path.join(w.dados, 'demo', 'cartoes')), false, 'pedido recusado não deixa cartão');
}));

test('os candidatos aparecem só na tela e nunca na resposta ao agente; a conversa traz as mensagens mais recentes', () => comTeste({}, async (w) => {
  const p = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' });
  assert.equal(p.status, 201);
  assert.deepEqual(Object.keys(p.json).sort(), ['aviso', 'estado', 'id', 'ok']);
  assert.ok(!/Souza|Silva|chat-maria|5511999990/.test(p.texto));

  const espera = await w.portao('GET', `${ROTAS.contato}/${p.json.id}`);
  assert.equal(espera.json.estado, 'aguardando');
  assert.ok(!/Souza|Silva|chat-maria|5511999990|candidat/i.test(espera.texto));

  const tela = (await w.c.get('/api/demo/cartoes')).json;
  assert.equal(tela.cartoes.length, 1);
  const cartao = tela.cartoes[0];
  assert.equal(cartao.tipo, 'leitura');
  assert.deepEqual(cartao.candidatos.map((c) => c.nome), ['Maria Silva', 'Maria Souza', 'Maria Lid']);
  assert.ok(cartao.candidatos.every((c) => !c.telefone), 'a tela recebe só o telefone mascarado');
  assert.equal(cartao.candidatos[0].telefone_mascarado, '+55 ••••• 0001');
  assert.equal(cartao.candidatos[2].sem_numero, true);

  // Confirmar com quem não está na lista é recusado.
  const falso = await w.decide(p.json.id, { decisao: 'confirmar', candidato: 'chat-que-nao-esta-na-lista' });
  assert.equal(falso.status, 409);
  assert.equal(falso.json.codigo, 'CANDIDATO_INVALIDO');
  assert.equal((await w.decide(p.json.id, { decisao: 'confirmar' })).json.codigo, 'CANDIDATO_OBRIGATORIO');

  const ok = await w.decide(p.json.id, { decisao: 'confirmar', candidato: 'chat-maria-silva' });
  assert.equal(ok.status, 200);
  const lib = await w.portao('GET', `${ROTAS.contato}/${p.json.id}`);
  assert.equal(lib.json.estado, 'liberado');
  assert.deepEqual(lib.json.contato, { nome: 'Maria Silva', telefone_mascarado: '+55 ••••• 0001', ref: p.json.id });
  assert.ok(!/Souza|5511999990001/.test(lib.texto), 'nem o número inteiro, nem os outros candidatos');

  const conv = await w.portao('GET', `${ROTAS.contato}/${p.json.id}/conversa?limite=2`);
  assert.equal(conv.status, 200);
  assert.deepEqual(conv.json.mensagens.map((m) => [m.de, m.texto]), [['nos', 'Claro, já te mando'], ['contato', '[áudio transcrito]: pode ser hoje']], 'as mais recentes, em ordem');
  const leitura = w.fake.chamadas.find((c) => /\/transcript$/.test(c.caminho));
  assert.ok(leitura.busca.since, 'o limit do Organizap traz o COMEÇO da conversa: a leitura precisa usar since');
  assert.equal(leitura.busca.format, 'json');
}));

test('contato não liberado não abre conversa', () => comTeste({}, async (w) => {
  const p = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' });
  const aguardando = await w.portao('GET', `${ROTAS.contato}/${p.json.id}/conversa`);
  assert.equal(aguardando.status, 409);
  assert.equal(aguardando.json.codigo, 'CONTATO_NAO_LIBERADO');
  const inventado = await w.portao('GET', `${ROTAS.contato}/chat-maria-silva/conversa`);
  assert.equal(inventado.status, 404, 'o id do chat do provedor não abre nada: só o ref que o Portão devolveu');
  assert.equal((await w.decide(p.json.id, { decisao: 'recusar' })).status, 200);
  const recusado = await w.portao('GET', `${ROTAS.contato}/${p.json.id}/conversa`);
  assert.equal(recusado.status, 409);
  assert.match((await w.portao('GET', `${ROTAS.contato}/${p.json.id}`)).json.motivo, /recusou/);
  assert.equal(w.fake.chamadas.filter((c) => /transcript/.test(c.caminho)).length, 0, 'nenhuma leitura chegou ao provedor');
}));

test('a liberação do contato vale 30 minutos', () => comTeste({}, async (w) => {
  const ref = await w.liberaContato();
  assert.equal((await w.portao('GET', `${ROTAS.contato}/${ref}/conversa`)).status, 200);
  w.relogio.t += 31 * 60 * 1000;
  const r = await w.portao('GET', `${ROTAS.contato}/${ref}/conversa`);
  assert.equal(r.status, 409);
  assert.equal((await w.portao('GET', `${ROTAS.contato}/${ref}`)).json.estado, 'expirado');
}));

// ── decisão: só o dono, no painel ────────────────────────────────────────────
test('o agente não consegue decidir um cartão só com o token', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  const url = `/api/demo/cartoes/${id}/decisao`;
  const corpo = JSON.stringify({ decisao: 'confirmar' });
  const origem = `http://127.0.0.1:${w.porta}`;
  const tenta = (h) => fetch(`${origem}${url}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: corpo });
  assert.equal((await tenta({ Authorization: `Bearer ${TOKEN}` })).status, 403, 'sem Origin é recusado pela checagem de origem');
  assert.equal((await tenta({ Authorization: `Bearer ${TOKEN}`, Origin: origem })).status, 401, 'com Origin e sem cookie de sessão é 401');
  assert.equal((await tenta({ Origin: origem })).status, 401);
  const lista = await fetch(`${origem}/api/demo/cartoes`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(lista.status, 401, 'a lista dos cartões também é só da tela');
  assert.equal(w.fake.envios.length, 0);
  assert.equal((await w.portao('GET', `${ROTAS.envio}/${id}`)).json.estado, 'aguardando');
}));

test('sem clique nada é enviado', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(w.fake.envios.length, 0);
  assert.equal((await w.portao('GET', `${ROTAS.envio}/${id}`)).json.estado, 'aguardando');
}));

test('o cartão de envio mostra o destinatário com o número inteiro, o texto completo e os anexos', () => comTeste({}, async (w) => {
  fs.writeFileSync(path.join(w.casa, 'saida', 'proposta.pdf'), 'conteudo');
  const id = await pedeEnvio(w, { anexos: ['/home/agente/saida/proposta.pdf'] });
  const c = (await w.c.get('/api/demo/cartoes')).json.cartoes.find((x) => x.id === id);
  assert.equal(c.canal, 'whatsapp');
  assert.equal(c.linha_rotulo, 'WhatsApp do Danilo');
  assert.deepEqual(c.destinatario, { nome: 'Maria Silva', telefone: '+5511999990001', para: null });
  assert.equal(c.texto, TEXTO);
  assert.deepEqual(c.anexos, [{ nome: 'proposta.pdf', tamanho: 8 }]);
}));

test('o cartão é de uso único e o texto enviado é exatamente o do cartão', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  const [a, b] = await Promise.all([w.decide(id, { decisao: 'confirmar' }), w.decide(id, { decisao: 'confirmar' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const fim = await w.esperaFim(id);
  assert.equal(fim.estado, 'enviado');
  assert.equal(w.fake.envios.length, 1, 'duas confirmações simultâneas enviam uma vez só');
  const e = w.fake.envios[0];
  assert.deepEqual(e.corpo, { chatId: 'chat-maria-silva', type: 'text', content: TEXTO });
  assert.equal(e.chave, id, 'a Idempotency-Key é o id do cartão');
  const de_novo = await w.decide(id, { decisao: 'confirmar' });
  assert.equal(de_novo.status, 409);
  assert.equal(de_novo.json.codigo, 'CARTAO_JA_DECIDIDO');
  assert.equal(w.fake.envios.length, 1);
}));

test('202 do provedor vira enviado, marcado como "na fila"; falha do provedor vira falhou com a causa', () => comTeste({}, async (w) => {
  w.fake.status202 = true;
  const id = await pedeEnvio(w);
  await w.decide(id, { decisao: 'confirmar' });
  const fim = await w.esperaFim(id);
  assert.equal(fim.estado, 'enviado');
  assert.match(fim.observacao, /fila/);

  w.fake.status202 = false;
  const id2 = await pedeEnvio(w);
  const id3 = await pedeEnvio(w);
  w.fake.falha = { status: 422, corpo: { success: false, code: 'RECIPIENT_IS_LID', error: 'lid' } };
  await w.decide(id2, { decisao: 'confirmar' });
  const f2 = await w.esperaFim(id2);
  assert.equal(f2.estado, 'falhou');
  assert.equal(f2.codigo, 'DESTINO_SEM_NUMERO');
  assert.match(f2.motivo, /número do contato/);
  w.fake.falha = { status: 500, corpo: { error: 'quebrou' } };
  await w.decide(id3, { decisao: 'confirmar' });
  const f3 = await w.esperaFim(id3);
  assert.equal(f3.estado, 'falhou');
  assert.match(f3.motivo, /500/);
  assert.ok(!f3.motivo.includes(CHAVES['organizap.key']), 'a chave nunca aparece');
}));

test('recusar não envia e o agente é avisado para não reenviar', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  assert.equal((await w.decide(id, { decisao: 'recusar' })).status, 200);
  const r = await w.portao('GET', `${ROTAS.envio}/${id}`);
  assert.equal(r.json.estado, 'recusado');
  assert.match(r.json.motivo, /não reenvie/i);
  assert.equal((await w.decide(id, { decisao: 'confirmar' })).status, 409);
  assert.equal(w.fake.envios.length, 0);
}));

test('o cartão expira em 10 minutos e depois disso não confirma mais', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  w.relogio.t += 11 * 60 * 1000;
  const r = await w.portao('GET', `${ROTAS.envio}/${id}`);
  assert.equal(r.json.estado, 'expirado');
  const d = await w.decide(id, { decisao: 'confirmar' });
  assert.equal(d.status, 409);
  assert.match(d.json.erro, /expirou/);
  assert.equal(w.fake.envios.length, 0);
  assert.equal((await w.c.get('/api/demo/cartoes')).json.cartoes.length, 0);
}));

test('no máximo 10 cartões abertos de uma vez', () => comTeste({}, async (w) => {
  for (let i = 0; i < 10; i++) assert.equal((await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' })).status, 201);
  const r = await w.portao('POST', ROTAS.contato, { linha: 'danilo', nome: 'maria' });
  assert.equal(r.status, 429);
  assert.equal(r.json.codigo, 'MUITOS_CARTOES_ABERTOS');
}));

// ── destinos de teste ────────────────────────────────────────────────────────
test('destinos_de_teste bloqueia o destino de fora, também no clique', () => comTeste({ ajusta: (j) => { j.destinos_de_teste = ['+55 11 99999-0001']; } }, async (w) => {
  // Maria Silva (…0001) está na lista; Maria Souza (…0002) não.
  const ok = await w.liberaContato('chat-maria-silva');
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref: ok, texto: 'oi' })).status, 201);
  const fora = await w.liberaContato('chat-maria-souza');
  const r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref: fora, texto: 'oi' });
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'DESTINO_FORA_DO_TESTE');
  const email = await w.portao('POST', ROTAS.envio, { canal: 'email', para: 'cliente@empresa.com', assunto: 'Oi', texto: 'oi' });
  assert.equal(email.json.codigo, 'DESTINO_FORA_DO_TESTE', 'e-mail também fica fora da lista de telefones');

  // Mesmo com um cartão que já existe em disco (criado antes da trava, por exemplo) o clique não envia.
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const agora = w.relogio.t;
  fs.mkdirSync(path.join(w.dados, 'demo', 'cartoes'), { recursive: true });
  fs.writeFileSync(path.join(w.dados, 'demo', 'cartoes', `${id}.json`), JSON.stringify({
    id, tipo: 'envio', canal: 'whatsapp', linha: 'danilo', texto: 'oi', anexos: [], estado: 'aguardando', criado_em: agora, expira_em: agora + 600000,
    destinatario: { nome: 'Maria Souza', telefone: '5511999990002', ref_provedor: 'chat-maria-souza', via: 'contato' },
  }), { mode: 0o600 });
  const clique = await w.decide(id, { decisao: 'confirmar' });
  assert.equal(clique.status, 403);
  assert.equal(clique.json.codigo, 'DESTINO_FORA_DO_TESTE');
  assert.equal(w.fake.envios.length, 0, 'nada saiu para fora da lista');
  const fim = await w.portao('GET', `${ROTAS.envio}/${id}`);
  assert.equal(fim.json.estado, 'falhou');
  assert.equal(fim.json.codigo, 'DESTINO_FORA_DO_TESTE');
}));

// ── telefone, linhas e e-mail ────────────────────────────────────────────────
test('linha Organizap com telefone só vale se a conversa já existe; linha CPDF aceita telefone', () => comTeste({}, async (w) => {
  const sem = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', telefone: '+55 11 90000-0000', texto: 'oi' });
  assert.equal(sem.status, 422);
  assert.equal(sem.json.codigo, 'SEM_CONVERSA_ABERTA');
  assert.match(sem.json.erro, /outra linha/);
  const com = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', telefone: '11999990001', texto: 'oi' });
  assert.equal(com.status, 201, 'número sem DDI ganha o 55 e acha a conversa da Maria');
  const cpdf = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'isa', telefone: '5511977776666', texto: 'oi pelo CPDF' });
  assert.equal(cpdf.status, 201);
  await w.decide(cpdf.json.id, { decisao: 'confirmar' });
  assert.equal((await w.esperaFim(cpdf.json.id)).estado, 'enviado');
  assert.deepEqual(w.fake.envios[0].corpo, { instanceId: 'inst-1', phone: '5511977776666', message: 'oi pelo CPDF' });
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', telefone: '123', texto: 'oi' })).json.codigo, 'TELEFONE_INVALIDO');
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', texto: 'oi' })).json.codigo, 'DESTINO_AMBIGUO');
}));

test('e-mail sai pelo Organizap com o texto do cartão e o anexo em base64', () => comTeste({}, async (w) => {
  fs.writeFileSync(path.join(w.casa, 'saida', 'proposta.pdf'), 'PDF-DE-TESTE');
  const r = await w.portao('POST', ROTAS.envio, { canal: 'email', para: 'cliente@empresa.com', assunto: 'Proposta', texto: TEXTO, anexos: ['/home/agente/saida/proposta.pdf'] });
  assert.equal(r.status, 201, r.texto);
  const cartao = (await w.c.get('/api/demo/cartoes')).json.cartoes[0];
  assert.deepEqual(cartao.destinatario, { nome: null, telefone: null, para: 'cliente@empresa.com' });
  assert.equal(cartao.assunto, 'Proposta');
  await w.decide(r.json.id, { decisao: 'confirmar' });
  assert.equal((await w.esperaFim(r.json.id)).estado, 'enviado');
  const e = w.fake.envios[0];
  assert.equal(e.via, 'email');
  assert.equal(e.chave, r.json.id);
  assert.equal(e.corpo.to, 'cliente@empresa.com');
  assert.equal(e.corpo.subject, 'Proposta');
  assert.equal(e.corpo.body, 'Oi Maria,<br>segue a &lt;proposta&gt; de R$ 1.500 &amp; prazo de 10 dias.<br>Abraço!');
  assert.deepEqual(e.corpo.attachments, [{ fileName: 'proposta.pdf', mimeType: 'application/pdf', content: Buffer.from('PDF-DE-TESTE').toString('base64') }]);
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'email', para: 'a@b.com, c@d.com', assunto: 'x', texto: 'x' })).json.codigo, 'EMAIL_INVALIDO');
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'email', para: 'a@b.com', assunto: 'x\ny', texto: 'x' })).json.codigo, 'ASSUNTO_INVALIDO');
}));

test('texto vazio, grande demais ou canal inválido são recusados com o motivo', () => comTeste({}, async (w) => {
  const ref = await w.liberaContato();
  const base = { canal: 'whatsapp', linha: 'danilo', ref };
  assert.equal((await w.portao('POST', ROTAS.envio, Object.assign({}, base, { texto: '   ' }))).json.codigo, 'TEXTO_OBRIGATORIO');
  const grande = await w.portao('POST', ROTAS.envio, Object.assign({}, base, { texto: 'a'.repeat(4001) }));
  assert.equal(grande.json.codigo, 'TEXTO_GRANDE');
  assert.match(grande.json.erro, /4000/);
  assert.equal((await w.portao('POST', ROTAS.envio, { canal: 'sms', texto: 'x' })).json.codigo, 'CANAL_INVALIDO');
  const corrompido = await fetch(`http://127.0.0.1:${w.porta}${ROTAS.envio}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{nao e json' });
  assert.equal(corrompido.status, 400);
}));

// ── anexos ───────────────────────────────────────────────────────────────────
test('anexos: atalho, ponto, fora da pasta, hardlink e arquivo trocado depois do cartão', () => comTeste({}, async (w) => {
  const ref = await w.liberaContato();
  const envia = (anexos) => w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: 'oi', anexos });
  const casa = w.casa;
  fs.writeFileSync(path.join(casa, 'arquivos', 'bom.pdf'), 'bom');
  fs.writeFileSync(path.join(casa, 'CLAUDE.md'), 'identidade');
  fs.writeFileSync(path.join(casa, 'arquivos', '.escondido'), 'x');
  fs.mkdirSync(path.join(casa, 'arquivos', 'sub'));
  fs.writeFileSync(path.join(casa, 'arquivos', 'sub', 'dentro.txt'), 'dentro');
  const fora = pastaTemp('fora');
  fs.writeFileSync(path.join(fora, 'segredo.txt'), 'segredo');
  fs.symlinkSync(path.join(fora, 'segredo.txt'), path.join(casa, 'arquivos', 'atalho.txt'));
  fs.symlinkSync(fora, path.join(casa, 'arquivos', 'pasta-atalho'));
  fs.linkSync(path.join(casa, 'arquivos', 'bom.pdf'), path.join(casa, 'saida', 'duplo.pdf'));

  const casos = [
    [['/home/agente/arquivos/atalho.txt'], 'ANEXO_COM_ATALHO'],
    [['/home/agente/arquivos/pasta-atalho/segredo.txt'], 'ANEXO_COM_ATALHO'],
    [['/home/agente/arquivos/.escondido'], 'ANEXO_CAMINHO_INVALIDO'],
    [['/home/agente/arquivos/sub/../bom.pdf'], 'ANEXO_CAMINHO_INVALIDO'],
    [['/home/agente/arquivos/./bom.pdf'], 'ANEXO_CAMINHO_INVALIDO'],
    [['/home/agente/arquivos//bom.pdf'], 'ANEXO_CAMINHO_INVALIDO'],
    [['/home/agente/CLAUDE.md'], 'ANEXO_FORA_DA_PASTA'],
    [['/etc/passwd'], 'ANEXO_FORA_DA_PASTA'],
    [['/home/agente/arquivos'], 'ANEXO_FORA_DA_PASTA'],
    [['/home/agente/arquivos/sub'], 'ANEXO_NAO_E_ARQUIVO'],
    [['/home/agente/arquivos/nao-existe.pdf'], 'ANEXO_NAO_ENCONTRADO'],
    [['/home/agente/saida/duplo.pdf'], 'ANEXO_COM_HARDLINK'],
    [[1], 'ANEXOS_INVALIDOS'],
    [Array(6).fill('/home/agente/arquivos/bom.pdf'), 'ANEXOS_DEMAIS'],
  ];
  for (const [anexos, codigo] of casos) {
    const r = await envia(anexos);
    assert.equal(r.json.codigo, codigo, `${JSON.stringify(anexos).slice(0, 80)}: ${r.texto}`);
    assert.ok(r.status >= 400);
  }
  assert.equal((await w.c.get('/api/demo/cartoes')).json.cartoes.length, 0, 'anexo recusado não gera cartão');

  fs.writeFileSync(path.join(casa, 'arquivos', 'ok.pdf'), 'ok');
  const bom = await envia(['/home/agente/arquivos/ok.pdf', '/home/agente/arquivos/sub/dentro.txt']);
  assert.equal(bom.status, 201, bom.texto);

  // O arquivo muda depois do cartão: o clique não envia nada.
  fs.writeFileSync(path.join(casa, 'arquivos', 'ok.pdf'), 'TROCADO DEPOIS DO CARTAO');
  const d = await w.decide(bom.json.id, { decisao: 'confirmar' });
  assert.equal(d.status, 409);
  assert.equal(d.json.codigo, 'ANEXO_MUDOU');
  assert.equal(w.fake.envios.length, 0);
  assert.equal((await w.portao('GET', `${ROTAS.envio}/${bom.json.id}`)).json.estado, 'falhou');

  // Trocado por um atalho no intervalo: a abertura com O_NOFOLLOW e a conferência recusam.
  const ok = await envia(['/home/agente/arquivos/sub/dentro.txt']);
  fs.rmSync(path.join(casa, 'arquivos', 'sub', 'dentro.txt'));
  fs.symlinkSync(path.join(fora, 'segredo.txt'), path.join(casa, 'arquivos', 'sub', 'dentro.txt'));
  const d2 = await w.decide(ok.json.id, { decisao: 'confirmar' });
  assert.equal(d2.json.codigo, 'ANEXO_COM_ATALHO');
  assert.equal(w.fake.envios.length, 0);
}));

test('anexo vai ao WhatsApp como data URL depois do texto, com chaves de idempotência próprias; linha CPDF recusa anexo', () => comTeste({}, async (w) => {
  fs.writeFileSync(path.join(w.casa, 'saida', 'foto.png'), 'PNG');
  const id = await pedeEnvio(w, { anexos: ['/home/agente/saida/foto.png'] });
  await w.decide(id, { decisao: 'confirmar' });
  assert.equal((await w.esperaFim(id)).estado, 'enviado');
  assert.equal(w.fake.envios.length, 2);
  assert.equal(w.fake.envios[0].corpo.type, 'text');
  assert.equal(w.fake.envios[1].corpo.type, 'image');
  assert.equal(w.fake.envios[1].corpo.content, `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`);
  assert.notEqual(w.fake.envios[1].chave, id);
  const cpdf = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'isa', telefone: '5511977776666', texto: 'oi', anexos: ['/home/agente/saida/foto.png'] });
  assert.equal(cpdf.json.codigo, 'ANEXO_NAO_SUPORTADO_NA_LINHA');
}));

// ── auditoria e arquivos em disco ────────────────────────────────────────────
test('a auditoria registra quem, canal, destinatário e hash, sem o corpo e sem o número inteiro', () => comTeste({}, async (w) => {
  const segredo = 'FRASE-SECRETA-DO-CORPO-4711';
  const ref = await w.liberaContato();
  const r = await w.portao('POST', ROTAS.envio, { canal: 'whatsapp', linha: 'danilo', ref, texto: segredo });
  await w.decide(r.json.id, { decisao: 'confirmar' });
  await w.esperaFim(r.json.id);
  await w.portao('GET', `${ROTAS.contato}/${ref}/conversa`);
  const bruto = lerAuditoria(w);
  assert.ok(!bruto.includes(segredo), 'o corpo da mensagem não vai para a auditoria');
  assert.ok(!bruto.includes('5511999990001'), 'o número inteiro não vai para a auditoria');
  assert.ok(!bruto.includes('Oi, quero uma proposta'), 'o conteúdo lido da conversa não vai para a auditoria');
  const linhas = bruto.trim().split('\n').map((l) => JSON.parse(l));
  const eventos = linhas.map((l) => l.evento);
  for (const e of ['pediu', 'liberou', 'confirmou', 'enviou', 'leu_conversa']) assert.ok(eventos.includes(e), `falta o evento ${e}: ${eventos}`);
  const conf = linhas.find((l) => l.evento === 'confirmou');
  assert.equal(conf.quem, 'dono');
  assert.equal(conf.canal, 'whatsapp');
  assert.equal(conf.final, '0001');
  assert.equal(conf.nome, 'Maria Silva');
  assert.equal(conf.id, r.json.id);
  assert.equal(conf.texto_sha256, require('node:crypto').createHash('sha256').update(segredo).digest('hex'));
  assert.equal(linhas.find((l) => l.evento === 'pediu' && l.id === r.json.id).quem, 'agente');
  assert.equal(fs.statSync(path.join(w.dados, 'demo', 'auditoria.jsonl')).mode & 0o777, 0o600);
}));

test('cartões e pastas ficam com permissão fechada, e o corpo só existe no cartão', () => comTeste({}, async (w) => {
  const id = await pedeEnvio(w);
  const pasta = path.join(w.dados, 'demo', 'cartoes');
  assert.equal(fs.statSync(pasta).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(w.dados, 'demo')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(pasta, `${id}.json`)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, `${id}.json`), 'utf8')).texto, TEXTO);
}));

test('envio que estava em andamento quando o painel caiu vira falhou, nunca enviado', async () => {
  const dir = pastaTemp('demo-reinicio');
  const dados = path.join(dir, 'dados');
  const cfg = escreveConfig(dir);
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.mkdirSync(path.join(dados, 'demo', 'cartoes'), { recursive: true });
  fs.writeFileSync(path.join(dados, 'demo', 'cartoes', `${id}.json`), JSON.stringify({
    id, tipo: 'envio', canal: 'whatsapp', linha: 'danilo', texto: 'oi', anexos: [], estado: 'enviando', criado_em: 1, expira_em: 2,
    destinatario: { nome: 'Maria', telefone: '5511999990001', ref_provedor: 'x', via: 'contato' },
  }));
  const cap = capturaLog();
  const demo = criarDemo({ config: { env: { DGCLAW_DEMO_CONFIG: cfg }, dataDir: dados }, registro: { obter: () => null }, log: cap.log });
  assert.equal(demo.ligado, true);
  const c = JSON.parse(fs.readFileSync(path.join(dados, 'demo', 'cartoes', `${id}.json`), 'utf8'));
  assert.equal(c.estado, 'falhou');
  assert.equal(c.codigo, 'ENVIO_INTERROMPIDO');
  assert.match(c.motivo, /não sei se a mensagem saiu/);
});

test('chaveDe só lê arquivos que estão no demo.json (para a página Sistemas conectados)', async () => {
  const dir = pastaTemp('demo-chave');
  const cfg = escreveConfig(dir);
  const demo = criarDemo({ config: { env: { DGCLAW_DEMO_CONFIG: cfg }, dataDir: path.join(dir, 'd') }, registro: { obter: () => null }, log: () => {} });
  assert.equal(demo.config.linhas_whatsapp.length, 2);
  assert.equal(demo.config.token_agente_sha256, undefined, 'o hash do token não é repassado');
  assert.equal(demo.chaveDe(demo.config.linhas_whatsapp[0].chave_arquivo), CHAVES['organizap.key']);
  assert.throws(() => demo.chaveDe('/etc/passwd'), /não é uma chave do demo.json/);
  assert.equal(carregarConfig(path.join(dir, 'nao-existe.json')).erro.includes('Não achei'), true);
});

// ── Reset ────────────────────────────────────────────────────────────────────
function fazScriptReset(dir, corpo) {
  const arq = path.join(dir, 'reset-falso.sh');
  fs.writeFileSync(arq, `#!/usr/bin/env bash\n${corpo}\n`, { mode: 0o755 });
  return arq;
}
async function esperaReset(w) {
  for (let i = 0; i < 100; i++) {
    const r = await w.c.get('/api/demo/reset/estado');
    if (r.json.fase !== 'em_andamento') return r.json;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('o reset não terminou');
}

test('Reset: pede a frase certa, só o dono com origem faz, chama o script com os argumentos e mostra o andamento', async () => {
  const dir = pastaTemp('demo-reset');
  const registro = path.join(dir, 'args.txt');
  const script = fazScriptReset(dir, `printf '%s\\n' "$@" > '${registro}'\necho '==> Parando o agente'\necho '==> Guardando'\nexit 0`);
  await comTeste({ opcoesServidor: { demoResetBin: script } }, async (w) => {
    assert.equal((await w.c.get('/api/demo/reset/estado')).json.fase, 'parado');
    const errada = await w.c.post('/api/demo/reset', { json: { confirmacao: 'novo cliente' } });
    assert.equal(errada.status, 400);
    assert.equal(errada.json.codigo, 'CONFIRMACAO_ERRADA');
    assert.equal(fs.existsSync(registro), false, 'frase errada não roda o script');
    const semOrigem = await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' }, origin: false });
    assert.equal(semOrigem.status, 403);
    const comToken = await fetch(`http://127.0.0.1:${w.porta}/api/demo/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${w.porta}` }, body: JSON.stringify({ confirmacao: 'NOVO CLIENTE' }) });
    assert.equal(comToken.status, 401, 'o agente com o token não faz o reset');
    assert.equal(fs.existsSync(registro), false);

    const ok = await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } });
    assert.equal(ok.status, 202);
    const fim = await esperaReset(w);
    assert.equal(fim.fase, 'ok');
    assert.deepEqual(fim.passos, ['Parando o agente', 'Guardando']);
    assert.deepEqual(fs.readFileSync(registro, 'utf8').trim().split('\n'), ['nova', '--dados', w.dados]);
    assert.match(lerAuditoria(w), /reset_concluido/);
  });
});

test('Reset que falha explica a causa e o que fazer, e o Portão fica fora do ar enquanto ele roda', async () => {
  const dir = pastaTemp('demo-reset-falha');
  const marca = path.join(dir, 'pode-terminar');
  const script = fazScriptReset(dir, `echo '==> Parando o agente'\nwhile [ ! -e '${marca}' ]; do sleep 0.02; done\necho 'ERRO: o runner não respondeu em 90s' >&2\nexit 1`);
  await comTeste({ opcoesServidor: { demoResetBin: script } }, async (w) => {
    assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
    const outro = await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } });
    assert.equal(outro.status, 409);
    assert.equal(outro.json.codigo, 'RESET_EM_ANDAMENTO');
    const portao = await w.portao('GET', '/api/demo/v1/envio/x');
    assert.equal(portao.status, 503);
    assert.equal(portao.json.codigo, 'RESET_EM_ANDAMENTO');
    assert.equal((await w.c.get('/api/demo/cartoes')).json.resetando, true);
    fs.writeFileSync(marca, '');
    const fim = await esperaReset(w);
    assert.equal(fim.fase, 'falhou');
    assert.match(fim.mensagem, /o runner não respondeu em 90s/);
    assert.match(fim.mensagem, /nada foi apagado/);
    assert.match(w.log.texto(), /o reset falhou/);
    assert.equal((await w.portao('GET', '/api/demo/v1/envio/x')).status, 404, 'depois do reset o Portão volta');
  });
});

test('Reset com script que não existe falha explicando, sem travar o painel', () => comTeste({ opcoesServidor: { demoResetBin: '/nao/existe/dgclaw-demo-reset' } }, async (w) => {
  assert.equal((await w.c.post('/api/demo/reset', { json: { confirmacao: 'NOVO CLIENTE' } })).status, 202);
  const fim = await esperaReset(w);
  assert.equal(fim.fase, 'falhou');
  assert.match(fim.mensagem, /Confira se .*dgclaw-demo-reset existe/);
}));
