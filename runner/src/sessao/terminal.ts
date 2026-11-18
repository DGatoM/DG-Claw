import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { BUFFER_MAX, QUIETO_DE_BOOT_MS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { cancelarQuietoDeBoot, cancelarStopPendente } from "./eventos.js";
import { talvezSoltarFila } from "./fila.js";
import { interrupcaoNoFimDoTranscript } from "../transcript.js";
import { ehDialogoDeBypass, ehDialogoDeConfiancaDoClaude, pastaDoDialogoDeConfianca, semAnsi } from "./telas.js";

const JANELA_DA_INTERRUPCAO_MS = 10_000;

/**
 * Depois de um Esc do Parar nenhum dos dois motores dispara um fim de turno que o runner use, então o status
 * ficaria em `working` e a fila de mensagens presa. Uma vigia de 10 s procura a PROVA do motor:
 *  - Claude: o marcador na tela depois do Esc E a última mensagem do transcript ser "[Request interrupted by
 *    user...]" com timestamp posterior ao Esc. A tela sozinha não basta (um redesenho repete um "Interrupted" velho).
 *  - Codex: o rollout registrar `turn_aborted`/`task_aborted` depois do Esc (ver confirmarInterrupcaoDoRollout).
 * Sem a prova no prazo: log.aviso e o status fica como estava.
 */
export function vigiarInterrupcao(s: Sessao): void {
  desarmarVigiaDaInterrupcao(s);
  const proc = s.proc;
  const timer = setTimeout(() => {
    if (s.vigiaInterrupcao?.timer !== timer) return;
    desarmarVigiaDaInterrupcao(s);
    log.aviso(s.a("entrada"), `Esc enviado pelo Parar, mas não vi a confirmação da interrupção em ${JANELA_DA_INTERRUPCAO_MS / 1000} s; o status continua ${s.estado.status}`);
  }, JANELA_DA_INTERRUPCAO_MS);
  timer.unref();
  s.vigiaInterrupcao = { proc, texto: "", timer, desdeMs: Date.now(), telaVista: false, poll: null };
}

export function desarmarVigiaDaInterrupcao(s: Sessao): void {
  if (s.vigiaInterrupcao) {
    clearTimeout(s.vigiaInterrupcao.timer);
    if (s.vigiaInterrupcao.poll) clearInterval(s.vigiaInterrupcao.poll);
  }
  s.vigiaInterrupcao = null;
}

function concluirInterrupcao(s: Sessao, como: string): void {
  desarmarVigiaDaInterrupcao(s);
  if (s.estado.status !== "working") return;
  cancelarStopPendente(s);
  s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: "runner:interrompido" });
  log.info(s.a("entrada"), `interrupção confirmada depois do Parar (${como}): o agente voltou a idle e a fila pode andar`);
  talvezSoltarFila(s);
}

/** Codex: o rollout registrou o turno abortado. Só vale com um Parar em curso e o registro depois do Esc. */
export function confirmarInterrupcaoDoRollout(s: Sessao, em: number): boolean {
  const v = s.vigiaInterrupcao;
  if (!v || v.proc !== s.proc || em < v.desdeMs) return false;
  concluirInterrupcao(s, "rollout do Codex: turno abortado");
  return true;
}

function tentarConfirmarPeloTranscript(s: Sessao): void {
  const v = s.vigiaInterrupcao;
  if (!v || !v.telaVista || v.proc !== s.proc) return;
  const sessionId = s.estado.sessionId;
  if (!sessionId) return;
  const prova = interrupcaoNoFimDoTranscript(sessionId, v.desdeMs, s.estado.config.envExtra?.CLAUDE_CONFIG_DIR);
  if (prova.interrompido) concluirInterrupcao(s, "tela e transcript do Claude");
  else log.debug(s.a("entrada"), `marcador na tela depois do Parar, mas o transcript ainda não confirma: ${prova.motivo}`);
}

function olharInterrupcao(s: Sessao, dados: string): void {
  const v = s.vigiaInterrupcao;
  if (!v) return;
  if (v.proc !== s.proc) { desarmarVigiaDaInterrupcao(s); return; }
  // No Codex a prova é o rollout; a tela não conta.
  if (s.motor.provedor !== "claude") return;
  // Procura no bloco inteiro mais a cauda do anterior; só depois limita o trecho guardado para o próximo bloco.
  const visto = v.texto + semAnsi(dados);
  v.texto = visto.slice(-4_096);
  if (v.telaVista || !/interrupted[^a-z]{0,20}what should/i.test(visto)) return;
  v.telaVista = true;
  tentarConfirmarPeloTranscript(s);
  // O transcript pode ser gravado um instante depois da tela: olha de novo até o fim do prazo.
  if (s.vigiaInterrupcao && !s.vigiaInterrupcao.poll) {
    const poll = setInterval(() => tentarConfirmarPeloTranscript(s), 400);
    poll.unref();
    s.vigiaInterrupcao.poll = poll;
  }
}

export function aoReceberDados(s: Sessao, dados: string, mascara: MascaraDeFluxo): void {
  s.ultimaSaidaEm = Date.now();
  olharInterrupcao(s, dados);
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
