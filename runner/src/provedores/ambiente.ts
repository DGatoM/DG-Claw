// O ambiente do processo do CLI, montado por MODO de pagamento.
//
// Função pura, de propósito: é aqui que se decide qual credencial o agente enxerga,
// e isso precisa ser testável sem subir PTY nenhum. A regra inteira cabe em uma
// frase: o agente vê UMA forma de pagar, a que o dono escolheu.
//
// Por que não basta "não passar a chave": qualquer uma das variáveis de LLM que
// sobrar no ambiente passa por cima do login escolhido. O caso concreto está em
// docs/PROVEDORES.md: `CODEX_API_KEY` falsa deixou o `codex exec` pendurado 90 s
// tentando usá-la em vez da assinatura. Por isso cada modo do catálogo traz a lista
// `limpar`, e este módulo a aplica.
import fs from "node:fs";
import type { Catalogo, ModoDeAuth } from "./catalogo.js";
import { provedorDe } from "./catalogo.js";
import { log } from "../logger.js";

/**
 * Chave de LLM que chega ao agente por HERANÇA de ambiente (o runner foi iniciado por
 * um shell que tinha a chave exportada) nunca entra: o agente do cliente não é dono
 * dela. O que o dono guardou de propósito no cofre do agente é outra coisa, e passa
 * (ver `nomesDoCofre`): a `OPENAI_API_KEY` do cofre serve às ferramentas do agente
 * (gerar imagem, por exemplo), não ao CLI. Esse filtro valia para tudo antes de
 * 12/10/2026 e jogava fora a chave que o dono tinha posto de propósito.
 *
 * Sobre o que vem do cofre vale só a lista `limpar` do modo escolhido: ela tira as
 * variáveis que mudariam a cobrança do CLI (`ANTHROPIC_API_KEY` na assinatura do
 * Claude, por exemplo). A única exceção de cada modo é a variável que ele próprio usa
 * (`api` e `token`), que fica.
 */
export const CHAVES_QUE_NAO_PASSAM = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_AI_API_KEY",
]);

const NOME_DE_VARIAVEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINHA_DO_COFRE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;
export const ARQUIVO_DO_COFRE_PADRAO = "/run/dgclaw/cofre/cofre.env";

/**
 * Os NOMES guardados no cofre do agente (EnvironmentFile da unidade), lidos do arquivo
 * `NOME='valor'` que o painel grava. Só os nomes: o valor continua vindo do `process.env`,
 * e nunca é lido nem logado aqui. Arquivo ausente = cofre vazio (não é erro: agente sem cofre).
 */
export function nomesDoCofre(arquivo: string = process.env.DGCLAW_COFRE_ARQUIVO?.trim() || ARQUIVO_DO_COFRE_PADRAO): Set<string> {
  const nomes = new Set<string>();
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.erro(
        "env",
        `não consegui ler os nomes do cofre em ${arquivo}: ${err instanceof Error ? err.message : err}`,
        "conferir a permissão de leitura do arquivo do cofre; sem ele, chaves de LLM herdadas e as do cofre são tratadas igual (saem do ambiente)",
      );
    }
    return nomes;
  }
  for (const linha of cru.split("\n")) {
    if (!linha.trim() || linha.trim().startsWith("#")) continue;
    const m = linha.match(LINHA_DO_COFRE);
    if (m) nomes.add(m[1]);
  }
  return nomes;
}

export interface EntradaDoAmbiente {
  /** O `process.env` do runner, que já traz o cofre do agente (EnvironmentFile). */
  base: Record<string, string | undefined>;
  /** `config.envExtra` do descritor (pode ser inválido: vem de um arquivo de cliente). */
  envExtra?: unknown;
  provedor: string;
  auth: string;
  catalogo: Catalogo;
  /** Os nomes que vieram do cofre (ver `nomesDoCofre`). Só nomes: a função continua pura. */
  cofre?: ReadonlySet<string>;
}

export interface ResultadoDoAmbiente {
  env: Record<string, string>;
  /** O modo escolhido, como está no catálogo. */
  modo: ModoDeAuth;
  /** A variável que carrega a credencial do modo (`api` e `token`), ou null. */
  variavelDoModo: string | null;
  /** true quando o modo exige uma variável e ela está presente e não vazia. */
  chaveDoModoPresente: boolean;
  /** Nomes (nunca valores) que saíram do ambiente, com o motivo. */
  removidas: Array<{ nome: string; motivo: "herdada, não está no cofre" | "outra forma de pagar (limpar do modo)" }>;
  /** Nomes do envExtra que não puderam entrar (nome inválido ou valor que não é texto). */
  recusadas: string[];
  /** Nomes do envExtra aplicados. */
  aplicadas: string[];
}

export function montarAmbiente(ent: EntradaDoAmbiente): ResultadoDoAmbiente {
  const modo = provedorDe(ent.catalogo, ent.provedor).auth[ent.auth];
  if (!modo) {
    throw new Error(`o modo de pagamento '${ent.auth}' não existe para o provedor '${ent.provedor}' no catálogo`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ent.base)) {
    if (v != null) env[k] = v;
  }

  const aplicadas: string[] = [];
  const recusadas: string[] = [];
  const extra = ent.envExtra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (typeof v !== "string" || !NOME_DE_VARIAVEL.test(k)) {
        recusadas.push(k);
        continue;
      }
      env[k] = v;
      aplicadas.push(k);
    }
  }

  const variavelDoModo = modo.variavel?.trim() || null;
  const cofre = ent.cofre ?? new Set<string>();
  const porHeranca = new Set([...CHAVES_QUE_NAO_PASSAM].filter((n) => !cofre.has(n)));
  const porModo = new Set(modo.limpar ?? []);
  const removidas: ResultadoDoAmbiente["removidas"] = [];
  for (const nome of new Set([...porHeranca, ...porModo])) {
    if (nome === variavelDoModo || !(nome in env)) continue;
    // As do `limpar` valem mesmo vindas do cofre; as da lista de herança só quando NÃO estão no cofre.
    removidas.push({ nome, motivo: porModo.has(nome) ? "outra forma de pagar (limpar do modo)" : "herdada, não está no cofre" });
    delete env[nome];
  }

  return {
    env,
    modo,
    variavelDoModo,
    chaveDoModoPresente: variavelDoModo ? Boolean(env[variavelDoModo]?.trim()) : true,
    removidas,
    recusadas,
    aplicadas,
  };
}
