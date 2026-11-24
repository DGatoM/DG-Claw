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

const RE_MARCA_DE_DIALOGO = /esctocancel|doyouwant|\(y\/n\)|1\.yes|1\.no|yes,|no,keep|no,exit|allowonce|alwaysallow|pressentertoconfirm|entercontinue|escskip|skipuntilnextversion|1\.updatenow/i;
/** O rodapé do TUI, por casamento ESTRITO da linha inteira (sem espaços e sem moldura). Os dois motores:
 *   - Claude: a linha de modo começa com o ícone (⏵⏵ bypass permissions on / auto mode on / accept edits on, ⏸ plan mode on)
 *     e pode ter "(shift+tab to cycle)" e outros avisos depois; a dica `? for shortcuts`;
 *   - Codex: `? for shortcuts` (com `100% context left` na mesma linha) e a linha de atalhos `⏎ send ...` do compositor ativo.
 *  Uma linha que só COMEÇA como um rodapé ("Plan mode on hold until Monday") é conteúdo do rascunho, não rodapé. Sem o ícone,
 *  "plan mode on" sozinho também não conta: o Claude sempre desenha o ícone, e sem ele a linha pode ser texto do dono. */
const RE_RODAPE_DA_CAIXA_VAZIA = /^(\?forshortcuts(\d+%contextleft)?|\(shift\+tabtocycle\)|[⏵⏸].*|⏎send.*)$/i;

function haDialogoAberto(tela: string): boolean {
  return ehDialogoDeAutoMode(tela) || ehDialogoDeConfiancaDoClaude(tela) || ehDialogoDeBypass(tela) || telaDeConfiancaDoCodex(tela);
}

/** A linha de status do Codex real: dois espaços, texto ("GPT-6.2-Astra high"), " · " e uma pasta absoluta ou ~, seguida
 *  opcionalmente de " · <título da sessão>" (depois do primeiro turno o Codex acrescenta o título: "... · /tmp/x · Responda ok"). */
const RE_STATUS_DO_CODEX = /^ {2}\S.* · [\/~]\S*(?: \S+)*(?: · \S.*)?$/;
function ehLinhaDeStatusDoCodex(linha: string): boolean {
  return RE_STATUS_DO_CODEX.test(linha.replace(/\s+$/, ""));
}
/** Linha de histórico do Codex acima da caixa: a resposta ("• ...") e o tempo do turno ("Worked for 2s"). */
const RE_HISTORICO_DO_CODEX = /^\s*(?:[•◦]\s|Worked for\b)/;
/** Linha de rodapé do Codex: em branco, qualquer linha com a dica "? for shortcuts" (pode ter "← for agents ·" antes e avisos
 *  "⚠ 1 warning · f2 to view" depois) ou um dos rodapés estritos dos dois motores. */
function ehLinhaDeRodapeDoCodex(linha: string): boolean {
  if (linha.trim() === "") return true;
  const c = compacta(linha);
  // Com rascunho, o Codex real apaga os atalhos e deixa só o aviso da direita ("⚠ 2 warnings · f2 to view").
  return c.includes("?forshortcuts") || RE_RODAPE_DA_CAIXA_VAZIA.test(c) || /^⚠\d+warnings?·f2toview$/i.test(c);
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
 *  borda e de espaços): um ❯ ou › no meio ou no fim do texto é conteúdo.
 *
 *  A caixa só é reconhecida com evidência POSITIVA da estrutura, nunca pela ausência de sinais:
 *   - com borda (Claude): uma linha de borda logo acima da linha do marcador e outra abaixo do conteúdo. O conteúdo é
 *     TUDO o que está entre as duas bordas: dentro da área de edição uma linha com cara de rodapé ("Plan mode on") é
 *     texto do dono, e o rodapé de verdade só vem depois da borda de baixo;
 *   - sem borda (Codex): o rodapé do TUI (`? for shortcuts` etc.) ocupa o fim da tela depois do conteúdo. O rodapé é o
 *     trecho final de linhas com cara de rodapé; uma linha assim no meio do rascunho, com texto depois dela, é conteúdo.
 *  Um menu com uma opção marcada ("❯ Yes", a pergunta acima e "No" abaixo) não tem nada disso e NÃO é caixa.
 *
 *  Devolve null quando não há marcador, "ambigua" quando outro marcador divide a mesma caixa e "duvidosa" quando há
 *  marcador mas a estrutura não se confirma (borda de baixo sem a de cima, ou o contrário, ou nenhum rodapé): quem lê
 *  trata como estado indeterminado, que mantém a suspensão. */
function lerCaixa(tela: string): { conteudo: string; marcaDeDialogoDepois: boolean } | "ambigua" | "duvidosa" | null {
  const linhas = semAnsi(desdeAUltimaLimpezaDeTela(tela)).split(/\r\n|\r|\n/);
  let l = -1;
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (RE_MARCADOR_NO_INICIO.test(linhas[i])) {
      l = i;
      break;
    }
  }
  if (l < 0) return null;
  // A primeira linha não vazia acima do marcador: se for a borda de cima, a caixa tem moldura.
  let acima = l - 1;
  while (acima >= 0 && linhas[acima].trim() === "") acima--;
  const bordaAcima = acima >= 0 && ehLimiteDaCaixa(linhas[acima]);
  // Outro marcador no começo de linha dentro da mesma caixa (sem limite entre eles). Com moldura só a borda encerra a busca:
  // uma linha em branco pode estar no meio de um rascunho de vários parágrafos, e um parágrafo que começa com ❯ ou › não
  // pode passar por "o marcador da caixa". Sem moldura (Codex) o editor ativo termina na primeira linha em branco acima do
  // marcador ou numa linha do histórico ("• resposta", "Worked for"): os "› pedido anterior" do histórico não são da caixa.
  for (let i = l - 1; i >= 0; i--) {
    if (ehLimiteDaCaixa(linhas[i])) break;
    if (!bordaAcima && (linhas[i].trim() === "" || RE_HISTORICO_DO_CODEX.test(linhas[i]))) break;
    if (RE_MARCADOR_NO_INICIO.test(linhas[i])) return "ambigua";
  }
  let fim = -1; // índice da primeira linha que NÃO é conteúdo (a borda de baixo, ou o começo do rodapé)
  let indiceDaLinhaDeStatus = -1; // linha de status do Codex reconhecida (fora da busca por marcas de diálogo)
  if (bordaAcima) {
    let bordas = 0;
    for (let i = l + 1; i < linhas.length; i++) {
      if (ehLimiteDaCaixa(linhas[i])) {
        if (fim < 0) fim = i;
        bordas++;
      }
    }
    // Mais de uma linha plausível de borda abaixo do marcador (um separador dentro do rascunho e a borda de verdade): não dá
    // para saber qual delas fecha a caixa, e o texto entre as duas pode ser do dono. Estado duvidoso, a suspensão se mantém.
    if (bordas > 1) return "duvidosa";
  } else {
    // Sem moldura (Codex): o fim da tela é o bloco final feito de linhas de rodapé ou em branco, e antes dele, no Codex real, a linha
    // de status ("  <modelo> <esforço> · <pasta>"). A evidência positiva é esse bloco: a linha de status e/ou uma linha de atalhos.
    let k = linhas.length;
    while (k > l + 1 && ehLinhaDeRodapeDoCodex(linhas[k - 1])) k--;
    let linhasDeRodape = 0;
    for (let i = k; i < linhas.length; i++) if (linhas[i].trim() !== "") linhasDeRodape++;
    // Mais de uma linha com cara de rodapé no fim: o TUI desenha uma linha de atalhos só, então uma delas pode ser a última
    // linha do rascunho do dono ("Plan mode on" digitado). Não dá para saber qual: estado indeterminado, a suspensão se mantém.
    if (linhasDeRodape > 1) return "duvidosa";
    let achouRodape = linhasDeRodape > 0;
    let fimDoConteudo = k;
    if (k - 1 > l && ehLinhaDeStatusDoCodex(linhas[k - 1])) {
      indiceDaLinhaDeStatus = k - 1;
      // Se a linha anterior (não em branco) também puder ser lida como status, a última linha do rascunho pode ser uma delas:
      // nada desempata, então a tela é duvidosa.
      let j = k - 2;
      while (j > l && linhas[j].trim() === "") j--;
      if (j > l && ehLinhaDeStatusDoCodex(linhas[j])) return "duvidosa";
      achouRodape = true;
      fimDoConteudo = k - 1;
    }
    // Uma borda de caixa depois do marcador, sem borda em cima, é estrutura pela metade: não se confirma.
    const bordaDepois = linhas.slice(l + 1, k).some((x) => ehLimiteDaCaixa(x));
    if (achouRodape && !bordaDepois) fim = fimDoConteudo;
  }
  if (fim < 0) return "duvidosa";
  // Marca de diálogo FORA da caixa (da borda de baixo, ou da linha de status, em diante) torna a tela duvidosa. O conteúdo
  // já delimitado da caixa não é procurado: o pedido pode conter "yes," ou "Do you want...?" e continua sendo só um pedido.
  // A linha de status do Codex (modelo, pasta e o TÍTULO da sessão, que é texto livre: "Do you want coffee?") não é diálogo.
  const depois = linhas.slice(fim).filter((_, i) => fim + i !== indiceDaLinhaDeStatus);
  const marcaDeDialogoDepois = RE_MARCA_DE_DIALOGO.test(compacta(depois.join("\n")));
  const partes = [linhas[l].replace(RE_MARCADOR_NO_INICIO, ""), ...linhas.slice(l + 1, fim)];
  return { conteudo: compacta(partes.join("\n").replace(/[│┃]\s*$/gm, "")), marcaDeDialogoDepois };
}

/** Olha o fim da tela e diz se a caixa de composição traz EXATAMENTE o texto digitado (o conteúdo inteiro, tolerante
 *  a quebra de linha e moldura), se está vazia, ou se não dá para saber (diálogo, menu, texto de outra pessoa, limites
 *  da caixa ambíguos, tela que não é a caixa). Só "mesmo-texto" autoriza repetir o Enter: um Enter numa caixa que
 *  mudou poderia mandar um rascunho do dono ou confirmar um diálogo de permissão. */
export function estadoDaCaixa(tela: string, texto: string): EstadoDaCaixa {
  if (haDialogoAberto(tela)) return "indeterminada";
  const caixa = lerCaixa(tela);
  if (caixa === null || caixa === "ambigua" || caixa === "duvidosa") return "indeterminada";
  if (caixa.marcaDeDialogoDepois) return "indeterminada";
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

/** A escrita que veio do dono (teclado do terminal ou entrada crua) é a tecla de ENVIAR (Enter)? Só vale o pedaço que é
 *  exatamente "\r" ou "\n", ou que termina em "\r" FORA de colagem com bracketed paste (ESC[200~ ... ESC[201~). Uma colagem,
 *  com ou sem várias quebras de linha, só preenche o editor: o rascunho continua na caixa e a digitação segue suspensa. */
export function ehEnterDoDono(texto: string): boolean {
  if (texto === "\r" || texto === "\n") return true;
  const fora = texto.replace(new RegExp(`${ESC}\\[200~[\\s\\S]*?(?:${ESC}\\[201~|$)`, "g"), "");
  return fora.endsWith("\r");
}

/** A entrada do dono é só navegação, comprovadamente sem efeito no texto da caixa: setas, Home/End, PgUp/PgDn, Insert, teclas de
 *  função e o Esc sozinho (sequências CSI e SS3 inteiras, sem nenhum outro byte). Caractere imprimível, colagem, Backspace (DEL ou
 *  Ctrl+H), Delete (ESC[3~), Ctrl+U/W/K e qualquer outra coisa NÃO são: contam como possível alteração do rascunho. */
export function ehEntradaSemEfeitoNoTexto(texto: string): boolean {
  if (texto === "") return true;
  const nav = new RegExp(
    `^(?:${ESC}\\[(?:[0-9;]*[ABCDHF]|(?:[1245678](?:;[0-9]+)?|1[1-9]|2[0-4])(?:;[0-9]+)?~)|${ESC}O[ABCDHFPQRS]|${ESC}(?!\\[|O))+$`,
  );
  return nav.test(texto);
}
