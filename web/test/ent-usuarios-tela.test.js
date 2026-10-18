'use strict';
// Telas do bloco B: Minha conta, Usuários e a etapa do 2FA no login. Funções puras, arquivos ligados e tutorial.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/conta-comum');
const Conta = require('../public/conta');
const Usuarios = require('../public/usuarios');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('dataBr: data em português, e "nunca" quando não há data (nunca 1970)', () => {
  assert.equal(C.dataBr(Date.parse('2026-10-18T15:05:00Z'), 'America/Sao_Paulo'), '18/10/2026 12:05');
  assert.equal(C.dataBr(null), 'nunca');
  assert.equal(C.dataBr(undefined), 'nunca');
  assert.equal(C.dataBr('abc'), 'nunca');
});

test('resumoUa: reconhece o aparelho sem expor o texto cru', () => {
  assert.equal(C.resumoUa('Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit Chrome/120.0 Safari/537'), 'Chrome em Windows');
  assert.equal(C.resumoUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17) AppleWebKit Version/17 Mobile Safari/604'), 'Safari em iPhone/iPad');
  assert.equal(C.resumoUa('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko Firefox/120.0'), 'Firefox em Linux');
  assert.equal(C.resumoUa(''), 'aparelho desconhecido');
});

test('htmlSessoes: marca a atual, escapa o texto e põe o botão só quando pedido', () => {
  const lista = [{ id: 'a'.repeat(16), atual: true, ua: '<script>x</script> Chrome/1', ip: '1.2.3.4', criada: 1, ultimo_uso: null, expira: 2 }];
  const h = C.htmlSessoes(lista, { botao: 'Sair desta sessão' });
  assert.match(h, /esta aqui/);
  assert.match(h, /data-acao="sair-sessao" data-id="a{16}"/);
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /último uso nunca/);
  assert.doesNotMatch(C.htmlSessoes(lista), /data-acao="sair-sessao"/);
  assert.match(C.htmlSessoes([]), /Nenhuma sessão aberta/);
});

test('htmlSegredo e htmlCodigosReserva: chave em grupos, link otpauth, códigos escapados', () => {
  const h = C.htmlSegredo({ segredo_agrupado: 'ABCD EFGH', otpauth: 'otpauth://totp/x?secret=ABCD&issuer=a"b' });
  assert.match(h, /data-chave>ABCD EFGH</);
  assert.match(h, /href="otpauth:\/\/totp\/x\?secret=ABCD&amp;issuer=a&quot;b"/);
  const r = C.htmlCodigosReserva(['aaaa-bbbb-cccc', '<b>']);
  assert.match(r, /Guarde estes 2 códigos/);
  assert.match(r, /&lt;b&gt;/);
});

test('Minha conta: 2FA desligado e obrigatório, desligado e opcional, ligado e travado, ligado e liberado', () => {
  const base = { usuario: 'ana', nome: 'Ana', papel: 'funcionario', agentes: ['luna'], ultimo_login: null, nivel_2fa: 'ti' };
  const off = Conta.htmlDoisFatores(Object.assign({}, base, { totp: { ativo: false, codigos_reserva: 0 }, exige_2fa: true, pode_desativar_2fa: false }));
  assert.match(off, /desligado/);
  assert.match(off, /obrigatório/);
  assert.match(off, /data-acao="iniciar-2fa"/);
  assert.match(Conta.htmlDoisFatores(Object.assign({}, base, { totp: { ativo: false, codigos_reserva: 0 }, exige_2fa: false })), /opcional/);
  const travado = Conta.htmlDoisFatores(Object.assign({}, base, { totp: { ativo: true, ativado_em: 1, codigos_reserva: 7 }, exige_2fa: true, pode_desativar_2fa: false }));
  assert.match(travado, /ligado/);
  assert.match(travado, /Não dá para desligar/);
  assert.doesNotMatch(travado, /data-form="desativar-2fa"/);
  const livre = Conta.htmlDoisFatores(Object.assign({}, base, { totp: { ativo: true, ativado_em: 1, codigos_reserva: 7 }, exige_2fa: false, pode_desativar_2fa: true }));
  assert.match(livre, /data-form="desativar-2fa"/);
  const ativando = Conta.htmlDoisFatores(Object.assign({}, base, { totp: { ativo: false, codigos_reserva: 0 }, exige_2fa: false }), { segredo_agrupado: 'AAAA BBBB', otpauth: 'otpauth://x' });
  assert.match(ativando, /data-form="ativar-2fa"/);
  assert.match(ativando, /AAAA BBBB/);
});

test('Minha conta: os dados mostram os agentes liberados só para funcionário', () => {
  const f = Conta.htmlDados({ usuario: 'ana', nome: 'Ana <b>', papel: 'funcionario', agentes: ['luna', 'marina'], ultimo_login: null });
  assert.match(f, /Agentes liberados<\/dt><dd>luna, marina/);
  assert.match(f, /Ana &lt;b&gt;/);
  assert.doesNotMatch(Conta.htmlDados({ usuario: 'ti', nome: 'TI', papel: 'ti', agentes: [], ultimo_login: 5 }), /Agentes liberados/);
  assert.match(Conta.htmlDados({ usuario: 'x', nome: 'X', papel: 'funcionario', agentes: [], ultimo_login: null }), /nenhum ainda/);
});

test('Usuários: cartão com selos, ações certas para ativo e desativado, tudo escapado', () => {
  const u = { usuario: 'bia', nome: 'Bia <i>', email: 'b@x.com', papel: 'funcionario', agentes: ['luna'], ativo: true, totp: { ativo: true }, exige_2fa: false, link_pendente: true, ultimo_login: null };
  const h = Usuarios.htmlUsuario(u, [{ id: 'luna', nome: 'Luna' }]);
  assert.match(h, /Bia &lt;i&gt;/);
  assert.match(h, /2FA ligado/);
  assert.match(h, /link de senha pendente/);
  assert.match(h, /data-acao="zerar-2fa"/);
  assert.match(h, /data-acao="desativar"/);
  assert.doesNotMatch(h, /data-acao="reativar"/);
  const off = Usuarios.htmlUsuario(Object.assign({}, u, { ativo: false, totp: { ativo: false }, link_pendente: false }), []);
  assert.match(off, /data-acao="reativar"/);
  assert.doesNotMatch(off, /data-acao="link"/);
  assert.doesNotMatch(off, /data-acao="zerar-2fa"/);
  const ti = Usuarios.htmlUsuario({ usuario: 'ti1', nome: 'TI', email: '', papel: 'ti', agentes: [], ativo: true, totp: { ativo: false }, exige_2fa: true, link_pendente: false, ultimo_login: null }, []);
  assert.match(ti, /Vê todos os agentes/);
  assert.match(ti, /2FA pendente/);
});

test('Usuários: formulário novo lista os agentes liberáveis; sem agentes avisa; link aparece com o aviso de uso único', () => {
  assert.match(Usuarios.htmlFormNovo([{ id: 'luna', nome: 'Luna' }]), /name="agentes" value="luna"/);
  assert.match(Usuarios.htmlFormNovo([]), /Ainda não há agentes de trabalho/);
  const l = Usuarios.htmlLink({ usuario: 'bia', link: 'http://x/primeiro-acesso#tok', link_expira_em: 0 });
  assert.match(l, /Link de senha para bia/);
  assert.match(l, /Vale uma vez/);
  assert.match(Usuarios.htmlLista([], []), /dgclaw usuario criar/);
});

test('as páginas carregam casca, tour, scripts e tutorial; a do 2FA tem Tutorial e viewport', () => {
  for (const [arq, script, pagina] of [['conta.html', '/conta.js', 'conta'], ['usuarios.html', '/usuarios.js', 'usuarios']]) {
    const h = pub(arq);
    for (const src of ['/tour.js', '/menu-lado.js', '/casca.js', '/conta-comum.js', script]) assert.ok(h.includes(`<script src="${src}">`), `${arq} sem ${src}`);
    assert.ok(h.includes('href="/conta.css"'));
    assert.match(h, new RegExp(`DGCasca\\.monta\\(\\{ pagina: '${pagina}'`));
    assert.match(h, /name="viewport"[^>]*width=device-width/);
  }
  const d = pub('login-2fa.html');
  assert.match(d, /id="tutorial"/);
  assert.match(d, /name="viewport"[^>]*width=device-width/);
  assert.match(d, /autocomplete="one-time-code"/);
});

test('tutorial: todo passo responde o que é, como funciona e por que está aqui', () => {
  for (const M of [Conta, Usuarios]) {
    for (const passos of Object.values(M.PASSOS)) {
      for (const p of passos) for (const campo of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[campo] && p[campo].length > (campo === 'titulo' ? 3 : 15), `${p.titulo}/${campo}`);
    }
  }
  assert.match(pub('login-2fa.js'), /oque:.*como:.*porque:/s);
});

test('o css não deixa a tela rolar de lado, tem alvo de toque e vira duas colunas só em tela larga', () => {
  const css = pub('conta.css');
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /grid-template-columns:1fr;/);
  assert.match(css, /@media \(min-width:720px\)/);
  assert.match(css, /min-height:36px/);
});

test('o gancho do menu: menu-lado.js carrega ent-conta.js e ele só age com papel na resposta de /api/v1/eu', () => {
  assert.match(pub('menu-lado.js'), /\/ent-conta\.js/);
  const js = pub('ent-conta.js');
  assert.match(js, /if \(!eu \|\| !eu\.papel\) return;/);
  assert.match(js, /\/usuarios/);
});
