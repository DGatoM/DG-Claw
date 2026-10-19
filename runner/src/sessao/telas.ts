import { timingSafeEqual } from "node:crypto";

export const ESC = "\u001b";
export const RE_ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

export function semAnsi(s: string): string {
  return s.replace(RE_ANSI, "");
}

/** O diálogo de aviso do modo Bypass Permissions do Claude Code (16/10/2026).
 *  O TUI desenha com movimento de cursor e pode "comer" espaços, então a conferência ignora
 *  todo espaço em branco e maiúsculas. Os dois pedaços juntos (o aviso e as opções) evitam
 *  um falso positivo quando alguém só cita o modo numa conversa. */
export function ehDialogoDeBypass(tela: string): boolean {
  const t = semAnsi(tela).replace(/\s+/g, "").toLowerCase();
  return t.includes("bypasspermissionsmode") && t.includes("no,exit") && t.includes("yes,iaccept");
}

/** O menu de confiança de pasta do Codex, olhando só o fim da tela (a tela velha pode ainda estar no buffer).
 *
 *  O buffer é o fluxo bruto do PTY, e o Codex redesenha com movimento de cursor, quase sem quebra de
 *  linha: um menu JÁ respondido continua nas últimas "linhas". Por isso o menu só conta se for a
 *  ÚLTIMA coisa desenhada. Na tela real do B6 (12/10/2026), depois de "Trust and continue" vinha só
 *  "2. Quit enter continue · esc quit"; depois de responder, vêm o rodapé e o prompt, bem mais longos.
 *  Errar para o lado do "tem menu" mandaria um "1" como turno a cada mensagem. */
export function telaDeConfiancaDoCodex(tela: string): boolean {
  const fim = semAnsi(tela).split(/\r?\n/).slice(-40).join("\n");
  if (!/Trust this folder\?/.test(fim)) return false;
  const i = fim.lastIndexOf("Trust and continue");
  if (i < 0) return false;
  const depois = fim.slice(i + "Trust and continue".length).replace(/\s+/g, "");
  return depois.length <= 60;
}

/** O nonce autentica os eventos de status de UM spawn. Comparação em tempo constante:
 *  tamanhos diferentes são recusados antes (o `timingSafeEqual` exige o mesmo tamanho). */
export function nonceConfere(esperado: string | null, recebido: unknown): boolean {
  if (!esperado || typeof recebido !== "string") return false;
  const a = Buffer.from(esperado);
  const b = Buffer.from(recebido);
  return a.length === b.length && timingSafeEqual(a, b);
}

