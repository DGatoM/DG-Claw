// Restrições do dono e conta de IA: o runner recusa abrir sessão do Claude quando há restrição ativa e a
// conta conectada pode trazer política administrada remota.
//
// Por quê: as travas do dono (sem Bash, sem enviar arquivo, escrita só em certas pastas) ficam na política
// administrada local do Claude Code. Uma conta Team/Enterprise do claude.ai recebe política remota que
// SUBSTITUI a local, inclusive os ganchos. O `dgclaw agente restricoes` confere a conta na hora de aplicar,
// mas o login pelo painel acontece depois, então a mesma regra roda aqui: depois de cada login concluído
// e antes de abrir ou retomar cada sessão. A regra é a mesma de `_restricoes_classificar_conta` e de
// REMOTA_JS em lib/restricoes.sh (lá é a conferência da CLI; aqui, a do runner). Mexeu em uma, mexa na outra.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_FILE } from "./config-runner.js";

export type ClasseDaConta = "sem" | "com" | "duvida";

/** O restricoes.json fica montado só leitura ao lado do runner.json (no container, /etc/dgclaw-runner). */
export function arquivoDeRestricoes(): string {
  return process.env.RUNNER_RESTRICOES_FILE?.trim() || path.join(path.dirname(AGENT_FILE), "restricoes.json");
}

export type LeituraDeRestricoes = { ativa: false } | { ativa: true; erro?: string };

/**
 * Há restrição ativa? Arquivo ausente = não. Arquivo que existe e não dá para ler ou entender = SIM, com o
 * motivo (falha fechada): na dúvida o agente é tratado como restrito.
 * Ativa = sem_bash ou sem_enviar_arquivo verdadeiros, ou escrita_so_em diferente de nulo (como a CLI).
 */
export function lerRestricoes(arquivo: string = arquivoDeRestricoes()): LeituraDeRestricoes {
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ativa: false };
    return { ativa: true, erro: `não consegui ler ${arquivo} (${e.code ?? e.message})` };
  }
  let j: unknown;
  try {
    j = JSON.parse(cru);
  } catch (err) {
    return { ativa: true, erro: `${arquivo} não é um JSON válido (${err instanceof Error ? err.message : err})` };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ativa: true, erro: `${arquivo} não é um objeto JSON` };
  const r = j as Record<string, unknown>;
  const ativa = r.sem_bash === true || r.sem_enviar_arquivo === true || (r.escrita_so_em !== undefined && r.escrita_so_em !== null);
  return ativa ? { ativa: true } : { ativa: false };
}

/** A saída de `claude auth status --json` vira sem (segue), com (organização Team/Enterprise) ou duvida. Assinatura (claude.ai ou OAuth) só é "sem" com plano pro ou max. */
export function classificarSaidaDaConta(saida: string): ClasseDaConta {
  let j: unknown;
  try {
    j = JSON.parse(saida);
  } catch {
    return "duvida";
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return "duvida";
  const o = j as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean" || typeof o.authMethod !== "string") return "duvida";
  const tipo = typeof o.subscriptionType === "string" ? o.subscriptionType.toLowerCase() : null;
  if (tipo === "team" || tipo === "enterprise") return "com";
  // Login por assinatura (claude.ai ou token OAuth): só um plano pessoal comprovado (lista fechada) segue. Token
  // OAuth de uma organização Team/Enterprise recebe a política remota depois, e sem plano legível não há prova.
  const metodo = o.authMethod.toLowerCase();
  const porAssinatura = metodo === "claude.ai" || metodo.includes("oauth");
  if (o.loggedIn === true && porAssinatura && tipo !== "pro" && tipo !== "max") return "duvida";
  return "sem";
}

/** O cache de política remota (remote-settings.json): sem (ausente ou vazio), com (qualquer chave) ou duvida. */
export function classificarPoliticaRemota(arquivo: string): ClasseDaConta {
  let fd: number;
  try {
    fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const c = (err as NodeJS.ErrnoException).code;
    return c === "ENOENT" || c === "ENOTDIR" ? "sem" : "duvida";
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 1048576) return "duvida";
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = fs.readSync(fd, buf, n, st.size - n, n);
      if (r <= 0) break;
      n += r;
    }
    const j: unknown = JSON.parse(buf.toString("utf8", 0, n));
    if (!j || typeof j !== "object" || Array.isArray(j)) return "duvida";
    return Object.keys(j).length === 0 ? "sem" : "com";
  } catch {
    return "duvida";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // fechar não muda a decisão
    }
  }
}

function statusDaConta(env: Record<string, string>, cwd: string | undefined): Promise<string> {
  return new Promise((resolve) => {
    // O código de saída não conta (sem login o comando sai com erro): decide a saída, e saída vazia é dúvida.
    execFile("claude", ["auth", "status", "--json"], { env, cwd, timeout: 20_000, maxBuffer: 65_536 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

export type ResultadoDaConferencia = { ok: true } | { ok: false; mensagem: string; comoResolver: string };

const COMO_RESOLVER =
  "conectar ao agente uma conta pessoal (Pro ou Max) ou uma chave de API no lugar da conta da organização, pelo painel; " +
  "ou desligar as restrições: dgclaw agente restricoes <nome-do-agente> --sem-bash nao --sem-enviar-arquivo nao --escrita-livre";

/**
 * Conferência do runner. Sem restrição ativa, não muda nada. Com restrição (ou restricoes.json ilegível), a
 * conta precisa ser classificada como "sem" e não pode haver política remota.
 */
export async function conferirContaComRestricoes(env: Record<string, string>, cwd?: string): Promise<ResultadoDaConferencia> {
  const lida = lerRestricoes();
  if (!lida.ativa) return { ok: true };
  if (lida.erro) {
    return {
      ok: false,
      mensagem: `Não consegui conferir as restrições do agente: ${lida.erro}. Por segurança a sessão não abriu.`,
      comoResolver: "o dono do servidor confere o arquivo com: jq . /var/lib/dgclaw/agentes/<nome-do-agente>/runner/restricoes.json , ou refaz as restrições com: dgclaw agente restricoes <nome-do-agente>",
    };
  }
  const pasta = env.CLAUDE_CONFIG_DIR?.trim() || path.join(env.HOME?.trim() || process.env.HOME || "/home/agente", ".claude");
  const remota = classificarPoliticaRemota(path.join(pasta, "remote-settings.json"));
  if (remota !== "sem") {
    return {
      ok: false,
      mensagem:
        remota === "com"
          ? "As restrições do agente não valem com a conta de IA conectada: ela tem política administrada remota, que substitui a configuração do DG Claw. Por segurança a sessão não abriu."
          : "Não consegui ler com segurança a política administrada remota da conta de IA conectada, então não sei se as restrições do agente valem. Por segurança a sessão não abriu.",
      comoResolver: COMO_RESOLVER,
    };
  }
  const conta = classificarSaidaDaConta(await statusDaConta(env, cwd));
  if (conta === "sem") return { ok: true };
  return {
    ok: false,
    mensagem:
      conta === "com"
        ? "As restrições do agente não valem com a conta de IA conectada: ela é de uma organização Team/Enterprise do claude.ai, que pode receber política administrada remota a qualquer momento, e ela substitui a configuração do DG Claw. Por segurança a sessão não abriu."
        : "Não consegui confirmar qual é a conta de IA conectada (claude auth status), então não sei se ela é de uma organização Team/Enterprise do claude.ai, que substituiria a configuração do DG Claw. Por segurança a sessão não abriu.",
    comoResolver: COMO_RESOLVER,
  };
}
