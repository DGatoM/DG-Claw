// Máscara de segredos na saída do terminal do agente.
//
// Porte do leak-detector do DG AI Bunker (apps/server/src/leak-detector.ts): troca
// por `[segredo oculto]` os valores conhecidos (variáveis de ambiente do agente) e
// qualquer coisa com cara de chave de API (Anthropic, OpenAI, Google, GitHub, AWS,
// PEM, Bearer, URL com senha embutida).
//
// Limite: um TUI que redesenha a tela pode intercalar sequência ANSI no meio do
// segredo. A regex tolera espaço, quebra de linha e caractere de controle entre os
// caracteres (até 16 seguidos), mas não uma sequência ANSI arbitrária. É defesa em
// profundidade, não a única barreira: o segredo não deveria chegar à tela.

export const OCULTO = "[segredo oculto]";

const TAMANHO_MINIMO_SEGREDO = 8;
const FOLGA_RETENCAO = 200;

// Cabeçalho de chave privada PEM, montado em duas partes só para o texto da chave
// não aparecer inteiro neste arquivo.
const PEM_INICIO = "-----BEGIN ";
const PEM_FIM = "PRIVATE KEY-----";
const PEM_TIPOS = ["", "RSA ", "EC ", "DSA ", "OPENSSH "];

/** Padrões de chave, copiados do Bunker. Regex com `g`: só usar via replace/exec com lastIndex zerado. */
const PADROES_DE_CHAVE: RegExp[] = [
  /sk-ant-api03-[A-Za-z0-9_-]{90,}/g,
  /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  /sk-proj-[A-Za-z0-9_-]{40,}/g,
  /AIza[A-Za-z0-9_-]{35}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /gho_[A-Za-z0-9]{36}/g,
  new RegExp(`${PEM_INICIO}(?:RSA |EC |DSA |OPENSSH )?${PEM_FIM}`, "g"),
  /AKIA[A-Z0-9]{16}/g,
  /Bearer\s+[A-Za-z0-9_-]{40,}/g,
  /\b[a-z][a-z0-9+.\-]{0,20}:\/\/[^\s:/?#@'"<>]+:[^\s@/?#'"<>]+@[^\s'"<>]+/gi,
];

/**
 * Começos possíveis de um padrão de chave que ainda pode estar chegando.
 * Cada item casa um sufixo do texto (ancorado no fim, sem espaço no meio) que, se
 * continuar, vira chave. Usado só para decidir o que reter na saída em fluxo.
 */
const CAUDAS_DE_CHAVE: RegExp[] = [
  /sk-[A-Za-z0-9_-]*$/, // sk-, sk-ant-api03-, sk-proj-
  /AIza[A-Za-z0-9_-]*$/,
  /ghp_[A-Za-z0-9]*$/,
  /github_pat_[A-Za-z0-9_]*$/,
  /gho_[A-Za-z0-9]*$/,
  /AKIA[A-Z0-9]*$/,
  /Bearer\s+[A-Za-z0-9_-]*$/,
  /\b[a-z][a-z0-9+.\-]{0,20}:\/\/[^\s'"<>]*$/i, // URL já com "://", esperando usuário:senha@
  /\b[a-z][a-z0-9+.\-]{0,20}:\/$/i,
];

/** Literais cujo começo (qualquer prefixo próprio, a partir de 1 caractere) pode ser o início de uma chave. */
const LITERAIS_DE_CHAVE = [
  "sk-",
  "AIza",
  "ghp_",
  "github_pat_",
  "gho_",
  "AKIA",
  "Bearer ",
  ...PEM_TIPOS.map((tipo) => PEM_INICIO + tipo + PEM_FIM),
];

const ENTRE_CARACTERES = "[\\s\\x00-\\x1f]{0,16}";
const CONTROLE_OU_ESPACO = /[\s\x00-\x1f]/g;

const cacheRegexTolerante = new Map<string, RegExp>();

/** Casa o segredo mesmo com quebra de linha, indentação ou controle entre os caracteres. */
function regexTolerante(segredo: string): RegExp {
  let re = cacheRegexTolerante.get(segredo);
  if (!re) {
    const corpo = segredo
      .split("")
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(ENTRE_CARACTERES);
    re = new RegExp(corpo, "g");
    cacheRegexTolerante.set(segredo, re);
  }
  re.lastIndex = 0;
  return re;
}

/** Tira repetidos e curtos, e ordena do mais longo para o mais curto. */
function prepararSegredos(conhecidos?: Iterable<string>): string[] {
  if (!conhecidos) return [];
  return Array.from(new Set(conhecidos))
    .filter((s) => typeof s === "string" && s.length >= TAMANHO_MINIMO_SEGREDO)
    .sort((a, b) => b.length - a.length);
}

/** Valores de `env[nome]` que valem como segredo: não vazios, com 8+ caracteres, sem repetição, do mais longo ao mais curto. */
export function segredosConhecidos(
  nomes: Iterable<string>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const valores = new Set<string>();
  for (const nome of nomes) {
    const valor = env[nome]?.trim();
    if (valor && valor.length >= TAMANHO_MINIMO_SEGREDO) valores.add(valor);
  }
  return Array.from(valores).sort((a, b) => b.length - a.length);
}

function mascararJa(texto: string, segredos: string[]): string {
  if (!texto) return texto;
  let resultado = texto;
  for (const segredo of segredos) resultado = resultado.replace(regexTolerante(segredo), OCULTO);
  for (const padrao of PADROES_DE_CHAVE) {
    padrao.lastIndex = 0;
    resultado = resultado.replace(padrao, OCULTO);
  }
  return resultado;
}

/** Troca os segredos conhecidos e os padrões de chave por `[segredo oculto]`. Pura. */
export function mascarar(texto: string, conhecidos?: Iterable<string>): string {
  if (!texto) return texto;
  return mascararJa(texto, prepararSegredos(conhecidos));
}

/**
 * Máscara para a saída do PTY, que chega em pedaços de tamanho qualquer.
 *
 * Um segredo partido entre dois pedaços não casa em nenhum dos dois, então o final
 * do texto que ainda pode virar segredo fica retido até chegar o pedaço seguinte
 * (ou até `descarregar()`). Retém a partir de 1 caractere: se soltasse "abc" de um
 * segredo "abcdefgh", o resto não seria reconhecido depois e a concatenação
 * deixaria o valor inteiro à mostra. A retenção nunca passa do maior segredo
 * conhecido mais 200 caracteres. Quem usa deve chamar `descarregar()` (por
 * exemplo num temporizador de silêncio) para a tela não ficar presa.
 */
export class MascaraDeFluxo {
  private readonly segredos: string[];
  private readonly limite: number;
  private retido = "";

  constructor(conhecidos: Iterable<string>) {
    this.segredos = prepararSegredos(conhecidos);
    const maior = this.segredos[0]?.length ?? 0;
    this.limite = maior + FOLGA_RETENCAO;
  }

  passar(pedaco: string): string {
    const texto = this.retido + pedaco;
    if (!texto) return "";
    const corte = this.pontoDeCorte(texto);
    this.retido = texto.slice(corte);
    return mascararJa(texto.slice(0, corte), this.segredos);
  }

  descarregar(): string {
    const saida = mascararJa(this.retido, this.segredos);
    this.retido = "";
    return saida;
  }

  /** Índice a partir do qual o texto fica retido (texto.length quando não há o que reter). */
  private pontoDeCorte(texto: string): number {
    const tamanho = texto.length;
    const janelaInicio = Math.max(0, tamanho - this.limite);
    const janela = texto.slice(janelaInicio);
    let corte = tamanho;

    // 1) Sufixo que é começo de algum segredo conhecido (tolerando espaço/controle).
    for (const segredo of this.segredos) {
      const primeiro = segredo[0]!;
      let i = janela.indexOf(primeiro);
      while (i !== -1) {
        const base = janelaInicio + i;
        if (base < corte) {
          const sem = texto.slice(base).replace(CONTROLE_OU_ESPACO, "");
          if (sem.length < segredo.length && segredo.startsWith(sem)) corte = base;
        }
        i = janela.indexOf(primeiro, i + 1);
      }
    }

    // 2) Sufixo que é começo de um literal de chave (prefixo próprio) ou já a cauda aberta de um padrão.
    for (const literal of LITERAIS_DE_CHAVE) {
      const maxLen = Math.min(literal.length - 1, tamanho);
      for (let n = maxLen; n >= 1; n--) {
        if (tamanho - n < corte && literal.startsWith(texto.slice(tamanho - n))) {
          corte = tamanho - n;
          break;
        }
      }
    }
    for (const cauda of CAUDAS_DE_CHAVE) {
      const m = cauda.exec(janela);
      if (m && janelaInicio + m.index < corte) corte = janelaInicio + m.index;
    }

    if (corte === tamanho) return corte;

    // 3) Não cortar no meio de um segredo ou chave que já casou por inteiro.
    const intervalos = this.intervalosCasados(texto);
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (const [ini, fim] of intervalos) {
        if (ini < corte && corte < fim) {
          corte = ini;
          mudou = true;
        }
      }
    }

    // 4) Teto: nunca segurar mais que o limite.
    return Math.max(corte, janelaInicio);
  }

  private intervalosCasados(texto: string): Array<[number, number]> {
    const achados: Array<[number, number]> = [];
    const coletar = (re: RegExp) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(texto)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        achados.push([m.index, m.index + m[0].length]);
      }
    };
    for (const segredo of this.segredos) coletar(regexTolerante(segredo));
    for (const padrao of PADROES_DE_CHAVE) coletar(padrao);
    return achados;
  }
}
