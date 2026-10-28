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
  for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
    if (!s.proc) return;
    const antes = s.promptsAceitos;
    const compactAntes = s.compactsIniciados;
    s.escrever("\r");
    const recebeu = await esperarRecibo(s, antes, espera, comandoDeBarra ? compactAntes : undefined);
    if (recebeu) return;
    log.info(
      s.a("entrada"),
      `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${espera}ms; batendo na tecla de novo`,
    );
  }
  // Não dá para consertar daqui, mas dá para NÃO mentir: quem lê o log precisa
  // saber que o texto está na caixa e que ninguém vai processá-lo.
  log.erro(
    s.a("entrada"),
    `digitei ${RECIBO_ENTER_TENTATIVAS} Enters e nenhum abriu turno: o texto ficou escrito na caixa de entrada do agente`,
    "olhar a tela (GET /api/agents/:id/terminal) e dar um Enter à mão, ou reenviar por POST /api/agents/:id/input",
  );
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
