'use strict';
// Teste do download do YouTube (diagnóstico): classificação do resultado do yt-dlp e cadência do teste.
// Comando de dentro do container falso: nada de rede, de podman nem de YouTube de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classificarYoutube, tarefaYoutube, SCRIPT, LIMITE_SAIDA } = require('../lib/diagnostico/youtube');

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
  assert.deepEqual(o, { tipo: 'outro', codigo: 1 }, 'só o tipo e o código de saída, nunca texto do stderr');
});

test('classificação: código 0 com aviso de cookies inválidos vira login (a conta caiu mesmo com o vídeo baixado)', () => {
  const aviso = 'WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.';
  assert.equal(classificarYoutube({ codigo: 0, stdout: '', stderr: aviso }).tipo, 'login');
  assert.equal(classificarYoutube({ codigo: 0, stdout: '', stderr: 'WARNING: tudo normal' }).tipo, 'ok');
});

test('o comando de dentro: só valores fixos, baixa pouco e apaga a pasta temporária', () => {
  assert.ok(!SCRIPT.includes(';'), 'sem ponto e vírgula: nada de valor externo entra no comando');
  assert.match(SCRIPT, /--ignore-config/);
  assert.match(SCRIPT, /--no-plugin-dirs/);
  assert.match(SCRIPT, /--js-runtimes node/);
  assert.ok(!SCRIPT.includes('--no-warnings'), 'sem --no-warnings: os avisos de cookie precisam aparecer');
  assert.match(SCRIPT, /if \[ -d \/home\/agente\/\.tela-chrome \]/, 'cookies só se a pasta do Chrome da Tela existir');
  assert.match(SCRIPT, /--cookies-from-browser "chrome\+basictext:\/home\/agente\/\.tela-chrome"/);
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

test('yt-dlp ausente e outro erro viram atenção; o outro erro mostra só o código de saída', async () => {
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
  assert.match(rb.motivo, /código de saída 1/);
  assert.ok(!/429|WARNING/.test(rb.motivo));
  b.limpa();
});

test('stderr com caminho de cliente não aparece no log, no estado nem na resposta', async () => {
  const stderr = 'ERROR: falhou lendo /home/agente/clientes/acme-secreta/contrato.pdf token=ZZZsegredoZZZ';
  const m = monta([{ codigo: 3, stdout: 'saida em /srv/cliente-fulano/x', stderr, erro: null }]);
  await m.rodar();
  const r = await m.rodar();
  const tudo = JSON.stringify([m.logs, JSON.parse(fs.readFileSync(path.join(m.dir, 'youtube-saude.json'), 'utf8')), r]);
  assert.ok(!/acme|cliente|segredo|contrato|srv/.test(tudo), tudo);
  assert.match(r.motivo, /código de saída 3/);
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /código de saída 3/.test(t)));
  m.limpa();
});

test('container que não aceitou o comando: log fixo, sem o stderr', async () => {
  const m = monta([{ codigo: 125, stdout: '', stderr: 'Error: no such container dgclaw-tina em /home/cliente-x/secreto', erro: null }]);
  await m.rodar();
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /não aceitou o teste/.test(t)));
  assert.ok(!JSON.stringify(m.logs).includes('cliente-x'));
  m.limpa();
});

test('saída enorme é cortada antes da classificação', () => {
  const lixo = 'x'.repeat(LIMITE_SAIDA + 10);
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: `${lixo}\nSign in to confirm you're not a bot` }).tipo, 'outro', 'o sinal depois do limite não é lido');
  assert.equal(classificarYoutube({ codigo: 1, stdout: `${lixo}\ncookies are no longer valid`, stderr: '' }).tipo, 'outro');
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: `Sign in to confirm\n${lixo}` }).tipo, 'login', 'o que está dentro do limite continua valendo');
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
    exec: async (cmd, args) => {
      if (cmd !== 'podman' || !args.includes('sh')) return { codigo: 1, stdout: '', stderr: '', erro: null };
      chamadas.push(args[5]); return respostas.shift() || BOM;
    },
    agora: () => AGORA,
  });
  const vigia = diag.vigiarYoutube({ push, intervaloMs: 1000000 });
  return { dir, diag, vigia, pushes, logs, chamadas, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
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

test('queda detectada pelo diagnóstico e confirmada pelo vigia gera um push só', async () => {
  const m = montaVigia([LOGIN, LOGIN, LOGIN]);
  // o diagnóstico (tarefa da saúde) é quem testa primeiro
  await m.diag.coletar();
  await m.diag.aguardarSegundoPlano();
  const arq = path.join(m.dir, 'youtube-saude.json');
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).tina.avisoPendente, true);
  assert.equal(m.pushes.length, 0);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1, 'aviso limpo, não repete');
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).tina.avisoPendente, false);
  m.limpa();
});

test('push que falha mantém o aviso pendente e a rodada seguinte tenta de novo', async () => {
  let n = 0;
  const m = montaVigia([LOGIN, LOGIN, LOGIN], null, async () => { n += 1; return n === 1 ? { inscricoes: 1, falhas: [{ motivo: 'HTTP 500' }] } : { inscricoes: 1, falhas: [] }; });
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 2, 'tentou de novo');
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 2, 'entregue: não tenta mais');
  m.limpa();
});

test('push sem aparelho inscrito mantém o aviso pendente; voltar a ok limpa a marca', async () => {
  const m = montaVigia([LOGIN, BOM], null, async () => ({ inscricoes: 0, falhas: [] }));
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1);
  await m.vigia.rodada();
  assert.equal(m.pushes.length, 1, 'a conta voltou: não avisa mais');
  m.limpa();
});
