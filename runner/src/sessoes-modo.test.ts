// O modo de permissão das sessões paralelas (decisão do Danilo, 21/10/2026): a principal roda
// em bypassPermissions (obrigatório) e toda paralela sobe em "auto", sem herdar da principal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { abrirServidorDeHooks, esperarAte, lerLinhasJson, logarClaude, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("sessoes-modo");
const { Sessao } = await import("./sessao.js");
const { configDaSessao } = await import("./sessoes.js");

const descritor = {
  id: "agente-teste",
  slug: "agente-teste",
  config: { name: "agente-teste", cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions", envExtra: { DGCHAT_OUTBOUND: "/tmp/saida.jsonl" } },
} as never;

const paralela = (tipo: string) =>
  ({ id: `p-${tipo}`, slug: `agente-teste-${tipo}`, tipo, chat: `c_${tipo}`, ociosoMinutos: 20 }) as never;

const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

test("paralela sai em auto mesmo com a principal em bypassPermissions (qualquer tipo)", () => {
  for (const tipo of ["bastidores", "conversa"]) {
    const cfg = configDaSessao(descritor, paralela(tipo), "/tmp/estado.json");
    assert.ok(cfg, `a sessão ${tipo} devia existir`);
    assert.equal(cfg.permissionMode, "auto", `tipo ${tipo}`);
  }
  assert.equal((descritor as { config: { permissionMode: string } }).config.permissionMode, "bypassPermissions", "a principal não é alterada");
});

async function subir(config: Record<string, unknown>, id: string) {
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const s = new Sessao({ id, slug: id, config: config as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
  } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
  const settings = JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${id}.settings.json`), "utf8"));
  const entrada = lerLinhasJson(amb.logDosClis).find((l) => l.bin === "claude" && l.argv.some((a: string) => a.endsWith(`/${id}.settings.json`))) as { argv: string[]; valores: Record<string, string> } | undefined;
  assert.ok(entrada, "o CLI falso devia ter registrado a subida");
  return { settings, entrada };
}

test("spawn: a paralela sobe com --permission-mode auto, sem IS_SANDBOX e sem skipDangerousModePermissionPrompt; a principal continua em bypass", async () => {
  logarClaude(amb);
  const principal = await subir((descritor as { config: Record<string, unknown> }).config, "principal-1");
  assert.equal(principal.settings.skipDangerousModePermissionPrompt, true);
  assert.equal(principal.entrada.argv[principal.entrada.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(principal.entrada.valores.IS_SANDBOX, "1");

  const cfg = configDaSessao(descritor, paralela("conversa"), "/tmp/estado.json");
  assert.ok(cfg);
  const filha = await subir(cfg as never, "paralela-1");
  assert.equal("skipDangerousModePermissionPrompt" in filha.settings, false);
  assert.equal(filha.entrada.argv[filha.entrada.argv.indexOf("--permission-mode") + 1], "auto");
  assert.notEqual(filha.entrada.valores.IS_SANDBOX, "1");
});
