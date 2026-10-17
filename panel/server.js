const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Load .env manually (no dotenv dependency) — opcional, só se existir ao lado.
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* no .env file */ }

// ─── Config (precedência: env → ./config.json → defaults) ─────
const { loadConfig } = require('./lib/config');
const CONFIG = loadConfig(__dirname);

const { buildPaths } = require('./lib/paths');
// Extensoes instaladas (.dgclaw/ext/): decidem o que ACENDE no painel. Ver lib/extensions.js.
const { listExtensions, resolveStateFile } = require('./lib/extensions');
const P = buildPaths(CONFIG);

const { readJSON, readJSONL, readJSONLLast, readFile, readFileTail, listDir, todayStr } = require('./lib/readers');

function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtime.toISOString(); } catch { return null; }
}
const { buildAuth, COMO_RESOLVER } = require('./lib/auth');
// As chaves de API (Bearer) com que OUTRO assistente opera este painel sem abrir a
// tela. O desenho e as garantias estão no cabeçalho de lib/chaves-api.js.
const { buildChavesApi } = require('./lib/chaves-api');
const { buildSanitizer } = require('./lib/sanitize');
const { isPathAllowed, explicarRecusa, TETO_LEITURA_BYTES } = buildSanitizer(CONFIG);
const { buildCronParser } = require('./lib/cron-parser');
const { getCronsForDate } = buildCronParser(CONFIG);
const { buildCosts } = require('./lib/costs');
const costs = buildCosts(CONFIG);
const { buildMeetings } = require('./lib/meetings');
const meetings = buildMeetings(P);
const { buildPulso } = require('./lib/pulso');
const pulso = buildPulso(CONFIG, __dirname);
// A agenda do agente vem do systemd, nao de lista escrita a mao. Ver lib/rotinas.js.
const rotinas = require('./lib/rotinas');
const skillsLib = require('./lib/skills');
// A conversa do dono com o agente. Fonte unica = o transcript da sessao viva.
const { buildConversa } = require('./lib/conversa');
const conversa = buildConversa(CONFIG, __dirname);
// Os aplicativos que o agente opera. A lista mora no agente (.dgclaw/apps.json),
// nao aqui: ver o cabecalho de lib/apps.js.
const { buildApps } = require('./lib/apps');
const apps = buildApps(CONFIG);
// A pasta de trabalho do agente, para a aba Pasta. A raiz dela é travada em
// <agentDir>/arquivos, e o porquê disso está no topo de lib/arquivos.js.
const { buildArquivos } = require('./lib/arquivos');
const arquivos = buildArquivos(CONFIG);
// O cofre do agente: a chave de serviço que o DONO dele cadastra. O desenho
// inteiro veio de uma nota de segurança escrita antes desta tela existir, e o
// cabeçalho de lib/cofre.js explica cada recusa. Ler antes de mexer.
const { buildCofre } = require('./lib/cofre');
const cofre = buildCofre(CONFIG);
const chavesApi = buildChavesApi(CONFIG);
const { disposicao } = require('./lib/mime');
// O roteiro pronto virando um link que o dono manda pro cliente. O porque de a
// pagina ser autossuficiente esta no cabecalho de lib/compartilhar.js.
const { buildCompartilhar } = require('./lib/compartilhar');
const compartilhar = buildCompartilhar(CONFIG);

const PORT = parseInt(process.env.DGCLAW_PANEL_PORT || '8300');
const AUTH_SALT = CONFIG.authSalt;
const TZ = CONFIG.timezoneOffsetHours;

// ─── Base path (fachada) ────────────────────────────────────
// Vazio = comportamento de hoje, byte a byte: o painel serve em "/". Preenchido (ex.:
// "/agente/ana/painel"), ele passa a viver sob um prefixo porque a plataforma o serve
// atrás de uma fachada autenticada, num caminho que não é a raiz do domínio.
let BASE = (process.env.DGCLAW_PANEL_BASE || '').replace(/\/+$/, '');
if (BASE && !BASE.startsWith('/')) BASE = '/' + BASE;
// 0.0.0.0 = comportamento de hoje (acessível pelo IP da VPS). O modo --loopback do
// instalador grava 127.0.0.1 aqui: o painel só responde na própria máquina, atrás da
// fachada, e some do IP público (que é o ponto do modo).
const HOST = process.env.DGCLAW_PANEL_HOST || '0.0.0.0';

// ─── Login e sessão ───────────────────────────────────────────
// Sem senha usável o painel sobe TRANCADO (nunca com uma senha padrão): o porquê e o
// que cada modo faz estão no cabeçalho de lib/auth.js. `renderLogin` é uma função
// declarada mais abaixo, junto dos templates; só roda quando chega um pedido.
let auth;
try {
  auth = buildAuth({
    env: process.env,
    authSalt: AUTH_SALT,
    base: BASE,
    chavesApi,
    renderLogin: (req, res, o) => renderLogin(req, res, o),
  });
} catch (e) {
  // Configuração de segurança errada derruba a subida, com o motivo escrito: subir
  // assim mesmo seria deixar a porta aberta sem ninguém saber.
  console.error(`[painel] NÃO SUBI: ${e.message}`);
  process.exit(1);
}

// Quem fez o pedido, em palavras, para o registro do cofre e das chaves de API.
function quemFez(req) {
  const a = req.dgclawAuth;
  if (a && a.tipo === 'proxy') return a.usuario;
  return CONFIG.creatorName || 'Dono';
}

// ─── Powers (poderes travados) ────────────────────────────────
// DGCLAW_PANEL_POWERS aponta outro arquivo de poderes. Serve para o painel que
// mostra um agente que não nasceu do plugin (o painel da Isa, por exemplo), que
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

const app = express();
// O Caddy local fala com o painel por loopback e diz o esquema real em X-Forwarded-Proto
// (é o que deixa o cookie sair com Secure). Só o loopback é confiável: um proxy remoto
// poderia mentir sobre o IP, e o limite de tentativas por IP deixaria de valer.
app.set('trust proxy', 'loopback');
app.use(auth.cabecalhos);
app.use(cookieParser());
// A aba Sessões (lib/sessoes-proxy.js e lib/sessoes-local.js) lê o corpo por conta própria: o proxy
// o repassa em STREAM para o DG Telegram (anexo de até 100 MB) e o modo local trata o multipart do
// anexo. Um parser global que lesse o corpo antes deixaria os dois sem nada, então /api/sessoes passa direto. O caminho aqui ainda leva o prefixo BASE.
const PREFIXO_SESSOES = `${BASE}/api/sessoes`.toLowerCase(); // o Express casa rota sem olhar maiúscula
const semParser = (parser) => (req, res, next) => {
  const p = req.path.toLowerCase();
  return p === PREFIXO_SESSOES || p.startsWith(`${PREFIXO_SESSOES}/`) ? next() : parser(req, res, next);
};
app.use(semParser(express.urlencoded({ extended: false })));
// 3 MB e não o teto de fábrica do express (100 KB): a aba Pasta salva arquivo de
// texto de até 2 MB, e com o teto de fábrica um .log de 300 KB voltava do PUT como
// uma página de erro em inglês que ninguém no painel tinha como ler.
app.use(semParser(express.json({ limit: '3mb' })));

// Tudo daqui pra baixo vive dentro de um router, montado no prefixo BASE lá embaixo
// (`app.use(BASE || '/', router)`). Com BASE vazio o router monta em "/" e nada muda
// pra quem já acessa http://IP:8300/; com BASE preenchido, o Express tira o prefixo
// antes de despachar pras rotas, então elas continuam escritas do jeito de sempre.
const router = express.Router();

// Rate limit API
router.use('/api/', rateLimit({ windowMs: 60000, max: 120 }));

// ─── Cloudflare Access (entrada sem senha para quem o Access já conferiu) ─────
//
// POR QUE EXISTE. Quando o painel fica atrás de um túnel Cloudflare com Access, o
// dono já provou quem é no Access (login por e-mail) antes de a requisição chegar
// aqui. Pedir a senha do painel de novo é atrito à toa. Então: se o Cloudflare
// mandou um JWT do Access válido, para o app certo e para um e-mail da lista, a
// requisição segue como se tivesse o cookie dash_token.
//
// DESLIGADO POR PADRÃO. Sem DGCLAW_PANEL_CF_ACCESS_AUD nada aqui roda e o painel se
// comporta exatamente como antes. Qualquer coisa errada (JWT ausente, inválido,
// vencido, e-mail fora da lista, JWKS fora do ar) cai no fluxo antigo: pede a senha.
//
// Envs:
//   DGCLAW_PANEL_CF_ACCESS_AUD  aud do app do Access (Zero Trust > Access > app > Overview)
//   DGCLAW_PANEL_CF_TEAM        domínio do time, ex.: meutime.cloudflareaccess.com
//   DGCLAW_PANEL_CF_EMAILS      e-mails aceitos, separados por vírgula
//   DGCLAW_PANEL_CF_CERTS_URL   SÓ PARA TESTE: troca a URL do JWKS por um servidor local.
//                               Em produção fica vazia (usa https://<team>/cdn-cgi/access/certs).
//
// O JWT vem no header Cf-Access-Jwt-Assertion (ou, na falta, no cookie
// CF_Authorization). Conferimos: RS256, assinatura contra as chaves públicas do time,
// iss, aud, exp (60s de tolerância) e e-mail. Nunca logamos o JWT.
const nodeCrypto = require('crypto');
const CF_AUD = (process.env.DGCLAW_PANEL_CF_ACCESS_AUD || '').trim();
const CF_TEAM = (process.env.DGCLAW_PANEL_CF_TEAM || '').trim()
  .replace(/^https?:\/\//, '').replace(/\/+$/, '');
const CF_EMAILS = (process.env.DGCLAW_PANEL_CF_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const CF_CERTS_URL = (process.env.DGCLAW_PANEL_CF_CERTS_URL || '').trim() ||
  (CF_TEAM ? `https://${CF_TEAM}/cdn-cgi/access/certs` : '');
const CF_ISS = CF_TEAM ? `https://${CF_TEAM}` : '';
let CF_ENABLED = false;
if (CF_AUD) {
  if (!CF_TEAM || CF_EMAILS.length === 0) {
    console.error('[painel] Cloudflare Access DESLIGADO: DGCLAW_PANEL_CF_ACCESS_AUD está definida, ' +
      `mas falta ${!CF_TEAM ? 'DGCLAW_PANEL_CF_TEAM' : 'DGCLAW_PANEL_CF_EMAILS'}. ` +
      'O painel segue pedindo a senha. Para ligar, defina as três envs no drop-in do serviço.');
  } else {
    CF_ENABLED = true;
    console.log(`[painel] Cloudflare Access ligado: time ${CF_TEAM}, e-mails aceitos ${CF_EMAILS.join(', ')}, ` +
      `chaves em ${CF_CERTS_URL}`);
  }
}

const CF_JWKS_TTL_MS = 60 * 60 * 1000;   // cache das chaves: 1h
const CF_JWKS_RETRY_MS = 60 * 1000;      // kid desconhecido: no máximo 1 recarga por minuto
let _cfKeys = null;                      // Map kid -> KeyObject
let _cfKeysAt = 0;
let _cfKeysFetching = null;
let _cfLastForced = 0;

function cfB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Log de recusa com freio: o navegador pede css/js/api em rajada e cada pedido traria
// o mesmo JWT; uma linha por motivo a cada 10 minutos já explica o problema.
const _cfLogAt = new Map();
function cfLogOnce(key, msg) {
  const now = Date.now();
  if (now - (_cfLogAt.get(key) || 0) < 10 * 60 * 1000) return;
  _cfLogAt.set(key, now);
  console.error(msg);
}

async function cfFetchKeys() {
  if (_cfKeysFetching) return _cfKeysFetching;
  _cfKeysFetching = (async () => {
    try {
      const r = await fetch(CF_CERTS_URL, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const map = new Map();
      for (const jwk of (body && body.keys) || []) {
        if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
        try {
          map.set(jwk.kid, nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch { /* chave que não abre não entra no mapa */ }
      }
      if (map.size === 0) throw new Error('resposta sem nenhuma chave RSA utilizável');
      _cfKeys = map;
      _cfKeysAt = Date.now();
      return map;
    } catch (err) {
      cfLogOnce('jwks', `[painel] Cloudflare Access: não consegui baixar as chaves públicas de ${CF_CERTS_URL} ` +
        `(${err && err.message ? err.message : err}). Enquanto isso o painel pede a senha. ` +
        'O que fazer: conferir se a VPS alcança esse endereço (curl na URL) e se DGCLAW_PANEL_CF_TEAM está certo.');
      return _cfKeys; // chave velha ainda serve se já tínhamos alguma
    } finally {
      _cfKeysFetching = null;
    }
  })();
  return _cfKeysFetching;
}

async function cfGetKey(kid) {
  let keys = _cfKeys;
  if (!keys || Date.now() - _cfKeysAt > CF_JWKS_TTL_MS) keys = await cfFetchKeys();
  if (keys && keys.has(kid)) return keys.get(kid);
  // kid novo (o Cloudflare gira as chaves): recarrega uma vez, com freio.
  if (Date.now() - _cfLastForced > CF_JWKS_RETRY_MS) {
    _cfLastForced = Date.now();
    keys = await cfFetchKeys();
    if (keys && keys.has(kid)) return keys.get(kid);
  }
  return null;
}

// Devolve { ok: true, email } ou { ok: false, reason }.
async function cfVerifyAccessJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'JWT malformado' };
  let header, payload;
  try {
    header = JSON.parse(cfB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(cfB64url(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'JWT com cabeçalho ou corpo ilegível' };
  }
  if (!header || header.alg !== 'RS256') return { ok: false, reason: `algoritmo ${header && header.alg} não aceito` };
  const key = await cfGetKey(header.kid);
  if (!key) return { ok: false, reason: `chave ${String(header.kid).slice(0, 12)}… não encontrada no JWKS` };
  const valid = nodeCrypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    key, cfB64url(parts[2]));
  if (!valid) return { ok: false, reason: 'assinatura inválida' };
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== CF_ISS) return { ok: false, reason: `iss ${payload.iss} diferente de ${CF_ISS}` };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(CF_AUD)) return { ok: false, reason: 'aud não é o deste painel' };
  if (typeof payload.exp !== 'number' || payload.exp + 60 < now) return { ok: false, reason: 'JWT vencido' };
  if (typeof payload.nbf === 'number' && payload.nbf - 60 > now) return { ok: false, reason: 'JWT ainda não vale (nbf)' };
  const email = String(payload.email || '').toLowerCase();
  if (!email || !CF_EMAILS.includes(email)) return { ok: false, reason: `e-mail ${email || '(nenhum)'} fora da lista` };
  return { ok: true, email };
}

function cfAccessAuth(req, res, next) {
  if (!CF_ENABLED) return next();
  if (auth.conferirToken(req.cookies && req.cookies.dash_token)) return next();
  const token = req.get('Cf-Access-Jwt-Assertion') || (req.cookies && req.cookies.CF_Authorization) || '';
  if (!token) return next();
  cfVerifyAccessJwt(token).then((r) => {
    if (r.ok) {
      // Sinal explícito para o requireAuth logo abaixo, só nesta requisição. Antes isto
      // fabricava um cookie, o que obrigava o token de sessão a ser um valor fixo e
      // conhecido. Não gravamos cookie no navegador: a confiança fica presa ao Access.
      req.dgclawAuth = 'cf-access';
    } else {
      cfLogOnce(`deny:${r.reason}`, `[painel] Cloudflare Access: JWT recusado em ${req.method} ${req.originalUrl} ` +
        `(${r.reason}). Caiu na senha do painel. Se era para entrar direto, conferir ` +
        'DGCLAW_PANEL_CF_ACCESS_AUD, DGCLAW_PANEL_CF_TEAM e DGCLAW_PANEL_CF_EMAILS no drop-in do serviço.');
    }
    next();
  }).catch((err) => {
    cfLogOnce('crash', `[painel] Cloudflare Access: erro inesperado ao conferir o JWT (${err && err.message}). Caiu na senha.`);
    next();
  });
}
router.use(cfAccessAuth);

// Auth middleware: cookie de sessão, Access ou chave de API (Bearer)
router.use(auth.requireAuth);
// Pedido que escreve, vindo do navegador, precisa ter nascido na própria tela do painel.
router.use(auth.csrf);

// ─── HTML com {{BASE}} ────────────────────────────────────────
//
// index.html e login.html carregam caminho absoluto (css, js, assets, /login, /logout).
// Atrás da fachada esses caminhos precisam do prefixo, então os dois deixam de ser
// arquivo estático e viram TEMPLATE: lê o arquivo, troca {{BASE}} / {{BASE_JSON}} pelo
// prefixo real, devolve. Cache por mtime (mesmo espírito do readPowers lá em cima): um
// `git pull` no painel troca o conteúdo sem precisar reiniciar o processo.
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_HTML = path.join(PUBLIC_DIR, 'login.html');
const _htmlCache = new Map();

// {{VOLTAR}} — a setinha de voltar para a estante.
//
// Só existe atrás da fachada, e por isso é template e não CSS: um DG Claw instalado
// sozinho na máquina do dono não tem estante nenhuma para onde voltar, e um link morto
// ali em cima seria pior que link nenhum. Servido pela plataforma, o painel vive na
// MESMA origem da estante, que mora na raiz, e por isso o href é "/" e não precisa saber
// o endereço de coisa alguma.
// A tela principal do agente é a conversa do chat (/a/<slug>); o painel são as páginas dele.
// O slug vem do próprio BASE ("/p/<slug>"), com o do config como reserva.
const SLUG_DA_FACHADA = (BASE.match(/^\/p\/([^/]+)/) || [])[1] || CONFIG.agentSlug || '';
const URL_CONVERSA = SLUG_DA_FACHADA ? `/a/${encodeURIComponent(SLUG_DA_FACHADA)}` : '/';
const VOLTAR_HTML =
  `<a class="btn-voltar" href="${URL_CONVERSA}" aria-label="voltar para a conversa">` +
  '<span aria-hidden="true">←</span><span class="btn-voltar-texto">conversa</span></a>';

// {{CASCA}}: o cabeçalho e o menu da Conversa também no painel (web/public/casca.js).
// Só sob a plataforma (BASE preenchido): os arquivos são servidos pelo Web, na raiz da MESMA origem,
// por isso os caminhos são absolutos e não levam o prefixo. Painel solto não tem esses arquivos:
// vira vazio e a tela fica exatamente como era. O casca.css vem ANTES do menu-lado.css (a ordem importa).
const CASCA_HTML = [
  '<link rel="stylesheet" href="/casca.css">',
  '<link rel="stylesheet" href="/menu-lado.css">',
  '<script src="/tour.js"></script>',
  '<script src="/menu-lado.js"></script>',
  '<script src="/casca.js"></script>',
].join('\n  ');

// Devolve o HTML já com {{BASE}} trocado, ou null se o arquivo não existe.
function carregarTemplate(filePath) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const cached = _htmlCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.html;
  const html = fs.readFileSync(filePath, 'utf-8')
    .split('{{CASCA}}').join(BASE ? CASCA_HTML : '')
    .split('{{VOLTAR}}').join(BASE ? VOLTAR_HTML : '')
    .split('{{BASE_JSON}}').join(JSON.stringify(BASE))
    .split('{{BASE}}').join(BASE);
  _htmlCache.set(filePath, { mtimeMs, html });
  return html;
}

function renderHtmlTemplate(filePath) {
  return (req, res) => {
    const html = carregarTemplate(filePath);
    if (html === null) return res.status(404).send('Nao encontrado.');
    res.type('html').send(html);
  };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A tela de login muda com o estado do servidor, e por isso os marcadores dela são
// trocados a cada pedido (o arquivo em cache continua sendo um só):
//   {{LOGIN_MODO}}   'trancado' | 'usuario' | 'senha'  (o CSS da página mostra o que cabe)
//   {{LOGIN_MOTIVO}} por que está trancado (já escapado)
//   {{LOGIN_COMO}}   o que fazer para destrancar (já escapado)
//   {{LOGIN_ERRO}}   '' | 'bloqueado:<minutos>' (erro de senha vem por ?error=1)
function renderLogin(req, res, o = {}) {
  const html = carregarTemplate(LOGIN_HTML);
  if (html === null) return res.status(404).send('Nao encontrado.');
  const modo = auth.trancado ? 'trancado' : (auth.usuarioObrigatorio ? 'usuario' : 'senha');
  const erro = o.erro === 'bloqueado' ? `bloqueado:${o.min || 1}` : '';
  res.status(o.status || 200).type('html').send(html
    .split('{{LOGIN_MODO}}').join(modo)
    .split('{{LOGIN_MOTIVO}}').join(escHtml(auth.motivo || ''))
    .split('{{LOGIN_COMO}}').join(escHtml(COMO_RESOLVER))
    .split('{{LOGIN_ERRO}}').join(erro));
}

router.get(['/', '/index.html'], renderHtmlTemplate(INDEX_HTML));
router.get('/login.html', (req, res) => renderLogin(req, res));

// Static files: só o que NÃO precisa de template (css/js/assets). `index: false` pra
// nunca deixar o express.static servir o index.html CRU (sem {{BASE}} trocado); as duas
// rotas acima, registradas antes, já respondem por "/" de qualquer forma.
router.use(express.static(PUBLIC_DIR, { index: false }));

// ─── Auth Routes ──────────────────────────────────────────────

router.post('/login', (req, res, next) => {
  auth.login(req, res).catch(next);
});

// Sair é POST: um GET que muda estado deixaria qualquer página de fora deslogar o dono
// com uma tag <img>. O GET continua só levando para a tela de login, sem efeito.
router.get('/logout', (req, res) => res.redirect((BASE || '') + '/login.html'));
router.post('/logout', (req, res) => {
  // path precisa bater com o do cookie.set, senão o navegador não o mata de verdade.
  res.clearCookie('dash_token', { path: BASE || '/' });
  res.redirect((BASE || '') + '/login.html');
});

// ─── API: Agentes desta maquina (seletor do menu) ─────────────

router.get('/api/agents', (req, res) => {
  try {
    // Atras da fachada (BASE preenchido) a rota devolve SO este agente: a maquina por
    // baixo e compartilhada, e quem entrou aqui entrou pelo cartao de um agente so. Ver
    // o porque em lib/agents.js. Com o front escondendo o seletor abaixo de dois, a
    // consequencia visivel e o seletor sumir - mas o corte que importa e este, no dado.
    const agents = require('./lib/agents').listar(CONFIG.agentSlug, req.hostname, {
      soOAtual: !!BASE,
    });
    res.json({ agents });
  } catch (e) {
    // Seletor e conforto, nao funcao vital: se falhar, o painel segue com um agente so.
    console.error('[painel] nao consegui listar os agentes da maquina:', e.message);
    res.json({ agents: [] });
  }
});

// ─── API: Config (boot do front) ──────────────────────────────

// Frente A (01/10/2026): saúde da RESPOSTA do agente (/api/saude, com `diagnostico`), reinício normal e em modo de segurança, e a sessão de socorro. Ver lib/rotas-saude.js.
const rotasSaude = require('./lib/rotas-saude')(router, { CONFIG, conversa, serverDir: __dirname });
// Frente de provedores (12/10/2026): bloco "Modelo e autenticação" da tela Status. Ver lib/provedores.js.
require('./lib/provedores')(router, { CONFIG, cofre, serverDir: __dirname });

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

// ─── API: Conversa ────────────────────────────────────────────
//
// A aba Conversa. Tres rotas e nenhuma tabela: a conversa VEM do transcript da sessao
// viva e VAI para a sessao viva, e nada fica guardado no meio do caminho. Ver o
// cabecalho de lib/conversa.js para o porque.
//
// Estas sao as PRIMEIRAS rotas de escrita do painel (ate aqui so /login e
// /api/costs/analyze eram POST). Escrever aqui nao mexe em arquivo nenhum do agente:
// o maximo que uma chamada faz e datilografar uma frase na sessao dele.

router.get('/api/chat/mensagens', async (req, res) => {
  const last = parseInt(req.query.last || '80', 10);
  try {
    const r = await conversa.mensagens({ last: Number.isFinite(last) ? last : 80 });
    const estado = await conversa.estado();
    res.json({
      mensagens: r.mensagens,
      // A diferenca entre "conversa vazia" e "nao consegui ler" precisa chegar na
      // tela: a primeira e normal num agente novo, a segunda e defeito.
      erro: r.erro || null,
      aviso: r.aviso || null,
      estado: {
        chave: estado.chave,
        frase: estado.frase,
        podeEscrever: estado.escreve,
        trabalhando: estado.trabalhando,
        viva: estado.viva,
        // Ele caiu E da para acordar daqui. So vem verdadeiro quando a plataforma
        // respondeu e disse que o card esta num estado retomavel: sem isso a tela
        // mostraria um botao de acordar em cima de uma sessao que ja esta de pe, ou
        // quando quem nao respondeu foi a propria plataforma.
        podeReativar: estado.podeReativar === true,
        cardStatus: estado.cardStatus || null,
      },
      chat: conversa.CHAT,
      agente: CONFIG.agentName,
    });
  } catch (e) {
    console.error('[painel] falha ao montar a conversa:', e);
    res.status(500).json({
      mensagens: [],
      erro: `Nao consegui montar a conversa: ${e.message}`,
    });
  }
});

router.post('/api/chat/mensagem', async (req, res) => {
  const texto = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  if (!texto.trim()) {
    return res.status(400).json({
      error: 'A mensagem veio vazia.',
      howToFix: 'Escreva o que voce quer pedir e envie de novo.',
    });
  }
  try {
    const r = await conversa.enviar(texto);
    if (r.ok) return res.status(202).json({ enviado: true });
    // A mensagem NAO entrou. Dizer isso com todas as letras importa mais que o motivo
    // tecnico: a pessoa precisa saber que nao adianta esperar resposta.
    console.error('[painel] mensagem NAO entregue na sessao viva:', r.motivo);
    return res.status(502).json({
      error: `${CONFIG.agentName} nao esta conseguindo receber mensagem agora, entao isto NAO foi enviado.`,
      howToFix:
        'Espere um minuto e mande de novo. Se continuar, avise quem cuida do sistema: ' +
        'a sua mensagem nao se perdeu, ela simplesmente nao saiu.',
      detalhe: r.motivo,
    });
  } catch (e) {
    console.error('[painel] erro ao enviar mensagem:', e);
    res.status(500).json({ error: `Nao consegui enviar: ${e.message}` });
  }
});

router.post('/api/chat/parar', async (req, res) => {
  try {
    const r = await conversa.parar();
    if (r.ok) return res.json({ parado: true });
    console.error('[painel] nao consegui interromper a sessao:', r.motivo);
    res.status(502).json({
      error: 'Nao consegui interromper o que ele esta fazendo.',
      howToFix: 'Tente de novo em alguns segundos. Se nao parar, quem cuida do sistema consegue parar pelo terminal.',
      detalhe: r.motivo,
    });
  } catch (e) {
    res.status(500).json({ error: `Nao consegui interromper: ${e.message}` });
  }
});

// Acordar o terminal do agente. E a unica acao desta tela que sobe processo: as
// outras duas so datilografam numa sessao que ja existe. Fica aqui, do lado delas,
// porque para quem usa o painel e a mesma conversa: a diferenca e que esta e a que
// funciona quando ele esta fora do ar.
router.post('/api/chat/reativar', async (req, res) => {
  try {
    const r = await conversa.reativar();
    if (r.ok) return res.json({ acordando: true, jaEstavaDePe: !!r.jaEstavaDePe });
    console.error('[painel] nao consegui acordar o terminal do agente:', r.motivo);
    return res.status(502).json({
      error: `Nao consegui acordar ${CONFIG.agentName}.`,
      howToFix:
        'Tente de novo em alguns segundos. Se continuar, quem cuida do sistema sobe a sessao ' +
        'pela plataforma; a sua conversa continua guardada e nao se perde.',
      detalhe: r.motivo,
    });
  } catch (e) {
    console.error('[painel] erro ao acordar o terminal:', e);
    res.status(500).json({ error: `Nao consegui acordar: ${e.message}` });
  }
});

// O ditado por voz. Recebe o audio bruto do MediaRecorder do navegador e devolve o
// TEXTO, que a tela poe na caixa de escrever para a pessoa ler antes de enviar.
//
// `express.raw` so nesta rota: o resto do painel fala JSON, e um parser binario
// global engoliria corpo de rota que nao e audio. O teto de 25 MB da uns 25 minutos
// de fala no formato que o navegador grava, bem acima de qualquer ditado real.
//
// O audio NAO e gravado em disco em lugar nenhum: entra pela requisicao, sai para a
// transcricao e morre com ela. O que sobra da voz da pessoa e o texto que ela mesma
// aprovar.
router.post(
  '/api/chat/transcrever',
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    try {
      const r = await conversa.transcrever(req.body, req.headers['content-type']);
      if (r.ok) return res.json({ texto: r.texto });
      console.error('[painel] transcricao falhou:', r.motivo);
      return res.status(r.silencio ? 400 : 502).json({
        error: r.silencio
          ? 'Nao consegui ouvir fala nenhuma nesse audio.'
          : 'Nao consegui transcrever o seu audio.',
        // "Tente gravar de novo" e o conselho certo para um audio ruim e o
        // conselho ERRADO para uma configuracao errada: gravar de novo nunca vai
        // consertar um endereco que nao tem servico de transcricao. Quando o
        // modulo sabe o que fazer, quem manda e ele.
        howToFix: r.silencio
          ? 'Fale mais perto do microfone e grave de novo. Nada foi perdido: voce ainda pode escrever.'
          : (r.comoResolver
            || 'Tente gravar de novo. Se continuar, escreva a mensagem: a conversa funciona do mesmo jeito.'),
        detalhe: r.motivo,
      });
    } catch (e) {
      console.error('[painel] erro na transcricao:', e);
      res.status(500).json({ error: `Nao consegui transcrever: ${e.message}` });
    }
  },
);

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

// ─── API: Posts (poder instagram) ─────────────────────────────

router.get('/api/posts', requirePower('instagram'), (req, res) => {
  const limit = parseInt(req.query.limit || '30');
  const date = req.query.date;

  let posts;
  if (date) {
    posts = readJSONL(P.POSTS_FILE, date);
  } else {
    posts = readJSONLLast(P.POSTS_FILE, limit);
  }

  const allStories = date ? readJSONL(P.STORIES_FILE, date) : readJSONLLast(P.STORIES_FILE, limit);
  for (const post of posts) {
    post.hasStory = false;
    for (const story of allStories) {
      const feedUrl = story.feedPostUrl || story.postFeedUrl || '';
      if (post.postUrl && feedUrl && feedUrl.includes(post.postUrl)) {
        post.hasStory = true;
        post.storyPublished = [true, 'OK', 'true'].includes(story.published);
        break;
      }
    }
  }

  res.json({ count: posts.length, posts: posts.reverse() });
});

router.get('/api/posts/stats', requirePower('instagram'), (req, res) => {
  const allPosts = readJSONL(P.POSTS_FILE);
  const today = todayStr(TZ);
  const todayPosts = allPosts.filter((p) => p.date === today);

  let streak = 0;
  const dates = [...new Set(allPosts.map((p) => p.date))].sort().reverse();
  const offset = typeof TZ === 'number' ? TZ : -3;
  const sign = offset < 0 ? '-' : '+';
  const oh = String(Math.abs(offset)).padStart(2, '0');
  const d = new Date(today + `T12:00:00${sign}${oh}:00`);
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().split('T')[0];
    if (dates.includes(dateStr)) {
      streak++;
    } else if (i > 0) {
      break;
    }
    d.setDate(d.getDate() - 1);
  }

  res.json({ total: allPosts.length, today: todayPosts.length, streak });
});

// ─── API: Comments (poder instagram) ──────────────────────────

router.get('/api/comments/recent', requirePower('instagram'), (req, res) => {
  const recent = readJSONLLast(P.COMMENTS_FILE, 20);
  const pending = readJSON(P.PENDING_FILE);

  const sentiments = { positive: 0, neutral: 0, negative: 0 };
  const positiveKeys = new Set(['elogio', 'positive', 'recomendacao']);
  const negativeKeys = new Set(['spam', 'injection', 'negative']);
  for (const c of recent) {
    const s = c.sentiment || 'unknown';
    if (positiveKeys.has(s)) sentiments.positive++;
    else if (negativeKeys.has(s)) sentiments.negative++;
    else sentiments.neutral++;
  }

  let totalReplied = 0;
  try {
    const data = fs.readFileSync(P.REPLIED_FILE, 'utf-8');
    totalReplied = data.split('\n').filter((l) => l.trim()).length;
  } catch { /* not found */ }

  res.json({
    recent: recent.reverse(),
    pending: Array.isArray(pending) ? pending : [],
    pendingCount: Array.isArray(pending) ? pending.length : 0,
    sentiments,
    totalReplied,
  });
});

// ─── API: Followers (poder instagram) ─────────────────────────

router.get('/api/followers/top', requirePower('instagram'), (req, res) => {
  const raw = readJSON(P.RELATIONSHIPS_FILE);
  const rels = raw.relationships || raw;
  const owner = rels[CONFIG.creatorKey] || null;
  const topFollowers = rels.top_followers || {};

  const followersArray = Object.entries(topFollowers).map(([username, data]) => ({
    username,
    ...data,
  }));

  res.json({
    agent_owner: owner, // bloco do dono no painel
    owner,
    top_followers: followersArray,
  });
});

router.get('/api/followers/stats', requirePower('instagram'), (req, res) => {
  const tiers = { newcomer: 0, returning: 0, regular: 0, close: 0, negative: 0 };
  let total = 0;

  try {
    const files = fs.readdirSync(P.FOLLOWERS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(P.FOLLOWERS_DIR, f), 'utf-8'));
        const tier = data.tier || 'newcomer';
        tiers[tier] = (tiers[tier] || 0) + 1;
        total++;
      } catch { continue; }
    }
  } catch { /* dir not found */ }

  res.json({ total, tiers });
});

// ─── API: Memory ──────────────────────────────────────────────

router.get('/api/memory', (req, res) => {
  const memoryFiles = listDir(P.MEMORY_DIR, ['.md', '.json']);
  const mainMemory = { name: 'MEMORY.md', size: 0, modified: '', isMain: true };
  try {
    const stat = fs.statSync(P.MEMORY_FILE);
    mainMemory.size = stat.size;
    mainMemory.modified = stat.mtime.toISOString();
  } catch { /* not found */ }

  res.json({ main: mainMemory, files: memoryFiles });
});

router.get('/api/memory/file', (req, res) => {
  const requestedPath = req.query.path;
  if (!requestedPath) return res.status(400).json({ error: 'path required' });

  if (!isPathAllowed(requestedPath)) {
    // O motivo vai junto (sem caminho de servidor): "access denied" sozinho não
    // diz à pessoa se o arquivo é secreto ou se ela digitou errado.
    return res.status(403).json({ error: 'access denied', motivo: explicarRecusa(requestedPath) });
  }

  const fullPath = path.resolve(P.AGENT_DIR, requestedPath);
  // Teto de leitura: arquivo de vários MB aqui não é memória (é log ou transcript),
  // e lê-lo inteiro para mandar ao navegador só gasta a RAM do painel.
  try {
    if (fs.statSync(fullPath).size > TETO_LEITURA_BYTES) {
      return res.status(413).json({ error: 'arquivo grande demais para abrir aqui', motivo: 'passa de 2 MB' });
    }
  } catch { /* ausente: o readFile abaixo devolve null e a rota responde 404 */ }
  const content = readFile(fullPath);
  if (content === null) return res.status(404).json({ error: 'not found' });

  if (fullPath.endsWith('.json')) {
    try {
      return res.json({ path: requestedPath, type: 'json', content: JSON.parse(content) });
    } catch { /* serve as text */ }
  }

  res.json({ path: requestedPath, type: 'text', content });
});

// ─── API: Personality ─────────────────────────────────────────

router.get('/api/personality', (req, res) => {
  const opinions = readJSON(P.OPINIONS_FILE);
  const proactivity = readJSON(resolveStateFile(P.PROACTIVITY_FILE, P.PROACTIVITY_FILE_LEGACY));
  const personality = readFile(P.PERSONALITY_FILE) || '';

  const bigFive = {};
  const bfMatches = personality.matchAll(/\|\s*([\wçãéêáà]+(?:\s+[\wçãéêáà]+)*)\s*\|\s*(\d+)\/10/gi);
  for (const m of bfMatches) {
    bigFive[m[1].trim().toLowerCase()] = parseInt(m[2]);
  }
  const headerMatches = personality.matchAll(/###\s+(.+?)\s*\((\d+)\/10\)/g);
  for (const m of headerMatches) {
    bigFive[m[1].trim().toLowerCase()] = parseInt(m[2]);
  }

  const proSettings = proactivity.settings || proactivity;

  res.json({
    bigFive,
    opinions: opinions.opinions || opinions,
    proactivity: {
      initiative: proSettings.initiative_level || 0,
      humor: proSettings.humor_level || 0,
      curiosity: proSettings.curiosity_level || 0,
      stubbornness: proSettings.stubbornness_level || 0,
    },
    thoughtBuffer: proactivity.thoughtBuffer || [],
    personalityModified: fileMtime(P.PERSONALITY_FILE),
    proactivityModified: fileMtime(resolveStateFile(P.PROACTIVITY_FILE, P.PROACTIVITY_FILE_LEGACY)),
    opinionsModified: fileMtime(P.OPINIONS_FILE),
  });
});

// ─── API: Identity ────────────────────────────────────────────

router.get('/api/identity', (req, res) => {
  res.json({
    soul: readFile(P.SOUL_FILE) || '',
    personality: readFile(P.PERSONALITY_FILE) || '',
    identity: readFile(P.IDENTITY_FILE) || '',
    ethics: readFile(P.ETHICS_FILE) || '',
    laws: readFile(P.LAWS_FILE) || '',
    // Mesmo lugar onde o leitor (/api/memoria/arquivo) procura: a lista só mostra o que ele abre.
    creator: readFile(path.join(P.AGENT_DIR, 'CREATOR.md')) || '',
  });
});

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

// ─── API: Working Memory ─────────────────────────────────────

router.get('/api/working-memory', (req, res) => {
  const arqWM = resolveStateFile(P.WORKING_MEMORY_FILE, P.WORKING_MEMORY_FILE_LEGACY);
  const content = readFile(arqWM);
  if (content === null) {
    // Agente novo pode não ter working-memory ainda.
    return res.json({ content: '', lastModified: null, size: 0 });
  }

  let lastModified = '';
  try {
    lastModified = fs.statSync(arqWM).mtime.toISOString();
  } catch { /* not found */ }

  res.json({ content, lastModified, size: (content || '').length });
});

// ─── API: Personality Changelog ──────────────────────────────

router.get('/api/personality/changelog', (req, res) => {
  const content = readFile(P.PERSONALITY_CHANGELOG);
  if (content === null) return res.json({ content: 'Nenhum changelog encontrado' });
  res.json({ content });
});

// ─── API: Diary ───────────────────────────────────────────────

router.get('/api/diary', (req, res) => {
  const limit = parseInt(req.query.limit || '20');
  const entries = readJSONLLast(P.DIARY_FILE, limit);
  res.json({ entries: entries.reverse() });
});

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
    : path.join(__dirname, CONFIG.costAnalyzer);
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

// Frente B (01/10/2026): Operações com quadradinhos, rotinas do usuário, raio-X e edição da memória, radiografia. Ver lib/rotas-painel.js.
require('./lib/rotas-painel').registrar(router, { CONFIG, pulso, serverDir: __dirname, diagnostico: () => rotasSaude.saude.diagnostico() });
// A saúde da memória de trabalho, para o cartão da aba Status (05/10/2026).
require('./lib/wm-status').registrar(router, { CONFIG });
// A aba Sessões (12/10/2026). Duas fontes para a mesma tela: com DGCLAW_PANEL_SESSOES_URL (ou
// sessoes.url no config.json) é o proxy fino para os cards do Bunker via DG Telegram; sem ela é o
// modo local, onde cada card é uma sessão paralela do runner deste agente. Ver docs/SESSOES.md.
const sessoesProxy = require('./lib/sessoes-proxy');
if (sessoesProxy.urlConfigurada(CONFIG)) sessoesProxy.registrar(router, { CONFIG });
else require('./lib/sessoes-local').registrar(router, { CONFIG });

// ─── API: Apps (os aplicativos que o agente opera) ────────────
// Endpoint do nucleo, sem poder: quem decide se ha app e o proprio agente, pelo
// .dgclaw/apps.json dele. Todo erro daqui desce com MOTIVO em portugues, porque a
// aba Apps nunca pode virar tela em branco.

function responderApps(res, r) {
  if (r && r.erro) return res.status(r.status || 500).json({ error: r.erro });
  res.json(r);
}

router.get('/api/apps', (req, res) => {
  try {
    res.json(apps.listar());
  } catch (e) {
    res.status(500).json({ error: `Nao consegui ler a lista de apps: ${e.message}` });
  }
});

router.get('/api/apps/:app/conteudos', (req, res) => {
  try {
    responderApps(res, apps.projetos(req.params.app));
  } catch (e) {
    res.status(500).json({ error: `Nao consegui listar os conteudos: ${e.message}` });
  }
});

router.get('/api/apps/:app/conteudos/:slug', (req, res) => {
  try {
    responderApps(res, apps.projeto(req.params.app, req.params.slug));
  } catch (e) {
    res.status(500).json({ error: `Nao consegui abrir o conteudo: ${e.message}` });
  }
});

router.get('/api/apps/:app/conteudos/:slug/assets', (req, res) => {
  try {
    responderApps(res, apps.assets(req.params.app, req.params.slug));
  } catch (e) {
    res.status(500).json({ error: `Nao consegui listar o material: ${e.message}` });
  }
});

router.get('/api/apps/:app/conteudos/:slug/arquivo/:nome', (req, res) => {
  try {
    responderApps(res, apps.arquivo(req.params.app, req.params.slug, req.params.nome));
  } catch (e) {
    res.status(500).json({ error: `Nao consegui ler o arquivo: ${e.message}` });
  }
});

// Serve UM arquivo do disco para o navegador.
//
// POR QUE ISTO NÃO PASSA PELO `responderApps`. Aquele helper devolve JSON, e aqui
// o corpo da resposta é o próprio arquivo. O `{erro, status}` que os módulos
// devolvem continua sendo tratado, só que à mão: erro sai como texto simples, e o
// caminho feliz vira um `pipe` direto do disco para a resposta.
//
// STREAMING, e não `readFileSync`: o painel roda numa VPS pequena e um vídeo de
// 300 MB lido para a memória antes de responder derruba o processo inteiro, com o
// dono do agente vendo o painel cair por ter clicado numa miniatura.
//
// `nosniff` mais `sandbox` porque o arquivo veio da pasta do agente. O tipo que
// desce é o da tabela de lib/mime.js e mais nenhum, e um .svg servido inline não
// pode virar uma página que roda script na origem do painel.
function servirBinario(res, r, comoAnexo) {
  if (r && r.erro) return res.status(r.status || 500).type('text/plain; charset=utf-8').send(r.erro);
  res.type(r.mime);
  res.setHeader('Content-Length', r.bytes);
  res.setHeader('Content-Disposition', disposicao(r.nome, !!comoAnexo));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  // 60 segundos: o suficiente para a grade de miniaturas não rebuscar tudo a cada
  // redesenho da aba (que acontece a cada minuto), e curto para o arquivo trocado
  // no disco aparecer trocado na tela sem ninguém precisar limpar cache. `private`
  // porque isto é material do agente de UM dono, e não pode ficar em cache de meio.
  res.setHeader('Cache-Control', 'private, max-age=60');
  const fluxo = fs.createReadStream(r.caminho);
  fluxo.on('error', (err) => {
    console.error('[painel] falhou ao servir arquivo:', r.caminho, err.message);
    if (!res.headersSent) res.status(500).type('text/plain; charset=utf-8').send('Não consegui ler o arquivo do disco.');
    else res.destroy();
  });
  fluxo.pipe(res);
}

// A prévia de um asset. Existe porque, até ela, a aba Apps contava quantas imagens
// o agente juntou e não mostrava nenhuma: o dono via "14 arquivos" e continuava
// sem saber se o material presta.
router.get('/api/apps/:app/conteudos/:slug/asset/:nome', (req, res) => {
  try {
    servirBinario(res, apps.assetBinario(req.params.app, req.params.slug, req.params.nome), false);
  } catch (e) {
    res.status(500).type('text/plain; charset=utf-8').send(`Não consegui abrir o material: ${e.message}`);
  }
});

// A etapa pronta virando link para quem nao tem senha deste painel.
//
// POST e nao GET DE PROPOSITO: cada chamada PUBLICA um arquivo novo na internet,
// e isso nao pode acontecer por um navegador pre-carregando um link, nem ser
// repetido por um F5. Quem aperta o botao esta decidindo mandar o trabalho do
// agente para fora da casa.
router.post('/api/apps/:app/conteudos/:slug/compartilhar', async (req, res) => {
  try {
    const r = await compartilhar.publicar(req.params.slug);
    if (r && r.erro) {
      console.error('[painel] compartilhar falhou:', r.erro, r.detalhe || '');
      return res.status(r.status || 500).json({
        error: r.erro,
        howToFix: r.howToFix,
        detalhe: r.detalhe,
      });
    }
    console.log(`[painel] roteiro de ${req.params.slug} publicado em ${r.url}`);
    res.json(r);
  } catch (e) {
    console.error('[painel] erro ao compartilhar:', e);
    res.status(500).json({ error: `Nao consegui gerar o link: ${e.message}` });
  }
});

// ─── API: Pasta (os arquivos que o agente guarda) ─────────────
// Endpoint do núcleo, sem poder: todo agente tem uma pasta de trabalho. A raiz é
// travada em <agentDir>/arquivos pelo lib/arquivos.js, e nenhuma rota daqui aceita
// caminho que saia dela. Todo erro desce com motivo em português E o que fazer.

function responderArquivos(res, r) {
  if (r && r.erro) return res.status(r.status || 500).json({ error: r.erro });
  res.json(r);
}

router.get('/api/arquivos', (req, res) => {
  try {
    responderArquivos(res, arquivos.listar(req.query.path || ''));
  } catch (e) {
    res.status(500).json({ error: `Não consegui listar a pasta: ${e.message}` });
  }
});

router.get('/api/arquivos/conteudo', (req, res) => {
  try {
    responderArquivos(res, arquivos.ler(req.query.path || ''));
  } catch (e) {
    res.status(500).json({ error: `Não consegui abrir o arquivo: ${e.message}` });
  }
});

// O download e a prévia saem pela MESMA rota. Imagem, vídeo, áudio e PDF descem
// `inline`, para poderem abrir no visualizador; o resto desce como anexo, que é o
// único destino honesto de um .xlsx num navegador.
router.get('/api/arquivos/baixar', (req, res) => {
  try {
    const r = arquivos.binario(req.query.path || '');
    const abreNaTela = r && !r.erro && ['imagem', 'video', 'audio', 'pdf'].includes(r.tipo);
    servirBinario(res, r, !abreNaTela);
  } catch (e) {
    res.status(500).type('text/plain; charset=utf-8').send(`Não consegui baixar o arquivo: ${e.message}`);
  }
});

router.put('/api/arquivos', (req, res) => {
  try {
    const texto = req.body && typeof req.body.texto === 'string' ? req.body.texto : null;
    if (texto === null) {
      return res.status(400).json({
        error: 'Não veio texto nenhum no pedido, então o arquivo continua como estava.',
        howToFix: 'Abra o arquivo de novo, edite e clique em Salvar.',
      });
    }
    responderArquivos(res, arquivos.salvar(req.query.path || '', texto));
  } catch (e) {
    res.status(500).json({ error: `Não consegui salvar o arquivo: ${e.message}` });
  }
});

router.delete('/api/arquivos', (req, res) => {
  try {
    responderArquivos(res, arquivos.apagar(req.query.path || ''));
  } catch (e) {
    res.status(500).json({ error: `Não consegui apagar o arquivo: ${e.message}` });
  }
});

// O upload.
//
// SEM MULTER E SEM DEPENDÊNCIA NOVA. O corpo do POST é o arquivo inteiro e nada
// mais: nome e pasta viajam na URL, e por isso não há formulário multipart para
// desmontar. `express.raw` como middleware SÓ DESTA ROTA, e não global, porque um
// parser binário global engoliria o corpo de toda rota JSON do painel.
//
// A TELA MANDA `application/octet-stream` DE PROPÓSITO. O `express.json()` lá em
// cima é global e roda ANTES do router: se o navegador anunciasse o tipo real de
// um .json subido pelo dono, o JSON seria comido pelo parser errado e chegaria
// aqui como objeto, nunca como Buffer. Por isso o teste abaixo é explícito, e a
// mensagem diz o que aconteceu em vez de gravar um arquivo corrompido.
router.post(
  '/api/arquivos/upload',
  express.raw({ type: '*/*', limit: '25mb' }),
  (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({
          error: 'O arquivo não chegou como arquivo, e eu prefiro não gravar um pedaço de coisa nenhuma.',
          howToFix: 'Tente enviar de novo pelo botão Subir arquivo. Se continuar, recarregue a página antes.',
        });
      }
      responderArquivos(res, arquivos.subir(req.query.path || '', req.query.nome || '', req.body));
    } catch (e) {
      res.status(500).json({ error: `Não consegui guardar o arquivo: ${e.message}` });
    }
  },
);

// ─── API: Cofre ───────────────────────────────────────────────
//
// NENHUMA DESTAS ROTAS DEVOLVE O VALOR DE UM SEGREDO, e isso não depende de
// disciplina de quem escreve rota: o `lib/cofre.js` guarda metadado e valor em
// arquivos separados, e o único caminho que decifra é a materialização, que
// devolve contagem e não conteúdo. Não existe objeto aqui dentro com o valor.
//
// TAMBÉM NÃO EXISTE ROTA DE LEITURA EM CLARO, e isso é de propósito: se ela
// existisse, um dia alguém a chamaria. Quem perdeu a chave gera outra no
// provedor.

function responderCofre(res, r) {
  if (r && r.erro) {
    const corpo = { error: r.erro };
    if (r.howToFix) corpo.howToFix = r.howToFix;
    return res.status(r.status || 500).json(corpo);
  }
  res.json(r);
}

router.get('/api/cofre', (req, res) => {
  try {
    res.json(cofre.estado());
  } catch (e) {
    res.status(500).json({ error: `Não consegui abrir o cofre: ${e.message}` });
  }
});

router.post('/api/cofre', (req, res) => {
  try {
    const b = req.body || {};
    // Quem cadastrou fica registrado COM A ORIGEM: o dono precisa distinguir a chave
    // que ele mesmo colou na tela da que outro assistente colocou por API.
    const porApi = !!(req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api');
    const guardado = cofre.guardar({
      envName: b.envName,
      valor: b.valor,
      provedor: b.provedor,
      quem: porApi ? `${req.dgclawAuth.nome} (por API)` : quemFez(req),
      origem: porApi ? 'api' : 'tela',
    });
    if (guardado.erro || b.aplicar !== true) return responderCofre(res, guardado);

    // `aplicar: true`: guarda e reinicia na mesma chamada. Se o reinício falhar, a
    // chave CONTINUA guardada, e a resposta diz as duas coisas com status de erro,
    // para que quem só olha o status não ache que deu tudo certo.
    const aplicado = cofre.aplicar();
    if (aplicado && aplicado.erro) {
      return res.status(aplicado.status || 500).json({
        error: `A chave foi guardada. ${aplicado.erro}`,
        howToFix: aplicado.howToFix || 'Guardar já foi feito; falta só reiniciar o agente (aba Cofre, "aplicar e reiniciar").',
        guardado,
        aplicado: { ok: false, erro: aplicado.erro },
      });
    }
    res.json({ ...guardado, aplicado });
  } catch (e) {
    // A mensagem de exceção NÃO leva o corpo do pedido junto, e é por isso que
    // este catch não faz `JSON.stringify(req.body)`: o valor da chave está lá.
    res.status(500).json({ error: `Não consegui guardar a chave: ${e.message}` });
  }
});

router.delete('/api/cofre', (req, res) => {
  try {
    responderCofre(res, cofre.revogar(req.query.envName || '', CONFIG.creatorName || 'Dono'));
  } catch (e) {
    res.status(500).json({ error: `Não consegui revogar a chave: ${e.message}` });
  }
});

// Aplicar = preparar o ambiente e REINICIAR o agente. É o passo que faz a chave
// passar a valer, e ele é um botão separado do salvar de propósito: reiniciar o
// agente interrompe o que ele estiver fazendo, e essa é uma decisão do dono, não
// um efeito colateral de ter clicado em guardar.
router.post('/api/cofre/aplicar', (req, res) => {
  try {
    const r = cofre.aplicar();
    if (r && r.erro) {
      const corpo = { error: r.erro };
      if (r.howToFix) corpo.howToFix = r.howToFix;
      if (r.materializou) corpo.materializou = true;
      return res.status(r.status || 500).json(corpo);
    }
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: `Não consegui aplicar o cofre: ${e.message}` });
  }
});

// ─── API: Chaves de API do painel ─────────────────────────────
//
// NENHUMA CHAVE DE API GERENCIA CHAVES DE API. O requireAuth já barra o Bearer em
// /api/chaves-api*; o `soHumano` abaixo é a segunda tranca, para o dia em que
// alguém mexer lá e esquecer desta regra. O token só aparece na resposta do POST.

function soHumano(req, res, next) {
  if (req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api') {
    return res.status(403).json({
      error: 'Uma chave de API não pode criar, listar nem revogar chaves de API.',
      howToFix: 'Faça isto pela aba Cofre do painel (entrando com a senha).',
    });
  }
  next();
}

router.get('/api/chaves-api', soHumano, (req, res) => {
  try {
    res.json({ chaves: chavesApi.listar() });
  } catch (e) {
    res.status(500).json({ error: `Não consegui listar as chaves de API: ${e.message}` });
  }
});

router.post('/api/chaves-api', soHumano, (req, res) => {
  try {
    const r = chavesApi.criar({ nome: (req.body || {}).nome, quem: quemFez(req) });
    responderCofre(res, r);
  } catch (e) {
    res.status(500).json({ error: `Não consegui criar a chave de API: ${e.message}` });
  }
});

router.delete('/api/chaves-api', soHumano, (req, res) => {
  try {
    responderCofre(res, chavesApi.revogar(req.query.id || '', quemFez(req)));
  } catch (e) {
    res.status(500).json({ error: `Não consegui revogar a chave de API: ${e.message}` });
  }
});

// ─── API: Reuniões (poder meetings) ───────────────────────────

router.get('/api/reunioes', requirePower('meetings'), (req, res) => {
  const q = (req.query.q || '').trim();
  const items = q ? meetings.searchMeetings(q) : meetings.listMeetings();
  res.json({ items, count: items.length });
});

router.get('/api/reunioes/:id', requirePower('meetings'), (req, res) => {
  const m = meetings.getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});

// Stream do audio.raw como WAV (16kHz mono 16-bit LE)
router.get('/api/reunioes/:id/audio.wav', requirePower('meetings'), (req, res) => {
  const id = req.params.id;
  if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(id)) return res.status(400).send('bad id');
  const raw = path.join(P.MEETINGS_DIR, id, 'audio.raw');
  let stat;
  try { stat = fs.statSync(raw); } catch { return res.status(404).send('no audio'); }
  const dataLen = stat.size;
  const sr = 16000;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + dataLen, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(dataLen, 40);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', 44 + dataLen);
  res.write(hdr);
  fs.createReadStream(raw).pipe(res);
});

// Monta tudo sob o prefixo. BASE vazio → monta em "/", igual a hoje.
app.use(BASE || '/', router);

// O ultimo colchete: corpo grande demais ou JSON quebrado.
//
// POR QUE ELE EXISTE. Sem este trecho, quem estourava o teto do upload recebia a
// página de erro de fábrica do express: HTML, em inglês, com pilha de chamada. O
// dono do agente lia "PayloadTooLargeError" e não tinha o que fazer com isso. Aqui
// o erro vira frase com o limite escrito e com a saída, que é a informação que
// resolve o problema dele.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tipo = err && err.type;
  if (tipo === 'entity.too.large') {
    return res.status(413).json({
      error: 'O arquivo (ou o texto) passou do limite de tamanho deste painel.',
      howToFix: 'O teto é 25 MB para subir arquivo e 2 MB para editar texto na tela. ' +
        'Arquivo maior que isso o agente busca sozinho: peça a ele na aba Conversa.',
    });
  }
  if (tipo === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'O pedido chegou quebrado no meio do caminho, então nada foi alterado.',
      howToFix: 'Recarregue a página e tente de novo.',
    });
  }
  console.error('[painel] erro não tratado:', req.method, req.originalUrl, err && err.message);
  res.status(500).json({ error: `Deu erro no painel: ${err && err.message ? err.message : 'causa desconhecida'}` });
});

// ─── Start ────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`✦ ${CONFIG.agentName} Painel rodando em http://${HOST}:${PORT}${BASE || ''} (config: ${CONFIG._source})`);
});
