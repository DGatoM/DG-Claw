#!/usr/bin/env bun
// dgclaw-hooks.ts — hook ÚNICO do DG Claw modo local (Bun, cross-platform).
//
// Registrado no .claude/settings.json DO WORKSPACE do agente (project-scoped —
// não vaza pra outras sessões da máquina). Um arquivo, vários eventos:
//
//   bun .dgclaw/hooks/dgclaw-hooks.ts user-prompt     (UserPromptSubmit)
//   bun .dgclaw/hooks/dgclaw-hooks.ts post-tool       (PostToolUse, matcher telegram)
//   bun .dgclaw/hooks/dgclaw-hooks.ts session-start   (SessionStart: startup|resume|compact)
//   bun .dgclaw/hooks/dgclaw-hooks.ts pre-compact     (PreCompact)
//   bun .dgclaw/hooks/dgclaw-hooks.ts stop            (Stop)
//
// Papel: manter o FIO da conversa do Telegram (chat-tail.md) vivo através das
// compactações, avisar o dono quando a memória vai ser organizada, e marcar
// quando a sessão está ociosa. A memória de longo prazo é a NATIVA do Claude
// Code (re-injetada sozinha) — aqui só cuidamos do que o nativo não cobre.
//
// Falha silenciosa SEMPRE: a conversa precisa continuar mesmo se isto quebrar.

import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import {
  appendTail,
  bumpTurns,
  contextBytesSinceCompact,
  CONTEXT_FULL_BYTES,
  dgDir,
  idleFile,
  lastTailLines,
  logCompactEvent,
  pidAlive,
  readConfig,
  readTextSafe,
  recordCompactBase,
  resetTurns,
  sendToOwner,
  workspaceRoot,
} from "../scripts/lib";
import { join } from "node:path";

const N_MSGS = 24; // últimas mensagens do fio re-injetadas no pós-compact
const NUDGE_EVERY = 25; // a cada N turnos: lembrete de atualizar memória
const WARN_CONTEXT_AT = 0.7; // avisa o dono quando o contexto passa de 70%

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  trigger?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function emitContext(event: string, context: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    }),
  );
}

// ---------- injetor experimental (só age se o dgclaw-run.ts estiver rodando) ----------

function injectorActive(ws: string): boolean {
  const pid = parseInt(readTextSafe(join(dgDir(ws), "injector.pid")).trim(), 10);
  return !!pid && pidAlive(pid);
}

/** Detecta gatilhos de comando vindos pelo Telegram (slash chega como TEXTO).
 *  Retorna a instrução pro agente, e enfileira o comando pro wrapper injetar
 *  quando a sessão ficar ociosa. */
function detectInjectTrigger(ws: string, text: string): string | null {
  if (!injectorActive(ws)) return null;
  const t = text.toLowerCase().trim();
  let cmd: string | null = null;
  let note: string | null = null;
  if (t === "/compact" || t.includes("organiza sua cabeça") || t.includes("organiza sua cabeca")) {
    cmd = "/compact";
    note =
      "O dono pediu a compactação. Responda curto avisando que vai organizar a memória agora. " +
      "O sistema vai disparar o /compact sozinho assim que você terminar este turno — não tente você mesmo.";
  } else if (t === "/recomeçar" || t === "/recomecar" || t === "/clear") {
    cmd = "/clear";
    note =
      "O dono pediu um recomeço. ANTES de terminar o turno: (1) salve no working-memory.md um resumo " +
      "de handoff (tarefa atual, decisões, pendências); (2) responda avisando que vai dar um recomeço " +
      "rápido e volta em segundos. O sistema vai limpar a conversa em seguida — você volta com " +
      "persona + memória + seu resumo.";
  }
  if (!cmd) return null;
  try {
    appendFileSync(join(dgDir(ws), "inject-queue"), cmd + "\n", "utf8");
  } catch {
    return null;
  }
  return note;
}

// ---------- UserPromptSubmit ----------

function userPrompt(ws: string, input: HookInput): void {
  const raw = input.prompt ?? "";
  // remove o envelope <channel ...> que o plugin telegram põe em volta da msg
  const text = raw.replace(/<\/?channel[^>]*>/g, "").trim();
  if (!text) return;

  appendTail(ws, "Dono", text);
  const turns = bumpTurns(ws);

  // sessão deixou de estar ociosa (sinal usado pelo injetor e pelo painel)
  try {
    rmSync(idleFile(ws), { force: true });
  } catch {
    /* melhor esforço */
  }

  const notes: string[] = [];

  // gatilhos do injetor experimental (/compact e /recomeçar pelo Telegram)
  const injectNote = detectInjectTrigger(ws, text);
  if (injectNote) notes.push(injectNote);

  // nudge de memória — substitui a consolidação por timer do modo servidor
  if (turns > 0 && turns % NUDGE_EVERY === 0) {
    notes.push(
      "Lembrete interno: já se passaram várias mensagens. Se surgiu fato novo que vale guardar " +
        "(preferência, pessoa, decisão, tarefa), atualize AGORA o working-memory.md e, se for " +
        "durável, a sua memória de longo prazo (auto-memória nativa). Faça em silêncio, sem anunciar.",
    );
  }

  // medidor de contexto — avisa o dono que a compactação se aproxima
  const bytes = contextBytesSinceCompact(ws, input.transcript_path);
  const pct = bytes / CONTEXT_FULL_BYTES;
  if (pct >= WARN_CONTEXT_AT && turns % 10 === 0) {
    notes.push(
      `Aviso interno: sua memória de trabalho está ~${Math.min(99, Math.round(pct * 100))}% cheia; ` +
        "em breve o sistema vai compactar a conversa sozinho (você NÃO perde o fio — ele é re-injetado). " +
        "Avise o dono em tom leve, tipo: 'minha memória de trabalho tá enchendo, daqui a pouco dou uma " +
        "organizada rápida na cabeça, pode seguir normal'.",
    );
  }

  if (notes.length) emitContext("UserPromptSubmit", notes.join("\n\n"));
}

// ---------- PostToolUse (matcher: mcp__.*telegram.*) ----------

function postTool(ws: string, input: HookInput): void {
  const name = (input.tool_name ?? "").toLowerCase();
  if (!name.includes("telegram")) return;
  if (!(name.includes("reply") || name.includes("send"))) return;
  const inp = input.tool_input ?? {};
  const text = String(inp.text ?? inp.message ?? "").trim();
  if (!text) return;
  const nome = readConfig(ws).name ?? "bot";
  appendTail(ws, `Você (${nome})`, text);
}

// ---------- SessionStart (startup | resume | compact) ----------

function sessionStart(ws: string, input: HookInput): void {
  const source = input.source ?? "";

  if (source === "compact") {
    resetTurns(ws);
    recordCompactBase(ws, input.transcript_path);
    logCompactEvent(ws, { event: "post-compact" });
  }

  const parts: string[] = [];

  const wm = readTextSafe(join(ws, "working-memory.md"));
  if (wm.trim()) {
    const body = wm
      .split("\n")
      .filter((l) => !l.startsWith(">"))
      .slice(0, 60)
      .join("\n");
    parts.push(`## Sua memória de curto prazo (working-memory.md)\n\n${body}`);
  }

  const tail = lastTailLines(ws, N_MSGS);
  if (tail) {
    parts.push(`## Últimas mensagens da conversa no Telegram (o fio que o dono vê)\n\n${tail}`);
  }

  if (!parts.length) return;

  const header =
    source === "compact"
      ? "A conversa acabou de ser compactada. Pra você NÃO perder o fio do Telegram, aqui está o " +
        "contexto real (use isto como a verdade da conversa atual). Assim que fizer sentido, mande um " +
        "reply curto ao dono avisando que voltou, no espírito de: 'pronto, organizei a cabeça — " +
        "seguindo em <tarefa atual do working-memory>'. Não repita a última resposta."
      : "Contexto pra você retomar a conversa com o dono (memória de curto prazo + últimas mensagens do Telegram):";

  emitContext("SessionStart", `${header}\n\n${parts.join("\n\n")}`);
}

// ---------- PreCompact ----------

async function preCompact(ws: string, input: HookInput): Promise<void> {
  logCompactEvent(ws, { event: "pre-compact", trigger: input.trigger ?? "auto" });
  // aviso rápido ao dono — melhor esforço, nunca bloqueia a compactação
  await sendToOwner(ws, "⏳ organizando minha memória, um instante...", 6000).catch(() => null);
}

// ---------- Stop ----------

function stop(ws: string): void {
  try {
    writeFileSync(idleFile(ws), new Date().toISOString(), "utf8");
  } catch {
    /* melhor esforço */
  }
}

// ---------- main ----------

async function main() {
  const event = process.argv[2] ?? "";
  let input: HookInput = {};
  try {
    if (!process.stdin.isTTY) input = JSON.parse(await Bun.stdin.text());
  } catch {
    input = {};
  }
  const ws = input.cwd && existsSync(join(input.cwd, ".dgclaw")) ? input.cwd : workspaceRoot();
  if (!existsSync(dgDir(ws))) return; // fora de um workspace DG Claw: não faz nada

  switch (event) {
    case "user-prompt":
      userPrompt(ws, input);
      break;
    case "post-tool":
      postTool(ws, input);
      break;
    case "session-start":
      sessionStart(ws, input);
      break;
    case "pre-compact":
      await preCompact(ws, input);
      break;
    case "stop":
      stop(ws);
      break;
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
