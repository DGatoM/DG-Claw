// Os servidores MCP do agente, traduzidos para o Codex.
//
// O `config.mcpConfig` do descritor é o formato do Claude (`--mcp-config`):
//   {"mcpServers": {"nome": {"command", "args", "env"}  ou  {"url"}}}
// O Codex não lê esse arquivo; recebe cada servidor por `-c mcp_servers.<nome>.*`.
//
// O problema que isto resolve: o Codex NÃO repassa o ambiente ao servidor MCP
// (testado em 12/10/2026), então o `env` do servidor teria que ir no argv, e o argv
// de um processo é legível por qualquer um na máquina (/proc/<pid>/cmdline). Para não
// pôr nada sensível ali, cada servidor de comando ganha DOIS arquivos na pasta de
// hooks do spawn: um `.env` (modo 600) com as variáveis, e um `.sh` (modo 700) que
// carrega o `.env` e faz `exec` do comando. O Codex só vê o caminho do `.sh`.
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

const NOME_DE_SERVIDOR = /^[A-Za-z0-9_-]+$/;
const NOME_DE_VARIAVEL = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A regra de `linhaDeAmbiente` do panel/lib/cofre.js: valor com aspa simples ou
 *  quebra de linha não vira linha de ambiente (quebraria o `. arquivo` do shell). */
export function linhaDeAmbiente(nome: string, valor: string): string {
  if (!NOME_DE_VARIAVEL.test(nome)) throw new Error(`o nome de variável '${nome}' é inválido`);
  if (valor.includes("'") || /[\n\r\0]/.test(valor)) {
    throw new Error(`a variável ${nome} tem aspa simples ou quebra de linha no valor, e isso não pode virar linha de ambiente`);
  }
  return `${nome}='${valor}'`;
}

/** Aspas simples de shell, com `'` escapado como `'\''`. */
function aspas(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface DefinicaoMcp {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
}

export function lerMcpConfig(mcp: string, cwd: string, area: string): Record<string, DefinicaoMcp> | null {
  let cru = mcp.trim();
  if (!cru.startsWith("{")) {
    const caminho = path.resolve(cwd, cru);
    try {
      cru = fs.readFileSync(caminho, "utf8");
    } catch (err) {
      log.erro(
        area,
        `mcpConfig aponta para ${caminho}, que não consegui ler: ${err instanceof Error ? err.message : err}`,
        "o agente Codex sobe SEM os servidores MCP, então a tool de resposta do canal não vai existir e a janela de conversa " +
          "fica muda: corrigir o caminho de mcpConfig no descritor",
      );
      return null;
    }
  }
  try {
    const o = JSON.parse(cru) as { mcpServers?: Record<string, DefinicaoMcp> };
    if (!o.mcpServers || typeof o.mcpServers !== "object") throw new Error('falta o objeto "mcpServers"');
    return o.mcpServers;
  } catch (err) {
    log.erro(
      area,
      `o mcpConfig não é um JSON {"mcpServers": {...}} válido: ${err instanceof Error ? err.message : err}`,
      "o agente Codex sobe SEM os servidores MCP; corrigir o JSON do mcpConfig no descritor",
    );
    return null;
  }
}

export interface MontagemDoMcp {
  /** Os `-c mcp_servers...` para o argv do Codex. */
  args: string[];
  /** Apaga os arquivos deste spawn. */
  limpar: () => void;
  /** Servidores que não puderam entrar (nome fora do padrão, valor recusado). */
  pulados: string[];
}

export interface EntradaDoMcp {
  mcpConfig: string;
  cwd: string;
  /** O ambiente final da sessão, de onde saem as DGCHAT_*. */
  env: Record<string, string>;
  idDaSessao: string;
  pastaDeHooks: string;
  /** Distingue os arquivos deste spawn dos de um spawn anterior da mesma sessão. */
  tag: string;
  area: string;
}

export function prepararMcpDoCodex(ent: EntradaDoMcp): MontagemDoMcp {
  const vazio: MontagemDoMcp = { args: [], limpar: () => undefined, pulados: [] };
  const servidores = lerMcpConfig(ent.mcpConfig, ent.cwd, ent.area);
  if (!servidores) return vazio;

  // Restos de spawns anteriores desta sessão (um kill -9 não deixa o onExit rodar).
  const raiz = path.join(ent.pastaDeHooks, `mcp-${ent.idDaSessao}`);
  fs.rmSync(raiz, { recursive: true, force: true });
  const dir = path.join(raiz, ent.tag);

  const args: string[] = [];
  const pulados: string[] = [];
  let criouPasta = false;
  const pular = (nome: string, motivo: string, comoResolver: string) => {
    pulados.push(nome);
    log.erro(ent.area, `servidor MCP '${nome}' ignorado no Codex: ${motivo}`, comoResolver);
  };

  for (const [nome, def] of Object.entries(servidores)) {
    if (!NOME_DE_SERVIDOR.test(nome)) {
      pular(nome, "o nome tem caracteres fora de letras, números, hífen e sublinhado", "renomear o servidor no mcpConfig");
      continue;
    }
    if (!def || typeof def !== "object") {
      pular(nome, `a definição não é um objeto (veio ${JSON.stringify(def)})`, "corrigir o mcpConfig no descritor");
      continue;
    }
    if (typeof def.url === "string" && def.url.trim()) {
      args.push("-c", `mcp_servers.${nome}.url=${JSON.stringify(def.url.trim())}`);
      continue;
    }
    if (typeof def.command !== "string" || !def.command.trim()) {
      pular(nome, "não tem nem 'command' nem 'url'", "corrigir o mcpConfig no descritor");
      continue;
    }
    const argv = Array.isArray(def.args) ? def.args : [];
    if (!argv.every((a) => typeof a === "string")) {
      pular(nome, "'args' tem item que não é texto", "corrigir os args do servidor no mcpConfig");
      continue;
    }
    // O env do servidor e depois as DGCHAT_* da sessão: as da sessão vencem, porque o
    // mcpConfig é compartilhado e o da paralela não pode apontar para a saída da principal.
    const variaveis: Record<string, string> = {};
    const entrada = def.env && typeof def.env === "object" ? (def.env as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(entrada)) {
      if (typeof v === "string") variaveis[k] = v;
    }
    for (const [k, v] of Object.entries(ent.env)) {
      if (k.startsWith("DGCHAT_")) variaveis[k] = v;
    }
    let linhas: string[];
    try {
      linhas = Object.entries(variaveis).map(([k, v]) => linhaDeAmbiente(k, v));
    } catch (err) {
      pular(
        nome,
        err instanceof Error ? err.message : String(err),
        "tirar a aspa simples ou a quebra de linha do valor dessa variável (o valor não é mostrado aqui de propósito)",
      );
      continue;
    }

    if (!criouPasta) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      criouPasta = true;
    }
    const arquivoEnv = path.join(dir, `mcp-${nome}.env`);
    const arquivoSh = path.join(dir, `mcp-${nome}.sh`);
    fs.writeFileSync(arquivoEnv, linhas.join("\n") + (linhas.length ? "\n" : ""), { mode: 0o600 });
    fs.chmodSync(arquivoEnv, 0o600);
    const comando = [def.command.trim(), ...(argv as string[])].map(aspas).join(" ");
    fs.writeFileSync(arquivoSh, `#!/bin/sh\nset -a; . ${aspas(arquivoEnv)}; set +a; exec ${comando}\n`, { mode: 0o700 });
    fs.chmodSync(arquivoSh, 0o700);
    args.push("-c", `mcp_servers.${nome}.command=${JSON.stringify(arquivoSh)}`, "-c", `mcp_servers.${nome}.args=[]`);
  }

  return {
    args,
    pulados,
    limpar: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.aviso(ent.area, `não consegui apagar os arquivos de MCP em ${dir}: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
}
