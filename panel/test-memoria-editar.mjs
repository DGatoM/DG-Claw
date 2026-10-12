// test-memoria-editar.mjs — a edição à mão da memória, e as recusas que a protegem.
//
// Roda contra uma pasta temporária, nunca contra a casa de um agente de verdade.
// Confere as cinco travas descritas no topo de lib/memoria.js:
//   1. só se lê e se grava dentro do agentDir, fora das pastas internas e de
//      segredo (o cofre!), fora dos blockedFiles e sem seguir link simbólico;
//   2. 409 quando o arquivo mudou desde que foi lido, sem gravar nada;
//   3. gravação atômica (temporário + rename): no meio do caminho, quem lê vê o
//      arquivo velho INTEIRO, e uma falha no meio deixa o original intacto;
//   4. o arquivo continua com as permissões de antes;
//   5. a versão anterior vai para .dgclaw/backups/memoria/ (as 20 últimas) e a
//      edição fica anotada em .dgclaw/logs/edicoes-memoria.jsonl.
//
// No fim, se o express estiver instalado (ou DGCLAW_TEST_NODE_PATH apontar para um
// node_modules com ele), sobe o painel de verdade numa porta local e repete as
// recusas principais por HTTP, que é por onde um navegador pediria.
//
// `node test-memoria-editar.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildMemoria } = require('./lib/memoria.js');
const { buildSanitizer } = require('./lib/sanitize.js');

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const RAIZ = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-teste-')));
const FORA = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-fora-'));
const escrever = (rel, txt, modo) => {
  const abs = path.join(RAIZ, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, txt);
  if (modo) fs.chmodSync(abs, modo);
};
escrever('working-memory.md', '# Working Memory\n\n## Agora\n- quinta 10h\n\n## Objetivos do Paulo\n- lançar o canal\n\n## Tarefas em andamento\n- [ ] roteiro do banco\n');
escrever('MEMORY.md', '# Índice\n\n- **18/08** nasci\n', 0o640);
escrever('memory/preferencias.md', '- gosta de PDF\n');
escrever('memory/relacoes.json', '{"dono":{"nome":"Paulo"}}');
escrever('memory/2026-09-30.md', '# Diário\n\nfoi um dia calmo\n');
escrever('memory/secreto.md', 'não pode abrir\n');
escrever('LAWS.md', '# Leis\n', 0o444);
escrever('.dgclaw/cofre.chave', 'CHAVE-MESTRA-DE-TESTE');
escrever('.dgclaw/cofre/segredos/x.enc', 'blob');
escrever('.claude/projects/s.jsonl', '{}');
fs.writeFileSync(path.join(FORA, 'alvo.md'), 'segredo de fora do agente');
fs.symlinkSync(path.join(FORA, 'alvo.md'), path.join(RAIZ, 'memory', 'atalho.md'));

const config = { agentDir: RAIZ, agentSlug: 'teste', blockedFiles: ['memory/secreto.md'] };
const mem = buildMemoria(config);
const { isPathAllowed } = buildSanitizer(config);

console.log('\nLeitura: o que NÃO pode abrir');
for (const [p, porque] of [
  ['.dgclaw/cofre.chave', 'a chave mestra do cofre'],
  ['.dgclaw/cofre/segredos/x.enc', 'segredo cifrado do cofre'],
  ['.claude/projects/s.jsonl', 'transcript da sessão'],
  ['../' + path.basename(FORA) + '/alvo.md', 'fora do agentDir por ../'],
  [path.join(FORA, 'alvo.md'), 'fora do agentDir por caminho absoluto'],
  ['memory/atalho.md', 'link simbólico que leva para fora'],
  ['memory/secreto.md', 'está nos blockedFiles do config'],
]) {
  ok(!isPathAllowed(p), `sanitizador recusa ${p} (${porque})`);
  const r = mem.ler(p);
  ok(r.status === 403 || r.status === 400, `leitor recusa ${p} com ${r.status}`);
  ok(!JSON.stringify(r).includes('CHAVE-MESTRA') && !JSON.stringify(r).includes('segredo de fora'), `e a recusa não vaza o conteúdo de ${p}`);
}

console.log('\nLeitura: o que pode');
{
  const r = mem.ler('working-memory.md');
  ok(r.status === 200 && r.corpo.editavel && typeof r.corpo.versao === 'string', 'working-memory.md abre, editável, com versão');
  ok(/remontada toda manhã/.test(r.corpo.aviso || ''), 'e com o aviso de que ela é remontada toda manhã');
  const leis = mem.ler('LAWS.md');
  ok(leis.status === 200 && leis.corpo.editavel === false && /imutáveis/.test(leis.corpo.motivoNaoEditavel), 'LAWS.md abre, mas como só leitura, com o motivo');
}

console.log('\nRaio-X');
{
  const c = mem.cerebro();
  const wm = c.cartoes.find((x) => x.path === 'working-memory.md');
  ok(!!wm, 'tem o cartão da memória de trabalho');
  ok(wm && wm.destaques.some((d) => d.titulo === 'Objetivos do dono' && /lançar/.test(d.markdown)), '"## Objetivos do Paulo" vira o destaque "Objetivos do dono"');
  ok(wm && wm.faltamSecoesNovas.includes('Últimas conversas'), 'e diz quais seções novas ainda não existem');
  ok(c.cartoes.some((x) => x.path === 'memory/relacoes.json' && /```json/.test(x.previa)), 'JSON aparece formatado num bloco de código');
  ok(!c.cartoes.some((x) => x.path.includes('secreto') || x.path.includes('atalho')), 'arquivo bloqueado e link simbólico não viram cartão');
  ok(c.camadas.find((x) => x.id === 'diarios').arquivos === 1, 'a camada de diários conta 1 arquivo');
}

console.log('\nGravação: recusas');
const lida = mem.ler('working-memory.md').corpo;
for (const [p, porque] of [
  ['../' + path.basename(FORA) + '/alvo.md', 'fora do agentDir'],
  ['memory/secreto.md', 'blockedFiles'],
  ['.dgclaw/cofre.chave', 'o cofre'],
  ['memory/atalho.md', 'link simbólico para fora'],
  ['LAWS.md', 'lei imutável'],
  ['AGENT.md', 'fora da lista de editáveis'],
]) {
  const r = mem.gravar({ path: p, conteudo: 'invadido', versaoLida: 'qualquer' });
  ok(r.status >= 400 && r.status < 500, `gravar ${p} é recusado (${porque}) com ${r.status}`);
}
ok(fs.readFileSync(path.join(FORA, 'alvo.md'), 'utf8') === 'segredo de fora do agente', 'o arquivo de fora continua intacto');
ok(fs.readFileSync(path.join(RAIZ, '.dgclaw/cofre.chave'), 'utf8') === 'CHAVE-MESTRA-DE-TESTE', 'a chave do cofre continua intacta');
{
  const r = mem.gravar({ path: 'working-memory.md', conteudo: 'x', versaoLida: '' });
  ok(r.status === 400, 'sem versão lida, recusa (400)');
  const j = mem.gravar({ path: 'memory/relacoes.json', conteudo: '{"dono": ', versaoLida: mem.ler('memory/relacoes.json').corpo.versao });
  ok(j.status === 400 && /JSON válido/.test(j.erro), 'JSON quebrado é recusado antes de gravar');
  ok(fs.readFileSync(path.join(RAIZ, 'memory/relacoes.json'), 'utf8') === '{"dono":{"nome":"Paulo"}}', 'e o JSON original continua lá');
}

console.log('\nGravação: conflito (409)');
{
  const antes = mem.ler('MEMORY.md').corpo;
  // O agente escreve no arquivo enquanto o dono edita.
  fs.appendFileSync(path.join(RAIZ, 'MEMORY.md'), '- **01/10** o agente escreveu isto agora\n');
  const r = mem.gravar({ path: 'MEMORY.md', conteudo: '# Índice\n\n- editado à mão\n', versaoLida: antes.versao });
  ok(r.status === 409, 'arquivo mudou desde a leitura: 409');
  ok(/mudou enquanto você editava/.test(r.erro) && r.versaoAtual, 'com o motivo em português e a versão atual');
  ok(/o agente escreveu isto agora/.test(fs.readFileSync(path.join(RAIZ, 'MEMORY.md'), 'utf8')), 'e o que o agente escreveu NÃO foi apagado');
}

console.log('\nGravação: sucesso, cópia, registro e permissões');
{
  const atual = mem.ler('MEMORY.md').corpo;
  const novo = atual.conteudo + '- **01/10** corrigido pelo dono\n';
  let lidoNoMeio = null;
  const r = mem.gravar({ path: 'MEMORY.md', conteudo: novo, versaoLida: atual.versao }, {
    antesDoRename: () => { lidoNoMeio = fs.readFileSync(path.join(RAIZ, 'MEMORY.md'), 'utf8'); },
  });
  ok(r.status === 200 && r.corpo.ok, 'grava com a versão certa');
  ok(lidoNoMeio === atual.conteudo, 'atômico: no meio da gravação o arquivo ainda é o velho INTEIRO');
  ok(fs.readFileSync(path.join(RAIZ, 'MEMORY.md'), 'utf8') === novo, 'e depois é o novo inteiro');
  ok((fs.statSync(path.join(RAIZ, 'MEMORY.md')).mode & 0o777) === 0o640, 'as permissões do original (640) foram mantidas');
  ok(!fs.readdirSync(RAIZ).some((f) => f.includes('.painel-')), 'nenhum temporário sobrou na pasta');
  const backup = path.join(RAIZ, r.corpo.backup);
  ok(fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') === atual.conteudo, 'a versão anterior foi guardada em .dgclaw/backups/memoria/');
  const log = fs.readFileSync(path.join(RAIZ, '.dgclaw/logs/edicoes-memoria.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ult = log[log.length - 1];
  ok(ult.path === 'MEMORY.md' && ult.versaoDepois === r.corpo.versao, 'a edição foi anotada no registro');
  ok(!JSON.stringify(log).includes('corrigido pelo dono'), 'o registro guarda o quê e quando, nunca o conteúdo');
  ok(mem.ler('MEMORY.md').corpo.autoria.voceFoiOUltimo === true, 'e o leitor sabe que a última mão foi do dono');
}
{
  const atual = mem.ler('memory/preferencias.md').corpo;
  const r = mem.gravar({ path: 'memory/preferencias.md', conteudo: 'quebrado no meio', versaoLida: atual.versao }, {
    antesDoRename: () => { throw new Error('disco cheio de mentira'); },
  });
  ok(r.status === 500 && /original ficou como estava/.test(r.erro), 'falha no meio da gravação: 500 com o motivo');
  ok(fs.readFileSync(path.join(RAIZ, 'memory/preferencias.md'), 'utf8') === '- gosta de PDF\n', 'e o original ficou intacto');
  ok(!fs.readdirSync(path.join(RAIZ, 'memory')).some((f) => f.includes('.painel-')), 'e o temporário foi apagado');
}
{
  let versao = mem.ler('memory/preferencias.md').corpo.versao;
  for (let i = 0; i < 25; i++) {
    const r = mem.gravar({ path: 'memory/preferencias.md', conteudo: `- versão ${i}\n`, versaoLida: versao }, { agora: new Date(Date.UTC(2026, 9, 1, 12, 0, i)) });
    versao = r.corpo.versao;
  }
  const copias = fs.readdirSync(path.join(RAIZ, '.dgclaw/backups/memoria')).filter((f) => f.startsWith('memory__preferencias.md.'));
  ok(copias.length === 20, `25 gravações guardam só as 20 últimas cópias (ficaram ${copias.length})`);
}

// ─── por HTTP, com o painel de verdade ───────────────────────────────────────
async function porHttp() {
  const nodePath = process.env.DGCLAW_TEST_NODE_PATH || process.env.NODE_PATH || '';
  try {
    if (nodePath) require(path.join(nodePath, 'express'));
    else require.resolve('express');
  } catch {
    console.log('\nPor HTTP: PULADO (o express não está instalado aqui; rode `npm install` no panel ou passe DGCLAW_TEST_NODE_PATH=<node_modules>)');
    return;
  }
  console.log('\nPor HTTP (o painel de verdade, numa porta local)');
  const cfgPath = path.join(RAIZ, 'painel-teste.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ agentName: 'Teste', agentSlug: 'teste', agentDir: RAIZ, authSalt: 'sal-de-teste', blockedFiles: ['memory/secreto.md'] }));
  const porta = 18000 + Math.floor(Math.random() * 1500);
  const servidor = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'server.js')], {
    env: { ...process.env, DGCLAW_PANEL_CONFIG: cfgPath, DGCLAW_PANEL_PORT: String(porta), DGCLAW_PANEL_PASSWORD: 'senha-teste', DGCLAW_PANEL_HOST: '127.0.0.1', NODE_PATH: nodePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  servidor.stdout.on('data', (d) => { saida += d; });
  servidor.stderr.on('data', (d) => { saida += d; });
  const base = `http://127.0.0.1:${porta}`;
  try {
    for (let i = 0; i < 50 && !/rodando/.test(saida); i++) await new Promise((r) => setTimeout(r, 100));
    ok(/rodando/.test(saida), 'o painel subiu');
    const login = await fetch(`${base}/login`, { method: 'POST', body: 'password=senha-teste', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(cookie.startsWith('dash_token='), 'entrou com a senha');
    const pedir = (url, opcoes = {}) => fetch(base + url, { ...opcoes, headers: { ...(opcoes.headers || {}), Cookie: cookie } });

    const cofre = await pedir('/api/memory/file?path=' + encodeURIComponent('.dgclaw/cofre.chave'));
    const cofreTexto = await cofre.text();
    ok(cofre.status === 403 && !cofreTexto.includes('CHAVE-MESTRA'), 'a rota ANTIGA /api/memory/file não entrega mais a chave do cofre');
    const segredo = await pedir('/api/memory/file?path=' + encodeURIComponent('.dgclaw/cofre/segredos/x.enc'));
    ok(segredo.status === 403, 'nem o segredo cifrado');
    const atalho = await pedir('/api/memory/file?path=' + encodeURIComponent('memory/atalho.md'));
    ok(atalho.status === 403 && !(await atalho.text()).includes('segredo de fora'), 'nem segue link simbólico para fora');
    const nova = await pedir('/api/memoria/arquivo?path=' + encodeURIComponent('.dgclaw/cofre.chave'));
    ok(nova.status === 403, 'a rota nova recusa o cofre também');

    const leitura = await (await pedir('/api/memoria/arquivo?path=working-memory.md')).json();
    fs.appendFileSync(path.join(RAIZ, 'working-memory.md'), '- linha do agente\n');
    const conflito = await pedir('/api/memoria/arquivo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'working-memory.md', conteudo: 'por cima', versaoLida: leitura.versao }) });
    const corpo = await conflito.json();
    ok(conflito.status === 409 && corpo.error && corpo.howToFix, 'PUT com versão velha: 409 com error e howToFix');
    const fresca = await (await pedir('/api/memoria/arquivo?path=working-memory.md')).json();
    const salvo = await pedir('/api/memoria/arquivo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'working-memory.md', conteudo: fresca.conteudo + '- do dono\n', versaoLida: fresca.versao }) });
    ok(salvo.status === 200 && (await salvo.json()).backup, 'PUT com a versão certa grava e devolve onde ficou a cópia');
    const cer = await pedir('/api/cerebro');
    ok(cer.status === 200 && Array.isArray((await cer.json()).cartoes), 'GET /api/cerebro responde');
    const radio = await pedir('/api/radiografia');
    ok(radio.status === 200 && typeof (await radio.json()).ausente === 'boolean', 'GET /api/radiografia responde (com ou sem o texto)');
    const ops = await pedir('/api/operacoes');
    const opsCorpo = await ops.json();
    ok(ops.status === 200 && opsCorpo.resumo && typeof opsCorpo.resumo.frase === 'string', `GET /api/operacoes responde (${opsCorpo.resumo && opsCorpo.resumo.frase})`);
    const usu = await pedir('/api/rotinas/usuario');
    ok(usu.status === 200 && Array.isArray((await usu.json()).rotinas), 'GET /api/rotinas/usuario responde');
  } finally {
    servidor.kill();
  }
}

await porHttp();

fs.rmSync(RAIZ, { recursive: true, force: true });
fs.rmSync(FORA, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
