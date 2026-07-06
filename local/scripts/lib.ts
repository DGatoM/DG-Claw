// lib.ts — helpers compartilhados do DG Claw modo local (Bun, cross-platform).
// Tudo aqui precisa funcionar em Windows, macOS e Linux: nada de $HOME em string,
// nada de bash. Caminhos sempre via path.join / os.homedir().

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

// ---------- workspace ----------

/** Acha a raiz do workspace do agente: env DGCLAW_WORKSPACE, ou sobe a partir
 *  do cwd até achar uma pasta com .dgclaw/. */
export function workspaceRoot(): string {
  const env = process.env.DGCLAW_WORKSPACE;
  if (env && existsSync(join(env, ".dgclaw"))) return resolve(env);
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".dgclaw"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd(); // melhor esforço; quem chamar valida
}

export const dgDir = (ws: string) => join(ws, ".dgclaw");

export interface DgConfig {
  name?: string;
  owner?: string;
  slug?: string;
  panelPort?: number;
  createdAt?: string;
  pluginVersion?: string;
}

export function readConfig(ws: string): DgConfig {
  return readJsonSafe<DgConfig>(join(dgDir(ws), "config.json")) ?? {};
}

// ---------- json / arquivos ----------

export function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readTextSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---------- telegram (state dir do plugin oficial) ----------

/** State dir do canal telegram DESTE agente (local à pasta do agente). */
export function stateDir(ws: string): string {
  return process.env.TELEGRAM_STATE_DIR ?? join(dgDir(ws), "telegram");
}

/** Token do bot: env real ganha; senão lê o .env do state dir (mesma regra do
 *  server.ts do plugin oficial). */
export function botToken(ws: string): string | null {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const env = readTextSafe(join(stateDir(ws), ".env"));
  const m = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

export interface AccessJson {
  dmPolicy?: string;
  allowFrom?: string[];
  pending?: Record<string, { senderId: string | number }>;
  ackReaction?: string;
}

export function readAccess(ws: string): AccessJson | null {
  return readJsonSafe<AccessJson>(join(stateDir(ws), "access.json"));
}

/** chat_id do dono = primeiro id da allowlist do pareamento. */
export function ownerChatId(ws: string): string | null {
  const a = readAccess(ws);
  return a?.allowFrom?.[0] ?? null;
}

/** Manda mensagem ao dono via Bot API sendMessage. NÃO conflita com o poller
 *  (getUpdates é exclusivo; enviar é livre). Melhor esforço: retorna ok/erro. */
export async function sendToOwner(
  ws: string,
  text: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; error?: string }> {
  const token = botToken(ws);
  if (!token) return { ok: false, error: "token do bot não encontrado (.env do state dir)" };
  const chatId = ownerChatId(ws);
  if (!chatId) return { ok: false, error: "dono ainda não pareado (allowFrom vazio no access.json)" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (res.ok && body?.ok) return { ok: true };
    return { ok: false, error: body?.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------- claude config dir / memória nativa ----------

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Slug de projeto do Claude Code: caminho absoluto com tudo que não é
 *  alfanumérico virando "-" (ex.: /root -> -root). */
export function projectSlug(ws: string): string {
  return resolve(ws).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Pasta da memória NATIVA do Claude Code para este workspace. */
export function nativeMemoryDir(ws: string): string {
  return join(claudeConfigDir(), "projects", projectSlug(ws), "memory");
}

export function nativeMemoryFile(ws: string): string {
  return join(nativeMemoryDir(ws), "MEMORY.md");
}

// ---------- chat-tail / contadores ----------

const TAIL_MAX_LINES = 80;
const LINE_MAX_CHARS = 500;

export function tailFile(ws: string): string {
  return join(dgDir(ws), "chat-tail.md");
}

/** Acrescenta uma linha ao fio da conversa e mantém só as últimas 80. */
export function appendTail(ws: string, who: string, text: string): void {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX_CHARS);
  if (!clean) return;
  const path = tailFile(ws);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${who}: ${clean}\n`, "utf8");
  const lines = readTextSafe(path).split("\n").filter(Boolean);
  if (lines.length > TAIL_MAX_LINES) {
    writeFileSync(path, lines.slice(-TAIL_MAX_LINES).join("\n") + "\n", "utf8");
  }
}

export function lastTailLines(ws: string, n: number): string {
  const lines = readTextSafe(tailFile(ws)).split("\n").filter(Boolean);
  return lines.slice(-n).join("\n");
}

export function bumpTurns(ws: string): number {
  const path = join(dgDir(ws), "turns.count");
  const n = (parseInt(readTextSafe(path).trim(), 10) || 0) + 1;
  try {
    writeFileSync(path, String(n), "utf8");
  } catch {
    /* melhor esforço */
  }
  return n;
}

export function resetTurns(ws: string): void {
  try {
    writeFileSync(join(dgDir(ws), "turns.count"), "0", "utf8");
  } catch {
    /* melhor esforço */
  }
}

// ---------- medidor de contexto ----------

/** Bytes do transcript desde a última compactação (base gravada no pós-compact). */
export function contextBytesSinceCompact(ws: string, transcriptPath?: string): number {
  if (!transcriptPath) return 0;
  const base = parseInt(readTextSafe(join(dgDir(ws), "compact-base.size")).trim(), 10) || 0;
  return Math.max(0, fileSize(transcriptPath) - base);
}

export function recordCompactBase(ws: string, transcriptPath?: string): void {
  if (!transcriptPath) return;
  try {
    writeFileSync(join(dgDir(ws), "compact-base.size"), String(fileSize(transcriptPath)), "utf8");
  } catch {
    /* melhor esforço */
  }
}

/** Heurística: o auto-compact costuma chegar com ~2.5MB de jsonl novo. */
export const CONTEXT_FULL_BYTES = 2_500_000;

// ---------- status (vivo/ocioso) ----------

export function idleFile(ws: string): string {
  return join(dgDir(ws), "idle");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID do poller do telegram (bot.pid do state dir), se vivo. */
export function botPid(ws: string): number | null {
  const raw = readTextSafe(join(stateDir(ws), "bot.pid")).trim();
  const pid = parseInt(raw, 10);
  if (!pid) return null;
  return pidAlive(pid) ? pid : null;
}

// ---------- log de compactações ----------

export function logCompactEvent(ws: string, event: Record<string, unknown>): void {
  try {
    const path = join(dgDir(ws), "compact-log.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {
    /* melhor esforço */
  }
}
