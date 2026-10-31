'use strict';
// Janela e selo do aviso de segurança: funções puras (fora do DOM), escape do texto vindo do GitHub e ligação nas telas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../public/seguranca-aviso');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const AGORA = Date.parse('2026-10-31T12:00:00Z');
const bol = (extra) => Object.assign({
  id: 'GHSA-332P-7HRC-92WF', severidade: 'CRITICAL', componente: 'Pillow', acao: 'atualizar-dgclaw', titulo: 'Vulnerabilidade no Pillow',
  detalhe: 'linha 1\nlinha 2', o_que_muda: 'A imagem usa o Pillow 13.', publicado_em: '2026-10-30T20:00:00Z', boletim_em: '2026-10-31T10:00:00Z',
  fonte_url: 'https://github.com/advisories/GHSA-332p-7hrc-92wf', noticia_url: null,
}, extra || {});

test('abertura: "Nas últimas horas" com menos de 48 h, senão a data em dd/mm/aaaa', () => {
  assert.equal(S.abertura('2026-10-30T20:00:00Z', AGORA), 'Nas últimas horas');
  assert.equal(S.abertura('2026-10-29T13:00:00Z', AGORA), 'Nas últimas horas');
  assert.equal(S.abertura('2026-10-29T11:00:00Z', AGORA), 'Em 29/10/2026');
  assert.equal(S.abertura('2026-10-21T21:28:09Z', AGORA), 'Em 21/10/2026');
  assert.equal(S.abertura('2026-11-05T00:00:00Z', AGORA), 'Nas últimas horas');
});

test('texto principal para atualizar-dgclaw, com a abertura certa', () => {
  assert.equal(S.textoPrincipal(bol(), AGORA),
    'Nas últimas horas foi identificada uma vulnerabilidade em uma das ferramentas que o sistema usa: Pillow. A correção já foi publicada pela equipe oficial dela. Para aplicar, basta clicar em Atualizar abaixo, e o seu sistema vai para a versão com essa correção. É muito importante que você atualize.');
  assert.match(S.textoPrincipal(bol({ publicado_em: '2026-10-21T21:28:09Z' }), AGORA), /^Em 21\/10\/2026 foi identificada/);
});

test('texto principal para atualizar-sistema troca as duas frases finais', () => {
  const t = S.textoPrincipal(bol({ acao: 'atualizar-sistema' }), AGORA);
  assert.match(t, /Para aplicar, clique em Atualizar abaixo e o Admin atualiza os pacotes do servidor com você\.$/);
  assert.doesNotMatch(t, /É muito importante/);
  assert.doesNotMatch(t, /basta clicar/);
});

test('parar-servico e aguardar: dizem que a correção ainda não saiu', () => {
  for (const acao of ['parar-servico', 'aguardar']) {
    assert.match(S.textoPrincipal(bol({ acao }), AGORA), /A correção ainda não saiu\./);
    assert.doesNotMatch(S.textoPrincipal(bol({ acao }), AGORA), /clicar em Atualizar/);
  }
});

test('nenhum texto da janela tem travessão', () => {
  for (const acao of ['atualizar-dgclaw', 'atualizar-sistema', 'parar-servico', 'aguardar']) {
    assert.doesNotMatch(S.modalHtml(bol({ acao }), AGORA), /[—–]/);
  }
  assert.doesNotMatch(JSON.stringify(S.passosDoModal(null)) + JSON.stringify(S.PASSO_SELO), /[—–]/);
});

test('gravidade em português', () => {
  assert.equal(S.gravidadeRotulo('CRITICAL'), 'Crítica');
  assert.equal(S.gravidadeRotulo('HIGH'), 'Alta');
  assert.equal(S.gravidadeRotulo('MEDIUM'), 'Média');
  assert.equal(S.gravidadeRotulo('LOW'), 'Baixa');
  assert.equal(S.gravidadeRotulo('desconhecida'), 'Não informada');
  assert.equal(S.gravidadeRotulo('QUALQUER'), 'Não informada');
});

test('a janela de atualizar-dgclaw tem título, fatos, link seguro, detalhes recolhidos e os dois botões', () => {
  const h = S.modalHtml(bol({ noticia_url: 'https://blog.exemplo.org/post' }), AGORA);
  assert.match(h, /<h2 id="sbTitulo">Aviso de segurança<\/h2>/);
  assert.match(h, /<dt>Publicada em<\/dt><dd>30\/10\/2026<\/dd>/);
  assert.match(h, /<dt>Gravidade<\/dt><dd>Crítica<\/dd>/);
  assert.match(h, /<dt>Fonte oficial<\/dt><dd><a href="https:\/\/github\.com\/advisories\/GHSA-332p-7hrc-92wf" target="_blank" rel="noopener noreferrer">/);
  assert.match(h, /<dt>Notícia<\/dt><dd><a href="https:\/\/blog\.exemplo\.org\/post" target="_blank" rel="noopener noreferrer">/);
  assert.match(h, /<dt>O que muda<\/dt><dd>A imagem usa o Pillow 13\.<\/dd>/);
  assert.match(h, /<details class="sb-detalhe"><summary>Ver detalhes<\/summary>/);
  assert.match(h, /data-sb="atualizar"[^>]*>Atualizar</);
  assert.match(h, /data-sb="lembrar"[^>]*>Lembrar depois</);
  assert.match(h, /data-sb="ajuda"/);
});

test('sem notícia, sem a linha Notícia; sem o_que_muda, sem a linha O que muda', () => {
  const h = S.modalHtml(bol({ o_que_muda: '' }), AGORA);
  assert.doesNotMatch(h, /Notícia/);
  assert.doesNotMatch(h, /O que muda/);
});

test('em aguardar e parar-servico não há botão Atualizar, só Entendi, e o detalhe fica à vista', () => {
  for (const acao of ['aguardar', 'parar-servico']) {
    const h = S.modalHtml(bol({ acao }), AGORA);
    assert.doesNotMatch(h, /Atualizar<\/button>/);
    assert.doesNotMatch(h, /data-sb="atualizar"/);
    assert.match(h, /data-sb="entendi"[^>]*>Entendi</);
    assert.match(h, /sb-detalhe-aberto/);
    assert.doesNotMatch(h, /<details/);
  }
});

test('texto do pedido ao Admin, por ação', () => {
  assert.equal(S.textoDoPedido(bol()), 'Quero instalar a atualização de segurança do DG Claw (boletim GHSA-332P-7HRC-92WF).');
  assert.equal(S.textoDoPedido(bol({ acao: 'atualizar-sistema' })), 'Quero aplicar a atualização de segurança do servidor (boletim GHSA-332P-7HRC-92WF).');
});

test('texto vindo do GitHub sai escapado: <img onerror> nunca vira tag', () => {
  const ruim = '<img src=x onerror=alert(1)>';
  const h = S.modalHtml(bol({
    componente: ruim, detalhe: '"><script>alert(2)</script>', o_que_muda: '</dd><svg onload=alert(3)>', id: ruim,
  }), AGORA);
  assert.doesNotMatch(h, /<img/i);
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<svg/i);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('link que não é https:// nunca vira <a>, mesmo que a API deixasse passar', () => {
  const h = S.modalHtml(bol({ fonte_url: 'javascript:alert(1)', noticia_url: 'https://x.org/"onmouseover="alert(1)' }), AGORA);
  assert.doesNotMatch(h, /<a /);
  assert.equal(S.ehHttps('https://x.org/a'), true);
  assert.equal(S.ehHttps('http://x.org/a'), false);
  assert.equal(S.ehHttps('https://x.org/a b'), false);
});

test('selo: singular e plural', () => {
  assert.equal(S.seloHtml(1), 'Aviso de segurança pendente');
  assert.equal(S.seloHtml(2), 'Avisos de segurança pendentes (2)');
});

test('tutorial da janela: cada passo diz o que é, como funciona e por que está aqui', () => {
  const passos = S.passosDoModal(null);
  const alvos = passos.map((p) => p.alvo);
  for (const a of ['#sbTexto', '#sbData', '#sbFonte', '#sbMuda', '#sbAtualizar', '#sbLembrar']) assert.ok(alvos.includes(a), a);
  for (const p of passos.concat([S.PASSO_SELO])) {
    assert.ok(p.alvo.startsWith('#'));
    for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[k] && p[k].length > (k === 'titulo' ? 3 : 20), `${p.alvo} ${k}`);
  }
});

test('ligação nas telas: conversa.html, casca.js, service worker e o tour da conversa', () => {
  assert.match(pub('conversa.html'), /<script src="\/seguranca-aviso\.js"><\/script>/);
  assert.match(pub('casca.js'), /\/seguranca-aviso\.js/);
  assert.match(pub('sw.js'), /\/seguranca-aviso\.js/);
  assert.match(pub('sw.js'), /\/seguranca-aviso\.css/);
  assert.match(pub('conversa.js'), /DGSegurancaAviso\.passoSelo\(\)/);
  assert.ok(fs.existsSync(path.join(__dirname, '../public/seguranca-aviso.css')));
});

test('a janela nunca usa innerHTML com dado cru e o botão Atualizar reaproveita a função da faixa', () => {
  const js = pub('seguranca-aviso.js');
  assert.match(js, /faixa\.instalar\(textoDoPedido\(b\)\)/);
  assert.match(js, /fundo\.innerHTML = modalHtml\(/);
  assert.match(pub('atualizacao-faixa.js'), /function instalar\(textoPedido\)/);
});
