// costs.js — Leitor e agregador dos *-tokens.jsonl no logDir do agente.
// Schema unificado:
//   { timestamp, cron, tag, model, duration_ms, num_turns, total_cost_usd,
//     session_id, is_error, usage, model_usage }
//
// Factory: buildCosts(config). Tudo parametrizado:
//   - logDir = config.logDir
//   - budget = config.budgetUsd
//   - offset BRT = config.timezoneOffsetHours
//   - categoryOf() = mapa genérico por prefixo do slug (sem hardcode de persona)
//
// Se o logDir não tiver nenhum *-tokens.jsonl, retorna overview ZERADO sem crashar.

const fs = require('fs');
const path = require('path');

function buildCosts(config) {
  const LOG_DIR = config.logDir;
  const BUDGET_USD = typeof config.budgetUsd === 'number' ? config.budgetUsd : 200;
  const TZ_OFFSET_MS = (config.timezoneOffsetHours || 0) * 3600000;
  const SLUG = config.agentSlug || 'agente';

  // Categoria genérica por prefixo do nome do cron. Mantém um agrupamento útil
  // sem precisar conhecer os crons específicos de um agente.
  function categoryOf(cron) {
    if (!cron) return 'outro';
    if (cron.startsWith('dm-')) return 'dm';
    if (cron.startsWith('heartbeat')) return 'heartbeat';
    if (cron.includes('webhook')) return 'webhook';
    if (cron.startsWith(SLUG)) return 'crons';
    return 'outro';
  }

  function listTokenFiles() {
    try {
      return fs.readdirSync(LOG_DIR)
        .filter((f) => f.endsWith('-tokens.jsonl'))
        .map((f) => path.join(LOG_DIR, f));
    } catch {
      return [];
    }
  }

  function readAllEntries(sinceIso) {
    const entries = [];
    const sinceTs = sinceIso ? new Date(sinceIso).getTime() : null;

    for (const file of listTokenFiles()) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        if (sinceTs) {
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (!ts || ts < sinceTs) continue;
        }
        obj.category = categoryOf(obj.cron);
        entries.push(obj);
      }
    }

    entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return entries;
  }

  function startOfMonthIso() {
    const brt = new Date(Date.now() + TZ_OFFSET_MS);
    return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1)).toISOString();
  }

  function startOfTodayIso() {
    const brt = new Date(Date.now() + TZ_OFFSET_MS);
    return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate())).toISOString();
  }

  function sumCost(entries) {
    return entries.reduce((acc, e) => acc + (Number(e.total_cost_usd) || 0), 0);
  }

  function getOverview() {
    const monthEntries = readAllEntries(startOfMonthIso());

    // Sem dados nenhum → overview zerado mas íntegro.
    const today = startOfTodayIso();
    const todayEntries = monthEntries.filter((e) => e.timestamp >= today);
    const yesterday = new Date(new Date(today).getTime() - 24 * 3600000).toISOString();
    const yesterdayEntries = monthEntries.filter((e) => e.timestamp >= yesterday && e.timestamp < today);
    const weekStart = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekEntries = monthEntries.filter((e) => e.timestamp >= weekStart);

    const byCategory = {};
    for (const e of monthEntries) {
      const c = e.category;
      if (!byCategory[c]) byCategory[c] = { cost: 0, executions: 0 };
      byCategory[c].cost += Number(e.total_cost_usd) || 0;
      byCategory[c].executions += 1;
    }

    const byCron = {};
    for (const e of monthEntries) {
      const c = e.cron || '?';
      if (!byCron[c]) byCron[c] = { cost: 0, executions: 0 };
      byCron[c].cost += Number(e.total_cost_usd) || 0;
      byCron[c].executions += 1;
    }
    const topCrons = Object.entries(byCron)
      .map(([cron, v]) => ({ cron, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);

    const byDay = {};
    for (const e of monthEntries) {
      if (!e.timestamp) continue;
      const day = e.timestamp.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + (Number(e.total_cost_usd) || 0);
    }
    const dailySeries = Object.entries(byDay)
      .map(([day, cost]) => ({ day, cost }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      budget: BUDGET_USD,
      month: { total: sumCost(monthEntries), executions: monthEntries.length, start: startOfMonthIso() },
      today: { total: sumCost(todayEntries), executions: todayEntries.length },
      yesterday: { total: sumCost(yesterdayEntries), executions: yesterdayEntries.length },
      week: { total: sumCost(weekEntries), executions: weekEntries.length },
      byCategory,
      topCrons,
      dailySeries,
    };
  }

  function getExecutions({ hours = 24, limit = 200, cron, category } = {}) {
    const sinceIso = new Date(Date.now() - hours * 3600000).toISOString();
    let entries = readAllEntries(sinceIso);
    if (cron) entries = entries.filter((e) => e.cron === cron);
    if (category) entries = entries.filter((e) => e.category === category);
    entries.reverse();
    return entries.slice(0, limit).map((e) => ({
      timestamp: e.timestamp,
      cron: e.cron,
      tag: e.tag,
      model: e.model,
      category: e.category,
      duration_ms: e.duration_ms,
      num_turns: e.num_turns,
      total_cost_usd: e.total_cost_usd,
      session_id: e.session_id,
      is_error: e.is_error,
    }));
  }

  function getExecution(sessionId) {
    const entries = readAllEntries();
    return entries.find((e) => e.session_id === sessionId) || null;
  }

  return {
    LOG_DIR,
    BUDGET_USD,
    categoryOf,
    readAllEntries,
    getOverview,
    getExecutions,
    getExecution,
  };
}

module.exports = { buildCosts };
