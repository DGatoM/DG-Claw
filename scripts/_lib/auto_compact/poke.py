"""Poke de retomada: fotografa a tarefa em curso e manda a persona continuar depois do compact."""

import json
from datetime import datetime, timezone
from pathlib import Path

from .ambiente import env, log, resolve_logs_dir
from .estado import _modo_seguro, notify_owner
from .injecao import inject_text, rodar_comando_de_host


# ─── poke de retomada (compactou no meio de tarefa) ───────────────────────────
# Compactar (ou reiniciar) no meio de um turno faz a persona acordar MUDA: o dono fica
# esperando uma resposta que nunca vem e precisa repetir o pedido. Caso real: um gestor
# ficou 13h parado depois de um compact. Aqui a gente fotografa o que ela estava fazendo,
# escreve num arquivo e, depois que a compactacao assenta, manda ela ler e retomar.

def resume_poke_enabled() -> bool:
    return (env("DGCLAW_COMPACT_RESUME_POKE", "1") or "1").strip().lower() not in ("0", "off", "no")


def write_resume_poke(workspace: Path, slug: str, snap: dict, ctx: int, dry_run: bool):
    """Escreve o arquivo que a persona vai LER depois da compactacao pra retomar."""
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
    path = resolve_logs_dir(workspace) / f".{slug}-retomada-{stamp}.txt"
    pedido = snap.get("last_user_msg") or "(nao consegui recuperar o pedido do transcript)"
    ultima = snap.get("last_assistant_text") or "(voce nao tinha falado nada ainda sobre isso)"
    # MODO DE SEGURANCA: este recado e digitado na sessao e cita o ultimo pedido ao pe da
    # letra. Se ele for (ou repetir) a mensagem que travou o agente, o recado vira o veneno.
    # O que esta em quarentena nao e citado, e o recado lembra o que nao fazer.
    aviso_seguro = ""
    if _modo_seguro(workspace):
        try:
            import quarentena  # noqa: WPS433  (mora em _lib, ja no sys.path)
            regras = quarentena.carregar(workspace)
        except Exception as e:  # noqa: BLE001  na duvida, nao cita nada
            log(f"poke de retomada: quarentena ilegivel ({e}); nao cito o pedido nem a resposta")
            regras = None
        # A resposta a um pedido em quarentena sai junto: era o agente falando do veneno.
        pedido_fora = regras is None or regras.texto_bloqueado(pedido)
        if pedido_fora:
            pedido = "(fora deste recado: esta em quarentena pelo modo de seguranca)"
        if pedido_fora or regras.texto_bloqueado(ultima):
            ultima = "(fora deste recado: esta em quarentena pelo modo de seguranca)"
        aviso_seguro = """
MODO DE SEGURANCA LIGADO: nao abra nem leia transcripts de conversas anteriores (.jsonl
em ~/.claude/projects), nao abra .dgclaw/quarentena e nao reprocesse audios, anexos ou
transcricoes de antes do reinicio. Retome so o que esta neste recado e na working-memory.
"""
    tools = ", ".join(snap.get("tools") or []) or "(nenhuma registrada)"
    if snap.get("pending_request"):
        estado = ("O dono tinha acabado de te pedir uma coisa e voce AINDA NAO tinha "
                  "comecado a responder quando a compactacao entrou.")
    elif snap.get("pending_tool"):
        estado = (f"Voce estava com a ferramenta {snap['pending_tool']} EM VOO quando a "
                  "compactacao entrou. O resultado dela se perdeu.")
    elif snap.get("busy"):
        estado = ("Voce estava no meio do turno (resultado de ferramenta tinha voltado, "
                  "mas sua resposta nao chegou a sair) quando a compactacao entrou.")
    else:
        estado = ("Seu turno estava fechado, mas voce tinha trabalho rodando em segundo "
                  "plano (lista abaixo). O restart MATOU esse trabalho: o aviso de termino "
                  "nunca vai chegar.")
    bg = snap.get("killed_bg") or []
    if bg:
        linhas = "\n".join(f"  - {t['tipo']}: {t['descricao']}"
                           + (f" ({t['motivo']})" if t.get("motivo") else "") for t in bg)
        estado += f"""

TRABALHO EM SEGUNDO PLANO QUE O RESTART INTERROMPEU:
{linhas}
Confira no disco o que cada um chegou a produzir. O que nao terminou, relance
(subagente de novo com o mesmo objetivo, comando de novo) e entregue o que tinha
prometido ao dono."""

    corpo = f"""[retomada-poscompact] stamp={stamp} contexto_antes={ctx // 1000}k persona={slug}

IDEMPOTENCIA: se voce JA concluiu isto e JA avisou o dono, NAO refaca. Responda so o
que ficou pronto e pare. Antes de repetir qualquer passo, CONFIRA no disco, no log ou
no servico se o trabalho ja foi feito: a compactacao pode ter pego so a sua resposta,
nao a execucao.

Sua sessao foi compactada agora pra aliviar o contexto, que estava em {ctx // 1000}k.
Voce e a MESMA persona, so com a sessao leve.

{estado}

ULTIMO PEDIDO DO DONO:
---
{pedido}
---

A ULTIMA COISA QUE VOCE TINHA FALADO:
---
{ultima}
---

FERRAMENTAS QUE VOCE VINHA USANDO: {tools}
{aviso_seguro}
O QUE FAZER AGORA, NESTA ORDEM:
1. Se a pessoa mandou alguma coisa e AINDA esta esperando resposta, responda ELA
   primeiro, nem que seja uma linha dizendo que voce esta terminando. Recado de
   maquina (este aqui) nao passa na frente de gente esperando.
2. Verifique o que ja ficou pronto antes de repetir qualquer passo.
3. Retome de onde parou e conclua a tarefa.
4. Responda o dono no canal com o resultado, dizendo numa linha que houve compactacao
   no meio (pra ele entender qualquer emenda estranha).
Se o pedido acima nao permitir inferir a tarefa, pergunte curto e direto, uma pergunta
so. Nao invente tarefa que nao esta aqui.
"""
    if dry_run:
        log(f"DRY-RUN — poke de retomada montado ({len(corpo)} chars), NAO escrevi")
        return path
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(corpo)
        log(f"poke de retomada escrito em {path}")
    except Exception as e:
        log(f"falha ao escrever poke de retomada: {e}")
        return None
    return path


def usa_canal_dgchat(workspace=None, transcript=None) -> bool:
    """A persona atende um canal dgchat (agente entregue)?

    Decide pela EXISTENCIA da instalacao do canal, nao pelo rastro no transcript: uma
    persona de canal parada ha tempo pode ter 600 linhas de trabalho sem canal por cima,
    e aí o rastro some e a gente mandaria o poke cru justo onde ele nao pode ir cru.
    O transcript fica so como ultimo recurso, pra install fora do layout padrao."""
    try:
        if workspace:
            ws = Path(workspace)
            if (ws / ".plataforma" / "dgchat.mcp.json").exists():
                return True
            cfg = ws / ".dgclaw" / "panel" / "config.json"
            if cfg.exists():
                try:
                    if (json.loads(cfg.read_text()) or {}).get("chat"):
                        return True
                except Exception:
                    pass  # config.json ilegivel ou invalido: sem o campo "chat", cai na checagem do transcript
    except Exception:
        pass  # workspace inacessivel: idem, a checagem do transcript decide
    try:
        if transcript:
            trecho = "\n".join(Path(transcript).read_text().splitlines()[-600:])
            return "<dgchat " in trecho
    except Exception:
        pass  # transcript ilegivel: sem marca de chat, devolve False abaixo
    return False


def envelope_poke(texto: str, transcript=None, workspace=None) -> str:
    """Embrulha o poke no envelope `<plataforma>` quando a persona roda com o canal
    dgchat (agente entregue tipo Ana / Bento).

    Por que isso importa: nesses agentes o hook `stop-force-reply.py` decide se o turno
    pode fechar olhando o envelope da ultima entrada. Texto CRU e lido como "a pessoa
    falando", e o hook passa a cobrar da persona uma resposta pelo canal para uma
    mensagem que ninguem mandou. Pior: a persona tenta RESPONDER O POKE PARA O CLIENTE.
    Com `<plataforma >` o hook entende que foi recado da maquina e libera. Em card comum
    do Bunker/sessao sem dgchat, o cru esta certo.

    O hook casa por string simples (`PLATFORM_MARKER = "<plataforma "`) e so registra o
    timestamp: nao le `recado`, nao le `tipo`, e nao tem conceito de recibo. Por isso NAO
    incluimos a linha de ack do poker.ts: aquele ack e do ledger do manager-api, e recado
    que nao nasceu la nao tem o que confirmar.
    Controle: DGCLAW_RESUME_POKE_ENVELOPE = auto (default) | plataforma | none."""
    modo = (env("DGCLAW_RESUME_POKE_ENVELOPE", "auto") or "auto").strip().lower()
    if modo in ("none", "0", "off", "cru"):
        return texto
    if modo == "auto" and not usa_canal_dgchat(workspace, transcript):
        return texto
    ts = datetime.now(timezone.utc).isoformat()
    rid = f"retomada-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    limpo = texto.replace("</plataforma>", "<\\/plataforma>")
    return f'<plataforma recado="{rid}" tipo="aviso" ts="{ts}">{limpo}</plataforma>'


def send_resume_poke(slug: str, channel: str, path, dry_run: bool, transcript=None,
                     workspace=None) -> int:
    """Acorda a sessao pra retomar. Tenta o transporte de injecao do plugin
    (tiocsti/tmux/bunker) e, se falhar, o comando do host em DGCLAW_RESUME_POKE_CMD
    ({file} vira o caminho do poke). Em host sem nenhum transporte (TIOCSTI morto, sem
    tmux, sem Bunker) o dono precisa configurar esse comando, senao a persona nao volta
    sozinha e a gente avisa em vez de fingir que deu certo."""
    if not path:
        return 1
    texto = envelope_poke(f"[retomada-poscompact] leia {path} e execute", transcript, workspace)
    rc = inject_text(slug, channel, texto, dry_run)
    if rc == 0:
        log("poke de retomada despachado pela injecao do plugin")
        return 0
    # Se DGCLAW_INJECT_CMD estiver configurada, o inject_text acima JA usou o transporte do
    # host: a env abaixo e so pra quem quer um caminho DIFERENTE pro poke (raro).
    cmd = env("DGCLAW_RESUME_POKE_CMD")
    if cmd and rodar_comando_de_host(cmd, texto, path, dry_run,
                                     "DGCLAW_RESUME_POKE_CMD") == 0:
        return 0
    if not dry_run:
        name = env("DGCLAW_NAME") or slug
        notify_owner(f"auto-compact ({name}): compactei no meio de uma tarefa e NAO consegui "
                     f"acordar a sessao pra retomar (rc={rc}). Ela nao volta sozinha. "
                     f"O que ela estava fazendo esta em {path}")
    return rc or 1
