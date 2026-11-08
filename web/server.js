#!/usr/bin/env node
'use strict';
// DG Claw Web: login, conversa com os agentes, proxy dos painéis. Node 22, sem dependências.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');

const H = require('./lib/http');
const { carregaConfig } = require('./lib/config');
const { criarRegistro } = require('./lib/registro');
const { criarRunner } = require('./lib/runner');
const { criarAuth } = require('./lib/auth');
const { criarMidia } = require('./lib/media');
const { criarAvatar } = require('./lib/avatar');
const { criarCompartilhados } = require('./lib/compartilhados');
const { criarLeitor, paraContainer } = require('./lib/thread');
const { criarLeitorRollout } = require('./lib/rollout');
const { criarConversa, RX_CLIENTE_ID } = require('./lib/conversa');
const { criarComandos } = require('./lib/comandos');
const { lerMultipart, nomeSeguro, nomeNeutro } = require('./lib/uploads');
const { gravaAnexo: gravaAnexoReal } = require('./lib/grava-anexo');
const { instanciaDe } = require('./lib/instancia');
const { entregar: entregarSeguro, ErroEntrega } = require('./lib/entrega-segura');
const { abrirStream } = require('./lib/sse');
const { criarProxy } = require('./lib/proxy');
const { criarCofreAgente } = require('./lib/cofre-agente');
const { criarCofreRotas } = require('./lib/cofre-rotas');
const { criarAlertas } = require('./lib/alertas');
const { criarFoco } = require('./lib/foco');
const { criarVoz } = require('./lib/voz');
const { criarSigilo } = require('./lib/sigilo');
const { criarAnonimizar } = require('./lib/anonimizar');
const { criarRotasAnonimizar } = require('./lib/anonimizar-rotas');
const { criarOnboarding } = require('./lib/onboarding');
const { criarLogin } = require('./lib/login');
const { criarContaColaborador } = require('./lib/conta-colaborador');
const { criarPrimeiroAcesso } = require('./lib/primeiro-acesso');
const { criarCaixaAgente, quemChamou } = require('./lib/caixa-agente');
const { criarPush } = require('./lib/push');
const { criarLembretes } = require('./lib/lembretes');
const { criarEstados } = require('./lib/estados');
const { criarPrefsAtencao } = require('./lib/prefs-atencao');
const { criarModalLoginPrefs } = require('./lib/modal-login-prefs');
const { criarVigiaAtencao } = require('./lib/vigia-atencao');
const { criarMesa } = require('./lib/mesa');
const { criarAvisos } = require('./lib/avisos');
const { criarAtualizacao } = require('./lib/atualizacao');
const { criarSeguranca } = require('./lib/seguranca');
const { criarRondaPainel } = require('./lib/ronda-painel');
const { criarNaoLidas } = require('./lib/nao-lidas');
const { criarUso } = require('./lib/uso');
const { criarColaboradores } = require('./lib/colaboradores');
const { criarColaboradoresRotas } = require('./lib/colaboradores-rotas');
const { criarEmail } = require('./lib/email');
const escopo = require('./lib/escopo');

const METODOS_QUE_ESCREVEM = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TIPOS_ESTATICOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const RX_SLUG_ROTA = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LOGIN_RESERVA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Entrar</title>' +
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

/**
 * Passa TODA resposta dinâmica de `res` pelo `filtro` (texto a texto) antes de sair: JSON e qualquer text/*.
 * `estatica` (documentação, por nome exato de rota) segue como está. Tipo de conteúdo que não sei filtrar,
 * com corpo, vira 503: para agente com a anonimização ligada, na dúvida não se entrega.
 */
function filtraRespostaDaCaixa(res, filtro, log, estatica) {
  if (estatica) return;
  const writeHead = res.writeHead.bind(res); const end = res.end.bind(res);
  let status = null; let cabecalhos = {}; const pedacos = [];
  res.writeHead = (s, h) => { status = s; cabecalhos = Object.assign({}, h && typeof h === 'object' ? h : {}); return res; };
  res.write = (c) => { pedacos.push(Buffer.from(c)); return true; };
  res.end = (c) => {
    if (c) pedacos.push(Buffer.from(c));
    let corpo = Buffer.concat(pedacos);
    const tipo = String(Object.entries(cabecalhos).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || res.getHeader('content-type') || '');
    let codigo = status || res.statusCode;
    let recusa = null;
    if (corpo.length) {
      try {
        if (/json/i.test(tipo)) corpo = Buffer.from(JSON.stringify(filtro(JSON.parse(corpo.toString('utf8')))), 'utf8');
        else if (/^\s*text\//i.test(tipo)) corpo = Buffer.from(filtro(corpo.toString('utf8')), 'utf8');
        else recusa = `tipo de conteúdo "${tipo || 'desconhecido'}" que não sei filtrar`;
      } catch (e) { recusa = e.message; }
    }
    if (recusa) {
      log('erro', `Anonimizar: não consegui filtrar a resposta da caixa (${recusa}). Respondi 503.`);
      codigo = 503;
      corpo = Buffer.from(JSON.stringify({ ok: false, erro: 'Não consegui trocar os dados pessoais da resposta, então ela não foi entregue. Tente de novo; se repetir, peça ao dono para conferir a tela Anonimizar.' }), 'utf8');
      cabecalhos = {};
      cabecalhos['Content-Type'] = 'application/json; charset=utf-8';
    }
    for (const k of Object.keys(cabecalhos)) if (k.toLowerCase() === 'content-length') delete cabecalhos[k];
    cabecalhos['Content-Length'] = corpo.length;
    writeHead(codigo, cabecalhos);
    return end(corpo);
  };
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
  const colaboradores = criarColaboradores({ config, log, agora: opcoes.agora, gerarHash: (senha) => auth.gerarHash(senha) });
  auth.ligarColaboradores(colaboradores);
  auth.ligarInstancias((slug) => instanciaDe(registro.obter(slug)));
  log('info', config.smtp.host ? `E-mail dos convites de colaborador: ligado (${config.smtp.host}:${config.smtp.porta}).` : 'E-mail dos convites de colaborador: desligado (opcional; o convite sai pelo texto da tela). Para ligar, defina DGCLAW_SMTP_HOST e as outras DGCLAW_SMTP_* no web.env.');
  // Conexões abertas (stream da conversa) de cada colaborador: ao revogar ou trocar a senha, fecham junto com a sessão.
  const streamsDoColaborador = new Map();
  const fechaStreamsDe = (id) => { for (const r of streamsDoColaborador.get(id) || []) r.destroy(); streamsDoColaborador.delete(id); proxy.fecharDoColaborador(id); };
  const primeiroAcesso = criarPrimeiroAcesso({ config, auth, log, agora: opcoes.agora });
  const avatares = criarAvatar({ dataDir: config.dataDir, log });
  const midia = criarMidia({ dataDir: config.dataDir, log, registro, publicDir: config.publicDir });
  const leitor = criarLeitor({ log, tz: config.tz, canalTelegram: config.canalTelegram, midia });
  const leitorRollout = criarLeitorRollout({ log, tz: config.tz, midia });
  const alertas = agente => criarAlertas(path.join(config.dataDir, 'alertas', agente.slug + '.json'), agente.chat_id);
  const comandos = criarComandos({ runner, log, agora: opcoes.agora });
  const conversa = criarConversa({ comandos, alertas, config, runner, leitor, leitorRollout, midia, log, agora: opcoes.agora, gravaToken: opcoes.gravaToken });
  const compartilhados = criarCompartilhados(conversa);
  const onboarding = criarOnboarding({ config, registro, conversa, midia, log, imagem: opcoes.imagem });
  const login = criarLogin({ runner, conversa, log, agora: opcoes.agora, oiPrazoMs: opcoes.loginOiPrazoMs, oiPassoMs: opcoes.loginOiPassoMs, provedores: opcoes.provedores });
  const cofreAgente = criarCofreAgente({ config, log, reiniciar: opcoes.reiniciarCofre });
  const voz = opcoes.voz || criarVoz({ env: config.env, log });
  const contaColab = criarContaColaborador({ dataDir: config.dataDir, login, log, agora: opcoes.agora, escreveArquivo: opcoes.escreveContaAgentes });
  const colabRotas = criarColaboradoresRotas({ colaboradores, auth, registro, email: opcoes.email || criarEmail({ config, log }), config, log, agora: opcoes.agora, aoDerrubar: fechaStreamsDe, conta: contaColab });
  const sigilo = opcoes.sigilo || criarSigilo({ env: config.env, registro, dataDir: config.dataDir, log, timeoutMs: opcoes.timeoutSigiloMs });
  const anonimizar = opcoes.anonimizar || criarAnonimizar({
    env: config.env, dataDir: config.dataDir, registro, log, paraContainer,
    motor: opcoes.anonMotor, systemctl: opcoes.anonSystemctl, ociosoMs: opcoes.anonOciosoMs,
  });
  const cofreRotas = criarCofreRotas({ config, runner, cofre: cofreAgente, voz, log, entregar: (...a) => conversa.entregar(...a), esperaAvisoMs: opcoes.esperaAvisoMs });
  const proxy = criarProxy({ config, registro, log, cofreRotas });
  const caixa = criarCaixaAgente({ config, registro, log, porta: () => servidor.address().port, agora: opcoes.agora, filtroRetrato: (slug, o) => { const f = anonimizar.filtroSaida(slug); return f ? f(o) : o; } });
  const push = criarPush({ dataDir: config.dataDir, log, agora: opcoes.agora, enviarHttp: opcoes.enviarPush });
  try { push.garantirChaves(); } catch (e) { log('erro', e.message); }
  // Texto livre que vai ao agente por outros caminhos (lembrete, mesa, aviso) passa pelo mesmo filtro do /send; lança se a config estiver ilegível.
  const filtroAnon = (slug, t) => (typeof t === 'string' && t && anonimizar.aplicaDigitado(slug) ? anonimizar.trocarDigitado(slug, t).texto : t);
  const lembretes = criarLembretes({ config, registro, runner, push, log, agora: opcoes.agora, filtro: filtroAnon });
  caixa.permitir('/api/v1/lembretes');
  // Modo foco: o agente chega pela caixa (dgclaw-api), o retrato vai para a casa dele e o PUT do agente avisa o celular.
  const foco = criarFoco({ dir: path.join(config.dataDir, 'foco'), tz: config.tz, log, registro, gravaRetrato: opcoes.gravaRetrato || caixa.gravaRetrato, push: opcoes.push || push, quemChamou: opcoes.quemChamou || quemChamou });
  caixa.permitir('/api/v1/foco');
  const mesa = criarMesa({ arquivo: path.join(config.dataDir, 'mesa', 'tarefas.json'), registro, runner, log, agora: opcoes.agora, tz: config.tz, avisarDono: (aviso) => push.enviar(aviso), filtro: filtroAnon });
  // O agente fala com a Mesa pelo dgclaw-mesa, que passa pela caixa: a rota precisa estar liberada.
  caixa.permitir('/api/v1/tarefas');
  const naoLidas = criarNaoLidas({ arquivo: path.join(config.dataDir, 'nao-lidas.json'), conversa, registro, log, relogio: opcoes.agora, lerThread: conversa.threadCompartilhada });
  const uso = criarUso({ registro, runner, log, timeoutMs: opcoes.timeoutUsoMs });
  // O agente consulta o uso da PRÓPRIA assinatura pela caixa (dgclaw-api GET /api/v1/uso); a rota
  // filtra pelo slug da caixa, então ele nunca vê os outros. O Admin, no host, usa a API normal.
  caixa.permitir('/api/v1/uso');
  const avisos = criarAvisos({ config, registro, runner, caixa, log, agora: opcoes.agora, filtro: filtroAnon });
  caixa.permitir('/api/v1/avisos');
  // Só o caminho exato da documentação do cofre (os templates mandam o agente ler); o cofre em si não é rota da caixa.
  caixa.permitir('/api/v1/cofre/docs.md');
  // A doc do Anonimizar é pública; as rotas dele NÃO entram aqui (agente não as chama).
  caixa.permitir('/api/v1/anonimizar/docs.md');
  // Aviso de versão nova: só o dono, pelo painel. De propósito NÃO entra em caixa.permitir (agente em container não usa).
  const estados = criarEstados({ conversa, naoLidas, registro, log });
  const prefsAtencao = criarPrefsAtencao({ arquivo: path.join(config.dataDir, 'push', 'preferencias.json'), log });
  const modalLoginPrefs = criarModalLoginPrefs({ arquivo: path.join(config.dataDir, 'modal-login.json'), log });
  const vigiaAtencao = criarVigiaAtencao({ registro, estados, lerThread: conversa.threadCompartilhada, push: opcoes.push || push, prefs: prefsAtencao, relogio: opcoes.agora, log, intervaloMs: opcoes.vigiaIntervaloMs });
  // /api/v1/estados NÃO entra na caixa: ela só atende agentes de trabalho, e um agente não tem por que
  // enxergar o estado (nem o nome) dos vizinhos. O Admin, no host, lê os documentos e a tela.
  const atualizacao = criarAtualizacao({ dataDir: config.dataDir, log });
  // Aviso de segurança: só o dono, pelo painel (mesma regra da faixa de versão), por isso também fora de caixa.permitir.
  const seguranca = criarSeguranca({ dataDir: config.dataDir, log, agora: opcoes.agora });
  // Ronda de fábrica e botão de emergência: também só do dono (fora de caixa.permitir). O Web só grava pedidos; o root executa.
  const rondaPainel = criarRondaPainel({ dataDir: config.dataDir, log, agora: opcoes.agora });

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
    cab['Accept-Ranges'] = 'bytes';
    // Range de um intervalo só (o iPhone só toca vídeo se o servidor responder 206). Vários intervalos: serve inteiro.
    let ini = 0; let fim = st.size - 1; let status = 200;
    const pedido = String(req.headers.range || '');
    if (/^bytes=/i.test(pedido) && !pedido.includes(',')) {
      const mr = /^bytes=(\d*)-(\d*)$/i.exec(pedido.trim());
      let a = NaN; let b = NaN;
      if (mr && (mr[1] !== '' || mr[2] !== '')) {
        if (mr[1] === '') { const n = Number(mr[2]); a = n > 0 ? Math.max(0, st.size - n) : NaN; b = st.size - 1; }
        else { a = Number(mr[1]); b = mr[2] === '' ? st.size - 1 : Math.min(Number(mr[2]), st.size - 1); }
      }
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > b || a >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      ini = a; fim = b; status = 206;
      cab['Content-Range'] = `bytes ${ini}-${fim}/${st.size}`;
    }
    cab['Content-Length'] = fim - ini + 1;
    res.writeHead(status, cab);
    if (req.method === 'HEAD') { res.end(); return true; }
    const s = fs.createReadStream(caminho, status === 206 ? { start: ini, end: fim } : undefined);
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

  // Só o dono, pela tela. Fora de caixa.permitir de propósito: agente em container não chama estas rotas.
  const rotasAnonimizar = criarRotasAnonimizar({ anon: anonimizar, registro, midia, log, origemOk });

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

  /** Para onde a pessoa vai depois de entrar. Colaborador: troca de senha pendente, senão o agente dele (ignora `next` fora do escopo). */
  function destinoDaSessao(sessao, next) {
    if (!sessao || sessao.papel !== 'colaborador') return next;
    if (sessao.trocar_senha) return '/trocar-senha';
    const padrao = `/a/${encodeURIComponent(sessao.agente)}`;
    let alvo;
    try { alvo = new URL(next || '/', 'http://local').pathname; } catch (_) { return padrao; }
    return alvo !== '/' && escopo.avaliar(sessao, 'GET', alvo).ok ? next : padrao;
  }

  function negarEscopo(req, res, sessao, v, p) {
    if (v.redirecionar && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(302, { Location: v.redirecionar, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const status = v.status === 302 ? 403 : v.status;
    log('aviso', `Colaborador ${sessao.usuario} (agente ${sessao.agente}) barrado em ${req.method} ${p.slice(0, 120)}: ${v.motivo}`);
    if (p.startsWith('/api/') || !querHtml(req)) return H.erroJson(res, status, v.motivo, v.extra);
    return H.paginaErro(res, status, 'Acesso não liberado', v.motivo);
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
      let s;
      try { s = auth.criaSessao(r.usuario, req, r.colaborador); } catch (e) {
        log('aviso', `Login de ${r.usuario} (ip ${ip}) não emitiu sessão: ${e.message}`);
        return json ? H.erroJson(res, e.status || 500, e.message) : voltaAoLogin(res, 'credenciais', next, usuarioDigitado);
      }
      log('info', `Login de ${r.usuario}${r.colaborador ? ` (colaborador do agente ${r.colaborador.agente})` : ''} (ip ${ip}).`);
      const cab = { 'Set-Cookie': s.cookies, 'Cache-Control': 'no-store' };
      const destino = r.colaborador
        ? destinoDaSessao({ papel: 'colaborador', agente: r.colaborador.agente, trocar_senha: !!(colaboradores.obter(r.colaborador.id) || {}).trocar_senha }, next)
        : next;
      if (json) return H.enviaJson(res, 200, { ok: true, destino }, cab);
      res.writeHead(303, Object.assign({ Location: destino }, cab));
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
    if (r.vencida) {
      log('aviso', `Login recusado (ip ${ip}): a senha temporária de um colaborador venceu.`);
      return json ? H.erroJson(res, 401, r.erro) : voltaAoLogin(res, 'vencida', next, usuarioDigitado);
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
    if (avatares.ehUrlDeFoto(av)) return { avatar: (a.nome[0] || '?').toUpperCase(), avatar_img: avatares.urlPublica(a.slug, av) };
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

    if ((p === '/api/v1/anonimizar' || p.startsWith('/api/v1/anonimizar/')) && await rotasAnonimizar.rotas(req, res, url, sessao)) return undefined;

    if ((p === '/api/v1/lembretes' || p.startsWith('/api/v1/lembretes/')) && await lembretes.rotas(req, res, url, sessao)) return undefined;

    if ((p === '/api/v1/atualizacao' || p.startsWith('/api/v1/atualizacao/')) && await atualizacao.rotas(req, res, url, sessao)) return undefined;

    if (p.startsWith('/api/v1/seguranca/') && await rondaPainel.rotas(req, res, url, sessao)) return undefined;

    if ((p === '/api/v1/seguranca' || p.startsWith('/api/v1/seguranca/')) && await seguranca.rotas(req, res, url, sessao)) return undefined;

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

    if (p === '/api/v1/colaboradores' || p.startsWith('/api/v1/colaboradores/')) {
      if (await colabRotas.tratar(req, res, url, sessao)) return undefined;
    }

    if (p === '/api/v1/eu' && m === 'GET') return colabRotas.eu(res, sessao);
    if (p === '/api/v1/eu/senha') {
      if (m !== 'POST') return H.erroJson(res, 405, 'Use POST com {"nova": "...", "confirmacao": "...", "atual": "..."}.');
      return colabRotas.trocarSenha(req, res, sessao);
    }

    if (p === '/api/v1/agents' && m === 'GET') {
      if (falhaDoRegistro(req, res, true)) return undefined;
      // Colaborador enxerga só o agente dele (o escopo já deixou passar a rota; o filtro é aqui, no handler).
      const visiveis = registro.estado().agentes.filter((a) => sessao.papel !== 'colaborador' || a.slug === sessao.agente);
      const lista = await Promise.all(visiveis.map(async (a) => Object.assign(await agentePublico(a), { ultima_ts: await conversa.ultimaMensagemTs(a) })));
      return H.enviaJson(res, 200, { ok: true, agentes: lista, voz: lista.some((a) => a.voz), microfone: voz.microfone, limite_upload_bytes: config.maxUploadBytes, usuario: sessao.usuario });
    }

    if (p === '/api/v1/nao-lidas') {
      if (falhaDoRegistro(req, res, true)) return undefined;
      if (m !== 'GET') return H.erroJson(res, 405, 'Use GET para ver quantas mensagens não lidas cada agente tem.');
      try {
        let contagem = await naoLidas.contar(sessao.usuario);
        if (sessao.papel === 'colaborador') contagem = Object.fromEntries(Object.entries(contagem).filter(([slug]) => slug === sessao.agente));
        return H.enviaJson(res, 200, { ok: true, agentes: contagem });
      } catch (e) {
        return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui contar as mensagens não lidas (${e.message}).`);
      }
    }

    if (p === '/api/v1/uso/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'USO-DA-ASSINATURA.md'), 'utf8'));
    }

    if (p === '/api/v1/uso') {
      if (falhaDoRegistro(req, res, true)) return undefined;
      if (m !== 'GET') return H.erroJson(res, 405, 'Use GET para ver quanto da assinatura de cada agente já foi usado.');
      try { return H.enviaJson(res, 200, { ok: true, agentes: await uso.consultar(caixa.ehPedidoDaCaixa(req)) }); } catch (e) {
        return H.erroJson(res, e.status || 500, `Não consegui juntar o uso das assinaturas (${e.message}).`);
      }
    }

    if (p === '/api/v1/estados/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'ESTADO-DOS-AGENTES.md'), 'utf8'));
    }
    if (p === '/api/v1/estados') {
      if (falhaDoRegistro(req, res, true)) return undefined;
      if (m !== 'GET') return H.erroJson(res, 405, 'Use GET para ver o estado de cada agente (trabalhando, precisa de você, terminou, ocioso ou sem sinal).');
      if (sessao.via === 'caixa') return H.erroJson(res, 403, 'O estado dos agentes é só do dono, pelo painel. Um agente de trabalho enxerga só a própria casa.');
      try { return H.enviaJson(res, 200, { ok: true, agentes: await estados.todos(sessao.usuario) }); } catch (e) {
        return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui montar o estado dos agentes (${e.message}).`);
      }
    }
    if (p === '/api/v1/modal-login/preferencia') {
      if (sessao.via === 'caixa') return H.erroJson(res, 403, 'A escolha sobre o aviso de login dos agentes é só do dono, pelo painel.');
      if (m === 'GET') {
        try { return H.enviaJson(res, 200, { ok: true, ...modalLoginPrefs.de(sessao.usuario) }); } catch (e) { return H.erroJson(res, e.status || 500, e.message); }
      }
      if (m !== 'POST') return H.erroJson(res, 405, 'Use GET para ler e POST com {"vistos": ["id"], "nao_mostrar_mais": true} para guardar.');
      let corpo;
      try { corpo = await H.lerJson(req, 4096); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
      try { return H.enviaJson(res, 200, { ok: true, ...modalLoginPrefs.grava(sessao.usuario, corpo) }); } catch (e) {
        return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui guardar a escolha (${e.message}).`);
      }
    }

    if (p === '/api/v1/push/preferencias') {
      if (sessao.via === 'caixa') return H.erroJson(res, 403, 'As preferências de aviso do aparelho são só do dono, pelo painel.');
      if (m === 'GET') {
        try { return H.enviaJson(res, 200, { ok: true, preferencias: prefsAtencao.de(sessao.usuario) }); } catch (e) { return H.erroJson(res, e.status || 500, e.message); }
      }
      if (m !== 'POST') return H.erroJson(res, 405, 'Use GET para ler e POST com {"precisa_de_voce": true, "terminou": false} para mudar.');
      let corpo;
      try { corpo = await H.lerJson(req, 1024); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
      try { return H.enviaJson(res, 200, { ok: true, preferencias: prefsAtencao.grava(sessao.usuario, corpo) }); } catch (e) {
        return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui guardar a preferência (${e.message}).`);
      }
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
          return H.enviaJson(res, 200, { ok: true, alertas: loja.listar(), avisos: avisosPara(sessao, t.avisos) });
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
          return H.enviaJson(res, 200, { ok: true, mensagem, msgs: atuais, mais_antigas: t.msgs.some(x => x.ep < mensagem.ep), avisos: avisosPara(sessao, t.avisos) });
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
    if (p === '/api/v1/conectar/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'CONECTAR-CONTA.md'), 'utf8'));
    }
    const lr = /^\/api\/v1\/agents\/([^/]+)\/login(?:\/(codigo|oi))?$/.exec(p);
    if (lr) {
      if (falhaDoRegistro(req, res, true)) return undefined;
      const agente = agenteOuErro(res, decodeURIComponent(lr[1]));
      if (!agente) return undefined;
      const sub = lr[2];
      const vale = () => sessaoAindaVale(req, sessao);
      let corpo = {};
      if (m === 'POST' && (!sub || sub === 'codigo')) {
        corpo = await lerEnvio(req, res);
        if (!corpo) return undefined;
        // O corpo pode ter demorado: quem foi revogado ou teve o convite reenviado nesse meio tempo não conecta nada.
        if (!vale()) return recusaSessaoVelha(res, sessao);
      }
      let r = null;
      if (!sub && m === 'GET') r = await contaColab.ver(agente, sessao);
      else if (!sub && m === 'POST') r = await contaColab.comecar(agente, sessao, corpo, vale);
      else if (!sub && m === 'DELETE') r = await contaColab.cancelar(agente, sessao);
      else if (sub === 'codigo' && m === 'POST') r = await contaColab.enviarCodigo(agente, sessao, corpo, vale);
      else if (sub === 'oi' && m === 'POST') r = await contaColab.oi(agente, sessao);
      if (!r) return H.erroJson(res, 405, `Método inválido para ${p}. Use GET, POST e DELETE em /login, e POST em /login/codigo e /login/oi.`);
      if (r.sessaoVelha) return recusaSessaoVelha(res, sessao);
      return H.enviaJson(res, r.status, r.corpo);
    }

    if (p === '/api/v1/caixa/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'docs', 'CAIXA-DO-AGENTE.md'), 'utf8'));
    }
    if (p === '/api/v1/cofre/docs.md' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'docs', 'COFRE-NA-CONVERSA.md'), 'utf8'));
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

    let mm = /^\/api\/v1\/agents\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
    if (mm) {
      if (falhaDoRegistro(req, res, true)) return undefined;
      const agente = agenteOuErro(res, decodeURIComponent(mm[1]));
      if (!agente) return undefined;
      const acao = mm[2] || '';
      if (acao === '' && m === 'GET') return H.enviaJson(res, 200, { ok: true, agente: await agentePublico(agente) });
      if (acao === 'avatar' && (m === 'GET' || m === 'HEAD')) {
        const falha = await avatares.servir(req, res, agente);
        return falha ? H.erroJson(res, falha.status, falha.erro) : undefined;
      }
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
      if (acao === 'messages' && m === 'GET') return mensagens(req, res, url, agente, sessao);
      if (acao === 'stream' && m === 'GET') return stream(req, res, url, agente, sessao);
      if (acao === 'wait' && m === 'GET') return esperar(req, res, url, agente, sessao);
      if (acao === 'send' && m === 'POST') return enviar(req, res, agente, sessao);
      if (acao === 'permissao' && m === 'POST') {
        const corpo = await lerEnvio(req, res);
        if (!corpo) return undefined;
        if (await confirmacaoNegada(res, agente, sessao, corpo.tool_use_id)) return undefined;
        if (!sessaoAindaVale(req, sessao)) return recusaSessaoVelha(res, sessao);
        const r = await conversa.permissao(agente, corpo.decisao, corpo.tool_use_id);
        return H.enviaJson(res, r.status, r.corpo);
      }
      if (acao === 'pergunta' && m === 'POST') {
        const corpo = await lerEnvio(req, res);
        if (!corpo) return undefined;
        if (await confirmacaoNegada(res, agente, sessao, corpo.tool_use_id)) return undefined;
        if (!sessaoAindaVale(req, sessao)) return recusaSessaoVelha(res, sessao);
        // Resposta em texto livre à pergunta do agente também sai do dono para o agente: mesmo filtro do /send.
        try {
          if (Array.isArray(corpo.respostas) && anonimizar.aplicaDigitado(agente.slug)) {
            for (const r of corpo.respostas) if (r && typeof r.texto === 'string') r.texto = anonimizar.trocarDigitado(agente.slug, r.texto).texto;
          }
        } catch (e) {
          log('erro', `Anonimizar: resposta à pergunta de ${agente.slug} recusada (${e.codigo || e.message}).`);
          return H.erroJson(res, e.status || 500, e.message, e.codigo ? { codigo: e.codigo } : undefined);
        }
        const r = await conversa.responderPergunta(agente, corpo);
        return H.enviaJson(res, r.status, r.corpo);
      }
      if (acao === 'reiniciar' && m === 'POST') {
        const r = await conversa.reiniciar(agente);
        return H.enviaJson(res, r.status, r.corpo);
      }
      if (acao === 'lido' && m === 'POST') {
        let corpo;
        try { corpo = await H.lerJson(req, 1024); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
        const abriu = !!corpo && corpo.abriu === true;
        const ep = corpo && typeof corpo.ep === 'number' ? corpo.ep : (abriu && (corpo.ep === undefined || corpo.ep === null) ? null : NaN);
        if (ep !== null && (!Number.isFinite(ep) || ep < 0)) {
          return H.erroJson(res, 400, `O campo "ep" precisa ser um número maior ou igual a zero (o ep da última mensagem que apareceu na tela). Recebi: ${JSON.stringify(corpo && corpo.ep === undefined ? null : corpo && corpo.ep).slice(0, 40)}.`);
        }
        try { return H.enviaJson(res, 200, { ok: true, visto_ep: naoLidas.marcar(sessao.usuario, agente.slug, ep, { abriu }) }); } catch (e) {
          return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui guardar que a conversa foi lida (${e.message}).`);
        }
      }
      if (acao === 'nao-lido' && (m === 'POST' || m === 'DELETE')) {
        try {
          naoLidas.marcarNaoLida(sessao.usuario, agente.slug, m === 'POST');
          return H.enviaJson(res, 200, { ok: true, marcada_nao_lida: m === 'POST' });
        } catch (e) {
          return H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui ${m === 'POST' ? 'marcar' : 'desmarcar'} a conversa como não lida (${e.message}).`);
        }
      }
      if (acao === 'vendo' && m === 'POST') {
        vigiaAtencao.vendo(agente.slug);
        return H.enviaJson(res, 200, { ok: true });
      }
      if (acao === 'upload' && m === 'POST') return upload(req, res, agente, sessao);
      if (acao === 'comandos' && m === 'GET') return H.enviaJson(res, 200, Object.assign({ ok: true, agente: agente.slug }, await comandos.catalogo(agente)));
      if (acao === 'comando' && m === 'POST') return comandoPost(req, res, agente, sessao);
      return H.erroJson(res, ['messages', 'stream', 'wait', 'send', 'upload', 'permissao', 'pergunta', 'reiniciar', 'lido', 'nao-lido', 'vendo', 'comandos', 'comando', ''].includes(acao) ? 405 : 404, `Não existe ${m} ${p}.`);
    }

    mm = /^\/api\/v1\/media\/([0-9a-f]{16})\/visual$/.exec(p);
    const slugDaMidia = sessao.papel === 'colaborador' ? sessao.agente : null;
    if (mm && (m === 'GET' || m === 'HEAD')) return midia.servirVisual(req, res, mm[1], url.searchParams.get('tema'), slugDaMidia);

    mm = /^\/api\/v1\/media\/([0-9a-f]{16})(?:\/(thumb))?$/.exec(p);
    if (mm && (m === 'GET' || m === 'HEAD')) return midia.servir(req, res, mm[1], mm[2] ? 'thumb' : 'arquivo', url.searchParams.get('baixar') === '1', slugDaMidia);

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
    if (p === '/api/v1/tts' && m === 'POST') return falar(req, res, sessao);
    if (p === '/api/v1/tts/cota' && m === 'GET') {
      const r = await voz.cota();
      if (r.erro) return H.erroJson(res, r.status, r.erro);
      return H.enviaJson(res, 200, Object.assign({ ok: true }, r));
    }
    return H.erroJson(res, 404, `Não existe ${m} ${p}. A lista de rotas está no README do Web.`);
  }

  // O que só o dono deve ver não vai ao colaborador: diagnóstico técnico do runner (avisos da thread, motivo
  // de falha) e o detalhe do pedido de permissão ou pergunta de um turno que não é dele.
  const AVISO_GENERICO = 'Não consegui carregar parte do histórico agora. Se continuar, avise o dono do DG Claw.';
  const ehColab = (sessao) => !!sessao && sessao.papel === 'colaborador';
  const avisosPara = (sessao, avisos) => (ehColab(sessao) ? (avisos && avisos.length ? [AVISO_GENERICO] : []) : avisos);
  async function atividadePara(sessao, agente, ativ) {
    if (!ehColab(sessao)) return ativ;
    const copia = Object.assign({}, ativ);
    vinculaPendencia(agente.slug, sessao, ativ);
    const id = (ativ.permissao && ativ.permissao.id) || (ativ.pergunta && ativ.pergunta.id) || null;
    if (!(await pendenciaEhDele(agente, sessao, id))) { delete copia.permissao; delete copia.pergunta; copia.detalhe = null; }
    // O motivo do runner pode citar link ou código de login: o colaborador só fica sabendo que falta conta, sem link.
    if (copia.motivo) {
      if (copia.alerta === 'sem_login') copia.motivo = 'O agente ainda não tem uma conta de IA conectada. Você pode conectar a sua em Conectar conta, no menu.';
      else if (copia.alerta === 'login_expirado') {
        copia.motivo = contaColab.conectouEste(agente, sessao)
          ? 'O login da conta que você conectou expirou. Você pode conectar de novo em Conectar conta, no menu.'
          : 'O login do agente expirou, e só o dono do DG Claw reconecta. Avise o dono.';
      } else copia.motivo = 'O agente está sem sinal agora.';
    }
    return copia;
  }

  async function mensagens(req, res, url, agente, sessao) {
    const q = url.searchParams;
    const t = await conversa.thread(agente);
    const todas = t.msgs;
    if (q.get('after') != null) {
      const after = numeroOuErro(res, 'after', q.get('after'), 0);
      if (after === undefined) return undefined;
      const limite = numeroOuErro(res, 'limit', q.get('limit'), 80, 1, 500);
      if (limite === undefined) return undefined;
      const mais = todas.filter((x) => x.ep > after);
      return H.enviaJson(res, 200, { ok: true, msgs: mais.slice(0, limite), avisos: avisosPara(sessao, t.avisos), mais_novas: mais.length > limite, limit: limite, after });
    }
    const limite = numeroOuErro(res, 'limit', q.get('limit'), 60, 1, 500);
    if (limite === undefined) return undefined;
    const before = q.get('before') != null && q.get('before') !== '' ? numeroOuErro(res, 'before', q.get('before'), null) : null;
    if (before === undefined) return undefined;
    const base = before == null ? todas : todas.filter((x) => x.ep < before);
    const msgs = base.slice(Math.max(0, base.length - limite));
    return H.enviaJson(res, 200, { ok: true, msgs, avisos: avisosPara(sessao, t.avisos), mais_antigas: base.length > limite, before, limit: limite });
  }

  async function esperar(req, res, url, agente, sessao) {
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
      if (!sessaoAindaVale(req, sessao)) return recusaSessaoVelha(res, sessao);
      const t = await conversa.thread(agente);
      if (!sessaoAindaVale(req, sessao)) return recusaSessaoVelha(res, sessao);
      const novas = t.msgs.filter((x) => x.ep > since);
      const doAgente = novas.some((x) => x.origin === 'agente' && !x.sistema); // aviso de sistema (compactação) não é resposta
      if (doAgente || Date.now() >= fim || fechou) {
        if (fechou) return undefined;
        return H.enviaJson(res, 200, { ok: true, msgs: novas, timeout: !doAgente, avisos: avisosPara(sessao, t.avisos) });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  function stream(req, res, url, agente, sessao) {
    if (sessao && sessao.papel === 'colaborador') {
      const abertos = streamsDoColaborador.get(sessao.colaborador_id) || new Set();
      abertos.add(res);
      streamsDoColaborador.set(sessao.colaborador_id, abertos);
      res.on('close', () => { abertos.delete(res); if (!abertos.size) streamsDoColaborador.delete(sessao.colaborador_id); });
    }
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
      // Colaborador: a cada tique o stream confere a sessão e fecha quando ela deixou de valer (expirou, saiu, foi revogada).
      valeAinda: ehColab(sessao) ? () => sessaoAindaVale(req, sessao) : null,
      fontes: ehColab(sessao)
        // Colaborador: sem a fonte do foco (é a lista do dono) e com os avisos técnicos trocados por um genérico.
        ? { thread: async (a) => { const t = await conversa.thread(a); return Object.assign({}, t, { avisos: avisosPara(sessao, t.avisos) }); }, atividade: async (a) => atividadePara(sessao, a, await conversa.atividade(a)), versaoJs }
        : { thread: conversa.thread, atividade: conversa.atividade, versaoJs, foco: (a) => foco.lista(a.slug) },
    });
    return undefined;
  }

  /**
   * A sessão do colaborador ainda vale AGORA? Repete o que o pedido fez ao entrar (sessão, versão da senha, vínculo
   * com o agente, revogação). O corpo de um pedido pode demorar a chegar: quem foi revogado ou teve o convite
   * reenviado nesse meio tempo não pode concluir o que começou.
   */
  function sessaoAindaVale(req, sessao) {
    if (!ehColab(sessao)) return true;
    const s2 = auth.sessaoDoPedido(req);
    return !!s2 && s2.papel === 'colaborador' && s2.colaborador_id === sessao.colaborador_id
      && s2.senha_versao === sessao.senha_versao && s2.agente === sessao.agente;
  }
  function recusaSessaoVelha(res, sessao) {
    log('aviso', `Pedido do colaborador ${sessao.usuario} recusado: a sessão deixou de valer enquanto o corpo chegava (acesso revogado ou convite reenviado).`);
    return H.erroJson(res, 401, 'Seu acesso mudou enquanto o envio estava em andamento (foi revogado ou o convite foi reenviado). Nada foi feito. Entre de novo com o convite mais recente.');
  }

  async function lerEnvio(req, res) {
    try { return await H.lerJson(req, 256 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return null; }
  }

  /** Quem fala na conversa: o dono (sem marca, vira "pessoa" no envelope) ou o colaborador, que o agente precisa distinguir. */
  function atorDa(sessao) {
    if (!sessao || sessao.papel !== 'colaborador') return undefined;
    return { colaborador: true, colaborador_id: sessao.colaborador_id, from: `colaborador: ${sessao.nome ? `${sessao.nome} (${sessao.usuario})` : sessao.usuario}` };
  }

  // Quem iniciou o turno em curso de cada agente, e de quem é cada pendência (permissão ou pergunta) que ele abriu.
  // O colaborador só confirma uma pendência cujo id pertence a um turno que ELE iniciou, sem mensagem de outra
  // pessoa na fila. Um envio que só entrou na fila (o agente estava ocupado ou esperando confirmação) não inicia
  // turno nenhum: se ele trocasse o autor, o colaborador aprovaria a operação que o dono deixou pendente.
  // Sem registro (restart), o turno é do dono.
  const RX_ENVIO_DO_PAINEL = /^\/api\/(?:chat|socorro|sessoes)(?:\/|$)/i;
  const turnos = new Map(); // slug -> { autor: { dono:true } | { colaborador_id }, misto: bool }
  const pendencias = new Map(); // slug -> { id, ok } (ok: o colaborador pode responder)
  const autorDe = (sessao) => (sessao && sessao.papel === 'colaborador' ? { colaborador_id: sessao.colaborador_id } : { dono: true });
  const identidadeDe = (sessao) => (sessao && sessao.papel === 'colaborador' ? `colaborador:${sessao.colaborador_id}` : 'dono');
  const mesmoAutor = (a, b) => (a.dono ? !!b.dono : a.colaborador_id === b.colaborador_id);
  /**
   * Só a execução efetiva de um envio chama isto (nunca a devolução do cache de um cliente_id repetido).
   * `r` é a resposta do envio: com `r.corpo.fila` a mensagem só entrou na fila. Turno novo, turno que muda de autor
   * ou que fica misto invalidam as pendências já vinculadas desse agente.
   */
  function marcaAutor(slug, sessao, r) {
    const autor = autorDe(sessao);
    const atual = turnos.get(slug) || { autor: { dono: true }, misto: false };
    if (r && r.corpo && r.corpo.fila) {
      if (!mesmoAutor(atual.autor, autor) && !atual.misto) { atual.misto = true; pendencias.delete(slug); }
      turnos.set(slug, atual);
      return;
    }
    turnos.set(slug, { autor, misto: false });
    pendencias.delete(slug);
  }
  /** Primeira vez que se vê uma pendência com este id: fixa de quem ela é. Chamado só no caminho do colaborador. */
  function vinculaPendencia(slug, sessao, ativ) {
    const id = (ativ && ((ativ.permissao && ativ.permissao.id) || (ativ.pergunta && ativ.pergunta.id))) || null;
    if (!id) { pendencias.delete(slug); return; }
    const p = pendencias.get(slug);
    if (p && p.id === id) return;
    const t = turnos.get(slug) || { autor: { dono: true }, misto: false };
    pendencias.set(slug, { id, colaborador_id: !t.misto && t.autor.colaborador_id ? t.autor.colaborador_id : null });
  }
  /**
   * Duas provas, as duas precisam bater. A memória do Web (turnos e pendências) só enxerga o que passou por aqui;
   * a transcrição é o que o runner de fato executou, inclusive o que veio por Telegram, canal ou rotina. Sem as duas,
   * a pendência é do dono.
   */
  const pendenciaEhDele = async (agente, sessao, id) => {
    const slug = agente.slug;
    const p = pendencias.get(slug);
    const t = turnos.get(slug);
    // Confere de novo o turno de agora: o vínculo sozinho não basta se o turno virou misto ou mudou de autor.
    const memoria = !!(id && p && p.id === id && p.colaborador_id && p.colaborador_id === sessao.colaborador_id
      && t && !t.misto && t.autor.colaborador_id === sessao.colaborador_id);
    if (!memoria) return false;
    return (await conversa.autoriaDaPendencia(agente, id)) === sessao.colaborador_id;
  };
  /**
   * Para o colaborador: a confirmação precisa trazer o id da pendência que está na tela agora, e ela precisa ser de um
   * turno dele. Devolve true depois de ter respondido a recusa. O dono nunca é barrado aqui.
   */
  async function confirmacaoNegada(res, agente, sessao, toolUseId) {
    if (!sessao || sessao.papel !== 'colaborador') return false;
    const recusa = (status, motivo) => { log('aviso', `Confirmação negada ao colaborador ${sessao.usuario} em ${agente.slug}: ${motivo}`); H.erroJson(res, status, motivo); return true; };
    if (typeof toolUseId !== 'string' || !toolUseId) return recusa(400, 'Faltou o "tool_use_id" da confirmação (vem em "permissao.id" ou "pergunta.id" da atividade do agente).');
    const ativ = await conversa.atividade(agente);
    vinculaPendencia(agente.slug, sessao, ativ);
    const idAgora = (ativ.permissao && ativ.permissao.id) || (ativ.pergunta && ativ.pergunta.id) || null;
    if (idAgora !== toolUseId) return recusa(409, 'Essa confirmação já não é a que está pendente. Atualize a conversa.');
    if (!(await pendenciaEhDele(agente, sessao, toolUseId))) {
      return recusa(403, 'Essa confirmação é do dono do DG Claw. Ela é de um pedido que ele fez; aguarde ou fale com ele.');
    }
    return false;
  }

  async function enviar(req, res, agente, sessao) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    const cid = corpo.cliente_id;
    if (cid != null && cid !== '' && !(typeof cid === 'string' && RX_CLIENTE_ID.test(cid))) {
      return H.erroJson(res, 400, `O "cliente_id" veio como ${JSON.stringify(String(cid).slice(0, 80))}, que não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_". Nada foi enviado.`);
    }
    // Anonimizar: TODO texto que chega ao agente passa pelo filtro, inclusive "//" (vira texto), comando de barra com
    // argumentos e legenda de anexo. Só fica de fora o comando que o Web executa e que não leva texto ao agente.
    // Config ilegível NÃO desliga o filtro em silêncio: a mensagem é recusada com 503.
    try {
      if (typeof corpo.text === 'string' && corpo.text.trim()) {
        const temAnexos = Array.isArray(corpo.anexos) && corpo.anexos.length > 0;
        const d = await comandos.decidir(agente, corpo.text, { temAnexos });
        const chegaAoAgente = !d.erro && (d.tipo === 'texto' || /^\S+\s+\S/.test(corpo.text.trim()));
        if (chegaAoAgente) {
          const comAnexoAnonimizado = temAnexos && corpo.anexos.some((id) => {
            const e = typeof id === 'string' ? midia.obter(id) : null;
            return e && e.slug === agente.slug && /^doc-[0-9a-f]{8}\.anon\./.test(path.basename(e.path));
          });
          if (comAnexoAnonimizado ? anonimizar.estaLigado(agente.slug) : anonimizar.aplicaDigitado(agente.slug)) {
            corpo.text = anonimizar.trocarDigitado(agente.slug, corpo.text).texto;
          }
        }
      }
    } catch (e) {
      log('erro', `Anonimizar: mensagem para ${agente.slug} recusada (${e.codigo || e.message}).`);
      return H.erroJson(res, e.status || 500, e.status ? e.message : `Não enviei a mensagem porque não consegui trocar os dados pessoais dela: ${e.message}`, e.codigo ? { codigo: e.codigo } : undefined);
    }
    const r = await conversa.umaVez(agente, 'send', cid || null, () => conversa.enviar(agente, corpo, atorDa(sessao)), identidadeDe(sessao));
    if (r.status < 300 && !(r.corpo && r.corpo.repetido)) marcaAutor(agente.slug, sessao, r);
    return H.enviaJson(res, r.status, r.corpo);
  }

  async function comandoPost(req, res, agente, sessao) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    const cid = corpo.cliente_id;
    if (cid != null && cid !== '' && !(typeof cid === 'string' && RX_CLIENTE_ID.test(cid))) {
      return H.erroJson(res, 400, `O "cliente_id" veio como ${JSON.stringify(String(cid).slice(0, 80))}, que não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_". Nada foi enviado.`);
    }
    // Argumentos de comando também chegam ao agente (skill, /compact foque em...). Monta UMA representação do que vai ao
    // runner, como conversa.comando interpreta ("comando" + "argumentos", senão "text"), filtra esse texto final e o devolve
    // num campo só. Combinação inválida segue para conversa.comando, que recusa com o motivo.
    try {
      const valido = typeof corpo.comando === 'string' && corpo.comando.trim() ? (corpo.argumentos == null || typeof corpo.argumentos === 'string') : (typeof corpo.text === 'string' && corpo.text.trim());
      if (valido) {
        const final = typeof corpo.comando === 'string' && corpo.comando.trim()
          ? corpo.comando.trim() + (typeof corpo.argumentos === 'string' && corpo.argumentos.trim() ? ` ${corpo.argumentos.trim()}` : '')
          : corpo.text.trim();
        if (/^\S+\s+\S/.test(final) && anonimizar.aplicaDigitado(agente.slug)) {
          corpo.text = anonimizar.trocarDigitado(agente.slug, final).texto;
          delete corpo.comando; delete corpo.argumentos;
        }
      }
    } catch (e) {
      log('erro', `Anonimizar: comando para ${agente.slug} recusado (${e.codigo || e.message}).`);
      return H.erroJson(res, e.status || 500, e.message, e.codigo ? { codigo: e.codigo } : undefined);
    }
    const r = await conversa.umaVez(agente, 'comando', cid || null, () => conversa.comando(agente, corpo, atorDa(sessao)), identidadeDe(sessao));
    if (r.status < 300 && !(r.corpo && r.corpo.repetido)) marcaAutor(agente.slug, sessao, r);
    return H.enviaJson(res, r.status, r.corpo);
  }

  const gravaAnexo = opcoes.gravaAnexo || gravaAnexoReal;

  async function upload(req, res, agente, sessao) {
    if (!agente.home_host) return H.erroJson(res, 503, `O agente ${agente.nome} não tem home_host no registro, então não há onde guardar anexos.`);
    let mp;
    try { mp = await lerMultipart(req, config.maxUploadBytes); } catch (e) { return H.erroJson(res, e.status || 400, e.message); }
    const arq = mp.arquivos.find((a) => a.campo === 'file');
    if (!arq || !arq.nome) return H.erroJson(res, 400, 'Mande o arquivo num multipart, no campo "file". Não veio nenhum arquivo.');
    const cid = mp.campos.cliente_id;
    if (cid && !RX_CLIENTE_ID.test(cid)) return H.erroJson(res, 400, 'O "cliente_id" não vale: use de 8 a 64 caracteres entre letras, números, "-" e "_".');
    if (!arq.dados.length) return H.erroJson(res, 400, `O arquivo "${arq.nome}" chegou com 0 byte. Escolha o arquivo de novo.`);
    const soGuardar = /^(0|false|nao|não|no)$/i.test((mp.campos.enviar || '').trim());
    const souColab = ehColab(sessao);
    const nomeLimpo = conversa.validaControle(arq.nome, 'O nome do arquivo');
    if (nomeLimpo.erro) return H.erroJson(res, 400, nomeLimpo.erro);
    const legendaLimpa = conversa.validaControle((mp.campos.legenda || '').trim(), 'A legenda', { normalizarCR: !souColab });
    if (legendaLimpa.erro) return H.erroJson(res, 400, legendaLimpa.erro);
    const legenda = legendaLimpa.texto;
    const r = await conversa.umaVez(agente, 'upload', cid || null, async () => {
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      // Colaborador grava numa pasta só dele e com um prefixo aleatório no nome: nunca na pasta dos arquivos do dono.
      const pastas = souColab ? ['uploads', dia, `colaborador-${String(sessao.colaborador_id).replace(/[^A-Za-z0-9_-]/g, '')}`] : ['uploads', dia];
      const pasta = path.join(agente.home_host, 'uploads', dia);
            // Anonimizar documentos: com a opção ligada, o original NUNCA chega à casa do agente; só as saídas com marcadores.
      const anon = await anonimizar.processarUpload(agente, { nome: arq.nome, dados: arq.dados, legenda, dia });
      if (!anon.ok) {
        log('aviso', `Upload para ${agente.slug} barrado pela anonimização (${anon.codigo || anon.status}). Nada foi enviado ao agente.`);
        return { status: anon.status, corpo: { ok: false, erro: anon.erro, codigo: anon.codigo || null, anonimizado: false } };
      }
      let destino; let anonimizado = null; let legendaEnvio = legenda; let notaAnon = ''; let nomeArquivo = arq.nome;
      if (!anon.id) {
        // Sem anonimizar o arquivo (exceção escolhida pelo dono): a legenda e o nome dele também chegam ao agente.
        try {
          if (anonimizar.aplicaDigitado(agente.slug)) {
            legendaEnvio = anonimizar.trocarDigitado(agente.slug, legenda).texto;
            nomeArquivo = anonimizar.trocarDigitado(agente.slug, arq.nome).texto;
          }
        } catch (e) {
          log('aviso', `Upload para ${agente.slug} barrado: não consegui filtrar a legenda e o nome do arquivo (${e.codigo || e.message}). Nada foi enviado ao agente.`);
          return { status: e.status || 503, corpo: { ok: false, erro: `${e.message} O arquivo não foi enviado ao agente.`, codigo: e.codigo || null, anonimizado: false } };
        }
      }
      if (anon.id) {
        destino = anon.principal;
        legendaEnvio = anon.legenda;
        anonimizado = { id: anon.id, contagem: anon.total, por_tipo: anon.contagem, avisos: anon.avisos, nivel: anon.nivel };
        const outras = anon.vistos.filter((v) => v !== paraContainer(destino, agente));
        notaAnon = '[documento anonimizado: os dados pessoais foram trocados por marcadores como [PESSOA_1]. Mantenha os marcadores exatamente como estão.' +
          (outras.length ? ` Outras versões do mesmo documento: ${outras.join(', ')}.` : '') + ']';
      } else {
        if (anon.semAnonimizar) anonimizado = { id: null, contagem: 0, avisos: [anon.aviso], enviado_sem_anonimizar: true };
        const nomeEmDisco = nomeNeutro(nomeSeguro(nomeArquivo));
        try {
          // Sem privilégio: quem grava é um processo com o uid do dono da casa, que não segue atalho para fora dela.
          destino = await gravaAnexo({ agente, pastas, nome: souColab ? `${crypto.randomBytes(4).toString('hex')}-${nomeEmDisco}` : nomeEmDisco, dados: arq.dados });
        } catch (e) {
          log('erro', `Upload para ${agente.slug}: não gravei em ${path.join(agente.home_host, ...pastas)}: ${e.message}`);
          return { status: 500, corpo: { ok: false, erro: `Não consegui gravar o arquivo na casa de ${agente.nome}: ${e.message} Nada foi enviado ao agente.` } };
        }
      }
      const visto = paraContainer(destino, agente);
      const media = midia.registrar(agente.slug, destino, { visto, nome: path.basename(destino) });
      const marcador = `[anexo: ${visto}]`;
      const tamanho = anon.id ? fs.statSync(destino).size : arq.dados.length;
      const anexo = { id: media.id, kind: media.kind, nome: anon.id ? path.basename(destino) : arq.nome, bytes: tamanho, path: visto, url: media.url };
      log('info', `Upload para ${agente.slug}: ${anon.id ? `documento anonimizado ${anon.id}` : arq.nome} (${media.kind}, ${tamanho} bytes) salvo em ${destino}.`);
      const corpoBase = anonimizado ? { anonimizado } : {};
      if (soGuardar) {
        return { status: 201, corpo: Object.assign({ ok: true, enviado: false, agente: agente.slug, anexo, marcador, media }, corpoBase) };
      }
      const ator = atorDa(sessao);
      const e = await conversa.entregar(agente, [legendaEnvio, marcador, notaAnon].filter(Boolean).join('\n'), { cru: false, from: ator && ator.from, colaboradorId: ator && ator.colaborador_id });
      if (e.status >= 300) return Object.assign(e, { corpo: Object.assign({ arquivo_salvo: visto }, e.corpo) });
      marcaAutor(agente.slug, sessao, e);
      return { status: 201, corpo: Object.assign({}, e.corpo, { enviado: true, kind: media.kind, texto: legendaEnvio, anexo, marcador, media }, corpoBase) };
    }, identidadeDe(sessao));
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

  async function falar(req, res, sessao) {
    const corpo = await lerEnvio(req, res);
    if (!corpo) return undefined;
    // Colaborador só fala com a voz do agente dele, qualquer que seja o agent_id pedido.
    const slug = sessao && sessao.papel === 'colaborador' ? sessao.agente
      : (typeof corpo.agent_id === 'string' ? corpo.agent_id : (registro.estado().agentes[0] || {}).slug);
    const agente = registro.obter(slug);
    if (!agente) return H.erroJson(res, 404, `Não existe agente com o id "${String(slug).slice(0, 40)}".`);
    const parte = corpo.parte == null ? 0 : corpo.parte;
    if (!Number.isInteger(parte) || parte < 0) {
      return H.erroJson(res, 400, `O campo "parte" precisa ser um número inteiro a partir de 0 (o pedaço de voz pedido). Recebi ${JSON.stringify(parte).slice(0, 40)}. Nada foi falado.`);
    }
    const r = await voz.falar(agente, corpo.text, typeof corpo.voice_id === 'string' ? corpo.voice_id : null, parte);
    if (r.erro) return H.erroJson(res, r.status, r.erro);
    const cab = { 'Content-Type': 'audio/mpeg', 'Content-Length': r.audio.length, 'Cache-Control': 'no-store', 'X-TTS-Chars': String(r.chars), 'X-TTS-Partes': String(r.partes), 'X-TTS-Parte': String(r.parte) };
    res.writeHead(200, cab);
    return res.end(r.audio);
  }

  // ── despacho ─────────────────────────────────────────────────────────────
  const quemDoProxy = (sessao, req) => (sessao.papel === 'colaborador' ? { colaborador_id: sessao.colaborador_id, valeAinda: () => sessaoAindaVale(req, sessao) } : {});

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

    // Anonimização: tudo que o agente recebe pela caixa (tarefas, lembretes, avisos, foco...) passa pelo filtro dos valores
    // conhecidos dele, campo a campo. Sem poder filtrar (config ou tabela ilegível), a resposta é 503.
    if (slugCaixa) {
      let filtro;
      try { filtro = anonimizar.filtroSaida(slugCaixa); } catch (e) {
        log('erro', `Anonimizar: resposta da caixa para ${slugCaixa} recusada (${e.codigo || e.message}).`);
        return H.erroJson(res, e.status || 503, e.message, e.codigo ? { codigo: e.codigo } : undefined);
      }
      // Só a documentação estática (nome exato de rota, ex.: /api/v1/avisos/docs.md) escapa do filtro.
      if (filtro) filtraRespostaDaCaixa(res, filtro, log, /^\/api\/v1\/[a-z-]+\/docs\.md$/.test(p));
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
      const ja = auth.sessaoDoPedido(req);
      if (ja) { res.writeHead(302, { Location: destinoDaSessao(ja, proximoSeguro(url.searchParams.get('next'))) }); return res.end(); }
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

    // Única rota do Anonimizar sem sessão: a documentação, estática, para o agente ler sem credencial.
    if (p === '/api/v1/anonimizar/docs.md' && (m === 'GET' || m === 'HEAD')) { rotasAnonimizar.servirDocs(res); return undefined; }
    if (sessao && !sessao.via) {
      // O cookie de papel só serve para a tela esconder o que não é do colaborador; aqui ele se conserta sozinho.
      if (H.parseCookies(req.headers.cookie).dgclaw_papel !== sessao.papel) res.setHeader('Set-Cookie', auth.cookiePapel(sessao.papel, req));
      // Isolamento do colaborador: negar por padrão, antes de qualquer rota (ver lib/escopo.js).
      const veredito = escopo.avaliar(sessao, m, p, req.url);
      if (!veredito.ok) return negarEscopo(req, res, sessao, veredito, p);
    }

    if (ehColab(sessao)) {
      req.dgRevalidar = () => {
        const vale = sessaoAindaVale(req, sessao);
        if (!vale) log('aviso', `Pedido ${m} ${p.slice(0, 120)} do colaborador ${sessao.usuario} recusado: a sessão deixou de valer enquanto o corpo chegava.`);
        return vale;
      };
    }

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
      // O painel do dono manda texto ao runner por conta própria (chat, recados, sessões): daqui em diante o turno
      // em curso deixa de ser de qualquer colaborador. A transcrição é a prova de verdade; isto é a segunda trava.
      if (!ehColab(sessao) && !sessao.via && m !== 'GET' && m !== 'HEAD' && RX_ENVIO_DO_PAINEL.test(pp[2])) {
        const slugPainel = decodeURIComponent(pp[1]);
        if (RX_SLUG_ROTA.test(slugPainel)) marcaAutor(slugPainel, sessao, null);
      }
      // O dono também inicia/cancela o login da conta de IA pelo painel do agente, sem passar pelas rotas /login do Web:
      // aqui respeita a reserva do colaborador e invalida a autoria dele (web/lib/conta-colaborador.js).
      if (!ehColab(sessao) && !sessao.via && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) && /^\/api\/provedor(\/|$)/i.test(pp[2])) {
        const mp = /^\/api\/provedor\/login(\/codigo)?\/?$/i.exec(pp[2]);
        const slugP = (() => { try { return decodeURIComponent(pp[1]); } catch (_) { return ''; } })();
        const agP = RX_SLUG_ROTA.test(slugP) ? registro.obter(slugP) : null;
        if (agP) {
          const veto = mp && (m === 'POST' || m === 'DELETE') ? await contaColab.noPainelDoDono(agP, sessao, m, !!mp[1]) : await contaColab.provedorNoPainelDoDono(agP);
          if (veto) return H.erroJson(res, veto.status, veto.corpo.erro);
        }
      }
      return proxy.responder(req, res, pp[1], sessao.usuario, quemDoProxy(sessao, req));
    }

    if (p === '/' && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (falhaDoRegistro(req, res, false)) return undefined;
      res.writeHead(302, { Location: `/a/${sessao.papel === 'colaborador' ? encodeURIComponent(sessao.agente) : agenteInicial(req)}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (p === '/trocar-senha' && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (sessao.papel !== 'colaborador') { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
      if (!servirArquivo(req, res, path.join(config.publicDir, 'trocar-senha.html'), 'no-store')) {
        log('erro', `A tela de trocar senha não está instalada: falta ${path.join(config.publicDir, 'trocar-senha.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de trocar senha não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/colaboradores' || p === '/colaboradores/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'colaboradores.html'), 'no-store')) {
        log('erro', `A tela de colaboradores não está instalada: falta ${path.join(config.publicDir, 'colaboradores.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de colaboradores não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
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
      // Colaborador: a fileira de troca de agente (#trocaBaixo) nem é enviada. Ele só tem este agente.
      if (ehColab(sessao)) {
        let html;
        try { html = fs.readFileSync(path.join(config.publicDir, 'conversa.html'), 'utf8'); } catch (_) { html = null; }
        if (html != null) {
          html = html.replace(/[ \t]*<nav id="trocaBaixo"[^>]*><\/nav>\n?/, '');
          const corpoHtml = Buffer.from(html, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': corpoHtml.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(m === 'HEAD' ? undefined : corpoHtml);
        }
      }
      if (!servirArquivo(req, res, path.join(config.publicDir, 'conversa.html'), 'no-store')) {
        log('erro', `A tela da conversa não está instalada: falta ${path.join(config.publicDir, 'conversa.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela da conversa não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/seguranca' || p === '/seguranca/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'seguranca.html'), 'no-store')) {
        log('erro', `A tela de segurança não está instalada: falta ${path.join(config.publicDir, 'seguranca.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de segurança não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/anonimizar' || p === '/anonimizar/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'anonimizar.html'), 'no-store')) {
        log('erro', `A tela de anonimizar não está instalada: falta ${path.join(config.publicDir, 'anonimizar.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de anonimizar documentos não foi encontrado no servidor. Reinstale o DG Claw Web.');
      }
      return undefined;
    }

    if ((p === '/conectar' || p === '/conectar/') && (m === 'GET' || m === 'HEAD')) {
      if (!sessao) return semSessaoPagina(req, res, url);
      if (!servirArquivo(req, res, path.join(config.publicDir, 'conectar.html'), 'no-store')) {
        log('erro', `A tela de conectar conta não está instalada: falta ${path.join(config.publicDir, 'conectar.html')}.`);
        H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de conectar conta não foi encontrado no servidor. Reinstale o DG Claw Web.');
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
      const veredito = escopo.websocketLiberado(sessao, url.pathname, req.url);
      if (!veredito.ok) {
        log('aviso', `WebSocket em ${url.pathname.slice(0, 120)} recusado para o colaborador ${sessao.usuario}: ${veredito.motivo}`);
        return nega(403, veredito.motivo);
      }
      if (!origemOk(req)) {
        log('aviso', `WebSocket em ${url.pathname} recusado: Origin ${String(req.headers.origin || '(sem Origin)').slice(0, 80)} não é a deste Web.`);
        return nega(403, 'Origem não permitida.');
      }
      const quem = quemDoProxy(sessao, req);
      if (quem.colaborador_id) {
        // A conferência repete o login do upgrade: o proxy a chama a cada 30 s e fecha o socket quando a sessão cai.
        quem.valeAinda = () => { const s2 = auth.sessaoDoPedido(req); return !!s2 && s2.papel === 'colaborador' && s2.colaborador_id === quem.colaborador_id && s2.senha_versao === sessao.senha_versao; };
      }
      return proxy.upgrade(req, socket, head, pp[1], sessao.usuario, quem);
    } catch (e) {
      log('erro', `Falha no upgrade de ${String(req.url).split('?')[0]}: ${e.message}`);
      socket.destroy();
      return undefined;
    }
  });

  // ── socket de administração do host ──────────────────────────────────────────
  // O comando `dgclaw colaborador` (root, no servidor) fala com o Web por um socket Unix em <dataDir>/admin.sock
  // (pasta 0700, socket 0600). Só atende /api/v1/colaboradores*; a sessão é a do dono, sem cookie. Quem chega por ele já
  // é root no servidor, e nenhum agente, caixa ou colaborador consegue abrir esse arquivo.
  const caminhoSocketAdmin = path.join(config.dataDir, 'admin.sock');
  const sessaoDoHost = () => ({ usuario: auth.usuario, via: 'host', papel: 'dono' });
  const servidorAdmin = http.createServer(async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url, 'http://local'); } catch (_) { return H.erroJson(res, 400, 'Não entendi o endereço pedido.'); }
      const p = url.pathname;
      if (p !== '/api/v1/colaboradores' && !p.startsWith('/api/v1/colaboradores/')) {
        return H.erroJson(res, 404, `Este canal do servidor só atende /api/v1/colaboradores (recebi ${req.method} ${p.slice(0, 120)}). As outras rotas são do painel, no navegador.`);
      }
      if (falhaDoRegistro(req, res, true)) return undefined;
      if (await colabRotas.tratar(req, res, url, sessaoDoHost())) return undefined;
      return H.erroJson(res, 404, `Não existe ${req.method} ${p}.`);
    } catch (e) {
      log('erro', `Socket de administração: ${req.method} ${String(req.url).slice(0, 120)} falhou: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      if (!res.headersSent) return H.erroJson(res, 500, 'Erro interno do servidor. O detalhe foi registrado no log do Web.');
      res.destroy();
      return undefined;
    }
  });

  /** Abre o socket. Nunca derruba o Web: se não der, o comando `dgclaw colaborador` diz que o Web não responde e o log diz por quê. */
  function abreSocketAdmin() {
    return new Promise((resolve) => {
      const falhou = (motivo) => { log('erro', `Não abri o socket de administração ${caminhoSocketAdmin} (${motivo}). O Web segue funcionando, mas o comando "dgclaw colaborador" não vai conseguir falar com ele até isso ser resolvido. Confira a permissão da pasta ${config.dataDir} e o tamanho do caminho (o limite de um socket Unix é de uns 100 caracteres).`); resolve(false); };
      try {
        let st = null;
        try { st = fs.lstatSync(caminhoSocketAdmin); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (st) {
          if (!st.isSocket()) return falhou('já existe um arquivo que não é um socket nesse caminho e eu não o apaguei');
          fs.unlinkSync(caminhoSocketAdmin);
        }
      } catch (e) { return falhou(e.code || e.message); }
      servidorAdmin.once('error', (e) => falhou(e.code || e.message));
      try {
        servidorAdmin.listen(caminhoSocketAdmin, () => {
          try { fs.chmodSync(caminhoSocketAdmin, 0o600); } catch (e) { servidorAdmin.close(); return falhou(`não consegui pôr permissão 600: ${e.code || e.message}`); }
          log('info', `Socket de administração do host em ${caminhoSocketAdmin}.`);
          return resolve(true);
        });
      } catch (e) { falhou(e.code || e.message); }
    });
  }

  return {
    servidor, servidorAdmin, caminhoSocketAdmin, config, registro, auth, colaboradores, contaColab, proxy, midia, conversa, anonimizar, filtroAnon, log, caixa, push, lembretes, avisos, estados, vigiaAtencao, prefsAtencao,
    ouvir(porta, host) {
      return new Promise((resolve, reject) => {
        servidor.once('error', reject);
        servidor.listen(porta == null ? config.porta : porta, host || config.host, () => {
          servidor.off('error', reject);
          caixa.iniciar();
          lembretes.iniciar();
          avisos.iniciar();
          vigiaAtencao.iniciar();
          if (opcoes.semSocketAdmin) return resolve(servidor.address());
          return abreSocketAdmin().then(() => resolve(servidor.address()));
        });
      });
    },
    fechar() { return new Promise((resolve) => { caixa.parar(); lembretes.parar(); avisos.parar(); vigiaAtencao.parar(); proxy.fecharTudo(); anonimizar.encerrar(); servidorAdmin.closeAllConnections(); servidorAdmin.close(); servidor.closeAllConnections && servidor.closeAllConnections(); servidor.close(() => resolve()); }); },
  };
}

module.exports = { criarServidor, proximoSeguro, filtraRespostaDaCaixa };

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
