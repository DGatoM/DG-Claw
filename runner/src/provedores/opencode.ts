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
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { lerRestricoes } from "../restricoes-conta.js";
import { ErroCatalogo, validar } from "./catalogo.js";
import { OPENCODE_PLUGIN_NOME, OPENCODE_PLUGIN_SOURCE } from "./opencode-plugin-source.js";
import { recusaDeChave, ErroDeMotor, type CtxMotor, type Motor, type Recusa } from "./motor.js";

/** Onde a imagem instala o @opencode-ai/plugin (container/Containerfile), com a trava revisada em providers/opencode-deps. */
const DEPENDENCIAS_PADRAO = "/opt/dgclaw/opencode-deps";

const PREFIXO_DO_MODELO = "openrouter/";

/** O argumento `-m`: o provedor do OpenCode é `openrouter`, e o resto é o id do modelo no OpenRouter. */
export function modeloDoOpenCode(ctx: CtxMotor): string {
  const modelo = ctx.escolha.modelo || ctx.catalogo.provedores.opencode?.modeloPadrao || "";
  return `${PREFIXO_DO_MODELO}${modelo}`;
}

const TETO_DO_AGENTS_MD = 256 * 1024;

/**
 * O AGENTS.md da pasta de trabalho entra nas instruções do card, e a pasta é gravável pelo agente: o arquivo pode ser
 * um link para algo privado (uma credencial) que iria ao modelo no primeiro pedido. Abre sem seguir link (O_NOFOLLOW),
 * confere pelo descritor que é um arquivo comum de tamanho limitado e entrega ao OpenCode uma CÓPIA dos bytes já
 * conferidos, dentro da pasta do spawn (modo 600), nunca o caminho original.
 */
function copiarAgentsMd(ctx: CtxMotor, pastaDoSpawn: string): string | null {
  if (!ctx.cwd) return null;
  const origem = path.join(ctx.cwd, "AGENTS.md");
  let fd: number | null = null;
  try {
    fd = fs.openSync(origem, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      log.aviso(ctx.a("spawn"), `o AGENTS.md da pasta de trabalho não é um arquivo comum; o card abre sem ele`);
      return null;
    }
    if (st.nlink !== 1) {
      // Dois nomes para o mesmo arquivo (link físico): pode ser uma credencial que o agente consegue ler.
      log.aviso(ctx.a("spawn"), `o AGENTS.md da pasta de trabalho tem ${st.nlink} nomes (link físico); o card abre sem ele, por segurança`);
      return null;
    }
    if (st.size > TETO_DO_AGENTS_MD) {
      log.aviso(ctx.a("spawn"), `o AGENTS.md da pasta de trabalho tem ${st.size} bytes (o teto é ${TETO_DO_AGENTS_MD}); o card abre sem ele`);
      return null;
    }
    const bytes = fs.readFileSync(fd);
    const destino = path.join(pastaDoSpawn, "AGENTS-da-pasta.md");
    fs.writeFileSync(destino, bytes, { mode: 0o600 });
    return destino;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.aviso(
        ctx.a("spawn"),
        code === "ELOOP"
          ? "o AGENTS.md da pasta de trabalho é um link simbólico; o card abre sem ele (por segurança, links não são seguidos)"
          : `não consegui ler o AGENTS.md da pasta de trabalho (${err instanceof Error ? err.message : err}); o card abre sem ele`,
      );
    }
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* descritor já fechado */
      }
    }
  }
}

/** O config do spawn (opencode.json dentro de OPENCODE_CONFIG_DIR). Soma-se ao config global do usuário, não o substitui. */
export function configDoSpawn(ctx: CtxMotor, pastaDoSpawn?: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    // Sem aviso de versão nova nem atualização sozinha no meio de um card.
    autoupdate: false,
    // Nunca publicar a conversa num link do opencode.ai.
    share: "disabled",
  };
  // A config do projeto (.opencode/, opencode.json) fica desligada de propósito (plugin plantado pelo agente na
  // pasta de trabalho rodaria com a chave no processo), e junto com ela o OpenCode deixa de ler o AGENTS.md da
  // pasta. O AGENTS.md é só texto de instrução, então entra pela lista `instructions`, que o próprio runner monta.
  const instrucoes: string[] = [];
  if (ctx.identidade.arquivo) instrucoes.push(ctx.identidade.arquivo);
  const copia = pastaDoSpawn ? copiarAgentsMd(ctx, pastaDoSpawn) : null;
  if (copia) instrucoes.push(copia);
  if (instrucoes.length) config.instructions = instrucoes;
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

/** A pasta de dependências pronta (package.json, package-lock.json e node_modules), ou null quando a imagem não a traz (desenvolvimento). */
export function pastaDeDependencias(): string | null {
  const dir = process.env.DGCLAW_OPENCODE_DEPS?.trim() || DEPENDENCIAS_PADRAO;
  const ok = ["package.json", "package-lock.json", "node_modules"].every((f) => fs.existsSync(path.join(dir, f)));
  return ok ? dir : null;
}

/**
 * Faz da pasta `destino` uma pasta de configuração do OpenCode que NÃO precisa instalar nada: copia o
 * package.json e a trava e liga o node_modules da imagem. O OpenCode 1.19.6 só roda a instalação (rede, 64 MB,
 * registro npm) quando falta o node_modules ou quando o pacote declarado não está na trava; com os três no
 * lugar ele pula (medido com a rede bloqueada).
 */
function ligarDependencias(destino: string, deps: string): void {
  fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
  for (const f of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(deps, f), path.join(destino, f));
    fs.chmodSync(path.join(destino, f), 0o600);
  }
  fs.symlinkSync(path.join(deps, "node_modules"), path.join(destino, "node_modules"), "dir");
}

/**
 * A pasta XDG_CONFIG_HOME só deste card: tem tudo o que a config real tem (ligado por link, para as outras
 * ferramentas do card, como o gh, seguirem achando o que é delas), MENOS a pasta `opencode`. É o que impede um
 * plugin deixado pelo agente em ~/.config/opencode de rodar dentro de outro card.
 */
function montarXdgIsolado(xdg: string, configReal: string, deps: string, ctx: CtxMotor): void {
  fs.mkdirSync(xdg, { recursive: true, mode: 0o700 });
  let entradas: string[] = [];
  try {
    entradas = fs.readdirSync(configReal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.aviso(ctx.a("spawn"), `não consegui listar ${configReal} para montar a config isolada do card: ${err instanceof Error ? err.message : err}. As ferramentas do card não verão a configuração delas`);
    }
  }
  for (const nome of entradas) {
    if (nome === "opencode") continue;
    try {
      fs.symlinkSync(path.join(configReal, nome), path.join(xdg, nome));
    } catch (err) {
      log.aviso(ctx.a("spawn"), `não consegui ligar ${nome} na config isolada do card: ${err instanceof Error ? err.message : err}`);
    }
  }
  const dirOpencode = path.join(xdg, "opencode");
  ligarDependencias(dirOpencode, deps);
}

/** As restrições do dono que o OpenCode não sabe aplicar: se existirem, o card não abre (senão seriam ignoradas em silêncio). */
/** Os motivos pelos quais este agente não pode abrir card no OpenCode (lista vazia = pode). Também usada ao CRIAR o card, antes de gravá-lo. */
export function motivosDeRestricao(cfg: { askTools?: string[]; denyTools?: string[]; extraArgs?: string[] }): string[] {
  const motivos: string[] = [];
  if ((cfg.askTools ?? []).length) motivos.push("pedidos de confirmação por ferramenta (askTools)");
  if ((cfg.denyTools ?? []).length) motivos.push("ferramentas proibidas (denyTools)");
  // O descritor também pode proibir ferramentas por flag do Claude (extraArgs): o OpenCode não as entende.
  if ((cfg.extraArgs ?? []).some((a) => /^--(disallowed-?tools|allowed-?tools|permission-mode|dangerously-skip-permissions|tools)\b/i.test(String(a).trim()))) {
    motivos.push("regras de ferramentas nos extraArgs (--disallowedTools e parecidas)");
  }
  const r = lerRestricoes();
  if (r.ativa) motivos.push(r.erro ? `restrições do dono ilegíveis (${r.erro})` : "restrições do dono (sem Bash, sem enviar arquivo ou escrita só em certas pastas)");
  return motivos;
}

function recusaPorRestricao(ctx: CtxMotor): Recusa | null {
  const motivos = motivosDeRestricao(ctx.config);
  if (!motivos.length) return null;
  return {
    tipo: "restricao",
    mensagem:
      `O card ${ctx.slug} não abre no OpenCode: este agente tem ${motivos.join(" e ")}, e o OpenCode não aplica essas regras ` +
      "(elas só funcionam no Claude Code). Abrir assim deixaria o card fazer o que o dono proibiu.",
    comoResolver: "abrir o card no Claude, que aplica essas regras, ou tirar as restrições do agente (dgclaw agente restricoes). Não use o Codex: ele também não aplica essas restrições",
  };
}

/** O modelo gravado no card tem que existir no catálogo/cache de hoje; senão o card para e pede outro (nunca cai para outro provedor). */
function recusaPorModelo(ctx: CtxMotor): Recusa | null {
  const modelo = ctx.escolha.modelo;
  try {
    const v = validar(ctx.catalogo, "opencode", "api", modelo, { paraCard: true });
    if (modelo && v.modelo !== modelo) throw new ErroCatalogo(`o id '${modelo}' não é o id canônico do catálogo (${v.modelo})`);
    return null;
  } catch (err) {
    if (!(err instanceof ErroCatalogo)) throw err;
    return {
      tipo: "modelo",
      mensagem: `O modelo '${modelo}' deste card do OpenCode não está mais disponível: ${err.message}`,
      comoResolver: "escolher outro modelo para este card (painel Sessões ou dgclaw-card abrir --provedor opencode --modelo <outro>); o card não troca de provedor sozinho",
    };
  }
}

export const motorOpenCode: Motor = {
  provedor: "opencode",
  binario: "opencode",
  usaHooks: false,
  prontidaoPorPlugin: true,
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
    const deps = pastaDeDependencias();
    if (!deps) {
      // Sem a pasta revisada o OpenCode instalaria o plugin pela internet, no momento em que já tem a chave no
      // processo, e sem a garantia da trava (package-lock.json). Não abre.
      throw new ErroDeMotor(
        `A pasta de dependências do OpenCode (${process.env.DGCLAW_OPENCODE_DEPS?.trim() || DEPENDENCIAS_PADRAO}) não existe nesta imagem, e o card não abre sem ela (o OpenCode instalaria o plugin pela internet, sem a trava revisada).`,
        "runner:dependencias-ausentes",
        "reconstruir a imagem dos agentes (dgclaw atualizar e reconstruir a imagem), que traz as dependências do OpenCode em /opt/dgclaw/opencode-deps",
      );
    }
    const configReal = ctx.env.XDG_CONFIG_HOME?.trim() || path.join(ctx.env.HOME?.trim() || os.homedir(), ".config");
    try {
      fs.mkdirSync(path.join(pasta, "plugins"), { recursive: true, mode: 0o700 });
      fs.chmodSync(pasta, 0o700);
      const plugin = path.join(pasta, "plugins", `${OPENCODE_PLUGIN_NOME}.js`);
      fs.writeFileSync(plugin, OPENCODE_PLUGIN_SOURCE, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(plugin, 0o600);
      const arquivoDeConfig = path.join(pasta, "opencode.json");
      fs.writeFileSync(arquivoDeConfig, JSON.stringify(configDoSpawn(ctx, pasta), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(arquivoDeConfig, 0o600);
      ligarDependencias(pasta, deps);
      fs.mkdirSync(path.join(pasta, "casa-vazia"), { recursive: true, mode: 0o700 });
      montarXdgIsolado(path.join(pasta, "xdg"), configReal, deps, ctx);
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

    // O OpenCode SOMA a OPENCODE_CONFIG_DIR à config do usuário (~/.config/opencode e ~/.opencode) e à da pasta
    // do projeto, e plugins de qualquer uma delas rodam antes de qualquer aprovação, com a chave no processo.
    // Como o agente escreve nessas pastas, o card só enxerga a configuração gerada aqui:
    //   - XDG_CONFIG_HOME aponta para a pasta isolada (a ~/.config/opencode real fica de fora);
    //   - OPENCODE_TEST_HOME muda onde o OpenCode procura ~/.opencode (os dados e as sessões continuam em
    //     ~/.local/share, então retomar com -s segue funcionando);
    //   - OPENCODE_DISABLE_PROJECT_CONFIG ignora .opencode/ e opencode.json da pasta de trabalho;
    //   - sem plugins padrão, sem o que o OpenCode importaria do Claude Code.
    // Medido com o opencode 1.19.6 e plugins marcadores plantados nos quatro lugares: só o do spawn carrega.
    ctx.env.OPENCODE_CONFIG_DIR = pasta;
    ctx.env.XDG_CONFIG_HOME = path.join(pasta, "xdg");
    ctx.env.OPENCODE_TEST_HOME = path.join(pasta, "casa-vazia");
    ctx.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    ctx.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
    ctx.env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
    ctx.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
    // As credenciais salvas pelo OpenCode (auth.json, em ~/.local/share) têm precedência sobre a variável de ambiente:
    // com {} aqui a única chave que vale é a do Cofre, e uma chave antiga guardada lá não continua sendo cobrada.
    ctx.env.OPENCODE_AUTH_CONTENT = "{}";
    ctx.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    // Nada de baixar servidor de linguagem (LSP) no meio do card: o que o card precisa vem na imagem.
    ctx.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
    ctx.env.DGCLAW_HOOK_AGENT = ctx.id;
    ctx.env.DGCLAW_HOOK_PORT = String(ctx.porta);
    ctx.env.DGCLAW_HOOK_NONCE = ctx.nonce;
    delete ctx.env.DGCLAW_SESSAO_ID;
    // O que o modo pede para limpar (OPENCODE_*, OPENROUTER_* e a chave herdada) já saiu do ambiente em
    // montarAmbiente; o que está acima é o do spawn e vem depois dele de propósito.

    avisarIgnorados(ctx);
  },

  motivoSemLogin(ctx): Recusa | null {
    const restricao = recusaPorRestricao(ctx);
    if (restricao) return restricao;
    // O OpenCode só tem a forma "api" (chave do OpenRouter, do Cofre). Qualquer outro nome vindo de arquivo
    // de cliente não satisfaz a exigência da chave: recusa em vez de abrir com credencial que o CLI já tenha salva.
    if (ctx.escolha.auth !== "api") {
      return {
        tipo: "chave",
        mensagem: `O card ${ctx.slug} pede a forma de pagar '${ctx.escolha.auth}' no OpenCode, e ele só funciona na forma 'api' (chave do OpenRouter no Cofre).`,
        comoResolver: "escolher o OpenCode na API (OpenRouter) ao abrir o card",
      };
    }
    const modelo = recusaPorModelo(ctx);
    if (modelo) return modelo;
    return ctx.chaveDoModoPresente ? null : recusaDeChave(ctx, "OpenCode");
  },
};
