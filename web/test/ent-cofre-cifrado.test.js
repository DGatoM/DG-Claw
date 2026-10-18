'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarCofreAgente } = require('../lib/cofre-agente');
const { capturaLog } = require('./ajuda');

const STUB = path.join(__dirname, '..', '..', 'tests', 'enterprise', 'stubs-d', 'systemd-creds');
const VALOR = 'sk-teste-valor-secreto-so-para-teste-12345678';
const VALOR2 = 'sk-teste-outro-valor-secreto-87654321';
const modo = (p) => fs.statSync(p).mode & 0o777;

/** Cenário completo: casa falsa, protecoes.json no nível pedido, systemd-creds falso e RAM numa pasta temporária. */
function cenario(nivel) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-cifrado-'));
  const casa = path.join(raiz, 'casa-ana');
  fs.mkdirSync(path.join(casa, 'cofre'), { recursive: true });
  fs.mkdirSync(path.join(casa, 'config'));
  fs.chmodSync(casa, 0o711); fs.chmodSync(path.join(casa, 'cofre'), 0o700); fs.chmodSync(path.join(casa, 'config'), 0o755);
  const dataDir = path.join(raiz, 'dados');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const ram = path.join(raiz, 'ram');
  const protecoesPath = path.join(raiz, 'protecoes.json');
  if (nivel) fs.writeFileSync(protecoesPath, JSON.stringify({ versao: 1, nivel, ajustes: {} }), { mode: 0o600 });
  const logCreds = path.join(raiz, 'creds.log');
  process.env.DGCLAW_SYSTEMD_CREDS = STUB;
  process.env.DGCLAW_COFRES_RAM = ram;
  process.env.STUB_LOG = logCreds;
  delete process.env.STUB_CREDS_FALHA;
  const cofreEnv = path.join(casa, 'cofre', 'cofre.env');
  const agente = { slug: 'ana', nome: 'Ana', cofre_arquivo: cofreEnv, container: 'dgclaw-ana' };
  const cap = capturaLog();
  const cofre = criarCofreAgente({ config: { dataDir, protecoesPath }, log: cap.log, reiniciar: async () => {} });
  return { raiz, casa, ram, cofreEnv, cred: `${cofreEnv}.cred`, ramEnv: path.join(ram, 'ana', 'cofre.env'), agente, cap, cofre, logCreds, nomes: path.join(casa, 'config', 'cofre-nomes'), limpa: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

test('cifrado: guardar deixa só o .cred no disco, a cópia em RAM certa e nenhum claro', () => {
  const s = cenario('escritorio');
  try {
    const r = s.cofre.guardar(s.agente, { envName: 'openai_api_key', valor: VALOR, provedor: 'openai', quem: 'Paulo' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!fs.existsSync(s.cofreEnv), 'o cofre.env em claro não pode existir no disco');
    assert.ok(fs.existsSync(s.cred)); assert.equal(modo(s.cred), 0o600);
    assert.ok(!fs.readFileSync(s.cred, 'utf8').includes(VALOR), 'o valor não aparece no .cred');
    assert.equal(fs.readFileSync(s.ramEnv, 'utf8'), `OPENAI_API_KEY='${VALOR}'\n`);
    assert.equal(modo(s.ramEnv), 0o600); assert.equal(modo(path.dirname(s.ramEnv)), 0o700);
    assert.equal(fs.readFileSync(s.nomes, 'utf8'), 'OPENAI_API_KEY=\n');
    // nada do valor em disco fora da RAM, nem no log, nem nos argumentos passados ao systemd-creds
    const achados = [];
    const varre = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) varre(p); else if (!p.startsWith(s.ram) && fs.readFileSync(p).includes(VALOR)) achados.push(p); } };
    varre(s.raiz);
    assert.deepEqual(achados, []);
    assert.ok(!s.cap.texto().includes(VALOR));
    const chamadas = fs.readFileSync(s.logCreds, 'utf8');
    assert.match(chamadas, /encrypt --name=dgclaw-cofre-ana --with-key=auto - -/);
    assert.ok(!chamadas.includes(VALOR), 'valor só por stdin, nunca por argumento');
  } finally { s.limpa(); }
});

test('cifrado: trocar e revogar leem do cifrado e mantêm as outras chaves', () => {
  const s = cenario('empresa');
  try {
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    s.cofre.guardar(s.agente, { envName: 'GEMINI_API_KEY', valor: 'gemini-chave-12345678', provedor: 'gemini' });
    const t = s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR2, provedor: 'openai' });
    assert.equal(t.trocada, true);
    assert.equal(fs.readFileSync(s.ramEnv, 'utf8'), `OPENAI_API_KEY='${VALOR2}'\nGEMINI_API_KEY='gemini-chave-12345678'\n`);
    const v = s.cofre.revogar(s.agente, 'OPENAI_API_KEY', 'Paulo');
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(fs.readFileSync(s.ramEnv, 'utf8'), "GEMINI_API_KEY='gemini-chave-12345678'\n");
    assert.deepEqual(s.cofre.listar(s.agente).chaves.filter((c) => !c.revogadaEm).map((c) => c.envName), ['GEMINI_API_KEY']);
    assert.ok(!fs.existsSync(s.cofreEnv));
  } finally { s.limpa(); }
});

test('cifrado: depois de reiniciar a máquina (RAM vazia) ainda lê pelo .cred e recria a cópia em RAM', () => {
  const s = cenario('escritorio');
  try {
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    fs.rmSync(s.ram, { recursive: true });
    const l = s.cofre.listar(s.agente);
    assert.equal(l.chaves[0].envName, 'OPENAI_API_KEY');
    assert.equal(fs.readFileSync(s.ramEnv, 'utf8'), `OPENAI_API_KEY='${VALOR}'\n`);
    s.cofre.guardar(s.agente, { envName: 'XAI_API_KEY', valor: 'xai-chave-12345678', provedor: 'xai' });
    assert.match(fs.readFileSync(s.ramEnv, 'utf8'), /OPENAI_API_KEY=.*\nXAI_API_KEY=/s, 'a chave antiga não se perdeu');
  } finally { s.limpa(); }
});

test('cifrado: cofre em claro que já existia é lido e, na primeira gravação, vira cifrado e some do disco', () => {
  const s = cenario('escritorio');
  try {
    fs.writeFileSync(s.cofreEnv, `GEMINI_API_KEY='gemini-antiga-12345678'\n`, { mode: 0o600 });
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    assert.ok(!fs.existsSync(s.cofreEnv));
    assert.equal(fs.readFileSync(s.ramEnv, 'utf8'), `GEMINI_API_KEY='gemini-antiga-12345678'\nOPENAI_API_KEY='${VALOR}'\n`);
  } finally { s.limpa(); }
});

test('cifrado: se o systemd-creds falha, recusa com motivo e não toca no cofre', () => {
  const s = cenario('escritorio');
  try {
    fs.writeFileSync(s.cofreEnv, `GEMINI_API_KEY='gemini-antiga-12345678'\n`, { mode: 0o600 });
    process.env.STUB_CREDS_FALHA = '1';
    const r = s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    assert.ok(r.erro && /cifrar o cofre de ana/.test(r.erro), r.erro);
    assert.equal(r.status, 500);
    assert.ok(!r.erro.includes(VALOR));
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `GEMINI_API_KEY='gemini-antiga-12345678'\n`);
    assert.ok(!fs.existsSync(s.cred));
  } finally { delete process.env.STUB_CREDS_FALHA; s.limpa(); }
});

test('cifrado: .cred que não decifra recusa a leitura em vez de devolver um cofre vazio', () => {
  const s = cenario('escritorio');
  try {
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    fs.rmSync(s.ram, { recursive: true });
    fs.writeFileSync(s.cred, 'lixo', { mode: 0o600 });
    const e = s.cofre.estado(s.agente);
    assert.ok(e.erro && /cofre cifrado/.test(e.erro), JSON.stringify(e));
    const g = s.cofre.guardar(s.agente, { envName: 'XAI_API_KEY', valor: 'xai-chave-12345678', provedor: 'xai' });
    assert.ok(g.erro, 'não pode gravar por cima de um cofre que não consegui ler');
  } finally { s.limpa(); }
});

test('pessoal: nada muda (cofre.env em claro, sem .cred, sem pasta em RAM)', () => {
  const s = cenario(null);
  try {
    const r = s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(s.cofreEnv, 'utf8'), `OPENAI_API_KEY='${VALOR}'\n`);
    assert.ok(!fs.existsSync(s.cred)); assert.ok(!fs.existsSync(s.ram));
    assert.equal(s.cofre.estado(s.agente).guarda.motor, 'host');
    assert.ok(!fs.existsSync(s.logCreds), 'o systemd-creds nem foi chamado');
  } finally { s.limpa(); }
});

test('pessoal com ajuste para cima: ligar cofre_cifrado num nível pessoal também cifra', () => {
  const s = cenario('pessoal');
  try {
    fs.writeFileSync(path.join(s.raiz, 'protecoes.json'), JSON.stringify({ versao: 1, nivel: 'pessoal', ajustes: { cofre_cifrado: true } }));
    s.cofre.guardar(s.agente, { envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' });
    assert.ok(fs.existsSync(s.cred)); assert.ok(!fs.existsSync(s.cofreEnv));
    assert.equal(s.cofre.estado(s.agente).guarda.motor, 'systemd-creds');
  } finally { s.limpa(); }
});
