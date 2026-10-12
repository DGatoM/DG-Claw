#!/usr/bin/env bun
// dispatch.ts — porteiro dos hooks de PLUGIN do DG Claw (v0.2).
//
// Hooks registrados no hooks.json de um plugin rodam em TODAS as sessões da
// máquina onde o plugin está habilitado. No v0.1 isso vazava os hooks bash pra
// qualquer sessão (e quebraria no Windows). Este dispatcher corrige:
//
//   - Sessão num workspace DG Claw MODO SERVIDOR (tem .dgclaw/config.sh, Linux)
//     → repassa pro hook bash original do v0.1 (comportamento intacto).
//   - Qualquer outra sessão (outros projetos, Windows/Mac, modo local — que usa
//     hooks project-scoped no .claude/settings.json do workspace)
//     → sai em silêncio, sem efeito colateral nenhum.
//
// Uso (hooks.json): bun "${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.ts" <evento>

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// [interpretador, script, ...argumentos]
const SCRIPT_BY_EVENT: Record<string, string[]> = {
  "user-prompt": ["bash", "memory-recall.sh"],
  "post-tool": ["bash", "log-reply.sh"],
  "session-start": ["bash", "session-context.sh"],
  // quadro de avisos da equipe (opcional; o script sai calado sem DGCLAW_MESA_URL)
  "avisos": ["python3", "avisos.py"],
  "avisos-reset": ["python3", "avisos.py", "reset"],
};

async function main() {
  const event = process.argv[2] ?? "";
  const script = SCRIPT_BY_EVENT[event];
  const stdin = process.stdin.isTTY ? "" : await Bun.stdin.text();
  if (!script || process.platform === "win32") return;

  // workspace: env do serviço v0.1 ganha; senão o cwd da sessão (do hook input)
  let ws = process.env.DGCLAW_WORKSPACE ?? "";
  if (!ws) {
    try {
      ws = JSON.parse(stdin).cwd ?? "";
    } catch {
      ws = "";
    }
  }
  if (!ws) ws = process.cwd();
  ws = resolve(ws);

  // marcador do modo servidor v0.1; fora dele, este hook não existe
  if (!existsSync(join(ws, ".dgclaw", "config.sh"))) return;

  const [interp, file, ...args] = script;
  const proc = Bun.spawn([interp, resolve(import.meta.dir, file), ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, DGCLAW_WORKSPACE: ws },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (out) process.stdout.write(out);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
