'use strict';
// Ronda de fábrica no painel: validação do ronda.json, pedidos (arquivos), emergência com frase e código, caixa recusada.
// Contrato: docs/interno/CONTRATO-RONDA.md. Rotas: web/docs/RONDA-PAINEL.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, cliente } = require('./ajuda');
const { validaAchado, validaRonda } = require('../lib/ronda-painel');

const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'admin' },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna' },
];
const AGORA = Date.parse('2026-10-31T12:00:00Z');
const achado = (extra) => Object.assign({
  id: 'UBUNTU-CVE-2026-98432', aliases: ['CVE-2026-98432'], nivel: 2, severidade: 'HIGH',
  nome_simples: 'Falha no kernel Linux (rede TCP IPv4)', componente: 'kernel Linux', publicado_em: '2026-10-15T00:00:00Z',
  fonte_url: 'https://ubuntu.com/security/CVE-2026-98432', noticia_url: null, onde: ['kernel 6.8.0-147 em execução'],
  o_que_faz: 'Um pacote malformado pode travar o servidor.', como_corrigir: 'Aplicar a mitigação do catálogo.',
  correcao: { tipo: 'acao-catalogo', acao_id: 'sysctl-mptcp-off', exige_reinicio: false, disponivel: true, executavel: true },
  estado: 'aberto', aplicado: null, primeira_vez_em: '2026-10-31T10:00:00Z',
}, extra || {});
const ronda = (achados, extra) => Object.assign({
  versao: 1, rodada_em: '2026-10-31T10:00:00Z', proxima_em: '2026-10-31T16:00:00Z', parcial: false,
  fontes: [{ nome: 'OSV.dev', ok: true, motivo: null }],
  inventario: { componentes: 12, kernel: '6.8.0-147-generic', portas_publicas: [{ porta: 443, processo: 'caddy', pacote: 'caddy' }], servicos_externos: [], reinventariado_em: '2026-10-30T10:00:00Z' },
  achados, ja_tratadas: [],
}, extra || {});
const pastaSeg = (w) => path.join(w.dados, 'seguranca');
const gravaRonda = (w, conteudo) => {
  fs.mkdirSync(pastaSeg(w), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pastaSeg(w), 'ronda.json'), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
};
const gravaEmergencia = (w, extra) => {
  fs.mkdirSync(pastaSeg(w), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pastaSeg(w), 'emergencia.json'), JSON.stringify(Object.assign({
    versao: 1, atualizado_em: '2026-10-31T11:00:00Z', disponivel: true, motivo: '', avisos: ['o painel também sai do ar'],
    estado: { cortado: false, desde: '', quem: '', isolar_saida: false, confirmado: false, religar_automatico_agendado: false, religar_automatico_em: '', servicos: [{ nome: 'caddy', ativo: true }] },
    plano: { recusado: false, problemas: [], avisos: [], isolar_saida: false, prazo_min: 5, servicos_a_parar: ['caddy'], comandos: ['systemctl stop caddy', 'ufw default deny incoming'] },
  }, extra || {})));
};
const pedidos = (w) => { try { return fs.readdirSync(path.join(pastaSeg(w), 'pedidos')).filter((n) => n.endsWith('.json')); } catch { return []; } };
const lePedido = (w, uuid) => JSON.parse(fs.readFileSync(path.join(pastaSeg(w), 'pedidos', `${uuid}.json`), 'utf8'));
async function logado(opcoes) {
  const w = await subirWeb(Object.assign({ agentes: AGENTES, opcoesServidor: { agora: () => AGORA } }, opcoes));
  await w.login();
  return w;
}

// --- validação ------------------------------------------------------------------------------------

test('achado válido passa; campos desconhecidos somem; texto com controle é limpo e cortado', () => {
  const r = validaAchado(achado({ coisa_nova: 'x', o_que_faz: 'linha\u0007 com‮ controle ' + 'a'.repeat(900) }));
  assert.ok(r.achado);
  assert.equal(r.achado.coisa_nova, undefined);
  assert.ok(!/[\u0007‮]/.test(r.achado.o_que_faz));
  assert.ok(Array.from(r.achado.o_que_faz).length <= 500);
  assert.equal(r.achado.noticia_url, null);
});

test('achado sem fonte https, com nível fora de 1 a 3 ou com id ruim é descartado, com motivo', () => {
  for (const [extra, motivo] of [
    [{ fonte_url: undefined }, /sem fonte_url/], [{ fonte_url: 'http://x.org/a' }, /sem fonte_url/], [{ fonte_url: 'javascript:alert(1)' }, /sem fonte_url/],
    [{ fonte_url: 'https://u:p@x.org/' }, /sem fonte_url/], [{ nivel: 4 }, /nivel/], [{ nivel: '2' }, /nivel/], [{ id: 'x!' }, /id fora/],
  ]) {
    const r = validaAchado(achado(extra));
    assert.equal(r.achado, undefined, JSON.stringify(extra));
    assert.match(r.motivo, motivo);
  }
});

test('notícia http é descartada sem derrubar o achado; correção sem disponivel true vale como indisponível', () => {
  const r = validaAchado(achado({ noticia_url: 'http://x.org/n', correcao: { tipo: 'acao-catalogo', acao_id: 'a', disponivel: 'true' } }));
  assert.equal(r.achado.noticia_url, null);
  assert.equal(r.achado.correcao.disponivel, false);
  assert.equal(validaAchado(achado({ correcao: { tipo: 'rm -rf', acao_id: '$(x)' } })).achado.correcao.tipo, 'nenhuma');
  assert.equal(validaAchado(achado({ correcao: { tipo: 'apt', acao_id: '$(x)' } })).achado.correcao.acao_id, null);
});

test('contrato de id: o painel aceita GHSA em minúsculas e normaliza para maiúsculas (aliases também)', () => {
  const r = validaAchado(achado({ id: 'GHSA-aaaa-bbbb-cccc', aliases: ['ghsa-dddd-eeee-ffff', 'CVE-2026-1234'] }));
  assert.equal(r.achado.id, 'GHSA-AAAA-BBBB-CCCC');
  assert.deepEqual(r.achado.aliases, ['GHSA-DDDD-EEEE-FFFF', 'CVE-2026-1234']);
  const rr = validaRonda(ronda([achado({ id: 'GHSA-aaaa-bbbb-cccc', nivel: 2 })]));
  assert.deepEqual(rr.ronda.niveis[2].map((x) => x.id), ['GHSA-AAAA-BBBB-CCCC']);
  assert.equal(validaAchado(achado({ id: 'x!' })).achado, undefined);
});

test('correcao.executavel só vale para acao-catalogo; ausente ou de outro tipo é false', () => {
  assert.equal(validaAchado(achado()).achado.correcao.executavel, true);
  assert.equal(validaAchado(achado({ correcao: { tipo: 'apt', disponivel: true, executavel: true } })).achado.correcao.executavel, false);
  assert.equal(validaAchado(achado({ correcao: { tipo: 'acao-catalogo', acao_id: 'a', disponivel: true } })).achado.correcao.executavel, false);
});

test('validaRonda agrupa por nível, mais grave primeiro, e acusa os descartados', () => {
  const descartes = [];
  const r = validaRonda(ronda([
    achado({ id: 'AAA-1', nivel: 3, severidade: 'LOW' }), achado({ id: 'AAA-2', nivel: 2, severidade: 'MEDIUM' }),
    achado({ id: 'AAA-3', nivel: 2, severidade: 'CRITICAL' }), achado({ id: 'AAA-4', fonte_url: null }), achado({ id: 'AAA-3' }),
  ], { parcial: true, fontes: [{ nome: 'OSV.dev', ok: true }, { nome: 'Ubuntu', ok: false, motivo: 'timeout' }], vigia_alerta: 'ronda atrasada' }), (id, m) => descartes.push([id, m]));
  assert.deepEqual(r.ronda.niveis[2].map((a) => a.id), ['AAA-3', 'AAA-2']);
  assert.deepEqual(r.ronda.niveis[3].map((a) => a.id), ['AAA-1']);
  assert.deepEqual(r.ronda.fontes_fora, ['Ubuntu']);
  assert.equal(r.ronda.vigia_alerta.motivo, 'ronda atrasada');
  assert.equal(descartes.length, 2);
  assert.equal(r.ronda.sem_novidades, false);
});

// --- GET /ronda ----------------------------------------------------------------------------------------

test('GET /ronda: ausente = nunca_rodou; válido; corrompido = 500 com caminho e comando', async () => {
  const w = await logado();
  try {
    let r = await w.c.get('/api/v1/seguranca/ronda');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, nunca_rodou: true });
    gravaRonda(w, ronda([achado(), achado({ id: 'GHSA-AAAA-1', nivel: 3, severidade: 'LOW' })]));
    r = await w.c.get('/api/v1/seguranca/ronda');
    assert.equal(r.status, 200);
    assert.equal(r.json.nunca_rodou, false);
    assert.equal(r.json.niveis['2'].length, 1);
    assert.equal(r.json.niveis['3'].length, 1);
    assert.equal(r.json.inventario.kernel, '6.8.0-147-generic');
    assert.equal(r.json.rodada_em, '2026-10-31T10:00:00Z');
    gravaRonda(w, ronda([]));
    assert.equal((await w.c.get('/api/v1/seguranca/ronda')).json.sem_novidades, true);
    gravaRonda(w, '{nao e json');
    r = await w.c.get('/api/v1/seguranca/ronda');
    assert.equal(r.status, 500);
    assert.match(r.json.erro, /ronda\.json/);
    assert.match(r.json.erro, /sudo dgclaw seguranca rodar/);
    gravaRonda(w, '{"achados": 3}');
    assert.equal((await w.c.get('/api/v1/seguranca/ronda')).status, 500);
  } finally { await w.fechar(); }
});

// --- pedidos -----------------------------------------------------------------------------------------

test('POST aplicar grava o pedido no formato do contrato (atômico, 600) e devolve o uuid', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([achado()]));
    const r = await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar', { json: {} });
    assert.equal(r.status, 202);
    assert.match(r.json.pedido, /^[0-9a-f-]{36}$/);
    const p = lePedido(w, r.json.pedido);
    assert.equal(p.tipo, 'aplicar');
    assert.equal(p.id, 'UBUNTU-CVE-2026-98432');
    assert.equal(p.quando, null);
    assert.equal(p.codigo, null);
    assert.equal(p.por, 'dono');
    assert.equal(p.pedido_em, new Date(AGORA).toISOString());
    assert.equal(fs.statSync(path.join(pastaSeg(w), 'pedidos', `${r.json.pedido}.json`)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(pastaSeg(w), 'pedidos')).filter((n) => n.endsWith('.tmp')), []);
  } finally { await w.fechar(); }
});

test('aplicar recusa id desconhecido (404), id malformado (400), correção indisponível e achado já tratado (409); nada é gravado', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([
      achado(), achado({ id: 'SEM-FIX-1', correcao: { tipo: 'nenhuma', disponivel: false } }), achado({ id: 'JA-FEITO-1', estado: 'aplicado-pelo-dono' }),
    ]));
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/NAO-EXISTE-9/aplicar', { json: {} })).status, 404);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/x!/aplicar', { json: {} })).status, 400);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/minusculo/aplicar', { json: {} })).status, 404, 'minúsculas são aceitas e normalizadas; aqui só não existe');
    const sem = await w.c.post('/api/v1/seguranca/ronda/SEM-FIX-1/aplicar', { json: {} });
    assert.equal(sem.status, 409);
    assert.match(sem.json.erro, /ainda não está pronta/);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/JA-FEITO-1/aplicar', { json: {} })).status, 409);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar', { json: {}, origin: 'https://fora.exemplo' })).status, 403);
    assert.deepEqual(pedidos(w), []);
    assert.equal((await w.c.get('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar')).status, 405);
  } finally { await w.fechar(); }
});

test('aplicar e agendar recusam correção não executável (409 explicando); com id em minúsculas o pedido sai em maiúsculas', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([
      achado({ id: 'USN-APT-1', correcao: { tipo: 'apt', disponivel: true, executavel: false } }),
      achado({ id: 'GHSA-aaaa-bbbb-cccc' }),
    ]));
    const quando = new Date(Date.now() + 3600 * 1000).toISOString();
    const a = await w.c.post('/api/v1/seguranca/ronda/USN-APT-1/aplicar', { json: {} });
    assert.equal(a.status, 409);
    assert.match(a.json.erro, /não é uma ação do catálogo/);
    assert.match(a.json.erro, /Pedir ao Admin/);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/USN-APT-1/agendar', { json: { quando } })).status, 409);
    const ok = await w.c.post('/api/v1/seguranca/ronda/ghsa-aaaa-bbbb-cccc/aplicar', { json: {} });
    assert.equal(ok.status, 202);
    assert.equal(ok.json.id, 'GHSA-AAAA-BBBB-CCCC');
    assert.equal(pedidos(w).length, 1, 'só o pedido válido foi gravado');
  } finally { await w.fechar(); }
});

test('sem ronda.json, aplicar responde 404 explicando', async () => {
  const w = await logado();
  try {
    const r = await w.c.post('/api/v1/seguranca/ronda/AAA-1/aplicar', { json: {} });
    assert.equal(r.status, 404);
    assert.match(r.json.erro, /ainda não rodou/);
  } finally { await w.fechar(); }
});

test('pedido repetido enquanto o primeiro não terminou: 409; fila cheia: 429', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([achado()]));
    const a = await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar', { json: {} });
    assert.equal(a.status, 202);
    const b = await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar', { json: {} });
    assert.equal(b.status, 409);
    assert.equal(b.json.pedido, a.json.pedido);
    assert.equal(pedidos(w).length, 1);
    const dir = path.join(pastaSeg(w), 'pedidos');
    for (let i = 0; i < 25; i += 1) fs.writeFileSync(path.join(dir, `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.json`), '{}');
    const c = await w.c.post('/api/v1/seguranca/emergencia/preparar', { json: {} });
    assert.equal(c.status, 429);
    assert.match(c.json.erro, /dgclaw-seguranca-pedidos/);
  } finally { await w.fechar(); }
});

test('agendar valida a data (ISO, entre 1 minuto e 90 dias) e grava quando em UTC', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([achado()]));
    const u = '/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/agendar';
    for (const quando of [undefined, 'amanhã', '2026-11-01', '2026-10-31T12:00:30Z', '2026-10-30T03:00:00Z', '2027-06-01T03:00:00Z', 12345]) {
      assert.equal((await w.c.post(u, { json: { quando } })).status, 400, String(quando));
    }
    assert.deepEqual(pedidos(w), []);
    const ok = await w.c.post(u, { json: { quando: '2026-11-01T03:00:00-03:00' } });
    assert.equal(ok.status, 202);
    const p = lePedido(w, ok.json.pedido);
    assert.equal(p.tipo, 'agendar');
    assert.equal(p.quando, '2026-11-01T06:00:00.000Z');
  } finally { await w.fechar(); }
});

test('desfazer só vale para o que a ronda aplicou sozinha e deixou o caminho de volta', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([
      achado({ id: 'FEITO-1', nivel: 1, estado: 'aplicado-sozinho', aplicado: { em: '2026-10-31T10:00:00Z', acao_id: 'sysctl-x', antes: '1', depois: '0', desfazer: 'sysctl -w x=1' } }),
      achado({ id: 'FEITO-2', nivel: 1, estado: 'aplicado-sozinho', aplicado: { em: '2026-10-31T10:00:00Z', acao_id: 'sysctl-x', antes: '1', depois: '0', desfazer: null } }),
    ]));
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/FEITO-2/desfazer', { json: {} })).status, 409);
    assert.equal((await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/desfazer', { json: {} })).status, 404);
    const ok = await w.c.post('/api/v1/seguranca/ronda/FEITO-1/desfazer', { json: {} });
    assert.equal(ok.status, 202);
    assert.equal(lePedido(w, ok.json.pedido).tipo, 'desfazer');
  } finally { await w.fechar(); }
});

test('GET pedidos/<uuid>: pendente, feito (com dados do preparar), 400 e 404', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([achado()]));
    const a = await w.c.post('/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar', { json: {} });
    const uuid = a.json.pedido;
    assert.deepEqual((await w.c.get(`/api/v1/seguranca/pedidos/${uuid}`)).json, { ok: true, pendente: true });
    assert.equal((await w.c.get('/api/v1/seguranca/pedidos/nao-e-uuid')).status, 400);
    assert.equal((await w.c.get('/api/v1/seguranca/pedidos/00000000-0000-4000-8000-000000000000')).status, 404);
    const feitos = path.join(pastaSeg(w), 'pedidos', 'feitos');
    fs.mkdirSync(feitos, { recursive: true });
    fs.writeFileSync(path.join(feitos, `${uuid}.json`), JSON.stringify({
      ok: true, mensagem: 'Aplicado.\u0007', feito_em: '2026-10-31T12:00:05Z',
      dados: { acao: 'cortar', codigo: 'K7M2PQ', expira_em: '2026-10-31T12:02:00Z', valido_s: 120, coisa: 'x', plano: { comandos: ['systemctl stop caddy'], problemas: [], avisos: [] } },
    }));
    const r = await w.c.get(`/api/v1/seguranca/pedidos/${uuid}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.pendente, false);
    assert.equal(r.json.resultado.ok, true);
    assert.equal(r.json.resultado.mensagem, 'Aplicado.');
    assert.equal(r.json.dados.codigo, 'K7M2PQ');
    assert.equal(r.json.dados.coisa, undefined);
    assert.deepEqual(r.json.dados.plano.comandos, ['systemctl stop caddy']);
    fs.writeFileSync(path.join(feitos, `${uuid}.json`), '{quebrado');
    assert.equal((await w.c.get(`/api/v1/seguranca/pedidos/${uuid}`)).status, 500);
  } finally { await w.fechar(); }
});

// --- emergência ------------------------------------------------------------------------------------------

test('GET /emergencia: sem arquivo = desconhecido e indisponível com o comando; com arquivo, o estado e o plano', async () => {
  const w = await logado();
  try {
    let r = await w.c.get('/api/v1/seguranca/emergencia');
    assert.equal(r.status, 200);
    assert.equal(r.json.desconhecido, true);
    assert.equal(r.json.disponivel, false);
    assert.match(r.json.motivo, /sudo dgclaw emergencia estado/);
    gravaEmergencia(w);
    r = await w.c.get('/api/v1/seguranca/emergencia');
    assert.equal(r.json.disponivel, true);
    assert.equal(r.json.estado.cortado, false);
    assert.equal(r.json.plano.comandos.length, 2);
    assert.equal(r.json.desatualizado, false);
    gravaEmergencia(w, { atualizado_em: '2026-10-30T00:00:00Z' });
    assert.equal((await w.c.get('/api/v1/seguranca/emergencia')).json.desatualizado, true);
    gravaEmergencia(w, { disponivel: false, motivo: 'o corte trancaria todo mundo fora: ligue o Tailscale' });
    r = await w.c.get('/api/v1/seguranca/emergencia');
    assert.equal(r.json.disponivel, false);
    assert.match(r.json.motivo, /Tailscale/);
    fs.writeFileSync(path.join(pastaSeg(w), 'emergencia.json'), 'x');
    assert.equal((await w.c.get('/api/v1/seguranca/emergencia')).status, 500);
  } finally { await w.fechar(); }
});

test('preparar grava pedido emergencia-preparar; indisponível = 409 com o motivo', async () => {
  const w = await logado();
  try {
    gravaEmergencia(w);
    const r = await w.c.post('/api/v1/seguranca/emergencia/preparar', { json: {} });
    assert.equal(r.status, 202);
    assert.equal(lePedido(w, r.json.pedido).tipo, 'emergencia-preparar');
    for (const n of pedidos(w)) fs.unlinkSync(path.join(pastaSeg(w), 'pedidos', n));
    gravaEmergencia(w, { disponivel: false, motivo: 'sem Tailscale' });
    const b = await w.c.post('/api/v1/seguranca/emergencia/preparar', { json: {} });
    assert.equal(b.status, 409);
    assert.match(b.json.erro, /sem Tailscale/);
    assert.deepEqual(pedidos(w), []);
  } finally { await w.fechar(); }
});

test('cortar e religar exigem a frase exata e um código de 6 caracteres; sem isso, 400 e nada gravado', async () => {
  const w = await logado();
  try {
    gravaEmergencia(w);
    const u = '/api/v1/seguranca/emergencia/cortar';
    for (const corpo of [{}, { codigo: 'K7M2PQ' }, { codigo: 'K7M2PQ', frase: 'tirar-do-ar' }, { codigo: 'K7M2PQ', frase: 'TIRAR DO AR' }, { codigo: 'K7M2PQ', frase: 'RELIGAR' }, { frase: 'TIRAR-DO-AR' }, { codigo: 'curto', frase: 'TIRAR-DO-AR' }, { codigo: 'K7M2PQ$', frase: 'TIRAR-DO-AR' }]) {
      const r = await w.c.post(u, { json: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    assert.match((await w.c.post(u, { json: { codigo: 'K7M2PQ', frase: 'errada' } })).json.erro, /TIRAR-DO-AR/);
    assert.equal((await w.c.post('/api/v1/seguranca/emergencia/religar', { json: { codigo: 'K7M2PQ', frase: 'TIRAR-DO-AR' } })).status, 400);
    assert.deepEqual(pedidos(w), []);
    const ok = await w.c.post(u, { json: { codigo: 'k7m2pq', frase: 'TIRAR-DO-AR' } });
    assert.equal(ok.status, 202);
    const p = lePedido(w, ok.json.pedido);
    assert.equal(p.tipo, 'emergencia-cortar');
    assert.equal(p.codigo, 'K7M2PQ');
    assert.equal(p.id, null);
  } finally { await w.fechar(); }
});

test('religar só com o sistema cortado; cortar só com ele de pé e disponível', async () => {
  const w = await logado();
  try {
    gravaEmergencia(w);
    const corpoR = { codigo: 'K7M2PQ', frase: 'RELIGAR' };
    assert.equal((await w.c.post('/api/v1/seguranca/emergencia/religar', { json: corpoR })).status, 409);
    gravaEmergencia(w, { estado: { cortado: true, desde: '2026-10-31T11:00:00Z', quem: 'dono', confirmado: false, religar_automatico_agendado: true, religar_automatico_em: '2026-10-31T11:05:00Z', servicos: [] } });
    assert.equal((await w.c.post('/api/v1/seguranca/emergencia/cortar', { json: { codigo: 'K7M2PQ', frase: 'TIRAR-DO-AR' } })).status, 409);
    const ok = await w.c.post('/api/v1/seguranca/emergencia/religar', { json: corpoR });
    assert.equal(ok.status, 202);
    assert.equal(lePedido(w, ok.json.pedido).tipo, 'emergencia-religar');
    gravaEmergencia(w, { disponivel: false, motivo: 'sem Tailscale' });
    const r = await w.c.post('/api/v1/seguranca/emergencia/cortar', { json: { codigo: 'K7M2PQ', frase: 'TIRAR-DO-AR' } });
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /sem Tailscale/);
  } finally { await w.fechar(); }
});

// --- acesso ----------------------------------------------------------------------------------------------

test('agente pela caixa não acessa nenhuma rota da ronda (403) e a rota não está liberada', async () => {
  const w = await logado();
  try {
    gravaRonda(w, ronda([achado()]));
    gravaEmergencia(w);
    assert.equal(w.web.caixa.rotaPermitida('/api/v1/seguranca/ronda'), false);
    assert.equal(w.web.caixa.rotaPermitida('/api/v1/seguranca/emergencia/cortar'), false);
    const cab = { 'x-dgclaw-caixa': w.web.caixa.segredo, 'x-dgclaw-agente': 'luna' };
    const c = cliente(w.porta);
    for (const [m, u] of [['GET', '/api/v1/seguranca/ronda'], ['POST', '/api/v1/seguranca/ronda/UBUNTU-CVE-2026-98432/aplicar'], ['GET', '/api/v1/seguranca/emergencia'],
      ['POST', '/api/v1/seguranca/emergencia/cortar'], ['POST', '/api/v1/seguranca/emergencia/preparar'], ['GET', '/api/v1/seguranca/pedidos/00000000-0000-4000-8000-000000000000'], ['GET', '/api/v1/seguranca/ronda/docs.md']]) {
      const r = await c.pedir(m, u, { headers: cab, json: m === 'POST' ? { codigo: 'K7M2PQ', frase: 'TIRAR-DO-AR' } : undefined });
      assert.equal(r.status, 403, `${m} ${u} -> ${r.texto}`);
    }
    assert.deepEqual(pedidos(w), []);
  } finally { await w.fechar(); }
});

test('sem login: 401 em tudo', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    for (const u of ['/api/v1/seguranca/ronda', '/api/v1/seguranca/emergencia', '/api/v1/seguranca/pedidos/00000000-0000-4000-8000-000000000000']) {
      assert.equal((await w.c.get(u)).status, 401, u);
    }
  } finally { await w.fechar(); }
});

test('docs.md: todas as rotas, em português, sem travessão no meio de frase', async () => {
  const w = await logado();
  try {
    const r = await w.c.get('/api/v1/seguranca/ronda/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/markdown/);
    for (const rota of ['GET /api/v1/seguranca/ronda', 'POST /api/v1/seguranca/ronda/<id>/aplicar', 'POST /api/v1/seguranca/ronda/<id>/agendar',
      'POST /api/v1/seguranca/ronda/<id>/desfazer', 'GET /api/v1/seguranca/pedidos/<pedido>', 'GET /api/v1/seguranca/emergencia',
      'POST /api/v1/seguranca/emergencia/preparar', 'POST /api/v1/seguranca/emergencia/cortar', 'POST /api/v1/seguranca/emergencia/religar']) {
      assert.ok(r.texto.includes(rota), rota);
    }
    assert.ok(!/[—–]/.test(r.texto));
  } finally { await w.fechar(); }
});

test('a tela /seguranca exige login e serve o HTML', async () => {
  const w = await logado();
  try {
    fs.writeFileSync(path.join(w.publico, 'seguranca.html'), '<html>seguranca de teste</html>');
    const sem = cliente(w.porta);
    assert.notEqual((await sem.get('/seguranca', { origin: false })).status, 200);
    const r = await w.c.get('/seguranca');
    assert.equal(r.status, 200);
    assert.match(r.texto, /seguranca de teste/);
  } finally { await w.fechar(); }
});
