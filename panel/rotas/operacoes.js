const rotinas = require('../lib/rotinas');
const skillsLib = require('../lib/skills');
const { readJSON, readFileTail, todayStr } = require('../lib/readers');

// Aba Operações: crons, agenda do systemd, skills, logs, sessão e pulso.

module.exports = function registrar(router, ctx) {
  const { CONFIG, P, TZ, pulso, getCronsForDate } = ctx;

  // ─── API: Operations ──────────────────────────────────────────

  router.get('/api/operations/crons', (req, res) => {
    const date = req.query.date || todayStr(TZ);
    const crons = getCronsForDate(P.SESSIONS_DIR, date);
    res.json({ date, crons });
  });

  // A AGENDA do agente: os timers que existem no systemd AGORA (os de vida, que vem com o
  // plugin, e os que o proprio agente marcou). Nao ha cache nem lista fixa: o que aparece
  // aqui e o que a maquina vai executar de fato.
  router.get('/api/rotinas', async (req, res) => {
    try {
      // Assíncrono desde 01/10/2026: antes eram um execFileSync por timer, e o painel
      // inteiro parava enquanto o systemd respondia. Ver lib/rotinas.js.
      res.json(await rotinas.listar(CONFIG.agentSlug, CONFIG.agentDir));
    } catch (e) {
      res.status(500).json({
        rotinas: [], inconsistencias: [],
        erro: `nao consegui ler a agenda no systemd: ${e.message}`,
      });
    }
  });

  // As skills do agente: pastas <dir>/<nome>/SKILL.md lidas do disco. Ver lib/skills.js.
  router.get('/api/skills', (req, res) => {
    try {
      res.json(skillsLib.listar(CONFIG.agentDir, process.env.DGCLAW_PANEL_SKILLS_DIR));
    } catch (e) {
      res.status(500).json({ error: `Não consegui listar as skills: ${e.message}`, howToFix: 'Confira se a pasta do agente existe e se o painel pode lê-la.', skills: [], pastas: [] });
    }
  });

  router.get('/api/operations/logs', (req, res) => {
    const type = req.query.type || 'heartbeat';
    const lines = parseInt(req.query.lines || '30');

    // Mapa fixo retrocompatível.
    const logMap = {
      heartbeat: P.LOG_HEARTBEAT,
      comments: P.LOG_COMMENTS,
      reflection: P.LOG_REFLECTION,
      ronda: P.LOG_RONDA,
      auditoria: P.LOG_AUDITORIA,
    };

    // Tipo dinâmico: qualquer <prefix>-<type>.log dentro do logDir.
    if (!logMap[type]) {
      if (!/^[a-z0-9-]+$/i.test(type)) return res.status(400).json({ error: 'invalid log type' });
      const candidate = type === 'heartbeat' ? P.LOG_HEARTBEAT : P.logFile(type);
      if (!candidate.startsWith(P.LOG_DIR)) return res.status(400).json({ error: 'invalid log type' });
      return res.json({ type, content: readFileTail(candidate, lines) });
    }

    res.json({ type, content: readFileTail(logMap[type], lines) });
  });

  router.get('/api/operations/session', (req, res) => {
    const session = readJSON(P.SESSION_FILE);
    res.json(session);
  });

  // ─── API: Pulso (saude operacional) ──────────────────────────
  // Fonte unica = scripts/pulso-status.py (descobre componentes dinamicamente).
  // Cache curto (~30s) dentro de lib/pulso. Endpoint do nucleo (sem poder).

  router.get('/api/pulso', async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : todayStr(TZ);
    try {
      const data = await pulso.getStatus(date);
      res.json(data);
    } catch (e) {
      // getStatus nunca rejeita, mas por garantia:
      res.status(500).json({ error: String(e.message || e) });
    }
  });
};
