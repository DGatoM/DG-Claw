import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  chaveFalsa, chaveFalsaOpenai, dormir, esperarAte, lerLinhasJson, lerTexto, logarClaude, logarCodex, portaLivre, prepararAmbiente,
} from "./apoio-teste.js";

const amb = prepararAmbiente("servidor", {
  config: { envExtra: { DGCHAT_OUTBOUND: "/tmp/dgchat-outbound-teste/outbound.jsonl", DGCHAT_AGENT: "agente-teste" } },
  sessoes: [{ id: "bast", tipo: "bastidores", chat: "c_bast" }],
});
const OAI = chaveFalsaOpenai();
const ANT = chaveFalsa();
fs.writeFileSync(path.join(amb.raiz, "cofre.env"), `OPENAI_API_KEY='${OAI}'\n`);
process.env.DGCLAW_COFRE_ARQUIVO = path.join(amb.raiz, "cofre.env");
process.env.OPENAI_API_KEY = OAI;
// O runner cobra o Bearer do RUNNER_TOKEN_FILE em toda rota menos saúde e hook
// (autenticacao.ts, do card 4): o teste fala com ele como o painel fala.
const TOKEN = "teste-" + "a".repeat(40);
fs.writeFileSync(path.join(amb.raiz, "runner.token"), TOKEN + "\n", { mode: 0o600 });
process.env.RUNNER_TOKEN_FILE = path.join(amb.raiz, "runner.token");
logarClaude(amb);
logarCodex(amb);

const { GerenteDeSessoes } = await import("./sessoes.js");
const { criarServidor } = await import("./servidor.js");
const { lerDescritor, PASTA_DE_ESTADO } = await import("./config-runner.js");

const porta = await portaLivre();
const descritor = lerDescritor();
const gerente = new GerenteDeSessoes(descritor, porta);
const servidor: http.Server = criarServidor(gerente);
await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
test.after(() => {
  gerente.pararTodas("fim dos testes");
  servidor.closeAllConnections?.();
  servidor.close();
});

const ID = descritor.id;
async function req(metodo: string, rota: string, corpo?: unknown): Promise<{ status: number; corpo: any }> {
  const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await r.text();
  let json: any = texto;
  try {
    json = JSON.parse(texto);
  } catch {
    /* corpo que não é JSON fica como texto */
  }
  return { status: r.status, corpo: json };
}
const principal = gerente.principal;
const ptys = () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "interativo");

test("a pasta de estado recebe tudo e o descritor continua sozinho na pasta dele", async () => {
  await principal.subir("nova");
  await esperarAte(() => principal.estado.status === "idle", 8_000);
  assert.equal(PASTA_DE_ESTADO, amb.estado);
  assert.ok(fs.existsSync(path.join(amb.estado, "runner-state.json")));
  assert.ok(fs.existsSync(path.join(amb.estado, "runner-hooks", `${ID}.settings.json`)));
  assert.deepEqual(fs.readdirSync(path.dirname(amb.descritor)), ["runner.json"]);
});

test("GET /api/provedor: formato, conferência sem e-mail nem orgId, login e canais", async () => {
  const r = await req("GET", "/api/provedor");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.corpo).sort(), ["auth", "canais", "conferido", "disponiveis", "login", "modelo", "origem", "provedor", "rotulo", "sessao"]);
  assert.equal(r.corpo.sessao, ID);
  assert.equal(r.corpo.provedor, "claude");
  assert.equal(r.corpo.auth, "assinatura");
  assert.equal(r.corpo.origem, "descritor");
  assert.equal(r.corpo.rotulo, "Claude (modelo padrão), na assinatura");
  assert.deepEqual(r.corpo.conferido.ok, true);
  assert.equal(r.corpo.conferido.metodo, "assinatura");
  assert.equal(r.corpo.conferido.detalhe, "Conta do Claude conectada (plano max).");
  assert.deepEqual(r.corpo.login, { estado: "nenhum" });
  // os CLIs falsos do teste (claude e codex) estão no PATH, então os dois provedores liberados do catálogo aparecem
  assert.deepEqual(r.corpo.disponiveis, ["claude", "codex"]);
  assert.deepEqual(r.corpo.canais, { telegram: "desligado" });
  const texto = JSON.stringify(r.corpo);
  for (const p of ["fulano", "example.com", "org-0123", "Organizacao"]) assert.equal(texto.includes(p), false, p);
});

test("GET /api/provedor?sessao=: a paralela não tem 'canais'; sessão inexistente é 404 com motivo e como resolver", async () => {
  const p = await req("GET", "/api/provedor?sessao=bast");
  assert.equal(p.status, 200);
  assert.equal(p.corpo.sessao, "bast");
  assert.equal("canais" in p.corpo, false);
  const n = await req("GET", "/api/provedor?sessao=nao-existe");
  assert.equal(n.status, 404);
  assert.equal(n.corpo.code, "SESSAO_INEXISTENTE");
  assert.match(n.corpo.error, /não tem a sessão nao-existe/);
  assert.match(n.corpo.howToFix, /GET \/api\/agents\?todas=1/);
});

test("POST /api/provedor recusa chave e segredo com 400, sem repetir o valor", async () => {
  for (const corpo of [
    { provedor: "codex", auth: "api", chave: ANT },
    { provedor: "codex", auth: "api", valor: "x" },
    { provedor: "codex", auth: "api", api_key: "x" },
    { provedor: "codex", auth: "api", modelo: ANT },
  ]) {
    const r = await req("POST", "/api/provedor", corpo);
    assert.equal(r.status, 400, JSON.stringify(Object.keys(corpo)));
    assert.equal(r.corpo.code, "CHAVE_NAO_AQUI");
    assert.match(r.corpo.error, /Cofre do painel/);
    assert.equal(JSON.stringify(r.corpo).includes(ANT), false);
  }
  assert.equal(fs.existsSync(path.join(amb.estado, "provedor.json")), false, "nada foi gravado");
});

test("POST /api/provedor valida pelo catálogo, em português", async () => {
  const casos: Array<[Record<string, unknown>, RegExp]> = [
    [{ provedor: "codex", auth: "token" }, /Forma de pagar 'token' não existe para Codex/],
    [{ provedor: "claude", auth: "assinatura", modelo: "gpt-5" }, /Modelo 'gpt-5' não existe para Claude/],
    [{ provedor: "gemini", auth: "api" }, /Gemini CLI ainda não está disponível/],
    [{ provedor: "xyz" }, /Provedor 'xyz' não existe/],
  ];
  for (const [corpo, esperado] of casos) {
    const r = await req("POST", "/api/provedor", corpo);
    assert.equal(r.status, 400);
    assert.equal(r.corpo.code, "ESCOLHA_INVALIDA");
    assert.match(r.corpo.error, esperado);
    assert.ok(r.corpo.howToFix);
  }
  assert.equal((await req("POST", "/api/provedor", { auth: "api" })).corpo.code, "PROVEDOR_OBRIGATORIO");
  assert.equal((await req("POST", "/api/provedor", { provedor: "claude", reiniciar: "sim" })).corpo.code, "REINICIAR_INVALIDO");
  assert.equal((await req("POST", "/api/provedor", { provedor: "claude", sessao: "nao-existe" })).status, 404);
});

test("POST /api/provedor com reiniciar:false só grava o provedor.json", async () => {
  const antes = ptys().length;
  const r = await req("POST", "/api/provedor", { provedor: "codex", auth: "assinatura", modelo: "", reiniciar: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, { ok: true, sessao: ID, provedor: "codex", auth: "assinatura", modelo: "", rotulo: "Codex (modelo padrão), na assinatura", reiniciou: false });
  const gravado = JSON.parse(fs.readFileSync(path.join(amb.estado, "provedor.json"), "utf8"));
  assert.equal(gravado.provedor, "codex");
  assert.equal(fs.statSync(path.join(amb.estado, "provedor.json")).mode & 0o777, 0o600);
  await dormir(300);
  assert.equal(ptys().length, antes, "ninguém reiniciou");
  assert.equal(principal.temPtyVivo(), true, "o Claude continua rodando até o reinício");
  const g = await req("GET", "/api/provedor");
  assert.equal(g.corpo.origem, "provedor.json");
  assert.equal(g.corpo.provedor, "codex");
  assert.deepEqual(g.corpo.canais, { telegram: "indisponivel_no_codex" });
  assert.equal(g.corpo.conferido.ok, true);
  assert.equal(g.corpo.conferido.detalhe, "Conta do ChatGPT conectada.");
});

test("POST /api/agents/<id>/reiniciar: com o provedor mudado desde o último spawn, abre conversa nova", async () => {
  const idAntigo = principal.estado.sessionId;
  const r = await req("POST", `/api/agents/${ID}/reiniciar`);
  assert.equal(r.status, 202);
  assert.deepEqual(r.corpo, { ok: true, sessao: ID, modo: "nova" });
  assert.equal(principal.estado.previousSessionId, idAntigo);
  await esperarAte(() => ptys().some((l) => l.argv[0] === "--dangerously-bypass-approvals-and-sandbox"), 6_000, "o Codex abrir");
  await esperarAte(() => principal.estado.status === "idle", 6_000);

  // sem mudança desde o último spawn, o reinício retoma a MESMA conversa
  await principal.digitarEEnviar("algo para o codex gravar o rollout");
  await esperarAte(() => principal.estado.sessionId !== null, 6_000);
  const uuid = principal.estado.sessionId;
  const r2 = await req("POST", `/api/agents/${ID}/reiniciar`);
  assert.deepEqual(r2.corpo, { ok: true, sessao: ID, modo: "retomar" });
  await esperarAte(() => ptys().some((l) => l.argv[0] === "resume" && l.argv[1] === uuid), 6_000, "o resume");
  assert.equal(principal.estado.sessionId, uuid);
});

test("POST /api/provedor com reiniciar (padrão) para e sobe NOVA na hora, de volta ao Claude", async () => {
  const antes = ptys().length;
  const r = await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "opus" });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.reiniciou, true);
  assert.equal(r.corpo.modelo, "claude-opus-5-5");
  assert.equal(r.corpo.rotulo, "Claude Opus 5.5, na assinatura");
  await esperarAte(() => ptys().length > antes && ptys().at(-1)!.argv.includes("--session-id"), 6_000, "o Claude novo abrir");
  assert.equal(ptys().at(-1)!.argv[ptys().at(-1)!.argv.indexOf("--model") + 1], "claude-opus-5-5");
});

test("POST /api/provedor com reiniciar: o processo antigo já morreu quando a resposta chega (sem janela com o ambiente do modo antigo)", async () => {
  await esperarAte(() => principal.temPtyVivo(), 6_000, "o PTY do teste anterior");
  const pidAntigo = (principal as unknown as { proc: { pid: number } }).proc.pid;
  const r = await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "" });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.reiniciou, true);
  assert.throws(() => process.kill(pidAntigo, 0), { code: "ESRCH" });
  await esperarAte(() => principal.temPtyVivo(), 6_000, "o PTY novo");
  assert.notEqual((principal as unknown as { proc: { pid: number } }).proc.pid, pidAntigo);
});

test("login assistido pelas rotas: link, código, concluído, e a sessão presa na tela de login é trocada por uma limpa", async () => {
  // O dono ainda não entrou: a sessão sobe, mostra a tela de login e fica errored.
  fs.rmSync(path.join(amb.claudeDir, ".credentials.json"), { force: true });
  await req("POST", `/api/agents/${ID}/reiniciar`);
  await esperarAte(() => principal.estado.statusReason === "runner:sem-login", 6_000, "errored sem-login");
  const bloqueada = await req("POST", `/api/agents/${ID}/input`, { text: "oi" });
  assert.equal(bloqueada.status, 409);
  assert.equal(bloqueada.corpo.code, "SEM_LOGIN");

  assert.equal((await req("GET", "/api/provedor/login")).corpo.estado, "nenhum");
  assert.equal((await req("POST", "/api/provedor/login/codigo", { codigo: "x" })).status, 409, "fora do estado");
  const ini = await req("POST", "/api/provedor/login", {});
  assert.equal(ini.status, 202);
  assert.equal(ini.corpo.estado, "aguardando_link");
  await esperarAte(async () => (await req("GET", "/api/provedor/login")).corpo.estado === "aguardando_codigo", 6_000, "o link");
  const com = await req("GET", "/api/provedor/login");
  assert.match(com.corpo.link, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.equal((await req("GET", "/api/provedor")).corpo.login.estado, "aguardando_codigo", "o mesmo objeto aparece no GET /api/provedor");
  const outro = await req("POST", "/api/provedor/login", {});
  assert.equal(outro.status, 409);
  assert.equal(outro.corpo.code, "LOGIN_EM_ANDAMENTO");
  assert.equal((await req("POST", "/api/provedor/login/codigo", { codigo: "com espaço" })).status, 400);
  assert.equal((await req("POST", "/api/provedor/login/codigo", { codigo: "abc123-xyz" })).status, 200);
  await esperarAte(async () => (await req("GET", "/api/provedor/login")).corpo.estado === "concluido", 6_000, "o login concluir");

  // Conta nova: a sessão da tela de login é descartada e sobe uma limpa, sem esperar o relógio de 60 s.
  await esperarAte(() => principal.estado.statusReason !== "runner:sem-login" && principal.temPtyVivo(), 8_000, "a sessão limpa subir");
  await esperarAte(() => principal.estado.status === "idle", 8_000);
  assert.equal(principal.recusaDeEntrada(), null);
  const conf = await req("GET", "/api/provedor");
  assert.equal(conf.corpo.conferido.ok, true, "o cache da conferência foi invalidado pelo login");
  assert.equal(lerTexto(amb.logDoRunner).includes("abc123-xyz"), false);
});

test("login só existe na assinatura: na API responde 409 com o caminho certo", async () => {
  process.env.ANTHROPIC_API_KEY = ANT;
  test.after(() => void delete process.env.ANTHROPIC_API_KEY);
  await req("POST", "/api/provedor", { provedor: "claude", auth: "api", modelo: "", reiniciar: false });
  const r = await req("POST", "/api/provedor/login", {});
  assert.equal(r.status, 409);
  assert.equal(r.corpo.code, "LOGIN_SO_NA_ASSINATURA");
  assert.match(r.corpo.howToFix, /Cofre do painel/);
  const g = await req("GET", "/api/provedor");
  assert.equal(g.corpo.conferido.ok, false, "o CLI diz assinatura e o dono escolheu a API");
  assert.match(g.corpo.conferido.detalhe, /configurado para chave de API, mas o Claude está conectado por assinatura/);
  await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "", reiniciar: false });
  assert.equal((await req("DELETE", "/api/provedor/login")).corpo.estado, "nenhum");
});

test("input numa sessão em modo API sem a chave responde 409 SEM_CHAVE com o motivo e o que fazer", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await req("POST", "/api/provedor", { provedor: "claude", auth: "api", modelo: "" });
  assert.equal(principal.estado.statusReason, "runner:sem-chave");
  const r = await req("POST", `/api/agents/${ID}/input`, { text: "oi" });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.code, "SEM_CHAVE");
  assert.match(r.corpo.error, /ANTHROPIC_API_KEY/);
  assert.match(r.corpo.howToFix, /Cofre do painel/);
  // submit:false (tecla crua do terminal do dono) continua passando pela guarda de login, como sempre
  await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "" });
  await esperarAte(() => principal.temPtyVivo(), 6_000);
});

test("POST /api/sessoes cria uma sessão Codex sem mexer no runner.json; ela dorme até o primeiro input", async () => {
  const antesDoDescritor = fs.readFileSync(amb.descritor, "utf8");
  const r = await req("POST", "/api/sessoes", { id: "card-teste", titulo: "Meu card", provedor: "codex", auth: "assinatura", modelo: "gpt-5.5" });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  assert.equal(r.corpo.success, true);
  assert.equal(r.corpo.data.id, "card-teste");
  assert.equal(r.corpo.data.sessao.tipo, "card");
  assert.equal(r.corpo.data.sessao.chat, `c_${descritor.slug}-card-teste`);
  assert.equal(r.corpo.data.sessao.titulo, "Meu card");
  assert.equal(r.corpo.data.status, "stopped");
  assert.equal(fs.readFileSync(amb.descritor, "utf8"), antesDoDescritor, "o runner.json não muda");
  const extras = JSON.parse(fs.readFileSync(path.join(amb.estado, "sessoes-extras.json"), "utf8"));
  assert.equal(extras.sessoes[0].id, "card-teste");
  const pj = JSON.parse(fs.readFileSync(path.join(amb.estado, "sessoes", "card-teste", "provedor.json"), "utf8"));
  assert.deepEqual([pj.provedor, pj.auth, pj.modelo], ["codex", "assinatura", "gpt-5.5"]);
  assert.equal(gerente.porId("card-teste")!.temPtyVivo(), false, "não acorda sozinha");
  const todas = await req("GET", "/api/agents?todas=1");
  assert.ok(todas.corpo.data.some((a: any) => a.id === "card-teste"));
  const g = await req("GET", "/api/provedor?sessao=card-teste");
  assert.equal(g.corpo.provedor, "codex");
  assert.equal(g.corpo.modelo, "gpt-5.5");
  assert.equal(g.corpo.origem, "provedor.json");

  // O primeiro input acorda (202) e o texto sai quando ela ficar ociosa.
  const i = await req("POST", `/api/agents/card-teste/input`, { text: "olá card" });
  assert.equal(i.status, 202);
  assert.equal(i.corpo.data.acordando, true);
  await esperarAte(() => gerente.porId("card-teste")!.temPtyVivo(), 6_000, "o card acordar");
  await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.texto === "olá card"), 15_000, "o texto chegar ao Codex");
  await esperarAte(() => gerente.porId("card-teste")!.estado.sessionId !== null, 8_000);
  const conversa = await req("GET", "/api/agents/card-teste/conversation?limit=10");
  assert.equal(conversa.status, 200);
  await esperarAte(async () => (await req("GET", "/api/agents/card-teste/conversation?limit=10")).corpo.data.some((m: any) => m.role === "assistant"), 8_000, "a resposta no rollout");
  const msgs = (await req("GET", "/api/agents/card-teste/conversation?limit=10")).corpo.data;
  assert.deepEqual(msgs.map((m: any) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0].text, "olá card");
  assert.deepEqual(Object.keys(msgs[0]).sort(), ["role", "text"]);
});

test("POST /api/sessoes: erros em português, e o id não repete", async () => {
  const casos: Array<[Record<string, unknown>, number, string]> = [
    [{ auth: "assinatura" }, 400, "PROVEDOR_OBRIGATORIO"],
    [{ provedor: "llama" }, 400, "PROVEDOR_INVALIDO"],
    [{ provedor: "claude", modelo: "gpt-5" }, 400, "ESCOLHA_INVALIDA"],
    [{ provedor: "claude", id: "card teste" }, 400, "SESSAO_INVALIDA"],
    [{ provedor: "claude", id: "card-teste" }, 409, "SESSAO_INVALIDA"],
    [{ provedor: "claude", id: ID }, 400, "SESSAO_INVALIDA"],
    [{ provedor: "claude", id: "outra", chat: `c_${descritor.slug}` }, 400, "SESSAO_INVALIDA"],
  ];
  for (const [corpo, status, code] of casos) {
    const r = await req("POST", "/api/sessoes", corpo);
    assert.equal(r.status, status, JSON.stringify(corpo));
    assert.equal(r.corpo.code, code);
    assert.ok(r.corpo.error && r.corpo.howToFix);
  }
  const auto = await req("POST", "/api/sessoes", { provedor: "claude" });
  assert.equal(auto.status, 201);
  assert.match(auto.corpo.data.id, /^card-[0-9a-f]{6}$/);
  assert.equal((await req("DELETE", `/api/sessoes/${auto.corpo.data.id}`)).status, 200);
});

test("no boot as extras sobem junto, dormindo; DELETE só vale para as extras", async () => {
  const outro = new GerenteDeSessoes(descritor, porta);
  const card = outro.porId("card-teste");
  assert.ok(card, "a sessão criada por API volta no próximo boot");
  assert.equal(card!.temPtyVivo(), false);
  assert.equal(card!.estado.status, "resumable", "tem conversa guardada: dá para acordar");
  assert.equal(outro.ehExtra("card-teste"), true);
  assert.equal(outro.ehExtra("bast"), false);

  const doDescritor = await req("DELETE", "/api/sessoes/bast");
  assert.equal(doDescritor.status, 409);
  assert.equal(doDescritor.corpo.code, "SESSAO_DO_DESCRITOR");
  assert.match(doDescritor.corpo.error, /declarada no descritor/);
  assert.equal((await req("DELETE", "/api/sessoes/nao-existe")).status, 404);

  const ok = await req("DELETE", "/api/sessoes/card-teste");
  assert.equal(ok.status, 200);
  assert.equal(gerente.porId("card-teste"), undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(amb.estado, "sessoes-extras.json"), "utf8")).sessoes.length, 0);
  assert.ok(fs.existsSync(path.join(amb.estado, "sessoes", "card-teste", "runner-state.json")), "a conversa fica no disco");
  assert.equal(new GerenteDeSessoes(descritor, porta).porId("card-teste"), undefined);
});

test("o hook de status pelo HTTP: nonce errado é recusado sem dizer o nonce", async () => {
  const r = await req("POST", "/api/agent-hook", { agentId: ID, event: "Stop", nonce: "errado" });
  assert.deepEqual(r.corpo, { success: false, reason: "nonce de um spawn antigo" });
  const naoEh = await req("POST", "/api/agent-hook", { agentId: "outro", event: "Stop", nonce: "x" });
  assert.equal(naoEh.corpo.success, false);
});

test("GET /conversation do Claude mascara o valor do cofre no histórico", async () => {
  await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "" });
  await esperarAte(() => principal.estado.sessionId !== null && principal.temPtyVivo(), 6_000);
  const id = principal.estado.sessionId!;
  const dir = path.join(amb.claudeDir, "projects", "pasta-qualquer");
  fs.mkdirSync(dir, { recursive: true });
  const linha = (role: string, text: string) => JSON.stringify({ message: { role, content: [{ type: "text", text }] } });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [linha("user", "oi"), linha("assistant", `a chave é ${OAI} mesmo`)].join("\n") + "\n");
  const r = await req("GET", `/api/agents/${ID}/conversation?limit=5`);
  assert.deepEqual(r.corpo.data, [
    { role: "user", text: "oi" },
    { role: "assistant", text: "a chave é [segredo oculto] mesmo" },
  ]);
});

test("GET /api/provedor no Codex na API: a saída do 'codex login status' tem pedaço da chave e nada dela chega na resposta", async () => {
  const chave = chaveFalsaOpenai("PEDACODACHAVE12345");
  const casaDoCard = descritor.config.cwd;
  const home = path.join(casaDoCard, ".plataforma", "codex-api", ID);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: chave }));
  await req("POST", "/api/provedor", { provedor: "codex", auth: "api", modelo: "", reiniciar: false });
  const g = await req("GET", "/api/provedor");
  assert.equal(g.status, 200);
  assert.equal(g.corpo.conferido.ok, true);
  assert.equal(g.corpo.conferido.metodo, "api");
  const texto = JSON.stringify(g.corpo);
  for (const pedaco of [chave.slice(0, 10), chave.slice(-6), "Logged in using an API key"]) assert.equal(texto.includes(pedaco), false, pedaco);
  await req("POST", "/api/provedor", { provedor: "claude", auth: "assinatura", modelo: "", reiniciar: false });
});

test("POST /api/sessoes respeita o teto RUNNER_MAX_SESSOES_EXTRAS: a 4ª dá 429 e fechar uma libera vaga", async () => {
  const antes = process.env.RUNNER_MAX_SESSOES_EXTRAS;
  try {
    process.env.RUNNER_MAX_SESSOES_EXTRAS = "3";
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await req("POST", "/api/sessoes", { provedor: "codex", id: `teto-${i}` });
      assert.equal(r.status, 201, JSON.stringify(r.corpo));
      ids.push(r.corpo.data.id);
    }
    const barrada = await req("POST", "/api/sessoes", { provedor: "codex", id: "teto-3" });
    assert.equal(barrada.status, 429);
    assert.equal(barrada.corpo.code, "LIMITE_DE_SESSOES");
    assert.match(barrada.corpo.error, /3 sessões.*limite é 3/);
    assert.match(barrada.corpo.howToFix, /dgclaw-card fechar/);
    assert.match(barrada.corpo.howToFix, /RUNNER_MAX_SESSOES_EXTRAS/);
    assert.equal(gerente.porId("teto-3"), undefined, "a barrada não deixa sessão nem arquivo para trás");

    assert.equal((await req("DELETE", `/api/sessoes/${ids[0]}`)).status, 200);
    const volta = await req("POST", "/api/sessoes", { provedor: "codex", id: "teto-3" });
    assert.equal(volta.status, 201, JSON.stringify(volta.corpo));

    // Valor inválido cai no padrão 3 (e o aviso vai para o log); 0 fecha a porta de vez.
    process.env.RUNNER_MAX_SESSOES_EXTRAS = "muitas";
    assert.equal(gerente.limiteDeExtras(), 3);
    assert.match(lerTexto(amb.logDoRunner), /RUNNER_MAX_SESSOES_EXTRAS="muitas" não é um inteiro.*padrão 3/);
    process.env.RUNNER_MAX_SESSOES_EXTRAS = "0";
    assert.equal((await req("POST", "/api/sessoes", { provedor: "codex" })).status, 429);
  } finally {
    if (antes === undefined) delete process.env.RUNNER_MAX_SESSOES_EXTRAS;
    else process.env.RUNNER_MAX_SESSOES_EXTRAS = antes;
    for (const id of ["teto-0", "teto-1", "teto-2", "teto-3"]) await req("DELETE", `/api/sessoes/${id}`);
  }
});

test("POST /api/agents/:id/permissao: decisão inválida é 400 e agente que não espera permissão é 409, sem digitar nada", async () => {
  const ruim = await req("POST", `/api/agents/${ID}/permissao`, { decisao: "talvez" });
  assert.equal(ruim.status, 400);
  assert.equal(ruim.corpo.code, "DECISAO_INVALIDA");
  assert.ok(principal.estado.status !== "waiting_input");
  const fora = await req("POST", `/api/agents/${ID}/permissao`, { decisao: "aprovar" });
  assert.equal(fora.status, 409);
  assert.equal(fora.corpo.code, "NAO_ESPERA_PERMISSAO");
  assert.match(fora.corpo.howToFix, /atualizar a tela/);
});

test("provedoresDisponiveis: precisa estar liberado no catálogo E ter o programa no PATH", async () => {
  const { provedoresDisponiveis } = await import("./provedores/rotas.js");
  const { carregar } = await import("./provedores/catalogo.js");
  const cat = carregar();
  const pasta = fs.mkdtempSync(path.join(amb.raiz, "bins-"));
  fs.writeFileSync(path.join(pasta, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(pasta, "codex"), "#!/bin/sh\n", { mode: 0o644 }); // sem permissão de executar: não conta
  assert.deepEqual(provedoresDisponiveis(cat, pasta), ["claude"]);
  fs.chmodSync(path.join(pasta, "codex"), 0o755);
  assert.deepEqual(provedoresDisponiveis(cat, pasta), ["claude", "codex"]);
  assert.deepEqual(provedoresDisponiveis(cat, ""), [], "PATH vazio: nenhum");
  assert.deepEqual(provedoresDisponiveis(cat, undefined), []);
  // gemini está no catálogo como indisponível: nunca entra, mesmo com o programa instalado
  fs.writeFileSync(path.join(pasta, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(provedoresDisponiveis(cat, pasta).includes("gemini"), false);
});
