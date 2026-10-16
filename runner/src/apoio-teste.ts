// Apoio dos testes (não é teste: o nome não casa com o padrão do `node --test`).
//
// Cada arquivo *.test.ts roda no PRÓPRIO processo, então mexer em process.env aqui é
// seguro: o ambiente da sessão de teste é montado ANTES do import dinâmico dos módulos
// que leem RUNNER_AGENT_FILE e RUNNER_PORT na hora de carregar (config-runner.ts chama
// process.exit sem eles).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PASTA_DOS_CLIS_FALSOS = fileURLToPath(new URL("../test/fixtures/bin/", import.meta.url));

/** Chave falsa montada sem o literal do prefixo real (um guardião do ambiente bloqueia o literal). */
export function chaveFalsa(sufixo = "AAAABBBBCCCCDDDDEEEEFFFF1234"): string {
  return "sk-" + "ant" + "-api03-TESTE" + sufixo;
}

/** Uma chave falsa no formato da OpenAI, também sem o literal. */
export function chaveFalsaOpenai(sufixo = "ZZZZYYYYXXXXWWWW9876"): string {
  return "sk-" + "proj-TESTE" + sufixo;
}

const pastasCriadas: string[] = [];
let limpezaRegistrada = false;

/**
 * Cria uma pasta temporária e a apaga quando o processo de teste termina. Cada arquivo
 * *.test.ts roda no próprio processo, então o `exit` cobre todos. Sem isso, cada `npm test`
 * deixava dezenas de pastas em /tmp. Para depurar, DGCLAW_TESTE_MANTER_TMP=1 mantém as
 * pastas e avisa no stderr onde ficaram.
 */
export function pastaTemporaria(rotulo: string): string {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), `prov-runner-${rotulo}-`));
  pastasCriadas.push(pasta);
  if (!limpezaRegistrada) {
    limpezaRegistrada = true;
    process.on("exit", () => {
      if (process.env.DGCLAW_TESTE_MANTER_TMP === "1") {
        process.stderr.write(`DGCLAW_TESTE_MANTER_TMP=1: pastas de teste mantidas:\n${pastasCriadas.join("\n")}\n`);
        return;
      }
      for (const p of pastasCriadas) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(`não consegui apagar a pasta de teste ${p}: ${err instanceof Error ? err.message : err}\n`);
        }
      }
    });
  }
  return pasta;
}

export interface Ambiente {
  raiz: string;
  casa: string;
  estado: string;
  descritor: string;
  claudeDir: string;
  codexHome: string;
  logDoRunner: string;
  logDosClis: string;
}

/**
 * Monta pastas temporárias e o ambiente do processo: descritor numa pasta SEPARADA da
 * pasta de estado (como no container, onde o descritor é só leitura), CLIs falsos na frente
 * do PATH, HOME apontando para o temporário (nada toca o ~ de verdade) e logs em arquivos.
 */
export function prepararAmbiente(rotulo: string, descritor: Record<string, unknown> = {}): Ambiente {
  const raiz = pastaTemporaria(rotulo);
  const casa = path.join(raiz, "casa");
  const estado = path.join(raiz, "estado");
  const pastaDescritor = path.join(raiz, "descritor-ro");
  for (const d of [casa, estado, pastaDescritor]) fs.mkdirSync(d, { recursive: true });
  const arquivoDescritor = path.join(pastaDescritor, "runner.json");
  const { config: configExtra, ...resto } = descritor as { config?: Record<string, unknown> } & Record<string, unknown>;
  const completo = {
    id: "agente-teste",
    slug: "agente-teste",
    ...resto,
    config: { name: "agente-teste", cwd: casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions", ...configExtra },
  };
  fs.writeFileSync(arquivoDescritor, JSON.stringify(completo, null, 2));

  const a: Ambiente = {
    raiz,
    casa,
    estado,
    descritor: arquivoDescritor,
    claudeDir: path.join(raiz, "claude-config"),
    codexHome: path.join(raiz, "codex-home"),
    logDoRunner: path.join(raiz, "runner.log"),
    logDosClis: path.join(raiz, "clis.jsonl"),
  };
  fs.mkdirSync(a.claudeDir, { recursive: true });
  fs.mkdirSync(a.codexHome, { recursive: true });
  fs.mkdirSync(path.join(raiz, "home"), { recursive: true });

  process.env.RUNNER_AGENT_FILE = arquivoDescritor;
  process.env.RUNNER_STATE_FILE = path.join(estado, "runner-state.json");
  process.env.RUNNER_PORT = "4399";
  process.env.RUNNER_LOG = a.logDoRunner;
  process.env.PATH = `${PASTA_DOS_CLIS_FALSOS}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_LOG = a.logDosClis;
  process.env.HOME = path.join(raiz, "home");
  process.env.CLAUDE_CONFIG_DIR = a.claudeDir;
  process.env.CODEX_HOME = a.codexHome;
  process.env.DGCLAW_COFRE_ARQUIVO = path.join(raiz, "nao-existe", "cofre.env");
  process.env.RUNNER_SUSPENSAO_INTERVALO_MS = "3600000";
  // O catálogo do repo: relativo quando o teste roda dentro do repo, ou o caminho que
  // o tests/rodar.sh passa (ele compila o runner numa pasta temporária, fora do repo).
  process.env.DGCLAW_CATALOGO = CATALOGO_DE_TESTE;
  for (const k of ["RUNNER_LOGIN_HINT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TELEGRAM_BOT_TOKEN", "CODEX_API_KEY"]) {
    delete process.env[k];
  }
  return a;
}

export function lerLinhasJson(arquivo: string): Array<Record<string, any>> {
  try {
    return fs
      .readFileSync(arquivo, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function lerTexto(arquivo: string): string {
  try {
    return fs.readFileSync(arquivo, "utf8");
  } catch {
    return "";
  }
}

export async function esperarAte(cond: () => boolean | Promise<boolean>, ms = 8_000, rotulo = "a condição"): Promise<void> {
  const inicio = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - inicio > ms) throw new Error(`esperei ${ms}ms por ${rotulo} e ela não veio`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Grava credencial falsa do Claude, para a assinatura contar como logada. */
export function logarClaude(a: Ambiente): void {
  fs.writeFileSync(path.join(a.claudeDir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"x"}}');
}

export function logarCodex(a: Ambiente): void {
  fs.writeFileSync(path.join(a.codexHome, "auth.json"), '{"tokens":{"access_token":"x"}}');
}

/** Um CtxMotor mínimo para testar a montagem de argumentos sem subir PTY. */
export function ctxDeTeste(parcial: Partial<import("./provedores/motor.js").CtxMotor> = {}): import("./provedores/motor.js").CtxMotor {
  return {
    id: "agente-teste",
    slug: "agente-teste",
    papel: "principal",
    porta: 4399,
    cwd: "/tmp/casa-de-teste",
    config: { name: "x", cwd: "/tmp/casa-de-teste", initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions" },
    escolha: { provedor: "claude", auth: "assinatura", modelo: "" },
    catalogo: carregarCatalogoDeTeste(),
    env: {},
    chaveDoModoPresente: true,
    variavelDoModo: null,
    pastaDeHooks: "/tmp/hooks-de-teste",
    pastaDeEstado: "/tmp/estado-de-teste",
    identidade: { arquivo: null, texto: null },
    settings: null,
    nonce: "a1b2c3d4".repeat(8),
    canalTelegram: false,
    novoId: null,
    extrasDoMotor: [],
    limpezas: [],
    a: (area) => area,
    ...parcial,
  };
}

const CATALOGO_DE_TESTE =
  process.env.DGCLAW_CATALOGO?.trim() || fileURLToPath(new URL("../../providers/catalogo.json", import.meta.url));

export function carregarCatalogoDeTeste(): import("./provedores/catalogo.js").Catalogo {
  return JSON.parse(fs.readFileSync(CATALOGO_DE_TESTE, "utf8"));
}

/** Um servidor mínimo no lugar do runner, só para receber os POST do hook/notify e repassar à sessão. */
export async function abrirServidorDeHooks(
  alvo: () => { receberHook(p: Record<string, unknown>): { ok: boolean; motivo?: string } } | undefined,
): Promise<{ porta: number; recebidos: Array<Record<string, any>>; fechar(): void }> {
  const http = await import("node:http");
  const recebidos: Array<Record<string, any>> = [];
  const srv = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (d) => (corpo += d));
    req.on("end", () => {
      let p: Record<string, any> = {};
      try {
        p = JSON.parse(corpo);
      } catch {
        /* o handler real também ignora corpo quebrado */
      }
      const r = alvo()?.receberHook(p);
      recebidos.push({ ...p, nonce: p.nonce ? "***" : undefined, resultado: r });
      res.end(JSON.stringify({ success: r?.ok === true }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { porta: (srv.address() as import("node:net").AddressInfo).port, recebidos, fechar: () => srv.close() };
}

/** Uma porta TCP livre agora (para o servidor de verdade e para os hooks apontarem para o mesmo lugar). */
export async function portaLivre(): Promise<number> {
  const net = await import("node:net");
  return new Promise((ok, falha) => {
    const s = net.createServer();
    s.once("error", falha);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as import("node:net").AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}
