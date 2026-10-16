// O motor do Claude Code.
//
// Mantém o contrato de sempre (`--session-id`/`--resume`, `--permission-mode`, o
// `--settings` por spawn com os hooks de status, a fila de colagem) e acrescenta o
// que a escolha de provedor pede: `--model`, a identidade por arquivo, a
// pré-aprovação da chave no modo API e o canal Telegram da principal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { gravarJsonAtomico } from "./arquivos.js";
import { CANAL_TELEGRAM, limparCacheNeedsAuth } from "./canais.js";
import { recusaDeChave, ErroDeMotor, type CtxMotor, type Motor, type Recusa } from "./motor.js";

/**
 * `bypassPermissions` sai como `--permission-mode bypassPermissions`, e NÃO como
 * `--dangerously-skip-permissions`, que é o que estava aqui até 24/08/2026.
 *
 * O motivo é concreto: o runner roda como root, e o CLI recusa aquele flag com
 * "dangerously-skip-permissions cannot be used with root/sudo privileges for
 * security reasons". Ele não avisa nada e não pede nada: sai. Como quem morre em
 * 2 segundos aqui é o PTY e não o serviço, o `Restart=always` não pega, e o
 * agente entraria em ciclo de subir e cair sem ninguém entender por quê.
 *
 * O `--permission-mode bypassPermissions` faz a mesma coisa, é aceito como root,
 * e é exatamente o que o agente de canal mais antigo desta máquina usa desde
 * sempre.
 */
export function argsDePermissao(modo: CtxMotor["config"]["permissionMode"]): string[] {
  return ["--permission-mode", modo ?? "default"];
}

/** O comando de login muda de casa para casa (na jaula do Bunker era um script em
 *  /srv; no DG Claw é o botão "Entrar com a assinatura" do painel). Quem instala
 *  diz qual é por RUNNER_LOGIN_HINT; {host} vira o hostname, que dentro de um
 *  container é o nome DELE, e não o slug do agente. */
export function dicaDeLogin(): string {
  const dica = process.env.RUNNER_LOGIN_HINT?.trim();
  return dica ? ` ${dica.replaceAll("{host}", os.hostname())}` : "";
}

/** Onde o Claude Code guarda credencial, cache e histórico deste spawn. */
export function configDirDoClaude(ctx: Pick<CtxMotor, "env">): string {
  const casa = ctx.env.HOME?.trim() || os.homedir();
  return ctx.env.CLAUDE_CONFIG_DIR?.trim() || path.join(casa, ".claude");
}

/** O `.claude.json` em uso: dentro do CLAUDE_CONFIG_DIR quando há um, senão `$HOME/.claude.json`. */
export function arquivoClaudeJson(env: Record<string, string>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, ".claude.json") : path.join(env.HOME?.trim() || os.homedir(), ".claude.json");
}

function lerClaudeJson(arquivo: string): Record<string, unknown> {
  if (!fs.existsSync(arquivo)) return {};
  const o = JSON.parse(fs.readFileSync(arquivo, "utf8")) as unknown;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("o conteúdo não é um objeto JSON");
  return o as Record<string, unknown>;
}

/** Marca a casa como confiável ANTES do PTY subir. Sem isto, na primeira vez
 *  numa pasta o CLI abre "Do you trust the files in this folder?", e o primeiro
 *  texto digitado cai dentro do diálogo e se perde. */
export function confiarNaPasta(cwd: string, env: Record<string, string>, area: string): void {
  const arquivo = arquivoClaudeJson(env);
  try {
    const atual = lerClaudeJson(arquivo);
    const projetos = ((atual as Record<string, Record<string, Record<string, unknown>>>).projects ??= {});
    const proj = (projetos[cwd] ??= {});
    if (proj.hasTrustDialogAccepted === true) return;
    proj.hasTrustDialogAccepted = true;
    gravarJsonAtomico(arquivo, atual);
    log.info(area, `casa ${cwd} marcada como confiável em ${arquivo}`);
  } catch (err) {
    log.aviso(
      area,
      `não consegui marcar ${cwd} como confiável (${err instanceof Error ? err.message : err}); ` +
        `se o CLI abrir o diálogo de confiança, a primeira mensagem enviada vai se perder dentro dele`,
    );
  }
}

/**
 * Modo API: grava no `.claude.json` em uso que a chave do ambiente já foi aprovada.
 *
 * Sem isto o Claude Code abre "Do you want to use this API key?" com o padrão em No
 * e o terminal fica parado ali (medido em 12/10/2026, docs/PROVEDORES.md). O que ele
 * compara são os ÚLTIMOS 20 caracteres da chave. `apiKeyHelper` não resolve.
 *
 * Idempotente, preserva o resto do JSON e NUNCA loga o sufixo: dos 20 caracteres
 * finais de uma chave dá para chutar o resto com muito menos esforço do que parece.
 */
export function preAprovarChaveDeApi(chave: string, env: Record<string, string>): { mudou: boolean; arquivo: string } {
  const arquivo = arquivoClaudeJson(env);
  const sufixo = chave.slice(-20);
  const atual = lerClaudeJson(arquivo);
  const resp = (atual.customApiKeyResponses && typeof atual.customApiKeyResponses === "object"
    ? atual.customApiKeyResponses
    : {}) as { approved?: unknown; rejected?: unknown };
  const aprovadas = Array.isArray(resp.approved) ? (resp.approved as unknown[]) : [];
  const rejeitadas = Array.isArray(resp.rejected) ? (resp.rejected as unknown[]) : [];
  const jaAprovada = aprovadas.includes(sufixo);
  const estavaRejeitada = rejeitadas.includes(sufixo);
  if (jaAprovada && !estavaRejeitada) return { mudou: false, arquivo };
  atual.customApiKeyResponses = {
    ...resp,
    approved: jaAprovada ? aprovadas : [...aprovadas, sufixo],
    rejected: rejeitadas.filter((x) => x !== sufixo),
  };
  gravarJsonAtomico(arquivo, atual);
  return { mudou: true, arquivo };
}

/** mcp-config, extraArgs do descritor, identidade, modelo e canal: tudo o que vem depois de `--settings`. */
function argsExtras(ctx: CtxMotor): string[] {
  const cfg = ctx.config;
  const fora: string[] = [];
  const mcp = cfg.mcpConfig?.trim();
  if (mcp) {
    if (!mcp.startsWith("{") && !fs.existsSync(mcp)) {
      log.erro(
        ctx.a("spawn"),
        `mcpConfig aponta para um arquivo que não existe: ${mcp}`,
        "o agente sobe SEM os servidores MCP deste arquivo, então a tool de resposta do " +
          "canal não vai existir e a janela de conversa fica muda: corrigir o caminho no descritor",
      );
    } else {
      fora.push("--mcp-config", mcp);
    }
  }
  for (const arg of cfg.extraArgs ?? []) {
    if (typeof arg !== "string" || !arg.length) {
      log.erro(
        ctx.a("spawn"),
        `extraArgs tem item inválido: ${JSON.stringify(arg)}`,
        "corrigir extraArgs no descritor (só texto não vazio)",
      );
      continue;
    }
    if (arg === "--strict-mcp-config") {
      log.aviso(ctx.a("spawn"), "--strict-mcp-config recusado: ele derruba todo MCP global dentro do agente");
      continue;
    }
    fora.push(arg);
  }
  if (ctx.identidade.arquivo) fora.push("--append-system-prompt-file", ctx.identidade.arquivo);
  const modelo = ctx.escolha.modelo;
  if (modelo) fora.push("--model", modelo);
  if (ctx.canalTelegram) {
    // Quem já passa --channels pelo extraArgs (agente antigo) não ganha um segundo.
    if (fora.includes("--channels")) {
      log.info(ctx.a("spawn"), "o canal Telegram já vem declarado em extraArgs (--channels); não repito o argumento");
    } else {
      fora.push("--channels", CANAL_TELEGRAM);
    }
  }
  return fora;
}

function cauda(ctx: CtxMotor): string[] {
  return [...(ctx.settings ? ["--settings", ctx.settings] : []), ...argsExtras(ctx)];
}

export const motorClaude: Motor = {
  provedor: "claude",
  binario: "claude",
  usaHooks: true,
  pausaAntesDoEnterMs: 60,
  reciboMs: 1_200,
  reciboPorRollout: false,

  argsNova(ctx) {
    return ["--session-id", ctx.novoId ?? "", ...argsDePermissao(ctx.config.permissionMode), ...cauda(ctx)];
  },

  argsRetomar(ctx, sessionId) {
    return ["--resume", sessionId, ...argsDePermissao(ctx.config.permissionMode), ...cauda(ctx)];
  },

  async preparar(ctx) {
    confiarNaPasta(ctx.cwd, ctx.env, ctx.a("spawn"));
    if (ctx.escolha.auth === "api") {
      const chave = ctx.env[ctx.variavelDoModo ?? "ANTHROPIC_API_KEY"];
      if (chave) {
        try {
          const r = preAprovarChaveDeApi(chave, ctx.env);
          if (r.mudou) log.info(ctx.a("spawn"), `chave de API pré-aprovada em ${r.arquivo}`);
        } catch (err) {
          throw new ErroDeMotor(
            `Não consegui pré-aprovar a chave de API no ${arquivoClaudeJson(ctx.env)}: ${err instanceof Error ? err.message : err}. ` +
              `Sem isso o Claude abre a pergunta "Do you want to use this API key?" e o terminal trava nela.`,
            "runner:preaprovacao-falhou",
            `conferir a permissão de escrita em ${path.dirname(arquivoClaudeJson(ctx.env))} e se o ${path.basename(arquivoClaudeJson(ctx.env))} é um JSON válido`,
          );
        }
      }
    }
    if (ctx.canalTelegram) limparCacheNeedsAuth(configDirDoClaude(ctx));
  },

  motivoSemLogin(ctx): Recusa | null {
    if (ctx.escolha.auth === "api" || ctx.escolha.auth === "token") {
      return ctx.chaveDoModoPresente ? null : recusaDeChave(ctx, "Claude");
    }
    const credencial = path.join(configDirDoClaude(ctx), ".credentials.json");
    try {
      if (fs.statSync(credencial).size > 0) return null;
    } catch {
      /* não existe, e é exatamente o caso que este método serve para nomear */
    }
    // Um agente SEM login não falha: ele sobe, o `claude` abre a tela de escolha de
    // conta e fica lá, com o PTY vivo e o status `idle`. Quem manda mensagem não
    // recebe nada nem descobre por quê (aconteceu em 27/08/2026).
    return {
      tipo: "login",
      mensagem:
        `O agente ${ctx.slug} ainda não fez login: não achei ${credencial}. ` +
        `Enquanto isso ele não responde nada, e a mensagem de quem escrever se perde na tela de login. ` +
        `O que fazer: abrir um terminal na casa dele e rodar "claude", escolher a conta, ou usar o login ` +
        `assistido do painel (POST /api/provedor/login), e o runner sobe sozinho assim que a credencial aparecer.` +
        dicaDeLogin(),
      comoResolver: "fazer o login da conta deste agente pelo painel (Provedor do agente) ou pelo terminal do cartão",
    };
  },
};
