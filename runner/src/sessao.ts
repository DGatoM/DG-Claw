// A sessão viva do agente: o PTY, o estado e a máquina de status.
//
// Este arquivo é a parte do `agent-manager.ts` do Bunker que um agente ENTREGUE
// realmente usa, reescrita para viver sozinha. O que ficou de fora, e por quê:
// worktree, geometria por aparelho, handoff, mestre, board e o cofre. Um agente de
// cliente não faz nada disso, e cada um deles arrastaria uma dependência do Bunker
// para dentro de uma máquina onde Bunker não existe.
//
// O CLI que roda dentro do PTY é escolhido por sessão (Claude Code ou Codex): o que
// muda de um para o outro fica em `provedores/` (um Motor por CLI). Aqui fica o que
// é igual nos dois.
//
// A classe guarda o estado e a API pública. As operações ficam em `sessao/`, uma área por
// arquivo: ciclo (subir, parar, spawn), configuracao (ambiente, settings, identidade),
// digitacao (Enter com recibo), fila (texto para quando ficar ocioso), eventos (hooks e
// status), terminal (buffer e máscara de segredo) e vigias (Stop perdido, rollout do Codex).
//
// O que foi mantido igual, porque é contrato e não estilo:
//   - `--session-id <uuid>` no spawn novo e `--resume <uuid>` na retomada (Claude);
//   - o `--settings` por spawn com os hooks de status e as regras de permissão (Claude);
//   - a fila de colagem antes do Enter (o bug histórico do "digita mas não envia");
//   - os nomes de status (`spawning`, `idle`, `working`, `waiting_input`,
//     `stopped`, `resumable`, `errored`), que o painel da pessoa já lê.
import path from "node:path";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { type ConfigDoRunner, PASTA_DE_ESTADO, STATE_FILE, gravarEstado, lerEstado } from "./config-runner.js";
import { type ItemDaFila, caminhoDaFila, carregarFila } from "./fila-ocioso.js";
import { log } from "./logger.js";
import { MascaraDeFluxo, segredosConhecidos } from "./mascara.js";
import { type ResultadoDoAmbiente, nomesDoCofre } from "./provedores/ambiente.js";
import type { Catalogo } from "./provedores/catalogo.js";
import { codexHomeDe } from "./provedores/codex.js";
import { type CamposDeEscolha, type Escolha, type EscolhaEfetiva, type SaidaDaEscolha, gravarProvedorJson, resolverEscolha } from "./provedores/escolha.js";
import type { CtxMotor, Motor, Recusa } from "./provedores/motor.js";
import { motorDe } from "./provedores/motores.js";
import { parar, pararEEsperar, subir, suspender, trocarPorSessaoLimpa } from "./sessao/ciclo.js";
import { ctxLeve, montarAmbienteBase } from "./sessao/configuracao.js";
import { QUIETO_PARA_OLHAR_TRANSCRIPT_MS, VIGIA_LOGIN_EXPIRADO_MS } from "./sessao/constantes.js";
import { digitarEEnviar, vencerTelaDeConfianca } from "./sessao/digitacao.js";
import { type PayloadDeHook, receberHook } from "./sessao/eventos.js";
import { enfileirarQuandoOcioso, talvezSoltarFila } from "./sessao/fila.js";
import { encerrarIncidenteDeLogin, entregarRecadoDeLogin, marcarLoginExpirado, retomarAposLoginExpirado } from "./sessao/login.js";
import { ESC } from "./sessao/telas.js";
import { guardarEEmitir } from "./sessao/terminal.js";
import type { AgentState } from "./tipos.js";

export { QUIETO_PARA_OLHAR_TRANSCRIPT_MS } from "./sessao/constantes.js";
export { ehDialogoDeBypass, nonceConfere, telaDeConfiancaDoCodex } from "./sessao/telas.js";

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
  /** Quanto o terminal fica mudo antes de olharmos o transcript (rede do Stop perdido, Claude). Testes usam valor curto. */
  quietoParaOlharTranscriptMs?: number;
  /** De quanto em quanto tempo se olha a credencial com o login expirado. Testes usam valor curto. */
  vigiaLoginExpiradoMs?: number;
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
  proc: pty.IPty | null = null;
  buffer: string[] = [];
  bufferBytes = 0;
  seq = 0;
  nonce: string | null = null;
  hooksVivos = false;
  /** Quantos prompts o CLI já ACEITOU (hook UserPromptSubmit no Claude; `task_started` ou o
   *  nascimento do rollout no Codex). É o recibo do Enter; ver enviarComRecibo(). */
  promptsAceitos = 0;
  stopPendente: NodeJS.Timeout | null = null;
  /** A máscara de segredo do spawn atual e o relógio que a descarrega no silêncio. */
  mascaraAtual: MascaraDeFluxo | null = null;
  descargaDaMascara: NodeJS.Timeout | null = null;
  quietoDeBoot: NodeJS.Timeout | null = null;
  vigiaDoStopPerdido: NodeJS.Timeout | null = null;
  readonly quietoParaOlharTranscriptMs: number;
  readonly vigiaLoginExpiradoMs: number;
  /** Quando o login expirou (ms). Presente só enquanto o estado for runner:login-expirado. */
  loginExpiradoEmMs: number | null = null;
  vigiaDoLoginExpirado: NodeJS.Timeout | null = null;
  /** O incidente que acabou de ser resolvido e ainda não foi contado ao agente (ver entregarRecadoDeLogin). */
  recadoDeLogin: { expirouEm: number; voltouEm: number } | null = null;
  /** Quando o turno atual começou (UserPromptSubmit/PreToolUse vindo de fora de working): a linha
   *  turn_duration só vale como "acabou" se for posterior a isto. */
  turnoComecouEm = 0;
  ultimaSaidaEm: number | null = null;
  /** O fim do que o CLI desenhou neste spawn, para reconhecer o diálogo do modo Bypass mesmo chegando em pedaços. */
  caudaDaTela = "";
  encerrando = false;
  /** Fila FIFO de textos para digitar quando o agente ficar ocioso. Era uma vaga
   *  só (o segundo texto apagava o primeiro, e a mensagem do cliente sumia). Cada
   *  mudança é espelhada em disco (ver fila-ocioso.ts), para um reinício do runner
   *  não perder um texto que já foi aceito com 202. */
  filaQuandoIdle: ItemDaFila[] = [];
  readonly arquivoDaFila: string;
  /** O item que está sendo digitado agora. Continua no disco até a digitação terminar:
   *  se o runner cair no meio, o texto sai de novo no próximo boot (repetir uma
   *  mensagem é melhor que perder a de um cliente). */
  itemEmVoo: ItemDaFila | null = null;
  /** true enquanto um item da fila está sendo digitado, para dois idles seguidos
   *  não soltarem dois itens por cima um do outro. */
  soltandoFila = false;
  /** Quando o PTY atual subiu (ver PRONTO_APOS_SPAWN_MS). */
  spawnEm = 0;
  reolharFila: NodeJS.Timeout | null = null;
  ultimaAtividade = Date.now();
  /** Quando o spawn atual foi uma RETOMADA, e quando ele começou. É o que
   *  permite separar "a sessão não abre" de "o agente trabalhou e saiu". */
  retomando: { sessionId: string; em: number } | null = null;
  /** Sessões cuja retomada já falhou. Sem esta marca, um transcript ilegível
   *  daria um laço: retoma, morre, retoma de novo, para sempre. */
  retomadasQueFalharam = new Set<string>();

  /** O motor e a escolha do último spawn (ou a resolvida no construtor, antes do primeiro). */
  motor: Motor;
  escolhaVigente: EscolhaEfetiva;
  /** O contexto do último spawn: dele saem o ambiente e a checagem de login/chave. */
  ctxVivo: CtxMotor | null = null;
  modoDoUltimoSpawn: "retomar" | "nova" | null = null;

  readonly estado: AgentState;
  readonly papel: "principal" | "paralela";
  readonly tipo: string | null;
  readonly chat: string | null;
  readonly titulo: string | null;
  readonly ociosoMinutos: number | null;
  readonly pastaDeEstado: string;
  readonly arquivoDeEstado: string;
  readonly promptHooks: string[];
  readonly identidade: string[];
  readonly escolhaDescrita: CamposDeEscolha | undefined;
  readonly idsEmUso: () => ReadonlySet<string>;

  constructor(
    readonly descritor: IdentidadeDaSessao,
    readonly porta: number,
    opcoes: OpcoesDaSessao = {},
  ) {
    super();
    this.papel = opcoes.papel ?? "principal";
    this.tipo = opcoes.tipo ?? null;
    this.chat = opcoes.chat ?? null;
    this.titulo = opcoes.titulo ?? null;
    this.ociosoMinutos = opcoes.ociosoMinutos ?? null;
    this.quietoParaOlharTranscriptMs = opcoes.quietoParaOlharTranscriptMs ?? QUIETO_PARA_OLHAR_TRANSCRIPT_MS;
    this.vigiaLoginExpiradoMs = opcoes.vigiaLoginExpiradoMs ?? VIGIA_LOGIN_EXPIRADO_MS;
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
  a(area: string): string {
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

  marcarAtividade(): void {
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
  codexHomeUsado: string | null = null;

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
  codexHomeParaModelos(): string | undefined {
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
    const amb = montarAmbienteBase(this, escolha, catalogo);
    let codexHome: string | null = null;
    if (escolha.provedor === "codex") {
      codexHome = codexHomeDe({ auth: escolha.auth, env: amb.env, cwd: this.descritor.config.cwd, id: this.id });
      amb.env.CODEX_HOME = codexHome;
    }
    return { ...amb, codexHome };
  }


  /** O CODEX_HOME desta sessão (onde ficam os rollouts), para o `GET /conversation` do Codex. */
  codexHomeAtual(): string {
    const e = this.escolhaVigente;
    const amb = this.ambienteDaEscolha({ ...e, provedor: "codex" }, this.lerEscolha().catalogo);
    return amb.codexHome as string;
  }

  // --- ciclo de vida ---------------------------------------------------------




  /**
   * Por que esta sessão não pode conversar agora (falta login ou falta a chave do modo).
   *
   * Existe porque um agente SEM login não falha: ele sobe, o CLI abre a tela
   * de escolha de conta e fica lá, com o PTY vivo e o status `idle`. Do lado de
   * fora tudo parece bem, e quem manda mensagem não recebe nada nem descobre por
   * quê, a mensagem é digitada na tela de login e se perde. Foi assim em
   * 27/08/2026, com o dono esperando resposta de um agente que nunca ia responder.
   */
  recusaDeEntrada(): Recusa | null {
    if (this.estado.status === "errored" && this.estado.statusReason === "runner:login-expirado") {
      return {
        tipo: "login-expirado",
        mensagem: this.estado.error ?? `O login da conta de ${this.slug} expirou.`,
        comoResolver: "reconectar a conta do agente pela conversa (cartão de login) ou digitando /login no terminal dele",
      };
    }
    return this.recusaDoMotor();
  }

  /** Só a falta de login ou de chave (a checagem do motor), sem o login expirado, que tem ciclo próprio. */
  recusaDoMotor(): Recusa | null {
    const motor = this.ctxVivo ? this.motor : motorDe(this.lerEscolha().escolha.provedor);
    return motor.motivoSemLogin(this.ctxVivo ?? ctxLeve(this));
  }

  /** O mesmo motivo como texto (login ou chave), para quem só quer a mensagem. */
  motivoSemLogin(): string | null {
    return this.recusaDeEntrada()?.mensagem ?? null;
  }



  /** Chamado quando o login assistido termina bem. Só age se a sessão estava parada por falta de login. */
  aposLoginConcluido(): void {
    if (this.estado.status === "errored" && this.estado.statusReason === "runner:sem-login") {
      trocarPorSessaoLimpa(this);
    } else if (this.estado.status === "errored" && this.estado.statusReason === "runner:login-expirado") {
      retomarAposLoginExpirado(this, "login assistido concluído");
    }
  }

  /** O relógio que espera o login aparecer. Nulo quando não há espera em curso. */
  esperandoLogin: ReturnType<typeof setInterval> | null = null;









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
   * Responde ao pedido de permissão do Claude Code (diálogo de ferramenta). Só vale com o agente em
   * `waiting_input`: fora disso a tecla cairia na caixa de mensagem como texto.
   *
   * No diálogo do Claude Code "1" é "Yes" (atalho numérico) e Esc cancela, que é o "No". Não usamos
   * "3"/"2" para negar porque o número da opção "No" muda conforme o diálogo (com ou sem "don't ask
   * again"); Esc vale em todos. O Codex não tem este diálogo no runner: recusa com motivo.
   */
  responderPermissao(decisao: "aprovar" | "negar"): { ok: true } | { ok: false; status: number; erro: string; comoResolver: string; code: string } {
    if (this.motor.provedor !== "claude") {
      return { ok: false, status: 501, code: "PERMISSAO_SO_CLAUDE", erro: `O provedor ${this.motor.provedor} não expõe o pedido de permissão ao runner.`, comoResolver: "responder pelo terminal do agente" };
    }
    if (this.estado.status !== "waiting_input") {
      return { ok: false, status: 409, code: "NAO_ESPERA_PERMISSAO", erro: `O agente ${this.slug} não está esperando permissão (status=${this.estado.status}).`, comoResolver: "atualizar a tela: o pedido já foi resolvido" };
    }
    if (!this.proc) {
      return { ok: false, status: 409, code: "NO_PTY", erro: `O agente ${this.slug} não tem terminal vivo agora.`, comoResolver: "chamar POST /api/agents/:id/resume antes" };
    }
    log.info(this.a("entrada"), `permissão ${decisao === "aprovar" ? "aprovada" : "negada"} por API`);
    this.escrever(decisao === "aprovar" ? "1" : ESC);
    return { ok: true };
  }








  // --- hooks -----------------------------------------------------------------






  // --- terminal --------------------------------------------------------------





  // --- estado ----------------------------------------------------------------

  mudar(campos: Partial<AgentState>): void {
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
    if (campos.status === "idle") {
      entregarRecadoDeLogin(this);
      talvezSoltarFila(this);
    }
  }

  // --- montagem do spawn -----------------------------------------------------

  // --- operações implementadas em sessao/*.ts ---------------------------------
  // A classe guarda o estado; o que cada operação faz fica no módulo da sua área.

  /** Sobe o PTY (ver sessao/ciclo.ts). */
  subir(modo: "retomar" | "nova"): Promise<"retomar" | "nova"> {
    return subir(this, modo);
  }

  /** Encerra o PTY sem matar o serviço (ver sessao/ciclo.ts). */
  parar(motivo: string, statusReason?: string): void {
    parar(this, motivo, statusReason);
  }

  /** Como parar(), mas só volta depois que o processo morreu (ver sessao/ciclo.ts). */
  pararEEsperar(motivo: string, prazoMs = 5_000): Promise<void> {
    return pararEEsperar(this, motivo, prazoMs);
  }

  /** Dorme uma sessão paralela (ver sessao/ciclo.ts). */
  suspender(motivo: string): boolean {
    return suspender(this, motivo);
  }

  /** Digita e envia, com recibo do Enter (ver sessao/digitacao.ts). */
  digitarEEnviar(texto: string): Promise<void> {
    return digitarEEnviar(this, texto);
  }

  /** Responde à tela de confiança de pasta do Codex (ver sessao/digitacao.ts). */
  vencerTelaDeConfianca(): Promise<void> {
    return vencerTelaDeConfianca(this);
  }

  /** Guarda um texto para digitar quando o agente ficar ocioso (ver sessao/fila.ts). */
  enfileirarQuandoOcioso(texto: string): void {
    enfileirarQuandoOcioso(this, texto);
  }

  /** Guarda no buffer da tela e entrega a quem ouve (ver sessao/terminal.ts). Os testes de tela chamam por aqui. */
  guardarEEmitir(texto: string): void {
    guardarEEmitir(this, texto);
  }

  /** Entra em login expirado e passa a vigiar a credencial (ver sessao/login.ts). */
  marcarLoginExpirado(origem: string, quando: number | null, detalhe: string | null): void {
    marcarLoginExpirado(this, origem, quando, detalhe);
  }

  /** Recebe o POST do handler de hook (ver sessao/eventos.ts). */
  receberHook(payload: PayloadDeHook): { ok: boolean; motivo?: string } {
    return receberHook(this, payload);
  }
}

