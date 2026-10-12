// cron-parser.js — Parser das sessões de cron (DG Claw), parametrizado.
//
// Factory: buildCronParser(config) → { CRON_SCHEDULE, getCronsForDate, parseSessionText }
//   - CRON_SCHEDULE  = config.schedule (vazio = sem grade esperada; nada quebra)
//   - offset BRT     = config.timezoneOffsetHours
//   - creatorId      = config.creatorId (usado em alguns step-defs de notificação)
//
// Os step-defs específicos de Instagram (publicação, planilhas, etc.) são
// DEFAULTS aplicados só quando faz sentido (cron de post/comment). Se um agente
// não tem o poder instagram, simplesmente não vai existir sessão de post/comment
// e a grade fica vazia — sem crash.

const fs = require('fs');
const path = require('path');

function buildCronParser(config) {
  const CRON_SCHEDULE = Array.isArray(config.schedule) ? config.schedule : [];
  const TZ_OFFSET_MS = (config.timezoneOffsetHours || 0) * 3600000;
  const CREATOR_ID = config.creatorId ? String(config.creatorId) : null;

  // Regex de notificação ao dono: usa o creatorId se houver, senão um placeholder
  // que nunca casa (pra não marcar como completo à toa).
  const ownerRe = CREATOR_ID
    ? new RegExp(CREATOR_ID)
    : /\b__no_owner_id__\b/;

  const POST_STEPS = [
    { id: 'skill_read', label: 'SKILL.md lido', pattern: /SKILL\.md/i, critical: false },
    { id: 'weather', label: 'Clima verificado', pattern: /wttr\.in/i, critical: false },
    { id: 'owner_start', label: 'Dono avisado início', pattern: ownerRe, critical: false },
    { id: 'image_gen', label: 'Imagem gerada', pattern: /(nano-banana|replicate|image.*generat)/i },
    { id: 'post_published', label: 'Post publicado', pattern: /(instagram.*publish|graph\.facebook.*media_publish|content_publish)/i },
    { id: 'story_published', label: 'Story publicado', pattern: /(story|stories.*publish)/i, critical: false },
    { id: 'sheets_updated', label: 'Planilhas atualizadas', pattern: /gog\s+sheets\s+append/i },
    { id: 'reflection_saved', label: 'Reflexão salva', pattern: /(planilha.*[Mm]em[oó]ria|REFLEXAO)/i },
    { id: 'update_state', label: 'update-state executado', pattern: /update-state\.py/i },
    { id: 'emotion_engine', label: 'emotion-engine lido', pattern: /emotion-engine\.py/i, critical: false },
    { id: 'report_sent', label: 'Relatório enviado', pattern: ownerRe, critical: false },
  ];

  const COMMENT_STEPS = [
    { id: 'skill_read', label: 'SKILL.md lido', pattern: /SKILL\.md/i, critical: false },
    { id: 'scrape', label: 'Scrape executado', pattern: /scrape-comments\.py/i },
    { id: 'replied_read', label: '.replied_comments lido', pattern: /\.replied_comments/i },
    { id: 'followers_checked', label: 'Followers consultados', pattern: /search-follower\.py/i, critical: false },
    { id: 'comments_replied', label: 'Comentários respondidos', pattern: /(POST.*comments|comment.*reply|graph\.facebook.*comments)/i },
    { id: 'ids_saved', label: 'IDs salvos', pattern: />>.*\.replied_comments/i },
    { id: 'update_state', label: 'update-state executado', pattern: /update-state\.py/i },
    { id: 'owner_notified', label: 'Dono avisado', pattern: ownerRe, critical: false },
  ];

  function parseSessionText(sessionPath) {
    const textParts = [];
    const errors = [];
    let startTime = null;
    let endTime = null;
    let cronLabel = null;
    let cronType = null;
    let model = null;
    let postUrl = null;

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      for (const line of data.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }

        const objType = obj.type;
        const ts = obj.timestamp || '';

        if (objType === 'session') { startTime = ts; continue; }
        if (objType === 'model_change') { model = obj.modelId || ''; continue; }
        if (ts && typeof ts === 'string') endTime = ts;
        if (objType !== 'message') continue;

        const msg = obj.message || {};
        const role = msg.role || '';
        const content = msg.content;
        if (!Array.isArray(content)) continue;

        for (const item of content) {
          if (typeof item !== 'object' || !item) continue;
          const itemType = item.type || '';

          if (role === 'user' && itemType === 'text' && cronType === null) {
            const txt = item.text || '';
            const cronMatch = txt.match(/\[cron:\s*([^\]]+)\]/i);
            if (cronMatch) {
              cronLabel = cronMatch[1].trim();
              const labelLower = cronLabel.toLowerCase();
              if (labelLower.includes('post') || labelLower.includes('postagem')) {
                cronType = 'post';
              } else if (labelLower.includes('coment') || labelLower.includes('comment')) {
                cronType = 'comment';
              } else {
                const firstLine = txt.split('\n')[0].toLowerCase();
                cronType = (firstLine.includes('comentar') || firstLine.includes('comment')) ? 'comment' : 'post';
              }
            }
          }

          if (itemType === 'text') {
            textParts.push(item.text || '');
          }

          if (itemType === 'toolCall') {
            const args = item.arguments || {};
            const cmd = args.command || '';
            textParts.push(cmd);
            textParts.push(item.name || '');

            const urlMatch = cmd.match(/https?:\/\/[^\s"']+instagram\.com\/p\/[^\s"']+/);
            if (urlMatch) postUrl = urlMatch[0];
          }

          if (itemType === 'toolResult') {
            const resultContent = item.content;
            if (Array.isArray(resultContent)) {
              for (const rc of resultContent) {
                if (rc && rc.type === 'text') {
                  const resultText = rc.text || '';
                  textParts.push(resultText);
                  const urlMatch = resultText.match(/https?:\/\/[^\s"']+instagram\.com\/p\/[^\s"']+/);
                  if (urlMatch) postUrl = urlMatch[0];
                }
              }
            }
            if (item.isError) {
              let errText = '';
              if (Array.isArray(resultContent)) {
                errText = resultContent.filter((rc) => rc && rc.type === 'text').map((rc) => rc.text || '').join(' ');
              } else if (typeof resultContent === 'string') {
                errText = resultContent;
              }
              if (errText) errors.push(errText.slice(0, 200));
            }
          }
        }
      }
    } catch {
      return null;
    }

    const fullText = textParts.join('\n');
    const repliedMatches = fullText.match(/>>.*\.replied_comments/g) || [];
    const graphReplies = fullText.match(/graph\.facebook\.com.*comments/g) || [];
    const commentsReplied = Math.max(repliedMatches.length, graphReplies.length);

    return { fullText, errors, startTime, endTime, cronLabel, cronType, model, commentsReplied, postUrl };
  }

  function detectSteps(fullText, stepDefs) {
    return stepDefs.map((step) => ({
      id: step.id,
      label: step.label,
      completed: step.pattern.test(fullText),
      critical: step.critical !== false,
    }));
  }

  function sessionToTzMinutes(startTime) {
    if (!startTime) return null;
    try {
      if (startTime.includes('T')) {
        const dt = new Date(startTime);
        const localMs = dt.getTime() + TZ_OFFSET_MS;
        const local = new Date(localMs);
        return local.getUTCHours() * 60 + local.getUTCMinutes();
      }
      const parts = startTime.split(':');
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } catch {
      return null;
    }
  }

  function matchSessionToSchedule(startTime, cronType) {
    const sessionMinutes = sessionToTzMinutes(startTime);
    if (sessionMinutes === null) return null;

    let bestMatch = null;
    let bestDiff = Infinity;

    for (const slot of CRON_SCHEDULE) {
      if (slot.type !== cronType) continue;
      const [h, m] = slot.time.split(':').map(Number);
      const slotMinutes = h * 60 + m;
      const diff = Math.abs(sessionMinutes - slotMinutes);
      if (diff < bestDiff && diff < 45) {
        bestDiff = diff;
        bestMatch = slot;
      }
    }
    return bestMatch;
  }

  function extractSummary(parsed) {
    const { fullText, cronType } = parsed;
    const summary = {};

    if (cronType === 'comment') {
      let m = fullText.match(/Total:\s*(\d+)\s*coment[áa]rios\s*de\s*(\d+)\s*posts/);
      if (m) {
        summary.totalComments = parseInt(m[1]);
        summary.postsScraped = parseInt(m[2]);
      }
      m = fullText.match(/(\d+)\s*pendentes?/);
      if (m) summary.pendingFound = parseInt(m[1]);
      m = fullText.match(/(\d+)\s*respondidos?/);
      if (m) summary.repliedCount = parseInt(m[1]);
    } else if (cronType === 'post') {
      const matches = fullText.match(/"theme"\s*:\s*"([^"]{2,80})"/g);
      if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        const tm = last.match(/"theme"\s*:\s*"([^"]{2,80})"/);
        if (tm) summary.theme = tm[1].trim().slice(0, 80);
      }
    }
    return summary;
  }

  function buildCronEntry(parsed, sessionId, sessionPath, slotTime, slotLabel) {
    const stepDefs = parsed.cronType === 'post' ? POST_STEPS : COMMENT_STEPS;
    const steps = detectSteps(parsed.fullText, stepDefs);

    if (parsed.cronType === 'comment') {
      const zeroPending = /(?:0\s*pendentes?|[Zz]ero\s*coment[áa]rios?\s*pendentes?|[Nn]enhum\s*pendente)/.test(parsed.fullText);
      if (zeroPending) {
        for (const s of steps) {
          if ((s.id === 'comments_replied' || s.id === 'ids_saved') && !s.completed) {
            s.completed = true;
            s.label += ' (N/A)';
          }
        }
      }
    }

    const hasErrors = parsed.errors.length > 0;
    const criticalSteps = steps.filter((s) => s.critical);
    const allCritical = criticalSteps.length > 0 ? criticalSteps.every((s) => s.completed) : true;
    const status = hasErrors ? 'error' : (allCritical ? 'completed' : 'partial');

    let duration = null;
    if (parsed.startTime && parsed.endTime) {
      try {
        const start = new Date(parsed.startTime);
        const end = new Date(parsed.endTime);
        duration = Math.round((end - start) / 1000);
      } catch { /* skip */ }
    }

    return {
      sessionId,
      sessionFile: sessionPath,
      cronType: parsed.cronType,
      cronLabel: slotLabel,
      scheduledTime: slotTime,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      durationSeconds: duration,
      status,
      steps,
      errors: parsed.errors.slice(0, 5),
      commentsReplied: parsed.commentsReplied,
      postUrl: parsed.postUrl,
      model: parsed.model,
      summary: extractSummary(parsed),
    };
  }

  function getSessionsByDate(sessionsDir, targetDate) {
    const sessions = [];
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fullPath = path.join(sessionsDir, f);
        const stat = fs.statSync(fullPath);
        const mdate = new Date(stat.mtimeMs + TZ_OFFSET_MS).toISOString().split('T')[0];
        if (mdate === targetDate) {
          sessions.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      }
    } catch { /* dir not found */ }
    sessions.sort((a, b) => a.mtime - b.mtime);
    return sessions;
  }

  function getCronsForDate(sessionsDir, targetDate) {
    const sessions = getSessionsByDate(sessionsDir, targetDate);
    const crons = [];
    const matched = new Set();

    for (const session of sessions) {
      const parsed = parseSessionText(session.path);
      if (!parsed || !parsed.cronType) continue;

      const slot = matchSessionToSchedule(parsed.startTime, parsed.cronType);
      const slotTime = slot ? slot.time : '??:??';
      const slotLabel = slot ? slot.label : `${parsed.cronType} (sem horário)`;

      if (slot) matched.add(slot.time);

      const sessionId = path.basename(session.path, '.jsonl');
      crons.push(buildCronEntry(parsed, sessionId, session.path, slotTime, slotLabel));
    }

    // Adiciona slots esperados que faltaram (só se há grade configurada).
    const nowLocal = new Date(Date.now() + TZ_OFFSET_MS);
    const nowMinutes = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();
    const isToday = targetDate === nowLocal.toISOString().split('T')[0];

    for (const slot of CRON_SCHEDULE) {
      if (matched.has(slot.time)) continue;
      const [h, m] = slot.time.split(':').map(Number);
      const slotMinutes = h * 60 + m;
      const isPast = isToday && slotMinutes < nowMinutes;

      crons.push({
        sessionId: null,
        cronType: slot.type,
        cronLabel: slot.label,
        scheduledTime: slot.time,
        status: isPast ? 'missing' : 'pending',
        steps: [],
        errors: [],
      });
    }

    crons.sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));
    return crons;
  }

  return { CRON_SCHEDULE, getCronsForDate, parseSessionText };
}

module.exports = { buildCronParser };
