// O motor do Codex CLI (OpenAI).
//
// Porta, para o runner do DG Claw, do que o Bunker faz em `codex-cli.ts`. O que o
// Codex tem de diferente do Claude Code, e que este arquivo absorve:
//   - o id da sessão não pode ser pré-fixado: é DESCOBERTO no rollout depois do spawn;
//   - retomar é subcomando (`codex resume <uuid>`), não flag;
//   - não há `--settings` com hooks: o status vem do `notify` e do rollout;
//   - MCP e identidade entram por `-c`; a confiança de pasta também vai por `-c`, mas o Codex 0.162
//     a ignora na tela de confiança, então `garantirConfiancaDaPasta` grava a seção no config.toml;
//   - na API, a chave vai para um CODEX_HOME separado por `codex login --with-api-key`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { CODEX_NOTIFY_SOURCE } from "./codex-notify-source.js";
import { prepararMcpDoCodex } from "./mcp-codex.js";
import { recusaDeChave, ErroDeMotor, type CtxMotor, type Motor, type Recusa } from "./motor.js";
import { dicaDeLogin } from "./claude.js";

/** Um argumento de linha de comando no Linux aceita no máximo 128 KB (MAX_ARG_STRLEN). */
const LIMITE_DA_IDENTIDADE_BYTES = 120_000;
const TEMPO_DO_LOGIN_POR_CHAVE_MS = 30_000;

type ModoDePermissao = CtxMotor["config"]["permissionMode"];

/**
 * O `permissionMode` do descritor traduzido para a política de aprovação do Codex.
 * O painel guarda UM conceito de autonomia e cada CLI recebe o dialeto dele.
 *
 *   auto             -> --ask-for-approval on-request   (o modelo decide se pergunta)
 *   default          -> --ask-for-approval untrusted    (só comando confiável passa)
 *   acceptEdits      -> --ask-for-approval on-request   (sem equivalente exato)
 *   bypassPermissions-> --dangerously-bypass-approvals-and-sandbox
 *
 * Testado em 12/10/2026: o Codex 0.162 aceita o flag de bypass rodando como root (ao
 * contrário do Claude, que o recusa e por isso usa `--permission-mode`).
 */
export function argsDeAprovacao(modo: ModoDePermissao): string[] {
  switch (modo) {
    case "bypassPermissions":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "default":
      return ["--ask-for-approval", "untrusted"];
    default:
      return ["--ask-for-approval", "on-request"];
  }
}

/**
 * O CODEX_HOME desta sessão.
 *   assinatura: envExtra.CODEX_HOME > process.env.CODEX_HOME (o `env` já traz os dois, nessa
 *               ordem) > $HOME/.codex, que é o volume persistente do container;
 *   api:        uma pasta por sessão em `<casa>/.plataforma/codex-api/<id>`, para a conta da
 *               API nunca se misturar com a da assinatura.
 */
export function codexHomeDe(p: { auth: string; env: Record<string, string>; cwd: string; id: string }): string {
  if (p.auth === "api") return path.join(p.cwd, ".plataforma", "codex-api", p.id);
  return p.env.CODEX_HOME?.trim() || path.join(p.env.HOME?.trim() || os.homedir(), ".codex");
}

export function shaDaChave(chave: string): string {
  return createHash("sha256").update(chave).digest("hex");
}

/**
 * Registra a chave de API no `auth.json` do CODEX_HOME da sessão, SÓ quando falta ou
 * mudou (compara o sha256 com o de `.dgclaw-chave.sha256`). A chave entra pelo stdin: nunca
 * pelo argv, que qualquer um na máquina lê, e nunca por shell. A saída do `codex login` pode
 * trazer um pedaço da chave, então ela é descartada sem ser lida nem guardada.
 */
export async function registrarChaveNoCodex(opts: {
  chave: string;
  home: string;
  env: Record<string, string>;
  area: string;
}): Promise<void> {
  const { chave, home } = opts;
  const authJson = path.join(home, "auth.json");
  const marca = path.join(home, ".dgclaw-chave.sha256");
  const sha = shaDaChave(chave);
  let gravado = "";
  try {
    gravado = fs.readFileSync(marca, "utf8").trim();
  } catch {
    /* nunca registrada: segue para o login */
  }
  if (fs.existsSync(authJson) && gravado === sha) return;

  const env: Record<string, string> = { ...opts.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY; // o login lê do stdin; não há motivo para a chave estar também no ambiente do filho
  const codigo = await new Promise<number | string>((resolve) => {
    const filho = spawn("codex", ["login", "--with-api-key"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const prazo = setTimeout(() => {
      filho.kill("SIGKILL");
      resolve("tempo");
    }, TEMPO_DO_LOGIN_POR_CHAVE_MS);
    filho.stdout.resume();
    filho.stderr.resume();
    filho.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(prazo);
      resolve(err.code === "ENOENT" ? "sem-binario" : `erro ${err.code ?? "desconhecido"}`);
    });
    filho.on("close", (c) => {
      clearTimeout(prazo);
      resolve(c ?? "sinal");
    });
    filho.stdin.on("error", () => undefined); // o filho pode sair antes de ler: o código de saída diz o que houve
    filho.stdin.end(chave);
  });
  if (codigo !== 0) {
    log.erro(
      opts.area,
      `o 'codex login --with-api-key' não concluiu (resultado: ${codigo})`,
      "a saída dele é descartada de propósito (pode ter pedaço da chave); conferir se a chave OPENAI_API_KEY do Cofre é válida e se o 'codex' está no PATH",
    );
    throw new ErroDeMotor(
      `Não consegui registrar a chave de API no Codex (resultado do 'codex login --with-api-key': ${codigo}). ` +
        `A saída do comando não é mostrada porque pode conter parte da chave.`,
      "runner:login-por-chave-falhou",
      "conferir no Cofre do painel se a OPENAI_API_KEY está correta, ou trocar a forma de pagar deste agente para a assinatura",
    );
  }
  fs.writeFileSync(marca, sha + "\n", { mode: 0o600 });
  fs.chmodSync(marca, 0o600);
  log.info(opts.area, `chave de API registrada no Codex (${home})`);
}

/**
 * Garante `[projects."<cwd>"]` com `trust_level = "trusted"` no config.toml do CODEX_HOME, do jeito
 * que o próprio Codex grava quando a pessoa escolhe "Trust and continue".
 *
 * Por que: no teste B6 (12/10/2026) o Codex 0.162.1 ignorou o `-c projects...trust_level` e abriu a
 * tela "Trust this folder?". O primeiro texto do dono ("<dgchat ...>") era digitado nela, o "2"
 * escolhia Quit e o Codex saía com código 0. Só ACRESCENTA no fim e só quando a seção não existe
 * (com qualquer conteúdo): o resto do arquivo não é reescrito nem reordenado.
 * Falhar aqui não derruba o spawn: o pior caso é a tela de confiança aparecer.
 */
export function garantirConfiancaDaPasta(home: string, cwd: string, area: string): void {
  const arquivo = path.join(home, "config.toml");
  const cabecalho = `[projects.${JSON.stringify(cwd)}]`;
  try {
    let atual = "";
    let modo = 0o600;
    try {
      atual = fs.readFileSync(arquivo, "utf8");
      modo = fs.statSync(arquivo).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (atual.split(/\r?\n/).some((l) => l.trim() === cabecalho)) return;
    const separador = atual === "" || atual.endsWith("\n\n") ? "" : atual.endsWith("\n") ? "\n" : "\n\n";
    const novo = `${atual}${separador}${cabecalho}\ntrust_level = "trusted"\n`;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const temporario = path.join(home, `.config.toml.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporario, novo, { mode: modo });
      fs.chmodSync(temporario, modo);
      fs.renameSync(temporario, arquivo);
    } catch (err) {
      fs.rmSync(temporario, { force: true });
      throw err;
    }
  } catch (err) {
    log.aviso(
      area,
      `não consegui gravar a confiança da pasta ${cwd} em ${arquivo}: ${err instanceof Error ? err.message : String(err)}. ` +
        `O Codex vai abrir perguntando se confia na pasta; responda 1 no terminal do painel. ` +
        `Para evitar, conferir a permissão de escrita em ${home}`,
    );
  }
}

/**
 * Apaga o que o shell snapshot do Codex deixou em CODEX_HOME/shell_snapshots antes do
 * `features.shell_snapshot=false`: cada arquivo é um `declare -x` do ambiente inteiro, com as
 * chaves do cofre. Não segue link (nem a pasta, nem os arquivos) e não desce em subpasta.
 * Devolve quantos apagou.
 */
export function apagarSnapshotsAntigos(home: string, area: string): number {
  const pasta = path.join(home, "shell_snapshots");
  let apagados = 0;
  try {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(pasta);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    if (!st.isDirectory()) {
      log.aviso(area, `${pasta} não é uma pasta (é ${st.isSymbolicLink() ? "um atalho" : "um arquivo"}): não mexi. Conferir à mão quem criou`);
      return 0;
    }
    for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      fs.unlinkSync(path.join(pasta, e.name)); // unlink num atalho apaga o atalho, nunca o alvo
      apagados++;
    }
  } catch (err) {
    log.aviso(
      area,
      `não consegui apagar os snapshots antigos do Codex em ${pasta} (apaguei ${apagados} antes do erro): ` +
        `${err instanceof Error ? err.message : String(err)}. Eles podem conter as chaves do cofre; ` +
        `conferir a permissão de escrita em ${pasta} e apagar os arquivos de lá à mão`,
    );
    return apagados;
  }
  if (apagados) log.info(area, `apaguei ${apagados} snapshot(s) antigo(s) do shell do Codex em ${pasta} (guardavam o ambiente, com as chaves)`);
  return apagados;
}

function avisarIgnorados(ctx: CtxMotor): void {
  const cfg = ctx.config;
  const ignorados: string[] = [];
  if ((cfg.stopHooks ?? []).length) ignorados.push("stopHooks");
  if ((cfg.promptHooks ?? []).length) ignorados.push("promptHooks");
  if ([cfg.allowTools, cfg.askTools, cfg.denyTools].some((l) => (l ?? []).length)) ignorados.push("allowTools/askTools/denyTools");
  if ((cfg.extraArgs ?? []).length) ignorados.push("extraArgs (são flags do Claude)");
  if (ctx.canalTelegram) ignorados.push("--channels");
  if (!ignorados.length) return;
  log.aviso(
    ctx.a("spawn"),
    `este agente usa o Codex, que não tem hooks por --settings, regras de permissão por ferramenta nem canais: ` +
      `ignorei ${ignorados.join(", ")}. Nada quebra, mas o que dependia disso não acontece neste motor`,
  );
}

function argsComuns(ctx: CtxMotor): string[] {
  return [
    ...argsDeAprovacao(ctx.config.permissionMode),
    "-c",
    `projects.${JSON.stringify(ctx.cwd)}.trust_level="trusted"`,
    ...(ctx.escolha.modelo ? ["-m", ctx.escolha.modelo] : []),
    // Sem isto, quando sai versão nova o Codex abre a tela "atualizar agora?" na partida, e o
    // Enter da primeira mensagem escolhe atualizar e encerra o Codex (B6, 12/10: saída 0 no 1º turno).
    "-c",
    "check_for_update_on_startup=false",
    // O shell snapshot grava `declare -x` de todo o ambiente em CODEX_HOME/shell_snapshots (644),
    // e as chaves do cofre estão no ambiente: iam parar em disco e no backup da casa (B6, 12/10).
    "-c",
    "features.shell_snapshot=false",
    ...ctx.extrasDoMotor,
  ];
}

export const motorCodex: Motor = {
  provedor: "codex",
  binario: "codex",
  usaHooks: false,
  pausaAntesDoEnterMs: 500,
  reciboMs: 3_000,
  reciboPorRollout: true,

  argsNova(ctx) {
    return argsComuns(ctx);
  },

  argsRetomar(ctx, sessionId) {
    return ["resume", sessionId, ...argsComuns(ctx)];
  },

  async preparar(ctx) {
    const home = codexHomeDe({ auth: ctx.escolha.auth, env: ctx.env, cwd: ctx.cwd, id: ctx.id });
    ctx.env.CODEX_HOME = home;
    ctx.extrasDoMotor = [];

    if (ctx.escolha.auth === "api") {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.chmodSync(home, 0o700);
      const chave = ctx.env[ctx.variavelDoModo ?? "OPENAI_API_KEY"];
      if (chave) {
        await registrarChaveNoCodex({ chave, home, env: ctx.env, area: ctx.a("spawn") });
      }
      // A OPENAI_API_KEY continua no ambiente da sessão: ela veio do cofre, e as ferramentas
      // do agente (gerar imagem, por exemplo) podem precisar dela. O Codex lê do auth.json.
    }

    garantirConfiancaDaPasta(home, ctx.cwd, ctx.a("spawn"));
    apagarSnapshotsAntigos(home, ctx.a("spawn"));

    const mcp = ctx.config.mcpConfig?.trim();
    if (mcp) {
      const m = prepararMcpDoCodex({
        mcpConfig: mcp,
        cwd: ctx.cwd,
        env: ctx.env,
        idDaSessao: ctx.id,
        pastaDeHooks: ctx.pastaDeHooks,
        tag: ctx.nonce.slice(0, 12),
        area: ctx.a("spawn"),
      });
      ctx.limpezas.push(m.limpar);
      ctx.extrasDoMotor.push(...m.args);
    }

    if (ctx.identidade.texto) {
      const valor = JSON.stringify(ctx.identidade.texto);
      const bytes = Buffer.byteLength(valor);
      if (bytes > LIMITE_DA_IDENTIDADE_BYTES) {
        throw new ErroDeMotor(
          `A identidade deste agente (${ctx.identidade.arquivo ?? "arquivos de identidade"}) tem ${Buffer.byteLength(ctx.identidade.texto)} ` +
            `bytes (${bytes} depois de escapada), acima do limite de ${LIMITE_DA_IDENTIDADE_BYTES}. O Codex recebe a identidade num ` +
            `argumento de linha de comando, e o Linux aceita no máximo 128 KB por argumento. Não vou cortar o texto em silêncio.`,
          "runner:identidade-grande",
          "encurtar o arquivo de identidade (mover o que é consulta para a memória do agente) ou usar o Claude como provedor",
        );
      }
      ctx.extrasDoMotor.push("-c", `developer_instructions=${valor}`);
    }

    fs.mkdirSync(ctx.pastaDeHooks, { recursive: true });
    const handler = path.join(ctx.pastaDeHooks, "runner-codex-notify.mjs");
    const atual = fs.existsSync(handler) ? fs.readFileSync(handler, "utf8") : "";
    if (atual !== CODEX_NOTIFY_SOURCE) fs.writeFileSync(handler, CODEX_NOTIFY_SOURCE, "utf8");
    const notify = [process.execPath, handler, "--agent", ctx.id, "--port", String(ctx.porta), "--nonce", ctx.nonce];
    ctx.extrasDoMotor.push("-c", `notify=${JSON.stringify(notify)}`);

    avisarIgnorados(ctx);
  },

  motivoSemLogin(ctx): Recusa | null {
    if (ctx.escolha.auth === "api") {
      return ctx.chaveDoModoPresente ? null : recusaDeChave(ctx, "Codex");
    }
    const home = codexHomeDe({ auth: ctx.escolha.auth, env: ctx.env, cwd: ctx.cwd, id: ctx.id });
    const credencial = path.join(home, "auth.json");
    try {
      if (fs.statSync(credencial).size > 0) return null;
    } catch {
      /* não existe: é o caso que este método serve para nomear */
    }
    return {
      tipo: "login",
      mensagem:
        `O agente ${ctx.slug} ainda não entrou no Codex: não achei ${credencial}. ` +
        `Enquanto isso ele não responde nada, e a mensagem de quem escrever se perde na tela de login. ` +
        `O que fazer: usar o login assistido do painel (POST /api/provedor/login) ou rodar ` +
        `"CODEX_HOME=${home} codex login --device-auth", e o runner sobe sozinho assim que a credencial aparecer.` +
        dicaDeLogin(),
      comoResolver: "fazer o login da conta do ChatGPT deste agente pelo painel (Provedor do agente)",
    };
  },
};
