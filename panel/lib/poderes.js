const fs = require('fs');
const path = require('path');

module.exports = function buildPoderes(CONFIG) {
  // ─── Powers (poderes travados) ────────────────────────────────
  // DGCLAW_PANEL_POWERS aponta outro arquivo de poderes. Serve para o painel que
  // mostra um agente que não nasceu do plugin (um painel de agente criado por fora, por exemplo), que
  // guarda o powers.json fora de <agente>/.dgclaw/.
  const POWERS_FILE = process.env.DGCLAW_PANEL_POWERS || path.join(CONFIG.agentDir, '.dgclaw', 'powers.json');
  const DEFAULT_POWERS = {
    schema: 1,
    powers: [
      { id: 'core', name: 'Nucleo', enabled: true, locked: true,
        tabs: ['status', 'memory', 'personality', 'identity', 'operations', 'costs'] },
      { id: 'instagram', name: 'Instagram', enabled: false, tabs: ['posts', 'followers'] },
      { id: 'meetings', name: 'Reunioes', enabled: false, tabs: ['reunioes'] },
      { id: 'crm', name: 'CRM', enabled: false, tabs: [] },
      { id: 'secretary', name: 'Secretaria', enabled: false, tabs: [] },
    ],
  };
  let _powersCache = null;
  let _powersMtime = null;

  function readPowers() {
    try {
      const stat = fs.statSync(POWERS_FILE);
      if (_powersCache && _powersMtime === stat.mtimeMs) return _powersCache;
      const data = JSON.parse(fs.readFileSync(POWERS_FILE, 'utf-8'));
      if (!data || !Array.isArray(data.powers)) throw new Error('bad powers');
      _powersCache = data;
      _powersMtime = stat.mtimeMs;
      return data;
    } catch {
      // Ausente / inválido → default seguro: só core ligado.
      return DEFAULT_POWERS;
    }
  }

  function powerEnabled(powerId) {
    const data = readPowers();
    const p = (data.powers || []).find((x) => x.id === powerId);
    return !!(p && p.enabled);
  }

  // Middleware factory: bloqueia (HTTP 423) se o poder não estiver instalado.
  function requirePower(powerId) {
    return (req, res, next) => {
      if (powerEnabled(powerId)) return next();
      return res.status(423).json({ error: 'power_not_installed', power: powerId });
    };
  }

  return { readPowers, powerEnabled, requirePower };
};
