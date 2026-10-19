import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { INTERVALO_MS, PEDACO, RECIBO_ENTER_TENTATIVAS } from "./constantes.js";
import { telaDeConfiancaDoCodex } from "./telas.js";

/**
 * Digita e ENVIA. Espera a fila de colagem drenar antes do Enter, que é o
 * detalhe que separa "funciona" de "digita o prompt e não envia": acima de
 * 256 caracteres o texto vai em pedaços, e um Enter cedo demais é tratado como
 * parte da colagem e vira quebra de linha dentro do campo. O Codex é mais
 * sensível ainda: trata texto rápido como colagem, então espera 500 ms.
 */
export async function digitarEEnviar(s: Sessao, texto: string): Promise<void> {
  if (!s.proc) throw new Error("não há terminal vivo para digitar");
  s.marcarAtividade();
  if (s.motor.provedor === "codex") await s.vencerTelaDeConfianca();
  const pausa = s.motor.pausaAntesDoEnterMs;
  if (texto.length <= 256) {
    s.proc.write(texto);
    await new Promise((r) => setTimeout(r, pausa));
    await enviarComRecibo(s);
    return;
  }
  await new Promise<void>((resolve) => {
    let i = 0;
    const passo = () => {
      if (!s.proc) return resolve();
      s.proc.write(texto.slice(i, i + PEDACO));
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
  await enviarComRecibo(s);
}

/**
 * O Codex 0.162.1 pode abrir "Trust this folder?" mesmo com o `trust_level` gravado (B6, 12/10/2026).
 * Se o texto do dono fosse digitado ali, o primeiro caractere escolheria uma opção do menu (o "2" de
 * uma data era "Quit": o Codex saiu com código 0). Então, antes de digitar, olha o fim da tela:
 * se o menu está lá, responde 1 + Enter e só segue quando a tela mudou e o menu não voltou.
 * Se não sumir, NÃO digita: erro claro, e quem chamou trata como trata qualquer falha de digitação.
 */
export async function vencerTelaDeConfianca(s: Sessao): Promise<void> {
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
    s.proc.write("1");
    await new Promise((r) => setTimeout(r, 300));
    s.proc?.write("\r");
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
  log.erro(area, motivo, "abrir o terminal do agente no painel, responder 1 e Enter, e reenviar a mensagem");
  throw new ErroDeMotor(motivo, "runner:tela-de-confianca", "abrir o terminal do agente no painel, responder 1 e Enter, e reenviar a mensagem");
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
export async function enviarComRecibo(s: Sessao): Promise<void> {
  const espera = s.motor.reciboMs;
  for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
    if (!s.proc) return;
    const antes = s.promptsAceitos;
    s.proc.write("\r");
    const recebeu = await esperarRecibo(s, antes, espera);
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
export function esperarRecibo(s: Sessao, antes: number, limiteMs: number): Promise<boolean> {
  if (!s.hooksVivos && !s.motor.reciboPorRollout) return Promise.resolve(true);
  return new Promise((resolve) => {
    const inicio = Date.now();
    const olhar = () => {
      if (s.promptsAceitos > antes) return resolve(true);
      if (Date.now() - inicio >= limiteMs) return resolve(false);
      setTimeout(olhar, 100);
    };
    olhar();
  });
}
