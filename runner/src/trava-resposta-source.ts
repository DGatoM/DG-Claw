// A trava de resposta, como TEXTO, para ser gravada ao lado do agente e rodar como hook `Stop` do Claude Code.
//
// O defeito que ela cobre: o agente recebe a fala do dono num envelope `<dgchat ...>` (ou, no WhatsApp,
// `<canal-externo ...>`) e escreve a resposta como texto puro no fim do turno, sem chamar a tool de resposta.
// Esse texto fica no terminal e não chega a ninguém (num agente real, 7 de 15 turnos acabaram assim). Quando
// isso acontece, o hook devolve o turno uma vez, pedindo o reenvio pela tool certa.
//
// Substitui, para os agentes Claude, o antigo `stop-force-reply.py` do Bunker, que não existe neste repositório.
//
// Invariantes que não podem ser perdidas numa futura edição:
//   1. SEMPRE sai com código 0. Erro, entrada estranha ou exceção deixam o turno passar.
//   2. Um bug da trava nunca bloqueia o agente: na dúvida, passa.
//   3. Nunca segura o turno por mais de ~4s (cinto de segurança armado antes de qualquer leitura).
//   4. Cobra UMA vez por turno: na segunda parada (`stop_hook_active`) deixa passar, para nunca entrar em laço.
//   5. Nunca grava o conteúdo das mensagens no log (é conversa privada). Os erros são registrados com
//      diagnóstico fixo (nunca com o `message` de uma exceção, que pode trazer trecho da entrada).
//   6. Ao bloquear, o stdout do block sai ANTES do aviso ao runner (StopBloqueado), e o aviso é best-effort.
//
// Só uma chamada que de fato entregou a resposta no canal certo dispensa a cobrança: `<dgchat>` pede
// `reply`/`send_file`; `<canal-externo>` pede `whatsapp_reply`/`whatsapp_send_file`. Chamada com erro não
// conta, exceto o erro de entrega incerta do servidor dgchat ("Pode ou não ter saído"), para não duplicar.
export const TRAVA_RESPOSTA_SOURCE = String.raw`import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

// Cinto de segurança, armado ANTES de qualquer leitura e SEM unref: ele precisa conseguir matar o processo.
setTimeout(() => process.exit(0), 4000);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const agentId = arg("--agent") || "";
const port = parseInt(arg("--port") || "0", 10);
const nonce = arg("--nonce") || "";

const TOOLS_DO_CANAL = {
  dgchat: new Set(["mcp__dgchat__reply", "mcp__dgchat__send_file"]),
  externo: new Set(["mcp__dgchat__whatsapp_reply", "mcp__dgchat__whatsapp_send_file"]),
};
// Texto que o servidor dgchat põe no erro de entrega incerta (scripts/dgchat-mcp/server.mjs, INCERTO).
const ENTREGA_INCERTA = "Pode ou não ter saído";

// Só o nome da classe e o código do erro: o message pode trazer trecho da entrada (conversa privada).
function diagnostico(err) {
  const nome = err && err.constructor && err.constructor.name ? err.constructor.name : "Error";
  return err && typeof err.code === "string" ? nome + " " + err.code : nome;
}
const TETO_TRANSCRIPT = 2 * 1024 * 1024;
const TETO_LOG = 256 * 1024;
const ARQUIVO_LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "trava-resposta.log");

// Uma linha por decisão relevante. Nunca recebe o conteúdo das mensagens.
function registrar(decisao, motivo, fazer) {
  try {
    try {
      if (fs.statSync(ARQUIVO_LOG).size > TETO_LOG) fs.renameSync(ARQUIVO_LOG, ARQUIVO_LOG + ".1");
    } catch { /* ainda não existe: nada a girar */ }
    fs.appendFileSync(ARQUIVO_LOG, new Date().toISOString() + " " + decisao + " | " + motivo + " | " + fazer + "\n");
  } catch {
    // Falha ao gravar o log é ignorada de propósito: o log é só para explicar, e a trava nunca pode
    // atrapalhar o agente por causa dele.
  }
}

// Leitura ASSÍNCRONA com teto próprio: a síncrona travaria o processo se o stdin não fechasse.
function lerStdin(tetoMs) {
  return new Promise((resolve) => {
    let dados = "";
    let feito = false;
    const fim = () => {
      if (feito) return;
      feito = true;
      resolve(dados);
    };
    const t = setTimeout(fim, tetoMs);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { dados += c; });
      process.stdin.on("end", () => { clearTimeout(t); fim(); });
      process.stdin.on("error", () => { clearTimeout(t); fim(); });
    } catch { clearTimeout(t); fim(); }
  });
}

// Só o FINAL do transcript: ele cresce sem parar e a trava só precisa do turno atual.
function lerFinal(caminho) {
  const fd = fs.openSync(caminho, "r");
  try {
    const tamanho = fs.fstatSync(fd).size;
    const inicio = Math.max(0, tamanho - TETO_TRANSCRIPT);
    const buf = Buffer.alloc(tamanho - inicio);
    let lidos = 0;
    while (lidos < buf.length) {
      const n = fs.readSync(fd, buf, lidos, buf.length - lidos, inicio + lidos);
      if (n <= 0) break;
      lidos += n;
    }
    let texto = buf.subarray(0, lidos).toString("utf8");
    if (inicio > 0) {
      const nl = texto.indexOf("\n");
      texto = nl >= 0 ? texto.slice(nl + 1) : "";
    }
    return texto;
  } finally {
    fs.closeSync(fd);
  }
}

function parsear(linha) {
  try { return JSON.parse(linha); } catch { return null; }
}

// O primeiro bloco de texto de uma fala de usuário de verdade; null se for só resultado de tool.
function textoDaFala(e) {
  if (!e || e.type !== "user" || e.isMeta || e.isCompactSummary) return null;
  const c = e.message && e.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    for (const item of c) {
      if (item && item.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  return null;
}

function textoDoResultado(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("\n");
  return "";
}

// A chamada entregou? Sem tool_result achado, conta como entregue (conservador). Com is_error, só conta
// se for a entrega incerta.
function entregou(entradas, depoisDe, id) {
  if (typeof id !== "string") return true;
  for (let j = depoisDe + 1; j < entradas.length; j++) {
    const e = entradas[j];
    if (!e || e.type !== "user") continue;
    for (const b of blocos(e)) {
      if (b && b.type === "tool_result" && b.tool_use_id === id) {
        if (b.is_error !== true) return true;
        return textoDoResultado(b.content).includes(ENTREGA_INCERTA);
      }
    }
  }
  return true;
}

function blocos(e) {
  const c = e && e.message && e.message.content;
  return Array.isArray(c) ? c : [];
}

// Avisa o runner de que o fim de turno foi devolvido (cancela o idle que o Stop do runner-hook agendou).
// Best-effort: uma tentativa, ~1s. Resolve sempre; falha vai para o log e nunca impede o block.
function avisarRunner(ev) {
  return new Promise((resolve) => {
    if (!agentId || !port) {
      registrar("erro", "não avisei o runner do bloqueio: faltou --agent ou --port no comando da trava", "o block saiu igual; reiniciar o agente para regravar o settings");
      resolve();
      return;
    }
    const payload = JSON.stringify({ agentId, nonce, event: "StopBloqueado", sessionId: ev.session_id || null });
    let feito = false;
    const fim = (falha) => {
      if (feito) return;
      feito = true;
      if (falha) registrar("erro", "aviso StopBloqueado ao runner falhou: " + falha, "o block saiu igual; o runner pode marcar o agente como ocioso antes da continuação, sem outro efeito");
      resolve();
    };
    try {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/agent-hook", method: "POST", timeout: 1000,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => { res.resume(); res.on("end", () => fim(res.statusCode && res.statusCode >= 400 ? "HTTP " + res.statusCode : null)); res.on("error", () => fim("erro na resposta")); },
      );
      req.on("error", (err) => fim(diagnostico(err)));
      req.on("timeout", () => { try { req.destroy(); } catch { /* já caiu */ } fim("timeout de 1s"); });
      req.write(payload);
      req.end();
    } catch (err) {
      fim(diagnostico(err));
    }
  });
}

function decidir(ev) {
  const transcript = ev.transcript_path;
  if (typeof transcript !== "string" || !transcript) {
    registrar("erro", "o evento Stop veio sem transcript_path", "nada a fazer: o turno passou sem conferência; se repetir, conferir a versão do Claude Code");
    return null;
  }
  let texto;
  try {
    texto = lerFinal(transcript);
  } catch (err) {
    registrar("erro", "transcript ilegível: " + transcript + ": " + diagnostico(err), "o turno passou sem conferência; conferir se o arquivo existe e se o agente pode lê-lo");
    return null;
  }
  const entradas = texto.split("\n").filter((l) => l.trim()).map(parsear).filter(Boolean);

  // A mensagem que abriu o turno: a última fala de verdade do usuário (tool_result não conta).
  let inicio = -1;
  let fala = "";
  for (let i = entradas.length - 1; i >= 0; i--) {
    const t = textoDaFala(entradas[i]);
    if (t !== null && t.trim()) { inicio = i; fala = t.trimStart(); break; }
  }
  if (inicio < 0) return null;

  let canal = null;
  if (fala.startsWith("<dgchat ")) canal = "dgchat";
  else if (fala.startsWith("<canal-externo ")) canal = "externo";
  if (!canal) return null;

  let temTexto = typeof ev.last_assistant_message === "string" && ev.last_assistant_message.trim() !== "";
  for (let i = inicio + 1; i < entradas.length; i++) {
    const e = entradas[i];
    if (e.type !== "assistant") continue;
    for (const b of blocos(e)) {
      if (b && b.type === "tool_use" && TOOLS_DO_CANAL[canal].has(b.name) && entregou(entradas, i, b.id)) return null;
      if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) temTexto = true;
    }
  }
  // Silêncio deliberado não é o defeito; o defeito é escrever um texto que não chega.
  if (!temTexto) return null;
  return canal;
}

try {
  const stdin = await lerStdin(1000);
  if (!stdin.trim()) {
    registrar("erro", "stdin vazio: o Claude Code não mandou o evento Stop", "o turno passou sem conferência; se repetir, conferir a versão do Claude Code");
  } else {
    let ev = null;
    try { ev = JSON.parse(stdin); } catch (err) {
      registrar("erro", "stdin não é JSON", "o turno passou sem conferência; se repetir, conferir a versão do Claude Code");
    }
    if (ev && typeof ev === "object") {
      if (ev.stop_hook_active === true) {
        registrar("passou-segunda-parada", "segunda parada do mesmo turno: a trava cobra só uma vez, para não entrar em laço", "nada a fazer");
      } else {
        const canal = decidir(ev);
        if (canal) {
          const tool = canal === "dgchat" ? "mcp__dgchat__reply (chat do <dgchat>)" : "mcp__dgchat__whatsapp_reply (número do <canal-externo>)";
          registrar("bloqueou", "turno de " + (canal === "dgchat" ? "<dgchat>" : "<canal-externo>") + " terminou só com texto, sem chamar a tool de resposta", "devolvi o turno uma vez pedindo o reenvio por " + tool);
          process.stdout.write(JSON.stringify({
            decision: "block",
            reason: "Você respondeu só em texto, e o texto do terminal não chega ao usuário. Reenvie a resposta pela tool " + tool + ", com o mesmo conteúdo.",
          }));
          await avisarRunner(ev);
        }
      }
    }
  }
} catch (err) {
  registrar("erro", "exceção inesperada: " + diagnostico(err), "o turno passou sem conferência; avisar quem mantém o DG Claw se repetir");
}
process.exit(0);
`;
