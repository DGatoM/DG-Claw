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
// A pasta de dependências da imagem, em miniatura: o runner a liga (package.json, trava e node_modules) em cada card.
const DEPS = path.join(amb.raiz, "opencode-deps");
fs.mkdirSync(path.join(DEPS, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
fs.writeFileSync(path.join(DEPS, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.19.6"}}\n');
fs.writeFileSync(path.join(DEPS, "package-lock.json"), '{"lockfileVersion":3}\n');
process.env.DGCLAW_OPENCODE_DEPS = DEPS;
// Uma pasta de config "do usuário" com um plugin plantado e um vizinho (gh): só o vizinho pode aparecer no card.
const CONFIG_REAL = path.join(amb.raiz, "config-real");
fs.mkdirSync(path.join(CONFIG_REAL, "opencode", "plugins"), { recursive: true });
fs.writeFileSync(path.join(CONFIG_REAL, "opencode", "plugins", "plantado.js"), "export const X = async () => ({});\n");
fs.mkdirSync(path.join(CONFIG_REAL, "gh"), { recursive: true });
process.env.XDG_CONFIG_HOME = CONFIG_REAL;

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

test("OpenCode: o card só enxerga a configuração do spawn (XDG isolado, sem plugin do usuário, sem config do projeto) e as dependências vêm ligadas", async () => {
  const { s, hooks } = await novoCard({ provider: "opencode", auth: "api" });
  await s.subir("nova");
  const deste = () => entradas().find((l) => l.valores.DGCLAW_HOOK_PORT === String(hooks.porta));
  await esperarAte(() => deste() !== undefined, 6_000, "o OpenCode deste card abrir");
  const e = deste()!;
  const pasta = e.valores.OPENCODE_CONFIG_DIR as string;
  assert.equal(e.valores.XDG_CONFIG_HOME, path.join(pasta, "xdg"));
  assert.ok(String(e.valores.OPENCODE_TEST_HOME).startsWith(pasta));
  assert.equal(e.valores.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(e.valores.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
  const xdg = path.join(pasta, "xdg");
  assert.equal(fs.existsSync(path.join(xdg, "opencode", "plugins")), false, "o plugin plantado em ~/.config/opencode não chega ao card");
  assert.ok(fs.existsSync(path.join(xdg, "gh")), "o que não é do OpenCode segue visível (link)");
  assert.equal(e.depsLigadas, true, "o node_modules da imagem está ligado: o OpenCode não precisa instalar nada");
  assert.ok(fs.existsSync(path.join(pasta, "package-lock.json")));
  assert.ok(fs.existsSync(path.join(xdg, "opencode", "package-lock.json")));
  s.parar("fim do teste");
});

test("OpenCode: variáveis OPENCODE_* e OPENROUTER_* (menos a chave) saem do ambiente, mesmo as vindas do Cofre", async () => {
  process.env.OPENCODE_MODELS_URL = "http://servidor-de-fora.invalid/modelos";
  process.env.OPENROUTER_BASE_URL = "http://servidor-de-fora.invalid/v1";
  process.env.OPENCODE_CONFIG_CONTENT = "{}";
  try {
    const { s, hooks } = await novoCard({ provider: "opencode", auth: "api" });
    await s.subir("nova");
    const deste = () => entradas().find((l) => l.valores.DGCLAW_HOOK_PORT === String(hooks.porta));
    await esperarAte(() => deste() !== undefined, 6_000, "o OpenCode deste card abrir");
    const env: string[] = deste()!.env;
    for (const nome of ["OPENCODE_MODELS_URL", "OPENROUTER_BASE_URL", "OPENCODE_CONFIG_CONTENT"]) {
      assert.equal(env.includes(nome), false, `${nome} não pode chegar ao OpenCode`);
    }
    assert.ok(env.includes("OPENROUTER_API_KEY"));
    s.parar("fim do teste");
  } finally {
    delete process.env.OPENCODE_MODELS_URL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENCODE_CONFIG_CONTENT;
  }
});

test("OpenCode: chave só no ambiente do serviço, com o Cofre vazio, NÃO libera o card", async () => {
  const antes = fs.readFileSync(path.join(amb.raiz, "cofre.env"), "utf8");
  fs.writeFileSync(path.join(amb.raiz, "cofre.env"), "OUTRA_CHAVE_API_KEY='valor-qualquer-123'\n");
  try {
    const { s } = await novoCard({ provider: "opencode", auth: "api" });
    const antesDeEntradas = entradas().length;
    await s.subir("nova");
    assert.equal(process.env.OPENROUTER_API_KEY, CHAVE_OR, "a chave fictícia segue no ambiente do processo");
    assert.equal(s.estado.status, "errored");
    assert.equal(s.estado.statusReason, "runner:sem-chave");
    assert.equal(entradas().length, antesDeEntradas, "nenhum OpenCode foi aberto");
  } finally {
    fs.writeFileSync(path.join(amb.raiz, "cofre.env"), antes);
  }
});

test("OpenCode: askTools/denyTools do dono impedem o card, com o que fazer", async () => {
  for (const config of [{ denyTools: ["Bash(rm:*)"] }, { askTools: ["Bash"] }]) {
    const { s } = await novoCard({ provider: "opencode", auth: "api" }, config);
    const antesDeEntradas = entradas().length;
    await s.subir("nova");
    assert.equal(s.estado.status, "errored");
    assert.equal(s.estado.statusReason, "runner:restricao-motor");
    assert.match(s.estado.error ?? "", /não aplica essas regras/);
    assert.match(s.estado.error ?? "", /O que fazer/);
    assert.equal(entradas().length, antesDeEntradas, "nenhum OpenCode foi aberto");
    assert.equal(s.recusaDeEntrada()?.tipo, "restricao", "o POST /input também é recusado");
  }
});

test("OpenCode: restricoes.json do dono (sem_bash) impede o card; sem o arquivo ele abre", async () => {
  const arq = path.join(amb.raiz, "restricoes.json");
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, sem_bash: true }));
  process.env.RUNNER_RESTRICOES_FILE = arq;
  try {
    const { s } = await novoCard({ provider: "opencode", auth: "api" });
    const antesDeEntradas = entradas().length;
    await s.subir("nova");
    assert.equal(s.estado.statusReason, "runner:restricao-motor");
    assert.equal(entradas().length, antesDeEntradas);
  } finally {
    delete process.env.RUNNER_RESTRICOES_FILE;
  }
});

test("OpenCode: modelo retirado do catálogo mantém o provedor e para pedindo outro modelo (não cai no Claude)", async () => {
  const { s } = await novoCard({ provider: "opencode", auth: "api", model: "laboratorio-que-saiu/modelo-velho" });
  const antesDeEntradas = entradas().length;
  const antesClaude = lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude").length;
  await s.subir("nova");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:modelo-indisponivel");
  assert.match(s.estado.error ?? "", /outro modelo/);
  assert.equal(entradas().length, antesDeEntradas);
  assert.equal(lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude").length, antesClaude, "o Claude não foi aberto no lugar");
  assert.equal(s.recusaDeEntrada()?.tipo, "modelo");
});

test("OpenCode: o fim de uma subtarefa (sessão filha) não troca a sessão do card nem anuncia o fim do turno", async () => {
  process.env.FAKE_OPENCODE_SUBTAREFA = "1";
  process.env.FAKE_OPENCODE_TURNO_MS = "1500";
  try {
    const { s, hooks } = await novoCard({ provider: "opencode", auth: "api" });
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o card ficar ocioso");
    await s.digitarEEnviar("tarefa com subtarefa");
    await esperarAte(() => s.estado.sessionId !== null, 6_000, "o id da sessão ser descoberto");
    const principal = s.estado.sessionId!;
    assert.doesNotMatch(principal, /Filha/);
    // Enquanto a principal ainda trabalha (o falso espera 1,5 s), a filha já terminou e falhou.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(s.estado.sessionId, principal, "a sessão do card continua a principal");
    assert.equal(s.estado.status, "working", "o idle da filha não encerrou o turno");
    await esperarAte(() => hooks.recebidos.some((h) => h.event === "Stop"), 8_000, "o Stop da principal chegar");
    assert.equal(s.estado.sessionId, principal);
    assert.equal(hooks.recebidos.some((h) => h.event === "StopFailure"), false, "o erro da filha não vira falha do card");
    assert.equal(hooks.recebidos.filter((h) => h.event === "Stop").length, 1);
    s.parar("fim do teste");
  } finally {
    delete process.env.FAKE_OPENCODE_SUBTAREFA;
    delete process.env.FAKE_OPENCODE_TURNO_MS;
  }
});

test("OpenCode: partida lenta (tela muda por vários segundos) não solta o pedido antes do aviso de tela pronta", async () => {
  process.env.FAKE_OPENCODE_PARTIDA_MS = "4000";
  try {
    const { s, hooks } = await novoCard({ provider: "opencode", auth: "api" });
    await s.subir("nova");
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(s.estado.status, "spawning", "silêncio da tela não vale como pronto");
    assert.equal(hooks.recebidos.some((h) => h.event === "SessionStart"), false);
    await esperarAte(() => hooks.recebidos.some((h) => h.event === "SessionStart"), 10_000, "o plugin avisar a tela pronta");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o card ficar ocioso depois do aviso");
    await s.digitarEEnviar("pedido depois do aviso");
    await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.bin === "opencode" && l.modo === "prompt" && l.texto === "pedido depois do aviso"), 8_000, "o pedido ser digitado");
    s.parar("fim do teste");
  } finally {
    delete process.env.FAKE_OPENCODE_PARTIDA_MS;
  }
});

test("OpenCode: depois que a prontidão expira nenhum envio é aceito até uma nova partida (nada é digitado na tela errada)", async () => {
  const { s } = await novoCard({ provider: "opencode", auth: "api" });
  s.mudar({ status: "errored", error: "o opencode não avisou que a tela estava pronta", statusReason: "runner:prontidao-expirou" });
  const r = s.recusaDeEntrada();
  assert.equal(r?.tipo, "prontidao");
  assert.match(r?.comoResolver ?? "", /abrir outro/);
});
