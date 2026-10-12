// meetings.js — Leitor dos workspaces de reuniões (Recall.ai), parametrizado.
// Cada subdir é uma reunião (YYYY-MM-DD-HHMM). Contém:
//   audio.raw, bot-meta.json, summary.json, timeline.txt, transcript-final.md, cost-log.jsonl, cost-summary.json
//
// Factory: buildMeetings(paths) — usa paths.MEETINGS_DIR. Se o dir não existe
// (poder meetings desligado / agente novo), listMeetings retorna [] sem crash.
const fs = require('fs');
const path = require('path');

function buildMeetings(P) {

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}
function safeJSON(p) {
  const r = safeRead(p);
  if (!r) return null;
  try { return JSON.parse(r); } catch { return null; }
}
function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Parse ID "2026-05-18-0918" → Date
function parseIdDate(id) {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00-03:00`);
}

// Lista todas as reuniões (cards). Não lê transcript pra ser rápido.
function listMeetings() {
  let dirs;
  try {
    dirs = fs.readdirSync(P.MEETINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(d.name))
      .map((d) => d.name);
  } catch { return []; }

  const out = [];
  for (const id of dirs) {
    const dir = path.join(P.MEETINGS_DIR, id);
    const summary = safeJSON(path.join(dir, 'summary.json')) || {};
    const costSummary = safeJSON(path.join(dir, 'cost-summary.json')) || null;
    const botMeta = safeJSON(path.join(dir, 'bot-meta.json')) || {};
    const audioStat = safeStat(path.join(dir, 'audio.raw'));
    const timelineStat = safeStat(path.join(dir, 'timeline.txt'));
    const transcriptStat = safeStat(path.join(dir, 'transcript-final.md'));

    // Participantes: tenta bot-meta primeiro, senão grep no timeline
    let participants = botMeta.participants_seen || [];
    if (!participants.length && timelineStat) {
      const tl = safeRead(path.join(dir, 'timeline.txt')) || '';
      const set = new Set();
      const re = /^\[([^\]]+?) \d\d:\d\d:\d\d /gm;
      let m;
      while ((m = re.exec(tl)) !== null) set.add(m[1]);
      participants = [...set];
    }

    const startedAt = parseIdDate(id);
    // Duração aproximada pelo mtime do timeline (último write durante a reunião)
    let durationMin = null;
    if (startedAt && timelineStat) {
      durationMin = Math.max(0, Math.round((timelineStat.mtimeMs - startedAt.getTime()) / 60000));
    }
    // Se cost-summary tem duration, usa esse (mais confiável)
    if (costSummary?.duration_min != null) durationMin = costSummary.duration_min;

    out.push({
      id,
      date: startedAt ? startedAt.toISOString() : null,
      duration_min: durationMin,
      mode: botMeta.meeting_mode || null,
      title: summary.tldr ? summary.tldr.slice(0, 120) : (id),
      tldr: summary.tldr || null,
      participants: participants.filter((p) => p && !p.includes('+')), // remove "X + Y"
      decisoes_count: (summary.decisoes || []).length,
      action_items_count: (summary.action_items || []).length,
      total_usd: costSummary?.total_usd ?? null,
      has_audio: !!audioStat,
      has_transcript: !!transcriptStat,
      bytes_audio: audioStat?.size || 0,
    });
  }
  // Mais recente primeiro
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

// Retorna detalhe da reunião incluindo transcript organizado (blocos por speaker + chat).
function getMeeting(id) {
  if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(id)) return null;
  const dir = path.join(P.MEETINGS_DIR, id);
  if (!safeStat(dir)) return null;

  const summary = safeJSON(path.join(dir, 'summary.json')) || {};
  const costSummary = safeJSON(path.join(dir, 'cost-summary.json')) || { total_usd: 0, by_provider: {} };
  const costLog = (safeRead(path.join(dir, 'cost-log.jsonl')) || '')
    .split('\n').filter(Boolean).map((ln) => { try { return JSON.parse(ln); } catch { return null; } })
    .filter(Boolean);
  const botMeta = safeJSON(path.join(dir, 'bot-meta.json')) || {};
  // timeline.txt SEMPRE tem o formato com speakers; transcript-final.md pode ser texto puro do Scribe batch
  const timelineRaw = safeRead(path.join(dir, 'timeline.txt')) || '';
  const transcriptFinalRaw = safeRead(path.join(dir, 'transcript-final.md')) || '';
  // batch_text = só o trecho de "## Áudio (transcrição oficial — Scribe batch)" do transcript-final, se existir
  let batchText = null;
  const batchMatch = transcriptFinalRaw.match(/## Áudio \(transcrição oficial — (?:Scribe|Gemini[^)]*)batch\)\s*\n([\s\S]*?)(?:\n## |$)/);
  if (batchMatch) batchText = batchMatch[1].trim();

  const audioStat = safeStat(path.join(dir, 'audio.raw'));

  // Parse linhas do timeline em blocos por speaker, intercalando chat
  // formato: [Nome HH:MM:SS audio|chat|agent-chat|tool-result] texto
  const lines = timelineRaw.split('\n');
  const blocks = []; // {speaker, kind, start_ts, text}
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^\[([^\]]+?) (\d{2}:\d{2}:\d{2}) ([a-z-]+)\] (.*)$/);
    if (!m) continue;
    const [, speaker, ts, kind, text] = m;
    if (cur && cur.speaker === speaker && cur.kind === kind && kind === 'audio') {
      // Concatena fragmento contínuo do mesmo speaker em audio
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + text;
    } else {
      if (cur) blocks.push(cur);
      cur = { speaker, kind, start_ts: ts, text };
    }
  }
  if (cur) blocks.push(cur);

  const participants = [...new Set(blocks.filter((b) => b.kind === 'audio').map((b) => b.speaker))]
    .filter((p) => p && p !== '?' && !p.includes('+'));

  return {
    id,
    date: parseIdDate(id)?.toISOString() || null,
    mode: botMeta.meeting_mode || null,
    bot_id: botMeta.bot_id || null,
    duration_min: costSummary.duration_min ?? null,
    summary,
    cost: { total_usd: costSummary.total_usd, by_provider: costSummary.by_provider || {}, log: costLog },
    participants,
    blocks,
    batch_text: batchText,
    has_audio: !!audioStat,
    bytes_audio: audioStat?.size || 0,
  };
}

// Busca full-text simples no transcript-final + summary
function searchMeetings(query) {
  if (!query || query.trim().length < 2) return listMeetings();
  const q = query.toLowerCase();
  const all = listMeetings();
  return all.filter((m) => {
    if ((m.tldr || '').toLowerCase().includes(q)) return true;
    if (m.id.includes(q)) return true;
    if ((m.participants || []).some((p) => p.toLowerCase().includes(q))) return true;
    const tr = safeRead(path.join(P.MEETINGS_DIR, m.id, 'transcript-final.md')) || '';
    return tr.toLowerCase().includes(q);
  });
}

  return { listMeetings, getMeeting, searchMeetings };
}

module.exports = { buildMeetings };
