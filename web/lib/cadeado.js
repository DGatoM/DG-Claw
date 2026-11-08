'use strict';
// Cadeado com Face ID (WebAuthn): opcional, ligado pela pessoa, por aparelho. Referência: web/docs/CADEADO.md.
//
// Como funciona, em curto:
//   - A passkey do aparelho (Face ID, Touch ID, biometria) só DESTRAVA uma sessão que já entrou com a senha.
//     Ela nunca cria sessão nem faz login, e precisa ser do titular da sessão (o dono, ou 'colaborador:<id>').
//   - Cada aparelho que cadastra uma passkey ganha o cookie dgclaw_aparelho (valor aleatório; no disco fica só o hash).
//     A sessão só trava quando o pedido traz esse cookie ligado a uma passkey do mesmo titular. Quem não ativou não percebe nada.
//   - O estado de cada sessão (último uso) fica no servidor, por hash do token. Sessão sem registro está travada.
//   - A verificação é toda aqui, no servidor: desafio de uso único (2 min, preso à sessão e ao tipo), type, origin, rpIdHash,
//     flags UP e UV, assinatura (ES256 ou RS256) e contador.
//   - O arquivo de passkeys ilegível FECHA: o cadeado continua ligado para quem tem o cookie e só a senha destrava; nada é regravado.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const H = require('./http');
const { NOME_COOKIE } = require('./auth');
const W = require('./webauthn');

const { WebAuthnErro, b64u, deB64u } = W;
const COOKIE_APARELHO = 'dgclaw_aparelho';
const COOKIE_APARELHO_S = 400 * 86400; // o navegador não guarda cookie por mais que isso
const BASE = '/api/v1/cadeado';
const DESAFIO_MS = 120 * 1000;
const DESAFIOS_POR_SESSAO = 8;
const TRAVA_PADRAO_MIN = 15;
const TRAVA_LIMITES = [1, 120];
const NOME_MAX = 60;
const PASSKEYS_POR_TITULAR = 10;
const ESTADO_ESQUECE_MS = 3 * 86400 * 1000; // vale só para registro sem exigência; o com exigência vive até a sessão expirar
const ESTADO_MAX = 5000;
const USO_MIN_MS = 60 * 1000;
const JANELA_FALHAS_MS = 10 * 60 * 1000;
const FALHAS_POR_SESSAO = 10;
const FALHAS_POR_IP = 20;
const RX_PASSKEY_ID = /^pk_[0-9a-f]{12}$/;
const RX_TITULAR = /^(?:dono|colaborador:[A-Za-z0-9_-]{8,64})$/;
const MSG_TRAVADO = 'A tela está travada por falta de uso. Destrave com o Face ID (ou entre de novo com a senha).';
const TRANSPORTES = new Set(['internal', 'hybrid', 'usb', 'nfc', 'ble', 'smart-card']);

// Arquivos estáticos que passam enquanto a sessão está travada (a tela do cadeado precisa deles). Nada de .html.
const RX_ESTATICO = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|gif|webp|svg|ico|webmanifest|woff2?|ttf|mp3|wav|mp4|webm)$/;
const ehEstatico = (p) => !p.includes('..') && !p.startsWith('/api/') && !p.startsWith('/p/') && RX_ESTATICO.test(p);

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const limpaNome = (v) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim() : '');
const iso = (ms) => new Date(ms).toISOString();

/** `next` só vale se for caminho do próprio site e não levar de volta ao cadeado, ao login ou ao sair. */
function destinoSeguro(valor) {
  const s = typeof valor === 'string' ? valor : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\x00-\x1f]/.test(s)) return '/';
  if (/^\/(?:cadeado|login|sair)(?:[/?#]|$)/.test(s)) return '/';
  return s;
}

/** Gravação atômica em fila: cada chamada vira uma troca de arquivo, uma por vez; chamadas seguidas sem começar viram uma só. */
function criarGravador(caminho, serializa) {
  let cadeia = Promise.resolve();
  let esperando = null;
  let n = 0;
  async function escreve() {
    const tmp = `${caminho}.${process.pid}.${n++}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(serializa()), { mode: 0o600 });
      await fs.promises.chmod(tmp, 0o600);
      await fs.promises.rename(tmp, caminho);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }
  return {
    gravar() {
      if (esperando) return esperando;
      const p = cadeia.then(() => { esperando = null; return escreve(); });
      esperando = p;
      cadeia = p.catch(() => {});
      return p;
    },
    aguardar() { return cadeia; },
  };
}

function criarCadeado({ config, log, agora, encerrarSessao, existeSessao, estadoMax, marcarSessao, desmarcarSessao, lerMarca, sessaoViva }) {
  const maxEstados = Number.isInteger(estadoMax) && estadoMax > 0 ? estadoMax : ESTADO_MAX;
  const relogio = agora || (() => Date.now());
  const arqPasskeys = path.join(config.dataDir, 'passkeys.json');
  const arqEstado = path.join(config.dataDir, 'cadeado-sessoes.json');

  let conf = { versao: 1, ajustes: {}, passkeys: [] };
  let falhaCarga = null;
  // chave da sessão -> { uso, destravada_em, como, titular } e, quando a sessão foi presa a um aparelho,
  // { exige: true, aparelho_hash, auth (chave da sessão no auth.js), expira (da sessão) }
  const estados = new Map();
  const desafios = new Map(); // desafio (base64url) -> { tipo, sessao, rpId, origem, exp }
  const falhas = new Map(); // 's:<sessão>' ou 'i:<ip>' -> [instantes]

  // ── disco ────────────────────────────────────────────────────────────────
  const registroValido = (p) => p && typeof p === 'object' && RX_PASSKEY_ID.test(p.id) && RX_TITULAR.test(String(p.titular))
    && typeof p.credencial_id === 'string' && /^[0-9a-f]{64}$/.test(String(p.aparelho_hash)) && typeof p.rp_id === 'string'
    && (p.alg === W.ALG_ES256 || p.alg === W.ALG_RS256) && p.jwk && typeof p.jwk === 'object' && typeof p.nome === 'string';

  function carrega() {
    let texto = null;
    try { texto = fs.readFileSync(arqPasskeys, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') falhaCarga = `${arqPasskeys} não pôde ser lido (${e.code || e.message})`;
    }
    if (texto !== null) {
      try {
        const d = JSON.parse(texto);
        if (!d || typeof d !== 'object' || !Array.isArray(d.passkeys)) throw new Error('o arquivo não tem a lista "passkeys"');
        const ruim = d.passkeys.findIndex((p) => !registroValido(p));
        if (ruim >= 0) throw new Error(`a passkey número ${ruim + 1} está incompleta ou fora do formato`);
        conf = { versao: 1, ajustes: d.ajustes && typeof d.ajustes === 'object' ? d.ajustes : {}, passkeys: d.passkeys };
      } catch (e) {
        falhaCarga = `${arqPasskeys} está ilegível (${e.message})`;
      }
    }
    if (falhaCarga) {
      falhaCarga += '. O Face ID ficou ligado nos aparelhos que já tinham cadastro e só a senha destrava. Nada foi regravado: conserte ou apague o arquivo e reinicie o painel.';
      log('erro', `Cadeado: ${falhaCarga}`);
    }
    try {
      const s = JSON.parse(fs.readFileSync(arqEstado, 'utf8'));
      for (const [k, v] of Object.entries((s && s.sessoes) || {})) {
        if (/^[0-9a-f]{64}$/.test(k) && v && Number.isFinite(v.uso) && RX_TITULAR.test(String(v.titular))) estados.set(k, v);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Cadeado: não li ${arqEstado} (${e.code || e.message}). Começo sem sessões destravadas, então cada aparelho com Face ID pede o destravamento de novo.`);
    }
  }
  carrega();

  const gravConf = criarGravador(arqPasskeys, () => conf);
  const gravEstado = criarGravador(arqEstado, () => ({ versao: 1, sessoes: Object.fromEntries(estados) }));
  /** Limpa o estado: 1) o que expirou ou cuja sessão já não existe no auth; 2) no corte por tamanho, primeiro o que não tem
      exigência; 3) só em último caso um registro com exigência de sessão VIVA, e então a sessão é encerrada junto: nunca fica
      sessão viva com a exigência perdida (sem registro, omitir o cookie liberaria a sessão). */
  function limpaEstados() {
    const t = relogio();
    for (const [k, v] of estados) {
      if (!v.exige) { if (t - v.uso > ESTADO_ESQUECE_MS) estados.delete(k); continue; }
      if (Number.isFinite(v.expira) && v.expira < t) estados.delete(k);
      else if (v.auth && existeSessao && !existeSessao(v.auth)) estados.delete(k);
    }
    while (estados.size > maxEstados) {
      let alvo = null;
      for (const [k, v] of estados) if (!v.exige) { alvo = k; break; }
      if (alvo !== null) { estados.delete(alvo); continue; }
      // todos os registros têm exigência e todos de sessão viva: o mais antigo sai, e a sessão dele sai junto
      let velho = null;
      for (const [k, v] of estados) if (velho === null || v.uso < estados.get(velho).uso) velho = k;
      const v = estados.get(velho);
      estados.delete(velho);
      if (v.auth && encerrarSessao) {
        encerrarSessao(v.auth);
        log('aviso', `Cadeado: o estado passou de ${maxEstados} sessões presas a um aparelho; encerrei a sessão mais antiga de ${v.titular} (pedirá a senha de novo) em vez de deixá-la sem a exigência do Face ID.`);
      } else {
        log('aviso', `Cadeado: o estado passou de ${maxEstados} sessões e descartei um registro de ${v.titular} sem como identificar a sessão dele. Se for a sessão de alguém, ela só trava de novo no próximo pedido com o cookie do aparelho.`);
      }
    }
  }
  const salvaEstado = () => {
    limpaEstados();
    gravEstado.gravar().catch((e) => log('erro', `Cadeado: não gravei ${arqEstado} (${e.code || e.message}). O estado das sessões vale só até o próximo restart; confira a permissão de ${config.dataDir}.`));
  };

  // Mudanças em passkeys.json: uma de cada vez, desfeitas em memória se a gravação falhar, e nunca com o arquivo ilegível.
  let fila = Promise.resolve();
  function altera(fn) {
    const exec = async () => {
      if (falhaCarga) throw new WebAuthnErro(`Não posso mexer nas passkeys: ${falhaCarga}`, 'arquivo', 503);
      const antes = JSON.stringify(conf);
      try {
        const r = fn(conf);
        await gravConf.gravar();
        return r;
      } catch (e) {
        conf = JSON.parse(antes);
        if (e instanceof WebAuthnErro) throw e;
        log('erro', `Cadeado: não gravei ${arqPasskeys} (${e.code || e.message}).`);
        throw new WebAuthnErro(`Não consegui gravar ${arqPasskeys} (${e.code || e.message}). Confira a permissão da pasta de dados.`, 'arquivo', 500);
      }
    };
    const p = fila.then(exec, exec);
    fila = p.catch(() => {});
    return p;
  }

  // ── quem é quem ──────────────────────────────────────────────────────────
  const titularDe = (sessao) => (!sessao || sessao.via ? null : (sessao.papel === 'colaborador' ? `colaborador:${sessao.colaborador_id}` : 'dono'));
  const lerCookie = (req, nome) => H.parseCookies(req.headers.cookie)[nome];
  function chaveSessao(req) {
    const t = lerCookie(req, NOME_COOKIE);
    return t && t.length <= 200 ? sha256hex(`dgclaw-cadeado-sessao:${t}`) : null;
  }
  function aparelhoDe(req) {
    const v = lerCookie(req, COOKIE_APARELHO);
    return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? { valor: v, hash: sha256hex(`dgclaw-cadeado-aparelho:${v}`) } : null;
  }
  const passkeysDe = (titular) => conf.passkeys.filter((p) => p.titular === titular);
  /** Este aparelho tem cadeado para este titular? Cookie ligado a uma passkey dele. Ilegível: qualquer cookie de aparelho vale. */
  function aparelhoLigado(req, titular) {
    const ap = aparelhoDe(req);
    if (!ap) return false;
    if (falhaCarga) return true;
    return conf.passkeys.some((p) => p.titular === titular && p.aparelho_hash === ap.hash);
  }
  const travaMin = (titular) => {
    const v = conf.ajustes[titular] && conf.ajustes[titular].trava_min;
    return Number.isInteger(v) && v >= TRAVA_LIMITES[0] && v <= TRAVA_LIMITES[1] ? v : TRAVA_PADRAO_MIN;
  };

  const authHashDe = (req) => {
    const t = lerCookie(req, NOME_COOKIE);
    return t && t.length <= 200 ? sha256hex(t) : null;
  };
  const estadoDe = (k, titular) => { const e = k ? estados.get(k) : null; return e && e.titular === titular ? e : null; };

  /** Prende a sessão ao aparelho NO SERVIDOR: dali em diante ela trava pelo tempo mesmo sem o cookie ou com cookie adulterado.
      O cookie só serve para criar essa ligação, nunca para desfazê-la. */
  function prende(k, titular, apHash, authHash, expira, manter) {
    // A marca também vai para o registro que autentica a sessão (sessoes.json): se o estado do cadeado se perder (disco cheio,
    // arquivo corrompido), a sessão continua exigindo o cadeado depois do restart. Com `manter`, se a gravação falhar a marca
    // fica na memória (entra na próxima gravação do auth) e a sessão segue travada; sem `manter`, devolve null e nada muda.
    const m = authHash && lerMarca ? lerMarca(authHash) : null;
    // Marca pendente (só na memória) nunca vale como gravada: tenta gravar de novo.
    if (!(m && !m.pendente && m.aparelho_hash === apHash) && !(authHash && marcarSessao && marcarSessao(authHash, apHash, manter))) {
      log('erro', `Cadeado: não consegui gravar a ligação da sessão ao aparelho no registro de sessões. ${manter ? 'A sessão segue travada e a marca fica na memória até a próxima gravação' : 'Nada foi destravado'}. Confira o espaço e a permissão da pasta de dados.`);
      if (!manter) return null;
    }
    const e = estadoDe(k, titular) || { uso: 0, destravada_em: 0, como: 'vinculo', titular };
    Object.assign(e, { exige: true, aparelho_hash: apHash, auth: authHash, expira });
    estados.set(k, e);
    return e;
  }

  /** A sessão deste pedido está travada agora? Caixa do agente e pedido sem sessão de cookie nunca travam.
      A primeira vez que um pedido da sessão traz um cookie válido do titular, a sessão é presa ao aparelho (ver prende). */
  function travada(req, sessao) {
    const titular = titularDe(sessao);
    const k = chaveSessao(req);
    if (!titular || !k) return false;
    let e = estadoDe(k, titular);
    if (!(e && e.exige)) {
      const authHash = authHashDe(req);
      const marca = authHash && lerMarca ? lerMarca(authHash) : null;
      if (marca) {
        // O auth diz que esta sessão exige o cadeado mas o estado se perdeu: sem registro não há prova de uso recente, então trava.
        e = Object.assign(e || { uso: 0, destravada_em: 0, como: 'marca', titular }, { exige: true, aparelho_hash: marca.aparelho_hash, auth: authHash, expira: sessao.expira });
        estados.set(k, e);
        salvaEstado();
      } else {
        const ap = aparelhoDe(req);
        if (!ap || !aparelhoLigado(req, titular)) return false;
        e = prende(k, titular, ap.hash, authHash, sessao.expira, true);
        salvaEstado();
      }
    }
    return relogio() - e.uso > travaMin(titular) * 60000;
  }
  /** Esta sessão tem cadeado? Presa a um aparelho (exigência no servidor) ou com cookie de aparelho válido do titular. */
  function ligado(req, sessao) {
    const titular = titularDe(sessao);
    if (!titular) return false;
    const e = estadoDe(chaveSessao(req), titular);
    const h = authHashDe(req);
    return !!(e && e.exige) || !!(h && lerMarca && lerMarca(h)) || aparelhoLigado(req, titular);
  }
  function restaS(req, sessao) {
    const titular = titularDe(sessao);
    if (!titular || !ligado(req, sessao)) return null;
    const e = estadoDe(chaveSessao(req), titular);
    if (!e) return 0;
    return Math.max(0, Math.floor((travaMin(titular) * 60000 - (relogio() - e.uso)) / 1000));
  }
  /** Destrava a sessão `k`. `prender` ({ apHash, authHash, expira }) liga também a sessão ao aparelho. */
  function destrava(k, titular, como, prender) {
    // A ligação é gravada ANTES de destravar: se não der, nada é destravado.
    if (prender && !prende(k, titular, prender.apHash, prender.authHash, prender.expira, prender.manter)) return false;
    const t = relogio();
    const e = estadoDe(k, titular) || {};
    Object.assign(e, { uso: t, destravada_em: t, como, titular });
    estados.set(k, e);
    salvaEstado();
    return true;
  }
  const ERRO_LIGACAO = () => new WebAuthnErro('O Face ID foi aceito, mas não consegui gravar a ligação desta sessão ao aparelho (disco cheio ou sem permissão). A sessão continua travada: tente de novo ou entre com a senha.', 'arquivo', 500);
  const ERRO_MARCA_CADASTRO = () => new WebAuthnErro('Não consegui gravar a ligação desta sessão ao aparelho (disco cheio ou sem permissão), então o Face ID não foi ligado. Nada mudou: você segue usando o DG Claw normalmente, sem o cadeado. Libere espaço ou confira a permissão da pasta de dados e tente de novo.', 'arquivo', 500);
  /** Depois de ler o corpo (ou dentro da fila de gravação) a sessão pode ter vencido ou travado: revalida antes de mudar qualquer coisa. */
  function confereSessao(req, sessao) {
    if (sessaoViva && !sessaoViva(req)) throw new WebAuthnErro('A sua sessão deixou de valer enquanto o pedido era lido. Entre de novo.', 'sessao', 401);
    if (travada(req, sessao)) throw new WebAuthnErro(MSG_TRAVADO, 'travado', 423);
  }
  /** Passkey removida e o aparelho ficou sem nenhuma da mesma pessoa: encerra as sessões presas a ele, menos a de quem removeu
      (se for do mesmo aparelho, ela continua e a exigência dela cai). Devolve quantas sessões foram encerradas. */
  function soltaAparelho(titular, apHash, kAtual) {
    let n = 0;
    for (const [k2, e] of [...estados]) {
      if (!e.exige || e.titular !== titular || e.aparelho_hash !== apHash) continue;
      if (k2 === kAtual) { if (e.auth && desmarcarSessao) desmarcarSessao(e.auth); delete e.exige; delete e.aparelho_hash; delete e.auth; delete e.expira; continue; }
      estados.delete(k2);
      if (e.auth && encerrarSessao) { encerrarSessao(e.auth); n++; }
      else if (e.auth) log('aviso', 'Cadeado: não tenho como encerrar a sessão presa a um aparelho removido (o servidor não ligou o encerramento).');
    }
    salvaEstado();
    return n;
  }

  // ── origem e rpId ────────────────────────────────────────────────────────
  // H.origemPropria usa X-Forwarded-Host só quando a conexão vem de proxy confiável (loopback ou lista configurada); de
  // outra conexão vale o Host. Por isso a TRAVA (travada) não usa o rpId: o cookie de aparelho já é preso ao endereço pelo
  // navegador, e amarrar a trava a um cabeçalho deixaria um Host forjado desligá-la. O rpId só decide cadastro e verificação,
  // onde a assinatura da passkey e o Origin do navegador fecham o que um Host forjado tentaria.
  function ambiente(req) {
    let u;
    try { u = new URL(H.origemPropria(req, config.proxiesConfiaveis)); } catch (_) {
      return { erro: 'Não consegui entender o endereço pelo qual você abriu o DG Claw, então não sei para qual endereço criar a passkey.' };
    }
    const host = u.hostname;
    const local = host === 'localhost' || host.endsWith('.localhost');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      return { erro: `O navegador só libera o Face ID em endereço com HTTPS, e você abriu o DG Claw por ${u.origin}. Abra pelo endereço com https:// (peça ao Admin para conferir o certificado) e tente de novo.` };
    }
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
      return { erro: `O navegador não aceita Face ID em endereço de IP (${host}). Use o endereço com nome do painel (por exemplo o de HTTPS que o instalador mostrou).` };
    }
    return { origem: u.origin, rpId: host, https: u.protocol === 'https:' };
  }

  // ── desafios e limites ───────────────────────────────────────────────────
  function novoDesafio(tipo, k, amb) {
    const t = relogio();
    for (const [c, d] of desafios) if (d.exp <= t) desafios.delete(c);
    const meus = [...desafios.entries()].filter(([, d]) => d.sessao === k).sort((a, b) => a[1].exp - b[1].exp);
    for (const [c] of meus.slice(0, Math.max(0, meus.length - DESAFIOS_POR_SESSAO + 1))) desafios.delete(c);
    const bruto = crypto.randomBytes(32);
    desafios.set(b64u(bruto), { tipo, sessao: k, rpId: amb.rpId, origem: amb.origem, exp: t + DESAFIO_MS });
    return bruto;
  }
  function consomeDesafio(valor, tipo, k) {
    if (typeof valor !== 'string' || !valor || valor.length > 200) throw new WebAuthnErro('O clientDataJSON veio sem challenge.', 'desafio');
    const canon = b64u(deB64u(valor, 'challenge', 200));
    const d = desafios.get(canon);
    desafios.delete(canon); // uso único, mesmo que a conferência abaixo falhe
    if (!d) throw new WebAuthnErro('Esse desafio não existe ou já foi usado (cada um vale uma vez só). Peça opções novas e tente de novo.', 'desafio');
    if (d.exp < relogio()) throw new WebAuthnErro('O desafio venceu (vale 2 minutos). Peça opções novas e tente de novo.', 'desafio');
    if (d.tipo !== tipo) throw new WebAuthnErro(`Esse desafio foi pedido para ${d.tipo}, não para ${tipo}.`, 'desafio');
    if (d.sessao !== k) throw new WebAuthnErro('Esse desafio foi gerado para outra sessão de login.', 'desafio', 403);
    return d;
  }
  function listaFalhas(chave) {
    const t = relogio();
    const l = (falhas.get(chave) || []).filter((x) => t - x < JANELA_FALHAS_MS);
    if (l.length) falhas.set(chave, l); else falhas.delete(chave);
    return l;
  }
  /** Segundos de espera se a sessão ou o IP estourou as tentativas, ou 0. */
  function espera(k, ip) {
    let s = 0;
    for (const [chave, max] of [[`s:${k}`, FALHAS_POR_SESSAO], [`i:${ip}`, FALHAS_POR_IP]]) {
      const l = listaFalhas(chave);
      if (l.length >= max) s = Math.max(s, Math.ceil((l[0] + JANELA_FALHAS_MS - relogio()) / 1000));
    }
    return s;
  }
  function registraFalha(k, ip) {
    const t = relogio();
    for (const chave of [`s:${k}`, `i:${ip}`]) falhas.set(chave, [...listaFalhas(chave), t]);
    if (falhas.size > 5000) for (const chave of [...falhas.keys()]) listaFalhas(chave);
  }

  // ── leitura do que o navegador manda ─────────────────────────────────────
  function credencialDe(corpo) {
    if (!corpo || typeof corpo !== 'object') throw new WebAuthnErro('O corpo precisa ser JSON com o campo "credencial".', 'formato');
    const cred = corpo.credencial;
    if (!cred || typeof cred !== 'object' || !cred.response || typeof cred.response !== 'object') {
      throw new WebAuthnErro('Faltou "credencial" com "response" dentro (o que o navegador devolve, em base64url).', 'formato', 400, Object.keys(corpo).slice(0, 10));
    }
    if (cred.type !== undefined && cred.type !== 'public-key') throw new WebAuthnErro('credencial.type precisa ser "public-key".', 'formato');
    return cred;
  }
  function clientData(resp) {
    const cdj = deB64u(resp.clientDataJSON, 'credencial.response.clientDataJSON');
    let cd;
    try { cd = JSON.parse(cdj.toString('utf8')); } catch (e) { throw new WebAuthnErro('O clientDataJSON não é JSON.', 'formato'); }
    if (!cd || typeof cd !== 'object' || Array.isArray(cd)) throw new WebAuthnErro('O clientDataJSON não é um objeto JSON.', 'formato');
    return { cdj, cd };
  }
  function confereCliente(cd, tipoEsperado, d, amb) {
    if (cd.type !== tipoEsperado) throw new WebAuthnErro(`O type do clientDataJSON precisa ser "${tipoEsperado}"; veio ${JSON.stringify(String(cd.type)).slice(0, 40)}.`, 'tipo');
    if (cd.crossOrigin === true) throw new WebAuthnErro('O Face ID foi pedido de dentro de outro site (crossOrigin). Abra o DG Claw direto pelo endereço dele.', 'origin', 403);
    const o = typeof cd.origin === 'string' ? cd.origin.replace(/\/+$/, '') : '';
    if (!o) throw new WebAuthnErro('O clientDataJSON veio sem origin.', 'origin');
    if (o !== amb.origem || o !== d.origem) {
      throw new WebAuthnErro(`A origin ${JSON.stringify(o.slice(0, 80))} não é a deste painel (${amb.origem}). Abra o DG Claw pelo endereço oficial.`, 'origin', 403);
    }
    if (d.rpId !== amb.rpId) throw new WebAuthnErro(`O desafio foi pedido para ${d.rpId} e o pedido chegou por ${amb.rpId}.`, 'rpid', 403);
  }
  function confereAuthData(ad, rpId) {
    if (!ad.rpHash.equals(crypto.createHash('sha256').update(rpId).digest())) throw new WebAuthnErro(`O rpIdHash do autenticador não é o de ${rpId}.`, 'rpid', 403);
    if (!ad.up) throw new WebAuthnErro('O autenticador não marcou presença do usuário (UP).', 'up');
    if (!ad.uv) throw new WebAuthnErro('O aparelho não confirmou o seu rosto, digital ou código (flag UV ausente). Ative o Face ID, a digital ou o código do aparelho e tente de novo.', 'uv');
  }
  const userHandle = (titular) => crypto.createHash('sha256').update(`dgclaw-cadeado-usuario:${titular}`).digest();
  const publica = (p, aparelho) => ({
    id: p.id, nome: p.nome, alg: W.NOME_ALG[p.alg], rp_id: p.rp_id, criada_em: p.criada_em, ultimo_uso: p.ultimo_uso,
    sincronizada: !!p.sincronizada, este_aparelho: !!aparelho && p.aparelho_hash === aparelho.hash,
  });

  // ── opções, cadastro e verificação ───────────────────────────────────────
  function opcoesCadastro(req, sessao, titular, k) {
    if (falhaCarga) throw new WebAuthnErro(`Não dá para cadastrar agora: ${falhaCarga}`, 'arquivo', 503);
    const amb = ambiente(req);
    if (amb.erro) throw new WebAuthnErro(amb.erro, 'ambiente');
    const meus = passkeysDe(titular);
    if (meus.length >= PASSKEYS_POR_TITULAR) throw new WebAuthnErro(`Já há ${PASSKEYS_POR_TITULAR} aparelhos cadastrados, que é o máximo. Remova um que você não usa mais.`, 'limite', 409);
    return {
      challenge: b64u(novoDesafio('cadastro', k, amb)),
      rp: { id: amb.rpId, name: 'DG Claw' },
      user: { id: b64u(userHandle(titular)), name: String(sessao.usuario || 'usuario').slice(0, 120), displayName: String(sessao.nome || sessao.usuario || 'DG Claw').slice(0, 120) },
      pubKeyCredParams: [{ type: 'public-key', alg: W.ALG_ES256 }, { type: 'public-key', alg: W.ALG_RS256 }],
      timeout: DESAFIO_MS,
      attestation: 'none',
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred', requireResidentKey: false },
      excludeCredentials: meus.filter((p) => p.rp_id === amb.rpId).map((p) => ({ type: 'public-key', id: p.credencial_id })),
    };
  }

  function opcoesVerificacao(req, titular, k) {
    if (falhaCarga) throw new WebAuthnErro(`O Face ID não está disponível agora: ${falhaCarga}`, 'arquivo', 503);
    const amb = ambiente(req);
    if (amb.erro) throw new WebAuthnErro(amb.erro, 'ambiente');
    const pks = passkeysDe(titular).filter((p) => p.rp_id === amb.rpId);
    if (!pks.length) throw new WebAuthnErro(`Não há Face ID cadastrado para ${amb.rpId}. Entre com a senha e ative o Face ID na tela Face ID do menu.`, 'sem_passkey', 404, amb.rpId);
    return {
      challenge: b64u(novoDesafio('verificacao', k, amb)),
      rpId: amb.rpId,
      timeout: DESAFIO_MS,
      userVerification: 'required',
      allowCredentials: pks.map((p) => ({ type: 'public-key', id: p.credencial_id, transports: p.transportes && p.transportes.length ? p.transportes : ['internal', 'hybrid'] })),
    };
  }

  async function cadastra(req, sessao, titular, k, corpo) {
    const cred = credencialDe(corpo);
    const nome = limpaNome(corpo.nome).slice(0, NOME_MAX) || 'Este aparelho';
    const resp = cred.response;
    const { cd } = clientData(resp);
    const amb = ambiente(req);
    if (amb.erro) throw new WebAuthnErro(amb.erro, 'ambiente');
    const d = consomeDesafio(cd.challenge, 'cadastro', k);
    confereCliente(cd, 'webauthn.create', d, amb);
    const att = W.cborInteiro(deB64u(resp.attestationObject, 'credencial.response.attestationObject', 32 * 1024), 'attestationObject');
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnErro('O attestationObject não tem authData.', 'formato');
    const ad = W.leAuthData(att.get('authData'));
    confereAuthData(ad, d.rpId);
    if (!ad.credId || ad.cose === null) throw new WebAuthnErro('O authenticatorData não trouxe a credencial nova (flag AT).', 'formato');
    const bruto = deB64u(cred.rawId || cred.id, 'credencial.rawId', 2048);
    if (!bruto.equals(ad.credId)) throw new WebAuthnErro('O rawId não bate com o id da credencial dentro do authenticatorData.', 'formato');
    const { alg, jwk } = W.chaveDoCose(ad.cose);
    const transportes = (Array.isArray(resp.transports) ? resp.transports : []).filter((t) => typeof t === 'string' && TRANSPORTES.has(t)).slice(0, 6);
    // O aparelho que já tem cookie ligado a alguma passkey o mantém (várias passkeys e pessoas no mesmo navegador); senão nasce um novo.
    const atual = aparelhoDe(req);
    const reaproveita = atual && conf.passkeys.some((p) => p.aparelho_hash === atual.hash);
    const valor = reaproveita ? atual.valor : b64u(crypto.randomBytes(32));
    const t = relogio();
    const rec = {
      id: `pk_${sha256hex(bruto).slice(0, 12)}`, titular, credencial_id: b64u(bruto), nome, alg, jwk, sign_count: ad.contador,
      rp_id: d.rpId, transportes, sincronizada: ad.be, aparelho_hash: sha256hex(`dgclaw-cadeado-aparelho:${valor}`),
      criada_em: iso(t), ultimo_uso: iso(t),
    };
    // A marca da sessão (sessoes.json) é gravada ANTES da passkey: sem ela o cadastro não acontece e a sessão segue normal.
    const authHash = authHashDe(req);
    confereSessao(req, sessao); // a sessão pode ter vencido ou travado durante o Face ID; depois da marca, travada() já enxergaria a marca
    const antes = authHash && lerMarca ? lerMarca(authHash) : null;
    if (!(authHash && marcarSessao && marcarSessao(authHash, rec.aparelho_hash, false))) {
      log('erro', 'Cadeado: não gravei a marca da sessão no registro de sessões; a passkey não foi cadastrada.');
      throw ERRO_MARCA_CADASTRO();
    }
    try {
      await altera((c) => {
        if (c.passkeys.some((p) => p.credencial_id === rec.credencial_id)) throw new WebAuthnErro('Essa passkey já está cadastrada.', 'duplicada', 409);
        if (c.passkeys.filter((p) => p.titular === titular).length >= PASSKEYS_POR_TITULAR) throw new WebAuthnErro(`Já há ${PASSKEYS_POR_TITULAR} aparelhos cadastrados, que é o máximo.`, 'limite', 409);
        c.passkeys.push(rec);
      });
    } catch (e) {
      // a passkey não foi criada: a marca volta ao que era (nunca fica sessão travada por uma passkey que não existe)
      if (antes && desmarcarSessao) marcarSessao(authHash, antes.aparelho_hash, true);
      else if (desmarcarSessao) desmarcarSessao(authHash);
      throw e;
    }
    if (!destrava(k, titular, 'cadastro', { apHash: rec.aparelho_hash, authHash, expira: sessao.expira, manter: true })) throw ERRO_LIGACAO();
    log('info', `Cadeado: passkey cadastrada para ${titular}: "${nome}" (${rec.id}, ${W.NOME_ALG[alg]}, rp ${d.rpId}).`);
    return { passkey: publica(rec, { hash: rec.aparelho_hash }), cookie: valor };
  }

  async function verifica(req, sessao, titular, k, corpo) {
    const cred = credencialDe(corpo);
    const bruto = deB64u(cred.rawId || cred.id, 'credencial.rawId', 2048);
    const cid = b64u(bruto);
    const resp = cred.response;
    const { cdj, cd } = clientData(resp);
    const amb = ambiente(req);
    if (amb.erro) throw new WebAuthnErro(amb.erro, 'ambiente');
    const d = consomeDesafio(cd.challenge, 'verificacao', k);
    confereCliente(cd, 'webauthn.get', d, amb);
    const pk = conf.passkeys.find((p) => p.credencial_id === cid);
    if (!pk) throw new WebAuthnErro('Essa passkey não está cadastrada (pode ter sido removida). Entre com a senha e ative o Face ID de novo.', 'desconhecida', 404);
    // A passkey precisa ser de QUEM está logado: a de outra pessoa não destrava esta sessão.
    if (pk.titular !== titular) throw new WebAuthnErro('Essa passkey não é de quem está logado nesta sessão.', 'titular', 403);
    if (pk.rp_id !== d.rpId) throw new WebAuthnErro(`Essa passkey é de ${pk.rp_id}, não de ${d.rpId}.`, 'rpid', 403);
    if (resp.userHandle) {
      if (!deB64u(resp.userHandle, 'credencial.response.userHandle', 256).equals(userHandle(titular))) throw new WebAuthnErro('O userHandle da passkey não é desta conta.', 'titular', 403);
    }
    const adBruto = deB64u(resp.authenticatorData, 'credencial.response.authenticatorData', 4096);
    const ad = W.leAuthData(adBruto);
    confereAuthData(ad, d.rpId);
    const assinatura = deB64u(resp.signature, 'credencial.response.signature', 2048);
    const dados = Buffer.concat([adBruto, crypto.createHash('sha256').update(cdj).digest()]);
    if (!W.confereAssinatura(pk.alg, pk.jwk, assinatura, dados)) {
      log('aviso', `Cadeado: assinatura inválida na passkey ${pk.id} de ${titular}.`);
      throw new WebAuthnErro('A assinatura não confere com a chave cadastrada.', 'assinatura', 403);
    }
    // O contador é conferido e gravado DENTRO da fila (altera), e só depois disso a sessão destrava: se a gravação falhar, o
    // contador volta ao que era, a resposta é 500 e a sessão segue travada (a pessoa usa a senha). Assim uma cópia da chave
    // não passa por um contador que ficou para trás.
    await altera((c) => {
      const alvo = c.passkeys.find((p) => p.id === pk.id && p.titular === titular);
      if (!alvo) throw new WebAuthnErro('Essa passkey foi removida enquanto você confirmava. Entre com a senha.', 'desconhecida', 404);
      const velho = Number(alvo.sign_count) || 0;
      if ((ad.contador || velho) && ad.contador <= velho) {
        log('aviso', `Cadeado: o contador da passkey ${pk.id} de ${titular} não subiu (guardado ${velho}, veio ${ad.contador}); recusei.`);
        throw new WebAuthnErro(`O contador da passkey não subiu (guardado ${velho}, veio ${ad.contador}). Isso pode ser uma cópia da chave. Remova esta passkey e cadastre de novo.`, 'contador', 403, ad.contador);
      }
      alvo.sign_count = ad.contador;
      alvo.ultimo_uso = iso(relogio());
    });
    const ap = aparelhoDe(req);
    const authHash = authHashDe(req);
    const marca = authHash && lerMarca ? lerMarca(authHash) : null;
    let prender = ap && aparelhoLigado(req, titular) ? { apHash: ap.hash, authHash, expira: sessao.expira } : null;
    // Sessão com marca só na memória: grava de novo e exige sucesso antes de destravar.
    if (!prender && marca && marca.pendente) prender = { apHash: marca.aparelho_hash, authHash, expira: sessao.expira };
    if (!destrava(k, titular, 'faceid', prender)) throw ERRO_LIGACAO();
    return { passkey: publica(pk, aparelhoDe(req)) };
  }

  // ── resposta ─────────────────────────────────────────────────────────────
  function estadoPublico(req, sessao) {
    const titular = titularDe(sessao);
    const amb = ambiente(req);
    const ativo = ligado(req, sessao);
    const ap = aparelhoDe(req);
    return {
      ok: true, ativo, travado: travada(req, sessao), trava_min: travaMin(titular), resta_s: restaS(req, sessao),
      passkeys: passkeysDe(titular).length, neste_aparelho: !!ap && passkeysDe(titular).some((p) => p.aparelho_hash === ap.hash),
      host: amb.rpId || null, https: amb.erro ? null : amb.https, ambiente_erro: amb.erro || null, aviso: falhaCarga,
    };
  }
  function cookieAparelho(valor, req) {
    let c = `${COOKIE_APARELHO}=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_APARELHO_S}`;
    if (H.esquemaDoPedido(req, config.proxiesConfiaveis) === 'https') c += '; Secure';
    return c;
  }
  async function corpoJson(req, res, max) {
    try { return await H.lerJson(req, max); } catch (e) { H.erroJson(res, e.status || 400, e.message); return null; }
  }
  function falhou(res, e, k, ip, etapa) {
    if (!(e instanceof WebAuthnErro)) throw e;
    if (e.status < 500 && !['arquivo', 'travado', 'sessao'].includes(e.motivo)) registraFalha(k, ip);
    log('aviso', `Cadeado: ${etapa} recusado (${e.motivo}): ${e.message}`);
    return H.erroJson(res, e.status, e.message, e.recebido === undefined ? { motivo: e.motivo } : { motivo: e.motivo, recebido: e.recebido });
  }

  function docs(res) {
    try {
      const texto = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CADEADO.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(texto);
    } catch (e) {
      log('erro', `Cadeado: não consegui ler docs/CADEADO.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento do Face ID não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Trata /api/v1/cadeado/*. Devolve true se respondeu. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    const m = req.method;
    const sub = p.slice(BASE.length).replace(/\/+$/, '');
    const metodo = (usar) => H.erroJson(res, 405, `Use ${usar} em ${p}.`);
    const titular = titularDe(sessao);
    if (!titular) { H.erroJson(res, 403, 'O Face ID é da sessão de quem entrou pelo painel; a caixa dos agentes não o usa.'); return true; }
    if (sessao.trocar_senha) { H.erroJson(res, 403, 'Troque a senha temporária antes de ativar o Face ID.', { trocar_senha: true }); return true; }
    if (sub === '/docs.md') { if (m === 'GET') docs(res); else metodo('GET'); return true; }

    const k = chaveSessao(req);
    if (!k) { H.erroJson(res, 401, 'Sem sessão de login válida. Entre em /login.'); return true; }
    const ip = H.ipDoPedido(req, config.proxiesConfiaveis);
    const livreTravada = (sub === '/estado' && m === 'GET') || (sub === '/verificar/opcoes' && m === 'GET') || (sub === '/verificar' && m === 'POST');
    if (!livreTravada && travada(req, sessao)) { H.erroJson(res, 423, MSG_TRAVADO, { travado: true }); return true; }

    try {
      if (sub === '/estado') {
        if (m !== 'GET') { metodo('GET'); return true; }
        H.enviaJson(res, 200, estadoPublico(req, sessao));
        return true;
      }
      if (sub === '/uso') {
        if (m !== 'POST') { metodo('POST'); return true; }
        const ativo = ligado(req, sessao);
        if (ativo) {
          const e = estadoDe(k, titular);
          // O uso conta SEMPRE em memória (senão, com trava curta, quem está usando seria travado); só a gravação em disco
          // é limitada a uma por minuto.
          if (e) {
            e.uso = relogio();
            if (!(relogio() - (e.gravado || 0) < USO_MIN_MS)) { e.gravado = relogio(); salvaEstado(); }
          }
        }
        H.enviaJson(res, 200, { ok: true, ativo, resta_s: restaS(req, sessao), trava_min: travaMin(titular) });
        return true;
      }
      if (sub === '/cadastro/opcoes') {
        if (m !== 'GET') { metodo('GET'); return true; }
        H.enviaJson(res, 200, { ok: true, publicKey: opcoesCadastro(req, sessao, titular, k) });
        return true;
      }
      if (sub === '/cadastro') {
        if (m !== 'POST') { metodo('POST'); return true; }
        const b = espera(k, ip);
        if (b) { H.erroJson(res, 429, `Muitas tentativas recusadas. Tente de novo em ${Math.ceil(b / 60)} min.`, { retryAfter: b }, { 'Retry-After': String(b) }); return true; }
        const corpo = await corpoJson(req, res, 96 * 1024);
        if (!corpo) return true;
        try {
          confereSessao(req, sessao);
          const r = await cadastra(req, sessao, titular, k, corpo);
          // O cookie novo só chega ao navegador com esta resposta; o estado devolvido já o considera.
          const reqNovo = Object.assign(Object.create(req), { headers: Object.assign({}, req.headers, { cookie: `${COOKIE_APARELHO}=${r.cookie}; ${req.headers.cookie || ''}` }) });
          H.enviaJson(res, 201, { ok: true, passkey: r.passkey, estado: estadoPublico(reqNovo, sessao) }, { 'Set-Cookie': cookieAparelho(r.cookie, req) });
        } catch (e) { falhou(res, e, k, ip, 'cadastro'); }
        return true;
      }
      if (sub === '/verificar/opcoes') {
        if (m !== 'GET') { metodo('GET'); return true; }
        try { H.enviaJson(res, 200, { ok: true, publicKey: opcoesVerificacao(req, titular, k) }); } catch (e) { falhou(res, e, k, ip, 'pedido de desafio'); }
        return true;
      }
      if (sub === '/verificar') {
        if (m !== 'POST') { metodo('POST'); return true; }
        const b = espera(k, ip);
        if (b) { H.erroJson(res, 429, `Muitas tentativas recusadas. Tente de novo em ${Math.ceil(b / 60)} min, ou entre com a senha.`, { retryAfter: b }, { 'Retry-After': String(b) }); return true; }
        const corpo = await corpoJson(req, res, 96 * 1024);
        if (!corpo) return true;
        try {
          if (falhaCarga) throw new WebAuthnErro(`O Face ID não está disponível agora: ${falhaCarga}`, 'arquivo', 503);
          const r = await verifica(req, sessao, titular, k, corpo);
          falhas.delete(`s:${k}`);
          const cab = {};
          const ap = aparelhoDe(req);
          if (ap && r.passkey.este_aparelho) cab['Set-Cookie'] = cookieAparelho(ap.valor, req); // renova a validade do cookie
          H.enviaJson(res, 200, { ok: true, passkey: r.passkey, estado: estadoPublico(req, sessao) }, cab);
        } catch (e) { falhou(res, e, k, ip, 'Face ID'); }
        return true;
      }
      if (sub === '/passkeys') {
        if (m !== 'GET') { metodo('GET'); return true; }
        const ap = aparelhoDe(req);
        H.enviaJson(res, 200, { ok: true, passkeys: passkeysDe(titular).map((x) => publica(x, ap)), estado: estadoPublico(req, sessao) });
        return true;
      }
      const pk = /^\/passkeys\/([^/]+)$/.exec(sub);
      if (pk) {
        if (m !== 'PATCH' && m !== 'DELETE') { metodo('PATCH ou DELETE'); return true; }
        const id = pk[1];
        // A existência e o dono são conferidos de novo DENTRO da fila (altera): dois pedidos seguidos não apagam a passkey de outra pessoa.
        const sumiu = () => new WebAuthnErro(`Não existe passkey "${id.slice(0, 20)}" na sua conta. Veja as que existem em GET ${BASE}/passkeys.`, 'inexistente', 404);
        if (!RX_PASSKEY_ID.test(id)) throw sumiu();
        if (m === 'PATCH') {
          const corpo = await corpoJson(req, res, 4 * 1024);
          if (!corpo) return true;
          const nome = limpaNome(corpo.nome);
          if (!nome) { H.erroJson(res, 400, 'Mande o nome novo em JSON: {"nome": "iPhone da Maria"}.'); return true; }
          if (nome.length > NOME_MAX) { H.erroJson(res, 400, `O nome passou de ${NOME_MAX} caracteres.`, { recebido: nome.length }); return true; }
          confereSessao(req, sessao);
          const novo = await altera((c) => { confereSessao(req, sessao); const alvo = c.passkeys.find((x) => x.id === id && x.titular === titular); if (!alvo) throw sumiu(); alvo.nome = nome; return { ...alvo }; });
          H.enviaJson(res, 200, { ok: true, passkey: publica(novo, aparelhoDe(req)) });
          return true;
        }
        const r = await altera((c) => {
          confereSessao(req, sessao);
          const i = c.passkeys.findIndex((x) => x.id === id && x.titular === titular);
          if (i < 0) throw sumiu();
          const [velho] = c.passkeys.splice(i, 1);
          return { velho, resta: c.passkeys.some((x) => x.titular === titular && x.aparelho_hash === velho.aparelho_hash) };
        });
        // Aparelho sem nenhuma passkey: as sessões presas a ele caem (a de quem removeu, se for do mesmo aparelho, continua).
        const encerradas = r.resta ? 0 : soltaAparelho(titular, r.velho.aparelho_hash, k);
        log('info', `Cadeado: passkey removida de ${titular}: "${r.velho.nome}" (${id}); ${encerradas} sessão(ões) do aparelho encerrada(s).`);
        H.enviaJson(res, 200, { ok: true, removida: publica(r.velho, aparelhoDe(req)), sessoes_encerradas: encerradas, estado: estadoPublico(req, sessao) });
        return true;
      }
      if (sub === '/ajustes') {
        if (m !== 'PUT') { metodo('PUT'); return true; }
        const corpo = await corpoJson(req, res, 4 * 1024);
        if (!corpo) return true;
        const v = corpo.trava_min;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < TRAVA_LIMITES[0] || v > TRAVA_LIMITES[1]) {
          H.erroJson(res, 400, `"trava_min" precisa ser um número inteiro de minutos entre ${TRAVA_LIMITES[0]} e ${TRAVA_LIMITES[1]}.`, { recebido: typeof v === 'number' ? v : typeof v });
          return true;
        }
        confereSessao(req, sessao);
        await altera((c) => { confereSessao(req, sessao); c.ajustes[titular] = Object.assign({}, c.ajustes[titular], { trava_min: v }); });
        log('info', `Cadeado: tempo de trava de ${titular} mudou para ${v} min.`);
        H.enviaJson(res, 200, { ok: true, trava_min: v, estado: estadoPublico(req, sessao) });
        return true;
      }
    } catch (e) {
      if (e instanceof WebAuthnErro) { H.erroJson(res, e.status, e.message, e.status === 423 ? { motivo: e.motivo, travado: true } : { motivo: e.motivo }); return true; }
      throw e;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  // ── o portão: roda para toda requisição de sessão de cookie, antes de qualquer tela ou API ─
  const livreTravado = (m, p) => {
    if ((m === 'GET' || m === 'HEAD') && (p === '/cadeado' || p === '/cadeado/')) return true;
    if ((m === 'GET' || m === 'HEAD') && ehEstatico(p)) return true;
    return (m === 'GET' && (p === `${BASE}/estado` || p === `${BASE}/verificar/opcoes`)) || (m === 'POST' && p === `${BASE}/verificar`);
  };
  function gate(req, res, url, sessao) {
    if (!travada(req, sessao)) return false;
    const p = url.pathname;
    const m = req.method;
    if (livreTravado(m, p)) return false;
    const leitura = m === 'GET' || m === 'HEAD';
    const querHtml = /\btext\/html\b/.test(String(req.headers.accept || ''));
    const ehApi = p.startsWith('/api/');
    const ehPainel = p.startsWith('/p/') || p === '/p';
    if (!ehApi && leitura && (!ehPainel || querHtml)) {
      const destino = destinoSeguro(p + url.search);
      res.writeHead(302, { Location: `/cadeado?next=${encodeURIComponent(destino)}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    H.erroJson(res, 423, MSG_TRAVADO, { travado: true, destravar: '/cadeado' });
    return true;
  }

  /** Sessão nova criada com senha nasce destravada, no aparelho que já tem cadeado. */
  /** Antes de a sessão nova ser gravada: se o aparelho já tem cookie válido, a marca entra na MESMA escrita que cria a sessão. */
  function marcaParaSessaoNova({ req, colaborador }) {
    const titular = colaborador ? `colaborador:${colaborador.id}` : 'dono';
    const ap = aparelhoDe(req);
    return ap && aparelhoLigado(req, titular) ? { cadeado_exige: true, aparelho_hash: ap.hash } : null;
  }
  function aoCriarSessao({ token, req, colaborador, expira }) {
    const titular = colaborador ? `colaborador:${colaborador.id}` : 'dono';
    salvaEstado(); // a sessão nova pode ter derrubado as mais antigas da mesma pessoa no auth: limpa os registros delas
    const ap = aparelhoDe(req);
    if (!ap || !aparelhoLigado(req, titular)) return;
    destrava(sha256hex(`dgclaw-cadeado-sessao:${token}`), titular, 'senha', { apHash: ap.hash, authHash: sha256hex(token), expira, manter: true });
  }

  /** Apaga as passkeys, o tempo de trava e o estado de um titular (acesso de colaborador revogado). */
  async function removerDoTitular(titular) {
    for (const [k, v] of estados) if (v.titular === titular) estados.delete(k);
    salvaEstado();
    if (!conf.passkeys.some((p) => p.titular === titular) && !conf.ajustes[titular]) return 0;
    const n = await altera((c) => { const antes = c.passkeys.length; c.passkeys = c.passkeys.filter((p) => p.titular !== titular); delete c.ajustes[titular]; return antes - c.passkeys.length; });
    log('info', `Cadeado: ${n} passkey(s) de ${titular} apagada(s) (acesso revogado).`);
    return n;
  }
  /** Na partida: apaga o que sobrou de colaborador revogado. `vale(id)` é falso só para quem foi revogado de fato. */
  async function limpaOrfaos(vale) {
    if (falhaCarga) return;
    const ids = new Set(conf.passkeys.filter((p) => p.titular.startsWith('colaborador:')).map((p) => p.titular.slice(12)));
    for (const id of ids) if (!vale(id)) await removerDoTitular(`colaborador:${id}`);
  }

  return {
    rotas, gate, travada, ligado, livreTravado, aoCriarSessao, marcaParaSessaoNova, removerDoTitular, limpaOrfaos, destinoSeguro,
    get falhaCarga() { return falhaCarga; },
    aguardar() { return Promise.all([gravConf.aguardar(), gravEstado.aguardar(), fila]); },
  };
}

module.exports = { criarCadeado, destinoSeguro, COOKIE_APARELHO, MSG_TRAVADO };
