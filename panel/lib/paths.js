// paths.js — Factory de caminhos parametrizada por config (DG Claw).
//
// Nada hardcoded: todos os caminhos derivam de
// config.agentDir / config.logDir / config.logPrefix.
//
//   const P = buildPaths(config);
//
// Qualquer arquivo de persona/memória pode não existir num agente recém-criado
// — os readers degradam pra vazio.

const path = require('path');

function buildPaths(config) {
  const AGENT_DIR = config.agentDir;
  const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');
  const LOG_DIR = config.logDir; // já normalizado em config.js
  const PREFIX = config.logPrefix; // já normalizado em config.js

  // Session file: por chat do dono (creatorId). Cai pra session.json genérico se ausente.
  const sessionBasename = config.creatorId
    ? `${config.creatorId}.json`
    : 'session.json';

  const logFile = (suffix) => path.join(LOG_DIR, `${PREFIX}-${suffix}.log`);

  return {
    AGENT_DIR,
    SESSIONS_DIR,
    LOG_DIR,
    LOG_PREFIX: PREFIX,

    // Extensoes instaladas (.dgclaw/ext/<nome>/). O nucleo do DG Claw nao tem emocao:
    // quem tiver a extensao DG Alive instalada ganha state.json e a aba de humor; quem
    // nao tiver simplesmente nao ve esses widgets (ver lib/extensions.js).
    EXT_DIR: path.join(AGENT_DIR, '.dgclaw/ext'),
    STATE_FILE: path.join(AGENT_DIR, '.dgclaw/ext/alive/state.json'),
    // Instalacao antiga (antes da fusao) guardava o estado aqui. O migrador move, mas o
    // painel aceita os dois enquanto houver instalacao velha por ai.
    STATE_FILE_LEGACY: path.join(AGENT_DIR, 'persona/state.json'),
    PROACTIVITY_FILE: path.join(AGENT_DIR, '.dgclaw/proactivity.json'),
    PROACTIVITY_FILE_LEGACY: path.join(AGENT_DIR, 'persona/proactivity.json'),

    // Planning
    THOUGHTS_FILE: path.join(AGENT_DIR, '.dgclaw/ext/alive/thoughts.json'),
    THOUGHTS_FILE_LEGACY: path.join(AGENT_DIR, 'planning/thoughts.json'),
    GOALS_FILE: path.join(AGENT_DIR, 'planning/goals.json'),

    // Data
    POSTS_FILE: path.join(AGENT_DIR, 'data/posts.jsonl'),
    COMMENTS_FILE: path.join(AGENT_DIR, 'data/comments.jsonl'),
    STORIES_FILE: path.join(AGENT_DIR, 'data/stories.jsonl'),
    DIARY_FILE: path.join(AGENT_DIR, 'data/diary.jsonl'),
    PENDING_FILE: path.join(AGENT_DIR, 'data/pending_comments.json'),
    CONFIG_FILE: path.join(AGENT_DIR, 'data/config.json'),

    // Memory
    MEMORY_FILE: path.join(AGENT_DIR, 'MEMORY.md'),
    MEMORY_DIR: path.join(AGENT_DIR, 'memory'),

    // Relationships & followers
    RELATIONSHIPS_FILE: path.join(AGENT_DIR, 'memory/relationships.json'),
    OPINIONS_FILE: path.join(AGENT_DIR, 'memory/opinions.json'),
    TRIGGERS_FILE: path.join(AGENT_DIR, 'memory/triggers.json'),
    FOLLOWERS_DIR: path.join(AGENT_DIR, 'persona/followers'),

    // Identity
    SOUL_FILE: path.join(AGENT_DIR, 'SOUL.md'),
    PERSONALITY_FILE: path.join(AGENT_DIR, 'PERSONALITY.md'),
    IDENTITY_FILE: path.join(AGENT_DIR, 'IDENTITY.md'),
    ETHICS_FILE: path.join(AGENT_DIR, 'ETHICS.md'),
    LAWS_FILE: path.join(AGENT_DIR, 'LAWS.md'),

    // Working Memory (na RAIZ do workspace) & Persona Evolution
    WORKING_MEMORY_FILE: path.join(AGENT_DIR, 'working-memory.md'),
    WORKING_MEMORY_FILE_LEGACY: path.join(AGENT_DIR, 'persona/working-memory.md'),
    PERSONALITY_CHANGELOG: path.join(AGENT_DIR, 'persona/personality-changelog.md'),

    // Session
    SESSION_FILE: path.join(AGENT_DIR, '.sessions', sessionBasename),
    REPLIED_FILE: path.join(AGENT_DIR, '.replied_comments'),

    // Logs (derivados do logPrefix). Heartbeat segue heartbeat-<prefix>.
    LOG_HEARTBEAT: path.join(LOG_DIR, `heartbeat-${PREFIX}.log`),
    LOG_COMMENTS: logFile('comentarios'),
    LOG_REFLECTION: logFile('reflection'),
    LOG_RONDA: logFile('ronda'),
    LOG_AUDITORIA: logFile('auditoria'),
    logFile,

    // Reuniões (Recall.ai) — usa meetingsDir; cai num default dentro do agentDir.
    MEETINGS_DIR: config.meetingsDir || path.join(AGENT_DIR, 'data', 'reunioes'),
  };
}

module.exports = { buildPaths };
