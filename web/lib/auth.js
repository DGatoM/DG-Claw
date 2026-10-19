'use strict';
// Autenticação do Web: verificação de senha (scrypt), sessões em cookie e limite de tentativas.
// Interface pequena de propósito: verificaSenha, criaSessao, sessaoDoPedido, encerra.
// Enterprise (multiusuário, web/lib/ent/usuarios.js): verificaSenha aceita um resolvedor de usuário, criaSessao
// aceita campos extras (papel, fa2_em, sessão "meia" do 2FA) e há listagem/revogação de sessões por usuário.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseCookies, ipDoPedido, esquemaDoPedido } = require('./http');

const NOME_COOKIE = 'dgclaw_sessao';
// Enterprise (https_endurecido): com HTTPS o cookie ganha o prefixo __Host-, que o navegador só aceita com Secure, Path=/ e sem Domain.
const NOME_COOKIE_HOST = '__Host-dgclaw_sessao';
const MAX_N = 2 ** 20;
const TENTATIVAS_MAX = 5;
const JANELA_MS = 15 * 60 * 1000;
const MAX_SESSOES = 200;
// scrypt com N alto pode usar centenas de MB por chamada: no máximo 2 contas ao mesmo tempo,
// para uma enxurrada de POST /login não derrubar a máquina por falta de memória.
const SCRYPT_SIMULTANEOS = 2;
const SCRYPT_NOVO = { N: 16384, r: 8, p: 1 }; // igual ao panel/lib/auth.js

const sha256 = (v) => crypto.createHash('sha256').update(v).digest();
const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');

function comparaTempoConstante(a, b) {
  // sha256 dos dois lados dá sempre 32 bytes: a comparação não depende do tamanho do texto
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

const idDe = (token) => sha256hex(token).slice(0, 16);

function b64urlParaBuffer(s) { return Buffer.from(String(s), 'base64url'); }

// Campos que o multiusuário acrescenta à sessão; no nível pessoal nenhum deles existe.
const CAMPOS_EXTRAS = ['papel', 'fa2_em', 'com_2fa', 'meia', 'etapa', 'ip', 'ua', 'ultimo_uso', 'via'];
const GRAVA_USO_A_CADA_MS = 60 * 1000;

/** Lê "scrypt$N$r$p$sal$hash". Devolve { N, r, p, sal, hash } ou { erro }. */
function parseHash(texto) {
  if (!texto) return { erro: 'não há hash de senha configurado' };
  const partes = String(texto).trim().split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return { erro: 'o hash não está no formato scrypt$N$r$p$sal$hash' };
  const N = Number(partes[1]); const r = Number(partes[2]); const p = Number(partes[3]);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return { erro: 'o N do hash precisa ser uma potência de 2' };
  if (N > MAX_N) return { erro: `o N do hash (${N}) passa do limite aceito (${MAX_N})` };
  if (!Number.isInteger(r) || r < 1 || r > 32) return { erro: 'o r do hash precisa estar entre 1 e 32' };
  if (!Number.isInteger(p) || p < 1 || p > 16) return { erro: 'o p do hash precisa estar entre 1 e 16' };
  const sal = b64urlParaBuffer(partes[4]);
  const hash = b64urlParaBuffer(partes[5]);
  if (sal.length < 8) return { erro: 'o sal do hash é curto demais' };
  if (hash.length < 16 || hash.length > 128) return { erro: 'o tamanho do hash esperado é inválido' };
  return { N, r, p, sal, hash };
}

function scrypt(senha, h) {
  return new Promise((resolve, reject) => {
    const maxmem = 128 * h.r * (h.N + h.p + 2) * 2 + (1 << 20);
    crypto.scrypt(String(senha).normalize('NFKC'), h.sal, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

/**
 * Cria o módulo de autenticação.
 * config: { env, dataDir, sessaoDias, proxiesConfiaveis }; log; agora (relógio injetável).
 */
function criarAuth({ config, log, agora }) {
  const relogio = agora || (() => Date.now());
  const usuario = String(config.env.DGCLAW_PANEL_USER || '').trim();
  const hashInicial = String(config.env.DGCLAW_PANEL_PASSWORD_HASH || '').trim();
  // "sem senha ainda": o usuário existe e o hash está vazio (instalação sem senha, esperando o primeiro acesso).
  let semSenha = !!usuario && !hashInicial;
  let hashTexto = hashInicial;
  let parsed = parseHash(hashInicial);
  // Ganchos do enterprise; sem eles (nível pessoal) nada muda.
  let horasDaSessao = null;   // () => número de horas, ou null para usar config.sessaoDias
  let sessaoValida = null;    // (sessao crua) => boolean
  let cookieEndurecido = null; // () => boolean (enterprise: cookie com prefixo __Host-)
  // hash falso para gastar o scrypt quando o usuário não existe (o tempo não pode revelar quem existe)
  const hashFalso = Object.assign({}, SCRYPT_NOVO, { sal: crypto.randomBytes(16), hash: crypto.randomBytes(32) });
  let trancado = !usuario || !!parsed.erro;
  let motivoTrancado = null;
  function calculaMotivo() {
    if (!trancado) return null;
    if (!usuario) return 'Falta o usuário do painel (DGCLAW_PANEL_USER).';
    if (semSenha) return 'Ainda não há senha cadastrada. Use o link de primeiro acesso.';
    return `O hash da senha não vale: ${parsed.erro}.`;
  }
  if (trancado) {
    motivoTrancado = calculaMotivo();
    if (semSenha) {
      log('info', 'Painel sem senha ainda: aguardando o primeiro acesso pelo link (sudo dgclaw primeiro-acesso gera outro).');
    } else {
      log('aviso', `Login TRANCADO: ${motivoTrancado} Rode o gerador de hash do instalador e coloque DGCLAW_PANEL_USER e DGCLAW_PANEL_PASSWORD_HASH no web.env. Ninguém consegue entrar até lá.`);
    }
  }

  // ── sessões (no disco só o sha256 do token) ──────────────────────────────
  const arquivo = path.join(config.dataDir, 'sessoes.json');
  let sessoes = new Map(); // sha256hex -> { usuario, criada, expira }
  function carrega() {
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      for (const [k, v] of Object.entries(j.sessoes || {})) if (v && v.expira > relogio()) sessoes.set(k, v);
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Não li as sessões salvas em ${arquivo} (${e.code || e.message}). Começo sem sessões; quem estava logado precisa entrar de novo.`);
    }
  }
  let ultimaGravacaoUso = 0;
  function salva() {
    ultimaGravacaoUso = relogio();
    try {
      const tmp = `${arquivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ versao: 1, sessoes: Object.fromEntries(sessoes) }), { mode: 0o600 });
      fs.renameSync(tmp, arquivo);
    } catch (e) {
      log('erro', `Não consegui gravar as sessões em ${arquivo} (${e.code || e.message}). O login continua valendo até o próximo restart; confira a permissão de ${config.dataDir}.`);
    }
  }
  function limpaExpiradas() {
    const t = relogio();
    for (const [k, v] of sessoes) if (v.expira <= t) sessoes.delete(k);
    while (sessoes.size > MAX_SESSOES) sessoes.delete(sessoes.keys().next().value);
  }
  carrega();

  // ── limite de tentativas por IP ──────────────────────────────────────────
  const falhas = new Map(); // ip -> [timestamps]
  let scryptEmCurso = 0;
  function janela(ip) {
    const t = relogio();
    const lista = (falhas.get(ip) || []).filter((x) => t - x < JANELA_MS);
    if (lista.length) falhas.set(ip, lista); else falhas.delete(ip);
    return lista;
  }
  /** Devolve { bloqueado, retryAfter } (segundos) para o IP. */
  function bloqueio(ip) {
    const lista = janela(ip);
    if (lista.length < TENTATIVAS_MAX) return { bloqueado: false, retryAfter: 0 };
    return { bloqueado: true, retryAfter: Math.max(1, Math.ceil((lista[0] + JANELA_MS - relogio()) / 1000)) };
  }

  return {
    get trancado() { return trancado; },
    get motivoTrancado() { return motivoTrancado; },
    get semSenha() { return semSenha; },
    get usuario() { return usuario; },
    NOME_COOKIE,
    bloqueio,

    /** Troca o hash em memória e destranca. Devolve { ok } ou { ok:false, erro }. */
    definirHash(texto) {
      const novo = parseHash(texto);
      if (novo.erro) return { ok: false, erro: novo.erro };
      parsed = novo; trancado = false; motivoTrancado = null; semSenha = false; hashTexto = String(texto).trim();
      falhas.clear();
      return { ok: true };
    },

    /** Gera "scrypt$N$r$p$sal$hash" (mesmo formato e parâmetros do panel/lib/auth.js). Respeita o limite de scrypt simultâneo. */
    async gerarHash(senha) {
      if (scryptEmCurso >= SCRYPT_SIMULTANEOS) { const e = new Error('Muitas senhas sendo processadas ao mesmo tempo. Tente de novo em alguns segundos.'); e.ocupado = true; throw e; }
      const h = Object.assign({}, SCRYPT_NOVO, { sal: crypto.randomBytes(16) });
      h.hash = { length: 32 };
      scryptEmCurso++;
      try {
        const k = await scrypt(senha, h);
        return `scrypt$${h.N}$${h.r}$${h.p}$${h.sal.toString('base64url')}$${k.toString('base64url')}`;
      } finally { scryptEmCurso--; }
    },

    /**
     * Confere usuário e senha. Sempre gasta o scrypt (mesmo com usuário errado). { ok, trancado?, erro? }
     * `resolvedor` (enterprise): (nome) => { usuario, hash } | null, para conferir contra o usuário certo em vez do único do web.env.
     * Com ele o login nunca fica "trancado" por causa do web.env: quem decide é o arquivo de usuários.
     */
    async verificaSenha(usuarioInformado, senha, ip, resolvedor) {
      if (trancado && !resolvedor) return { ok: false, trancado: true, erro: semSenha ? `O login ainda não tem senha. ${motivoTrancado}` : `O login está trancado: ${motivoTrancado} Rode o gerador de hash do instalador.` };
      const b = ip ? bloqueio(ip) : { bloqueado: false };
      if (b.bloqueado) return { ok: false, limite: true, retryAfter: b.retryAfter, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(b.retryAfter / 60)} min.` };
      if (scryptEmCurso >= SCRYPT_SIMULTANEOS) {
        log('aviso', `Login de ${ip || '(sem IP)'} recusado: já há ${scryptEmCurso} senhas sendo conferidas ao mesmo tempo.`);
        return { ok: false, limite: true, retryAfter: 2, erro: 'Muitas tentativas ao mesmo tempo. Tente de novo em alguns segundos.' };
      }
      let alvo = parsed;
      let alvoUsuario = usuario;
      let existe = true;
      if (resolvedor) {
        const r = resolvedor(usuarioInformado == null ? '' : String(usuarioInformado));
        const h = r ? parseHash(r.hash) : { erro: 'usuário inexistente' };
        if (r && h.erro && r.hash) log('aviso', `O hash de senha do usuário "${String(r.usuario).slice(0, 40)}" não vale (${h.erro}). Redefina a senha com: dgclaw usuario link ${String(r.usuario).slice(0, 40)}`);
        existe = !!r && !h.erro;
        alvo = existe ? h : hashFalso;
        alvoUsuario = existe ? r.usuario : '';
      }
      let calculado;
      scryptEmCurso++;
      try {
        calculado = await scrypt(senha == null ? '' : senha, alvo);
      } catch (e) {
        log('erro', `Falha ao calcular o scrypt da senha (${e.message}). Confira N, r e p do hash.`);
        return { ok: false, erro: 'Não consegui conferir a senha agora. Tente de novo em instantes.' };
      } finally {
        scryptEmCurso--;
      }
      const senhaOk = calculado.length === alvo.hash.length && crypto.timingSafeEqual(calculado, alvo.hash);
      const usuarioOk = resolvedor ? existe : comparaTempoConstante(usuarioInformado == null ? '' : usuarioInformado, usuario);
      if (senhaOk && usuarioOk) {
        if (ip) falhas.delete(ip);
        return { ok: true, usuario: alvoUsuario };
      }
      if (ip) { const l = janela(ip); l.push(relogio()); falhas.set(ip, l); }
      return { ok: false, erro: 'Usuário ou senha incorretos.' };
    },

    /**
     * Cria a sessão e devolve { token, id, expira, cookie(Set-Cookie) } pronta para o cookie.
     * `extra` (enterprise): { papel, fa2_em, com_2fa, meia, etapa, ip, ua, horas }. `horas` manda no prazo da sessão
     * (a "meia" do 2FA dura minutos); sem ele vale sessao_horas da matriz, ou config.sessaoDias.
     */
    criaSessao(nomeUsuario, req, extra) {
      const token = crypto.randomBytes(32).toString('base64url');
      const criada = relogio();
      const e = extra || {};
      const horas = e.horas != null ? e.horas : (horasDaSessao ? horasDaSessao() : null);
      const segundos = horas != null ? Math.max(1, Math.round(horas * 3600)) : config.sessaoDias * 86400;
      const expira = criada + segundos * 1000;
      limpaExpiradas();
      const s = { usuario: nomeUsuario || usuario, criada, expira };
      for (const c of CAMPOS_EXTRAS) if (e[c] !== undefined) s[c] = e[c];
      if (e.papel !== undefined) s.ultimo_uso = criada;
      sessoes.set(sha256hex(token), s);
      limpaExpiradas();
      salva();
      return { token, id: idDe(token), expira, cookie: montaCookie(token, segundos, req) };
    },

    /**
     * { usuario, expira, ...extras } da sessão do cookie, ou null. A sessão "meia" do 2FA só aparece com
     * `{ incluirMeia: true }`: para o resto do Web ela é como se não existisse.
     */
    sessaoDoPedido(req, opcoes) {
      const token = tokenDoPedido(req);
      if (!token || token.length > 200) return null;
      const chaveSessao = sha256hex(token);
      const s = sessoes.get(chaveSessao);
      if (!s) return null;
      if (s.expira <= relogio()) { sessoes.delete(chaveSessao); salva(); return null; }
      if (s.meia && !(opcoes && opcoes.incluirMeia)) return null;
      if (sessaoValida && !sessaoValida(s)) return null;
      const saida = { usuario: s.usuario, expira: s.expira, criada: s.criada, id: chaveSessao.slice(0, 16) };
      for (const c of CAMPOS_EXTRAS) if (s[c] !== undefined) saida[c] = s[c];
      if (s.ultimo_uso !== undefined) {
        saida.ultimo_uso = s.ultimo_uso = relogio();
        if (relogio() - ultimaGravacaoUso > GRAVA_USO_A_CADA_MS) salva();
      }
      return saida;
    },

    /** Muda campos de uma sessão viva pelo id (o de criaSessao/sessaoDoPedido). Devolve true se achou. */
    atualizaSessao(id, campos) {
      for (const [k, s] of sessoes) {
        if (k.startsWith(id) && id.length >= 16) {
          for (const c of Object.keys(campos)) { if (campos[c] === undefined) delete s[c]; else s[c] = campos[c]; }
          salva();
          return true;
        }
      }
      return false;
    },

    /** As sessões completas (sem a "meia") de um usuário, da mais recente para a mais antiga. */
    listarSessoes(nome) {
      limpaExpiradas();
      const alvo = String(nome).toLowerCase();
      const saida = [];
      for (const [k, s] of sessoes) {
        if (s.meia || String(s.usuario).toLowerCase() !== alvo) continue;
        saida.push({ id: k.slice(0, 16), criada: s.criada, ultimo_uso: s.ultimo_uso == null ? null : s.ultimo_uso, expira: s.expira, ip: s.ip || null, ua: s.ua || null });
      }
      return saida.sort((a, b) => b.criada - a.criada);
    },

    /** Revoga as sessões de um usuário (todas, ou só a de `id`; `exceto` poupa uma). Devolve quantas. */
    revogarSessoes(nome, opcoes) {
      const o = opcoes || {};
      const alvo = String(nome).toLowerCase();
      let n = 0;
      for (const [k, s] of [...sessoes]) {
        if (String(s.usuario).toLowerCase() !== alvo) continue;
        if (o.id && k.slice(0, 16) !== o.id) continue;
        if (o.exceto && k.slice(0, 16) === o.exceto) continue;
        sessoes.delete(k); n += 1;
      }
      if (n) salva();
      return n;
    },

    /** Enterprise: () => boolean, se o cookie de sessão leva o prefixo __Host- (protecao https_endurecido). */
    definirCookieEndurecido(fn) { cookieEndurecido = fn; },
    /** Enterprise: prazo da sessão vindo da matriz (`sessao_horas`). */
    definirHorasDaSessao(fn) { horasDaSessao = fn; },
    /** Enterprise: recusa sessões que o multiusuário não reconhece (criadas antes dele ligar, por exemplo). */
    definirFiltroDeSessao(fn) { sessaoValida = fn; },
    /** O hash em uso hoje (o do web.env ou o que o primeiro acesso gravou), para migrar para o arquivo de usuários. */
    get hashTexto() { return hashTexto; },

    /** Apaga a sessão do pedido e manda o cookie expirar. */
    encerra(req, res) {
      const token = tokenDoPedido(req);
      if (token && sessoes.delete(sha256hex(token))) salva();
      // Com o cookie endurecido ligado, apaga os dois nomes (o antigo pode ter ficado de antes da proteção).
      res.setHeader('Set-Cookie', cookieEndurecidoLigado() ? [montaCookie('', 0, req), montaCookie('', 0, req, true)] : montaCookie('', 0, req));
    },
  };

  /** O token do cookie: o nome com __Host- tem a vez; o nome antigo continua valendo (sessões de antes da proteção). */
  function tokenDoPedido(req) {
    const c = parseCookies(req.headers.cookie);
    return c[NOME_COOKIE_HOST] || c[NOME_COOKIE];
  }

  function cookieEndurecidoLigado() {
    if (!cookieEndurecido) return false;
    try { return cookieEndurecido() === true; } catch (_) { return false; }
  }

  /** `forcaAntigo`: monta o cookie com o nome antigo mesmo com a proteção ligada (para apagá-lo). */
  function montaCookie(valor, maxAge, req, forcaAntigo) {
    const https = !!req && esquemaDoPedido(req, config.proxiesConfiaveis) === 'https';
    const host = !forcaAntigo && https && cookieEndurecidoLigado();
    let c = `${host ? NOME_COOKIE_HOST : NOME_COOKIE}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    if (https) c += '; Secure';
    return c;
  }
}

module.exports = { criarAuth, parseHash, NOME_COOKIE, NOME_COOKIE_HOST, TENTATIVAS_MAX };
