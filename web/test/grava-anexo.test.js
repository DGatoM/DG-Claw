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
    const tentativa = gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08', 'colaborador-x'], nome: 'tarefa', dados: Buffer.from('* * * * * root id') });
    if (onde.length === 1) await assert.rejects(tentativa, /atalho|Permission|EACCES|EEXIST|não é uma pasta/i);
    else {
      // pasta do dia que virou atalho não é seguida: o anexo vai para <dia>-2, dentro da casa
      // (sem root, como no CI, não há migração de pasta: a gravação é recusada, e nada vai para fora do mesmo jeito).
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const caminho = await tentativa;
        assert.ok(caminho.startsWith(path.join(h, 'uploads', '2026-11-08-2') + path.sep), caminho);
      } else {
        await assert.rejects(tentativa, /atalho/i);
      }
    }
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

test('upload pelo Web (dono e colaborador): atalho plantado na pasta do dia não faz o Web gravar fora da casa (vai para <dia>-2)', async () => {
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
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        assert.equal(r.status, 201, r.texto);
        assert.match(r.json.anexo.path, new RegExp(`/uploads/${dia}-2/`), 'a pasta do dia que virou atalho não foi seguida');
      } else {
        // Sem root (CI) a gravação é recusada; nada é gravado fora da casa.
        assert.equal(r.status, 500, r.texto);
        assert.match(r.json.erro, /atalho/i);
      }
    }
    semNada(fora);
  } finally { await s.fechar(); }
});

// ── 9ª rodada ──
const souRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const semRoot = souRoot ? false : 'este teste precisa rodar como root (a casa e as pastas antigas são do root); pulado fora do root';

test('rodada 9, achado 2: a casa do Admin é do root e o upload funciona; agente comum com casa de root segue recusado; atalho é recusado também no Admin', { skip: semRoot }, async () => {
  const h = pastaTemp('casa-admin'); // dono root, como a do Admin
  const admin = { slug: 'admin', nome: 'Admin', tipo: 'admin', home_host: h };
  const a = await gravaAnexo({ agente: admin, pastas: ['uploads', '2026-11-08'], nome: 'a.txt', dados: Buffer.from('um') });
  const b = await gravaAnexo({ agente: admin, pastas: ['uploads', '2026-11-08'], nome: 'a.txt', dados: Buffer.from('dois') });
  assert.equal(a, path.join(h, 'uploads', '2026-11-08', 'a.txt'));
  assert.equal(path.basename(b), 'a-1.txt');
  assert.equal(fs.statSync(a).uid, 0);
  await assert.rejects(gravaAnexo({ agente: { ...admin, tipo: 'agente' }, pastas: ['uploads'], nome: 'x.txt', dados: Buffer.from('x') }), /pertence ao root/);
  const fora = alvoFora();
  fs.symlinkSync(fora, path.join(h, 'uploads', '2026-11-09'));
  await assert.rejects(gravaAnexo({ agente: admin, pastas: ['uploads', '2026-11-09'], nome: 'x.txt', dados: Buffer.from('x') }), /atalho/);
  semNada(fora);
});

test('rodada 9, achado 3: uploads/ e uploads/<dia> criados como root numa instalação antiga: uploads/ passa ao dono, a pasta do dia do root não é tocada e o upload funciona', { skip: semRoot }, async () => {
  const h = pastaTemp('casa-antiga');
  fs.mkdirSync(path.join(h, 'uploads', '2026-11-08'), { recursive: true }); // root, 0755
  fs.writeFileSync(path.join(h, 'uploads', '2026-11-08', 'velho.txt'), 'antigo');
  fs.chownSync(h, 65534, 65534);
  assert.equal(fs.statSync(path.join(h, 'uploads')).uid, 0);
  const caminho = await gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08', 'colaborador-x'], nome: 'novo.txt', dados: Buffer.from('novo') });
  assert.equal(fs.statSync(path.join(h, 'uploads')).uid, 65534, 'só uploads/ foi passada ao dono');
  assert.equal(fs.statSync(path.join(h, 'uploads', '2026-11-08')).uid, 0, 'a pasta do dia do root não foi tocada');
  assert.equal(fs.readFileSync(path.join(h, 'uploads', '2026-11-08', 'velho.txt'), 'utf8'), 'antigo', 'nada foi apagado nem movido');
  assert.equal(caminho, path.join(h, 'uploads', '2026-11-08-2', 'colaborador-x', 'novo.txt'));
  assert.equal(fs.statSync(caminho).uid, 65534);
  const outro = await gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08'], nome: 'outro.txt', dados: Buffer.from('2') });
  assert.equal(outro, path.join(h, 'uploads', '2026-11-08-2', 'outro.txt'), 'reaproveita a pasta nova do dono');
});

test('rodada 9, achado 3: uploads/ que é atalho para fora não é migrada nem seguida', { skip: semRoot }, async () => {
  const h = pastaTemp('casa-atalho');
  fs.chownSync(h, 65534, 65534);
  const fora = pastaTemp('fora-root'); // do root, 755
  fs.symlinkSync(fora, path.join(h, 'uploads'));
  await assert.rejects(gravaAnexo({ agente: agenteDe(h), pastas: ['uploads', '2026-11-08'], nome: 'x.txt', dados: Buffer.from('x') }), /atalho|Permission|EACCES/);
  assert.equal(fs.statSync(fora).uid, 0, 'o destino do atalho continua do root');
  semNada(fora);
});

test('rodada 9, achado 1: agente que sumiu do registro derruba a sessão do colaborador e o login responde com a mensagem do convite de agente removido', async () => {
  const s = await cenario();
  try {
    const x = await colaboradorAtivo(s);
    assert.equal((await x.c.get('/api/v1/agents/ana/messages')).status, 200);
    const j = JSON.parse(fs.readFileSync(s.t.agentesPath, 'utf8'));
    j.agentes = j.agentes.filter((a) => a.slug !== 'ana'); // `dgclaw agente remover ana`: sai do agentes.json
    fs.writeFileSync(s.t.agentesPath, JSON.stringify(j));
    const futuro = new Date(Date.now() + 5000); fs.utimesSync(s.t.agentesPath, futuro, futuro);
    assert.equal((await x.c.get('/api/v1/agents/ana/messages')).status, 401, 'a sessão existente caiu');
    const l = await require('./ajuda').cliente(s.t.porta).post('/login', { json: { usuario: x.email, senha: x.nova } });
    assert.equal(l.status, 401, l.texto);
    assert.match(l.json.erro, /Este convite era de um agente que foi removido\. Peça um convite novo ao dono\./);
  } finally { await s.fechar(); }
});
