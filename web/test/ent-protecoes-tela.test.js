'use strict';
// Tela Proteções: funções puras da página, arquivos ligados e as duas rotas (API e página).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/protecoes');
const { criarProtecoes } = require('../lib/protecoes');
const { subirWeb, pastaTemp } = require('./ajuda');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

function resumoDe(nivel, ajustes) {
  const dir = pastaTemp('tela');
  const caminho = path.join(dir, 'protecoes.json');
  if (nivel) fs.writeFileSync(caminho, JSON.stringify({ nivel, ajustes: ajustes || {}, org_uuid: '' }));
  return criarProtecoes({ caminho, log: () => {} }).resumo();
}

test('valor em palavras: sim/não, número com unidade, sem prazo e a palavra do enum', () => {
  assert.equal(P.rotuloValor({ chave: 'backup', valor: true }), 'sim');
  assert.equal(P.rotuloValor({ chave: 'backup', valor: false }), 'não');
  assert.equal(P.rotuloValor({ chave: 'sessao_horas', valor: 72 }), '72 horas');
  assert.equal(P.rotuloValor({ chave: 'retencao_dias', valor: 0 }), 'sem prazo');
  assert.equal(P.rotuloValor({ chave: 'retencao_dias', valor: 30 }), '30 dias');
  assert.equal(P.rotuloValor({ chave: '2fa', valor: 'todos' }), 'todos');
});

test('ficha da proteção: ligada, travada, ajustada e os três textos, tudo escapado', () => {
  const h = P.htmlChave({ chave: '2fa', valor: 'todos', padrao: 'ti', ligada: true, protegendo: true, travado: true, ajustado: true,
    descricao: 'Segundo <fator>', como: 'Pede "código"', porque: 'Senha vaza & vale' });
  assert.match(h, /pr-ligada/);
  assert.match(h, />ligada</);
  assert.match(h, />travado</);
  assert.match(h, /ajustado \(padrão: ti\)/);
  assert.match(h, /O que é<\/dt><dd>Segundo &lt;fator&gt;/);
  assert.match(h, /Como o sistema aplica<\/dt><dd>Pede &quot;código&quot;/);
  assert.match(h, /Por que está aqui<\/dt><dd>Senha vaza &amp; vale/);
  assert.doesNotMatch(h, /<fator>/);
  const off = P.htmlChave({ chave: 'backup', valor: false, padrao: false, ligada: false, protegendo: false, travado: false, ajustado: false, descricao: 'x', como: 'y', porque: 'z' });
  assert.match(off, />desligada</);
  assert.doesNotMatch(off, /travado|ajustado|pr-ligada/);
  const par = P.htmlChave({ chave: 'sessao_horas', valor: 24, padrao: 168, ligada: true, protegendo: null, travado: false, ajustado: true, descricao: 'x', como: 'y', porque: 'z' });
  assert.match(par, />parâmetro</);
  assert.doesNotMatch(par, />ligada<|>desligada</);
});

test('nível pessoal: diz que nada está ligado e recolhe a lista', () => {
  const h = P.htmlResumo(resumoDe(null));
  assert.match(h, /Nenhuma proteção enterprise está ligada neste nível/);
  assert.match(h, /<details class="pr-mais">/);
  assert.match(h, /Ver as 22 proteções/);
  assert.doesNotMatch(h, /proteções ligadas</);
  assert.equal((h.match(/class="pr-item/g) || []).length, 22);
  assert.doesNotMatch(h, /pr-item pr-ligada/, 'no pessoal nenhuma ficha está protegendo');
});

test('nível empresa: conta as ligadas e mostra a lista aberta, com a trava de cada uma', () => {
  const r = resumoDe('empresa');
  const h = P.htmlResumo(r);
  assert.doesNotMatch(h, /<details/);
  const ligadas = r.chaves.filter((c) => c.protegendo).length;
  assert.match(h, new RegExp(`${ligadas} de 20 proteções ligadas`));
  assert.match(h, /pr-nivel-nome">empresa</);
  assert.match(h, /data-chave="2fa"/);
  assert.match(h, /travado/);
});

test('organização do Claude aparece quando existe', () => {
  const h = P.htmlResumo({ nivel: 'empresa', org_uuid: '123e4567-e89b-12d3-a456-426614174000', chaves: [] });
  assert.match(h, /Organização do Claude: 123e4567/);
});

test('protecoes.html: casca, tour, viewport e Tutorial; tutorial com o que é / como / por quê em cada passo', () => {
  const h = pub('protecoes.html');
  for (const src of ['/tour.js', '/menu-lado.js', '/casca.js', '/protecoes.js']) assert.ok(h.includes(`<script src="${src}">`), src);
  assert.ok(h.includes('href="/protecoes.css"'));
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'protecoes'/);
  assert.match(h, /name="viewport"[^>]*width=device-width/);
  assert.ok(h.indexOf('href="/casca.css"') < h.indexOf('href="/menu-lado.css"'));
  for (const passos of Object.values(P.PASSOS)) {
    for (const p of passos) for (const campo of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[campo] && p[campo].length > (campo === 'titulo' ? 3 : 15), `${p.titulo}/${campo}`);
  }
});

test('o css não deixa a tela rolar de lado e vira grade só em tela larga', () => {
  const c = pub('protecoes.css');
  assert.match(c, /overflow-wrap:anywhere/);
  assert.match(c, /grid-template-columns:1fr;/);
  assert.match(c, /@media \(min-width:720px\)/);
});

test('rotas: API e página exigem sessão; com sessão mostram o nível e as 22 chaves', async () => {
  const dirNivel = pastaTemp('nivel');
  const protecoesPath = path.join(dirNivel, 'protecoes.json');
  fs.writeFileSync(protecoesPath, JSON.stringify({ nivel: 'escritorio', ajustes: { sessao_horas: 24 } }));
  const s = await subirWeb({ opcoesServidor: { protecoesPath } });
  try {
    fs.copyFileSync(path.join(__dirname, '../public/protecoes.html'), path.join(s.publico, 'protecoes.html'));
    const semApi = await s.c.get('/api/v1/protecoes');
    assert.equal(semApi.status, 401);
    const semPag = await s.c.get('/protecoes', { headers: { Accept: 'text/html' } });
    assert.equal(semPag.status, 302);
    assert.match(semPag.headers.location, /^\/login\?next=%2Fprotecoes/);

    await s.login();
    const api = await s.c.get('/api/v1/protecoes');
    assert.equal(api.status, 200);
    assert.equal(api.json.ok, true);
    assert.equal(api.json.nivel, 'escritorio');
    assert.equal(api.json.chaves.length, 22);
    const sessao = api.json.chaves.find((c) => c.chave === 'sessao_horas');
    assert.equal(sessao.valor, 24);
    assert.equal(sessao.padrao, 168);
    assert.equal(sessao.ajustado, true);
    assert.equal(api.headers['cache-control'], 'no-store');
    assert.doesNotMatch(api.texto, /protecoes\.json|\/etc\/dgclaw/, 'a resposta não vaza caminho do servidor');

    const post = await s.c.post('/api/v1/protecoes', { json: {} });
    assert.equal(post.status, 405);
    assert.match(post.json.erro, /dgclaw nivel definir/);

    const pag = await s.c.get('/protecoes', { headers: { Accept: 'text/html' } });
    assert.equal(pag.status, 200);
    assert.match(pag.headers['content-type'], /text\/html/);
    assert.match(pag.texto, /Proteções - DG Claw/);
    const barra = await s.c.get('/protecoes/', { headers: { Accept: 'text/html' } });
    assert.equal(barra.status, 200);
  } finally { await s.fechar(); }
});

test('sem o arquivo de nível a API responde pessoal, sem erro', async () => {
  const s = await subirWeb({ opcoesServidor: { protecoesPath: path.join(pastaTemp('vazio'), 'nao-existe.json') } });
  try {
    await s.login();
    const api = await s.c.get('/api/v1/protecoes');
    assert.equal(api.status, 200);
    assert.equal(api.json.nivel, 'pessoal');
    assert.deepEqual(api.json.chaves.filter((c) => c.protegendo).map((c) => c.chave), [], 'no pessoal nenhuma proteção está protegendo');
  } finally { await s.fechar(); }
});
