// Restrições do dono x conta de IA: o runner recusa abrir sessão quando há restrição ativa e a conta é de
// uma organização (política remota vence a trava local). Usa o Claude falso (FAKE_CLAUDE_STATUS).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { abrirServidorDeHooks, esperarAte, lerTexto, logarClaude, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("restricoes-conta");
const { Sessao } = await import("./sessao.js");
const { lerRestricoes, classificarSaidaDaConta } = await import("./restricoes-conta.js");

const ARQ_RESTRICOES = path.join(path.dirname(amb.descritor), "restricoes.json");
const CONTA_PESSOAL = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
const CONTA_DE_ORG = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", orgName: "Org Exemplo" });

function restringir(conteudo: string | null): void {
  if (conteudo === null) fs.rmSync(ARQ_RESTRICOES, { force: true });
  else fs.writeFileSync(ARQ_RESTRICOES, conteudo);
}
const COM_TRAVA = '{"versao":1,"sem_bash":true,"sem_enviar_arquivo":false,"escrita_so_em":null}';

let n = 0;
const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
async function nova() {
  n += 1;
  const id = `rc-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const cfg = { name: id, cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions" };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, { arquivoDeEstado: path.join(pasta, "runner-state.json"), pastaDeEstado: pasta } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  return s;
}
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
  restringir(null);
});
test.beforeEach(() => {
  logarClaude(amb);
  restringir(null);
  fs.rmSync(path.join(amb.claudeDir, "remote-settings.json"), { force: true });
  process.env.FAKE_CLAUDE_STATUS = CONTA_PESSOAL + "\n";
});

test("sem restrições a sessão abre, mesmo com conta de organização", async () => {
  process.env.FAKE_CLAUDE_STATUS = CONTA_DE_ORG + "\n";
  const s = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "abrir sem restrições");
  assert.equal(s.recusaDeEntrada(), null);
});

test("com restrições e conta pessoal a sessão abre", async () => {
  restringir(COM_TRAVA);
  const s = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "abrir com restrições e conta pessoal");
});

test("com restrições e conta de organização a sessão NÃO abre, com motivo e o que fazer, e registra no log", async () => {
  restringir(COM_TRAVA);
  process.env.FAKE_CLAUDE_STATUS = CONTA_DE_ORG + "\n";
  const s = await nova();
  await s.subir("nova");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.equal(s.temPtyVivo(), false);
  assert.match(s.estado.error ?? "", /Team\/Enterprise/);
  assert.match(s.estado.error ?? "", /conta pessoal \(Pro ou Max\) ou uma chave de API/);
  const r = s.recusaDeEntrada();
  assert.equal(r?.tipo, "restricao");
  assert.ok(lerTexto(amb.logDoRunner).includes("não valem com a conta de IA conectada"));
  assert.ok(!lerTexto(amb.logDoRunner).includes("Org Exemplo"), "a organização não vai para o log");
});

test("com restrições e política remota no disco a sessão NÃO abre; ao retomar também", async () => {
  restringir(COM_TRAVA);
  fs.writeFileSync(path.join(amb.claudeDir, "remote-settings.json"), '{"disableAllHooks":true}');
  const s = await nova();
  await s.subir("nova");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.match(s.estado.error ?? "", /política administrada remota/);
  await s.subir("retomar");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.equal(s.temPtyVivo(), false);
});

test("com restrições e conta que não dá para classificar a sessão NÃO abre", async () => {
  restringir(COM_TRAVA);
  process.env.FAKE_CLAUDE_STATUS = "isto não é json\n";
  const s = await nova();
  await s.subir("nova");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.match(s.estado.error ?? "", /Não consegui confirmar qual é a conta/);
});

test("restricoes.json inválido recusa (falha fechada)", async () => {
  restringir("{isto nao e json");
  const s = await nova();
  await s.subir("nova");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.match(s.estado.error ?? "", /não é um JSON válido/);
  restringir("[1,2]");
  await s.subir("nova");
  assert.equal(s.estado.statusReason, "runner:restricao-conta");
  assert.match(s.estado.error ?? "", /não é um objeto/);
});

test("restricoes.json com tudo desligado não conta como restrição", async () => {
  restringir('{"versao":1,"sem_bash":false,"sem_enviar_arquivo":false,"escrita_so_em":null}');
  assert.deepEqual(lerRestricoes(ARQ_RESTRICOES), { ativa: false });
  process.env.FAKE_CLAUDE_STATUS = CONTA_DE_ORG + "\n";
  const s = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "abrir com tudo desligado");
});

test("depois do login: conta de organização derruba a sessão aberta; conta pessoal deixa", async () => {
  restringir(COM_TRAVA);
  const s = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "abrir");
  s.aposLoginConcluido();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.estado.status, "idle", "conta pessoal: nada muda");

  process.env.FAKE_CLAUDE_STATUS = CONTA_DE_ORG + "\n";
  s.aposLoginConcluido();
  await esperarAte(() => s.estado.statusReason === "runner:restricao-conta", 8_000, "recusar depois do login");
  assert.equal(s.temPtyVivo(), false);
  assert.equal(s.estado.status, "errored");

  // Reconectou uma conta pessoal: o login concluído tenta de novo e a sessão volta.
  process.env.FAKE_CLAUDE_STATUS = CONTA_PESSOAL + "\n";
  s.aposLoginConcluido();
  await esperarAte(() => s.estado.status === "idle", 12_000, "voltar com conta pessoal");
});

test("classificação da conta: a mesma regra da CLI", () => {
  const c = classificarSaidaDaConta;
  assert.equal(c('{"loggedIn":false,"authMethod":"none"}'), "sem");
  assert.equal(c('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"Enterprise"}'), "com");
  assert.equal(c('{"loggedIn":true,"authMethod":"claude.ai"}'), "duvida");
  assert.equal(c('{"loggedIn":true,"authMethod":"api_key"}'), "sem");
  assert.equal(c('{"loggedIn":true}'), "duvida");
  assert.equal(c("[]"), "duvida");
  assert.equal(c(""), "duvida");
});
