'use strict';
// Teste do download do YouTube (diagnóstico): classificação do resultado do yt-dlp e cadência do teste.
// Comando de dentro do container falso: nada de rede, de podman nem de YouTube de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classificarYoutube, tarefaYoutube, testarYoutube, SCRIPT, LIMITE_SAIDA } = require('../lib/diagnostico/youtube');

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
  assert.match(SCRIPT, /TMPDIR="\$d" timeout \d+ yt-dlp [^\n]*--cookies-from-browser/, 'a cópia temporária dos cookies fica dentro da pasta apagada pelo trap');
  assert.ok(!SCRIPT.includes('--no-warnings'), 'sem --no-warnings: os avisos de cookie precisam aparecer');
  assert.match(SCRIPT, /if \[ ! -d \/home\/agente\/\.tela-chrome\/Default \]/, 'sem a pasta do Chrome da Tela o script não usa cookies');
  assert.match(SCRIPT, /exit 66/);
  assert.match(SCRIPT, /--cookies-from-browser "chrome\+basictext:\/home\/agente\/\.tela-chrome\/Default" --match-filters "availability=public & age_limit=0"/);
  assert.match(SCRIPT, /-f "worst\/worstvideo"/);
  assert.ok(!/-f worst /.test(SCRIPT));
  assert.match(SCRIPT, /--max-filesize 5M/);
  assert.match(SCRIPT, /timeout \d+ yt-dlp/);
  assert.match(SCRIPT, /rm -rf "\$d"/);
});

test('o comando tenta SEM cookies primeiro e só usa os cookies depois de "sign in to confirm"', () => {
  const linhas = SCRIPT.split('\n');
  const ytdlp = linhas.map((l, i) => [l, i]).filter(([l]) => /timeout \d+ yt-dlp/.test(l));
  assert.equal(ytdlp.length, 2, 'duas tentativas');
  assert.ok(!ytdlp[0][0].includes('--cookies-from-browser'), 'a primeira é anônima');
  assert.match(ytdlp[0][0], /2>"\$d\/err"/, 'o stderr da primeira fica em arquivo fora da pasta de download');
  assert.ok(ytdlp[1][0].includes('--cookies-from-browser'), 'a segunda usa os cookies');
  const iLogin = linhas.findIndex((l) => /head -c 8192 "\$d\/err" \| grep -qiE "sign in to confirm you\.re not a bot"/.test(l));
  const iPasta = linhas.findIndex((l) => /if \[ ! -d \/home\/agente\/\.tela-chrome\/Default \]/.test(l));
  assert.ok(iLogin > ytdlp[0][1] && iLogin < iPasta && iPasta < ytdlp[1][1], 'ordem: anônima, checagem anti-robô, pasta, cookies');
  assert.match(SCRIPT, /head -c 8192 "\$d\/err" >&2/, 'falha por outro motivo repassa o stderr cortado');
  assert.match(SCRIPT, /find "\$d\/v" -type f -size \+0c/, 'exige arquivo com mais de 0 bytes');
  assert.match(SCRIPT, /-P "\$d\/v"/);
});

test('pasta do Chrome ausente com download anônimo ok dá ok (script de verdade, yt-dlp falso)', () => {
  const { spawnSync } = require('node:child_process');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-falso-'));
  const exec = (corpo) => {
    fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!/bin/sh\n${corpo}\n`, { mode: 0o755 });
    return spawnSync('sh', ['-c', SCRIPT], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  };
  // acha o -P do download e grava um arquivo nele
  const grava = 'while [ $# -gt 0 ]; do if [ "$1" = "-P" ]; then p="$2"; fi; shift; done; echo dado > "$p/v.mp4"';
  if (fs.existsSync('/home/agente/.tela-chrome/Default')) { fs.rmSync(bin, { recursive: true, force: true }); return; }
  let r = exec(grava);
  assert.equal(r.status, 0, r.stderr);
  r = exec('echo "ERROR: Sign in to confirm you\'re not a bot" >&2; exit 1');
  assert.equal(r.status, 66, 'pediu login e a pasta não existe');
  r = exec('echo "ERROR: Sign in to confirm your age" >&2; exit 1');
  assert.equal(r.status, 1, 'restrição de idade não é o desafio anti-robô: não chega à tentativa com cookies');
  r = exec('echo "ERROR: HTTP Error 429" >&2; exit 3');
  assert.equal(r.status, 3, 'outro erro: devolve o código dela');
  assert.match(r.stderr, /429/);
  // mensagem anti-robô DEPOIS dos 8 KiB não libera os cookies; antes do limite libera
  r = exec('head -c 9000 /dev/zero | tr "\\0" "a" >&2; echo >&2; echo "ERROR: Sign in to confirm you\'re not a bot" >&2; exit 3');
  assert.equal(r.status, 3, 'anti-robô depois do limite é ignorado: devolve o código dela');
  r = exec('echo "ERROR: Sign in to confirm you\'re not a bot" >&2; head -c 9000 /dev/zero | tr "\\0" "a" >&2; exit 3');
  assert.equal(r.status, 66, 'anti-robô antes do limite continua valendo');
  r = exec('exit 0');
  assert.equal(r.status, 65, 'saiu 0 sem arquivo');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('ler(): sem identidade de um dos lados ou com instâncias diferentes devolve null', () => {
  const m = monta([]);
  const est = require('../lib/diagnostico/youtube').criarEstadoYoutube(m.ctx);
  est.guardar('tina', { em: AGORA, tipo: 'ok', codigo: null, instancia: 'i:aaa' });
  assert.equal(est.ler('tina', 'i:aaa').tipo, 'ok');
  assert.equal(est.ler('tina', 'i:bbb'), null, 'duas instâncias diferentes do mesmo slug');
  for (const falta of [undefined, null, '']) assert.equal(est.ler('tina', falta), null, 'sem identidade atual');
  for (const falta of [undefined, null, '']) {
    est.guardar('tina', { em: AGORA, tipo: 'ok', codigo: null, instancia: falta });
    assert.equal(est.ler('tina', 'i:aaa'), null, 'sem identidade gravada');
    assert.equal(est.ler('tina', falta), null, 'sem identidade dos dois lados');
  }
  m.limpa();
});

test('código 66 (Tela ainda não aberta) vira sem_perfil', () => {
  assert.deepEqual(classificarYoutube({ codigo: 66, stdout: '', stderr: 'perfil da Tela ausente' }), { tipo: 'sem_perfil' });
});

function monta(respostas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-yt-'));
  let agora = AGORA;
  const chamadas = [];
  const logs = [];
  const ctx = {
    config: { dataDir: dir }, log: (n, m) => logs.push([n, m]), agora: () => agora,
    execSolto: async (cmd, args, opcoes) => { chamadas.push({ cmd, args, opcoes }); const r = respostas.shift() || { codigo: 0, stdout: '', stderr: '', erro: null }; if (r.lanca) throw new Error(r.lanca); return r; },
  };
  const ag = { slug: 'tina', nome: 'Tina', container: 'dgclaw-tina', instancia: 'aaa' };
  // O diagnóstico só LÊ; quem testa é o vigia (aqui, testarYoutube direto).
  const ler = (dep) => tarefaYoutube(ctx, ag, {}).fn(dep || {});
  const testa = async () => testarYoutube(ctx, ag);
  return { ctx, chamadas, logs, dir, ler, testa, avanca: (ms) => { agora += ms; }, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('o diagnóstico só lê: nunca dispara o teste, e sem resultado diz que o teste roda sozinho a cada 6 horas', async () => {
  const m = monta([]);
  const r = await m.ler();
  assert.equal(r.estado, 'nao_medido');
  assert.match(r.motivo, /a cada 6 horas/);
  await m.ler();
  assert.equal(m.chamadas.length, 0);
  m.limpa();
});

test('resultado gravado pelo teste aparece no diagnóstico, com podman exec e -- antes do container', async () => {
  const m = monta([{ codigo: 0, stdout: '', stderr: '', erro: null }]);
  assert.equal(await m.testa(), 'ok');
  const c = m.chamadas[0];
  assert.equal(c.cmd, 'podman');
  assert.deepEqual(c.args.slice(0, 7), ['exec', '--user', 'agente', '-e', 'HOME=/home/agente', '--', 'dgclaw-tina']);
  assert.ok(c.opcoes.timeout >= 60000, 'o download tem prazo próprio, maior que o da verificação');
  m.avanca(12 * H);
  assert.equal((await m.ler()).estado, 'ok', 'dentro da validade (13 h)');
  m.avanca(2 * H);
  const velho = await m.ler();
  assert.equal(velho.estado, 'nao_medido', 'passou de 13 h: o resultado não vale mais');
  assert.match(velho.motivo, /faz mais de 13 horas/);
  assert.equal(velho.ultimo_sinal, require('../lib/diagnostico/util').iso(AGORA), 'diz o horário do último teste');
  assert.equal(m.chamadas.length, 1, 'ler nunca baixa de novo');
  m.limpa();
});

test('pediu login vira atenção com o passo a passo em português, sem falar de conta conectada', async () => {
  const m = monta([{ codigo: 1, stdout: '', stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot", erro: null }]);
  await m.testa();
  const r = await m.ler();
  assert.equal(r.estado, 'atencao');
  assert.match(r.motivo, /pediu login/);
  assert.match(r.motivo, /download do YouTube/);
  assert.ok(!/conta/i.test(r.motivo));
  assert.match(r.o_que_fazer, /Tela/);
  assert.match(r.o_que_fazer, /youtube\.com/);
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /login/.test(t)), 'também fica no log');
  m.limpa();
});

test('sem a pasta da Tela: sem_perfil é atenção e não conta como ok', async () => {
  const m = monta([
    { codigo: 1, stdout: '', stderr: 'Sign in to confirm you\'re not a bot', erro: null },
    { codigo: 66, stdout: '', stderr: 'perfil da Tela ausente', erro: null },
  ]);
  await m.testa();
  await m.testa();
  const v = m.ctx.youtube.ler('tina', 'i:aaa');
  assert.equal(v.tipo, 'sem_perfil');
  const r = await m.ler();
  assert.equal(r.estado, 'atencao');
  assert.match(r.motivo, /pediu login .* a Tela deste agente ainda não foi aberta/);
  m.limpa();
});

test('yt-dlp ausente e outro erro viram atenção; o outro erro mostra só o código de saída', async () => {
  const a = monta([{ codigo: 127, stdout: '', stderr: 'yt-dlp: command not found', erro: null }]);
  await a.testa();
  const ra = await a.ler();
  assert.equal(ra.estado, 'atencao');
  assert.match(ra.motivo, /yt-dlp não existe/);
  a.limpa();
  const b = monta([{ codigo: 1, stdout: '', stderr: 'WARNING: algo\nERROR: HTTP Error 429: Too Many Requests', erro: null }]);
  await b.testa();
  const rb = await b.ler();
  assert.equal(rb.estado, 'atencao');
  assert.match(rb.motivo, /código de saída 1/);
  assert.ok(!/429|WARNING/.test(rb.motivo));
  b.limpa();
});

test('stderr com caminho de cliente não aparece no log, no estado nem na resposta', async () => {
  const stderr = 'ERROR: falhou lendo /home/agente/clientes/acme-secreta/contrato.pdf token=ZZZsegredoZZZ';
  const m = monta([{ codigo: 3, stdout: 'saida em /srv/cliente-fulano/x', stderr, erro: null }]);
  await m.testa();
  const r = await m.ler();
  const tudo = JSON.stringify([m.logs, JSON.parse(fs.readFileSync(path.join(m.dir, 'youtube-saude.json'), 'utf8')), r]);
  assert.ok(!/acme|cliente|segredo|contrato|srv/.test(tudo), tudo);
  assert.match(r.motivo, /código de saída 3/);
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /código de saída 3/.test(t)));
  m.limpa();
});

test('falha de infraestrutura (container não aceitou, podman ausente, erro interno): grava tentativa nao_medido e guarda o último resultado concluído', async () => {
  const m = monta([
    { codigo: 0, stdout: '', stderr: '', erro: null },
    { codigo: 125, stdout: '', stderr: 'Error: no such container dgclaw-tina em /home/cliente-x/secreto', erro: null },
    { codigo: null, stdout: '', stderr: '', erro: 'ENOENT' },
    { lanca: 'quebrou /srv/cliente-y' },
  ]);
  await m.testa();
  m.avanca(MIN);
  assert.equal(await m.testa(), 'nao_medido');
  let v = m.ctx.youtube.ler('tina', 'i:aaa');
  assert.equal(v.tipo, 'nao_medido');
  assert.equal(v.em, AGORA + MIN, 'horário da tentativa');
  assert.deepEqual(v.ultimoConcluido, { em: AGORA, tipo: 'ok', codigo: null });
  const r = await m.ler();
  assert.equal(r.estado, 'nao_medido');
  assert.equal(r.ultimo_sinal, require('../lib/diagnostico/util').iso(AGORA + MIN), 'mostra o horário da tentativa');
  assert.ok(m.logs.some(([n, t]) => n === 'aviso' && /não aceitou o teste/.test(t)));
  m.avanca(MIN);
  await m.testa();
  m.avanca(MIN);
  await m.testa();
  v = m.ctx.youtube.ler('tina', 'i:aaa');
  assert.equal(v.tipo, 'nao_medido');
  assert.equal(v.ultimoConcluido.tipo, 'ok', 'o último concluído continua o mesmo depois de várias tentativas');
  assert.ok(!JSON.stringify(m.logs).includes('cliente-x') && !JSON.stringify(m.logs).includes('cliente-y'));
  m.limpa();
});

test('erro do sistema ao iniciar o podman (EACCES, EMFILE): nao_medido e o último resultado concluído fica', async () => {
  const m = monta([
    { codigo: 0, stdout: '', stderr: '', erro: null },
    { codigo: null, stdout: '', stderr: '', erro: 'EACCES' },
    { codigo: null, stdout: '', stderr: '', erro: 'EMFILE' },
  ]);
  await m.testa();
  for (const cod of ['EACCES', 'EMFILE']) {
    m.avanca(MIN);
    assert.equal(await m.testa(), 'nao_medido', cod);
    const v = m.ctx.youtube.ler('tina', 'i:aaa');
    assert.equal(v.tipo, 'nao_medido', cod);
    assert.deepEqual(v.ultimoConcluido, { em: AGORA, tipo: 'ok', codigo: null }, cod);
    assert.ok(m.logs.some(([n, t]) => n === 'aviso' && t.includes(cod)), cod);
  }
  m.limpa();
});

test('container ou nome fora do padrão: não executa nada e loga mensagem fixa', async () => {
  const m = monta([]);
  for (const ag of [{ slug: 'tina', nome: 'T', container: 'outro-container' }, { slug: 'Tina;rm', nome: 'T', container: 'dgclaw-Tina;rm' }, { slug: 'a b', nome: 'T', container: 'dgclaw-a b' }]) {
    assert.equal(await testarYoutube(m.ctx, ag), null);
  }
  assert.equal(m.chamadas.length, 0);
  assert.equal(m.logs.length, 3);
  assert.ok(!JSON.stringify(m.logs).includes('rm'));
  m.limpa();
});

test('saída enorme é cortada antes da classificação', () => {
  const lixo = 'x'.repeat(LIMITE_SAIDA + 10);
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: `${lixo}\nSign in to confirm you're not a bot` }).tipo, 'outro', 'o sinal depois do limite não é lido');
  assert.equal(classificarYoutube({ codigo: 1, stdout: `${lixo}\ncookies are no longer valid`, stderr: '' }).tipo, 'outro');
  assert.equal(classificarYoutube({ codigo: 1, stdout: '', stderr: `Sign in to confirm you're not a bot\n${lixo}` }).tipo, 'login', 'o que está dentro do limite continua valendo');
});

test('o último resultado sobrevive a reinício do painel (arquivo) e container parado não mostra teste', async () => {
  const m = monta([{ codigo: 0, stdout: '', stderr: '', erro: null }]);
  await m.testa();
  const arq = path.join(m.dir, 'youtube-saude.json');
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).tina.tipo, 'ok');
  assert.equal((fs.statSync(arq).mode & 0o777).toString(8), '600');
  delete m.ctx.youtube; // painel reiniciado: a memória some, o arquivo fica
  assert.equal((await m.ler()).estado, 'ok');
  assert.equal(m.chamadas.length, 1);
  const p = await m.ler({ parado: true });
  assert.equal(p.estado, 'nao_medido');
  m.limpa();
});

// Vigia periódico: só testa; não avisa ninguém no aparelho.
const { criarDiagnostico } = require('../lib/diagnostico');
const LOGIN = { codigo: 1, stdout: '', stderr: 'ERROR: Sign in to confirm you\'re not a bot', erro: null };
const BOM = { codigo: 0, stdout: '', stderr: '', erro: null };

function montaVigia(respostas, agentes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-vigia-'));
  const chamadas = [];
  const logs = [];
  const diag = criarDiagnostico({
    config: { tz: 'America/Sao_Paulo', dataDir: dir },
    registro: { estado: () => ({ ok: true, erro: null, agentes: agentes || [{ slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina' }] }) },
    runner: {}, log: (n, m) => logs.push([n, m]),
    exec: async (cmd, args) => {
      if (cmd !== 'podman' || !args.includes('sh')) return { codigo: 1, stdout: '', stderr: '', erro: null };
      chamadas.push(args[6]); return respostas.shift() || BOM;
    },
    agora: () => AGORA,
  });
  const vigia = diag.vigiarYoutube({ intervaloMs: 1000000 });
  return { dir, diag, vigia, logs, chamadas, limpa: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('vigia: testa cada agente, e um que falha não impede o seguinte', async () => {
  const agentes = [
    { slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina' },
    { slug: 'rui', nome: 'Rui', tipo: 'agente', container: 'dgclaw-rui' },
  ];
  const m = montaVigia([LOGIN, BOM], agentes);
  await m.vigia.rodada();
  assert.deepEqual(m.chamadas, ['dgclaw-tina', 'dgclaw-rui']);
  const arq = JSON.parse(fs.readFileSync(path.join(m.dir, 'youtube-saude.json'), 'utf8'));
  assert.equal(arq.tina.tipo, 'login');
  assert.equal(arq.rui.tipo, 'ok');
  assert.ok(!('avisoPendente' in arq.tina), 'não existe mais marca de aviso pendente');
  m.limpa();
});

test('a coleta do diagnóstico não dispara o teste; só o vigia testa', async () => {
  const m = montaVigia([LOGIN]);
  await m.diag.coletar();
  await m.diag.aguardarSegundoPlano();
  assert.equal(m.chamadas.length, 0, 'abrir o diagnóstico não baixa nada');
  await m.vigia.rodada();
  assert.equal(m.chamadas.length, 1);
  m.limpa();
});

test('resultado de outra instância do agente é descartado: o item fica não medido', async () => {
  const m = monta([BOM]);
  const ag = { slug: 'tina', nome: 'Tina', container: 'dgclaw-tina', instancia: 'aaa' };
  await testarYoutube(m.ctx, ag);
  assert.equal(m.ctx.youtube.ler('tina', 'i:aaa').tipo, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir, 'youtube-saude.json'), 'utf8')).tina.instancia, 'i:aaa');
  assert.equal((await tarefaYoutube(m.ctx, ag, {}).fn({})).estado, 'ok', 'mesma instância: vale');
  const recriado = { ...ag, instancia: 'bbb' };
  const r = await tarefaYoutube(m.ctx, recriado, {}).fn({});
  assert.equal(r.estado, 'nao_medido');
  assert.match(r.motivo, /Ainda não há resultado/);
  m.limpa();
});

test('código 125 do podman é infraestrutura mesmo com texto de login na saída e preserva o último resultado concluído', async () => {
  const m = monta([
    BOM,
    { codigo: 125, stdout: '', stderr: 'Error: can only create exec sessions on running containers: container state improper', erro: null },
    { codigo: 125, stdout: '', stderr: "Sign in to confirm you're not a bot", erro: null },
  ]);
  await m.testa();
  m.avanca(MIN);
  assert.equal(await m.testa(), 'nao_medido');
  m.avanca(MIN);
  assert.equal(await m.testa(), 'nao_medido', '125 vale antes da análise da saída do yt-dlp');
  const v = m.ctx.youtube.ler('tina', 'i:aaa');
  assert.equal(v.tipo, 'nao_medido');
  assert.deepEqual(v.ultimoConcluido, { em: AGORA, tipo: 'ok', codigo: null });
  const r = await m.ler();
  assert.equal(r.estado, 'nao_medido');
  assert.ok(!JSON.stringify(m.logs).includes('exec sessions'), 'o texto do podman não vai para o log');
  m.limpa();
});

test('vigia: primeira rodada 2 minutos depois de iniciar (aqui encurtada) e depois no intervalo; parar cancela', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-timer-'));
  let testes = 0;
  const diag = criarDiagnostico({
    config: { tz: 'America/Sao_Paulo', dataDir: dir },
    registro: { estado: () => ({ ok: true, erro: null, agentes: [{ slug: 'tina', nome: 'Tina', tipo: 'agente', container: 'dgclaw-tina' }] }) },
    runner: {}, log: () => {},
    exec: async (cmd, args) => { if (args.includes('sh')) testes += 1; return BOM; },
    agora: () => AGORA,
  });
  const vigia = diag.vigiarYoutube({ intervaloMs: 60000, primeiraMs: 20 });
  vigia.iniciar();
  assert.equal(testes, 0, 'nada na hora de iniciar');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(testes, 1);
  vigia.parar();
  m_limpa(dir);
});
function m_limpa(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('restrição de idade não é o desafio anti-robô: não vira "login"', () => {
  assert.notEqual(classificarYoutube({ codigo: 1, stdout: '', stderr: 'ERROR: Sign in to confirm your age' }).tipo, 'login');
});

test('código 70 (pasta temporária não criada) é infraestrutura: nao_medido e preserva o último resultado concluído', async () => {
  const m = monta([
    BOM,
    { codigo: 70, stdout: '', stderr: '', erro: null },
  ]);
  await m.testa();
  m.avanca(MIN);
  assert.equal(await m.testa(), 'nao_medido');
  const v = m.ctx.youtube.ler('tina', 'i:aaa');
  assert.equal(v.tipo, 'nao_medido');
  assert.deepEqual(v.ultimoConcluido, { em: AGORA, tipo: 'ok', codigo: null });
  m.limpa();
});
