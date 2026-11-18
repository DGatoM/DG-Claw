import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { BUFFER_MAX, QUIETO_DE_BOOT_MS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { cancelarQuietoDeBoot, cancelarStopPendente } from "./eventos.js";
import { talvezSoltarFila } from "./fila.js";
import { ehDialogoDeBypass, ehDialogoDeConfiancaDoClaude, pastaDoDialogoDeConfianca, semAnsi } from "./telas.js";

const JANELA_DA_INTERRUPCAO_MS = 10_000;

/**
 * Depois de um Esc do Parar o Claude não dispara o hook Stop, então o status ficaria em `working` e a fila de
 * mensagens ficaria presa. Aqui se arma uma vigia de 10 s: só o texto que chega do PTY DEPOIS do Esc (sem ANSI)
 * conta, e o marcador do CLI ("Interrupted" no Claude, "Conversation interrupted" no Codex) devolve o agente a idle.
 */
export function vigiarInterrupcao(s: Sessao): void {
  desarmarVigiaDaInterrupcao(s);
  const proc = s.proc;
  const timer = setTimeout(() => {
    if (s.vigiaInterrupcao?.timer !== timer) return;
    s.vigiaInterrupcao = null;
    log.aviso(s.a("entrada"), `Esc enviado pelo Parar, mas não vi a confirmação da interrupção em ${JANELA_DA_INTERRUPCAO_MS / 1000} s; o status continua ${s.estado.status}`);
  }, JANELA_DA_INTERRUPCAO_MS);
  timer.unref();
  s.vigiaInterrupcao = { proc, texto: "", timer };
}

export function desarmarVigiaDaInterrupcao(s: Sessao): void {
  if (s.vigiaInterrupcao) clearTimeout(s.vigiaInterrupcao.timer);
  s.vigiaInterrupcao = null;
}

function olharInterrupcao(s: Sessao, dados: string): void {
  const v = s.vigiaInterrupcao;
  if (!v) return;
  if (v.proc !== s.proc) { desarmarVigiaDaInterrupcao(s); return; }
  v.texto = (v.texto + semAnsi(dados)).slice(-4_096);
  // Claude: a linha "Interrupted · What should Claude do instead?" (a palavra solta pode estar na própria resposta).
  const marcador = s.motor.provedor === "codex" ? /conversation interrupted/i : /interrupted[^a-z]{0,20}what should/i;
  if (!marcador.test(v.texto)) return;
  desarmarVigiaDaInterrupcao(s);
  if (s.estado.status !== "working") return;
  cancelarStopPendente(s);
  s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: "runner:interrompido" });
  log.info(s.a("entrada"), "interrupção confirmada na tela depois do Parar: o agente voltou a idle e a fila pode andar");
  talvezSoltarFila(s);
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
