// Autenticação do runner: toda chamada precisa de `Authorization: Bearer <token>`.
//
// O runner escuta só em 127.0.0.1, mas "só na máquina" não é "só eu": qualquer
// processo local (ou outro usuário da VPS) alcança a porta. O token fica num
// arquivo de modo 600, lido UMA vez na subida, e nunca aparece em log, nem
// inteiro, nem em pedaço, nem o tamanho dele.
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import { log } from "./logger.js";

export type TokenDoRunner = { token: Buffer | null; motivo: string | null };

const TAMANHO_MINIMO = 32;
const JANELA_LOG_MS = 60_000;

function semToken(motivo: string): TokenDoRunner {
  log.erro(
    "auth",
    motivo,
    "crie o arquivo com um token de 32+ caracteres (ex.: openssl rand -hex 32), chmod 600, e aponte RUNNER_TOKEN_FILE para ele; sem isso o runner recusa tudo com 401, menos GET /api/saude e POST /api/agent-hook",
  );
  return { token: null, motivo };
}

export function carregarTokenDoRunner(env: NodeJS.ProcessEnv = process.env): TokenDoRunner {
  const caminho = env.RUNNER_TOKEN_FILE?.trim();
  if (!caminho) return semToken("RUNNER_TOKEN_FILE não está definida");

  let bruto: string;
  let modo: number;
  try {
    bruto = fs.readFileSync(caminho, "utf8");
    modo = fs.statSync(caminho).mode;
  } catch (e) {
    const codigo = (e as NodeJS.ErrnoException).code || "desconhecido";
    return semToken(`não consegui ler o arquivo do token em ${caminho} (erro ${codigo})`);
  }

  const token = bruto.trim();
  if (token.length < TAMANHO_MINIMO || /\s/.test(token)) {
    return semToken(
      `o arquivo do token em ${caminho} precisa ter um token de pelo menos ${TAMANHO_MINIMO} caracteres, em uma linha só, sem espaços`,
    );
  }

  if (modo & 0o077) {
    log.aviso(
      "auth",
      `o arquivo do token em ${caminho} pode ser lido por outros usuários da máquina; rode: chmod 600 ${caminho}`,
    );
  }
  return { token: Buffer.from(token, "utf8"), motivo: null };
}

/** Rotas que respondem sem token. `rota` já vem sem query e sem barra final. */
export function rotaLivre(rota: string, metodo: string): boolean {
  if (metodo === "GET" && (rota === "/api/saude" || rota === "/saude")) return true;
  // O hook tem nonce próprio, que o runner confere na rota.
  if (metodo === "POST" && rota === "/api/agent-hook") return true;
  return false;
}

/** Comparação em tempo constante. O sha256 iguala o tamanho e não deixa o tamanho do token vazar. */
export function tokensIguais(recebido: string, certo: Buffer): boolean {
  const a = crypto.createHash("sha256").update(recebido, "utf8").digest();
  const b = crypto.createHash("sha256").update(certo).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Extrai o token de `Authorization: Bearer xxx`; null se não casar. */
function tokenDoCabecalho(req: http.IncomingMessage): string | null {
  const cab = req.headers.authorization;
  if (typeof cab !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(cab);
  return m ? m[1] : null;
}

function rotaDe(req: http.IncomingMessage): string {
  return (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
}

// Uma linha por combinação code+rota a cada 60 s, para um cliente em laço não inundar o log.
const ultimosAvisos = new Map<string, number>();

function avisarRecusa(metodo: string, rota: string, code: string): void {
  const agora = Date.now();
  for (const [chave, quando] of ultimosAvisos) {
    if (agora - quando >= JANELA_LOG_MS) ultimosAvisos.delete(chave);
  }
  const chave = `${code} ${rota}`;
  if (ultimosAvisos.has(chave)) return;
  ultimosAvisos.set(chave, agora);
  log.aviso("auth", `chamada recusada: ${metodo} ${rota} (${code}); repetições iguais ficam sem log por 60 s`);
}

function recusar(
  res: http.ServerResponse,
  metodo: string,
  rota: string,
  code: string,
  error: string,
  howToFix: string,
): false {
  avisarRecusa(metodo, rota, code);
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "WWW-Authenticate": "Bearer",
  });
  res.end(JSON.stringify({ success: false, error, howToFix, code }));
  return false;
}

/** Guarda para o topo do handler HTTP: true se pode seguir; false se já respondeu 401. */
export function exigirTokenDoRunner(opcoes: {
  token: Buffer | null;
}): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return (req, res) => {
    const rota = rotaDe(req);
    const metodo = req.method || "GET";
    if (rotaLivre(rota, metodo)) return true;

    if (!opcoes.token) {
      return recusar(
        res,
        metodo,
        rota,
        "RUNNER_SEM_TOKEN",
        "este runner subiu sem token configurado e recusa tudo",
        "crie o arquivo de token (openssl rand -hex 32, chmod 600), aponte RUNNER_TOKEN_FILE para ele e reinicie o runner; o motivo exato está no log da subida",
      );
    }
    if (typeof req.headers.authorization !== "string") {
      return recusar(
        res,
        metodo,
        rota,
        "SEM_TOKEN",
        "esta chamada não trouxe o cabeçalho Authorization",
        "mande Authorization: Bearer <conteúdo do arquivo RUNNER_TOKEN_FILE>",
      );
    }
    const recebido = tokenDoCabecalho(req);
    if (recebido === null || !tokensIguais(recebido, opcoes.token)) {
      return recusar(
        res,
        metodo,
        rota,
        "TOKEN_ERRADO",
        "o token enviado está errado ou o cabeçalho Authorization está malformado",
        "mande Authorization: Bearer <conteúdo do arquivo RUNNER_TOKEN_FILE>, com exatamente o conteúdo do arquivo",
      );
    }
    return true;
  };
}

/**
 * Para o upgrade do WebSocket. O navegador não consegue pôr cabeçalho no
 * WebSocket, então aqui (e só aqui) vale também `?token=`.
 */
export function conferirTokenWs(req: http.IncomingMessage, opcoes: { token: Buffer | null }): boolean {
  if (!opcoes.token) return false;
  let recebido = tokenDoCabecalho(req);
  if (recebido === null) {
    try {
      recebido = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("token");
    } catch {
      recebido = null;
    }
  }
  if (!recebido) return false;
  return tokensIguais(recebido, opcoes.token);
}

/** `verifyClient` assíncrono do ws 8. */
export function verificarClienteWs(opcoes: {
  token: Buffer | null;
}): (info: { req: http.IncomingMessage }, cb: (ok: boolean, codigo?: number, mensagem?: string) => void) => void {
  return (info, cb) => {
    if (conferirTokenWs(info.req, opcoes)) {
      cb(true);
      return;
    }
    avisarRecusa("WS", rotaDe(info.req), opcoes.token ? "WS_TOKEN_INVALIDO" : "RUNNER_SEM_TOKEN");
    cb(false, 401, "token do runner ausente ou errado");
  };
}
