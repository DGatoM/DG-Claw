'use strict';
// A conversa de um agente que roda com o motor Codex.
//
// O Codex não grava o transcript do Claude: grava um "rollout"
// (<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<data>-<sessionId>.jsonl), uma linha JSON por
// registro, com `timestamp`, `type` e `payload`. Este módulo acha esse arquivo e o traduz para
// as MESMAS mensagens que o leitor do Claude (thread.js) entrega à tela.
//
// O que conta como mensagem:
//   - fala do dono: mensagem `user` com o envelope <dgchat ...> (só o corpo aparece) ou, pelo
//     WhatsApp, <canal-externo origem="whatsapp" ...>;
//   - fala do agente: chamada da tool dgchat `reply` (texto) ou `send_file` (mídia), ou `whatsapp_reply` /
//     `whatsapp_send_file` (via "whatsapp", e contam como tool de envio para a regra de duplicata). No rollout
//     ela é o registro `event_msg` / `item_completed` com item `McpToolCall` (server "dgchat"),
//     porque o Codex chama a tool por dentro de um `exec` e não grava um `function_call` com o nome;
//   - regra de duplicata, POR TURNO (do envelope do dono até o próximo): se o turno chamou
//     reply/send_file, só essas chamadas contam; se não chamou nenhuma, vale a ÚLTIMA mensagem do
//     assistente (o texto final). O texto final só aparece quando o turno acaba (task_complete,
//     task_aborted ou turn_aborted), ou quando começa o turno seguinte, para não mostrar rascunho.
// O que some: contexto injetado (AGENTS.md, environment_context...), mensagem `user` sem envelope
// que comece com <plataforma , o texto dos turnos de rotina (só as chamadas de tool deles contam),
// e a linha truncada no fim do arquivo (o CLI está escrevendo).

const fs = require('node:fs');
const path = require('node:path');
const { criarMontagem, lerIncremental, parseDgchat, parseCanalExterno, paraHost } = require('./thread');
const { descreveUso } = require('./trilha');

const CONTEXTO_INJETADO = ['<environment_context>', '<user_instructions>', '# AGENTS.md'];
const POKE = /\/tmp\/dgclaw-poke-([a-zA-Z0-9_.-]+?)-\d{8}-\d{6}\.txt/;
const RX_SESSAO = /^[0-9a-fA-F-]{8,64}$/;
const ROLLOUT_NOME = /^rollout-.*\.jsonl$/i;
const FIM_DE_TURNO = new Set(['task_complete', 'task_aborted', 'turn_aborted']);
const TOOLS = { reply: false, send_file: true, whatsapp_reply: false, whatsapp_send_file: true }; // nome da tool -> é arquivo?
const TOOLS_WHATSAPP = new Set(['whatsapp_reply', 'whatsapp_send_file']);

/** Os blocos de texto de uma mensagem do rollout (input_text / output_text). */
function textoDoRollout(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('');
}

function ehRollout(caminho) {
  return ROLLOUT_NOME.test(path.basename(String(caminho || '')));
}

// ── achar o arquivo ────────────────────────────────────────────────────────

/** realpath ou null (não existe, laço de atalhos, sem permissão). */
function realOuNull(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }

/** `alvo` e `raiz` já com realpath: o alvo é a raiz ou está dentro dela? */
function dentroDe(raiz, alvo) {
  const rel = path.relative(raiz, alvo);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Confere, com realpath, que `arquivo` fica dentro de `raiz`. Atalho para fora é recusado.
 * Devolve { real } ou { erro } (o erro diz o que foi recusado, o caminho recebido, o real e que nada foi lido).
 */
function confinar(arquivo, raiz, que) {
  const rr = realOuNull(raiz);
  if (!rr) return { erro: `Recusei ${que}: não consegui resolver a raiz ${raiz} (realpath). Caminho recebido: ${arquivo}. Nada foi lido.` };
  const real = realOuNull(arquivo);
  if (!real) return { erro: `Recusei ${que}: não consegui resolver ${arquivo} (realpath). Nada foi lido.` };
  if (!dentroDe(rr, real)) return { erro: `Recusei ${que}: o caminho recebido (${arquivo}) aponta, por atalho, para ${real}, que cai fora de ${rr}. Nada foi lido.` };
  return { real };
}

/** Procura `rollout-*-<sessionId>.jsonl` sob `<codexHome>/sessions/AAAA/MM/DD`, da pasta mais nova para a mais antiga. */
function acharNoCodexHome(codexHome, sessionId, recusados, raizReal) {
  const sufixo = `-${sessionId.toLowerCase()}.jsonl`;
  const raiz = path.join(codexHome, 'sessions');
  if (raizReal) {
    // a pasta sessions (e tudo acima dela) pode ser atalho: confere antes de procurar
    if (!realOuNull(raiz)) return null; // não existe
    const c = confinar(raiz, raizReal, 'a pasta de sessões do Codex');
    if (c.erro) { recusados.push(c.erro); return null; }
  }
  const ler = (dir, re) => {
    try { return fs.readdirSync(dir).filter((d) => re.test(d)).sort().reverse(); } catch (_) { return []; }
  };
  for (const ano of ler(raiz, /^\d{4}$/)) {
    for (const mes of ler(path.join(raiz, ano), /^\d{2}$/)) {
      for (const dia of ler(path.join(raiz, ano, mes), /^\d{2}$/)) {
        const pasta = path.join(raiz, ano, mes, dia);
        let nomes = [];
        try { nomes = fs.readdirSync(pasta); } catch (_) { continue; }
        const f = nomes.find((n) => ROLLOUT_NOME.test(n) && n.toLowerCase().endsWith(sufixo));
        if (f) {
          const cand = path.join(pasta, f);
          if (!raizReal) return cand;
          const c = confinar(cand, raizReal, 'o registro Codex');
          if (c.erro) { recusados.push(c.erro); continue; }
          return c.real;
        }
      }
    }
  }
  return null;
}

/** Traduz o CODEX_HOME visto de dentro do container para o do host. Devolve { dir } ou { erro }. */
function codexHomeNoHost(agente, codexHome) {
  const home = agente.home_host && path.resolve(agente.home_host);
  if (!home) return { erro: `O runner informou o CODEX_HOME ${codexHome}, mas o registro de ${agente.nome} não tem home_host para eu traduzir esse caminho.` };
  const dir = path.resolve(paraHost(codexHome, agente));
  if (dir !== home && !dir.startsWith(home + path.sep)) {
    return { erro: `O CODEX_HOME que o runner informou (${codexHome}) cai fora da casa do agente (${home}). Recusei por segurança e não li nada dali.` };
  }
  if (!realOuNull(dir)) return { dir }; // não existe: não há o que ler, o aviso de "não achei" cobre
  const c = confinar(dir, agente.home_host, 'o CODEX_HOME informado pelo runner');
  if (c.erro) return { erro: c.erro };
  return { dir: c.real };
}

/**
 * Acha o rollout de uma sessão. Com `codexHome` (de dentro do container, vindo do runner) lê só
 * ali; sem ele tenta, na ordem, <home_host>/.plataforma/codex-api/<id>/ e <home_host>/.codex.
 * Devolve { arquivo, procurados, erro }: `procurados` lista o que foi olhado, para o aviso.
 */
function acharRollout(agente, sessionId, codexHome) {
  const procurados = [];
  const recusados = [];
  if (!RX_SESSAO.test(sessionId)) return { arquivo: null, procurados, erro: `O id da sessão (${String(sessionId).slice(0, 40)}) não parece um id do Codex.` };
  const homes = [];
  if (typeof codexHome === 'string' && codexHome.trim()) {
    const t = codexHomeNoHost(agente, codexHome.trim());
    if (t.erro) return { arquivo: null, procurados, erro: t.erro };
    homes.push(t.dir);
  } else {
    if (!agente.home_host) return { arquivo: null, procurados, erro: `O registro de ${agente.nome} não tem home_host, então não sei onde ficam os rollouts do Codex.` };
    const base = path.resolve(agente.home_host);
    try {
      const api = path.join(base, '.plataforma', 'codex-api');
      for (const d of fs.readdirSync(api, { withFileTypes: true })) if (d.isDirectory()) homes.push(path.join(api, d.name));
    } catch (_) { /* sem pasta codex-api: o agente não está no modo api */ }
    homes.push(path.join(base, '.codex'));
  }
  const casaReal = realOuNull(agente.home_host);
  if (!casaReal) return { arquivo: null, procurados, erro: `Não consegui resolver (realpath) a casa do agente ${agente.nome} (${agente.home_host}). Nada foi lido.` };
  for (const h of homes) {
    procurados.push(path.join(h, 'sessions'));
    const f = acharNoCodexHome(h, sessionId, recusados, casaReal);
    if (f) return { arquivo: f, procurados };
  }
  if (recusados.length) return { arquivo: null, procurados, erro: recusados.join(' ') };
  if (!procurados.length) procurados.push('(nenhuma pasta)');
  return { arquivo: null, procurados };
}

// ── ler o rollout ──────────────────────────────────────────────────────────

/** Argumentos da chamada de tool: objeto, ou texto JSON. */
function argumentosDe(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') { try { const o = JSON.parse(a); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }
  return {};
}

function criarLeitorRollout({ log, tz, midia }) {
  const estados = new Map();
  const m = criarMontagem({ tz, midia });

  function novoEstado() {
    return {
      trilhaPend: new Map(), // call_id -> { ep, uso }: comandos do Codex ainda sem saída
      offset: 0, ino: null, eventos: [], versao: 0, ultimoEp: 0, msgsVistas: new Set(), restoParcial: Buffer.alloc(0),
      turno: null,        // { dono, origin, temChamada, final: {ep,text}|null }
      chatCorrente: '',
      temSinalDeTurno: false,
    };
  }

  /** Solta o texto final do turno, se ele vale: turno do dono, sem chamada de tool. */
  function soltaFinal(estado, agente) {
    const t = estado.turno;
    if (!t || !t.final) return;
    const f = t.final;
    t.final = null;
    if (!t.dono || t.temChamada) return;
    m.empurra(estado, agente, { ep: f.ep, origin: 'agente', text: f.text, caminhos: [], via: 'plataforma', quem: 'agente' });
  }

  const NOMES_SHELL = new Set(['shell', 'exec_command', 'shell_command', 'local_shell', 'container.exec']);
  function trilhaCodex(estado, p, ep) {
    if (p.type === 'function_call') {
      if (!NOMES_SHELL.has(p.name) || typeof p.call_id !== 'string') return;
      const a = argumentosDe(p.arguments);
      const cmd = Array.isArray(a.command) ? a.command.join(' ') : String(a.command || a.cmd || '');
      const uso = descreveUso('Bash', { command: cmd });
      if (uso) estado.trilhaPend.set(p.call_id, { ep, uso });
      return;
    }
    estado.trilhaPend.delete(p.call_id);
    // Resolvido: só sai do Map. Não vira item no histórico (a atividade fica na barrinha de status).
  }

  function abreTurno(estado, agente, dono, origin) {
    soltaFinal(estado, agente); // o turno anterior acabou, mesmo sem sinal de fim
    estado.turno = { dono, origin, temChamada: false, final: null };
  }

  function processaLinha(estado, agente, linha) {
    // Pré-filtro barato: o session_meta, o world_state e as saídas de ferramenta são gigantes e não interessam.
    if (!/"type":"(response_item|event_msg)"/.test(linha.slice(0, 200))) return;
    if (!/"role":"(user|assistant)"|"McpToolCall"|"task_started"|"task_complete"|"task_aborted"|"turn_aborted"|"function_call/.test(linha)) return;
    let o;
    try { o = JSON.parse(linha); } catch (_) { return; } // linha truncada: o CLI ainda está escrevendo
    const p = o && o.payload;
    if (!p || typeof p !== 'object') return;

    // Trilha de comandos (melhor esforço: o formato da chamada de shell do Codex varia entre versões).
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'function_call_output')) {
      trilhaCodex(estado, p, m.epDe(o.timestamp, estado));
      return;
    }

    if (o.type === 'event_msg') {
      if (p.type === 'task_started') { estado.temSinalDeTurno = true; return; } // este CLI avisa quando o turno acaba
      if (FIM_DE_TURNO.has(p.type)) {
        estado.temSinalDeTurno = true;
        soltaFinal(estado, agente);
        return;
      }
      const it = p.type === 'item_completed' ? p.item : null;
      if (!it || it.type !== 'McpToolCall' || String(it.server || '').toLowerCase() !== 'dgchat') return;
      if (!Object.hasOwn(TOOLS, it.tool)) return;
      if (it.status && it.status !== 'completed') return; // a entrega falhou: não chegou à pessoa
      const inp = argumentosDe(it.arguments);
      if (estado.turno) estado.turno.temChamada = true;
      const origin = estado.turno && estado.turno.origin === 'rotina' ? 'rotina' : 'agente';
      if (TOOLS_WHATSAPP.has(it.tool)) { // o WhatsApp não tem chat do painel: não passa pela conferência de conversa
        m.empurraAgenteWhatsapp(estado, agente, { ep: m.epDe(o.timestamp, estado), origin, arquivo: TOOLS[it.tool], inp });
        return;
      }
      const chat = inp.chat || estado.chatCorrente || agente.chat_id;
      if (chat !== agente.chat_id) return;
      m.empurraAgente(estado, agente, { ep: m.epDe(o.timestamp, estado), origin, arquivo: TOOLS[it.tool], inp });
      return;
    }

    if (o.type !== 'response_item' || p.type !== 'message') return;
    const txt = textoDoRollout(p.content).trim();
    if (!txt) return;

    if (p.role === 'user') {
      if (CONTEXTO_INJETADO.some((c) => txt.startsWith(c))) return;
      const dg = parseDgchat(txt);
      if (dg) {
        estado.chatCorrente = dg.attrs.chat;
        abreTurno(estado, agente, dg.attrs.chat === agente.chat_id, 'dono');
        if (dg.attrs.chat !== agente.chat_id) return;
        if (dg.attrs.msg) {
          if (estado.msgsVistas.has(dg.attrs.msg)) return;
          estado.msgsVistas.add(dg.attrs.msg);
        }
        m.empurraDono(estado, agente, dg, m.epDe(o.timestamp, estado));
        return;
      }
      const ce = parseCanalExterno(txt);
      if (ce) {
        abreTurno(estado, agente, true, 'dono');
        if (ce.attrs.msg) {
          const k = 'wa:' + ce.attrs.msg;
          if (estado.msgsVistas.has(k)) return;
          estado.msgsVistas.add(k);
        }
        m.empurraDonoWhatsapp(estado, agente, ce, m.epDe(o.timestamp, estado));
        return;
      }
      if (txt.startsWith('<plataforma ') || POKE.test(txt)) abreTurno(estado, agente, false, 'rotina');
      return;
    }

    if (p.role === 'assistant') {
      if (!estado.turno || !estado.turno.dono) return;
      if (p.phase === 'commentary') return; // rascunho no meio do turno
      estado.turno.final = { ep: m.epDe(o.timestamp, estado), text: txt };
    }
  }

  /** Rollout sem nenhum sinal de turno (CLI antigo): mostra a última fala do assistente mesmo assim. */
  function aoFimDaLeitura(estado, agente) {
    if (!estado.temSinalDeTurno) soltaFinal(estado, agente);
  }

  /** Lê o que cresceu no rollout. Devolve { eventos, versao } (eventos é a MESMA lista, só cresce). */
  function ler(caminho, agente) {
    return lerIncremental({
      estados, caminho, agente, novoEstado,
      processaLinha: (estado, linha) => processaLinha(estado, agente, linha),
      aoFimDaLeitura: (estado) => aoFimDaLeitura(estado, agente),
    });
  }

  function pendente(caminho, slug) {
    const estado = estados.get(`${slug}|${caminho}`);
    if (!estado || !estado.trilhaPend.size) return null;
    let ultimo = null;
    for (const x of estado.trilhaPend.values()) if (!ultimo || x.ep >= ultimo.ep) ultimo = x;
    return ultimo ? { ferramenta: ultimo.uso.ferramenta, titulo: ultimo.uso.titulo, comando: ultimo.uso.comando } : null;
  }

  return { ler, pendente, esquece(caminho, slug) { estados.delete(`${slug}|${caminho}`); } };
}

module.exports = { criarLeitorRollout, acharRollout, ehRollout, confinar, textoDoRollout };
