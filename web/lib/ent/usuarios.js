'use strict';
// Bloco B do enterprise: vários usuários com papéis, segundo fator (TOTP), sessões que se revogam e a auditoria do login.
// Só age quando a proteção `multiusuario` está ligada; no nível pessoal este módulo não responde a nada, não lê
// o usuarios.json e o login é o de sempre (um usuário só, do web.env).
//
// Papéis: `ti` vê tudo (inclusive o Admin, os usuários, a auditoria). `funcionario` vê só os agentes da sua lista e nunca o Admin.
// A regra única de acesso é podeVerAgente(sessao, slug); o server.js a aplica em toda rota que recebe slug.
//
// Rotas deste módulo (todas só com multiusuário ligado):
//   antesDaSessao (sem sessão completa):  GET /login/2fa, GET|POST /api/v1/login/2fa, POST /api/primeiro-acesso (link de usuário)
//   antes (com sessão):  GET /usuarios, GET /conta, /api/v1/usuarios..., /api/v1/eu...
// Contrato completo das rotas em web/docs/USUARIOS.md.

const crypto = require('node:crypto');
const path = require('node:path');
const H = require('../http');
const totp = require('../totp');
const { criarArquivoUsuarios, ErroUsuarios, chave, PAPEIS, RX_USUARIO } = require('../usuarios-arquivo');
const { motivoSenhaInvalida } = require('../primeiro-acesso');

const FALHAS_MAX = 10;
const JANELA_FALHAS_MS = 15 * 60 * 1000;
const TRANCA_MS = 15 * 60 * 1000;
const MEIA_MINUTOS = 5;
const CODIGOS_RESERVA = 10;
const CODIGO_POR_SESSAO_MAX = 5;
const LINK_MS = 24 * 60 * 60 * 1000;
const RX_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RX_ID_SESSAO = /^[0-9a-f]{16}$/;
const ALFABETO_RESERVA = 'abcdefghjkmnpqrstuvwxyz23456789';

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** `next` só vale se for caminho do próprio site (mesma regra do server.js). */
function proximoSeguro(v) {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\x00-\x1f]/.test(s) || s.startsWith('/login') || s.startsWith('/sair')) return '/';
  return s;
}

function codigoReservaNovo() {
  const b = crypto.randomBytes(12);
  let t = '';
  for (let i = 0; i < 12; i += 1) t += ALFABETO_RESERVA[b[i] % ALFABETO_RESERVA.length];
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}`;
}
const normalizaReserva = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Para o bloco de aprovações: a ação perigosa pede o 2FA feito há menos de `minutos`?
 * Verdadeiro quando a pessoa tem 2FA e o último código dela (no login ou em POST /api/v1/eu/reautenticar) é mais velho que isso.
 * Quem não tem 2FA ativo não tem como reautenticar, então devolve false (a exigência de ter 2FA é da matriz, não daqui).
 */
function exigeReautenticacao(sessao, minutos, agora) {
  if (!sessao || !sessao.com_2fa) return false;
  const limite = (minutos == null ? 15 : minutos) * 60 * 1000;
  const t = agora == null ? Date.now() : agora;
  return !(Number.isFinite(sessao.fa2_em) && t - sessao.fa2_em <= limite);
}

module.exports = {
  nome: 'usuarios',
  ordem: 10,
  exigeReautenticacao,
  criar(ctx) {
    const { config, registro, auth, log, protecoes, auditoria, servirArquivo, semSessaoPagina } = ctx;
    const relogio = ctx.agora ? () => { const a = ctx.agora(); return a instanceof Date ? a.getTime() : Number(a); } : () => Date.now();

    const multiOn = () => protecoes.ligada('multiusuario');
    const nivel2fa = () => protecoes.valor('2fa');
    const exige2fa = (rec) => { const v = nivel2fa(); return v === 'todos' || (v === 'ti' && rec.papel === 'ti'); };
    const precisaFa2 = (rec) => rec.totp.ativo || exige2fa(rec);

    // criado na primeira vez que alguém precisa (no nível pessoal nunca é criado, e o arquivo nem é tocado)
    let arquivoReal = null;
    const abrirArquivo = () => arquivoReal || (arquivoReal = criarArquivoUsuarios({
      dataDir: config.dataDir,
      log,
      semente() {
        const nome = String(auth.usuario || '').trim();
        if (!nome) {
          log('aviso', 'Multiusuário ligado, mas o web.env não tem DGCLAW_PANEL_USER: criei o arquivo de usuários vazio. Crie o primeiro usuário TI com: dgclaw usuario criar <usuario> --papel ti');
          return [];
        }
        log('info', `Multiusuário ligado pela primeira vez: o usuário do web.env ("${nome}") virou o primeiro usuário TI, com a mesma senha.`);
        return [{ usuario: nome, nome, email: '', papel: 'ti', agentes: [], hash: auth.hashTexto || '', origem: 'web.env', criado_em: relogio(), desativado_em: null, ultimo_login: null }];
      },
    }));
    const arquivo = {
      lista: () => abrirArquivo().lista(),
      buscar: (n) => abrirArquivo().buscar(n),
      atualizar: (fn) => abrirArquivo().atualizar(fn),
    };

    // ── leitura tolerante: arquivo ilegível nunca vira "todo mundo entra" ─────
    let ultimoErroLogado = '';
    function achar(nome) {
      try { return arquivo.buscar(nome); } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        if (ultimoErroLogado !== e.message) { ultimoErroLogado = e.message; log('erro', e.message); }
        return null;
      }
    }
    const vivo = (rec) => !!rec && !rec.desativado_em;

    // ── ganchos no auth ────────────────────────────────────────────────────
    if (auth) auth.definirHorasDaSessao(() => {
      try { return protecoes.valor('sessao_horas'); } catch (e) { log('erro', `Não consegui ler sessao_horas da matriz (${e.message}); uso o prazo padrão da sessão.`); return null; }
    });
    if (auth) auth.definirFiltroDeSessao((s) => {
      if (!multiOn()) return true;
      if (s.papel === undefined) return false;       // sessão de antes do multiusuário: entra de novo
      const rec = achar(s.usuario);
      if (!vivo(rec)) return false;
      if (s.meia) return true;
      return !precisaFa2(rec) || Number.isFinite(s.fa2_em);   // 2FA passou a valer depois do login: entra de novo
    });

    // ── auditoria ──────────────────────────────────────────────────────────
    const uaDe = (req) => String((req && req.headers && req.headers['user-agent']) || '').slice(0, 120);
    const ipDe = (req) => (req ? H.ipDoPedido(req, config.proxiesConfiaveis) : null);
    function auditar(evento, dados, quem, req) {
      try {
        auditoria.registrar(evento, Object.assign({}, dados, req ? { ip: ipDe(req), ua: uaDe(req) } : {}), quem || 'desconhecido', 'web');
      } catch (e) {
        log('erro', `Não consegui gravar o evento "${evento}" na auditoria (${e.message}). A ação foi feita, mas ficou sem registro; confira a pasta da auditoria.`);
      }
    }

    // ── bloqueio por conta (além do bloqueio por IP do auth) ───────────────
    const contas = new Map(); // chave do usuário -> { falhas: [ms], trancadaAte }
    function trancadaPor(k) {
      const c = contas.get(k);
      if (!c || !c.trancadaAte) return 0;
      const resta = c.trancadaAte - relogio();
      if (resta <= 0) { c.trancadaAte = 0; return 0; }
      return Math.ceil(resta / 1000);
    }
    /** Conta uma falha. Devolve true quando esta falha trancou a conta. */
    function contaFalhou(k, req, nomeInformado) {
      const t = relogio();
      const c = contas.get(k) || { falhas: [], trancadaAte: 0 };
      c.falhas = c.falhas.filter((x) => t - x < JANELA_FALHAS_MS);
      c.falhas.push(t);
      contas.set(k, c);
      if (contas.size > 5000) for (const [kk, v] of contas) if (!v.trancadaAte && !v.falhas.some((x) => t - x < JANELA_FALHAS_MS)) contas.delete(kk);
      if (c.falhas.length >= FALHAS_MAX) {
        c.falhas = []; c.trancadaAte = t + TRANCA_MS;
        log('aviso', `Conta "${String(nomeInformado).slice(0, 40)}" trancada por ${TRANCA_MS / 60000} min depois de ${FALHAS_MAX} falhas em ${JANELA_FALHAS_MS / 60000} min (ip ${ipDe(req)}).`);
        auditar('conta_trancada', { usuario: String(nomeInformado).slice(0, 80), minutos: TRANCA_MS / 60000, falhas: FALHAS_MAX }, String(nomeInformado).slice(0, 80), req);
        return true;
      }
      return false;
    }
    const contaAcertou = (k) => contas.delete(k);

    // ── regras de acesso ───────────────────────────────────────────────────
    function agentesDeTrabalho() {
      const est = registro.estado();
      return est.ok ? est.agentes.filter((a) => a.tipo !== 'admin') : null;
    }

    /** A regra única: o TI vê tudo; o funcionário só os agentes da sua lista, nunca o Admin. */
    function podeVerAgente(sessao, slug) {
      if (!multiOn()) return true;
      if (!sessao) return false;
      if (sessao.via === 'caixa') return true;         // o agente fala por si
      const rec = achar(sessao.usuario);
      if (!vivo(rec)) return false;
      if (rec.papel === 'ti') return true;
      const ag = registro.obter(slug);
      if (!ag || ag.tipo === 'admin') return false;
      return rec.agentes.includes(slug);
    }

    const ehTI = (sessao) => { const r = sessao && sessao.via !== 'caixa' ? achar(sessao.usuario) : null; return vivo(r) && r.papel === 'ti'; };

    // ── respostas ──────────────────────────────────────────────────────────
    const erro = (res, status, msg, extra) => H.erroJson(res, status, msg, extra);
    const ok = (res, status, corpo, cab) => H.enviaJson(res, status, Object.assign({ ok: true }, corpo), cab);
    async function corpoJson(req, res) {
      try { return await H.lerJson(req, 16 * 1024); } catch (e) { erro(res, e.status || 400, e.message); return null; }
    }
    const textoCurto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

    function linkVivo(rec) {
      return !!(rec.link && rec.link.token_sha256 && rec.link.usado_em == null && Number(rec.link.expira) > relogio());
    }
    function publico(rec) {
      return {
        usuario: rec.usuario, nome: rec.nome, email: rec.email, papel: rec.papel,
        agentes: rec.papel === 'ti' ? [] : rec.agentes,
        ativo: !rec.desativado_em, desativado_em: rec.desativado_em, criado_em: rec.criado_em, ultimo_login: rec.ultimo_login,
        totp: { ativo: rec.totp.ativo, ativado_em: rec.totp.ativado_em, codigos_reserva: rec.totp.codigos_reserva.length },
        exige_2fa: exige2fa(rec), link_pendente: linkVivo(rec),
      };
    }

    // ── sessão "meia" do 2FA ───────────────────────────────────────────────
    const tentativasDeCodigo = new Map(); // id da sessão meia -> tentativas
    function criarMeia(rec, etapa, req) {
      return auth.criaSessao(rec.usuario, req, { papel: rec.papel, meia: true, etapa, horas: MEIA_MINUTOS / 60, ip: ipDe(req), ua: uaDe(req) });
    }

    function sessaoCompleta(rec, req, fa2) {
      return auth.criaSessao(rec.usuario, req, {
        papel: rec.papel, com_2fa: rec.totp.ativo, ip: ipDe(req), ua: uaDe(req),
        ...(fa2 ? { fa2_em: relogio() } : {}),
      });
    }

    function marcaLogin(nome) {
      try {
        arquivo.atualizar((d) => {
          const r = d.usuarios.find((u) => chave(u.usuario) === chave(nome));
          if (!r) return { semMudanca: true };
          r.ultimo_login = relogio();
          return null;
        });
      } catch (e) {
        log('aviso', `Não consegui gravar o último login de "${String(nome).slice(0, 40)}" (${e.message}). O login valeu; só o registro de "último acesso" ficou velho.`);
      }
    }

    /** Fecha o login: sessão completa, evento e último acesso. `via` é 'senha' ou 'senha+2fa'. */
    function concluirLogin(rec, req, via, fa2) {
      const s = sessaoCompleta(rec, req, fa2);
      marcaLogin(rec.usuario);
      auditar('login_ok', { via }, rec.usuario, req);
      log('info', `Login de ${rec.usuario} (${via}, ip ${ipDe(req)}).`);
      return s;
    }

    // ── login (gancho do server.js: postLogin) ─────────────────────────────
    function resolvedor(nome) {
      const rec = achar(nome);
      if (!vivo(rec)) return null;
      // o usuário vindo do web.env que ainda não tem hash no arquivo usa o que o primeiro acesso gravou
      const hash = rec.hash || (rec.origem === 'web.env' ? auth.hashTexto || '' : '');
      return { usuario: rec.usuario, hash };
    }

    async function login(nomeInformado, senha, ip, req) {
      if (!multiOn()) return null;
      const k = chave(nomeInformado);
      const trancadoPor = trancadaPor(k);
      if (trancadoPor) {
        return { ok: false, limite: true, retryAfter: trancadoPor, erro: `Conta trancada por excesso de tentativas. Tente de novo em ${Math.ceil(trancadoPor / 60)} min ou peça ao TI para conferir.` };
      }
      try { arquivo.lista(); } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        log('erro', e.message);
        return { ok: false, trancado: true, erro: e.message };
      }
      const r = await auth.verificaSenha(nomeInformado, senha, ip, resolvedor);
      if (!r.ok) {
        if (r.limite) {
          auditar('login_falha', { usuario: textoCurto(nomeInformado, 80), motivo: 'ip_bloqueado' }, textoCurto(nomeInformado, 80) || 'desconhecido', req);
          return r;
        }
        if (r.erro && !r.trancado) {
          const trancou = contaFalhou(k, req, nomeInformado);
          auditar('login_falha', { usuario: textoCurto(nomeInformado, 80), motivo: 'senha_ou_usuario' }, textoCurto(nomeInformado, 80) || 'desconhecido', req);
          if (trancou) return Object.assign({}, r, { limite: true, retryAfter: TRANCA_MS / 1000, erro: `Conta trancada por ${TRANCA_MS / 60000} min depois de ${FALHAS_MAX} tentativas erradas.` });
        }
        return r;
      }
      contaAcertou(k);
      const rec = achar(r.usuario);
      // guarda no arquivo o hash que veio do web.env, para a senha deixar de depender dele
      if (rec && !rec.hash && rec.origem === 'web.env' && auth.hashTexto) {
        try { arquivo.atualizar((d) => { const x = d.usuarios.find((u) => u.usuario === rec.usuario); if (x && !x.hash) { x.hash = auth.hashTexto; return null; } return { semMudanca: true }; }); } catch (e) {
          log('aviso', `Não consegui copiar o hash do web.env para o arquivo de usuários (${e.message}); o login continua valendo com o hash do web.env.`);
        }
      }
      if (rec.totp.ativo) {
        const s = criarMeia(rec, 'codigo', req);
        return { ok: true, usuario: rec.usuario, sessao: s, etapa: 'codigo', destino: '/login/2fa' };
      }
      if (exige2fa(rec)) {
        const s = criarMeia(rec, 'ativar', req);
        return { ok: true, usuario: rec.usuario, sessao: s, etapa: 'ativar', destino: '/login/2fa' };
      }
      return { ok: true, usuario: rec.usuario, sessao: concluirLogin(rec, req, 'senha', false) };
    }

    // ── conferir código (TOTP ou reserva) sob trava ────────────────────────
    /**
     * Confere o código da pessoa. TOTP vale uma vez só (ultimo_passo); código de reserva é apagado ao usar.
     * Devolve { ok, reserva?, restantes? } ou { ok:false, motivo }.
     */
    function conferirCodigo(nome, codigo, { aceitaReserva }) {
      return arquivo.atualizar((d) => {
        const rec = d.usuarios.find((u) => chave(u.usuario) === chave(nome));
        if (!rec || !rec.totp.segredo) return { semMudanca: true, ok: false, motivo: 'sem_segredo' };
        const v = totp.verificar(rec.totp.segredo, codigo, { agora: relogio(), depoisDoPasso: rec.totp.ultimo_passo });
        if (v.ok) { rec.totp.ultimo_passo = v.passo; return { ok: true }; }
        if (aceitaReserva && v.motivo === 'formato') {
          const h = sha256hex(normalizaReserva(codigo));
          const i = rec.totp.codigos_reserva.indexOf(h);
          if (i >= 0) { rec.totp.codigos_reserva.splice(i, 1); return { ok: true, reserva: true, restantes: rec.totp.codigos_reserva.length }; }
        }
        return { semMudanca: true, ok: false, motivo: v.motivo };
      });
    }

    /** Confere o código pendente de ativação e, se bater, liga o 2FA e gera os códigos de reserva (devolvidos em claro uma vez). */
    function ativarComCodigo(nome, codigo) {
      return arquivo.atualizar((d) => {
        const rec = d.usuarios.find((u) => chave(u.usuario) === chave(nome));
        if (!rec || !rec.totp.segredo || rec.totp.ativo) return { semMudanca: true, ok: false, motivo: 'sem_pendente' };
        const v = totp.verificar(rec.totp.segredo, codigo, { agora: relogio() });
        if (!v.ok) return { semMudanca: true, ok: false, motivo: v.motivo };
        const claros = Array.from({ length: CODIGOS_RESERVA }, codigoReservaNovo);
        rec.totp.ativo = true;
        rec.totp.ativado_em = relogio();
        rec.totp.ultimo_passo = v.passo;
        rec.totp.codigos_reserva = claros.map((c) => sha256hex(normalizaReserva(c)));
        return { ok: true, codigos: claros };
      });
    }

    /** O segredo pendente da pessoa (cria um se não há). */
    function segredoPendente(nome) {
      return arquivo.atualizar((d) => {
        const rec = d.usuarios.find((u) => chave(u.usuario) === chave(nome));
        if (!rec) return { semMudanca: true, ok: false };
        if (rec.totp.ativo) return { semMudanca: true, ok: false, jaAtivo: true };
        if (rec.totp.segredo) return { semMudanca: true, ok: true, segredo: rec.totp.segredo, emissor: 'DG Claw', conta: rec.usuario };
        rec.totp.segredo = totp.gerarSegredo();
        return { ok: true, segredo: rec.totp.segredo, conta: rec.usuario };
      });
    }
    const dadosDeAtivacao = (r, req) => {
      const emissor = `DG Claw (${H.hostDoPedido(req, config.proxiesConfiaveis) || 'servidor'})`;
      return { segredo: r.segredo, segredo_agrupado: totp.agrupa(r.segredo), otpauth: totp.otpauth({ segredo: r.segredo, conta: r.conta, emissor }) };
    };

    // ── rotas sem sessão completa ──────────────────────────────────────────
    async function rotaLogin2fa(req, res, url) {
      const p = url.pathname;
      const m = req.method;
      const ms = auth.sessaoDoPedido(req, { incluirMeia: true });
      if (p === '/login/2fa') {
        if (m !== 'GET' && m !== 'HEAD') { erro(res, 405, 'Abra /login/2fa com GET.'); return true; }
        if (!ms || !ms.meia) { res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); res.end(); return true; }
        if (!servirArquivo(req, res, path.join(config.publicDir, 'login-2fa.html'), 'no-store')) {
          log('erro', `A tela do segundo fator não está instalada: falta ${path.join(config.publicDir, 'login-2fa.html')}.`);
          H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela do segundo fator não foi encontrado no servidor. Reinstale o DG Claw Web.');
        }
        return true;
      }
      // /api/v1/login/2fa
      if (!ms || !ms.meia) { erro(res, 401, 'A etapa do código expirou ou não começou. Volte a /login e entre com a senha.'); return true; }
      const rec = achar(ms.usuario);
      if (!vivo(rec)) { auth.revogarSessoes(ms.usuario, { id: ms.id }); erro(res, 401, 'Este usuário não está mais ativo. Fale com o TI.'); return true; }

      if (m === 'GET') {
        const base = { etapa: ms.etapa, usuario: rec.usuario, nome: rec.nome, expira_em: ms.expira, obrigatorio: exige2fa(rec) };
        if (ms.etapa === 'ativar') {
          const r = segredoPendente(rec.usuario);
          if (!r.ok) { erro(res, 409, 'Não consegui preparar o segundo fator agora. Volte a /login e tente de novo.'); return true; }
          Object.assign(base, dadosDeAtivacao(r, req));
        }
        ok(res, 200, base);
        return true;
      }
      if (m !== 'POST') { erro(res, 405, 'Use GET para ver a etapa ou POST com {"codigo": "123456"}.'); return true; }

      const corpo = await corpoJson(req, res);
      if (!corpo) return true;
      const k = chave(rec.usuario);
      const trancadoPor = trancadaPor(k);
      if (trancadoPor) { erro(res, 429, `Conta trancada por excesso de tentativas. Tente de novo em ${Math.ceil(trancadoPor / 60)} min.`, { retryAfter: trancadoPor }); return true; }

      const falhou = (motivo, status, msg) => {
        auditar('2fa_falha', { motivo, etapa: ms.etapa }, rec.usuario, req);
        const n = (tentativasDeCodigo.get(ms.id) || 0) + 1;
        tentativasDeCodigo.set(ms.id, n);
        const trancou = contaFalhou(k, req, rec.usuario);
        if (n >= CODIGO_POR_SESSAO_MAX || trancou) {
          auth.revogarSessoes(rec.usuario, { id: ms.id });
          tentativasDeCodigo.delete(ms.id);
          erro(res, 429, `Código errado demais. Volte a /login e entre de novo${trancou ? ' (a conta ficou trancada por alguns minutos)' : ''}.`, { reiniciar: true });
        } else {
          erro(res, status, msg);
        }
        return true;
      };
      const msgs = {
        formato: 'O código tem 6 números. Confira o aplicativo e digite de novo.',
        errado: 'Código errado. Confira a hora do celular e digite o que o aplicativo mostra agora.',
        reuso: 'Este código já foi usado. Espere o aplicativo mostrar o próximo e digite de novo.',
      };

      let codigos = null; let via = 'senha+2fa'; let reservaUsada = false;
      try {
        if (ms.etapa === 'ativar') {
          const r = ativarComCodigo(rec.usuario, corpo.codigo);
          if (!r.ok) return falhou(r.motivo, 400, msgs[r.motivo] || 'Não consegui ativar o segundo fator. Recarregue a página e tente de novo.');
          codigos = r.codigos;
          auditar('2fa_ativado', { via: 'login' }, rec.usuario, req);
        } else {
          const r = conferirCodigo(rec.usuario, corpo.codigo, { aceitaReserva: true });
          if (!r.ok) return falhou(r.motivo, 400, msgs[r.motivo] || msgs.errado);
          if (r.reserva) {
            reservaUsada = true;
            auditar('codigo_reserva_usado', { restantes: r.restantes }, rec.usuario, req);
          }
        }
      } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        log('erro', `2FA de ${rec.usuario}: ${e.message}`);
        erro(res, e.status, e.message);
        return true;
      }
      contaAcertou(k);
      tentativasDeCodigo.delete(ms.id);
      auth.revogarSessoes(rec.usuario, { id: ms.id });
      const recNovo = achar(rec.usuario);
      const s = concluirLogin(recNovo, req, via, true);
      const cab = { 'Set-Cookie': s.cookie };
      const corpoResp = { destino: proximoSeguro(corpo.next) };
      if (codigos) corpoResp.codigos_reserva = codigos;
      if (reservaUsada) corpoResp.aviso = `Você usou um código de reserva. Restam ${recNovo.totp.codigos_reserva.length}; gere novos em /conta se estiverem acabando.`;
      ok(res, 200, corpoResp, cab);
      return true;
    }

    /** POST /api/primeiro-acesso com o link de um usuário (criado pelo TI ou por `dgclaw usuario link`). */
    const postsPorIp = new Map();
    async function rotaLinkDeUsuario(req, res) {
      const ip = ipDe(req);
      const t = relogio();
      const lista = (postsPorIp.get(ip) || []).filter((x) => t - x < 10 * 60 * 1000);
      lista.push(t); postsPorIp.set(ip, lista);
      if (postsPorIp.size > 5000) for (const [k, v] of postsPorIp) if (!v.some((x) => t - x < 600000)) postsPorIp.delete(k);

      let bufCorpo;
      try { bufCorpo = await H.lerCorpo(req, 16 * 1024); } catch (e) { erro(res, e.status || 400, 'Não entendi o pedido. Recarregue a página e tente de novo.'); return true; }
      let corpo;
      try { corpo = JSON.parse(bufCorpo.toString('utf8') || '{}'); } catch (_) { erro(res, 400, 'Não entendi o pedido. Recarregue a página e tente de novo.'); return true; }
      if (!corpo || typeof corpo !== 'object') corpo = {};
      const { token, senha, confirmacao } = corpo;
      if (typeof token !== 'string' || !RX_TOKEN.test(token)) return reenviarAoOriginal(req, res, bufCorpo);
      let rec;
      try { rec = arquivo.lista().find((u) => u.link && u.link.token_sha256 === sha256hex(token)) || null; } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        erro(res, e.status, e.message); return true;
      }
      if (!rec) return reenviarAoOriginal(req, res, bufCorpo);
      if (lista.length > 10) { H.erroJson(res, 429, 'Muitas tentativas. Tente de novo em alguns minutos.', { retryAfter: 600 }, { 'Retry-After': '600' }); return true; }
      if (rec.desativado_em) { erro(res, 403, 'Este usuário foi desativado. Fale com o TI.'); return true; }
      if (rec.link.usado_em != null) { erro(res, 410, 'Este link já foi usado. Peça ao TI um link novo.'); return true; }
      if (!(Number(rec.link.expira) > relogio())) { erro(res, 410, 'Este link expirou. Peça ao TI um link novo.'); return true; }
      const ruim = motivoSenhaInvalida(senha, confirmacao);
      if (ruim) { erro(res, 400, ruim); return true; }
      let hash;
      try { hash = await auth.gerarHash(senha); } catch (e) {
        if (e.ocupado) { erro(res, 429, e.message, { retryAfter: 2 }); return true; }
        log('erro', `Link de senha de ${rec.usuario}: falha ao gerar o hash (${e.message}).`);
        erro(res, 500, 'Não consegui processar a senha agora. Tente de novo em instantes.');
        return true;
      }
      try {
        const r = arquivo.atualizar((d) => {
          const x = d.usuarios.find((u) => u.usuario === rec.usuario);
          if (!x || !x.link || x.link.token_sha256 !== sha256hex(token) || x.link.usado_em != null) return { semMudanca: true, usado: true };
          x.hash = hash;
          x.link = Object.assign({}, x.link, { usado_em: relogio() });
          return { usado: false };
        });
        if (r.usado) { erro(res, 410, 'Este link já foi usado. Peça ao TI um link novo.'); return true; }
      } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        log('erro', `Link de senha de ${rec.usuario}: não gravei a senha (${e.message}).`);
        erro(res, e.status, e.message); return true;
      }
      auth.revogarSessoes(rec.usuario);
      auditar('senha_trocada', { via: 'link' }, rec.usuario, req);
      log('info', `Senha definida pelo link de ${rec.usuario} (ip ${ip}).`);
      ok(res, 200, { destino: '/login', mensagem: 'Senha cadastrada. Entre com ela.' }, { 'Cache-Control': 'no-store' });
      return true;
    }
    // O token não é de nenhum usuário: o primeiro acesso de sempre (web.env) responde. O corpo já foi lido,
    // então fica em req.corpoJaLido (o server.js usa esse texto em vez de ler o fluxo de novo).
    function reenviarAoOriginal(req, res, buf) {
      req.corpoJaLido = buf;
      return false;
    }

    // ── rotas com sessão ───────────────────────────────────────────────────
    async function rotaEu(req, res, url, sessao) {
      const p = url.pathname;
      const m = req.method;
      const rec = achar(sessao.usuario);
      if (!vivo(rec)) { erro(res, 401, 'Sua conta não está mais ativa. Entre de novo ou fale com o TI.'); return true; }
      const resto = p.slice('/api/v1/eu'.length);

      if (resto === '') {
        if (m !== 'GET') { erro(res, 405, 'Use GET.'); return true; }
        ok(res, 200, Object.assign(publico(rec), {
          sessao_id: sessao.id, fa2_em: sessao.fa2_em || null, pode_desativar_2fa: !exige2fa(rec),
          nivel_2fa: nivel2fa(), multiusuario: true, sessao_expira: sessao.expira,
        }));
        return true;
      }

      if (resto === '/reautenticar') {
        if (m !== 'POST') { erro(res, 405, 'Use POST com {"codigo": "123456"}.'); return true; }
        const corpo = await corpoJson(req, res); if (!corpo) return true;
        if (!rec.totp.ativo) { erro(res, 409, 'Você ainda não ativou o segundo fator. Ative em /conta antes de confirmar uma ação perigosa.'); return true; }
        const k = chave(rec.usuario);
        const t = trancadaPor(k);
        if (t) { erro(res, 429, `Conta trancada por excesso de tentativas. Tente de novo em ${Math.ceil(t / 60)} min.`, { retryAfter: t }); return true; }
        const r = conferirCodigo(rec.usuario, corpo.codigo, { aceitaReserva: false });
        if (!r.ok) {
          auditar('2fa_falha', { motivo: r.motivo, etapa: 'reautenticar' }, rec.usuario, req);
          contaFalhou(k, req, rec.usuario);
          erro(res, 400, r.motivo === 'reuso' ? 'Este código já foi usado. Espere o próximo e tente de novo.' : 'Código errado. Digite o que o aplicativo mostra agora.');
          return true;
        }
        contaAcertou(k);
        const agora = relogio();
        auth.atualizaSessao(sessao.id, { fa2_em: agora, com_2fa: true });
        auditar('reautenticado', {}, rec.usuario, req);
        ok(res, 200, { fa2_em: agora });
        return true;
      }

      if (resto === '/senha') {
        if (m !== 'POST') { erro(res, 405, 'Use POST com senha_atual, senha_nova e confirmacao.'); return true; }
        const corpo = await corpoJson(req, res); if (!corpo) return true;
        const k = chave(rec.usuario);
        const t = trancadaPor(k);
        if (t) { erro(res, 429, `Conta trancada por excesso de tentativas. Tente de novo em ${Math.ceil(t / 60)} min.`, { retryAfter: t }); return true; }
        const v = await auth.verificaSenha(rec.usuario, String(corpo.senha_atual == null ? '' : corpo.senha_atual), null, resolvedor);
        if (!v.ok) {
          if (v.limite) { erro(res, 429, v.erro, { retryAfter: v.retryAfter }); return true; }
          contaFalhou(k, req, rec.usuario);
          auditar('login_falha', { motivo: 'senha_atual_errada_ao_trocar' }, rec.usuario, req);
          erro(res, 403, 'A senha atual não confere.');
          return true;
        }
        const ruim = motivoSenhaInvalida(corpo.senha_nova, corpo.confirmacao);
        if (ruim) { erro(res, 400, ruim); return true; }
        let hash;
        try { hash = await auth.gerarHash(corpo.senha_nova); } catch (e) {
          if (e.ocupado) { erro(res, 429, e.message, { retryAfter: 2 }); return true; }
          log('erro', `Troca de senha de ${rec.usuario}: falha ao gerar o hash (${e.message}).`);
          erro(res, 500, 'Não consegui processar a senha agora. Tente de novo em instantes.');
          return true;
        }
        arquivo.atualizar((d) => { d.usuarios.find((u) => chave(u.usuario) === chave(rec.usuario)).hash = hash; return null; });
        const fora = auth.revogarSessoes(rec.usuario, { exceto: sessao.id });
        auditar('senha_trocada', { via: 'conta', sessoes_encerradas: fora }, rec.usuario, req);
        ok(res, 200, { sessoes_encerradas: fora });
        return true;
      }

      if (resto === '/sessoes' || resto.startsWith('/sessoes/')) {
        const id = resto.slice('/sessoes/'.length);
        if (resto === '/sessoes' && m === 'GET') {
          ok(res, 200, { sessoes: auth.listarSessoes(rec.usuario).map((s) => Object.assign({ atual: s.id === sessao.id }, s)) });
          return true;
        }
        if (m !== 'DELETE') { erro(res, 405, 'Use GET para listar e DELETE para sair das sessões.'); return true; }
        if (resto === '/sessoes') {
          const manter = url.searchParams.get('manter_atual') === '1';
          const n = auth.revogarSessoes(rec.usuario, manter ? { exceto: sessao.id } : {});
          auditar('sessao_revogada', { alvo: rec.usuario, quantas: n, todas: true }, rec.usuario, req);
          ok(res, 200, { encerradas: n, inclui_a_atual: !manter });
          return true;
        }
        if (!RX_ID_SESSAO.test(id)) { erro(res, 400, 'O id da sessão tem 16 caracteres (veja GET /api/v1/eu/sessoes).'); return true; }
        const n = auth.revogarSessoes(rec.usuario, { id });
        if (!n) { erro(res, 404, 'Não achei essa sessão entre as suas. Atualize a lista.'); return true; }
        auditar('sessao_revogada', { alvo: rec.usuario, quantas: 1, id }, rec.usuario, req);
        ok(res, 200, { encerradas: n, inclui_a_atual: id === sessao.id });
        return true;
      }

      if (resto === '/2fa/iniciar' || resto === '/2fa/ativar' || resto === '/2fa/desativar') {
        if (m !== 'POST') { erro(res, 405, 'Use POST.'); return true; }
        const corpo = await corpoJson(req, res); if (!corpo) return true;
        if (resto === '/2fa/iniciar') {
          const r = segredoPendente(rec.usuario);
          if (r.jaAtivo) { erro(res, 409, 'O segundo fator já está ativo. Desative antes de gerar outro segredo.'); return true; }
          if (!r.ok) { erro(res, 500, 'Não consegui preparar o segundo fator.'); return true; }
          ok(res, 200, dadosDeAtivacao(r, req));
          return true;
        }
        if (resto === '/2fa/ativar') {
          const k = chave(rec.usuario);
          const r = ativarComCodigo(rec.usuario, corpo.codigo);
          if (!r.ok) {
            if (r.motivo === 'sem_pendente') { erro(res, 409, rec.totp.ativo ? 'O segundo fator já está ativo.' : 'Comece por POST /api/v1/eu/2fa/iniciar para receber o segredo.'); return true; }
            auditar('2fa_falha', { motivo: r.motivo, etapa: 'ativar' }, rec.usuario, req);
            contaFalhou(k, req, rec.usuario);
            erro(res, 400, r.motivo === 'formato' ? 'O código tem 6 números.' : 'Código errado. Confira a hora do celular e digite o que o aplicativo mostra agora.');
            return true;
          }
          auth.atualizaSessao(sessao.id, { com_2fa: true, fa2_em: relogio() });
          auditar('2fa_ativado', { via: 'conta' }, rec.usuario, req);
          ok(res, 200, { codigos_reserva: r.codigos, aviso: 'Guarde estes códigos em lugar seguro: eles não aparecem de novo. Cada um vale uma vez.' });
          return true;
        }
        // desativar
        if (!rec.totp.ativo) { erro(res, 409, 'O segundo fator não está ativo.'); return true; }
        if (exige2fa(rec)) { erro(res, 403, `Neste nível de proteção o segundo fator é obrigatório para o seu perfil (2fa = ${nivel2fa()}). Só o administrador do servidor muda isso.`); return true; }
        const k = chave(rec.usuario);
        const v = await auth.verificaSenha(rec.usuario, String(corpo.senha == null ? '' : corpo.senha), null, resolvedor);
        if (!v.ok) { if (!v.limite) contaFalhou(k, req, rec.usuario); erro(res, v.limite ? 429 : 403, v.limite ? v.erro : 'A senha não confere.'); return true; }
        const c = conferirCodigo(rec.usuario, corpo.codigo, { aceitaReserva: false });
        if (!c.ok) { auditar('2fa_falha', { motivo: c.motivo, etapa: 'desativar' }, rec.usuario, req); contaFalhou(k, req, rec.usuario); erro(res, 400, 'Código errado. Digite o que o aplicativo mostra agora.'); return true; }
        arquivo.atualizar((d) => {
          const x = d.usuarios.find((u) => chave(u.usuario) === chave(rec.usuario));
          x.totp = { segredo: '', ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null };
          return null;
        });
        auth.atualizaSessao(sessao.id, { com_2fa: false });
        auditar('2fa_desativado', { por: rec.usuario }, rec.usuario, req);
        ok(res, 200, {});
        return true;
      }
      erro(res, 404, `Não existe ${m} ${p}. As rotas de conta são /api/v1/eu, /reautenticar, /senha, /sessoes e /2fa/(iniciar|ativar|desativar).`);
      return true;
    }

    // ── administração (só TI) ──────────────────────────────────────────────
    function validaAgentes(lista) {
      if (lista === undefined) return { ok: true, valor: undefined };
      if (!Array.isArray(lista) || lista.some((s) => typeof s !== 'string')) return { ok: false, erro: '"agentes" precisa ser uma lista de ids de agente, como ["luna","marina"].' };
      const existem = agentesDeTrabalho();
      if (!existem) return { ok: false, status: 503, erro: registro.estado().erro };
      const slugs = existem.map((a) => a.slug);
      const unicos = [...new Set(lista.map((s) => s.trim()))];
      const falsos = unicos.filter((s) => !slugs.includes(s));
      if (falsos.length) return { ok: false, erro: `Não existe agente de trabalho com o id ${falsos.map((s) => `"${s.slice(0, 40)}"`).join(', ')}. Ids que existem: ${slugs.join(', ') || '(nenhum)'}. O Admin não pode ser dado a um funcionário.` };
      return { ok: true, valor: unicos };
    }

    function gerarLink(rec, req) {
      const token = crypto.randomBytes(32).toString('base64url');
      const criado = relogio();
      rec.link = { token_sha256: sha256hex(token), criado, expira: criado + LINK_MS, usado_em: null };
      return { url: `${H.origemPropria(req, config.proxiesConfiaveis)}/primeiro-acesso#${token}`, expira_em: rec.link.expira };
    }

    const ativosTI = (d) => d.usuarios.filter((u) => u.papel === 'ti' && !u.desativado_em);

    async function rotaUsuarios(req, res, url, sessao) {
      const p = url.pathname;
      const m = req.method;
      const quem = sessao.usuario;
      const resto = p.slice('/api/v1/usuarios'.length).replace(/\/+$/, '');

      if (resto === '') {
        if (m === 'GET') {
          const ag = agentesDeTrabalho();
          ok(res, 200, {
            usuarios: arquivo.lista().map(publico),
            agentes_disponiveis: ag ? ag.map((a) => ({ id: a.slug, nome: a.nome })) : [],
            nivel_2fa: nivel2fa(),
          });
          return true;
        }
        if (m !== 'POST') { erro(res, 405, 'Use GET para listar ou POST para criar um usuário.'); return true; }
        const corpo = await corpoJson(req, res); if (!corpo) return true;
        const usuario = chave(corpo.usuario);
        if (!RX_USUARIO.test(usuario)) { erro(res, 400, 'O usuário precisa ter de 2 a 64 caracteres, começar com letra ou número e usar só letras minúsculas, números, ponto, traço, sublinhado e @. Exemplo: ana.silva'); return true; }
        if (!PAPEIS.includes(corpo.papel)) { erro(res, 400, `O papel é "ti" ou "funcionario" (veio ${JSON.stringify(corpo.papel === undefined ? null : String(corpo.papel).slice(0, 20))}).`); return true; }
        const email = textoCurto(corpo.email, 120);
        if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) { erro(res, 400, 'O e-mail não parece certo. Exemplo: ana@empresa.com.br'); return true; }
        const ag = validaAgentes(corpo.agentes === undefined ? [] : corpo.agentes);
        if (!ag.ok) { erro(res, ag.status || 400, ag.erro); return true; }
        let criado; let link;
        try {
          arquivo.atualizar((d) => {
            if (d.usuarios.some((u) => chave(u.usuario) === usuario)) throw Object.assign(new ErroUsuarios(`Já existe o usuário "${usuario}". Use PATCH /api/v1/usuarios/${usuario} para mudar.`, 409));
            criado = {
              usuario, nome: textoCurto(corpo.nome, 80) || usuario, email, papel: corpo.papel, agentes: corpo.papel === 'ti' ? [] : ag.valor,
              hash: '', totp: { segredo: '', ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null },
              origem: 'painel', criado_em: relogio(), desativado_em: null, ultimo_login: null,
            };
            link = gerarLink(criado, req);
            d.usuarios.push(criado);
            return null;
          });
        } catch (e) {
          if (!(e instanceof ErroUsuarios)) throw e;
          erro(res, e.status, e.message); return true;
        }
        auditar('usuario_criado', { usuario, papel: criado.papel, agentes: criado.agentes }, quem, req);
        ok(res, 201, { usuario: publico(criado), link: link.url, link_expira_em: link.expira_em, aviso: 'Mande o link à pessoa por um canal seguro. Ele vale uma vez e não aparece de novo.' });
        return true;
      }

      const mm = /^\/([^/]+)(?:\/(sessoes|link|zerar-2fa))?$/.exec(resto);
      if (!mm) { erro(res, 404, `Não existe ${m} ${p}.`); return true; }
      let alvoNome;
      try { alvoNome = decodeURIComponent(mm[1]); } catch (_) { erro(res, 400, 'O nome do usuário na URL está malformado.'); return true; }
      const alvo = achar(alvoNome);
      if (!alvo) { erro(res, 404, `Não existe o usuário "${alvoNome.slice(0, 40)}". Veja GET /api/v1/usuarios.`); return true; }
      const sub = mm[2] || '';

      if (sub === 'sessoes') {
        if (m === 'GET') { ok(res, 200, { usuario: alvo.usuario, sessoes: auth.listarSessoes(alvo.usuario) }); return true; }
        if (m !== 'DELETE') { erro(res, 405, 'Use GET para listar ou DELETE para revogar (?id=<sessão> revoga uma só).'); return true; }
        const id = url.searchParams.get('id');
        if (id && !RX_ID_SESSAO.test(id)) { erro(res, 400, 'O id da sessão tem 16 caracteres (veja GET .../sessoes).'); return true; }
        const n = auth.revogarSessoes(alvo.usuario, id ? { id } : {});
        if (id && !n) { erro(res, 404, 'Não achei essa sessão nesse usuário. Atualize a lista.'); return true; }
        auditar('sessao_revogada', { alvo: alvo.usuario, quantas: n, id: id || null, por: quem }, quem, req);
        ok(res, 200, { encerradas: n });
        return true;
      }

      if (sub === 'link') {
        if (m !== 'POST') { erro(res, 405, 'Use POST para gerar um link novo de senha.'); return true; }
        if (alvo.desativado_em) { erro(res, 409, `O usuário "${alvo.usuario}" está desativado. Reative com PATCH {"ativo": true} antes.`); return true; }
        let link;
        arquivo.atualizar((d) => { link = gerarLink(d.usuarios.find((u) => u.usuario === alvo.usuario), req); return null; });
        auditar('usuario_alterado', { usuario: alvo.usuario, acao: 'link_de_senha' }, quem, req);
        ok(res, 200, { link: link.url, link_expira_em: link.expira_em, aviso: 'O link vale uma vez e o anterior deixou de valer.' });
        return true;
      }

      if (sub === 'zerar-2fa') {
        if (m !== 'POST') { erro(res, 405, 'Use POST para zerar o segundo fator.'); return true; }
        arquivo.atualizar((d) => { d.usuarios.find((u) => u.usuario === alvo.usuario).totp = { segredo: '', ativo: false, ativado_em: null, codigos_reserva: [], ultimo_passo: null }; return null; });
        const n = auth.revogarSessoes(alvo.usuario);
        auditar('2fa_desativado', { usuario: alvo.usuario, por: quem, motivo: 'zerado pelo TI', sessoes_encerradas: n }, quem, req);
        ok(res, 200, { sessoes_encerradas: n });
        return true;
      }

      // /api/v1/usuarios/<usuario>
      if (m === 'GET') { ok(res, 200, { usuario: publico(alvo) }); return true; }

      if (m === 'DELETE' || m === 'PATCH') {
        const corpo = m === 'PATCH' ? await corpoJson(req, res) : {};
        if (!corpo) return true;
        const mudancas = {};
        const falha = (status, msg) => { erro(res, status, msg); return true; };
        if (m === 'PATCH') {
          const permitidos = ['nome', 'email', 'papel', 'agentes', 'ativo'];
          const sobra = Object.keys(corpo).filter((c) => !permitidos.includes(c));
          if (sobra.length) return falha(400, `Campo(s) que não mudam por aqui: ${sobra.join(', ')}. Aceito: ${permitidos.join(', ')}. Para senha e 2FA use as rotas /link e /zerar-2fa.`);
          if (!Object.keys(corpo).length) return falha(400, `Mande ao menos um campo para mudar: ${permitidos.join(', ')}.`);
          if (corpo.papel !== undefined && !PAPEIS.includes(corpo.papel)) return falha(400, 'O papel é "ti" ou "funcionario".');
          if (corpo.email !== undefined && textoCurto(corpo.email, 120) && !/^[^@\s]+@[^@\s]+$/.test(textoCurto(corpo.email, 120))) return falha(400, 'O e-mail não parece certo. Exemplo: ana@empresa.com.br');
          if (corpo.ativo !== undefined && typeof corpo.ativo !== 'boolean') return falha(400, '"ativo" é true ou false.');
        }
        const ag = m === 'PATCH' ? validaAgentes(corpo.agentes) : { ok: true };
        if (!ag.ok) return falha(ag.status || 400, ag.erro);
        let desativou = false; let jaEstava = false;
        try {
          arquivo.atualizar((d) => {
            const x = d.usuarios.find((u) => u.usuario === alvo.usuario);
            const querDesativar = m === 'DELETE' || corpo.ativo === false;
            const novoPapel = m === 'PATCH' && corpo.papel !== undefined ? corpo.papel : x.papel;
            if (querDesativar && x.desativado_em) { jaEstava = true; return { semMudanca: true }; }
            if (querDesativar && x.usuario === quem) throw new ErroUsuarios('Você não pode desativar a si mesmo. Peça a outro usuário TI.', 409);
            const ultimoTI = x.papel === 'ti' && !x.desativado_em && ativosTI(d).length === 1;
            if (ultimoTI && (querDesativar || novoPapel !== 'ti')) throw new ErroUsuarios(`"${x.usuario}" é o único usuário TI ativo. Crie ou promova outro TI antes de tirar este.`, 409);
            if (querDesativar) { x.desativado_em = relogio(); desativou = true; mudancas.ativo = { de: true, para: false }; return null; }
            if (m !== 'PATCH') return { semMudanca: true };
            if (corpo.ativo === true && x.desativado_em) { x.desativado_em = null; mudancas.ativo = { de: false, para: true }; }
            if (corpo.nome !== undefined && textoCurto(corpo.nome, 80) && textoCurto(corpo.nome, 80) !== x.nome) { mudancas.nome = { de: x.nome, para: textoCurto(corpo.nome, 80) }; x.nome = textoCurto(corpo.nome, 80); }
            if (corpo.email !== undefined && textoCurto(corpo.email, 120) !== x.email) { mudancas.email = { de: x.email, para: textoCurto(corpo.email, 120) }; x.email = textoCurto(corpo.email, 120); }
            if (novoPapel !== x.papel) { mudancas.papel = { de: x.papel, para: novoPapel }; x.papel = novoPapel; }
            const novosAgentes = novoPapel === 'ti' ? [] : (ag.valor !== undefined ? ag.valor : x.agentes);
            if (JSON.stringify(novosAgentes) !== JSON.stringify(x.agentes)) { mudancas.agentes = { de: x.agentes, para: novosAgentes }; x.agentes = novosAgentes; }
            if (!Object.keys(mudancas).length) return { semMudanca: true };
            return null;
          });
        } catch (e) {
          if (!(e instanceof ErroUsuarios)) throw e;
          return falha(e.status, e.message);
        }
        if (desativou) {
          const n = auth.revogarSessoes(alvo.usuario);
          auditar('usuario_desativado', { usuario: alvo.usuario, sessoes_encerradas: n }, quem, req);
        } else if (Object.keys(mudancas).length) {
          auditar('usuario_alterado', { usuario: alvo.usuario, mudancas }, quem, req);
        }
        ok(res, 200, { usuario: publico(achar(alvo.usuario)), ja_estava: jaEstava, mudou: desativou || Object.keys(mudancas).length > 0 });
        return true;
      }
      erro(res, 405, 'Use GET, PATCH ou DELETE em /api/v1/usuarios/<usuario>.');
      return true;
    }

    // ── recusas por papel ──────────────────────────────────────────────────
    const SO_TI = [
      { rx: /^\/(?:api\/v1\/)?avisos(?:\/|$)/, nome: 'o quadro de avisos entre agentes' },
      { rx: /^\/api\/v1\/push(?:\/|$)/, nome: 'os avisos no aparelho' },
      { rx: /^\/api\/v1\/onboarding(?:\/|$)/, nome: 'a criação de agentes' },
      { rx: /^\/(?:api\/v1\/)?protecoes(?:\/|$)/, nome: 'a tela de proteções' },
    ];
    function negaAcesso(req, res, url, sessao, recurso, motivo) {
      auditar('acesso_negado', { recurso: String(recurso).slice(0, 160), metodo: req.method }, sessao.usuario, req);
      if (url.pathname.startsWith('/api/')) erro(res, 403, motivo);
      else H.paginaErro(res, 403, 'Sem acesso', motivo);
      return true;
    }

    return {
      podeVerAgente,
      login,
      aoNegar(req, sessao, recurso) {
        if (!multiOn() || !sessao || sessao.via === 'caixa') return;
        auditar('acesso_negado', { recurso: String(recurso).slice(0, 160), metodo: req.method }, sessao.usuario, req);
      },
      aoSair(req, sessao) {
        if (!multiOn() || !sessao || sessao.via === 'caixa') return;
        auditar('logout', {}, sessao.usuario, req);
      },

      async antesDaSessao(req, res, url) {
        if (!multiOn()) return false;
        const p = url.pathname;
        try {
          if (p === '/login/2fa' || p === '/api/v1/login/2fa') return await rotaLogin2fa(req, res, url);
          if (p === '/api/primeiro-acesso' && req.method === 'POST') return await rotaLinkDeUsuario(req, res);
        } catch (e) {
          if (e instanceof ErroUsuarios) { log('erro', e.message); erro(res, e.status, e.message); return true; }
          throw e;
        }
        return false;
      },

      async antes(req, res, url, sessao) {
        if (!multiOn()) return false;
        const p = url.pathname;
        const ehUsuarios = p === '/api/v1/usuarios' || p.startsWith('/api/v1/usuarios/');
        const ehEu = p === '/api/v1/eu' || p.startsWith('/api/v1/eu/');
        const ehPagina = (p === '/usuarios' || p === '/usuarios/' || p === '/conta' || p === '/conta/') && (req.method === 'GET' || req.method === 'HEAD');
        if (!sessao) {
          // sem sessão, as rotas daqui seguem para o 401 de sempre (API) ou o redirecionamento ao login (página)
          if (ehPagina) { semSessaoPagina(req, res, url); return true; }
          return false;
        }
        if (sessao.via === 'caixa') {
          if (ehUsuarios || ehEu) { erro(res, 403, 'As rotas de usuário não são liberadas para agentes.'); return true; }
          return false;
        }
        try {
          const rec = achar(sessao.usuario);
          if (!vivo(rec)) return false;   // o filtro de sessão já recusou; nada a fazer aqui

          if (ehEu) return await rotaEu(req, res, url, sessao);
          if (ehUsuarios) {
            if (rec.papel !== 'ti') return negaAcesso(req, res, url, sessao, p, 'A administração de usuários é só do TI. Peça a alguém do TI para ajustar o que você precisa.');
            return await rotaUsuarios(req, res, url, sessao);
          }
          if (ehPagina) {
            const conta = p.startsWith('/conta');
            if (!conta && rec.papel !== 'ti') return negaAcesso(req, res, url, sessao, p, 'A tela de usuários é só do TI.');
            const nomeArq = conta ? 'conta.html' : 'usuarios.html';
            if (!servirArquivo(req, res, path.join(config.publicDir, nomeArq), 'no-store')) {
              log('erro', `A tela ${nomeArq} não está instalada: falta ${path.join(config.publicDir, nomeArq)}.`);
              H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela não foi encontrado no servidor. Reinstale o DG Claw Web.');
            }
            return true;
          }
          if (rec.papel !== 'ti') {
            for (const r of SO_TI) {
              if (r.rx.test(p)) return negaAcesso(req, res, url, sessao, p, `Seu perfil (funcionário) não usa ${r.nome}. Peça ao TI se precisar.`);
            }
          }
        } catch (e) {
          if (e instanceof ErroUsuarios) { log('erro', e.message); erro(res, e.status, e.message); return true; }
          throw e;
        }
        return false;
      },
    };
  },
};
