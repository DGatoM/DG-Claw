// A porta do runner: HTTP e WebSocket, no mesmo dialeto do bunker-server.
//
// Falar o MESMO protocolo é a decisão central deste trabalho. Quem consome um
// agente hoje (o `agents-server` pelo `bunker-client.ts`, o painel do DG Claw
// pelo `bunkerUrl` do `config.json`, e o `inject.py` das rotinas pelo
// `DGCLAW_BUNKER_URL`) continua falando exatamente o que já fala: muda o
// endereço, não o vocabulário. A alternativa (protocolo novo) obrigaria a mexer
// nos três ao mesmo tempo, e cada um deles é um jeito diferente de deixar um
// cliente sem agente no meio do caminho.
//
// O que este servidor NÃO tem, de propósito: cofre, criação de card, projetos,
// worktrees, board, handoff. Rota que não existe responde 404 com o motivo, e
// não com um 500 genérico.
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Sessao } from "./sessao.js";
import type { GerenteDeSessoes, Recusa } from "./sessoes.js";
import { ultimasMensagens } from "./transcript.js";
import { log } from "./logger.js";
import { carregarTokenDoRunner, exigirTokenDoRunner, verificarClienteWs } from "./autenticacao.js";

const CORPO_MAX = 5 * 1024 * 1024;

function json(res: http.ServerResponse, corpo: unknown, status = 200): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(texto);
}

async function lerCorpo(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let dados = "";
    req.on("data", (pedaco: Buffer) => {
      dados += pedaco.toString();
      if (dados.length > CORPO_MAX) {
        reject(new Error(`corpo acima de ${CORPO_MAX} bytes`));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!dados.trim()) return resolve({});
      try {
        resolve(JSON.parse(dados) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`corpo não é JSON válido: ${err instanceof Error ? err.message : err}`));
      }
    });
    req.on("error", reject);
  });
}

/** O estado de uma sessão como o painel e a API o veem. A paralela leva o campo
 *  extra `sessao`; a principal só o leva quando pedido (`?todas=1`), para a
 *  resposta de sempre continuar idêntica. */
function visao(s: Sessao, comMeta: boolean): Record<string, unknown> {
  if (!comMeta && s.papel === "principal") return s.estado as unknown as Record<string, unknown>;
  return {
    ...s.estado,
    sessao: {
      papel: s.papel,
      tipo: s.tipo,
      chat: s.chat,
      fila: s.tamanhoDaFila(),
      ociosoHaMin: ociosoHaMin(s),
    },
  };
}

function ociosoHaMin(s: Sessao): number {
  return Math.round(((Date.now() - s.ultimaAtividadeEm()) / 60_000) * 100) / 100;
}

function respostaDeRecusa(res: http.ServerResponse, r: Recusa): void {
  json(res, { success: false, error: r.error, howToFix: r.howToFix, code: "SEM_CAPACIDADE" }, 503);
}

export function criarServidor(gerente: GerenteDeSessoes): http.Server {
  const principal = gerente.principal;
  const id = principal.id;
  const slug = principal.slug;
  // Bearer do RUNNER_TOKEN_FILE, lido uma vez aqui (ver autenticacao.ts).
  const credencial = carregarTokenDoRunner();
  const autorizado = exigirTokenDoRunner(credencial);
  const servidor = http.createServer((req, res) => {
    if (!autorizado(req, res)) return;
    const rota = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    const metodo = req.method || "GET";

    const responder = async (): Promise<void> => {
      // --- saúde: sem segredo, para o watchdog e para o `curl` de plantão ---
      if (rota === "/api/saude" || rota === "/saude") {
        const temParalelas = gerente.paralelas().length > 0;
        const cap = temParalelas ? gerente.capacidade() : null;
        json(res, {
          ok: true,
          agente: { id, slug, status: principal.estado.status, ptyVivo: principal.temPtyVivo() },
          sessionId: principal.estado.sessionId,
          ultimaSaidaEm: principal.quandoFalouPorUltimo(),
          // Só aparecem quando há paralelas: sem elas a resposta é a de sempre.
          ...(cap
            ? {
                sessoes: gerente.todas().map((x) => ({
                  id: x.id,
                  tipo: x.tipo ?? "principal",
                  status: x.estado.status,
                  ptyVivo: x.temPtyVivo(),
                  sessionId: x.estado.sessionId,
                })),
                capacidade: { teto: cap.teto, acordadas: cap.acordadas },
              }
            : {}),
        });
        return;
      }

      if (rota === "/api/capacidade" && metodo === "GET") {
        const cap = gerente.capacidade();
        json(res, {
          success: true,
          data: {
            fonte: cap.fonte,
            ...(cap.limiteBytes !== undefined ? { limiteBytes: cap.limiteBytes } : {}),
            ...(cap.usoBytes !== undefined ? { usoBytes: cap.usoBytes } : {}),
            ...(cap.disponivelBytes !== undefined ? { disponivelBytes: cap.disponivelBytes } : {}),
            reservaBytes: cap.reservaBytes,
            porSessaoBytes: cap.porSessaoBytes,
            teto: cap.teto,
            acordadas: cap.acordadas,
            idsAcordadas: cap.idsAcordadas,
            folga: cap.folga,
            pertoDoTeto: cap.pertoDoTeto,
            sessoes: gerente.todas().map((x) => ({
              id: x.id,
              papel: x.papel,
              tipo: x.tipo ?? "principal",
              status: x.estado.status,
              ptyVivo: x.temPtyVivo(),
              ociosoHaMin: ociosoHaMin(x),
              ociosoMinutos: x.ociosoMinutos,
            })),
          },
        });
        return;
      }

      // --- o hook de status, que o próprio agente chama a cada evento ---
      if (rota === "/api/agent-hook" && metodo === "POST") {
        const corpo = await lerCorpo(req).catch(() => ({}));
        const alvo = (corpo as { agentId?: unknown }).agentId;
        const dona = typeof alvo === "string" ? gerente.porId(alvo) : undefined;
        if (!dona) {
          json(res, {
            success: false,
            reason: `agentId ${String(alvo)} não é de nenhuma sessão deste runner`,
          });
          return;
        }
        const r = dona.receberHook(corpo as Parameters<Sessao["receberHook"]>[0]);
        json(res, { success: r.ok, ...(r.motivo ? { reason: r.motivo } : {}) });
        return;
      }

      // --- a lista, que para um runner tem sempre um item ---
      if (rota === "/api/agents" && metodo === "GET") {
        const todas = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("todas") === "1";
        json(res, {
          success: true,
          data: todas ? gerente.todas().map((x) => visao(x, true)) : [principal.estado],
        });
        return;
      }

      if (rota === "/api/agents" && metodo === "POST") {
        // Recusa explícita, e não 404: quem chegou aqui esperava criar um agente,
        // e precisa saber que criar é papel de quem provisiona.
        json(
          res,
          {
            success: false,
            error:
              "Este runner serve UM agente, que já existe. Criar agente é papel de quem provisiona " +
              "(o agents-server, ou o instalador do DG Claw na máquina do cliente): ele escreve o " +
              "descritor e sobe a unidade dgclaw-agent-<slug>.",
            code: "RUNNER_DE_UM_AGENTE",
          },
          405,
        );
        return;
      }

      const casa = rota.match(/^\/api\/agents\/([^/]+)(\/[a-z-]+)?$/);
      if (casa) {
        const pedido = casa[1];
        const acao = casa[2] ?? "";
        const sessao = gerente.porId(pedido);
        if (!sessao) {
          const paralelas = gerente.paralelas();
          json(
            res,
            {
              success: false,
              error:
                `Este runner serve o agente ${id} (${slug})` +
                (paralelas.length ? ` e as sessões paralelas ${paralelas.map((x) => x.id).join(", ")}` : "") +
                `, e o pedido veio para ${pedido}.`,
              howToFix:
                "conferir o bunkerCard do painel e o backend registrado no agents-server: " +
                "cada agente tem o runner dele, numa porta própria",
              code: "AGENTE_DE_OUTRO_RUNNER",
            },
            404,
          );
          return;
        }

        if (acao === "" && metodo === "GET") {
          json(res, { success: true, data: visao(sessao, false) });
          return;
        }

        if (acao === "/input" && metodo === "POST") {
          const corpo = await lerCorpo(req).catch((err: Error) => ({ __erro: err.message }));
          if (typeof (corpo as { __erro?: string }).__erro === "string") {
            json(res, { success: false, error: (corpo as { __erro: string }).__erro }, 400);
            return;
          }
          const texto = (corpo as { text?: unknown }).text;
          if (typeof texto !== "string") {
            json(res, { success: false, error: `Corpo precisa de "text" (string). Recebido: ${typeof texto}` }, 400);
            return;
          }
          const enviar = (corpo as { submit?: boolean }).submit !== false;
          const quandoOcioso = (corpo as { injectWhenIdle?: boolean }).injectWhenIdle === true;

          // A GUARDA DE LOGIN VALE PARA O TURNO, NUNCA PARA A TECLA.
          //
          // Esta rota é a porta de duas coisas que precisam de tratamento
          // OPOSTO quando falta credencial:
          //
          //   - turno de conversa (`submit` verdadeiro, ou `injectWhenIdle`): é
          //     o cliente ou um cron falando. Tem que ser recusado, senão vira
          //     texto digitado numa tela de login e some;
          //   - tecla crua (`submit: false`): é o DONO digitando no terminal do
          //     cartão, e é o único jeito de fazer o login sem ter um terminal na
          //     máquina. Barrar isso trava a única saída — cada tecla virava um
          //     409 que a fachada mostrava como 502, e a pessoa ficava presa numa
          //     tela preta com um número.
          //
          // `submit: false` é o que a fachada do painel manda em cada tecla
          // (entrega-rotas.ts: `digitar(id, tecla, { submit: false })`), e é por
          // isso que ele serve como a distinção: quem manda tecla não está
          // fechando um turno.
          if (enviar || quandoOcioso) {
            const semLogin = sessao.motivoSemLogin();
            if (semLogin) {
              json(
                res,
                {
                  success: false,
                  error: semLogin,
                  howToFix:
                    "Fazer o login da conta deste agente, pelo terminal do cartão ou por " +
                    "lib/login-agente.sh. Depois disso o runner troca a sessão do login por uma " +
                    "limpa sozinho, e a mensagem pode ser reenviada.",
                  code: "SEM_LOGIN",
                },
                409,
              );
              return;
            }
          }

          // Paralela dormindo e um pedido de TURNO: acorda e enfileira. O texto só é
          // guardado depois que a capacidade deixou acordar; recusado, ele não fica
          // em fila nenhuma (quem enviou precisa saber, para reenviar depois).
          if (sessao.papel === "paralela" && !sessao.temPtyVivo() && (enviar || quandoOcioso)) {
            const r = await gerente.acordar(sessao.id, "input recebido");
            if (!r.ok) {
              if ("recusa" in r) respostaDeRecusa(res, r.recusa);
              else json(res, { success: false, error: r.falha, howToFix: "ver o log do runner e tentar POST /api/agents/:id/resume", code: "NAO_ACORDOU" }, 500);
              return;
            }
            sessao.enfileirarQuandoOcioso(texto);
            json(res, { success: true, data: { enfileirado: true, acordando: true } }, 202);
            return;
          }

          if (quandoOcioso) {
            sessao.enfileirarQuandoOcioso(texto);
            json(res, { success: true, data: { enfileirado: true, aguardando: "idle" } }, 202);
            return;
          }
          if (!sessao.temPtyVivo()) {
            // 409 com code NO_PTY, igual ao Bunker. É este código que faz o
            // painel mostrar o botão de acordar em vez de dizer que a
            // plataforma não respondeu, e é por isso que ele não pode virar 503.
            json(
              res,
              {
                success: false,
                error: `O agente ${sessao.slug} não tem terminal vivo agora (status=${sessao.estado.status}), o texto seria descartado em silêncio.`,
                howToFix: "Chamar POST /api/agents/:id/resume (ou /revive) antes de digitar.",
                code: "NO_PTY",
              },
              409,
            );
            return;
          }
          if (enviar) {
            await sessao.digitarEEnviar(texto);
          } else {
            sessao.escrever(texto);
          }
          json(res, { success: true, data: { enviado: true, submit: enviar, chars: texto.length } });
          return;
        }

        if (acao === "/resume" && metodo === "POST") {
          if (sessao.papel === "paralela") {
            const r = await gerente.acordar(sessao.id, "resume pedido por API");
            if (!r.ok) {
              if ("recusa" in r) respostaDeRecusa(res, r.recusa);
              else json(res, { success: false, error: r.falha, howToFix: "ver o log do runner", code: "NAO_ACORDOU" }, 500);
              return;
            }
          } else {
            await sessao.subir("retomar");
          }
          json(res, { success: true, data: visao(sessao, false) });
          return;
        }

        if (acao === "/suspend" && metodo === "POST") {
          if (sessao.papel === "principal") {
            json(
              res,
              {
                success: false,
                error: `A sessão ${sessao.id} é a principal deste agente (a conversa do cliente) e não pode ser suspensa.`,
                howToFix: "suspender só sessões paralelas (ver GET /api/agents?todas=1); a principal fica sempre acordada",
                code: "PRINCIPAL_NAO_SUSPENDE",
              },
              409,
            );
            return;
          }
          sessao.suspender("pedido por API");
          json(res, { success: true, data: visao(sessao, false) });
          return;
        }

        if (acao === "/revive" && metodo === "POST") {
          // Sessão NOVA, guardando a anterior. O painel chama isto quando a
          // conversa não volta; perder o histórico aqui seria perder o trabalho
          // do cliente sem aviso.
          if (sessao.papel === "paralela" && !sessao.temPtyVivo()) {
            const recusa = gerente.verificarCapacidade(sessao);
            if (recusa) {
              respostaDeRecusa(res, recusa);
              return;
            }
          }
          sessao.parar("revive");
          await sessao.subir("nova");
          json(res, { success: true, data: visao(sessao, false) });
          return;
        }

        if (acao === "/remove" && metodo === "DELETE") {
          // Para o PTY e responde. NÃO apaga casa, descritor nem conversa: apagar
          // o trabalho de um cliente por uma chamada de API é exatamente o tipo
          // de coisa que precisa de uma mão humana e de um caminho separado.
          sessao.parar("remove pedido por API");
          json(res, {
            success: true,
            data: { parado: true },
            aviso:
              "O terminal foi encerrado. A casa do agente, o descritor e a conversa continuam no disco, " +
              "e a unidade systemd continua instalada: para desligar de vez, " +
              `systemctl disable --now dgclaw-agent-${slug}`,
          });
          return;
        }

        if (acao === "/conversation" && metodo === "GET") {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          const quantas = Number.parseInt(url.searchParams.get("limit") || "6", 10);
          if (!sessao.estado.sessionId) {
            json(res, { success: true, data: [], aviso: "este agente ainda não tem sessão registrada" });
            return;
          }
          const msgs = ultimasMensagens(
            sessao.estado.sessionId,
            Number.isFinite(quantas) ? quantas : 6,
            sessao.estado.config.envExtra?.CLAUDE_CONFIG_DIR,
          );
          json(res, { success: true, data: msgs ?? [] });
          return;
        }

        json(
          res,
          {
            success: false,
            error: `O runner não tem a rota ${metodo} ${rota}.`,
            howToFix:
              "o runner implementa o que um agente entregue usa: GET /api/agents, GET /api/agents/:id, " +
              "POST /input, POST /resume, POST /revive, POST /suspend (só paralelas), DELETE /remove, " +
              "GET /conversation, GET /api/capacidade, GET /api/saude e POST /api/agent-hook. " +
              "O resto (cofre, worktree, board, handoff) é do Bunker e não existe aqui",
            code: "ROTA_INEXISTENTE",
          },
          404,
        );
        return;
      }

      json(
        res,
        {
          success: false,
          error: `Rota desconhecida: ${metodo} ${rota}`,
          howToFix: `este processo serve só o agente ${slug} (e suas sessões paralelas, se houver); ver GET /api/saude e GET /api/capacidade`,
          code: "ROTA_INEXISTENTE",
        },
        404,
      );
    };

    responder().catch((err: unknown) => {
      const motivo = err instanceof Error ? err.message : String(err);
      log.erro(
        "http",
        `${metodo} ${rota} estourou: ${motivo}`,
        "ver o log acima para o passo que falhou; a resposta 500 já saiu com o motivo",
      );
      json(res, { success: false, error: motivo, code: "ERRO_INTERNO" }, 500);
    });
  });

  // --- WebSocket: o mesmo broadcast do Bunker -------------------------------
  // `/ws` sem parâmetro vê SÓ a principal, como sempre: o painel do cliente não
  // pode receber o terminal dos bastidores. `/ws?sessao=<id>` vê só aquela sessão.
  const wss = new WebSocketServer({ server: servidor, path: "/ws", verifyClient: verificarClienteWs(credencial) });
  const clientes = new Map<WebSocket, string>();

  const paraSessao = (alvo: string, msg: unknown): void => {
    const texto = JSON.stringify(msg);
    for (const [c, dele] of clientes) {
      if (dele === alvo && c.readyState === 1) c.send(texto);
    }
  };

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pedida = url.searchParams.get("sessao");
    const sessao = pedida ? gerente.porId(pedida) : principal;
    if (!sessao) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Este runner não tem a sessão ${pedida}. Sessões servidas: ${gerente.idsAtendidos().join(", ")}.`,
        }),
      );
      ws.close();
      return;
    }
    clientes.set(ws, sessao.id);
    log.info("ws", `cliente conectado (${clientes.size} no total)${sessao === principal ? "" : ` na sessão ${sessao.id}`}`);
    // O socket só-terminal do painel não quer a fotografia inicial, igual ao Bunker.
    const soTerminal = url.searchParams.get("terminal") === "1" || (typeof req.url === "string" && req.url.includes("terminal=1"));
    if (!soTerminal) {
      ws.send(JSON.stringify({ type: "full_sync", agents: [visao(sessao, false)], projects: [] }));
    }
    ws.on("message", (cru) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(cru.toString()) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "mensagem não é JSON válido" }));
        return;
      }
      switch (msg.type) {
        case "ping":
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" }));
          return;
        case "subscribe_output":
        case "unsubscribe_output":
          // Aceitas e ignoradas: cada socket já vê só a sessão dele, e recusar
          // faria o front do painel achar que o socket está quebrado.
          return;
        case "terminal_input":
          if (typeof msg.data === "string") sessao.escrever(msg.data);
          return;
        case "request_terminal_buffer": {
          const tela = sessao.telaInteira();
          ws.send(
            JSON.stringify({
              type: "terminal_buffer",
              agentId: sessao.id,
              data: tela.length ? [tela] : [],
              segments: tela.length ? [{ data: tela }] : [],
            }),
          );
          return;
        }
        default:
          log.debug("ws", `mensagem sem tratamento: ${String(msg.type)}`);
      }
    });
    ws.on("close", () => {
      clientes.delete(ws);
      log.info("ws", `cliente saiu (${clientes.size} restantes)`);
    });
    ws.on("error", (err) => log.aviso("ws", `socket reclamou: ${err.message}`));
  });

  for (const s of gerente.todas()) {
    s.on("estado", () => paraSessao(s.id, { type: "agent_update", agent: visao(s, false) }));
    s.on("terminal", (dados: string, seq: number) =>
      paraSessao(s.id, { type: "terminal_data", agentId: s.id, data: dados, seq }),
    );
  }

  return servidor;
}
