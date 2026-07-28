#!/usr/bin/env bun
// dgclaw-run.ts — launcher EXPERIMENTAL com injetor de comandos (§ avançado).
//
// Roda o `claude --continue --channels ...` dentro de um pty controlado,
// espelhando tudo no terminal do usuário. Isso permite "digitar" comandos de
// verdade na sessão quando o dono pede pelo Telegram:
//   - "/compact" (ou "organiza sua cabeça")  → injeta /compact
//   - "/recomeçar"                            → injeta /clear (handoff local:
//     o hook manda o agente salvar o resumo no working-memory antes)
//
// Como funciona: o hook user-prompt detecta o gatilho e grava o comando em
// .dgclaw/inject-queue; este wrapper injeta SÓ com a sessão OCIOSA (sinal =
// .dgclaw/idle, escrito pelo hook Stop — keystroke em turno em voo se perde).
//
// STATUS: EXPERIMENTAL — depende do node-pty (prebuilds win/mac). Se o
// node-pty não estiver disponível, cai no modo simples (sem injeção), que é o
// mesmo comportamento do launcher normal. O launcher padrão do wizard NÃO usa
// isto; é opt-in pra teste (dogfooding).
//
// Uso:  bun .dgclaw/scripts/dgclaw-run.ts        (na pasta do agente)
// Pré:  bun add node-pty   (na pasta .dgclaw/scripts — cria node_modules ali)

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dgDir, idleFile, workspaceRoot } from "./lib";

const WS = workspaceRoot();
const QUEUE = join(dgDir(WS), "inject-queue");
const INJECTOR_PID = join(dgDir(WS), "injector.pid");
const CLAUDE_ARGS = ["--continue", "--channels", "plugin:telegram@claude-plugins-official"];
const IDLE_MIN_AGE_MS = 3000; // ocioso há pelo menos isso antes de injetar

process.env.TELEGRAM_STATE_DIR ??= join(dgDir(WS), "telegram");

function claudeArgs(): string[] {
  // primeira partida da pasta: sem --continue (não há conversa pra retomar)
  const marker = join(dgDir(WS), "first-run-done");
  if (existsSync(marker)) return CLAUDE_ARGS;
  writeFileSync(marker, "ok", "utf8");
  return CLAUDE_ARGS.slice(1);
}

function sessionIdleFor(): number {
  try {
    return Date.now() - statSync(idleFile(WS)).mtimeMs;
  } catch {
    return -1; // sem marcador = em turno (ou sessão recém-aberta)
  }
}

function nextCommand(): string | null {
  try {
    const lines = readFileSync(QUEUE, "utf8").split("\n").filter(Boolean);
    if (!lines.length) return null;
    const [cmd, ...rest] = lines;
    if (rest.length) writeFileSync(QUEUE, rest.join("\n") + "\n", "utf8");
    else rmSync(QUEUE, { force: true });
    return cmd.trim();
  } catch {
    return null;
  }
}

async function runWithPty(pty: typeof import("node-pty")): Promise<never> {
  const shellCols = process.stdout.columns || 100;
  const shellRows = process.stdout.rows || 30;
  const p = pty.spawn("claude", claudeArgs(), {
    name: "xterm-256color",
    cols: shellCols,
    rows: shellRows,
    cwd: WS,
    env: process.env as Record<string, string>,
  });

  writeFileSync(INJECTOR_PID, String(process.pid), "utf8");
  rmSync(QUEUE, { force: true }); // nunca injetar pedido de uma sessão anterior

  p.onData((d) => process.stdout.write(d));
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => p.write(d.toString()));
  process.stdout.on("resize", () => p.resize(process.stdout.columns || 100, process.stdout.rows || 30));

  const timer = setInterval(() => {
    const idleMs = sessionIdleFor();
    if (idleMs < IDLE_MIN_AGE_MS) return;
    const cmd = nextCommand();
    if (!cmd) return;
    // digita o comando e confirma — como se o dono tivesse digitado no terminal
    p.write(cmd);
    setTimeout(() => p.write("\r"), 400);
  }, 2000);

  p.onExit(({ exitCode }) => {
    clearInterval(timer);
    rmSync(INJECTOR_PID, { force: true });
    process.stdin.setRawMode?.(false);
    process.exit(exitCode ?? 0);
  });

  return new Promise(() => {}) as Promise<never>;
}

async function runSimple(): Promise<never> {
  console.log("(injetor indisponível — modo simples, igual ao launcher normal)");
  const proc = Bun.spawn(["claude", ...claudeArgs()], {
    cwd: WS,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env as Record<string, string>,
  });
  process.exit(await proc.exited);
}

async function main() {
  if (!existsSync(dgDir(WS))) {
    console.error(`não achei um agente DG Claw aqui: ${WS}`);
    process.exit(1);
  }
  try {
    const pty = await import("node-pty");
    console.log("🧪 injetor experimental ATIVO (/compact e /recomeçar via Telegram)");
    await runWithPty(pty);
  } catch {
    await runSimple();
  }
}

main();
