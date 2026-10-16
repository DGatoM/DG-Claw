// Qual provedor, qual forma de pagar e qual modelo uma sessão usa.
//
// Quatro lugares podem dizer, e o primeiro que existir e for VÁLIDO vence:
//   1. provedor.json da sessão (escrito só pelo runner, quando o painel troca);
//   2. os campos da sessão paralela no descritor (sessoes[].provider/model/auth);
//   3. config.provider/model/auth do descritor;
//   4. o padrão: Claude, na assinatura, modelo padrão.
//
// Escolha inválida NUNCA derruba a sessão: é registrada pelo chamador (o que veio,
// de onde, o que fazer) e a resolução cai para o nível seguinte. Quem manda no
// agente do cliente não pode ficar fora do ar por causa de um modelo que saiu da
// lista do Codex na semana passada.
import fs from "node:fs";
import path from "node:path";
import { carregar, catalogoDeEmergencia, validar, ErroCatalogo, type Catalogo } from "./catalogo.js";

export type NomeProvedor = "claude" | "codex";
export type OrigemDaEscolha = "provedor.json" | "descritor" | "padrao";

export interface Escolha {
  provedor: NomeProvedor;
  auth: string;
  modelo: string;
}

export interface EscolhaEfetiva extends Escolha {
  origem: OrigemDaEscolha;
}

export interface CamposDeEscolha {
  provider?: unknown;
  model?: unknown;
  auth?: unknown;
}

export interface Problema {
  motivo: string;
  comoResolver: string;
}

export const ESCOLHA_PADRAO: Escolha = { provedor: "claude", auth: "assinatura", modelo: "" };

/** O vocabulário do runner.json (`local-cli`, `codex-cli`) e o do catálogo (`claude`,
 *  `codex`) são o mesmo conjunto com dois nomes. O catálogo é o do painel. */
export function provedorDoVocabulario(valor: string): NomeProvedor | null {
  switch (valor.trim().toLowerCase()) {
    case "claude":
    case "local-cli":
    case "claude-code":
      return "claude";
    case "codex":
    case "codex-cli":
      return "codex";
    default:
      return null;
  }
}

export function providerDoRunner(p: NomeProvedor): "local-cli" | "codex-cli" {
  return p === "codex" ? "codex-cli" : "local-cli";
}

function texto(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export interface LeituraDoProvedorJson {
  existe: boolean;
  campos?: { provider?: string; model?: string; auth?: string };
  problema?: Problema;
}

export function lerProvedorJson(arquivo: string): LeituraDoProvedorJson {
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { existe: false };
    return {
      existe: true,
      problema: {
        motivo: `não consegui ler ${arquivo}: ${err instanceof Error ? err.message : err}`,
        comoResolver: "conferir a permissão de leitura do arquivo; enquanto isso vale a escolha do descritor",
      },
    };
  }
  try {
    const o = JSON.parse(cru) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("não é um objeto JSON");
    return {
      existe: true,
      campos: { provider: texto(o.provedor), model: typeof o.modelo === "string" ? o.modelo.trim() : undefined, auth: texto(o.auth) },
    };
  } catch (err) {
    return {
      existe: true,
      problema: {
        motivo: `${arquivo} não é um JSON válido de escolha de provedor: ${err instanceof Error ? err.message : err}`,
        comoResolver: "escolher o provedor de novo pelo painel (ele regrava o arquivo); enquanto isso vale a escolha do descritor",
      },
    };
  }
}

/** Grava o provedor.json: atômico (tmp + rename na mesma pasta) e modo 600. */
export function gravarProvedorJson(arquivo: string, escolha: Escolha): void {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  const corpo = { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo, em: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(corpo, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, arquivo);
}

export interface EntradaDaEscolha {
  arquivoProvedor: string;
  /** Os campos da sessão paralela no descritor (nível 2). */
  sessao?: CamposDeEscolha;
  /** Os campos do `config` do descritor (nível 3). */
  config?: CamposDeEscolha;
  codexHome?: string;
  /** Catálogo já carregado (os testes injetam); senão é lido do disco. */
  catalogo?: Catalogo;
}

export interface SaidaDaEscolha {
  escolha: EscolhaEfetiva;
  problemas: Problema[];
  /** O catálogo que valeu (o de emergência, se o arquivo não pôde ser lido). */
  catalogo: Catalogo;
}

export function resolverEscolha(ent: EntradaDaEscolha): SaidaDaEscolha {
  const problemas: Problema[] = [];
  const padrao: EscolhaEfetiva = { ...ESCOLHA_PADRAO, origem: "padrao" };

  let cat: Catalogo;
  try {
    cat = ent.catalogo ?? carregar();
  } catch (err) {
    problemas.push({
      motivo: err instanceof ErroCatalogo ? err.message : `falha ao ler o catálogo de provedores: ${err}`,
      comoResolver:
        "restaurar providers/catalogo.json (ou apontar DGCLAW_CATALOGO para ele). Sem o catálogo só o padrão " +
        "(Claude, na assinatura) é possível, e o agente sobe assim para não ficar fora do ar",
    });
    return { escolha: padrao, problemas, catalogo: catalogoDeEmergencia() };
  }

  type Nivel = { nome: string; origem: OrigemDaEscolha; provider?: string; model?: string; auth?: string };
  const niveis: Nivel[] = [];

  const lido = lerProvedorJson(ent.arquivoProvedor);
  if (lido.problema) problemas.push(lido.problema);
  if (lido.campos) niveis.push({ nome: `o arquivo ${ent.arquivoProvedor}`, origem: "provedor.json", ...lido.campos });

  const dele = (c: CamposDeEscolha | undefined, nome: string) => {
    if (!c) return;
    const n: Nivel = { nome, origem: "descritor", provider: texto(c.provider), model: texto(c.model), auth: texto(c.auth) };
    if (n.provider || n.model || n.auth) niveis.push(n);
  };
  dele(ent.sessao, "a sessão no descritor (sessoes[].provider/model/auth)");
  dele(ent.config, "o config do descritor (config.provider/model/auth)");

  for (const n of niveis) {
    const nome = n.provider ? provedorDoVocabulario(n.provider) : "claude";
    if (!nome) {
      const doCatalogo = cat.provedores[(n.provider ?? "").toLowerCase()];
      if (doCatalogo) {
        // Existe no catálogo mas o runner não sabe subir (Gemini): o catálogo diz por quê.
        let motivo = `o runner ainda não sabe subir o ${doCatalogo.nome}`;
        try {
          validar(cat, (n.provider ?? "").toLowerCase(), n.auth ?? "assinatura", n.model ?? "");
        } catch (err) {
          if (err instanceof ErroCatalogo) motivo = err.message;
        }
        problemas.push({ motivo: `${n.nome}: ${motivo}`, comoResolver: "escolher Claude ou Codex pelo painel; caindo para o próximo nível" });
        continue;
      }
      problemas.push({
        motivo: `${n.nome} pede o provedor '${n.provider}', que o runner não conhece`,
        comoResolver: "usar claude ou codex (no descritor também vale local-cli ou codex-cli); caindo para o próximo nível",
      });
      continue;
    }
    try {
      const v = validar(cat, nome, n.auth ?? "assinatura", n.model ?? "", { codexHome: ent.codexHome });
      return { escolha: { provedor: nome, auth: v.auth, modelo: v.modelo, origem: n.origem }, problemas, catalogo: cat };
    } catch (err) {
      if (!(err instanceof ErroCatalogo)) throw err;
      problemas.push({
        motivo: `${n.nome} tem uma escolha inválida: ${err.message}`,
        comoResolver: "corrigir a escolha pelo painel (Provedor do agente); caindo para o próximo nível",
      });
    }
  }
  return { escolha: padrao, problemas, catalogo: cat };
}
