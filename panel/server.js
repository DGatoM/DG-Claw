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
const P = buildPaths(CONFIG);

const { buildAuth } = require('./lib/auth');
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
// que cada modo faz estão no cabeçalho de lib/auth.js. O template de HTML (lib/html-template.js)
// só existe depois da autenticação, então `renderLogin` chega por uma função: ela roda
// quando chega um pedido, não na construção.
let auth;
let html;
try {
  auth = buildAuth({
    env: process.env,
    authSalt: AUTH_SALT,
    base: BASE,
    chavesApi,
    renderLogin: (req, res, o) => html.renderLogin(req, res, o),
  });
} catch (e) {
  // Configuração de segurança errada derruba a subida, com o motivo escrito: subir
  // assim mesmo seria deixar a porta aberta sem ninguém saber.
  console.error(`[painel] NÃO SUBI: ${e.message}`);
  process.exit(1);
}
html = require('./lib/html-template')({ BASE, CONFIG, serverDir: __dirname, getAuth: () => auth });

// Quem fez o pedido, em palavras, para o registro do cofre e das chaves de API.
function quemFez(req) {
  const a = req.dgclawAuth;
  if (a && a.tipo === 'proxy') return a.usuario;
  return CONFIG.creatorName || 'Dono';
}

// Powers (poderes travados): ver lib/poderes.js.
const { readPowers, requirePower } = require('./lib/poderes')(CONFIG);

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

// Cloudflare Access: entrada sem senha para quem o Access já conferiu (ver lib/cf-access.js).
router.use(require('./lib/cf-access')({ auth }).cfAccessAuth);

// Auth middleware: cookie de sessão, Access ou chave de API (Bearer)
router.use(auth.requireAuth);
// Pedido que escreve, vindo do navegador, precisa ter nascido na própria tela do painel.
router.use(auth.csrf);

router.get(['/', '/index.html'], html.renderHtmlTemplate(html.INDEX_HTML));
router.get('/login.html', (req, res) => html.renderLogin(req, res));

// Static files: só o que NÃO precisa de template (css/js/assets). `index: false` pra
// nunca deixar o express.static servir o index.html CRU (sem {{BASE}} trocado); as duas
// rotas acima, registradas antes, já respondem por "/" de qualquer forma.
router.use(express.static(html.PUBLIC_DIR, { index: false }));

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

// ─── Rotas por área (rotas/*.js) ──────────────────────────────

const ctx = {
  CONFIG, P, TZ, BASE, serverDir: __dirname,
  conversa, costs, pulso, apps, arquivos, cofre, chavesApi, compartilhar, meetings,
  requirePower, readPowers, quemFez,
  isPathAllowed, explicarRecusa, TETO_LEITURA_BYTES, getCronsForDate,
};

require('./rotas/nucleo')(router, ctx);

// Frente A (01/10/2026): saúde da RESPOSTA do agente (/api/saude, com `diagnostico`), reinício normal e em modo de segurança, e a sessão de socorro. Ver lib/rotas-saude.js.
const rotasSaude = require('./lib/rotas-saude')(router, { CONFIG, conversa, serverDir: __dirname });
// Frente de provedores (12/10/2026): bloco "Modelo e autenticação" da tela Status. Ver lib/provedores.js.
require('./lib/provedores')(router, { CONFIG, cofre, serverDir: __dirname });

require('./rotas/conversa')(router, ctx);
require('./rotas/instagram')(router, ctx);
require('./rotas/memoria')(router, ctx);
require('./rotas/operacoes')(router, ctx);
require('./rotas/custos')(router, ctx);

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

require('./rotas/apps')(router, ctx);
require('./rotas/arquivos')(router, ctx);
require('./rotas/cofre')(router, ctx);
require('./rotas/reunioes')(router, ctx);

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
