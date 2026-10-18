'use strict';
// Montagem da thread a partir do transcript (.jsonl) da sessão principal do agente.
// Porta do scripts/_lib/thread_log.py, com leitura INCREMENTAL: cada arquivo guarda o
// offset já lido e só o que cresceu é processado a cada chamada.
//
// O que conta como mensagem:
//   - fala do dono: turno `user` com o envelope <dgchat from chat msg ts>texto</dgchat>
//     (só o corpo aparece), com o Telegram ligado, <channel source="plugin:telegram...">, ou,
//     com o WhatsApp ligado, <canal-externo origem="whatsapp" de="+55..." msg ts>corpo escapado</canal-externo>;
//   - fala do agente: tool_use cujo nome termina em __dgchat__reply (texto) ou
//     __dgchat__send_file (mídia), __telegram__reply (com via:"telegram"), __whatsapp_reply (texto)
//     ou __whatsapp_send_file (mídia), ambas com via:"whatsapp".
//     Texto solto do assistente NÃO conta.
// O que some: <plataforma ...>, system-reminder, tool_result, eco de comando, poke de cron,
// recado do sistema (Stop hook feedback, interrupções).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { marcar } = require('./alertas');
const { descreveUso } = require('./trilha');

const DGCHAT_ABRE = /<dgchat\b[^>]*>/;
const DGCHAT_ATTR = /\b(from|chat|msg|ts)="([^"]*)"/g;
const DGCHAT_FECHA = '</dgchat>';
const TOOL_TEXTO = '__dgchat__reply';
const TOOL_ARQUIVO = '__dgchat__send_file';
const TOOL_TELEGRAM = 'telegram__reply';
const TOOL_WA_TEXTO = '__whatsapp_reply';
const TOOL_WA_ARQUIVO = '__whatsapp_send_file';
const EXTERNO_ABRE = /^<canal-externo\b([^>]*)>/;
const EXTERNO_ATTR = /\b(origem|de|msg|ts)="([^"]*)"/g;
const EXTERNO_FECHA = /<\/canal-externo>\s*$/;
// Só o formato exato que a ponte grava vira anexo. Quem escreve no WhatsApp pode digitar
// "[imagem salvo em /home/agente/.claude/...]" à mão; sem esta trava, o Web serviria esse arquivo.
const MARCA_MIDIA = /^\[(?:imagem|áudio|vídeo|documento) salvo em (\/home\/agente\/uploads\/whatsapp\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8})\]\s*$/gm;
const CANAL_ABRE = /^<channel\b[^>]*>/;
const CANAL_USER = /\buser="([^"]*)"/;
const POKE = /\/tmp\/dgclaw-poke-([a-zA-Z0-9_.-]+?)-\d{8}-\d{6}\.txt/;
const RETORNO_SISTEMA = /^(stop hook feedback|\[request interrupted|caveat: the messages below)/i;
const ECO_COMANDO = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)\b/;
const ANSI = /\u001b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const SAIDA_COMANDO = /^<local-command-(stdout|stderr)>([\s\S]*?)(?:<\/local-command-\1>)?\s*$/;
const TAG_NOME_COMANDO = /<command-name>([\s\S]*?)<\/command-name>/;
const TAG_ARGS_COMANDO = /<command-args>([\s\S]*?)<\/command-args>/;
const MAX_SAIDA_COMANDO = 4000;
// Compactação (/compact). O Claude Code grava o /compact como se fosse fala do dono e depois um "resultado do
// comando" quase vazio; para o dono isso é ruído. No lugar entram dois avisos curtos DA AGENTE (balão do lado dela),
// na voz dela, porque é a agente que "some" por uns 45 segundos enquanto resume a conversa.
const AVISO_COMPACTANDO = 'Tô compactando a conversa pra voltar mais leve... já volto';
const AVISO_COMPACTADA = 'Voltei, conversa compactada.';
// Compactação dada como interrompida: chegou um turno normal (fala do dono ou da agente) depois do "/compact" cru e
// sem compact_boundary, ou o prazo venceu. Sem este aviso o "já volto" ficaria pendurado para sempre (sessão que caiu).
const AVISO_COMPACTACAO_INTERROMPIDA = 'A compactação não terminou, sigo com a conversa como estava.';
const avisoFalhaCompactacao = (motivo) => `Não consegui compactar a conversa: ${motivo}`;
// Linha user que o Claude Code grava NO INÍCIO da compactação: conteúdo string pura "/compact" (ou "/compact instruções").
const LINHA_COMPACT = /^\/compact(?:\s[\s\S]*)?$/;
const NOME_COMPACT = /^\/?compact$/;
// Uma tentativa de /compact que nunca terminou (sessão caiu, comando cancelado) não pode engolir o aviso de início
// da próxima: passado esse prazo, um novo /compact conta como compactação nova.
const PRAZO_COMPACTACAO_S = 600;
// Saída do terminal que, vinda de um /compact, indica falha (o stderr já indica por si).
const FALHA_COMPACT = /\b(error|erro|fail|falh|cancel|abort|not enough|cannot|could not)/i;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ANEXO_LINHA = /^\[anexo:\s*(.+?)\]\s*$/gm;
const ROTULO_EMOJI = { photo: '📷 foto', video: '🎬 vídeo', audio: '🎤 áudio', document: '📄 arquivo' };
const CHUNK = 4 * 1024 * 1024;

function textoDosBlocos(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

/** Lê o envelope <dgchat>. Devolve { attrs, interno } ou null. Sem `chat` o envelope não vale. */
function parseDgchat(texto) {
  const m = DGCHAT_ABRE.exec(texto);
  if (!m) return null;
  const attrs = {};
  let a;
  DGCHAT_ATTR.lastIndex = 0;
  while ((a = DGCHAT_ATTR.exec(m[0])) !== null) attrs[a[1]] = a[2];
  if (!attrs.chat) return null;
  let interno = texto.slice(m.index + m[0].length);
  const fim = interno.lastIndexOf(DGCHAT_FECHA);
  if (fim >= 0) interno = interno.slice(0, fim);
  interno = interno.split('<\\/dgchat>').join(DGCHAT_FECHA).trim();
  return { attrs, interno };
}

/** <channel source="plugin:telegram..." user="x">texto</channel>. Devolve { user, interno } ou null. */
function parseCanalTelegram(texto, prefixoFonte) {
  const t = texto.trim();
  if (!t.startsWith('<channel')) return null;
  const m = CANAL_ABRE.exec(t);
  if (!m) return null;
  const fonte = /\bsource="([^"]*)"/.exec(m[0]);
  if (!fonte || !fonte[1].startsWith(prefixoFonte)) return null;
  const u = CANAL_USER.exec(m[0]);
  const interno = t.slice(m[0].length).replace(/<\/channel>\s*$/, '').trim();
  return { user: (u && u[1]) || 'pessoa', interno };
}

/** Desfaz o escape do corpo do <canal-externo>: &lt; e &gt; antes de &amp; (senão &amp;lt; viraria <). */
function desescapa(t) {
  return String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * <canal-externo origem="whatsapp" de="+55..." msg="..." ts="...">corpo escapado</canal-externo>.
 * Devolve { attrs, interno } (corpo já desescapado) ou null. Só a origem "whatsapp" vale por enquanto.
 */
function parseCanalExterno(texto) {
  const t = String(texto).trim();
  const m = EXTERNO_ABRE.exec(t);
  if (!m) return null;
  const attrs = {};
  let a;
  EXTERNO_ATTR.lastIndex = 0;
  while ((a = EXTERNO_ATTR.exec(m[1])) !== null) attrs[a[1]] = a[2];
  if (attrs.origem !== 'whatsapp') return null;
  const interno = desescapa(t.slice(m[0].length).replace(EXTERNO_FECHA, '')).trim();
  return { attrs, interno };
}

function fmtHoraDia(epoch, tz) {
  const d = new Date(epoch * 1000);
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hourCycle: 'h23' });
  } catch (_) {
    fmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hourCycle: 'h23' });
  }
  const p = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { hhmm: `${p.hour}:${p.minute}`, dia: `${p.day}/${p.month}/${p.year}` };
}

/** Traduz um caminho visto de dentro do container para o do host (ou o devolve igual). */
function paraHost(caminho, agente) {
  const c = String(caminho || '').trim();
  const cont = agente.home_container && agente.home_container.replace(/\/+$/, '');
  const host = agente.home_host && agente.home_host.replace(/\/+$/, '');
  if (cont && host && (c === cont || c.startsWith(cont + '/'))) return host + c.slice(cont.length);
  return c;
}
function paraContainer(caminhoHost, agente) {
  const cont = agente.home_container && agente.home_container.replace(/\/+$/, '');
  const host = agente.home_host && agente.home_host.replace(/\/+$/, '');
  if (cont && host && (caminhoHost === host || caminhoHost.startsWith(host + '/'))) return cont + caminhoHost.slice(host.length);
  return caminhoHost;
}

/**
 * A montagem das mensagens que a tela recebe (id, hora, mídia). Serve ao leitor do transcript
 * do Claude e ao do rollout do Codex: as duas fontes entregam a MESMA forma de mensagem.
 */
function criarMontagem({ tz, midia }) {
  function epDe(ts, estado) {
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(t)) { estado.ultimoEp = t / 1000; return t / 1000; }
    estado.ultimoEp += 0.001;
    return estado.ultimoEp;
  }

  function monta(estado, agente, { ep, origin, text, kind, media, via, quem }) {
    const { hhmm, dia } = fmtHoraDia(ep, tz);
    const caminho = media && media.id ? media.id : '';
    return marcar({
      id: crypto.createHash('sha1').update(`${ep}|${text}|${caminho}|${via}`).digest('hex').slice(0, 16),
      ep, hhmm, dia, origin, text, kind, media: media || null,
      fmt: 'text', editada: false, reacoes: [], cita: null, via, quem,
    });
  }

  /** Cria 1..N mensagens a partir de texto + lista de caminhos de mídia (host). */
  function empurra(estado, agente, { ep, origin, text, caminhos, via, quem }) {
    if (!caminhos.length) {
      if (text) estado.eventos.push(monta(estado, agente, { ep, origin, text, kind: 'text', media: null, via, quem }));
      return;
    }
    caminhos.forEach((c, i) => {
      const media = midia.registrar(agente.slug, c.host, { visto: c.visto, nome: c.nome });
      const kind = media ? media.kind : 'document';
      const t = i === 0 && text ? text : (ROTULO_EMOJI[kind] || '📄 arquivo');
      estado.eventos.push(monta(estado, agente, { ep: ep + i * 0.0001, origin, text: t, kind, media, via, quem }));
    });
  }

  /** A fala do dono, com os marcadores [anexo: ...] virando mídia. `dg` vem de parseDgchat. */
  function empurraDono(estado, agente, dg, ep) {
    const caminhos = [];
    const corpo = dg.interno.replace(ANEXO_LINHA, (_, cam) => {
      const visto = cam.trim();
      const host = paraHost(visto, agente);
      caminhos.push({ host, visto, nome: path.basename(host) });
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    empurra(estado, agente, { ep, origin: 'dono', text: corpo, caminhos, via: 'plataforma', quem: dg.attrs.from || 'pessoa' });
  }

  /** A fala do dono pelo WhatsApp: as marcas "[imagem salvo em ...]" viram anexo, o resto é o texto. */
  function empurraDonoWhatsapp(estado, agente, ce, ep) {
    const caminhos = [];
    const corpo = ce.interno.replace(MARCA_MIDIA, (_, cam) => {
      const visto = cam.trim();
      const host = paraHost(visto, agente);
      caminhos.push({ host, visto, nome: path.basename(host) });
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    empurra(estado, agente, { ep, origin: 'dono', text: corpo, caminhos, via: 'whatsapp', quem: ce.attrs.de || 'pessoa' });
  }

  /** Saída pelo WhatsApp: whatsapp_reply {texto} ou whatsapp_send_file {caminho, legenda}. */
  function empurraAgenteWhatsapp(estado, agente, { ep, origin, arquivo, inp }) {
    if (!arquivo) {
      const t = typeof inp.texto === 'string' ? inp.texto.trim() : '';
      if (!t) return false;
      empurra(estado, agente, { ep, origin, text: t, caminhos: [], via: 'whatsapp', quem: 'agente' });
      return true;
    }
    const visto = String(inp.caminho || '').trim();
    if (!visto) return false;
    const host = paraHost(visto, agente);
    empurra(estado, agente, { ep, origin, text: String(inp.legenda || '').trim(), caminhos: [{ host, visto, nome: path.basename(host) }], via: 'whatsapp', quem: 'agente' });
    return true;
  }

  /** Mensagem do agente por dgchat reply (texto) ou send_file (mídia). `inp` = argumentos da tool. */
  function empurraAgente(estado, agente, { ep, origin, arquivo, inp }) {
    if (!arquivo) {
      const t = typeof inp.text === 'string' ? inp.text.trim() : '';
      if (!t) return false;
      empurra(estado, agente, { ep, origin, text: t, caminhos: [], via: 'plataforma', quem: 'agente' });
      return true;
    }
    const visto = String(inp.path || '').trim();
    if (!visto) return false;
    const host = paraHost(visto, agente);
    empurra(estado, agente, { ep, origin, text: String(inp.caption || '').trim(), caminhos: [{ host, visto, nome: path.basename(host) }], via: 'plataforma', quem: 'agente' });
    return true;
  }

  /**
   * O resultado de um comando de barra que o terminal imprimiu (<local-command-stdout>): sem códigos ANSI,
   * cortado em 4000 caracteres com aviso. Como a trilha, é texto de máquina: não passa por `marcar`.
   */
  function empurraComando(estado, { ep, texto, saida }) {
    const limpo = String(texto).replace(ANSI, '').trim();
    if (!limpo) return;
    const cortado = limpo.length > MAX_SAIDA_COMANDO;
    const corpo = cortado
      ? `${limpo.slice(0, MAX_SAIDA_COMANDO)}\n[saída cortada: o terminal devolveu ${limpo.length} caracteres e a conversa mostra os primeiros ${MAX_SAIDA_COMANDO}]`
      : limpo;
    const { hhmm, dia } = fmtHoraDia(ep, tz);
    estado.eventos.push({
      id: crypto.createHash('sha1').update(`comando|${ep}|${saida}|${limpo}`).digest('hex').slice(0, 16),
      ep, hhmm, dia, origin: 'comando', text: corpo, kind: 'text', media: null,
      fmt: 'text', editada: false, reacoes: [], cita: null, via: 'plataforma', quem: 'agente',
      comando: { saida, cortado },
    });
  }

  /**
   * Aviso curto da própria agente (hoje: compactação). Mesmo formato de uma fala dela, para o balão ir do lado da
   * agente sem mexer na tela. `sistema` marca que não é resposta a um pedido (o /wait da API não o conta como resposta).
   * Push: o servidor não dispara notificação a partir da thread (só a Mesa, os lembretes e o foco chamam push.enviar),
   * então este aviso não notifica nem conta como mensagem nova do dono (origin nunca é 'dono').
   */
  function empurraAviso(estado, agente, { ep, text, sistema }) {
    estado.eventos.push({ ...monta(estado, agente, { ep, origin: 'agente', text, kind: 'text', media: null, via: 'plataforma', quem: 'agente' }), sistema });
  }

  return { epDe, monta, empurra, empurraDono, empurraAgente, empurraDonoWhatsapp, empurraAgenteWhatsapp, empurraComando, empurraAviso };
}

/**
 * Leitura INCREMENTAL de um .jsonl: guarda o offset já lido (e a linha parcial do fim) em
 * `estados` e só processa o que cresceu. `novoEstado` cria o estado; `processaLinha(estado, linha)`
 * recebe cada linha completa. Devolve { eventos, versao }.
 */
function lerIncremental({ estados, caminho, agente, novoEstado, processaLinha, aoFimDaLeitura }) {
  const chave = `${agente.slug}|${caminho}`;
  let st;
  try { st = fs.statSync(caminho); } catch (e) {
    throw new Error(`Não consegui abrir o registro da conversa ${caminho} (${e.code || e.message}).`);
  }
  let estado = estados.get(chave);
  if (!estado || estado.ino !== st.ino || st.size < estado.offset) {
    estado = novoEstado();
    estado.ino = st.ino;
    estados.set(chave, estado);
  }
  if (st.size === estado.offset + estado.restoParcial.length && estado.lido) return { eventos: estado.eventos, versao: estado.versao };
  const fd = fs.openSync(caminho, 'r');
  try {
    let pos = estado.offset + estado.restoParcial.length;
    let resto = estado.restoParcial;
    const antes = estado.eventos.length;
    while (pos < st.size) {
      const n = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.allocUnsafe(n);
      const lidos = fs.readSync(fd, buf, 0, n, pos);
      if (lidos <= 0) break;
      pos += lidos;
      const junto = resto.length ? Buffer.concat([resto, buf.subarray(0, lidos)]) : buf.subarray(0, lidos);
      const ult = junto.lastIndexOf(0x0a);
      if (ult < 0) { resto = Buffer.from(junto); continue; }
      const completo = junto.subarray(0, ult).toString('utf8');
      for (const linha of completo.split('\n')) if (linha) processaLinha(estado, linha);
      estado.offset += ult + 1;
      resto = Buffer.from(junto.subarray(ult + 1));
    }
    estado.restoParcial = resto;
    estado.lido = true;
    if (aoFimDaLeitura) aoFimDaLeitura(estado);
    if (estado.eventos.length !== antes) estado.versao += 1;
  } finally {
    fs.closeSync(fd);
  }
  return { eventos: estado.eventos, versao: estado.versao };
}

function criarLeitor({ log, tz, canalTelegram, midia }) {
  const estados = new Map(); // chave -> estado incremental

  function novoEstado() {
    return { offset: 0, ino: null, trigger: 'owner', chatCorrente: '', eventos: [], versao: 0, ultimoEp: 0, msgsVistas: new Set(), waPendentes: new Map(), restoParcial: Buffer.alloc(0), trilhaPend: new Map(), compactandoEp: null, fimCompactEp: 0, ecoCompact: false };
  }

  const { epDe, empurra, empurraDono, empurraAgente, empurraDonoWhatsapp, empurraAgenteWhatsapp, empurraComando, empurraAviso } = criarMontagem({ tz, midia });

  /**
   * Casa os tool_result de um turno user com os envios de WhatsApp pendentes. Sucesso: o evento
   * entra com o ep ORIGINAL do tool_use, na posição certa por ep (o tool_result chega depois, e
   * outras falas podem ter entrado no meio; a tela diffa por id, então inserir no meio é seguro).
   * Erro: descarta. Nos dois casos a entrada sai do Map.
   */
  function resolvePendentesWhatsapp(estado, agente, blocos) {
    for (const b of blocos) {
      if (!b || b.type !== 'tool_result') continue;
      const pend = estado.waPendentes.get(b.tool_use_id);
      if (!pend) continue;
      estado.waPendentes.delete(b.tool_use_id);
      if (b.is_error === true) continue;
      const antes = estado.eventos.length;
      empurraAgenteWhatsapp(estado, agente, pend);
      const novos = estado.eventos.splice(antes);
      if (!novos.length) continue;
      let i = estado.eventos.length;
      while (i > 0 && estado.eventos[i - 1].ep > novos[0].ep) i--;
      estado.eventos.splice(i, 0, ...novos);
    }
  }

  /**
   * Casa os tool_result com os comandos pendentes da trilha. O que ainda não tem resultado fica em `trilhaPend`
   * (o cartão de permissão lê dali). Resolvido, o comando só sai do Map: NÃO vira item no histórico. O dono pediu
   * que as linhas "rodou: ..." saíssem da conversa; a atividade aparece só na barrinha de status.
   */
  function resolvePendentesTrilha(estado, blocos) {
    for (const b of blocos) {
      if (!b || b.type !== 'tool_result') continue;
      const pend = estado.trilhaPend.get(b.tool_use_id);
      if (!pend) continue;
      estado.trilhaPend.delete(b.tool_use_id);
    }
  }

  // Comando sem tool_result depois de 30 minutos de transcript: a sessão caiu no meio. Sai do Map para não
  // fazer toda linha de tool_result passar pelo JSON.parse para sempre.
  const PRAZO_PENDENTE_TRILHA_S = 1800;
  function descartaTrilhaVelha(estado, ts) {
    const agora = ts ? Date.parse(ts) / 1000 : NaN;
    if (!Number.isFinite(agora)) return;
    for (const [id, pend] of estado.trilhaPend) if (agora - pend.ep > PRAZO_PENDENTE_TRILHA_S) estado.trilhaPend.delete(id);
  }

  // Um envio cujo tool_result nunca chega (a sessão caiu no meio do turno) ficaria pendente para
  // sempre, e enquanto houver pendente toda linha de tool_result passa pelo JSON.parse. Dez
  // minutos de transcript depois do tool_use, o envio sai do Map sem virar balão, com aviso.
  const PRAZO_PENDENTE_WA_S = 600;

  function descartaPendentesVelhos(estado, agente, ts) {
    const agora = ts ? Date.parse(ts) / 1000 : NaN;
    if (!Number.isFinite(agora)) return;
    for (const [id, pend] of estado.waPendentes) {
      if (agora - pend.ep <= PRAZO_PENDENTE_WA_S) continue;
      estado.waPendentes.delete(id);
      if (log) {
        log('aviso', `Thread de ${agente && (agente.slug || agente.nome)}: o envio pelo WhatsApp ${id} ficou sem ` +
          `confirmação (nenhum tool_result em ${PRAZO_PENDENTE_WA_S / 60} minutos de transcript) e não aparece no chat. ` +
          'Provavelmente a sessão caiu no meio do turno; confira com o dono se a mensagem chegou.');
      }
    }
  }

  /**
   * Um turno normal (fala do dono por qualquer canal, ou linha da agente) com compactação em andamento prova que ela
   * não vai terminar. Na sequência real nada de turno aparece entre o "/compact" cru e o boundary (eco, stdout, resumo
   * e caveat não contam). O aviso entra logo antes do evento que provou a interrupção.
   */
  function interrompeCompactacao(estado, agente, ep) {
    if (estado.compactandoEp === null) return;
    estado.compactandoEp = null;
    empurraAviso(estado, agente, { ep: ep - 0.0005, text: AVISO_COMPACTACAO_INTERROMPIDA, sistema: 'compactacao' });
  }

  /** Início da compactação. Não duplica enquanto uma estiver em andamento (e recente). */
  function inicioCompactacao(estado, agente, ep) {
    if (estado.compactandoEp !== null) {
      if (ep - estado.compactandoEp < PRAZO_COMPACTACAO_S) return;
      interrompeCompactacao(estado, agente, ep); // a anterior nunca terminou: fecha antes de abrir a nova
    }
    estado.compactandoEp = ep;
    empurraAviso(estado, agente, { ep, text: AVISO_COMPACTANDO, sistema: 'compactacao' });
  }

  /**
   * Saída do terminal que pertence ao /compact: some como "resultado do comando". Só uma falha vira aviso.
   * Decisão de robustez: o dono é quem ficaria no escuro se a compactação desse erro, então stderr (sempre) e
   * stdout que cheire a erro (logo após o eco do /compact) viram "Não consegui compactar..." com a primeira
   * linha do erro, e a compactação deixa de estar "em andamento". O sucesso não gera nada aqui: quem diz
   * "Voltei" é o compact_boundary, que é o sinal estrutural (o texto do stdout muda entre versões).
   */
  function saidaDeCompactacao(estado, agente, ep, saida, texto) {
    const limpo = String(texto).replace(ANSI, '').trim();
    const falha = saida === 'stderr' || (!/^Compacted\b/.test(limpo) && FALHA_COMPACT.test(limpo));
    estado.ecoCompact = false;
    if (!falha) return;
    const linha = (limpo.split('\n').find((l) => l.trim()) || '').trim().slice(0, 300) || 'o terminal não explicou o motivo';
    estado.compactandoEp = null;
    empurraAviso(estado, agente, { ep, text: avisoFalhaCompactacao(linha), sistema: 'compactacao' });
  }

  /** compact_boundary: a compactação terminou (manual ou automática). Garante o aviso de início antes do de fim. */
  function fimCompactacao(estado, agente, ep) {
    if (estado.compactandoEp === null) {
      // Sem início (compactação automática, ou versão que só grava o eco depois): sintetiza o início logo antes.
      empurraAviso(estado, agente, { ep: ep - 0.001, text: AVISO_COMPACTANDO, sistema: 'compactacao' });
    }
    estado.compactandoEp = null;
    estado.fimCompactEp = ep;
    empurraAviso(estado, agente, { ep, text: AVISO_COMPACTADA, sistema: 'compactacao' });
  }

  function processaLinha(estado, agente, linha) {
    // Pré-filtro barato: a maioria das linhas (tool_result gigantes, thinking) não interessa.
    // A linha system do compact_boundary também passa (é o sinal de fim da compactação).
    if (!/"type"\s*:\s*"(?:user|assistant|attachment|queue-operation)"/.test(linha) && !linha.includes('"compact_boundary"')) return;
    // O tool_result do WhatsApp não menciona "whatsapp" (só o tool_use_id), então com envio
    // pendente as linhas de tool_result também passam. Sem pendentes, o filtro continua barato.
    const resultadoPendente = (estado.waPendentes.size > 0 || estado.trilhaPend.size > 0) && linha.includes('"tool_result"');
    // Com compactação em andamento, qualquer fala da agente passa: é ela que prova que a compactação morreu no
    // meio (a sessão voltou a responder sem compact_boundary). Sem isso, uma resposta em texto puro, sem dgchat
    // nem ferramenta, era descartada aqui e o "já volto" ficava pendurado até vencer o prazo.
    const provaInterrupcao = estado.compactandoEp !== null && /"type"\s*:\s*"assistant"/.test(linha);
    if (!resultadoPendente && !provaInterrupcao && !/dgchat|<channel|canal-externo|plataforma|dgclaw-poke|command-name|local-command-std|compact_boundary|"content"\s*:\s*"\s*\/compact|telegram__|__whatsapp_|"name":"(?:Bash|Write|Edit|MultiEdit|NotebookEdit)"/.test(linha)) return;

    let o;
    try { o = JSON.parse(linha); } catch (_) { return; } // linha truncada (transcript sendo escrito) não derruba nada
    if (!o || o.isSidechain === true) return;
    if (o.isCompactSummary === true) return; // o resumo que o Claude Code injeta depois de compactar: nunca é fala
    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') fimCompactacao(estado, agente, epDe(o.timestamp, estado));
      return;
    }
    if (estado.waPendentes.size > 0) descartaPendentesVelhos(estado, agente, o.timestamp);
    const m = o.message || {};
    const fila = o.type === 'attachment' && o.attachment?.type === 'queued_command'
      || o.type === 'queue-operation' && o.operation === 'enqueue';
    const cont = fila ? (o.type === 'attachment' ? o.attachment.prompt : o.content) : m.content;

    if (o.type === 'user' || fila) {
      if (Array.isArray(cont) && estado.waPendentes.size > 0) resolvePendentesWhatsapp(estado, agente, cont);
      if (Array.isArray(cont) && estado.trilhaPend.size > 0) { resolvePendentesTrilha(estado, cont); descartaTrilhaVelha(estado, o.timestamp); }
      let txt = textoDosBlocos(cont).replace(REMINDER, '').trim();
      if (!txt) return;
      if (RETORNO_SISTEMA.test(txt) || txt.includes('STOP BLOQUEADO')) return;
      // Início de uma compactação: o Claude Code grava o "/compact" cru (string pura) em tempo real, na hora em que começa.
      if (!fila && typeof cont === 'string' && LINHA_COMPACT.test(txt)) {
        inicioCompactacao(estado, agente, epDe(o.timestamp, estado));
        return;
      }
      if (ECO_COMANDO.test(txt)) {
        // Eco de comando de barra: o que a pessoa digitou vira fala dela; o que o terminal imprimiu vira
        // "resultado do comando". O resto (command-message sozinho, caveat) continua escondido.
        const nome = TAG_NOME_COMANDO.exec(txt);
        if (nome && !fila) {
          const n = nome[1].trim();
          if (n && NOME_COMPACT.test(n)) {
            // O eco do /compact não é fala do dono. Ele leva o timestamp do INÍCIO da compactação, mas o Claude Code
            // o grava junto com o fim. Se o início já saiu (linha "/compact" crua) ou se o compact_boundary desta
            // mesma compactação já passou (eco com ep <= fim), não repete o aviso.
            const ep = epDe(o.timestamp, estado);
            estado.ecoCompact = true;
            if (ep > estado.fimCompactEp) inicioCompactacao(estado, agente, ep);
            return;
          }
          estado.ecoCompact = false;
          if (n) {
            const a = TAG_ARGS_COMANDO.exec(txt);
            const args = a ? a[1].trim() : '';
            estado.trigger = 'owner';
            empurra(estado, agente, { ep: epDe(o.timestamp, estado), origin: 'dono', text: `${n.startsWith('/') ? n : `/${n}`}${args ? ` ${args}` : ''}`, caminhos: [], via: 'plataforma', quem: 'pessoa' });
          }
          return;
        }
        const saida = SAIDA_COMANDO.exec(txt);
        if (saida && !fila) {
          const ep = epDe(o.timestamp, estado);
          // Resultado de /compact: pelo eco anterior, ou pelo texto "Compacted" (versões sem eco).
          if (estado.ecoCompact || /^Compacted\b/.test(saida[2].replace(ANSI, '').trim())) saidaDeCompactacao(estado, agente, ep, saida[1], saida[2]);
          else empurraComando(estado, { ep, texto: saida[2], saida: saida[1] });
        }
        return;
      }
      if (txt.startsWith('<plataforma ')) { if (!fila) estado.trigger = 'cron'; return; } // aviso do sistema: o agente que fala depois age por conta própria
      const pk = POKE.exec(txt);
      if (pk) {
        if (pk[1].startsWith('retomada')) estado.trigger = 'owner';
        else if (!fila) estado.trigger = 'cron';
        return;
      }

      const dg = parseDgchat(txt);
      if (dg) {
        estado.chatCorrente = dg.attrs.chat;
        if (dg.attrs.chat !== agente.chat_id) return;
        if (dg.attrs.msg) {
          if (estado.msgsVistas.has(dg.attrs.msg)) return;
          estado.msgsVistas.add(dg.attrs.msg);
        }
        estado.trigger = 'owner';
        const epDg = epDe(o.timestamp, estado);
        if (!fila) interrompeCompactacao(estado, agente, epDg);
        empurraDono(estado, agente, dg, epDg);
        return;
      }

      const ce = parseCanalExterno(txt);
      if (ce) {
        if (ce.attrs.msg) {
          const k = 'wa:' + ce.attrs.msg;
          if (estado.msgsVistas.has(k)) return;
          estado.msgsVistas.add(k);
        }
        estado.trigger = 'owner';
        const epCe = epDe(o.timestamp, estado);
        if (!fila) interrompeCompactacao(estado, agente, epCe);
        empurraDonoWhatsapp(estado, agente, ce, epCe);
        return;
      }

      const tg = parseCanalTelegram(txt, canalTelegram);
      if (tg) {
        if (!tg.interno) return;
        const id = /\bmessage_id="([^"]+)"/.exec(txt)?.[1];
        if (id && estado.msgsVistas.has('tg:' + id)) return;
        if (id) estado.msgsVistas.add('tg:' + id);
        estado.trigger = 'owner';
        const ep = epDe(o.timestamp, estado);
        if (!fila) interrompeCompactacao(estado, agente, ep);
        empurra(estado, agente, { ep, origin: 'dono', text: tg.interno, caminhos: [], via: 'telegram', quem: tg.user });
      }
      return;
    }

    if (o.type === 'assistant' && Array.isArray(cont)) {
      if (cont.length) interrompeCompactacao(estado, agente, epDe(o.timestamp, estado));
      for (const b of cont) {
        if (!b || b.type !== 'tool_use') continue;
        const nome = String(b.name || '');
        const inp = b.input || {};
        const origin = estado.trigger === 'cron' ? 'rotina' : 'agente';
        const uso = descreveUso(nome, inp);
        if (uso) {
          if (typeof b.id === 'string' && b.id) estado.trilhaPend.set(b.id, { ep: epDe(o.timestamp, estado), uso });
          continue;
        }
        if (nome.endsWith(TOOL_TEXTO) || nome.endsWith(TOOL_ARQUIVO)) {
          const chat = inp.chat || estado.chatCorrente || agente.chat_id;
          if (chat !== agente.chat_id) continue;
          empurraAgente(estado, agente, { ep: epDe(o.timestamp, estado), origin, arquivo: nome.endsWith(TOOL_ARQUIVO), inp });
          continue;
        }
        if (nome.endsWith(TOOL_WA_TEXTO) || nome.endsWith(TOOL_WA_ARQUIVO)) {
          // Só vira fala quando o tool_result confirmar o envio: a tool que falha (WhatsApp
          // desligado, número fora da lista) devolve is_error e nada foi entregue.
          const idUso = typeof b.id === 'string' ? b.id : '';
          const pend = { ep: epDe(o.timestamp, estado), origin, arquivo: nome.endsWith(TOOL_WA_ARQUIVO), inp };
          if (idUso) estado.waPendentes.set(idUso, pend);
          continue;
        }
        if (nome.endsWith(TOOL_TELEGRAM)) {
          const t = typeof inp.text === 'string' ? inp.text.trim() : '';
          if (!t) continue;
          const ep = epDe(o.timestamp, estado);
          empurra(estado, agente, { ep, origin, text: t, caminhos: [], via: 'telegram', quem: 'agente' });
        }
      }
    }
  }

  /** Lê o que cresceu no arquivo. Devolve { eventos, versao } (eventos é a MESMA lista, só cresce). */
  function ler(caminho, agente) {
    return lerIncremental({ estados, caminho, agente, novoEstado, processaLinha: (estado, linha) => processaLinha(estado, agente, linha) });
  }

  /** O comando mais recente que ainda não tem resultado (o que o cartão de permissão mostra), ou null. */
  function pendente(caminho, slug) {
    const estado = estados.get(`${slug}|${caminho}`);
    if (!estado || !estado.trilhaPend.size) return null;
    let ultimo = null;
    for (const p of estado.trilhaPend.values()) if (!ultimo || p.ep >= ultimo.ep) ultimo = p;
    return ultimo ? { ferramenta: ultimo.uso.ferramenta, titulo: ultimo.uso.titulo, comando: ultimo.uso.comando } : null;
  }

  return { ler, pendente, esquece(caminho, slug) { estados.delete(`${slug}|${caminho}`); } };
}

module.exports = { parseCanalExterno, desescapa, criarLeitor, criarMontagem, lerIncremental, fmtHoraDia, parseDgchat, parseCanalTelegram, paraHost, paraContainer, textoDosBlocos, ROTULO_EMOJI };
