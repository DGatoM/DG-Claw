// test-sessoes-local.mjs: a aba Sessões em modo local fala certo com o runner e não vaza nada?
//
// POR QUE ESTE TESTE EXISTE. No modo local o painel decide coisas que antes eram do DG Telegram:
// qual estado de cada card, quem pode aprovar um pedido, de onde saem os documentos. Os defeitos
// que custam caro são silenciosos: um agente aprovando o próprio pedido com a chave de API, um
// documento de fora da casa saindo pela tela, a lista vazia com status 200 quando o runner caiu,
// o token do runner aparecendo numa resposta. Tudo roda contra um RUNNER FALSO em porta
// aleatória (o runner real, porta 4300, nunca é chamado).
//
// `node test-sessoes-local.mjs` na pasta do painel.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
// Gerado a cada execução: nenhum valor fixo de credencial no repositório.
const SEGREDO_DO_RUNNER = crypto.randomBytes(24).toString('hex');

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const RAIZ = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessoes-local-')));
const arquivoToken = path.join(RAIZ, 'runner.token');
fs.writeFileSync(arquivoToken, `${SEGREDO_DO_RUNNER}\n`, { mode: 0o600 });
const REGISTRO = path.join(RAIZ, '.dgclaw', 'panel', 'sessoes-local.json');

function portaLivre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ─── o runner falso ──────────────────────────────────────────────────────────
const agora = Date.now();
const sessoes = new Map();
const chamadas = [];
const flags = { limite: false, semLogin: false, soClaude: false, runnerAntigo: false };
let proximoId = 1;

function nova(id, over) {
  const s = {
    id, config: { name: id, cwd: RAIZ }, status: 'idle', sessionId: `sid-${id}`, lastMessage: null,
    pendingPermission: null, createdAt: agora - 100000, updatedAt: agora - 5000, lastActivatedAt: agora - 5000,
    sessao: { papel: 'paralela', tipo: 'card', chat: `c_${id}`, titulo: `Titulo ${id}`, fila: 0 },
    msgs: [],
  };
  Object.assign(s, over);
  sessoes.set(id, s);
  return s;
}
function resetar() {
  sessoes.clear();
  nova('luna', { sessao: { papel: 'principal', tipo: undefined, chat: 'c_luna', titulo: undefined, fila: 0 }, msgs: [{ role: 'assistant', text: 'Oi, estou aqui.' }] });
  nova('card-a1', { status: 'working', updatedAt: agora - 1000, lastActivatedAt: agora - 1000, msgs: [{ role: 'user', text: 'faça X' }, { role: 'assistant', text: 'Fazendo X agora com acentuação ✓' }] });
  nova('card-w1', { status: 'waiting_input', pendingPermission: { toolName: 'Bash', toolInput: {}, toolUseId: 't1', description: 'Rodar rm -rf build', timestamp: agora }, msgs: [{ role: 'assistant', text: 'Preciso de permissão.' }] });
  nova('card-f1', { status: 'resumable', updatedAt: agora - 90000, lastActivatedAt: agora - 90000, msgs: [{ role: 'assistant', text: 'Terminei a análise.' }] });
  nova('card-e1', { status: 'errored', config: { name: 'e1', cwd: RAIZ }, error: 'o CLI caiu' });
  nova('bast', { status: 'resumable', sessao: { papel: 'paralela', tipo: 'bastidores', chat: 'c_bast', titulo: 'Bastidores', fila: 0 } });
  nova('card-i1', { status: 'idle', msgs: [{ role: 'assistant', text: 'Pronto.' }] });
  nova('card-h1', {
    status: 'idle', sessao: { papel: 'paralela', tipo: 'card', chat: 'c_h1', titulo: 'Card do handoff', fila: 0 },
    msgs: [{ role: 'assistant', text: '▶️ ATIVA [VPS] - Projeto Z: etapa 2\n\n```\nContinue o projeto Z a partir da etapa 2.\nArquivos: a.md\n```\n\n✅ ENCERRADA [VPS] - Projeto Z: etapa 1 concluída' }],
  });
  proximoId = 1;
}

async function subirRunner() {
  const srv = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (b) => pedacos.push(b));
    req.on('end', () => {
      const corpoTxt = Buffer.concat(pedacos).toString('utf-8');
      let corpo = null;
      try { corpo = corpoTxt ? JSON.parse(corpoTxt) : null; } catch { /* sem json */ }
      const url = new URL(req.url, 'http://x');
      const caminho = url.pathname;
      chamadas.push({ metodo: req.method, caminho, query: url.search, corpo, auth: req.headers.authorization });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${SEGREDO_DO_RUNNER}`) return json(401, { success: false, error: 'sem token', code: 'NAO_AUTORIZADO' });
      const vista = (s) => { const { msgs, ...resto } = s; return resto; };
      if (caminho === '/api/agents' && url.searchParams.get('todas') === '1') return json(200, { success: true, data: [...sessoes.values()].map(vista) });
      if (caminho === '/api/provedor') return json(200, { sessao: 'luna', provedor: 'claude', auth: 'assinatura', modelo: 'sonnet-teste', ...(flags.runnerAntigo ? {} : { disponiveis: flags.soClaude ? ['claude'] : ['claude', 'codex'] }) });
      if (caminho === '/api/sessoes' && req.method === 'POST') {
        if (flags.limite) return json(429, { success: false, error: 'Já existem 8 sessões criadas por API e o limite é 8. Não criei outra.', howToFix: 'fechar uma', code: 'LIMITE_DE_SESSOES' });
        const id = `card-n${proximoId++}`;
        const s = nova(id, { status: 'resumable', sessao: { papel: 'paralela', tipo: corpo.tipo || 'card', chat: `c_${id}`, titulo: corpo.titulo, fila: 0 }, sessionId: null });
        return json(201, { success: true, data: vista(s) });
      }
      const del = /^\/api\/sessoes\/([^/]+)$/.exec(caminho);
      if (del && req.method === 'DELETE') {
        if (!sessoes.has(del[1])) return json(404, { success: false, error: 'não existe', code: 'SESSAO_INEXISTENTE' });
        sessoes.delete(del[1]);
        return json(200, { success: true, data: { removida: true } });
      }
      const m = /^\/api\/agents\/([^/]+)\/([a-z-]+)$/.exec(caminho);
      if (m) {
        const s = sessoes.get(m[1]);
        if (!s) return json(404, { success: false, error: 'outro runner', code: 'AGENTE_DE_OUTRO_RUNNER' });
        if (m[2] === 'conversation') return json(200, { success: true, data: s.msgs.slice(-Number(url.searchParams.get('limit') || 6)) });
        if (m[2] === 'input') {
          if (flags.semLogin) return json(409, { success: false, error: 'sem login', howToFix: 'entrar', code: 'SEM_LOGIN' });
          if (!corpo.injectWhenIdle && corpo.submit !== false && s.status === 'resumable') return json(202, { success: true, data: { enfileirado: true, acordando: true } });
          if (s.status === 'resumable' || s.status === 'stopped' || s.status === 'errored') return json(409, { success: false, error: 'sem terminal', code: 'NO_PTY' });
          return json(corpo.injectWhenIdle ? 202 : 200, { success: true, data: {} });
        }
        if (m[2] === 'permissao') { s.status = 'working'; s.pendingPermission = null; return json(200, { success: true, data: { decisao: corpo.decisao } }); }
        if (m[2] === 'resume') { s.status = 'idle'; return json(200, { success: true, data: vista(s) }); }
        if (m[2] === 'revive') { s.status = 'idle'; return json(200, { success: true, data: vista(s) }); }
        if (m[2] === 'suspend') { s.status = 'resumable'; return json(200, { success: true, data: vista(s) }); }
      }
      return json(404, { success: false, error: `rota ${caminho}`, code: 'ROTA_INEXISTENTE' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, porta: srv.address().port };
}

// ─── o painel ────────────────────────────────────────────────────────────────
async function subirPainel(portaRunner, envExtra = {}, cfgExtra = {}) {
  const porta = await portaLivre();
  const cfgPath = path.join(RAIZ, `painel-${porta}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    agentName: 'Teste', agentSlug: 'luna', agentDir: RAIZ, authSalt: 'sal-de-teste',
    bunkerUrl: `http://127.0.0.1:${portaRunner}`, runnerTokenFile: arquivoToken, ...cfgExtra,
  }));
  const env = { ...process.env, DGCLAW_PANEL_CONFIG: cfgPath, DGCLAW_PANEL_PORT: String(porta), DGCLAW_PANEL_PASSWORD: 'senha-teste', DGCLAW_PANEL_HOST: '127.0.0.1' };
  for (const k of Object.keys(env)) if (k.startsWith('DGCLAW_PANEL_SESSOES') || k === 'RUNNER_TOKEN_FILE' || k === 'DGCLAW_BUNKER_URL') delete env[k];
  Object.assign(env, envExtra);
  const proc = spawn(process.execPath, [path.join(AQUI, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  proc.stdout.on('data', (d) => { saida += d; });
  proc.stderr.on('data', (d) => { saida += d; });
  for (let i = 0; i < 80 && !/rodando/.test(saida); i++) await new Promise((r) => setTimeout(r, 100));
  if (!/rodando/.test(saida)) throw new Error(`o painel não subiu: ${saida}`);
  const base = `http://127.0.0.1:${porta}`;
  const login = await fetch(`${base}/login`, { method: 'POST', body: 'password=senha-teste', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const p = {
    porta, base, cookie, saida: () => saida, parar: () => proc.kill(),
    // Como a tela: cookie e Origin do próprio painel nas escritas.
    pedir: (url, op = {}) => {
      const h = { ...(op.headers || {}), Cookie: cookie };
      if (op.method && op.method !== 'GET' && !('Origin' in h)) h.Origin = base;
      return fetch(base + url, { ...op, headers: h });
    },
    json: (url, corpo, op = {}) => p.pedir(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(op.headers || {}) }, body: JSON.stringify(corpo === undefined ? {} : corpo) }),
  };
  return p;
}

const lerJson = async (r) => {
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* não é JSON */ }
  return { status: r.status, json, txt, headers: r.headers };
};
const achar = (metodo, re) => chamadas.filter((c) => c.metodo === metodo && re.test(c.caminho));
const lerRegistro = () => JSON.parse(fs.readFileSync(REGISTRO, 'utf-8'));

resetar();
const { srv: runnerSrv, porta: portaRunner } = await subirRunner();
const servidores = [];

try {
  const p = await subirPainel(portaRunner);
  servidores.push(p);
  const chaveResp = await lerJson(await p.json('/api/chaves-api', { nome: 'agente-teste' }));
  const CHAVE_API = chaveResp.json && (chaveResp.json.token || chaveResp.json.chave);
  ok(typeof CHAVE_API === 'string' && CHAVE_API.startsWith('dgc_'), 'criei uma chave de API de teste pelo login');
  const comChave = (url, op = {}) => fetch(p.base + url, { ...op, headers: { Authorization: `Bearer ${CHAVE_API}`, ...(op.headers || {}) } });
  const chavePost = (url, corpo) => comChave(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo === undefined ? {} : corpo) });

  console.log('\n1. Configuração: modo local ligado de fábrica');
  {
    const c = await lerJson(await p.pedir('/api/sessoes-config'));
    ok(c.status === 200 && c.json.ligado === true && c.json.modo === 'local' && c.json.agente === 'luna' && c.json.appUrl === null && c.json.soLeitura === false, '/api/sessoes-config: ligado, modo local, agente, sem appUrl');
  }

  console.log('\n2. Lista: grupos, contagem, última fala e filtros');
  {
    const r = await lerJson(await p.pedir('/api/sessoes?grupo=todos'));
    const por = Object.fromEntries((r.json.itens || []).map((i) => [i.id, i]));
    ok(r.status === 200 && r.json.ok === true && r.json.fonte.id === 'local' && r.json.fonte.recursos.apagar === true && r.json.fonte.recursos.link_externo === false, 'resposta no contrato, fonte local com recursos');
    ok(por['card-w1'].grupo === 'esperando_voce' && por['card-w1'].estado === 'pedindo_permissao' && /rm -rf/.test(por['card-w1'].pedido), 'waiting_input vira esperando_voce com o pedido');
    ok(por['card-a1'].grupo === 'trabalhando' && por['card-a1'].tem_terminal === true, 'working vira trabalhando');
    ok(por['card-i1'].grupo === 'concluido' && por['card-i1'].tem_terminal === true, 'idle vira concluido');
    ok(por['card-e1'].grupo === 'erro' && /o CLI caiu/.test(por['card-e1'].motivo), 'errored vira erro com o motivo do runner');
    ok(por['card-f1'].grupo === 'fechado' && por['card-f1'].tem_terminal === false && /dormindo/.test(por['card-f1'].motivo), 'resumable vira fechado: dormindo');
    ok(por.luna.papel === 'principal' && por.bast.papel === 'bastidores' && por['card-a1'].papel === 'card', 'papéis: principal, bastidores e card');
    ok(por['card-a1'].ultima_fala && por['card-a1'].ultima_fala.texto === 'Fazendo X agora com acentuação ✓' && por['card-a1'].ultima_fala.fonte === 'transcript', 'ultima_fala vem da última mensagem do assistente');
    ok(por['card-a1'].nome === 'Titulo card-a1', 'sem registro, o nome é o título do runner');
    ok(r.json.contagem.esperando_voce === 1 && r.json.contagem.trabalhando === 1 && r.json.contagem.fechado === 2 && r.json.contagem.erro === 1 && r.json.contagem.arquivado === 0, 'contagem por grupo');
    ok(r.json.itens[0].id === 'card-w1', 'quem espera você vem primeiro');
    const ativos = await lerJson(await p.pedir('/api/sessoes'));
    ok(!ativos.json.itens.some((i) => i.grupo === 'fechado'), 'ativos não traz os fechados');
    const q = await lerJson(await p.pedir('/api/sessoes?grupo=todos&q=T%C3%8DTULO%20CARD-A1'));
    ok(q.json.itens.length === 1 && q.json.itens[0].id === 'card-a1', 'filtro q ignora acento e maiúscula');
    const ruim = await lerJson(await p.pedir('/api/sessoes?grupo=bobagem'));
    ok(ruim.status === 400 && /todos/.test(ruim.json.como_resolver), 'grupo inválido: 400 dizendo os válidos');
    const lim = await lerJson(await p.pedir('/api/sessoes?limite=0'));
    ok(lim.status === 400, 'limite inválido: 400');
  }

  console.log('\n3. Um card e a conversa');
  {
    const r = await lerJson(await p.pedir('/api/sessoes/card-a1'));
    ok(r.status === 200 && r.json.item.id === 'card-a1' && r.json.fonte.id === 'local', 'GET um card');
    const nao = await lerJson(await p.pedir('/api/sessoes/card-zzz'));
    ok(nao.status === 404 && nao.json.ok === false, 'card que não existe: 404');
    sessoes.get('card-a1').msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
    const c1 = await lerJson(await p.pedir('/api/sessoes/card-a1/conversa?limite=5'));
    ok(c1.json.mensagens.map((m) => m.texto).join() === 'm7,m8,m9,m10,m11' && c1.json.antes === 5 && c1.json.truncado === true, 'conversa: as 5 últimas, com antes=5');
    const c2 = await lerJson(await p.pedir('/api/sessoes/card-a1/conversa?limite=5&before=5'));
    ok(c2.json.mensagens.map((m) => m.texto).join() === 'm2,m3,m4,m5,m6' && c2.json.antes === 10, 'conversa: página anterior sem repetir');
    sessoes.get('card-a1').msgs = [{ role: 'user', text: 'faça X' }, { role: 'assistant', text: 'Fazendo X agora com acentuação ✓' }];
  }

  console.log('\n4. Criar');
  {
    const antes = chamadas.length;
    const r = await lerJson(await p.json('/api/sessoes', { nome: 'Revisar contrato', prompt: 'Leia o contrato e resuma.', pasta: '.' }));
    const novas = chamadas.slice(antes);
    ok(r.status === 201 && r.json.item && r.json.item.nome === 'Revisar contrato', '201 com o item e o nome escolhido');
    const post = novas.find((c) => c.metodo === 'POST' && c.caminho === '/api/sessoes');
    ok(post && post.corpo.provedor === 'claude' && post.corpo.auth === 'assinatura' && post.corpo.modelo === 'sonnet-teste' && post.corpo.titulo === 'Revisar contrato', 'provedor, forma de pagar e modelo copiados da principal');
    const inp = novas.find((c) => c.caminho.endsWith('/input'));
    ok(inp && inp.corpo.submit === true && inp.corpo.text.includes('Leia o contrato e resuma.') && inp.corpo.text.startsWith(`Pasta de trabalho: ${RAIZ}.`), 'prompt entregue por /input, com a pasta como primeira linha');
    const reg = lerRegistro();
    ok(reg[r.json.item.id].nome === 'Revisar contrato' && reg[r.json.item.id].criado_por === 'tela' && reg[r.json.item.id].pasta === RAIZ, 'registro guarda nome, criado_por e pasta');
    ok((fs.statSync(REGISTRO).mode & 0o777) === 0o600, 'o registro tem permissão 600');
    ok(!fs.readdirSync(path.dirname(REGISTRO)).some((f) => f.endsWith('.tmp')), 'a escrita atômica não deixa arquivo temporário');

    const fora = await lerJson(await p.json('/api/sessoes', { nome: 'x', prompt: 'y', pasta: '/etc' }));
    ok(fora.status === 400 && /fora da casa/.test(fora.json.erro), 'pasta fora da casa: 400');
    const naoHa = await lerJson(await p.json('/api/sessoes', { nome: 'x', prompt: 'y', pasta: 'nao-existe' }));
    ok(naoHa.status === 400 && /não existe/.test(naoHa.json.erro), 'pasta que não existe: 400');
    ok((await lerJson(await p.json('/api/sessoes', { nome: '', prompt: 'y' }))).status === 400, 'sem nome: 400');
    ok((await lerJson(await p.json('/api/sessoes', { nome: 'a', prompt: '' }))).status === 400, 'sem prompt: 400');

    // escolha do provedor do card (Claude ou Codex)
    const pv = await lerJson(await p.pedir('/api/sessoes/provedores'));
    ok(pv.status === 200 && pv.json.principal === 'claude' && pv.json.disponiveis.map((x) => x.id).join() === 'claude,codex' && pv.json.disponiveis[1].nome === 'Codex', 'GET /api/sessoes/provedores: principal e os disponíveis, com nome');
    const a1 = chamadas.length;
    const cx = await lerJson(await p.json('/api/sessoes', { nome: 'No Codex', prompt: 'olá', provedor: 'codex' }));
    const postCx = chamadas.slice(a1).find((c) => c.metodo === 'POST' && c.caminho === '/api/sessoes');
    ok(cx.status === 201 && postCx.corpo.provedor === 'codex' && !('auth' in postCx.corpo) && !('modelo' in postCx.corpo), 'provedor codex: repassado ao runner, sem a forma de pagar e o modelo do Claude');
    const a2 = chamadas.length;
    await p.json('/api/sessoes', { nome: 'Claude explícito', prompt: 'olá', provedor: 'claude' });
    const postCl = chamadas.slice(a2).find((c) => c.metodo === 'POST' && c.caminho === '/api/sessoes');
    ok(postCl.corpo.provedor === 'claude' && postCl.corpo.modelo === 'sonnet-teste', 'provedor igual ao da principal: mantém forma de pagar e modelo');
    const ruim = await lerJson(await p.json('/api/sessoes', { nome: 'x', prompt: 'y', provedor: 'gemini' }));
    ok(ruim.status === 400 && ruim.json.code === 'PROVEDOR_INVALIDO' && /claude, codex/.test(ruim.json.como_resolver) && /gemini/.test(ruim.json.erro), 'provedor que não vale: 400 em português dizendo quais valem');
    ok((await lerJson(await p.json('/api/sessoes', { nome: 'x', prompt: 'y', provedor: 5 }))).status === 400, 'provedor que não é texto: 400');
    flags.soClaude = true;
    const so = await lerJson(await p.json('/api/sessoes', { nome: 'x', prompt: 'y', provedor: 'codex' }));
    const pv1 = await lerJson(await p.pedir('/api/sessoes/provedores'));
    flags.soClaude = false;
    ok(so.status === 400 && /claude\b/.test(so.json.como_resolver) && !/codex,/.test(so.json.como_resolver) && pv1.json.disponiveis.length === 1, 'só o Claude disponível: codex é recusado e a lista tem um só');
    flags.runnerAntigo = true;
    const pv2 = await lerJson(await p.pedir('/api/sessoes/provedores'));
    flags.runnerAntigo = false;
    ok(pv2.json.disponiveis.map((x) => x.id).join() === 'claude', 'runner antigo (sem "disponiveis"): só o provedor da principal');

    flags.limite = true;
    const lim = await lerJson(await p.json('/api/sessoes', { nome: 'a', prompt: 'b' }));
    flags.limite = false;
    ok(lim.status === 429 && /limite é 8/.test(lim.json.erro) && /Apagar/.test(lim.json.como_resolver), '429 do runner vira 429 com o limite e como liberar vaga');

    flags.semLogin = true;
    const total = sessoes.size;
    const sl = await lerJson(await p.json('/api/sessoes', { nome: 'sem login', prompt: 'b' }));
    flags.semLogin = false;
    ok(sl.status === 409 && sessoes.size === total, 'sem login: erro do runner e o card recém criado é fechado');

    const viaChave = await lerJson(await chavePost('/api/sessoes', { nome: 'Pela chave', prompt: 'olá' }));
    ok(viaChave.status === 201 && lerRegistro()[viaChave.json.item.id].criado_por === 'chave:agente-teste', 'criar com chave de API: criado_por chave:<nome>, sem exigir Origin');
  }

  console.log('\n5. Recado');
  {
    const antes = chamadas.length;
    const a = await lerJson(await p.json('/api/sessoes/card-a1/recado', { texto: 'continue', quando: 'agora' }));
    const ia = chamadas.slice(antes).find((c) => c.caminho === '/api/agents/card-a1/input');
    ok(a.status === 200 && a.json.enviado === true && ia.corpo.submit === true && ia.corpo.text === 'continue', 'agora: /input com submit');
    const b = await lerJson(await p.json('/api/sessoes/card-a1/recado', { texto: 'depois', quando: 'quando_livre' }));
    const ib = chamadas.filter((c) => c.caminho === '/api/agents/card-a1/input').pop();
    ok(b.status === 202 && b.json.enfileirado === true && ib.corpo.injectWhenIdle === true, 'quando_livre: /input com injectWhenIdle, 202');
    const c = await lerJson(await p.json('/api/sessoes/card-w1/recado', { texto: 'oi' }));
    ok(c.status === 409 && /decidir/.test(c.json.erro) && /Aprove ou negue/.test(c.json.como_resolver), 'esperando_voce: 409 mandando decidir primeiro');
    const d = await lerJson(await p.json('/api/sessoes/card-f1/recado', { texto: 'acorda' }));
    ok(d.status === 409 && /retomar/.test(d.json.como_resolver), 'fechado sem retomar: 409 com como_resolver citando retomar');
    const n = chamadas.length;
    const e = await lerJson(await p.json('/api/sessoes/card-f1/recado', { texto: 'acorda', retomar: true }));
    const novas = chamadas.slice(n).filter((c) => c.metodo === 'POST');
    ok(e.status === 202 && e.json.retomado === true && novas[0].caminho === '/api/agents/card-f1/resume' && novas[1].corpo.injectWhenIdle === true, 'retomar:true: resume e depois recado quando livre');
    sessoes.get('card-f1').status = 'resumable';
    const f = await lerJson(await chavePost('/api/sessoes/card-a1/recado', { texto: 'da chave' }));
    const ic = chamadas.filter((x) => x.caminho === '/api/agents/card-a1/input').pop();
    ok(f.status === 200 && ic.corpo.text === '[recado de agente-teste pelo painel] da chave', 'chave de API: o recado leva o prefixo com o nome da chave');
    ok((await lerJson(await p.json('/api/sessoes/card-a1/recado', { texto: '   ' }))).status === 400, 'texto vazio: 400');
    ok((await lerJson(await p.json('/api/sessoes/card-a1/recado', { texto: 'x', quando: 'ontem' }))).status === 400, 'quando inválido: 400');
  }

  console.log('\n6. Decidir');
  {
    const n = chamadas.length;
    const r = await lerJson(await p.json('/api/sessoes/card-w1/decidir', { acao: 'aprovar' }));
    const perm = chamadas.slice(n).find((c) => c.caminho === '/api/agents/card-w1/permissao');
    ok(r.status === 200 && perm && perm.corpo.decisao === 'aprovar', 'login humano aprova: /permissao com decisao aprovar');
    sessoes.get('card-w1').status = 'waiting_input';
    sessoes.get('card-w1').pendingPermission = { toolName: 'Bash', toolInput: {}, toolUseId: 't1', description: 'Rodar rm -rf build', timestamp: agora };
    const n2 = chamadas.length;
    const k = await lerJson(await chavePost('/api/sessoes/card-w1/decidir', { acao: 'aprovar' }));
    ok(k.status === 403 && /não decide pedidos/.test(k.json.erro) && !chamadas.slice(n2).some((c) => c.caminho.endsWith('/permissao')), 'chave de API: 403 e nada chega ao runner');
    ok((await lerJson(await p.json('/api/sessoes/card-w1/decidir', { acao: 'talvez' }))).status === 400, 'ação inválida: 400');
    const nao = await lerJson(await p.json('/api/sessoes/card-a1/decidir', { acao: 'negar' }));
    ok(nao.status === 409, 'card sem pedido esperando: 409');
    const neg = await lerJson(await p.json('/api/sessoes/card-w1/decidir', { acao: 'negar' }));
    ok(neg.status === 200 && achar('POST', /card-w1\/permissao/).pop().corpo.decisao === 'negar', 'negar vira decisao negar');
    sessoes.get('card-w1').status = 'waiting_input';
  }

  console.log('\n7. Arquivar, desarquivar e apagar');
  {
    const n = chamadas.length;
    const r = await lerJson(await p.json('/api/sessoes/card-i1/arquivar'));
    ok(r.status === 200 && r.json.terminal_parado === true && chamadas.slice(n).some((c) => c.caminho === '/api/agents/card-i1/suspend'), 'arquivar suspende o terminal');
    const reg = lerRegistro()['card-i1'];
    ok(reg.arquivado && reg.arquivado.por === 'tela' && reg.arquivado.quando, 'registro marca arquivado com quando e por');
    const lista = await lerJson(await p.pedir('/api/sessoes?grupo=arquivado'));
    ok(lista.json.itens.length === 1 && lista.json.itens[0].id === 'card-i1' && lista.json.contagem.arquivado === 1, 'filtro arquivado mostra o card e a contagem');
    ok(!(await lerJson(await p.pedir('/api/sessoes?grupo=todos'))).json.itens.some((i) => i.id === 'card-i1'), 'arquivado sai das outras listas');
    ok((await lerJson(await p.json('/api/sessoes/card-a1/apagar'))).status === 409, 'apagar card que não está arquivado: 409');
    ok((await lerJson(await p.json('/api/sessoes/luna/arquivar'))).status === 409, 'arquivar a principal: 409');
    ok((await lerJson(await p.json('/api/sessoes/bast/arquivar'))).status === 409, 'arquivar bastidores: 409');
    const ap = await lerJson(await p.json('/api/sessoes/luna/apagar'));
    ok(ap.status === 409 && /principal/.test(ap.json.erro), 'apagar a principal: 409 com o motivo');
    const des = await lerJson(await p.json('/api/sessoes/card-i1/desarquivar'));
    ok(des.status === 200 && lerRegistro()['card-i1'].arquivado === null, 'desarquivar tira a marca');
    ok((await lerJson(await p.json('/api/sessoes/card-i1/desarquivar'))).status === 404, 'desarquivar de novo: 404');
    await p.json('/api/sessoes/card-i1/arquivar');
    const ap2 = await lerJson(await p.json('/api/sessoes/card-i1/apagar'));
    ok(ap2.status === 200 && !sessoes.has('card-i1') && !lerRegistro()['card-i1'], 'apagar arquivado: DELETE no runner e some do registro');
  }

  console.log('\n8. Renomear e favorito');
  {
    const r = await lerJson(await p.json('/api/sessoes/card-a1/renomear', { nome: '  Meu nome novo  ' }));
    ok(r.status === 200 && r.json.item.nome === 'Meu nome novo' && lerRegistro()['card-a1'].nome === 'Meu nome novo', 'renomear persiste no json');
    ok((await lerJson(await p.json('/api/sessoes/card-a1/renomear', { nome: 'x'.repeat(121) }))).status === 400, 'nome com mais de 120: 400');
    const f = await lerJson(await p.json('/api/sessoes/card-a1/favorito', { favorito: true }));
    ok(f.status === 200 && f.json.item.favorito === true && lerRegistro()['card-a1'].favorito === true, 'favorito persiste');
    const alterna = await lerJson(await p.json('/api/sessoes/card-a1/favorito'));
    ok(alterna.json.item.favorito === false, 'sem corpo, alterna');
    await p.json('/api/sessoes/card-a1/favorito', { favorito: true });
    ok((await lerJson(await p.json('/api/sessoes/card-a1/favorito', { favorito: 'sim' }))).status === 400, 'favorito que não é booleano: 400');
    const lista = await lerJson(await p.pedir('/api/sessoes?grupo=todos'));
    ok(lista.json.itens.find((i) => i.id === 'card-a1').nome === 'Meu nome novo', 'a lista usa o nome do registro');
    ok((fs.statSync(REGISTRO).mode & 0o777) === 0o600, 'o registro continua 600 depois de várias escritas');
  }

  console.log('\n9. Retomar');
  {
    const n = chamadas.length;
    const r = await lerJson(await p.json('/api/sessoes/card-f1/retomar'));
    ok(r.status === 200 && r.json.modo === 'mesma' && chamadas.slice(n).some((c) => c.caminho === '/api/agents/card-f1/resume'), 'retomar: /resume (mesma conversa)');
    ok((await lerJson(await p.json('/api/sessoes/card-f1/retomar'))).status === 409, 'já com terminal: 409');
    sessoes.get('card-f1').status = 'resumable';
    const nv = await lerJson(await p.json('/api/sessoes/card-f1/retomar', { nova: true }));
    ok(nv.status === 200 && nv.json.modo === 'nova' && achar('POST', /card-f1\/revive/).length === 1, 'nova:true: /revive (conversa nova)');
    sessoes.get('card-f1').status = 'resumable';
  }

  console.log('\n10. Handoff');
  {
    const r = await lerJson(await p.pedir('/api/sessoes/card-h1/handoff'));
    ok(r.status === 200 && r.json.encontrado === true && r.json.nome_novo.startsWith('▶️ ATIVA') && r.json.nome_antigo.startsWith('✅ ENCERRADA') && /etapa 2/.test(r.json.prompt), 'GET: achou o handoff com nome novo, nome antigo e prompt');
    const sem = await lerJson(await p.pedir('/api/sessoes/card-a1/handoff'));
    ok(sem.status === 200 && sem.json.encontrado === false && sem.json.motivo, 'GET: não achou, com o motivo');
    const total = sessoes.size;
    const n = chamadas.length;
    const h = await lerJson(await p.json('/api/sessoes/card-h1/handoff', { usar_existente: true, apagar_antigo: false }));
    ok(h.status === 201 && h.json.novo.nome.startsWith('▶️ ATIVA') && h.json.abrir_em === h.json.novo.id && sessoes.size === total + 1, 'POST achou: 201 com o card novo e abrir_em');
    const inp = chamadas.slice(n).find((c) => c.caminho === `/api/agents/${h.json.novo.id}/input`);
    ok(inp && /Continue o projeto Z/.test(inp.corpo.text), 'o prompt do handoff foi entregue ao card novo');
    const antigo = (await lerJson(await p.pedir('/api/sessoes/card-h1'))).json.item;
    ok(antigo.nome.startsWith('✅ ENCERRADA') && antigo.arquivado === true, 'o antigo foi renomeado e arquivado');
    const n2 = chamadas.length;
    const sem2 = await lerJson(await p.json('/api/sessoes/card-a1/handoff', { usar_existente: true }));
    const pedido = chamadas.slice(n2).find((c) => c.caminho === '/api/agents/card-a1/input');
    ok(sem2.status === 202 && /Pedi o handoff/.test(sem2.json.aviso) && pedido.corpo.injectWhenIdle === true && /ENCERRADA/.test(pedido.corpo.text), 'POST não achou: recado quando_livre pedindo o formato, 202');
    ok((await lerJson(await p.json('/api/sessoes/luna/handoff', {}))).status === 409, 'handoff da principal: 409');
  }

  console.log('\n11. Documentos não saem da casa');
  {
    fs.mkdirSync(path.join(RAIZ, 'docs-teste'), { recursive: true });
    const citado = path.join(RAIZ, 'docs-teste', 'relatorio.md');
    const naoCitado = path.join(RAIZ, 'docs-teste', 'segredo.md');
    const oculto = path.join(RAIZ, '.env');
    const fora = path.join(os.tmpdir(), `fora-${process.pid}.txt`);
    const atalho = path.join(RAIZ, 'docs-teste', 'atalho.txt');
    fs.writeFileSync(citado, '# Relatório\ncom acentuação');
    fs.writeFileSync(naoCitado, 'nao foi citado');
    fs.writeFileSync(oculto, 'SEGREDO=1');
    fs.writeFileSync(fora, 'fora da casa');
    fs.symlinkSync('/etc/hostname', atalho);
    sessoes.get('card-a1').msgs = [{ role: 'assistant', text: `Gerei \`${citado}\`, também ${oculto}, ${fora}, /etc/passwd e ${atalho}.` }];
    const l = await lerJson(await p.pedir('/api/sessoes/card-a1/documentos'));
    ok(l.status === 200 && l.json.documentos.length === 1 && l.json.documentos[0].nome === 'relatorio.md' && l.json.documentos[0].tipo === 'md', 'lista só o que existe dentro da casa (fora, oculto e atalho para fora ficam de fora)');
    const q = (c) => `/api/sessoes/card-a1/documentos/conteudo?caminho=${encodeURIComponent(c)}`;
    const ok1 = await lerJson(await p.pedir(q(citado)));
    ok(ok1.status === 200 && ok1.json.texto.includes('acentuação') && ok1.json.cortado === false, 'documento citado abre');
    const rel = await lerJson(await p.pedir(q('docs-teste/relatorio.md')));
    ok(rel.status === 200, 'caminho relativo à casa também abre');
    const sobe = await lerJson(await p.pedir(q('../../etc/passwd')));
    ok(sobe.status === 403 || sobe.status === 404, `tentativa com ../ barrada (${sobe.status})`);
    const abs = await lerJson(await p.pedir(q('/etc/passwd')));
    ok(abs.status === 403 && /fora da pasta do agente/.test(abs.json.erro), 'caminho absoluto fora da casa: 403');
    ok((await lerJson(await p.pedir(q(fora)))).status === 403, 'arquivo de fora, mesmo citado: 403');
    const nc = await lerJson(await p.pedir(q(naoCitado)));
    ok(nc.status === 403 && /não foi citado/.test(nc.json.erro), 'dentro da casa mas não citado: 403');
    ok((await lerJson(await p.pedir(q(oculto)))).status === 403, 'arquivo oculto citado (.env): 403');
    ok((await lerJson(await p.pedir(q(atalho)))).status === 403, 'atalho para fora da casa: 403');
    ok((await lerJson(await p.pedir(q(path.join(RAIZ, 'nao-existe.md'))))).status === 404, 'arquivo que não existe: 404');
    ok((await lerJson(await p.pedir('/api/sessoes/card-a1/documentos/conteudo'))).status === 400, 'sem caminho: 400');
    sessoes.get('card-a1').msgs = [{ role: 'user', text: 'faça X' }, { role: 'assistant', text: 'Fazendo X agora com acentuação ✓' }];
  }

  console.log('\n12. Anexo');
  {
    const boundary = '----teste1234';
    const monta = (nomeArq, conteudo, texto) => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="arquivo"; filename="${nomeArq}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      conteudo,
      Buffer.from(texto ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="texto"\r\n\r\n${texto}` : ''),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const envio = (corpo) => p.pedir('/api/sessoes/card-a1/anexo', { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: corpo });
    const bin = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 13) % 256));
    const r = await lerJson(await envio(monta('foto.bin', bin)));
    const destino = path.join(RAIZ, 'anexos', 'card-a1', 'foto.bin');
    ok(r.status === 200 && r.json.caminho === destino && fs.readFileSync(destino).equals(bin), 'anexo gravado byte a byte em anexos/<id>/<nome>');
    const r2 = await lerJson(await envio(monta('../../evil.txt', Buffer.from('x'))));
    ok(r2.status === 200 && path.dirname(r2.json.caminho) === path.join(RAIZ, 'anexos', 'card-a1') && !fs.existsSync(path.join(RAIZ, 'evil.txt')), 'nome com ../ é saneado: não escapa da pasta');
    const r3 = await lerJson(await envio(monta('foto.bin', Buffer.from('outro'))));
    ok(r3.json.nome === 'foto-2.bin' && fs.readFileSync(destino).equals(bin), 'nome repetido não sobrescreve');
    const n = chamadas.length;
    const r4 = await lerJson(await envio(monta('nota.txt', Buffer.from('oi'), 'veja isto')));
    const inp = chamadas.slice(n).find((c) => c.caminho === '/api/agents/card-a1/input');
    ok(r4.status === 200 && inp && inp.corpo.text.startsWith('veja isto\n[anexo: ') && inp.corpo.text.includes('nota.txt'), 'com texto no form, manda recado citando o caminho');
    const semArq = await lerJson(await envio(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="texto"\r\n\r\noi\r\n--${boundary}--\r\n`)));
    ok(semArq.status === 400, 'multipart sem o campo arquivo: 400');
    const json = await lerJson(await p.json('/api/sessoes/card-a1/anexo', {}));
    ok(json.status === 415, 'anexo que não é multipart: 415');
  }

  console.log('\n13. Segurança do pedido');
  {
    const semOrigin = await lerJson(await fetch(`${p.base}/api/sessoes/card-a1/favorito`, { method: 'POST', headers: { Cookie: p.cookie, 'Content-Type': 'application/json' }, body: '{}' }));
    ok(semOrigin.status === 403, 'cookie sem Origin: 403');
    const outra = await lerJson(await p.json('/api/sessoes/card-a1/favorito', {}, { headers: { Origin: 'https://site-ruim.example' } }));
    ok(outra.status === 403, 'cookie com Origin de outro site: 403');
    const tipo = await lerJson(await p.pedir('/api/sessoes/card-a1/favorito', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }));
    ok(tipo.status === 415, 'tipo de conteúdo estranho: 415');
    ok((await lerJson(await p.pedir('/api/sessoes/card-a1/tecla', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status === 501, 'tecla: 501 com a frase');
    ok((await lerJson(await p.pedir('/api/sessoes/cofre'))).status === 501, 'cofre: 501');
    ok((await lerJson(await p.pedir('/api/sessoes/pedidos'))).status === 501, 'pedidos: 501');
    ok((await lerJson(await p.pedir('/api/sessoes/..%2Fx'))).status >= 400, 'caminho com barra escondida: recusado');
    ok((await fetch(`${p.base}/api/sessoes`)).status === 401, 'sem login nem chave: 401');
    const docs = await lerJson(await p.pedir('/api/sessoes/docs.md'));
    ok(docs.status === 200 && /text\/markdown/.test(docs.headers.get('content-type')) && /Aba Sessões/.test(docs.txt), 'GET /api/sessoes/docs.md serve a documentação em markdown');
    ok((await comChave('/api/sessoes?grupo=todos')).status === 200, 'chave de API lê a lista');
    ok(chamadas.every((c) => c.auth === `Bearer ${SEGREDO_DO_RUNNER}`), 'toda chamada ao runner levou o token no cabeçalho');
    ok(!p.saida().includes(SEGREDO_DO_RUNNER), 'o token do runner não aparece no log do painel');
  }

  console.log('\n14. Modo só leitura vale no local');
  {
    const ro = await subirPainel(portaRunner, { DGCLAW_PANEL_SESSOES_SO_LEITURA: '1' });
    servidores.push(ro);
    const c = await lerJson(await ro.pedir('/api/sessoes-config'));
    ok(c.json.soLeitura === true && c.json.modo === 'local', 'config diz soLeitura:true');
    ok((await lerJson(await ro.pedir('/api/sessoes?grupo=todos'))).status === 200, 'ler continua funcionando');
    const w = await lerJson(await ro.json('/api/sessoes/card-a1/favorito', {}));
    ok(w.status === 403 && /só para ler/.test(w.json.erro), 'escrever dá 403 com o motivo');
    ro.parar();
  }

  console.log('\n15. Runner com problema: nunca lista vazia com 200');
  {
    const semTok = await subirPainel(portaRunner, {}, { runnerTokenFile: path.join(RAIZ, 'nao-existe.token') });
    servidores.push(semTok);
    const t = await lerJson(await semTok.pedir('/api/sessoes'));
    ok(t.status === 503 && t.json.code === 'SEM_TOKEN_RUNNER' && t.json.erro.includes('nao-existe.token'), 'token ilegível: 503 SEM_TOKEN_RUNNER com o caminho do arquivo');
    semTok.parar();

    const outroSegredo = crypto.randomBytes(12).toString('hex');
    const ruim = path.join(RAIZ, 'token-errado');
    fs.writeFileSync(ruim, `${outroSegredo}\n`);
    const errado = await subirPainel(portaRunner, {}, { runnerTokenFile: ruim });
    servidores.push(errado);
    const e = await lerJson(await errado.pedir('/api/sessoes'));
    ok(e.status === 503 && e.json.code === 'RUNNER_RECUSOU_TOKEN' && !e.txt.includes(outroSegredo), 'runner recusa o token: 503 sem mostrar o token');
    errado.parar();

    await new Promise((r) => runnerSrv.close(r));
    const f = await lerJson(await p.pedir('/api/sessoes'));
    ok(f.status === 503 && f.json.code === 'RUNNER_FORA' && f.json.ok === false && !('itens' in f.json) && /127\.0\.0\.1/.test(f.json.erro) && /Admin/.test(f.json.como_resolver), 'runner fora do ar: 503 RUNNER_FORA com o endereço e o que fazer (nada de lista vazia)');
    const g = await lerJson(await p.json('/api/sessoes/card-a1/recado', { texto: 'oi' }));
    ok(g.status === 503 && g.json.code === 'RUNNER_FORA', 'escrever com o runner fora: 503 RUNNER_FORA');
    ok(/falhou/.test(p.saida()), 'a falha ficou no log do painel');
  }

  console.log('\n16. Com DGCLAW_PANEL_SESSOES_URL o proxy continua sendo escolhido');
  {
    const px = await subirPainel(portaRunner, { DGCLAW_PANEL_SESSOES_URL: 'http://127.0.0.1:9' });
    servidores.push(px);
    const c = await lerJson(await px.pedir('/api/sessoes-config'));
    ok(c.json.modo === undefined && c.json.ligado === false && /chave/.test(c.json.motivo), 'config é a do proxy (sem modo local; falta a chave)');
    const r = await lerJson(await px.pedir('/api/sessoes'));
    ok(r.status === 501 && /falta a chave/.test(r.json.erro), 'a lista é do proxy: 501 dizendo que falta a chave');
    px.parar();
  }
} finally {
  for (const s of servidores) s.parar();
  runnerSrv.close();
  fs.rmSync(RAIZ, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(os.tmpdir(), `fora-${process.pid}.txt`)); } catch { /* já foi */ }
}

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
