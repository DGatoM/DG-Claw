// Quem é o agente deste processo, e onde ele guarda o que sobrevive a restart.
//
// Um runner serve UM agente. Não é limitação de implementação: é a decisão de
// desenho. O agente entregue a um terceiro tem que morrer e nascer sozinho, sem
// que a queda dele encoste na de outro cliente, e é o systemd (com
// `Restart=always` por unidade) que dá isso de graça. Um processo servindo
// vários voltaria a ter o problema que este trabalho veio resolver: um restart
// derruba todo mundo.
//
// Dois arquivos, com donos diferentes de propósito:
//
//   runner.json        o QUE o agente é (id, slug, AgentConfig). Escrito por
//                      quem provisiona (o agents-server, ou o instalador do DG
//                      Claw na VPS do cliente). O runner só lê.
//   runner-state.json  o que o agente VIVEU (sessionId, sessão anterior, último
//                      status). Escrito só pelo runner.
//
// Misturar os dois é o erro clássico: quem provisiona reescreve o descritor e
// leva junto o sessionId, e o agente "esquece" a conversa inteira no próximo
// restart, sem erro nenhum no caminho.
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig, AgentStatus } from "./tipos.js";
import { log } from "./logger.js";

/** O AgentConfig do shared não conhece `promptHooks` (comandos extras do evento
 *  UserPromptSubmit). Estendido aqui, e não no shared, para o runner continuar
 *  compilando sem que o resto do monorepo precise mudar junto. */
export type ConfigDoRunner = AgentConfig & { promptHooks?: string[] };

/** Uma sessão paralela declarada no descritor: outra conversa do MESMO agente
 *  (mesma casa, mesma memória, mesmo login), com PTY e sessionId próprios. */
export interface SessaoParalelaDescrita {
  id: string;
  tipo: string;
  slug?: string;
  chat: string;
  identidade?: string[];
  ociosoMinutos?: number;
  envExtra?: Record<string, string>;
  allowTools?: string[];
  promptHooks?: string[];
}

export interface CapacidadeDescrita {
  /** Quanto cada conversa acordada pesa em memória, em GB. */
  gbPorSessao?: number;
  /** Folga que nunca se gasta, em GB. Padrão: 25% do limite (cgroup) ou 2 GB (host). */
  reservaGb?: number;
  /** Avisa a principal quando faltarem no máximo tantas vagas para o teto.
   *  Padrão 0 (só quando não cabe mais nenhuma): a nota entra na conversa do
   *  cliente, e com folga 1 ela sairia toda vez que os bastidores acordassem. */
  avisoFaltando?: number;
}

export interface DescritorDoAgente {
  /** O id do agente. É o MESMO id do card antigo, e o mesmo do delivered_agent
   *  no banco do agents-server: o painel da pessoa, o `bunkerCard` do painel DG
   *  Claw e as rotinas do `config.sh` apontam todos para ele. Trocar este id na
   *  migração significaria reescrever tudo isso, então ele não muda nunca. */
  id: string;
  slug: string;
  config: ConfigDoRunner;
  /** Id do chat da principal no canal. Padrão `c_${slug}`. */
  chatPrincipal?: string;
  /** Onde a principal recebe as notas do sistema (relativo ao cwd ou absoluto).
   *  Padrão `.plataforma/bastidores/notas.jsonl`. */
  notasPrincipal?: string;
  capacidade?: CapacidadeDescrita;
  sessoes?: SessaoParalelaDescrita[];
}

export const CAPACIDADE_PADRAO = { gbPorSessao: 0.4, avisoFaltando: 0 } as const;
export const OCIOSO_MINUTOS_PADRAO = 20;
export const NOTAS_PADRAO = ".plataforma/bastidores/notas.jsonl";

/** Uma sessão paralela já validada, com os padrões aplicados. */
export interface SessaoParalelaValida extends SessaoParalelaDescrita {
  slug: string;
  ociosoMinutos: number;
}

/**
 * Valida as sessões paralelas do descritor. Sessão inválida é registrada e
 * PULADA: a principal (o agente que o cliente usa) sobe de qualquer jeito, que é
 * a degradação certa. Derrubar o runner por causa de uma sessão de bastidores
 * deixaria o cliente sem agente por um erro de configuração que não é dele.
 */
export function validarSessoes(d: DescritorDoAgente): SessaoParalelaValida[] {
  if (d.sessoes === undefined) return [];
  if (!Array.isArray(d.sessoes)) {
    log.erro(
      "config",
      `"sessoes" no descritor ${AGENT_FILE} não é uma lista (veio ${typeof d.sessoes})`,
      "corrigir para um array de objetos { id, tipo, chat }; nenhuma sessão paralela vai existir até lá",
    );
    return [];
  }
  const chatPrincipal = d.chatPrincipal?.trim() || `c_${d.slug}`;
  const vistos = new Set<string>();
  const validas: SessaoParalelaValida[] = [];
  d.sessoes.forEach((s, i) => {
    const nome = `sessoes[${i}]${s && typeof s.id === "string" ? ` (${s.id})` : ""}`;
    const pular = (motivo: string, comoResolver: string) =>
      log.erro("config", `${nome} ignorada: ${motivo}`, `${comoResolver}. As outras sessões e a principal sobem normalmente`);
    if (!s || typeof s !== "object") {
      pular(`o item não é um objeto (veio ${JSON.stringify(s)})`, "corrigir o item no descritor");
      return;
    }
    if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(s.id)) {
      pular(
        `id inválido: ${JSON.stringify(s.id)}`,
        "usar só letras, números, hífen e sublinhado (o id vira nome de pasta e de arquivo)",
      );
      return;
    }
    if (s.id === d.id) {
      pular(`o id ${s.id} é o mesmo da sessão principal`, "dar um id próprio à sessão paralela");
      return;
    }
    if (vistos.has(s.id)) {
      pular(`o id ${s.id} aparece mais de uma vez`, "cada sessão paralela precisa de um id único");
      return;
    }
    if (typeof s.tipo !== "string" || !s.tipo.trim()) {
      pular("falta o campo tipo", 'preencher tipo (ex.: "bastidores")');
      return;
    }
    if (typeof s.chat !== "string" || !s.chat.trim()) {
      pular("falta o campo chat", "preencher chat com o id do chat dessa sessão no canal");
      return;
    }
    if (s.chat.trim() === chatPrincipal) {
      pular(
        `o chat ${s.chat} é o mesmo da principal`,
        "a sessão paralela precisa de um chat próprio, senão as respostas dela cairiam na conversa do cliente",
      );
      return;
    }
    const ocioso = s.ociosoMinutos;
    if (ocioso !== undefined && !(typeof ocioso === "number" && Number.isFinite(ocioso) && ocioso > 0)) {
      pular(`ociosoMinutos inválido: ${JSON.stringify(ocioso)}`, "usar um número maior que zero (minutos)");
      return;
    }
    vistos.add(s.id);
    validas.push({
      ...s,
      tipo: s.tipo.trim(),
      chat: s.chat.trim(),
      slug: s.slug?.trim() || `${d.slug}-${s.tipo.trim()}`,
      ociosoMinutos: ocioso ?? OCIOSO_MINUTOS_PADRAO,
    });
  });
  return validas;
}

export interface EstadoPersistido {
  sessionId: string | null;
  previousSessionId: string | null;
  status: AgentStatus | null;
  atualizadoEm: number;
}

function exigir(nome: string): string {
  const v = process.env[nome]?.trim();
  if (!v) {
    log.erro(
      "config",
      `a variável ${nome} não veio no ambiente deste processo`,
      `conferir o EnvironmentFile da unidade (systemctl cat dgclaw-agent-<slug>) — ` +
        `o runner não adivinha qual agente ele serve, e subir com um default aqui seria ` +
        `servir o agente errado em silêncio`,
    );
    process.exit(1);
  }
  return v;
}

export const AGENT_FILE = exigir("RUNNER_AGENT_FILE");
export const PORTA = Number.parseInt(exigir("RUNNER_PORT"), 10);
/** Loopback fixo por padrão, como no agents-server: quem publica na internet é
 *  o túnel, com login na frente. Só muda por env explícita, para o dia em que o
 *  runner rodar num container com rede própria. */
export const BIND = process.env.RUNNER_BIND?.trim() || "127.0.0.1";
export const STATE_FILE =
  process.env.RUNNER_STATE_FILE?.trim() || path.join(path.dirname(AGENT_FILE), "runner-state.json");

if (!Number.isFinite(PORTA) || PORTA <= 0 || PORTA > 65535) {
  log.erro(
    "config",
    `RUNNER_PORT="${process.env.RUNNER_PORT}" não é uma porta válida`,
    "corrigir RUNNER_PORT no EnvironmentFile do agente (1 a 65535)",
  );
  process.exit(1);
}

export function lerDescritor(): DescritorDoAgente {
  let cru: string;
  try {
    cru = fs.readFileSync(AGENT_FILE, "utf8");
  } catch (err) {
    log.erro(
      "config",
      `não consegui ler o descritor ${AGENT_FILE}: ${err instanceof Error ? err.message : err}`,
      `conferir se o arquivo existe e é legível por este serviço (ls -l ${AGENT_FILE}). ` +
        `Ele é escrito pelo provisionamento; sem ele o runner não sabe que agente servir`,
    );
    process.exit(1);
  }
  let obj: Partial<DescritorDoAgente>;
  try {
    obj = JSON.parse(cru) as Partial<DescritorDoAgente>;
  } catch (err) {
    log.erro(
      "config",
      `o descritor ${AGENT_FILE} não é JSON válido: ${err instanceof Error ? err.message : err}`,
      `abrir o arquivo e corrigir o JSON. Recusar aqui é de propósito: subir com ` +
        `descritor pela metade daria um agente sem MCP, sem identidade e sem permissões, ` +
        `e ele pareceria vivo`,
    );
    process.exit(1);
  }
  const faltando: string[] = [];
  if (!obj.id?.trim()) faltando.push("id");
  if (!obj.slug?.trim()) faltando.push("slug");
  if (!obj.config || typeof obj.config !== "object") faltando.push("config");
  if (!obj.config?.cwd?.trim()) faltando.push("config.cwd");
  if (faltando.length) {
    log.erro(
      "config",
      `o descritor ${AGENT_FILE} está sem: ${faltando.join(", ")}`,
      "preencher os campos que faltam no descritor (id, slug, config.cwd são o mínimo)",
    );
    process.exit(1);
  }
  if (!fs.existsSync(obj.config!.cwd)) {
    log.erro(
      "config",
      `a casa do agente não existe: ${obj.config!.cwd}`,
      `criar a pasta ou corrigir config.cwd em ${AGENT_FILE}. O claude não sobe sem cwd válido`,
    );
    process.exit(1);
  }
  return obj as DescritorDoAgente;
}

const ESTADO_VAZIO: EstadoPersistido = {
  sessionId: null,
  previousSessionId: null,
  status: null,
  atualizadoEm: 0,
};

export function lerEstado(arquivo: string = STATE_FILE): EstadoPersistido {
  try {
    if (!fs.existsSync(arquivo)) return { ...ESTADO_VAZIO };
    return { ...ESTADO_VAZIO, ...(JSON.parse(fs.readFileSync(arquivo, "utf8")) as EstadoPersistido) };
  } catch (err) {
    // Estado ilegível NÃO derruba o runner: o agente sobe como sessão nova, que
    // é degradação honesta. Mas o aviso precisa aparecer, porque a conta que a
    // pessoa vai fazer é "cadê a conversa de ontem".
    log.aviso(
      "estado",
      `não consegui ler ${arquivo} (${err instanceof Error ? err.message : err}); ` +
        `este agente vai subir como sessão NOVA e a conversa anterior fica no disco, não perdida`,
    );
    return { ...ESTADO_VAZIO };
  }
}

export function gravarEstado(estado: Partial<EstadoPersistido>, arquivo: string = STATE_FILE): void {
  const atual = lerEstado(arquivo);
  const novo: EstadoPersistido = { ...atual, ...estado, atualizadoEm: Date.now() };
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    // Grava por arquivo temporário + rename: um corte de energia no meio da
    // escrita deixaria um JSON pela metade, e o próximo boot perderia o
    // sessionId (que é a conversa inteira do cliente).
    const tmp = `${arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(novo, null, 2) + "\n");
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    log.erro(
      "estado",
      `não consegui gravar ${arquivo}: ${err instanceof Error ? err.message : err}`,
      `conferir permissão de escrita na pasta. Sem isso o agente perde o vínculo com a ` +
        `sessão no próximo restart e volta como conversa nova`,
    );
  }
}
