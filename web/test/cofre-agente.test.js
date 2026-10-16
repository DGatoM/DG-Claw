'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { criarCofreAgente } = require('../lib/cofre-agente');
const { capturaLog } = require('./ajuda');

const VALOR = 'sk-teste-valor-secreto-so-para-teste-12345678';
const VALOR2 = 'sk-teste-outro-valor-secreto-87654321';
const modo = (p) => fs.statSync(p).mode & 0o777;

/** Casa falsa no layout da v1: casa 711, cofre 700, config 755; dados do Web noutra pasta 700. */
function cenario(extra) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-agente-'));
  const casa = path.join(raiz, 'casa-ana');
  fs.mkdirSync(path.join(casa, 'cofre'), { recursive: true });
  fs.mkdirSync(path.join(casa, 'config'));
  fs.chmodSync(casa, 0o711); fs.chmodSync(path.join(casa, 'cofre'), 0o700); fs.chmodSync(path.join(casa, 'config'), 0o755);
  const dataDir = path.join(raiz, 'dados');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const cofreEnv = path.join(casa, 'cofre', 'cofre.env');
  const agente = { slug: 'ana', nome: 'Ana', cofre_arquivo: cofreEnv, container: 'dgclaw-ana' };
  const cap = capturaLog();
  const reinicios = [];
  const o = Object.assign({ reiniciar: async (a) => { reinicios.push(a.slug); } }, extra || {});
  const cofre = criarCofreAgente({ config: { dataDir }, log: cap.log, reiniciar: o.reiniciar });
  return { raiz, casa, dataDir, cofreEnv, agente, cap, cofre, reinicios, nomes: path.join(casa, 'config', 'cofre-nomes'), meta: path.join(dataDir, 'cofre', 'ana.json'), limpa: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

test('guardar: grava no cofre.env, lista os nomes, anota metadados fora da casa e não vaza o valor', () => {
  const s = cenario();
  try {
    const r = s.cofre.guardar(s.agente, { envName: 'openai_api_key', valor: VALOR, provedor: 'openai', quem: 'Paulo', origem: 'tela' });
    assert.equal(r.ok, true); assert.equal(r.envName, 'OPENAI_API_KEY'); assert.equal(r.ultimos4, VALOR.slice(-4)); assert.equal(r.trocada, false);
    assert.ok(r.aviso);
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `OPENAI_API_KEY='${VALOR}'\n`);
    assert.equal(modo(s.cofreEnv), 0o600);
    assert.equal(fs.readFileSync(s.nomes, 'utf8'), 'OPENAI_API_KEY=\n');
    assert.equal(modo(s.nomes), 0o644);
    assert.equal(modo(s.meta), 0o600);
    assert.equal(modo(path.dirname(s.meta)), 0o700);
    assert.ok(!s.meta.startsWith(s.casa), 'metadados ficam fora da casa do agente');
    const meta = JSON.parse(fs.readFileSync(s.meta, 'utf8'));
    assert.equal(meta.chaves[0].cadastradaPor, 'Paulo'); assert.equal(meta.chaves[0].origem, 'tela'); assert.equal(meta.chaves[0].provedor, 'openai');
    assert.ok(!JSON.stringify(r).includes(VALOR));
    assert.ok(!fs.readFileSync(s.meta, 'utf8').includes(VALOR));
    assert.ok(!fs.readFileSync(s.nomes, 'utf8').includes(VALOR));
    assert.ok(!s.cap.texto().includes(VALOR), 'valor fora do log');
    assert.deepEqual(fs.readdirSync(s.dataDir + '/cofre'), ['ana.json']);
  } finally { s.limpa(); }
});

test('trocar e revogar preservam as outras linhas, na ordem; revogar data e não apaga o registro', () => {
  const s = cenario();
  try {
    fs.writeFileSync(s.cofreEnv, `# comentario\nexport GEMINI_API_KEY="gemini-antiga-12345678"\nOPENAI_API_KEY=${VALOR}\nXAI_API_KEY='xai-chave-12345678'\n`, { mode: 0o600 });
    const t = s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR2, provedor: 'openai', quem: 'Paulo' });
    assert.equal(t.trocada, true); assert.match(t.aviso, /trocada/);
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `# comentario\nGEMINI_API_KEY='gemini-antiga-12345678'\nOPENAI_API_KEY='${VALOR2}'\nXAI_API_KEY='xai-chave-12345678'\n`);
    assert.equal(fs.readFileSync(s.nomes, 'utf8'), 'GEMINI_API_KEY=\nOPENAI_API_KEY=\nXAI_API_KEY=\n');
    const rv = s.cofre.revogar(s.agente, 'openai_api_key', 'Paulo');
    assert.equal(rv.ok, true); assert.ok(rv.aviso);
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `# comentario\nGEMINI_API_KEY='gemini-antiga-12345678'\nXAI_API_KEY='xai-chave-12345678'\n`);
    assert.equal(fs.readFileSync(s.nomes, 'utf8'), 'GEMINI_API_KEY=\nXAI_API_KEY=\n');
    const meta = JSON.parse(fs.readFileSync(s.meta, 'utf8')).chaves.find((m) => m.envName === 'OPENAI_API_KEY');
    assert.ok(meta.revogadaEm); assert.equal(meta.revogadaPor, 'Paulo');
    assert.equal(s.cofre.revogar(s.agente, 'OPENAI_API_KEY', 'x').status, 409);
    assert.equal(s.cofre.revogar(s.agente, 'NAO_EXISTE_KEY', 'x').status, 404);
    assert.ok(!s.cap.texto().includes(VALOR) && !s.cap.texto().includes(VALOR2) && !s.cap.texto().includes('gemini-antiga'));
  } finally { s.limpa(); }
});

test('estado: formato do painel, chave sem metadado vira "desconhecido" com últimos 4, revogada aparece como histórico', () => {
  const s = cenario();
  try {
    fs.writeFileSync(s.cofreEnv, "LEGADA_API_KEY='legada-chave-abcd'\n", { mode: 0o600 });
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai', quem: 'Paulo' });
    s.cofre.revogar(s.agente, 'OPENAI_API_KEY', 'Paulo');
    const e = s.cofre.estado(Object.assign({ dono: 'Paulo' }, s.agente));
    assert.deepEqual(e.agente, { slug: 'ana', nome: 'Ana', dono: 'Paulo' });
    assert.equal(s.cofre.estado(s.agente).agente.dono, 'Dono');
    const leg = e.chaves.find((c) => c.envName === 'LEGADA_API_KEY');
    assert.equal(leg.cadastradaPor, 'desconhecido'); assert.equal(leg.ultimos4, 'abcd'); assert.equal(leg.revogadaEm, null);
    const rev = e.chaves.find((c) => c.envName === 'OPENAI_API_KEY');
    assert.ok(rev.revogadaEm);
    assert.equal(e.guarda.motor, 'host'); assert.equal(e.guarda.emMemoria, false);
    assert.match(e.guarda.motorExplicacao, /fora da pasta do agente/);
    assert.deepEqual(e.aplicar, { pode: true, unidade: 'dgclaw-runner', forma: 'web' });
    assert.equal(e.arquivoDeAmbiente, '/run/dgclaw/cofre/cofre.env');
    assert.ok(Array.isArray(e.provedores) && e.provedores.length > 3);
    assert.ok(!JSON.stringify(e).includes('legada-chave-abcd'));
    const l = s.cofre.listar(s.agente);
    assert.deepEqual(Object.keys(l.chaves[0]).sort(), ['cadastradaEm', 'envName', 'provedor', 'revogadaEm', 'ultimos4']);
  } finally { s.limpa(); }
});

test('recusas: nome proibido, valor com aspa, vault:, curto; nada gravado e valor fora da resposta', () => {
  const s = cenario();
  try {
    for (const [envName, valor] of [['NODE_OPTIONS', VALOR], ['LD_PRELOAD', VALOR], ['MINHA_COISA', VALOR], ['OPENAI_API_KEY', "tem'aspa-simples-1234"], ['OPENAI_API_KEY', 'vault:openai-api-key'], ['OPENAI_API_KEY', 'curta'], ['OPENAI_API_KEY', ''], ['', VALOR]]) {
      const r = s.cofre.guardar(s.agente, { envName, valor });
      assert.ok(r.erro && r.status >= 400, `${envName} deveria ser recusado`);
      if (valor.length >= 8) assert.ok(!JSON.stringify(r).includes(valor));
    }
    assert.equal(fs.existsSync(s.cofreEnv), false);
    assert.equal(fs.existsSync(s.meta), false);
    assert.equal(s.cofre.guardar(s.agente, { envName: 'CLAUDE_CODE_OAUTH_TOKEN', valor: 'tok-claude-oauth-12345678' }).ok, true);
  } finally { s.limpa(); }
});

test('agente sem cofre_arquivo: 409 em tudo', async () => {
  const s = cenario();
  try {
    const a = { slug: 'velho', nome: 'Velho' };
    for (const r of [s.cofre.estado(a), s.cofre.guardar(a, { envName: 'OPENAI_API_KEY', valor: VALOR }), s.cofre.revogar(a, 'OPENAI_API_KEY', 'x'), s.cofre.listar(a), await s.cofre.aplicar(a)]) {
      assert.equal(r.status, 409); assert.match(r.erro, /layout da v1/);
    }
    assert.deepEqual(s.reinicios, []);
  } finally { s.limpa(); }
});

test('aplicar: chama o reiniciar injetado; erros viram mensagem clara em português', async () => {
  const s = cenario();
  try {
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR });
    const ok = await s.cofre.aplicar(s.agente);
    assert.equal(ok.ok, true); assert.equal(ok.unidade, 'dgclaw-runner'); assert.equal(ok.chaves, 1); assert.match(ok.feito, /reiniciado/);
    assert.deepEqual(s.reinicios, ['ana']);
  } finally { s.limpa(); }
  for (const [erro, status, rx] of [
    [Object.assign(new Error('x'), { code: 'ENOENT' }), 500, /podman/],
    [Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), 504, /60 s/],
    [Object.assign(new Error('x'), { stderr: 'Error: no container with name or ID "dgclaw-ana" found' }), 409, /não está rodando/],
    [Object.assign(new Error('falhou'), { stderr: `boom ${VALOR}` }), 502, /Não consegui reiniciar/],
  ]) {
    const t = cenario({ reiniciar: async () => { throw erro; } });
    try {
      t.cofre.guardar(t.agente, { envName: 'OPENAI_API_KEY', valor: VALOR });
      const r = await t.cofre.aplicar(t.agente);
      assert.equal(r.status, status); assert.match(r.erro, rx); assert.match(r.howToFix, /FOI guardada/);
      assert.ok(!JSON.stringify(r).includes(VALOR) && !t.cap.texto().includes(VALOR));
    } finally { t.limpa(); }
  }
});

test('duas gravações seguidas no mesmo agente não perdem linha; trava de outro processo espera', async () => {
  const s = cenario();
  try {
    await Promise.all([
      Promise.resolve().then(() => s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR })),
      Promise.resolve().then(() => s.cofre.guardar(s.agente, { envName: 'GEMINI_API_KEY', valor: VALOR2 })),
    ]);
    assert.equal(fs.readFileSync(s.nomes, 'utf8'), 'OPENAI_API_KEY=\nGEMINI_API_KEY=\n');
    assert.equal(s.cofre.estado(s.agente).chaves.length, 2);
    // trava deixada por outro processo e já velha: é ignorada
    const lock = path.join(s.dataDir, 'cofre', 'ana.lock');
    fs.writeFileSync(lock, '');
    const velho = new Date(Date.now() - 60000); fs.utimesSync(lock, velho, velho);
    assert.equal(s.cofre.guardar(s.agente, { envName: 'XAI_API_KEY', valor: VALOR2 }).ok, true);
    assert.equal(fs.existsSync(lock), false);
  } finally { s.limpa(); }
});

test('linha que não entende é preservada e vira aviso sem o conteúdo', () => {
  const s = cenario();
  try {
    fs.writeFileSync(s.cofreEnv, "isto nao e uma linha de ambiente segredo-estranho\nXAI_API_KEY='xai-chave-12345678'\n", { mode: 0o600 });
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR });
    assert.match(fs.readFileSync(s.cofreEnv, 'utf8'), /^isto nao e uma linha de ambiente segredo-estranho\n/);
    assert.match(s.cap.texto(), /\[aviso\].*1 linha/);
    assert.ok(!s.cap.texto().includes('segredo-estranho'));
  } finally { s.limpa(); }
});

// ── a linha de comando ──────────────────────────────────────────────────────
function cli(s, args, input, extraEnv) {
  const agentes = path.join(s.raiz, 'agentes.json');
  fs.writeFileSync(agentes, JSON.stringify({ versao: 1, agentes: [{ slug: 'ana', nome: 'Ana', runner: 'http://127.0.0.1:1', agente_id: 'a1', cofre_arquivo: s.cofreEnv }] }));
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cofre.js'), ...args], {
    input: input == null ? '' : input, encoding: 'utf8',
    env: Object.assign({}, process.env, { DGCLAW_WEB_ENV: path.join(s.raiz, 'nao-existe.env'), DGCLAW_AGENTES: agentes, DGCLAW_WEB_DATA: s.dataDir }, extraEnv || {}),
  });
}

test('CLI: guardar pelo stdin, listar, aplicar (podman falso) e revogar; o valor nunca aparece na saída', () => {
  const s = cenario();
  try {
    const bin = path.join(s.raiz, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'podman'), `#!/bin/sh\necho "$@" >> "${s.raiz}/podman.log"\n`, { mode: 0o755 });
    const PATH = `${bin}:${process.env.PATH}`;
    const g = cli(s, ['guardar', 'ana', 'OPENAI_API_KEY', '--provedor', 'openai', '--aplicar'], `${VALOR}\n`, { PATH });
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /guardada \(termina em 5678\)/);
    assert.ok(!(g.stdout + g.stderr).includes(VALOR));
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `OPENAI_API_KEY='${VALOR}'\n`);
    assert.match(fs.readFileSync(path.join(s.raiz, 'podman.log'), 'utf8'), /exec dgclaw-ana systemctl restart dgclaw-runner/);
    assert.equal(JSON.parse(fs.readFileSync(s.meta, 'utf8')).chaves[0].origem, 'cli');
    assert.equal(JSON.parse(fs.readFileSync(s.meta, 'utf8')).chaves[0].cadastradaPor, 'administrador (linha de comando)');
    const l = cli(s, ['listar', 'ana', '--json']);
    assert.equal(l.status, 0); assert.equal(JSON.parse(l.stdout).chaves[0].envName, 'OPENAI_API_KEY'); assert.ok(!l.stdout.includes(VALOR));
    assert.equal(cli(s, ['aplicar', 'ana'], '', { PATH }).status, 0);
    const r = cli(s, ['revogar', 'ana', 'OPENAI_API_KEY', '--quem', 'Danilo']);
    assert.equal(r.status, 0, r.stderr);
  } finally { s.limpa(); }
});

test('CLI: recusa valor por argumento (2), nome proibido (1), agente inexistente (1); valor fora do erro', () => {
  const s = cenario();
  try {
    const a = cli(s, ['guardar', 'ana', 'OPENAI_API_KEY', VALOR], VALOR);
    assert.equal(a.status, 2); assert.match(a.stderr, /stdin/); assert.ok(!(a.stdout + a.stderr).includes(VALOR));
    const b = cli(s, ['guardar', 'ana', `OPENAI_API_KEY=${VALOR}`], VALOR);
    assert.equal(b.status, 2); assert.ok(!(b.stdout + b.stderr).includes(VALOR));
    const c = cli(s, ['guardar', 'ana', 'NODE_OPTIONS'], VALOR);
    assert.equal(c.status, 1); assert.ok(!(c.stdout + c.stderr).includes(VALOR));
    assert.equal(cli(s, ['guardar', 'fantasma', 'OPENAI_API_KEY'], VALOR).status, 1);
    assert.equal(cli(s, ['dancar', 'ana']).status, 2);
    assert.equal(fs.existsSync(s.cofreEnv), false);
  } finally { s.limpa(); }
});
