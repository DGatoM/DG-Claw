#!/usr/bin/env bun
// checkup.ts — check-up da máquina do aluno ANTES de instalar o agente local.
//
// Roda em Windows, macOS e Linux. Imprime um checklist ✅/❌ com a instrução
// exata do que instalar quando falta algo. Exit code = quantidade de ❌
// (o wizard só segue com exit 0).
//
// Uso:  bun checkup.ts
// (se o Bun ainda não existe, o wizard faz estes checks na mão — ver SKILL.md)

import { existsSync, readdirSync } from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const MIN_CLAUDE = [2, 1, 80]; // primeira versão com --channels estável

let fails = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const bad = (msg: string, fix: string) => {
  console.log(`  ❌ ${msg}`);
  console.log(`     → como resolver: ${fix}`);
  fails++;
};

function cmpVersion(v: string, min: number[]): boolean {
  const parts = v.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

async function main() {
  const os = platform(); // win32 | darwin | linux
  const osName = os === "win32" ? "Windows" : os === "darwin" ? "macOS" : "Linux";
  console.log(`=== DG Claw check-up — ${osName} ${release()} (${arch()}) ===\n`);

  // 1. Bun (se este script está rodando, tem Bun — registra a versão)
  ok(`Bun ${Bun.version} instalado`);

  // 2. Claude Code presente e com versão que tem channels
  try {
    const out = (await $`claude --version`.nothrow().quiet()).text().trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (!m) {
      bad("Claude Code não respondeu à versão", "feche e reabra o terminal; se persistir, reinstale o Claude Code (https://claude.com/claude-code)");
    } else if (cmpVersion(m[1], MIN_CLAUDE)) {
      ok(`Claude Code ${m[1]} (>= ${MIN_CLAUDE.join(".")}, tem canais/Telegram)`);
    } else {
      bad(`Claude Code ${m[1]} é antigo demais (precisa >= ${MIN_CLAUDE.join(".")})`, "atualize: claude update (ou reinstale pelo site)");
    }
  } catch {
    bad("Claude Code não está no PATH", "instale em https://claude.com/claude-code e reabra o terminal");
  }

  // 3. Login do Claude (Pro/Max) — presença do config
  const cfg = configDir();
  if (existsSync(join(cfg, ".credentials.json")) || existsSync(join(homedir(), ".claude.json")) || existsSync(join(cfg, "..", ".claude.json"))) {
    ok("Claude Code já foi aberto/logado nesta máquina");
  } else {
    bad("parece que o Claude Code nunca foi logado aqui", "rode `claude` uma vez e faça o login com sua assinatura Pro/Max");
  }

  // 4. Plugin telegram instalado
  let tgFound = false;
  try {
    const cacheRoot = join(cfg, "plugins", "cache");
    for (const marketplace of readdirSync(cacheRoot)) {
      const p = join(cacheRoot, marketplace, "telegram");
      if (existsSync(p)) {
        tgFound = true;
        break;
      }
    }
  } catch {
    /* cache pode não existir ainda */
  }
  if (!tgFound) {
    // fallback: pergunta ao próprio claude
    try {
      const out = (await $`claude plugin list`.nothrow().quiet()).text();
      tgFound = /telegram/i.test(out);
    } catch {
      /* segue como não encontrado */
    }
  }
  if (tgFound) ok("plugin telegram@claude-plugins-official instalado");
  else
    bad(
      "plugin telegram NÃO instalado",
      "dentro do Claude Code rode: /plugin install telegram@claude-plugins-official  e depois /reload-plugins",
    );

  // 5. Internet até o Telegram
  try {
    const res = await fetch("https://api.telegram.org", { signal: AbortSignal.timeout(6000) });
    if (res.status > 0) ok("internet OK (api.telegram.org alcançável)");
  } catch {
    bad("não alcancei api.telegram.org", "confira a internet/firewall/VPN — o bot precisa falar com o Telegram");
  }

  console.log(`\n=== resumo: ${fails === 0 ? "TUDO VERDE ✅ — pode instalar o agente" : `${fails} pendência(s) ❌ — resolva antes de seguir`} ===`);
  process.exit(fails);
}

main();
