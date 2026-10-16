// Login assistido: entrar na conta (Claude ou ChatGPT) pelo painel, sem terminal.
//
// O dono de um agente entregue não tem ssh na máquina. O login roda num PTY à parte
// (nunca no PTY da conversa do agente, que seria sujo pela tela de login), o runner
// lê o link que o CLI imprime, e o painel mostra esse link para a pessoa abrir.
//   - Claude: `claude auth login`. A pessoa abre o link, autoriza, copia um código da
//     página e cola de volta; o runner digita o código no PTY (POST .../login/codigo).
//   - Codex: `codex login --device-auth`. A pessoa abre o link e digita o código de
//     dispositivo que o painel mostra; o CLI percebe sozinho e termina.
//
// A saída do CLI fica SÓ em memória e é descartada ao terminar. O log registra apenas
// "login iniciado/concluído/falhou, código de saída N": no link há um estado de OAuth
// e na saída do Codex pode haver outras coisas que não pertencem a um arquivo de log.
import pty from "node-pty";
import { log } from "../logger.js";

export type EstadoDoLogin =
  | "nenhum"
  | "aguardando_link"
  | "aguardando_codigo"
  | "aguardando_navegador"
  | "concluido"
  | "falhou";

export interface VisaoDoLogin {
  estado: EstadoDoLogin;
  link?: string;
  codigoDispositivo?: string;
  mensagem?: string;
}

/** Erro com status HTTP e instrução, no formato que a rota devolve. */
export class ErroDeLogin extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
    readonly code: string,
    readonly comoResolver: string,
  ) {
    super(mensagem);
  }
}

const ESC = "\u001b";
const BEL = "\u0007";
const RE_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const RE_OSC8_ALVO = new RegExp(`${ESC}\\]8;[^;${BEL}${ESC}]*;([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, "g");
const RE_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const RE_LINK_CLAUDE = /https:\/\/claude\.(?:com|ai)\/[^\s"'<>]*oauth\/authorize[^\s"'<>]*/;
const RE_LINK_CODEX = /https:\/\/auth\.openai\.com\/codex\/device/;
const RE_CODIGO_CODEX = /(?<![A-Z0-9-])[A-Z0-9]{4}-[A-Z0-9]{4,5}(?![A-Z0-9-])/;
const BUFFER_MAX = 64 * 1024;
const PRAZO_PADRAO_MS = 15 * 60_000;
const CODIGO_PERMITIDO = /^[A-Za-z0-9#_.~-]{1,512}$/;

/** Tira as sequências de controle (cores, cursor, hiperlink OSC 8) e deixa o texto visível. */
export function limparSaida(bruto: string): string {
  return bruto.replace(RE_OSC, "").replace(RE_CSI, "").replace(/\r/g, "");
}

export function extrairLinkDoClaude(bruto: string): string | null {
  // O alvo do hiperlink (OSC 8) é a URL inteira, mesmo quando o texto visível é um rótulo.
  for (const m of bruto.matchAll(RE_OSC8_ALVO)) {
    const achado = m[1].match(RE_LINK_CLAUDE);
    if (achado) return achado[0];
  }
  return limparSaida(bruto).match(RE_LINK_CLAUDE)?.[0] ?? null;
}

export function extrairDoCodex(bruto: string): { link: string | null; codigo: string | null } {
  const texto = limparSaida(bruto);
  const link = texto.match(RE_LINK_CODEX)?.[0] ?? null;
  const depois = link ? texto.slice(texto.indexOf(link) + link.length) : "";
  return { link, codigo: depois.match(RE_CODIGO_CODEX)?.[0] ?? null };
}

interface Corrente {
  sessao: string;
  provedor: "claude" | "codex";
  proc: pty.IPty;
  bruto: string;
  visao: VisaoDoLogin;
  prazo: NodeJS.Timeout;
  cancelado: boolean;
  aoConcluir: () => void;
}

export interface PedidoDeLogin {
  sessao: string;
  provedor: "claude" | "codex";
  env: Record<string, string>;
  cwd: string;
  /** Roda quando o CLI sai com 0: o chamador invalida o cache de conferência e troca a sessão. */
  aoConcluir: () => void;
}

export class LoginAssistido {
  private corrente: Corrente | null = null;
  private ultimos = new Map<string, VisaoDoLogin>();

  constructor(private readonly prazoMs = PRAZO_PADRAO_MS) {}

  visao(sessao: string): VisaoDoLogin {
    if (this.corrente?.sessao === sessao) return { ...this.corrente.visao };
    return { ...(this.ultimos.get(sessao) ?? { estado: "nenhum" }) };
  }

  iniciar(p: PedidoDeLogin): VisaoDoLogin {
    if (this.corrente) {
      throw new ErroDeLogin(
        `Já existe um login em andamento (sessão ${this.corrente.sessao}). O runner faz um login por vez.`,
        409,
        "LOGIN_EM_ANDAMENTO",
        "terminar esse login, ou cancelar com DELETE /api/provedor/login?sessao=<id>, e então tentar de novo",
      );
    }
    const nome = p.provedor === "claude" ? "Claude" : "Codex";
    const args = p.provedor === "claude" ? ["auth", "login"] : ["login", "--device-auth"];
    const env = p.provedor === "claude" ? { ...p.env, BROWSER: "/bin/true" } : { ...p.env };
    let proc: pty.IPty;
    try {
      // Colunas de sobra: um link comprido quebrado em duas linhas não seria achado.
      proc = pty.spawn(p.provedor, args, { name: "xterm-256color", cols: 1000, rows: 40, cwd: p.cwd, env });
    } catch (err) {
      throw new ErroDeLogin(
        `Não consegui iniciar o login do ${nome}: ${err instanceof Error ? err.message : err}`,
        500,
        "LOGIN_NAO_INICIOU",
        `conferir se o '${p.provedor}' está no PATH do serviço do agente e se a casa ${p.cwd} existe`,
      );
    }
    const c: Corrente = {
      sessao: p.sessao,
      provedor: p.provedor,
      proc,
      bruto: "",
      visao: { estado: "aguardando_link" },
      prazo: setTimeout(() => this.estourou(c), this.prazoMs),
      cancelado: false,
      aoConcluir: p.aoConcluir,
    };
    c.prazo.unref?.();
    this.corrente = c;
    this.ultimos.delete(p.sessao);
    log.info("login", `login do ${nome} iniciado`);
    proc.onData((d) => this.aoReceber(c, d));
    proc.onExit(({ exitCode }) => this.aoSair(c, exitCode));
    return { ...c.visao };
  }

  private aoReceber(c: Corrente, dados: string): void {
    if (this.corrente !== c) return;
    c.bruto += dados;
    if (c.bruto.length > BUFFER_MAX) c.bruto = c.bruto.slice(-BUFFER_MAX);
    if (c.provedor === "claude") {
      const link = extrairLinkDoClaude(c.bruto);
      if (link && c.visao.estado === "aguardando_link") c.visao = { estado: "aguardando_codigo", link };
    } else {
      const { link, codigo } = extrairDoCodex(c.bruto);
      if (link && codigo) c.visao = { estado: "aguardando_navegador", link, codigoDispositivo: codigo };
    }
  }

  private estourou(c: Corrente): void {
    if (this.corrente !== c) return;
    log.aviso("login", `login do ${c.provedor === "claude" ? "Claude" : "Codex"} passou de ${Math.round(this.prazoMs / 60_000)} min sem concluir; encerrando`);
    c.visao = {
      estado: "falhou",
      mensagem: `O login não foi concluído em ${Math.round(this.prazoMs / 60_000)} minutos e foi cancelado. Inicie de novo e termine a autorização no navegador sem demorar.`,
    };
    this.encerrar(c);
  }

  private encerrar(c: Corrente): void {
    c.cancelado = true;
    try {
      c.proc.kill();
    } catch (err) {
      log.aviso("login", `o kill do PTY de login reclamou: ${err instanceof Error ? err.message : err}`);
    }
  }

  private aoSair(c: Corrente, codigo: number): void {
    if (this.corrente !== c) return;
    clearTimeout(c.prazo);
    c.bruto = "";
    this.corrente = null;
    const nome = c.provedor === "claude" ? "Claude" : "Codex";
    if (c.cancelado) {
      const final = c.visao.estado === "falhou" ? { estado: "falhou" as const, mensagem: c.visao.mensagem } : { estado: "nenhum" as const };
      this.ultimos.set(c.sessao, final);
      log.info("login", `login do ${nome} encerrado antes de terminar (código de saída ${codigo})`);
      return;
    }
    if (codigo === 0) {
      this.ultimos.set(c.sessao, { estado: "concluido" });
      log.info("login", `login do ${nome} concluído, código de saída ${codigo}`);
      try {
        c.aoConcluir();
      } catch (err) {
        log.erro(
          "login",
          `o login do ${nome} concluiu, mas o passo seguinte falhou: ${err instanceof Error ? err.message : err}`,
          "reiniciar a sessão pelo painel (POST /api/agents/<id>/reiniciar) para ela enxergar a conta nova",
        );
      }
      return;
    }
    this.ultimos.set(c.sessao, { estado: "falhou", mensagem: mensagemDeFalha(nome, c.provedor) });
    log.aviso("login", `login do ${nome} falhou, código de saída ${codigo}`);
  }

  enviarCodigo(sessao: string, codigo: unknown): void {
    const c = this.corrente;
    if (!c || c.sessao !== sessao || c.visao.estado !== "aguardando_codigo") {
      throw new ErroDeLogin(
        `Não há login do Claude esperando um código agora (estado: ${this.visao(sessao).estado}).`,
        409,
        "LOGIN_FORA_DO_ESTADO",
        "iniciar o login com POST /api/provedor/login, abrir o link e só então enviar o código",
      );
    }
    if (typeof codigo !== "string" || !CODIGO_PERMITIDO.test(codigo.trim())) {
      throw new ErroDeLogin(
        'O campo "codigo" precisa ser o texto que a página do Claude mostrou (até 512 caracteres entre letras, números e # _ . ~ -).',
        400,
        "CODIGO_INVALIDO",
        "copiar o código inteiro da página de autorização e enviar de novo",
      );
    }
    c.proc.write(`${codigo.trim()}\r`);
  }

  cancelar(sessao: string): void {
    const c = this.corrente;
    if (c && c.sessao === sessao) {
      c.visao = { estado: "nenhum" };
      this.encerrar(c);
    }
    this.ultimos.delete(sessao);
  }

  /** Para tudo (desligamento do runner). */
  pararTudo(): void {
    if (this.corrente) this.encerrar(this.corrente);
  }
}

function mensagemDeFalha(nome: string, provedor: "claude" | "codex"): string {
  return provedor === "claude"
    ? `O login do ${nome} não terminou. Confira se o código colado é o da página de autorização e inicie de novo.`
    : `O login do ${nome} não terminou. Confira se o código de dispositivo foi digitado na página certa e inicie de novo.`;
}
