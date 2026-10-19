import path from "node:path";
import fs from "node:fs";
import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { configDirDoClaude } from "../provedores/claude.js";
import { loginExpiradoNoFimDoTranscript } from "../transcript.js";
import { ctxLeve } from "./configuracao.js";
import { cancelarStopPendente } from "./eventos.js";

// --- login expirado --------------------------------------------------------
//
// Caso real de 19/10/2026: o OAuth do Claude morreu (token vencido e o refresh falhou), mas o
// .credentials.json continuou no disco. O runner dizia `idle` e o agente parou de responder sem
// que nada aparecesse na conversa. Diferente do "sem login" de primeira vez, aqui a sessão TEM
// conversa: ela nunca é trocada por uma nova, volta por retomada (`--resume`).

/** Quando a credencial do Claude foi gravada pela última vez (ms); 0 se não dá para saber. */
export function credencialGravadaEm(s: Sessao): number {
  const ctx = s.ctxVivo ?? ctxLeve(s);
  const arquivo = path.join(configDirDoClaude(ctx), ".credentials.json");
  try {
    return fs.statSync(arquivo).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.aviso(s.a("login"), `não consegui ler a data de ${arquivo}: ${err instanceof Error ? err.message : err}`);
    }
    return 0;
  }
}

export function horaDe(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Procura o erro sintético de login no fim do transcript e, se estiver lá, entra em login expirado. */
export function conferirLoginExpiradoNoTranscript(s: Sessao, desdeMs: number, origem: string): boolean {
  if (s.motor.provedor !== "claude" || !s.estado.sessionId) return false;
  const prova = loginExpiradoNoFimDoTranscript(
    s.estado.sessionId,
    Math.max(desdeMs, credencialGravadaEm(s)),
    s.estado.config.envExtra?.CLAUDE_CONFIG_DIR,
  );
  if (!prova.expirado) return false;
  marcarLoginExpirado(s, `transcript (${origem})`, prova.quando, null);
  return true;
}

/**
 * O Claude não consegue mais autenticar: tira o agente de `working`/`idle` para `errored` e começa a
 * vigiar a credencial. `quando` é a hora do erro quando se sabe (transcript); sem ela vale agora.
 */
export function marcarLoginExpirado(s: Sessao, origem: string, quando: number | null, detalhe: string | null): void {
  if (s.estado.statusReason === "runner:login-expirado") return;
  cancelarStopPendente(s);
  const em = quando ?? Date.now();
  s.loginExpiradoEmMs = em;
  const assinatura = s.escolhaVigente.auth === "assinatura";
  const hora = horaDe(em);
  const mensagem = assinatura
    ? `O login da conta do Claude de ${s.slug} expirou às ${hora}: a credencial existe, mas o Claude não conseguiu renová-la. ` +
      `Desde então ele não responde. O que fazer: reconectar a conta pela conversa (cartão "Conectar o seu Claude") ou digitando ` +
      `/login no terminal dele; o runner reinicia a mesma sessão sozinho depois do login.`
    : `O Claude recusou a credencial de ${s.slug} às ${hora} (modo ${s.escolhaVigente.auth}). Desde então ele não responde. ` +
      `O que fazer: conferir a chave ou o token no Cofre do painel e reiniciar o agente.`;
  s.mudar({
    status: "errored",
    error: mensagem,
    statusReason: "runner:login-expirado",
    motivo: "login",
    loginExpiradoEm: new Date(em).toISOString(),
    hookLatched: true,
    currentTool: null,
  });
  log.erro(
    s.a("login"),
    `login expirado detectado por ${origem} (${hora})${detalhe ? `: "${detalhe}"` : ""}`,
    assinatura
      ? "reconectar a conta pelo cartão de login da conversa ou pelo /login no terminal; quando o .credentials.json ficar mais novo que este aviso, o runner reinicia a mesma sessão sozinho"
      : "conferir a chave ou o token no Cofre e reiniciar o agente",
  );
  if (assinatura) vigiarCredencial(s);
}

/** De 30 em 30 s: a credencial ficou mais nova que o erro? Cobre login pelo terminal e várias agentes na mesma conta. */
export function vigiarCredencial(s: Sessao): void {
  pararVigiaDoLoginExpirado(s);
  s.vigiaDoLoginExpirado = setInterval(() => {
    if (s.estado.statusReason !== "runner:login-expirado" || s.loginExpiradoEmMs === null) {
      pararVigiaDoLoginExpirado(s);
      return;
    }
    if (credencialGravadaEm(s) > s.loginExpiradoEmMs) retomarAposLoginExpirado(s, "credencial renovada no disco");
  }, s.vigiaLoginExpiradoMs);
  s.vigiaDoLoginExpirado.unref();
}

export function pararVigiaDoLoginExpirado(s: Sessao): void {
  if (s.vigiaDoLoginExpirado) {
    clearInterval(s.vigiaDoLoginExpirado);
    s.vigiaDoLoginExpirado = null;
  }
}

/** Reinicia RETOMANDO a mesma conversa (o mesmo `parar` + `subir("retomar")` do POST /reiniciar). */
export function retomarAposLoginExpirado(s: Sessao, motivo: string): void {
  pararVigiaDoLoginExpirado(s);
  log.info(s.a("login"), `${motivo}: reiniciando a sessão ${s.estado.sessionId ?? "(sem id)"} por retomada`);
  s.parar("login reconectado: retomando a mesma sessão");
  setTimeout(() => {
    s.subir("retomar").catch((err) =>
      log.erro(
        s.a("login"),
        `a retomada depois do login falhou: ${err instanceof Error ? err.message : err}`,
        "reiniciar o agente pelo painel (POST /api/agents/:id/reiniciar); a conversa continua no disco",
      ),
    );
  }, 1_500).unref();
}

/** Fecha o incidente ao subir de novo. Se a credencial renovou, guarda o recado para o agente. */
export function encerrarIncidenteDeLogin(s: Sessao): void {
  pararVigiaDoLoginExpirado(s);
  if (s.loginExpiradoEmMs === null) return;
  const expirouEm = s.loginExpiradoEmMs;
  s.loginExpiradoEmMs = null;
  if (credencialGravadaEm(s) > expirouEm) {
    s.recadoDeLogin = { expirouEm, voltouEm: Date.now() };
  } else {
    log.aviso(
      s.a("login"),
      `a sessão voltou a subir sem que a credencial tenha sido renovada desde ${horaDe(expirouEm)}; ` +
        `se o login ainda estiver expirado, o próximo turno vai falhar de novo e o aviso reaparece`,
    );
  }
  s.mudar({ loginExpiradoEm: null });
}

/** Um recado só por incidente, depois que a sessão voltou a idle, para o agente responder o que ficou pendente. */
export function entregarRecadoDeLogin(s: Sessao): void {
  const r = s.recadoDeLogin;
  if (!r) return;
  s.recadoDeLogin = null;
  const texto =
    `<plataforma recado="login-reconectado" tipo="aviso" ts="${new Date().toISOString()}">` +
    `O login da sua conta expirou às ${horaDe(r.expirouEm)} e voltou às ${horaDe(r.voltouEm)}. ` +
    "Mensagens que chegaram nesse intervalo ficaram sem resposta: confira as últimas do dono e responda o que ficou pendente, " +
    "sem comentar o problema técnico se não for perguntado. " +
    "Este é um aviso da plataforma, não uma mensagem escrita pelo dono.</plataforma>";
  log.info(s.a("login"), "entregando ao agente o recado de login reconectado");
  s.enfileirarQuandoOcioso(texto);
}
