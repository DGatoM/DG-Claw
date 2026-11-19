'use strict';
// Teste do download do YouTube (diagnóstico): classificação do resultado do yt-dlp e cadência do teste.
// Comando de dentro do container falso: nada de rede, de podman nem de YouTube de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classificarYoutube, tarefaYoutube, SCRIPT } = require('../lib/diagnostico/youtube');

const AGORA = Date.UTC(2026, 10, 18, 15, 0, 0);
const MIN = 60000;
const H = 3600 * 1000;

test('classificação: ok, pediu login, yt-dlp ausente, tempo e outro erro', () => {
  assert.equal(classificarYoutube({ codigo: 0, stdout: '', stderr: '' }).tipo, 'ok');
  const bot = 'ERROR: [youtube] jNQXAC9IJRQ: Sign in to confirm you\'re not a bot. Use --cookies-from-browser or --cookies for the authentication.';
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: bot }).tipo, 'login');
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: 'WARNING: The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser' }).tipo, 'login');
  assert.equal(classificarYoutube({ codigo: 127, stdout: '', stderr: 'yt-dlp: command not found' }).tipo, 'ausente');
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: 'sh: 1: yt-dlp: not found' }).tipo, 'ausente');
  assert.equal(classificarYoutube({ codigo: null, stdout: '', stderr: '', erro: 'timeout' }).tipo, 'tempo');
  assert.equal(classificarYoutube({ codigo: 124, stdout: '', stderr: '' }).tipo, 'tempo');
  const o = classificarYoutube({ codigo: 1, stdout: '', stderr: 'WARNING: x\nERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>\n' });
  assert.equal(o.tipo, 'outro');
  assert.match(o.detalhe, /Unable to download webpage/);
});

test('classificação: o detalhe de outro erro não carrega cookie nem token', () => {
  const o = classificarYoutube({ codigo: 1, stdout: '', stderr: 'ERROR: falhou com Authorization: Bearer abcdef1234567890abcdef1234567890 e SID=segredo123456789012345678901234567890 em /home/agente/.dgclaw/segredos/runner.token' });
  assert.equal(o.tipo, 'outro');
  assert.ok(!/abcdef1234567890abcdef/.test(o.detalhe), o.detalhe);
  assert.ok(!/segredo123456789/.test(o.detalhe), o.detalhe);
  assert.ok(!/runner\.token/.test(o.detalhe), o.detalhe);
});

test('o comando de dentro: só valores fixos, baixa pouco e apaga a pasta temporária', () => {
  assert.ok(!SCRIPT.includes(';'), 'sem ponto e vírgula: nada de valor externo entra no comando');
  assert.match(SCRIPT, /-f worst/);
  assert.match(SCRIPT, /--max-filesize 5M/);
  assert.match(SCRIPT, /timeout \d+ yt-dlp/);
  assert.match(SCRIPT, /rm -rf "\$d"/);
});

function monta(respostas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-yt-'));
  let agora = AGORA;
  const chamadas = [];
  const logs = [];
  const ctx = {
    config: { dataDir: dir }, log: (n, m) => logs.push([n, m]), agora: () => agora,
    execSolto: async (cmd, args, opcoes) => { chamadas.push({ cmd, args, opcoes }); return respostas.shift() || { codigo: 0, stdout: '', stderr: '', erro: null }; },
  };
  const ag = { slug: 'tina', nome: 'Tina', container: 'dgclaw-tina' };
  const tarefa = () => tarefaYoutube(ctx, ag, {});
  const rodar = async (dep) => { const r = await tarefa().fn(dep); await Promise.all([...ctx.youtube.andando.values()]); return r; };
  return { ctx, chamadas, logs, dir, rodar, avanca: (ms) => { agora += ms; }, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('cadência: roda uma vez, mostra o resultado, só repete depois de 24 h', async () => {
  const m = monta([{ codigo: 0, stdout: '', stderr: '', erro: null }]);
  const primeira = await m.rodar();
  assert.equal(primeira.estado, 'nao_medido', 'na primeira vez o teste ainda está rodando');
  assert.equal(m.chamadas.length, 1);
  const c = m.chamadas[0];
  assert.equal(c.cmd, 'podman');
  assert.deepEqual(c.args.slice(0, 6), ['exec', '--user', 'agente', '-e', 'HOME=/home/agente', 'dgclaw-tina']);
  assert.ok(c.opcoes.timeout >= 60000, 'o download tem prazo próprio, maior que o da verificação');
  m.avanca(30 * 1000);
  assert.equal((await m.rodar()).estado, 'ok');
  m.avanca(10 * H);
  assert.equal((await m.rodar()).estado, 'ok');
  assert.equal(m.chamadas.length, 1, 'abrir a saúde várias vezes no mesmo dia não baixa de novo');
  m.avanca(15 * H);
  assert.equal((await m.rodar()).estado, 'ok', 'mostra o último resultado enquanto refaz');
  assert.equal(m.chamadas.length, 2, 'passadas 24 h o teste roda de novo');
  m.limpa();
});

test('pediu login vira aviso visível (atenção) com o passo a passo em português; refaz depois de 5 min', async () => {
  const m = monta([{ codigo: 1, stdout: '', stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot", erro: null }, { codigo: 0, stdout: '', stderr: '', erro: null }]);
  await m.rodar();
  m.avanca(MIN);
  const r = await m.rodar();
  assert.equal(r.estado, 'atencao');
  assert.match(r.motivo, /pediu login/);
  assert.match(r.o_que_fazer, /Tela/);
  assert.match(r.o_que_fazer, /youtube\.com/);
  assert.equal(m.chamadas.length, 1, 'antes de 5 min não baixa de novo');
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /login/.test(t)), 'também fica no log');
  m.avanca(6 * MIN);
  await m.rodar();
  assert.equal(m.chamadas.length, 2, 'depois de 5 min, quem abre a saúde testa de novo');
  m.avanca(MIN);
  assert.equal((await m.rodar()).estado, 'ok', 'logou na Tela: o item volta a ok');
  m.limpa();
});

test('yt-dlp ausente e outro erro viram atenção; o outro erro mostra só a última linha do stderr', async () => {
  const a = monta([{ codigo: 127, stdout: '', stderr: 'yt-dlp: command not found', erro: null }]);
  await a.rodar();
  const ra = await a.rodar();
  assert.equal(ra.estado, 'atencao');
  assert.match(ra.motivo, /yt-dlp não existe/);
  a.limpa();
  const b = monta([{ codigo: 1, stdout: '', stderr: 'WARNING: algo\nERROR: HTTP Error 429: Too Many Requests', erro: null }]);
  await b.rodar();
  const rb = await b.rodar();
  assert.equal(rb.estado, 'atencao');
  assert.match(rb.motivo, /HTTP Error 429/);
  assert.ok(!/WARNING: algo/.test(rb.motivo));
  b.limpa();
});

test('o último resultado sobrevive a reinício do painel (arquivo) e container parado não baixa nada', async () => {
  const m = monta([{ codigo: 0, stdout: '', stderr: '', erro: null }]);
  await m.rodar();
  const arq = path.join(m.dir, 'youtube-saude.json');
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).tina.tipo, 'ok');
  assert.equal((fs.statSync(arq).mode & 0o777).toString(8), '600');
  delete m.ctx.youtube; // painel reiniciado: a memória some, o arquivo fica
  m.avanca(MIN);
  assert.equal((await m.rodar()).estado, 'ok');
  assert.equal(m.chamadas.length, 1, 'não baixou de novo depois do reinício');
  const p = await tarefaYoutube(m.ctx, { slug: 'tina', nome: 'Tina', container: 'dgclaw-tina' }, {}).fn({ parado: true });
  assert.equal(p.estado, 'nao_medido');
  assert.equal(m.chamadas.length, 1);
  m.limpa();
});

// Vigia periódico: avisa no aparelho só quando a conta cai (transição para login).
const { criarDiagnostico } = require('../lib/diagnostico');
const LOGIN = { codigo: 1, stdout: '', stderr: 'ERROR: Sign in to confirm you\'re not a bot', erro: null };
const BOM = { codigo: 0, stdout: '', stderr: '', erro: null };

function montaVigia(respostas, agentes, pushImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-vigia-'));
  const chamadas = [];
  const logs = [];
  const pushes = [];
  const push = { enviar: async (aviso) => { pushes.push(aviso); if (pushImpl) return pushImpl(aviso); return { inscricoes: 1, falhas: [] }; } };
  const diag = criarDiagnostico({
    config: { tz: 'America/Sao_Paulo', dataDir: dir },
    registro: { estado: () => ({ ok: true, erro: null, agentes: agentes || [{ slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina' }] }) },
    runner: {}, log: (n, m) => logs.push([n, m]),
    exec: async (cmd, args) => { chamadas.push(args[5]); return respostas.shift() || BOM; },
  });
  const vigia = diag.vigiarYoutube({ push, intervaloMs: 1000000 });
  return { vigia, pushes, logs, chamadas, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('vigia: transição ok -> login manda um push com a tag do agente', async () => {
  const m = montaVigia([BOM, LOGIN]);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 0);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1);
  assert.equal(m.pushes[0].tag, 'youtube-tina');
  assert.equal(m.pushes[0].titulo, 'Tina saiu do YouTube');
  assert.equal(m.pushes[0].url, '/a/tina');
  m.limpa();
});

test('vigia: login -> login não avisa de novo', async () => {
  const m = montaVigia([LOGIN, LOGIN, LOGIN]);
  await m.vigia.rodada();
  await m.vigia.rodada();
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1, 'só o primeiro login avisa');
  m.limpa();
});

test('vigia: primeiro teste já em login (sem resultado anterior) avisa', async () => {
  const m = montaVigia([LOGIN]);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1);
  m.limpa();
});

test('vigia: push que lança erro não derruba a rodada e o próximo agente é testado', async () => {
  const agentes = [
    { slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina' },
    { slug: 'rui', nome: 'Rui', tipo: 'agente', container: 'dgclaw-rui' },
  ];
  const m = montaVigia([LOGIN, LOGIN], agentes, async () => { throw new Error('sem rede'); });
  await m.vigia.rodada();
  assert.deepEqual(m.chamadas, ['dgclaw-tina', 'dgclaw-rui']);
  assert.equal(m.pushes.length, 2);
  assert.ok(m.logs.some(([n, t]) => n === 'erro' && /Tina não saiu \(sem rede\)/.test(t)), JSON.stringify(m.logs));
  m.limpa();
});
