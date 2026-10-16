// As rotas de provedor: GET/POST /api/provedor e o login assistido.
//
// Ficam num módulo à parte para o servidor.ts continuar fácil de ler (e de proteger com
// autenticação no topo). Toda rota aceita `?sessao=<id>` (GET/DELETE) ou `sessao` no
// corpo (POST); sem isso, é a sessão principal. Erro sempre `{error, howToFix, code}`.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { erro, json, lerCorpo } from "../http-util.js";
import type { GerenteDeSessoes } from "../sessoes.js";
import type { Sessao } from "../sessao.js";
import { ErroCatalogo, rotulo, validar } from "./catalogo.js";
import { lerCanais } from "./canais.js";
import { Conferidor, conferirProvedor } from "./conferido.js";
import { ErroDeLogin, LoginAssistido } from "./login.js";

export interface ServicosDeProvedor {
  gerente: GerenteDeSessoes;
  login: LoginAssistido;
  conferidor: Conferidor;
}

/** Nomes de campo e valores com cara de segredo: a chave vai pelo Cofre do painel, nunca por aqui. */
const CAMPO_DE_SEGREDO = /chave|valor|senha|secret|token|api.?key|password|segredo|credencial/i;
const VALOR_DE_CHAVE = /^(?:sk[-_][A-Za-z0-9_-]{10,}|[A-Za-z0-9_\-.=+/]{40,})$/;

function pareceSegredo(corpo: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(corpo)) {
    if (CAMPO_DE_SEGREDO.test(k)) return `o campo "${k}"`;
    if (typeof v === "string" && VALOR_DE_CHAVE.test(v.trim())) return `o valor do campo "${k}"`;
  }
  return null;
}

function achar(
  res: http.ServerResponse,
  gerente: GerenteDeSessoes,
  id: unknown,
): Sessao | null {
  const pedido = typeof id === "string" && id.trim() ? id.trim() : gerente.principal.id;
  const s = gerente.porId(pedido);
  if (!s) {
    erro(
      res,
      404,
      "SESSAO_INEXISTENTE",
      `Este runner não tem a sessão ${pedido}. Sessões servidas: ${gerente.idsAtendidos().join(", ")}.`,
      "conferir o id da sessão (GET /api/agents?todas=1); sem o parâmetro sessao a rota fala da principal",
    );
    return null;
  }
  return s;
}

function rotuloSeguro(
  cat: Parameters<typeof rotulo>[0],
  provedor: string,
  auth: string,
  modelo: string,
  codexHome: string | undefined,
): string {
  try {
    return rotulo(cat, provedor, auth, modelo, { codexHome });
  } catch (err) {
    return err instanceof ErroCatalogo ? `${provedor}, ${auth} (${err.message})` : `${provedor}, ${auth}`;
  }
}

/** Devolve true quando a rota era do provedor (e já respondeu). */
export async function tratarRotasDeProvedor(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rota: string,
  metodo: string,
  svc: ServicosDeProvedor,
): Promise<boolean> {
  if (!rota.startsWith("/api/provedor")) return false;
  const { gerente, login, conferidor } = svc;
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const doQuery = url.searchParams.get("sessao");

  // --- GET /api/provedor ---
  if (rota === "/api/provedor" && metodo === "GET") {
    const s = achar(res, gerente, doQuery);
    if (!s) return true;
    const { escolha, catalogo } = s.lerEscolha();
    const amb = s.ambienteDaEscolha(escolha, catalogo);
    const home = amb.codexHome ?? undefined;
    const conferido = await conferidor.obter(s.id, `${escolha.provedor}|${escolha.auth}`, () =>
      conferirProvedor({
        provedor: escolha.provedor,
        auth: escolha.auth,
        env: amb.env,
        cwd: s.config.cwd,
        codexApiAindaSemLogin: escolha.provedor === "codex" && escolha.auth === "api" && !!home && !fs.existsSync(path.join(home, "auth.json")),
      }),
    );
    const canais =
      s.papel === "principal"
        ? {
            canais: {
              telegram:
                escolha.provedor === "codex"
                  ? "indisponivel_no_codex"
                  : lerCanais(s.config.cwd, false).telegram.ligado
                    ? "ligado"
                    : "desligado",
            },
          }
        : {};
    json(res, {
      sessao: s.id,
      provedor: escolha.provedor,
      auth: escolha.auth,
      modelo: escolha.modelo,
      rotulo: rotuloSeguro(catalogo, escolha.provedor, escolha.auth, escolha.modelo, home),
      origem: escolha.origem,
      conferido,
      login: login.visao(s.id),
      ...canais,
    });
    return true;
  }

  // --- POST /api/provedor ---
  if (rota === "/api/provedor" && metodo === "POST") {
    const corpo = await lerCorpo(req).catch((e: Error) => ({ __erro: e.message }));
    if (typeof (corpo as { __erro?: string }).__erro === "string") {
      erro(res, 400, "CORPO_INVALIDO", (corpo as { __erro: string }).__erro, "mandar um objeto JSON { provedor, auth, modelo, reiniciar? }");
      return true;
    }
    const segredo = pareceSegredo(corpo);
    if (segredo) {
      // O motivo não repete o valor, só aponta o campo.
      erro(
        res,
        400,
        "CHAVE_NAO_AQUI",
        `Esta rota não aceita chave nem segredo (${segredo} parece um). A chave de API vai pelo Cofre do painel.`,
        "guardar a chave no Cofre do painel (OPENAI_API_KEY ou ANTHROPIC_API_KEY) e aqui mandar só { provedor, auth, modelo }",
      );
      return true;
    }
    const s = achar(res, gerente, (corpo as { sessao?: unknown }).sessao);
    if (!s) return true;
    const { provedor, auth, modelo, reiniciar } = corpo as { provedor?: unknown; auth?: unknown; modelo?: unknown; reiniciar?: unknown };
    if (typeof provedor !== "string" || !provedor.trim()) {
      erro(res, 400, "PROVEDOR_OBRIGATORIO", 'Falta o campo "provedor" (claude ou codex).', "mandar { provedor, auth, modelo } no corpo");
      return true;
    }
    if (auth !== undefined && typeof auth !== "string") {
      erro(res, 400, "AUTH_INVALIDO", `O campo "auth" precisa ser texto (veio ${typeof auth}).`, "usar assinatura, token (só Claude) ou api");
      return true;
    }
    if (modelo !== undefined && typeof modelo !== "string") {
      erro(res, 400, "MODELO_INVALIDO", `O campo "modelo" precisa ser texto (veio ${typeof modelo}).`, "mandar o id do modelo, ou vazio para o padrão do provedor");
      return true;
    }
    if (reiniciar !== undefined && typeof reiniciar !== "boolean") {
      erro(res, 400, "REINICIAR_INVALIDO", `O campo "reiniciar" precisa ser true ou false (veio ${typeof reiniciar}).`, "omitir para reiniciar (padrão)");
      return true;
    }
    const { catalogo } = s.lerEscolha();
    const nomeP = provedor.trim().toLowerCase();
    const nomeA = (auth ?? "assinatura").trim();
    let valida;
    try {
      // Os modelos do Codex vêm do models_cache.json do CODEX_HOME DESTA sessão (que na API é outro).
      const codexHome =
        nomeP === "codex" && catalogo.provedores.codex?.auth[nomeA]
          ? (s.ambienteDaEscolha({ provedor: "codex", auth: nomeA, modelo: "" }, catalogo).codexHome ?? undefined)
          : undefined;
      valida = validar(catalogo, nomeP, nomeA, (modelo ?? "").trim(), { codexHome });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      erro(res, 400, "ESCOLHA_INVALIDA", msg, "escolher entre os provedores, formas de pagar e modelos do catálogo (GET /api/provedor mostra a escolha atual)");
      return true;
    }
    const e = { provedor: valida.provedor as "claude" | "codex", auth: valida.auth, modelo: valida.modelo };
    try {
      s.definirEscolha(e);
    } catch (err) {
      erro(
        res,
        500,
        "NAO_GRAVOU",
        `Não consegui gravar a escolha de provedor: ${err instanceof Error ? err.message : err}`,
        `conferir a permissão de escrita em ${path.dirname(s.arquivoDoProvedor())}`,
      );
      return true;
    }
    conferidor.invalidar(s.id);
    let reiniciou = false;
    if (reiniciar !== false && (s.papel === "principal" || s.temPtyVivo())) {
      await s.pararEEsperar("troca de provedor");
      await s.subir("nova");
      reiniciou = true;
    }
    const lida = s.lerEscolha();
    json(res, {
      ok: true,
      sessao: s.id,
      provedor: e.provedor,
      auth: e.auth,
      modelo: e.modelo,
      rotulo: rotuloSeguro(lida.catalogo, e.provedor, e.auth, e.modelo, undefined),
      reiniciou,
    });
    return true;
  }

  // --- login assistido ---
  if (rota === "/api/provedor/login") {
    if (metodo === "GET") {
      const s = achar(res, gerente, doQuery);
      if (!s) return true;
      json(res, login.visao(s.id));
      return true;
    }
    if (metodo === "POST") {
      const corpo = await lerCorpo(req).catch(() => ({}) as Record<string, unknown>);
      const s = achar(res, gerente, corpo.sessao ?? doQuery);
      if (!s) return true;
      const { escolha, catalogo } = s.lerEscolha();
      if (escolha.auth !== "assinatura") {
        erro(
          res,
          409,
          "LOGIN_SO_NA_ASSINATURA",
          `O login assistido só existe para a assinatura, e esta sessão está configurada para ${escolha.auth}.`,
          escolha.auth === "api"
            ? "na API não há login: guardar a chave no Cofre do painel. Para entrar com a conta, trocar a forma de pagar para assinatura (POST /api/provedor)"
            : "para o modo token, gerar o código com 'claude setup-token' e guardá-lo no Cofre do painel",
        );
        return true;
      }
      const amb = s.ambienteDaEscolha(escolha, catalogo);
      try {
        const visao = login.iniciar({
          sessao: s.id,
          provedor: escolha.provedor,
          env: amb.env,
          cwd: s.config.cwd,
          aoConcluir: () => {
            conferidor.invalidar(s.id);
            s.aposLoginConcluido();
          },
        });
        json(res, visao, 202);
      } catch (err) {
        if (err instanceof ErroDeLogin) erro(res, err.status, err.code, err.message, err.comoResolver);
        else throw err;
      }
      return true;
    }
    if (metodo === "DELETE") {
      const s = achar(res, gerente, doQuery);
      if (!s) return true;
      login.cancelar(s.id);
      json(res, { ok: true, estado: "nenhum" });
      return true;
    }
  }

  if (rota === "/api/provedor/login/codigo" && metodo === "POST") {
    const corpo = await lerCorpo(req).catch((e: Error) => ({ __erro: e.message }));
    if (typeof (corpo as { __erro?: string }).__erro === "string") {
      erro(res, 400, "CORPO_INVALIDO", (corpo as { __erro: string }).__erro, 'mandar { "codigo": "<código da página>" }');
      return true;
    }
    const s = achar(res, gerente, (corpo as { sessao?: unknown }).sessao ?? doQuery);
    if (!s) return true;
    try {
      login.enviarCodigo(s.id, (corpo as { codigo?: unknown }).codigo);
      json(res, { ok: true });
    } catch (err) {
      if (err instanceof ErroDeLogin) erro(res, err.status, err.code, err.message, err.comoResolver);
      else throw err;
    }
    return true;
  }

  erro(
    res,
    404,
    "ROTA_INEXISTENTE",
    `O runner não tem a rota ${metodo} ${rota}.`,
    "as rotas de provedor são GET/POST /api/provedor, GET/POST/DELETE /api/provedor/login e POST /api/provedor/login/codigo",
  );
  return true;
}
