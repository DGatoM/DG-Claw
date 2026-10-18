// montar-ambiente.mjs: sobe, numa pasta temporária, o DG Claw Web e o painel de um agente falso
// do jeito que a produção liga os dois (agentes.json, web.env com hash scrypt, segredo do proxy,
// painel sob /p/<slug>), mais um runner falso mínimo. Nada toca /etc, /var nem o sistema.
//
// Uso como módulo:  const amb = await montarAmbiente({ repo }); ... await amb.parar();
// Uso solto:        node qa/montar-ambiente.mjs   (sobe, imprime a URL e fica de pé até Ctrl+C)
//
// Onde acha o express do painel (nesta ordem): DGCLAW_TEST_NODE_PATH, NODE_PATH, panel/node_modules,
// e por último um `npm install` numa pasta temporária (nunca em panel/, para não sujar o repositório).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(AQUI, '..');

export const USUARIO = 'dono';
export const SENHA = 'senha-de-qa-bem-longa-123';
export const AGENTE = { slug: 'tina', nome: 'Tina', cor: '#c2410c', avatar: 'https://avatar.qa.invalid/tina.png' };

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/** Mesmo formato do web/lib/auth.js: scrypt$N$r$p$sal$hash (base64url). */
export function gerarHash(senha) {
  const N = 16384; const r = 8; const p = 1;
  const sal = crypto.randomBytes(16);
  const k = crypto.scryptSync(String(senha).normalize('NFKC'), sal, 32, { N, r, p, maxmem: 128 * r * (N + p + 2) * 2 + (1 << 20) });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64url')}$${k.toString('base64url')}`;
}

function temExpress(dir) { return !!dir && fs.existsSync(path.join(dir, 'express', 'package.json')); }

/** Devolve a pasta node_modules com o express, ou lança com o que fazer. */
export function acharNodeModulesDoPainel(repo = REPO, log = console.log) {
  const candidatos = [process.env.DGCLAW_TEST_NODE_PATH, ...String(process.env.NODE_PATH || '').split(path.delimiter), path.join(repo, 'panel', 'node_modules')];
  for (const c of candidatos) if (temExpress(c)) return c;
  const tmp = path.join(os.tmpdir(), 'dgclaw-qa-painel-deps');
  if (temExpress(path.join(tmp, 'node_modules'))) return path.join(tmp, 'node_modules');
  log('Não achei o express do painel (DGCLAW_TEST_NODE_PATH, NODE_PATH ou panel/node_modules). Instalando em ' + tmp + ' (uma vez só)...');
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(path.join(repo, 'panel', 'package.json'), path.join(tmp, 'package.json'));
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: tmp, stdio: 'inherit' });
  } catch (e) {
    throw new Error(`O npm install do painel falhou (${e.message}). Sem rede? Aponte DGCLAW_TEST_NODE_PATH para uma pasta node_modules que tenha o express 4.`);
  }
  return path.join(tmp, 'node_modules');
}

/** Histórico falso: pares de mensagem do dono e resposta do agente, no formato do transcript do Claude Code. */
function transcriptFalso(chat, pares) {
  const linhas = [];
  const base = Date.now() - pares * 120000;
  for (let i = 0; i < pares; i++) {
    const t = new Date(base + i * 120000).toISOString();
    linhas.push(JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content: `<dgchat from="pessoa" chat="${chat}" msg="p${i}" ts="${t}">Pergunta número ${i + 1}: me explica como funciona isto, com calma?</dgchat>` } }));
    const resp = i === pares - 1
      ? 'ÚLTIMA RESPOSTA DO TESTE. Este balão tem de aparecer inteiro, com o texto até o fim, acima da barra de digitação. Linha extra para ele ficar alto. Mais uma linha para garantir mais de uma linha de texto no celular.'
      : `Resposta ${i + 1}: claro, é assim que funciona, em poucas palavras para o teste.`;
    linhas.push(JSON.stringify({ type: 'assistant', timestamp: new Date(base + i * 120000 + 5000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'mcp__dgchat__reply', input: { chat, text: resp } }] } }));
  }
  return linhas.join('\n') + '\n';
}

/** Runner falso mínimo: estado idle e mais nada (a conversa abre; o histórico vem do transcript). */
function subirRunnerFalso(agenteId, sessionId) {
  const srv = http.createServer((req, res) => {
    const json = (st, c) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(c)); };
    const rota = req.url.split('?')[0];
    if (rota === `/api/agents/${agenteId}`) return json(200, { success: true, data: { id: agenteId, status: 'idle', sessionId, currentTool: null, updatedAt: Date.now() } });
    if (rota === '/api/saude' || rota === '/health') return json(200, { ok: true });
    if (rota === '/api/provedor') return json(404, { success: false, error: 'sem rota no runner falso' });
    return json(404, { success: false, error: `runner falso: sem rota ${req.method} ${rota}` });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ porta: srv.address().port, fechar: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) })));
}

async function esperarNoAr(url, rotulo, filho, ms = 30000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (filho && filho.exitCode !== null) throw new Error(`${rotulo} terminou sozinho (código ${filho.exitCode}) antes de ficar no ar. Veja a saída acima.`);
    try { await fetch(url, { redirect: 'manual' }); return; } catch { await dormir(200); }
  }
  throw new Error(`${rotulo} não respondeu em ${url} depois de ${ms / 1000}s.`);
}

/**
 * opcoes: { repo, pares (mensagens no histórico, padrão 40), quieto }
 * Devolve { url, usuario, senha, agente, raiz, parar() }.
 */
export async function montarAmbiente(opcoes = {}) {
  const repo = opcoes.repo || REPO;
  const log = opcoes.quieto ? () => {} : (m) => console.log(`[ambiente] ${m}`);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-qa-'));
  const filhos = [];
  const fechaveis = [];
  const parar = async () => {
    for (const f of filhos) { try { f.kill('SIGTERM'); } catch { /* já morreu */ } }
    for (const f of fechaveis) { try { await f(); } catch { /* já fechou */ } }
    await dormir(200);
    if (!process.env.DGCLAW_QA_MANTER) fs.rmSync(raiz, { recursive: true, force: true });
  };
  try {
    const nm = acharNodeModulesDoPainel(repo, log);
    const portaWeb = await portaLivre();
    const portaPainel = await portaLivre();
    const sessionId = 'sess-0001-aaaa';
    const transcripts = path.join(raiz, 'transcripts');
    const dados = path.join(raiz, 'web-dados');
    const agenteDir = path.join(raiz, 'agente-tina');
    fs.mkdirSync(transcripts, { recursive: true });
    fs.mkdirSync(dados, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(agenteDir, '.dgclaw'), { recursive: true });
    fs.writeFileSync(path.join(transcripts, `${sessionId}.jsonl`), transcriptFalso(`c_${AGENTE.slug}`, opcoes.pares || 40));
    // O IDENTITY do agente: é o que o painel lê na aba Identidade. Fica com um emoji diferente
    // do avatar do registro de propósito, para o roteiro pegar o painel pintando o avatar errado.
    fs.writeFileSync(path.join(agenteDir, 'IDENTITY.md'), '# Tina\n\n- **Nome:** Tina\n- **Emoji:** 🦊\n- **Papel:** agente de teste do QA\n');

    const runner = await subirRunnerFalso('tina-id', sessionId);
    fechaveis.push(runner.fechar);
    const segredo = path.join(raiz, 'proxy-segredo');
    fs.writeFileSync(segredo, crypto.randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
    const reg = (slug, nome, extra) => Object.assign({ slug, nome, runner: `http://127.0.0.1:${runner.porta}`, agente_id: `${slug}-id`, avatar: '', cor: '#4A5D78', provedor: 'claude', modelo: 'sonnet' }, extra);
    const agentes = path.join(raiz, 'agentes.json');
    fs.writeFileSync(agentes, JSON.stringify({ versao: 1, agentes: [
      reg('admin', 'Admin', { tipo: 'admin', cor: '#24694c' }),
      reg(AGENTE.slug, AGENTE.nome, { agente_id: 'tina-id', avatar: AGENTE.avatar, cor: AGENTE.cor, transcripts_dir: transcripts, porta_painel: portaPainel, proxy_segredo_arquivo: segredo, subtitulo: 'agente de teste' }),
    ] }, null, 2));
    const webEnv = path.join(raiz, 'web.env');
    fs.writeFileSync(webEnv, `DGCLAW_PANEL_USER=${USUARIO}\nDGCLAW_PANEL_PASSWORD_HASH=${gerarHash(SENHA)}\n`, { mode: 0o600 });
    const cfgPainel = path.join(raiz, 'painel-config.json');
    fs.writeFileSync(cfgPainel, JSON.stringify({ agentName: 'Tina', agentSlug: AGENTE.slug, agentDir: agenteDir, creatorName: 'Dono', logDir: path.join(agenteDir, 'logs') }));

    const envBase = { ...process.env, HOME: raiz, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    delete envBase.HTTP_PROXY; delete envBase.HTTPS_PROXY; delete envBase.http_proxy; delete envBase.https_proxy;
    const painel = spawn('node', [path.join(repo, 'panel', 'server.js')], {
      cwd: path.join(repo, 'panel'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...envBase, NODE_PATH: nm, DGCLAW_PANEL_PORT: String(portaPainel), DGCLAW_PANEL_HOST: '127.0.0.1', DGCLAW_PANEL_BASE: `/p/${AGENTE.slug}`,
        DGCLAW_PANEL_PROXY_SECRET_FILE: segredo, DGCLAW_PANEL_CONFIG: cfgPainel, DGCLAW_SAUDE_CHECAR_LOGIN: 'off' },
    });
    filhos.push(painel);
    const web = spawn('node', [path.join(repo, 'web', 'server.js')], {
      cwd: path.join(repo, 'web'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...envBase, DGCLAW_WEB_ENV: webEnv, DGCLAW_AGENTES: agentes, DGCLAW_WEB_DATA: dados, DGCLAW_WEB_PORT: String(portaWeb), DGCLAW_WEB_HOST: '127.0.0.1' },
    });
    filhos.push(web);
    const saidas = { painel: '', web: '' };
    painel.stdout.on('data', (d) => { saidas.painel += d; }); painel.stderr.on('data', (d) => { saidas.painel += d; });
    web.stdout.on('data', (d) => { saidas.web += d; }); web.stderr.on('data', (d) => { saidas.web += d; });
    try {
      await esperarNoAr(`http://127.0.0.1:${portaPainel}/`, 'O painel do agente', painel);
      await esperarNoAr(`http://127.0.0.1:${portaWeb}/login`, 'O DG Claw Web', web);
    } catch (e) {
      throw new Error(`${e.message}\n--- saída do painel ---\n${saidas.painel.slice(-1500)}\n--- saída do web ---\n${saidas.web.slice(-1500)}`);
    }
    log(`no ar: web http://127.0.0.1:${portaWeb} (usuário ${USUARIO}), painel de ${AGENTE.nome} na porta ${portaPainel}, dados em ${raiz}`);
    return { url: `http://127.0.0.1:${portaWeb}`, usuario: USUARIO, senha: SENHA, agente: AGENTE, raiz, saidas, parar };
  } catch (e) {
    await parar();
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const amb = await montarAmbiente();
  console.log(`\nAbra ${amb.url}  usuário: ${amb.usuario}  senha: ${amb.senha}\nCtrl+C para encerrar.`);
  const sai = async () => { await amb.parar(); process.exit(0); };
  process.on('SIGINT', sai); process.on('SIGTERM', sai);
  await new Promise(() => {});
}
