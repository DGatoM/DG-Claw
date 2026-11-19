// O catálogo de provedores (Claude, Codex, ...) lido de providers/catalogo.json.
//
// Porta para TypeScript de scripts/provedores/catalogo.mjs, que é a referência: a
// regra de validação tem que ser a MESMA nos dois lados, senão o painel aceita uma
// escolha que o runner recusa (ou o contrário) e a pessoa só descobre quando o
// agente sobe. Se uma regra mudar lá, muda aqui.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lerCacheOpenRouter } from "./openrouter-modelos.js";

export class ErroCatalogo extends Error {}

export interface ModoDeAuth {
  nome: string;
  explica?: string;
  conferir?: string;
  logar?: string;
  variavel?: string;
  ondeCriar?: string;
  limpar?: string[];
  /** Prefixos de variáveis que saem do ambiente neste modo (exceto a variável do próprio modo). */
  limparPrefixos?: string[];
  /** A variável do modo só vale se estiver no Cofre do agente: chave herdada do ambiente do serviço não conta. */
  soDoCofre?: boolean;
}

export interface ModeloDoCatalogo {
  id: string;
  nome: string;
  apelidos?: string[];
  /** Só nos modelos vindos do OpenRouter: preço em dólares por milhão de tokens (null = o OpenRouter não informou). */
  entradaPorMilhao?: number | null;
  saidaPorMilhao?: number | null;
}

export interface ProvedorDoCatalogo {
  nome: string;
  disponivel: boolean;
  motivo?: string;
  binario: string;
  instalar?: string;
  auth: Record<string, ModoDeAuth>;
  canaisTelegram?: boolean;
  modeloPadrao?: string;
  modelosDe?: string;
  modelos?: ModeloDoCatalogo[];
  /** Provedor que só abre cards (OpenCode): nunca serve de motor da conversa principal. */
  soCard?: boolean;
  motivoSoCard?: string;
}

export interface Catalogo {
  versao: number;
  provedores: Record<string, ProvedorDoCatalogo>;
}

export interface OpcoesDeModelos {
  codexHome?: string;
  soApi?: boolean;
  /** Libera o provedor que só abre cards (a sessão paralela passa true). */
  paraCard?: boolean;
  /** Arquivo do cache do OpenRouter (padrão: arquivoCacheOpenRouter()). */
  cacheOpenRouter?: string;
}

export interface EscolhaValidada {
  provedor: string;
  auth: string;
  modelo: string;
}

/** `runner/src/provedores` (ou `runner/dist/provedores`) sobe três pastas até a raiz do repo. */
export const CATALOGO_PADRAO = fileURLToPath(new URL("../../../providers/catalogo.json", import.meta.url));

/** O mínimo para o agente subir quando o catalogo.json some: só o padrão (Claude na assinatura). */
export function catalogoDeEmergencia(): Catalogo {
  return {
    versao: 1,
    provedores: {
      claude: {
        nome: "Claude",
        disponivel: true,
        binario: "claude",
        auth: {
          assinatura: {
            nome: "na assinatura",
            limpar: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
          },
        },
        canaisTelegram: true,
        modelos: [],
      },
    },
  };
}

function listaPt(xs: string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ou ${xs[xs.length - 1]}`;
}

export function caminhoDoCatalogo(): string {
  return process.env.DGCLAW_CATALOGO?.trim() || CATALOGO_PADRAO;
}

export function carregar(arquivo: string = caminhoDoCatalogo()): Catalogo {
  let bruto: string;
  try {
    bruto = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    throw new ErroCatalogo(
      `Não consegui ler o catálogo de provedores em ${arquivo}: ${err instanceof Error ? err.message : err}`,
    );
  }
  try {
    return JSON.parse(bruto) as Catalogo;
  } catch (err) {
    throw new ErroCatalogo(
      `O catálogo de provedores em ${arquivo} não é um JSON válido: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function provedorDe(cat: Catalogo, id: string): ProvedorDoCatalogo {
  const p = cat.provedores && Object.hasOwn(cat.provedores, id) ? cat.provedores[id] : undefined;
  if (!p) {
    throw new ErroCatalogo(`Provedor '${id}' não existe. Os que existem: ${Object.keys(cat.provedores ?? {}).join(", ")}.`);
  }
  return p;
}

/** Para o Codex quem manda é o cache do próprio CLI (models_cache.json); sem ele,
 *  vale a lista de reserva do catálogo. */
export function modelos(cat: Catalogo, id: string, opcoes: OpcoesDeModelos = {}): ModeloDoCatalogo[] {
  const p = provedorDe(cat, id);
  if (p.modelosDe === "openrouter_api") {
    const c = lerCacheOpenRouter(opcoes.cacheOpenRouter);
    if (c) {
      // Os apelidos (glm, kimi...) vivem na lista de reserva do catálogo e valem também para o cache.
      const apelidos = new Map((p.modelos ?? []).map((m) => [m.id, m.apelidos ?? []]));
      return c.modelos.map((m) => ({ ...m, apelidos: apelidos.get(m.id) ?? m.apelidos ?? [] }));
    }
  }
  if (p.modelosDe === "codex_models_cache") {
    const home = opcoes.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")) as {
        models?: Array<{ slug: string; display_name?: string; visibility?: string; supported_in_api?: boolean }>;
      };
      if (Array.isArray(cache.models) && cache.models.length) {
        return cache.models
          .filter((m) => m.visibility === "list" && (!opcoes.soApi || m.supported_in_api === true))
          .map((m) => ({ id: m.slug, nome: m.display_name || m.slug, apelidos: [] }));
      }
    } catch {
      /* sem cache legível: cai na lista de reserva do catálogo, que é o comportamento desenhado */
    }
  }
  return (p.modelos ?? []).map((m) => ({ ...m }));
}

/** Devolve a escolha com o modelo no id canônico ('' = padrão do provedor). */
export function validar(
  cat: Catalogo,
  id: string,
  auth: string,
  modelo = "",
  opcoes: OpcoesDeModelos = {},
): EscolhaValidada {
  const p = provedorDe(cat, id);
  if (!p.disponivel) {
    throw new ErroCatalogo(`O provedor ${p.nome} ainda não está disponível: ${p.motivo || "em preparo"}.`);
  }
  if (!p.auth || !Object.hasOwn(p.auth, auth)) {
    throw new ErroCatalogo(`Forma de pagar '${auth}' não existe para ${p.nome}. Use: ${listaPt(Object.keys(p.auth))}.`);
  }
  // Provedor que só abre cards (OpenCode) nunca serve de motor da conversa principal.
  if (p.soCard && !opcoes.paraCard) {
    throw new ErroCatalogo(`O ${p.nome} ${p.motivoSoCard || "abre só cards"}. Escolha Claude ou Codex para a conversa principal.`);
  }
  // No OpenCode o modelo sempre vai explícito: vazio vira o padrão do catálogo.
  if (!modelo && p.modelosDe === "openrouter_api") modelo = p.modeloPadrao || "";
  if (!modelo) return { provedor: id, auth, modelo: "" };
  const lista = modelos(cat, id, { ...opcoes, soApi: auth === "api" });
  const m = modelo.toLowerCase();
  const achado = lista.find((x) => x.id.toLowerCase() === m || (x.apelidos ?? []).some((a) => a.toLowerCase() === m));
  if (!achado) {
    const ids =
      lista.length > 12
        ? `${lista
            .slice(0, 12)
            .map((x) => x.id)
            .join(", ")} e mais ${lista.length - 12} (lista completa: catalogo.mjs modelos ${id})`
        : lista.map((x) => x.id).join(", ") || "(nenhum)";
    throw new ErroCatalogo(`Modelo '${modelo}' não existe para ${p.nome} ${p.auth[auth].nome}. Os válidos: ${ids}.`);
  }
  return { provedor: id, auth, modelo: achado.id };
}

export function rotulo(cat: Catalogo, id: string, auth: string, modelo = "", opcoes: OpcoesDeModelos = {}): string {
  const v = validar(cat, id, auth, modelo, opcoes);
  const p = cat.provedores[id];
  let nomeModelo: string;
  if (v.modelo) {
    const m = modelos(cat, id, { ...opcoes, soApi: auth === "api" }).find((x) => x.id === v.modelo);
    nomeModelo = m?.nome || v.modelo;
  } else {
    nomeModelo = `${p.nome} (modelo padrão)`;
  }
  return `${nomeModelo}, ${p.auth[auth].nome}`;
}
