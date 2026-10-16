import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { carregarCatalogoDeTeste, pastaTemporaria } from "./apoio-teste.js";
import { gravarProvedorJson, lerProvedorJson, provedorDoVocabulario, resolverEscolha } from "./provedores/escolha.js";
import { carregar, rotulo, validar } from "./provedores/catalogo.js";

const catalogo = carregarCatalogoDeTeste();
const arquivoProvedor = () => path.join(pastaTemporaria("escolha"), "provedor.json");

test("sem nada configurado vale o padrão: Claude, assinatura, modelo padrão", () => {
  const r = resolverEscolha({ arquivoProvedor: arquivoProvedor(), catalogo });
  assert.deepEqual(r.escolha, { provedor: "claude", auth: "assinatura", modelo: "", origem: "padrao" });
  assert.deepEqual(r.problemas, []);
});

test("config do descritor vale quando não há nada acima (vocabulário do runner)", () => {
  const r = resolverEscolha({ arquivoProvedor: arquivoProvedor(), config: { provider: "codex-cli", auth: "api" }, catalogo });
  assert.equal(r.escolha.provedor, "codex");
  assert.equal(r.escolha.auth, "api");
  assert.equal(r.escolha.origem, "descritor");
});

test("a sessão paralela do descritor vence o config", () => {
  const r = resolverEscolha({
    arquivoProvedor: arquivoProvedor(),
    sessao: { provider: "claude", model: "sonnet" },
    config: { provider: "codex-cli" },
    catalogo,
  });
  assert.equal(r.escolha.provedor, "claude");
  assert.equal(r.escolha.modelo, "claude-sonnet-5-5", "o apelido vira o id canônico");
});

test("o provedor.json vence tudo, e é gravado atômico, no formato combinado e com modo 600", () => {
  const arq = arquivoProvedor();
  gravarProvedorJson(arq, { provedor: "codex", auth: "assinatura", modelo: "" });
  const gravado = JSON.parse(fs.readFileSync(arq, "utf8"));
  assert.deepEqual(Object.keys(gravado).sort(), ["auth", "em", "modelo", "provedor"]);
  assert.match(gravado.em, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(arq)), ["provedor.json"], "nenhum temporário sobra");
  const r = resolverEscolha({
    arquivoProvedor: arq,
    sessao: { provider: "claude" },
    config: { provider: "local-cli" },
    catalogo,
  });
  assert.equal(r.escolha.provedor, "codex");
  assert.equal(r.escolha.origem, "provedor.json");
});

test("escolha inválida é registrada e cai para o próximo nível, sem derrubar", () => {
  const arq = arquivoProvedor();
  // token só existe no Claude: o provedor.json pede token no Codex.
  fs.writeFileSync(arq, JSON.stringify({ provedor: "codex", auth: "token", modelo: "" }));
  const r = resolverEscolha({ arquivoProvedor: arq, config: { provider: "codex-cli", model: "gpt-5.5" }, catalogo, codexHome: pastaTemporaria("sem-cache") });
  assert.equal(r.escolha.origem, "descritor");
  assert.equal(r.escolha.modelo, "gpt-5.5");
  assert.equal(r.problemas.length, 1);
  assert.match(r.problemas[0].motivo, /Forma de pagar 'token' não existe para Codex/);
  assert.match(r.problemas[0].comoResolver, /próximo nível/);
});

test("modelo fora da lista, provedor indisponível e provedor desconhecido caem para o padrão", () => {
  const arq = arquivoProvedor();
  const casos: Array<[Record<string, string>, RegExp]> = [
    [{ provider: "claude", model: "gpt-5" }, /Modelo 'gpt-5' não existe para Claude/],
    [{ provider: "gemini" }, /Gemini CLI ainda não está disponível/],
    [{ provider: "llama" }, /não conhece/],
  ];
  for (const [config, esperado] of casos) {
    const r = resolverEscolha({ arquivoProvedor: arq, config, catalogo });
    assert.equal(r.escolha.origem, "padrao");
    assert.match(r.problemas.map((p) => p.motivo).join("\n"), esperado);
  }
});

test("provedor.json quebrado não derruba: avisa e usa o descritor", () => {
  const arq = arquivoProvedor();
  fs.writeFileSync(arq, "{ isto nao e json");
  const r = resolverEscolha({ arquivoProvedor: arq, config: { provider: "codex-cli" }, catalogo });
  assert.equal(r.escolha.provedor, "codex");
  assert.match(r.problemas[0].motivo, /não é um JSON válido/);
  assert.equal(lerProvedorJson(path.join(pastaTemporaria("x"), "nao-existe.json")).existe, false);
});

test("modelos do Codex vêm do models_cache.json do CODEX_HOME, com reserva no catálogo", () => {
  const home = pastaTemporaria("codexhome");
  fs.writeFileSync(
    path.join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-so-na-assinatura", display_name: "Só assinatura", visibility: "list", supported_in_api: false },
        { slug: "gpt-nos-dois", display_name: "Nos dois", visibility: "list", supported_in_api: true },
        { slug: "gpt-escondido", visibility: "hide", supported_in_api: true },
      ],
    }),
  );
  assert.equal(validar(catalogo, "codex", "assinatura", "gpt-so-na-assinatura", { codexHome: home }).modelo, "gpt-so-na-assinatura");
  assert.throws(() => validar(catalogo, "codex", "api", "gpt-so-na-assinatura", { codexHome: home }), /Os válidos: gpt-nos-dois/);
  assert.throws(() => validar(catalogo, "codex", "assinatura", "gpt-escondido", { codexHome: home }));
  // sem cache: vale a lista de reserva
  assert.equal(validar(catalogo, "codex", "assinatura", "gpt-5.5", { codexHome: pastaTemporaria("sem-cache") }).modelo, "gpt-5.5");
  assert.equal(rotulo(catalogo, "claude", "assinatura", "opus"), "Claude Opus 5.5, na assinatura");
  assert.equal(rotulo(catalogo, "codex", "api", ""), "Codex (modelo padrão), na API");
});

test("o catálogo ilegível deixa só o padrão possível, com o motivo", () => {
  const antes = process.env.DGCLAW_CATALOGO;
  process.env.DGCLAW_CATALOGO = path.join(pastaTemporaria("cat"), "nao-existe.json");
  try {
    const r = resolverEscolha({ arquivoProvedor: arquivoProvedor(), config: { provider: "codex-cli" } });
    assert.equal(r.escolha.provedor, "claude");
    assert.match(r.problemas[0].motivo, /Não consegui ler o catálogo/);
    assert.ok(r.catalogo.provedores.claude, "o runner devolve um catálogo mínimo para o agente subir");
  } finally {
    // Volta ao que estava: fora do repo (tests/rodar.sh) o catálogo vem por esta variável.
    if (antes === undefined) delete process.env.DGCLAW_CATALOGO;
    else process.env.DGCLAW_CATALOGO = antes;
  }
  assert.ok(carregar().provedores.codex.disponivel);
  assert.equal(provedorDoVocabulario("local-cli"), "claude");
  assert.equal(provedorDoVocabulario("codex-cli"), "codex");
});
