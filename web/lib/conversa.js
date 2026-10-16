'use strict';
// A conversa de um agente: achar o transcript da sessão principal, montar a thread,
// calcular a atividade, enviar mensagens (envelope) e o rótulo do provedor.

const fs = require('node:fs');
const path = require('node:path');
const { paraContainer } = require('./thread');
const { criaInterceptor } = require('./token-telegram');
const { acharRollout, ehRollout, confinar } = require('./rollout');

const RX_SESSION = /^[A-Za-z0-9_-]{8,80}$/;
const TTL_RUNNER_MS = 2000;
const TTL_ROTULO_MS = 60 * 1000;
const TTL_ENVIO_MS = 60 * 60 * 1000;
const MAX_ENVIOS = 2000;
const RX_CLIENTE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ANEXOS = 10;

/**
 * O envelope de entrada. Mesmo formato do panel/lib/conversa.js (montarEnvelope):
 * o agente, o hook de cobrança e o extrator de thread dependem de ele ser exatamente este.
 */
function montarEnvelope({ from, chat, msg, ts, text }) {
  const atributo = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();
  // Quem digitasse "</dgchat>" fecharia o envelope no meio: escapa, como se escapa HTML.
  const corpo = String(text == null ? '' : text).replace(/<\/dgchat>/gi, '<\\/dgchat>');
  return `<dgchat from="${atributo(from) || 'pessoa'}" chat="${atributo(chat)}" msg="${atributo(msg)}" ts="${atributo(ts)}">${corpo}</dgchat>`;
}

function criarConversa({ config, runner, leitor, leitorRollout, midia, log, agora, gravaToken }) {
  const tokenTelegram = criaInterceptor({ gravaToken });
  const relogio = agora || (() => Date.now());
  const estadoRunner = new Map();   // slug -> { ts, promessa, valor }
  const arquivoPorSessao = new Map(); // `${slug}|${sessionId}` -> caminho
  const rolloutPorSessao = new Map(); // `${slug}|${sessionId}` -> rollout do Codex
  const ultimoArquivo = new Map();  // slug -> caminho (para quando o runner some)
  const atividadeAnterior = new Map(); // slug -> { chave, desde }
  const rotulos = new Map();        // slug -> { ts, valor }
  const envios = new Map();         // chave -> { promessa, ts }
  const logUmaVez = new Map();      // chave -> último motivo

  function avisaUmaVez(chave, nivel, msg) {
    if (logUmaVez.get(chave) === msg) return;
    logUmaVez.set(chave, msg);
    log(nivel, msg);
  }
  function esquece(chave) { logUmaVez.delete(chave); }

  // ── estado do runner, com cache de 2 s e uma chamada só por vez ──────────
  function estado(agente) {
    const c = estadoRunner.get(agente.slug);
    if (c && relogio() - c.ts < TTL_RUNNER_MS) return c.promessa;
    const promessa = runner.estado(agente).then((r) => {
      if (r.ok) esquece(`runner|${agente.slug}`); else avisaUmaVez(`runner|${agente.slug}`, 'aviso', `Runner de ${agente.nome}: ${r.erro}`);
      return r;
    });
    estadoRunner.set(agente.slug, { ts: relogio(), promessa });
    return promessa;
  }

  // ── achar o .jsonl ───────────────────────────────────────────────────────
  function achaPorSessao(agente, sessionId) {
    if (!agente.transcripts_dir || !RX_SESSION.test(sessionId)) return null;
    const chave = `${agente.slug}|${sessionId}`;
    const guardado = arquivoPorSessao.get(chave);
    if (guardado && fs.existsSync(guardado)) return guardado;
    const direto = path.join(agente.transcripts_dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direto)) { arquivoPorSessao.set(chave, direto); return direto; }
    let pastas = [];
    try { pastas = fs.readdirSync(agente.transcripts_dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const p of pastas) {
      if (!p.isDirectory()) continue;
      const cand = path.join(agente.transcripts_dir, p.name, `${sessionId}.jsonl`);
      if (fs.existsSync(cand)) { arquivoPorSessao.set(chave, cand); return cand; }
    }
    return null;
  }

  function maisRecente(agente) {
    if (!agente.transcripts_dir) return null;
    let melhor = null; let mt = -1;
    const olha = (dir) => {
      let nomes = [];
      try { nomes = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const n of nomes) {
        if (!n.isFile() || !n.name.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(dir, n.name)); if (st.mtimeMs > mt) { mt = st.mtimeMs; melhor = path.join(dir, n.name); } } catch (_) { /* some entre o readdir e o stat */ }
      }
    };
    olha(agente.transcripts_dir);
    try {
      for (const p of fs.readdirSync(agente.transcripts_dir, { withFileTypes: true })) if (p.isDirectory()) olha(path.join(agente.transcripts_dir, p.name));
    } catch (_) { /* pasta ausente: devolve null */ }
    return melhor;
  }

  /** Codex: o rollout da sessão. Cache por sessão. Devolve { arquivo, procurados, erro }. */
  function achaRolloutDaSessao(agente, sessionId, codexHome) {
    const chave = `${agente.slug}|${sessionId}`;
    const guardado = rolloutPorSessao.get(chave);
    if (guardado && fs.existsSync(guardado)) return { arquivo: guardado, procurados: [] };
    const r = acharRollout(agente, sessionId, codexHome);
    if (r.arquivo) rolloutPorSessao.set(chave, r.arquivo);
    return r;
  }

  /** { msgs, versao, avisos } da thread do agente. Nunca lança: problema vira aviso. */
  async function thread(agente) {
    const avisos = [];
    const r = await estado(agente);
    let arquivo = null;
    if (r.ok && r.estado.sessionId) {
      const sid = String(r.estado.sessionId);
      const codexHome = typeof r.estado.codexHome === 'string' && r.estado.codexHome.trim() ? r.estado.codexHome.trim() : null;
      // Com codexHome o motor é o Codex. Sem ele, o transcript do Claude vem primeiro e o rollout é a segunda chance.
      if (!codexHome) arquivo = achaPorSessao(agente, sid);
      let rol = null;
      if (!arquivo) {
        rol = achaRolloutDaSessao(agente, sid, codexHome);
        arquivo = rol.arquivo;
      }
      if (!arquivo) {
        const onde = agente.transcripts_dir || '(transcripts_dir não configurado)';
        let motivo;
        if (rol && rol.erro) motivo = `Não consegui localizar o registro Codex da sessão ${sid}: ${rol.erro}`;
        else if (codexHome) motivo = `Não achei o registro Codex da sessão ${sid}. Procurei em ${rol.procurados.join(', ')}.`;
        else motivo = `Não achei o registro da sessão ${sid} em ${onde}.${rol && rol.procurados.length ? ` Também procurei o rollout do Codex em ${rol.procurados.join(', ')}.` : ''}`;
        avisos.push(motivo);
        avisaUmaVez(`arq|${agente.slug}`, 'aviso', `Thread de ${agente.nome}: o runner diz que a sessão é ${sid}, mas ${motivo.charAt(0).toLowerCase()}${motivo.slice(1)} Confira transcripts_dir e home_host no registro de agentes.`);
      } else esquece(`arq|${agente.slug}`);
    } else if (!r.ok) {
      avisos.push(`O runner não respondeu (${r.erro}). Mostro a última conversa conhecida.`);
    }
    if (!arquivo) arquivo = ultimoArquivo.get(agente.slug) || (r.ok && !r.estado.sessionId ? maisRecente(agente) : null) || (!r.ok ? maisRecente(agente) : null);
    if (!arquivo) return { msgs: [], versao: 0, avisos, arquivo: null };
    // Última guarda: o arquivo final, com realpath, precisa ficar dentro da raiz (atalho para fora é recusado).
    const eRollout = ehRollout(arquivo);
    {
      const raiz = eRollout ? agente.home_host : agente.transcripts_dir;
      const c = raiz ? confinar(arquivo, raiz, eRollout ? 'o registro Codex' : 'o transcript do Claude') : { erro: `Recusei ler ${arquivo}: o registro de ${agente.nome} não tem ${eRollout ? 'home_host' : 'transcripts_dir'} para conferir. Nada foi lido.` };
      if (c.erro) {
        avisos.push(c.erro);
        avisaUmaVez(`conf|${agente.slug}`, 'aviso', `Thread de ${agente.nome}: ${c.erro}`);
        ultimoArquivo.delete(agente.slug);
        return { msgs: [], versao: 0, avisos, arquivo: null };
      }
      arquivo = c.real;
    }
    ultimoArquivo.set(agente.slug, arquivo);
    try {
      const fonte = eRollout && leitorRollout ? leitorRollout : leitor;
      const { eventos, versao } = fonte.ler(arquivo, agente);
      return { msgs: eventos, versao, avisos, arquivo };
    } catch (e) {
      log('erro', `Thread de ${agente.nome}: falhou ao ler ${arquivo}: ${e.message}`);
      avisos.push(`Não consegui ler a conversa: ${e.message}`);
      return { msgs: [], versao: 0, avisos, arquivo };
    }
  }

  // ── atividade ────────────────────────────────────────────────────────────
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

  async function atividade(agente) {
    const r = await estado(agente);
    const agoraMs = relogio();
    let est;
    if (!r.ok) {
      est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: null, alerta: null, motivo: r.erro };
    } else {
      const e = r.estado;
      const ultimo = typeof e.updatedAt === 'number' ? iso(e.updatedAt) : null;
      if (e.status === 'working') {
        est = { estado: 'trabalhando', acao: e.currentTool || 'pensando', detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: null };
      } else if (e.status === 'waiting_input') {
        est = { estado: 'trabalhando', acao: e.currentTool || 'aguardando permissão', detalhe: null, ultimo_sinal: ultimo, alerta: 'permissao', motivo: null };
      } else if (e.status === 'idle') {
        est = { estado: 'ocioso', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: null };
      } else {
        est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: `O runner informa o status "${e.status}" para ${agente.nome}, então não sei se ele está trabalhando.` };
      }
    }
    const chave = `${est.estado}|${est.acao}|${est.alerta}`;
    const ant = atividadeAnterior.get(agente.slug);
    const desde = ant && ant.chave === chave ? ant.desde : iso(agoraMs);
    atividadeAnterior.set(agente.slug, { chave, desde });
    est.desde = est.estado === 'ocioso' ? null : desde;
    return est;
  }

  // ── rótulo do provedor (cache de 60 s, 1,5 s de espera, reserva do registro) ─
  function reservaDoRotulo(agente) {
    return [agente.provedor, agente.modelo].filter(Boolean).join(', ');
  }
  async function rotuloProvedor(agente) {
    const c = rotulos.get(agente.slug);
    if (c && relogio() - c.ts < TTL_ROTULO_MS) return c.valor;
    const espera = new Promise((resolve) => { setTimeout(() => resolve({ ok: false, erro: 'demorou mais de 1,5 s' }), 1500).unref(); });
    let r;
    try {
      r = await Promise.race([runner.provedor(agente, 1500), espera]);
    } catch (e) {
      r = { ok: false, erro: e.message };
    }
    let valor;
    if (r.ok && typeof r.dados.rotulo === 'string' && r.dados.rotulo.trim()) {
      valor = r.dados.rotulo.trim();
      esquece(`rotulo|${agente.slug}`);
    } else {
      valor = reservaDoRotulo(agente);
      const motivo = r.ok ? 'a resposta não trouxe o campo "rotulo"' : r.erro;
      avisaUmaVez(`rotulo|${agente.slug}`, 'aviso', `Rótulo do provedor de ${agente.nome}: ${motivo}. Uso a reserva do registro de agentes ("${valor}").`);
    }
    rotulos.set(agente.slug, { ts: relogio(), valor });
    return valor;
  }

  // ── idempotência por cliente_id (em memória, com validade) ───────────────
  async function umaVez(agente, rota, clienteId, faz) {
    if (!clienteId) return faz();
    const chave = `${agente.slug}|${rota}|${clienteId}`;
    const t = relogio();
    for (const [k, e] of envios) if (e.pronto && t - e.ts > TTL_ENVIO_MS) envios.delete(k);
    while (envios.size > MAX_ENVIOS) envios.delete(envios.keys().next().value);
    const existente = envios.get(chave);
    if (existente) {
      let espera;
      const limite = new Promise((resolve) => { espera = setTimeout(() => resolve('tempo'), 30000); espera.unref(); });
      const r = await Promise.race([existente.promessa, limite]);
      clearTimeout(espera);
      if (r === 'tempo') {
        return { status: 409, corpo: { ok: false, erro: `Já existe um envio com o cliente_id ${clienteId} em andamento há mais de 30 s e ele ainda não respondeu. Não mandei de novo para não duplicar: confira a conversa antes de tentar outra vez.`, cliente_id: clienteId } };
      }
      if (r && r.status < 300) {
        log('info', `${rota} repetido para ${agente.slug} (cliente_id ${clienteId}): devolvi a resposta do envio que já tinha saído.`);
        return { status: r.status, corpo: Object.assign({}, r.corpo, { repetido: true }) };
      }
      // o original falhou: segue e tenta de novo
    }
    const promessa = Promise.resolve().then(faz);
    const entrada = { promessa, ts: t, pronto: false };
    envios.set(chave, entrada);
    try {
      const r = await promessa;
      entrada.pronto = true;
      entrada.ts = relogio();
      if (r.status >= 300) envios.delete(chave);
      return r;
    } catch (e) {
      envios.delete(chave);
      throw e;
    }
  }

  // ── enviar ───────────────────────────────────────────────────────────────
  let sequencia = 0;
  const erro = (status, motivo, extra) => ({ status, corpo: Object.assign({ ok: false, erro: motivo }, extra || {}) });

  /** Entrega o texto (já com marcadores de anexo) ao agente. Devolve { status, corpo }. */
  async function entregar(agente, textoFinal, { cru }) {
    sequencia += 1;
    const payload = cru
      ? textoFinal
      : montarEnvelope({ from: 'pessoa', chat: agente.chat_id, msg: `w${relogio().toString(36)}${sequencia}`, ts: new Date(relogio()).toISOString(), text: textoFinal });
    const epEnviado = relogio() / 1000 - 2;
    const r = await runner.input(agente, { text: payload, submit: true, injectWhenIdle: true });
    if (!r.ok) {
      log('erro', `Envio para ${agente.slug} não entregue (${cru ? 'comando cru' : `${textoFinal.length} caracteres`}): ${r.erro}`);
      return erro(r.status === 409 ? 409 : 502, `Não consegui entregar a mensagem a ${agente.nome}: ${r.erro}`);
    }
    log('info', `Mensagem entregue a ${agente.slug} (${cru ? 'comando cru' : `${textoFinal.length} caracteres`}).`);
    return { status: 200, corpo: { ok: true, ep_enviado: epEnviado, agente: agente.slug } };
  }

  async function enviar(agente, req) {
    const texto = typeof req.text === 'string' ? req.text.trim() : '';
    const ids = req.anexos == null ? [] : req.anexos;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && i)) {
      return erro(400, `"anexos" precisa ser a lista dos ids devolvidos por /upload com enviar=0 (anexo.id). Recebi: ${JSON.stringify(ids).slice(0, 200)}.`);
    }
    if (ids.length > MAX_ANEXOS) return erro(413, `Vieram ${ids.length} anexos e o limite é ${MAX_ANEXOS} por mensagem. Mande o resto em outra.`);
    if (new Set(ids).size !== ids.length) return erro(400, 'Há ids repetidos em "anexos". Cada arquivo entra uma vez só.');
    if (!texto && !ids.length) return erro(400, 'Mande o texto em "text" (ou os ids dos arquivos em "anexos"). Recebi vazio.');
    // Token do BotFather colado sozinho: vai para o .env do agente e nunca para o runner.
    if (!ids.length && tokenTelegram.ehToken(texto)) {
      const g = await tokenTelegram.guardar(agente, texto);
      if (g.erro) {
        log('aviso', `Token do Telegram colado na conversa de ${agente.slug} não foi guardado: ${g.erro.corpo.erro}`);
        return g.erro;
      }
      const r = await entregar(agente, g.marca, { cru: false });
      if (r.status >= 300) return r;
      log('info', `Token do Telegram de ${agente.slug} guardado no .env do agente (${g.mascarado}).`);
      return { status: 200, corpo: Object.assign({}, r.corpo, { token_guardado: true, mascarado: g.mascarado, marca: g.marca }) };
    }
    if (texto.length > config.maxTexto) return erro(413, `O texto tem ${texto.length} caracteres e o limite é ${config.maxTexto} por mensagem. Divida em partes.`);
    const marcadores = []; const faltam = [];
    for (const id of ids) {
      const e = midia.obter(id);
      if (!e || e.slug !== agente.slug) { faltam.push(id); continue; }
      marcadores.push(`[anexo: ${paraContainer(e.path, agente)}]`);
    }
    if (faltam.length) {
      return erro(404, `Não achei o anexo ${faltam.join(', ')} entre os arquivos de ${agente.nome}. Suba o arquivo de novo em /upload (enviar=0) e use o anexo.id que voltar. Nada foi enviado.`, { anexos_faltando: faltam });
    }
    // Admin: texto que começa com "/" (ex.: /compact, /clear) vai CRU, sem envelope.
    const cru = agente.tipo === 'admin' && !ids.length && texto.startsWith('/');
    const final = cru ? texto : [texto, ...marcadores].filter(Boolean).join('\n');
    return entregar(agente, final, { cru });
  }

  return {
    montarEnvelope, estado, thread, atividade, rotuloProvedor, umaVez, enviar, entregar,
    RX_CLIENTE_ID,
  };
}

module.exports = { criarConversa, montarEnvelope, RX_CLIENTE_ID };
