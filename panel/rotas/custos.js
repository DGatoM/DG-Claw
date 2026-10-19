const fs = require('fs');
const path = require('path');

// Aba Custos: visão geral, execuções e análise de uma execução.

module.exports = function registrar(router, ctx) {
  const { CONFIG, costs, serverDir } = ctx;

  // ─── API: Costs ───────────────────────────────────────────────

  router.get('/api/costs/overview', (req, res) => {
    try {
      res.json(costs.getOverview());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/costs/executions', (req, res) => {
    const hours = parseInt(req.query.hours || '24');
    const limit = parseInt(req.query.limit || '200');
    const cron = req.query.cron || undefined;
    const category = req.query.category || undefined;
    res.json({ executions: costs.getExecutions({ hours, limit, cron, category }) });
  });

  router.get('/api/costs/execution/:sessionId', (req, res) => {
    const entry = costs.getExecution(req.params.sessionId);
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json(entry);
  });

  router.post('/api/costs/analyze', (req, res) => {
    // Opcional: só se config.costAnalyzer apontar pro script.
    if (!CONFIG.costAnalyzer) {
      return res.status(404).json({ error: 'cost analyzer not configured' });
    }
    const sessionId = req.body && req.body.session_id;
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });

    const entry = costs.getExecution(sessionId);
    if (!entry) return res.status(404).json({ error: 'execution not found' });

    const analyzerPath = path.isAbsolute(CONFIG.costAnalyzer)
      ? CONFIG.costAnalyzer
      : path.join(serverDir, CONFIG.costAnalyzer);
    if (!fs.existsSync(analyzerPath)) {
      return res.status(404).json({ error: 'cost analyzer script not found' });
    }

    const { spawn } = require('child_process');
    const proc = spawn('python3', [analyzerPath], {
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '' },
    });

    let stdout = '', stderr = '';
    proc.stdin.write(JSON.stringify(entry));
    proc.stdin.end();
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (e) => res.status(500).json({ error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) return res.status(500).json({ error: stderr || `exit ${code}` });
      try {
        res.json(JSON.parse(stdout));
      } catch (e) {
        res.status(500).json({ error: 'invalid analyzer output', raw: stdout.slice(0, 500) });
      }
    });
  });
};
