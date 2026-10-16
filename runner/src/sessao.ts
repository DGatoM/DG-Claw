// A sessão viva do agente: o PTY, o estado e a máquina de status.
//
// Este arquivo é a parte do `agent-manager.ts` do Bunker que um agente ENTREGUE
// realmente usa, reescrita para viver sozinha. O que ficou de fora, e por quê:
// worktree, geometria por aparelho, handoff, mestre, board e o cofre. Um agente de
// cliente não faz nada disso, e cada um deles arrastaria uma dependência do Bunker
// para dentro de uma máquina onde Bunker não existe.
//
// O CLI que roda dentro do PTY é escolhido por sessão (Claude Code ou Codex): o que
// muda de um para o outro mora em `provedores/` (um Motor por CLI). Aqui fica o que
// é igual nos dois.
//
// O que foi mantido igual, porque é contrato e não estilo:
//   - `--session-id <uuid>` no spawn novo e `--resume <uuid>` na retomada (Claude);
//   - o `--settings` por spawn com os hooks de status e as regras de permissão (Claude);
//   - a fila de colagem antes do Enter (o bug histórico do "digita mas não envia");
//   - os nomes de status (`spawning`, `idle`, `working`, `waiting_input`,
//     `stopped`, `resumable`, `errored`), que o painel da pessoa já lê.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import pty from "node-pty";
import type { AgentState } from "./tipos.js";
import { log } from "./logger.js";
import { HOOK_HANDLER_SOURCE } from "./hook-handler-source.js";
import { gravarEstado, lerEstado, PASTA_DE_ESTADO, STATE_FILE, type ConfigDoRunner } from "./config-runner.js";
import { montarAmbiente, nomesDoCofre, type ResultadoDoAmbiente } from "./provedores/ambiente.js";
import { caminhoDaFila, carregarFila, gravarFila, type ItemDaFila } from "./fila-ocioso.js";
import { MascaraDeFluxo, segredosConhecidos } from "./mascara.js";
import type { Catalogo } from "./provedores/catalogo.js";
import { lerCanais, pastaTelegramDesligado } from "./provedores/canais.js";
import { codexHomeDe } from "./provedores/codex.js";
import { acharRolloutPorId, descobrirRollout, vigiarRollout, type EventoInterno } from "./provedores/codex-rollout.js";
import {
  gravarProvedorJson,
  resolverEscolha,
  type CamposDeEscolha,
  type Escolha,
  type EscolhaEfetiva,
  type SaidaDaEscolha,
} from "./provedores/escolha.js";
import { ErroDeMotor, redigirArgs, type CtxMotor, type Motor, type Recusa } from "./provedores/motor.js";
import { motorDe } from "./provedores/motores.js";

/** Quanto da tela guardamos para quem chegar depois (o painel pede o buffer ao abrir). */
const BUFFER_MAX = 200 * 1024;
/** O Stop dispara no fim de TODO turno, inclusive intermediário. Só vira
 *  "concluído" depois de tanto tempo quieto. Mesmo valor do Bunker. */
const STOP_CONFIRM_MS = 6_000;
/** Colagem: pedaços de 128 a cada 25ms, e o Enter só depois de drenar. */
const PEDACO = 128;
const INTERVALO_MS = 25;
/** Quantas vezes batemos no Enter se ele não virar turno. Quanto esperar pelo recibo
 *  depende do motor (Motor.reciboMs). Ver enviarComRecibo(). */
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
/** A máscara de segredo retém o final do que pode ser começo de segredo. Passado este silêncio
 *  ela é descarregada, senão o fim da linha ficaria preso na tela. */
const SILENCIO_DA_MASCARA_MS = 50;
/** Motor sem SessionStart (Codex): a tela quieta por este tempo é o "pronto". */
const QUIETO_DE_BOOT_MS = 1_500;
/** Depois deste tempo sem rollout, o Codex provavelmente nem abriu a conversa. */
const ROLLOUT_AUSENTE_MS = 60_000;

const ESC = "\u001b";
const RE_ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

function semAnsi(s: string): string {
  return s.replace(RE_ANSI, "");
}

/** O menu de confiança de pasta do Codex, olhando só o fim da tela (a tela velha pode ainda estar no buffer).
 *
 *  O buffer é o fluxo bruto do PTY, e o Codex redesenha com movimento de cursor, quase sem quebra de
 *  linha: um menu JÁ respondido continua nas últimas "linhas". Por isso o menu só conta se for a
 *  ÚLTIMA coisa desenhada. Na tela real do B6 (12/10/2026), depois de "Trust and continue" vinha só
 *  "2. Quit enter continue · esc quit"; depois de responder, vêm o rodapé e o prompt, bem mais longos.
 *  Errar para o lado do "tem menu" mandaria um "1" como turno a cada mensagem. */
export function telaDeConfiancaDoCodex(tela: string): boolean {
  const fim = semAnsi(tela).split(/\r?\n/).slice(-40).join("\n");
  if (!/Trust this folder\?/.test(fim)) return false;
  const i = fim.lastIndexOf("Trust and continue");
  if (i < 0) return false;
  const depois = fim.slice(i + "Trust and continue".length).replace(/\s+/g, "");
  return depois.length <= 60;
}

/** O nonce autentica os eventos de status de UM spawn. Comparação em tempo constante:
 *  tamanhos diferentes são recusados antes (o `timingSafeEqual` exige o mesmo tamanho). */
export function nonceConfere(esperado: string | null, recebido: unknown): boolean {
  if (!esperado || typeof recebido !== "string") return false;
  const a = Buffer.from(esperado);
  const b = Buffer.from(recebido);
  return a.length === b.length && timingSafeEqual(a, b);
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
  /** A pasta onde o runner GRAVA (runner-hooks/, provedor.json da principal). Padrão: PASTA_DE_ESTADO. */
  pastaDeEstado?: string;
  papel?: "principal" | "paralela";
  tipo?: string;
  chat?: string;
  titulo?: string;
  /** Comandos extras do evento UserPromptSubmit, depois do hook do runner. */
  promptHooks?: string[];
  ociosoMinutos?: number;
  /** Arquivos de identidade (relativos ao cwd) concatenados a cada spawn. */
  identidade?: string[];
  /** provider/model/auth da sessão paralela no descritor (nível 2 da escolha de provedor). */
  escolhaDescrita?: CamposDeEscolha;
  /** Ids de sessão do Codex que OUTRAS sessões deste runner já reivindicaram. */
  idsEmUso?: () => ReadonlySet<string>;
}

export class Sessao extends EventEmitter {
  private proc: pty.IPty | null = null;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private seq = 0;
  private nonce: string | null = null;
  private hooksVivos = false;
  /** Quantos prompts o CLI já ACEITOU (hook UserPromptSubmit no Claude; `task_started` ou o
   *  nascimento do rollout no Codex). É o recibo do Enter; ver enviarComRecibo(). */
  private promptsAceitos = 0;
  private stopPendente: NodeJS.Timeout | null = null;
  /** A máscara de segredo do spawn atual e o relógio que a descarrega no silêncio. */
  private mascaraAtual: MascaraDeFluxo | null = null;
  private descargaDaMascara: NodeJS.Timeout | null = null;
  private quietoDeBoot: NodeJS.Timeout | null = null;
  private ultimaSaidaEm: number | null = null;
  private encerrando = false;
  /** Fila FIFO de textos para digitar quando o agente ficar ocioso. Era uma vaga
   *  só (o segundo texto apagava o primeiro, e a mensagem do cliente sumia). Cada
   *  mudança é espelhada em disco (ver fila-ocioso.ts), para um reinício do runner
   *  não perder um texto que já foi aceito com 202. */
  private filaQuandoIdle: ItemDaFila[] = [];
  private readonly arquivoDaFila: string;
  /** O item que está sendo digitado agora. Continua no disco até a digitação terminar:
   *  se o runner cair no meio, o texto sai de novo no próximo boot (repetir uma
   *  mensagem é melhor que perder a de um cliente). */
  private itemEmVoo: ItemDaFila | null = null;
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

  /** O motor e a escolha do último spawn (ou a resolvida no construtor, antes do primeiro). */
  private motor: Motor;
  private escolhaVigente: EscolhaEfetiva;
  /** O contexto do último spawn: dele saem o ambiente e a checagem de login/chave. */
  private ctxVivo: CtxMotor | null = null;
  private modoDoUltimoSpawn: "retomar" | "nova" | null = null;

  readonly estado: AgentState;
  readonly papel: "principal" | "paralela";
  readonly tipo: string | null;
  readonly chat: string | null;
  readonly titulo: string | null;
  readonly ociosoMinutos: number | null;
  readonly pastaDeEstado: string;
  private readonly arquivoDeEstado: string;
  private readonly promptHooks: string[];
  private readonly identidade: string[];
  private readonly escolhaDescrita: CamposDeEscolha | undefined;
  private readonly idsEmUso: () => ReadonlySet<string>;

  constructor(
    private readonly descritor: IdentidadeDaSessao,
    private readonly porta: number,
    opcoes: OpcoesDaSessao = {},
  ) {
    super();
    this.papel = opcoes.papel ?? "principal";
    this.tipo = opcoes.tipo ?? null;
    this.chat = opcoes.chat ?? null;
    this.titulo = opcoes.titulo ?? null;
    this.ociosoMinutos = opcoes.ociosoMinutos ?? null;
    this.arquivoDeEstado = opcoes.arquivoDeEstado ?? STATE_FILE;
    this.pastaDeEstado = opcoes.pastaDeEstado ?? PASTA_DE_ESTADO;
    this.arquivoDaFila = caminhoDaFila(this.pastaDeEstado, descritor.id);
    this.filaQuandoIdle = carregarFila(this.arquivoDaFila, this.a("fila"));
    if (this.filaQuandoIdle.length) {
      log.info(
        this.a("fila"),
        `${this.filaQuandoIdle.length} texto(s) voltaram do disco (${this.arquivoDaFila}) e saem quando a sessão ficar ociosa`,
      );
    }
    this.promptHooks = opcoes.promptHooks ?? descritor.config.promptHooks ?? [];
    this.identidade = opcoes.identidade ?? [];
    this.escolhaDescrita = opcoes.escolhaDescrita;
    this.idsEmUso = opcoes.idsEmUso ?? (() => new Set());
    const inicial = this.lerEscolha();
    this.escolhaVigente = inicial.escolha;
    this.motor = motorDe(inicial.escolha.provedor);
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

  get config(): ConfigDoRunner {
    return this.descritor.config;
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

  /** O CODEX_HOME do último spawn (o que `preparar` pôs no ambiente); null no Claude e antes do primeiro spawn. */
  private codexHomeUsado: string | null = null;

  codexHome(): string | null {
    return this.codexHomeUsado;
  }

  telaInteira(): string {
    return this.buffer.join("");
  }

  /** Os valores do cofre que não podem aparecer na tela nem no histórico. */
  segredosParaMascara(): string[] {
    return segredosConhecidos(nomesDoCofre());
  }

  quandoFalouPorUltimo(): number | null {
    return this.ultimaSaidaEm;
  }

  /** Com que modo o último spawn subiu (pode ser "nova" mesmo tendo sido pedido "retomar"). */
  ultimoModo(): "retomar" | "nova" | null {
    return this.modoDoUltimoSpawn;
  }

  // --- provedor --------------------------------------------------------------

  /** O provedor.json desta sessão: principal em `<pasta de estado>/provedor.json`,
   *  paralela em `<pasta de estado>/sessoes/<id>/provedor.json`. */
  arquivoDoProvedor(): string {
    return path.join(path.dirname(this.arquivoDeEstado), "provedor.json");
  }

  /** O CODEX_HOME usado pelo runner para listar modelos: o do envExtra, o do ambiente ou o padrão. */
  private codexHomeParaModelos(): string | undefined {
    return this.descritor.config.envExtra?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || undefined;
  }

  /** Resolve a escolha efetiva AGORA (lê provedor.json e o catálogo do disco). Não registra nada. */
  lerEscolha(): SaidaDaEscolha {
    const cfg = this.descritor.config;
    return resolverEscolha({
      arquivoProvedor: this.arquivoDoProvedor(),
      sessao: this.escolhaDescrita,
      config: { provider: cfg.provider, model: cfg.model, auth: cfg.auth },
      codexHome: this.codexHomeParaModelos(),
    });
  }

  /** A escolha do último spawn (ou a resolvida no construtor, antes do primeiro). */
  escolhaAtual(): EscolhaEfetiva {
    return this.escolhaVigente;
  }

  /** Grava a escolha no provedor.json desta sessão. Não reinicia nada. */
  definirEscolha(e: Escolha): void {
    gravarProvedorJson(this.arquivoDoProvedor(), e);
    log.info(this.a("escolha"), `provedor definido: ${e.provedor}, ${e.auth}${e.modelo ? `, modelo ${e.modelo}` : ""}`);
  }

  /** O ambiente que o spawn de `escolha` usaria, sem efeito colateral nenhum (serve à conferência). */
  ambienteDaEscolha(escolha: Escolha, catalogo: Catalogo): ResultadoDoAmbiente & { codexHome: string | null } {
    const amb = this.montarAmbienteBase(escolha, catalogo);
    let codexHome: string | null = null;
    if (escolha.provedor === "codex") {
      codexHome = codexHomeDe({ auth: escolha.auth, env: amb.env, cwd: this.descritor.config.cwd, id: this.id });
      amb.env.CODEX_HOME = codexHome;
    }
    return { ...amb, codexHome };
  }

  private montarAmbienteBase(escolha: Escolha, catalogo: Catalogo): ResultadoDoAmbiente {
    const cfg = this.descritor.config;
    const amb = montarAmbiente({
      base: process.env,
      envExtra: cfg.envExtra,
      provedor: escolha.provedor,
      auth: escolha.auth,
      catalogo,
      cofre: nomesDoCofre(),
    });
    // O que destrava o modo "não pergunte nada" quando o processo é root.
    //
    // O runner roda como root, e o Claude Code recusa QUALQUER forma de pular permissão
    // sob root com "cannot be used with root/sudo privileges for security
    // reasons". Ele não pede nada e não espera: sai com código 1 em segundos, e
    // como quem morre é o PTY e não o serviço, o `Restart=always` da unidade não
    // pega. O agente some sem ninguém entender por quê (custou um agente de cliente fora do ar
    // em 24/08/2026, no primeiro agente em que isto foi ligado).
    //
    // `IS_SANDBOX=1` é a saída que o próprio CLI oferece, e já era o padrão desta
    // casa antes deste arquivo existir. Só entra no modo bypass, de propósito: num
    // agente que ainda pergunta, esta variável não muda nada. O Codex não precisa
    // dela (aceita o flag de bypass como root; testado em 12/10/2026).
    if (escolha.provedor === "claude" && cfg.permissionMode === "bypassPermissions") amb.env.IS_SANDBOX = "1";
    return amb;
  }

  /** O CODEX_HOME desta sessão (onde ficam os rollouts), para o `GET /conversation` do Codex. */
  codexHomeAtual(): string {
    const e = this.escolhaVigente;
    const amb = this.ambienteDaEscolha({ ...e, provedor: "codex" }, this.lerEscolha().catalogo);
    return amb.codexHome as string;
  }

  // --- ciclo de vida ---------------------------------------------------------

  /**
   * Sobe o agente. `modo`:
   *   "retomar" — continua a sessão que já existe (`--resume`). É o caminho de
   *               todo boot do serviço: o cliente não pode perder a conversa
   *               porque a máquina reiniciou.
   *   "nova"    — sessão nova, guardando a anterior em `previousSessionId` para
   *               nada ser perdido sem volta.
   *
   * Devolve o modo com que realmente subiu: "retomar" vira "nova" quando o provedor
   * ou a forma de pagar mudaram desde o último spawn, porque o id da conversa antiga
   * pertence a outro CLI ou a outra conta e não abriria.
   */
  async subir(modo: "retomar" | "nova"): Promise<"retomar" | "nova"> {
    if (this.proc) {
      log.info(this.a("pty"), `pedido de subir ignorado: já existe PTY vivo (pid ${this.proc.pid})`);
      return this.modoDoUltimoSpawn ?? modo;
    }
    this.marcarAtividade();

    const { escolha, problemas, catalogo } = this.lerEscolha();
    for (const p of problemas) log.erro(this.a("escolha"), p.motivo, p.comoResolver);
    const motorMudou = this.motor.provedor !== escolha.provedor;
    this.escolhaVigente = escolha;
    this.motor = motorDe(escolha.provedor);
    if (motorMudou) {
      this.hooksVivos = false;
      this.estado.hookActive = false;
    }

    // O id guardado só abre no CLI e na conta que o criaram. Sem `escolha` gravada (estado
    // de antes desta função existir) o CLI era o Claude.
    const gravada = lerEstado(this.arquivoDeEstado).escolha ?? (this.estado.sessionId ? { provedor: "claude", auth: "", modelo: "" } : null);
    if (
      modo === "retomar" &&
      this.estado.sessionId &&
      gravada &&
      (gravada.provedor !== escolha.provedor || (gravada.auth && gravada.auth !== escolha.auth))
    ) {
      log.info(
        this.a("pty"),
        `o provedor ou a forma de pagar mudou (de ${gravada.provedor}${gravada.auth ? `/${gravada.auth}` : ""} ` +
          `para ${escolha.provedor}/${escolha.auth}): o id ${this.estado.sessionId} é de outro CLI ou de outra conta, ` +
          `então subo uma conversa NOVA e guardo a antiga em previousSessionId`,
      );
      modo = "nova";
    }

    const ctx = this.montarCtx(escolha, catalogo);
    this.ctxVivo = ctx;

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
    //
    // A FALTA DE CHAVE é outro caso: nos modos `api` e `token` não há tela de login
    // para mostrar, e subir o CLI sem a chave o faria cair na assinatura sem ninguém
    // pedir. Aí o PTY NÃO sobe: a sessão fica `errored` com o motivo.
    const recusa = this.motor.motivoSemLogin(ctx);
    if (recusa?.tipo === "chave") {
      // O erro do estado é o que o painel mostra: precisa dizer também o que fazer.
      this.mudar({ status: "errored", error: `${recusa.mensagem} O que fazer: ${recusa.comoResolver}.`, statusReason: "runner:sem-chave" });
      log.erro(this.a("pty"), recusa.mensagem, recusa.comoResolver);
      this.modoDoUltimoSpawn = modo;
      return modo;
    }
    if (recusa) {
      log.erro(this.a("pty"), recusa.mensagem, "logar pelo terminal do cartão; o runner assume assim que a credencial aparecer");
    }

    // O preparo pode demorar (o login por chave do Codex leva alguns segundos): já é `spawning`.
    this.mudar({ status: "spawning", error: null, statusReason: "runner:preparando" });
    try {
      await this.motor.preparar(ctx);
      this.codexHomeUsado = this.motor.provedor === "codex" ? (ctx.env.CODEX_HOME ?? null) : null;
    } catch (err) {
      for (const f of ctx.limpezas) f();
      const erro =
        err instanceof ErroDeMotor
          ? err
          : new ErroDeMotor(
              `O preparo do ${this.motor.binario} falhou: ${err instanceof Error ? err.message : String(err)}`,
              "runner:preparo-falhou",
              "ver o log do runner e tentar de novo",
            );
      this.mudar({ status: "errored", error: erro.message, statusReason: erro.statusReason });
      log.erro(this.a("pty"), erro.message, erro.comoResolver);
      this.modoDoUltimoSpawn = modo;
      return modo;
    }

    let args: string[];
    if (modo === "retomar" && this.estado.sessionId) {
      args = this.motor.argsRetomar(ctx, this.estado.sessionId);
      this.retomando = { sessionId: this.estado.sessionId, em: Date.now() };
      this.mudar({ status: "spawning", error: null, statusReason: "runner:resume" });
      log.info(this.a("pty"), `retomando a sessão ${this.estado.sessionId}`);
    } else {
      this.retomando = null;
      if (modo === "retomar") {
        log.info(this.a("pty"), "não há sessão anterior registrada; subindo uma sessão nova");
      }
      // O Codex não aceita pré-fixar o id: ele é descoberto no rollout depois do spawn.
      const novo = this.motor.provedor === "claude" ? randomUUID() : null;
      ctx.novoId = novo;
      this.mudar({
        status: "spawning",
        error: null,
        sessionId: novo,
        previousSessionId: this.estado.sessionId ?? this.estado.previousSessionId ?? null,
        statusReason: "runner:sessao-nova",
      });
      args = this.motor.argsNova(ctx);
      log.info(
        this.a("pty"),
        `sessão nova ${novo ?? "(o id será descoberto no rollout do Codex)"}` +
          (this.estado.previousSessionId ? ` (anterior guardada: ${this.estado.previousSessionId})` : ""),
      );
    }
    this.modoDoUltimoSpawn = modo;
    await this.spawn(ctx, args);

    // Depois do spawn, e não antes: o `mudar` do spawn põe `spawning`, e este
    // aqui é que fica valendo. Sem isto o boot-timer de 8s marcaria `idle` e o
    // painel voltaria a dizer que está tudo bem.
    if (recusa && this.proc) {
      this.mudar({ status: "errored", error: recusa.mensagem, statusReason: "runner:sem-login" });
      this.esperarLogin();
    }
    return modo;
  }

  /** Monta o contexto de um spawn: ambiente por modo, canal Telegram, identidade e hooks. */
  private montarCtx(escolha: EscolhaEfetiva, catalogo: Catalogo): CtxMotor {
    const cfg = this.descritor.config;
    const amb = this.montarAmbienteBase(escolha, catalogo);
    // Só os NOMES vão para o log, nunca os valores.
    if (amb.aplicadas.length) log.info(this.a("env"), `envExtra aplicado: ${amb.aplicadas.join(", ")}`);
    if (amb.recusadas.length) {
      log.erro(
        this.a("env"),
        `envExtra recusado: ${amb.recusadas.join(", ")}`,
        "nome de variável inválido ou valor que não é texto; corrigir config.envExtra no descritor",
      );
    }
    if (amb.removidas.length) {
      log.info(
        this.a("env"),
        `fora do ambiente (${escolha.provedor}/${escolha.auth}): ` + amb.removidas.map((r) => `${r.nome} (${r.motivo})`).join(", "),
      );
    }

    const env = amb.env;
    const principal = this.papel === "principal";
    let canalTelegram = false;
    // Um agente antigo que já declara `--channels` no extraArgs continua do jeito dele:
    // tirar o TELEGRAM_BOT_TOKEN dele derrubaria um canal que funciona.
    const canalLegado = principal && (cfg.extraArgs ?? []).includes("--channels");
    if (!canalLegado) {
      const canais = principal ? lerCanais(cfg.cwd) : null;
      if (principal && escolha.provedor === "claude" && canais?.telegram.ligado && canais.telegram.estadoDir) {
        env.TELEGRAM_STATE_DIR = canais.telegram.estadoDir;
        canalTelegram = true;
      } else {
        // O plugin faz polling mesmo sem `--channels`. Sem isto uma sessão paralela
        // (ou um Codex) consumiria as mensagens do bot e as jogaria fora.
        delete env.TELEGRAM_BOT_TOKEN;
        env.TELEGRAM_STATE_DIR = pastaTelegramDesligado(cfg.cwd);
        if (principal && escolha.provedor === "codex" && canais?.telegram.ligado) {
          log.aviso(
            this.a("canais"),
            "o canal do Telegram está ligado para este agente, mas o Telegram oficial só existe no Claude; " +
              "com o Codex como provedor o agente conversa pelo painel",
          );
        }
      }
    }

    const nonce = randomBytes(32).toString("hex");
    this.nonce = nonce;
    const identidade = this.montarIdentidade();
    const settings = this.motor.usaHooks ? this.escreverSettings(nonce) : null;

    return {
      id: this.descritor.id,
      slug: this.descritor.slug,
      papel: this.papel,
      porta: this.porta,
      cwd: cfg.cwd,
      config: cfg,
      escolha: { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo },
      catalogo,
      env,
      chaveDoModoPresente: amb.chaveDoModoPresente,
      variavelDoModo: amb.variavelDoModo,
      pastaDeHooks: this.pastaDeHooks(),
      pastaDeEstado: this.pastaDeEstado,
      identidade,
      settings,
      nonce,
      canalTelegram,
      novoId: null,
      extrasDoMotor: [],
      limpezas: [],
      a: (area) => this.a(area),
    };
  }

  /** Um contexto sem efeito colateral, para perguntar "tem login?" antes de qualquer spawn. */
  private ctxLeve(): CtxMotor {
    const { escolha, catalogo } = this.lerEscolha();
    const amb = this.montarAmbienteBase(escolha, catalogo);
    const cfg = this.descritor.config;
    return {
      id: this.descritor.id,
      slug: this.descritor.slug,
      papel: this.papel,
      porta: this.porta,
      cwd: cfg.cwd,
      config: cfg,
      escolha: { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo },
      catalogo,
      env: amb.env,
      chaveDoModoPresente: amb.chaveDoModoPresente,
      variavelDoModo: amb.variavelDoModo,
      pastaDeHooks: this.pastaDeHooks(),
      pastaDeEstado: this.pastaDeEstado,
      identidade: { arquivo: null, texto: null },
      settings: null,
      nonce: "",
      canalTelegram: false,
      novoId: null,
      extrasDoMotor: [],
      limpezas: [],
      a: (area) => this.a(area),
    };
  }

  /**
   * Por que esta sessão não pode conversar agora (falta login ou falta a chave do modo).
   *
   * Existe porque um agente SEM login não falha: ele sobe, o CLI abre a tela
   * de escolha de conta e fica lá, com o PTY vivo e o status `idle`. Do lado de
   * fora tudo parece bem, e quem manda mensagem não recebe nada nem descobre por
   * quê — a mensagem é digitada na tela de login e se perde. Foi assim em
   * 27/08/2026, com o dono esperando resposta de um agente que nunca ia responder.
   */
  recusaDeEntrada(): Recusa | null {
    const motor = this.ctxVivo ? this.motor : motorDe(this.lerEscolha().escolha.provedor);
    return motor.motivoSemLogin(this.ctxVivo ?? this.ctxLeve());
  }

  /** O mesmo motivo como texto (login ou chave), para quem só quer a mensagem. */
  motivoSemLogin(): string | null {
    return this.recusaDeEntrada()?.mensagem ?? null;
  }

  /**
   * Fica de olho até a credencial aparecer, e então sobe sozinho.
   *
   * O login é interativo e acontece FORA deste processo: alguém abre um terminal
   * na casa do agente e escolhe a conta (ou usa o login assistido do painel). Sem
   * isto aqui, o runner ficaria parado para sempre depois de logar, e a pessoa que
   * acabou de logar não teria como saber que ainda falta um passo — que era
   * justamente a reclamação de 27/08.
   *
   * Um minuto entre olhadas, e olhar custa um `stat`.
   */
  private esperarLogin(): void {
    if (this.esperandoLogin) return;
    this.esperandoLogin = setInterval(() => {
      if (this.recusaDeEntrada()) return;
      this.trocarPorSessaoLimpa();
    }, 60_000);
    // Não segura o processo de pé só por causa deste relógio.
    this.esperandoLogin.unref?.();
  }

  private trocarPorSessaoLimpa(): void {
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
  }

  /** Chamado quando o login assistido termina bem. Só age se a sessão estava parada por falta de login. */
  aposLoginConcluido(): void {
    if (this.estado.status === "errored" && this.estado.statusReason === "runner:sem-login") {
      this.trocarPorSessaoLimpa();
    }
  }

  /** O relógio que espera o login aparecer. Nulo quando não há espera em curso. */
  private esperandoLogin: ReturnType<typeof setInterval> | null = null;

  private async spawn(ctx: CtxMotor, args: string[]): Promise<void> {
    const cwd = ctx.cwd;
    const binario = this.motor.binario;

    log.info(this.a("pty"), `subindo: ${binario} ${redigirArgs(args).join(" ")}`);
    log.info(this.a("pty"), `casa: ${cwd}`);
    let esteProc: pty.IPty;
    try {
      esteProc = pty.spawn(binario, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: ctx.env,
      });
    } catch (err) {
      for (const f of ctx.limpezas) f();
      const motivo = err instanceof Error ? err.message : String(err);
      this.mudar({ status: "errored", error: motivo, statusReason: "runner:spawn-falhou" });
      log.erro(
        this.a("pty"),
        `pty.spawn("${binario}") falhou em ${cwd}: ${motivo}`,
        `conferir se o executável "${binario}" está no PATH DESTE serviço ` +
          `(systemctl show dgclaw-agent-${this.descritor.slug} -p Environment) e se a casa do agente existe`,
      );
      return;
    }
    this.proc = esteProc;

    log.info(this.a("pty"), `PTY de pé, pid ${esteProc.pid}`);
    this.buffer = [];
    this.bufferBytes = 0;
    this.spawnEm = Date.now();
    this.mudar({ status: "spawning", statusReason: "runner:spawn" });
    // O id da conversa só vale para este CLI e esta conta: grava de quem é, para o boot seguinte decidir.
    gravarEstado({ escolha: ctx.escolha }, this.arquivoDeEstado);

    const pararVigias: Array<() => void> = [];
    if (this.motor.provedor === "codex") pararVigias.push(this.vigiarRolloutDoCodex(esteProc, ctx));

    // Uma máscara por spawn: o que o CLI escreve passa por ela antes de chegar ao buffer da tela e ao painel.
    const mascara = new MascaraDeFluxo(this.segredosParaMascara());
    this.mascaraAtual = mascara;
    esteProc.onData((d) => this.aoReceberDados(d, mascara));
    esteProc.onExit(({ exitCode, signal }) => {
      this.descarregarMascara(mascara);
      for (const parar of pararVigias) parar();
      for (const f of ctx.limpezas) f();
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
      if (this.estado.status !== "spawning" || this.proc !== esteProc) return;
      // Um agente sem credencial não está `idle`: ele está parado numa tela de
      // login. Dizer `idle` aqui foi o que fez o painel mentir por horas.
      const semLogin = this.recusaDeEntrada();
      if (semLogin) {
        this.mudar({ status: "errored", error: semLogin.mensagem, statusReason: "runner:sem-login" });
        return;
      }
      this.mudar({ status: "idle", statusReason: "runner:boot-timer 8s" });
    }, 8_000).unref();
  }

  /** Codex: status e id da sessão vêm do rollout. Devolve a função que para o vigia. */
  private vigiarRolloutDoCodex(esteProc: pty.IPty, ctx: CtxMotor): () => void {
    const home = ctx.env.CODEX_HOME ?? codexHomeDe({ auth: ctx.escolha.auth, env: ctx.env, cwd: ctx.cwd, id: ctx.id });
    const desde = this.spawnEm;
    let arquivo: string | null = null;
    let avisouAusencia = false;
    return vigiarRollout({
      desdeMs: desde,
      resolverArquivo: () => {
        if (this.proc !== esteProc) return null;
        if (arquivo) return arquivo;
        const conhecido = this.estado.sessionId;
        if (conhecido) {
          arquivo = acharRolloutPorId(conhecido, home);
        } else {
          const achado = descobrirRollout(ctx.cwd, desde, home, this.idsEmUso());
          if (achado) {
            arquivo = achado.arquivo;
            log.info(this.a("codex"), `id da sessão descoberto no rollout: ${achado.id}`);
            this.mudar({ sessionId: achado.id });
            // O rollout nascer é o recibo do primeiro Enter (ele só existe depois do primeiro turno).
            this.promptsAceitos += 1;
          }
        }
        if (!arquivo && !avisouAusencia && Date.now() - desde > ROLLOUT_AUSENTE_MS) {
          avisouAusencia = true;
          log.erro(
            this.a("codex"),
            `o rollout do Codex não apareceu em ${Math.round(ROLLOUT_AUSENTE_MS / 1000)}s em ${home}/sessions` +
              (conhecido ? ` (procurei o id ${conhecido})` : ` (procurei por cwd ${ctx.cwd})`),
            "conferir se o Codex fez login (a tela do terminal mostra) e se CODEX_HOME é o mesmo do processo; sem o rollout o status do agente não anda e a conversa não aparece no painel",
          );
        }
        return arquivo;
      },
      aoEvento: (e) => {
        if (this.proc !== esteProc) return;
        this.aplicarEvento({ event: e.evento satisfies EventoInterno, toolName: e.ferramenta ?? null });
      },
    });
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
    this.cancelarQuietoDeBoot();
    if (this.mascaraAtual) this.descarregarMascara(this.mascaraAtual);
    this.mudar({
      status: this.estado.sessionId ? "resumable" : "stopped",
      statusReason: statusReason ?? `runner:parado ${motivo}`,
    });
  }

  /** Como parar(), mas só volta depois que o processo antigo morreu de verdade.
   *  Na troca de forma de pagar o CLI antigo carrega no ambiente a chave do modo
   *  antigo (ex.: ANTHROPIC_API_KEY): subir o novo com o velho ainda vivo deixa uma
   *  janela em que o dono escolheu um modo e outro continua gastando (B6, card 4,
   *  12/10/2026). O SIGHUP do parar() não basta se o CLI o ignora; passado o prazo,
   *  vai SIGKILL no grupo inteiro (o node-pty faz o filho líder de sessão, então
   *  -pid pega também os servidores MCP). Nunca lança. */
  async pararEEsperar(motivo: string, prazoMs = 5_000): Promise<void> {
    const antigo = this.proc;
    if (!antigo) return;
    const pid = antigo.pid;
    let saiu = false;
    let acordar: () => void = () => {};
    const saida = new Promise<void>((resolve) => {
      acordar = resolve;
    });
    antigo.onExit(() => {
      saiu = true;
      acordar();
    });
    this.parar(motivo);

    const esperar = async (ms: number): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      const limite = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref();
      });
      await Promise.race([saida, limite]);
      if (timer) clearTimeout(timer);
    };

    await esperar(prazoMs);
    if (saiu) return;

    let forcou = "mandei SIGKILL no grupo do processo";
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      forcou = "mandei SIGKILL só no processo";
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        forcou = `tentei o SIGKILL e não consegui (${err instanceof Error ? err.message : err})`;
      }
    }
    log.aviso(
      this.a("pty"),
      `o processo antigo (pid ${pid}) não saiu em ${prazoMs / 1000}s com o SIGHUP na parada (${motivo}); ${forcou}`,
    );

    await esperar(2_000);
    if (saiu) return;
    log.erro(
      this.a("pty"),
      `o processo antigo (pid ${pid}) continuou vivo mesmo depois do SIGKILL (${motivo}); ele pode estar rodando com o ambiente do modo antigo`,
      `conferir com "ps -o pid,cmd -p ${pid}" e encerrar esse processo à mão antes de confiar na troca`,
    );
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
    this.cancelarQuietoDeBoot();
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
        `a sessão ${retomada.sessionId} não abriu: o ${this.motor.binario} saiu com código ${exitCode} em ` +
          `${Math.round((Date.now() - retomada.em) / 1000)}s. A causa quase sempre é o histórico ` +
          `dela não estar no disco (Claude: ~/.claude/projects/<pasta>/${retomada.sessionId}.jsonl; ` +
          `Codex: <CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*-${retomada.sessionId}.jsonl)`,
        `estou subindo uma sessão NOVA para o agente não ficar mudo, e guardando a antiga em ` +
          `previousSessionId (nada foi apagado). Para investigar: conferir se o arquivo existe e ` +
          `se este serviço tem permissão de leitura nele`,
      );
      this.subir("nova").catch((err) =>
        log.erro(
          this.a("pty"),
          `nem a sessão nova subiu: ${err instanceof Error ? err.message : err}`,
          `conferir o executável ${this.motor.binario} e a casa do agente; o serviço vai continuar tentando a cada restart`,
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
      error: exitCode === 0 ? null : `o processo ${this.motor.binario} saiu com código ${exitCode}`,
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
   * parte da colagem e vira quebra de linha dentro do campo. O Codex é mais
   * sensível ainda: trata texto rápido como colagem, então espera 500 ms.
   */
  async digitarEEnviar(texto: string): Promise<void> {
    if (!this.proc) throw new Error("não há terminal vivo para digitar");
    this.marcarAtividade();
    if (this.motor.provedor === "codex") await this.vencerTelaDeConfianca();
    const pausa = this.motor.pausaAntesDoEnterMs;
    if (texto.length <= 256) {
      this.proc.write(texto);
      await new Promise((r) => setTimeout(r, pausa));
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
          setTimeout(resolve, Math.max(120, pausa));
          return;
        }
        setTimeout(passo, INTERVALO_MS);
      };
      passo();
    });
    await this.enviarComRecibo();
  }

  /**
   * O Codex 0.162.1 pode abrir "Trust this folder?" mesmo com o `trust_level` gravado (B6, 12/10/2026).
   * Se o texto do dono fosse digitado ali, o primeiro caractere escolheria uma opção do menu (o "2" de
   * uma data era "Quit": o Codex saiu com código 0). Então, antes de digitar, olha o fim da tela:
   * se o menu está lá, responde 1 + Enter e só segue quando a tela mudou e o menu não voltou.
   * Se não sumir, NÃO digita: erro claro, e quem chamou trata como trata qualquer falha de digitação.
   */
  async vencerTelaDeConfianca(): Promise<void> {
    if (!this.proc || !telaDeConfiancaDoCodex(this.telaInteira())) return;
    const area = this.a("entrada");
    log.aviso(
      area,
      "o Codex está na tela 'Trust this folder?' (o trust_level gravado não foi respeitado); respondendo 1 + Enter antes de digitar o texto",
    );
    let novo = "";
    const ouvir = (t: string) => {
      novo += t;
    };
    this.on("terminal", ouvir);
    try {
      this.proc.write("1");
      await new Promise((r) => setTimeout(r, 300));
      this.proc?.write("\r");
      const limite = Date.now() + 3_000;
      while (Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 100));
        if (novo.length > 0 && !telaDeConfiancaDoCodex(novo)) return;
      }
    } finally {
      this.off("terminal", ouvir);
    }
    const motivo =
      "O Codex está parado na tela 'Trust this folder?' e não saiu dela depois de responder 1 + Enter. " +
      "Não digitei o texto para ele não cair no menu.";
    log.erro(area, motivo, "abrir o terminal do agente no painel, responder 1 e Enter, e reenviar a mensagem");
    throw new ErroDeMotor(motivo, "runner:tela-de-confianca", "abrir o terminal do agente no painel, responder 1 e Enter, e reenviar a mensagem");
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
   *  O recibo é o hook UserPromptSubmit (Claude) ou o `task_started` do rollout
   *  (Codex), que só aparecem quando o CLI ACEITOU o prompt. Sem recibo, batemos na
   *  tecla de novo. Um Enter a mais numa caixa já vazia é inofensivo (o TUI ignora
   *  linha vazia; testado no Codex real); um Enter a menos perde o poke.  */
  private async enviarComRecibo(): Promise<void> {
    const espera = this.motor.reciboMs;
    for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
      if (!this.proc) return;
      const antes = this.promptsAceitos;
      this.proc.write("\r");
      const recebeu = await this.esperarRecibo(antes, espera);
      if (recebeu) return;
      log.info(
        this.a("entrada"),
        `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${espera}ms; batendo na tecla de novo`,
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

  /** Espera o contador de prompts aceitos passar de `antes`. No Claude, sem hook vivo
   *  (agente sem hooks registrados) não existe recibo possível: aí damos o benefício da
   *  dúvida e voltamos true, para não bater na tecla três vezes à toa. No Codex o recibo
   *  vem do rollout, que vale esperar desde o primeiro Enter. */
  private esperarRecibo(antes: number, limiteMs: number): Promise<boolean> {
    if (!this.hooksVivos && !this.motor.reciboPorRollout) return Promise.resolve(true);
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
    this.filaQuandoIdle.push({ texto, em: Date.now() });
    this.espelharFila();
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
    this.itemEmVoo = this.filaQuandoIdle.shift()!;
    const texto = this.itemEmVoo.texto;
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
        this.itemEmVoo = null;
        this.espelharFila();
      });
  }

  /** Grava no disco o que ainda não foi entregue: o item em digitação e a fila. */
  private espelharFila(): void {
    const pendentes = this.itemEmVoo ? [this.itemEmVoo, ...this.filaQuandoIdle] : this.filaQuandoIdle;
    gravarFila(this.arquivoDaFila, pendentes, this.a("fila"));
  }

  // --- hooks -----------------------------------------------------------------

  /** Recebe o POST do handler de hook (o do Claude ou o `notify` do Codex). Nonce errado é
   *  descartado: é hook de um PTY já morto, ou de um processo que não é este. O evento SÓ
   *  muda o status: nunca injeta texto, nunca dispara comando e nunca devolve conteúdo. */
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
    if (!nonceConfere(this.nonce, payload.nonce)) return { ok: false, motivo: "nonce de um spawn antigo" };
    return this.aplicarEvento(payload);
  }

  /** O efeito de um evento de status já autenticado (vindo do hook ou do rollout do Codex). */
  private aplicarEvento(payload: {
    event?: string;
    sessionId?: string | null;
    toolName?: string | null;
    source?: string | null;
  }): { ok: boolean; motivo?: string } {
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

    if (["UserPromptSubmit", "PreToolUse", "Stop", "PreCompact"].includes(payload.event ?? "")) this.marcarAtividade();
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
        // O contador é o RECIBO do Enter: é a única prova, vinda do próprio CLI,
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

  private cancelarQuietoDeBoot(): void {
    if (this.quietoDeBoot) {
      clearTimeout(this.quietoDeBoot);
      this.quietoDeBoot = null;
    }
  }

  // --- terminal --------------------------------------------------------------

  private aoReceberDados(dados: string, mascara: MascaraDeFluxo): void {
    this.ultimaSaidaEm = Date.now();
    const visivel = mascara.passar(dados);
    if (visivel) this.guardarEEmitir(visivel);
    // O que a máscara reteve (possível começo de segredo) sai quando o CLI fica quieto.
    if (this.descargaDaMascara) clearTimeout(this.descargaDaMascara);
    this.descargaDaMascara = setTimeout(() => this.descarregarMascara(mascara), SILENCIO_DA_MASCARA_MS);
    this.descargaDaMascara.unref();

    if (this.estado.status !== "spawning") return;

    // Motor sem SessionStart (Codex): a tela quieta por um instante é o "pronto".
    // A recusa de login é checada no boot-timer, não aqui: uma tela de login também fica quieta.
    if (!this.motor.usaHooks && this.proc) {
      const esteProc = this.proc;
      this.cancelarQuietoDeBoot();
      this.quietoDeBoot = setTimeout(() => {
        this.quietoDeBoot = null;
        if (this.proc !== esteProc || this.estado.status !== "spawning") return;
        this.mudar({ status: "idle", statusReason: `pty:quieto ${QUIETO_DE_BOOT_MS}ms (sem hooks)` });
      }, QUIETO_DE_BOOT_MS);
      this.quietoDeBoot.unref();
      return;
    }

    // Fallback de ocioso, e SÓ quando não há hook vivo. Com hooks funcionando,
    // deixar o regex mandar traria de volta o falso "ocioso" no meio de um turno
    // longo, que é o motivo de os hooks existirem.
    if (!this.hooksVivos && semAnsi(dados).includes("? for shortcuts")) {
      this.mudar({ status: "idle", statusReason: "pty:? for shortcuts (sem hooks)" });
    }
  }

  /** Guarda no buffer da tela (que o painel pede ao abrir) e entrega a quem está ouvindo. */
  private guardarEEmitir(texto: string): void {
    this.buffer.push(texto);
    this.bufferBytes += texto.length;
    while (this.bufferBytes > BUFFER_MAX && this.buffer.length > 1) {
      this.bufferBytes -= this.buffer.shift()!.length;
    }
    this.seq += 1;
    this.emit("terminal", texto, this.seq);
  }

  /** Solta o que a máscara reteve, pelo mesmo caminho da saída normal. */
  private descarregarMascara(mascara: MascaraDeFluxo): void {
    if (this.descargaDaMascara) {
      clearTimeout(this.descargaDaMascara);
      this.descargaDaMascara = null;
    }
    const resto = mascara.descarregar();
    if (resto) this.guardarEEmitir(resto);
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
    // Dentro da pasta de ESTADO (que é gravável), e não ao lado do descritor (que no
    // container é só leitura) nem em /tmp: um settings apagado pela limpeza de /tmp
    // deixaria o agente sem hook de status no meio da vida, e o sintoma seria um
    // agente eternamente "trabalhando".
    return path.join(this.pastaDeEstado, "runner-hooks");
  }

  private escreverSettings(nonce: string): string | null {
    try {
      const dir = this.pastaDeHooks();
      fs.mkdirSync(dir, { recursive: true });
      const handler = path.join(dir, "runner-hook.mjs");
      const atual = fs.existsSync(handler) ? fs.readFileSync(handler, "utf8") : "";
      if (atual !== HOOK_HANDLER_SOURCE) fs.writeFileSync(handler, HOOK_HANDLER_SOURCE, "utf8");

      const cfg = this.descritor.config;
      const base = `"${process.execPath}" "${handler}" --agent ${this.descritor.id} --port ${this.porta} --nonce ${nonce}`;
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
      // Modo 600: o nonce está dentro do comando de cada hook.
      fs.writeFileSync(arquivo, JSON.stringify(settings), { encoding: "utf8", mode: 0o600 });
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

  /** Junta os arquivos de identidade da sessão num só, a cada spawn (o dono pode ter
   *  editado um deles entre uma subida e outra). Na principal entra o
   *  `config.identidadeArquivo`; na paralela, a lista `identidade` dela (a persona da
   *  principal não se herda). Arquivo que falta é registrado e os outros seguem: uma
   *  persona incompleta ainda é melhor que uma sessão que nem sobe. */
  private montarIdentidade(): { arquivo: string | null; texto: string | null } {
    const relativos = [
      ...(this.papel === "principal" && this.descritor.config.identidadeArquivo?.trim()
        ? [this.descritor.config.identidadeArquivo.trim()]
        : []),
      ...this.identidade,
    ];
    if (!relativos.length) return { arquivo: null, texto: null };
    const partes: string[] = [];
    for (const rel of relativos) {
      const caminho = path.resolve(this.descritor.config.cwd, rel);
      try {
        partes.push(fs.readFileSync(caminho, "utf8").trim());
      } catch (err) {
        log.erro(
          this.a("spawn"),
          `não consegui ler o arquivo de identidade ${caminho}: ${err instanceof Error ? err.message : err}`,
          "conferir o caminho em identidade/identidadeArquivo no descritor (relativo à casa do agente); a sessão sobe sem esse trecho",
        );
      }
    }
    if (!partes.length) return { arquivo: null, texto: null };
    const texto = partes.join("\n\n---\n\n");
    try {
      const dir = this.pastaDeHooks();
      fs.mkdirSync(dir, { recursive: true });
      const arquivo = path.join(dir, `${this.descritor.id}.identidade.md`);
      fs.writeFileSync(arquivo, texto, "utf8");
      return { arquivo, texto };
    } catch (err) {
      log.erro(
        this.a("spawn"),
        `não consegui gravar a identidade concatenada: ${err instanceof Error ? err.message : err}`,
        `conferir permissão de escrita em ${this.pastaDeHooks()}; a sessão sobe sem a identidade`,
      );
      return { arquivo: null, texto: null };
    }
  }
}
