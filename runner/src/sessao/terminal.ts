import xtermHeadless from "@xterm/headless";
import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { BUFFER_MAX, EMULADOR_PENDENTE_PAUSA, EMULADOR_PENDENTE_RETOMA, QUIETO_DE_BOOT_MS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { cancelarQuietoDeBoot } from "./eventos.js";
import { ehDialogoDeBypass, ehDialogoDeConfiancaDoClaude, pastaDoDialogoDeConfianca, semAnsi } from "./telas.js";

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
  escreverNoEmulador(s, texto);
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

const { Terminal } = xtermHeadless;
/** Limpeza de tela INTEGRAL: ESC[2J ou ESC c (RIS). O ESC[3J limpa só o histórico de rolagem e não conta. */
const LIMPEZA_DE_TELA_INTEGRAL = /\u001b\[2J|\u001bc/;

/** A escrita no emulador nunca derruba o runner. O @xterm/headless lança, de forma síncrona, quando a fila interna dele passa de
 *  50 milhões de unidades pendentes (o limite de 200 KiB do buffer não limita essa fila). Se lançar, o que ele guardava está
 *  incompleto: ele é recriado vazio e a tela desta sessão deixa de valer como prova (ver Sessao.emuladorNaoConfiavel) até um
 *  redesenho completo, o que suspende a digitação automática SÓ desta sessão. O log não leva texto do terminal. */
function escreverNoEmulador(s: Sessao, texto: string): void {
  const t = s.emulador;
  if (!t) return;
  try {
    s.emuladorPendente += texto.length;
    t.write(texto, () => {
      if (s.emulador !== t) return;
      s.emuladorPendente = Math.max(0, s.emuladorPendente - texto.length);
      if (s.ptyPausadoPeloEmulador && s.emuladorPendente <= EMULADOR_PENDENTE_RETOMA) retomarPty(s);
    });
  } catch (err) {
    perdeuOEmulador(s, t, err);
    return;
  }
  const nc = s.emuladorNaoConfiavel;
  if (nc) {
    nc.bytesNovos += texto.length;
    if (LIMPEZA_DE_TELA_INTEGRAL.test(texto)) {
      log.info(s.a("pty"), `o emulador de tela voltou a valer como prova (limpeza de tela integral recebida depois da recriação, ${nc.bytesNovos} bytes de saída nova antes dela)`);
      s.emuladorNaoConfiavel = null;
    }
  }
  if (!s.ptyPausadoPeloEmulador && s.emuladorPendente >= EMULADOR_PENDENTE_PAUSA && typeof s.proc?.pause === "function") {
    s.ptyPausadoPeloEmulador = true;
    s.proc.pause();
    log.aviso(s.a("pty"), `o emulador de tela está ${s.emuladorPendente} bytes atrasado; pausei a leitura do terminal até ele alcançar`);
  }
}

function retomarPty(s: Sessao): void {
  s.ptyPausadoPeloEmulador = false;
  if (typeof s.proc?.resume === "function") s.proc.resume();
}

function perdeuOEmulador(s: Sessao, antigo: NonNullable<Sessao["emulador"]>, err: unknown): void {
  log.erro(
    s.a("pty"),
    `a escrita no emulador de tela falhou (${err instanceof Error ? err.message : String(err)}); recriei o emulador vazio e suspendi a digitação automática desta sessão`,
    "a digitação desta sessão volta sozinha quando o CLI redesenhar a tela inteira (limpeza integral, ESC[2J ou ESC c); se não voltar sozinha, reiniciar o agente pelo painel resolve. Os outros agentes não são afetados",
  );
  try {
    antigo.dispose();
  } catch {
    // o emulador antigo já está inutilizável; o que importa é o novo
  }
  s.emulador = new Terminal({ cols: 120, rows: 40, scrollback: 200, allowProposedApi: true });
  s.emuladorPendente = 0;
  if (s.ptyPausadoPeloEmulador) retomarPty(s);
  s.emuladorNaoConfiavel = { desde: Date.now(), bytesNovos: 0 };
}
