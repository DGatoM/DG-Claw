#!/usr/bin/env node
// Servidor MCP do DG CHAT (DG Claw): o "correio" pelo qual o agente entrega
// mensagem para a pessoa dona dele, pelo painel.
//
// Porte de apps/agents-server/src/dgchat-mcp/server.mjs, da plataforma. Os dois
// arquivos são deliberadamente parecidos para continuarem diffáveis; o que muda
// está isolado no MODO, logo abaixo, e explicado em docs/CANAL-DG-CHAT.md.
//
// A ideia central do canal: o que o agente escreve como texto e o que ele pensa
// NÃO chegam a ninguém. Só chega o que passa por uma das tools daqui. É o mesmo
// contrato que ele já tem com o plugin do Telegram, e é o que permite trabalhar,
// errar, tentar de novo e só então falar, em vez de despejar o processo inteiro
// em cima de quem perguntou.
//
// COMO A MENSAGEM CHEGA NA TELA (a parte que surpreende):
//   Não há transporte. A chamada da tool fica gravada no transcript da sessão
//   como `tool_use`, o `scripts/_lib/thread_log.py` casa `__dgchat__reply` e
//   `__dgchat__send_file` por sufixo, e a aba Conversa do painel relê o
//   transcript a cada poll. A entrega É a chamada. Este processo só valida,
//   registra e devolve ao agente uma resposta honesta sobre o que aconteceu.
//
// Sem dependências de propósito: só builtins do node. Assim ele roda em
// qualquer VPS de aluna, sem `npm install` e sem bun.
//
// Como a sessão recebe isto: `--mcp-config <ws>/.dgclaw/dgchat.mcp.json`,
// escrito pelo `scripts/launch.sh`. NUNCA usar `--strict-mcp-config`: derrubaria
// os MCPs globais, inclusive o do Telegram. Fora do `bypassPermissions`, as duas
// tools precisam estar em `permissions.allow`, senão o agente para em
// "aguardando permissão" a CADA resposta.
//
// Ambiente:
//   DGCHAT_AGENT     slug do agente (aparece no registro de entrega)
//   DGCHAT_OUTBOUND  caminho do outbound.jsonl (default ao lado do workspace)
//   DGCLAW_WHATSAPP_SOCK  socket da ponte do WhatsApp (padrão ~/.dgclaw/whatsapp/ponte.sock)
//   DGCHAT_SESSAO_ID presente e não vazio = sessão paralela (não fala pelo WhatsApp)
//   DGCHAT_URL       base do agents-server. AUSENTE É O NORMAL AQUI: quer dizer
//                    DG Claw rodando sozinho, sem plataforma. Presente só quando
//                    o agente vive num card do Bunker.
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { connect } from "node:net";

const AGENTE = process.env.DGCHAT_AGENT || "";
const BASE_URL = (process.env.DGCHAT_URL || "").replace(/\/+$/, "");
const OUTBOUND =
  process.env.DGCHAT_OUTBOUND || resolve(process.cwd(), ".dgclaw", "dgchat", "outbound.jsonl");

/**
 * O modo. É a única diferença de comportamento em relação à plataforma, e ela
 * existe porque copiar as frases de lá produziria mentira aqui.
 *
 *   "transcript"  DG Claw sozinho. Não há para onde empurrar e não precisa: a
 *                 dona vê a mensagem no próximo poll do painel. Entrega é
 *                 entrega, e a tool tem que dizer isso.
 *   "plataforma"  há um agents-server. Aí sim existe empurrão por WebSocket, e
 *                 falhar nele é atraso (não perda), o que o agente precisa saber
 *                 para não reenviar.
 *
 * Errar isto é caro do jeito mais silencioso possível: um agente que ouve
 * "registrado para entrega" quando já entregou repete a mensagem.
 */
const MODO = BASE_URL ? "plataforma" : "transcript";

const PROTOCOLO_PADRAO = "2024-11-05";
const LIMITE_TEXTO = 32_000; // acima disso é despejo de log, não mensagem
const LIMITE_ARQUIVO = 64 * 1024 * 1024;

const enviar = (o) => process.stdout.write(JSON.stringify(o) + "\n");

/**
 * Registro do que foi entregue, no molde do telegram_notify.py. NÃO é a conversa:
 * ninguém lê este arquivo para montar a tela (quem monta a tela lê o transcript).
 * Ele responde a uma pergunta só, a que sempre aparece quando algo some: "ele
 * acha que falou; saiu alguma coisa?". Serve ao /doctor e a quem depura.
 */
function registrar(evento) {
  const linha = JSON.stringify({ ts: new Date().toISOString(), agent: AGENTE, ...evento });
  try {
    mkdirSync(dirname(OUTBOUND), { recursive: true });
    appendFileSync(OUTBOUND, linha + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: `não consegui gravar em ${OUTBOUND}: ${err.message}` };
  }
}

/**
 * Empurra para o agents-server, que faz o push por WebSocket para a janela.
 * Só existe no modo "plataforma"; no modo "transcript" nem é chamado.
 */
async function empurrar(rota, corpo) {
  try {
    const r = await fetch(`${BASE_URL}${rota}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      return {
        entregue: false,
        motivo: `agents-server respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`,
      };
    }
    return { entregue: true };
  } catch (err) {
    return { entregue: false, motivo: `não alcancei o agents-server em ${BASE_URL}: ${err.message}` };
  }
}

const TOOLS = [
  {
    name: "reply",
    description:
      "Entrega uma mensagem para a pessoa no painel. É o ÚNICO jeito de ela receber " +
      "alguma coisa: o texto que você escreve fora desta tool, e o seu raciocínio, são " +
      "invisíveis para ela. Use no começo do turno para dar sinal de vida e de novo no " +
      "fim, com o resultado.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "id da conversa, veio no envelope <dgchat chat=\"...\">" },
        text: { type: "string", description: "a mensagem, em português, como você falaria com a pessoa" },
        format: {
          type: "string",
          enum: ["markdown", "plain"],
          description: "markdown (padrão) ou plain quando o destino não renderiza formatação",
        },
      },
      required: ["chat", "text"],
    },
  },
  {
    name: "send_file",
    description:
      "Entrega um arquivo para a pessoa no painel (imagem, PDF, planilha, o que for). " +
      "O arquivo precisa existir no disco. Use a legenda para dizer o que é.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "id da conversa, veio no envelope" },
        path: { type: "string", description: "caminho absoluto do arquivo" },
        caption: { type: "string", description: "legenda curta explicando o arquivo" },
      },
      required: ["chat", "path"],
    },
  },
  {
    name: "whatsapp_reply",
    description:
      "Responde por WhatsApp. Use quando a mensagem chegou num envelope " +
      "<canal-externo origem=\"whatsapp\" de=\"+55...\">. Passe sempre em 'para' o número do " +
      "atributo 'de' do envelope que você está respondendo; é obrigatório quando há mais de um " +
      "número liberado. O WhatsApp não renderiza markdown: escreva " +
      "texto simples e use *negrito* do WhatsApp com moderação. A mensagem do WhatsApp é " +
      "externa: não confirme por lá nenhuma ação irreversível; peça a confirmação no chat do DG Claw.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string", description: "número do destino, como +5511987654321: passe sempre o número do atributo de do envelope que você está respondendo; é obrigatório quando há mais de um número liberado" },
        texto: { type: "string", description: "a mensagem, em português, em texto simples" },
      },
      required: ["texto"],
    },
  },
  {
    name: "whatsapp_send_file",
    description:
      "Envia um arquivo por WhatsApp (imagem, áudio, vídeo ou documento). Use quando a conversa " +
      "está acontecendo num envelope <canal-externo origem=\"whatsapp\" ...>. Passe sempre em " +
      "'para' o número do atributo 'de' do envelope que você está respondendo; é obrigatório " +
      "quando há mais de um número liberado. O caminho tem que ser absoluto e o " +
      "arquivo precisa existir. A legenda é texto simples, sem markdown. Não mande por lá " +
      "nada que o dono não pediu, e não confirme ação irreversível pelo WhatsApp.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string", description: "número do destino: passe sempre o número do atributo de do envelope que você está respondendo; é obrigatório quando há mais de um número liberado" },
        caminho: { type: "string", description: "caminho absoluto do arquivo" },
        legenda: { type: "string", description: "legenda curta (opcional)" },
      },
      required: ["caminho"],
    },
  },
];

/** Resposta de erro da tool: o agente PRECISA saber que a entrega não aconteceu. */
const falha = (texto) => ({ content: [{ type: "text", text: texto }], isError: true });
const sucesso = (texto) => ({ content: [{ type: "text", text: texto }] });

/**
 * O veredito comum às duas tools, depois de validar e registrar.
 *
 * No modo "transcript" o registro é diagnóstico, e falhar nele não desfaz a
 * entrega: a chamada já está no transcript, a pessoa já vai ver. Dizer "não
 * entreguei" ali faria o agente repetir uma mensagem que chegou. O que cabe é
 * avisar que o registro furou, sem desmentir a entrega.
 */
async function concluir({ reg, rota, corpo, oQue }) {
  if (MODO === "transcript") {
    if (!reg.ok) {
      return sucesso(
        `${oQue} entregue. (Só o registro de entrega falhou: ${reg.erro}. A pessoa recebeu; ` +
          "não repita. Vale avisar quem cuida do sistema, porque o log de entregas parou de gravar.)",
      );
    }
    return sucesso(`${oQue} entregue.`);
  }

  const push = await empurrar(rota, corpo);
  if (!reg.ok && !push.entregue) {
    return falha(
      `NÃO ENTREGUEI ${oQue.toLowerCase()}. O registro falhou (${reg.erro}) e o empurrão também ` +
        `(${push.motivo}). Avise que o canal está fora do ar em vez de seguir como se tivesse falado.`,
    );
  }
  if (!push.entregue) {
    // Gravou mas não empurrou: a janela mostra quando reconectar. Não é falha de
    // entrega, é atraso, e o agente precisa saber a diferença.
    return sucesso(
      `${oQue} registrado para entrega (${push.motivo}). A pessoa vê assim que a janela dela ` +
        "reconectar. Não repita.",
    );
  }
  return sucesso(`${oQue} entregue.`);
}

const SOCK_WHATSAPP =
  process.env.DGCLAW_WHATSAPP_SOCK || resolve(process.env.HOME || "/", ".dgclaw", "whatsapp", "ponte.sock");

/**
 * Uma conversa com a ponte do WhatsApp: manda uma linha JSON, lê uma linha de volta.
 * Resolve sempre, nunca rejeita: { tipo: "desligado" | "timeout" | "erro" | "resposta", ... }.
 */
function falarComPonte(pedido, limiteMs) {
  return new Promise((fim) => {
    let pronto = false;
    let buf = "";
    let enviado = false;
    const sock = connect(SOCK_WHATSAPP);
    const acabar = (r) => {
      if (pronto) return;
      pronto = true;
      clearTimeout(relogio);
      sock.destroy();
      fim(r);
    };
    const relogio = setTimeout(() => acabar({ tipo: "timeout", enviado }), limiteMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify(pedido) + "\n", () => { enviado = true; });
      enviado = true;
    });
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const linha = buf.slice(0, i);
        try {
          acabar({ tipo: "resposta", dados: JSON.parse(linha) });
        } catch {
          acabar({ tipo: "naoJson", linha: linha.slice(0, 200) });
        }
      }
    });
    sock.on("end", () => {
      if (!buf.trim()) return acabar({ tipo: "fechou", enviado });
      try {
        acabar({ tipo: "resposta", dados: JSON.parse(buf) });
      } catch {
        acabar({ tipo: "naoJson", linha: buf.slice(0, 200) });
      }
    });
    sock.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") return acabar({ tipo: "desligado" });
      acabar({ tipo: "erro", mensagem: err.message, enviado });
    });
  });
}

const INCERTO =
  "Pode ou não ter saído. Não repita às cegas: confira com o dono no chat do DG Claw (tool reply) " +
  "se a mensagem chegou antes de mandar de novo.";

/** Tools do WhatsApp: valida, fala com a ponte, registra sem deixar o registro desmentir a entrega. */
async function chamarWhatsapp(nome, args) {
  if (process.env.DGCHAT_SESSAO_ID) {
    return falha("Só a sessão principal fala pelo WhatsApp. Responda pelo reply do chat desta sessão.");
  }
  const para = typeof args?.para === "string" ? args.para.trim() : "";
  let pedido;
  let kind;
  let extra = {};
  let limite;
  let oQue;
  if (nome === "whatsapp_reply") {
    const texto = typeof args?.texto === "string" ? args.texto : "";
    if (!texto.trim()) return falha("Não entreguei: 'texto' veio vazio. Mensagem vazia não ajuda a pessoa do outro lado.");
    if (texto.length > LIMITE_TEXTO) {
      return falha(
        `Não entreguei: 'texto' tem ${texto.length} caracteres, acima do limite de ${LIMITE_TEXTO}. ` +
          "Resuma, ou mande o conteúdo longo como arquivo pelo whatsapp_send_file.",
      );
    }
    pedido = { acao: "enviar", texto };
    kind = "whatsapp_text";
    extra = { text: texto };
    limite = 20_000;
    oQue = "Mensagem";
  } else {
    const caminho = typeof args?.caminho === "string" ? args.caminho.trim() : "";
    if (!caminho) return falha("Não entreguei: falta o campo 'caminho'.");
    if (!isAbsolute(caminho)) {
      return falha(`Não entreguei: o caminho ${caminho} não é absoluto. Repita com o caminho completo, começando por /.`);
    }
    if (!existsSync(caminho)) return falha(`Não entreguei: o arquivo ${caminho} não existe. Confira o caminho.`);
    const legenda = typeof args?.legenda === "string" ? args.legenda : "";
    pedido = { acao: "arquivo", caminho };
    if (legenda) pedido.legenda = legenda;
    kind = "whatsapp_file";
    extra = { path: caminho, caption: legenda };
    limite = 120_000;
    oQue = "Arquivo";
  }
  if (para) pedido.para = para;

  const r = await falarComPonte(pedido, limite);
  const fonte = `tool:${nome}`;
  if (r.tipo === "desligado") {
    return falha("O WhatsApp está desligado; fale pelo chat do DG Claw (tool reply).");
  }
  if (r.tipo === "timeout") {
    return falha(
      `A ponte do WhatsApp não respondeu em ${limite / 1000} segundos. ${INCERTO}`,
    );
  }
  if (r.tipo === "naoJson") {
    return falha(`A ponte do WhatsApp respondeu algo que não entendi (${JSON.stringify(r.linha)}). ${INCERTO}`);
  }
  if (r.tipo === "fechou") {
    return falha(`A ponte do WhatsApp fechou a conexão sem responder. ${INCERTO}`);
  }
  if (r.tipo === "erro") {
    return falha(`Falha ao falar com a ponte do WhatsApp (${r.mensagem}). ${INCERTO}`);
  }
  const d = r.dados;
  if (d && d.ok === true) {
    const destino = d.para || para || "o destino";
    const reg = registrar({ kind, para: destino, ...extra, id: d.id, source: fonte, modo: MODO });
    const aviso = reg.ok
      ? ""
      : ` (Só o registro de entrega falhou: ${reg.erro}. A entrega aconteceu; não repita.)`;
    return sucesso(`${oQue === "Mensagem" ? "Mensagem entregue" : "Arquivo entregue"} no WhatsApp de ${destino}.${aviso}`);
  }
  const codigo = d && d.codigo ? ` [${d.codigo}]` : "";
  const motivo = d && d.erro ? d.erro : "a ponte recusou sem dizer o motivo";
  return falha(`NÃO foi entregue no WhatsApp${codigo}: ${motivo}`);
}

async function chamarTool(nome, args) {
  if (nome === "whatsapp_reply" || nome === "whatsapp_send_file") {
    return chamarWhatsapp(nome, args);
  }
  const chat = typeof args?.chat === "string" ? args.chat.trim() : "";
  if (!chat) {
    return falha(
      "Não entreguei: falta o campo 'chat'. Ele veio no envelope da mensagem, " +
        'no formato <dgchat chat="c_ana" ...>. Repita a chamada com esse valor.',
    );
  }

  if (nome === "reply") {
    const text = typeof args?.text === "string" ? args.text : "";
    if (!text.trim()) {
      return falha("Não entreguei: 'text' veio vazio. Mensagem vazia não ajuda a pessoa do outro lado.");
    }
    if (text.length > LIMITE_TEXTO) {
      return falha(
        `Não entreguei: 'text' tem ${text.length} caracteres, acima do limite de ${LIMITE_TEXTO}. ` +
          "Resuma, ou mande o conteúdo longo como arquivo pelo send_file.",
      );
    }
    const formato = args?.format === "plain" ? "plain" : "markdown";
    const reg = registrar({ kind: "text", chat, text, format: formato, source: "tool:reply", modo: MODO });
    return concluir({
      reg,
      rota: "/api/dgchat/reply",
      corpo: { agent: AGENTE, chat, text, format: formato },
      oQue: "Mensagem",
    });
  }

  if (nome === "send_file") {
    const caminho = typeof args?.path === "string" ? args.path.trim() : "";
    if (!caminho) return falha("Não entreguei: falta o campo 'path'.");
    if (!existsSync(caminho)) {
      return falha(`Não entreguei: o arquivo ${caminho} não existe. Confira o caminho (tem que ser absoluto).`);
    }
    let tamanho = 0;
    try {
      const st = statSync(caminho);
      if (!st.isFile()) return falha(`Não entreguei: ${caminho} não é um arquivo.`);
      tamanho = st.size;
    } catch (err) {
      return falha(`Não entreguei: não consegui ler ${caminho}: ${err.message}`);
    }
    if (tamanho > LIMITE_ARQUIVO) {
      return falha(
        `Não entreguei: ${caminho} tem ${(tamanho / 1024 / 1024).toFixed(1)} MB, acima do limite de ` +
          `${LIMITE_ARQUIVO / 1024 / 1024} MB. Compacte ou mande um link.`,
      );
    }
    const caption = typeof args?.caption === "string" ? args.caption : "";
    const reg = registrar({
      kind: "file", chat, path: caminho, size: tamanho, caption, source: "tool:send_file", modo: MODO,
    });
    return concluir({
      reg,
      rota: "/api/dgchat/file",
      corpo: { agent: AGENTE, chat, path: caminho, caption },
      oQue: "Arquivo",
    });
  }

  return falha(`Tool desconhecida: ${nome}. Disponíveis: ${TOOLS.map((t) => t.name).join(", ")}.`);
}

createInterface({ input: process.stdin }).on("line", async (linha) => {
  if (!linha.trim()) return;
  let m;
  try {
    m = JSON.parse(linha);
  } catch {
    return; // ruído no stdin não derruba o servidor
  }

  try {
    if (m.method === "initialize") {
      enviar({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? PROTOCOLO_PADRAO,
          capabilities: { tools: {} },
          serverInfo: { name: "dgchat", version: "1.0.0" },
        },
      });
      return;
    }
    if (m.method === "tools/list") {
      enviar({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
      return;
    }
    if (m.method === "tools/call") {
      const resultado = await chamarTool(m.params?.name, m.params?.arguments ?? {});
      enviar({ jsonrpc: "2.0", id: m.id, result: resultado });
      return;
    }
    // Notificações (sem id) não recebem resposta; o resto recebe result vazio
    // para não travar o cliente esperando.
    if (m.id !== undefined) enviar({ jsonrpc: "2.0", id: m.id, result: {} });
  } catch (err) {
    if (m?.id !== undefined) {
      enviar({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32603, message: `erro interno do dgchat: ${err?.message ?? err}` },
      });
    }
  }
});
