#!/usr/bin/env python3
"""thread_log.py (DG Claw) — Reconstroi o LOG CANONICO da thread do dono a partir do
transcript (.jsonl) da sessao VIVA da persona.

DUAS ORIGENS, UMA LISTA SO (10/08/2026)
  O dono fala com o agente por dois caminhos, e os dois caem no MESMO transcript:
    - o canal do Telegram, quando ele plugou um bot (<channel source="plugin:telegram...">
      na entrada, tool telegram__reply na saida);
    - o painel do agente, que e o canal PADRAO e nao depende de plugar nada
      (<dgchat ...> na entrada, tool mcp__dgchat__reply na saida).
  Como os dois vivem na mesma sessao, ler o transcript uma vez ja devolve a conversa
  inteira em ordem, sem sincronizar nada e sem migrar dado nenhum. Cada evento sai
  marcado com `via` ("telegram", "plataforma" ou "whatsapp"), pra quem le poder mostrar de onde veio.
  Quem nao plugou Telegram tem so os eventos do painel; plugar depois nao perde nada,
  porque a fonte sempre foi o transcript.

O WHATSAPP (peca 3 do canal, 2026)
  Terceira origem, no mesmo transcript, marcada com `via: "whatsapp"`:
    - ENTRADA: user turn com <canal-externo origem="whatsapp" de="+55..." msg=".." ts="..">
      corpo escapado</canal-externo>. O corpo chega com &amp; &lt; &gt; escapados e aqui
      volta ao texto original. Vira evento do dono (`who` = o numero do atributo `de`).
    - SAIDA: tool cujo nome termina em __whatsapp_reply (input {para?, texto}) ou
      __whatsapp_send_file (input {para?, caminho, legenda?}). No Codex, o item
      McpToolCall do servidor dgchat com tool whatsapp_reply / whatsapp_send_file.
  O valor de `via` e o id curto do canal, o mesmo que o painel usa como chave (CANAIS no
  panel/public/js/app.js). Valor que o painel nao conhece aparece sem etiqueta.
  Vias possiveis hoje: "plataforma", "telegram", "whatsapp". Como o WhatsApp nao tem id de
  conversa do painel, os eventos dele so entram quando `chat` e None (como o Telegram).

Por que existe (requisito da "dieta de contexto" / sono-vigilia):
  O DONO so ve a THREAD do canal (ex.: o chat do Telegram). A persona ve a sessao
  interna, onde pokes de cron (heartbeat/reflexao/proatividade) entram ENTRE a
  pergunta dela e a resposta do dono. Resultado: ela ancora no poke do cron e
  responde "qual post?" a um "pode resumir". Eles nao leem a mesma coisa.
  Este modulo extrai EXATAMENTE o que apareceu no canal do dono, em ordem, marcado
  por origem (dono / persona-direta / persona-cron). A instrucao interna do cron
  ("leia /tmp/dgclaw-poke-... e execute") fica de FORA — ela nunca chegou no canal,
  entao nao pode ser confundida com "o dono disse".

  Esse log entra no CARRY-OVER (working-memory) antes de um restart-com-carry-over
  (auto-compact / reflexao), pra a sessao fresca acordar sabendo a conversa recente.

GENERALIZADO pro contrato DG Claw: ZERO hardcode de persona/paths. Tudo por env DGCLAW_*.

O que conta como mensagem da thread:
  - ENTRADA (dono), pelo Telegram: user turn cujo conteudo comeca com
        <channel source="plugin:telegram:telegram" ... user="..."> texto </channel>
    (chega com isMeta=True — NAO pular por isMeta).
  - ENTRADA (dono), pelo painel: user turn cujo conteudo tem o envelope
        <dgchat from="..." chat="..." msg="..." ts="..."> texto </dgchat>
    (datilografado na sessao viva por quem serve o painel).
  - SAIDA (persona): assistant tool_use cujo nome casa um dos *send hints*
    (telegram__reply/send/... e mcp__dgchat__reply/send_file), com input.text.
    Atribuida a "persona-cron" se o gatilho mais recente foi um poke de cron, ou
    "persona-direta" se foi msg do dono.

O que NAO conta (fica fora da thread):
  - Poke de cron: user turn "leia /tmp/dgclaw-poke-<slug>-<tag>-... e execute" — so
    muda o gatilho corrente (pra atribuir as saidas seguintes como persona-cron).
  - Recado que o SISTEMA escreveu como se fosse user turn ("Stop hook feedback",
    "[Request interrupted", "Caveat:", a cobranca "STOP BLOQUEADO"). Contar isso como
    instrucao interna faria a resposta que vem LOGO DEPOIS aparecer como "a persona
    falou sozinha", quando ela e a resposta ao dono.
  - thinking, tool_result, edits, /compact, etc.

Env:
  DGCLAW_WORKSPACE        raiz do workspace da persona (p/ derivar o session dir).
  DGCLAW_SESSION_DIR      override do dir dos transcripts .jsonl. Default:
                            ~/.claude/projects/<workspace com '/' -> '-'>.
  DGCLAW_CHANNEL_SOURCE   marca do canal no <channel source="...">. Default
                            "plugin:telegram:telegram".
  DGCLAW_SEND_TOOL_HINTS  CSV de substrings que identificam a tool de envio da persona.
                            Default cobre o plugin oficial de Telegram E a tool do painel.
  DGCLAW_OWNER            nome de exibicao do dono quando o <channel> nao traz user=.
                            Default "Dono".

Uso (CLI):
  thread_log.py --session <customTitle> [--last 14] [--format md|json] [--chat <id>]
  thread_log.py --jsonl /path/sessao.jsonl --last 14

Como modulo:
  import thread_log; events = thread_log.build_thread_log(path, last=14)
  md = thread_log.format_md(events)
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def _env(name, default=""):
    return os.environ.get(name, default)


def resolve_session_dir() -> Path:
    """Dir dos transcripts .jsonl. Mesma convencao do inject.py/auto-compact.py:
    DGCLAW_SESSION_DIR, ou ~/.claude/projects/<workspace com '/' -> '-'>."""
    override = _env("DGCLAW_SESSION_DIR")
    if override:
        return Path(override).resolve()
    ws = Path(_env("DGCLAW_WORKSPACE") or os.getcwd()).resolve()
    encoded = str(ws).replace("/", "-")
    return Path.home() / ".claude" / "projects" / encoded


def _channel_source() -> str:
    return _env("DGCLAW_CHANNEL_SOURCE") or "plugin:telegram:telegram"


def _send_tool_hints() -> tuple:
    raw = _env("DGCLAW_SEND_TOOL_HINTS")
    if raw:
        hints = tuple(h.strip() for h in raw.split(",") if h.strip())
        if hints:
            return hints
    # default: o plugin oficial de Telegram (reply/send/edit que de fato mandam texto).
    # As tools do painel (__dgchat__*) sao tratadas a parte, em _DGCHAT_TOOLS, porque
    # elas tambem carregam o id da conversa e o caso de arquivo.
    return ("telegram__reply", "telegram__send", "telegram_reply",
            "telegram_send_message", "telegram__send_message")


def _owner_name() -> str:
    return _env("DGCLAW_OWNER") or "Dono"


# poke interno de cron (NAO e mensagem do canal). Casa o caminho do poke file gerado
# por _lib/inject.sh: /tmp/dgclaw-poke-<slug>-<tag>-<YYYYMMDD>-<HHMMSS>.txt
_POKE_RE = re.compile(r'/tmp/dgclaw-poke-([a-zA-Z0-9_.-]+?)-\d{8}-\d{6}\.txt')
_CHANNEL_OPEN = re.compile(r'^<channel\b[^>]*>', re.S)
_CHANNEL_USER = re.compile(r'\buser="([^"]*)"')

# ─── o canal do painel (<dgchat ...>) ─────────────────────────────────────────
# Formato definido em apps/agents-server/src/dgchat/envelope.ts, que e a FONTE da
# verdade: tres consumidores dependem dele (o agente, o hook de cobranca e este
# extrator). Mudar la sem mudar aqui cega este leitor em silencio.
_DGCHAT_OPEN = re.compile(r'<dgchat\b[^>]*>', re.S)
_DGCHAT_ATTR = re.compile(r'\b(from|chat|msg|ts)="([^"]*)"')
_DGCHAT_CLOSE = "</dgchat>"

# Tools do painel. O nome no transcript vem prefixado pelo servidor MCP
# ("mcp__dgchat__reply"), entao casamos pelo SUFIXO — assim um prefixo diferente
# num host diferente nao quebra a leitura.
_DGCHAT_TOOL_TEXTO = "__dgchat__reply"
_DGCHAT_TOOL_ARQUIVO = "__dgchat__send_file"
_WA_TOOL_TEXTO = "__whatsapp_reply"
_WA_TOOL_ARQUIVO = "__whatsapp_send_file"

# O canal do WhatsApp: <canal-externo origem="whatsapp" de=".." msg=".." ts="..">corpo escapado</canal-externo>
_EXTERNO_OPEN = re.compile(r'^<canal-externo\b([^>]*)>')
_EXTERNO_ATTR = re.compile(r'\b(origem|de|msg|ts)="([^"]*)"')
_EXTERNO_CLOSE = re.compile(r'</canal-externo>\s*$')

# Recado do SISTEMA que chega como user turn e nao e nem dono nem instrucao nossa.
_RETORNO_DO_SISTEMA = re.compile(
    r'^(stop hook feedback|\[request interrupted|caveat: the messages below)', re.I)
_COBRANCA_DA_TRAVA = "STOP BLOQUEADO"


def _parse_dgchat(text):
    """Se o turno carrega um envelope <dgchat ...>, devolve (attrs, texto_interno).
    Senao None. Tolerante de proposito: o envelope e datilografado no TUI e pode
    chegar com espaco em volta ou quebra de linha depois da tag."""
    m = _DGCHAT_OPEN.search(text)
    if not m:
        return None
    attrs = {k: v for k, v in _DGCHAT_ATTR.findall(m.group(0))}
    if not attrs.get("chat"):
        # Sem `chat` o envelope e invalido: nao da pra dizer de qual conversa e.
        return None
    inner = text[m.end():]
    fim = inner.rfind(_DGCHAT_CLOSE)
    if fim >= 0:
        inner = inner[:fim]
    # desfaz o escape do corpo (quem digita "</dgchat>" nao fecha o envelope)
    inner = inner.replace(r"<\/dgchat>", _DGCHAT_CLOSE).strip()
    return attrs, inner


def _desescapa(t):
    """Desfaz o escape do corpo: &lt; e &gt; antes de &amp; (senao &amp;lt; viraria <)."""
    return t.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def _parse_canal_externo(text):
    """<canal-externo origem="whatsapp" ...>corpo</canal-externo> -> (attrs, corpo desescapado).
    Origem diferente de whatsapp (ou envelope sem abertura) -> None."""
    t = text.strip()
    m = _EXTERNO_OPEN.match(t)
    if not m:
        return None
    attrs = {k: v for k, v in _EXTERNO_ATTR.findall(m.group(1))}
    if attrs.get("origem") != "whatsapp":
        return None
    inner = _EXTERNO_CLOSE.sub("", t[m.end():])
    return attrs, _desescapa(inner).strip()


def find_session(label, session_dir: Path = None):
    """O .jsonl da sessao channels VIVA, identificada por customTitle (NAO por mtime:
    outro arquivo pode ter mtime mais novo e mascarar a sessao real)."""
    session_dir = session_dir or resolve_session_dir()
    if not session_dir.exists():
        return None
    files = sorted(session_dir.glob("*.jsonl"),
                   key=lambda f: f.stat().st_mtime, reverse=True)
    for p in files[:120]:
        try:
            with p.open() as f:
                for i, line in enumerate(f):
                    if i > 5:
                        break
                    try:
                        if json.loads(line).get("customTitle") == label:
                            return str(p)
                    except Exception:
                        continue
        except Exception:
            continue
    return None


def _text_blocks(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
        return "\n".join(out)
    return ""


def _parse_incoming(text, channel_source, owner):
    """Se for um <channel source="<channel_source>" ...>...</channel>, devolve
    (user, inner_text). Senao None."""
    if channel_source not in text[:240]:
        return None
    m = _CHANNEL_OPEN.match(text.strip())
    if not m:
        return None
    user = owner
    um = _CHANNEL_USER.search(m.group(0))
    if um and um.group(1):
        user = um.group(1)
    inner = text.strip()[m.end():]
    inner = re.sub(r'</channel>\s*$', '', inner).strip()
    return user, inner


# ─── o motor Codex (rollout) ──────────────────────────────────────────────────
# O Codex nao grava o transcript do Claude: grava um "rollout"
# (<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<data>-<sessionId>.jsonl), uma linha JSON por
# registro com `timestamp`, `type` e `payload`. A conversa sai assim:
#   - fala do dono: mensagem `user` com o envelope <dgchat ...> ou <canal-externo origem="whatsapp">;
#   - fala do agente: o registro event_msg/item_completed com item McpToolCall do servidor
#     "dgchat" (tool reply = texto, send_file = arquivo; whatsapp_reply / whatsapp_send_file valem como
#     tools de envio, com via "whatsapp"). O Codex chama a tool por dentro de
#     um `exec`, entao nao existe um function_call com o nome dela;
#   - duplicata, POR TURNO (do envelope do dono ao proximo): se o turno chamou reply/send_file,
#     so elas contam; se nao chamou nenhuma, vale a ULTIMA mensagem do assistente (o texto
#     final), que so aparece quando o turno acaba (task_complete, task_aborted, turn_aborted)
#     ou quando o turno seguinte comeca, para nao mostrar rascunho. Rollout sem nenhum
#     sinal de turno mostra a ultima fala mesmo assim;
#   - some: contexto injetado (AGENTS.md, environment_context...), user sem envelope que
#     comece com <plataforma, texto final de turno de rotina e linha truncada no fim.
_ROLLOUT_CONTEXTO = ("<environment_context>", "<user_instructions>", "# AGENTS.md")
_ROLLOUT_FIM_DE_TURNO = ("task_complete", "task_aborted", "turn_aborted")
_ROLLOUT_TOOLS = {"reply": False, "send_file": True,
                   "whatsapp_reply": False, "whatsapp_send_file": True}  # tool -> e arquivo?
_ROLLOUT_TOOLS_WA = ("whatsapp_reply", "whatsapp_send_file")


def _is_rollout(path) -> bool:
    nome = os.path.basename(str(path))
    return nome.startswith("rollout-") and nome.endswith(".jsonl")


def _rollout_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content
                       if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def _rollout_dentro_da_casa(jsonl_path) -> bool:
    """O realpath do rollout precisa cair dentro de realpath($HOME): atalho plantado
    para fora da casa do agente e recusado, com aviso, e nada e lido."""
    try:
        casa = Path.home().resolve()
        real = Path(jsonl_path).resolve(strict=True)
    except (OSError, RuntimeError) as e:
        sys.stderr.write(f"[thread_log] recusei o registro Codex {jsonl_path}: nao consegui resolver o "
                         f"caminho real ({e}); nada foi lido\n")
        return False
    if real == casa or casa in real.parents:
        return True
    sys.stderr.write(f"[thread_log] recusei o registro Codex {jsonl_path}: o atalho aponta para {real}, "
                     f"fora de {casa}; nada foi lido\n")
    return False


def _build_rollout_log(jsonl_path, last=14, chat=None):
    if not _rollout_dentro_da_casa(jsonl_path):
        return []
    owner = _owner_name()
    events = []
    seen_msgs = set()
    turno = None            # dict(dono, cron, tem_chamada, final)
    chat_corrente = ""
    tem_sinal = False       # o rollout avisa quando o turno acaba?

    def solta_final():
        nonlocal turno
        if not turno or not turno["final"]:
            return
        ts, texto = turno["final"]
        turno["final"] = None
        if turno["dono"] and not turno["tem_chamada"]:
            events.append({"origin": "persona-direct", "who": "persona", "text": texto,
                           "ts": ts, "via": "plataforma", "tipo": "texto",
                           "chat": chat_corrente})

    def abre_turno(dono, cron):
        nonlocal turno
        solta_final()
        turno = {"dono": dono, "cron": cron, "tem_chamada": False, "final": None}

    try:
        f = open(jsonl_path)
    except Exception:
        return []
    with f:
        for line in f:
            # o session_meta e o world_state sao gigantes e nao interessam
            if '"type":"response_item"' not in line[:200] and '"type":"event_msg"' not in line[:200]:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue  # linha truncada (o CLI esta escrevendo agora) nao derruba a leitura
            p = o.get("payload")
            if not isinstance(p, dict):
                continue
            ts = (o.get("timestamp") or "")[:19]
            typ = o.get("type")

            if typ == "event_msg":
                pt = p.get("type")
                if pt == "task_started":
                    tem_sinal = True
                elif pt in _ROLLOUT_FIM_DE_TURNO:
                    tem_sinal = True
                    solta_final()
                elif pt == "item_completed":
                    it = p.get("item")
                    if not isinstance(it, dict) or it.get("type") != "McpToolCall":
                        continue
                    if str(it.get("server", "")).lower() != "dgchat":
                        continue
                    tool = it.get("tool")
                    if tool not in _ROLLOUT_TOOLS:
                        continue
                    if it.get("status") and it.get("status") != "completed":
                        continue  # a entrega falhou: nao chegou a pessoa
                    args = it.get("arguments")
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except Exception:
                            args = {}
                    if not isinstance(args, dict):
                        args = {}
                    if turno:
                        turno["tem_chamada"] = True
                    origin = "persona-cron" if (turno and turno["cron"]) else "persona-direct"
                    if tool in _ROLLOUT_TOOLS_WA:
                        if chat is not None:
                            continue  # o WhatsApp nao pertence a conversa nenhuma do painel
                        if tool == "whatsapp_reply":
                            texto = args.get("texto") or ""
                            if not isinstance(texto, str) or not texto.strip():
                                continue
                            events.append({"origin": origin, "who": "persona", "text": texto.strip(),
                                           "ts": ts, "via": "whatsapp", "tipo": "texto"})
                        else:
                            arquivo = (args.get("caminho") or "").strip()
                            if not arquivo:
                                continue
                            legenda = (args.get("legenda") or "").strip()
                            events.append({"origin": origin, "who": "persona",
                                           "text": legenda or f"[arquivo: {arquivo.rsplit('/', 1)[-1]}]",
                                           "ts": ts, "via": "whatsapp", "tipo": "arquivo",
                                           "arquivo": arquivo})
                        continue
                    chat_do_bloco = args.get("chat") or chat_corrente
                    if chat is not None and chat_do_bloco != chat:
                        continue
                    if not _ROLLOUT_TOOLS[tool]:
                        texto = args.get("text") or ""
                        if not isinstance(texto, str) or not texto.strip():
                            continue
                        events.append({"origin": origin, "who": "persona", "text": texto.strip(),
                                       "ts": ts, "via": "plataforma", "tipo": "texto",
                                       "chat": chat_do_bloco})
                    else:
                        arquivo = (args.get("path") or "").strip()
                        if not arquivo:
                            continue
                        legenda = (args.get("caption") or "").strip()
                        events.append({"origin": origin, "who": "persona",
                                       "text": legenda or f"[arquivo: {arquivo.rsplit('/', 1)[-1]}]",
                                       "ts": ts, "via": "plataforma", "tipo": "arquivo",
                                       "chat": chat_do_bloco, "arquivo": arquivo})
                continue

            if typ != "response_item" or p.get("type") != "message":
                continue
            txt = _rollout_text(p.get("content")).strip()
            if not txt:
                continue
            role = p.get("role")
            if role == "user":
                if txt.startswith(_ROLLOUT_CONTEXTO):
                    continue
                dg = _parse_dgchat(txt)
                if dg:
                    attrs, inner = dg
                    chat_corrente = attrs["chat"]
                    abre_turno(chat is None or attrs["chat"] == chat, False)
                    msg_id = attrs.get("msg")
                    if msg_id:
                        if msg_id in seen_msgs:
                            continue
                        seen_msgs.add(msg_id)
                    if inner and (chat is None or attrs["chat"] == chat):
                        events.append({"origin": "owner", "who": attrs.get("from") or owner,
                                       "text": inner, "ts": ts, "via": "plataforma",
                                       "tipo": "texto", "chat": attrs["chat"]})
                elif _parse_canal_externo(txt):
                    attrs, inner = _parse_canal_externo(txt)
                    abre_turno(True, False)
                    msg_id = attrs.get("msg")
                    if msg_id:
                        if "wa:" + msg_id in seen_msgs:
                            continue
                        seen_msgs.add("wa:" + msg_id)
                    if inner and chat is None:
                        events.append({"origin": "owner", "who": attrs.get("de") or owner,
                                       "text": inner, "ts": ts, "via": "whatsapp", "tipo": "texto"})
                elif txt.startswith("<plataforma ") or _POKE_RE.search(txt):
                    abre_turno(False, True)
            elif role == "assistant":
                if not turno or not turno["dono"] or p.get("phase") == "commentary":
                    continue
                turno["final"] = (ts, txt)

    if not tem_sinal:
        solta_final()
    return events[-last:] if last else events


def _wa_ids_com_erro(jsonl_path):
    """Ids dos tool_use do WhatsApp cujo tool_result veio com is_error true (WhatsApp desligado,
    destino fora da lista). O transcript e relido inteiro a cada chamada, entao uma passada previa
    juntando os ids basta: o tool_result sempre vem DEPOIS do tool_use no arquivo."""
    ids = set()
    try:
        f = open(jsonl_path)
    except Exception:
        return ids
    with f:
        for line in f:
            if '"tool_result"' not in line or '"is_error"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            cont = (o.get("message", {}) or {}).get("content")
            if not isinstance(cont, list):
                continue
            for b in cont:
                if (isinstance(b, dict) and b.get("type") == "tool_result"
                        and b.get("is_error") is True and b.get("tool_use_id")):
                    ids.add(b["tool_use_id"])
    return ids


def build_thread_log(jsonl_path, last=14, chat=None):
    """Le o transcript e devolve a lista de eventos da thread do dono, em ordem de
    arquivo (= ordem real), misturando o Telegram e o painel.

    Cada evento: dict(origin, who, text, ts, via, tipo[, chat, arquivo]).
      origin in {'owner','persona-direct','persona-cron'}
      via    in {'telegram','plataforma','whatsapp'}
      tipo   in {'texto','arquivo'}

    `chat` filtra por conversa (so faz sentido no canal do painel, que carrega o id).
    Os campos `via`/`tipo`/`chat` sao ADITIVOS: quem so lia origin/who/text/ts (o
    auto-compact e o inject-telegram-thread) continua funcionando sem mudar nada.
    """
    if _is_rollout(jsonl_path):
        return _build_rollout_log(jsonl_path, last, chat)
    channel_source = _channel_source()
    send_hints = _send_tool_hints()
    owner = _owner_name()

    events = []
    last_trigger = "owner"  # gatilho corrente: 'owner' ou 'cron:<tag>'
    chat_corrente = ""      # ultimo chat visto, pra atribuir a saida que nao repete o id
    seen_wa = set()         # ids de mensagem do WhatsApp ja vistos (entrega repetida)
    wa_com_erro = _wa_ids_com_erro(jsonl_path)  # envios do WhatsApp que a tool recusou
    try:
        f = open(jsonl_path)
    except Exception:
        return []
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue  # linha truncada (transcript sendo escrito agora) nao derruba a leitura
            typ = o.get("type")
            ts = (o.get("timestamp") or "")[:19]
            m = o.get("message", {}) or {}
            cont = m.get("content")

            if typ == "user":
                # NAO pular por isMeta: as mensagens REAIS do dono via canal chegam
                # como user turn com isMeta=True (o <channel ...>). Os pokes de cron
                # NAO sao meta. Turns que nao casam channel/dgchat/poke caem no
                # ignore natural.
                txt = _text_blocks(cont).strip()
                if not txt:
                    continue
                # Recado do sistema: nao e dono nem instrucao nossa, entao NAO pode
                # mexer no gatilho (senao a resposta seguinte vira "falou sozinha").
                if _RETORNO_DO_SISTEMA.match(txt) or _COBRANCA_DA_TRAVA in txt:
                    continue
                pk = _POKE_RE.search(txt)
                if pk:
                    last_trigger = f"cron:{pk.group(1)}"
                    continue  # poke interno: NAO entra na thread

                dg = _parse_dgchat(txt)
                if dg:
                    attrs, inner = dg
                    last_trigger = "owner"
                    chat_corrente = attrs["chat"]
                    if inner and (chat is None or attrs["chat"] == chat):
                        events.append({
                            "origin": "owner", "who": attrs.get("from") or owner,
                            "text": inner, "ts": ts,
                            "via": "plataforma", "tipo": "texto",
                            "chat": attrs["chat"],
                        })
                    continue

                ce = _parse_canal_externo(txt)
                if ce:
                    attrs, inner = ce
                    last_trigger = "owner"
                    msg_id = attrs.get("msg")
                    if msg_id:
                        if "wa:" + msg_id in seen_wa:
                            continue
                        seen_wa.add("wa:" + msg_id)
                    if inner and chat is None:
                        events.append({"origin": "owner", "who": attrs.get("de") or owner,
                                       "text": inner, "ts": ts, "via": "whatsapp", "tipo": "texto"})
                    continue

                inc = _parse_incoming(txt, channel_source, owner)
                if inc:
                    user, inner = inc
                    last_trigger = "owner"
                    if inner and chat is None:
                        events.append({"origin": "owner", "who": user,
                                       "text": inner, "ts": ts,
                                       "via": "telegram", "tipo": "texto"})
                # outros user-text (raros) sao ignorados na thread canonica

            elif typ == "assistant" and isinstance(cont, list):
                for b in cont:
                    if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                        continue
                    name = b.get("name", "") or ""
                    inp = b.get("input", {}) or {}
                    origin = ("persona-cron" if last_trigger.startswith("cron")
                              else "persona-direct")

                    if name.endswith(_DGCHAT_TOOL_TEXTO) or name.endswith(_DGCHAT_TOOL_ARQUIVO):
                        chat_do_bloco = inp.get("chat") or chat_corrente
                        if chat is not None and chat_do_bloco != chat:
                            continue
                        if name.endswith(_DGCHAT_TOOL_TEXTO):
                            text = inp.get("text") or ""
                            if not isinstance(text, str) or not text.strip():
                                continue
                            events.append({"origin": origin, "who": "persona",
                                           "text": text.strip(), "ts": ts,
                                           "via": "plataforma", "tipo": "texto",
                                           "chat": chat_do_bloco})
                        else:
                            arquivo = (inp.get("path") or "").strip()
                            if not arquivo:
                                continue
                            legenda = (inp.get("caption") or "").strip()
                            events.append({
                                "origin": origin, "who": "persona",
                                "text": legenda or f"[arquivo: {arquivo.rsplit('/', 1)[-1]}]",
                                "ts": ts, "via": "plataforma", "tipo": "arquivo",
                                "chat": chat_do_bloco, "arquivo": arquivo,
                            })
                        continue

                    if name.endswith(_WA_TOOL_TEXTO) or name.endswith(_WA_TOOL_ARQUIVO):
                        if chat is not None:
                            continue  # o WhatsApp nao pertence a conversa nenhuma do painel
                        if b.get("id") in wa_com_erro:
                            continue  # tool_result is_error: nada foi entregue no WhatsApp
                        if name.endswith(_WA_TOOL_TEXTO):
                            text = inp.get("texto") or ""
                            if not isinstance(text, str) or not text.strip():
                                continue
                            events.append({"origin": origin, "who": "persona",
                                           "text": text.strip(), "ts": ts,
                                           "via": "whatsapp", "tipo": "texto"})
                        else:
                            arquivo = (inp.get("caminho") or "").strip()
                            if not arquivo:
                                continue
                            legenda = (inp.get("legenda") or "").strip()
                            events.append({"origin": origin, "who": "persona",
                                           "text": legenda or f"[arquivo: {arquivo.rsplit('/', 1)[-1]}]",
                                           "ts": ts, "via": "whatsapp", "tipo": "arquivo",
                                           "arquivo": arquivo})
                        continue

                    if not any(h in name for h in send_hints):
                        continue
                    if chat is not None:
                        continue  # saida do Telegram nao pertence a conversa nenhuma do painel
                    text = inp.get("text") or inp.get("message") or ""
                    if not isinstance(text, str) or not text.strip():
                        continue
                    events.append({"origin": origin, "who": "persona",
                                   "text": text.strip(), "ts": ts,
                                   "via": "telegram", "tipo": "texto"})

    return events[-last:] if last else events


def _hhmm_local(ts):
    """ts e UTC (ex '2026-06-30T13:51:33'). Devolve HH:MM no fuso LOCAL do host
    (respeita TZ do ambiente — o DG Claw seta TZ no .service)."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "")).replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime("%H:%M")
    except Exception:
        return ts[11:16]


def format_md(events, max_chars=320):
    """Render compacto pro contexto/carry-over. Pouco token, alta densidade.
    Horarios convertidos pro fuso local (o transcript guarda UTC)."""
    owner = _owner_name()
    label = {"owner": f"👤 {owner}", "persona-direct": "🤖 (eu)",
             "persona-cron": "🤖 (eu, via cron)"}
    out = []
    for e in events:
        t = e["text"].replace("\n", " ").strip()
        if len(t) > max_chars:
            t = t[:max_chars].rstrip() + "…"
        who = label.get(e["origin"], e["origin"])
        out.append(f"- [{_hhmm_local(e['ts'])}] {who}: {t}")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Log canonico da thread do canal (DG Claw).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--session", help="customTitle da sessao (ex: dgclaw-<slug>)")
    g.add_argument("--jsonl", help="caminho direto do .jsonl")
    ap.add_argument("--last", type=int, default=14)
    ap.add_argument("--chat", default=None,
                    help="filtra pela conversa do painel (ex: c_ana)")
    ap.add_argument("--format", choices=["md", "json"], default="md")
    args = ap.parse_args()

    path = args.jsonl or find_session(args.session)
    if not path:
        print(f"# (sessao nao encontrada: {args.session or args.jsonl})")
        return
    events = build_thread_log(path, args.last, chat=args.chat)
    if args.format == "json":
        print(json.dumps(events, ensure_ascii=False, indent=2))
    else:
        print(format_md(events))


if __name__ == "__main__":
    main()
