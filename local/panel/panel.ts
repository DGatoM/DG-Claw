#!/usr/bin/env bun
// panel.ts — painel web do DG Claw modo local (Bun.serve, zero deps).
//
// Roda SÓ em localhost (127.0.0.1:8200) — é o computador da própria pessoa,
// então não precisa de token. Mostra e edita a memória do agente:
//   - status vivo/mudo (bot.pid) + ocioso/trabalhando (.dgclaw/idle)
//   - medidor de contexto (quanto falta pra próxima compactação)
//   - working-memory.md (curto prazo, editável)
//   - memória nativa do Claude Code (MEMORY.md, editável)
//   - fio da conversa do Telegram (chat-tail.md)
//   - log de compactações
//
// Uso:  bun .dgclaw/panel/panel.ts        (na pasta do agente)
// Parar: skill /dgclaw:panel (usa o .dgclaw/panel.pid)

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  botPid,
  contextBytesSinceCompact,
  CONTEXT_FULL_BYTES,
  dgDir,
  idleFile,
  lastTailLines,
  nativeMemoryFile,
  readConfig,
  readTextSafe,
  workspaceRoot,
} from "../scripts/lib";

const WS = workspaceRoot();
if (!existsSync(dgDir(WS))) {
  console.error(`não achei um agente DG Claw aqui: ${WS} (rode na pasta do agente)`);
  process.exit(1);
}
const CFG = readConfig(WS);
const NAME = CFG.name ?? "DG Claw";
const PORT = Number(process.env.DGCLAW_PANEL_PORT ?? CFG.panelPort ?? 8200);

const FILES: Record<string, { path: string; title: string; hint: string }> = {
  working: {
    path: join(WS, "working-memory.md"),
    title: "Curto prazo — working-memory.md",
    hint: "O “agora”: tarefas em aberto, contexto recente. O agente lê e atualiza sozinho.",
  },
  native: {
    path: nativeMemoryFile(WS),
    title: "Longo prazo — memória nativa (MEMORY.md)",
    hint: "Índice da auto-memória do Claude Code. Carregado em toda sessão; o agente anota sozinho.",
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function status() {
  const pid = botPid(WS);
  const idleRaw = readTextSafe(idleFile(WS)).trim();
  // sem transcript aqui; usamos o último tamanho vs base (aproximação do painel)
  const bytes = contextBytesSinceCompact(WS, latestTranscript());
  const pct = Math.min(99, Math.round((bytes / CONTEXT_FULL_BYTES) * 100));
  let lastTurn = "";
  try {
    lastTurn = statSync(join(dgDir(WS), "chat-tail.md")).mtime.toLocaleString("pt-BR");
  } catch {
    /* sem conversa ainda */
  }
  return {
    alive: pid != null,
    pid,
    state: pid == null ? "MUDO (sessão fechada?)" : idleRaw ? "ocioso" : "trabalhando",
    idleSince: idleRaw,
    contextPct: pct,
    lastTurn,
  };
}

/** Transcript .jsonl mais recente do projeto (pra estimar o contexto). */
function latestTranscript(): string | undefined {
  try {
    const projDir = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(require("node:os").homedir(), ".claude"),
      "projects",
      require("node:path").resolve(WS).replace(/[^a-zA-Z0-9]/g, "-"),
    );
    const files = require("node:fs")
      .readdirSync(projDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => ({ f, m: statSync(join(projDir, f)).mtimeMs }))
      .sort((a: { m: number }, b: { m: number }) => b.m - a.m);
    return files.length ? join(projDir, files[0].f) : undefined;
  } catch {
    return undefined;
  }
}

function compactLog(): string {
  const lines = readTextSafe(join(dgDir(WS), "compact-log.jsonl")).split("\n").filter(Boolean).slice(-10);
  if (!lines.length) return "(nenhuma compactação ainda)";
  return lines
    .map((l) => {
      try {
        const d = JSON.parse(l);
        return `${new Date(d.ts).toLocaleString("pt-BR")} — ${d.event}${d.trigger ? ` (${d.trigger})` : ""}`;
      } catch {
        return l;
      }
    })
    .reverse()
    .join("\n");
}

function page(saved?: string): string {
  const st = status();
  const dot = st.alive ? (st.idleSince ? "🟢" : "🟠") : "🔴";
  const blocks = Object.entries(FILES)
    .map(([key, f]) => {
      const content = existsSync(f.path) ? readFileSync(f.path, "utf8") : "";
      const missing = !existsSync(f.path)
        ? `<p class=hint>⚠️ ainda não existe (${esc(f.path)}) — aparece depois da primeira conversa/anotação.</p>`
        : "";
      return `<form method=post action="/save">
<h2>${esc(f.title)}</h2><p class=hint>${esc(f.hint)}</p>${missing}
<input type=hidden name=file value="${key}">
<textarea name=content spellcheck=false>${esc(content)}</textarea>
<button type=submit>Salvar</button></form>`;
    })
    .join("\n");

  return `<!doctype html><html lang=pt-br><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>${esc(NAME)} — painel</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:880px;margin:0 auto;padding:18px;background:#0f1115;color:#e6e6e6}
 h1{font-size:20px} h2{font-size:15px;margin:22px 0 4px;color:#8ab4f8}
 .hint{color:#9aa;font-size:13px;margin:2px 0 8px}
 .card{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:12px 16px;margin:10px 0}
 .meter{background:#232838;border-radius:6px;height:14px;overflow:hidden;margin-top:6px}
 .meter i{display:block;height:100%;background:linear-gradient(90deg,#2f6feb,#e0a030);width:${st.contextPct}%}
 textarea{width:100%;box-sizing:border-box;min-height:180px;background:#171a21;color:#e6e6e6;
   border:1px solid #2a2f3a;border-radius:8px;padding:10px;font:13px/1.5 ui-monospace,monospace}
 pre{background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:10px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap}
 button{background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer;margin-top:8px}
 .ok{color:#7fdc8f}
</style></head><body>
<h1>🐾 ${esc(NAME)} — painel</h1>
${saved ? `<p class=ok>✓ ${esc(saved)} salvo.</p>` : ""}
<div class=card>
 <b>${dot} ${esc(st.state)}</b>${st.pid ? ` — canal telegram vivo (pid ${st.pid})` : " — abra o launcher pra ligar"}<br>
 <span class=hint>último turno: ${esc(st.lastTurn || "—")}</span>
 <div class=hint style="margin-top:8px">memória de trabalho (estimativa até a próxima organização automática): ${st.contextPct}%</div>
 <div class=meter><i></i></div>
</div>
${blocks}
<h2>Fio da conversa (Telegram)</h2>
<p class=hint>As últimas mensagens trocadas — é isto que sobrevive às compactações.</p>
<pre>${esc(lastTailLines(WS, 40) || "(sem conversa ainda)")}</pre>
<h2>Organizações de memória (compactações)</h2>
<pre>${esc(compactLog())}</pre>
<p class=hint>Página estática — recarregue (F5) pra atualizar. Painel local: só este computador enxerga.</p>
</body></html>`;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(page(url.searchParams.get("saved") ?? undefined), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname === "/save") {
      const form = await req.formData();
      const key = String(form.get("file") ?? "");
      const f = FILES[key];
      if (!f) return new Response("arquivo inválido", { status: 400 });
      const content = String(form.get("content") ?? "").replace(/\r\n/g, "\n");
      require("node:fs").mkdirSync(require("node:path").dirname(f.path), { recursive: true });
      writeFileSync(f.path, content, "utf8");
      return new Response(null, { status: 303, headers: { Location: `/?saved=${encodeURIComponent(key)}` } });
    }
    return new Response("404", { status: 404 });
  },
});

writeFileSync(join(dgDir(WS), "panel.pid"), String(process.pid), "utf8");
console.log(`painel do ${NAME} no ar: http://127.0.0.1:${server.port}  (Ctrl+C pra parar)`);
