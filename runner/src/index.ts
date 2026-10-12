// dgclaw-agent-<slug>: o processo que É o agente entregue.
//
// Um por agente, com `Restart=always`. A diferença que isto faz, e que é o
// motivo do trabalho: antes, a sessão viva de um agente entregue era um card
// do `bunker-server`, então todo restart do painel do dono derrubava os
// agentes dos clientes dele, e o cofre trancado depois do restart deixava a API
// inteira fora do ar até alguém digitar a senha mestra. Um agente de cliente não
// pode depender de nada disso, e na VPS do cliente não existe Bunker nenhum
// para depender.
//
// O que sobe aqui: o PTY do `claude`, a porta HTTP/WS que fala o dialeto do
// Bunker, e nada mais.
import { criarServidor } from "./servidor.js";
import { GerenteDeSessoes } from "./sessoes.js";
import { lerDescritor, BIND, PORTA, AGENT_FILE, STATE_FILE } from "./config-runner.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const descritor = lerDescritor();
  log.info("boot", `runner do agente ${descritor.slug} (${descritor.id})`);
  log.info("boot", `descritor=${AGENT_FILE} estado=${STATE_FILE}`);
  log.info("boot", `casa=${descritor.config.cwd}`);

  const gerente = new GerenteDeSessoes(descritor, PORTA);
  const servidor = criarServidor(gerente);

  servidor.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.erro(
        "boot",
        `a porta ${PORTA} já está ocupada`,
        `descobrir quem está lá (ss -ltnp | grep ${PORTA}). Cada agente tem a porta dele: ` +
          `duas unidades com a mesma RUNNER_PORT fazem uma subir e a outra reiniciar em laço`,
      );
      process.exit(1);
    }
    log.erro("boot", `o servidor HTTP falhou: ${err.message}`, "ver o erro acima; o serviço vai reiniciar");
    process.exit(1);
  });

  servidor.listen(PORTA, BIND, () => {
    log.info("boot", `no ar em http://${BIND}:${PORTA} (ws em /ws)`);
  });

  // A porta abre ANTES do PTY subir de propósito. Um agente que demora a retomar
  // uma conversa longa não pode aparecer como "a plataforma não respondeu" no
  // painel: enquanto ele sobe, o runner responde e diz `spawning`.
  // Só a principal sobe no boot. As paralelas acordam quando alguém escreve para
  // elas, para não gastar RAM do container com conversa que ninguém está usando.
  gerente.iniciarLaco();
  await gerente.principal.subir("retomar");

  const desligar = (sinal: string) => {
    log.info("boot", `${sinal} recebido, encerrando`);
    // Encerra o PTY de propósito: deixá-lo órfão manteria o `claude` vivo sem
    // ninguém lendo a saída dele, e o próximo boot subiria um SEGUNDO processo
    // na mesma conversa. Dois PTYs na mesma sessão corrompem o transcript.
    gerente.pararTodas(`sinal ${sinal}`);
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => desligar("SIGTERM"));
  process.on("SIGINT", () => desligar("SIGINT"));

  process.on("uncaughtException", (err) => {
    log.erro(
      "fatal",
      `exceção não tratada: ${err.stack ?? err.message}`,
      "o serviço vai reiniciar sozinho (Restart=always); a pilha acima é o que precisa ser lido",
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (motivo) => {
    log.erro(
      "fatal",
      `promessa rejeitada sem tratamento: ${motivo instanceof Error ? motivo.stack : String(motivo)}`,
      "não derruba o processo, mas indica caminho de erro sem tratamento",
    );
  });
}

main().catch((err) => {
  log.erro(
    "fatal",
    `não consegui subir: ${err instanceof Error ? err.stack : String(err)}`,
    "conferir o descritor do agente e o EnvironmentFile da unidade",
  );
  process.exit(1);
});
