import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  carregarTokenDoRunner,
  conferirTokenWs,
  exigirTokenDoRunner,
  rotaLivre,
  tokensIguais,
  verificarClienteWs,
} from "./autenticacao.js";

// Gerados a cada execução: nenhum valor fixo com cara de segredo fica no arquivo.
const CERTO = crypto.randomBytes(32).toString("hex");
const ERRADO = crypto.randomBytes(32).toString("hex");

let pasta: string;
before(() => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), "runner-auth-"));
});
after(() => {
  fs.rmSync(pasta, { recursive: true, force: true });
});

/** Captura o que o logger escreve em console.log e console.error durante `fn`. */
async function capturarLog<T>(fn: () => Promise<T> | T): Promise<{ resultado: T; linhas: string[] }> {
  const linhas: string[] = [];
  const log0 = console.log;
  const erro0 = console.error;
  console.log = (...a: unknown[]) => void linhas.push(a.join(" "));
  console.error = (...a: unknown[]) => void linhas.push(a.join(" "));
  try {
    return { resultado: await fn(), linhas };
  } finally {
    console.log = log0;
    console.error = erro0;
  }
}

function arquivoDeToken(nome: string, conteudo: string, modo: number): string {
  const caminho = path.join(pasta, nome);
  fs.writeFileSync(caminho, conteudo);
  fs.chmodSync(caminho, modo);
  return caminho;
}

describe("carregarTokenDoRunner", () => {
  it("sem a variável: token null e motivo claro", async () => {
    const { resultado, linhas } = await capturarLog(() => carregarTokenDoRunner({}));
    assert.equal(resultado.token, null);
    assert.equal(resultado.motivo, "RUNNER_TOKEN_FILE não está definida");
    assert.ok(linhas.some((l) => l.includes("ERRO") && l.includes("openssl rand -hex 32")));
  });

  it("variável vazia conta como ausente", async () => {
    const { resultado } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: "  " }));
    assert.equal(resultado.token, null);
  });

  it("arquivo inexistente: motivo com caminho e ENOENT", async () => {
    const caminho = path.join(pasta, "nao-existe");
    const { resultado } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: caminho }));
    assert.equal(resultado.token, null);
    assert.ok(resultado.motivo?.includes(caminho));
    assert.ok(resultado.motivo?.includes("ENOENT"));
  });

  it("arquivo curto: recusa sem mostrar o conteúdo", async () => {
    const caminho = arquivoDeToken("curto", "conteudo-curto\n", 0o600);
    const { resultado, linhas } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: caminho }));
    assert.equal(resultado.token, null);
    assert.ok(resultado.motivo?.includes("32"));
    assert.ok(!resultado.motivo?.includes("conteudo-curto"));
    assert.ok(!linhas.join("\n").includes("conteudo-curto"));
  });

  it("arquivo com quebra de linha no meio: recusa", async () => {
    const caminho = arquivoDeToken("quebra", `${CERTO.slice(0, 40)}\n${CERTO.slice(40)}\n`, 0o600);
    const { resultado } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: caminho }));
    assert.equal(resultado.token, null);
    assert.ok(resultado.motivo);
  });

  it("arquivo 644: aceita, mas avisa com o chmod 600", async () => {
    const caminho = arquivoDeToken("aberto", CERTO + "\n", 0o644);
    const { resultado, linhas } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: caminho }));
    assert.ok(resultado.token);
    assert.equal(resultado.token.toString("utf8"), CERTO);
    const avisos = linhas.filter((l) => l.includes("AVISO"));
    assert.equal(avisos.length, 1);
    assert.ok(avisos[0].includes(`chmod 600 ${caminho}`));
    assert.ok(!linhas.join("\n").includes(CERTO));
  });

  it("arquivo bom 600: aceita sem aviso nem erro", async () => {
    const caminho = arquivoDeToken("bom", CERTO + "\n", 0o600);
    const { resultado, linhas } = await capturarLog(() => carregarTokenDoRunner({ RUNNER_TOKEN_FILE: caminho }));
    assert.equal(resultado.motivo, null);
    assert.equal(resultado.token?.toString("utf8"), CERTO);
    assert.deepEqual(linhas, []);
  });
});

describe("rotaLivre e tokensIguais", () => {
  it("só as três rotas, só nos métodos certos", () => {
    assert.equal(rotaLivre("/api/saude", "GET"), true);
    assert.equal(rotaLivre("/saude", "GET"), true);
    assert.equal(rotaLivre("/api/agent-hook", "POST"), true);
    assert.equal(rotaLivre("/api/saude", "POST"), false);
    assert.equal(rotaLivre("/api/agent-hook", "GET"), false);
    assert.equal(rotaLivre("/api/agents", "GET"), false);
    assert.equal(rotaLivre("/", "GET"), false);
  });

  it("tokensIguais não lança com tamanhos diferentes", () => {
    const certo = Buffer.from(CERTO);
    assert.equal(tokensIguais(CERTO, certo), true);
    assert.equal(tokensIguais("curto", certo), false);
    assert.equal(tokensIguais(CERTO + "x", certo), false);
    assert.equal(tokensIguais("", certo), false);
  });
});

type Resposta = { status: number; cabecalhos: http.IncomingHttpHeaders; corpo: any };

function chamar(porta: number, metodo: string, caminho: string, cabecalhos: http.OutgoingHttpHeaders = {}): Promise<Resposta> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: porta, method: metodo, path: caminho, headers: cabecalhos }, (res) => {
      let texto = "";
      res.on("data", (c) => (texto += c));
      res.on("end", () => {
        let corpo: any = texto;
        try {
          corpo = JSON.parse(texto);
        } catch {
          /* corpo não JSON: devolve o texto */
        }
        resolve({ status: res.statusCode || 0, cabecalhos: res.headers, corpo });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sobe servidor HTTP com o guarda no topo e um WebSocketServer com verifyClient. */
async function subir(token: Buffer | null) {
  const guarda = exigirTokenDoRunner({ token });
  const servidor = http.createServer((req, res) => {
    if (!guarda(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const wss = new WebSocketServer({ server: servidor, path: "/ws", verifyClient: verificarClienteWs({ token }) });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const porta = (servidor.address() as AddressInfo).port;
  const fechar = () =>
    new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => servidor.close(() => r()));
      servidor.closeAllConnections();
    });
  return { porta, fechar };
}

describe("HTTP com token configurado", () => {
  let porta = 0;
  let fechar: () => Promise<void>;
  before(async () => {
    ({ porta, fechar } = await subir(Buffer.from(CERTO)));
  });
  after(() => fechar());

  const auth = (v: string) => ({ Authorization: v });

  it("rotas livres passam sem token", async () => {
    assert.equal((await chamar(porta, "GET", "/api/saude")).status, 200);
    assert.equal((await chamar(porta, "GET", "/api/saude/")).status, 200);
    assert.equal((await chamar(porta, "GET", "/saude")).status, 200);
    assert.equal((await chamar(porta, "POST", "/api/agent-hook")).status, 200);
  });

  it("POST /api/saude exige token", async () => {
    const r = await chamar(porta, "POST", "/api/saude");
    assert.equal(r.status, 401);
    assert.equal(r.corpo.code, "SEM_TOKEN");
  });

  it("sem cabeçalho: 401 SEM_TOKEN com WWW-Authenticate e formato padrão", async () => {
    const r = await chamar(porta, "GET", "/api/agents");
    assert.equal(r.status, 401);
    assert.equal(r.corpo.success, false);
    assert.equal(r.corpo.code, "SEM_TOKEN");
    assert.ok(r.corpo.howToFix.includes("RUNNER_TOKEN_FILE"));
    assert.equal(r.cabecalhos["www-authenticate"], "Bearer");
  });

  it("token errado: 401 TOKEN_ERRADO", async () => {
    const r = await chamar(porta, "GET", "/api/agents", auth(`Bearer ${ERRADO}`));
    assert.equal(r.status, 401);
    assert.equal(r.corpo.code, "TOKEN_ERRADO");
    assert.equal(r.cabecalhos["www-authenticate"], "Bearer");
  });

  it("token de tamanho diferente: 401 sem exceção", async () => {
    const r = await chamar(porta, "GET", "/api/agents", auth("Bearer x"));
    assert.equal(r.status, 401);
    assert.equal(r.corpo.code, "TOKEN_ERRADO");
  });

  it("cabeçalho que não é Bearer: 401 TOKEN_ERRADO", async () => {
    assert.equal((await chamar(porta, "GET", "/api/agents", auth(`Basic ${CERTO}`))).corpo.code, "TOKEN_ERRADO");
    assert.equal((await chamar(porta, "GET", "/api/agents", auth(CERTO))).corpo.code, "TOKEN_ERRADO");
  });

  it("'bearer' minúsculo é aceito", async () => {
    assert.equal((await chamar(porta, "GET", "/api/agents", auth(`bearer ${CERTO}`))).status, 200);
  });

  it("token certo passa", async () => {
    assert.equal((await chamar(porta, "GET", "/api/agents", auth(`Bearer ${CERTO}`))).status, 200);
  });

  it("?token= certo em HTTP NÃO passa", async () => {
    const r = await chamar(porta, "GET", `/api/agents?token=${CERTO}`);
    assert.equal(r.status, 401);
    assert.equal(r.corpo.code, "SEM_TOKEN");
  });
});

describe("HTTP com o runner sem token", () => {
  let porta = 0;
  let fechar: () => Promise<void>;
  before(async () => {
    ({ porta, fechar } = await subir(null));
  });
  after(() => fechar());

  it("tudo 401 RUNNER_SEM_TOKEN, menos as livres", async () => {
    const r = await chamar(porta, "GET", "/api/agents", { Authorization: `Bearer ${CERTO}` });
    assert.equal(r.status, 401);
    assert.equal(r.corpo.code, "RUNNER_SEM_TOKEN");
    assert.equal(r.cabecalhos["www-authenticate"], "Bearer");
    assert.equal((await chamar(porta, "GET", "/api/saude")).status, 200);
    assert.equal((await chamar(porta, "POST", "/api/agent-hook")).status, 200);
  });
});

describe("WebSocket", () => {
  let porta = 0;
  let fechar: () => Promise<void>;
  before(async () => {
    ({ porta, fechar } = await subir(Buffer.from(CERTO)));
  });
  after(() => fechar());

  function conectar(url: string, headers?: Record<string, string>): Promise<"abriu" | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.on("open", () => {
        ws.close();
        resolve("abriu");
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      ws.on("error", () => {
        /* o resultado sai por unexpected-response */
      });
    });
  }

  it("sem token: recusa com 401 no handshake", async () => {
    assert.equal(await conectar(`ws://127.0.0.1:${porta}/ws`), 401);
  });
  it("?token= certo conecta", async () => {
    assert.equal(await conectar(`ws://127.0.0.1:${porta}/ws?token=${CERTO}`), "abriu");
  });
  it("Authorization certo conecta", async () => {
    assert.equal(await conectar(`ws://127.0.0.1:${porta}/ws`, { Authorization: `Bearer ${CERTO}` }), "abriu");
  });
  it("token errado recusa", async () => {
    assert.equal(await conectar(`ws://127.0.0.1:${porta}/ws?token=${ERRADO}`), 401);
    assert.equal(await conectar(`ws://127.0.0.1:${porta}/ws`, { Authorization: `Bearer ${ERRADO}` }), 401);
  });
  it("conferirTokenWs com token null sempre recusa", () => {
    const req = { url: `/ws?token=${CERTO}`, headers: {} } as http.IncomingMessage;
    assert.equal(conferirTokenWs(req, { token: null }), false);
  });
});

describe("log de recusa", () => {
  it("nunca mostra tokens nem URL com ?token=, e junta recusas iguais em uma linha", async () => {
    const { porta, fechar } = await subir(Buffer.from(CERTO));
    try {
      const { linhas } = await capturarLog(async () => {
        const h = { Authorization: `Bearer ${ERRADO}` };
        await chamar(porta, "GET", "/api/log-unico", h);
        await chamar(porta, "GET", "/api/log-unico", h);
        await chamar(porta, "GET", `/api/log-token?token=${ERRADO}`);
        await chamar(porta, "GET", "/api/log-ok", { Authorization: `Bearer ${CERTO}` });
      });
      const tudo = linhas.join("\n");
      assert.ok(!tudo.includes(CERTO), "token certo apareceu no log");
      assert.ok(!tudo.includes(ERRADO), "token enviado apareceu no log");
      assert.ok(!tudo.includes("?token"), "query string apareceu no log");
      assert.equal(linhas.filter((l) => l.includes("/api/log-unico")).length, 1);
      assert.equal(linhas.filter((l) => l.includes("/api/log-token")).length, 1);
      assert.equal(linhas.filter((l) => l.includes("/api/log-ok")).length, 0);
    } finally {
      await fechar();
    }
  });
});
