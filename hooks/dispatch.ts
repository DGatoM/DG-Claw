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
  // quadro de avisos da equipe (le o retrato local .dgclaw/retratos/avisos.json; sai calado se ele ainda nao existe)
  "avisos": ["python3", "-I", "avisos.py"],
  "avisos-reset": ["python3", "-I", "avisos.py", "reset"],
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

  // Os scripts rodam SEMPRE de dentro da pasta dos hooks (de root, fora do alcance do agente) e com um
  // ambiente sem os ganchos de interpretador: o cwd da sessão pode ser um repositório de terceiros, e
  // python/bash/node carregariam código de lá (json.py ao lado, BASH_ENV, PYTHONSTARTUP...). O
  // workspace chega pela variável DGCLAW_WORKSPACE, nunca pelo cwd.
  const env: Record<string, string | undefined> = { ...process.env, DGCLAW_WORKSPACE: ws, PYTHONSAFEPATH: "1" };
  for (const k of Object.keys(env)) {
    if (k.startsWith("PYTHON") && k !== "PYTHONSAFEPATH") delete env[k];
    else if (k.startsWith("BUN_") || k === "NODE_OPTIONS" || k === "BASH_ENV" || k === "ENV" || k.startsWith("BASH_FUNC_")) delete env[k];
  }
  const [interp, ...resto] = script;
  const iFile = resto.findIndex((a) => a.endsWith(".sh") || a.endsWith(".py"));
  const args = resto.map((a, i) => (i === iFile ? resolve(import.meta.dir, a) : a));
  const proc = Bun.spawn([interp, ...args], {
    cwd: import.meta.dir,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (out) process.stdout.write(out);
}

main()
  // Um hook nunca pode derrubar a sessão: o erro vai para o stderr e o processo sai com 0.
  .catch((e) => console.error(`dgclaw dispatch (${process.argv[2] ?? "?"}): o hook falhou e foi ignorado: ${e && e.message ? e.message : e}. A sessão segue; rode o script do hook à mão para ver o motivo.`))
  .finally(() => process.exit(0));
