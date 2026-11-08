'use strict';
// O gravador de anexos roda sem privilégio: atalho plantado pelo agente na casa dele não leva a gravação para fora.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, entregaAoAgente } = require('./ajuda');
const { gravaAnexo } = require('../lib/grava-anexo');
const { cenario, colaboradorAtivo } = require('./colab-ajuda');

/** Uma pasta de fora da casa que quem não é root não consegue escrever (dono root ou modo 555). */
function alvoFora() {
  const d = pastaTemp('fora');
  fs.chmodSync(d, 0o555);
  return d;
}
const casa = () => { const h = pastaTemp('casa'); fs.mkdirSync(path.join(h, 'uploads'), { recursive: true }); return entregaAoAgente(h); };
const agenteDe = (h) => ({ slug: 'ana', nome: 'Ana', home_host: h });
const semNada = (dir) => assert.deepEqual(fs.readdirSync(dir), [], `nada pode ter sido criado em ${dir}`);

test('anexo: grava na casa, cria as pastas e não sobrescreve (-1, -2)', async () => {
  const h = casa();
  const a = await gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08'], nome: 'a.txt', dados: Buffer.from('um') });
  const b = await gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08'], nome: 'a.txt', dados: Buffer.from('dois') });
  assert.equal(a, path.join(h, 'uploads', '2026-11-08', 'a.txt'));
  assert.equal(b, path.join(h, 'uploads', '2026-11-08', 'a-1.txt'));
  assert.equal(fs.readFileSync(a, 'utf8'), 'um');
  if (process.getuid() === 0) assert.equal(fs.statSync(a).uid, 65534, 'o arquivo é do dono da casa, não do root');
});

test('anexo: pasta do meio trocada por atalho para fora da casa não leva a gravação (nada é criado lá)', async () => {
  for (const onde of [['uploads'], ['uploads', '2026-11-08']]) {
    const h = casa();
    const fora = alvoFora();
    if (onde.length === 1) { fs.rmSync(path.join(h, 'uploads'), { recursive: true }); fs.symlinkSync(fora, path.join(h, 'uploads')); }
    else { fs.symlinkSync(fora, path.join(h, 'uploads', '2026-11-08')); }
    await assert.rejects(gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08', 'colaborador-x'], nome: 'tarefa', dados: Buffer.from('* * * * * root id') }), /atalho|Permission|EACCES|EEXIST|não é uma pasta/i);
    semNada(fora);
  }
});

test('anexo: arquivo final que já é atalho não é seguido (O_NOFOLLOW + O_EXCL): grava com outro nome e o alvo fica intacto', async () => {
  const h = casa();
  const fora = pastaTemp('alvo-final');
  const alvo = path.join(fora, 'intacto.txt');
  fs.writeFileSync(alvo, 'original');
  fs.mkdirSync(path.join(h, 'uploads', 'dia'));
  entregaAoAgente(h);
  fs.symlinkSync(alvo, path.join(h, 'uploads', 'dia', 'x.txt'));
  const caminho = await gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', 'dia'], nome: 'x.txt', dados: Buffer.from('novo') });
  assert.equal(path.basename(caminho), 'x-1.txt');
  assert.equal(fs.readFileSync(alvo, 'utf8'), 'original');
});

test('anexo: casa de root ou casa que é atalho é recusada com explicação, sem gravar', async () => {
  if (process.getuid() === 0) {
    const h = pastaTemp('casa-root'); // dono root
    await assert.rejects(gravaAnexo({ agente: agenteDe(h), pastas: ['uploads'], nome: 'a.txt', dados: Buffer.from('x') }), /pertence ao root/);
    semNada(h);
  }
  const real = casa();
  const elo = path.join(pastaTemp('elo'), 'casa');
  fs.symlinkSync(real, elo);
  await assert.rejects(gravaAnexo({ agente: agenteDe(elo), pastas: ['uploads'], nome: 'a.txt', dados: Buffer.from('x') }), /atalho/);
  assert.deepEqual(fs.readdirSync(path.join(real, 'uploads')), []);
});

test('upload pelo Web (dono e colaborador): atalho plantado na casa do agente não faz o Web gravar fora dela', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    const fora = alvoFora();
    fs.mkdirSync(path.join(s.homeAna, 'uploads'), { recursive: true });
    entregaAoAgente(s.homeAna);
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: s.t.web.config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    fs.symlinkSync(fora, path.join(s.homeAna, 'uploads', dia));
    const corpo = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="tarefa"\r\nContent-Type: text/plain\r\n\r\n* * * * * root id\r\n--b--\r\n');
    const cab = { 'Content-Type': 'multipart/form-data; boundary=b' };
    for (const c of [x.c, s.dono]) {
      const r = await c.post('/api/v1/agents/ana/upload', { corpo, headers: cab });
      assert.equal(r.status, 500, r.texto);
      assert.match(r.json.erro, /Não consegui gravar o arquivo na casa de Ana/);
    }
    semNada(fora);
    assert.equal(s.rAna.rec.inputs.length, 0, 'nada foi enviado ao agente');
  } finally { await s.fechar(); }
});
