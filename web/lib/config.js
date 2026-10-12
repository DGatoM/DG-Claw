'use strict';
// Leitura da configuração: variáveis de ambiente + arquivo KEY=VALOR (web.env).

const fs = require('node:fs');
const path = require('node:path');

/** Lê um arquivo KEY=VALOR. Devolve { vars, erro }. Nunca lança. */
function lerEnvArquivo(caminho) {
  let texto;
  try {
    texto = fs.readFileSync(caminho, 'utf8');
  } catch (e) {
    return { vars: {}, erro: `${e.code || e.name}: ${e.message}` };
  }
  const vars = {};
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const m = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    vars[m[1]] = v;
  }
  return { vars, erro: null };
}

/**
 * Monta a configuração. `opcoes.env` (objeto) ignora arquivo e ambiente: é o caminho dos testes.
 * Sem ele: valores do arquivo DGCLAW_WEB_ENV e, por cima, as variáveis do ambiente.
 */
function carregaConfig(opcoes, log) {
  opcoes = opcoes || {};
  let env;
  if (opcoes.env) {
    env = Object.assign({}, opcoes.env);
  } else {
    const arquivo = process.env.DGCLAW_WEB_ENV || '/etc/dgclaw/web.env';
    const r = lerEnvArquivo(arquivo);
    if (r.erro) {
      log('aviso', `Não li o arquivo de ambiente ${arquivo} (${r.erro}). Sigo só com as variáveis do ambiente do processo; ` +
        'se o login ficar trancado, rode o instalador para gerar esse arquivo.');
    }
    env = Object.assign({}, r.vars, process.env);
  }
  const num = (v, pad) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : pad; };
  return {
    env,
    host: opcoes.host || env.DGCLAW_WEB_HOST || '127.0.0.1',
    porta: opcoes.porta != null ? opcoes.porta : num(env.DGCLAW_WEB_PORT, 8300),
    agentesPath: opcoes.agentesPath || env.DGCLAW_AGENTES || '/etc/dgclaw/agentes.json',
    dataDir: opcoes.dataDir || env.DGCLAW_WEB_DATA || '/var/lib/dgclaw/web',
    publicDir: opcoes.publicDir || path.join(__dirname, '..', 'public'),
    origensExtras: new Set(String(env.DGCLAW_WEB_ORIGENS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)),
    proxiesConfiaveis: new Set(String(env.DGCLAW_WEB_PROXIES_CONFIAVEIS || '').split(',').map((s) => s.trim()).filter(Boolean)),
    maxUploadBytes: Math.round(num(env.DGCLAW_WEB_MAX_UPLOAD_MB, 50) * 1024 * 1024),
    maxTexto: Math.round(num(env.DGCLAW_WEB_MAX_TEXTO, 20000)),
    tz: opcoes.tz || env.DGCLAW_WEB_TZ || env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    canalTelegram: env.DGCLAW_CHANNEL_SOURCE || 'plugin:telegram',
    sessaoDias: 30,
  };
}

module.exports = { lerEnvArquivo, carregaConfig };
