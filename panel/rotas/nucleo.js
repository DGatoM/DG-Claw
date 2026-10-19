const fs = require('fs');
const { listExtensions, resolveStateFile } = require('../lib/extensions');
const { readJSON, readJSONL, todayStr, fileMtime } = require('../lib/readers');

// Rotas do núcleo: agentes da máquina, boot do front, poderes, visão geral, emoções e pensamentos.

module.exports = function registrar(router, ctx) {
  const { CONFIG, P, TZ, BASE, readPowers } = ctx;

  // ─── API: Agentes desta maquina (seletor do menu) ─────────────

  router.get('/api/agents', (req, res) => {
    try {
      // Atras da fachada (BASE preenchido) a rota devolve SO este agente: a maquina por
      // baixo e compartilhada, e quem entrou aqui entrou pelo cartao de um agente so. Ver
      // o porque em lib/agents.js. Com o front escondendo o seletor abaixo de dois, a
      // consequencia visivel e o seletor sumir - mas o corte que importa e este, no dado.
      const agents = require('../lib/agents').listar(CONFIG.agentSlug, req.hostname, {
        soOAtual: !!BASE,
      });
      res.json({ agents });
    } catch (e) {
      // Seletor e conforto, nao funcao vital: se falhar, o painel segue com um agente so.
      console.error('[painel] nao consegui listar os agentes da maquina:', e.message);
      res.json({ agents: [] });
    }
  });

  router.get('/api/config', (req, res) => {
    // Descobre logs: config.logs[] tem prioridade; senão descobre por logDir.
    let logs = [];
    if (Array.isArray(CONFIG.logs) && CONFIG.logs.length) {
      logs = CONFIG.logs.map((l) => ({ id: l.id, label: l.label || String(l.id).toUpperCase() }));
    } else {
      // Descoberta automática: <prefix>-<id>.log e heartbeat-<prefix>.log
      try {
        const files = fs.readdirSync(CONFIG.logDir).filter((f) => f.endsWith('.log'));
        const prefix = CONFIG.logPrefix;
        const ids = new Set();
        for (const f of files) {
          let id = null;
          if (f === `heartbeat-${prefix}.log`) id = 'heartbeat';
          else if (f.startsWith(prefix + '-')) id = f.slice(prefix.length + 1, -4);
          if (id) ids.add(id);
        }
        logs = [...ids].map((id) => ({ id, label: id.toUpperCase() }));
      } catch { logs = []; }
    }
    // Garante ao menos heartbeat na lista (botão padrão).
    if (!logs.some((l) => l.id === 'heartbeat')) logs.unshift({ id: 'heartbeat', label: 'HEARTBEAT' });

    res.json({
      agentName: CONFIG.agentName,
      creatorName: CONFIG.creatorName,
      avatar: CONFIG.avatar,
      level: CONFIG.level || null,
      logs,
      moodSprites: CONFIG.moodSprites || null,
      // Lista de extensoes instaladas. O front usa pra acender/apagar os blocos
      // marcados com data-ext (hoje: 'alive', o motor de emocoes).
      extensions: listExtensions(P.EXT_DIR, P.STATE_FILE_LEGACY),
      costAnalyzer: !!CONFIG.costAnalyzer,
      tabPowers: { posts: 'instagram', followers: 'instagram', reunioes: 'meetings' },
    });
  });

  // ─── API: Powers ──────────────────────────────────────────────

  router.get('/api/powers', (req, res) => {
    const data = readPowers();
    res.json({
      powers: (data.powers || []).map((p) => ({ id: p.id, name: p.name, enabled: !!p.enabled })),
    });
  });

  // ─── API: Overview ────────────────────────────────────────────

  router.get('/api/overview', (req, res) => {
    const state = readJSON(resolveStateFile(P.STATE_FILE, P.STATE_FILE_LEGACY));
    const session = readJSON(P.SESSION_FILE);
    const todayPosts = readJSONL(P.POSTS_FILE, todayStr(TZ));
    const pending = readJSON(P.PENDING_FILE);
    const pendingCount = Array.isArray(pending) ? pending.length : 0;

    res.json({
      mood: state.mood || {},
      emotions: state.emotions || {},
      postsToday: todayPosts.length,
      pendingComments: pendingCount,
      lastSession: session.updated || null,
      lastStateUpdate: state.lastUpdate || null,
    });
  });

  // ─── API: Emotions ────────────────────────────────────────────

  router.get('/api/emotions', (req, res) => {
    // Sem a extensao DG Alive instalada nao existe state.json nenhum: devolve vazio, e o
    // painel mostra o bloco de emocoes apagado. Nao e erro, e o DG Claw puro.
    const data = readJSON(resolveStateFile(P.STATE_FILE, P.STATE_FILE_LEGACY));
    res.json({
      emotions: data.emotions || {},
      mood: data.mood || {},
      needs: data.needs || {},
      lastUpdate: data.lastUpdate || '',
      fileModified: fileMtime(resolveStateFile(P.STATE_FILE, P.STATE_FILE_LEGACY)),
      recentEvents: (data.recentEvents || []).slice(-10),
    });
  });

  // ─── API: Thoughts ────────────────────────────────────────────

  router.get('/api/thoughts', (req, res) => {
    const arqThoughts = resolveStateFile(P.THOUGHTS_FILE, P.THOUGHTS_FILE_LEGACY);
    const thoughts = readJSON(arqThoughts);
    const goals = readJSON(P.GOALS_FILE);
    const proactivity = readJSON(resolveStateFile(P.PROACTIVITY_FILE, P.PROACTIVITY_FILE_LEGACY));

    res.json({
      thoughts: {
        present: thoughts.present || [],
        recentPast: thoughts.recent_past || [],
        future: thoughts.future || [],
        lingering: thoughts.lingering || [],
      },
      goals: {
        shortTerm: goals.short_term || [],
        mediumTerm: goals.medium_term || [],
        longTerm: goals.long_term || [],
        abandoned: goals.abandoned || [],
      },
      proactivity: {
        initiative: proactivity.initiative_level || 0,
        humor: proactivity.humor_level || 0,
        curiosity: proactivity.curiosity_level || 0,
        stubbornness: proactivity.stubbornness_level || 0,
        thoughtBuffer: proactivity.thoughtBuffer || [],
      },
      thoughtsModified: fileMtime(arqThoughts),
      goalsModified: fileMtime(P.GOALS_FILE),
    });
  });
};
