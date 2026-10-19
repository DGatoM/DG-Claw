'use strict';
// Bloco G do enterprise, parte 1: login único (SSO) por OIDC. Guia em docs/enterprise/SSO-AUDITORIA.md.
// Só age quando a proteção `sso` não é "nao" E o multiusuário está ligado (o e-mail do token procura a pessoa no
// usuarios.json). No nível pessoal este módulo não responde a nada e o login é o de sempre.
//
// Rotas (sem sessão): GET /sso/entrar  começa o fluxo (cookie assinado com state, nonce e PKCE; 10 min)
//                     GET /sso/retorno volta do provedor, confere tudo e abre a sessão
// Modos da matriz: opcional (botão ao lado da senha), padrao (botão em destaque, senha escondida atrás de um link),
// obrigatorio (a senha deixa de valer para todos, menos para uma conta de emergência do TI marcada `emergencia: true`).
// O módulo nunca cria usuário: quem não está no usuarios.json recebe a tela "peça ao TI para cadastrar o seu e-mail".
// Login por SSO conta como segundo fator feito pelo provedor da empresa (fa2_em = agora, via: 'sso').
// Os textos de cada código de erro (/login?erro=sso_<codigo>) ficam em web/public/login.js.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const { criarArquivoUsuarios, ErroUsuarios, chave } = require('../usuarios-arquivo');
const sso = require('../sso-config');
const { criarOidc, ErroOidc, novoPkce, aleatorio, seguroIgual } = require('../sso-oidc');

const NOME_COOKIE = 'dgclaw_sso';
const VALE_MS = 10 * 60 * 1000;

const b64 = (v) => Buffer.from(v).toString('base64url');

/** `next` só vale se for caminho do próprio site (mesma regra do server.js). */
function proximoSeguro(v) {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\x00-\x1f]/.test(s) || s.startsWith('/login') || s.startsWith('/sair') || s.startsWith('/sso')) return '/';
  return s;
}

module.exports = {
  nome: 'sso',
  ordem: 5,
  criar(ctx) {
    const { config, auth, log, protecoes, auditoria } = ctx;
    const relogio = ctx.agora ? () => { const a = ctx.agora(); return a instanceof Date ? a.getTime() : Number(a); } : () => Date.now();
    const teste = ctx.sso || {};
    const caminhoCfg = sso.caminhoDoSso(config.protecoesPath);
    const oidc = criarOidc({ fetch: teste.fetch, agora: relogio, log, aceitaLoopback: !!teste.aceitaLoopback });

    const multiOn = () => protecoes.ligada('multiusuario');
    const modoMatriz = () => protecoes.valor('sso');
    const ativoNaMatriz = () => modoMatriz() !== 'nao' && multiOn();

    // ── configuração (relida quando o arquivo muda) ─────────────────────────
    let cache = { marca: null, cfg: null, erro: null };
    let ultimoErroLogado = '';
    function configuracao() {
      let marca;
      try { const st = fs.statSync(caminhoCfg); marca = `${st.mtimeMs}:${st.size}`; } catch (e) { marca = e.code === 'ENOENT' ? 'ausente' : `erro:${e.code}`; }
      if (cache.marca === marca) return cache;
      let cfg = null; let erro = null;
      if (marca === 'ausente') erro = `Falta o arquivo ${caminhoCfg}. Configure com: dgclaw sso configurar`;
      else {
        try { cfg = sso.ler(caminhoCfg, { log, aceitaLoopback: !!teste.aceitaLoopback }); } catch (e) {
          if (!(e instanceof sso.ErroSso)) throw e;
          erro = e.message;
        }
      }
      if (erro && erro !== ultimoErroLogado) { ultimoErroLogado = erro; log('erro', `Login único (SSO) indisponível: ${erro}`); }
      cache = { marca, cfg, erro };
      return cache;
    }

    // ── usuários (o mesmo usuarios.json do multiusuário; nunca é criado por aqui) ──
    let arquivoReal = null;
    const abrir = () => arquivoReal || (arquivoReal = criarArquivoUsuarios({ dataDir: config.dataDir, log, semente: () => [] }));
    const temArquivo = () => fs.existsSync(path.join(config.dataDir, 'usuarios.json'));
    function listaUsuarios() {
      if (!temArquivo()) return [];
      try { return abrir().lista(); } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        log('erro', e.message);
        return [];
      }
    }
    const vivo = (r) => !!r && !r.desativado_em;

    // ── auditoria ──────────────────────────────────────────────────────────
    const ipDe = (req) => H.ipDoPedido(req, config.proxiesConfiaveis);
    const uaDe = (req) => String((req && req.headers && req.headers['user-agent']) || '').slice(0, 120);
    function auditar(evento, dados, quem, req) {
      try {
        auditoria.registrar(evento, Object.assign({}, dados, req ? { ip: ipDe(req), ua: uaDe(req) } : {}), quem || 'desconhecido', 'web');
      } catch (e) {
        log('erro', `Não consegui gravar o evento "${evento}" na auditoria (${e.message}). A ação foi feita, mas ficou sem registro; confira a pasta da auditoria.`);
      }
    }

    // ── cookie assinado do fluxo ───────────────────────────────────────────
    let chaveHmac = null;
    function chaveDoCookie() {
      if (chaveHmac) return chaveHmac;
      const arq = path.join(config.dataDir, 'sso-chave');
      try {
        chaveHmac = Buffer.from(fs.readFileSync(arq, 'utf8').trim(), 'base64url');
        if (chaveHmac.length === 32) return chaveHmac;
        log('aviso', `${arq} não tem 32 bytes; gerei outra. Quem estava no meio de um login por SSO precisa recomeçar.`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw new Error(`Não consegui ler ${arq} (${e.code || e.message}). Confira a permissão da pasta ${config.dataDir}.`);
      }
      chaveHmac = crypto.randomBytes(32);
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(arq, `${chaveHmac.toString('base64url')}\n`, { mode: 0o600 });
      return chaveHmac;
    }
    const assina = (payload) => crypto.createHmac('sha256', chaveDoCookie()).update(payload).digest('base64url');
    const seguro = (req) => (H.esquemaDoPedido(req, config.proxiesConfiaveis) === 'https' ? '; Secure' : '');
    function cookieDoFluxo(req, dados) {
      const payload = b64(JSON.stringify(dados));
      return `${NOME_COOKIE}=${payload}.${assina(payload)}; HttpOnly; SameSite=Lax; Path=/sso; Max-Age=${VALE_MS / 1000}${seguro(req)}`;
    }
    const apagaCookie = (req) => `${NOME_COOKIE}=; HttpOnly; SameSite=Lax; Path=/sso; Max-Age=0${seguro(req)}`;
    function lerCookieDoFluxo(req) {
      const bruto = H.parseCookies(req.headers.cookie)[NOME_COOKIE];
      if (!bruto || bruto.length > 2000) return null;
      const i = bruto.lastIndexOf('.');
      if (i < 1) return null;
      const payload = bruto.slice(0, i);
      if (!seguroIgual(bruto.slice(i + 1), assina(payload))) return null;
      try {
        const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return d && Number(d.exp) > relogio() ? d : null;
      } catch (_) { return null; }
    }

    // ── respostas ──────────────────────────────────────────────────────────
    function paraOLogin(res, req, codigo) {
      res.writeHead(302, { Location: `/login?erro=sso_${codigo}`, 'Cache-Control': 'no-store', 'Set-Cookie': apagaCookie(req) });
      res.end();
      return true;
    }
    const redirectUri = (req, cfg) => cfg.redirect_uri || `${H.origemPropria(req, config.proxiesConfiaveis)}/sso/retorno`;
    function falhaDoFluxo(req, res, codigo, detalhe, quem) {
      log('aviso', `Login por SSO recusado (${codigo}, ip ${ipDe(req)}): ${detalhe}`);
      auditar('sso_falha', { motivo: codigo, detalhe: String(detalhe).slice(0, 240) }, quem || 'desconhecido', req);
      return paraOLogin(res, req, codigo);
    }

    async function entrar(req, res, url) {
      const { cfg, erro } = configuracao();
      if (!cfg) {
        H.paginaErro(res, 503, 'Login único não configurado', `O login único está ligado mas a configuração não vale: ${erro} Quem administra o servidor resolve com: dgclaw sso configurar`);
        return true;
      }
      if (auth.sessaoDoPedido(req)) { res.writeHead(302, { Location: proximoSeguro(url.searchParams.get('next')) }); res.end(); return true; }
      let doc;
      try { doc = await oidc.descobrir(cfg); } catch (e) {
        if (!(e instanceof ErroOidc)) throw e;
        return falhaDoFluxo(req, res, e.codigo, e.message);
      }
      const pkce = novoPkce();
      const estado = aleatorio(24);
      const nonce = aleatorio(24);
      const next = proximoSeguro(url.searchParams.get('next'));
      const cookie = cookieDoFluxo(req, { s: estado, n: nonce, v: pkce.verificador, next, exp: relogio() + VALE_MS });
      const destino = oidc.urlDeAutorizacao(cfg, doc, { redirect_uri: redirectUri(req, cfg), state: estado, nonce, desafio: pkce.desafio });
      res.writeHead(302, { Location: destino, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    /** Acha a pessoa pelo e-mail do token. { rec } | { motivo: 'nenhum' | 'desativado' | 'ambiguo' }. */
    function pessoaDoEmail(email) {
      const todos = listaUsuarios().filter((u) => chave(u.email) === email);
      if (!todos.length) return { motivo: 'nenhum' };
      const vivos = todos.filter(vivo);
      if (!vivos.length) return { motivo: 'desativado', rec: todos[0] };
      if (vivos.length > 1) return { motivo: 'ambiguo' };
      return { rec: vivos[0] };
    }

    async function retorno(req, res, url) {
      const { cfg } = configuracao();
      if (!cfg) return paraOLogin(res, req, 'config');
      const fluxo = lerCookieDoFluxo(req);
      const state = url.searchParams.get('state');
      if (!fluxo || !state || !seguroIgual(state, fluxo.s)) {
        return falhaDoFluxo(req, res, 'estado', fluxo ? 'o state do retorno não é o desta janela do navegador' : 'o cookie do fluxo não veio, expirou ou foi alterado');
      }
      const recusa = url.searchParams.get('error');
      if (recusa) return falhaDoFluxo(req, res, 'recusado', `o provedor devolveu error=${String(recusa).replace(/[^a-z_]/gi, '').slice(0, 40)}`);
      const codigo = url.searchParams.get('code');
      if (!codigo || codigo.length > 2048) return falhaDoFluxo(req, res, 'token', 'o retorno veio sem o parâmetro code');
      let identidade;
      try {
        const doc = await oidc.descobrir(cfg);
        const idToken = await oidc.trocarCodigo(cfg, doc, { codigo, verificador: fluxo.v, redirect_uri: redirectUri(req, cfg) });
        identidade = await oidc.validarIdToken(cfg, doc, idToken, { nonce: fluxo.n });
      } catch (e) {
        if (!(e instanceof ErroOidc)) throw e;
        return falhaDoFluxo(req, res, e.codigo, e.message);
      }
      const p = pessoaDoEmail(identidade.email);
      if (p.motivo === 'nenhum') {
        log('aviso', `Login por SSO de ${identidade.email}: o e-mail não está no usuarios.json (ip ${ipDe(req)}).`);
        auditar('sso_falha', { motivo: 'email_nao_cadastrado', email: identidade.email }, identidade.email, req);
        H.paginaErro(res, 403, 'E-mail ainda não cadastrado', `O provedor confirmou o e-mail ${identidade.email}, mas ele não está cadastrado neste painel. Peça ao administrador de TI para cadastrar o seu e-mail e tente de novo.`, { 'Set-Cookie': apagaCookie(req) });
        return true;
      }
      if (p.motivo === 'desativado') return falhaDoFluxo(req, res, 'desativado', `o usuário ${p.rec.usuario} está desativado`, p.rec.usuario);
      if (p.motivo === 'ambiguo') return falhaDoFluxo(req, res, 'ambiguo', `mais de um usuário vivo com o e-mail ${identidade.email}`);
      const rec = p.rec;
      const s = auth.criaSessao(rec.usuario, req, {
        papel: rec.papel, com_2fa: rec.totp.ativo, fa2_em: relogio(), via: 'sso', ip: ipDe(req), ua: uaDe(req),
      });
      try {
        abrir().atualizar((d) => {
          const r = d.usuarios.find((u) => chave(u.usuario) === chave(rec.usuario));
          if (!r) return { semMudanca: true };
          r.ultimo_login = relogio();
          return null;
        });
      } catch (e) {
        log('aviso', `Não consegui gravar o último login de "${rec.usuario}" (${e.message}). O login valeu; só o registro de "último acesso" ficou velho.`);
      }
      auditar('login_ok', { via: 'sso', provedor: cfg.provedor, email: identidade.email }, rec.usuario, req);
      log('info', `Login de ${rec.usuario} por SSO (${cfg.provedor}, ip ${ipDe(req)}).`);
      res.writeHead(302, { Location: proximoSeguro(fluxo.next), 'Set-Cookie': [s.cookie, apagaCookie(req)], 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    // ── senha no modo obrigatório ──────────────────────────────────────────
    /** Gancho de login (index.js): em modo obrigatório só a conta de emergência passa para a conferência de senha. */
    function login(usuario, _senha, _ip, req) {
      if (!ativoNaMatriz() || modoMatriz() !== 'obrigatorio') return null;
      const k = chave(usuario);
      const rec = listaUsuarios().find((u) => chave(u.usuario) === k);
      const curto = String(usuario || '').slice(0, 80);
      if (vivo(rec) && rec.emergencia === true && rec.papel === 'ti') {
        const n2 = protecoes.valor('2fa');
        if (!rec.totp.ativo && n2 !== 'todos' && n2 !== 'ti') {
          auditar('login_recusado_sso', { usuario: curto, motivo: 'emergencia_sem_2fa' }, curto, req);
          return { ok: false, codigo: 'sso_emergencia', erro: 'A conta de emergência só entra com senha e segundo fator, e esta ainda não tem o segundo fator. Peça ao TI para ligar o 2FA dela antes.' };
        }
        auditar('login_emergencia_tentativa', { usuario: rec.usuario }, rec.usuario, req);
        log('aviso', `Tentativa de login pela conta de EMERGÊNCIA "${rec.usuario}" (ip ${ipDe(req)}). O login único é obrigatório neste nível; confira se isto era esperado.`);
        return null;
      }
      auditar('login_recusado_sso', { usuario: curto, motivo: 'senha_desligada' }, curto, req);
      return { ok: false, codigo: 'sso_obrigatorio', erro: 'Neste nível de proteção a entrada é só pelo login único da empresa. Use o botão de entrar com a conta da empresa.' };
    }

    return {
      login,

      /** Estende /api/login-estado com o que a tela de login precisa para mostrar o botão. */
      loginEstado(estado) {
        if (!ativoNaMatriz()) return;
        const { cfg } = configuracao();
        if (!cfg) {
          // Em modo obrigatório sem configuração válida a senha já não vale: a tela precisa dizer isso, não esconder o motivo.
          if (modoMatriz() === 'obrigatorio') estado.sso = { modo: 'obrigatorio', indisponivel: true, provedor: null, url: null };
          return;
        }
        estado.sso = { provedor: sso.nomeDoProvedor(cfg), modo: modoMatriz(), url: '/sso/entrar' };
      },

      async antesDaSessao(req, res, url) {
        const p = url.pathname;
        if (p !== '/sso/entrar' && p !== '/sso/retorno') return false;
        if (!ativoNaMatriz()) return false;   // nível pessoal (ou sem multiusuário): estas rotas não existem, como antes
        if (req.method !== 'GET' && req.method !== 'HEAD') { H.erroJson(res, 405, `Abra ${p} pelo navegador, com GET.`); return true; }
        try {
          return p === '/sso/entrar' ? await entrar(req, res, url) : await retorno(req, res, url);
        } catch (e) {
          log('erro', `SSO ${p}: ${e.stack || e.message}`);
          H.paginaErro(res, 500, 'Não consegui entrar', 'Aconteceu um erro inesperado no login único. O detalhe está no registro do servidor; fale com o TI.');
          return true;
        }
      },
    };
  },
};
