// A sessão viva do agente: o PTY, o estado e a máquina de status.
//
// Este arquivo é a parte do `agent-manager.ts` do Bunker que um agente ENTREGUE
// realmente usa, reescrita para viver sozinha. O que ficou de fora, e por quê:
// worktree, codex, geometria por aparelho, handoff, mestre, board e o cofre. Um
// agente de cliente não faz nada disso, e cada um deles arrastaria uma
// dependência do Bunker para dentro de uma máquina onde Bunker não existe.
//
// O que foi mantido igual, porque é contrato e não estilo:
//   - `--session-id <uuid>` no spawn novo e `--resume <uuid>` na retomada;
//   - o `--settings` por spawn com os hooks de status e as regras de permissão;
//   - a fila de colagem antes do Enter (o bug histórico do "digita mas não envia");
//   - os nomes de status (`spawning`, `idle`, `working`, `waiting_input`,
//     `stopped`, `resumable`, `errored`), que o painel da pessoa já lê.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import pty from "node-pty";
import type { AgentConfig, AgentState } from "./tipos.js";
import { log } from "./logger.js";
import { HOOK_HANDLER_SOURCE } from "./hook-handler-source.js";
import { gravarEstado, lerEstado, STATE_FILE, type ConfigDoRunner } from "./config-runner.js";

/** Quanto da tela guardamos para quem chegar depois (o painel pede o buffer ao abrir). */
const BUFFER_MAX = 200 * 1024;
/** O Stop dispara no fim de TODO turno, inclusive intermediário. Só vira
 *  "concluído" depois de tanto tempo quieto. Mesmo valor do Bunker. */
const STOP_CONFIRM_MS = 6_000;
/** Colagem: pedaços de 128 a cada 25ms, e o Enter só depois de drenar. */
const PEDACO = 128;
const INTERVALO_MS = 25;
/** Quanto esperamos o recibo do Enter (o hook UserPromptSubmit) antes de bater na
 *  tecla de novo, e quantas vezes batemos. Ver enviarComRecibo(). */
const RECIBO_ENTER_MS = 1_200;
const RECIBO_ENTER_TENTATIVAS = 3;
/** Um `--resume` que morre dentro desta janela morreu por causa da sessão, não
 *  do trabalho. Medido: `claude --resume <id>` de um id sem transcript no disco
 *  sai com código 1 em ~2s. */
const RESUME_MORREU_CEDO_MS = 15_000;
/** Depois de subir um PTY, a fila só solta texto passado este tempo E com a tela
 *  quieta por QUIETO_ANTES_DE_DIGITAR_MS. O SessionStart de um `--resume` chega
 *  em ~1,4s, antes de o TUI acabar de desenhar o histórico: o texto digitado ali
 *  some e os três Enters batem numa caixa vazia (ensaio de 09/10/2026, sessão de
 *  bastidores acordando depois de suspensa). Só vale para os primeiros
 *  JANELA_DE_PRONTIDAO_MS do spawn; depois disso a fila solta como sempre. */
const PRONTO_APOS_SPAWN_MS = 5_000;
const QUIETO_ANTES_DE_DIGITAR_MS = 1_200;
const JANELA_DE_PRONTIDAO_MS = 30_000;

/** Chave de LLM em texto claro nunca entra num agente por herança de ambiente.
 *  No Bunker isso existe porque o proxy troca por placeholder; aqui existe
 *  porque o processo do runner pode ter sido iniciado por um shell que tinha a
 *  chave exportada, e o agente do cliente não é dono dela. */
const CHAVES_QUE_NAO_PASSAM = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_AI_API_KEY",
]);

const ESC = "\u001b";
const RE_ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

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
function argsDePermissao(modo: AgentConfig["permissionMode"]): string[] {
  return ["--permission-mode", modo ?? "default"];
}

function semAnsi(s: string): string {
  return s.replace(RE_ANSI, "");
}

/** O que uma Sessao precisa saber sobre quem ela é. Para a principal, o `config`
 *  é o do descritor; para a paralela, o derivado (ver configDaSessao). */
export interface IdentidadeDaSessao {
  id: string;
  slug: string;
  config: ConfigDoRunner;
}

export interface OpcoesDaSessao {
  /** Onde esta sessão guarda sessionId e status. Padrão: STATE_FILE (a principal). */
  arquivoDeEstado?: string;
  papel?: "principal" | "paralela";
  tipo?: string;
  chat?: string;
  /** Comandos extras do evento UserPromptSubmit, depois do hook do runner. */
  promptHooks?: string[];
  ociosoMinutos?: number;
  /** Arquivos de identidade (relativos ao cwd) concatenados a cada spawn. */
  identidade?: string[];
}

export class Sessao extends EventEmitter {
  private proc: pty.IPty | null = null;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private seq = 0;
  private nonce: string | null = null;
  private hooksVivos = false;
  /** Quantos prompts o Claude já ACEITOU (contado no hook UserPromptSubmit). É o
   *  recibo do Enter; ver enviarComRecibo(). */
  private promptsAceitos = 0;
  private stopPendente: NodeJS.Timeout | null = null;
  private ultimaSaidaEm: number | null = null;
  private encerrando = false;
  /** Fila FIFO de textos para digitar quando o agente ficar ocioso. Era uma vaga
   *  só (o segundo texto apagava o primeiro, e a mensagem do cliente sumia). */
  private filaQuandoIdle: string[] = [];
  /** true enquanto um item da fila está sendo digitado, para dois idles seguidos
   *  não soltarem dois itens por cima um do outro. */
  private soltandoFila = false;
  /** Quando o PTY atual subiu (ver PRONTO_APOS_SPAWN_MS). */
  private spawnEm = 0;
  private reolharFila: NodeJS.Timeout | null = null;
  private ultimaAtividade = Date.now();
  /** Quando o spawn atual foi uma RETOMADA, e quando ele começou. É o que
   *  permite separar "a sessão não abre" de "o agente trabalhou e saiu". */
  private retomando: { sessionId: string; em: number } | null = null;
  /** Sessões cuja retomada já falhou. Sem esta marca, um transcript ilegível
   *  daria um laço: retoma, morre, retoma de novo, para sempre. */
  private retomadasQueFalharam = new Set<string>();

  readonly estado: AgentState;
  readonly papel: "principal" | "paralela";
  readonly tipo: string | null;
  readonly chat: string | null;
  readonly ociosoMinutos: number | null;
  private readonly arquivoDeEstado: string;
  private readonly promptHooks: string[];
  private readonly identidade: string[];

  constructor(
    private readonly descritor: IdentidadeDaSessao,
    private readonly porta: number,
    opcoes: OpcoesDaSessao = {},
  ) {
    super();
    this.papel = opcoes.papel ?? "principal";
    this.tipo = opcoes.tipo ?? null;
    this.chat = opcoes.chat ?? null;
    this.ociosoMinutos = opcoes.ociosoMinutos ?? null;
    this.arquivoDeEstado = opcoes.arquivoDeEstado ?? STATE_FILE;
    this.promptHooks = opcoes.promptHooks ?? descritor.config.promptHooks ?? [];
    this.identidade = opcoes.identidade ?? [];
    const salvo = lerEstado(this.arquivoDeEstado);
    const agora = Date.now();
    this.estado = {
      id: descritor.id,
      config: descritor.config,
      // Nasce `stopped` e não `idle`: até o PTY subir, dizer "ocioso" seria
      // mentir para o painel, que mostraria o agente pronto para conversar.
      // A paralela não sobe no boot: com conversa guardada ela nasce
      // `resumable`, que é o que o painel entende como "dá para acordar".
      status: this.papel === "paralela" && salvo.sessionId ? "resumable" : "stopped",
      sessionId: salvo.sessionId,
      previousSessionId: salvo.previousSessionId,
      currentTask: null,
      currentTool: null,
      todoItems: [],
      lastMessage: null,
      pendingPermission: null,
      createdAt: agora,
      updatedAt: agora,
      costUsd: 0,
      turns: 0,
      toolCallsCount: 0,
      messagesCount: 0,
      error: null,
      hookActive: false,
      hookLatched: false,
      statusReason: "runner:boot",
      worktree: null,
    };
  }

  // --- leitura ---------------------------------------------------------------

  /** Id curto na área do log, só para a paralela: os logs das duas dividem o
   *  mesmo arquivo, e sem isto não dá para saber de quem é cada linha. A
   *  principal mantém as áreas de sempre. */
  private a(area: string): string {
    return this.papel === "principal" ? area : `${area}[${this.descritor.id.slice(0, 12)}]`;
  }

  get id(): string {
    return this.descritor.id;
  }

  get slug(): string {
    return this.descritor.slug;
  }

  /** Quando houve a última coisa que conta como "estão usando esta sessão": input,
   *  turno, ferramenta, fim de turno, compact, subida. Base da suspensão. */
  ultimaAtividadeEm(): number {
    return this.ultimaAtividade;
  }

  tamanhoDaFila(): number {
    return this.filaQuandoIdle.length;
  }

  private marcarAtividade(): void {
    this.ultimaAtividade = Date.now();
  }

  /** true quando existe PTY vivo agora. É a diferença que o painel do DG Claw
   *  usa para decidir entre "não alcancei a plataforma" (o runner está fora) e
   *  "o terminal caiu" (o runner respondeu, mas não há sessão), e só a segunda
   *  mostra o botão de acordar. Responder errado aqui esconde o botão
   *  exatamente na hora em que ele é necessário. */
  temPtyVivo(): boolean {
    return this.proc !== null;
  }

  telaInteira(): string {
    return this.buffer.join("");
  }

  quandoFalouPorUltimo(): number | null {
    return this.ultimaSaidaEm;
  }

  // --- ciclo de vida ---------------------------------------------------------

  /**
   * Sobe o agente. `modo`:
   *   "retomar" — continua a sessão que já existe (`--resume`). É o caminho de
   *               todo boot do serviço: o cliente não pode perder a conversa
   *               porque a máquina reiniciou.
   *   "nova"    — sessão nova (`--session-id`), guardando a anterior em
   *               `previousSessionId` para nada ser perdido sem volta.
   */
  async subir(modo: "retomar" | "nova"): Promise<void> {
    if (this.proc) {
      log.info(this.a("pty"), `pedido de subir ignorado: já existe PTY vivo (pid ${this.proc.pid})`);
      return;
    }
    // SEM LOGIN, O PTY SOBE ASSIM MESMO, E ISSO É DELIBERADO.
    //
    // A primeira versão desta guarda barrava o spawn, e ela consertava um
    // problema criando outro. O que ela consertava continua valendo: um agente
    // sem credencial parava na tela de escolha de conta, reportava `idle`, e
    // engolia em silêncio tudo o que o cliente escrevesse.
    //
    // O que ela quebrou: sem PTY, o terminal do cartão fica PRETO, e a tela de
    // login era justamente por onde o dono logava — pelo cartão, sem precisar de
    // terminal na máquina. A guarda tirou o único caminho de login de quem não
    // tem ssh, que é o motivo de o cartão existir.
    //
    // Então agora são as duas coisas ao mesmo tempo, que nunca foram opostas:
    // o PTY nasce e o dono vê a tela de login no cartão, E o estado vai para
    // `errored` com o motivo, o que faz o `POST /input` do cliente ser recusado
    // com 409 SEM_LOGIN em vez de virar texto digitado numa tela de login.
    // Quem digita PELO TERMINAL (terminal_input, o dono) continua passando: é
    // outro caminho, e é o caminho do login.
    this.marcarAtividade();
    const semLogin = this.motivoDeNaoSubir();
    if (semLogin) {
      log.erro(this.a("pty"), semLogin, "logar pelo terminal do cartão; o runner assume assim que a credencial aparecer");
    }

    const cfg = this.descritor.config;
    let args: string[];
    if (modo === "retomar" && this.estado.sessionId) {
      args = ["--resume", this.estado.sessionId, ...argsDePermissao(cfg.permissionMode)];
      this.retomando = { sessionId: this.estado.sessionId, em: Date.now() };
      this.mudar({ status: "spawning", error: null, statusReason: "runner:resume" });
      log.info(this.a("pty"), `retomando a sessão ${this.estado.sessionId}`);
    } else {
      this.retomando = null;
      if (modo === "retomar") {
        log.info(this.a("pty"), "não há sessão anterior registrada; subindo uma sessão nova");
      }
      const novo = randomUUID();
      this.mudar({
        status: "spawning",
        error: null,
        sessionId: novo,
        previousSessionId: this.estado.sessionId ?? this.estado.previousSessionId ?? null,
        statusReason: "runner:sessao-nova",
      });
      args = ["--session-id", novo, ...argsDePermissao(cfg.permissionMode)];
      log.info(
        this.a("pty"),
        `sessão nova ${novo}` +
          (this.estado.previousSessionId ? ` (anterior guardada: ${this.estado.previousSessionId})` : ""),
      );
    }
    await this.spawn(args);

    // Depois do spawn, e não antes: o `mudar` do spawn põe `spawning`, e este
    // aqui é que fica valendo. Sem isto o boot-timer de 8s marcaria `idle` e o
    // painel voltaria a dizer que está tudo bem.
    if (semLogin) {
      this.mudar({ status: "errored", error: semLogin, statusReason: "runner:sem-login" });
      this.esperarLogin();
    }
  }

  /**
   * Onde mora a credencial deste agente, e se ela existe.
   *
   * Existe porque um agente SEM login não falha: ele sobe, o `claude` abre a tela
   * de escolha de conta e fica lá, com o PTY vivo e o status `idle`. Do lado de
   * fora tudo parece bem, e quem manda mensagem não recebe nada nem descobre por
   * quê — a mensagem é digitada na tela de login e se perde. Foi assim em
   * 27/08/2026, com o dono esperando resposta de um agente que nunca ia responder.
   *
   * Chave de API conta como login: quem usa `ANTHROPIC_API_KEY` não tem (nem
   * precisa de) `.credentials.json`.
   */
  private motivoDeNaoSubir(): string | null {
    const cfg = this.descritor.config;
    const extra = cfg.envExtra ?? {};
    if (extra.ANTHROPIC_API_KEY || extra.ANTHROPIC_AUTH_TOKEN) return null;
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return null;

    const casa = extra.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || os.homedir();
    const credencial = path.join(casa, ".credentials.json");
    try {
      if (fs.statSync(credencial).size > 0) return null;
    } catch {
      /* não existe, e é exatamente o caso que este método serve para nomear */
    }
    return (
      `O agente ${this.descritor.slug} ainda não fez login: não achei ${credencial}. ` +
      `Enquanto isso ele não responde nada, e a mensagem de quem escrever se perde na tela de login. ` +
      `O que fazer: abrir um terminal na casa dele e rodar "claude", escolher a conta, e o runner sobe sozinho ` +
      `assim que a credencial aparecer.` +
      // O comando de login muda de casa para casa (na jaula do Bunker era um
      // script em /srv; no DG Claw é o botão "Entrar com a assinatura" do
      // painel). Quem instala diz qual é por RUNNER_LOGIN_HINT; {host} vira o
      // hostname, que dentro de um container é o nome DELE, e não o slug do agente.
      (process.env.RUNNER_LOGIN_HINT?.trim()
        ? ` ${process.env.RUNNER_LOGIN_HINT.trim().replaceAll("{host}", os.hostname())}`
        : "")
    );
  }

  /** O mesmo motivo, para quem consome de fora (o servidor recusa input com ele). */
  motivoSemLogin(): string | null {
    return this.motivoDeNaoSubir();
  }

  /**
   * Fica de olho até a credencial aparecer, e então sobe sozinho.
   *
   * O login é interativo e acontece FORA deste processo: alguém abre um terminal
   * na casa do agente e escolhe a conta. Sem isto aqui, o runner ficaria parado
   * para sempre depois de logar, e a pessoa que acabou de logar não teria como
   * saber que ainda falta um passo — que era justamente a reclamação de 27/08.
   *
   * Um minuto entre olhadas, e olhar custa um `stat`.
   */
  private esperarLogin(): void {
    if (this.esperandoLogin) return;
    this.esperandoLogin = setInterval(() => {
      if (this.motivoDeNaoSubir()) return;
      if (this.esperandoLogin) {
        clearInterval(this.esperandoLogin);
        this.esperandoLogin = null;
      }
      // A sessão em que o login foi feito é DESCARTÁVEL: ela nasceu na tela de
      // escolha de conta e não tem conversa nenhuma. Trocar por uma limpa aqui é
      // o que evita o estrago de 27/08, quando logar dentro da sessão viva do
      // agente matou a conversa dele junto.
      log.info(this.a("pty"), "a credencial apareceu: trocando a sessão do login por uma limpa");
      this.parar("login concluído: trocando por uma sessão limpa");
      setTimeout(() => void this.subir("nova"), 1_500).unref();
    }, 60_000);
    // Não segura o processo de pé só por causa deste relógio.
    this.esperandoLogin.unref?.();
  }

  /** O relógio que espera o login aparecer. Nulo quando não há espera em curso. */
  private esperandoLogin: ReturnType<typeof setInterval> | null = null;

  private async spawn(args: string[]): Promise<void> {
    const cfg = this.descritor.config;
    const cwd = cfg.cwd;

    const settings = this.escreverSettings();
    const extras = this.argsExtras();
    const finais = [...args, ...(settings ? ["--settings", settings] : []), ...extras];

    this.confiarNaPasta(cwd, cfg.envExtra?.CLAUDE_CONFIG_DIR);

    const ambiente: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue;
      if (CHAVES_QUE_NAO_PASSAM.has(k)) continue;
      ambiente[k] = v;
    }
    // O EnvironmentFile da unidade já entrou acima, porque o systemd o injeta no
    // processo do runner. É ele o "cofre" deste agente: o que o dono liberou,
    // nada além. Não existe caminho neste arquivo que leia segredo de outro
    // lugar, e é essa ausência que faz o agente do cliente ser seguro por
    // desenho, e não por lista de proibições que alguém precisa lembrar de
    // atualizar toda vez que um segredo novo é cadastrado.
    this.aplicarEnvExtra(ambiente);

    // O que destrava o modo "não pergunte nada" quando o processo é root.
    //
    // O runner roda como root, e o CLI recusa QUALQUER forma de pular permissão
    // sob root com "cannot be used with root/sudo privileges for security
    // reasons". Ele não pede nada e não espera: sai com código 1 em segundos, e
    // como quem morre é o PTY e não o serviço, o `Restart=always` da unidade não
    // pega. O agente some sem ninguém entender por quê (custou um agente de cliente fora do ar
    // em 24/08/2026, no primeiro agente em que isto foi ligado).
    //
    // `IS_SANDBOX=1` é a saída que o próprio CLI oferece, e já era o padrão desta
    // casa antes deste arquivo existir: está no `isa-headless-launch.sh` e no
    // `recall/tools.py` do ClaudeClaw, os dois rodando bypass sob root há meses.
    //
    // Só entra no modo bypass, de propósito: num agente que ainda pergunta, esta
    // variável não muda nada e só serviria para confundir quem for depurar.
    if (cfg.permissionMode === "bypassPermissions") ambiente.IS_SANDBOX = "1";

    log.info(this.a("pty"), `subindo: claude ${finais.join(" ")}`);
    log.info(this.a("pty"), `casa: ${cwd}`);
    try {
      this.proc = pty.spawn("claude", finais, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: ambiente,
      });
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      this.mudar({ status: "errored", error: motivo, statusReason: "runner:spawn-falhou" });
      log.erro(
        this.a("pty"),
        `pty.spawn("claude") falhou em ${cwd}: ${motivo}`,
        `conferir se o executável "claude" está no PATH DESTE serviço ` +
          `(systemctl show dgclaw-agent-${this.descritor.slug} -p Environment) e se a casa do agente existe`,
      );
      return;
    }

    log.info(this.a("pty"), `PTY de pé, pid ${this.proc.pid}`);
    this.buffer = [];
    this.bufferBytes = 0;
    this.spawnEm = Date.now();
    this.mudar({ status: "spawning", statusReason: "runner:spawn" });

    const esteProc = this.proc;
    this.proc.onData((d) => this.aoReceberDados(d));
    this.proc.onExit(({ exitCode, signal }) => {
      // Saída de um PTY que parar() já tinha largado: o kill é assíncrono, e o
      // evento chega depois que a sessão pode ter subido outro PTY (suspensa e
      // acordada logo em seguida, ou revive). Tratar como saída "do atual"
      // apagaria o PTY novo e marcaria a sessão como caída.
      if (this.proc !== esteProc) {
        log.info(this.a("pty"), `PTY antigo (pid ${esteProc.pid}) terminou depois de ter sido encerrado de propósito (código ${exitCode})`);
        return;
      }
      this.aoSair(exitCode, signal);
    });

    // Rede de segurança do boot: se nenhum hook chegar (settings recusado, versão
    // do CLI sem hooks), o agente não pode ficar preso em "spawning" para sempre.
    setTimeout(() => {
      if (this.estado.status !== "spawning") return;
      // Um agente sem credencial não está `idle`: ele está parado numa tela de
      // login. Dizer `idle` aqui foi o que fez o painel mentir por horas.
      const semLogin = this.motivoDeNaoSubir();
      if (semLogin) {
        this.mudar({ status: "errored", error: semLogin, statusReason: "runner:sem-login" });
        return;
      }
      this.mudar({ status: "idle", statusReason: "runner:boot-timer 8s" });
    }, 8_000).unref();
  }

  /** Encerra o PTY sem matar o serviço. O agente fica `resumable` se tem sessão
   *  para voltar: é o estado que faz o painel mostrar o botão de acordar em vez
   *  de dizer que a plataforma sumiu. */
  parar(motivo: string, statusReason?: string): void {
    if (!this.proc) return;
    this.encerrando = true;
    try {
      this.proc.kill();
    } catch (err) {
      log.aviso(this.a("pty"), `kill do pid ${this.proc.pid} reclamou: ${err instanceof Error ? err.message : err}`);
    }
    this.proc = null;
    this.encerrando = false;
    this.mudar({
      status: this.estado.sessionId ? "resumable" : "stopped",
      statusReason: statusReason ?? `runner:parado ${motivo}`,
    });
  }

  /** Dorme uma sessão PARALELA para devolver memória. Ela fica `resumable` e a
   *  conversa continua no disco: o próximo input a acorda com --resume. A
   *  principal nunca dorme, porque é a conversa do cliente. */
  suspender(motivo: string): boolean {
    if (this.papel !== "paralela") {
      log.erro(
        this.a("pty"),
        `pedido de suspender a sessão principal ${this.descritor.id} (${motivo})`,
        "a principal fica sempre acordada; só sessões paralelas são suspensas",
      );
      return false;
    }
    if (!this.proc) return false;
    if (this.filaQuandoIdle.length) {
      log.aviso(
        this.a("entrada"),
        `suspendendo com ${this.filaQuandoIdle.length} texto(s) ainda na fila; eles ficam guardados e saem na próxima vez que a sessão acordar e ficar ociosa`,
      );
    }
    this.parar(motivo, `runner:suspensa ${motivo}`);
    return true;
  }

  private aoSair(exitCode: number, signal?: number): void {
    log.info(this.a("pty"), `PTY saiu (código ${exitCode}${signal ? `, sinal ${signal}` : ""})`);
    this.proc = null;
    this.cancelarStopPendente();
    const retomada = this.retomando;
    this.retomando = null;
    if (this.encerrando) return;

    // A retomada que morre na largada. O caso real: o transcript daquela sessão
    // não existe (ou não abre), e o CLI sai com código 1 em dois segundos. Sem
    // este ramo o agente ficaria `resumable` para sempre e o `Restart=always`
    // não ajudaria, porque quem está de pé é o runner, não o PTY. Para o cliente
    // isso é o agente simplesmente mudo.
    //
    // A saída é subir uma sessão NOVA, guardando a que não abriu em
    // `previousSessionId`: a conversa antiga continua no disco e pode ser
    // reapontada depois. Perder o histórico é ruim; ficar sem agente é pior, e
    // só um dos dois é reversível.
    if (
      retomada &&
      exitCode !== 0 &&
      Date.now() - retomada.em < RESUME_MORREU_CEDO_MS &&
      !this.retomadasQueFalharam.has(retomada.sessionId)
    ) {
      this.retomadasQueFalharam.add(retomada.sessionId);
      log.erro(
        this.a("pty"),
        `a sessão ${retomada.sessionId} não abriu: o claude saiu com código ${exitCode} em ` +
          `${Math.round((Date.now() - retomada.em) / 1000)}s. A causa quase sempre é o transcript ` +
          `dela não estar no disco (~/.claude/projects/<pasta>/${retomada.sessionId}.jsonl)`,
        `estou subindo uma sessão NOVA para o agente não ficar mudo, e guardando a antiga em ` +
          `previousSessionId (nada foi apagado). Para investigar: conferir se o arquivo existe e ` +
          `se este serviço tem permissão de leitura nele`,
      );
      this.subir("nova").catch((err) =>
        log.erro(
          this.a("pty"),
          `nem a sessão nova subiu: ${err instanceof Error ? err.message : err}`,
          "conferir o executável claude e a casa do agente; o serviço vai continuar tentando a cada restart",
        ),
      );
      return;
    }

    // Saída não pedida. `resumable` e não `errored`: a conversa continua no
    // disco e o botão de acordar tem que aparecer. `errored` mandaria o painel
    // mostrar falha onde há só um terminal fechado.
    this.mudar({
      status: this.estado.sessionId ? "resumable" : "stopped",
      statusReason: `runner:pty-saiu codigo=${exitCode}`,
      error: exitCode === 0 ? null : `o processo claude saiu com código ${exitCode}`,
    });
  }

  // --- entrada ---------------------------------------------------------------

  escrever(texto: string): void {
    if (!this.proc) {
      log.aviso(this.a("entrada"), `descartei ${texto.length} caracteres: não há PTY vivo`);
      return;
    }
    this.marcarAtividade();
    this.proc.write(texto);
  }

  /**
   * Digita e ENVIA. Espera a fila de colagem drenar antes do Enter, que é o
   * detalhe que separa "funciona" de "digita o prompt e não envia": acima de
   * 256 caracteres o texto vai em pedaços, e um Enter cedo demais é tratado como
   * parte da colagem e vira quebra de linha dentro do campo.
   */
  async digitarEEnviar(texto: string): Promise<void> {
    if (!this.proc) throw new Error("não há terminal vivo para digitar");
    this.marcarAtividade();
    if (texto.length <= 256) {
      this.proc.write(texto);
      await new Promise((r) => setTimeout(r, 60));
      await this.enviarComRecibo();
      return;
    }
    await new Promise<void>((resolve) => {
      let i = 0;
      const passo = () => {
        if (!this.proc) return resolve();
        this.proc.write(texto.slice(i, i + PEDACO));
        i += PEDACO;
        if (i >= texto.length) {
          // Uma folga depois do último pedaço: o TUI ainda está processando o
          // burst quando o write retorna.
          setTimeout(resolve, 120);
          return;
        }
        setTimeout(passo, INTERVALO_MS);
      };
      passo();
    });
    await this.enviarComRecibo();
  }

  /** O Enter, com recibo.
   *
   *  Por que não basta escrever "\r": o Enter que chega logo depois de um burst
   *  grande às vezes alcança o TUI enquanto ele ainda está juntando o texto colado,
   *  e vira quebra de linha em vez de envio. O texto fica escrito na caixa de
   *  entrada, ninguém abre turno nenhum, e o POST /input já respondeu 200 — que é a
   *  pior forma de falhar: silenciosa e com cara de sucesso. Visto em campo em
   *  25/08/2026, num poke de 293 caracteres; o MESMO texto passou na tentativa
   *  seguinte, então é corrida, e corrida não se resolve aumentando a espera.
   *
   *  O recibo é o hook UserPromptSubmit, que só dispara quando o Claude ACEITOU o
   *  prompt. Sem recibo, batemos na tecla de novo. Um Enter a mais numa caixa já
   *  vazia é inofensivo (o TUI ignora linha vazia); um Enter a menos perde o poke.  */
  private async enviarComRecibo(): Promise<void> {
    for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
      if (!this.proc) return;
      const antes = this.promptsAceitos;
      this.proc.write("\r");
      const recebeu = await this.esperarRecibo(antes, RECIBO_ENTER_MS);
      if (recebeu) return;
      log.info(
        this.a("entrada"),
        `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${RECIBO_ENTER_MS}ms; batendo na tecla de novo`,
      );
    }
    // Não dá para consertar daqui, mas dá para NÃO mentir: quem lê o log precisa
    // saber que o texto está na caixa e que ninguém vai processá-lo.
    log.erro(
      this.a("entrada"),
      `digitei ${RECIBO_ENTER_TENTATIVAS} Enters e nenhum abriu turno: o texto ficou escrito na caixa de entrada do agente`,
      "olhar a tela (GET /api/agents/:id/terminal) e dar um Enter à mão, ou reenviar por POST /api/agents/:id/input",
    );
  }

  /** Espera o contador de prompts aceitos passar de `antes`. Sem hook vivo (agente
   *  sem hooks registrados) não existe recibo possível: aí damos o benefício da
   *  dúvida e voltamos true, para não bater na tecla três vezes à toa. */
  private esperarRecibo(antes: number, limiteMs: number): Promise<boolean> {
    if (!this.hooksVivos) return Promise.resolve(true);
    return new Promise((resolve) => {
      const inicio = Date.now();
      const olhar = () => {
        if (this.promptsAceitos > antes) return resolve(true);
        if (Date.now() - inicio >= limiteMs) return resolve(false);
        setTimeout(olhar, 100);
      };
      olhar();
    });
  }

  /** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
   *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
   *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
  enfileirarQuandoOcioso(texto: string): void {
    this.marcarAtividade();
    this.filaQuandoIdle.push(texto);
    log.info(
      this.a("entrada"),
      `${texto.length} caracteres enfileirados para quando ficar ocioso (fila: ${this.filaQuandoIdle.length})`,
    );
    this.talvezSoltarFila();
  }

  /** Solta UM item por vez: o próximo sai no próximo idle, depois que o turno do
   *  anterior terminar. Soltar a fila toda de uma vez empilharia vários prompts
   *  no mesmo turno. */
  private talvezSoltarFila(): void {
    if (!this.filaQuandoIdle.length || !this.proc || this.soltandoFila) return;
    const desdeSpawn = Date.now() - this.spawnEm;
    if (desdeSpawn < JANELA_DE_PRONTIDAO_MS) {
      const quieto = this.ultimaSaidaEm ? Date.now() - this.ultimaSaidaEm : Infinity;
      if (desdeSpawn < PRONTO_APOS_SPAWN_MS || quieto < QUIETO_ANTES_DE_DIGITAR_MS) {
        // O TUI ainda está desenhando: olha de novo daqui a pouco, sem perder a vez.
        if (!this.reolharFila) {
          this.reolharFila = setTimeout(() => {
            this.reolharFila = null;
            this.talvezSoltarFila();
          }, 400);
          this.reolharFila.unref();
        }
        return;
      }
    }
    if (this.estado.status !== "idle") return;
    const texto = this.filaQuandoIdle.shift()!;
    this.soltandoFila = true;
    log.info(
      this.a("entrada"),
      `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${this.filaQuandoIdle.length} na fila)`,
    );
    this.digitarEEnviar(texto)
      .catch((err) =>
        log.erro(
          this.a("entrada"),
          `falhei ao digitar o texto enfileirado: ${err instanceof Error ? err.message : err}`,
          "reenviar pelo POST /api/agents/:id/input",
        ),
      )
      .finally(() => {
        this.soltandoFila = false;
      });
  }

  // --- hooks -----------------------------------------------------------------

  /** Recebe o POST do handler de hook. Nonce errado é descartado em silêncio:
   *  é hook de um PTY já morto, ou de um processo que não é este. */
  receberHook(payload: {
    agentId?: string;
    event?: string;
    nonce?: string;
    sessionId?: string | null;
    toolName?: string | null;
    source?: string | null;
  }): { ok: boolean; motivo?: string } {
    if (!payload.agentId || !payload.event) return { ok: false, motivo: "faltou agentId ou event" };
    if (payload.agentId !== this.descritor.id) return { ok: false, motivo: "agentId de outro agente" };
    if (!this.nonce || payload.nonce !== this.nonce) return { ok: false, motivo: "nonce de um spawn antigo" };

    // O session_id do evento é a fonte mais confiável que existe: vem do próprio
    // CLI. É assim que o runner descobre quando o agente trocou de sessão por
    // dentro (um `/resume` digitado no TUI), caso em que o id que guardamos
    // ficaria apontando para uma conversa que ninguém mais escreve.
    if (payload.sessionId && payload.sessionId !== this.estado.sessionId) {
      log.info(this.a("hook"), `a sessão viva mudou por dentro: ${this.estado.sessionId} -> ${payload.sessionId}`);
      this.mudar({
        sessionId: payload.sessionId,
        previousSessionId: this.estado.sessionId ?? this.estado.previousSessionId ?? null,
      });
    }

    if (["UserPromptSubmit", "PreToolUse", "Stop", "PreCompact"].includes(payload.event)) this.marcarAtividade();
    this.hooksVivos = true;
    if (!this.estado.hookActive) this.estado.hookActive = true;

    // Estado terminal não é mexido por hook: quem manda no fim é o onExit do PTY.
    if (this.estado.status === "stopped" || this.estado.status === "resumable" || this.estado.status === "errored") {
      return { ok: true };
    }

    switch (payload.event) {
      case "SessionStart":
        // O fim do compact chega aqui, como SessionStart com source=compact, e é o
        // único sinal de fim que ele dá. Sem este ramo o PreCompact deixava o agente
        // em working para sempre e a fila de ocioso nunca soltava: um agente de cliente passou 8
        // dias assim (02/09 a 11/09/2026) com o /api/saude dizendo ok. Se o compact
        // foi o automático no meio de um turno, o PreToolUse seguinte cancela.
        if (payload.source === "compact") {
          log.info(this.a("hook"), "fim do compact (SessionStart source=compact): volto para idle depois da janela quieta");
          this.agendarStop();
        }
        if (this.estado.status === "spawning") this.mudar({ status: "idle", statusReason: "hook:SessionStart" });
        break;
      case "UserPromptSubmit":
        this.cancelarStopPendente();
        // O contador é o RECIBO do Enter: é a única prova, vinda do próprio Claude,
        // de que o texto virou turno em vez de ficar escrito na caixa. Quem espera
        // por ele é o enviarComRecibo().
        this.promptsAceitos += 1;
        this.mudar({ status: "working", hookLatched: false, statusReason: "hook:UserPromptSubmit" });
        break;
      case "PreToolUse":
        this.cancelarStopPendente();
        if (this.estado.status !== "working") {
          this.mudar({
            status: "working",
            hookLatched: false,
            currentTool: payload.toolName ?? null,
            statusReason: `hook:PreToolUse ${payload.toolName ?? ""}`,
          });
        } else if (payload.toolName && payload.toolName !== this.estado.currentTool) {
          this.mudar({ currentTool: payload.toolName });
        }
        break;
      case "Notification":
        // Só registramos matcher=permission_prompt, então este evento é sempre
        // "parou para pedir autorização".
        if (this.estado.status !== "waiting_input") {
          this.mudar({
            status: "waiting_input",
            hookLatched: false,
            statusReason: "hook:Notification permission_prompt",
          });
        }
        break;
      case "PreCompact":
        // O compact é o único trabalho que começa e não termina em Stop. Quem
        // devolve o agente para idle é o SessionStart source=compact, lá em cima.
        this.cancelarStopPendente();
        this.mudar({ status: "working", hookLatched: false, statusReason: "hook:PreCompact" });
        break;
      case "Stop":
        this.agendarStop();
        break;
      default:
        log.debug(this.a("hook"), `evento sem tratamento: ${payload.event}`);
    }
    return { ok: true };
  }

  private agendarStop(): void {
    this.cancelarStopPendente();
    this.stopPendente = setTimeout(() => {
      this.stopPendente = null;
      if (this.estado.status === "working") {
        this.mudar({
          status: "idle",
          hookLatched: true,
          currentTool: null,
          statusReason: `hook:Stop confirmado (${STOP_CONFIRM_MS / 1000}s quieto)`,
        });
      }
      this.talvezSoltarFila();
    }, STOP_CONFIRM_MS);
    this.stopPendente.unref();
  }

  private cancelarStopPendente(): void {
    if (this.stopPendente) {
      clearTimeout(this.stopPendente);
      this.stopPendente = null;
    }
  }

  // --- terminal --------------------------------------------------------------

  private aoReceberDados(dados: string): void {
    this.ultimaSaidaEm = Date.now();
    this.buffer.push(dados);
    this.bufferBytes += dados.length;
    while (this.bufferBytes > BUFFER_MAX && this.buffer.length > 1) {
      this.bufferBytes -= this.buffer.shift()!.length;
    }
    this.seq += 1;
    this.emit("terminal", dados, this.seq);

    // Fallback de ocioso, e SÓ quando não há hook vivo. Com hooks funcionando,
    // deixar o regex mandar traria de volta o falso "ocioso" no meio de um turno
    // longo, que é o motivo de os hooks existirem.
    if (!this.hooksVivos && this.estado.status === "spawning") {
      if (semAnsi(dados).includes("? for shortcuts")) {
        this.mudar({ status: "idle", statusReason: "pty:? for shortcuts (sem hooks)" });
      }
    }
  }

  // --- estado ----------------------------------------------------------------

  private mudar(campos: Partial<AgentState>): void {
    Object.assign(this.estado, campos, { updatedAt: Date.now() });
    if ("sessionId" in campos || "previousSessionId" in campos || "status" in campos) {
      gravarEstado(
        {
          sessionId: this.estado.sessionId,
          previousSessionId: this.estado.previousSessionId ?? null,
          status: this.estado.status,
        },
        this.arquivoDeEstado,
      );
    }
    if (campos.status) {
      log.info(this.a("estado"), `${campos.status}${campos.statusReason ? ` (${campos.statusReason})` : ""}`);
    }
    this.emit("estado", this.estado);
    if (campos.status === "idle") this.talvezSoltarFila();
  }

  // --- montagem do spawn -----------------------------------------------------

  private pastaDeHooks(): string {
    // Ao lado do descritor, e não em /tmp: um settings apagado pela limpeza de
    // /tmp deixaria o agente sem hook de status no meio da vida, e o sintoma
    // seria um agente eternamente "trabalhando".
    return path.join(path.dirname(process.env.RUNNER_AGENT_FILE || os.tmpdir()), "runner-hooks");
  }

  private escreverSettings(): string | null {
    try {
      const dir = this.pastaDeHooks();
      fs.mkdirSync(dir, { recursive: true });
      const handler = path.join(dir, "runner-hook.mjs");
      const atual = fs.existsSync(handler) ? fs.readFileSync(handler, "utf8") : "";
      if (atual !== HOOK_HANDLER_SOURCE) fs.writeFileSync(handler, HOOK_HANDLER_SOURCE, "utf8");

      this.nonce = randomUUID();
      const cfg = this.descritor.config;
      const base = `"${process.execPath}" "${handler}" --agent ${this.descritor.id} --port ${this.porta} --nonce ${this.nonce}`;
      const para = (ev: string, matcher = "") => [
        { matcher, hooks: [{ type: "command", command: `${base} --event ${ev}` }] },
      ];
      const stop = [{ type: "command", command: `${base} --event Stop` }];
      for (const extra of cfg.stopHooks ?? []) {
        if (typeof extra === "string" && extra.trim()) {
          stop.push({ type: "command", command: extra.trim() });
        } else {
          log.erro(
            this.a("hook"),
            `stopHooks tem um item que não é texto: ${JSON.stringify(extra)}`,
            "corrigir stopHooks no descritor do agente; sem a trava de fim de turno o canal " +
              "escreve a resposta como texto e quem está do outro lado vê uma janela muda",
          );
        }
      }
      // O hook do runner vem sempre primeiro; os promptHooks só entram quando
      // existem, e sem eles o settings fica idêntico ao de antes.
      const prompt = para("UserPromptSubmit");
      for (const extra of this.promptHooks) {
        if (typeof extra === "string" && extra.trim()) {
          prompt[0].hooks.push({ type: "command", command: extra.trim() });
        } else {
          log.erro(
            this.a("hook"),
            `promptHooks tem um item que não é texto: ${JSON.stringify(extra)}`,
            "corrigir promptHooks no descritor; o comando é ignorado e o resto dos hooks segue",
          );
        }
      }
      const settings: Record<string, unknown> = {
        hooks: {
          SessionStart: para("SessionStart"),
          UserPromptSubmit: prompt,
          PreToolUse: para("PreToolUse"),
          Notification: para("Notification", "permission_prompt"),
          PreCompact: para("PreCompact"),
          Stop: [{ matcher: "", hooks: stop }],
        },
      };
      const limpar = (r?: string[] | null) =>
        (r ?? []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
      const allow = limpar(cfg.allowTools);
      const ask = limpar(cfg.askTools);
      const deny = limpar(cfg.denyTools);
      if (allow.length || ask.length || deny.length) {
        settings.permissions = {
          ...(deny.length ? { deny } : {}),
          ...(ask.length ? { ask } : {}),
          ...(allow.length ? { allow } : {}),
        };
      }
      const arquivo = path.join(dir, `${this.descritor.id}.settings.json`);
      fs.writeFileSync(arquivo, JSON.stringify(settings), "utf8");
      log.info(this.a("hook"), `settings escrito (${allow.length} allow, ${ask.length} ask, ${deny.length} deny)`);
      return arquivo;
    } catch (err) {
      log.erro(
        this.a("hook"),
        `não consegui escrever o settings de hooks: ${err instanceof Error ? err.message : err}`,
        `o agente vai subir SEM status determinístico e SEM as regras de permissão do ` +
          `descritor, o que é mais permissivo do que o desenhado — conferir permissão de ` +
          `escrita em ${this.pastaDeHooks()} e reiniciar o serviço`,
      );
      return null;
    }
  }

  private argsExtras(): string[] {
    const cfg = this.descritor.config;
    const fora: string[] = [];
    const mcp = cfg.mcpConfig?.trim();
    if (mcp) {
      if (!mcp.startsWith("{") && !fs.existsSync(mcp)) {
        log.erro(
          this.a("spawn"),
          `mcpConfig aponta para um arquivo que não existe: ${mcp}`,
          "o agente sobe SEM os servidores MCP deste arquivo, então a tool de resposta do " +
            "canal não vai existir e a janela de conversa fica muda — corrigir o caminho no descritor",
        );
      } else {
        fora.push("--mcp-config", mcp);
      }
    }
    for (const arg of cfg.extraArgs ?? []) {
      if (typeof arg !== "string" || !arg.length) {
        log.erro(
          this.a("spawn"),
          `extraArgs tem item inválido: ${JSON.stringify(arg)}`,
          "corrigir extraArgs no descritor (só texto não vazio)",
        );
        continue;
      }
      if (arg === "--strict-mcp-config") {
        log.aviso(this.a("spawn"), "--strict-mcp-config recusado: ele derruba todo MCP global dentro do agente");
        continue;
      }
      fora.push(arg);
    }
    const identidade = this.montarIdentidade();
    if (identidade) fora.push("--append-system-prompt-file", identidade);
    return fora;
  }

  /** Junta os arquivos de identidade da sessão paralela num só, a cada spawn (o
   *  dono pode ter editado um deles entre uma subida e outra). Arquivo que falta
   *  é registrado e os outros seguem: uma persona incompleta ainda é melhor que
   *  uma sessão que nem sobe. */
  private montarIdentidade(): string | null {
    if (!this.identidade.length) return null;
    const partes: string[] = [];
    for (const rel of this.identidade) {
      const caminho = path.resolve(this.descritor.config.cwd, rel);
      try {
        partes.push(fs.readFileSync(caminho, "utf8").trim());
      } catch (err) {
        log.erro(
          this.a("spawn"),
          `não consegui ler o arquivo de identidade ${caminho}: ${err instanceof Error ? err.message : err}`,
          "conferir o caminho em identidade no descritor (relativo à casa do agente); a sessão sobe sem esse trecho",
        );
      }
    }
    if (!partes.length) return null;
    try {
      const dir = this.pastaDeHooks();
      fs.mkdirSync(dir, { recursive: true });
      const arquivo = path.join(dir, `${this.descritor.id}.identidade.md`);
      fs.writeFileSync(arquivo, partes.join("\n\n---\n\n"), "utf8");
      return arquivo;
    } catch (err) {
      log.erro(
        this.a("spawn"),
        `não consegui gravar a identidade concatenada: ${err instanceof Error ? err.message : err}`,
        `conferir permissão de escrita em ${this.pastaDeHooks()}; a sessão sobe sem a identidade`,
      );
      return null;
    }
  }

  private aplicarEnvExtra(ambiente: Record<string, string>): void {
    const extra = this.descritor.config.envExtra;
    if (!extra || typeof extra !== "object") return;
    const aplicadas: string[] = [];
    const recusadas: string[] = [];
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || CHAVES_QUE_NAO_PASSAM.has(k)) {
        recusadas.push(k);
        continue;
      }
      ambiente[k] = v;
      aplicadas.push(k);
    }
    // Só os NOMES vão para o log, nunca os valores.
    if (aplicadas.length) log.info(this.a("env"), `envExtra aplicado: ${aplicadas.join(", ")}`);
    if (recusadas.length) {
      log.erro(
        this.a("env"),
        `envExtra recusado: ${recusadas.join(", ")}`,
        "nome inválido, valor que não é texto, ou chave de LLM que nenhum agente recebe em claro",
      );
    }
  }

  /** Marca a casa como confiável ANTES do PTY subir. Sem isto, na primeira vez
   *  numa pasta o CLI abre "Do you trust the files in this folder?", e o primeiro
   *  texto digitado cai dentro do diálogo e se perde. */
  private confiarNaPasta(cwd: string, configDir?: string): void {
    try {
      const casa = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || os.homedir();
      const arquivo = path.join(casa, ".claude.json");
      const atual = fs.existsSync(arquivo)
        ? (JSON.parse(fs.readFileSync(arquivo, "utf8")) as Record<string, unknown>)
        : {};
      const projetos = ((atual as Record<string, Record<string, Record<string, unknown>>>).projects ??= {});
      const proj = (projetos[cwd] ??= {});
      if (proj.hasTrustDialogAccepted === true) return;
      proj.hasTrustDialogAccepted = true;
      fs.writeFileSync(arquivo, JSON.stringify(atual, null, 2));
      log.info(this.a("spawn"), `casa ${cwd} marcada como confiável em ${arquivo}`);
    } catch (err) {
      log.aviso(
        this.a("spawn"),
        `não consegui marcar ${cwd} como confiável (${err instanceof Error ? err.message : err}); ` +
          `se o CLI abrir o diálogo de confiança, a primeira mensagem enviada vai se perder dentro dele`,
      );
    }
  }
}
