// test-saude.mjs — o selo que mede a RESPOSTA, os dois reinícios e a sessão de socorro.
//
// Roda contra uma pasta temporária e um "runner" falso (servidor HTTP local que imita
// GET /api/agents/:id, /api/saude, /input, /resume, /revive e DELETE /remove). Nunca
// toca agente de verdade. O Claude da sessão de socorro também é de mentira: um script
// que imprime o stream-json que o `claude -p` imprimiria, e grava os argumentos que
// recebeu, para o teste conferir as travas (--safe-mode, ferramentas, --resume).
//
// O painel não tem node_modules no repo, então este teste não sobe o express: as rotas
// são registradas num roteador de mentira e chamadas direto, com req/res falsos.
//
// `node test-saude.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(new URL(import.meta.url).pathname);

let falhas = 0;
function ok(cond, oQue) {
  if (cond) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a casa do agente e o HOME falsos ─────────────────────────────────────────
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'saude-teste-'));
const HOME = path.join(RAIZ, 'home');
const WS = path.join(RAIZ, 'agente');
fs.mkdirSync(path.join(WS, '.dgclaw', 'logs'), { recursive: true });
process.env.HOME = HOME;
process.env.DGCLAW_SAUDE_CHECAR_LOGIN = 'off';
process.env.DGCLAW_PANEL_PASSWORD = 'senha-que-nao-pode-vazar';
const CARD = 'cardDoTeste';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const pastaTranscripts = path.join(HOME, '.claude', 'projects', path.resolve(WS).replace(/\//g, '-'));
fs.mkdirSync(pastaTranscripts, { recursive: true });

const linha = (o) => `${JSON.stringify(o)}\n`;
fs.writeFileSync(path.join(pastaTranscripts, `${SID}.jsonl`), [
  { type: 'user', timestamp: '2026-10-01T10:00:00Z', sessionId: SID,
    message: { role: 'user', content: '<dgchat from="Dono" chat="c_teste" msg="1" ts="x">bom dia</dgchat>' } },
  { type: 'assistant', timestamp: '2026-10-01T10:00:05Z', sessionId: SID,
    message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'mcp__dgchat__reply', input: { chat: 'c_teste', text: 'bom dia!' } }] } },
  { type: 'user', timestamp: '2026-10-01T10:10:00Z', sessionId: SID,
    message: { role: 'user', content: '<dgchat from="Dono" chat="c_teste" msg="2" ts="x">simula um ataque ao meu site</dgchat>' } },
  { type: 'assistant', timestamp: '2026-10-01T10:10:09Z', sessionId: SID,
    message: { model: 'claude-opus-5-5', stop_reason: 'refusal', content: [{ type: 'thinking', thinking: '' }],
      stop_details: { type: 'refusal', category: 'cyber', explanation: "blocked under Anthropic's Usage Policy (ver /opt/segredo/arquivo.txt)" } } },
].map(linha).join(''));

// ── o runner falso ───────────────────────────────────────────────────────────
const painel = { status: 'idle', sid: SID, chamadas: [] };
const srv = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (d) => { corpo += d; });
  req.on('end', () => {
    painel.chamadas.push(`${req.method} ${req.url}`);
    const responder = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const estado = () => ({ status: painel.status, sessionId: painel.sid, config: { cwd: WS } });
    if (req.url === '/api/saude') return responder(200, { ok: true, agente: { id: CARD } });
    if (req.url === `/api/agents/${CARD}` && req.method === 'GET') return responder(200, { success: true, data: estado() });
    if (req.url === `/api/agents/${CARD}/remove`) { painel.status = 'resumable'; return responder(200, { success: true }); }
    if (req.url === `/api/agents/${CARD}/resume`) { painel.status = 'idle'; return responder(200, { success: true, data: estado() }); }
    if (req.url === `/api/agents/${CARD}/revive`) {
      painel.sid = 'bbbbbbbb-1111-2222-3333-444444444444';
      painel.status = 'spawning';
      setTimeout(() => { painel.status = 'idle'; }, 1200);
      return responder(200, { success: true, data: estado() });
    }
    if (req.url === `/api/agents/${CARD}/input`) {
      const t = JSON.parse(corpo || '{}').text || '';
      fs.appendFileSync(path.join(pastaTranscripts, `${painel.sid}.jsonl`),
        linha({ type: 'user', timestamp: '2026-10-01T12:00:00Z', sessionId: painel.sid, message: { role: 'user', content: t } }));
      return responder(200, { success: true, data: { enviado: true } });
    }
    responder(404, { success: false });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL_RUNNER = `http://127.0.0.1:${srv.address().port}`;

// ── o claude de mentira da sessão de socorro ─────────────────────────────────
const ARGS_LOG = path.join(RAIZ, 'claude-args.jsonl');
const FAKE_CLAUDE = path.join(RAIZ, 'claude');
// Ele responde ao --help como o CLI de verdade (o socorro pergunta se a máquina conhece
// --permission-prompts, que o 2.1.247 da jaula não tem). DGCLAW_FAKE_ANTIGO=1 imita o antigo.
const fakeClaude = (antigo) => `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === '--help') {
  process.stdout.write('Usage: claude [options]\\n  --safe-mode\\n  --tools <tools...>\\n' + (${antigo ? 'false' : 'true'} ? '  --permission-prompts <target>\\n' : ''));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(ARGS_LOG)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n');
const p = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
p({ type: 'system', subtype: 'init', session_id: 'sess-socorro-1' });
p({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat .dgclaw/logs/saude.json' } }] } });
p({ type: 'assistant', message: { content: [{ type: 'text', text: 'Olhei: a Anthropic bloqueou uma resposta. Posso reiniciar em modo de segurança?' }] } });
p({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-socorro-1', total_cost_usd: 0.01, duration_ms: 1200 });
`;
fs.writeFileSync(FAKE_CLAUDE, fakeClaude(false));
fs.chmodSync(FAKE_CLAUDE, 0o755);
const FAKE_ANTIGO = path.join(RAIZ, 'claude-2.1.247');
fs.writeFileSync(FAKE_ANTIGO, fakeClaude(true));
fs.chmodSync(FAKE_ANTIGO, 0o755);

// ── as rotas, num roteador de mentira ────────────────────────────────────────
function montar(configExtra) {
  const rotas = {};
  const router = { get: (p, h) => { rotas[`GET ${p}`] = h; }, post: (p, h) => { rotas[`POST ${p}`] = h; } };
  const CONFIG = {
    agentSlug: 'teste', agentName: 'Agente de Teste', agentDir: WS, creatorName: 'Dono de Teste',
    bunkerCard: CARD, bunkerUrl: URL_RUNNER, claudeBin: FAKE_CLAUDE, ...configExtra,
  };
  const conversa = { estado: async () => ({ viva: true, chave: 'pronto', frase: 'pronta', cardStatus: 'idle', podeReativar: false }) };
  require('./lib/rotas-saude')(router, { CONFIG, conversa, serverDir: AQUI });
  async function chamar(metodo, rota, { body, query } = {}) {
    const h = rotas[`${metodo} ${rota}`];
    if (!h) throw new Error(`rota ${metodo} ${rota} nao registrada`);
    return new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, corpo: o }); } };
      Promise.resolve(h({ body: body || {}, query: query || {} }, res));
    });
  }
  return chamar;
}

process.env.DGCLAW_INJECT_MODE = 'bunker';
const chamar = montar({});

console.log('\nGET /api/saude');
let r = await chamar('GET', '/api/saude');
ok(r.status === 200, 'responde 200');
for (const campo of ['viva', 'chave', 'frase', 'cardStatus', 'motivo', 'podeReativar']) {
  ok(campo in r.corpo, `mantém o campo de sempre "${campo}" (a tela de hoje usa)`);
}
const d = r.corpo.diagnostico || {};
ok(d.estado === 'inativo' && d.tipo === 'recusa' && d.recomendacao === 'modo_seguro',
  `diagnostico: recusa vira inativo + modo_seguro (veio ${d.estado}/${d.tipo}/${d.recomendacao})`);
for (const campo of ['estado', 'tipo', 'frase', 'trecho', 'desde', 'ocorrencias', 'recomendacao', 'comoResolver', 'sessionId', 'verificadoEm']) {
  ok(campo in d, `diagnostico tem "${campo}" (contrato)`);
}
const tudo = JSON.stringify(r.corpo);
ok(!tudo.includes(WS) && !tudo.includes(HOME), 'nenhum caminho do servidor desce para o navegador');
ok(!tudo.includes('/opt/segredo'), 'caminho citado DENTRO do trecho também é tirado');
ok(r.corpo.modoSeguro && r.corpo.modoSeguro.ativo === false, 'modoSeguro desligado antes de qualquer reinício');

// Prova por contagem, não por relógio: o cache devolve o MESMO objeto, e uma medição
// nova seria outro objeto, com outro verificadoEm (o Python grava até o microssegundo).
// Medir o tempo da segunda leitura falhava com a máquina carregada.
const rCache = await chamar('GET', '/api/saude');
ok(rCache.corpo.diagnostico === r.corpo.diagnostico && rCache.corpo.diagnostico.verificadoEm === d.verificadoEm,
  `a segunda leitura sai do cache (20 s), sem rodar o diagnóstico de novo (verificadoEm ${d.verificadoEm} e ${rCache.corpo.diagnostico && rCache.corpo.diagnostico.verificadoEm})`);

console.log('\nPOST /api/saude/reiniciar');
r = await chamar('POST', '/api/saude/reiniciar', { body: { modo: 'qualquer' } });
ok(r.status === 400 && /normal/.test(r.corpo.howToFix || ''), 'modo desconhecido: 400 com o que fazer');

painel.chamadas = [];
r = await chamar('POST', '/api/saude/reiniciar', { body: { modo: 'normal' } });
ok(r.status === 200 && r.corpo.reiniciado === true, `normal: 200 (veio ${r.status} ${JSON.stringify(r.corpo).slice(0, 160)})`);
ok(painel.chamadas.includes(`DELETE /api/agents/${CARD}/remove`) && painel.chamadas.includes(`POST /api/agents/${CARD}/resume`),
  'normal no runner: para o terminal e retoma a MESMA conversa');
ok(!painel.chamadas.includes(`POST /api/agents/${CARD}/revive`), 'normal nunca abre conversa nova');

painel.chamadas = [];
r = await chamar('POST', '/api/saude/reiniciar', { body: { modo: 'seguro' } });
ok(r.status === 202 && r.corpo.iniciado === true, `seguro: 202, roda em segundo plano (veio ${r.status})`);
const r2 = await chamar('POST', '/api/saude/reiniciar', { body: { modo: 'seguro' } });
ok(r2.status === 409, 'pedir de novo enquanto roda: 409 com o motivo');
let marca = null;
for (let i = 0; i < 60; i++) {
  try {
    marca = JSON.parse(fs.readFileSync(path.join(WS, '.dgclaw', 'modo-seguro.json'), 'utf-8'));
    if (marca.recado && marca.recado.entregue) break;
  } catch { /* ainda nao gravou */ }
  await dormir(500);
}
ok(marca && marca.ativo, 'a marca do modo de segurança foi gravada');
ok(marca && marca.recado && marca.recado.entregue, 'o recado foi entregue na sessão nova');
ok(painel.chamadas.includes(`POST /api/agents/${CARD}/revive`), 'seguro: conversa NOVA (/revive)');
await dormir(300);
r = await chamar('GET', '/api/saude');
ok(r.corpo.modoSeguro && r.corpo.modoSeguro.ativo === true, '/api/saude mostra o modo de segurança ligado');
ok(r.corpo.modoSeguro && r.corpo.modoSeguro.quarentena && /ataque/.test(r.corpo.modoSeguro.quarentena.trechoDaMensagem || ''),
  'o dono vê qual mensagem foi para a quarentena');
ok(!JSON.stringify(r.corpo.modoSeguro).includes(WS), 'a marca desce sem caminho do servidor');

console.log('\nSessão de socorro');
r = await chamar('POST', '/api/socorro/mensagem', { body: { texto: '' } });
ok(r.status === 400, 'mensagem vazia: 400');
r = await chamar('POST', '/api/socorro/mensagem', { body: { texto: 'aconteceu alguma coisa com meu agente, vê aí' } });
ok(r.status === 202, `primeira mensagem aceita (veio ${r.status} ${JSON.stringify(r.corpo)})`);
let est;
for (let i = 0; i < 40; i++) {
  est = (await chamar('GET', '/api/socorro/estado')).corpo;
  if (!est.respondendo && est.eventos.some((e) => e.tipo === 'fim')) break;
  await dormir(150);
}
const tipos = est.eventos.map((e) => e.tipo);
ok(tipos.join(',') === 'voce,ferramenta,socorro,fim', `eventos em ordem (veio ${tipos.join(',')})`);
ok(est.eventos.find((e) => e.tipo === 'ferramenta').texto.startsWith('rodou um comando'), 'a ferramenta aparece resumida em português');
let chamadas = fs.readFileSync(ARGS_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
const a1 = chamadas[0].argv;
ok(a1.includes('--safe-mode'), 'roda com --safe-mode (sem o CLAUDE.md e os hooks do agente)');
ok(a1[a1.indexOf('--tools') + 1] === 'Read,Grep,Glob,Bash', 'só Read, Grep, Glob e Bash');
ok(a1.includes('--permission-prompts') && a1[a1.indexOf('--permission-prompts') + 1] === 'none', 'o que pediria permissão é negado');
ok(a1[a1.indexOf('--model') + 1] === 'sonnet', 'sonnet por padrão');
ok(!a1.includes('--resume'), 'a primeira mensagem abre sessão nova');
const prompt = a1[a1.indexOf('--append-system-prompt') + 1];
ok(/PERGUNT|posso fazer/i.test(prompt) && /PARE/.test(prompt), 'o prompt manda perguntar antes de mudar qualquer coisa');
ok(/EMERGENCIA\.md/.test(prompt), 'o prompt aponta o manual de emergência');
ok(path.resolve(chamadas[0].cwd) !== path.resolve(WS), 'o cwd NÃO é a casa do agente (transcript separado)');
ok(!chamadas[0].env.includes('DGCLAW_PANEL_PASSWORD'), 'a senha do painel não entra no ambiente do socorro');
ok(fs.readdirSync(path.join(WS, '.dgclaw', 'socorro')).some((f) => f.endsWith('.jsonl')), 'o histórico fica em .dgclaw/socorro/<data>.jsonl');

r = await chamar('POST', '/api/socorro/mensagem', { body: { texto: 'sim, pode' } });
for (let i = 0; i < 40; i++) {
  est = (await chamar('GET', '/api/socorro/estado')).corpo;
  if (!est.respondendo && est.eventos.filter((e) => e.tipo === 'fim').length >= 2) break;
  await dormir(150);
}
chamadas = fs.readFileSync(ARGS_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
const a2 = chamadas[1].argv;
ok(a2.includes('--resume') && a2[a2.indexOf('--resume') + 1] === 'sess-socorro-1', 'a segunda mensagem continua a mesma sessão (--resume)');
const parcial = (await chamar('GET', '/api/socorro/estado', { query: { desde: String(est.ultimo - 1) } })).corpo;
ok(parcial.eventos.length === 1, '?desde= devolve só o que é novo (polling barato)');

r = await chamar('POST', '/api/socorro/encerrar');
est = (await chamar('GET', '/api/socorro/estado')).corpo;
ok(r.corpo.encerrada && !est.ativa && est.eventos.length === 0, 'encerrar esquece a sessão');
// Espera a chamada aparecer no registro (um tempo fixo falhava com a máquina ocupada).
const lerChamadas = () => fs.readFileSync(ARGS_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
async function esperarChamadas(n) {
  for (let i = 0; i < 100 && lerChamadas().length < n; i++) await dormir(100);
  return lerChamadas();
}
await chamar('POST', '/api/socorro/mensagem', { body: { texto: 'de novo' } });
chamadas = await esperarChamadas(3);
ok(!chamadas[2].argv.includes('--resume'), 'depois de encerrar, a próxima mensagem começa do zero');

// CLI antigo (o da jaula): sem --permission-prompts, e o socorro precisa rodar mesmo assim.
const antigo = montar({ claudeBin: FAKE_ANTIGO });
r = await antigo('POST', '/api/socorro/mensagem', { body: { texto: 'cli antigo' } });
ok(r.status === 202, `CLI antigo: a mensagem é aceita (veio ${r.status})`);
chamadas = await esperarChamadas(4);
const aAntigo = chamadas[chamadas.length - 1].argv;
ok(aAntigo.includes('cli antigo') && !aAntigo.includes('--permission-prompts') && aAntigo.includes('--safe-mode'),
  'CLI sem --permission-prompts: a flag fica de fora e o resto continua igual');

const desligado = montar({ socorro: false });
r = await desligado('POST', '/api/socorro/mensagem', { body: { texto: 'oi' } });
ok(r.status === 403 && /config\.json/.test(r.corpo.howToFix || ''), 'socorro: false no config desliga, com o motivo');

srv.close();
// O modo de seguranca roda em segundo plano; espera ele soltar a pasta antes de apagar.
await dormir(500);
fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
