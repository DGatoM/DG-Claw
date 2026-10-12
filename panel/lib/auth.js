// auth.js — a porta do painel: senha, sessão, limite de tentativas, CSRF e chave de API.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ESTE LOGIN É A ÚNICA PORTA PARA UM AGENTE QUE RODA COMO ADMINISTRADOR    ║
// ║  DA MÁQUINA. Nada aqui tem "senha padrão", e nada falha calado.           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// O QUE MUDOU EM RELAÇÃO À VERSÃO ANTERIOR, e por quê:
//
//   1. Sem senha configurada (ou igual a "admin"), o painel antes caía em "admin"
//      sem avisar. Agora sobe TRANCADO: a tela de login explica o que falta, a API
//      responde 503 e o POST /login recusa. Default silencioso é o defeito.
//   2. A senha pode vir como hash scrypt (DGCLAW_PANEL_PASSWORD_HASH, preferido) ou
//      em texto (DGCLAW_PANEL_PASSWORD, só por compatibilidade com agente antigo).
//   3. O token do cookie deixou de ser sha256(sal:senha), que nunca vencia. Agora é
//      `v1.<expira-em-ms>.<hmac>`, assinado, com validade conferida no servidor.
//      Trocar a senha troca a chave do HMAC e derruba todas as sessões.
//   4. Limite de tentativas por IP, comparações em tempo constante, conferência de
//      Origin contra CSRF e chave de API (Bearer) para quem opera sem tela.
//
// O QUE NÃO ENTRA: X-Frame-Options e frame-ancestors. O painel é aberto dentro de
// uma fachada (iframe), e esses cabeçalhos o deixariam em branco lá.
//
// `base` é o prefixo DGCLAW_PANEL_BASE do painel (ex.: "/agente/ana/painel"), ou
// vazio quando o painel serve na raiz. O requireAuth roda MONTADO dentro do router
// do server.js, então req.path já chega SEM o prefixo (o Express tira antes de
// despachar). O redirect, porém, vai para o navegador, que fala com o domínio
// inteiro, por isso precisa levar o prefixo de volta, senão o dono cai num
// /login.html que não existe.

const crypto = require('crypto');
const fs = require('fs');

const SESSAO_MS = 30 * 24 * 60 * 60 * 1000;      // igual ao cookie de sempre: 30 dias
const JANELA_FALHAS_MS = 15 * 60 * 1000;
const MAX_FALHAS = 10;
const MIN_SENHA = 12;

// ─── Hash de senha (scrypt) ──────────────────────────────────────────────────
//
// Formato: scrypt$<N>$<r>$<p>$<sal base64url>$<hash base64url>. Os parâmetros vão
// DENTRO da linha para que dê para endurecê-los no futuro sem invalidar os hashes
// que já existem.

const SCRYPT = { N: 16384, r: 8, p: 1, tamanho: 32, sal: 16 };

function maxmemPara(N, r) {
  return 256 * N * r + 1024 * 1024;
}

function scryptAsync(senha, sal, tamanho, opts) {
  return new Promise((ok, falha) => {
    crypto.scrypt(senha, sal, tamanho, opts, (err, chave) => (err ? falha(err) : ok(chave)));
  });
}

async function gerarHash(senha) {
  const sal = crypto.randomBytes(SCRYPT.sal);
  const { N, r, p, tamanho } = SCRYPT;
  const h = await scryptAsync(String(senha), sal, tamanho, { N, r, p, maxmem: maxmemPara(N, r) });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64url')}$${h.toString('base64url')}`;
}

/** Lê a linha do hash. Devolve null se não for uma linha scrypt bem formada e razoável. */
function lerHash(linha) {
  const partes = String(linha || '').trim().split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null;
  const N = Number(partes[1]); const r = Number(partes[2]); const p = Number(partes[3]);
  // Teto nos parâmetros: o hash vem do ambiente, mas um valor absurdo (N = 2^30)
  // travaria o painel na primeira tentativa de login, com pouca memória.
  const potenciaDeDois = Number.isInteger(N) && N >= 2 && (N & (N - 1)) === 0;
  if (!potenciaDeDois || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const sal = Buffer.from(partes[4], 'base64url');
  const hash = Buffer.from(partes[5], 'base64url');
  if (sal.length < 8 || hash.length < 16) return null;
  return { N, r, p, sal, hash };
}

async function conferirHash(senha, linha) {
  const h = lerHash(linha);
  if (!h) return false;
  const calculado = await scryptAsync(String(senha), h.sal, h.hash.length, {
    N: h.N, r: h.r, p: h.p, maxmem: maxmemPara(h.N, h.r),
  });
  return crypto.timingSafeEqual(calculado, h.hash);
}

/**
 * Igualdade de texto em tempo constante. Compara os sha256 dos dois, que têm
 * sempre o mesmo tamanho: `timingSafeEqual` exige buffers do mesmo tamanho, e
 * comparar os textos crus vazaria o tamanho do segredo.
 */
function iguais(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ─── O que está configurado ──────────────────────────────────────────────────

/**
 * Lê o ambiente e diz em que modo o painel sobe.
 *   { modo: 'hash', hash }          senha em hash scrypt (preferido)
 *   { modo: 'texto', texto, curta } senha em texto (compatibilidade); curta = menos de 12
 *   { modo: 'trancado', motivo }    sem senha usável: nada entra
 */
function lerSenhaConfigurada(env) {
  const hash = String((env && env.DGCLAW_PANEL_PASSWORD_HASH) || '').trim();
  const texto = String((env && env.DGCLAW_PANEL_PASSWORD) || '');
  if (hash) {
    if (!lerHash(hash)) {
      return {
        modo: 'trancado',
        motivo: 'DGCLAW_PANEL_PASSWORD_HASH está definida, mas não tem o formato scrypt$N$r$p$sal$hash.',
      };
    }
    return { modo: 'hash', hash };
  }
  if (!texto.trim()) {
    return { modo: 'trancado', motivo: 'Este painel não tem senha configurada.' };
  }
  if (texto === 'admin') {
    return { modo: 'trancado', motivo: 'A senha configurada é "admin", que qualquer pessoa tenta primeiro.' };
  }
  return { modo: 'texto', texto, curta: texto.length < MIN_SENHA };
}

const COMO_RESOLVER =
  'Rode "node panel/bin/senha-hash.js" (ele pede a senha sem mostrar na tela e imprime uma linha começando por scrypt$), ' +
  'ponha essa linha em DGCLAW_PANEL_PASSWORD_HASH no ambiente da unidade do painel e reinicie o painel.';

// ─── O segredo do proxy ──────────────────────────────────────────────────────
//
// Quando o painel roda atrás de um proxy que já fez o login do dono (o "DG Claw
// Web"), o proxy prova quem é mandando `X-DGClaw-Proxy: <segredo>`. O segredo vem de
// um ARQUIVO (preferido: variável de ambiente aparece em `systemctl show` e em
// /proc/<pid>/environ) ou, na falta, de DGCLAW_PANEL_PROXY_SECRET.
//
// Segredo vazio NUNCA libera: sem ele configurado, o cabeçalho é ignorado, e um
// cabeçalho vazio contra um segredo vazio não pode ser "igual".

function lerSegredoDoProxy(env, log) {
  const arquivo = String((env && env.DGCLAW_PANEL_PROXY_SECRET_FILE) || '').trim();
  if (arquivo) {
    let stat;
    try {
      stat = fs.statSync(arquivo);
    } catch (err) {
      throw new Error(`DGCLAW_PANEL_PROXY_SECRET_FILE aponta para ${arquivo}, e eu não consegui abrir esse arquivo (${err.code || err.message}). ` +
        'Crie o arquivo com o segredo do proxy (modo 600) ou tire a variável do ambiente do painel.');
    }
    if (stat.mode & 0o077) {
      throw new Error(`O arquivo do segredo do proxy (${arquivo}) está legível por outros usuários da máquina (modo ${(stat.mode & 0o777).toString(8)}). ` +
        `Quem lê esse arquivo entra no painel como dono. O painel não sobe assim. Corrija com: chmod 600 ${arquivo}`);
    }
    const segredo = fs.readFileSync(arquivo, 'utf8').trim();
    if (!segredo) {
      log(`[painel] O arquivo do segredo do proxy (${arquivo}) está vazio, então a entrada pelo proxy fica DESLIGADA. Escreva o segredo nele e reinicie o painel.`);
      return '';
    }
    return segredo;
  }
  const texto = String((env && env.DGCLAW_PANEL_PROXY_SECRET) || '').trim();
  return texto;
}

// ─── A fábrica ───────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.env           process.env (ou um objeto de teste)
 * @param {string} o.authSalt      config.authSalt
 * @param {string} [o.base]        prefixo do painel atrás da fachada
 * @param {object} [o.chavesApi]   buildChavesApi(): conferir(token) -> {id,nome}|null
 * @param {function} o.renderLogin (req, res, {status, erro, min}) pinta a tela de login
 * @param {function} [o.agora]     relógio injetável (teste)
 * @param {function} [o.log]       console.error injetável (teste)
 */
function buildAuth(o) {
  const env = o.env || process.env;
  const base = o.base || '';
  const agora = o.agora || Date.now;
  const log = o.log || ((...a) => console.error(...a));
  const config = lerSenhaConfigurada(env);
  const trancado = config.modo === 'trancado';
  const usuario = String(env.DGCLAW_PANEL_USER || '').trim();
  const segredoProxy = lerSegredoDoProxy(env, log);

  if (trancado) {
    log(`[painel] TRANCADO: ${config.motivo} Ninguém entra até isso ser resolvido, e a API responde 503. ${COMO_RESOLVER}`);
  } else if (config.modo === 'texto' && config.curta) {
    log(`[painel] AVISO: a senha em DGCLAW_PANEL_PASSWORD tem menos de ${MIN_SENHA} caracteres. O painel funciona, mas este login é a ` +
      `porta de um agente que roda como administrador da máquina. ${COMO_RESOLVER}`);
  }

  // A chave do HMAC nasce do sal da instalação E do que está configurado como senha:
  // trocar a senha troca a chave e invalida todas as sessões que já existem.
  const material = config.modo === 'hash' ? config.hash : (config.modo === 'texto' ? config.texto : '');
  const chaveSessao = crypto.createHmac('sha256', String(o.authSalt || 'dgclaw-dash'))
    .update(`sessao:${material}`).digest();

  function assinar(expira) {
    return crypto.createHmac('sha256', chaveSessao).update(`v1.${expira}`).digest('base64url');
  }

  function emitirToken() {
    const expira = agora() + SESSAO_MS;
    return `v1.${expira}.${assinar(expira)}`;
  }

  function conferirToken(token) {
    if (trancado) return false;
    const partes = String(token || '').split('.');
    if (partes.length !== 3 || partes[0] !== 'v1' || !/^\d{10,16}$/.test(partes[1])) return false;
    const esperado = Buffer.from(assinar(partes[1]));
    const recebido = Buffer.from(partes[2]);
    // Tamanho diferente já é assinatura errada; o tamanho do HMAC não é segredo.
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return false;
    return Number(partes[1]) > agora();
  }

  async function senhaConfere(senha) {
    if (config.modo === 'hash') return conferirHash(senha, config.hash);
    if (config.modo === 'texto') return iguais(senha, config.texto);
    return false;
  }

  // ─── Limite de tentativas ──────────────────────────────────────────────────
  // Em memória: reiniciar o painel zera a contagem, e isso é aceito (o atacante
  // não controla o reinício). Cada IP guarda só as horas das falhas da janela.
  const falhas = new Map();

  function falhasRecentes(ip) {
    const corte = agora() - JANELA_FALHAS_MS;
    const lista = (falhas.get(ip) || []).filter((t) => t > corte);
    if (lista.length) falhas.set(ip, lista); else falhas.delete(ip);
    return lista;
  }

  /** Minutos que faltam para destravar, ou 0 se o IP pode tentar. */
  function minutosBloqueado(ip) {
    const lista = falhasRecentes(ip);
    if (lista.length < MAX_FALHAS) return 0;
    return Math.max(1, Math.ceil((lista[0] + JANELA_FALHAS_MS - agora()) / 60000));
  }

  function querJson(req) {
    const a = String(req.get('accept') || '');
    return /json/.test(a) && !/html/.test(a);
  }

  // ─── POST /login ───────────────────────────────────────────────────────────
  async function login(req, res) {
    const ip = req.ip || 'desconhecido';
    if (trancado) {
      if (querJson(req)) {
        return res.status(503).json({ error: `O painel está trancado: ${config.motivo}`, howToFix: COMO_RESOLVER });
      }
      return o.renderLogin(req, res, { status: 503 });
    }
    const min = minutosBloqueado(ip);
    if (min) {
      if (querJson(req)) {
        return res.status(429).json({
          error: `Muitas tentativas erradas. Espere ${min} minuto${min === 1 ? '' : 's'}.`,
          howToFix: 'Aguarde o tempo indicado e tente de novo com a senha certa.',
        });
      }
      return o.renderLogin(req, res, { status: 429, erro: 'bloqueado', min });
    }

    const b = req.body || {};
    // As duas conferências sempre rodam, para o tempo não dizer qual dos dois errou.
    const userOk = usuario ? iguais(b.user || '', usuario) : true;
    const senhaOk = await senhaConfere(String(b.password || ''));

    if (userOk && senhaOk) {
      falhas.delete(ip);
      res.cookie('dash_token', emitirToken(), {
        maxAge: SESSAO_MS, httpOnly: true, sameSite: 'lax', secure: !!req.secure, path: base || '/',
      });
      return res.redirect(base + '/');
    }

    const lista = falhasRecentes(ip);
    lista.push(agora());
    falhas.set(ip, lista);
    // Nunca vai a senha nem o usuário digitados: quem erra costuma ter colado a
    // senha no campo errado, e o log viraria um vazamento.
    log(`[painel] login recusado de ${ip}: ${usuario ? 'usuário ou senha' : 'senha'} incorreta (${lista.length} de ${MAX_FALHAS} falhas nos últimos 15 min).`);
    return res.redirect(base + '/login.html?error=1');
  }

  // ─── Cabeçalhos ────────────────────────────────────────────────────────────
  function cabecalhos(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  }

  // ─── Porta de entrada ──────────────────────────────────────────────────────
  const BEARER = /^Bearer\s+(dgc_[A-Za-z0-9_-]{20,})\s*$/;

  function requireAuth(req, res, next) {
    if (req.path === '/login' || req.path === '/login.html' ||
        req.path.startsWith('/css/') || req.path.startsWith('/assets/') ||
        req.path === '/favicon.ico') {
      return next();
    }
    const ehApi = req.path.startsWith('/api/');

    // TRANCADO desliga só a SENHA (e o cookie que nasce dela). O proxy, a chave de API
    // e o Access continuam valendo, porque cada um tem a própria credencial: no DG Claw
    // v1 o painel do container nem tem senha, quem faz o login do dono é o DG Claw Web,
    // que chega aqui pelo proxy. Sem nenhuma dessas três configurada, nada entra.

    // O Cloudflare Access já provou quem é: sinal explícito, e não um cookie falso.
    if (req.dgclawAuth === 'cf-access') return next();

    // O proxy do dono (ele fez o login) prova quem é com o segredo compartilhado.
    // Cabeçalho errado ou ausente cai no login normal, como se não existisse.
    const doProxy = req.get('x-dgclaw-proxy');
    if (segredoProxy && doProxy && iguais(doProxy, segredoProxy)) {
      const nome = String(req.get('x-dgclaw-usuario') || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
      req.dgclawAuth = { tipo: 'proxy', usuario: nome || 'Dono' };
      return next();
    }

    const cab = req.get('authorization');
    if (cab && ehApi && /^Bearer\s/i.test(cab)) {
      // Nenhuma chave gerencia chaves: se uma chave vazar, ela não consegue criar
      // outra para continuar entrando depois de revogada.
      if (req.path.startsWith('/api/chaves-api')) {
        return res.status(403).json({
          error: 'Uma chave de API não pode criar, listar nem revogar chaves de API.',
          howToFix: 'Faça isto pela aba Cofre do painel (entrando com a senha) ou, na máquina, com "node panel/bin/chave-api.js".',
        });
      }
      const m = BEARER.exec(cab);
      const achada = m && o.chavesApi ? o.chavesApi.conferir(m[1]) : null;
      if (!achada) {
        return res.status(401).json({
          error: 'A chave de API não foi aceita: ela está errada, foi revogada ou não é deste painel.',
          howToFix: 'Confira se a chave é a deste agente (cada agente tem as suas). Se foi revogada, crie outra na aba Cofre.',
        });
      }
      req.dgclawAuth = { tipo: 'chave-api', nome: achada.nome, id: achada.id };
      return next();
    }

    if (conferirToken(req.cookies && req.cookies.dash_token)) {
      req.dgclawAuth = 'cookie';
      return next();
    }

    if (trancado) {
      if (ehApi) {
        return res.status(503).json({ error: `O painel está trancado: ${config.motivo}`, howToFix: COMO_RESOLVER });
      }
      return res.redirect(`${base}/login.html`);
    }

    if (ehApi) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect(`${base}/login.html`);
  }

  // ─── CSRF por Origin ───────────────────────────────────────────────────────
  // Só vale para quem entrou por cookie ou Access, que são credenciais que o
  // navegador manda sozinho. Bearer não é mandado sozinho por navegador nenhum.
  // DGCLAW_PANEL_ORIGINS é a válvula para o proxy que reescreve o Host: sem ela,
  // esse painel ficaria impossível de usar e a única saída seria desligar a checagem.
  const extras = String(env.DGCLAW_PANEL_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  function deLoopback(req) {
    const a = String((req.socket && req.socket.remoteAddress) || '');
    return a === '::1' || a === '127.0.0.1' || a.startsWith('::ffff:127.');
  }

  function csrf(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    // Bearer não é mandado sozinho pelo navegador; o proxy já conferiu a Origin do dono.
    if (req.dgclawAuth && (req.dgclawAuth.tipo === 'chave-api' || req.dgclawAuth.tipo === 'proxy')) return next();
    // Navegador atual diz de onde veio o pedido mesmo quando omite a Origin.
    if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
      log(`[painel] CSRF: ${req.method} ${req.originalUrl} recusado, o navegador disse que veio de outro site (Sec-Fetch-Site).`);
      return res.status(403).json({
        error: 'Este pedido veio de outro site, e não da tela do painel. Recusei por segurança.',
        howToFix: 'Abra o painel pelo endereço dele e refaça a ação por lá.',
      });
    }
    const origem = req.get('origin');
    if (!origem) return next();
    let host = '';
    try { host = new URL(origem).host.toLowerCase(); } catch { /* "null" ou lixo: cai na recusa abaixo */ }
    // X-Forwarded-Host só vale vindo do proxy local; de fora, qualquer um o forjaria.
    const encaminhado = deLoopback(req) ? String(req.get('x-forwarded-host') || '').split(',')[0].trim().toLowerCase() : '';
    const meu = encaminhado || String(req.get('host') || '').toLowerCase();
    if (host && (host === meu || extras.includes(host))) return next();
    log(`[painel] CSRF: ${req.method} ${req.originalUrl} recusado, Origin ${origem} não é o endereço deste painel (${meu}).`);
    return res.status(403).json({
      error: 'Este pedido veio de outro site, e não da tela do painel. Recusei por segurança.',
      howToFix: 'Abra o painel pelo endereço dele e refaça a ação por lá. Se o endereço mudou por causa de um proxy, ' +
        'quem administra a máquina informa o endereço em DGCLAW_PANEL_ORIGINS.',
    });
  }

  return {
    trancado, motivo: config.motivo || null, modo: config.modo, usuarioObrigatorio: !!usuario,
    emitirToken, conferirToken, senhaConfere, minutosBloqueado,
    login, cabecalhos, requireAuth, csrf,
  };
}

module.exports = {
  buildAuth, gerarHash, conferirHash, lerHash, lerSenhaConfigurada, iguais,
  MIN_SENHA, MAX_FALHAS, SESSAO_MS, JANELA_FALHAS_MS, COMO_RESOLVER,
};
