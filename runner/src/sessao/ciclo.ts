import pty from "node-pty";
import type { Sessao } from "../sessao.js";
import { randomUUID } from "node:crypto";
import { gravarEstado, lerEstado } from "../config-runner.js";
import { log } from "../logger.js";
import { MascaraDeFluxo } from "../mascara.js";
import { type CtxMotor, ErroDeMotor, redigirArgs } from "../provedores/motor.js";
import { motorDe } from "../provedores/motores.js";
import { montarCtx } from "./configuracao.js";
import { RESUME_MORREU_CEDO_MS } from "./constantes.js";
import { cancelarQuietoDeBoot, cancelarStopPendente } from "./eventos.js";
import { cancelarReintentoDaFila } from "./fila.js";
import { conferirLoginExpiradoNoTranscript, encerrarIncidenteDeLogin } from "./login.js";
import { aoReceberDados, descarregarMascara } from "./terminal.js";
import { pararVigiaDoStopPerdido, vigiarRolloutDoCodex, vigiarStopPerdido } from "./vigias.js";

/**
 * Sobe o agente. `modo`:
 *   "retomar": continua a sessão que já existe (`--resume`). É o caminho de
 *               todo boot do serviço: o cliente não pode perder a conversa
 *               porque a máquina reiniciou.
 *   "nova"   : sessão nova, guardando a anterior em `previousSessionId` para
 *               nada ser perdido sem volta.
 *
 * Devolve o modo com que realmente subiu: "retomar" vira "nova" quando o provedor
 * ou a forma de pagar mudaram desde o último spawn, porque o id da conversa antiga
 * pertence a outro CLI ou a outra conta e não abriria.
 */
export function subir(s: Sessao, modo: "retomar" | "nova"): Promise<"retomar" | "nova"> {
  // `geracao` é lida já aqui, antes de qualquer espera: uma parada ou um revive DEPOIS deste pedido cancela a subida, mesmo que ela ainda esteja na fila.
  const geracaoNoPedido = s.geracao;
  const entrar = (): Promise<"retomar" | "nova"> => enfileirarSubida(s, modo, geracaoNoPedido);
  // Um revive em curso decide qual conversa vale: quem chega no meio dele (resume, login, auto-restart)
  // espera ele terminar, senão o resume passava na frente e subia a conversa ORIGINAL.
  if (s.reviveEmCurso) return s.reviveEmCurso.then(entrar, entrar);
  return entrar();
}

/** Fila reservada ANTES de qualquer await: duas chamadas que esperavam a mesma faxina passavam juntas
 *  pela guarda `s.proc` ainda nula e faziam dois spawn. A segunda agora só roda depois da primeira
 *  e cai em "pedido de subir ignorado". O erro da anterior vai para o chamador dela, não envenena a fila. */
function enfileirarSubida(s: Sessao, modo: "retomar" | "nova", geracaoNoPedido: number): Promise<"retomar" | "nova"> {
  const seguir = (): Promise<"retomar" | "nova"> => subirSerializado(s, modo, geracaoNoPedido);
  const minha = s.filaDeSubida.then(seguir, seguir);
  s.filaDeSubida = minha;
  return minha;
}

/**
 * Sessão NOVA guardando a anterior, como uma operação só: espera o claude antigo morrer (e o grupo dele
 * ser varrido) e sobe o novo. Com os dois vivos ao mesmo tempo o novo caiu com código 129 meio segundo
 * depois de subir (Wells, 30/10/2026). Dois revives simultâneos dividem a mesma operação.
 * Um parar() (remove, suspender) durante a espera cancela a subida, inclusive antes de o PTY antigo sair.
 */
export function reviver(s: Sessao): Promise<void> {
  if (s.reviveEmCurso) return s.reviveEmCurso;
  s.geracao++;
  const op = (async () => {
    // O parar() roda na parte síncrona de pararEEsperar: a marca lida logo depois já o inclui,
    // e qualquer parada posterior (a do remove) a torna velha. Pedidos de subir anteriores ao revive ficam velhos também.
    const parada = pararEEsperar(s, "revive");
    const marca = s.geracao;
    await parada;
    // Direto na fila, sem passar pela espera do revive: esperar por si mesmo seria um deadlock.
    await enfileirarSubida(s, "nova", marca);
  })().finally(() => {
    if (s.reviveEmCurso === op) s.reviveEmCurso = null;
  });
  s.reviveEmCurso = op;
  return op;
}

async function subirSerializado(s: Sessao, modo: "retomar" | "nova", geracaoNoPedido: number): Promise<"retomar" | "nova"> {
  // Se o PTY anterior saiu sozinho, o grupo dele pode ainda ter filhos vivos: espera a faxina
  // terminar para nunca ter dois claude na mesma sessão (Layla, 30/10/2026).
  // Em laço: enquanto se espera, a saída de outro PTY pode ter começado uma varredura nova.
  while (s.saidaPendente || s.varreduras.size > 0) {
    await Promise.all([s.saidaPendente, ...s.varreduras]);
  }
  // parar() com s.proc nulo (revive esperando a faxina) não tinha o que matar e respondia "parado",
  // mas o claude subia mesmo assim quando a faxina acabava.
  if (s.geracao !== geracaoNoPedido) {
    log.info(
      s.a("pty"),
      `pedido de subir (${modo}) cancelado: chegou uma parada ou um revive enquanto ele esperava a faxina do PTY anterior`,
    );
    return modo;
  }
  if (s.grupoQueSobrou !== null) {
    const pgid = s.grupoQueSobrou;
    if (grupoVivo(pgid)) {
      const cmd = `ps -o pid,pgid,stat,cmd -g ${pgid}`;
      log.erro(
        s.a("pty"),
        `não subo outro ${s.motor.binario}: o processo antigo (pid/pgid ${pgid}) continuou com processos vivos depois do SIGTERM e do SIGKILL, e um segundo agente na mesma sessão corrompe a conversa`,
        `conferir com "${cmd}" e encerrar à mão; na próxima tentativa de subir o runner confere de novo`,
      );
      s.mudar({
        status: "errored",
        error: `O processo antigo do agente (pid/pgid ${pgid}) não morreu e ainda segura a sessão. Para conferir: ${cmd}. Quando ele sumir, tente subir de novo.`,
        statusReason: "runner:antigo-vivo",
      });
      return modo;
    }
    log.info(s.a("pty"), `o grupo antigo (pgid ${pgid}) sumiu; sigo com o spawn`);
    s.grupoQueSobrou = null;
  }
  if (s.proc) {
    log.info(s.a("pty"), `pedido de subir ignorado: já existe PTY vivo (pid ${s.proc.pid})`);
    return s.modoDoUltimoSpawn ?? modo;
  }
  s.marcarAtividade();
  encerrarIncidenteDeLogin(s);

  const { escolha, problemas, catalogo } = s.lerEscolha();
  for (const p of problemas) log.erro(s.a("escolha"), p.motivo, p.comoResolver);
  const motorMudou = s.motor.provedor !== escolha.provedor;
  s.escolhaVigente = escolha;
  s.motor = motorDe(escolha.provedor);
  if (motorMudou) {
    s.hooksVivos = false;
    s.estado.hookActive = false;
  }

  // O id guardado só abre no CLI e na conta que o criaram. Sem `escolha` gravada (estado
  // de antes desta função existir) o CLI era o Claude.
  const gravada = lerEstado(s.arquivoDeEstado).escolha ?? (s.estado.sessionId ? { provedor: "claude", auth: "", modelo: "" } : null);
  if (
    modo === "retomar" &&
    s.estado.sessionId &&
    gravada &&
    (gravada.provedor !== escolha.provedor || (gravada.auth && gravada.auth !== escolha.auth))
  ) {
    log.info(
      s.a("pty"),
      `o provedor ou a forma de pagar mudou (de ${gravada.provedor}${gravada.auth ? `/${gravada.auth}` : ""} ` +
        `para ${escolha.provedor}/${escolha.auth}): o id ${s.estado.sessionId} é de outro CLI ou de outra conta, ` +
        `então subo uma conversa NOVA e guardo a antiga em previousSessionId`,
    );
    modo = "nova";
  }

  const ctx = montarCtx(s, escolha, catalogo);
  s.ctxVivo = ctx;

  // SEM LOGIN, O PTY SOBE ASSIM MESMO, E ISSO É DELIBERADO.
  //
  // A primeira versão desta guarda barrava o spawn, e ela consertava um
  // problema criando outro. O que ela consertava continua valendo: um agente
  // sem credencial parava na tela de escolha de conta, reportava `idle`, e
  // engolia em silêncio tudo o que o cliente escrevesse.
  //
  // O que ela quebrou: sem PTY, o terminal do cartão fica PRETO, e a tela de
  // login era justamente por onde o dono logava: pelo cartão, sem precisar de
  // terminal na máquina. A guarda tirou o único caminho de login de quem não
  // tem ssh, que é o motivo de o cartão existir.
  //
  // Então agora são as duas coisas ao mesmo tempo, que nunca foram opostas:
  // o PTY nasce e o dono vê a tela de login no cartão, E o estado vai para
  // `errored` com o motivo, o que faz o `POST /input` do cliente ser recusado
  // com 409 SEM_LOGIN em vez de virar texto digitado numa tela de login.
  // Quem digita PELO TERMINAL (terminal_input, o dono) continua passando: é
  // outro caminho, e é o caminho do login.
  //
  // A FALTA DE CHAVE é outro caso: nos modos `api` e `token` não há tela de login
  // para mostrar, e subir o CLI sem a chave o faria cair na assinatura sem ninguém
  // pedir. Aí o PTY NÃO sobe: a sessão fica `errored` com o motivo.
  const recusa = s.motor.motivoSemLogin(ctx);
  if (recusa?.tipo === "chave") {
    // O erro do estado é o que o painel mostra: precisa dizer também o que fazer.
    s.mudar({ status: "errored", error: `${recusa.mensagem} O que fazer: ${recusa.comoResolver}.`, statusReason: "runner:sem-chave" });
    log.erro(s.a("pty"), recusa.mensagem, recusa.comoResolver);
    s.modoDoUltimoSpawn = modo;
    return modo;
  }
  if (recusa) {
    log.erro(s.a("pty"), recusa.mensagem, "logar pelo terminal do cartão; o runner assume assim que a credencial aparecer");
  }

  // O preparo pode demorar (o login por chave do Codex leva alguns segundos): já é `spawning`.
  s.mudar({ status: "spawning", error: null, statusReason: "runner:preparando" });
  try {
    await s.motor.preparar(ctx);
    s.codexHomeUsado = s.motor.provedor === "codex" ? (ctx.env.CODEX_HOME ?? null) : null;
  } catch (err) {
    for (const f of ctx.limpezas) f();
    const erro =
      err instanceof ErroDeMotor
        ? err
        : new ErroDeMotor(
            `O preparo do ${s.motor.binario} falhou: ${err instanceof Error ? err.message : String(err)}`,
            "runner:preparo-falhou",
            "ver o log do runner e tentar de novo",
          );
    s.mudar({ status: "errored", error: erro.message, statusReason: erro.statusReason });
    log.erro(s.a("pty"), erro.message, erro.comoResolver);
    s.modoDoUltimoSpawn = modo;
    return modo;
  }

  // O preparo é um await de segundos (login por chave do Codex): uma parada ou um revive que cheguem
  // nele também cancelam a subida. Ainda não mexemos no sessionId, então nada da conversa muda.
  if (s.geracao !== geracaoNoPedido) {
    for (const f of ctx.limpezas) f();
    log.info(s.a("pty"), `pedido de subir (${modo}) cancelado: chegou uma parada ou um revive durante o preparo do ${s.motor.binario}`);
    s.mudar({ status: s.estado.sessionId ? "resumable" : "stopped", statusReason: "runner:subida-cancelada" });
    return modo;
  }

  let args: string[];
  if (modo === "retomar" && s.estado.sessionId) {
    args = s.motor.argsRetomar(ctx, s.estado.sessionId);
    s.retomando = { sessionId: s.estado.sessionId, em: Date.now() };
    s.mudar({ status: "spawning", error: null, statusReason: "runner:resume" });
    log.info(s.a("pty"), `retomando a sessão ${s.estado.sessionId}`);
  } else {
    s.retomando = null;
    if (modo === "retomar") {
      log.info(s.a("pty"), "não há sessão anterior registrada; subindo uma sessão nova");
    }
    // O Codex não aceita pré-fixar o id: ele é descoberto no rollout depois do spawn.
    const novo = s.motor.provedor === "claude" ? randomUUID() : null;
    ctx.novoId = novo;
    s.mudar({
      status: "spawning",
      error: null,
      sessionId: novo,
      previousSessionId: s.estado.sessionId ?? s.estado.previousSessionId ?? null,
      statusReason: "runner:sessao-nova",
    });
    args = s.motor.argsNova(ctx);
    log.info(
      s.a("pty"),
      `sessão nova ${novo ?? "(o id será descoberto no rollout do Codex)"}` +
        (s.estado.previousSessionId ? ` (anterior guardada: ${s.estado.previousSessionId})` : ""),
    );
  }
  s.modoDoUltimoSpawn = modo;
  await spawn(s, ctx, args);

  // Depois do spawn, e não antes: o `mudar` do spawn põe `spawning`, e este
  // aqui é que fica valendo. Sem isto o boot-timer de 8s marcaria `idle` e o
  // painel voltaria a dizer que está tudo bem.
  if (recusa && s.proc) {
    s.mudar({ status: "errored", error: recusa.mensagem, statusReason: "runner:sem-login" });
    esperarLogin(s);
  }
  return modo;
}

export async function spawn(s: Sessao, ctx: CtxMotor, args: string[]): Promise<void> {
  const cwd = ctx.cwd;
  const binario = s.motor.binario;

  log.info(s.a("pty"), `subindo: ${binario} ${redigirArgs(args).join(" ")}`);
  log.info(s.a("pty"), `casa: ${cwd}`);
  let esteProc: pty.IPty;
  try {
    esteProc = pty.spawn(binario, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: ctx.env,
    });
  } catch (err) {
    for (const f of ctx.limpezas) f();
    const motivo = err instanceof Error ? err.message : String(err);
    s.mudar({ status: "errored", error: motivo, statusReason: "runner:spawn-falhou" });
    log.erro(
      s.a("pty"),
      `pty.spawn("${binario}") falhou em ${cwd}: ${motivo}`,
      `conferir se o executável "${binario}" está no PATH DESTE serviço ` +
        `(systemctl show dgclaw-agent-${s.descritor.slug} -p Environment) e se a casa do agente existe`,
    );
    return;
  }
  s.proc = esteProc;

  log.info(s.a("pty"), `PTY de pé, pid ${esteProc.pid}`);
  s.buffer = [];
  s.bufferBytes = 0;
  s.caudaDaTela = "";
  s.spawnEm = Date.now();
  s.mudar({ status: "spawning", statusReason: "runner:spawn" });
  // O id da conversa só vale para este CLI e esta conta: grava de quem é, para o boot seguinte decidir.
  gravarEstado({ escolha: ctx.escolha }, s.arquivoDeEstado);

  const pararVigias: Array<() => void> = [];
  if (s.motor.provedor === "codex") pararVigias.push(vigiarRolloutDoCodex(s, esteProc, ctx));

  // Uma máscara por spawn: o que o CLI escreve passa por ela antes de chegar ao buffer da tela e ao painel.
  const mascara = new MascaraDeFluxo(s.segredosParaMascara());
  s.mascaraAtual = mascara;
  esteProc.onData((d) => {
    // PTY largado por parar(): o que ele ainda escreve não pode sujar o buffer nem o status do atual.
    if (s.proc !== esteProc) return;
    aoReceberDados(s, d, mascara);
  });
  esteProc.onExit(({ exitCode, signal }) => {
    for (const parar of pararVigias) parar();
    for (const f of ctx.limpezas) f();
    // O líder do grupo morreu, mas o claude cria filhos (servidores MCP, subshells) no mesmo grupo,
    // e eles não morrem junto quando o líder cai por sinal. Sem varrer o grupo aqui, o runner subia
    // um claude novo ao lado dos órfãos. Vale para toda saída, pedida ou não.
    // Conjunto, não slot único: o onExit atrasado de um PTY largado pode chegar com a varredura do PTY
    // novo em curso, e sobrescrever a marca deixaria o subir() seguir com o grupo novo ainda vivo.
    const minha: Promise<void> = varrerGrupoOrfao(s, esteProc.pid, exitCode, signal).finally(() => {
      s.varreduras.delete(minha);
    });
    s.varreduras.add(minha);
    varreduraDoPty.set(esteProc, minha);
    // Saída de um PTY que parar() já tinha largado: o kill é assíncrono, e o
    // evento chega depois que a sessão pode ter subido outro PTY (suspensa e
    // acordada logo em seguida, ou revive). Tratar como saída "do atual"
    // apagaria o PTY novo e marcaria a sessão como caída.
    if (s.proc !== esteProc) {
      log.info(s.a("pty"), `PTY antigo (pid ${esteProc.pid}) terminou depois de ter sido encerrado de propósito (código ${exitCode})`);
      return;
    }
    descarregarMascara(s, mascara);
    pararVigiaDoStopPerdido(s);
    aoSair(s, exitCode, signal);
  });

  if (s.motor.usaHooks) vigiarStopPerdido(s, esteProc);

  // Rede de segurança do boot: se nenhum hook chegar (settings recusado, versão
  // do CLI sem hooks), o agente não pode ficar preso em "spawning" para sempre.
  setTimeout(() => {
    if (s.estado.status !== "spawning" || s.proc !== esteProc) return;
    // Um agente sem credencial não está `idle`: ele está parado numa tela de
    // login. Dizer `idle` aqui foi o que fez o painel mentir por horas.
    const semLogin = s.recusaDoMotor();
    if (semLogin) {
      s.mudar({ status: "errored", error: semLogin.mensagem, statusReason: "runner:sem-login" });
      return;
    }
    // A credencial existe, mas o fim do transcript pode já dizer que ela morreu (runner reiniciado
    // com a conta expirada): idle aqui seria o mesmo silêncio que este incidente nasceu para acabar.
    if (conferirLoginExpiradoNoTranscript(s, 0, "boot-timer")) return;
    s.mudar({ status: "idle", statusReason: "runner:boot-timer 8s" });
  }, 8_000).unref();
}

/**
 * Fica de olho até a credencial aparecer, e então sobe sozinho.
 *
 * O login é interativo e acontece FORA deste processo: alguém abre um terminal
 * na casa do agente e escolhe a conta (ou usa o login assistido do painel). Sem
 * isto aqui, o runner ficaria parado para sempre depois de logar, e a pessoa que
 * acabou de logar não teria como saber que ainda falta um passo: que era
 * justamente a reclamação de 27/08.
 *
 * Um minuto entre olhadas, e olhar custa um `stat`.
 */
export function esperarLogin(s: Sessao): void {
  if (s.esperandoLogin) return;
  s.esperandoLogin = setInterval(() => {
    if (s.recusaDoMotor()) return;
    trocarPorSessaoLimpa(s);
  }, 60_000);
  // Não segura o processo de pé só por causa deste relógio.
  s.esperandoLogin.unref?.();
}

export function trocarPorSessaoLimpa(s: Sessao): void {
  if (s.esperandoLogin) {
    clearInterval(s.esperandoLogin);
    s.esperandoLogin = null;
  }
  // A sessão em que o login foi feito é DESCARTÁVEL: ela nasceu na tela de
  // escolha de conta e não tem conversa nenhuma. Trocar por uma limpa aqui é
  // o que evita o estrago de 27/08, quando logar dentro da sessão viva do
  // agente matou a conversa dele junto.
  log.info(s.a("pty"), "a credencial apareceu: trocando a sessão do login por uma limpa");
  s.parar("login concluído: trocando por uma sessão limpa");
  setTimeout(() => void s.subir("nova"), 1_500).unref();
}

/** Encerra o PTY sem matar o serviço. O agente fica `resumable` se tem sessão
 *  para voltar: é o estado que faz o painel mostrar o botão de acordar em vez
 *  de dizer que a plataforma sumiu. */
export function parar(s: Sessao, motivo: string, statusReason?: string): void {
  // Antes da guarda: com s.proc nulo ainda pode haver um subir() esperando a faxina, e é ele que cancelamos.
  s.geracao++;
  if (!s.proc) return;
  // Parada pedida nunca é "retomada que falhou". O kill é assíncrono e o `encerrando` volta a
  // false antes de a saída chegar; sem esquecer a retomada aqui, o SIGTERM no meio de uma
  // retomada (restart logo depois do boot) virava "a sessão não abriu" e o runner trocava a
  // conversa por uma sessão nova (Layla, jaula, 31/10/2026: código 143 em 5s).
  s.retomando = null;
  const antigoProc = s.proc;
  s.encerrando = true;
  try {
    s.proc.kill();
  } catch (err) {
    log.aviso(s.a("pty"), `kill do pid ${s.proc.pid} reclamou: ${err instanceof Error ? err.message : err}`);
  }
  registrarSaidaPendente(s, antigoProc);
  s.proc = null;
  s.encerrando = false;
  cancelarQuietoDeBoot(s);
  cancelarReintentoDaFila(s);
  if (s.mascaraAtual) descarregarMascara(s, s.mascaraAtual);
  s.mudar({
    status: s.estado.sessionId ? "resumable" : "stopped",
    statusReason: statusReason ?? `runner:parado ${motivo}`,
  });
}

/** Como parar(), mas só volta depois que o processo antigo morreu de verdade.
 *  Na troca de forma de pagar o CLI antigo carrega no ambiente a chave do modo
 *  antigo (ex.: ANTHROPIC_API_KEY): subir o novo com o velho ainda vivo deixa uma
 *  janela em que o dono escolheu um modo e outro continua gastando (B6, card 4,
 *  12/10/2026). O SIGHUP do parar() não basta se o CLI o ignora; passado o prazo,
 *  vai SIGKILL no grupo inteiro (o node-pty faz o filho líder de sessão, então
 *  -pid pega também os servidores MCP). Nunca lança. */
export async function pararEEsperar(s: Sessao, motivo: string, prazoMs = 5_000): Promise<void> {
  const antigo = s.proc;
  if (!antigo) return;
  const pid = antigo.pid;
  let saiu = false;
  let acordar: () => void = () => {};
  const saida = new Promise<void>((resolve) => {
    acordar = resolve;
  });
  antigo.onExit(() => {
    saiu = true;
    acordar();
  });
  s.parar(motivo);

  const esperar = async (ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const limite = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    });
    await Promise.race([saida, limite]);
    if (timer) clearTimeout(timer);
  };

  await esperar(prazoMs);
  if (saiu) return;

  let forcou = "mandei SIGKILL no grupo do processo";
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    forcou = "mandei SIGKILL só no processo";
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      forcou = `tentei o SIGKILL e não consegui (${err instanceof Error ? err.message : err})`;
    }
  }
  log.aviso(
    s.a("pty"),
    `o processo antigo (pid ${pid}) não saiu em ${prazoMs / 1000}s com o SIGHUP na parada (${motivo}); ${forcou}`,
  );

  await esperar(2_000);
  if (saiu) return;
  s.grupoQueSobrou = pid;
  log.erro(
    s.a("pty"),
    `o processo antigo (pid ${pid}) continuou vivo mesmo depois do SIGKILL (${motivo}); ele pode estar rodando com o ambiente do modo antigo`,
    `conferir com "ps -o pid,cmd -p ${pid}" e encerrar esse processo à mão antes de confiar na troca`,
  );
}

/** Dorme uma sessão PARALELA para devolver memória. Ela fica `resumable` e a
 *  conversa continua no disco: o próximo input a acorda com --resume. A
 *  principal nunca dorme, porque é a conversa do cliente. */
export function suspender(s: Sessao, motivo: string): boolean {
  if (s.papel !== "paralela") {
    log.erro(
      s.a("pty"),
      `pedido de suspender a sessão principal ${s.descritor.id} (${motivo})`,
      "a principal fica sempre acordada; só sessões paralelas são suspensas",
    );
    return false;
  }
  if (!s.proc) return false;
  if (s.filaQuandoIdle.length) {
    log.aviso(
      s.a("entrada"),
      `suspendendo com ${s.filaQuandoIdle.length} texto(s) ainda na fila; eles ficam guardados e saem na próxima vez que a sessão acordar e ficar ociosa`,
    );
  }
  s.parar(motivo, `runner:suspensa ${motivo}`);
  return true;
}

/** O grupo `-pgid` ainda tem algum processo? (EPERM também conta como vivo.) */
function grupoVivo(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Prazo máximo que subir() espera um PTY largado por parar() sair e ter o grupo varrido. */
const PRAZO_SAIDA_PENDENTE_MS = 8_000;

/** A varredura de cada PTY, para o onExit dele esperar a DELE e não a que estiver em curso. */
const varreduraDoPty = new WeakMap<object, Promise<void>>();

/** Chamada por parar() NO MOMENTO em que larga o PTY: cria a promessa que subir() espera, para nenhum
 *  segundo claude nascer antes de o antigo sair e o grupo dele ser varrido. Se o prazo vence com o
 *  grupo ainda vivo, anota em `grupoQueSobrou` e subir() recusa. */
function registrarSaidaPendente(s: Sessao, antigo: Sessao["proc"]): void {
  if (!antigo) return;
  const pid = antigo.pid;
  const pend = new Promise<void>((resolve) => {
    let saiu = false;
    const prazo = setTimeout(() => {
      // Saída já chegou: a varredura está em curso e é ela que resolve (o prazo não pode passar na frente).
      if (saiu) return;
      if (grupoVivo(pid)) s.grupoQueSobrou = pid;
      resolve();
    }, PRAZO_SAIDA_PENDENTE_MS);
    // O listener do spawn (que inicia a varredura) foi registrado antes deste, então já rodou.
    antigo.onExit(() => {
      saiu = true;
      void (async () => {
        await varreduraDoPty.get(antigo);
        clearTimeout(prazo);
        resolve();
      })();
    });
  }).finally(() => {
    if (s.saidaPendente === pend) s.saidaPendente = null;
  });
  s.saidaPendente = pend;
}

/** Garante que não sobra processo no grupo `-pid` de um PTY que saiu: SIGTERM, curta espera, SIGKILL.
 *  O node-pty faz o filho líder de uma sessão nova, então o grupo é só dele (nunca o do runner).
 *  Nunca lança. */
async function varrerGrupoOrfao(s: Sessao, pid: number, exitCode: number, signal?: number): Promise<void> {
  const vivo = (): boolean => grupoVivo(pid);
  const esperarMorrer = async (ms: number): Promise<boolean> => {
    const limite = Date.now() + ms;
    while (Date.now() < limite) {
      if (!vivo()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !vivo();
  };
  if (pid <= 1 || pid === process.pid || !vivo()) return;
  const sobrou = (): void => {
    s.grupoQueSobrou = pid;
  };
  const area = s.a("pty");
  const saida = `código ${exitCode}${signal ? `, sinal ${signal}` : ""}`;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    log.erro(area, `o PTY (pid ${pid}) saiu (${saida}) deixando processos no grupo, e o SIGTERM no grupo falhou: ${err instanceof Error ? err.message : err}`, `conferir com "ps -o pid,pgid,cmd -g ${pid}" e encerrar à mão antes de confiar que só há um claude`);
    sobrou();
    return;
  }
  if (await esperarMorrer(1_500)) {
    log.aviso(area, `o PTY (pid ${pid}) saiu (${saida}) deixando processos no grupo; encerrei o grupo com SIGTERM`);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // o grupo pode ter acabado entre o teste e o kill; a conferência abaixo decide
  }
  if (await esperarMorrer(1_000)) {
    log.aviso(area, `o PTY (pid ${pid}) saiu (${saida}) deixando processos no grupo que ignoraram o SIGTERM; encerrei o grupo com SIGKILL`);
    return;
  }
  sobrou();
  log.erro(area, `o grupo do PTY (pid ${pid}) continuou com processos vivos depois do SIGTERM e do SIGKILL (saída: ${saida})`, `conferir com "ps -o pid,pgid,stat,cmd -g ${pid}"; processo em estado D (disco) não morre, e o claude novo pode ter um irmão antigo na mesma sessão`);
}

export function aoSair(s: Sessao, exitCode: number, signal?: number): void {
  log.info(s.a("pty"), `PTY saiu (código ${exitCode}${signal ? `, sinal ${signal}` : ""})`);
  s.proc = null;
  cancelarStopPendente(s);
  cancelarQuietoDeBoot(s);
  cancelarReintentoDaFila(s);
  const retomada = s.retomando;
  s.retomando = null;
  if (s.encerrando) return;

  // A retomada que morre na largada. O caso real: o transcript daquela sessão
  // não existe (ou não abre), e o CLI sai com código 1 em dois segundos. Sem
  // este ramo o agente ficaria `resumable` para sempre e o `Restart=always`
  // não ajudaria, porque quem está de pé é o runner, não o PTY. Para o cliente
  // isso é o agente simplesmente mudo.
  //
  // A saída é subir uma sessão NOVA, guardando a que não abriu em
  // `previousSessionId`: a conversa antiga continua no disco e pode ser
  // reapontada depois. Perder o histórico é ruim; ficar sem agente é pior, e
  // só um dos dois é reversível.
  if (
    retomada &&
    exitCode !== 0 &&
    Date.now() - retomada.em < RESUME_MORREU_CEDO_MS &&
    !s.retomadasQueFalharam.has(retomada.sessionId)
  ) {
    s.retomadasQueFalharam.add(retomada.sessionId);
    log.erro(
      s.a("pty"),
      `a sessão ${retomada.sessionId} não abriu: o ${s.motor.binario} saiu com código ${exitCode} em ` +
        `${Math.round((Date.now() - retomada.em) / 1000)}s. A causa quase sempre é o histórico ` +
        `dela não estar no disco (Claude: ~/.claude/projects/<pasta>/${retomada.sessionId}.jsonl; ` +
        `Codex: <CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*-${retomada.sessionId}.jsonl)`,
      `estou subindo uma sessão NOVA para o agente não ficar mudo, e guardando a antiga em ` +
        `previousSessionId (nada foi apagado). Para investigar: conferir se o arquivo existe e ` +
        `se este serviço tem permissão de leitura nele`,
    );
    s.subir("nova").catch((err) =>
      log.erro(
        s.a("pty"),
        `nem a sessão nova subiu: ${err instanceof Error ? err.message : err}`,
        `conferir o executável ${s.motor.binario} e a casa do agente; o serviço vai continuar tentando a cada restart`,
      ),
    );
    return;
  }

  // Saída não pedida. `resumable` e não `errored`: a conversa continua no
  // disco e o botão de acordar tem que aparecer. `errored` mandaria o painel
  // mostrar falha onde há só um terminal fechado.
  s.mudar({
    status: s.estado.sessionId ? "resumable" : "stopped",
    statusReason: `runner:pty-saiu codigo=${exitCode}`,
    error: exitCode === 0 ? null : `o processo ${s.motor.binario} saiu com código ${exitCode}`,
  });
}
