// A interface que cada CLI (Claude Code, Codex) implementa para a Sessao.
//
// A Sessao cuida do que é igual nos dois (PTY, fila de entrada, máquina de status,
// estado em disco). O Motor cuida do que muda: os argumentos de linha de comando, o
// que precisa ser preparado antes do spawn, e como saber se há login.
import type { ConfigDoRunner } from "../config-runner.js";
import type { Catalogo } from "./catalogo.js";
import type { Escolha, NomeProvedor } from "./escolha.js";

/** Falha que impede o spawn, com o motivo já em português e sem segredo nenhum. A
 *  Sessao a transforma em `errored` com este `statusReason`. */
export class ErroDeMotor extends Error {
  constructor(
    mensagem: string,
    readonly statusReason: string,
    readonly comoResolver: string,
  ) {
    super(mensagem);
  }
}

/** Por que a sessão não pode conversar agora. `login` = falta entrar com a conta;
 *  `chave` = o modo escolhido exige uma chave que não está no ambiente. */
export interface Recusa {
  tipo: "login" | "chave";
  mensagem: string;
  comoResolver: string;
}

/** Tudo o que o motor precisa saber de UM spawn. A Sessao monta, o motor lê (e o
 *  `preparar` pode completar `env`, `extrasDoMotor` e `limpezas`). */
export interface CtxMotor {
  id: string;
  slug: string;
  papel: "principal" | "paralela";
  porta: number;
  cwd: string;
  config: ConfigDoRunner;
  escolha: Escolha;
  catalogo: Catalogo;
  /** Ambiente já filtrado por modo (ver ambiente.ts) e com os ajustes de canal. */
  env: Record<string, string>;
  /** O modo exige uma variável e ela estava presente ANTES de qualquer preparo
   *  (o Codex na API a tira do ambiente depois de registrar a chave). */
  chaveDoModoPresente: boolean;
  variavelDoModo: string | null;
  pastaDeHooks: string;
  pastaDeEstado: string;
  /** A identidade (persona) concatenada: o arquivo gravado e o texto dele. */
  identidade: { arquivo: string | null; texto: string | null };
  /** Só o Claude: o arquivo de `--settings` com os hooks de status. */
  settings: string | null;
  /** Segredo do spawn, que autentica os eventos de status. NUNCA vai para log. */
  nonce: string;
  /** Só no Claude da sessão principal: o canal Telegram está ligado. */
  canalTelegram: boolean;
  /** Id da sessão nova (Claude pré-fixa com `--session-id`); null no Codex. */
  novoId: string | null;
  /** Argumentos que o `preparar` do motor acrescenta (o Codex monta MCP, identidade e notify). */
  extrasDoMotor: string[];
  /** Roda quando o PTY deste spawn sai (apaga arquivos temporários do spawn). */
  limpezas: Array<() => void>;
  /** Rotula a área do log com o id da sessão paralela. */
  a(area: string): string;
}

export interface Motor {
  provedor: NomeProvedor;
  binario: string;
  /** O CLI chama hooks por `--settings` (Claude). O Codex não: usa notify + rollout. */
  usaHooks: boolean;
  /** Pausa entre o fim do texto e o Enter. O Codex trata texto rápido como colagem. */
  pausaAntesDoEnterMs: number;
  /** Quanto esperar o recibo do Enter antes de bater de novo. */
  reciboMs: number;
  /** O recibo vem de ler o rollout (Codex), então vale esperar mesmo antes do primeiro evento. */
  reciboPorRollout: boolean;
  argsNova(ctx: CtxMotor): string[];
  argsRetomar(ctx: CtxMotor, sessionId: string): string[];
  /** Pré-aprovação de chave, login por chave, arquivos de MCP e notify. Pode lançar ErroDeMotor. */
  preparar(ctx: CtxMotor): Promise<void>;
  motivoSemLogin(ctx: CtxMotor): Recusa | null;
}

/** Os argumentos como vão para o log: sem nonce e sem textos enormes (a identidade vai
 *  inteira num `-c developer_instructions=` e não pertence a uma linha de log). */
export function redigirArgs(args: string[]): string[] {
  return args.map((a, i) => {
    if (args[i - 1] === "--nonce") return "***";
    let s = a.replace(/("--nonce"\s*,\s*")[^"]*(")/g, "$1***$2");
    if (s.length > 300) s = `${s.slice(0, 40)}...<${Buffer.byteLength(a)} bytes>`;
    return s;
  });
}

/** O trecho comum das mensagens de falta de chave. */
export function recusaDeChave(ctx: CtxMotor, nomeDoProvedor: string): Recusa {
  const modo = ctx.catalogo.provedores[ctx.escolha.provedor]?.auth[ctx.escolha.auth];
  const variavel = ctx.variavelDoModo ?? "(variável do modo)";
  return {
    tipo: "chave",
    mensagem:
      `O agente ${ctx.slug} está configurado para o ${nomeDoProvedor} ${modo?.nome ?? ctx.escolha.auth}, ` +
      `mas a variável ${variavel} não está no ambiente dele (ausente ou vazia). ` +
      `Por segurança ele NÃO volta para a assinatura sozinho, e fica parado até isto ser resolvido.`,
    comoResolver:
      `guardar a chave no Cofre do painel com o nome ${variavel} e aplicar, ou trocar a forma de pagar ` +
      `deste agente para a assinatura (POST /api/provedor)`,
  };
}
