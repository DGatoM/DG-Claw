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

/** O diálogo de confiança de pasta do Claude Code ("Is this a directory you created or one you trust?" no
 *  2.1.326 em diante, "Do you trust the files in this folder?" nas versões antigas), que abre no boot para o
 *  cwd e para cada --add-dir ainda não marcado. Mesmo cuidado do auto mode: o buffer é o fluxo bruto do PTY,
 *  então só conta se for a ÚLTIMA coisa desenhada (depois das opções sobra pouco texto), para não disparar
 *  por diálogo já respondido nem por alguém que cita a frase na conversa. */
export function ehDialogoDeConfiancaDoClaude(tela: string): boolean {
  const t = semAnsi(desdeAUltimaLimpezaDeTela(tela)).replace(/\s+/g, "").toLowerCase();
  const pergunta = ["isthisadirectoryyoucreatedoroneyoutrust", "doyoutrustthefilesinthisfolder"]
    .map((p) => t.lastIndexOf(p))
    .reduce((a, b) => Math.max(a, b), -1);
  if (pergunta < 0) return false;
  const i = t.indexOf("no,exit", pergunta);
  if (i < 0 || !t.includes("yes,", pergunta)) return false;
  const depois = t.slice(i + "no,exit".length);
  if (depois.includes("❯") || depois.includes("?forshortcuts")) return false;
  return depois.length <= 120;
}

/** A pasta que o diálogo de confiança pergunta (a linha com o caminho vem antes da pergunta). Melhor
 *  esforço: o TUI pode comer espaços, e sem caminho reconhecível devolve null. */
export function pastaDoDialogoDeConfianca(tela: string): string | null {
  const t = semAnsi(desdeAUltimaLimpezaDeTela(tela));
  const i = t.search(/This\s*session\s*hasn.t\s*worked|Do\s*you\s*trust\s*the\s*files|Is\s*this\s*a\s*directory/i);
  const antes = i < 0 ? t : t.slice(Math.max(0, i - 600), i);
  const m = [...antes.matchAll(/(\/[\w.@+~-]+(?:\/[\w.@+~-]+)*)/g)];
  return m.length ? m[m.length - 1][1] : null;
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


/** O que a tela mostra na caixa de composição, comparado com o texto que o runner digitou. */
export type EstadoDaCaixa = "mesmo-texto" | "vazia" | "indeterminada";

/** Tira espaço, quebra de linha e as linhas de moldura da caixa (U+2500 a U+257F): o TUI quebra o texto
 *  comprido e desenha a borda no meio dele, então a comparação ignora tudo isso. */
function compacta(t: string): string {
  return t.replace(/[\s─-╿]/g, "");
}

const RE_MARCA_DE_DIALOGO = /esctocancel|doyouwant|\(y\/n\)|1\.yes|1\.no|yes,|no,keep|no,exit|allowonce|alwaysallow|pressentertoconfirm/i;
const RE_RODAPE_DA_CAIXA_VAZIA = /^(\?forshortcuts|⏵|\(shift\+tab|bypasspermissions|automode|acceptedits|planmode)/i;

function haDialogoAberto(tela: string): boolean {
  return ehDialogoDeAutoMode(tela) || ehDialogoDeConfiancaDoClaude(tela) || ehDialogoDeBypass(tela) || telaDeConfiancaDoCodex(tela);
}

const RE_MARCADOR_NO_INICIO = /^[\s│┃|]*[❯›]/;
const RE_SO_MOLDURA = /^[\s│┃|╭╮╰╯┌┐└┘─━]*$/;
const RE_TRACO_DE_MOLDURA = /[╭╮╰╯┌┐└┘─━]/g;
const MOLDURA_MINIMA = 40;

/** Uma linha só é a borda da caixa se tiver SÓ moldura e espaços e ao menos 40 caracteres de moldura (a borda real ocupa a
 *  largura do terminal). Uma linha curta, ou que começa com ─ mas tem texto, é conteúdo do rascunho.
 *  Risco que fica: um rascunho com uma linha inteira de 40 ou mais traços parece borda. Fica porque a leitura de tela é
 *  heurística e o lado do erro escolhido é suspender a mais, nunca digitar por cima do texto de alguém. */
function ehLimiteDaCaixa(linha: string): boolean {
  return RE_SO_MOLDURA.test(linha) && (linha.match(RE_TRACO_DE_MOLDURA)?.length ?? 0) >= MOLDURA_MINIMA;
}

/** Lê a caixa de composição na tela renderizada. O marcador (❯ ou ›) só conta no INÍCIO da linha da caixa (depois da
 *  borda e de espaços): um ❯ ou › no meio ou no fim do texto é conteúdo. O conteúdo vai do que vem depois do marcador
 *  até o limite de baixo da caixa ou o rodapé. Devolve null quando não há caixa reconhecível e "ambigua" quando os
 *  limites não se distinguem (outro marcador na mesma caixa). */
function lerCaixa(tela: string): { conteudo: string; marcaDeDialogoDepois: boolean } | "ambigua" | null {
  const linhas = semAnsi(desdeAUltimaLimpezaDeTela(tela)).split(/\r\n|\r|\n/);
  let l = -1;
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (RE_MARCADOR_NO_INICIO.test(linhas[i])) {
      l = i;
      break;
    }
  }
  if (l < 0) return null;
  // Outro marcador no começo de linha dentro da mesma caixa (sem limite nem linha em branco entre eles).
  // Só a borda da caixa encerra a busca: uma linha em branco pode estar no meio de um rascunho de vários parágrafos,
  // e um parágrafo que começa com ❯ ou › não pode passar por "o marcador da caixa".
  for (let i = l - 1; i >= 0; i--) {
    if (ehLimiteDaCaixa(linhas[i])) break;
    if (RE_MARCADOR_NO_INICIO.test(linhas[i])) return "ambigua";
  }
  const partes = [linhas[l].replace(RE_MARCADOR_NO_INICIO, "")];
  for (let i = l + 1; i < linhas.length; i++) {
    if (ehLimiteDaCaixa(linhas[i])) break;
    if (RE_RODAPE_DA_CAIXA_VAZIA.test(compacta(linhas[i]))) break;
    partes.push(linhas[i]);
  }
  // Qualquer marca de diálogo abaixo do marcador (mesmo depois do limite ou do rodapé) torna a tela duvidosa.
  const marcaDeDialogoDepois = RE_MARCA_DE_DIALOGO.test(compacta(linhas.slice(l + 1).join("\n")));
  return { conteudo: compacta(partes.join("\n").replace(/[│┃]\s*$/gm, "")), marcaDeDialogoDepois };
}

/** Olha o fim da tela e diz se a caixa de composição traz EXATAMENTE o texto digitado (o conteúdo inteiro, tolerante
 *  a quebra de linha e moldura), se está vazia, ou se não dá para saber (diálogo, menu, texto de outra pessoa, limites
 *  da caixa ambíguos, tela que não é a caixa). Só "mesmo-texto" autoriza repetir o Enter: um Enter numa caixa que
 *  mudou poderia mandar um rascunho do dono ou confirmar um diálogo de permissão. */
export function estadoDaCaixa(tela: string, texto: string): EstadoDaCaixa {
  if (haDialogoAberto(tela)) return "indeterminada";
  const caixa = lerCaixa(tela);
  if (caixa === null || caixa === "ambigua") return "indeterminada";
  if (caixa.marcaDeDialogoDepois || RE_MARCA_DE_DIALOGO.test(caixa.conteudo)) return "indeterminada";
  if (caixa.conteudo === "") return "vazia";
  return caixa.conteudo === compacta(texto) ? "mesmo-texto" : "indeterminada";
}

/** A tela de agora mostra um diálogo (permissão, pergunta, aviso de modo)? Olha só o que é do diálogo: as telas de aviso
 *  conhecidas e as marcas de diálogo ABAIXO do marcador da caixa. O texto da própria caixa não conta (o pedido pode
 *  conter "yes," e continua sendo só um pedido). */
export function haDialogoNaTela(tela: string): boolean {
  if (haDialogoAberto(tela)) return true;
  const caixa = lerCaixa(tela);
  return typeof caixa === "object" && caixa !== null && caixa.marcaDeDialogoDepois;
}

/** A leitura da tela identifica UMA caixa de composição, sem diálogo aberto nem marca de diálogo abaixo dela. Só com isso
 *  o primeiro Enter pode sair: com a tela ambígua (outro marcador, menu, nada reconhecível) ele poderia responder algo. */
export function caixaIdentificada(tela: string): boolean {
  if (haDialogoAberto(tela)) return false;
  const caixa = lerCaixa(tela);
  return typeof caixa === "object" && caixa !== null && !caixa.marcaDeDialogoDepois;
}

/** A tela mostra a caixa de composição sem nenhum texto (só o prompt e o rodapé)? */
export function caixaVaziaNaTela(tela: string): boolean {
  return estadoDaCaixa(tela, "\u0000") === "vazia";
}
