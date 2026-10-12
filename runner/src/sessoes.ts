// O gerente das sessões de um agente: a principal e as paralelas.
//
// A principal é a conversa do cliente e é tratada exatamente como sempre foi:
// sobe no boot, nunca dorme, nunca é barrada por capacidade. As paralelas (a
// primeira é a de "bastidores", onde o dono conserta coisas num canto escondido)
// dividem a mesma casa, o mesmo HOME e o mesmo login, mas cada uma tem PTY,
// sessionId, nonce, settings e arquivo de estado próprios. Elas NÃO sobem no
// boot: acordam quando alguém escreve para elas, e dormem sozinhas depois de um
// tempo ociosas, para poupar a RAM do container (que é um só e é do cliente).
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_FILE,
  NOTAS_PADRAO,
  STATE_FILE,
  validarSessoes,
  type ConfigDoRunner,
  type DescritorDoAgente,
  type SessaoParalelaValida,
} from "./config-runner.js";
import { calcularCapacidade, descreverMemoria, type Capacidade } from "./capacidade.js";
import { Sessao } from "./sessao.js";
import { log } from "./logger.js";

const NOTA_INTERVALO_MS = 30 * 60_000;
const LACO_PADRAO_MS = 60_000;

/** Por que uma sessão paralela não pôde acordar. */
export interface Recusa {
  tipo: "capacidade";
  error: string;
  howToFix: string;
  capacidade: Capacidade;
}

export type ResultadoDeAcordar =
  | { ok: true; jaEstavaAcordada: boolean }
  | { ok: false; recusa: Recusa }
  | { ok: false; falha: string };

/**
 * A config da paralela, derivada da da principal. Função pura (não toca disco):
 * quem cria pastas é o gerente. Devolve null quando a sessão não pode existir
 * (bastidores numa principal sem canal de saída), com o motivo no log.
 */
export function configDaSessao(
  d: DescritorDoAgente,
  s: SessaoParalelaValida,
  arquivoDeEstadoPrincipal: string,
): ConfigDoRunner | null {
  const p = d.config;
  const cwd = p.cwd;
  const pasta = path.join(cwd, ".plataforma", "dgchat", "sessoes", s.id);
  const env: Record<string, string> = {
    ...(p.envExtra ?? {}),
    ...(s.envExtra ?? {}),
    DGCHAT_AGENT: s.slug,
    DGCHAT_OUTBOUND: path.join(pasta, "outbound.jsonl"),
    DGCHAT_STATE_FILE: path.join(pasta, "force-reply-state.json"),
    DGCHAT_LOG: path.join(pasta, "stop-force-reply.log"),
    DGCHAT_CHAT_FIXO: s.chat,
    DGCHAT_SESSAO_ID: s.id,
    DGCHAT_SESSAO_TIPO: s.tipo,
  };
  const allow = [...(p.allowTools ?? [])];

  if (s.tipo === "bastidores") {
    const saidaPrincipal = p.envExtra?.DGCHAT_OUTBOUND;
    if (!saidaPrincipal) {
      log.erro(
        "config",
        `sessoes (${s.id}) ignorada: a sessão de bastidores precisa falar com a principal, e a principal não tem DGCHAT_OUTBOUND no envExtra de ${AGENT_FILE}`,
        "preencher config.envExtra.DGCHAT_OUTBOUND na principal (o arquivo de saída do canal dela). A principal e as outras sessões sobem normalmente",
      );
      return null;
    }
    env.DGCHAT_PRINCIPAL_OUTBOUND = saidaPrincipal;
    env.DGCHAT_PRINCIPAL_AGENT = p.envExtra?.DGCHAT_AGENT ?? d.slug;
    env.DGCHAT_PRINCIPAL_CHAT = d.chatPrincipal?.trim() || `c_${d.slug}`;
    env.DGCHAT_NOTAS = caminhoDasNotas(d);
    env.DGCHAT_PRINCIPAL_ESTADO = path.resolve(arquivoDeEstadoPrincipal);
    allow.push("mcp__dgchat__falar_na_conversa_principal", "mcp__dgchat__ler_conversa_principal");
  }
  allow.push(...(s.allowTools ?? []));

  // O `--append-system-prompt-file` herdado é a persona da principal. A paralela
  // tem a própria (identidade), montada a cada spawn pela Sessao.
  const extraArgs: string[] = [];
  const herdados = p.extraArgs ?? [];
  for (let i = 0; i < herdados.length; i++) {
    const arg = herdados[i];
    if (arg === "--append-system-prompt-file") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--append-system-prompt-file=")) continue;
    extraArgs.push(arg);
  }

  return {
    ...p,
    name: s.slug,
    envExtra: env,
    allowTools: [...new Set(allow)],
    extraArgs,
    promptHooks: s.promptHooks ?? [],
  };
}

function caminhoDasNotas(d: DescritorDoAgente): string {
  return path.resolve(d.config.cwd, d.notasPrincipal?.trim() || NOTAS_PADRAO);
}

export class GerenteDeSessoes {
  readonly principal: Sessao;
  private readonly mapaParalelas = new Map<string, Sessao>();
  private ultimaNotaEm = 0;
  private laco: NodeJS.Timeout | null = null;

  constructor(readonly descritor: DescritorDoAgente, porta: number) {
    this.principal = new Sessao(
      { id: descritor.id, slug: descritor.slug, config: descritor.config },
      porta,
    );
    for (const s of validarSessoes(descritor)) {
      const config = configDaSessao(descritor, s, STATE_FILE);
      if (!config) continue;
      const arquivoDeEstado = path.join(path.dirname(AGENT_FILE), "sessoes", s.id, "runner-state.json");
      try {
        fs.mkdirSync(path.dirname(arquivoDeEstado), { recursive: true });
        fs.mkdirSync(path.dirname(config.envExtra!.DGCHAT_OUTBOUND), { recursive: true });
      } catch (err) {
        log.erro(
          "config",
          `sessoes (${s.id}) ignorada: não consegui criar as pastas dela: ${err instanceof Error ? err.message : err}`,
          `conferir permissão de escrita em ${path.dirname(arquivoDeEstado)} e em ${path.dirname(config.envExtra!.DGCHAT_OUTBOUND)}`,
        );
        continue;
      }
      this.mapaParalelas.set(
        s.id,
        new Sessao({ id: s.id, slug: s.slug, config }, porta, {
          arquivoDeEstado,
          papel: "paralela",
          tipo: s.tipo,
          chat: s.chat,
          promptHooks: s.promptHooks ?? [],
          ociosoMinutos: s.ociosoMinutos,
          identidade: s.identidade,
        }),
      );
      log.info("boot", `sessão paralela ${s.id} (${s.tipo}, chat ${s.chat}) registrada, dormindo até alguém escrever`);
    }
  }

  porId(id: string): Sessao | undefined {
    return id === this.principal.id ? this.principal : this.mapaParalelas.get(id);
  }

  todas(): Sessao[] {
    return [this.principal, ...this.mapaParalelas.values()];
  }

  paralelas(): Sessao[] {
    return [...this.mapaParalelas.values()];
  }

  idsAtendidos(): string[] {
    return this.todas().map((s) => s.id);
  }

  // --- capacidade ----------------------------------------------------------

  idsAcordadas(): string[] {
    return this.todas().filter((s) => s.temPtyVivo()).map((s) => s.id);
  }

  capacidade(): Capacidade & { idsAcordadas: string[] } {
    const ids = this.idsAcordadas();
    return { ...calcularCapacidade(this.descritor.capacidade, ids.length), idsAcordadas: ids };
  }

  /** Cabe acordar mais uma paralela? Se não, devolve a recusa pronta (e anota
   *  na principal, no máximo a cada 30 min). Nunca chamar para a principal. */
  verificarCapacidade(sessao: Sessao): Recusa | null {
    const cap = this.capacidade();
    if (cap.podeAcordar) return null;
    const minutos = sessao.ociosoMinutos ?? 20;
    const recusa: Recusa = {
      tipo: "capacidade",
      error:
        `Não há memória para acordar a sessão ${sessao.id} agora: ${cap.acordadas} conversas acordadas ` +
        `(${cap.idsAcordadas.join(", ")}) e o teto é ${cap.teto} (fonte ${cap.fonte}: ${descreverMemoria(cap)}). ` +
        `O texto enviado NÃO foi guardado.`,
      howToFix:
        `esperar uma sessão paralela dormir (elas dormem sozinhas depois de ${minutos} min ociosas), ` +
        `suspender uma à mão com POST /api/agents/<id>/suspend, ou aumentar a memória do container`,
      capacidade: cap,
    };
    log.aviso("capacidade", recusa.error);
    this.anotarNaPrincipal(
      `Aviso do sistema: este agente tentou abrir outra conversa e não coube: ${cap.acordadas} de ${cap.teto} conversas já estão acordadas, no limite de memória da máquina dele. ` +
        `Se a pessoa pedir algo que precise de outra frente de trabalho, avise que pode demorar um pouco.`,
    );
    return recusa;
  }

  /** Acorda uma paralela (conversa antiga com --resume, ou nova se nunca teve). */
  async acordar(id: string, motivo: string): Promise<ResultadoDeAcordar> {
    const s = this.mapaParalelas.get(id);
    if (!s) return { ok: false, falha: `a sessão ${id} não é uma paralela deste runner` };
    if (s.temPtyVivo()) return { ok: true, jaEstavaAcordada: true };
    const recusa = this.verificarCapacidade(s);
    if (recusa) return { ok: false, recusa };
    log.info("sessoes", `acordando ${id}: ${motivo}`);
    await s.subir("retomar");
    if (!s.temPtyVivo()) {
      return {
        ok: false,
        falha:
          `o terminal da sessão ${id} não subiu (status=${s.estado.status}): ${s.estado.error ?? "sem detalhe"}. ` +
          `Ver o log do runner na linha pty[${id.slice(0, 12)}]`,
      };
    }
    const depois = this.capacidade();
    if (depois.pertoDoTeto) {
      this.anotarNaPrincipal(
        `Aviso do sistema: este agente está com ${depois.acordadas} de ${depois.teto} conversas acordadas, perto do limite de memória da máquina dele. ` +
          `Se a pessoa pedir algo que precise de outra frente de trabalho, avise que pode demorar um pouco.`,
      );
    }
    return { ok: true, jaEstavaAcordada: false };
  }

  /** Uma linha no arquivo de notas da principal, no máximo a cada 30 min: a
   *  principal lê as notas e pode avisar o cliente, mas não pode ser inundada. */
  private anotarNaPrincipal(texto: string): void {
    const agora = Date.now();
    if (agora - this.ultimaNotaEm < NOTA_INTERVALO_MS) return;
    const arquivo = caminhoDasNotas(this.descritor);
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      fs.appendFileSync(
        arquivo,
        JSON.stringify({ ts: new Date(agora).toISOString(), origem: "runner:capacidade", tipo: "capacidade", texto }) + "\n",
      );
      this.ultimaNotaEm = agora;
      log.info("capacidade", `nota anotada para a principal em ${arquivo}`);
    } catch (err) {
      log.erro(
        "capacidade",
        `não consegui anotar o aviso em ${arquivo}: ${err instanceof Error ? err.message : err}`,
        "conferir permissão de escrita na pasta das notas (notasPrincipal no descritor); a principal não vai saber que a memória está no limite",
      );
    }
  }

  // --- ociosidade ----------------------------------------------------------

  iniciarLaco(): void {
    if (this.laco || !this.mapaParalelas.size) return;
    const intervalo = Number(process.env.RUNNER_SUSPENSAO_INTERVALO_MS) || LACO_PADRAO_MS;
    this.laco = setInterval(() => this.suspenderOciosas(), intervalo);
    this.laco.unref();
  }

  /** Só status idle com fila vazia dorme: working, waiting_input e spawning
   *  nunca, porque suspender no meio de um turno jogaria trabalho fora. */
  private suspenderOciosas(): void {
    const agora = Date.now();
    for (const s of this.mapaParalelas.values()) {
      if (!s.temPtyVivo() || s.estado.status !== "idle" || s.tamanhoDaFila() > 0) continue;
      const limite = (s.ociosoMinutos ?? 20) * 60_000;
      const parada = agora - s.ultimaAtividadeEm();
      if (parada <= limite) continue;
      const min = Math.round((parada / 60_000) * 10) / 10;
      log.info("sessoes", `suspendendo ${s.id}: ociosa há ${min} min (limite ${s.ociosoMinutos} min)`);
      s.suspender(`ociosa há ${min} min`);
    }
  }

  pararTodas(motivo: string): void {
    if (this.laco) clearInterval(this.laco);
    this.laco = null;
    for (const s of this.todas()) s.parar(motivo);
  }
}
