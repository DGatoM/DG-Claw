// Os canais ligados na sessão principal (hoje só o Telegram oficial do Claude).
//
// Fonte única: `<casa>/.dgclaw/canais.json`, gravado pelo comando `dgclaw-agente
// canal telegram ligar|desligar`. O runner.json continua SÓ LEITURA e não tem campo
// de canal. O arquivo é relido a cada spawn, então ligar ou desligar o canal vale
// no próximo `POST /api/agents/<id>/reiniciar`, sem mexer no descritor.
//
// O arquivo vem de uma pasta que o agente (um LLM com ferramentas) consegue
// escrever, então é tratado como entrada hostil: lista fechada de campos, nada de
// comando, executável, porta ou variável de ambiente vindo dele, e o
// `estado_dir` tem que ficar dentro de `<casa>/.dgclaw/` depois de resolver
// symlinks.
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

/** Para leituras de consulta (GET), que não devem repetir no log o que o spawn já registrou. */
const SEM_LOG = { aviso: (..._: unknown[]) => undefined, erro: (..._: unknown[]) => undefined };
import { gravarJsonAtomico } from "./arquivos.js";

export interface Canais {
  telegram: { ligado: boolean; estadoDir: string | null };
}

const DESLIGADO: Canais = { telegram: { ligado: false, estadoDir: null } };

/** O plugin oficial de Telegram do Claude Code, como o `--channels` o nomeia. */
export const CANAL_TELEGRAM = "plugin:telegram@claude-plugins-official";
/** A chave que o Claude Code carimba no cache de "precisa de autenticação". */
export const CHAVE_TELEGRAM_NO_CACHE = "plugin:telegram:telegram";

export function arquivoDeCanais(casa: string): string {
  return path.join(casa, ".dgclaw", "canais.json");
}

/** realpath de um caminho que pode ainda não existir: resolve o ancestral que existe e
 *  acrescenta o resto (que, por não existir, não tem symlink nenhum). */
function realpathParcial(alvo: string): string {
  const resto: string[] = [];
  let atual = path.resolve(alvo);
  for (;;) {
    try {
      return path.join(fs.realpathSync(atual), ...resto.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const pai = path.dirname(atual);
      if (pai === atual) throw err;
      resto.push(path.basename(atual));
      atual = pai;
    }
  }
}

export function lerCanais(casa: string, registrar = true): Canais {
  const reg = registrar ? log : SEM_LOG;
  const arquivo = arquivoDeCanais(casa);
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { telegram: { ...DESLIGADO.telegram } };
    reg.erro(
      "canais",
      `não consegui ler ${arquivo}: ${err instanceof Error ? err.message : err}`,
      "conferir a permissão de leitura; enquanto isso o canal do Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cru) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("não é um objeto JSON");
  } catch (err) {
    reg.erro(
      "canais",
      `${arquivo} não é um JSON válido: ${err instanceof Error ? err.message : err}`,
      "religar o canal com 'dgclaw-agente canal telegram ligar' (ele regrava o arquivo); enquanto isso o Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }

  for (const campo of Object.keys(obj)) {
    if (campo !== "versao" && campo !== "telegram") {
      reg.aviso("canais", `campo desconhecido '${campo}' em ${arquivo}, ignorado (os campos válidos são versao e telegram)`);
    }
  }
  const tg = obj.telegram;
  if (tg === undefined) return { telegram: { ...DESLIGADO.telegram } };
  if (!tg || typeof tg !== "object" || Array.isArray(tg)) {
    reg.erro(
      "canais",
      `'telegram' em ${arquivo} não é um objeto (veio ${JSON.stringify(tg)})`,
      "religar o canal com 'dgclaw-agente canal telegram ligar'; enquanto isso o Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }
  const t = tg as Record<string, unknown>;
  for (const campo of Object.keys(t)) {
    if (campo !== "ligado" && campo !== "estado_dir") {
      reg.aviso("canais", `campo desconhecido 'telegram.${campo}' em ${arquivo}, ignorado (os campos válidos são ligado e estado_dir)`);
    }
  }
  if (typeof t.ligado !== "boolean" || (t.estado_dir !== undefined && typeof t.estado_dir !== "string")) {
    reg.erro(
      "canais",
      `${arquivo} tem tipo errado: telegram.ligado precisa ser true/false (veio ${JSON.stringify(t.ligado)}) e ` +
        `telegram.estado_dir precisa ser texto (veio ${JSON.stringify(t.estado_dir)})`,
      "religar o canal com 'dgclaw-agente canal telegram ligar'; enquanto isso o Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }
  if (!t.ligado) return { telegram: { ligado: false, estadoDir: null } };

  const estado = typeof t.estado_dir === "string" ? t.estado_dir.trim() : "";
  if (!estado) {
    reg.erro(
      "canais",
      `telegram.ligado é true em ${arquivo}, mas falta telegram.estado_dir`,
      "religar o canal com 'dgclaw-agente canal telegram ligar'; enquanto isso o Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }
  try {
    const raiz = fs.realpathSync(path.join(casa, ".dgclaw"));
    const resolvido = realpathParcial(estado);
    const rel = path.relative(raiz, resolvido);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      reg.erro(
        "canais",
        `telegram.estado_dir '${estado}' (resolvido: ${resolvido}) fica FORA de ${raiz}`,
        "o estado do Telegram tem que ficar dentro de <casa>/.dgclaw/ (symlink para fora também é recusado); " +
          "religar o canal com 'dgclaw-agente canal telegram ligar'. Enquanto isso o Telegram fica DESLIGADO",
      );
      return { telegram: { ...DESLIGADO.telegram } };
    }
    return { telegram: { ligado: true, estadoDir: resolvido } };
  } catch (err) {
    reg.erro(
      "canais",
      `não consegui resolver telegram.estado_dir '${estado}': ${err instanceof Error ? err.message : err}`,
      "conferir se <casa>/.dgclaw existe; enquanto isso o Telegram fica DESLIGADO",
    );
    return { telegram: { ...DESLIGADO.telegram } };
  }
}

/** Pasta vazia para onde apontar TELEGRAM_STATE_DIR quando o canal não é desta sessão:
 *  o plugin faz polling mesmo sem `--channels`, e sem isto uma sessão paralela
 *  consumiria as mensagens do bot e as jogaria fora (mesma regra do launch.sh). */
export function pastaTelegramDesligado(casa: string): string {
  const pasta = path.join(casa, ".dgclaw", "telegram-desligado");
  try {
    fs.mkdirSync(pasta, { recursive: true });
  } catch (err) {
    log.erro(
      "canais",
      `não consegui criar ${pasta}: ${err instanceof Error ? err.message : err}`,
      "conferir a permissão de escrita em <casa>/.dgclaw; sem a pasta o plugin do Telegram pode tentar usar o estado do canal verdadeiro",
    );
  }
  return pasta;
}

/**
 * Tira o carimbo do Telegram do cache de "precisa de autenticação". Regressão do
 * Claude Code (o cache ~/.claude/mcp-needs-auth-cache.json): depois do
 * segundo start o cache marca o canal como precisando de login e ele é pulado,
 * ficando mudo. Arquivo ausente ou sem a chave: nada a fazer. Devolve true se mexeu.
 */
export function limparCacheNeedsAuth(configDir: string): boolean {
  const arquivo = path.join(configDir, "mcp-needs-auth-cache.json");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(arquivo, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    log.aviso(
      "canais",
      `não consegui ler ${arquivo} (${err instanceof Error ? err.message : err}); o canal do Telegram pode ficar mudo se ele tiver o carimbo de autenticação`,
    );
    return false;
  }
  if (!obj || typeof obj !== "object" || !(CHAVE_TELEGRAM_NO_CACHE in obj)) return false;
  delete obj[CHAVE_TELEGRAM_NO_CACHE];
  try {
    gravarJsonAtomico(arquivo, obj);
    log.info("canais", `carimbo ${CHAVE_TELEGRAM_NO_CACHE} removido de ${arquivo}`);
    return true;
  } catch (err) {
    log.erro(
      "canais",
      `não consegui regravar ${arquivo}: ${err instanceof Error ? err.message : err}`,
      "conferir a permissão de escrita no config dir do Claude; sem isso o canal do Telegram pode ficar mudo depois do segundo start",
    );
    return false;
  }
}
