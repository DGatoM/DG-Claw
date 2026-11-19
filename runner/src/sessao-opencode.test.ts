import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { abrirServidorDeHooks, esperarAte, lerLinhasJson, lerTexto, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-opencode");
const { Sessao } = await import("./sessao.js");

const CHAVE_OR = "sk-or-v1-" + "5a6b7c8d9e0f".repeat(5);
fs.writeFileSync(path.join(amb.raiz, "cofre.env"), `OPENROUTER_API_KEY='${CHAVE_OR}'\n`);
process.env.DGCLAW_COFRE_ARQUIVO = path.join(amb.raiz, "cofre.env");
process.env.OPENROUTER_API_KEY = CHAVE_OR;
process.env.DGCLAW_OPENROUTER_CACHE = path.join(amb.raiz, "openrouter-models.json");

let n = 0;
const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

async function novoCard(escolha: Record<string, string>, config: Record<string, unknown> = {}) {
  n += 1;
  const id = `oc-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const cwd = path.join(amb.raiz, `casa-${n}`);
  fs.mkdirSync(cwd, { recursive: true });
  const cfg = { name: id, initialPrompt: "", provider: "opencode-cli", permissionMode: "auto", ...config, cwd };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
    papel: "paralela",
    escolhaDescrita: escolha as never,
  } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  return { s, hooks, id, pasta };
}

const entradas = () => lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "opencode" && l.modo === "interativo");

test("OpenCode: o card sobe com -m openrouter/<modelo>, a chave só no ambiente, e o plugin leva o turno a idle", async () => {
  const { s, hooks } = await novoCard({ provider: "opencode", auth: "api", model: "z-ai/glm-5.3-prime" });
  assert.equal(await s.subir("nova"), "nova");
  await esperarAte(() => entradas().length > 0, 6_000, "o OpenCode falso abrir");
  const e = entradas().at(-1)!;
  assert.deepEqual(e.argv, ["-m", "openrouter/z-ai/glm-5.3-prime"]);
  assert.ok(e.env.includes("OPENROUTER_API_KEY"));
  assert.ok(e.valores.OPENCODE_CONFIG_DIR.includes("opencode-"));
  assert.equal(e.valores.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.ok(e.env.includes("DGCLAW_HOOK_NONCE"), "o runner entrega o nonce ao spawn; o plugin o apaga do ambiente depois de ler");

  await esperarAte(() => hooks.recebidos.some((h) => h.event === "SessionStart"), 6_000, "o plugin avisar a partida");
  await esperarAte(() => s.estado.status === "idle", 8_000, "o card ficar ocioso");

  await s.digitarEEnviar("primeira tarefa");
  await esperarAte(() => s.estado.status === "working", 6_000, "o turno virar working");
  await esperarAte(() => s.estado.sessionId !== null, 6_000, "o id da sessão ser descoberto pelo plugin");
  assert.match(s.estado.sessionId!, /^ses_/);
  await esperarAte(() => hooks.recebidos.some((h) => h.event === "Stop"), 8_000, "o Stop chegar");
  await esperarAte(() => s.estado.status === "idle", 8_000, "o Stop virar idle");
  assert.equal(lerTexto(amb.logDoRunner).includes(CHAVE_OR), false, "a chave não aparece no log do runner");
});

test("OpenCode: a pasta de configuração do spawn é apagada quando a sessão para", async () => {
  const { s, hooks } = await novoCard({ provider: "opencode", auth: "api" });
  await s.subir("nova");
  const deste = () => entradas().find((l) => l.valores.DGCLAW_HOOK_PORT === String(hooks.porta));
  await esperarAte(() => deste() !== undefined, 6_000, "o OpenCode deste card abrir");
  const pasta = deste()!.valores.OPENCODE_CONFIG_DIR as string;
  assert.ok(fs.existsSync(pasta));
  s.parar("fim do teste");
  await esperarAte(() => !fs.existsSync(pasta), 6_000, "a pasta de config do spawn sumir");
});

test("OpenCode: sem a chave no Cofre o card não sobe e a recusa diz como resolver", async () => {
  const antes = fs.readFileSync(path.join(amb.raiz, "cofre.env"), "utf8");
  fs.writeFileSync(path.join(amb.raiz, "cofre.env"), "");
  delete process.env.OPENROUTER_API_KEY;
  try {
    const { s } = await novoCard({ provider: "opencode", auth: "api" });
    const antesDeEntradas = entradas().length;
    await s.subir("nova");
    assert.equal(s.estado.status, "errored");
    assert.equal(s.estado.statusReason, "runner:sem-chave");
    assert.match(s.estado.error ?? "", /OPENROUTER_API_KEY/);
    assert.equal(entradas().length, antesDeEntradas, "nenhum OpenCode foi aberto");
  } finally {
    fs.writeFileSync(path.join(amb.raiz, "cofre.env"), antes);
    process.env.OPENROUTER_API_KEY = CHAVE_OR;
  }
});
