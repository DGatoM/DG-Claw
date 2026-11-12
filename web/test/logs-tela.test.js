'use strict';
// Tela Logs: marcação, estilo, textos puros, tutorial, menu e a regra de nunca montar HTML com texto de log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../public/logs');
const M = require('../public/menu-lado');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');

test('logs.js não monta HTML por texto: sem innerHTML, outerHTML, insertAdjacentHTML, document.write nem eval', () => {
  const js = pub('logs.js');
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /outerHTML/);
  assert.doesNotMatch(js, /insertAdjacentHTML/);
  assert.doesNotMatch(js, /document\.write/);
  assert.doesNotMatch(js, /\beval\s*\(/);
  assert.doesNotMatch(js, /new Function/);
  assert.doesNotMatch(js, /\.href\s*=|\.src\s*=|setAttribute\(\s*['"](?:href|src|srcdoc)['"]/, 'nada de link nem iframe a partir do log');
  assert.doesNotMatch(js, /createElement\(\s*['"](?:a|iframe|script|img)['"]/);
  assert.match(js, /textContent/);
});

test('logs.html: casca, sem zoom, viewport, tour e os pontos que o script usa', () => {
  const h = pub('logs.html');
  assert.match(h, /<meta name="viewport"[^>]*user-scalable=no/);
  assert.match(h, /<script src="\/sem-zoom\.js"><\/script>/);
  for (const s of ['/tour.js', '/menu-lado.js', '/casca.js', '/logs.js']) assert.ok(h.includes(`src="${s}"`), s);
  assert.ok(h.indexOf('/casca.js') < h.indexOf('/logs.js'));
  assert.match(h, /DGCasca\.monta\(\{ pagina: 'logs', titulo: 'Logs'/);
  assert.match(h, /DGLogsTela\.tutorial\(\)/);
  for (const id of ['lgAgente', 'lgFontes', 'lgForm', 'lgDesde', 'lgAte', 'lgChips', 'lgBusca', 'lgSessao', 'lgLimpar', 'lgAvisos', 'lgEstado', 'lgLista', 'lgRodape', 'lgMais', 'lgMsgGeral']) {
    assert.ok(h.includes(`id="${id}"`), id);
  }
  assert.doesNotMatch(h, /autofocus/);
  assert.doesNotMatch(h, /<script>[^<]*innerHTML/);
  assert.equal((h.match(/class="lg-ajuda"/g) || []).length, 4, 'um ? por seção');
});

test('logs.css: sem rolagem horizontal, toque de 32 px, campos de 16 px e cores das variáveis da casca', () => {
  const css = pub('logs.css');
  assert.match(css, /min-width:0/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /pre\{[^}]*white-space:pre-wrap/);
  assert.match(css, /\.lg-campo\{[^}]*font-size:16px/);
  assert.match(css, /--line:/);
  assert.match(css, /--muted:/);
  assert.match(css, /--txt:/);
  assert.match(css, /\.lg-chip\{[^}]*min-height:34px/);
  assert.match(css, /\.lg-ajuda\{[^}]*width:34px;height:34px/);
});

test('sw.js guarda a tela de logs e a versão subiu', () => {
  const s = pub('sw.js');
  assert.match(s, /'\/logs\.js'/);
  assert.match(s, /'\/logs\.css'/);
  assert.match(s, /dgclaw-estaticos-v(3[6-9]|[4-9][0-9])'/);
});

test('consulta: só leva o que foi preenchido', () => {
  assert.equal(T.consulta({}, null), 'limite=50');
  const q = new URLSearchParams(T.consulta({ desde: '2026-11-01', ate: '2026-11-08', tipos: ['comando', 'arquivo'], q: 'olá mundo', sessao: 'abc' }, 'CUR'));
  assert.equal(q.get('desde'), '2026-11-01');
  assert.equal(q.get('ate'), '2026-11-08');
  assert.equal(q.get('tipo'), 'comando,arquivo');
  assert.equal(q.get('q'), 'olá mundo');
  assert.equal(q.get('sessao'), 'abc');
  assert.equal(q.get('cursor'), 'CUR');
  assert.equal(T.temFiltro({}), false);
  assert.equal(T.temFiltro({ tipos: [] }), false);
  assert.equal(T.temFiltro({ q: 'x' }), true);
});

test('estado vazio: "faltando fonte", "nada com os filtros", "ainda não fez nada" e "não olhei tudo" são frases diferentes', () => {
  const ok = [{ motor: 'claude', estado: 'ok' }];
  const falta = [{ motor: 'claude', estado: 'ausente', motivo: 'nunca rodou neste motor' }, { motor: 'codex', estado: 'ilegivel', motivo: 'EACCES' }];
  const a = T.estadoVazio(falta, false, false);
  assert.equal(a.tipo, 'faltando');
  assert.match(a.texto, /nunca rodou neste motor/);
  assert.match(a.texto, /EACCES/);
  assert.doesNotMatch(a.texto, /ainda não fez nada/);
  assert.equal(T.estadoVazio(ok, true, false).tipo, 'filtro');
  assert.match(T.estadoVazio(ok, true, false).texto, /Nada com esses filtros/);
  assert.equal(T.estadoVazio(ok, false, false).tipo, 'nada');
  assert.match(T.estadoVazio(ok, false, false).texto, /ainda não fez nada/);
  assert.equal(T.estadoVazio(ok, true, true).tipo, 'parcial');
  assert.equal(T.estadoVazio([], false, false).tipo, 'faltando');
});

test('erro da resposta diz a causa e o que fazer', () => {
  assert.match(T.erroDaResposta(401, null), /\/login/);
  assert.match(T.erroDaResposta(403, { erro: 'só do dono' }), /só do dono/);
  assert.match(T.erroDaResposta(429, { erro: 'ocupado' }), /Espere um instante/);
  assert.match(T.erroDaResposta(503, { erro: 'registro' }), /registro/);
  assert.match(T.erroDaResposta(500, null), /Tente de novo/);
});

test('fontes e contagens viram frases', () => {
  const ok = T.descreveFonte({ motor: 'claude', estado: 'ok', arquivos: 3, bytes: 2048, ultima_atividade: Date.parse('2026-11-08T12:00:00Z') });
  assert.equal(ok.titulo, 'Claude: Lida');
  assert.match(ok.detalhe, /3 arquivo\(s\), 2 KB/);
  const aus = T.descreveFonte({ motor: 'codex', estado: 'ausente', motivo: 'nunca rodou neste motor' });
  assert.equal(aus.titulo, 'Codex: Ausente');
  assert.equal(aus.detalhe, 'nunca rodou neste motor');
  assert.equal(T.resumoContagens({ linhas_ilegiveis: 0, linhas_gigantes: 0, sem_horario: 0, atalhos_ignorados: 0 }), '');
  assert.match(T.resumoContagens({ linhas_ilegiveis: 2, linhas_gigantes: 1, sem_horario: 3, atalhos_ignorados: 4 }), /2 linha\(s\) com JSON quebrado.*1 linha\(s\) grande\(s\)/);
  assert.equal(T.tamanho(512), '512 B');
  assert.equal(T.tamanho(5 * 1024 * 1024), '5,0 MB');
  assert.equal(T.sessaoCurta({ sessao: '12345678-aaaa', id: 'x:1' }), '12345678');
  assert.equal(T.sessaoCurta({ sessao: null, id: 'abcdef012345:99' }), 'abcdef01');
});

test('tutorial: cada passo responde o que é, como calculo e por que está aqui, e aponta para algo que existe', () => {
  const h = pub('logs.html');
  const passos = T.passosPagina(null);
  assert.equal(passos.length, 4);
  for (const p of passos) {
    for (const campo of ['alvo', 'titulo', 'oque', 'como', 'porque']) assert.ok(p[campo] && p[campo].length > (['alvo', 'titulo'].includes(campo) ? 3 : 10), `${p.titulo || p.alvo}: ${campo}`);
    assert.ok(h.includes(`id="${p.alvo.slice(1)}"`), `${p.alvo} existe no HTML`);
  }
  for (const chave of Object.keys(T.PASSOS)) assert.ok(h.includes(`data-secao="${chave}"`), `? da seção ${chave}`);
});

test('texto da tela sem travessão no meio de frase nem a fórmula "não é X, é Y"', () => {
  for (const arq of ['logs.js', 'logs.html', 'logs.css', '../docs/LOGS.md']) {
    const t = pub(arq);
    assert.doesNotMatch(t, /[—–]/, arq);
    assert.doesNotMatch(t, /não é (sobre|só|apenas|uma questão)|não se trata/i, arq);
  }
});

// ── menu ────────────────────────────────────────────────────────────────────
test('menu: item Logs só no Admin do dono', () => {
  assert.deepEqual(M.LINK_LOGS, { nome: 'Logs', ico: '≡', href: '/logs' });
  assert.equal(M.chaveDoHref('/logs'), 'logs');
  assert.equal(M.chaveDoHref('/logs/'), 'logs');
  assert.equal(M.chaveDoHref('/logs?a=admin'), 'logs');
  assert.equal(M.mostraLogs({ id: 'admin', tipo: 'admin' }, false), true);
  assert.equal(M.mostraLogs({ id: 'ana', tipo: 'agente' }, false), false);
  assert.equal(M.mostraLogs({ id: 'admin', tipo: 'admin' }, true), false, 'colaborador nunca');
  assert.equal(M.mostraLogs(null, false), false);
  const src = pub('menu-lado.js');
  assert.match(src, /if \(mostraLogs\(ag, colab\)\) \{[\s\S]*LINK_LOGS\.href/);
  assert.ok(M.passosMenu({ nome: 'Admin', naConversa: true })[0].como.includes('Logs'), 'o tutorial do menu cita o item');
});

test('fontes parcial e não verificada aparecem com o motivo, e uma fonte parcial com arquivos não vira "sem histórico"', () => {
  const nv = T.descreveFonte({ motor: 'claude', estado: 'nao_verificada', motivo: 'passou do prazo' });
  assert.equal(nv.titulo, 'Claude: Não verificada');
  assert.equal(nv.detalhe, 'passou do prazo');
  const pa = T.descreveFonte({ motor: 'codex', estado: 'parcial', motivo: 'a pasta tem mais de 50000 entradas', arquivos: 7, bytes: 1024, ultima_atividade: null });
  assert.equal(pa.titulo, 'Codex: Parcial');
  assert.match(pa.detalhe, /7 arquivo\(s\).*Atenção: a pasta tem mais de 50000 entradas/);
  assert.equal(T.estadoVazio([{ motor: 'claude', estado: 'parcial', arquivos: 3, motivo: 'x' }], false, false).tipo, 'nada');
  assert.equal(T.estadoVazio([{ motor: 'claude', estado: 'nao_verificada', arquivos: null, motivo: 'x' }], false, false).tipo, 'faltando');
});

test('busca parcial sem como continuar não promete "Continuar procurando"', () => {
  const ok = [{ motor: 'claude', estado: 'ok', arquivos: 1 }];
  const v = T.estadoVazio(ok, false, true, false);
  assert.equal(v.tipo, 'parada');
  assert.doesNotMatch(v.texto, /Continuar procurando/);
  assert.equal(T.estadoVazio(ok, false, true, true).tipo, 'parcial');
});
