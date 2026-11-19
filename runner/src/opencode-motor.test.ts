import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { ctxDeTeste, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

prepararAmbiente("opencode-motor");

const { motorOpenCode, configDoSpawn, modeloDoOpenCode } = await import("./provedores/opencode.js");
const { OPENCODE_PLUGIN_SOURCE, OPENCODE_PLUGIN_NOME } = await import("./provedores/opencode-plugin-source.js");
const { mensagensDoExport, lerConversaDoOpenCode, zerarConversaDoOpenCode, ErroDeConversa } = await import("./provedores/opencode-conversa.js");
const { filtrarModelosOpenRouter, lerCacheOpenRouter, cacheOpenRouterVelho, atualizarCacheOpenRouter, garantirCacheOpenRouter, zerarFalhasDoOpenRouter, VALIDADE_CACHE_OPENROUTER_MS } =
  await import("./provedores/openrouter-modelos.js");

const CHAVE_FALSA = "sk-or-v1-" + "a1b2c3d4e5f6".repeat(5);

function ctxOpenCode(sobre: Record<string, unknown> = {}) {
  const hooks = pastaTemporaria("oc-hooks");
  return ctxDeTeste({
    escolha: { provedor: "opencode", auth: "api", modelo: "z-ai/glm-5.3-prime", paraCard: true },
    pastaDeHooks: hooks,
    env: { PATH: process.env.PATH ?? "", OPENROUTER_API_KEY: CHAVE_FALSA },
    config: { name: "x", cwd: "/tmp", initialPrompt: "", provider: "opencode-cli", permissionMode: "auto" },
    ...sobre,
  } as never);
}

// ─── motor ───────────────────────────────────────────────────────

test("opencode: sessão nova passa só o modelo do OpenRouter, sem --auto", () => {
  const ctx = ctxOpenCode();
  assert.deepEqual(motorOpenCode.argsNova(ctx), ["-m", "openrouter/z-ai/glm-5.3-prime"]);
});

test("opencode: modelo vazio usa o padrão do catálogo", () => {
  const ctx = ctxOpenCode({ escolha: { provedor: "opencode", auth: "api", modelo: "", paraCard: true } });
  assert.equal(modeloDoOpenCode(ctx), "openrouter/" + ctx.catalogo.provedores.opencode!.modeloPadrao);
  assert.match(modeloDoOpenCode(ctx), /^openrouter\/.+\/.+/);
});

test("opencode: retomar usa -s com o id da sessão e o mesmo modelo", () => {
  const ctx = ctxOpenCode();
  assert.deepEqual(motorOpenCode.argsRetomar(ctx, "ses_abc123XYZ"), ["-s", "ses_abc123XYZ", "-m", "openrouter/z-ai/glm-5.3-prime"]);
  assert.equal(motorOpenCode.argsNova(ctx).includes("--auto"), false);
});

test("opencode: o motor não usa hooks do Claude e digita com pausa de 500 ms", () => {
  assert.equal(motorOpenCode.usaHooks, false);
  assert.equal(motorOpenCode.pausaAntesDoEnterMs, 500);
  assert.equal(motorOpenCode.reciboPorRollout, false);
});

test("opencode: preparar grava plugin e config com modo 600, define o ambiente e a limpeza apaga tudo", async () => {
  const ctx = ctxOpenCode({ identidade: { arquivo: "/tmp/identidade.md", texto: "x" } });
  await motorOpenCode.preparar(ctx);
  const pasta = ctx.env.OPENCODE_CONFIG_DIR!;
  assert.ok(pasta.startsWith(ctx.pastaDeHooks), "a pasta fica na pasta de hooks do spawn");
  assert.equal(fs.statSync(pasta).mode & 0o777, 0o700);
  const plugin = path.join(pasta, "plugins", `${OPENCODE_PLUGIN_NOME}.js`);
  assert.equal(fs.readFileSync(plugin, "utf8"), OPENCODE_PLUGIN_SOURCE);
  assert.equal(fs.statSync(plugin).mode & 0o777, 0o600);
  const arquivoCfg = path.join(pasta, "opencode.json");
  assert.equal(fs.statSync(arquivoCfg).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(arquivoCfg, "utf8"));
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.autoupdate, false);
  assert.deepEqual(cfg.instructions, ["/tmp/identidade.md"]);
  assert.equal(ctx.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(ctx.env.DGCLAW_HOOK_AGENT, ctx.id);
  assert.equal(ctx.env.DGCLAW_HOOK_PORT, String(ctx.porta));
  assert.equal(ctx.env.DGCLAW_HOOK_NONCE, ctx.nonce);
  assert.equal(JSON.stringify(cfg).includes(CHAVE_FALSA), false, "a chave nunca vai para o arquivo de config");
  for (const limpar of ctx.limpezas) limpar();
  assert.equal(fs.existsSync(pasta), false);
});

test("opencode: permissão por confirmação só no modo default", () => {
  const auto = configDoSpawn(ctxOpenCode());
  assert.equal("permission" in auto, false);
  const padrao = configDoSpawn(
    ctxOpenCode({ config: { name: "x", cwd: "/tmp", initialPrompt: "", provider: "opencode-cli", permissionMode: "default" } }),
  );
  assert.deepEqual(padrao.permission, { edit: "ask", bash: "ask" });
  assert.equal("instructions" in auto, false, "sem identidade não há instructions");
});

test("opencode: sem a chave no ambiente o motor recusa com a causa e o que fazer", () => {
  const sem = ctxOpenCode({ chaveDoModoPresente: false, variavelDoModo: "OPENROUTER_API_KEY" });
  const r = motorOpenCode.motivoSemLogin!(sem)!;
  assert.equal(r.tipo, "chave");
  assert.match(r.mensagem, /OPENROUTER_API_KEY/);
  assert.match(r.comoResolver, /Cofre/);
  assert.equal(motorOpenCode.motivoSemLogin!(ctxOpenCode()), null);
});

// ─── plugin de status ────────────────────────────────────────────

interface Recebido {
  corpo: Record<string, any>;
}

async function servidorMudoOuNormal(mudo: boolean) {
  const recebidos: Recebido[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        recebidos.push({ corpo: JSON.parse(b) });
      } catch {
        recebidos.push({ corpo: { invalido: b } });
      }
      if (!mudo) res.end("{}");
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { porta: (srv.address() as AddressInfo).port, recebidos, fechar: () => { srv.closeAllConnections?.(); srv.close(); } };
}

let contadorDePlugin = 0;
async function carregarPlugin(porta: number) {
  const pasta = pastaTemporaria("oc-plugin");
  const arquivo = path.join(pasta, `plugin-${++contadorDePlugin}.mjs`);
  fs.writeFileSync(arquivo, OPENCODE_PLUGIN_SOURCE);
  process.env.DGCLAW_HOOK_AGENT = "agente-x";
  process.env.DGCLAW_HOOK_PORT = String(porta);
  process.env.DGCLAW_HOOK_NONCE = "nonce-secreto-123";
  const mod = await import(arquivo);
  const ganchos = await mod.DgclawStatus({});
  return ganchos as Record<string, (arg: unknown) => Promise<void>>;
}

async function esperar(cond: () => boolean, ms = 4000) {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error("tempo esgotado esperando o evento do plugin");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("plugin: traduz cada evento do OpenCode para o hook do runner, em ordem, e o nonce some do ambiente", async () => {
  const srv = await servidorMudoOuNormal(false);
  try {
    const g = await carregarPlugin(srv.porta);
    assert.equal(process.env.DGCLAW_HOOK_NONCE, undefined, "o nonce sai do process.env depois de lido");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(srv.recebidos.length, 0, "carregar o plugin não avisa a partida: a tela ainda não aceita texto");
    await g.event({ event: { type: "catalog.updated", properties: {} } });
    await esperar(() => srv.recebidos.length >= 1);
    await g["chat.message"]({ sessionID: "ses_Aa1Bb2Cc3" });
    await g["tool.execute.before"]({ sessionID: "ses_Aa1Bb2Cc3", tool: "bash", callID: "call_1" });
    await g.event({ event: { type: "permission.asked", properties: { sessionID: "ses_Aa1Bb2Cc3" } } });
    await g.event({ event: { type: "permission.replied", properties: { sessionID: "ses_Aa1Bb2Cc3" } } });
    await g.event({ event: { type: "session.idle", properties: { sessionID: "ses_Aa1Bb2Cc3" } } });
    await g.event({ event: { type: "session.error", properties: { sessionID: "ses_Aa1Bb2Cc3", error: { name: "ProviderAuthError", data: { message: "segredo" } } } } });
    await esperar(() => srv.recebidos.length >= 7);
    const eventos = srv.recebidos.map((r) => r.corpo.event);
    assert.deepEqual(eventos, ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "PreToolUse", "Stop", "StopFailure"]);
    for (const r of srv.recebidos) {
      assert.equal(r.corpo.agentId, "agente-x");
      assert.equal(r.corpo.nonce, "nonce-secreto-123");
    }
    const ferramenta = srv.recebidos[2]!.corpo;
    assert.equal(ferramenta.toolName, "bash");
    assert.equal(ferramenta.toolUseId, "call_1");
    assert.equal(ferramenta.sessionId, "ses_Aa1Bb2Cc3");
    const falha = srv.recebidos[6]!.corpo;
    assert.equal(falha.error, "ProviderAuthError");
    assert.equal(JSON.stringify(falha).includes("segredo"), false, "só o nome do erro viaja, nunca a mensagem");
  } finally {
    srv.fechar();
  }
});

test("plugin: session.status busy vira batimento no máximo a cada 5 s e não repete com permissão pendente", async () => {
  const srv = await servidorMudoOuNormal(false);
  try {
    const g = await carregarPlugin(srv.porta);
    const busy = { event: { type: "session.status", properties: { sessionID: "ses_Zz9", status: { type: "busy" } } } };
    await g.event({ event: { type: "catalog.updated", properties: {} } });
    await esperar(() => srv.recebidos.length >= 1);
    await g.event(busy);
    await g.event(busy);
    await g.event({ event: { type: "permission.asked", properties: { sessionID: "ses_Zz9" } } });
    await g.event(busy);
    await esperar(() => srv.recebidos.length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      srv.recebidos.map((r) => r.corpo.event),
      ["SessionStart", "PreToolUse", "Notification"],
    );
  } finally {
    srv.fechar();
  }
});

test("plugin: nunca lança com evento torto, id malformado ou ctx vazio", async () => {
  const srv = await servidorMudoOuNormal(false);
  try {
    const g = await carregarPlugin(srv.porta);
    await g.event({ event: null });
    await g.event(undefined);
    await g.event({ event: { type: "session.idle", properties: { sessionID: "../../etc/passwd" } } });
    await g["chat.message"](undefined);
    await g["tool.execute.before"](null);
    await esperar(() => srv.recebidos.length >= 4);
    const idle = srv.recebidos.find((r) => r.corpo.event === "Stop")!;
    assert.equal(idle.corpo.sessionId, null, "id fora do formato nunca é repassado");
  } finally {
    srv.fechar();
  }
});

test("plugin: com o runner mudo o gancho volta na hora e cada POST respeita o prazo de 1 s", async () => {
  const srv = await servidorMudoOuNormal(true);
  try {
    const t0 = Date.now();
    const g = await carregarPlugin(srv.porta);
    await g["chat.message"]({ sessionID: "ses_Mudo1" });
    await g.event({ event: { type: "session.idle", properties: { sessionID: "ses_Mudo1" } } });
    assert.ok(Date.now() - t0 < 500, "o OpenCode não espera pelo runner");
    await esperar(() => srv.recebidos.length >= 1);
  } finally {
    srv.fechar();
  }
});

// ─── conversa (opencode export) ─────────────────────────────────

const EXPORT = JSON.stringify({
  info: { id: "ses_Exp1" },
  messages: [
    { info: { role: "user" }, parts: [{ type: "text", text: "diga PONG" }] },
    {
      info: { role: "assistant" },
      parts: [
        { type: "step-start" },
        { type: "text", text: `PONG, chave ${CHAVE_FALSA}` },
        { type: "step-finish", reason: "stop" },
      ],
    },
    { info: { role: "user" }, parts: [{ type: "text", text: "synthetic", synthetic: true }] },
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: "x" } }],
    },
  ],
});

test("conversa: só o texto entra, ferramenta e passos ficam de fora e o segredo é mascarado", () => {
  const msgs = mensagensDoExport(EXPORT, 6, [CHAVE_FALSA])!;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0]!.text, "diga PONG");
  assert.equal(msgs[1]!.text.includes(CHAVE_FALSA), false);
  assert.match(msgs[1]!.text, /^PONG/);
});

test("conversa: respeita o limite de mensagens e devolve null para JSON quebrado ou sem messages", () => {
  assert.equal(mensagensDoExport(EXPORT, 1)!.length, 1);
  assert.equal(mensagensDoExport("{nao json")!, null);
  assert.equal(mensagensDoExport(JSON.stringify({ info: {} })), null);
});

test("conversa: id de sessão fora da forma ses_ não executa nada", async () => {
  await assert.rejects(
    lerConversaDoOpenCode({ sessionId: "$(touch /tmp/x)", env: {}, cwd: "/tmp", quantas: 3, binario: "/bin/false" }),
    /não tem a forma de um id do OpenCode/,
  );
});

test("conversa: binário falso que imprime o export devolve as mensagens", async () => {
  const pasta = pastaTemporaria("oc-bin");
  const bin = path.join(pasta, "opencode-falso");
  fs.writeFileSync(bin, `#!/bin/sh\necho "Exporting session: $2" >&2\ncat <<'FIM'\n${EXPORT}\nFIM\n`, { mode: 0o755 });
  const r = await lerConversaDoOpenCode({ sessionId: "ses_Exp1abc", env: { PATH: process.env.PATH ?? "" }, cwd: pasta, quantas: 5, binario: bin });
  assert.equal(r?.length, 2);
});

// ─── lista de modelos do OpenRouter ──────────────────────────────

test("openrouter: filtra por texto e ferramentas, tira :batch e converte o preço para milhão de tokens", () => {
  const lista = filtrarModelosOpenRouter({
    data: [
      { id: "z-ai/glm-5.3-prime", name: "GLM 5.3 Prime", architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], pricing: { prompt: "0.0000006", completion: "0.0000022" } },
      { id: "x/sem-ferramenta", supported_parameters: ["temperature"] },
      { id: "x/imagem", architecture: { output_modalities: ["image"] } },
      { id: "x/modelo:batch" },
      { id: "id invalido com espaço" },
      null,
    ],
  });
  assert.deepEqual(lista.map((m) => m.id), ["z-ai/glm-5.3-prime"]);
  assert.equal(lista[0]!.entradaPorMilhao, 0.6);
  assert.equal(lista[0]!.saidaPorMilhao, 2.2);
});

test("openrouter: atualizar grava o cache, e falha mantém o cache anterior", async () => {
  const arquivo = path.join(pastaTemporaria("oc-cache"), "modelos.json");
  assert.equal(lerCacheOpenRouter(arquivo), null);
  assert.equal(cacheOpenRouterVelho(arquivo), true, "sem cache conta como velho");
  const bom = (async () => new Response(JSON.stringify({ data: [{ id: "a/b", name: "AB", supported_parameters: ["tools"] }] }), { status: 200 })) as typeof fetch;
  const r1 = await atualizarCacheOpenRouter({ arquivo, buscar: bom });
  assert.deepEqual(r1, { ok: true, quantos: 1 });
  assert.equal(cacheOpenRouterVelho(arquivo), false);
  assert.equal(cacheOpenRouterVelho(arquivo, Date.now() + VALIDADE_CACHE_OPENROUTER_MS + 60_000), true);

  const ruim = (async () => new Response("erro", { status: 503 })) as typeof fetch;
  const r2 = await atualizarCacheOpenRouter({ arquivo, buscar: ruim });
  assert.equal(r2.ok, false);
  assert.match((r2 as { erro: string }).erro, /503/);
  const vazio = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  assert.equal((await atualizarCacheOpenRouter({ arquivo, buscar: vazio })).ok, false);
  const rede = (async () => { throw new Error("sem rede"); }) as typeof fetch;
  assert.equal((await atualizarCacheOpenRouter({ arquivo, buscar: rede })).ok, false);
  assert.equal(lerCacheOpenRouter(arquivo)?.modelos[0]?.id, "a/b", "o cache bom sobrevive às falhas");
});

test("openrouter: corpo grande demais é cortado durante a leitura, sem puxar tudo para a memória", async () => {
  const arquivo = path.join(pastaTemporaria("oc-grande"), "modelos.json");
  let enviados = 0;
  let cancelado = false;
  const corpo = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      enviados += 1;
      ctrl.enqueue(new Uint8Array(1024 * 1024)); // 1 MiB por pedaço, para sempre
    },
    cancel() {
      cancelado = true;
    },
  });
  const buscar = (async () => new Response(corpo, { status: 200 })) as typeof fetch;
  const r = await atualizarCacheOpenRouter({ arquivo, buscar });
  assert.equal(r.ok, false);
  assert.match((r as { erro: string }).erro, /grande demais/);
  assert.equal(cancelado, true, "a leitura foi cancelada ao passar do teto");
  assert.ok(enviados < 20, `parou perto de 8 MiB (puxou ${enviados} MiB)`);
  assert.equal(fs.existsSync(arquivo), false);
});

test("openrouter: atualizações simultâneas viram uma busca só, e depois de falhar não repete antes do intervalo", async () => {
  const arquivo = path.join(pastaTemporaria("oc-unica"), "modelos.json");
  let buscas = 0;
  const lento = (async () => {
    buscas += 1;
    await new Promise((r) => setTimeout(r, 100));
    return new Response(JSON.stringify({ data: [{ id: "a/b", supported_parameters: ["tools"] }] }), { status: 200 });
  }) as typeof fetch;
  const rs = await Promise.all([1, 2, 3, 4].map(() => atualizarCacheOpenRouter({ arquivo, buscar: lento })));
  assert.equal(buscas, 1);
  assert.ok(rs.every((r) => r.ok));

  zerarFalhasDoOpenRouter();
  const velho = path.join(pastaTemporaria("oc-falha"), "modelos.json");
  let tentativas = 0;
  const cai = (async () => {
    tentativas += 1;
    throw new Error("sem rede");
  }) as typeof fetch;
  await garantirCacheOpenRouter("teste", { arquivo: velho, buscar: cai });
  await garantirCacheOpenRouter("teste", { arquivo: velho, buscar: cai });
  assert.equal(tentativas, 1, "a segunda chamada, logo depois da falha, não bate na rede");
});

test("openrouter: cache que é FIFO ou link simbólico não é lido nem trava o runner", () => {
  const pasta = pastaTemporaria("oc-especial");
  const fifo = path.join(pasta, "fifo.json");
  execFileSync("mkfifo", [fifo]);
  const t0 = Date.now();
  assert.equal(lerCacheOpenRouter(fifo), null);
  assert.ok(Date.now() - t0 < 1000, "a leitura não ficou presa no FIFO");
  const alvo = path.join(pasta, "real.json");
  fs.writeFileSync(alvo, JSON.stringify({ buscadoEm: new Date().toISOString(), modelos: [{ id: "a/b", nome: "AB", apelidos: [] }] }));
  const link = path.join(pasta, "link.json");
  fs.symlinkSync(alvo, link);
  assert.equal(lerCacheOpenRouter(link), null, "link simbólico não é seguido");
  assert.equal(lerCacheOpenRouter(alvo)?.modelos.length, 1, "o arquivo comum continua lido");
});

test("openrouter: a gravação não segue link plantado no nome temporário antigo e deixa o cache com modo 600", async () => {
  const pasta = pastaTemporaria("oc-tmp");
  const arquivo = path.join(pasta, "modelos.json");
  const vitima = path.join(pasta, "vitima.txt");
  fs.writeFileSync(vitima, "intacto");
  fs.symlinkSync(vitima, `${arquivo}.${process.pid}.tmp`);
  const bom = (async () => new Response(JSON.stringify({ data: [{ id: "a/b", supported_parameters: ["tools"] }] }), { status: 200 })) as typeof fetch;
  assert.equal((await atualizarCacheOpenRouter({ arquivo, buscar: bom })).ok, true);
  assert.equal(fs.readFileSync(vitima, "utf8"), "intacto");
  assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(pasta).filter((f) => f.endsWith(".tmp") && !f.startsWith("modelos.json." + process.pid)).length, 0, "nenhum temporário aleatório sobrou");
});

function binarioDeConversa(pasta: string, corpo: string): string {
  const bin = path.join(pasta, "opencode-falso");
  fs.writeFileSync(bin, `#!/bin/sh\n${corpo}\n`, { mode: 0o755 });
  return bin;
}

test("conversa: leituras simultâneas da mesma sessão compartilham um processo só, e o cache curto evita outro", async () => {
  zerarConversaDoOpenCode();
  const pasta = pastaTemporaria("oc-conc");
  const contagem = path.join(pasta, "contagem");
  const bin = binarioDeConversa(pasta, `echo x >> "${contagem}"\nsleep 0.4\ncat <<'FIM'\n${EXPORT}\nFIM`);
  const pedido = { sessionId: "ses_Conc1abc", env: { PATH: process.env.PATH ?? "" }, cwd: pasta, quantas: 5, binario: bin };
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => lerConversaDoOpenCode(pedido)));
  assert.ok(rs.every((r) => r.length === 2));
  assert.equal(fs.readFileSync(contagem, "utf8").trim().split("\n").length, 1, "um processo para cinco leituras");
  await lerConversaDoOpenCode(pedido);
  assert.equal(fs.readFileSync(contagem, "utf8").trim().split("\n").length, 1, "o cache curto atendeu a leitura seguinte");
});

test("conversa: sessões diferentes passam por no máximo 2 processos ao mesmo tempo", async () => {
  zerarConversaDoOpenCode();
  const pasta = pastaTemporaria("oc-vagas");
  const marcas = path.join(pasta, "marcas");
  const bin = binarioDeConversa(pasta, `echo "+" >> "${marcas}"\nsleep 0.3\necho "-" >> "${marcas}"\ncat <<'FIM'\n${EXPORT}\nFIM`);
  const ids = ["ses_Vaga1abc", "ses_Vaga2abc", "ses_Vaga3abc", "ses_Vaga4abc", "ses_Vaga5abc"];
  await Promise.all(ids.map((sessionId) => lerConversaDoOpenCode({ sessionId, env: { PATH: process.env.PATH ?? "" }, cwd: pasta, quantas: 1, binario: bin })));
  let ativos = 0;
  let maximo = 0;
  for (const l of fs.readFileSync(marcas, "utf8").trim().split("\n")) {
    ativos += l === "+" ? 1 : -1;
    maximo = Math.max(maximo, ativos);
  }
  assert.ok(maximo <= 2, `no máximo 2 ao mesmo tempo (chegou a ${maximo})`);
});

test("conversa: falha do export e conversa acima do teto viram erro explícito, não lista vazia", async () => {
  zerarConversaDoOpenCode();
  const pasta = pastaTemporaria("oc-erro");
  const quebra = binarioDeConversa(pasta, "echo 'banco corrompido' >&2\nexit 3");
  await assert.rejects(
    lerConversaDoOpenCode({ sessionId: "ses_Erro1abc", env: { PATH: process.env.PATH ?? "" }, cwd: pasta, quantas: 1, binario: quebra }),
    (e: unknown) => e instanceof ErroDeConversa && /falhou/.test(e.message) && e.comoResolver.length > 0,
  );
  zerarConversaDoOpenCode();
  const enorme = binarioDeConversa(pasta, "head -c 34000000 /dev/zero | tr '\\0' a");
  await assert.rejects(
    lerConversaDoOpenCode({ sessionId: "ses_Erro2abc", env: { PATH: process.env.PATH ?? "" }, cwd: pasta, quantas: 1, binario: enorme }),
    (e: unknown) => e instanceof ErroDeConversa && /32 MiB/.test(e.message),
  );
});

test("opencode: forma de pagar herdada do protótipo ('constructor') não vale e restrições do dono recusam o card", () => {
  const sem = ctxOpenCode({ escolha: { provedor: "opencode", auth: "constructor", modelo: "z-ai/glm-5.3-prime", paraCard: true } });
  const r = motorOpenCode.motivoSemLogin!(sem)!;
  assert.equal(r.tipo, "chave");
  assert.match(r.mensagem, /só funciona na forma 'api'/);
  const restrito = ctxOpenCode({ config: { name: "x", cwd: "/tmp", initialPrompt: "", provider: "opencode-cli", permissionMode: "auto", denyTools: ["Bash"] } });
  assert.equal(motorOpenCode.motivoSemLogin!(restrito)!.tipo, "restricao");
});

test("opencode: o AGENTS.md da pasta de trabalho entra por instructions (a config do projeto fica desligada)", () => {
  const cwd = pastaTemporaria("oc-agents");
  assert.equal("instructions" in configDoSpawn(ctxOpenCode({ cwd })), false, "sem AGENTS.md nada entra");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "regras da pasta\n");
  const cfg = configDoSpawn(ctxOpenCode({ cwd, identidade: { arquivo: "/tmp/identidade.md", texto: "x" } }));
  assert.deepEqual(cfg.instructions, ["/tmp/identidade.md", path.join(cwd, "AGENTS.md")]);
  // Uma PASTA chamada AGENTS.md não é arquivo de instrução.
  const outro = pastaTemporaria("oc-agents2");
  fs.mkdirSync(path.join(outro, "AGENTS.md"));
  assert.equal("instructions" in configDoSpawn(ctxOpenCode({ cwd: outro })), false);
});
