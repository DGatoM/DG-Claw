import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { BUFFER_MAX, QUIETO_DE_BOOT_MS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { cancelarQuietoDeBoot } from "./eventos.js";
import { ehDialogoDeBypass, semAnsi } from "./telas.js";

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
