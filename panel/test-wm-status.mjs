// test-wm-status.mjs — o cartão "Memória de trabalho" da aba Status diz a verdade?
//
// Monta agentes de mentira numa pasta temporária, com relógio fixo e um systemctl
// falso, e confere cada estado que a tela promete: em dia, atrasada (não rodou,
// falhou, parada), ausente, vazia, e o "não consegui ver" quando nada dá para medir.
// O ponto mais importante é o último: o que não foi medido sai `null`, nunca zero.
//
// Também desenha o cartão (js/wm-status.js) com um `fetch` de mentira, para conferir
// que a tela escreve "não consegui ver" e não um número inventado.
//
// `node test-wm-status.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(new URL(import.meta.url).pathname);
const { buildWmStatus, registrar } = require('./lib/wm-status');

let falhas = 0;
function ok(cond, oQue, extra) {
  if (cond) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}${extra !== undefined ? `\n         ${JSON.stringify(extra)}` : ''}`); falhas++; }
}

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-status-teste-'));
let n = 0;
function agente({ wm, pulso, plugin = true, claudeMd, legado = false, hookTeto } = {}) {
  const ws = path.join(RAIZ, `a${++n}`);
  fs.mkdirSync(path.join(ws, '.dgclaw', 'logs'), { recursive: true });
  if (wm !== undefined) {
    const arq = legado ? path.join(ws, 'persona', 'working-memory.md') : path.join(ws, 'working-memory.md');
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, wm);
  }
  if (pulso) {
    const dir = path.join(ws, '.dgclaw', 'logs', 'pulso');
    fs.mkdirSync(dir, { recursive: true });
    for (const [dia, linhas] of Object.entries(pulso)) {
      fs.writeFileSync(path.join(dir, `${dia}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
  }
  if (plugin) {
    fs.mkdirSync(path.join(ws, '.dgclaw', 'plugin', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.dgclaw', 'plugin', 'scripts', 'build-working-memory.py'), 'BRT = 1\nMAX_BYTES = 1000\n');
  }
  if (hookTeto) {
    fs.mkdirSync(path.join(ws, '.dgclaw', 'plugin', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.dgclaw', 'plugin', 'hooks', 'session-context.sh'), `        TETO = ${hookTeto}  # comentario\n`);
  }
  if (claudeMd) fs.writeFileSync(path.join(ws, 'CLAUDE.md'), claudeMd);
  return ws;
}

// systemctl de mentira: devolve o que o teste mandar, por unidade.
function systemctlFalso(unidades) {
  return async (unidade) => (unidades === null ? null : (unidades[unidade] || { LoadState: 'not-found' }));
}
const relogio = (iso) => () => new Date(iso);
const TIMER_ANTIGO = {
  'dgclaw-t-build-wm.timer': { LoadState: 'loaded', ActiveState: 'active', ActiveEnterTimestamp: 'Fri 2026-10-02 18:29:10 -03', NextElapseUSecRealtime: 'Tue 2026-10-06 07:00:00 -03' },
};
const st = (ws, agoraIso, unidades = TIMER_ANTIGO, extra = {}) =>
  buildWmStatus({ agentDir: ws, agentSlug: 't', timezoneOffsetHours: -3, ...extra }, { agora: relogio(agoraIso), systemctl: systemctlFalso(unidades) }).status();

const WM = (agora, pend = 'Responder o fornecedor X. Aguardando o dono.') => [
  '# Working Memory de Teste', '',
  `⚡ PENDÊNCIAS ATIVAS: ${pend}`, '',
  '## Agora', `- **Agora:** segunda, ${agora}`, '',
  '## Hoje', '- revisei a proposta (ação)', '',
].join('\n');

// ── em dia ──────────────────────────────────────────────────────────────────
console.log('\nem dia');
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [{ ts: '2026-10-05T07:00:03-03:00', id: 'build-wm', status: 'ok', detalhe: '' }] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'em-dia', 'remontagem de hoje no pulso + Agora há 10 min = em dia', r.estado);
  ok(r.remontagem.rodouHoje === true && /07:00/.test(r.remontagem.frase), 'diz que rodou hoje às 07:00', r.remontagem.frase);
  ok(r.idadeMin === 10 && r.idadeTexto === 'há 10 min', 'idade conta da linha "Agora", não da data do arquivo', r.idadeMin);
  ok(r.atualizadaFonte.includes('Agora'), 'diz que a data veio da linha Agora');
  ok(r.teto.bytes === 1000 && /MAX_BYTES/.test(r.teto.fonte), 'teto lido do MAX_BYTES do script instalado', r.teto);
  ok(r.ocupacaoPct === Math.round((Buffer.byteLength(fs.readFileSync(path.join(ws, 'working-memory.md'), 'utf8')) / 1000) * 100), 'ocupação = bytes / teto');
  ok(r.arquivo.caracteres < r.arquivo.bytes, 'caracteres e bytes são números diferentes (acento ocupa 2 bytes)');
  ok(r.pendencias.texto === 'Responder o fornecedor X. Aguardando o dono.' && r.pendencias.nenhuma === false, 'lê a linha ⚡ PENDÊNCIAS ATIVAS');
  ok(r.remontagem.fontes.includes('registro do pulso') && r.remontagem.fontes.includes('systemd'), 'lista as fontes que conferiu', r.remontagem.fontes);
}

// ── antes das 7h ────────────────────────────────────────────────────────────
console.log('\nantes das 7h');
{
  const ws = agente({ wm: WM('05/10/2026 06:20'), pulso: { '2026-10-04': [{ ts: '2026-10-04T07:00:01-03:00', id: 'build-wm', status: 'ok' }], '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T06:30:00-03:00');
  ok(r.estado === 'em-dia', 'às 6h30 a falta da de hoje não é atraso', r.estado);
  ok(r.remontagem.rodouHoje === null, 'rodouHoje fica null (ainda não era hora), não false');
  ok(/ontem às 07:00/.test(r.remontagem.frase), 'conta que a última foi ontem às 07:00', r.remontagem.frase);
}

// ── atrasada: não rodou ─────────────────────────────────────────────────────
console.log('\natrasada');
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-04': [{ ts: '2026-10-04T07:00:01-03:00', id: 'build-wm', status: 'ok' }], '2026-10-05': [{ ts: '2026-10-05T09:43:00-03:00', id: 'heartbeat', status: 'ok' }] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'atrasada' && r.remontagem.rodouHoje === false, 'às 10h sem build-wm hoje = atrasada', r);
  ok(r.causa && r.oQueFazer, 'traz a causa e o que fazer');
  ok(/ontem às 07:00/.test(r.causa), 'a causa diz quando foi a última', r.causa);
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [{ ts: '2026-10-05T07:00:02-03:00', id: 'build-wm', status: 'erro', detalhe: 'python saiu com 1' }] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'atrasada' && r.remontagem.falhou === true, 'build-wm com erro hoje = atrasada (falhou)', r.remontagem);
  ok(/python saiu com 1/.test(r.causa), 'a causa carrega o detalhe do erro', r.causa);
}
{
  const ws = agente({ wm: WM('05/10/2026 02:00'), pulso: { '2026-10-05': [{ ts: '2026-10-05T07:00:02-03:00', id: 'build-wm', status: 'ok' }] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'atrasada' && /batimento/.test(r.causa), 'linha Agora parada há 8 h = atrasada, culpa do batimento', r.causa);
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', {});
  ok(r.estado === 'atrasada' && r.remontagem.semTimer === true, 'sem timer e sem registro = atrasada, falta o timer', r.remontagem);
  ok(/install-timers/.test(r.oQueFazer), 'diz o que instalar');
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T13:00:00-03:00', {
    'dgclaw-t-build-wm.timer': { LoadState: 'loaded', ActiveEnterTimestamp: 'Mon 2026-10-05 11:56:41 -03', NextElapseUSecRealtime: 'Tue 2026-10-06 07:00:00 -03' },
    'dgclaw-t-build-wm.service': { ExecMainExitTimestamp: '', ExecMainStatus: '0', Result: 'success' },
  });
  ok(r.remontagem.rodouHoje === null && /11:56/.test(r.remontagem.frase), 'timer ligado hoje depois das 7h: não é atraso, diz quando roda', r.remontagem.frase);
  ok(r.estado === 'em-dia', 'e o estado continua em dia', r.estado);
}
{
  // o systemd sabe que rodou mesmo com o registro do pulso calado
  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', {
    ...TIMER_ANTIGO,
    'dgclaw-t-build-wm.service': { ExecMainExitTimestamp: 'Mon 2026-10-05 07:00:04 -03', ExecMainStatus: '0', Result: 'success' },
  });
  ok(r.remontagem.rodouHoje === true && r.estado === 'em-dia', 'systemd sozinho já prova que rodou', r.remontagem);
}

// ── ausente, vazia ──────────────────────────────────────────────────────────
console.log('\nausente e vazia');
{
  const ws = agente({ pulso: { '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'ausente' && r.arquivo.existe === false, 'sem arquivo = ausente');
  ok(r.arquivo.caracteres === null && r.ocupacaoPct === null && r.idadeMin === null, 'ausente: tamanho, ocupação e idade são null, não zero', r);
  ok(r.causa && r.oQueFazer, 'ausente traz causa e o que fazer');
}
{
  const ws = agente({ wm: '  \n', pulso: { '2026-10-05': [] } });
  const r = await st(ws, '2026-10-05T10:00:00-03:00');
  ok(r.estado === 'vazia', 'arquivo só com espaço = vazia', r.estado);
}

// ── não medido ──────────────────────────────────────────────────────────────
console.log('\nnão medido');
{
  const ws = agente({ wm: WM('05/10/2026 09:50') });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.remontagem.rodouHoje === null && r.remontagem.fontes.length === 0, 'sem pulso, sem systemctl: rodouHoje null', r.remontagem);
  ok(/Não consigo ver/.test(r.remontagem.frase), 'e diz que não consegue ver', r.remontagem.frase);
  ok(r.estado === 'em-dia', 'não medir a remontagem não vira atraso', r.estado);
}
{
  const ws = agente({ wm: `${WM('05/10/2026 09:50')}\n<!-- virada do dia: 2026-10-05 -->\n` });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.remontagem.rodouHoje === true && r.remontagem.fontes.includes('marca no arquivo'), 'a marca "virada do dia" de hoje basta', r.remontagem);
}
{
  const log = path.join(RAIZ, 'build-wm.log');
  fs.writeFileSync(log, 'ok\n');
  fs.utimesSync(log, new Date('2026-10-05T07:00:05-03:00'), new Date('2026-10-05T07:00:05-03:00'));
  const ws = agente({ wm: WM('05/10/2026 09:50') });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null, { wmRebuildLog: log });
  ok(r.remontagem.rodouHoje === true && r.remontagem.fontes.includes('log da remontagem'), 'log configurado (cron, como a Isa) conta', r.remontagem);
}

// ── tetos e caminho antigo ──────────────────────────────────────────────────
console.log('\ntetos e caminho antigo');
{
  const ws = agente({ wm: `# WM\n*Ocupação: 100B/6500B*\n${WM('05/10/2026 09:50', '(nenhuma ativa. resumo)')}`, plugin: false, legado: true });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.arquivo.caminho === path.join('persona', 'working-memory.md'), 'acha persona/working-memory.md', r.arquivo.caminho);
  ok(r.teto.bytes === 6500 && /Ocupação/.test(r.teto.fonte), 'sem script, usa o teto escrito no cabeçalho', r.teto);
  ok(r.pendencias.nenhuma === true, '"(nenhuma ...)" conta como nenhuma pendência');
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), plugin: false });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.teto.bytes === 9000 && /fábrica/.test(r.teto.fonte), 'sem nada para ler, o teto de fábrica, e diz que é de fábrica', r.teto);
  ok(r.tetoInicioSessao.caracteres === null && r.tetoInicioSessao.inteira === null, 'sem import nem hook: não sabe quanto chega, e diz', r.tetoInicioSessao);
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50'), claudeMd: '# agente\n\n@MEMORY.md\n@working-memory.md\n', hookTeto: 14000 });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.tetoInicioSessao.inteira === true, 'CLAUDE.md com @working-memory.md: entra inteira', r.tetoInicioSessao);
}
{
  const grande = WM('05/10/2026 09:50') + 'x'.repeat(200);
  const ws = agente({ wm: grande, hookTeto: 100 });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.tetoInicioSessao.caracteres === 100, 'sem import, lê o TETO do hook instalado', r.tetoInicioSessao);
  ok(r.avisos.some((a) => /100 caracteres/.test(a)), 'avisa quando passa do que chega ao começo da conversa', r.avisos);
}
{
  const ws = agente({ wm: WM('05/10/2026 09:50') + 'y'.repeat(1200) });
  const r = await st(ws, '2026-10-05T10:00:00-03:00', null);
  ok(r.ocupacaoPct > 100 && r.avisos.some((a) => /wm-transbordo/.test(a)), 'passou do teto: avisa que o excesso vai para o transbordo', r.avisos);
}

// ── a rota ──────────────────────────────────────────────────────────────────
console.log('\na rota');
{
  const ws = agente({ wm: WM('05/10/2026 09:50') });
  const rotas = {};
  registrar({ get: (url, fn) => { rotas[url] = fn; } }, { CONFIG: { agentDir: ws, agentSlug: 'teste-sem-timer-xyz', timezoneOffsetHours: -3 } });
  ok(typeof rotas['/api/working-memory/status'] === 'function', 'registra GET /api/working-memory/status');
  let corpo; let status = 200;
  await rotas['/api/working-memory/status']({ query: {} }, { json: (o) => { corpo = o; }, status(s) { status = s; return this; } });
  ok(status === 200 && corpo && corpo.arquivo && corpo.arquivo.existe === true, 'responde 200 com o estado', { status, corpo });
}

// ── o cartão ────────────────────────────────────────────────────────────────
console.log('\no cartão');
{
  const fonte = fs.readFileSync(path.join(AQUI, 'public/js/wm-status.js'), 'utf8');
  const janela = { DGCLAW_BASE: '' };
  let resposta;
  const fetchFalso = async () => ({ ok: true, status: 200, json: async () => resposta });
  new Function('window', 'fetch', 'document', fonte)(janela, fetchFalso, { querySelector: () => null });
  const el = { innerHTML: '', querySelector: () => null };

  const ws = agente({ wm: WM('05/10/2026 09:50'), pulso: { '2026-10-05': [{ ts: '2026-10-05T07:00:03-03:00', id: 'build-wm', status: 'ok' }] } });
  resposta = await st(ws, '2026-10-05T10:00:00-03:00');
  await janela.DGWmStatus.carregar(el);
  ok(/Em dia/.test(el.innerHTML) && /rodou hoje/.test(el.innerHTML), 'desenha o selo e a remontagem');
  ok(/Responder o fornecedor X/.test(el.innerHTML), 'desenha as pendências');
  ok(/aba Memória/.test(el.innerHTML), 'tem o link para a aba Memória');
  ok((el.innerHTML.match(/title="/g) || []).length >= 6, 'cada rótulo tem tooltip');

  const ws2 = agente({ wm: 'sem linha agora\n' });
  resposta = await st(ws2, '2026-10-05T10:00:00-03:00', null);
  resposta.atualizadaEm = null; // força o "não medido" da idade
  await janela.DGWmStatus.carregar(el);
  ok(/não consegui ver/.test(el.innerHTML), 'o que não foi medido aparece como "não consegui ver"');
  ok(!/>0%</.test(el.innerHTML) && !/>0 caracteres/.test(el.innerHTML), 'e nunca como zero');

  resposta = await st(agente({}), '2026-10-05T10:00:00-03:00');
  await janela.DGWmStatus.carregar(el);
  ok(/Ausente/.test(el.innerHTML) && /O que fazer/.test(el.innerHTML), 'ausente aparece com o que fazer');
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO CERTO');
process.exit(falhas ? 1 : 0);
