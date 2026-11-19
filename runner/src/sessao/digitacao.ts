import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { type SemRecibo, liberarBarra, reter, suspenderPorRascunho, talvezSoltarFila } from "./fila.js";
import { INTERVALO_MS, PEDACO, RECIBO_ENTER_TENTATIVAS } from "./constantes.js";
import { ehDialogoDeAutoMode, estadoDaCaixa, telaDeConfiancaDoCodex } from "./telas.js";

/**
 * Digita e ENVIA. Espera a fila de colagem drenar antes do Enter, que é o
 * detalhe que separa "funciona" de "digita o prompt e não envia": acima de
 * 256 caracteres o texto vai em pedaços, e um Enter cedo demais é tratado como
 * parte da colagem e vira quebra de linha dentro do campo. O Codex é mais
 * sensível ainda: trata texto rápido como colagem, então espera 500 ms.
 *
 * `envio` é o item da fila que este texto representa (null numa chamada direta, como o POST /input): é ele, e
 * não um campo global da sessão, que a rotina do Enter marca. Os envios de texto de um mesmo terminal são
 * serializados: um texto só começa a ser colado depois que o anterior terminou o Enter dele.
 */
export function digitarEEnviar(s: Sessao, texto: string, daFila = false, envio: SemRecibo | null = null): Promise<boolean> {
  const minha = s.cadeiaDeEnvio.then(() => digitar(s, texto, daFila, envio));
  s.cadeiaDeEnvio = minha.then(
    () => undefined,
    () => undefined,
  );
  return minha;
}

/** O terminal deste envio saiu ou foi trocado: nada mais é escrito no terminal novo e o pedido fica retido. */
function terminalTrocado(s: Sessao, envio: SemRecibo | null): false {
  log.aviso(
    s.a("entrada"),
    "o terminal mudou no meio do envio (saiu ou foi trocado); parei de escrever para não digitar no terminal novo, e não sei se o pedido foi recebido",
  );
  if (envio) envio.parada = { tipo: "terminal", motivo: "o terminal foi trocado no meio do envio" };
  return false;
}

async function digitar(s: Sessao, texto: string, daFila: boolean, envio: SemRecibo | null): Promise<boolean> {
  // O terminal deste envio, capturado no começo: toda escrita abaixo confere que ele continua sendo o da sessão.
  const proc = s.proc;
  if (!proc) throw new Error("não há terminal vivo para digitar");
  s.marcarAtividade();
  if (s.motor.provedor === "codex") await s.vencerTelaDeConfianca(daFila, proc);
  if (s.proc !== proc) return terminalTrocado(s, envio);
  if (s.motor.provedor === "claude") recusarSeEstiverNoAvisoDoAutoMode(s, daFila);
  const pausa = s.motor.pausaAntesDoEnterMs;
  const ehComandoDeBarra = texto.trim().startsWith("/");
  if (texto.length <= 256) {
    s.escrever(texto);
    await new Promise((r) => setTimeout(r, pausa));
    return enviarComRecibo(s, { texto, comandoDeBarra: ehComandoDeBarra, envio, proc });
  }
  const inteiro = await new Promise<boolean>((resolve) => {
    let i = 0;
    const passo = () => {
      if (s.proc !== proc) return resolve(false);
      s.escrever(texto.slice(i, i + PEDACO));
      i += PEDACO;
      if (i >= texto.length) {
        // Uma folga depois do último pedaço: o TUI ainda está processando o
        // burst quando o write retorna.
        setTimeout(() => resolve(true), Math.max(120, pausa));
        return;
      }
      setTimeout(passo, INTERVALO_MS);
    };
    passo();
  });
  if (!inteiro || s.proc !== proc) return terminalTrocado(s, envio);
  return enviarComRecibo(s, { texto, comandoDeBarra: ehComandoDeBarra, envio, proc });
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
export async function vencerTelaDeConfianca(s: Sessao, daFila = false, procDoEnvio: Sessao["proc"] = s.proc): Promise<void> {
  if (!s.proc || s.proc !== procDoEnvio || !telaDeConfiancaDoCodex(s.telaInteira())) return;
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
    // Se o terminal foi trocado nesse meio tempo, o Enter não pode cair no terminal novo.
    if (s.proc !== procDoEnvio) return;
    s.escrever("\r");
    const limite = Date.now() + 3_000;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 100));
      if (s.proc !== procDoEnvio) return;
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


export interface ContextoDoEnvio {
  texto: string;
  comandoDeBarra: boolean;
  /** O item da fila deste envio (null numa chamada direta). */
  envio: SemRecibo | null;
  /** O terminal em que o texto foi digitado. */
  proc: NonNullable<Sessao["proc"]>;
}

/** Só /compact tem recibo próprio (o PreCompact). Os outros comandos de barra não têm. */
function ehCompact(texto: string): boolean {
  return /^\/compact(\s|$)/.test(texto.trim());
}

type DecisaoDoEnter = { acao: "enter" } | { acao: "esperar" } | { acao: "parar"; tipo: "caixa"; motivo: string };

/** Antes de repetir o Enter, três perguntas: alguém escreveu no terminal depois do último Enter? A tela mostra o
 *  MESMO texto na caixa de composição? Só com as duas respostas certas o Enter se repete. Caixa vazia: o texto
 *  saiu da caixa (o CLI provavelmente o aceitou e o recibo está atrasado), então só espera. Diálogo, menu, texto
 *  diferente ou tela que não se reconhece: não aperta nada, porque um Enter ali poderia aprovar uma permissão ou
 *  mandar um rascunho do dono. */
function decidirEnter(s: Sessao, texto: string, entradasEsperadas: number): DecisaoDoEnter {
  if (s.entradasManuais !== entradasEsperadas) {
    return { acao: "parar", tipo: "caixa", motivo: "houve outra escrita no terminal depois do Enter anterior, e a caixa já não é a mesma" };
  }
  const caixa = estadoDaCaixa(s.telaInteira(), texto);
  if (caixa === "mesmo-texto") return { acao: "enter" };
  if (caixa === "vazia") return { acao: "esperar" };
  return {
    acao: "parar",
    tipo: "caixa",
    motivo: "a tela não mostra o mesmo texto na caixa de composição (pode haver um diálogo, um menu ou outro texto no lugar)",
  };
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
 *  (Codex), que só aparecem quando o CLI ACEITOU o prompt. Sem recibo, o Enter só se repete se a tela
 *  mostrar que o MESMO texto continua na caixa de composição (ver decidirEnter); em qualquer outro caso o
 *  pedido fica retido como incerto.
 *
 *  Devolve true quando o texto está confirmado e false quando NÃO está: os Enters acabaram sem recibo (a vigia
 *  segue em segundo plano), a repetição parou, ou o terminal saiu no meio. Quem chamou pela fila usa isso, e o
 *  `parada` do item, para reter o pedido em vez de dá-lo como entregue.  */
export async function enviarComRecibo(s: Sessao, ctx: ContextoDoEnvio): Promise<boolean> {
  const { texto, comandoDeBarra, envio, proc } = ctx;
  const espera = s.motor.reciboMs;
  // Quantas escritas o PTY deve ter contado se só estes Enters escreveram (ver vigiarReciboAtrasado).
  let entradasEsperadas = s.entradasManuais;
  const compact = ehCompact(texto);
  for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
    if (s.proc !== proc) return terminalTrocado(s, envio);
    let escreveuEnter = false;
    if (tentativa > 1) {
      const d = decidirEnter(s, texto, entradasEsperadas);
      if (d.acao === "parar") {
        log.aviso(
          s.a("entrada"),
          `parei de repetir o Enter (${tentativa - 1}/${RECIBO_ENTER_TENTATIVAS} sem recibo): ${d.motivo}; não sei se o pedido foi recebido`,
        );
        if (envio) {
          envio.interrompido = true;
          envio.parada = { tipo: "caixa", motivo: `a repetição do Enter parou: ${d.motivo}` };
        }
        return false;
      }
      // Comando de barra sem recibo próprio (/clear, /model...) com a caixa vazia: o comando foi consumido.
      if (d.acao === "esperar" && comandoDeBarra && !compact) return true;
      escreveuEnter = d.acao === "enter";
    } else {
      escreveuEnter = true;
    }
    const antes = s.promptsAceitos;
    const compactAntes = s.compactsIniciados;
    if (escreveuEnter) {
      // O recibo deste pedido só vale se vier depois do PRIMEIRO Enter dele: o contador é marcado aqui, antes da escrita.
      if (envio && !envio.enterEscrito) {
        envio.promptsAntes = s.promptsAceitos;
        envio.enterEscrito = true;
      }
      s.escrever("\r");
      entradasEsperadas = s.entradasManuais;
    }
    const recebeu = await esperarRecibo(s, antes, espera, comandoDeBarra ? compactAntes : undefined);
    if (recebeu) return true;
    if (escreveuEnter) {
      const proxima = tentativa < RECIBO_ENTER_TENTATIVAS ? decidirEnter(s, texto, entradasEsperadas).acao : null;
      const fim =
        proxima === "enter" ? "; o mesmo texto continua na caixa, batendo na tecla de novo"
        : proxima === "esperar" ? "; o texto já saiu da caixa, só espero o recibo"
        : "";
      log.info(s.a("entrada"), `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${espera}ms${fim}`);
    } else {
      log.info(s.a("entrada"), `tentativa ${tentativa}/${RECIBO_ENTER_TENTATIVAS} sem recibo em ${espera}ms (o texto já saiu da caixa, não repeti o Enter)`);
    }
    // Sem nenhum hook há mais de 60 s não existe recibo possível: esperar mais não prova nada. As tentativas
    // acabam aqui e o pedido fica retido como incerto (nunca declarado entregue, nunca digitado de novo).
    if (semHooksDeVerdade(s) && estadoDaCaixa(s.telaInteira(), texto) !== "mesmo-texto") {
      return semRecibosPossivel(s, envio, comandoDeBarra && !compact);
    }
  }
  if (semHooksDeVerdade(s)) return semRecibosPossivel(s, envio, comandoDeBarra && !compact);
  // Ainda dá para insistir sem segurar quem chamou: a vigia segue em segundo plano e só ela dá o ERRO final.
  const total = RECIBO_ENTER_TENTATIVAS + s.reciboVigiaPassosMs.length;
  const segundos = Math.round(s.reciboVigiaPassosMs.reduce((a, b) => a + b, 0) / 1000);
  log.info(
    s.a("entrada"),
    `${RECIBO_ENTER_TENTATIVAS} Enters sem recibo; continuo tentando em segundo plano por ~${segundos}s (até ${s.reciboVigiaPassosMs.length} verificações espaçadas; o Enter só se repete com o mesmo texto na caixa)`,
  );
  if (s.proc !== proc) return terminalTrocado(s, envio);
  vigiarReciboAtrasado(s, ctx, total, entradasEsperadas);
  return false;
}

/** Claude sem nenhum hook há mais de 60 s: o pedido foi digitado e o Enter escrito, mas não há como provar que o
 *  CLI o recebeu. Não é declarado entregue. Comando de barra sem recibo próprio não tem o que provar. */
function semRecibosPossivel(s: Sessao, envio: SemRecibo | null, barraSemRecibo: boolean): boolean {
  if (barraSemRecibo) return true;
  log.aviso(
    s.a("entrada"),
    `o ${s.motor.binario} não mandou nenhum hook desde que abriu (mais de ${Math.round(s.prazoSemHooksMs / 1000)}s): não há como provar que ele recebeu o pedido, ` +
      `então o pedido não é dado como entregue e fica retido como incerto`,
  );
  if (envio) envio.parada = { tipo: "sem-hooks", motivo: "o agente não manda hooks, então não há recibo possível" };
  return false;
}

/** Continua olhando, em segundo plano, depois que as tentativas de enviarComRecibo falharam.
 *  Cada passo olha primeiro o recibo (o turno pode ter aberto sozinho, só atrasado) e só então decide
 *  se bate a tecla: com a sessão fora de idle, algo abriu turno por outro caminho e basta esperar; com a
 *  caixa vazia o texto já saiu dela e também basta esperar; só com o MESMO texto na caixa o Enter se repete.
 *  Só no fim, sem recibo, o pedido vai para retidos. Uma vigia por sessão. */
function vigiarReciboAtrasado(s: Sessao, ctx: ContextoDoEnvio, total: number, entradasDoEnvio: number): void {
  const { texto, comandoDeBarra, envio, proc } = ctx;
  if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
  s.vigiaDoRecibo = null;
  if (s.proc !== proc) return;
  const antes = s.promptsAceitos;
  const compactAntes = s.compactsIniciados;
  const compact = ehCompact(texto);
  const inicio = Date.now();
  const passos = s.reciboVigiaPassosMs;
  const aceito = () => s.promptsAceitos > antes || (comandoDeBarra && s.compactsIniciados > compactAntes);
  // Toda escrita no PTY passa por s.escrever() e soma em entradasManuais. Se o número mudou sem ser pela
  // própria vigia, alguém mexeu na caixa (o dono pelo terminal, ou um texto novo sendo digitado): o que
  // está lá já não é o texto que esta vigia tenta enviar, e um Enter dela poderia mandar um rascunho.
  let entradasEsperadas = entradasDoEnvio;

  const reterEste = (motivo: string, suspender: boolean) => {
    if (!envio?.aguardando) return;
    if (suspender) suspenderPorRascunho(s);
    reter(s, envio.item, motivo);
    talvezSoltarFila(s);
  };

  const passo = (i: number): void => {
    s.vigiaDoRecibo = null;
    if (s.proc !== proc) return;
    if (aceito()) {
      log.info(
        s.a("entrada"),
        `o turno abriu atrasado, ${Math.round((Date.now() - inicio) / 1000)}s depois do texto digitado`,
      );
      if (envio?.barra) liberarBarra(s, envio);
      return;
    }
    const d = decidirEnter(s, texto, entradasEsperadas);
    if (comandoDeBarra && !compact && d.acao === "esperar") {
      // Comando de barra sem recibo próprio e a caixa vazia: o comando foi consumido.
      if (envio?.barra) liberarBarra(s, envio);
      return;
    }
    if (i >= passos.length) {
      const naCaixa = d.acao === "enter";
      if (naCaixa) {
        log.erro(
          s.a("entrada"),
          `digitei ${total} Enters e nenhum abriu turno: o texto ficou escrito na caixa de entrada do agente`,
          "olhar a tela (GET /api/agents/:id/terminal) e dar um Enter à mão, ou reenviar por POST /api/agents/:id/input",
        );
      } else {
        log.aviso(
          s.a("entrada"),
          `o texto saiu da caixa de entrada, mas o agente não confirmou o pedido em ~${Math.round((Date.now() - inicio) / 1000)}s; não sei se ele foi recebido`,
        );
      }
      // Sem recibo depois de todas as verificações: o pedido fica retido como incerto (não trava os próximos, e o
      // texto fica guardado no arquivo da fila). Nunca é digitado de novo sozinho. Se o texto pode ter ficado na
      // caixa, a digitação automática deste terminal fica suspensa.
      reterEste(`${total} tentativas e nenhuma virou turno`, d.acao !== "esperar");
      return;
    }
    if (d.acao === "parar") {
      log.info(s.a("entrada"), `parei de insistir no Enter: ${d.motivo}`);
      // O pedido pendente não tem como ser provado nem repetido com segurança: fica retido. Como há outra coisa
      // na caixa (provavelmente o dono escrevendo, ou um diálogo), a digitação automática fica suspensa.
      if (envio) envio.interrompido = true;
      reterEste("a repetição do Enter parou porque a caixa de entrada mudou", true);
      return;
    }
    if (d.acao === "enter" && s.estado.status === "idle") {
      log.info(
        s.a("entrada"),
        `o Enter atrasado ${RECIBO_ENTER_TENTATIVAS + i + 1}/${total} (ainda sem recibo, e o mesmo texto continua na caixa); batendo na tecla de novo`,
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

/** Claude sem NENHUM hook vivo e já passado o prazo de boot desde o spawn: agente sem hooks registrados
 *  (settings recusado, versão sem hooks), para o qual não existe recibo possível. Antes do prazo a falta de hook
 *  só quer dizer "ainda não chegou", e um Claude com os hooks travados é igual a esse caso (incidente de
 *  18/11/2026: o pedido foi digitado sem recibo e sumiu). Nesse caso o pedido NÃO é dado como entregue: fica
 *  retido como incerto. */
export function semHooksDeVerdade(s: Sessao): boolean {
  return !s.hooksVivos && !s.motor.reciboPorRollout && Date.now() - s.spawnEm >= s.prazoSemHooksMs;
}

/** Espera o contador de prompts aceitos passar de `antes`. Sem recibo dentro do limite, false: nem o prazo de
 *  "agente sem hooks" transforma a falta de recibo em entrega (ver semHooksDeVerdade). */
export function esperarRecibo(s: Sessao, antes: number, limiteMs: number, compactAntes?: number): Promise<boolean> {
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
