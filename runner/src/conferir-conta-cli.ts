// Conferência de conta para as rotinas autônomas do agente que rodam o Claude fora do runner (reflexão
// headless, crons de publicação e de comentários). Mesma regra de conferirContaComRestricoes, chamada por
// scripts/_lib/restricoes-rotina.sh antes de cada execução.
//
// Saída: código 0 = pode rodar (sem restrição, ou restrição ativa e conta compatível); código 1 = recusa, com
// o motivo e o que fazer no stderr, em português. Quando pode rodar COM restrição ativa, o stdout traz uma
// ferramenta negada por linha (o denyTools do runner.json), para a rotina passar ao motor com --disallowedTools.
// Sem restrição ativa o stdout sai vazio e nada muda.
//
// Os valores padrão abaixo existem porque o config-runner.ts exige variáveis que só a unidade do runner define.
export {};
process.env.RUNNER_AGENT_FILE ||= "/etc/dgclaw-runner/runner.json";
process.env.RUNNER_PORT ||= "1";

const { conferirContaComRestricoes, lerRestricoes } = await import("./restricoes-conta.js");
const { AGENT_FILE } = await import("./config-runner.js");
const fs = await import("node:fs");

function negadasDoRunner(): string[] {
  let j: unknown;
  try {
    j = JSON.parse(fs.readFileSync(AGENT_FILE, "utf8"));
  } catch (err) {
    throw new Error(`não consegui ler as ferramentas negadas em ${AGENT_FILE} (${err instanceof Error ? err.message : err})`);
  }
  const deny = (j as { config?: { denyTools?: unknown } } | null)?.config?.denyTools;
  if (deny === undefined || deny === null) return [];
  if (!Array.isArray(deny)) throw new Error(`"config.denyTools" em ${AGENT_FILE} precisa ser uma lista`);
  return deny.filter((x): x is string => typeof x === "string" && x.trim() !== "" && !/[\r\n]/.test(x)).map((x) => x.trim());
}

async function main(): Promise<number> {
  const rotulo = process.argv[2] || "rotina do agente";
  const lida = lerRestricoes();
  if (!lida.ativa) return 0;
  let negadas: string[];
  try {
    const conf = await conferirContaComRestricoes(process.env as Record<string, string>, process.cwd());
    if (!conf.ok) {
      process.stderr.write(`${rotulo}: RECUSADA. ${conf.mensagem.replace("a sessão não abriu", "a rotina não rodou")} O que fazer: ${conf.comoResolver}\n`);
      return 1;
    }
    negadas = negadasDoRunner();
  } catch (err) {
    process.stderr.write(
      `${rotulo}: RECUSADA. Há restrições ativas e não consegui conferir a conta ou a lista de ferramentas negadas (${err instanceof Error ? err.message : err}). ` +
        `O que fazer: o dono do servidor confere o agente com: dgclaw agente restricoes <nome-do-agente>\n`,
    );
    return 1;
  }
  if (negadas.length) process.stdout.write(`${negadas.join("\n")}\n`);
  return 0;
}

process.exit(await main());
