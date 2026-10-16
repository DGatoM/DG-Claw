// "Está mesmo conectado?": a conferência que o painel mostra ao lado do provedor.
//
// Roda o comando de conferência do próprio CLI (`claude auth status --json`,
// `codex login status`) com o MESMO ambiente que o spawn usaria, e devolve só o que
// é seguro mostrar. A saída crua NUNCA sai daqui: a do Claude traz e-mail, orgId e
// nome da organização; a do Codex na API traz um pedaço da chave. Por isso este
// módulo lê campos escolhidos (Claude) ou procura palavras (Codex) e descarta o resto.
import { execFile } from "node:child_process";

export interface Conferido {
  /** true = conectado como o dono escolheu; false = não; null = ainda não sei. */
  ok: boolean | null;
  /** Como o CLI diz que está conectado: assinatura | token | api, ou null. */
  metodo: string | null;
  detalhe: string;
  em: string | null;
}

const PRAZO_DO_COMANDO_MS = 15_000;
const CACHE_MS = 60_000;
const ESPERA_DO_GET_MS = 3_000;

function nomeDoModo(modo: string): string {
  switch (modo) {
    case "assinatura":
      return "assinatura";
    case "token":
      return "código de acesso de longa duração";
    case "api":
      return "chave de API";
    default:
      return modo;
  }
}

function agora(): string {
  return new Date().toISOString();
}

function resultado(ok: boolean | null, metodo: string | null, detalhe: string): Conferido {
  return { ok, metodo, detalhe, em: agora() };
}

export const CONFERINDO: Conferido = {
  ok: null,
  metodo: null,
  detalhe: "Conferindo com o CLI; atualize em alguns segundos.",
  em: null,
};

/** `claude auth status --json`: usa só `loggedIn`, `authMethod` e `subscriptionType`. */
export function interpretarStatusDoClaude(saida: string, authEscolhido: string): Conferido {
  let o: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
  try {
    o = JSON.parse(saida) as typeof o;
    if (!o || typeof o !== "object") throw new Error("não é um objeto");
  } catch {
    return resultado(false, null, "Não consegui entender a resposta do 'claude auth status'. Atualize o Claude Code e tente de novo.");
  }
  const logado = o.loggedIn === true;
  const metodo =
    o.authMethod === "claude.ai" ? "assinatura" : o.authMethod === "oauth_token" ? "token" : o.authMethod === "api_key" ? "api" : null;
  const plano = typeof o.subscriptionType === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(o.subscriptionType) ? o.subscriptionType : null;
  if (!logado || metodo === null) {
    const dica =
      authEscolhido === "assinatura"
        ? "Entre com a conta do Claude pelo botão de login do painel."
        : `Confira a variável do modo '${nomeDoModo(authEscolhido)}' no Cofre do painel.`;
    return resultado(false, null, `O Claude não está conectado neste agente. ${dica}`);
  }
  if (metodo !== authEscolhido) {
    return resultado(
      false,
      metodo,
      `O agente está configurado para ${nomeDoModo(authEscolhido)}, mas o Claude está conectado por ` +
        `${nomeDoModo(metodo)}. Corrija a forma de pagar no painel ou o que está no Cofre, e reinicie o agente.`,
    );
  }
  // Com chave falsa o CLI também diz loggedIn:true (ele não valida a chave), por isso o
  // texto fala em "configurada" e nunca em "válida".
  const detalhe =
    metodo === "assinatura"
      ? `Conta do Claude conectada${plano ? ` (plano ${plano})` : ""}.`
      : metodo === "token"
        ? "Código de acesso de longa duração configurado (o Claude não confirma se ele ainda vale)."
        : "Chave de API configurada (o Claude não confirma se ela vale).";
  return resultado(true, metodo, detalhe);
}

/** `codex login status`: exit 0 e uma linha com "ChatGPT" ou "API key". Nenhum trecho da linha é repassado. */
export function interpretarStatusDoCodex(saida: string, codigo: number | null, authEscolhido: string): Conferido {
  const t = saida.toLowerCase();
  const metodo = codigo === 0 ? (t.includes("chatgpt") ? "assinatura" : t.includes("api key") ? "api" : null) : null;
  if (metodo === null) {
    const dica =
      authEscolhido === "assinatura"
        ? "Entre com a conta do ChatGPT pelo botão de login do painel."
        : "Confira a OPENAI_API_KEY no Cofre do painel e reinicie o agente.";
    return resultado(false, null, `O Codex não está conectado neste agente. ${dica}`);
  }
  if (metodo !== authEscolhido) {
    return resultado(
      false,
      metodo,
      `O agente está configurado para ${nomeDoModo(authEscolhido)}, mas o Codex está conectado por ` +
        `${nomeDoModo(metodo)}. Corrija a forma de pagar no painel e reinicie o agente.`,
    );
  }
  return resultado(
    true,
    metodo,
    metodo === "assinatura" ? "Conta do ChatGPT conectada." : "Chave de API configurada no Codex (o Codex não confirma se ela vale).",
  );
}

function rodar(
  binario: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<{ saida: string; erroPadrao: string; codigo: number | null; falha?: "sem-binario" | "tempo" | "outra" }> {
  return new Promise((resolve) => {
    execFile(binario, args, { env, cwd, timeout: PRAZO_DO_COMANDO_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const erroPadrao = String(stderr ?? "");
      if (!err) return resolve({ saida: String(stdout), erroPadrao, codigo: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.code === "ENOENT") return resolve({ saida: "", erroPadrao, codigo: null, falha: "sem-binario" });
      if (e.killed) return resolve({ saida: "", erroPadrao, codigo: null, falha: "tempo" });
      resolve({ saida: String(stdout ?? ""), erroPadrao, codigo: typeof e.code === "number" ? e.code : 1, falha: "outra" });
    });
  });
}

export interface PedidoDeConferencia {
  provedor: "claude" | "codex";
  auth: string;
  env: Record<string, string>;
  cwd?: string;
  /** No Codex na API o login por chave só acontece quando o agente sobe. */
  codexApiAindaSemLogin?: boolean;
}

export async function conferirProvedor(p: PedidoDeConferencia): Promise<Conferido> {
  const binario = p.provedor;
  if (p.provedor === "codex" && p.auth === "api" && p.codexApiAindaSemLogin) {
    return resultado(null, "api", "A chave será registrada no Codex quando o agente subir; ainda não há o que conferir.");
  }
  const args = p.provedor === "claude" ? ["auth", "status", "--json"] : ["login", "status"];
  const r = await rodar(binario, args, p.env, p.cwd);
  if (r.falha === "sem-binario") {
    return resultado(false, null, `O programa '${binario}' não está instalado neste agente (não está no PATH do serviço). Instale-o e reinicie o agente.`);
  }
  if (r.falha === "tempo") {
    return resultado(false, null, `O '${binario} ${args.join(" ")}' não respondeu em ${PRAZO_DO_COMANDO_MS / 1000} s. Tente de novo; se persistir, reinicie o agente.`);
  }
  // O `codex login status` real escreve "Logged in using ..." no STDERR (visto no teste B6, 12/10/2026:
  // chave registrada e turno respondido, e o painel dizia "não está conectado" porque só se lia o stdout).
  // O Claude imprime JSON no stdout, e misturar o stderr estragaria o parse.
  return p.provedor === "claude"
    ? interpretarStatusDoClaude(r.saida, p.auth)
    : interpretarStatusDoCodex(`${r.saida}\n${r.erroPadrao}`, r.codigo, p.auth);
}

/** Cache de 60 s por sessão, e uma conferência por vez. O GET nunca espera mais de 3 s:
 *  o seletor do painel chama esta rota para cada agente e não pode travar. */
export class Conferidor {
  private cache = new Map<string, { res: Conferido; ate: number; chave: string }>();
  private rodando = new Map<string, Promise<Conferido>>();

  invalidar(sessao: string): void {
    this.cache.delete(sessao);
    this.rodando.delete(sessao);
  }

  async obter(sessao: string, chave: string, executar: () => Promise<Conferido>, esperaMs = ESPERA_DO_GET_MS): Promise<Conferido> {
    const c = this.cache.get(sessao);
    if (c && c.chave === chave && c.ate > Date.now()) return c.res;
    let p = this.rodando.get(sessao);
    if (!p) {
      const nova: Promise<Conferido> = executar()
        .catch((err) => resultado(false, null, `Não consegui conferir: ${err instanceof Error ? err.message : err}`))
        .then((res) => {
          if (this.rodando.get(sessao) === nova) {
            this.cache.set(sessao, { res, ate: Date.now() + CACHE_MS, chave });
            this.rodando.delete(sessao);
          }
          return res;
        });
      this.rodando.set(sessao, nova);
      p = nova;
    }
    let tempo: NodeJS.Timeout | undefined;
    const limite = new Promise<null>((r) => {
      tempo = setTimeout(() => r(null), esperaMs);
    });
    const pronto = await Promise.race([p, limite]);
    clearTimeout(tempo);
    if (pronto) return pronto;
    const velho = this.cache.get(sessao);
    return velho && velho.chave === chave ? velho.res : { ...CONFERINDO };
  }
}
