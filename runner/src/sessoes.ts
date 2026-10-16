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
import { randomBytes } from "node:crypto";
import {
  AGENT_FILE,
  NOTAS_PADRAO,
  PASTA_DE_ESTADO,
  STATE_FILE,
  validarSessao,
  validarSessoes,
  type ConfigDoRunner,
  type DescritorDoAgente,
  type SessaoParalelaDescrita,
  type SessaoParalelaValida,
} from "./config-runner.js";
import { carregar, validar, ErroCatalogo } from "./provedores/catalogo.js";
import { gravarJsonAtomico } from "./provedores/arquivos.js";
import { gravarProvedorJson, provedorDoVocabulario } from "./provedores/escolha.js";
import { calcularCapacidade, descreverMemoria, type Capacidade } from "./capacidade.js";
import { Sessao } from "./sessao.js";
import { log } from "./logger.js";

const NOTA_INTERVALO_MS = 30 * 60_000;
const LACO_PADRAO_MS = 60_000;
/** Quantas sessões criadas por API podem existir ao mesmo tempo, se RUNNER_MAX_SESSOES_EXTRAS não disser. */
const MAX_EXTRAS_PADRAO = 3;

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
    // A persona da principal não se herda: a paralela tem a dela (identidade).
    identidadeArquivo: undefined,
  };
}

function caminhoDasNotas(d: DescritorDoAgente): string {
  return path.resolve(d.config.cwd, d.notasPrincipal?.trim() || NOTAS_PADRAO);
}

/** O pedido de uma sessão criada em tempo de execução (POST /api/sessoes). */
export type PedidoDeSessaoExtra = Record<string, unknown>;

export type ResultadoDeSessaoExtra =
  | { ok: true; sessao: Sessao }
  | { ok: false; status: number; error: string; howToFix: string; code: string };

const falhaDeExtra = (status: number, code: string, error: string, howToFix: string) =>
  ({ ok: false, status, code, error, howToFix }) as const;

export class GerenteDeSessoes {
  readonly principal: Sessao;
  private readonly mapaParalelas = new Map<string, Sessao>();
  /** As paralelas criadas por API (sessoes-extras.json). As do descritor não saem por API. */
  private readonly extras = new Map<string, SessaoParalelaDescrita>();
  private ultimaNotaEm = 0;
  private laco: NodeJS.Timeout | null = null;
  private aoCriar: Array<(s: Sessao) => void> = [];

  constructor(readonly descritor: DescritorDoAgente, private readonly porta: number, private readonly pastaDeEstado: string = PASTA_DE_ESTADO) {
    this.principal = new Sessao(
      { id: descritor.id, slug: descritor.slug, config: descritor.config },
      porta,
      { pastaDeEstado, idsEmUso: () => this.idsDeSessaoEmUso() },
    );
    for (const s of validarSessoes(descritor)) this.registrar(s, "boot");
    this.carregarExtras();
  }

  /** O arquivo das sessões criadas por API: na pasta de estado, porque o runner.json é só leitura. */
  arquivoDasExtras(): string {
    return path.join(this.pastaDeEstado, "sessoes-extras.json");
  }

  private idsDeSessaoEmUso(): Set<string> {
    const ids = new Set<string>();
    for (const x of this.todas()) {
      if (x.estado.sessionId) ids.add(x.estado.sessionId);
      if (x.estado.previousSessionId) ids.add(x.estado.previousSessionId);
    }
    return ids;
  }

  /** Cria a Sessao paralela e a põe no mapa. false = a config dela não pôde existir (já registrado no log). */
  private registrar(s: SessaoParalelaValida, origem: "boot" | "extra"): boolean {
    const config = configDaSessao(this.descritor, s, STATE_FILE);
    if (!config) return false;
    const arquivoDeEstado = path.join(this.pastaDeEstado, "sessoes", s.id, "runner-state.json");
    try {
      fs.mkdirSync(path.dirname(arquivoDeEstado), { recursive: true });
      fs.mkdirSync(path.dirname(config.envExtra!.DGCHAT_OUTBOUND), { recursive: true });
    } catch (err) {
      log.erro(
        "config",
        `sessoes (${s.id}) ignorada: não consegui criar as pastas dela: ${err instanceof Error ? err.message : err}`,
        `conferir permissão de escrita em ${path.dirname(arquivoDeEstado)} e em ${path.dirname(config.envExtra!.DGCHAT_OUTBOUND)}`,
      );
      return false;
    }
    const sessao = new Sessao({ id: s.id, slug: s.slug, config }, this.porta, {
      arquivoDeEstado,
      pastaDeEstado: this.pastaDeEstado,
      papel: "paralela",
      tipo: s.tipo,
      chat: s.chat,
      titulo: s.titulo,
      promptHooks: s.promptHooks ?? [],
      ociosoMinutos: s.ociosoMinutos,
      identidade: s.identidade,
      escolhaDescrita: { provider: s.provider, model: s.model, auth: s.auth },
      idsEmUso: () => this.idsDeSessaoEmUso(),
    });
    this.mapaParalelas.set(s.id, sessao);
    log.info("boot", `sessão paralela ${s.id} (${s.tipo}, chat ${s.chat}${origem === "extra" ? ", criada por API" : ""}) registrada, dormindo até alguém escrever`);
    for (const f of this.aoCriar) f(sessao);
    return true;
  }

  // --- sessões criadas por API (POST /api/sessoes) -------------------------

  private carregarExtras(): void {
    const arquivo = this.arquivoDasExtras();
    let cru: string;
    try {
      cru = fs.readFileSync(arquivo, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.erro(
          "config",
          `não consegui ler ${arquivo}: ${err instanceof Error ? err.message : err}`,
          "conferir a permissão de leitura; as sessões criadas por API não vão existir até lá (as conversas continuam no disco)",
        );
      }
      return;
    }
    let lista: SessaoParalelaDescrita[];
    try {
      const o = JSON.parse(cru) as { sessoes?: unknown };
      if (!Array.isArray(o.sessoes)) throw new Error('falta a lista "sessoes"');
      lista = o.sessoes as SessaoParalelaDescrita[];
    } catch (err) {
      log.erro(
        "config",
        `${arquivo} não é um JSON válido de sessões extras: ${err instanceof Error ? err.message : err}`,
        "conferir o arquivo (ele é escrito só pelo runner); as sessões criadas por API não vão existir até lá",
      );
      return;
    }
    for (const bruta of lista) {
      const r = validarSessao(this.descritor, bruta, new Set(this.todas().map((x) => x.id)));
      if (!r.ok) {
        log.erro("config", `sessão extra ignorada em ${arquivo}: ${r.motivo}`, `${r.comoResolver}. As outras sessões sobem normalmente`);
        continue;
      }
      if (this.registrar(r.valida, "extra")) this.extras.set(r.valida.id, bruta);
    }
  }

  private gravarExtras(): void {
    gravarJsonAtomico(this.arquivoDasExtras(), { versao: 1, sessoes: [...this.extras.values()] });
  }

  /** Avisa quem quiser saber (o servidor liga os eventos de WebSocket) quando nasce uma sessão. */
  aoNovaSessao(f: (s: Sessao) => void): void {
    this.aoCriar.push(f);
  }

  ehExtra(id: string): boolean {
    return this.extras.has(id);
  }

  /**
   * O teto de sessões criadas por API (RUNNER_MAX_SESSOES_EXTRAS, inteiro >= 0, padrão 3).
   * Lido a cada criação para o valor poder mudar sem recompilar nada; o aviso de valor
   * inválido sai uma vez só por valor, para não encher o log.
   */
  limiteDeExtras(): number {
    const cru = process.env.RUNNER_MAX_SESSOES_EXTRAS?.trim();
    if (cru === undefined || cru === "") return MAX_EXTRAS_PADRAO;
    if (/^\d+$/.test(cru)) return Number.parseInt(cru, 10);
    if (this.limiteInvalidoAvisado !== cru) {
      this.limiteInvalidoAvisado = cru;
      log.aviso(
        "config",
        `RUNNER_MAX_SESSOES_EXTRAS="${cru}" não é um inteiro maior ou igual a 0; usei o padrão ${MAX_EXTRAS_PADRAO}. Corrija o valor na unidade do runner se quiser outro limite`,
      );
    }
    return MAX_EXTRAS_PADRAO;
  }
  private limiteInvalidoAvisado: string | null = null;

  criarExtra(p: PedidoDeSessaoExtra): ResultadoDeSessaoExtra {
    // O teto vem antes de tudo: cada sessão acordada é um CLI inteiro na RAM do container do cliente.
    const limite = this.limiteDeExtras();
    if (this.extras.size >= limite) {
      return falhaDeExtra(
        429,
        "LIMITE_DE_SESSOES",
        `Já existem ${this.extras.size} sessões criadas por API e o limite é ${limite}. Não criei outra.`,
        "fechar uma que não precisa mais com DELETE /api/sessoes/<id> (pelo comando: dgclaw-card fechar <id>), ou aumentar RUNNER_MAX_SESSOES_EXTRAS na unidade do runner",
      );
    }
    const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const d = this.descritor;
    const id = texto(p.id) ?? (() => {
      for (;;) {
        const novo = `card-${randomBytes(3).toString("hex")}`;
        if (!this.porId(novo)) return novo;
      }
    })();
    if (p.id !== undefined && typeof p.id !== "string") {
      return falhaDeExtra(400, "ID_INVALIDO", `O campo "id" precisa ser texto (veio ${typeof p.id}).`, "mandar o id como texto, ou omitir para o runner escolher");
    }
    if (typeof p.provedor !== "string" || !p.provedor.trim()) {
      return falhaDeExtra(400, "PROVEDOR_OBRIGATORIO", 'Falta o campo "provedor" (claude ou codex).', "mandar { provedor, auth, modelo } no corpo");
    }
    const nomeProvedor = provedorDoVocabulario(p.provedor);
    if (!nomeProvedor) {
      return falhaDeExtra(400, "PROVEDOR_INVALIDO", `O provedor '${p.provedor}' não existe.`, "usar claude ou codex");
    }
    let escolha;
    try {
      escolha = validar(
        carregar(),
        nomeProvedor,
        texto(p.auth) ?? "assinatura",
        typeof p.modelo === "string" ? p.modelo.trim() : "",
        { codexHome: this.descritor.config.envExtra?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || undefined },
      );
    } catch (err) {
      if (err instanceof ErroCatalogo) {
        return falhaDeExtra(400, "ESCOLHA_INVALIDA", err.message, "ver as opções em GET /api/provedor e no catálogo de provedores");
      }
      throw err;
    }
    const identidade = Array.isArray(p.identidade) ? p.identidade : p.identidade === undefined ? [] : [p.identidade];
    if (!identidade.every((x) => typeof x === "string" && x.trim())) {
      return falhaDeExtra(400, "IDENTIDADE_INVALIDA", 'O campo "identidade" precisa ser um caminho de arquivo (ou uma lista deles).', "mandar o caminho relativo à casa do agente");
    }
    const bruta: SessaoParalelaDescrita = {
      id,
      tipo: texto(p.tipo) ?? "card",
      slug: `${d.slug}-${id}`,
      chat: texto(p.chat) ?? `c_${d.slug}-${id}`,
      ...(texto(p.titulo) ? { titulo: texto(p.titulo) } : {}),
      ...(identidade.length ? { identidade: (identidade as string[]).map((x) => x.trim()) } : {}),
    };
    const r = validarSessao(d, bruta, new Set(this.todas().map((x) => x.id)));
    if (!r.ok) {
      return falhaDeExtra(
        r.motivo.includes("aparece mais de uma vez") ? 409 : 400,
        "SESSAO_INVALIDA",
        `Não criei a sessão: ${r.motivo}.`,
        r.comoResolver,
      );
    }
    try {
      gravarProvedorJson(path.join(this.pastaDeEstado, "sessoes", id, "provedor.json"), escolha as { provedor: "claude" | "codex"; auth: string; modelo: string });
    } catch (err) {
      return falhaDeExtra(
        500,
        "NAO_GRAVOU",
        `Não consegui gravar a escolha de provedor da sessão ${id}: ${err instanceof Error ? err.message : err}`,
        `conferir a permissão de escrita em ${this.pastaDeEstado}`,
      );
    }
    if (!this.registrar(r.valida, "extra")) {
      return falhaDeExtra(400, "SESSAO_NAO_PODE_EXISTIR", `A sessão ${id} (${r.valida.tipo}) não pôde ser criada neste agente.`, "ver o log do runner (área config) para o motivo");
    }
    this.extras.set(id, bruta);
    try {
      this.gravarExtras();
    } catch (err) {
      this.extras.delete(id);
      this.mapaParalelas.get(id)?.parar("criação desfeita");
      this.mapaParalelas.delete(id);
      return falhaDeExtra(
        500,
        "NAO_GRAVOU",
        `Não consegui gravar ${this.arquivoDasExtras()}: ${err instanceof Error ? err.message : err}. A sessão ${id} não foi criada.`,
        `conferir a permissão de escrita em ${this.pastaDeEstado}`,
      );
    }
    this.iniciarLaco();
    return { ok: true, sessao: this.mapaParalelas.get(id)! };
  }

  removerExtra(id: string): { ok: true } | { ok: false; status: number; error: string; howToFix: string; code: string } {
    const s = this.mapaParalelas.get(id);
    if (!s) {
      return falhaDeExtra(404, "SESSAO_INEXISTENTE", `Este runner não tem a sessão ${id}.`, "ver as sessões em GET /api/agents?todas=1");
    }
    if (!this.extras.has(id)) {
      return falhaDeExtra(
        409,
        "SESSAO_DO_DESCRITOR",
        `A sessão ${id} é declarada no descritor do agente e não sai por API.`,
        "só sessões criadas por POST /api/sessoes podem ser removidas; para suspender esta, use POST /api/agents/<id>/suspend",
      );
    }
    s.parar("sessão removida por API");
    this.extras.delete(id);
    this.mapaParalelas.delete(id);
    try {
      this.gravarExtras();
    } catch (err) {
      return falhaDeExtra(
        500,
        "NAO_GRAVOU",
        `O terminal da sessão ${id} foi encerrado, mas não consegui regravar ${this.arquivoDasExtras()}: ${err instanceof Error ? err.message : err}. Ela voltaria no próximo boot.`,
        `conferir a permissão de escrita em ${this.pastaDeEstado} e repetir o DELETE`,
      );
    }
    return { ok: true };
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
