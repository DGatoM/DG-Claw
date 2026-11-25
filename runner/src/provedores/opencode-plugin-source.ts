// O plugin de status do OpenCode, como TEXTO, para ser gravado na pasta de configuração do spawn.
//
// O OpenCode não tem hooks por linha de comando como o Claude (`--settings`) nem `notify` como o
// Codex. O gancho dele é o plugin: um arquivo `plugins/<nome>.js` dentro da pasta apontada por
// OPENCODE_CONFIG_DIR, carregado no boot, que recebe os eventos do próprio programa. Este plugin os
// traduz para o POST /api/agent-hook do runner, no mesmo formato do hook do Claude, para a Sessao
// aplicar o mesmo efeito (ver sessao/eventos.ts):
//
//   tela pronta (catalog.updated) -> SessionStart  (tira o card de "subindo"; sem esse sinal, nunca parte)
//   chat.message           -> UserPromptSubmit   (recibo do Enter; traz o id da sessão)
//   tool.execute.before    -> PreToolUse         (ferramenta em uso)
//   session.status busy    -> PreToolUse         (batimento: o turno segue; no máximo 1 a cada 5 s)
//   permission.asked       -> Notification       (parou pedindo autorização)
//   permission.replied     -> PreToolUse         (a pessoa respondeu, o turno segue)
//   session.idle           -> Stop               (fim do turno)
//   session.error          -> StopFailure        (só o NOME do erro; nunca o texto)
//
// Quem é o agente, a porta e o segredo do spawn chegam por variáveis de ambiente DGCLAW_HOOK_*
// (o segredo não fica em arquivo). O plugin apaga a do segredo do ambiente depois de ler, para que
// os comandos que o agente rodar não a herdem.
//
// Invariantes: nunca lança (cada gancho é blindado), nunca segura o turno (o envio é por fila, sem
// ser esperado pelo gancho, com prazo de 1 s por POST) e só avisa mudança de status: o plugin não
// injeta texto, não roda comando e não devolve conteúdo da conversa. O único valor da conversa que
// sai é o id da sessão do OpenCode (ses_...), validado por formato.
export const OPENCODE_PLUGIN_NOME = "dgclaw-status";

export const OPENCODE_PLUGIN_SOURCE = String.raw`import http from "node:http";

const agentId = process.env.DGCLAW_HOOK_AGENT || "";
const port = parseInt(process.env.DGCLAW_HOOK_PORT || "0", 10);
const nonce = process.env.DGCLAW_HOOK_NONCE || "";
// O segredo do spawn só serve a este plugin: some do ambiente antes de qualquer ferramenta do agente rodar.
delete process.env.DGCLAW_HOOK_NONCE;

const PRAZO_MS = 1000;
const BATIMENTO_MS = 5000;
const ID_VALIDO = /^[A-Za-z0-9_.-]{1,100}$/;

let fila = Promise.resolve();
let naFila = 0;
let pendente = false;
let ultimoBatimento = 0;

function idDe(v) {
  return typeof v === "string" && ID_VALIDO.test(v) ? v : null;
}

// O card pertence a UMA sessão do OpenCode: a do primeiro chat.message (o pedido da pessoa, ou a retomada com -s).
// Subtarefas (a ferramenta task) criam sessões filhas que emitem os mesmos eventos; sem este filtro o idle de
// uma filha anunciaria o fim do turno e trocaria o id da conversa do card. Eventos de outra sessão nunca levam
// o id dela adiante; os que só dizem "o card trabalha" ou "precisa de você" seguem sem id.
let sessaoDoCard = null;
// A sessão do card está no meio de um turno. Um pedido novo de OUTRA sessão com o card parado é a pessoa
// trocando de conversa dentro da TUI (/new, /sessions): o card passa a seguir essa. Com o card ocupado, é
// uma subtarefa.
let cardOcupado = false;
function doCard(id) {
  return sessaoDoCard === null || id === sessaoDoCard;
}
function idDoCard(id) {
  return id !== null && id === sessaoDoCard ? id : null;
}

function postar(corpo) {
  return new Promise((resolve) => {
    try {
      const dados = JSON.stringify(corpo);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/agent-hook",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(dados) },
          timeout: PRAZO_MS,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
          res.on("error", resolve);
        },
      );
      req.on("error", resolve);
      req.on("timeout", () => {
        try { req.destroy(); } catch { /* a conexão já caiu: não há o que destruir */ }
        resolve();
      });
      req.end(dados);
    } catch {
      resolve();
    }
  });
}

// Envio em ordem (um Stop nunca passa na frente do PreToolUse que veio antes), sem esperar: o gancho
// do OpenCode volta na hora. Se o runner estiver parado, o excesso é descartado em vez de acumular, mas só os
// batimentos (PreToolUse, que se repetem): permissão, pedido, fim de turno e erro são essenciais e têm um teto
// bem mais alto, porque perder o único Stop deixaria o card em "trabalhando" para sempre.
const ESSENCIAIS = new Set(["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure"]);
let batimentosNaFila = 0;
function avisar(evento, extra, forcarEssencial) {
  if (!agentId || !port) return;
  const essencial = forcarEssencial === true || ESSENCIAIS.has(evento);
  if (!essencial && (naFila > 40 || batimentosNaFila >= 3)) return;
  if (naFila > 400) return;
  naFila += 1;
  if (!essencial) batimentosNaFila += 1;
  const corpo = { agentId, nonce, event: evento, ...(extra || {}) };
  fila = fila.then(() => postar(corpo)).catch(() => undefined).then(() => {
    naFila -= 1;
    if (!essencial) batimentosNaFila -= 1;
  });
}

// O plugin carrega uns 2 s ANTES de a TUI aceitar texto (medido na 1.19.6: carga, rajada de plugin.added e,
// no catalog.updated, a tela pronta). Avisar a partida na carga faria o runner digitar cedo demais, então o
// SessionStart sai só no primeiro catalog.updated (com uma folga curta), ou no primeiro chat.message (a pessoa
// já escreveu). Sem prazo de reserva de propósito: se a tela nunca ficar pronta, quem decide é o runner, que
// espera até 45 s e então recusa o pedido com o motivo, em vez de o plugin liberar a fila para um pedido que
// a tela ainda não aceita.
const FOLGA_DA_TELA_MS = 800;
let partiu = false;
function partida() {
  if (partiu) return;
  partiu = true;
  avisar("SessionStart", { source: "startup" });
}

export const DgclawStatus = async () => {
  return {
    event: async (entrada) => {
      try {
        const event = entrada && entrada.event;
        const tipo = event && event.type;
        const props = (event && event.properties) || {};
        if (tipo === "catalog.updated" && !partiu) {
          const t = setTimeout(partida, FOLGA_DA_TELA_MS);
          if (t && typeof t.unref === "function") t.unref();
        } else if (tipo === "session.status") {
          const status = props.status && props.status.type;
          const agora = Date.now();
          if (status === "busy" && !pendente && agora - ultimoBatimento >= BATIMENTO_MS) {
            ultimoBatimento = agora;
            avisar("PreToolUse", { sessionId: idDoCard(idDe(props.sessionID)) });
          }
        } else if (tipo === "session.idle") {
          // O fim do turno do card é o da sessão do card; o de uma subtarefa não encerra nada.
          if (doCard(idDe(props.sessionID))) {
            pendente = false;
            cardOcupado = false;
            avisar("Stop", { sessionId: idDe(props.sessionID) });
          }
        } else if (tipo === "permission.asked") {
          // Pedido de uma subtarefa também para o card esperando a pessoa: avisa, sem o id da filha.
          pendente = true;
          avisar("Notification", { sessionId: idDoCard(idDe(props.sessionID)) });
        } else if (tipo === "permission.replied") {
          pendente = false;
          ultimoBatimento = Date.now();
          // A resposta a um pedido de permissão muda o estado do card (volta a "trabalhando"): não pode se perder.
          avisar("PreToolUse", { sessionId: idDoCard(idDe(props.sessionID)) }, true);
        } else if (tipo === "session.error") {
          if (doCard(idDe(props.sessionID))) {
            const nome = props.error && typeof props.error.name === "string" ? props.error.name : "erro";
            pendente = false;
            cardOcupado = false;
            avisar("StopFailure", { sessionId: idDe(props.sessionID), error: nome.slice(0, 60) });
          }
        }
      } catch { /* um evento que o plugin não entende nunca pode atrapalhar o turno */ }
    },
    "chat.message": async (input) => {
      try {
        partida();
        const id = idDe(input && input.sessionID);
        if (id && (sessaoDoCard === null || (id !== sessaoDoCard && !cardOcupado))) sessaoDoCard = id;
        if (!doCard(id)) return; // o prompt de uma subtarefa não é um pedido da pessoa
        cardOcupado = true;
        pendente = false;
        ultimoBatimento = Date.now();
        avisar("UserPromptSubmit", { sessionId: id });
      } catch { /* idem */ }
    },
    "tool.execute.before": async (input) => {
      try {
        ultimoBatimento = Date.now();
        avisar("PreToolUse", {
          sessionId: idDoCard(idDe(input && input.sessionID)),
          toolName: input && typeof input.tool === "string" ? input.tool.slice(0, 80) : null,
          toolUseId: idDe(input && input.callID),
        });
      } catch { /* idem */ }
    },
  };
};
`;
