#!/usr/bin/env bun
// scaffold.ts — materializa a pasta do agente DG Claw modo local (cross-platform).
//
// O wizard /dgclaw:setup chama isto UMA vez depois de coletar nome/dono/
// personalidade. Cria a pasta inteira: CLAUDE.md, working-memory,
// TROUBLESHOOTING, .claude/settings.json (hooks project-scoped + permissões),
// .dgclaw/ (hooks/scripts/painel copiados do plugin + config.json + state dir
// do telegram com access.json já com pairing e 👀) e o launcher do SO.
//
// Uso:
//   bun local/scripts/scaffold.ts --dir <pasta> --name <Nome> --owner <Dono> \
//       [--personality-file <arquivo.txt>] [--port 8200]
//
// (personalidade em arquivo porque texto livre multi-linha não passa bem por
//  argumento no Windows)

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("dir");
const name = arg("name");
const owner = arg("owner");
const port = arg("port") ?? "8200";
const persFile = arg("personality-file");

if (!dir || !name || !owner) {
  console.error("uso: bun scaffold.ts --dir <pasta> --name <Nome> --owner <Dono> [--personality-file f] [--port 8200]");
  process.exit(2);
}

const WS = resolve(dir);
const PLUGIN_LOCAL = resolve(import.meta.dir, ".."); // .../local
const TPL = join(PLUGIN_LOCAL, "templates");
const personality = persFile ? readFileSync(persFile, "utf8").trim() : "Prestativo, leal e bem-humorado.";
const slug = name
  .toLowerCase()
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");
const today = new Date().toISOString().slice(0, 10);

function render(tmpl: string): string {
  return tmpl
    .replaceAll("{{NOME}}", name!)
    .replaceAll("{{DONO}}", owner!)
    .replaceAll("{{PERSONALIDADE}}", personality)
    .replaceAll("{{SLUG}}", slug)
    .replaceAll("{{PORTA}}", port)
    .replaceAll("{{DATA}}", today);
}

function materialize(tmplName: string, outPath: string): void {
  const out = render(readFileSync(join(TPL, tmplName), "utf8"));
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, out, "utf8");
  console.log(`  ✓ ${outPath}`);
}

// pastas
for (const d of [WS, join(WS, ".claude"), join(WS, ".dgclaw", "telegram", "inbox")]) {
  mkdirSync(d, { recursive: true });
}

// órgãos internos: cópia estável de hooks/scripts/painel pro .dgclaw
for (const [src, dst] of [
  ["hooks", "hooks"],
  ["scripts", "scripts"],
  ["panel", "panel"],
] as const) {
  cpSync(join(PLUGIN_LOCAL, src), join(WS, ".dgclaw", dst), {
    recursive: true,
    filter: (s) => !s.endsWith("scaffold.ts"), // só faz sentido dentro do plugin
  });
}
console.log(`  ✓ ${join(WS, ".dgclaw")} (hooks + scripts + painel)`);

// arquivos do agente
materialize("CLAUDE.md.tmpl", join(WS, "CLAUDE.md"));
materialize("working-memory.md.tmpl", join(WS, "working-memory.md"));
materialize("TROUBLESHOOTING.md.tmpl", join(WS, "TROUBLESHOOTING.md"));
materialize("settings.json.tmpl", join(WS, ".claude", "settings.json"));
materialize("config.json.tmpl", join(WS, ".dgclaw", "config.json"));

// access.json (pairing + 👀) — só se ainda não existe (não sobrescreve pareamento)
const accessPath = join(WS, ".dgclaw", "telegram", "access.json");
if (!existsSync(accessPath)) materialize("access.json.tmpl", accessPath);

// launcher do SO
if (platform() === "win32") {
  materialize("launcher-win.bat.tmpl", join(WS, `Iniciar ${name}.bat`));
} else {
  const launcher = join(WS, `Iniciar ${name}.command`);
  materialize("launcher-mac.command.tmpl", launcher);
  chmodSync(launcher, 0o755);
}

console.log(`\n🐾 Pasta do agente ${name} pronta em: ${WS}`);
console.log(`   Falta: token do BotFather em ${join(WS, ".dgclaw", "telegram", ".env")} (o wizard cuida disso).`);
