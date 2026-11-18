import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { BUFFER_MAX, QUIETO_DE_BOOT_MS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { cancelarQuietoDeBoot, cancelarStopPendente } from "./eventos.js";
import { talvezSoltarFila } from "./fila.js";
import { interrupcaoNoFimDoTranscript } from "../transcript.js";
import { ehDialogoDeBypass, ehDialogoDeConfiancaDoClaude, pastaDoDialogoDeConfianca, semAnsi } from "./telas.js";

const JANELA_DA_INTERRUPCAO_MS = 10_000;
const INTERVALO_DA_VIGIA_MS = 500;
const SILENCIO_DO_MOTOR_ANTES_DA_FILA_MS = 1_000;

/**
 * Depois de um Esc do Parar nenhum dos dois motores dispara um fim de turno que o runner use, então o status
 * ficaria em `working` e a fila de mensagens presa. Uma vigia de 10 s espera o REGISTRO do motor (a tela não conta):
 *  - Claude: a última entrada user/assistant do transcript ser exatamente "[Request interrupted by user]" (ou "... for
 *    tool use]"), com horário igual ou posterior ao Esc (conferido a cada 500 ms).
 *  - Codex: o rollout registrar `turn_aborted`/`task_aborted` com horário igual ou posterior ao Esc
 *    (ver confirmarInterrupcaoDoRollout).
 * `desdeMs` é o horário medido ANTES de escrever o Esc. Um segundo Parar com a vigia armada não a troca: vale o
 * horário do primeiro Esc. Sem a prova no prazo: log.aviso e o status fica como estava.
 */
export function vigiarInterrupcao(s: Sessao, desdeMs: number): void {
  const atual = s.vigiaInterrupcao;
  if (atual && atual.proc === s.proc && !atual.confirmada) {
    // Segundo Parar: o horário do primeiro Esc continua sendo o limite inferior da prova, mas o prazo de 10 s conta do Esc novo.
    armarPrazoDaVigia(s, atual);
    return;
  }
  desarmarVigiaDaInterrupcao(s);
  const v = { proc: s.proc, timer: null as unknown as NodeJS.Timeout, desdeMs, poll: null as NodeJS.Timeout | null, confirmada: false };
  s.vigiaInterrupcao = v;
  armarPrazoDaVigia(s, v);
  if (s.motor.provedor === "claude") {
    v.poll = setInterval(() => conferirTranscriptDaVigia(s, v), INTERVALO_DA_VIGIA_MS);
    v.poll.unref();
  }
}

function armarPrazoDaVigia(s: Sessao, v: NonNullable<Sessao["vigiaInterrupcao"]>): void {
  clearTimeout(v.timer);
  v.timer = setTimeout(() => {
    if (s.vigiaInterrupcao !== v) return;
    desarmarVigiaDaInterrupcao(s);
    log.aviso(s.a("entrada"), `Esc enviado pelo Parar, mas não vi a confirmação da interrupção em ${JANELA_DA_INTERRUPCAO_MS / 1000} s; o status continua ${s.estado.status}`);
  }, JANELA_DA_INTERRUPCAO_MS);
  v.timer.unref();
}

export function desarmarVigiaDaInterrupcao(s: Sessao): void {
  const v = s.vigiaInterrupcao;
  if (v) {
    clearTimeout(v.timer);
    if (v.poll) clearInterval(v.poll);
  }
  s.vigiaInterrupcao = null;
}

/** Confirmou: vai a idle agora, mas a fila só é solta depois do lote de eventos em curso, e só se nada mudou. */
function concluirInterrupcao(s: Sessao, v: NonNullable<Sessao["vigiaInterrupcao"]>, como: string): void {
  clearTimeout(v.timer);
  if (v.poll) clearInterval(v.poll);
  v.confirmada = true;
  if (s.estado.status !== "working") { desarmarVigiaDaInterrupcao(s); return; }
  cancelarStopPendente(s);
  s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: "runner:interrompido" });
  log.info(s.a("entrada"), `interrupção confirmada pelo registro do motor (${como}): o agente voltou a idle`);
  // A fila só sai depois de 1 s sem nenhum evento novo do motor (hook ou rollout): um turno novo no lote seguinte
  // reinicia a espera ou desarma a vigia. No fim, reconfere status idle, mesmo PTY e mesma vigia.
  const esperar = (vistos: number): void => {
    const t = setTimeout(() => {
      if (s.vigiaInterrupcao !== v) return;
      if (s.eventosDoMotor !== vistos) { esperar(s.eventosDoMotor); return; }
      const mesma = s.proc === v.proc && s.estado.status === "idle";
      desarmarVigiaDaInterrupcao(s);
      // Mudou algo no meio (um turno novo começou, o PTY trocou): o Stop/idle normal cuida da fila depois.
      if (mesma) talvezSoltarFila(s);
    }, SILENCIO_DO_MOTOR_ANTES_DA_FILA_MS);
    t.unref();
  };
  esperar(s.eventosDoMotor);
}

function falhaDaVigia(s: Sessao, onde: string, err: unknown): void {
  desarmarVigiaDaInterrupcao(s);
  log.aviso(s.a("entrada"), `vigia da interrupção desarmada: falhou ao ${onde} (${err instanceof Error ? err.message : String(err)})`);
}

/** Codex: o rollout registrou o turno abortado. Só vale com um Parar em curso e o registro depois do Esc. */
export function confirmarInterrupcaoDoRollout(s: Sessao, em: number): boolean {
  try {
    const v = s.vigiaInterrupcao;
    if (!v || v.confirmada || v.proc !== s.proc || !(em >= v.desdeMs)) return false;
    concluirInterrupcao(s, v, "rollout do Codex: turno abortado");
    return true;
  } catch (err) {
    falhaDaVigia(s, "confirmar pelo rollout", err);
    return false;
  }
}

function conferirTranscriptDaVigia(s: Sessao, v: NonNullable<Sessao["vigiaInterrupcao"]>): void {
  try {
    if (s.vigiaInterrupcao !== v || v.confirmada) return;
    if (v.proc !== s.proc) { desarmarVigiaDaInterrupcao(s); return; }
    const sessionId = s.estado.sessionId;
    if (!sessionId) return;
    const prova = interrupcaoNoFimDoTranscript(sessionId, v.desdeMs, s.estado.config.envExtra?.CLAUDE_CONFIG_DIR);
    if (prova.interrompido) concluirInterrupcao(s, v, "transcript do Claude");
  } catch (err) {
    falhaDaVigia(s, "ler o transcript", err);
  }
}

export function aoReceberDados(s: Sessao, dados: string, mascara: MascaraDeFluxo): void {
  s.ultimaSaidaEm = Date.now();
  const visivel = mascara.passar(dados);
  if (visivel) guardarEEmitir(s, visivel);
  // O que a máscara reteve (possível começo de segredo) sai quando o CLI fica quieto.
  if (s.descargaDaMascara) clearTimeout(s.descargaDaMascara);
  s.descargaDaMascara = setTimeout(() => descarregarMascara(s, mascara), SILENCIO_DA_MASCARA_MS);
  s.descargaDaMascara.unref();

  if (s.estado.status !== "spawning") return;

  if (s.motor.provedor === "claude") {
    s.caudaDaTela = (s.caudaDaTela + dados).slice(-8_192);
    if (ehDialogoDeBypass(s.caudaDaTela)) {
      pararNoDialogoDeBypass(s);
      return;
    }
    if (ehDialogoDeConfiancaDoClaude(s.caudaDaTela)) {
      pararNoDialogoDeConfianca(s);
      return;
    }
  }

  // Motor sem SessionStart (Codex): a tela quieta por um instante é o "pronto".
  // A recusa de login é checada no boot-timer, não aqui: uma tela de login também fica quieta.
  if (!s.motor.usaHooks && s.proc) {
    const esteProc = s.proc;
    cancelarQuietoDeBoot(s);
    s.quietoDeBoot = setTimeout(() => {
      s.quietoDeBoot = null;
      if (s.proc !== esteProc || s.estado.status !== "spawning") return;
      s.mudar({ status: "idle", statusReason: `pty:quieto ${QUIETO_DE_BOOT_MS}ms (sem hooks)` });
    }, QUIETO_DE_BOOT_MS);
    s.quietoDeBoot.unref();
    return;
  }

  // Fallback de ocioso, e SÓ quando não há hook vivo. Com hooks funcionando,
  // deixar o regex mandar traria de volta o falso "ocioso" no meio de um turno
  // longo, que é o motivo de os hooks existirem.
  if (!s.hooksVivos && semAnsi(dados).includes("? for shortcuts")) {
    s.mudar({ status: "idle", statusReason: "pty:? for shortcuts (sem hooks)" });
  }
}

/**
 * O Claude parou no aviso do modo Bypass Permissions (16/10/2026). Não se responde: o Enter
 * escolhe o padrão, "No, exit", e o CLI sai com código 1 em loop. O PTY fica vivo na tela do
 * aviso (quem abre o terminal do painel pode escolher "2"), a fila de entrada não é solta e o
 * `POST /input` é recusado pelo estado `errored`.
 */
export function pararNoDialogoDeBypass(s: Sessao): void {
  const mensagem =
    "O Claude Code abriu o aviso do modo Bypass Permissions e ficou esperando resposta. " +
    "O DG Claw não responde esse aviso sozinho (o Enter escolheria \"No, exit\" e o Claude sairia). " +
    "O que fazer: acrescentar \"skipDangerousModePermissionPrompt\": true ao settings.json do HOME do " +
    "motor (~/.claude/settings.json) ou atualizar o DG Claw, e reiniciar o agente.";
  s.mudar({ status: "errored", error: mensagem, statusReason: "runner:dialogo-bypass" });
  log.erro(
    s.a("pty"),
    "o Claude Code está parado no aviso 'Bypass Permissions mode' (1. No, exit / 2. Yes, I accept) e a chave skipDangerousModePermissionPrompt não chegou ao settings",
    "acrescentar \"skipDangerousModePermissionPrompt\": true ao ~/.claude/settings.json do HOME do motor, ou atualizar o runner; depois reiniciar o agente. Nenhuma tecla foi enviada",
  );
}

/**
 * O Claude parou no diálogo de confiança de pasta (2.1.326: abre para o cwd e para cada --add-dir sem
 * `hasTrustDialogAccepted`, com o cursor em "No, exit"). Sem ninguém no teclado ele fica ali com o processo
 * vivo, e um vigia que olha só o processo diria "no ar". Não se responde com teclas.
 */
export function pararNoDialogoDeConfianca(s: Sessao): void {
  const pasta = pastaDoDialogoDeConfianca(s.caudaDaTela);
  const qual = pasta ? ` (pasta: ${pasta})` : "";
  const mensagem =
    `O Claude Code parou no diálogo de confiança de pasta${qual} ("Is this a directory you created or one you trust?") ` +
    "e ficou esperando resposta. O DG Claw não responde sozinho (o Enter escolheria \"No, exit\"). " +
    "O que fazer: marcar a pasta como confiável no .claude.json do motor (projects.<pasta>.hasTrustDialogAccepted = true) " +
    "ou reiniciar o agente, porque o DG Claw tenta marcar sozinho antes do boot.";
  s.mudar({ status: "errored", error: mensagem, statusReason: "runner:tela-de-confianca" });
  log.erro(
    s.a("pty"),
    `o Claude Code está parado no diálogo de confiança de pasta${qual} e a pasta não estava marcada em hasTrustDialogAccepted`,
    "marcar a pasta como confiável no .claude.json do motor ou reiniciar o agente (o DG Claw marca o cwd e cada --add-dir antes do boot). Nenhuma tecla foi enviada",
  );
}

/** Guarda no buffer da tela (que o painel pede ao abrir) e entrega a quem está ouvindo. */
export function guardarEEmitir(s: Sessao, texto: string): void {
  s.buffer.push(texto);
  s.bufferBytes += texto.length;
  while (s.bufferBytes > BUFFER_MAX && s.buffer.length > 1) {
    s.bufferBytes -= s.buffer.shift()!.length;
  }
  s.seq += 1;
  s.emit("terminal", texto, s.seq);
}

/** Solta o que a máscara reteve, pelo mesmo caminho da saída normal. */
export function descarregarMascara(s: Sessao, mascara: MascaraDeFluxo): void {
  if (s.descargaDaMascara) {
    clearTimeout(s.descargaDaMascara);
    s.descargaDaMascara = null;
  }
  const resto = mascara.descarregar();
  if (resto) guardarEEmitir(s, resto);
}
