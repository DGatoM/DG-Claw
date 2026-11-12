import { timingSafeEqual } from "node:crypto";

export const ESC = "\u001b";
export const RE_ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

export function semAnsi(s: string): string {
  return s.replace(RE_ANSI, "");
}

/** Só o que foi desenhado depois da última limpeza de tela (ESC[2J, ESC[3J, ESC c) ou troca de tela
 *  alternativa (ESC[?1049h/l). O buffer é o fluxo bruto do PTY: depois de um diálogo fechado o TUI
 *  limpa a tela e redesenha um prompt curto, mas `semAnsi` apaga a limpeza e o diálogo velho ficaria
 *  parecendo "a última coisa" com pouco texto depois dele. */
export function desdeAUltimaLimpezaDeTela(tela: string): string {
  let corte = -1;
  let fim = 0;
  for (const m of tela.matchAll(new RegExp(`${ESC}(?:\\[[23]J|c|\\[\\?1049[hl])`, "g"))) {
    corte = m.index;
    fim = m.index + m[0].length;
  }
  return corte < 0 ? tela : tela.slice(fim);
}

/** O diálogo de aviso do modo Bypass Permissions do Claude Code (16/10/2026).
 *  O TUI desenha com movimento de cursor e pode "comer" espaços, então a conferência ignora
 *  todo espaço em branco e maiúsculas. Os dois pedaços juntos (o aviso e as opções) evitam
 *  um falso positivo quando alguém só cita o modo numa conversa. */
export function ehDialogoDeBypass(tela: string): boolean {
  const t = semAnsi(tela).replace(/\s+/g, "").toLowerCase();
  return t.includes("bypasspermissionsmode") && t.includes("no,exit") && t.includes("yes,iaccept");
}

/** A pergunta de primeira vez do auto mode do Claude Code 2.1.x ("Make auto mode your default
 *  permission mode?", 1. Yes, set auto mode as my default / 2. No, keep ...). Quando ela está na
 *  frente da caixa, o texto digitado cai dentro do menu e nenhum Enter vira turno (caso real de
 *  28/10/2026: um card ficou 7 minutos com o pedido parado).
 *
 *  Mesmo cuidado do menu do Codex: o buffer é o fluxo bruto do PTY e a pergunta JÁ respondida
 *  continua nele. Ela só conta se for a ÚLTIMA coisa desenhada (depois da opção "No, keep" sobra
 *  pouco texto); o prompt normal que volta depois de responder é bem maior que isso. */
export function ehDialogoDeAutoMode(tela: string): boolean {
  const t = semAnsi(desdeAUltimaLimpezaDeTela(tela)).replace(/\s+/g, "").toLowerCase();
  if (!t.includes("makeautomodeyourdefaultpermissionmode?")) return false;
  const i = t.lastIndexOf("no,keep");
  if (i < 0 || !t.includes("yes,setautomodeasmydefaultpermissionmode")) return false;
  const depois = t.slice(i + "no,keep".length);
  // Um prompt de entrada redesenhado depois das opções (sem limpeza de tela no meio) também prova que a pergunta fechou.
  if (depois.includes("❯") || depois.includes("?forshortcuts")) return false;
  return depois.length <= 80;
}

/** O menu de confiança de pasta do Codex, olhando só o fim da tela (a tela velha pode ainda estar no buffer).
 *
 *  O buffer é o fluxo bruto do PTY, e o Codex redesenha com movimento de cursor, quase sem quebra de
 *  linha: um menu JÁ respondido continua nas últimas "linhas". Por isso o menu só conta se for a
 *  ÚLTIMA coisa desenhada. Na tela real do B6 (12/10/2026), depois de "Trust and continue" vinha só
 *  "2. Quit enter continue · esc quit"; depois de responder, vêm o rodapé e o prompt, bem mais longos.
 *  Errar para o lado do "tem menu" mandaria um "1" como turno a cada mensagem. */
export function telaDeConfiancaDoCodex(tela: string): boolean {
  const fim = semAnsi(desdeAUltimaLimpezaDeTela(tela)).split(/\r?\n/).slice(-40).join("\n");
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

