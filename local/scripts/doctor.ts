#!/usr/bin/env bun
// doctor.ts — diagnóstico + auto-conserto do agente DG Claw modo local.
//
// Cobre os erros REAIS que deixam o bot mudo, em Windows/macOS/Linux:
//   - token inválido (getMe)
//   - needs-auth cache preso (regressão conhecida: o canal telegram é pulado
//     no startup quando ~/.claude/mcp-needs-auth-cache.json carimba o plugin)
//   - 409 Conflict (dois processos no mesmo token / launcher aberto 2x)
//   - sessão fechada (bot.pid morto)
//   - hooks não registrados no .claude/settings.json do workspace
//   - pareamento pendente
//
// Uso:  bun .dgclaw/scripts/doctor.ts     (na pasta do agente)
// Exit code = itens [FALTA] restantes.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  botPid,
  botToken,
  claudeConfigDir,
  dgDir,
  readAccess,
  readConfig,
  readJsonSafe,
  stateDir,
  workspaceRoot,
} from "./lib";

let pass = 0,
  fail = 0,
  fixed = 0;
const ok = (m: string) => (console.log(`  [ OK ] ${m}`), pass++);
const bad = (m: string) => (console.log(`  [FALTA] ${m}`), fail++);
const fix = (m: string) => (console.log(`  [CONSERTADO] ${m}`), fixed++);

async function tg(token: string, method: string, timeoutMs = 8000): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const ws = workspaceRoot();
  if (!existsSync(dgDir(ws))) {
    console.error(`não achei um agente DG Claw aqui: ${ws} (rode na pasta do agente)`);
    process.exit(1);
  }
  const cfg = readConfig(ws);
  console.log(`=== DG Claw doctor (local): ${cfg.name ?? "?"} — ${ws} ===\n`);

  // 1. config.json
  cfg.name ? ok(`config.json ok (agente ${cfg.name})`) : bad("config.json ausente/incompleto — rode o wizard /dgclaw:setup de novo");

  // 2. token do bot + getMe
  const token = botToken(ws);
  let tokenOk = false;
  if (!token) {
    bad(`token não encontrado em ${join(stateDir(ws), ".env")} — refaça o passo do BotFather no wizard`);
  } else {
    try {
      const r = await tg(token, "getMe");
      if (r.body?.ok) {
        tokenOk = true;
        ok(`token válido — bot @${r.body.result?.username}`);
      } else if (r.status === 401) {
        bad("token INVÁLIDO (401) — o BotFather pode ter revogado; gere outro com /token e refaça o wizard");
      } else {
        bad(`Telegram respondeu estranho ao getMe (HTTP ${r.status}) — confira a internet e rode de novo`);
      }
    } catch {
      bad("sem resposta do Telegram (internet/firewall/VPN?)");
    }
  }

  // 3. needs-auth cache preso (auto-conserta)
  const cachePath = join(claudeConfigDir(), "mcp-needs-auth-cache.json");
  const cache = readJsonSafe<Record<string, unknown>>(cachePath);
  if (cache && Object.keys(cache).some((k) => k.includes("telegram"))) {
    try {
      for (const k of Object.keys(cache)) if (k.includes("telegram")) delete cache[k];
      writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
      fix("cache needs-auth estava travando o canal telegram — limpei (feche e reabra o launcher)");
    } catch {
      bad(`cache needs-auth preso em ${cachePath} — apague a linha com "telegram" e reabra o launcher`);
    }
  } else {
    ok("cache needs-auth limpo (canal telegram não está sendo pulado)");
  }

  // 4. sessão viva + 409 (dois launchers)
  const pid = botPid(ws);
  if (tokenOk && token) {
    let conflict = false;
    try {
      const r = await tg(token, "getUpdates?timeout=0&limit=1");
      conflict = r.status === 409;
    } catch {
      /* rede já checada acima */
    }
    if (pid && conflict) {
      ok(`canal telegram VIVO (poller pid ${pid} segurando o getUpdates)`);
    } else if (pid && !conflict) {
      bad(`processo do bot existe (pid ${pid}) mas o poller NÃO está segurando o Telegram — feche o launcher e abra de novo`);
    } else if (!pid && conflict) {
      bad("OUTRO processo está usando este token (launcher aberto 2x? outro computador?) — feche todas as janelas e abra o launcher UMA vez");
    } else {
      bad("sessão do agente não está rodando — abra o launcher (Iniciar <Nome>)");
    }
  }

  // 5. hooks registrados no workspace
  const settingsText = existsSync(join(ws, ".claude", "settings.json"))
    ? readFileSync(join(ws, ".claude", "settings.json"), "utf8")
    : "";
  settingsText.includes("dgclaw-hooks.ts")
    ? ok("hooks do DG Claw registrados no .claude/settings.json do agente")
    : bad("hooks NÃO registrados — rode o wizard de novo (passo do settings.json) pra não perder o fio pós-compactação");

  // 6. pareamento + ackReaction
  const access = readAccess(ws);
  if (access?.allowFrom?.length) {
    ok(`pareado com o dono (id ${access.allowFrom[0]})`);
  } else if (access && Object.keys(access.pending ?? {}).length) {
    bad("pareamento PENDENTE — mande uma mensagem pro bot e aprove no wizard (/dgclaw:setup faz sozinho)");
  } else {
    bad("ninguém pareado ainda — mande uma mensagem pro bot e rode o passo de pareamento do wizard");
  }
  access?.ackReaction
    ? ok(`ackReaction ligado (${access.ackReaction} confirma que a mensagem chegou)`)
    : bad('ackReaction desligado — adicione "ackReaction": "👀" no access.json do state dir');

  // 7. memória nativa habilitada? (informativo — auto-memory é o default)
  const home = join(homedir(), ".claude");
  ok(`memória nativa do Claude Code em uso (config dir: ${process.env.CLAUDE_CONFIG_DIR ?? home})`);

  console.log(`\n=== resumo: ${pass} ok, ${fixed} consertado(s), ${fail} faltando ===`);
  console.log(fail === 0 ? ">> TUDO CERTO. Manda um oi pro bot. 🐾" : `>> ainda faltam ${fail} item(ns) acima.`);
  process.exit(fail);
}

main();
