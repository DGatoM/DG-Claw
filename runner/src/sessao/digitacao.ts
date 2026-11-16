import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { INTERVALO_MS, PEDACO, RECIBO_ENTER_TENTATIVAS } from "./constantes.js";
import { ehDialogoDeAutoMode, telaDeConfiancaDoCodex } from "./telas.js";

/**
 * Digita e ENVIA. Espera a fila de colagem drenar antes do Enter, que é o
 * detalhe que separa "funciona" de "digita o prompt e não envia": acima de
 * 256 caracteres o texto vai em pedaços, e um Enter cedo demais é tratado como
 * parte da colagem e vira quebra de linha dentro do campo. O Codex é mais
 * sensível ainda: trata texto rápido como colagem, então espera 500 ms.
 */
export async function digitarEEnviar(s: Sessao, texto: string, daFila = false): Promise<void> {
  if (!s.proc) throw new Error("não há terminal vivo para digitar");
  s.marcarAtividade();
  if (s.motor.provedor === "codex") await s.vencerTelaDeConfianca(daFila);
  if (s.motor.provedor === "claude") recusarSeEstiverNoAvisoDoAutoMode(s, daFila);
  const pausa = s.motor.pausaAntesDoEnterMs;
  const ehComandoDeBarra = texto.trim().startsWith("/");
  if (texto.length <= 256) {
    s.escrever(texto);
    await new Promise((r) => setTimeout(r, pausa));
    await enviarComRecibo(s, ehComandoDeBarra);
    return;
  }
  await new Promise<void>((resolve) => {
    let i = 0;
    const passo = () => {
      if (!s.proc) return resolve();
      s.escrever(texto.slice(i, i + PEDACO));
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
  await enviarComRecibo(s, ehComandoDeBarra);
}

/** Orientação quando a tela bloqueia a caixa. Pela fila o pedido fica guardado e a fila tenta de novo
 *  sozinha; numa chamada direta não existe fila, então a pessoa precisa reenviar. */
function comoResolverTelaBloqueada(daFila: boolean): string {
  return daFila
    ? "responder o aviso no terminal do agente (aba Sessões, botão Terminal); o pedido está guardado e é entregue sozinho assim que o aviso sumir. Não reenvie."
    : "responder o aviso no terminal do agente e enviar a mensagem de novo";
}

/** O Claude parou na pergunta de primeira vez do auto mode: o texto digitado cairia dentro do menu e
 *  ficaria parado (nenhum Enter vira turno). Não se responde sozinho porque aceitar muda o modo padrão
 *  do dono. Não digita nada e falha com o motivo, como o aviso do Bypass. */
function recusarSeEstiverNoAvisoDoAutoMode(s: Sessao, daFila: boolean): void {
  if (!ehDialogoDeAutoMode(s.telaInteira())) return;
  const motivo =
    "O Claude Code está parado na pergunta 'Make auto mode your default permission mode?' (aviso de primeira vez do auto mode) " +
    "e a chave skipAutoPermissionPrompt não chegou ao settings. Não digitei o texto para ele não cair dentro do menu.";
  const comoResolver = comoResolverTelaBloqueada(daFila);
  // Pela fila quem loga é ela, uma vez por bloqueio: a tentativa se repete a cada poucos segundos.
  if (!daFila) log.erro(s.a("entrada"), motivo, comoResolver);
  throw new ErroDeMotor(motivo, "runner:dialogo-auto-mode", comoResolver);
}

/**
 * O Codex 0.162.1 pode abrir "Trust this folder?" mesmo com o `trust_level` gravado (B6, 12/10/2026).
 * Se o texto do dono fosse digitado ali, o primeiro caractere escolheria uma opção do menu (o "2" de
 * uma data era "Quit": o Codex saiu com código 0). Então, antes de digitar, olha o fim da tela:
 * se o menu está lá, responde 1 + Enter e só segue quando a tela mudou e o menu não voltou.
 * Se não sumir, NÃO digita: erro claro, e quem chamou trata como trata qualquer falha de digitação.
 */
export async function vencerTelaDeConfianca(s: Sessao, daFila = false): Promise<void> {
  if (!s.proc || !telaDeConfiancaDoCodex(s.telaInteira())) return;
  const area = s.a("entrada");
  log.aviso(
    area,
    "o Codex está na tela 'Trust this folder?' (o trust_level gravado não foi respeitado); respondendo 1 + Enter antes de digitar o texto",
  );
  let novo = "";
  const ouvir = (t: string) => {
    novo += t;
  };
  s.on("terminal", ouvir);
  try {
    s.escrever("1");
    await new Promise((r) => setTimeout(r, 300));
    s.escrever("\r");
    const limite = Date.now() + 3_000;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 100));
      if (novo.length > 0 && !telaDeConfiancaDoCodex(novo)) return;
    }
  } finally {
    s.off("terminal", ouvir);
  }
  const motivo =
    "O Codex está parado na tela 'Trust this folder?' e não saiu dela depois de responder 1 + Enter. " +
    "Não digitei o texto para ele não cair no menu.";
  const comoResolver = comoResolverTelaBloqueada(daFila);
  if (!daFila) log.erro(area, motivo, comoResolver);
  throw new ErroDeMotor(motivo, "runner:tela-de-confianca", comoResolver);
}

/** O Enter, com recibo.
 *
 *  Por que não basta escrever "\r": o Enter que chega logo depois de um burst
 *  grande às vezes alcança o TUI enquanto ele ainda está juntando o texto colado,
 *  e vira quebra de linha em vez de envio. O texto fica escrito na caixa de
 *  entrada, ninguém abre turno nenhum, e o POST /input já respondeu 200: que é a
 *  pior forma de falhar: silenciosa e com cara de sucesso. Visto em campo em
 *  25/08/2026, num poke de 293 caracteres; o MESMO texto passou na tentativa
 *  seguinte, então é corrida, e corrida não se resolve aumentando a espera.
 *
 *  O recibo é o hook UserPromptSubmit (Claude) ou o `task_started` do rollout
 *  (Codex), que só aparecem quando o CLI ACEITOU o prompt. Sem recibo, batemos na
 *  tecla de novo. Um Enter a mais numa caixa já vazia é inofensivo (o TUI ignora
 *  linha vazia; testado no Codex real); um Enter a menos perde o poke.  */
export async function enviarComRecibo(s: Sessao, comandoDeBarra = false): Promise<void> {
  const espera = s.motor.reciboMs;
  // Quantas escritas o PTY deve ter contado se só estes Enters escreveram (ver vigiarReciboAtrasado).
  let entradasEsperadas = s.entradasManuais;
  // O terminal deste envio. Se a sessão for trocada no meio, nada daqui pode tocar no terminal novo.
  const proc = s.proc;
  for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
    if (!s.proc || s.proc !== proc) return;
    const antes = s.promptsAceitos;
    const compactAntes = s.compactsIniciados;
    s.escrever("\r");
    entradasEsperadas = s.entradasManuais;
    const recebeu = await esperarRecibo(s, antes, espera, comandoDeBarra ? compactAntes : undefined);
    if (recebeu) return;
    log.info(
      s.a("entrada"),
      `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${espera}ms; batendo na tecla de novo`,
    );
  }
  // Ainda dá para insistir sem segurar quem chamou: a vigia segue em segundo plano e só ela dá o ERRO final.
  const total = RECIBO_ENTER_TENTATIVAS + s.reciboVigiaPassosMs.length;
  const segundos = Math.round(s.reciboVigiaPassosMs.reduce((a, b) => a + b, 0) / 1000);
  log.info(
    s.a("entrada"),
    `${RECIBO_ENTER_TENTATIVAS} Enters sem recibo; continuo tentando em segundo plano por ~${segundos}s (mais ${s.reciboVigiaPassosMs.length} Enters espaçados)`,
  );
  if (!proc || s.proc !== proc) return;
  vigiarReciboAtrasado(s, comandoDeBarra, total, entradasEsperadas, proc);
}

/** Continua batendo no Enter, em segundo plano, depois que as tentativas de enviarComRecibo falharam.
 *  Cada passo olha primeiro o recibo (o turno pode ter aberto sozinho, só atrasado) e só então decide
 *  se bate a tecla: com a sessão fora de idle, algo abriu turno por outro caminho e basta esperar.
 *  Só no fim, sem recibo, vem o ERRO de que o texto ficou na caixa. Uma vigia por sessão. */
function vigiarReciboAtrasado(
  s: Sessao,
  comandoDeBarra: boolean,
  total: number,
  entradasDoEnvio: number,
  proc: NonNullable<Sessao["proc"]>,
): void {
  if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
  s.vigiaDoRecibo = null;
  if (s.proc !== proc) return;
  const antes = s.promptsAceitos;
  const compactAntes = s.compactsIniciados;
  const inicio = Date.now();
  const passos = s.reciboVigiaPassosMs;
  const aceito = () => s.promptsAceitos > antes || (comandoDeBarra && s.compactsIniciados > compactAntes);
  // Toda escrita no PTY passa por s.escrever() e soma em entradasManuais. Se o número mudou sem ser pela
  // própria vigia, alguém mexeu na caixa (o dono pelo terminal, ou um texto novo sendo digitado): o que
  // está lá já não é o texto que esta vigia tenta enviar, e um Enter dela poderia mandar um rascunho.
  // O ponto de partida vem de enviarComRecibo (o valor logo depois do último Enter dele), para pegar
  // também a escrita feita enquanto ele esperava o recibo do último Enter.
  let entradasEsperadas = entradasDoEnvio;

  const passo = (i: number): void => {
    s.vigiaDoRecibo = null;
    if (s.proc !== proc) return;
    if (aceito()) {
      log.info(
        s.a("entrada"),
        `o turno abriu atrasado, ${Math.round((Date.now() - inicio) / 1000)}s depois do texto digitado`,
      );
      return;
    }
    if (i >= passos.length) {
      log.erro(
        s.a("entrada"),
        `digitei ${total} Enters e nenhum abriu turno: o texto ficou escrito na caixa de entrada do agente`,
        "olhar a tela (GET /api/agents/:id/terminal) e dar um Enter à mão, ou reenviar por POST /api/agents/:id/input",
      );
      return;
    }
    if (s.entradasManuais !== entradasEsperadas) {
      log.info(
        s.a("entrada"),
        "parei de insistir no Enter: houve outra escrita no terminal depois do texto, e a caixa já não é a mesma",
      );
      return;
    }
    if (s.estado.status === "idle") {
      log.info(
        s.a("entrada"),
        `o Enter atrasado ${RECIBO_ENTER_TENTATIVAS + i + 1}/${total} (ainda sem recibo); batendo na tecla de novo`,
      );
      s.escrever("\r");
      entradasEsperadas = s.entradasManuais;
    }
    agendar(i + 1);
  };
  // O último passo só confere o recibo do último Enter, então espera o mesmo que o Enter normal.
  const agendar = (i: number): void => {
    s.vigiaDoRecibo = setTimeout(() => passo(i), i < passos.length ? passos[i] : s.motor.reciboMs);
    s.vigiaDoRecibo.unref();
  };
  agendar(0);
}

/** Espera o contador de prompts aceitos passar de `antes`. No Claude, sem hook vivo
 *  (agente sem hooks registrados) não existe recibo possível: aí damos o benefício da
 *  dúvida e voltamos true, para não bater na tecla três vezes à toa. No Codex o recibo
 *  vem do rollout, que vale esperar desde o primeiro Enter. */
export function esperarRecibo(s: Sessao, antes: number, limiteMs: number, compactAntes?: number): Promise<boolean> {
  if (!s.hooksVivos && !s.motor.reciboPorRollout) return Promise.resolve(true);
  return new Promise((resolve) => {
    const inicio = Date.now();
    const olhar = () => {
      if (s.promptsAceitos > antes) return resolve(true);
      // Comando de barra (`/compact`) não dispara UserPromptSubmit: o PreCompact depois deste Enter é o
      // recibo dele. Só para esse caso: PreToolUse de um turno ANTERIOR não prova que a mensagem nova
      // entrou (ela pode estar presa na caixa), então não conta.
      if (compactAntes !== undefined && s.compactsIniciados > compactAntes) return resolve(true);
      if (Date.now() - inicio >= limiteMs) return resolve(false);
      setTimeout(olhar, 100);
    };
    olhar();
  });
}
