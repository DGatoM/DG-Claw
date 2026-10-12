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
  marcado com `via` ("telegram" ou "plataforma"), pra quem le poder mostrar de onde veio.
  Quem nao plugou Telegram tem so os eventos do painel; plugar depois nao perde nada,
  porque a fonte sempre foi o transcript.

ONDE UM CANAL NOVO SE PLUGA (ex.: WhatsApp) — so documentacao, 01/10/2026
  O painel ja sabe desenhar `via: "whatsapp"` (etiqueta verde no balao, ver CANAIS
  no panel/public/js/app.js). Do lado de ca, um canal novo precisa de tres coisas,
  e nenhuma delas existe ainda:
    1. ENTRADA: reconhecer o envelope do canal no user turn. Hoje so ha um canal
       externo, lido por _parse_incoming() com DGCLAW_CHANNEL_SOURCE; um segundo
       canal pede uma lista de (source, via) em vez de uma string so, e o
       events.append do bloco "inc = _parse_incoming(...)" passa a gravar o `via`
       daquele source, no lugar do "telegram" fixo.
    2. SAIDA: a tool de envio do canal entra em _send_tool_hints(), e o
       events.append do fim do laco (o do `via: "telegram"` fixo) passa a decidir o
       `via` pelo nome da tool que casou.
    3. O valor de `via` e o id curto do canal ("whatsapp"), o mesmo que o painel
       usa como chave. Valor que o painel nao conhece aparece sem etiqueta, como se
       fosse do proprio painel: nada quebra, mas a origem some da tela.

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


def build_thread_log(jsonl_path, last=14, chat=None):
    """Le o transcript e devolve a lista de eventos da thread do dono, em ordem de
    arquivo (= ordem real), misturando o Telegram e o painel.

    Cada evento: dict(origin, who, text, ts, via, tipo[, chat, arquivo]).
      origin in {'owner','persona-direct','persona-cron'}
      via    in {'telegram','plataforma'}
      tipo   in {'texto','arquivo'}

    `chat` filtra por conversa (so faz sentido no canal do painel, que carrega o id).
    Os campos `via`/`tipo`/`chat` sao ADITIVOS: quem so lia origin/who/text/ts (o
    auto-compact e o inject-telegram-thread) continua funcionando sem mudar nada.
    """
    channel_source = _channel_source()
    send_hints = _send_tool_hints()
    owner = _owner_name()

    events = []
    last_trigger = "owner"  # gatilho corrente: 'owner' ou 'cron:<tag>'
    chat_corrente = ""      # ultimo chat visto, pra atribuir a saida que nao repete o id
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
