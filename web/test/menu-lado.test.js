'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/menu-lado');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('conversa.html carrega o menu novo e não tem mais o link avulso do painel', () => {
  const h = pub('conversa.html');
  assert.match(h, /<link rel="stylesheet" href="\/menu-lado\.css">/);
  assert.match(h, /<script src="\/menu-lado\.js"><\/script>/);
  assert.ok(h.indexOf('/menu-lado.js') < h.indexOf('/conversa.js'), 'menu-lado.js precisa vir antes do conversa.js');
  assert.doesNotMatch(h, /gmSecPainel/);
});

test('sw.js guarda os arquivos novos e está na v14', () => {
  const s = pub('sw.js');
  assert.match(s, /dgclaw-estaticos-v(1[5-9]|[2-9][0-9])\b/);
  assert.match(s, /'\/menu-lado\.js'/);
  assert.match(s, /'\/menu-lado\.css'/);
});

test('seletor: cada item usa a foto do próprio agente, não a do agente atual', () => {
  const ana = { id: 'ana', nome: 'Ana', cor: '#aa0000', avatar_img: '/fotos/ana.png' };
  const bento = { id: 'bento', nome: 'Bento', cor: '#0000bb', avatar_img: '/fotos/bento.png' };
  const caio = { id: 'caio', nome: 'Caio', cor: '#00cc00', avatar: 'C' };
  const hAna = M.itemAgente(ana, 'bento'), hBento = M.itemAgente(bento, 'bento'), hCaio = M.itemAgente(caio, 'bento');
  assert.match(hAna, /src="\/fotos\/ana\.png"/);
  assert.doesNotMatch(hAna, /bento\.png/);
  assert.match(hBento, /src="\/fotos\/bento\.png"/);
  assert.match(hBento, /aqui/);
  assert.doesNotMatch(hAna, /aqui/);
  assert.match(hCaio, /background:#00cc00/);
  assert.match(hCaio, />C</);
  assert.doesNotMatch(hCaio, /<img/);
  assert.match(hCaio, /href="\/a\/caio"/);
});

test('seletor: nome com HTML não vira marcação', () => {
  const h = M.itemAgente({ id: 'x', nome: '<b>"x"</b>' }, 'y');
  assert.doesNotMatch(h, /<b>"x"/);
});

test('páginas do painel: 13 links com #aba=, e nenhum sem painel', () => {
  const l = M.linksPainel({ id: 'ana', tem_painel: true, painel_url: '/p/ana/' });
  assert.deepEqual(l.map(x => x.href.split('#aba=')[1]),
    ['status', 'skills', 'rotinas', 'cofre', 'arquivos', 'memory', 'operations', 'costs', 'como', 'identity', 'personality', 'apps', 'socorro']);
  assert.ok(l.every(x => x.href.startsWith('/p/ana/#aba=')));
  assert.deepEqual(M.linksPainel({ id: 'admin', tem_painel: false }), []);
});

test('Tela: item do menu leva ao painel já na aba Tela, e o Admin não tem', () => {
  const l = M.linkTela({ id: 'ana', tem_painel: true, painel_url: '/p/ana/' });
  assert.equal(l.href, '/p/ana/#aba=tela');
  assert.equal(l.nome, 'Navegador');
  assert.equal(l.alvo, '_blank');
  assert.equal(M.chaveDoHref(l.href), 'tela');
  assert.equal(M.linkTela({ id: 'tina', tem_painel: true }).href, '/p/tina/#aba=tela');
  assert.equal(M.linkTela({ id: 'admin', tipo: 'admin', tem_painel: true }), null);
  assert.equal(M.linkTela({ id: 'admin', tem_painel: false }), null);
});

test('instalar o app: instalado some, prompt do Chrome, iPhone explica, resto explica o porquê', () => {
  assert.equal(M.instrucaoInstalar({ standalone: true }).tipo, 'instalado');
  assert.equal(M.instrucaoInstalar({ promptGuardado: true }).tipo, 'prompt');
  const ios = M.instrucaoInstalar({ ios: true });
  assert.equal(ios.tipo, 'ios');
  assert.match(ios.texto, /Adicionar à Tela de Início/);
  assert.match(M.instrucaoInstalar({}).texto, /não oferece/);
});

test('manifesto instalável: standalone, start_url, ícones 192/512 e maskable existem', () => {
  const m = JSON.parse(pub('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(__dirname, '../public', i.src)), i.src);
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'));
});

test('hora da última mensagem: hh:mm hoje, "ontem", dd/mm antes, e vazio quando não se sabe', () => {
  const agora = new Date(2026, 9, 19, 15, 0).getTime();
  assert.equal(M.horaCurta(new Date(2026, 9, 19, 9, 5).getTime(), agora), '09:05');
  assert.equal(M.horaCurta(new Date(2026, 9, 18, 23, 59).getTime(), agora), 'ontem');
  assert.equal(M.horaCurta(new Date(2026, 9, 3, 12, 0).getTime(), agora), '03/10');
  assert.equal(M.horaCurta(new Date(2026, 8, 30, 12, 0).getTime(), new Date(2026, 9, 1, 8, 0).getTime()), 'ontem', 'vira o mês');
  for (const nada of [null, undefined, 0, NaN, '12']) assert.equal(M.horaCurta(nada, agora), '');
});

test('seletor: mostra a hora em .ml-hora só quando há ultima_ts, escapada', () => {
  const com = M.itemAgente({ id: 'a', nome: 'A', ultima_ts: Date.now() }, 'b');
  assert.match(com, /<span class="ml-hora">\d\d:\d\d<\/span>/);
  assert.doesNotMatch(M.itemAgente({ id: 'a', nome: 'A', ultima_ts: null }, 'b'), /ml-hora/);
  assert.match(pub('menu-lado.css'), /\.ml-aqui \+ \.ml-hora\{margin-left:6px\}/);
});

test('seletor: bolinha de não lidas em .ml-nl com número, 99+, e sem ela no atual, em 0 e em null', () => {
  assert.match(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: 3 }, 'b'), /<span class="ml-nl"[^>]*aria-label="3 mensagens não lidas">3<\/span>/);
  assert.match(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: 1 }, 'b'), /aria-label="1 mensagem não lida">1</);
  assert.match(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: 99, mais: true }, 'b'), />99\+<\/span>/);
  assert.doesNotMatch(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: 5 }, 'a'), /ml-nl/);
  assert.doesNotMatch(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: null }, 'b'), /ml-nl/);
  assert.doesNotMatch(M.itemAgente({ id: 'a', nome: 'A', nao_lidas: 0 }, 'b'), /ml-nl/);
  assert.doesNotMatch(M.itemAgente({ id: 'a', nome: 'A' }, 'b'), /ml-nl/);
  assert.match(pub('menu-lado.css'), /\.ml-nl\{[^}]*background:#d93025/);
});

test('totalNaoLidas soma só os outros agentes e ignora null', () => {
  const lista = [{ id: 'admin' }, { id: 'ana' }, { id: 'bia' }, { id: 'caio' }];
  const contagens = { admin: { nao_lidas: 5 }, ana: { nao_lidas: 2 }, bia: { nao_lidas: null }, caio: { nao_lidas: 0 } };
  assert.equal(M.totalNaoLidas(lista, contagens, 'admin'), 2);
  assert.equal(M.totalNaoLidas(lista, {}, 'admin'), 0);
  assert.equal(M.totalNaoLidas(lista, { bia: { nao_lidas: null } }, 'admin'), 0);
});

// ── Menu em grupos (acordeões) ──────────────────────────────────────────────
const AG = { id: 'ana', nome: 'Ana', tipo: 'agente', tem_painel: true, painel_url: '/p/ana/' };

test('grupos do menu: cada item tem um lugar e nenhum aparece em dois', () => {
  const todos = M.GRUPOS_MENU.flatMap(g => g.chaves);
  assert.equal(new Set(todos).size, todos.length, 'chave repetida entre grupos');
  assert.deepEqual(M.GRUPOS_MENU.map(g => g.nome), ['Perfil do agente', 'Dia a dia', 'Ferramentas', 'Operação', 'Segurança']);
  const por = Object.fromEntries(M.GRUPOS_MENU.map(g => [g.id, g.chaves]));
  assert.deepEqual(por.perfil, ['identity', 'personality', 'memory']);
  assert.deepEqual(por.dia, ['rotinas', 'lembretes', 'sessoes']);
  assert.deepEqual(por.ferramentas.slice(0, 2), ['skills', 'apps']);
  assert.deepEqual(por.operacao, ['status', 'operations', 'costs']);
  assert.deepEqual(por.seguranca.slice(0, 3), ['seguranca', 'cofre', 'avisos']);
});

test('organizaMenu (dono, agente com painel): fixos, cinco grupos, rodapé solto e Navegador em Conexões', () => {
  const org = M.organizaMenu(M.montaItens(AG, false));
  assert.deepEqual(org.fixos.map(i => i.chave), ['arquivos']);
  assert.deepEqual(org.grupos.map(g => g.id), ['perfil', 'dia', 'ferramentas', 'operacao', 'seguranca']);
  assert.deepEqual(org.rodape.map(i => i.chave), ['como', 'socorro']);
  assert.deepEqual(org.conexoes.map(i => i.chave), ['tela']);
  // nenhum item que existia antes sumiu
  const chaves = new Set(M.montaItens(AG, false).map(i => i.chave));
  for (const c of ['status', 'skills', 'rotinas', 'cofre', 'arquivos', 'memory', 'operations', 'costs', 'como', 'identity', 'personality', 'apps', 'socorro',
    'lembretes', 'avisos', 'seguranca', 'conectar', 'anonimizar', 'colaboradores', 'sessoes', 'tela']) assert.ok(chaves.has(c), c);
  const agrupados = [...org.fixos, ...org.grupos.flatMap(g => g.itens), ...org.rodape, ...org.conexoes];
  assert.equal(agrupados.length, chaves.size, 'todo item cai em exatamente um lugar');
});

test('organizaMenu: o Admin (sem painel) só tem os grupos com algo dentro; colaborador não vê cofre, Mesa nem o que é do dono', () => {
  const admin = M.organizaMenu(M.montaItens({ id: 'admin', tipo: 'admin', tem_painel: false }, false));
  assert.deepEqual(admin.grupos.map(g => g.id), ['dia', 'ferramentas', 'seguranca']);
  assert.deepEqual(admin.grupos.find(g => g.id === 'seguranca').itens.map(i => i.chave), ['seguranca', 'avisos'], 'o Admin não convida colaborador');
  assert.deepEqual(admin.conexoes, []);
  const colab = M.organizaMenu(M.montaItens(AG, true));
  const chaves = [...colab.fixos, ...colab.grupos.flatMap(g => g.itens), ...colab.rodape, ...colab.conexoes].map(i => i.chave);
  for (const nao of ['cofre', 'lembretes', 'avisos', 'seguranca', 'anonimizar', 'colaboradores', 'tela']) assert.ok(!chaves.includes(nao), nao);
  assert.ok(chaves.includes('sessoes') && chaves.includes('conectar'));
  assert.ok(!colab.grupos.some(g => g.id === 'seguranca'), 'grupo sem item não aparece');
});

test('menuHtml: cada grupo é um botão com aria-expanded e aria-controls, o conteúdo tem o mesmo id, e o data-tour dos itens fica', () => {
  const org = M.organizaMenu(M.montaItens(AG, false));
  const html = M.menuHtml(org, { dia: true });
  assert.match(html, /<button type="button" class="ml-grupo-cab" id="mlG-dia-b" aria-expanded="true" aria-controls="mlG-dia">/);
  assert.match(html, /<button type="button" class="ml-grupo-cab" id="mlG-perfil-b" aria-expanded="false" aria-controls="mlG-perfil">/);
  assert.match(html, /<div class="ml-grupo-itens" id="mlG-dia" role="group" aria-labelledby="mlG-dia-b">/);
  assert.match(html, /<div class="ml-grupo aberto" data-grupo="dia"/);
  assert.doesNotMatch(html, /<div class="ml-grupo aberto" data-grupo="perfil"/);
  for (const t of ['gm-lembretes', 'gm-avisos', 'gm-seguranca', 'gm-conectar', 'gm-anonimizar', 'gm-colaborador', 'gm-sessoes', 'gm-tela']) assert.ok(html.includes(`data-tour="${t}"`), t);
  assert.match(html, /data-selos/, 'o cabeçalho tem lugar para o selo de atenção');
  // sem item em Conexões o grupo nasce escondido; com Navegador aparece
  assert.match(M.menuHtml(M.organizaMenu([]), {}), /data-grupo="conexoes"[^>]*hidden/);
  assert.doesNotMatch(html, /data-grupo="conexoes"[^>]*hidden/);
  // Como funciona e Socorro ficam soltos no fim, fora dos grupos
  assert.match(html, /<div class="ml-solto">[\s\S]*Como funciona[\s\S]*Socorro[\s\S]*<\/div>$/);
});

test('menuHtml: nome de item vindo de fora sai escapado', () => {
  const html = M.menuHtml(M.organizaMenu([{ chave: 'extra-x', nome: '<img src=x onerror=1>', ico: 'i-dot', href: '/p/a/#aba=x"><script>' }]), {});
  assert.doesNotMatch(html, /<img src=x|<script/);
});

test('grupoDaChave: a página aberta abre o grupo dela', () => {
  assert.equal(M.grupoDaChave('lembretes'), 'dia');
  assert.equal(M.grupoDaChave('avisos'), 'seguranca');
  assert.equal(M.grupoDaChave('costs'), 'operacao');
  assert.equal(M.grupoDaChave('posts'), 'conexoes');
  for (const solto of ['', 'conversa', 'mesa', 'arquivos', 'como', 'socorro']) assert.equal(M.grupoDaChave(solto), '', solto);
});

test('menu-lado.css: acordeão com animação curta, sem animação em Reduzir Movimento, e alvo de 44px no toque', () => {
  const css = pub('menu-lado.css');
  assert.match(css, /\.ml-grupo-itens\{[^}]*grid-template-rows:0fr;visibility:hidden/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.ml-grupo-seta,\.ml-grupo-itens[^}]*transition:none/);
  assert.match(css, /pointer:coarse\)\{\.ml-tab,\.ml-grupo-cab[^}]*min-height:44px/);
  assert.match(css, /\.ml-grupo\.aberto \.ml-grupo-selos\{display:none\}/);
});

test('menu-lado.js: o estado dos grupos vai para o localStorage sem quebrar quando ele falha, e a visita guiada abre o grupo', () => {
  const js = pub('menu-lado.js');
  assert.match(js, /localStorage\.setItem\(CHAVE_ABERTOS/);
  assert.match(js, /não consegui guardar o grupo/);
  assert.match(js, /não consegui ler quais grupos do menu estavam abertos/);
  const p = M.passosMenu({ nome: 'Ana', comTroca: false, naConversa: true });
  const passo = p.find(x => x.alvo === '[data-tour="gm-lembretes"]');
  assert.ok(passo && typeof passo.antes === 'function', 'o passo de um item dentro de grupo abre o grupo antes');
  for (const x of p) assert.doesNotMatch(JSON.stringify(x), /[—–]/);
  let abriu = null, menuAberto = false;
  M.passosMenu({ nome: 'Ana', comTroca: false, abre: () => { menuAberto = true; }, abreGrupo: id => { abriu = id; } }).find(x => x.alvo === '[data-tour="gm-lembretes"]').antes();
  assert.equal(abriu, 'dia');
  assert.ok(menuAberto, 'abre o menu (gaveta do celular) e depois o grupo');
});
