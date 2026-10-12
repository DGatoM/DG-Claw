'use strict';
// Montagem da thread a partir do transcript (.jsonl) da sessão principal do agente.
// Porta do scripts/_lib/thread_log.py, com leitura INCREMENTAL: cada arquivo guarda o
// offset já lido e só o que cresceu é processado a cada chamada.
//
// O que conta como mensagem:
//   - fala do dono: turno `user` com o envelope <dgchat from chat msg ts>texto</dgchat>
//     (só o corpo aparece) ou, com o Telegram ligado, <channel source="plugin:telegram...">;
//   - fala do agente: tool_use cujo nome termina em __dgchat__reply (texto) ou
//     __dgchat__send_file (mídia), ou __telegram__reply (com via:"telegram").
//     Texto solto do assistente NÃO conta.
// O que some: <plataforma ...>, system-reminder, tool_result, eco de comando, poke de cron,
// recado do sistema (Stop hook feedback, interrupções).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DGCHAT_ABRE = /<dgchat\b[^>]*>/;
const DGCHAT_ATTR = /\b(from|chat|msg|ts)="([^"]*)"/g;
const DGCHAT_FECHA = '</dgchat>';
const TOOL_TEXTO = '__dgchat__reply';
const TOOL_ARQUIVO = '__dgchat__send_file';
const TOOL_TELEGRAM = 'telegram__reply';
const CANAL_ABRE = /^<channel\b[^>]*>/;
const CANAL_USER = /\buser="([^"]*)"/;
const POKE = /\/tmp\/dgclaw-poke-([a-zA-Z0-9_.-]+?)-\d{8}-\d{6}\.txt/;
const RETORNO_SISTEMA = /^(stop hook feedback|\[request interrupted|caveat: the messages below)/i;
const ECO_COMANDO = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)\b/;
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

function criarLeitor({ log, tz, canalTelegram, midia }) {
  const estados = new Map(); // chave -> estado incremental

  function novoEstado() {
    return { offset: 0, ino: null, trigger: 'owner', chatCorrente: '', eventos: [], versao: 0, ultimoEp: 0, msgsVistas: new Set(), restoParcial: Buffer.alloc(0) };
  }

  function epDe(ts, estado) {
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(t)) { estado.ultimoEp = t / 1000; return t / 1000; }
    estado.ultimoEp += 0.001;
    return estado.ultimoEp;
  }

  function monta(estado, agente, { ep, origin, text, kind, media, via, quem }) {
    const { hhmm, dia } = fmtHoraDia(ep, tz);
    const caminho = media && media.id ? media.id : '';
    return {
      id: crypto.createHash('sha1').update(`${ep}|${text}|${caminho}|${via}`).digest('hex').slice(0, 16),
      ep, hhmm, dia, origin, text, kind, media: media || null,
      fmt: 'text', editada: false, reacoes: [], cita: null, via, quem,
    };
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

  function processaLinha(estado, agente, linha) {
    // Pré-filtro barato: a maioria das linhas (tool_result gigantes, thinking) não interessa.
    if (!(linha.includes('"type":"user"') || linha.includes('"type":"assistant"'))) return;
    if (!/dgchat|<channel|plataforma|dgclaw-poke|telegram__/.test(linha)) return;

    let o;
    try { o = JSON.parse(linha); } catch (_) { return; } // linha truncada (transcript sendo escrito) não derruba nada
    if (!o || o.isSidechain === true) return;
    const m = o.message || {};
    const cont = m.content;

    if (o.type === 'user') {
      let txt = textoDosBlocos(cont).replace(REMINDER, '').trim();
      if (!txt) return;
      if (RETORNO_SISTEMA.test(txt) || txt.includes('STOP BLOQUEADO')) return;
      if (ECO_COMANDO.test(txt)) return;
      if (txt.startsWith('<plataforma ')) { estado.trigger = 'cron'; return; } // aviso do sistema: o agente que fala depois age por conta própria
      const pk = POKE.exec(txt);
      if (pk) { estado.trigger = 'cron'; return; }

      const dg = parseDgchat(txt);
      if (dg) {
        estado.chatCorrente = dg.attrs.chat;
        estado.trigger = 'owner';
        if (dg.attrs.chat !== agente.chat_id) return;
        if (dg.attrs.msg) {
          if (estado.msgsVistas.has(dg.attrs.msg)) return;
          estado.msgsVistas.add(dg.attrs.msg);
        }
        const ep = epDe(o.timestamp, estado);
        let corpo = dg.interno;
        const caminhos = [];
        corpo = corpo.replace(ANEXO_LINHA, (_, cam) => {
          const visto = cam.trim();
          const host = paraHost(visto, agente);
          caminhos.push({ host, visto, nome: path.basename(host) });
          return '';
        }).replace(/\n{3,}/g, '\n\n').trim();
        empurra(estado, agente, { ep, origin: 'dono', text: corpo, caminhos, via: 'plataforma', quem: dg.attrs.from || 'pessoa' });
        return;
      }

      const tg = parseCanalTelegram(txt, canalTelegram);
      if (tg) {
        estado.trigger = 'owner';
        if (!tg.interno) return;
        const ep = epDe(o.timestamp, estado);
        empurra(estado, agente, { ep, origin: 'dono', text: tg.interno, caminhos: [], via: 'telegram', quem: tg.user });
      }
      return;
    }

    if (o.type === 'assistant' && Array.isArray(cont)) {
      for (const b of cont) {
        if (!b || b.type !== 'tool_use') continue;
        const nome = String(b.name || '');
        const inp = b.input || {};
        const origin = estado.trigger === 'cron' ? 'rotina' : 'agente';
        if (nome.endsWith(TOOL_TEXTO) || nome.endsWith(TOOL_ARQUIVO)) {
          const chat = inp.chat || estado.chatCorrente || agente.chat_id;
          if (chat !== agente.chat_id) continue;
          const ep = epDe(o.timestamp, estado);
          if (nome.endsWith(TOOL_TEXTO)) {
            const t = typeof inp.text === 'string' ? inp.text.trim() : '';
            if (!t) continue;
            empurra(estado, agente, { ep, origin, text: t, caminhos: [], via: 'plataforma', quem: 'agente' });
          } else {
            const visto = String(inp.path || '').trim();
            if (!visto) continue;
            const host = paraHost(visto, agente);
            empurra(estado, agente, { ep, origin, text: String(inp.caption || '').trim(), caminhos: [{ host, visto, nome: path.basename(host) }], via: 'plataforma', quem: 'agente' });
          }
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
        for (const linha of completo.split('\n')) if (linha) processaLinha(estado, agente, linha);
        estado.offset += ult + 1;
        resto = Buffer.from(junto.subarray(ult + 1));
      }
      estado.restoParcial = resto;
      estado.lido = true;
      if (estado.eventos.length !== antes) estado.versao += 1;
    } finally {
      fs.closeSync(fd);
    }
    return { eventos: estado.eventos, versao: estado.versao };
  }

  return { ler, esquece(caminho, slug) { estados.delete(`${slug}|${caminho}`); } };
}

module.exports = { criarLeitor, parseDgchat, parseCanalTelegram, paraHost, paraContainer, textoDosBlocos, ROTULO_EMOJI };
