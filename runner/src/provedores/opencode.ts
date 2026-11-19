// O motor do OpenCode (https://opencode.ai), ligado a uma chave do OpenRouter.
//
// Só abre CARDS (sessões paralelas): o catálogo marca o provedor como `soCard` e a escolha da
// conversa principal o recusa. Por que a TUI dentro do PTY, e não `opencode run` nem `opencode serve`:
// a TUI reaproveita tudo o que o mini-bunker já faz com o Claude e o Codex (terminal visível no painel,
// fila de ocioso, texto digitado, suspender e retomar, capacidade, fechar o card). `opencode run` é um
// processo por mensagem, sem terminal, e pediria um segundo modo de sessão; `opencode serve` pediria um
// cliente HTTP/SSE, senha e porta por card, sem ganho para este uso.
//
// O que o OpenCode tem de diferente, e que este arquivo absorve (medido com o opencode-ai 1.19.6):
//   - não há `--settings` nem `notify`: o status vem de um PLUGIN (opencode-plugin-source.ts) que fica em
//     `plugins/` dentro da pasta apontada por OPENCODE_CONFIG_DIR, uma por spawn;
//   - o id da sessão é descoberto pelo plugin (`chat.message`), não pode ser pré-fixado;
//   - retomar é flag: `opencode -s <ses_...>`; o modelo vai em `-m openrouter/<id do OpenRouter>`;
//   - a chave é OPENROUTER_API_KEY no ambiente, que o OpenCode já lê para o provedor `openrouter`;
//   - não há tela de confiança de pasta nem de login (só a chave existe).
//
// O que NÃO vem junto, e é avisado no log a cada spawn: os hooks do Claude Code (promptHooks, stopHooks,
// trava de resposta), as regras allow/ask/deny por ferramenta, os skills do plugin do DG Claw, os
// conectores do claude.ai, o Telegram e o MCP do descritor. O card recebe no lugar o AGENTS.md da pasta
// de trabalho (o OpenCode o lê sozinho), a identidade do agente (via `instructions`), o plugin de status
// e as ferramentas nativas do OpenCode.
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { OPENCODE_PLUGIN_NOME, OPENCODE_PLUGIN_SOURCE } from "./opencode-plugin-source.js";
import { recusaDeChave, ErroDeMotor, type CtxMotor, type Motor, type Recusa } from "./motor.js";

const PREFIXO_DO_MODELO = "openrouter/";

/** O argumento `-m`: o provedor do OpenCode é `openrouter`, e o resto é o id do modelo no OpenRouter. */
export function modeloDoOpenCode(ctx: CtxMotor): string {
  const modelo = ctx.escolha.modelo || ctx.catalogo.provedores.opencode?.modeloPadrao || "";
  return `${PREFIXO_DO_MODELO}${modelo}`;
}

/** O config do spawn (opencode.json dentro de OPENCODE_CONFIG_DIR). Soma-se ao config global do usuário, não o substitui. */
export function configDoSpawn(ctx: CtxMotor): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    // Sem aviso de versão nova nem atualização sozinha no meio de um card.
    autoupdate: false,
    // Nunca publicar a conversa num link do opencode.ai.
    share: "disabled",
  };
  if (ctx.identidade.arquivo) config.instructions = [ctx.identidade.arquivo];
  // Autonomia: só o modo "default" do descritor pede confirmação antes de editar e de rodar comando.
  // Os demais usam o padrão do OpenCode (que só pergunta ao sair da pasta de trabalho).
  if (ctx.config.permissionMode === "default") config.permission = { edit: "ask", bash: "ask" };
  return config;
}

function avisarIgnorados(ctx: CtxMotor): void {
  const cfg = ctx.config;
  const ignorados: string[] = [];
  if ((cfg.promptHooks ?? []).length) ignorados.push("promptHooks");
  if ((cfg.stopHooks ?? []).length) ignorados.push("stopHooks");
  if ([cfg.allowTools, cfg.askTools, cfg.denyTools].some((l) => (l ?? []).length)) ignorados.push("allowTools/askTools/denyTools");
  if ((cfg.extraArgs ?? []).length) ignorados.push("extraArgs (são flags do Claude)");
  if (cfg.mcpConfig?.trim()) ignorados.push("mcpConfig");
  if (ctx.canalTelegram) ignorados.push("--channels");
  const base =
    "este card usa o OpenCode, que não roda os hooks do Claude Code (recall, trava de resposta, regras de permissão por ferramenta), " +
    "não carrega os skills do plugin do DG Claw, os conectores do claude.ai nem o Telegram. " +
    "Ele recebe o AGENTS.md da pasta de trabalho, a identidade do agente e as ferramentas nativas dele";
  log.aviso(ctx.a("spawn"), ignorados.length ? `${base}. Ignorei também: ${ignorados.join(", ")}` : base);
}

function argsComuns(ctx: CtxMotor): string[] {
  // Sem --auto: o padrão só pede permissão para sair da pasta de trabalho, e aprovar tudo seria perigoso.
  return ["-m", modeloDoOpenCode(ctx)];
}

export const motorOpenCode: Motor = {
  provedor: "opencode",
  binario: "opencode",
  usaHooks: false,
  pausaAntesDoEnterMs: 500,
  reciboMs: 3_000,
  reciboPorRollout: false,

  argsNova(ctx) {
    return argsComuns(ctx);
  },

  argsRetomar(ctx, sessionId) {
    return ["-s", sessionId, ...argsComuns(ctx)];
  },

  async preparar(ctx) {
    ctx.extrasDoMotor = [];
    const pasta = path.join(ctx.pastaDeHooks, `opencode-${ctx.nonce.slice(0, 12)}`);
    try {
      fs.mkdirSync(path.join(pasta, "plugins"), { recursive: true, mode: 0o700 });
      fs.chmodSync(pasta, 0o700);
      const plugin = path.join(pasta, "plugins", `${OPENCODE_PLUGIN_NOME}.js`);
      fs.writeFileSync(plugin, OPENCODE_PLUGIN_SOURCE, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(plugin, 0o600);
      const arquivoDeConfig = path.join(pasta, "opencode.json");
      fs.writeFileSync(arquivoDeConfig, JSON.stringify(configDoSpawn(ctx), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(arquivoDeConfig, 0o600);
    } catch (err) {
      throw new ErroDeMotor(
        `Não consegui preparar a pasta de configuração do OpenCode em ${pasta}: ${err instanceof Error ? err.message : String(err)}`,
        "runner:preparo-falhou",
        `conferir a permissão de escrita em ${ctx.pastaDeHooks}`,
      );
    }
    ctx.limpezas.push(() => {
      try {
        fs.rmSync(pasta, { recursive: true, force: true });
      } catch (err) {
        log.aviso(ctx.a("spawn"), `não consegui apagar ${pasta} (config temporária do OpenCode): ${err instanceof Error ? err.message : err}`);
      }
    });

    ctx.env.OPENCODE_CONFIG_DIR = pasta;
    ctx.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    // Nada de baixar servidor de linguagem (LSP) no meio do card: o que o card precisa vem na imagem.
    ctx.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
    ctx.env.DGCLAW_HOOK_AGENT = ctx.id;
    ctx.env.DGCLAW_HOOK_PORT = String(ctx.porta);
    ctx.env.DGCLAW_HOOK_NONCE = ctx.nonce;
    delete ctx.env.DGCLAW_SESSAO_ID;
    // O que o modo pede para limpar (base do OpenRouter, config e permissão vindos de fora) já saiu do
    // ambiente em montarAmbiente; o OPENCODE_CONFIG_DIR acima é o do spawn e vem depois dele de propósito.

    avisarIgnorados(ctx);
  },

  motivoSemLogin(ctx): Recusa | null {
    return ctx.chaveDoModoPresente ? null : recusaDeChave(ctx, "OpenCode");
  },
};
