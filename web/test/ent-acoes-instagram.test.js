'use strict';
// Bloco E, ações do Instagram com aprovação: o agente pede pela caixa, o TI aprova, o Web publica com a Graph API falsa.
// O token vai no corpo do POST (nunca na URL), não aparece em nenhuma resposta, no log, na auditoria nem no pedido gravado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cliente } = require('./ajuda');
const { cenarioEnt } = require('./ent-usuarios-ajuda');
const acoes = require('../lib/ent/acoes-instagram');

const CONTA = '17841400000000000';
const COMENTARIO = '17858893269000001';
// Valor de mentira gerado na hora: nenhum segredo escrito no teste.
const VALOR = `valor-ig-${require('node:crypto').randomBytes(10).toString('hex')}`;
const LEGENDA = 'Lançamento da semana! Detalhes no link da bio.\nSegunda linha, com acento: coração.';
const IMAGEM = 'https://cdn.exemplo.com.br/posts/foto.jpg';

/** Graph API falsa: guarda cada chamada (url, método, cabeçalhos, corpo) e responde conforme o roteiro. */
function graphFalsa(roteiro) {
  const chamadas = [];
  const fetch = async (url, init) => {
    const i = init || {};
    chamadas.push({ url: String(url), metodo: i.method || 'GET', headers: i.headers || {}, corpo: i.body ? String(i.body) : '' });
    const r = roteiro ? roteiro(String(url), i) : null;
    const { status = 200, json = {} } = r || {};
    if (!r) {
      if (/\/media$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ id: 'container-1' }) };
      if (/\/media_publish$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ id: 'midia-9' }) };
      if (/\/replies$/.test(String(url))) return { ok: true, status: 200, json: async () => ({ id: 'resp-5' }) };
      return { ok: true, status: 200, json: async () => ({ permalink: 'https://www.instagram.com/p/ABC/' }) };
    }
    return { ok: status < 400, status, json: async () => json };
  };
  return { fetch, chamadas };
}

async function com(nivel, fn, extra) {
  const g = graphFalsa(extra && extra.roteiro);
  const dirAcoes = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'acoes-'));
  const instagram = Object.assign({ fetch: g.fetch, dormir: async () => {}, dir: dirAcoes, buscarMidia: async () => ({ tipo: 'image/png', buf: Buffer.from('PNGFALSO') }) }, extra && extra.instagram);
  const c = await cenarioEnt({ nivel, opcoesServidor: { instagram } });
  fs.copyFileSync(path.join(__dirname, '../public/aprovacoes.html'), path.join(c.s.publico, 'aprovacoes.html'));
  const cofre = (slug, conteudo) => {
    fs.mkdirSync(path.join(dirAcoes, slug), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dirAcoes, slug, 'instagram.env'), conteudo == null ? `IG_TOKEN=${VALOR}\nIG_CONTA=${CONTA}\n` : conteudo, { mode: 0o600 });
  };
  const comoAgente = (slug) => {
    const cli = cliente(c.s.porta);
    const h = { 'X-DGClaw-Caixa': c.s.web.caixa.segredo, 'X-DGClaw-Agente': slug };
    return { post: (rota, json) => cli.pedir('POST', rota, { json, headers: h, origin: false }), get: (rota) => cli.pedir('GET', rota, { headers: h, origin: false }) };
  };
  try { await fn({ c, g, dirAcoes, cofre, comoAgente, ti: async () => (await c.entrar('dono', c.senhaTi)).cli }); } finally { await c.fechar(); fs.rmSync(dirAcoes, { recursive: true, force: true }); }
}

const PUBLICAR = { op: 'publicar', conta: CONTA, legenda: LEGENDA, imagem_url: IMAGEM };

function nadaDoValor(c, g, ...textos) {
  const lugares = [c.s.log.texto(), JSON.stringify(g.chamadas.map((x) => x.url)), ...textos];
  for (const d of [path.join(c.dataDir, 'aprovacoes'), path.dirname(c.auditoriaPath)]) {
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isFile()) lugares.push(fs.readFileSync(p, 'utf8')); }
  }
  lugares.forEach((t, i) => assert.ok(!String(t).includes(VALOR), `o token apareceu no lugar ${i}`));
}

test('publicar: o agente pede, o TI vê a frase com a legenda inteira e a prévia, aprova, e o post sai com o token no corpo', async () => {
  await com('escritorio', async ({ c, g, cofre, comoAgente, ti }) => {
    cofre('ana');
    const agente = comoAgente('ana');
    const r = await agente.post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(r.status, 202, r.texto);
    assert.equal(r.json.pendente, true);
    assert.equal(g.chamadas.length, 0, 'pedir não chama a Graph API');
    assert.ok(r.json.descricao.includes(LEGENDA), 'a frase leva a legenda inteira');
    assert.ok(r.json.descricao.includes(CONTA) && r.json.descricao.includes(IMAGEM) && r.json.descricao.includes('`ana`'));
    // pedido igual enquanto pendente: devolve o mesmo
    const igual = await agente.post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(igual.json.aprovacao, r.json.aprovacao);
    assert.equal(igual.json.ja_existia, true);

    const cli = await ti();
    const lista = (await cli.get('/api/v1/aprovacoes')).json;
    assert.equal(lista.pendentes, 1);
    const ap = lista.aprovacoes[0];
    assert.equal(ap.tipo, 'instagram');
    assert.equal(ap.params.imagem_url, IMAGEM);
    const previa = await cli.get(`/api/v1/acoes/instagram/${ap.id}/previa`);
    assert.equal(previa.status, 200);
    assert.equal(previa.headers['content-type'], 'image/png');
    assert.equal(previa.headers['x-content-type-options'], 'nosniff');
    assert.equal(previa.texto, 'PNGFALSO');

    const ok = await cli.post(`/api/v1/aprovacoes/${ap.id}/aprovar`, { json: {} });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.executada, true);
    assert.match(ok.json.aprovacao.resultado.saida, /instagram\.com\/p\/ABC/);

    assert.equal(g.chamadas.length, 3);
    const [cria, publica, link] = g.chamadas;
    assert.equal(cria.url, `https://graph.facebook.com/v21.0/${CONTA}/media`);
    assert.equal(cria.metodo, 'POST');
    assert.match(cria.headers['Content-Type'], /x-www-form-urlencoded/);
    const corpoCria = new URLSearchParams(cria.corpo);
    assert.equal(corpoCria.get('access_token'), VALOR, 'o token vai no CORPO do POST');
    assert.equal(corpoCria.get('image_url'), IMAGEM);
    assert.equal(corpoCria.get('caption'), LEGENDA);
    assert.equal(publica.url, `https://graph.facebook.com/v21.0/${CONTA}/media_publish`);
    assert.equal(new URLSearchParams(publica.corpo).get('creation_id'), 'container-1');
    assert.equal(new URLSearchParams(publica.corpo).get('access_token'), VALOR);
    assert.ok(link.url.startsWith('https://graph.facebook.com/v21.0/midia-9?fields=permalink'));
    assert.equal(link.headers.Authorization, `Bearer ${VALOR}`, 'no GET o token vai no cabeçalho');
    for (const x of g.chamadas) assert.ok(!x.url.includes(VALOR) && !/access_token/.test(x.url), `token na URL: ${x.url}`);

    // o agente consulta pela caixa e vê "executada", sem o token em lugar nenhum
    const estado = await agente.get(`/api/v1/aprovacoes/${ap.id}`);
    assert.equal(estado.json.aprovacao.estado, 'executada');
    nadaDoValor(c, g, r.texto, ok.texto, estado.texto, lista.aprovacoes.map((a) => JSON.stringify(a)).join(''));
    const eventos = c.eventos().map((e) => e.evento);
    for (const e of ['aprovacao_criada', 'aprovacao_aprovada', 'aprovacao_executada']) assert.ok(eventos.includes(e), `falta ${e} na auditoria`);
  });
});

test('responder comentário: o texto entra na frase e a resposta sai pela Graph API com o token no corpo', async () => {
  await com('escritorio', async ({ c, g, cofre, comoAgente, ti }) => {
    cofre('ana');
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', { op: 'responder', comentario_id: COMENTARIO, mensagem: 'Obrigado pelo carinho!' });
    assert.equal(r.status, 202, r.texto);
    assert.ok(r.json.descricao.includes(COMENTARIO) && r.json.descricao.includes('Obrigado pelo carinho!'));
    const cli = await ti();
    const ok = await cli.post(`/api/v1/aprovacoes/${r.json.aprovacao}/aprovar`, { json: {} });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(g.chamadas.length, 1);
    assert.equal(g.chamadas[0].url, `https://graph.facebook.com/v21.0/${COMENTARIO}/replies`);
    const corpo = new URLSearchParams(g.chamadas[0].corpo);
    assert.equal(corpo.get('message'), 'Obrigado pelo carinho!');
    assert.equal(corpo.get('access_token'), VALOR);
    nadaDoValor(c, g, ok.texto);
  });
});

test('a legenda de 2200 caracteres aparece inteira na frase (a fila genérica corta em 500 por padrão)', async () => {
  await com('escritorio', async ({ cofre, comoAgente }) => {
    cofre('ana');
    const longa = `${'a'.repeat(2150)} FIM`;
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', { ...PUBLICAR, legenda: longa });
    assert.equal(r.status, 202, r.texto);
    assert.ok(r.json.descricao.includes('aaaa FIM'), 'a frase não foi cortada no meio da legenda');
  });
});

test('o pedido é validado: URL insegura, campo estranho, legenda grande, conta de outra pessoa e op desconhecida são recusados', async () => {
  await com('escritorio', async ({ g, cofre, comoAgente }) => {
    cofre('ana');
    const a = comoAgente('ana');
    const ruins = [
      [{ ...PUBLICAR, imagem_url: 'http://cdn.exemplo.com.br/a.jpg' }, /https/],
      [{ ...PUBLICAR, imagem_url: 'https://usuario:senha@cdn.exemplo.com.br/a.jpg' }, /usuário e senha/],
      [{ ...PUBLICAR, imagem_url: 'https://127.0.0.1/a.jpg' }, /nome de site/],
      [{ ...PUBLICAR, imagem_url: 'https://cdn.exemplo.com.br:8443/a.jpg' }, /porta/],
      [{ ...PUBLICAR, imagem_url: 'nao e url' }, /endereço https/],
      [{ ...PUBLICAR, legenda: '   ' }, /não pode ficar vazia/],
      [{ ...PUBLICAR, legenda: 'x'.repeat(2201) }, /2200/],
      [{ ...PUBLICAR, conta: '123' }, /igAccountId/],
      [{ ...PUBLICAR, conta: '99999999999' }, /conta do Instagram que o TI configurou/],
      [{ ...PUBLICAR, token: 'x' }, /não existe nesta ação/],
      [{ op: 'apagar' }, /"publicar" ou "responder"/],
      [{ op: 'responder', comentario_id: 'abc', mensagem: 'x' }, /id do comentário/],
      [{ op: 'responder', comentario_id: COMENTARIO, mensagem: '' }, /não pode ficar vazia/],
      [[], /objeto JSON/],
    ];
    for (const [corpo, motivo] of ruins) {
      const r = await a.post('/api/v1/acoes/instagram', corpo);
      assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(corpo).slice(0, 80)} deveria ser recusado, veio ${r.status}`);
      assert.match(r.json.erro, motivo);
    }
    assert.equal(g.chamadas.length, 0);
  });
});

test('crase e caractere de controle da legenda não entram na frase da aprovação', () => {
  const p = acoes.validar({ op: 'publicar', conta: CONTA, legenda: 'oi `rm -rf` \u0007 fim', imagem_url: IMAGEM }, 'ana');
  assert.equal(p.legenda, "oi 'rm -rf'   fim");
  assert.ok(!acoes.descrever(p, 'post.publicar').includes('`rm'));
});

test('sem token no cofre do host o pedido é recusado (409) com o comando para configurar; token some depois de aprovado: o pedido volta a pendente', async () => {
  await com('escritorio', async ({ g, cofre, dirAcoes, comoAgente, ti }) => {
    const a = comoAgente('ana');
    const sem = await a.post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(sem.status, 409);
    assert.match(sem.json.erro, /dgclaw acoes instagram configurar ana/);
    cofre('ana');
    const r = await a.post('/api/v1/acoes/instagram', PUBLICAR);
    fs.rmSync(path.join(dirAcoes, 'ana'), { recursive: true });
    const cli = await ti();
    const ok = await cli.post(`/api/v1/aprovacoes/${r.json.aprovacao}/aprovar`, { json: {} });
    assert.equal(ok.status, 503, ok.texto);
    assert.match(ok.json.erro, /não está no cofre do host/);
    assert.equal(ok.json.aprovacao.estado, 'pendente', 'nada foi tentado, o TI pode aprovar de novo');
    assert.equal(g.chamadas.length, 0);
  });
});

test('erro da Graph API vira "falhou" com a mensagem dela, sem o token', async () => {
  await com('escritorio', async ({ c, g, cofre, comoAgente, ti }) => {
    cofre('ana');
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', PUBLICAR);
    const cli = await ti();
    const ok = await cli.post(`/api/v1/aprovacoes/${r.json.aprovacao}/aprovar`, { json: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.aprovacao.estado, 'falhou');
    assert.match(ok.json.aprovacao.resultado.erro, /Graph API erro 190.*token expirou/);
    assert.equal(g.chamadas.length, 1, 'parou no primeiro passo, não tentou publicar');
    nadaDoValor(c, g, ok.texto);
  }, { roteiro: () => ({ status: 400, json: { error: { code: 190, message: 'O token expirou' } } }) });
});

test('token cifrado (instagram.env.cred) é lido pelo systemd-creds, com o nome da credencial do agente', async () => {
  await com('escritorio', async ({ g, dirAcoes, comoAgente, ti }) => {
    fs.mkdirSync(path.join(dirAcoes, 'ana'), { recursive: true });
    fs.writeFileSync(path.join(dirAcoes, 'ana', 'instagram.env.cred'), `IG_TOKEN=${VALOR}\nIG_CONTA=${CONTA}\n`);
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(r.status, 202, r.texto);
    const cli = await ti();
    const ok = await cli.post(`/api/v1/aprovacoes/${r.json.aprovacao}/aprovar`, { json: {} });
    assert.equal(ok.json.executada, true, ok.texto);
    assert.equal(new URLSearchParams(g.chamadas[0].corpo).get('access_token'), VALOR);
    const anotado = fs.readFileSync(path.join(dirAcoes, 'creds-args.txt'), 'utf8');
    assert.match(anotado, /decrypt --name=dgclaw-acoes-instagram-ana /);
  }, { instagram: (() => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creds-'));
    const bin = path.join(dir, 'systemd-creds');
    // decrypt <--name> <arquivo> - : o falso devolve o conteúdo do arquivo e anota os argumentos (nunca o conteúdo).
    fs.writeFileSync(bin, '#!/bin/sh\necho "$@" >> "$(dirname "$3")/../creds-args.txt"\ncat "$3"\n', { mode: 0o755 });
    return { comandoCreds: bin };
  })() });
});

test('quem pede é só o agente pela caixa; o TI em navegador e outro agente não conseguem; só o TI vê a prévia', async () => {
  await com('escritorio', async ({ c, cofre, comoAgente, ti }) => {
    cofre('ana'); cofre('marina');
    const cli = await ti();
    const doTi = await cli.post('/api/v1/acoes/instagram', { json: PUBLICAR });
    assert.equal(doTi.status, 403);
    assert.match(doTi.json.erro, /agente, pela caixa/);
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', PUBLICAR);
    const outra = await comoAgente('marina').get(`/api/v1/aprovacoes/${r.json.aprovacao}`);
    assert.equal(outra.status, 404, 'outro agente não vê o pedido da ana');
    const previaDoAgente = await comoAgente('ana').get(`/api/v1/acoes/instagram/${r.json.aprovacao}/previa`);
    assert.equal(previaDoAgente.status, 403);
    const anon = await cliente(c.s.porta).get(`/api/v1/acoes/instagram/${r.json.aprovacao}/previa`);
    assert.equal(anon.status, 401);
    const admin = await comoAgente('admin').post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(admin.status, 403, 'o Admin não é agente de trabalho');
  });
});

test('prévia de mídia sem imagem ou de outro tipo de pedido: 404; erro ao buscar: mensagem em português', async () => {
  await com('escritorio', async ({ cofre, comoAgente, ti }) => {
    cofre('ana');
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', { op: 'responder', comentario_id: COMENTARIO, mensagem: 'oi' });
    const cli = await ti();
    assert.equal((await cli.get(`/api/v1/acoes/instagram/${r.json.aprovacao}/previa`)).status, 404);
    assert.equal((await cli.get(`/api/v1/acoes/instagram/${'0'.repeat(24)}/previa`)).status, 404);
  });
  await com('escritorio', async ({ cofre, comoAgente, ti }) => {
    cofre('ana');
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', PUBLICAR);
    const cli = await ti();
    const p = await cli.get(`/api/v1/acoes/instagram/${r.json.aprovacao}/previa`);
    assert.equal(p.status, 415);
    assert.match(p.json.erro, /não devolve uma imagem/);
  }, { instagram: { buscarMidia: async () => { throw new acoes.ErroAcao('A URL não devolve uma imagem (veio "text/html"), então não há prévia.', 415); } } });
});

test('nível pessoal: a rota não responde (as travas estão desligadas) e nenhuma aprovação nasce', async () => {
  await com('pessoal', async ({ cofre, comoAgente, g }) => {
    cofre('ana');
    const r = await comoAgente('ana').post('/api/v1/acoes/instagram', PUBLICAR);
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /travas de ação externa estão desligadas/);
    assert.equal(g.chamadas.length, 0);
  });
});

test('defesa contra SSRF na prévia: endereços internos e reservados são recusados, públicos passam', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(acoes.enderecoPrivado(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.69', '2606:4700::1111']) assert.equal(acoes.enderecoPrivado(ip), false, ip);
  await assert.rejects(acoes.buscarMidia('https://cdn.exemplo.com.br/a.jpg', { resolver: async () => [{ address: '10.1.2.3', family: 4 }] }), /endereço interno ou reservado/);
  await assert.rejects(acoes.buscarMidia('https://cdn.exemplo.com.br/a.jpg', { resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /endereço interno ou reservado/);
  await assert.rejects(acoes.buscarMidia('https://nao-existe.exemplo.com.br/a.jpg', { resolver: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }), /ENOTFOUND/);
});
