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
// Teto de erros por IP somando TODAS as identidades (dono, colaboradores, e-mails que nem existem). Nenhum acerto
// zera este contador, só o tempo: sem isso, quem tem um login de colaborador válido o usaria para limpar as
// tentativas e chutar a senha do dono sem parar.
const TENTATIVAS_MAX_POR_IP = 20;
const JANELA_MS = 15 * 60 * 1000;
const MAX_SESSOES = 200;
const MAX_SESSOES_POR_COLABORADOR = 10;
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

/** Hash fictício, gerado uma vez: login de e-mail que não existe gasta o mesmo scrypt de um que existe. */
let hashFicticioCache = null;
function hashFicticio() {
  if (hashFicticioCache) return hashFicticioCache;
  const sal = crypto.randomBytes(16);
  const k = crypto.scryptSync('senha-que-ninguem-tem', sal, 32, { N: SCRYPT_NOVO.N, r: SCRYPT_NOVO.r, p: SCRYPT_NOVO.p, maxmem: 64 * 1024 * 1024 });
  const partes = ['scrypt', SCRYPT_NOVO.N, SCRYPT_NOVO.r, SCRYPT_NOVO.p, sal.toString('base64url'), k.toString('base64url')];
  hashFicticioCache = parseHash(partes.join('$'));
  return hashFicticioCache;
}

/**
 * Cria o módulo de autenticação.
 * config: { env, dataDir, sessaoDias, proxiesConfiaveis }; log; agora (relógio injetável).
 */
function criarAuth({ config, log, agora, colaboradores: colabsInicial }) {
  let colaboradores = colabsInicial || null; // ligado depois por ligarColaboradores (o módulo precisa do gerarHash, que é daqui)
  let instanciaAtual = null;
  const MOTIVO_INSTANCIA = 'Este convite era de um agente que foi removido. Peça um convite novo ao dono.';
  /** O convite guarda a instância do agente; se o agente foi removido e recriado com o mesmo nome, ele não vale. */
  // Sem exceção: convite sem instância, instância atual ilegível ou módulo não ligado também NEGAM.
  const instanciaMudou = (c) => {
    if (!c) return false;
    const atual = instanciaAtual ? instanciaAtual(c.agente) : null;
    return !c.instancia || !atual || c.instancia !== atual;
  };

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
  }
  /** Abre vaga para a sessão do dono: derruba a mais antiga de colaborador e, só se não houver nenhuma, a mais antiga do dono. */
  function abreVagaParaODono() {
    while (sessoes.size >= MAX_SESSOES) {
      let alvo = null;
      for (const [k, v] of sessoes) { if (v.papel === 'colaborador') { alvo = k; break; } }
      sessoes.delete(alvo !== null ? alvo : sessoes.keys().next().value);
    }
  }
  carrega();

  // ── limite de tentativas ─────────────────────────────────────────────────
  // Dois contadores independentes: um por (identidade, IP), que o acerto da PRÓPRIA identidade zera, e um por IP
  // com todas as identidades juntas, que nenhum acerto zera (ver TENTATIVAS_MAX_POR_IP).
  const falhasIdentidade = new Map(); // `${identidade}\n${ip}` -> [timestamps]
  const falhasIp = new Map(); // ip -> [timestamps]
  let scryptEmCurso = 0;
  function janelaDe(mapa, chave) {
    const t = relogio();
    const lista = (mapa.get(chave) || []).filter((x) => t - x < JANELA_MS);
    if (lista.length) mapa.set(chave, lista); else mapa.delete(chave);
    return lista;
  }
  const chaveIdentidade = (identidade, ip) => `${identidade}\n${ip}`;
  function segundosAte(lista) { return Math.max(1, Math.ceil((lista[0] + JANELA_MS - relogio()) / 1000)); }
  /** Devolve { bloqueado, retryAfter } (segundos) para esta identidade neste IP, olhando os dois contadores. */
  function bloqueioLogin(identidade, ip) {
    let espera = 0;
    const da = janelaDe(falhasIdentidade, chaveIdentidade(identidade, ip));
    if (da.length >= TENTATIVAS_MAX) espera = segundosAte(da);
    const doIp = janelaDe(falhasIp, ip);
    if (doIp.length >= TENTATIVAS_MAX_POR_IP) espera = Math.max(espera, segundosAte(doIp));
    return espera ? { bloqueado: true, retryAfter: espera } : { bloqueado: false, retryAfter: 0 };
  }
  function registraFalhaLogin(identidade, ip) {
    const t = relogio();
    const k = chaveIdentidade(identidade, ip);
    falhasIdentidade.set(k, [...janelaDe(falhasIdentidade, k), t]);
    falhasIp.set(ip, [...janelaDe(falhasIp, ip), t]);
  }
  /** Acerto: zera só o contador desta identidade neste IP. O do IP inteiro continua contando. */
  const limpaFalhasDe = (identidade, ip) => falhasIdentidade.delete(chaveIdentidade(identidade, ip));
  const IDENT_DONO = 'dono';

  return {
    get trancado() { return trancado; },
    get motivoTrancado() { return motivoTrancado; },
    get semSenha() { return semSenha; },
    get usuario() { return usuario; },
    NOME_COOKIE,
    /** O IP está bloqueado para o login do dono? (a mesma conta que verificaSenha faz) */
    bloqueio(ip) { return bloqueioLogin(IDENT_DONO, ip); },

    /** Troca o hash em memória e destranca. Devolve { ok } ou { ok:false, erro }. */
    definirHash(hashTexto) {
      const novo = parseHash(hashTexto);
      if (novo.erro) return { ok: false, erro: novo.erro };
      parsed = novo; hashAtual = String(hashTexto).trim();
      if (sessoes.size) { sessoes.clear(); salva(); }
      trancado = false; motivoTrancado = null; semSenha = false;
      falhasIdentidade.clear(); falhasIp.clear();
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
      if (colaboradores && !comparaTempoConstante(usuarioInformado == null ? '' : usuarioInformado, usuario)) return verificaColaborador(usuarioInformado, senha, ip);
      if (trancado) return { ok: false, trancado: true, erro: semSenha ? `O login ainda não tem senha. ${motivoTrancado}` : `O login está trancado: ${motivoTrancado} Rode o gerador de hash do instalador.` };
      const b = ip ? bloqueioLogin(IDENT_DONO, ip) : { bloqueado: false };
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
        if (ip) limpaFalhasDe(IDENT_DONO, ip);
        return { ok: true, usuario, papel: 'dono' };
      }
      if (ip) registraFalhaLogin(IDENT_DONO, ip);
      return { ok: false, erro: 'Usuário ou senha incorretos.' };
    },

    /** Cria a sessão e devolve { token, expira, cabecalho(Set-Cookie) } pronta para o cookie. */
    criaSessao(nomeUsuario, req, colaborador) {
      const token = crypto.randomBytes(32).toString('base64url');
      const criada = relogio();
      const expira = criada + config.sessaoDias * 86400 * 1000;
      limpaExpiradas();
      let expiraFinal = expira;
      if (colaborador) {
        // Conferência síncrona logo antes de emitir: se a senha, o convite ou o acesso mudou depois que a senha foi
        // verificada, a sessão não nasce. Enquanto a senha é a temporária, a sessão morre junto com ela.
        const atual = colaboradores ? colaboradores.obter(colaborador.id) : null;
        if (instanciaMudou(atual)) { const e = new Error(MOTIVO_INSTANCIA); e.status = 401; throw e; }
        if (!atual || atual.revogado_em || atual.agente !== colaborador.agente || (atual.senha_versao || 1) !== colaborador.senha_versao || (colaborador.hash && atual.hash !== colaborador.hash)) {
          const e = new Error('O seu acesso mudou (senha trocada, convite novo ou acesso revogado) enquanto você entrava. Entre de novo.');
          e.status = 401;
          throw e;
        }
        if (atual.trocar_senha) expiraFinal = Math.min(expira, Number(atual.temporaria_expira));
        // Limite por identidade: a 11ª sessão derruba a mais antiga DELE. Sessão de colaborador nunca tira a de outra pessoa.
        const dele = [...sessoes.entries()].filter(([, v]) => v.colaborador_id === colaborador.id).map(([k]) => k);
        while (dele.length >= MAX_SESSOES_POR_COLABORADOR) sessoes.delete(dele.shift());
        if (sessoes.size >= MAX_SESSOES) {
          const e = new Error('O servidor está com o limite de sessões abertas cheio agora. Tente entrar de novo em alguns minutos ou avise o dono do DG Claw.');
          e.status = 503;
          throw e;
        }
      } else {
        abreVagaParaODono();
      }
      const reg = { usuario: nomeUsuario || usuario, criada, expira: expiraFinal, marca: marcaAtual() };
      if (colaborador) Object.assign(reg, { papel: 'colaborador', colaborador_id: colaborador.id, agente: colaborador.agente, senha_versao: colaborador.senha_versao });
      sessoes.set(sha256hex(token), reg);
      limpaExpiradas();
      salva();
      const cookie = montaCookie(token, config.sessaoDias * 86400, req);
      return { token, expira: expiraFinal, cookie, cookies: [cookie, montaCookiePapel(colaborador ? 'colaborador' : 'dono', req)] };
    },

    /** { usuario, expira, papel, agente, ... } da sessão do cookie, ou null. Sessão sem papel no disco é do dono. */
    sessaoDoPedido(req) {
      const token = parseCookies(req.headers.cookie)[NOME_COOKIE];
      if (!token || token.length > 200) return null;
      const s = sessoes.get(sha256hex(token));
      if (!s) return null;
      if (!marcaConfere(s)) { sessoes.delete(sha256hex(token)); salva(); return null; }
      if (s.expira <= relogio()) { sessoes.delete(sha256hex(token)); salva(); return null; }
      if (s.papel === 'colaborador') return sessaoDeColaborador(token, s);
      return { usuario: s.usuario, expira: s.expira, papel: 'dono', agente: null };
    },

    ligarColaboradores(modulo) { colaboradores = modulo; },
    /** `fn(slug)` devolve a instância atual do agente (ver instancia.js). Sem ela a conferência de instância não acontece. */
    ligarInstancias(fn) { instanciaAtual = fn; },

    /** Cookie legível pelo navegador só para a tela esconder o que não é do colaborador. Não protege nada: quem protege é o escopo.js. */
    cookiePapel(papel, req) { return montaCookiePapel(papel, req); },

    /** A senha confere com este hash? (troca de senha do colaborador). Respeita o limite de scrypt simultâneo. */
    async senhaConfereHash(senha, hashTexto) {
      const h = parseHash(hashTexto);
      if (h.erro) return false;
      if (scryptEmCurso >= SCRYPT_SIMULTANEOS) { const e = new Error('Muitas senhas sendo processadas ao mesmo tempo. Tente de novo em alguns segundos.'); e.ocupado = true; throw e; }
      scryptEmCurso++;
      try {
        const k = await scrypt(senha, h);
        return k.length === h.hash.length && crypto.timingSafeEqual(k, h.hash);
      } finally { scryptEmCurso--; }
    },

    /** Apaga todas as sessões de um colaborador (revogação, convite novo, troca de senha). Devolve quantas. */
    encerraDoColaborador(id) {
      let n = 0;
      for (const [k, v] of sessoes) if (v.papel === 'colaborador' && v.colaborador_id === id) { sessoes.delete(k); n++; }
      if (n) salva();
      return n;
    },

    /** Apaga a sessão do pedido e manda o cookie expirar. */
    encerra(req, res) {
      const token = parseCookies(req.headers.cookie)[NOME_COOKIE];
      if (token && sessoes.delete(sha256hex(token))) salva();
      res.setHeader('Set-Cookie', [montaCookie('', 0, req), montaCookiePapel('', req)]);
    },
  };

  // ── colaboradores (funções separadas das do dono, para facilitar o rebase) ──
  async function verificaColaborador(emailInformado, senha, ip) {
    const identidade = `colaborador:${String(emailInformado == null ? '' : emailInformado).trim().toLowerCase().slice(0, 200)}`;
    const b = ip ? bloqueioLogin(identidade, ip) : { bloqueado: false };
    if (b.bloqueado) return { ok: false, limite: true, retryAfter: b.retryAfter, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(b.retryAfter / 60)} min.` };
    if (scryptEmCurso >= SCRYPT_SIMULTANEOS) {
      log('aviso', `Login de ${ip || '(sem IP)'} recusado: já há ${scryptEmCurso} senhas sendo conferidas ao mesmo tempo.`);
      return { ok: false, limite: true, retryAfter: 2, erro: 'Muitas tentativas ao mesmo tempo. Tente de novo em alguns segundos.' };
    }
    const c = colaboradores.porEmailAtivo(emailInformado);
    // O registro pode mudar DURANTE o scrypt (o dono reenvia o convite, o colaborador troca a senha) e os objetos
    // do registro são alterados no lugar. O que foi conferido fica em constantes aqui, antes do await.
    const visto = c ? { id: c.id, email: c.email, agente: c.agente, hash: c.hash, versao: c.senha_versao || 1 } : null;
    let alvo = visto ? parseHash(visto.hash) : hashFicticio();
    if (alvo.erro) {
      log('erro', `O hash do colaborador ${visto.email} não vale (${alvo.erro}). Ele não consegue entrar; mande um convite novo (POST /api/v1/colaboradores/${visto.id}/reenviar).`);
      alvo = hashFicticio();
    }
    let calculado;
    scryptEmCurso++;
    try {
      calculado = await scrypt(senha == null ? '' : senha, alvo);
    } catch (e) {
      log('erro', `Falha ao calcular o scrypt da senha de colaborador (${e.message}).`);
      return { ok: false, erro: 'Não consegui conferir a senha agora. Tente de novo em instantes.' };
    } finally {
      scryptEmCurso--;
    }
    const senhaOk = !!visto && alvo !== hashFicticioCache && calculado.length === alvo.hash.length && crypto.timingSafeEqual(calculado, alvo.hash);
    if (!senhaOk) {
      if (ip) registraFalhaLogin(identidade, ip);
      return { ok: false, erro: 'Usuário ou senha incorretos.' };
    }
    // Recarrega: só vale se o registro ainda é exatamente o que a senha conferiu e o acesso não foi revogado.
    const atual = colaboradores.obter(visto.id);
    if (!atual || atual.revogado_em || atual.hash !== visto.hash || (atual.senha_versao || 1) !== visto.versao || atual.agente !== visto.agente) {
      log('aviso', `Login de ${visto.email} (ip ${ip || '?'}) descartado: o convite, a senha ou o acesso mudou enquanto a senha era conferida.`);
      return { ok: false, erro: 'O seu acesso mudou (senha trocada, convite novo ou acesso revogado) enquanto você entrava. Entre de novo.' };
    }
    if (instanciaMudou(atual)) {
      log('aviso', `Login de ${visto.email} (ip ${ip || '?'}) recusado: o convite era de uma instância antiga do agente ${atual.agente} (removido e recriado).`);
      return { ok: false, erro: MOTIVO_INSTANCIA };
    }
    if (ip) limpaFalhasDe(identidade, ip);
    if (atual.trocar_senha && Number(atual.temporaria_expira) < relogio()) {
      return { ok: false, vencida: true, erro: 'A senha temporária venceu. Peça ao dono do DG Claw um convite novo.' };
    }
    colaboradores.registrarLogin(visto.id);
    return { ok: true, usuario: visto.email, papel: 'colaborador', colaborador: { id: visto.id, agente: visto.agente, senha_versao: visto.versao, hash: visto.hash } };
  }

  /** Confere a CADA pedido que o colaborador ainda vale: a revogação e a troca de senha derrubam a sessão no pedido seguinte. */
  function sessaoDeColaborador(token, s) {
    const c = colaboradores ? colaboradores.obter(s.colaborador_id) : null;
    if (!c || c.revogado_em || c.agente !== s.agente || (c.senha_versao || 1) !== s.senha_versao || instanciaMudou(c)) {
      if (c && instanciaMudou(c)) log('aviso', `Sessão do colaborador ${c.email} derrubada: o agente ${c.agente} foi removido e recriado, e o convite era da instância antiga.`);
      sessoes.delete(sha256hex(token));
      salva();
      return null;
    }
    if (c.trocar_senha && Number(c.temporaria_expira) <= relogio()) {
      sessoes.delete(sha256hex(token));
      salva();
      return null;
    }
    return { usuario: s.usuario, expira: s.expira, papel: 'colaborador', agente: c.agente, colaborador_id: c.id, nome: c.nome || '', trocar_senha: !!c.trocar_senha, senha_versao: c.senha_versao || 1 };
  }

  function montaCookiePapel(papel, req) {
    let c = `dgclaw_papel=${papel}; SameSite=Lax; Path=/; Max-Age=${papel ? config.sessaoDias * 86400 : 0}`;
    if (req && esquemaDoPedido(req, config.proxiesConfiaveis) === 'https') c += '; Secure';
    return c;
  }

  function montaCookie(valor, maxAge, req) {
    let c = `${NOME_COOKIE}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    if (req && esquemaDoPedido(req, config.proxiesConfiaveis) === 'https') c += '; Secure';
    return c;
  }
}

module.exports = { criarAuth, parseHash, NOME_COOKIE, TENTATIVAS_MAX };
