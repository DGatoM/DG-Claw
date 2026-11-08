'use strict';
// Autenticação do Web: verificação de senha (scrypt), sessões em cookie e limite de tentativas.
// Interface pequena de propósito: verificaSenha, criaSessao, sessaoDoPedido, encerra.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseCookies, ipDoPedido, esquemaDoPedido } = require('./http');

const NOME_COOKIE = 'dgclaw_sessao';
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

function b64urlParaBuffer(s) { return Buffer.from(String(s), 'base64url'); }

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
  let hashAtual = hashInicial;
  let parsed = parseHash(hashInicial);
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
  let sessoes = new Map(); // sha256hex -> { usuario, criada, expira, marca }
  // "Marca" da credencial: sha256 de usuário + hash da senha. Cada sessão carrega a marca de quando nasceu,
  // então trocar a senha ou o usuário derruba as sessões antigas. O hash em si nunca vai para o disco.
  const marcaAtual = () => sha256hex(`${usuario}\n${hashAtual}`);
  const marcaConfere = (s) => typeof s.marca === 'string' && s.marca.length === 64
    && crypto.timingSafeEqual(Buffer.from(s.marca), Buffer.from(marcaAtual()));
  function carrega() {
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      let descartadas = 0;
      for (const [k, v] of Object.entries(j.sessoes || {})) {
        if (!v || !(v.expira > relogio())) continue;
        if (!marcaConfere(v)) { descartadas++; continue; }
        sessoes.set(k, v);
      }
      if (descartadas) {
        log('info', `${descartadas} sessão(ões) do painel descartada(s): a senha ou o usuário do painel mudou (ou a sessão é de uma versão antiga, sem a marca da senha); quem estava logado precisa entrar de novo.`);
        salva();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Não li as sessões salvas em ${arquivo} (${e.code || e.message}). Começo sem sessões; quem estava logado precisa entrar de novo.`);
    }
  }
  function salva() {
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
    definirHash(hashTexto) {
      const novo = parseHash(hashTexto);
      if (novo.erro) return { ok: false, erro: novo.erro };
      parsed = novo; hashAtual = String(hashTexto).trim();
      if (sessoes.size) { sessoes.clear(); salva(); }
      trancado = false; motivoTrancado = null; semSenha = false;
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

    /** Confere usuário e senha. Sempre gasta o scrypt (mesmo com usuário errado). { ok, trancado?, erro? } */
    async verificaSenha(usuarioInformado, senha, ip) {
      if (trancado) return { ok: false, trancado: true, erro: semSenha ? `O login ainda não tem senha. ${motivoTrancado}` : `O login está trancado: ${motivoTrancado} Rode o gerador de hash do instalador.` };
      const b = ip ? bloqueio(ip) : { bloqueado: false };
      if (b.bloqueado) return { ok: false, limite: true, retryAfter: b.retryAfter, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(b.retryAfter / 60)} min.` };
      if (scryptEmCurso >= SCRYPT_SIMULTANEOS) {
        log('aviso', `Login de ${ip || '(sem IP)'} recusado: já há ${scryptEmCurso} senhas sendo conferidas ao mesmo tempo.`);
        return { ok: false, limite: true, retryAfter: 2, erro: 'Muitas tentativas ao mesmo tempo. Tente de novo em alguns segundos.' };
      }
      let calculado;
      scryptEmCurso++;
      try {
        calculado = await scrypt(senha == null ? '' : senha, parsed);
      } catch (e) {
        log('erro', `Falha ao calcular o scrypt da senha (${e.message}). Confira N, r e p do hash no web.env.`);
        return { ok: false, erro: 'Não consegui conferir a senha agora. Tente de novo em instantes.' };
      } finally {
        scryptEmCurso--;
      }
      const senhaOk = calculado.length === parsed.hash.length && crypto.timingSafeEqual(calculado, parsed.hash);
      const usuarioOk = comparaTempoConstante(usuarioInformado == null ? '' : usuarioInformado, usuario);
      if (senhaOk && usuarioOk) {
        if (ip) falhas.delete(ip);
        return { ok: true, usuario };
      }
      if (ip) { const l = janela(ip); l.push(relogio()); falhas.set(ip, l); }
      return { ok: false, erro: 'Usuário ou senha incorretos.' };
    },

    /** Cria a sessão e devolve { token, expira, cabecalho(Set-Cookie) } pronta para o cookie. */
    criaSessao(nomeUsuario, req) {
      const token = crypto.randomBytes(32).toString('base64url');
      const criada = relogio();
      const expira = criada + config.sessaoDias * 86400 * 1000;
      limpaExpiradas();
      sessoes.set(sha256hex(token), { usuario: nomeUsuario || usuario, criada, expira, marca: marcaAtual() });
      limpaExpiradas();
      salva();
      return { token, expira, cookie: montaCookie(token, config.sessaoDias * 86400, req) };
    },

    /** { usuario, expira } da sessão do cookie, ou null. */
    sessaoDoPedido(req) {
      const token = parseCookies(req.headers.cookie)[NOME_COOKIE];
      if (!token || token.length > 200) return null;
      const s = sessoes.get(sha256hex(token));
      if (!s) return null;
      if (!marcaConfere(s)) { sessoes.delete(sha256hex(token)); salva(); return null; }
      if (s.expira <= relogio()) { sessoes.delete(sha256hex(token)); salva(); return null; }
      return { usuario: s.usuario, expira: s.expira };
    },

    /** Apaga a sessão do pedido e manda o cookie expirar. */
    encerra(req, res) {
      const token = parseCookies(req.headers.cookie)[NOME_COOKIE];
      if (token && sessoes.delete(sha256hex(token))) salva();
      res.setHeader('Set-Cookie', montaCookie('', 0, req));
    },
  };

  function montaCookie(valor, maxAge, req) {
    let c = `${NOME_COOKIE}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    if (req && esquemaDoPedido(req, config.proxiesConfiaveis) === 'https') c += '; Secure';
    return c;
  }
}

module.exports = { criarAuth, parseHash, NOME_COOKIE, TENTATIVAS_MAX };
