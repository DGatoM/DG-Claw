// config.js — Carrega a configuração do painel DG Claw.
//
// Precedência:
//   1. process.env.DGCLAW_PANEL_CONFIG  (path absoluto pro config.json)
//   2. ./config.json                       (ao lado do server.js)
//   3. defaults seguros (genéricos, sem dados de nenhuma persona)
//
// O painel NUNCA pode quebrar por config ausente ou inválida — sempre cai
// em defaults seguros e segue de pé.

const fs = require('fs');
const path = require('path');

// Defaults genéricos. Tudo derivável de agentDir fica derivado no buildPaths;
// aqui só ficam os escalares e o esqueleto.
function defaults() {
  return {
    agentName: 'DG Claw',
    agentSlug: 'agente',
    agentDir: process.cwd(),
    creatorId: null,
    creatorName: 'Dono',
    creatorKey: 'agent_owner',
    meetingsDir: null,         // se null/ausente → poder meetings sem dados
    logDir: null,              // default = <agentDir>/.dgclaw/logs
    logPrefix: null,           // default = agentSlug
    pulsoDir: null,            // default = <agentDir>/.dgclaw/logs/pulso
    pulsoStatusScript: null,   // override do path do pulso-status.py; null = auto-resolve
    authSalt: 'dgclaw-dash',
    budgetUsd: 200,
    avatar: '/assets/sprites/avatar.jpg',
    level: null,               // opcional, mostrado no card de status
    schedule: [],              // [{time,type,label}] — vazio = sem grade de crons esperada
    timezoneOffsetHours: -3,
    moodSprites: null,         // map mood→sprite; null = usa fallback bundlado
    logs: null,                // [{id,label}] pros botões de log; null = descobre por logDir
    costAnalyzer: null,        // path do cost-analyzer.py; ausente → botão escondido
    blockedFiles: null,        // lista extra pra sanitize; defaults sempre aplicados

    // ── a aba Conversa ──
    // chat: o id da conversa que vai no envelope <dgchat chat="...">, e que o agente
    //   devolve na tool de resposta. Default derivado do slug (`c_<slug>`).
    chat: null,
    // bunkerCard / bunkerUrl: quando a sessão viva do agente é um CARD do painel do
    //   Bunker (é o caso do gestor e do agente entregue) em vez de um `claude
    //   --channels` deste host. Ausentes = DG Claw sozinho, e o injetor usa TIOCSTI.
    //   ⚠️ bunkerUrl NUNCA sai de SERVER_PORT: ver o aviso no _lib/inject.py.
    bunkerCard: null,
    bunkerUrl: null,
    // runnerTokenFile: caminho do arquivo (modo 600) com o token Bearer que o runner exige.
    runnerTokenFile: null,
  };
}

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// serverDir = __dirname do server.js (pra resolver ./config.json)
function loadConfig(serverDir) {
  const base = defaults();
  let loaded = null;
  let source = 'defaults';

  const envPath = process.env.DGCLAW_PANEL_CONFIG;
  if (envPath) {
    loaded = readJsonSafe(envPath);
    if (loaded) source = envPath;
  }
  if (!loaded && serverDir) {
    const local = path.join(serverDir, 'config.json');
    loaded = readJsonSafe(local);
    if (loaded) source = local;
  }

  const cfg = Object.assign({}, base, loaded || {});

  // Normaliza derivados
  if (!cfg.agentDir) cfg.agentDir = process.cwd();
  if (!cfg.logDir) cfg.logDir = path.join(cfg.agentDir, '.dgclaw', 'logs');
  if (!cfg.logPrefix) cfg.logPrefix = cfg.agentSlug || 'agente';
  if (!cfg.pulsoDir) cfg.pulsoDir = path.join(cfg.agentDir, '.dgclaw', 'logs', 'pulso');
  if (typeof cfg.timezoneOffsetHours !== 'number') cfg.timezoneOffsetHours = -3;
  if (typeof cfg.budgetUsd !== 'number') cfg.budgetUsd = 200;
  if (!cfg.creatorKey) cfg.creatorKey = 'agent_owner';
  if (!Array.isArray(cfg.schedule)) cfg.schedule = [];

  cfg._source = source;
  return cfg;
}

module.exports = { loadConfig, defaults };
