#!/usr/bin/env node
'use strict';
// DG Claw Web: login, conversa com os agentes, proxy dos painéis. Node 22, sem dependências.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const H = require('./lib/http');
const { carregaConfig } = require('./lib/config');
const { criarRegistro } = require('./lib/registro');
const { criarRunner } = require('./lib/runner');
const { criarAuth } = require('./lib/auth');
const { criarMidia } = require('./lib/media');
const { criarCompartilhados } = require('./lib/compartilhados');
const { criarLeitor, paraContainer } = require('./lib/thread');
const { criarLeitorRollout } = require('./lib/rollout');
const { criarConversa, RX_CLIENTE_ID } = require('./lib/conversa');
const { criarComandos } = require('./lib/comandos');
const { lerMultipart, nomeSeguro, gravaSemSobrescrever } = require('./lib/uploads');
const { abrirStream } = require('./lib/sse');
const { criarProxy } = require('./lib/proxy');
const { criarCofreAgente } = require('./lib/cofre-agente');
const { criarCofreRotas } = require('./lib/cofre-rotas');
const { criarAlertas } = require('./lib/alertas');
const { criarFoco } = require('./lib/foco');
const { criarVoz } = require('./lib/voz');
const { criarSigilo } = require('./lib/sigilo');
const { criarOnboarding } = require('./lib/onboarding');
const { criarLogin } = require('./lib/login');
const { criarPrimeiroAcesso } = require('./lib/primeiro-acesso');
const { criarCaixaAgente, quemChamou } = require('./lib/caixa-agente');
const { criarPush } = require('./lib/push');
const { criarLembretes } = require('./lib/lembretes');
const { criarMesa } = require('./lib/mesa');
const { criarAvisos } = require('./lib/avisos');

const METODOS_QUE_ESCREVEM = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TIPOS_ESTATICOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const RX_SLUG_ROTA = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LOGIN_RESERVA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar</title>' +
  '<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:14vh auto;padding:0 1rem}input,button{display:block;width:100%;margin:.5rem 0;padding:.6rem;font-size:1rem}</style></head><body>' +
  '<h1>DG Claw</h1><p id="e" style="color:#b00"></p><form method="post" action="/login"><input name="usuario" placeholder="Usuário" autocomplete="username" required>' +
  '<input name="senha" type="password" placeholder="Senha" autocomplete="current-password" required><input type="hidden" name="next" value=""><button>Entrar</button></form>' +
  '<script>var q=new URLSearchParams(location.search);document.getElementById("e").textContent=q.get("erro")||"";document.querySelector("[name=next]").value=q.get("next")||"/"</script></body></html>';

/** `next` só vale se for caminho relativo do próprio site. */
function proximoSeguro(v) {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\x00-\x1f]/.test(s) || s.startsWith('/login') || s.startsWith('/sair')) return '/';
  return s;
}

function criarServidor(opcoes) {
  opcoes = opcoes || {};
  const log = opcoes.log || H.logPadrao;
  const config = carregaConfig(opcoes, log);

  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.dataDir, 0o700);
  } catch (e) {
    log('erro', `Não consegui preparar a pasta de dados ${config.dataDir} (${e.code || e.message}). Crie-a com permissão 700 ou aponte DGCLAW_WEB_DATA para um lugar gravável; as sessões não serão salvas.`);
  }

  const registro = criarRegistro({ caminho: config.agentesPath, log });
  const runner = criarRunner({ log, timeoutMs: opcoes.timeoutRunnerMs });
  const auth = criarAuth({ config, log, agora: opcoes.agora });
  const primeiroAcesso = criarPrimeiroAcesso({ config, auth, log, agora: opcoes.agora });
  const midia = criarMidia({ dataDir: config.dataDir, log, registro, publicDir: config.publicDir });
  const leitor = criarLeitor({ log, tz: config.tz, canalTelegram: config.canalTelegram, midia });
  const leitorRollout = criarLeitorRollout({ log, tz: config.tz, midia });
  const alertas = agente => criarAlertas(path.join(config.dataDir, 'alertas', agente.slug + '.json'), agente.chat_id);
  const comandos = criarComandos({ runner, log, agora: opcoes.agora });
  const conversa = criarConversa({ comandos, alertas, config, runner, leitor, leitorRollout, midia, log, agora: opcoes.agora, gravaToken: opcoes.gravaToken });
  const compartilhados = criarCompartilhados(conversa);
  const onboarding = criarOnboarding({ config, registro, conversa, midia, log, imagem: opcoes.imagem });
  const login = criarLogin({ runner, conversa, log, agora: opcoes.agora, oiPrazoMs: opcoes.loginOiPrazoMs, oiPassoMs: opcoes.loginOiPassoMs });
  const cofreAgente = criarCofreAgente({ config, log, reiniciar: opcoes.reiniciarCofre });
  const voz = opcoes.voz || criarVoz({ env: config.env, log });
  const sigilo = opcoes.sigilo || criarSigilo({ env: config.env, registro, dataDir: config.dataDir, log, timeoutMs: opcoes.timeoutSigiloMs });
  const cofreRotas = criarCofreRotas({ config, runner, cofre: cofreAgente, voz, log });
  const proxy = criarProxy({ config, registro, log, cofreRotas });
  const caixa = criarCaixaAgente({ config, registro, log, porta: () => servidor.address().port, agora: opcoes.agora });
  const push = criarPush({ dataDir: config.dataDir, log, agora: opcoes.agora, enviarHttp: opcoes.enviarPush });
  try { push.garantirChaves(); } catch (e) { log('erro', e.message); }
  const lembretes = criarLembretes({ config, registro, runner, push, log, agora: opcoes.agora });
  caixa.permitir('/api/v1/lembretes');
  // Modo foco: o agente chega pela caixa (dgclaw-api), o retrato vai para a casa dele e o PUT do agente avisa o celular.
  const foco = criarFoco({ dir: path.join(config.dataDir, 'foco'), tz: config.tz, log, registro, gravaRetrato: opcoes.gravaRetrato || caixa.gravaRetrato, push: opcoes.push || push, quemChamou: opcoes.quemChamou || quemChamou });
  caixa.permitir('/api/v1/foco');
  const mesa = criarMesa({ arquivo: path.join(config.dataDir, 'mesa', 'tarefas.json'), registro, runner, log, agora: opcoes.agora, tz: config.tz, avisarDono: (aviso) => push.enviar(aviso) });
  // O agente fala com a Mesa pelo dgclaw-mesa, que passa pela caixa: a rota precisa estar liberada.
  caixa.permitir('/api/v1/tarefas');
  const avisos = criarAvisos({ config, registro, runner, caixa, log, agora: opcoes.agora });
  caixa.permitir('/api/v1/avisos');

  let versaoJsCache = { ts: 0, valor: '0' };
  /** Versão da tela: mtime de conversa.js. A tela compara com a que carregou e se recarrega sozinha. */
  function versaoJs() {
    if (Date.now() - versaoJsCache.ts < 5000) return versaoJsCache.valor;
    let valor = '0';
    try { valor = Math.round(fs.statSync(path.join(config.publicDir, 'conversa.js')).mtimeMs).toString(36); } catch (_) { /* tela ausente: versão 0 */ }
    versaoJsCache = { ts: Date.now(), valor };
    return valor;
  }

  // ── arquivos estáticos e páginas ─────────────────────────────────────────
  function servirArquivo(req, res, caminho, cache) {
    let st;
    try { st = fs.statSync(caminho); } catch (_) { return false; }
    if (!st.isFile()) return false;
    const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const tipo = TIPOS_ESTATICOS[path.extname(caminho).toLowerCase()] || 'application/octet-stream';
    const cab = { 'Content-Type': tipo, ETag: etag, 'Cache-Control': cache || 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (path.basename(caminho) === 'sw.js') cab['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, cab); res.end(); return true; }
    cab['Content-Length'] = st.size;
    res.writeHead(200, cab);
    if (req.method === 'HEAD') { res.end(); return true; }
    const s = fs.createReadStream(caminho);
    s.on('error', (e) => { log('erro', `Falha lendo o arquivo estático ${caminho} (${e.code || e.message}).`); res.destroy(); });
    s.pipe(res);
    return true;
  }

  function arquivoPublico(urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath); } catch (_) { return null; }
    if (rel.includes('\0')) return null;
    const raiz = path.resolve(config.publicDir);
    const alvo = path.resolve(raiz, '.' + rel);
    if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) return null;
    let real; let raizReal;
    try { real = fs.realpathSync(alvo); raizReal = fs.realpathSync(raiz); } catch (_) { return null; }
    if (!real.startsWith(raizReal + path.sep)) return null;
    return real;
  }

  const ehMutacao = (req) => METODOS_QUE_ESCREVEM.has(req.method);

  function origemOk(req) {
    const o = req.headers.origin;
    if (!o || o === 'null') return false;
    const norm = String(o).replace(/\/+$/, '');
    return norm === H.origemPropria(req, config.proxiesConfiaveis) || config.origensExtras.has(norm);
  }

  const querHtml = (req) => /\btext\/html\b/.test(String(req.headers.accept || ''));

  function semSessaoPagina(req, res, url) {
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
    res.end();
  }

  /* A rota "/" abre o último agente usado (cookie dgclaw_agente, gravado pela casca), se ele ainda existe no registro;
     senão o primeiro que não é o Admin (é com ele que a pessoa trabalha); senão o Admin. */
  function agenteInicial(req) {
    const agentes = registro.estado().agentes;
    let guardado = H.parseCookies(req.headers.cookie).dgclaw_agente;
    try { guardado = guardado && decodeURIComponent(guardado); } catch (_) { guardado = null; /* cookie ilegível: cai no primeiro agente */ }
    const doCookie = guardado && agentes.find((a) => a.slug === guardado);
    if (doCookie) return doCookie.slug;
    const trabalho = agentes.find((a) => a.tipo !== 'admin');
    return (trabalho || agentes[0]).slug;
  }

  function falhaDoRegistro(req, res, api) {
    const est = registro.estado();
    if (est.ok) return false;
    if (api) H.erroJson(res, 503, est.erro); else H.paginaErro(res, 503, 'Lista de agentes indisponível', est.erro);
    return true;
  }

  // ── login ────────────────────────────────────────────────────────────────
  // Formulário (navegador): erro volta como 302 para /login?erro=<código>&next=...
  // Códigos: credenciais, limite, origem, campos, bloqueado. JSON (Accept/Content-Type): status e {ok,erro}.
  function voltaAoLogin(res, codigo, next, usuario) {
    let destino = `/login?erro=${codigo}`;
    if (next && next !== '/') destino += `&next=${encodeURIComponent(next)}`;
    if (usuario && usuario.length < 80) destino += `&usuario=${encodeURIComponent(usuario)}`;
    res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store' });
    res.end();
  }

  async function postLogin(req, res, url) {
    const ip = H.ipDoPedido(req, config.proxiesConfiaveis);
    const corpoJson = /application\/json/i.test(String(req.headers['content-type'] || ''));
    const json = corpoJson || (/application\/json/i.test(String(req.headers.accept || '')) && !querHtml(req));
    let campos = {};
    try {
      const buf = await H.lerCorpo(req, 16 * 1024);
      const texto = buf.toString('utf8');
      if (corpoJson) campos = JSON.parse(texto || '{}');
      else campos = Object.fromEntries(new URLSearchParams(texto));
    } catch (e) {
      return json ? H.erroJson(res, e.status || 400, 'Não entendi o corpo do login. Mande usuario e senha.') : voltaAoLogin(res, 'campos', '/');
    }
    const next = proximoSeguro(campos.next);
    const usuarioDigitado = String(campos.usuario == null ? '' : campos.usuario);
    if (!usuarioDigitado || !campos.senha) {
      return json ? H.erroJson(res, 400, 'Preencha o usuário e a senha.') : voltaAoLogin(res, 'campos', next, usuarioDigitado);
    }
    const r = await auth.verificaSenha(usuarioDigitado, String(campos.senha), ip);
    if (r.ok) {
      const s = auth.criaSessao(r.usuario, req);
      log('info', `Login de ${r.usuario} (ip ${ip}).`);
      const cab = { 'Set-Cookie': s.cookie, 'Cache-Control': 'no-store' };
      if (json) return H.enviaJson(res, 200, { ok: true, destino: next }, cab);
      res.writeHead(303, Object.assign({ Location: next }, cab));
      return res.end();
    }
    if (r.limite) {
      log('aviso', `Login bloqueado por excesso de tentativas (ip ${ip}); libera em ${r.retryAfter} s.`);
      if (json) return H.erroJson(res, 429, r.erro, { retryAfter: r.retryAfter }, { 'Retry-After': String(r.retryAfter) });
      res.setHeader('Retry-After', String(r.retryAfter));
      return voltaAoLogin(res, 'limite', next, usuarioDigitado);
    }
    if (r.trancado) {
      log('aviso', `Tentativa de login com o acesso trancado (ip ${ip}).`);
      return json ? H.erroJson(res, 403, r.erro, { trancado: true }) : voltaAoLogin(res, 'bloqueado', next);
    }
    log('aviso', `Login recusado (ip ${ip}): usuário ou senha incorretos.`);
    if (json) return H.erroJson(res, 401, r.erro);
    return voltaAoLogin(res, 'credenciais', next, usuarioDigitado);
  }

  // ── primeiro acesso (link de uso único, sem sessão) ──────────────────────
  async function postPrimeiroAcesso(req, res) {
    const ip = H.ipDoPedido(req, config.proxiesConfiaveis);
    let campos;
    try {
      const buf = await H.lerCorpo(req, 16 * 1024);
      campos = JSON.parse(buf.toString('utf8') || '{}');
    } catch (e) {
      return H.erroJson(res, e.status || 400, 'Não entendi o pedido. Recarregue a página e tente de novo.');
    }
    const r = await primeiroAcesso.consumir(campos && typeof campos === 'object' ? campos : {}, ip, req);
    const cab = { 'Cache-Control': 'no-store' };
    if (r.cookie) cab['Set-Cookie'] = r.cookie;
    if (r.status === 429 && r.corpo.retryAfter) cab['Retry-After'] = String(r.corpo.retryAfter);
    if (r.status >= 400) return H.erroJson(res, r.status, r.corpo.erro, r.corpo.retryAfter ? { retryAfter: r.corpo.retryAfter } : undefined, cab);
    return H.enviaJson(res, r.status, r.corpo, cab);
  }

  // ── API ──────────────────────────────────────────────────────────────────
  function avatarDe(a) {
    const foto = onboarding.foto(a.slug);
    if (foto) return { avatar: a.nome.slice(0, 1), avatar_img: foto };
    const av = a.avatar || '';
    if (/^https:\/\//i.test(av)) return { avatar: (a.nome[0] || '?').toUpperCase(), avatar_img: av };
    return { avatar: av || (a.nome[0] || '?').toUpperCase(), avatar_img: null };
  }

  async function agentePublico(a) {
    const rotulo = await conversa.rotuloProvedor(a);
    return Object.assign({
      id: a.slug, nome: a.nome, subtitulo: a.subtitulo || rotulo, cor: a.cor, tipo: a.tipo,
      provedor: a.provedor, modelo: a.modelo, rotulo_provedor: rotulo,
      tem_painel: !!a.porta_painel, painel_url: a.porta_painel ? `/p/${a.slug}/` : null,
      voz: voz.vozDoAgente(a), tem_voz: voz.vozDoAgente(a), microfone: voz.microfone,
    }, avatarDe(a));
  }

  function agenteOuErro(res, id) {
    const a = registro.obter(id);
    if (!a) { H.erroJson(res, 404, `Não existe agente com o id "${id}". Veja GET /api/v1/agents.`); return null; }
    return a;
  }

  function numeroOuErro(res, nome, bruto, pad, min, max) {
    if (bruto == null || bruto === '') return pad;
    const n = Number(bruto);
    if (!Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)) {
      H.erroJson(res, 400, `O parâmetro "${nome}" precisa ser um número${min != null ? ` entre ${min} e ${max}` : ''}. Recebi: ${String(bruto).slice(0, 40)}.`);
      return undefined;
    }
    return n;
  }

  async function api(req, res, url, sessao) {
    const p = url.pathname;
    const m = req.method;
    if (p.startsWith('/api/v1/tarefas') && await mesa.rota(req, res, url, sessao)) return undefined;

    if (await foco.tratarRota(req, res, url, sessao)) return undefined;

    if ((p === '/api/v1/lembretes' || p.startsWith('/api/v1/lembretes/')) && await lembretes.rotas(req, res, url, sessao)) return undefined;

    if (p === '/api/v1/onboarding') {
      if (falhaDoRegistro(req, res, true)) return;
      try {
        if (m === 'GET') return H.enviaJson(res, 200, { ok: true, ...await onboarding.estado() });
        if (m === 'POST') {
          const corpo = await H.lerJson(req, 8 * 1024);
          return H.enviaJson(res, 200, { ok: true, ...await onboarding.solicitar(corpo, sessao.usuario) });
        }
        return H.erroJson(res, 405, 'Use GET para acompanhar ou POST para criar pelo Admin.');
      } catch (e) { return H.erroJson(res, e.status || 500, e.status ? e.message : 'Não consegui guardar o pedido. Peça ao Admin para conferir o espaço e as permissões do servidor.'); }
    }

    if (p === '/api/v1/onboarding/animacao-vista') {
      if (falhaDoRegistro(req, res, true)) return;
      if (m !== 'POST') return H.erroJson(res, 405, 'Use POST com o id do pedido para marcar a animação como vista.');
      try {
        const corpo = await H.lerJson(req, 1024);
        return H.enviaJson(res, 200, { ok: true, ...onboarding.animacaoVista(corpo && corpo.id) });
      } catch (e) { return H.erroJson(res, e.status || 500, e.status ? e.message : 'Não consegui guardar que a animação já tocou. Peça ao Admin para conferir o espaço e as permissões do servidor.'); }
    }

    if (p === '/api/v1/onboarding/cartao-dispensado') {
      if (falhaDoRegistro(req, res, true)) return;
      if (m !== 'POST') return H.erroJson(res, 405, 'Use POST com o id do pedido para dispensar o cartão.');
      try {
        const corpo = await H.lerJson(req, 1024);
        return H.enviaJson(res, 200, { ok: true, ...onboarding.dispensarCartao(corpo && corpo.id) });
      } catch (e) { return H.erroJson(res, e.status || 500, e.status ? e.message : 'Não consegui guardar que o cartão foi dispensado. Peça ao Admin para conferir o espaço e as permissões do servidor.'); }
    }

    if (p === '/api/v1/eu' && m === 'GET') return H.enviaJson(res, 200, { ok: true, usuario: sessao.usuario });

    if (p === '/api/v1/agents' && m === 'GET') {
      if (falhaDoRegistro(req, res, true)) return undefined;
      const lista = await Promise.all(registro.estado().agentes.map(agentePublico));
      return H.enviaJson(res, 200, { ok: true, agentes: lista, voz: lista.some((a) => a.voz), microfone: voz.microfone, limite_upload_bytes: config.maxUploadBytes, usuario: sessao.usuario });
    }

    if (p === '/api/v1/compartilhados/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'MIDIAS-CACHE.md')));
    }

    if (p === '/api/v1/alertas/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'ALERTAS.md'), 'utf8'));
    }
    const ar = /^\/api\/v1\/agents\/([^/]+)\/alertas(?:\/([a-f0-9]{24})\/(visto|mensagem))?$/.exec(p);
    if (ar) {
      if (falhaDoRegistro(req, res, true)) return;
      const agente = agenteOuErro(res, decodeURIComponent(ar[1]));
      if (!agente) return;
      try {
        const loja = alertas(agente);
        if (!ar[2] && m === 'GET') {
          const t = await conversa.thread(agente);
          return H.enviaJson(res, 200, { ok: true, alertas: loja.listar(), avisos: t.avisos });
        }
        if (ar[3] === 'visto' && m === 'POST') {
          if (!loja.reconhecer(ar[2])) return H.erroJson(res, 404, 'Esse alerta não existe nesta conversa. Atualize a página.');
          return H.enviaJson(res, 200, { ok: true });
        }
        if (ar[3] === 'mensagem' && m === 'GET') {
          const t = await conversa.thread(agente);
          const mensagem = loja.mensagem(ar[2]);
          if (!mensagem) return H.erroJson(res, 404, 'Esse alerta não existe nesta conversa. Atualize a página.');
          // Carrega a origem e a sequência até o fim, sem lacuna na rolagem.
          const atuais = t.msgs.filter(x => x.ep >= mensagem.ep);
          if (!atuais.some(x => x.id === mensagem.id)) atuais.unshift(mensagem);
          return H.enviaJson(res, 200, { ok: true, mensagem, msgs: atuais, mais_antigas: t.msgs.some(x => x.ep < mensagem.ep), avisos: t.avisos });
        }
        return H.erroJson(res, 405, 'Método inválido para este alerta. Use GET para consultar ou POST para reconhecer.');
      } catch (e) {
        log('erro', `Alertas de ${agente.slug}: ${m} ${p} falhou: ${e.message}. Confira a pasta de dados do Web.`);
        return H.erroJson(res, 503, `Não consegui acessar os alertas. Tente novamente: ${e.message}`);
      }
    }

    if (p === '/api/v1/login/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'LOGIN-NA-CONVERSA.md'), 'utf8'));
    }
    const lr = /^\/api\/v1\/agents\/([^/]+)\/login(?:\/(codigo|oi))?$/.exec(p);
    if (lr) {
      if (falhaDoRegistro(req, res, true)) return undefined;
      const agente = agenteOuErro(res, decodeURIComponent(lr[1]));
      if (!agente) return undefined;
      let r = null;
      if (!lr[2] && m === 'GET') r = await login.ver(agente);
      else if (!lr[2] && m === 'POST') r = await login.comecar(agente);
      else if (!lr[2] && m === 'DELETE') r = await login.cancelar(agente);
      else if (lr[2] === 'codigo' && m === 'POST') {
        const corpo = await lerEnvio(req, res);
        if (!corpo) return undefined;
        r = await login.enviarCodigo(agente, corpo);
      } else if (lr[2] === 'oi' && m === 'POST') r = await login.primeiroOi(agente);
      if (!r) return H.erroJson(res, 405, `Método inválido para ${p}. Use GET, POST e DELETE em /login, e POST em /login/codigo e /login/oi.`);
      return H.enviaJson(res, r.status, r.corpo);
    }

    if (p === '/api/v1/caixa/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'docs', 'CAIXA-DO-AGENTE.md'), 'utf8'));
    }
    if (p === '/api/v1/push/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'AVISOS-NO-APARELHO.md'), 'utf8'));
    }
    if (p === '/api/v1/avisos' || p.startsWith('/api/v1/avisos/')) {
      if (await avisos.tratar(req, res, url, sessao)) return undefined;
    }
    if (p === '/api/v1/push' || p.startsWith('/api/v1/push/')) {
      if (await push.rotas(req, res, url, sessao)) return undefined;
    }

    if (p === '/api/v1/comandos/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'COMANDOS-DE-BARRA.md'), 'utf8'));
    }

    if (p === '/api/v1/trilha/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'TRILHA-E-PERMISSAO.md'), 'utf8'));
    }

    let mm = /^\/api\/v1\/agents\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
    if (mm) {
      if (falhaDoRegistro(req, res, true)) return undefined;
      const agente = agenteOuErro(res, decodeURIComponent(mm[1]));
      if (!agente) return undefined;
      const acao = mm[2] || '';
      if (acao === '' && m === 'GET') return H.enviaJson(res, 200, { ok: true, agente: await agentePublico(agente) });
      if (acao === 'compartilhados' && m === 'GET') {
        try {
          if (url.searchParams.has('mensagem')) {
            const t = await conversa.thread(agente), id = url.searchParams.get('mensagem');
            const origem = t.msgs.find(x => x.id === id);
            if (!origem) return H.erroJson(res, 404, 'A mensagem não está nesta sessão. Atualize a lista.');
            return H.enviaJson(res, 200, { ok: true, mensagem: origem, msgs: t.msgs.filter(x => x.ep >= origem.ep) });
          }
          return H.enviaJson(res, 200, await compartilhados(agente, url.searchParams));
        }
        catch (e) { log('aviso', `Acervo de ${agente.slug}: ${e.message}`); return H.erroJson(res, 400, e.message); }
      }
      if (acao === 'messages' && m === 'GET') return mensagens(req, res, url, agente);
      if (acao === 'stream' && m === 'GET') return stream(req, res, url, agente);
      if (acao === 'wait' && m === 'GET') return esperar(req, res, url, agente);
      if (acao === 'send' && m === 'POST') return enviar(req, res, agente);
      if (acao === 'permissao' && m === 'POST') {
        const corpo = await lerEnvio(req, res);
        if (!corpo) return undefined;
        const r = await conversa.permissao(agente, corpo.decisao);
        return H.enviaJson(res, r.status, r.corpo);
      }
      if (acao === 'upload' && m === 'POST') return upload(req, res, agente);
      if (acao === 'comandos' && m === 'GET') return H.enviaJson(res, 200, Object.assign({ ok: true, agente: agente.slug }, await comandos.catalogo(agente)));
      if (acao === 'comando' && m === 'POST') return comandoPost(req, res, agente);
      return H.erroJson(res, ['messages', 'stream', 'wait', 'send', 'upload', 'permissao', 'comandos', 'comando', ''].includes(acao) ? 405 : 404, `Não existe ${m} ${p}.`);
    }

    mm = /^\/api\/v1\/media\/([0-9a-f]{16})\/visual$/.exec(p);
    if (mm && (m === 'GET' || m === 'HEAD')) return midia.servirVisual(req, res, mm[1], url.searchParams.get('tema'));

    mm = /^\/api\/v1\/media\/([0-9a-f]{16})(?:\/(thumb))?$/.exec(p);
    if (mm && (m === 'GET' || m === 'HEAD')) return midia.servir(req, res, mm[1], mm[2] ? 'thumb' : 'arquivo', url.searchParams.get('baixar') === '1');

    if (p === '/api/v1/sigilo/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'SIGILO.md'), 'utf8'));
    }
    if (p === '/api/v1/sigilo/estado' && m === 'GET') return H.enviaJson(res, 200, Object.assign({ ok: true }, sigilo.estado()));
    if (p === '/api/v1/sigilo') {
      if (m !== 'POST') return H.erroJson(res, 405, 'Use POST com {"textos": [...]}. O estado do modo escondido está em GET /api/v1/sigilo/estado.');
      let corpo;
      try { corpo = await H.lerJson(req, 4 * 1024 * 1024); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
      const v = sigilo.validaEntrada(corpo);
      if (v.erro) return H.erroJson(res, 400, v.erro);
      return H.enviaJson(res, 200, Object.assign({ ok: true }, await sigilo.analisar(v.textos)));
    }

    if (p === '/api/v1/transcribe' && m === 'POST') return transcrever(req, res);
    if (p === '/api/v1/tts' && m === 'POST') return falar(req, res);
    if (p === '/api/v1/tts/cota' && m === 'GET') {
      const r = await voz.cota();
      if (r.erro) return H.erroJson(res, r.status, r.erro);
      return H.enviaJson(res, 200, Object.assign({ ok: true }, r));
    }
    return H.erroJson(res, 404, `Não existe ${m} ${p}. A lista de rotas está no README do Web.`);
  }

  async function mensagens(req, res, url, agente) {
    const q = url.searchParams;
    const t = await conversa.thread(agente);
    const todas = t.msgs;
    if (q.get('after') != null) {
      const after = numeroOuErro(res, 'after', q.get('after'), 0);
      if (after === undefined) return undefined;
      const limite = numeroOuErro(res, 'limit', q.get('limit'), 80, 1, 500);
      if (limite === undefined) return undefined;
      const mais = todas.filter((x) => x.ep > after);
      return H.enviaJson(res, 200, { ok: true, msgs: mais.slice(0, limite), avisos: t.avisos, mais_novas: mais.length > limite, limit: limite, after });
    }
    const limite = numeroOuErro(res, 'limit', q.get('limit'), 60, 1, 500);
    if (limite === undefined) return undefined;
    const before = q.get('before') != null && q.get('before') !== '' ? numeroOuErro(res, 'before', q.get('before'), null) : null;
    if (before === undefined) return undefined;
    const base = before == null ? todas : todas.filter((x) => x.ep < before);
    const msgs = base.slice(Math.max(0, base.length - limite));
    return H.enviaJson(res, 200, { ok: true, msgs, avisos: t.avisos, mais_antigas: base.length > limite, before, limit: limite });
  }

  async function esperar(req, res, url, agente) {
    const q = url.searchParams;
    const since = numeroOuErro(res, 'since', q.get('since'), 0);
    if (since === undefined) return undefined;
    if (!(since > 0)) return H.erroJson(res, 400, 'O parâmetro "since" é obrigatório: o epoch (número) a partir do qual procuro mensagem nova. Use o ep_enviado do /send.');
    let timeout = numeroOuErro(res, 'timeout', q.get('timeout'), 25);
    if (timeout === undefined) return undefined;
    timeout = Math.max(1, Math.min(28, timeout));
    const fim = Date.now() + timeout * 1000;
    let fechou = false;
    res.on('close', () => { fechou = true; });
    for (;;) {
      const t = await conversa.thread(agente);
      const novas = t.msgs.filter((x) => x.ep > since);
      const doAgente = novas.some((x) => x.origin === 'agente');
      if (doAgente || Date.now() >= fim || fechou) {
        if (fechou) return undefined;
        return H.enviaJson(res, 200, { ok: true, msgs: novas, timeout: !doAgente, avisos: t.avisos });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  function stream(req, res, url, agente) {
    let since = null;
    const ultimo = req.headers['last-event-id'];
    if (ultimo) { const n = Number(ultimo); if (Number.isFinite(n)) since = n; else log('aviso', `Stream de ${agente.slug}: Last-Event-ID inválido (${String(ultimo).slice(0, 30)}); uso o parâmetro since.`); }
    if (since == null && url.searchParams.get('since') != null && url.searchParams.get('since') !== '') {
      const n = Number(url.searchParams.get('since'));
      if (!Number.isFinite(n)) return H.erroJson(res, 400, `O parâmetro "since" precisa ser o epoch (número) da última mensagem que você já tem. Recebi: ${url.searchParams.get('since').slice(0, 40)}.`);
      since = n;
    }
    if (since == null || since <= 0) since = Date.now() / 1000 - 60;
    abrirStream({
      req, res, agente, since, log, tickMs: opcoes.tickSseMs,
      fontes: { thread: conversa.thread, atividade: conversa.atividade, versaoJs, foco: (a) => foco.lista(a.slug) },
    });
    return undefined;
  }

  async function lerEnvio(req, res) {
    try { return await H.lerJson(req, 256 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return null; }
  }

  async function enviar(req, res, agente) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    const cid = corpo.cliente_id;
    if (cid != null && cid !== '' && !(typeof cid === 'string' && RX_CLIENTE_ID.test(cid))) {
      return H.erroJson(res, 400, `O "cliente_id" veio como ${JSON.stringify(String(cid).slice(0, 80))}, que não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_". Nada foi enviado.`);
    }
    const r = await conversa.umaVez(agente, 'send', cid || null, () => conversa.enviar(agente, corpo));
    return H.enviaJson(res, r.status, r.corpo);
  }

  async function comandoPost(req, res, agente) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    const cid = corpo.cliente_id;
    if (cid != null && cid !== '' && !(typeof cid === 'string' && RX_CLIENTE_ID.test(cid))) {
      return H.erroJson(res, 400, `O "cliente_id" veio como ${JSON.stringify(String(cid).slice(0, 80))}, que não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_". Nada foi enviado.`);
    }
    const r = await conversa.umaVez(agente, 'comando', cid || null, () => conversa.comando(agente, corpo));
    return H.enviaJson(res, r.status, r.corpo);
  }

  async function upload(req, res, agente) {
    if (!agente.home_host) return H.erroJson(res, 503, `O agente ${agente.nome} não tem home_host no registro, então não há onde guardar anexos.`);
    let mp;
    try { mp = await lerMultipart(req, config.maxUploadBytes); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
    const arq = mp.arquivos.find((a) => a.campo === 'file');
    if (!arq || !arq.nome) return H.erroJson(res, 400, 'Mande o arquivo num multipart, no campo "file". Não veio nenhum arquivo.');
    const cid = mp.campos.cliente_id;
    if (cid && !RX_CLIENTE_ID.test(cid)) return H.erroJson(res, 400, 'O "cliente_id" não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_".');
    if (!arq.dados.length) return H.erroJson(res, 400, `O arquivo "${arq.nome}" chegou com 0 byte. Escolha o arquivo de novo.`);
    const soGuardar = /^(0|false|nao|não|no)$/i.test((mp.campos.enviar || '').trim());
    const legenda = (mp.campos.legenda || '').trim();
    const r = await conversa.umaVez(agente, 'upload', cid || null, async () => {
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const pasta = path.join(agente.home_host, 'uploads', dia);
      let destino;
      try {
        fs.mkdirSync(pasta, { recursive: true, mode: 0o755 });
        destino = gravaSemSobrescrever(pasta, nomeSeguro(arq.nome), arq.dados);
      } catch (e) {
        log('erro', `Upload para ${agente.slug}: não gravei em ${pasta} (${e.code || e.message}).`);
        return { status: 500, corpo: { ok: false, erro: `Não consegui gravar o arquivo em ${pasta} (${e.code || e.message}). Confira espaço em disco e permissão da pasta do agente.` } };
      }
      const visto = paraContainer(destino, agente);
      const media = midia.registrar(agente.slug, destino, { visto, nome: path.basename(destino) });
      const marcador = `[anexo: ${visto}]`;
      const anexo = { id: media.id, kind: media.kind, nome: arq.nome, bytes: arq.dados.length, path: visto, url: media.url };
      log('info', `Upload para ${agente.slug}: ${arq.nome} (${media.kind}, ${arq.dados.length} bytes) salvo em ${destino}.`);
      if (soGuardar) {
        return { status: 201, corpo: { ok: true, enviado: false, agente: agente.slug, anexo, marcador, media } };
      }
      const e = await conversa.entregar(agente, [legenda, marcador].filter(Boolean).join('\n'), { cru: false });
      if (e.status >= 300) return Object.assign(e, { corpo: Object.assign({ arquivo_salvo: visto }, e.corpo) });
      return { status: 201, corpo: Object.assign({}, e.corpo, { enviado: true, kind: media.kind, texto: legenda, anexo, marcador, media }) };
    });
    return H.enviaJson(res, r.status, r.corpo);
  }

  async function transcrever(req, res) {
    if (!voz.microfone) return H.erroJson(res, 503, voz.semChaveMic, { microfone: false });
    let mp;
    try { mp = await lerMultipart(req, 25 * 1024 * 1024); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
    const a = mp.arquivos.find((x) => x.campo === 'audio');
    if (!a) return H.erroJson(res, 400, 'Mande o áudio num multipart, no campo "audio".');
    if (a.dados.length < 1024) return H.erroJson(res, 400, `O áudio chegou com ${a.dados.length} bytes, que é menos de 1 KB: a gravação veio vazia. Toque para falar, diga algo e toque de novo.`);
    const r = await voz.transcrever(a.dados, a.nome, a.tipo);
    if (r.erro) return H.erroJson(res, r.status, r.erro);
    return H.enviaJson(res, 200, { ok: true, text: r.texto, bytes: a.dados.length, audio_id: null });
  }

  async function falar(req, res) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    const slug = typeof corpo.agent_id === 'string' ? corpo.agent_id : (registro.estado().agentes[0] || {}).slug;
    const agente = registro.obter(slug);
    if (!agente) return H.erroJson(res, 404, `Não existe agente com o id "${String(slug).slice(0, 40)}".`);
    const r = await voz.falar(agente, corpo.text, typeof corpo.voice_id === 'string' ? corpo.voice_id : null);
    if (r.erro) return H.erroJson(res, r.status, r.erro);
    const cab = { 'Content-Type': 'audio/mpeg', 'Content-Length': r.audio.length, 'Cache-Control': 'no-store', 'X-TTS-Chars': String(r.chars) };
    if (r.cortado) cab['X-TTS-Cortado'] = '1';
    res.writeHead(200, cab);
    return res.end(r.audio);
  }

  // ── despacho ─────────────────────────────────────────────────────────────
  async function tratar(req, res) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch (_) { return H.paginaErro(res, 400, 'Endereço inválido', 'Não entendi o endereço pedido.'); }
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/saude' && (m === 'GET' || m === 'HEAD')) {
      const est = registro.estado();
      return H.enviaJson(res, 200, { ok: true, agentes: est.ok ? est.agentes.length : null, registro_ok: est.ok, login_trancado: auth.trancado });
    }
    if (p === '/api/login-estado' && m === 'GET') {
      if (auth.semSenha) {
        return H.enviaJson(res, 200, { ok: true, trancado: auth.trancado, sem_senha: true, usuario: auth.usuario, mensagem: 'Use o link de primeiro acesso que apareceu no fim da instalação. Se perdeu, rode no servidor: sudo dgclaw primeiro-acesso' });
      }
      return H.enviaJson(res, 200, { ok: true, trancado: auth.trancado, sem_senha: false, mensagem: auth.trancado ? `O acesso está trancado: ${auth.motivoTrancado} Rode o gerador de hash do instalador e coloque o resultado no web.env.` : null });
    }

    if (!p.startsWith('/p/')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }

    // Pedido interno da caixa de um agente: só rotas /api/ liberadas com caixa.permitir().
    const slugCaixa = caixa.ehPedidoDaCaixa(req);
    if (slugCaixa && !(p.startsWith('/api/') && caixa.rotaPermitida(p))) {
      return H.erroJson(res, 403, `A rota ${p.slice(0, 120)} não está liberada para agentes. Só as rotas que a frente liberou com caixa.permitir() respondem pela caixa.`);
    }

    // CSRF: toda escrita exige Origin igual à do próprio Web (a caixa não vem de navegador).
    if (ehMutacao(req) && !slugCaixa && !origemOk(req)) {
      const visto = req.headers.origin ? String(req.headers.origin).slice(0, 80) : '(sem Origin)';
      log('aviso', `Pedido ${m} ${p} recusado: Origin ${visto} não é a deste Web (${H.origemPropria(req, config.proxiesConfiaveis)}).`);
      const motivo = `Pedido recusado: a origem ${visto} não é a deste site. Abra o DG Claw pelo endereço normal e tente de novo.`;
      const jsonPedido = /application\/json/i.test(String(req.headers['content-type'] || '')) || /application\/json/i.test(String(req.headers.accept || ''));
      if (p === '/login' && !jsonPedido) return voltaAoLogin(res, 'origem', '/');
      return querHtml(req) && !p.startsWith('/api/') ? H.paginaErro(res, 403, 'Pedido recusado', motivo) : H.erroJson(res, 403, motivo);
    }

    if (p === '/login' && m === 'GET') {
      if (auth.sessaoDoPedido(req)) { res.writeHead(302, { Location: proximoSeguro(url.searchParams.get('next')) }); return res.end(); }
      if (!servirArquivo(req, res, path.join(config.publicDir, 'login.html'), 'no-store')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(LOGIN_RESERVA);
      }
      return undefined;
    }
    if (p === '/login' && m === 'POST') return postLogin(req, res, url);
    if (p === '/primeiro-acesso' && (m === 'GET' || m === 'HEAD')) {
      if (!servirArquivo(req, res, path.join(config.publicDir, 'primeiro-acesso.html'), 'no-store')) {
        log('erro', `A tela de primeiro acesso não está instalada: falta ${path.join(config.publicDir, 'primeiro-acesso.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de primeiro acesso não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }
    if (p === '/api/primeiro-acesso' && m === 'POST') return postPrimeiroAcesso(req, res);
    if (p === '/sair' && (m === 'GET' || m === 'POST')) {
      auth.encerra(req, res);
      res.writeHead(303, { Location: '/login', 'Set-Cookie': res.getHeader('Set-Cookie'), 'Cache-Control': 'no-store' });
      return res.end();
    }

    const sessao = slugCaixa ? { usuario: 'agente:' + slugCaixa, via: 'caixa', agente: slugCaixa } : auth.sessaoDoPedido(req);

    if (p.startsWith('/api/')) {
      if (!sessao) return H.erroJson(res, 401, 'Você precisa entrar para usar a API. Faça login em /login.');
      return api(req, res, url, sessao);
    }

    const pp = /^\/p\/([^/]+)(\/.*)?$/.exec(p);
    if (pp) {
      if (!sessao) {
        if (querHtml(req)) return semSessaoPagina(req, res, url);
        return H.erroJson(res, 401, 'Você precisa entrar para abrir o painel. Faça login em /login.');
      }
      if (!pp[2]) { res.writeHead(302, { Location: `/p/${pp[1]}/${url.search}` }); return res.end(); }
      return proxy.responder(req, res, pp[1], sessao.usuario);
    }

    if (p === '/' && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (falhaDoRegistro(req, res, false)) return undefined;
      res.writeHead(302, { Location: `/a/${agenteInicial(req)}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (p === '/lembretes' && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'lembretes.html'), 'no-store')) {
        log('erro', `A tela de lembretes não está instalada: falta ${path.join(config.publicDir, 'lembretes.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de lembretes não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/avisos' || p === '/avisos/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'avisos.html'), 'no-store')) {
        log('erro', `A tela do quadro de avisos não está instalada: falta ${path.join(config.publicDir, 'avisos.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela do quadro de avisos não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    const pa = /^\/a\/([^/]+)\/?$/.exec(p);
    if (pa && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (falhaDoRegistro(req, res, false)) return undefined;
      const slug = decodeURIComponent(pa[1]);
      if (!RX_SLUG_ROTA.test(slug) || !registro.obter(slug)) {
        return H.paginaErro(res, 404, 'Agente não encontrado', `Não existe agente chamado "${H.escapaHtml(slug.slice(0, 40))}". Volte ao início para ver a lista.`);
      }
      if (!servirArquivo(req, res, path.join(config.publicDir, 'conversa.html'), 'no-store')) {
        log('erro', `A tela da conversa não está instalada: falta ${path.join(config.publicDir, 'conversa.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela da conversa não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/mesa' || p === '/mesa/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'mesa.html'), 'no-store')) {
        log('erro', `A tela da Mesa não está instalada: falta ${path.join(config.publicDir, 'mesa.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela da Mesa de tarefas não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if (m === 'GET' || m === 'HEAD') {
      const arq = arquivoPublico(p);
      if (arq) {
        const ehHtml = arq.endsWith('.html');
        const livre = ['login.html', 'primeiro-acesso.html'].includes(path.basename(arq));
        if (ehHtml && !livre && !sessao) return semSessaoPagina(req, res, url);
        if (servirArquivo(req, res, arq)) return undefined;
      }
      return H.paginaErro(res, 404, 'Página não encontrada', 'Esse endereço não existe neste servidor.');
    }
    return H.erroJson(res, 405, `Não existe ${m} ${p}.`);
  }

  const servidor = http.createServer((req, res) => {
    tratar(req, res).catch((e) => {
      log('erro', `Erro inesperado em ${req.method} ${String(req.url).split('?')[0]}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      if (!res.headersSent) H.erroJson(res, 500, 'Erro interno do servidor. O detalhe foi registrado no log; tente de novo e, se repetir, avise quem instalou.');
      else res.destroy();
    });
  });

  servidor.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://local');
      const pp = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const sessao = auth.sessaoDoPedido(req);
      const nega = (status, motivo) => { socket.write(`HTTP/1.1 ${status} Recusado\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${motivo}`); socket.destroy(); };
      if (!pp) return nega(404, 'Só o painel (/p/<agente>/) aceita WebSocket.');
      if (!sessao) return nega(401, 'Você precisa entrar antes.');
      if (!origemOk(req)) {
        log('aviso', `WebSocket em ${url.pathname} recusado: Origin ${String(req.headers.origin || '(sem Origin)').slice(0, 80)} não é a deste Web.`);
        return nega(403, 'Origem não permitida.');
      }
      return proxy.upgrade(req, socket, head, pp[1], sessao.usuario);
    } catch (e) {
      log('erro', `Falha no upgrade de ${String(req.url).split('?')[0]}: ${e.message}`);
      socket.destroy();
      return undefined;
    }
  });

  return {
    servidor, config, registro, auth, midia, conversa, log, caixa, push, lembretes, avisos,
    ouvir(porta, host) {
      return new Promise((resolve, reject) => {
        servidor.once('error', reject);
        servidor.listen(porta == null ? config.porta : porta, host || config.host, () => {
          servidor.off('error', reject);
          caixa.iniciar();
          lembretes.iniciar();
          avisos.iniciar();
          resolve(servidor.address());
        });
      });
    },
    fechar() { return new Promise((resolve) => { caixa.parar(); lembretes.parar(); avisos.parar(); proxy.fecharTudo(); servidor.closeAllConnections && servidor.closeAllConnections(); servidor.close(() => resolve()); }); },
  };
}

module.exports = { criarServidor, proximoSeguro };

if (require.main === module) {
  const s = criarServidor();
  s.ouvir().then((a) => {
    s.log('info', `DG Claw Web escutando em http://${a.address}:${a.port} (agentes: ${s.config.agentesPath}, dados: ${s.config.dataDir}).`);
  }).catch((e) => {
    s.log('erro', `Não consegui escutar em ${s.config.host}:${s.config.porta} (${e.code || e.message}). Veja se outra coisa usa a porta ou mude DGCLAW_WEB_PORT.`);
    process.exit(1);
  });
  for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { s.fechar().then(() => process.exit(0)); });
}
