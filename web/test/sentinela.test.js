'use strict';
// Sentinela do servidor, lado do painel: leitura do estado, push só quando aviso.seq aumenta, rotas com sessão,
// teste de avisos por execFile sem shell, faixa e cartão. Contrato em web/docs/SENTINELA.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarSentinela } = require('../lib/sentinela');
const F = require('../public/sentinela-faixa');
const S = require('../public/saude-servidor');
const { subirWeb, pastaTemp, capturaLog } = require('./ajuda');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const AGENTES = [
  { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://x', agente_id: 'admin' },
  { slug: 'luna', nome: 'Luna', tipo: 'agente', runner: 'http://x', agente_id: 'luna' },
];

function estado(extra) {
  return Object.assign({
    versao: 1, atualizado_em: new Date().toISOString(), servidor: 'meudominio.com.br', nivel_geral: 'critico',
    disco: [{ ponto: '/', usado_pct: 93.1, livre_gb: 2.8, total_gb: 40.0, inodes_pct: 12.0, nivel: 'critico' }],
    ram: { usado_pct: 61.0, disponivel_mb: 3100, total_mb: 7950, swap_pct: 4.0, nivel: 'ok' },
    reserva: { ligada: true, existe: false, tamanho_gb: 2.0, liberada_em: '2026-11-10T03:11:58-03:00' },
    agentes: [{ slug: 'luna', nome: 'Luna', estado: 'ok', desde: null, motivo: '' }],
    servicos: [{ nome: 'dgclaw-web', ativo: true }],
    maiores_pastas: [{ caminho: '/var/lib/containers', gb: 9.8 }],
    ultimas_acoes: [{ em: '2026-11-10T03:00:00-03:00', tipo: 'faxina', descricao: 'journal: liberou 820 MB', liberou_mb: 820 }],
    canais: { telegram: true, email: false, pulso: true, admin: true, ultimo_envio_ok: '2026-11-10T03:12:00-03:00', ultima_falha: null },
    aviso: { seq: 17, nivel: 'critico', titulo: '🔴 CRÍTICO · disco em 93%', corpo: 'Disco em 93%.\nOs agentes podem parar.', em: '2026-11-10T03:12:04-03:00' },
  }, extra || {});
}
const gravaEstado = (dados, e) => {
  const dir = path.join(dados, 'sentinela');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'estado.json'), typeof e === 'string' ? e : JSON.stringify(e));
};
const novaSentinela = (extra) => {
  const dados = pastaTemp('sent');
  const cap = capturaLog();
  const enviados = [];
  const push = { enviar: async (a) => { enviados.push(a); return { inscricoes: 1, ok: 1, removidas: 0, falhas: [] }; } };
  const s = criarSentinela(Object.assign({ dataDir: dados, log: cap.log, push }, extra || {}));
  return { s, dados, cap, enviados, push };
};

test('arquivo ausente: instalado falso com explicação, nunca erro mudo', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    const r = await w.c.get('/api/v1/sentinela');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.instalado, false);
    assert.match(r.json.motivo, /ainda não rodou/);
    assert.match(r.json.motivo, /dgclaw-sentinela\.timer/);
  } finally { await w.fechar(); }
});

test('arquivo ilegível: 503 com o caminho e o que fazer, e o erro vai para o log', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    gravaEstado(w.dados, '{isto não é json');
    const r = await w.c.get('/api/v1/sentinela');
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.ok(r.json.erro.includes(path.join(w.dados, 'sentinela', 'estado.json')));
    assert.match(r.json.erro, /sudo dgclaw sentinela rodar/);
    assert.match(w.log.texto(), /\[erro\] Sentinela: Não consegui ler/);
  } finally { await w.fechar(); }
});

test('estado válido: sai só o contrato, medida ausente continua null e nunca vira 0', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    gravaEstado(w.dados, estado({
      segredo_que_nao_existe: 'tok', ram: { usado_pct: null, total_mb: 'oito', nivel: 'ok' },
      disco: [{ ponto: '/', usado_pct: 50, nivel: 'ok' }],
    }));
    const r = await w.c.get('/api/v1/sentinela');
    assert.equal(r.status, 200);
    assert.equal(r.json.instalado, true);
    assert.equal(r.json.nivel_geral, 'critico');
    assert.equal(r.json.ram.usado_pct, null);
    assert.equal(r.json.ram.total_mb, null);
    assert.equal(r.json.disco[0].livre_gb, null);
    assert.equal(r.json.parada, false);
    assert.equal('segredo_que_nao_existe' in r.json, false);
  } finally { await w.fechar(); }
});

test('estado velho (mais de 5 minutos) vem marcado como parada', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    gravaEstado(w.dados, estado({ atualizado_em: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
    const r = await w.c.get('/api/v1/sentinela');
    assert.equal(r.json.parada, true);
    assert.ok(r.json.idade_s >= 1200);
  } finally { await w.fechar(); }
});

test('cache por mtime: só relê quando o arquivo mudou', () => {
  const { s, dados } = novaSentinela();
  gravaEstado(dados, estado({ nivel_geral: 'ok' }));
  const arq = path.join(dados, 'sentinela', 'estado.json');
  const a = s.lerEstado();
  assert.equal(a.estado.nivel_geral, 'ok');
  assert.equal(s.lerEstado(), a, 'sem mudança devolve o mesmo objeto, sem reler');
  fs.writeFileSync(arq, JSON.stringify(estado({ nivel_geral: 'serio' })));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(arq, t, t);
  assert.equal(s.lerEstado().estado.nivel_geral, 'serio');
});

test('push: a primeira leitura só guarda; manda só quando aviso.seq aumenta; reiniciar não repete', async () => {
  const { s, dados, enviados, push, cap } = novaSentinela();
  const arq = path.join(dados, 'sentinela', 'estado.json');
  const grava = (seq, extra) => {
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, JSON.stringify(estado({ aviso: Object.assign({ seq, nivel: 'critico', titulo: 'T', corpo: 'C', em: null }, extra || {}) })));
    const t = new Date(Date.now() + seq * 1000);
    fs.utimesSync(arq, t, t);
  };
  grava(5);
  await s.verificar();
  assert.equal(enviados.length, 0, 'primeira leitura não manda');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dados, 'sentinela', 'push.json'), 'utf8')).seq, 5);
  await s.verificar();
  assert.equal(enviados.length, 0, 'mesmo seq não manda');

  const longo = 'palavra '.repeat(80);
  grava(6, { corpo: longo });
  await s.verificar();
  assert.equal(enviados.length, 1);
  const a = enviados[0];
  assert.equal(a.titulo, 'T');
  assert.equal(a.tag, 'sentinela');
  assert.equal(a.url, '/seguranca#saude-servidor');
  assert.equal(a.exigir_interacao, true);
  assert.ok(a.corpo.length <= 300, `corpo com ${a.corpo.length} caracteres`);
  await s.verificar();
  assert.equal(enviados.length, 1, 'não repete o mesmo seq');

  grava(7, { nivel: 'serio' });
  await s.verificar();
  assert.equal(enviados.length, 2);
  assert.equal(enviados[1].exigir_interacao, false, 'só o crítico exige toque');

  grava(2);   // a sentinela recomeçou a contagem: só guarda
  await s.verificar();
  assert.equal(enviados.length, 2);

  const s2 = criarSentinela({ dataDir: dados, log: cap.log, push });
  await s2.verificar();
  assert.equal(enviados.length, 2, 'um Web reiniciado não repete o aviso');
  grava(3);
  await s2.verificar();
  assert.equal(enviados.length, 3, 'e continua mandando os novos');
});

test('push que falha vai para o log e não derruba a verificação nem repete no tick seguinte', async () => {
  const { s, dados, cap, enviados } = novaSentinela({ push: { enviar: async () => { throw new TypeError('aviso inválido de teste'); } } });
  const arq = path.join(dados, 'sentinela', 'estado.json');
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, JSON.stringify(estado({ aviso: { seq: 1, nivel: 'critico', titulo: 'T', corpo: 'C' } })));
  await s.verificar();
  fs.writeFileSync(arq, JSON.stringify(estado({ aviso: { seq: 2, nivel: 'critico', titulo: 'T', corpo: 'C' } })));
  fs.utimesSync(arq, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await s.verificar();
  assert.match(cap.texto(), /não consegui mandar o aviso 2 ao celular \(aviso inválido de teste\)/);
  assert.equal(enviados.length, 0);
});

test('rotas exigem sessão: 401 sem login (inclui docs.md); escrita sem Origin é recusada', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    for (const [m, p] of [['GET', '/api/v1/sentinela'], ['POST', '/api/v1/sentinela/testar'], ['GET', '/api/v1/sentinela/docs.md']]) {
      const r = await w.c.pedir(m, p, m === 'POST' ? { json: {} } : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    await w.login();
    const r = await w.c.pedir('POST', '/api/v1/sentinela/testar', { json: {}, origin: 'https://outro.exemplo' });
    assert.equal(r.status, 403);
    assert.match(r.json.erro, /origem/);
  } finally { await w.fechar(); }
});

test('agente pela caixa recebe 403: a rota é só do dono', async () => {
  const { s } = novaSentinela();
  const res = { writeHead(st) { this.status = st; }, end(t) { this.corpo = t; } };
  const tratou = await s.rotas({ method: 'GET' }, res, new URL('http://x/api/v1/sentinela'), { via: 'caixa', agente: 'luna' });
  assert.equal(tratou, true);
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.corpo).erro, /só do dono/);
});

test('rota desconhecida e método errado explicam o que usar', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    const a = await w.c.get('/api/v1/sentinela/nada');
    assert.equal(a.status, 404);
    assert.match(a.json.erro, /docs\.md/);
    const b = await w.c.post('/api/v1/sentinela', { json: {} });
    assert.equal(b.status, 405);
    assert.match(b.json.erro, /Use GET/);
  } finally { await w.fechar(); }
});

test('docs.md é servido com sessão e não tem travessão', async () => {
  const w = await subirWeb({ agentes: AGENTES });
  try {
    await w.login();
    const r = await w.c.get('/api/v1/sentinela/docs.md');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /markdown/);
    assert.match(r.texto, /POST \/api\/v1\/sentinela\/testar/);
    assert.doesNotMatch(r.texto, /[—–]/);
  } finally { await w.fechar(); }
});

test('testar: execFile sem shell, argumentos em lista, timeout de 60 s, python3 -I', async () => {
  const appDir = pastaTemp('app');
  const script = path.join(appDir, 'seguranca', 'sentinela', 'sentinela.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '# falso');
  const chamadas = [];
  const fake = (cmd, args, opts, cb) => { chamadas.push({ cmd, args, opts }); cb(null, JSON.stringify({ ok: true, canais: { telegram: { configurado: true, ok: true, motivo: '' } } }), ''); };
  const w = await subirWeb({ agentes: AGENTES, opcoesServidor: { appDir, execFileSentinela: fake } });
  try {
    await w.login();
    const r = await w.c.post('/api/v1/sentinela/testar', { json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.resultado.canais.telegram.ok, true);
    assert.equal(chamadas.length, 1);
    const { cmd, args, opts } = chamadas[0];
    assert.equal(cmd, 'python3');
    assert.deepEqual(args, ['-I', script, 'testar-avisos', '--json']);
    assert.equal(opts.timeout, 60000);
    assert.ok(!opts.shell, 'nunca com shell');
  } finally { await w.fechar(); }
  const fonte = fs.readFileSync(path.join(__dirname, '../lib/sentinela.js'), 'utf8');
  assert.doesNotMatch(fonte, /\bexec\(|execSync|shell:\s*true|\bspawn\(/);
});

test('testar de verdade com um motor falso em python: o resultado volta e o código de saída é informado', async (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('sem python3 nesta máquina'); return; }
  const appDir = pastaTemp('app2');
  const script = path.join(appDir, 'seguranca', 'sentinela', 'sentinela.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'import json, sys\nprint(json.dumps({"args": sys.argv[1:], "canais": {"telegram": {"ok": False, "motivo": "token recusado"}}}))\nsys.exit(1)\n');
  const w = await subirWeb({ agentes: AGENTES, opcoesServidor: { appDir } });
  try {
    await w.login();
    const r = await w.c.post('/api/v1/sentinela/testar', { json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.codigo_saida, 1);
    assert.deepEqual(r.json.resultado.args, ['testar-avisos', '--json']);
    assert.equal(r.json.resultado.canais.telegram.motivo, 'token recusado');
  } finally { await w.fechar(); }
});

test('testar: motor ausente, saída ilegível e timeout viram erro em português com o que fazer', async () => {
  const sem = novaSentinela({ appDir: pastaTemp('vazio') });
  const resSem = { writeHead(st) { this.status = st; }, end(t) { this.corpo = t; } };
  await sem.s.rotas({ method: 'POST' }, resSem, new URL('http://x/api/v1/sentinela/testar'), { usuario: 'dono' });
  assert.equal(resSem.status, 503);
  assert.match(JSON.parse(resSem.corpo).erro, /dgclaw atualizar/);

  const appDir = pastaTemp('app3');
  const script = path.join(appDir, 'seguranca', 'sentinela', 'sentinela.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '# falso');
  const roda = async (fake) => {
    const { s } = novaSentinela({ appDir, execFile: fake });
    const res = { writeHead(st) { this.status = st; }, end(t) { this.corpo = t; } };
    await s.rotas({ method: 'POST' }, res, new URL('http://x/api/v1/sentinela/testar'), { usuario: 'dono' });
    return { status: res.status, erro: JSON.parse(res.corpo).erro };
  };
  const ruim = await roda((c, a, o, cb) => { const e = new Error('x'); e.code = 2; cb(e, 'lixo', 'Traceback: deu ruim'); });
  assert.equal(ruim.status, 502);
  assert.match(ruim.erro, /Traceback: deu ruim/);
  assert.match(ruim.erro, /sudo dgclaw sentinela testar-avisos/);
  const lento = await roda((c, a, o, cb) => { const e = new Error('t'); e.killed = true; e.signal = 'SIGTERM'; cb(e, '', ''); });
  assert.equal(lento.status, 504);
  assert.match(lento.erro, /60 segundos/);
});

test('faixa: só aparece com nível sério, crítico ou agente fora do ar, com a frase certa', () => {
  assert.equal(F.situacao(null), null);
  assert.equal(F.situacao({ instalado: false }), null);
  assert.equal(F.situacao(estado({ nivel_geral: 'ok' }) && { instalado: true, ...estado({ nivel_geral: 'ok' }) }), null);
  assert.equal(F.situacao({ instalado: true, ...estado({ nivel_geral: 'aviso' }) }), null);
  const crit = F.situacao({ instalado: true, ...estado() });
  assert.equal(crit.nivel, 'critico');
  assert.equal(crit.texto, 'Disco do servidor em 93%: os agentes podem parar.');
  const serio = F.situacao({ instalado: true, ...estado({ nivel_geral: 'serio', disco: [{ ponto: '/', usado_pct: 86, nivel: 'serio' }] }) });
  assert.equal(serio.nivel, 'serio');
  const ag = F.situacao({ instalado: true, ...estado({ nivel_geral: 'ok', agentes: [{ slug: 'luna', nome: 'Luna', estado: 'caido' }] }) });
  assert.equal(ag.nivel, 'critico');
  assert.match(ag.texto, /agente Luna está fora do ar/);
  const zap = F.situacao({ instalado: true, ...estado({ nivel_geral: 'critico', agentes: [{ slug: 'luna', nome: 'Luna', estado: 'canal_caido' }] }) });
  assert.match(zap.texto, /WhatsApp do agente Luna parou/);
  const ram = F.situacao({ instalado: true, ...estado({ nivel_geral: 'serio', disco: [], ram: { usado_pct: 94, nivel: 'serio' } }) });
  assert.match(ram.texto, /Memória do servidor em 94%/);
});

test('faixa: crítica não tem botão de recolher, a séria tem; texto vindo do estado sai escapado', () => {
  assert.doesNotMatch(F.faixaHtml({ nivel: 'critico', texto: 'x' }), /data-sf="recolher"/);
  assert.match(F.faixaHtml({ nivel: 'serio', texto: 'x' }), /data-sf="recolher"/);
  const h = F.faixaHtml({ nivel: 'critico', texto: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /href="\/seguranca#saude-servidor"/);
  assert.match(F.faixaHtml({ nivel: 'critico', texto: 'x' }, true), /href="#saude-servidor"/);
  const nome = F.situacao({ instalado: true, ...estado({ agentes: [{ nome: '<b>x</b>', estado: 'caido' }] }) });
  assert.doesNotMatch(F.faixaHtml(nome), /<b>x/);
});

test('cartão: sentinela que não rodou é explicada na tela; null aparece como "não medido", nunca 0', () => {
  const vazio = S.corpoHtml({ instalado: false, motivo: 'ainda sem arquivo' });
  assert.match(vazio, /A sentinela ainda não rodou/);
  assert.match(vazio, /dgclaw-sentinela\.timer/);
  assert.match(S.corpoHtml(null), /ainda não rodou/);
  const h = S.corpoHtml({ instalado: true, nivel_geral: 'ok', atualizado_em: new Date().toISOString(), disco: [{ ponto: '/', usado_pct: null, livre_gb: null, total_gb: null, inodes_pct: null, nivel: null }], ram: { usado_pct: null, disponivel_mb: null, total_mb: null, swap_pct: null, nivel: null }, reserva: {}, agentes: [], servicos: [], maiores_pastas: [], ultimas_acoes: [], canais: {} }, Date.now());
  assert.match(h, /uso não medido/);
  assert.match(h, /aria-label="Disco \/: não medido"/);
  assert.doesNotMatch(h, /0%/);
  assert.doesNotMatch(h, /style="width:0%"/);
  assert.match(h, /Sem informação da reserva/);
});

test('cartão: barras com a cor do nível, canais "ligado" ou "não configurado", agente fora com o motivo', () => {
  const e = { instalado: true, ...estado({ agentes: [{ slug: 'luna', nome: 'Luna', estado: 'caido', motivo: 'container parado' }] }), parada: false };
  const h = S.corpoHtml(e, Date.now());
  assert.match(h, /sd-barra sd-n-critico/);
  assert.match(h, /style="width:93%"/);
  assert.match(h, /sd-barra sd-n-ok/);
  assert.match(h, /Fora do ar<\/span> <b>Luna/);
  assert.match(h, /container parado/);
  assert.match(h, /<b>Telegram<\/b>/);
  assert.match(h, /Não configurado: peça ao Admin para configurar/);
  assert.match(h, /Liberada/);
  assert.match(h, /Isso compra tempo, não resolve/);
  assert.match(h, /id="sdDisco"/);
  assert.match(S.corpoHtml({ ...e, parada: true }, Date.now()), /não atualiza há mais de 5 minutos/);
});

test('cartão: texto do estado sai escapado e a largura da barra é só número', () => {
  const h = S.corpoHtml({ instalado: true, ...estado({ disco: [{ ponto: '<script>x</script>', usado_pct: 'abc', nivel: '" onload="x' }], maiores_pastas: [{ caminho: '<img src=x>', gb: 1 }] }) }, Date.now());
  assert.doesNotMatch(h, /<script>x|<img src=x>|onload="x/);
  assert.doesNotMatch(h, /width:abc/);
});

test('resultado do teste: canais que chegaram, falharam e não configurados; formato estranho aparece cru', () => {
  const h = S.resultadoTesteHtml({ resultado: { ok: true, canais: {
    telegram: { configurado: true, ok: true, motivo: '' }, email: { configurado: true, ok: false, motivo: 'senha recusada' },
    pulso: { configurado: false, ok: null, motivo: '' }, admin: { configurado: true, ok: true, motivo: '' } } } });
  assert.match(h, /Chegou<\/span> <b>Telegram/);
  assert.match(h, /Não chegou<\/span> <b>E-mail/);
  assert.match(h, /senha recusada/);
  assert.match(h, /Não configurado: peça ao Admin para ligar/);
  const nada = S.resultadoTesteHtml({ resultado: { ok: false, canais: { telegram: { configurado: false, ok: null }, email: { configurado: false, ok: null } } } });
  assert.match(nada, /Nenhum canal está configurado/);
  const falhou = S.resultadoTesteHtml({ resultado: { ok: false, canais: { telegram: { configurado: true, ok: false, motivo: 'token recusado' } } } });
  assert.match(falhou, /Nenhum aviso chegou/);
  assert.match(S.resultadoTesteHtml({ resultado: { qualquer: 'coisa' } }), /Resposta da sentinela/);
});

test('faixa laranja quando a vigia parou (parada) e nenhuma faixa quando ainda não rodou (instalado falso)', () => {
  const p = F.situacao({ instalado: true, parada: true, idade_s: 1260, ...estado({ nivel_geral: 'ok' }) });
  assert.equal(p.nivel, 'serio');
  assert.equal(p.texto, 'A vigia do servidor parou de atualizar há 21 min: os alarmes de disco e memória estão desligados. Peça ao Admin para conferir.');
  assert.match(F.faixaHtml(p), /data-sf="recolher"/, 'recolhível por 1 h');
  assert.equal(F.situacao({ instalado: false, motivo: 'x' }), null);
  assert.equal(F.situacao({ instalado: true, parada: false, idade_s: 30, ...estado({ nivel_geral: 'ok' }) }), null);
  const crit = F.situacao({ instalado: true, parada: true, idade_s: 1260, ...estado() });
  assert.equal(crit.nivel, 'critico', 'um alarme real, mesmo velho, tem prioridade');
});

test('tutorial: cada passo responde o que é, como é calculado e por que está aqui, e os alvos existem na tela', () => {
  assert.ok(S.PASSOS.length >= 8);
  const html = pub('seguranca.html') + S.corpoHtml({ instalado: true, ...estado() }, Date.now());
  for (const p of S.PASSOS) {
    for (const k of ['titulo', 'oque', 'como', 'porque']) assert.ok(p[k] && p[k].length > (k === 'titulo' ? 3 : 30), `${p.alvo} ${k}`);
    assert.ok(html.includes(`id="${p.alvo.slice(1)}"`), `alvo ${p.alvo} existe`);
  }
  assert.ok(S.passosDoCartao(null).length === S.PASSOS.length);
  assert.ok(F.PASSO.oque && F.PASSO.como && F.PASSO.porque);
});

test('ligações: telas, casca e service worker; css sem rolagem horizontal e alvos de 32 px', () => {
  for (const t of ['conversa', 'conectar', 'colaboradores', 'anonimizar', 'seguranca']) assert.equal(pub(t + '.html').split('/sentinela-faixa.js').length - 1, 1, t);
  assert.match(pub('casca.js'), /s\.src = '\/sentinela-faixa\.js'/);
  const sw = pub('sw.js');
  for (const u of ['/sentinela-faixa.js', '/sentinela-faixa.css', '/saude-servidor.js', '/saude-servidor.css']) assert.ok(sw.includes(`'${u}'`), u);
  const h = pub('seguranca.html');
  assert.match(h, /id="saude-servidor"/);
  assert.match(h, /data-sd="testar">Testar avisos</);
  assert.ok(h.indexOf('/saude-servidor.js') < h.indexOf('/seguranca.js'));
  const css = pub('sentinela-faixa.css');
  assert.match(css, /flex-wrap:wrap/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /\.sf-btn\{min-height:32px/);
  assert.match(css, /\.sf-ajuda\{width:32px;height:32px/);
  assert.match(pub('saude-servidor.css'), /overflow-wrap:anywhere/);
});

test('texto visível ao dono não tem travessão nem segredo', () => {
  for (const n of ['sentinela-faixa.js', 'sentinela-faixa.css', 'saude-servidor.js', 'saude-servidor.css', '../lib/sentinela.js', '../docs/SENTINELA.md']) {
    assert.doesNotMatch(pub(n), /[—–]/, n);
  }
  assert.doesNotMatch(JSON.stringify(S.PASSOS), /[—–]/);
  assert.doesNotMatch(JSON.stringify(F.PASSO), /[—–]/);
});
