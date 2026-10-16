import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("canais");
const { lerCanais, limparCacheNeedsAuth, pastaTelegramDesligado, arquivoDeCanais } = await import("./provedores/canais.js");

function casaComCanais(conteudo: unknown): string {
  const casa = pastaTemporaria("casa-canais");
  fs.mkdirSync(path.join(casa, ".dgclaw"), { recursive: true });
  if (conteudo !== undefined) fs.writeFileSync(arquivoDeCanais(casa), typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo));
  return casa;
}

test("sem canais.json o Telegram está desligado, sem erro", () => {
  const antes = lerTexto(amb.logDoRunner).length;
  assert.deepEqual(lerCanais(casaComCanais(undefined)), { telegram: { ligado: false, estadoDir: null } });
  assert.equal(lerTexto(amb.logDoRunner).length, antes, "arquivo ausente não gera log de erro");
});

test("ligado com estado_dir dentro de .dgclaw: liga (mesmo se a pasta ainda não existe)", () => {
  const casa = casaComCanais(undefined);
  const estado = path.join(casa, ".dgclaw", "telegram");
  fs.writeFileSync(arquivoDeCanais(casa), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: estado } }));
  const r = lerCanais(casa);
  assert.equal(r.telegram.ligado, true);
  assert.equal(r.telegram.estadoDir, fs.realpathSync(path.join(casa, ".dgclaw")) + "/telegram");
});

test("estado_dir fora de .dgclaw, ou por symlink, desliga e loga o caminho recebido e o motivo", () => {
  const casa = casaComCanais(undefined);
  const fora = pastaTemporaria("fora");
  fs.writeFileSync(arquivoDeCanais(casa), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: fora } }));
  assert.equal(lerCanais(casa).telegram.ligado, false);
  assert.match(lerTexto(amb.logDoRunner), new RegExp(`estado_dir '${fora}'.*FORA de`));

  fs.symlinkSync(fora, path.join(casa, ".dgclaw", "atalho"));
  fs.writeFileSync(arquivoDeCanais(casa), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: path.join(casa, ".dgclaw", "atalho") } }));
  const r = lerCanais(casa);
  assert.equal(r.telegram.ligado, false, "symlink que sai de .dgclaw é recusado");
  assert.equal(r.telegram.estadoDir, null);

  fs.writeFileSync(arquivoDeCanais(casa), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: path.join(casa, ".dgclaw", "..", "..", "etc") } }));
  assert.equal(lerCanais(casa).telegram.ligado, false, "caminho com .. também");
});

test("JSON quebrado ou tipo errado: desligado e uma linha de log com o caminho e o erro", () => {
  const casa = casaComCanais("{ nao e json");
  assert.equal(lerCanais(casa).telegram.ligado, false);
  assert.match(lerTexto(amb.logDoRunner), new RegExp(`${arquivoDeCanais(casa)} não é um JSON válido`));
  const tipo = casaComCanais({ versao: 1, telegram: { ligado: "sim", estado_dir: 5 } });
  assert.equal(lerCanais(tipo).telegram.ligado, false);
  assert.match(lerTexto(amb.logDoRunner), /telegram\.ligado precisa ser true\/false/);
});

test("campo desconhecido é ignorado com aviso que diz o nome do campo", () => {
  const casa = casaComCanais(undefined);
  fs.writeFileSync(
    arquivoDeCanais(casa),
    JSON.stringify({ versao: 1, comando: "rm -rf /", telegram: { ligado: false, porta: 1, executavel: "/bin/x" } }),
  );
  assert.equal(lerCanais(casa).telegram.ligado, false);
  const log = lerTexto(amb.logDoRunner);
  assert.match(log, /campo desconhecido 'comando'/);
  assert.match(log, /campo desconhecido 'telegram\.porta'/);
  assert.match(log, /campo desconhecido 'telegram\.executavel'/);
});

test("a pasta do Telegram desligado é criada vazia dentro de .dgclaw", () => {
  const casa = pastaTemporaria("casa-desligado");
  const p = pastaTelegramDesligado(casa);
  assert.equal(p, path.join(casa, ".dgclaw", "telegram-desligado"));
  assert.deepEqual(fs.readdirSync(p), []);
});

test("cache de needs-auth: tira só a chave do Telegram, atômico; ausente ou sem a chave não faz nada", () => {
  const dir = pastaTemporaria("needs-auth");
  assert.equal(limparCacheNeedsAuth(dir), false, "arquivo ausente");
  const arq = path.join(dir, "mcp-needs-auth-cache.json");
  fs.writeFileSync(arq, JSON.stringify({ "outro:mcp": { timestamp: 1 } }), { mode: 0o644 });
  assert.equal(limparCacheNeedsAuth(dir), false, "sem a chave");
  fs.writeFileSync(arq, JSON.stringify({ "plugin:telegram:telegram": { timestamp: 2 }, "outro:mcp": { timestamp: 1 } }), { mode: 0o644 });
  fs.chmodSync(arq, 0o644);
  assert.equal(limparCacheNeedsAuth(dir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, "utf8")), { "outro:mcp": { timestamp: 1 } });
  assert.equal(fs.statSync(arq).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(dir), ["mcp-needs-auth-cache.json"]);
});
