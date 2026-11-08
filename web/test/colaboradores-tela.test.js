'use strict';
// Telas do colaborador: papel.js, menu curto, textos da página Conectar, cofre fechado e páginas novas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../public/menu-lado');
const P = require('../public/conectar-puro');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

/** Roda o papel.js numa "janela" falsa com o cookie dado. */
function papelCom(cookie) {
  const classes = new Set();
  const janela = { document: { cookie, documentElement: { classList: { add: (c) => classes.add(c) } } } };
  vm.runInNewContext(pub('papel.js'), Object.assign(janela, { globalThis: janela, window: janela }));
  return { papel: janela.DGPapel, classes };
}

test('papel.js: só o cookie "colaborador" liga o modo colaborador; ausente, vazio ou estranho é dono', () => {
  const colab = papelCom('x=1; dgclaw_papel=colaborador; y=2');
  assert.equal(colab.papel.colaborador, true);
  assert.ok(colab.classes.has('papel-colab'));
  for (const c of ['', 'dgclaw_papel=dono', 'dgclaw_papel=', 'dgclaw_papel=Colaborador', 'outro_dgclaw_papel=colaborador', 'dgclaw_papel=colaboradorx']) {
    const r = papelCom(c);
    assert.equal(r.papel.colaborador, false, c);
    assert.equal(r.classes.size, 0, c);
  }
});

test('conversa.html e conectar.html carregam o papel.js e o papel.css antes dos outros scripts', () => {
  for (const n of ['conversa.html', 'conectar.html']) {
    const h = pub(n);
    assert.match(h, /<script src="\/papel\.js"><\/script>/, n);
    assert.match(h, /<link rel="stylesheet" href="\/papel\.css">/, n);
    assert.ok(h.indexOf('/papel.js') < h.indexOf('/menu-lado.js'), n);
  }
  assert.match(pub('papel.css'), /\.papel-colab #btnMesa/);
  assert.match(pub('sw.js'), /'\/papel\.js'/);
});

test('colaborador vê o agente inteiro: Sessões e as páginas do painel dele não são escondidas', () => {
  const css = pub('papel.css');
  assert.doesNotMatch(css, /#btnSessoes/);
  assert.doesNotMatch(css, /#mlPainel/);
  assert.match(css, /#btnMesa/);
  assert.match(css, /#mlTroca/);
  assert.doesNotMatch(pub('conversa.js'), /COLAB\) for \(const id of \[[^\]]*btnSessoes/);
  assert.match(pub('menu-lado.js'), /if \(Array\.isArray\(opcoes\.extras\)\) extras\(opcoes\.extras\)/);
});

test('menu do colaborador: visita curta, com as páginas do agente e sem Mesa, Lembretes, Avisos nem troca de agente', () => {
  const passos = M.passosMenu({ nome: 'Ana', comTroca: true, naConversa: true, colaborador: true });
  assert.equal(passos.length, 1);
  assert.match(passos[0].como, /Conectar conta/);
  assert.match(passos[0].oque, /Sessões de trabalho/);
  assert.doesNotMatch(JSON.stringify(passos), /Mesa|Lembretes|Avisos|Segurança|Admin/);
  const dono = M.passosMenu({ nome: 'Ana', comTroca: true, naConversa: true });
  assert.equal(dono.length, 2);
  assert.equal(M.chaveDoHref('/colaboradores?agente=ana'), 'colaboradores');
  assert.equal(M.LINK_COLABORADOR.href, '/colaboradores');
});

test('menu-lado.js: Convidar colaborador só para o dono e nunca para o Admin', () => {
  const js = pub('menu-lado.js');
  assert.match(js, /if \(!colab && ag\.tipo !== 'admin' && ag\.id\)/);
  assert.match(js, /LINK_COLABORADOR\.href\}\?agente=\$\{encodeURIComponent\(ag\.id\)\}/);
  // colaborador não dispara nada que o servidor nega (lista de agentes, uso), mas tem as páginas e as Sessões do agente dele
  assert.match(js, /else if \(!colab\) recarrega\(ag\)/);
  assert.match(js, /if \(colab\) \{ const uso = \$\('mlUso'\); if \(uso\) uso\.remove\(\); \} else ligaUso\(\)/);
  assert.doesNotMatch(js, /if \(!colab\) ligaSessoes/);
  assert.match(js, /filter\(l => !colab \|\| chaveDoHref\(l\.href\) !== 'cofre'\)/, 'o cofre do agente não aparece no menu do colaborador');
});

test('página Conectar para colaborador: sem Admin nem "pedir ao Admin"', () => {
  const c = P.pronto({ usuario: 'maria@x.com', principalNome: 'Ana', endereco: 'https://x/', colaborador: true });
  assert.deepEqual(c.itens, ['Ana: o agente com quem você conversa por aqui.']);
  assert.match(c.passo2, /maria@x\.com/);
  assert.doesNotMatch(JSON.stringify(c), /Admin/);
  assert.match(P.pronto({ usuario: 'dono', principalNome: 'Ana', endereco: 'x' }).itens[0], /Admin/);
  assert.deepEqual(P.textosModal(1, { principalNome: 'Ana', colaborador: true }).itens, c.itens);
});

test('cofre da lousa: para colaborador mostra o aviso e não monta campo de chave', () => {
  const janela = { DGPapel: { colaborador: true } };
  janela.document = undefined;
  const cc = vm.runInNewContext(`${pub('campo-cofre.js')}\n;module.exports`, { window: janela, module: { exports: {} }, globalThis: janela, console }, { filename: 'campo-cofre.js' });
  // o arquivo escolhe a raiz por `typeof window`; sem document ele só exporta a API
  const api = cc && cc.html ? cc : janela.campoCofre;
  assert.ok(api, 'a API do campo do cofre não carregou');
  const h = api.html('GROQ_API_KEY', 'Chave', 'id1');
  assert.match(h, /O cofre é só do dono do DG Claw\./);
  assert.doesNotMatch(h, /type="password"/);
});

test('páginas novas: tutorial, viewport sem zoom, campos de 16 px e nada de travessão em texto', () => {
  for (const n of ['colaboradores.html', 'trocar-senha.html']) {
    const h = pub(n);
    assert.match(h, /maximum-scale=1, user-scalable=no/, n);
    assert.match(h, /sem-zoom\.js/, n);
    assert.match(h, /\/tour\.js/, n);
  }
  assert.match(pub('colaboradores.js'), /DGCasca\.monta\(\{ pagina: 'colaboradores'/);
  assert.match(pub('colaboradores.html'), /data-co="ajuda"/);
  assert.match(pub('trocar-senha.js'), /tsTutorial/);
  assert.match(pub('colaboradores.css'), /font-size:16px/);
  for (const n of ['colaboradores.html', 'colaboradores.js', 'colaboradores.css', 'trocar-senha.html', 'trocar-senha.js', 'trocar-senha.css', 'papel.js', 'papel.css']) {
    assert.doesNotMatch(pub(n), /[—–]/, `${n} tem travessão`);
  }
});

test('login.js: o link do convite preenche o usuário e leva o cursor à senha', () => {
  const js = pub('login.js');
  assert.match(js, /const u = q\.get\('usuario'\)/);
  assert.match(js, /campoSenha'\)\.focus\(\)/);
  assert.match(js, /vencida:/);
});
