'use strict';
// Leitura da configuração: variáveis de ambiente + arquivo KEY=VALOR (web.env).

const fs = require('node:fs');
const path = require('node:path');

/** Interpreta o texto de um arquivo KEY=VALOR (a última definição de cada chave vence). Função pura: nunca lança. */
function lerEnvTexto(texto) {
  const vars = {};
  for (const bruta of String(texto).split(/\r?\n/)) {
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
  return vars;
}

/** Lê um arquivo KEY=VALOR. Devolve { vars, erro }. Nunca lança. */
function lerEnvArquivo(caminho) {
  let texto;
  try {
    texto = fs.readFileSync(caminho, 'utf8');
  } catch (e) {
    return { vars: {}, erro: `${e.code || e.name}: ${e.message}` };
  }
  return { vars: lerEnvTexto(texto), erro: null };
}

/** O web.env governa o hash: só é "por fora" quando o arquivo NÃO define a chave (nem vazia) e o processo a define
 *  com valor. Se o arquivo a define, o valor dele vence (ver carregaConfig), então uma troca pelo painel vale no reinício. */
function hashAdministradoPorFora(varsArquivo, envProcesso) {
  if (Object.prototype.hasOwnProperty.call(varsArquivo || {}, 'DGCLAW_PANEL_PASSWORD_HASH')) return false;
  return !!String((envProcesso || {}).DGCLAW_PANEL_PASSWORD_HASH || '').trim();
}

/**
 * Monta a configuração. `opcoes.env` (objeto) ignora arquivo e ambiente: é o caminho dos testes.
 * Sem ele: valores do arquivo DGCLAW_WEB_ENV e, por cima, as variáveis do ambiente.
 */
function carregaConfig(opcoes, log) {
  opcoes = opcoes || {};
  let env;
  let hashPorFora = !!opcoes.hashPorFora; // só os testes forçam; em produção vem da comparação abaixo
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
    // O web.env governa o hash da senha: se ele define a chave, vale o dele mesmo que o ambiente do processo traga outro.
    if (Object.prototype.hasOwnProperty.call(r.vars, 'DGCLAW_PANEL_PASSWORD_HASH')) env.DGCLAW_PANEL_PASSWORD_HASH = r.vars.DGCLAW_PANEL_PASSWORD_HASH;
    hashPorFora = hashAdministradoPorFora(r.vars, process.env);
  }
  const num = (v, pad) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : pad; };
  return {
    env,
    // true quando o hash da senha do painel só existe no ambiente do processo (ex.: Environment= na unidade) e o
    // web.env não o define. Se o web.env define, ele governa: depois de uma troca pelo painel o processo ainda
    // tem o hash antigo, o arquivo o novo, e vale o do arquivo.
    hashPorFora,
    host: opcoes.host || env.DGCLAW_WEB_HOST || '127.0.0.1',
    porta: opcoes.porta != null ? opcoes.porta : num(env.DGCLAW_WEB_PORT, 8300),
    agentesPath: opcoes.agentesPath || env.DGCLAW_AGENTES || '/etc/dgclaw/agentes.json',
    dataDir: opcoes.dataDir || env.DGCLAW_WEB_DATA || '/var/lib/dgclaw/web',
    chavesApiArquivo: opcoes.chavesApiArquivo || null, // padrão: <dataDir>/chaves-api.json (override só para testes)
    // Pasta da marca (white label): fica fora da instalação e sobrevive à atualização.
    marcaDir: opcoes.marcaDir || env.DGCLAW_MARCA_DIR || '/etc/dgclaw/marca',
    publicDir: opcoes.publicDir || path.join(__dirname, '..', 'public'),
    origensExtras: new Set(String(env.DGCLAW_WEB_ORIGENS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)),
    proxiesConfiaveis: new Set(String(env.DGCLAW_WEB_PROXIES_CONFIAVEIS || '').split(',').map((s) => s.trim()).filter(Boolean)),
    maxUploadBytes: Math.round(num(env.DGCLAW_WEB_MAX_UPLOAD_MB, 50) * 1024 * 1024),
    maxTexto: Math.round(num(env.DGCLAW_WEB_MAX_TEXTO, 20000)),
    tz: opcoes.tz || env.DGCLAW_WEB_TZ || env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    canalTelegram: env.DGCLAW_CHANNEL_SOURCE || 'plugin:telegram',
    sessaoDias: 30,
    // E-mail do convite do colaborador (opcional). A senha fica em env.DGCLAW_SMTP_SENHA e nunca entra aqui nem em log.
    smtp: {
      host: String(env.DGCLAW_SMTP_HOST || '').trim(),
      porta: num(env.DGCLAW_SMTP_PORTA, 587),
      usuario: String(env.DGCLAW_SMTP_USUARIO || ''),
      remetente: String(env.DGCLAW_SMTP_REMETENTE || '').trim(),
    },
  };
}

module.exports = { lerEnvTexto, lerEnvArquivo, carregaConfig, hashAdministradoPorFora };
