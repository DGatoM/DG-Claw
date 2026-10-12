#!/usr/bin/env python3
"""reinicio.py (DG Claw) — Reiniciar o agente, do jeito NORMAL ou em MODO DE SEGURANCA.

DOIS REINICIOS, PORQUE SAO DOIS PROBLEMAS
  normal  o agente travou, caiu ou parou de responder sem motivo na conversa. Ele
          volta lembrando de tudo: no runner e no card do Bunker, e a MESMA conversa
          (--resume); no modo classico (claude --channels pelo launch.sh, que nao usa
          --resume) e sessao nova com a memoria e o fio reinjetados pelo
          hooks/session-context.sh.
  seguro  o problema ESTA na conversa. Foi o que aconteceu com a Isa em 30/09/2026: o
          filtro de seguranca da Anthropic cortou uma resposta sobre um tema que parecia
          ciberataque, e toda retomada que reenviava a conversa (ou mandava ela reler o
          transcript morto) devolvia o texto envenenado ao contexto e era cortada de novo.
          Aqui a sessao volta NOVA, sem carregar a conversa anterior (que fica guardada no
          disco), a mensagem que causou o corte vai para a QUARENTENA (guardada, nunca
          reenviada, e o dono e avisado de qual foi), e o agente recebe um recado curto
          dizendo o que houve e pedindo para ele falar com o dono antes de qualquer coisa.

ONDE CADA REINICIO ACONTECE (os tres mundos que o _lib/inject.py conhece)
  bunker (card do Bunker OU runner proprio, DGCLAW_BUNKER_CARD + DGCLAW_BUNKER_URL):
      normal  card caido -> POST /resume. Card de pe -> para o terminal e /resume.
              Para parar, o runner usa DELETE /api/agents/:id/remove (so encerra o PTY)
              e o Bunker usa DELETE /api/agents/:id. ⚠️ NO BUNKER O /remove APAGA O CARD.
              Por isso o runner e IDENTIFICADO antes (GET /api/saude responde com
              `agente.id`, que o Bunker nao tem) e, na duvida, o caminho e o do Bunker.
      seguro  POST /revive (nos dois: sessao nova, a anterior guardada em
              previousSessionId).
      NUNCA systemctl aqui: reiniciar a unidade do runner sobe `claude --resume`, e o
      veneno volta junto. E o watchdog da jaula roda como usuario comum, sem permissao
      de systemctl (119 "restart FALHOU" num agente ate 01/10/2026).
  classico (tiocsti/tmux): `systemctl restart <DGCLAW_SERVICE>` (com `sudo -n` quando
      nao for root). O launch.sh nao usa --resume, entao normal e seguro sobem sessao
      nova; o que separa os dois e o que o session-context.sh reinjeta.

O QUE O MODO DE SEGURANCA GRAVA (tudo dentro de <ws>/.dgclaw/, nada e apagado)
  modo-seguro.json       a marca: motivo, tipo, desde, sessao anterior, cortarDepoisDe.
                         Quem le: hooks/session-context.sh, auto-compact.py, watchdog.py,
                         o painel (/api/saude.modoSeguro).
  quarentena/<stamp>.json a(s) mensagem(ns) que abriram o turno envenenado. Nunca
                         reenviada a ninguem; o dono ve pelo painel qual foi.
  modo-seguro/           o que foi tirado do caminho: o chat-tail.md antigo e o bloco
                         de carry-over da working-memory (que o auto-compact escreve com
                         o fio da conversa, e que podia conter o texto que travou).
  chat-tail.md           REFEITO so com o fio ate cortarDepoisDe. O session-context so o
                         reinjeta com a marca chatTailRefeito=true.

CLI:
  reinicio.py checar [--json]                 pode reiniciar daqui? qual mundo? (rapido)
  reinicio.py normal [--motivo ...] [--origem painel|watchdog|manual] [--json]
  reinicio.py seguro [--motivo ...] [--origem ...] [--json] [--dry-run]
  reinicio.py encerrar-modo-seguro [--json]   arquiva a marca (o agente ja esta bem)
  reinicio.py status [--json]                 a marca atual, sem caminho de servidor

Saida JSON: {"ok": bool, "acao": "...", "frase": "...", "motivo": "...", ...}. Codigo de
saida 0 so quando a acao aconteceu de verdade; "enfileirado" NAO conta como entregue.
"""
import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import inject  # noqa: E402
import saude_sessao  # noqa: E402

try:
    from pulso_lib import pulso_write  # noqa: E402
except Exception as e:  # pragma: no cover - pulso e acessorio, nunca derruba o reinicio
    print(f"[reinicio] pulso_lib indisponivel ({e}); o ledger do Pulso nao vai registrar", file=sys.stderr)

    def pulso_write(*_a, **_k):
        return None


CARRYOVER_START = "<!-- DG-ALIVE-CARRYOVER START (auto-compact) -->"
CARRYOVER_END = "<!-- DG-ALIVE-CARRYOVER END -->"


# ─── contexto ─────────────────────────────────────────────────────────────────

def agora():
    return datetime.now(timezone.utc)


def iso(dt=None):
    return (dt or agora()).isoformat().replace("+00:00", "Z")


def stamp():
    return agora().astimezone().strftime("%Y%m%d-%H%M%S")


def workspace() -> Path:
    return Path(os.environ.get("DGCLAW_WORKSPACE") or os.getcwd()).resolve()


def slug() -> str:
    return os.environ.get("DGCLAW_SLUG") or workspace().name or "agente"


def dgclaw_dir() -> Path:
    return workspace() / ".dgclaw"


def marca_path() -> Path:
    return dgclaw_dir() / "modo-seguro.json"


def log(msg):
    linha = f"[{agora().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')}] {msg}"
    print(linha, file=sys.stderr, flush=True)
    try:
        d = dgclaw_dir() / "logs"
        d.mkdir(parents=True, exist_ok=True)
        with (d / "reinicio.log").open("a") as f:
            f.write(linha + "\n")
    except OSError as e:
        print(f"[reinicio] nao consegui gravar o log em {dgclaw_dir() / 'logs'}: {e}", file=sys.stderr)


def escrever_atomico(p: Path, texto: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(texto)
    tmp.replace(p)


def ler_marca():
    p = marca_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError) as e:
        # Marca ilegivel nao pode virar "nao ha modo de seguranca": e justamente quando
        # ele esta ligado que o hook precisa segurar o fio antigo.
        log(f"modo-seguro.json ilegivel em {p} ({e}); tratando como LIGADO e sem fio refeito")
        return {"ativo": True, "ilegivel": True, "chatTailRefeito": False}


# ─── o mundo ──────────────────────────────────────────────────────────────────

def servico() -> str:
    return os.environ.get("DGCLAW_SERVICE") or f"dgclaw-{slug()}.service"


def eh_runner():
    """O alvo e um agent-runner (mini-Bunker de um agente so)? So ele tem GET
    /api/saude com `agente.id`. Devolve True, False ou None (nao consegui perguntar).
    None NUNCA vira True: o caminho do runner usa uma rota que no Bunker apaga o card."""
    status, corpo = inject._bunker_pedir("/api/saude", timeout=8)
    if status == 0:
        return None
    if status == 200 and isinstance(corpo, dict) and isinstance(corpo.get("agente"), dict):
        return corpo["agente"].get("id") == inject._bunker_card()
    return False


def mundo():
    modo = inject.resolve_mode()
    if modo == "bunker":
        if not inject._bunker_card():
            return {"modo": "bunker", "pode": False,
                    "motivo": "o agente está configurado como card da plataforma, mas sem o id do card",
                    "comoResolver": "Exportar DGCLAW_BUNKER_CARD no .dgclaw/config.sh do agente."}
        card = inject._bunker_estado()
        if card is None:
            return {"modo": "bunker", "pode": False,
                    "motivo": "não consegui falar com a plataforma que hospeda o agente",
                    "comoResolver": "Espere um minuto e tente de novo. Se continuar, a plataforma (ou o runner) está fora do ar."}
        runner = eh_runner()
        return {"modo": "bunker", "pode": True, "runner": runner is True, "card": card}
    return {"modo": modo, "pode": True, "servico": servico()}


def _systemctl(*args):
    cmd = ["systemctl", *args]
    if os.geteuid() != 0:
        cmd = ["sudo", "-n", *cmd]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"{' '.join(cmd)} não rodou: {e}"
    if r.returncode != 0:
        return False, f"{' '.join(cmd)} saiu {r.returncode}: {(r.stderr or r.stdout).strip()[:300]}"
    return True, ""


# ─── esperar a sessao ficar de pe ─────────────────────────────────────────────

def esperar_de_pe(m, sessao_anterior=None, exigir_nova=False, prazo_s=None):
    """Espera a sessao subir. Devolve (ok, card|None, motivo)."""
    prazo_s = prazo_s or int(os.environ.get("DGCLAW_REINICIO_PRAZO_S", "120"))
    fim = time.monotonic() + prazo_s
    if m["modo"] == "bunker":
        ultimo = None
        while time.monotonic() < fim:
            card = inject._bunker_estado()
            if card:
                ultimo = card.get("status")
                nova_ok = (not exigir_nova) or (card.get("sessionId") and card.get("sessionId") != sessao_anterior)
                if card.get("status") in ("idle", "completed") and nova_ok:
                    return True, card, ""
            time.sleep(3)
        return False, None, f"o card não ficou pronto em {prazo_s}s (último estado: {ultimo or 'sem resposta'})"
    while time.monotonic() < fim:
        if inject.is_session_alive(slug()):
            # O TUI demora a aceitar teclado depois que o processo aparece. Digitar
            # antes disso perde as teclas sem erro nenhum.
            time.sleep(int(os.environ.get("DGCLAW_REINICIO_BOOT_S", "20")))
            return True, None, ""
        time.sleep(3)
    return False, None, f"a sessão não voltou em {prazo_s}s"


# ─── reinicio NORMAL ──────────────────────────────────────────────────────────

def reiniciar_normal(motivo="", origem="manual"):
    m = mundo()
    if not m["pode"]:
        return falha("normal", m["motivo"], m.get("comoResolver"))
    log(f"reinicio NORMAL pedido por {origem} ({m['modo']}): {motivo or 'sem motivo informado'}")
    if m["modo"] == "bunker":
        card = m["card"]
        cid = inject._bunker_card()
        vivo = inject._bunker_vivo(card)
        if vivo:
            rota = f"/api/agents/{cid}/remove" if m["runner"] else f"/api/agents/{cid}"
            st, corpo = _pedir_metodo("DELETE", rota)
            if st not in (200, 202):
                return falha("normal", f"não consegui parar o terminal ({rota} respondeu {st}: "
                                       f"{(corpo or {}).get('error') or 'sem detalhe'})",
                             "Tente de novo em alguns segundos.")
            # O resume so e aceito com o terminal parado; o runner recusa subir em
            # cima de um PTY vivo, e responderia "ok" sem fazer nada.
            for _ in range(20):
                c = inject._bunker_estado()
                if c and not inject._bunker_vivo(c):
                    break
                time.sleep(1)
        st, corpo = inject._bunker_pedir(f"/api/agents/{cid}/resume", {})
        if st != 200 or not (corpo or {}).get("success"):
            return falha("normal", f"a plataforma recusou retomar a sessão ({st}: "
                                   f"{(corpo or {}).get('error') or 'sem detalhe'})",
                         "Tente de novo em um minuto. A conversa continua guardada.")
        ok, _c, porque = esperar_de_pe(m)
        pulso_write("reinicio", "ok" if ok else "erro", f"normal ({origem}): {porque or 'de pe'}")
        return {"ok": True, "acao": "normal", "dePe": ok, "mundo": "runner" if m["runner"] else "bunker",
                "frase": "Ele foi reiniciado e volta na mesma conversa." if ok else
                         f"Pedi para ele voltar, mas ainda não confirmei que voltou: {porque}.",
                "motivo": None if ok else porque}
    ok, erro = _systemctl("restart", m["servico"])
    if not ok:
        pulso_write("reinicio", "erro", f"normal ({origem}): {erro}")
        return falha("normal", erro, f"Quem administra a máquina vê o motivo com: systemctl status {m['servico']}")
    pulso_write("reinicio", "ok", f"normal ({origem}): systemctl restart {m['servico']}")
    return {"ok": True, "acao": "normal", "dePe": None, "mundo": "classico",
            "frase": "Ele foi reiniciado. Volta em alguns segundos, com a memória e as últimas mensagens.",
            "motivo": None}


def _pedir_metodo(metodo, rota):
    """inject._bunker_pedir so faz GET/POST. DELETE e so aqui, sem proxy, igual a ele."""
    import urllib.error
    import urllib.request
    url = f"{inject._bunker_url()}{rota}"
    req = urllib.request.Request(url, headers=inject._cabecalho_runner(), method=metodo)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=30) as r:
            bruto, st = r.read().decode("utf-8", "replace"), r.status
    except urllib.error.HTTPError as e:
        bruto, st = e.read().decode("utf-8", "replace"), e.code
    except Exception as e:
        log(f"{metodo} {url} falhou: {e}")
        return 0, None
    try:
        return st, json.loads(bruto)
    except ValueError:
        return st, None


def falha(acao, motivo, como=None):
    log(f"reinicio {acao} FALHOU: {motivo}")
    return {"ok": False, "acao": acao, "frase": f"Não consegui reiniciar: {motivo}.",
            "motivo": motivo, "comoResolver": como}


# ─── MODO DE SEGURANCA ────────────────────────────────────────────────────────

def _parse_ts(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def separar_fio(transcript, corte_iso):
    """O fio da conversa (thread_log) dividido no ponto de corte: (seguro, quarentena).
    corte None = nada desta sessao e seguro (no segundo corte da Isa, a sessao inteira
    nasceu do poke que mandou reler o veneno)."""
    import thread_log
    if not transcript or not os.path.exists(transcript):
        return [], []
    eventos = thread_log.build_thread_log(transcript, last=0)
    corte = _parse_ts(corte_iso)
    seguro, depois = [], []
    for e in eventos:
        t = _parse_ts((e.get("ts") or "") + ("" if (e.get("ts") or "").endswith("Z") else "Z"))
        (seguro if (corte and t and t <= corte) else depois).append(e)
    return seguro, [e for e in depois if e.get("origin") == "owner"]


def _linhas_chat_tail(eventos, n=24):
    """O formato do chat-tail.md (memory-recall.sh e log-reply.sh escrevem assim)."""
    out = []
    for e in eventos[-n:]:
        quem = "Dono" if e.get("origin") == "owner" else "Voce (bot)"
        out.append(f"{quem}: {' '.join((e.get('text') or '').split())[:500]}")
    return "\n".join(out) + ("\n" if out else "")


def _tirar_carry_over(ws: Path, guarda: Path):
    """Tira da working-memory o bloco de carry-over do auto-compact, guardando-o.
    O bloco traz o fio da conversa ANTERIOR a um restart, e e lido no boot: se a
    conversa estava envenenada, ele traz o veneno de volta pela porta da frente."""
    for wm in (ws / "working-memory.md", ws / "persona" / "working-memory.md"):
        if not wm.exists():
            continue
        corpo = wm.read_text()
        if CARRYOVER_START not in corpo or CARRYOVER_END not in corpo:
            return None
        pre, resto = corpo.split(CARRYOVER_START, 1)
        bloco, pos = resto.split(CARRYOVER_END, 1)
        guarda.parent.mkdir(parents=True, exist_ok=True)
        guarda.write_text(CARRYOVER_START + bloco + CARRYOVER_END + "\n")
        escrever_atomico(wm, (pre.rstrip() + "\n" + pos.lstrip("\n")).rstrip() + "\n")
        return str(guarda.relative_to(ws))
    return None


def _refazer_wm():
    """Roda o build da working memory so nas secoes geradas (--agora-only). Devolve
    {"ok": bool, "motivo": ...}. Falhar aqui nao impede o reinicio: o session-context e
    o build das 7h tambem filtram a quarentena; fica registrado para quem for olhar."""
    build = AQUI.parent / "build-working-memory.py"
    if not build.exists():
        return {"ok": False, "motivo": f"nao achei {build.name} ao lado de _lib"}
    try:
        r = subprocess.run([sys.executable, str(build), "--agora-only"], capture_output=True,
                           text=True, timeout=120, env=dict(os.environ, DGCLAW_WORKSPACE=str(workspace())))
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"modo de segurança: não consegui refazer a working memory: {e}")
        return {"ok": False, "motivo": str(e)}
    if r.returncode != 0:
        motivo = ((r.stderr or r.stdout).strip().splitlines() or [f"saiu {r.returncode}"])[-1][:300]
        log(f"modo de segurança: o build da working memory saiu {r.returncode}: {motivo}")
        return {"ok": False, "motivo": motivo}
    return {"ok": True}


def recado_modo_seguro(marca):
    chat = os.environ.get("DGCLAW_CHAT_ID") or f"c_{slug()}"
    q = marca.get("quarentena") or {}
    sobre_q = ""
    if q.get("mensagemEm"):
        hora = _parse_ts(q["mensagemEm"]).astimezone().strftime("%d/%m às %H:%M")
        sobre_q = (f" A mensagem do dono de {hora} foi posta em QUARENTENA: ela não está aqui e você "
                   f"não deve procurá-la (não abra .dgclaw/quarentena/). Diga a ele que essa mensagem "
                   f"ficou de fora e que, se ainda quiser, ele pode reescrever o pedido com outras palavras.")
    return (
        f"[modo-seguro] Você foi reiniciado em MODO DE SEGURANÇA. Motivo: {marca.get('motivo') or 'a conversa anterior travou'}. "
        "A conversa anterior ficou guardada no disco, mas NÃO foi carregada nesta sessão, de propósito: "
        "alguma coisa nela fazia você travar." + sobre_q + " Regras desta volta: "
        "(1) leia a sua working-memory.md para saber quem você é e o que está pendente; "
        "(2) NÃO retome o último assunto por conta própria; "
        "(3) NÃO abra, não leia e não procure o transcript da conversa anterior (os arquivos .jsonl em ~/.claude/projects), "
        "e NÃO reprocesse anexos, áudios ou transcrições daquela conversa, nem por ferramenta; "
        f"(4) avise o dono agora, pelo canal de sempre (no painel é a conversa {chat}), em uma ou duas frases: "
        "diga que voltou em modo de segurança, explique em palavras simples o motivo acima e pergunte como ele quer seguir."
    )


def checar():
    """Pode reiniciar daqui? Rapido, nao mexe em nada. Serve ao painel antes de mandar
    o modo de seguranca rodar em segundo plano."""
    m = mundo()
    lock = dgclaw_dir() / "modo-seguro.lock"
    ocupado = False
    if lock.exists():
        try:
            with lock.open("a") as fh:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fh, fcntl.LOCK_UN)
        except BlockingIOError:
            ocupado = True
    out = {"ok": m["pode"] and not ocupado, "mundo": ("runner" if m.get("runner") else m["modo"]),
           "emAndamento": ocupado}
    if not m["pode"]:
        out.update(motivo=m["motivo"], comoResolver=m.get("comoResolver"))
    elif ocupado:
        out.update(motivo="já existe um reinício em modo de segurança em andamento",
                   comoResolver="Espere ele terminar (leva até dois minutos).")
    return out


def reiniciar_seguro(motivo="", origem="manual", dry_run=False):
    ws = workspace()
    dg = dgclaw_dir()
    dg.mkdir(parents=True, exist_ok=True)
    lock_p = dg / "modo-seguro.lock"
    fh = lock_p.open("a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return falha("seguro", "já existe um reinício em modo de segurança em andamento",
                     "Espere ele terminar (leva até dois minutos).")
    try:
        return _reiniciar_seguro(ws, dg, motivo, origem, dry_run)
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def _reiniciar_seguro(ws, dg, motivo, origem, dry_run):
    m = mundo()
    if not m["pode"]:
        return falha("seguro", m["motivo"], m.get("comoResolver"))

    pub, interno = saude_sessao.diagnosticar(slug(), checar_login=False)
    transcript = interno.get("transcript")
    tipo = pub.get("tipo") if pub.get("tipo") not in ("ok",) else "manual"
    motivo = motivo or {
        "recusa": "a Anthropic bloqueou uma resposta sua pelo filtro de segurança e você travou nesse assunto",
        "contexto": "a conversa ficou grande demais para você ler de uma vez",
    }.get(pub.get("tipo"), "o dono pediu para recomeçar sem carregar a conversa anterior")
    # Com o agente "normal" (o dono pediu o modo de seguranca por conta propria), o
    # corte e o ultimo turno bom, e a quarentena fica vazia: nao houve turno ruim.
    corte = interno.get("cortarDepoisDe")
    seguro, quarentena_msgs = separar_fio(transcript, corte)
    sessao_anterior = pub.get("sessionId") or (m.get("card") or {}).get("sessionId")
    s = stamp()

    plano = {"mundo": "runner" if m.get("runner") else m["modo"], "tipo": tipo, "motivo": motivo,
             "cortarDepoisDe": corte, "fioSeguro": len(seguro), "emQuarentena": len(quarentena_msgs),
             "sessaoAnterior": sessao_anterior}
    if dry_run:
        return {"ok": True, "acao": "seguro", "dryRun": True, "plano": plano,
                "recado": recado_modo_seguro({"motivo": motivo, "quarentena": {
                    "mensagemEm": (quarentena_msgs[0].get("ts") + "Z") if quarentena_msgs else None}}),
                "frase": "Simulação: nada foi alterado."}

    log(f"MODO DE SEGURANÇA pedido por {origem} ({plano['mundo']}): {motivo}")

    # 1. quarentena: a mensagem que abriu o turno ruim. Guardada, nunca reenviada.
    quarentena = None
    if quarentena_msgs or pub.get("trecho"):
        qdir = dg / "quarentena"
        qdir.mkdir(parents=True, exist_ok=True)
        qarq = qdir / f"{s}.json"
        qarq.write_text(json.dumps({
            "criadoEm": iso(), "tipo": tipo, "motivo": motivo, "sessaoAnterior": sessao_anterior,
            # O corte vai junto: _lib/quarentena.py usa sessao + corte para tirar do
            # caminho tudo o que a sessao anterior gravou depois dele (inclusive o que o
            # agente comecou a responder), e nao so o texto do dono.
            "cortarDepoisDe": corte,
            "trechoDaRecusa": pub.get("trecho"),
            "mensagens": [{"em": e.get("ts") + "Z" if e.get("ts") else None, "via": e.get("via"),
                           "texto": e.get("text")} for e in quarentena_msgs],
            "aviso": "NUNCA reenviar este texto ao agente. Ele é o que fez a conversa travar.",
        }, ensure_ascii=False, indent=2))
        quarentena = {"arquivo": str(qarq.relative_to(ws)),
                      "mensagemEm": (quarentena_msgs[0].get("ts") + "Z") if quarentena_msgs else None,
                      "trechoDaMensagem": saude_sessao._corta(quarentena_msgs[0].get("text")) if quarentena_msgs else None,
                      "mensagens": len(quarentena_msgs)}

    # 2. o fio: chat-tail.md antigo vai para a guarda, e o novo so tem o que e seguro.
    guarda = dg / "modo-seguro" / s
    guardados = {}
    tail = dg / "chat-tail.md"
    if tail.exists():
        guarda.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tail), str(guarda / "chat-tail.md"))
        guardados["chatTail"] = str((guarda / "chat-tail.md").relative_to(ws))
    escrever_atomico(tail, _linhas_chat_tail(seguro))
    co = _tirar_carry_over(ws, guarda / "carry-over.md")
    if co:
        guardados["carryOver"] = co

    # 3. a marca. Escrita ANTES do reinicio: o SessionStart da sessao nova precisa achar.
    marca = {
        "ativo": True, "motivo": motivo, "tipo": tipo, "origem": origem,
        "desde": pub.get("desde") or iso(), "ativadoEm": iso(),
        "sessaoAnterior": sessao_anterior, "cortarDepoisDe": corte,
        "chatTailRefeito": True, "guardados": guardados, "quarentena": quarentena,
        "reinicio": {"ok": None}, "recado": {"entregue": False, "confirmado": False},
    }
    anterior = ler_marca()
    if anterior and not anterior.get("ilegivel"):
        hist = dg / "modo-seguro" / "historico"
        hist.mkdir(parents=True, exist_ok=True)
        shutil.move(str(marca_path()), str(hist / f"{s}-substituida.json"))
    escrever_atomico(marca_path(), json.dumps(marca, ensure_ascii=False, indent=2))

    # 3b. a working memory. "Agora" e "Ultimas conversas" sao montadas do transcript, e a
    # WM e lida no boot (o CLAUDE.md a importa): sem refazer, a mensagem que travou
    # voltaria por ela. Refeitas agora, com a marca ja gravada, a quarentena as filtra.
    marca["wmRefeita"] = _refazer_wm()
    escrever_atomico(marca_path(), json.dumps(marca, ensure_ascii=False, indent=2))

    # 4. sessao NOVA.
    if m["modo"] == "bunker":
        st, corpo = inject._bunker_pedir(f"/api/agents/{inject._bunker_card()}/revive", {}, timeout=60)
        ok_r = st == 200 and (corpo or {}).get("success") is not False
        erro_r = "" if ok_r else f"o /revive respondeu {st}: {(corpo or {}).get('error') or 'sem detalhe'}"
    else:
        ok_r, erro_r = _systemctl("restart", m["servico"])
    marca["reinicio"] = {"ok": ok_r, "em": iso(), "motivo": erro_r or None}
    escrever_atomico(marca_path(), json.dumps(marca, ensure_ascii=False, indent=2))
    if not ok_r:
        pulso_write("modo-seguro", "erro", f"{origem}: {erro_r}")
        r = falha("seguro", erro_r, "A marca do modo de segurança ficou gravada: no próximo reinício, de "
                                   "qualquer jeito, ele volta sem o fio que travou. Tente de novo em um minuto.")
        r["marcaGravada"] = True
        return r

    # 5. esperar de pe e entregar o recado. Sem injectWhenIdle: a fila do runner tem
    # UMA vaga e o proximo cron apagaria o recado sem ninguem saber. Esperamos o card
    # ficar ocioso NOS MESMOS e digitamos direto.
    de_pe, card, porque = esperar_de_pe(m, sessao_anterior, exigir_nova=(m["modo"] == "bunker"))
    entregue, confirmado, motivo_recado = False, False, porque
    if de_pe:
        texto = recado_modo_seguro(marca)
        env = dict(os.environ, DGCLAW_POKE_ENVELOPE="plataforma")
        try:
            r = subprocess.run([sys.executable, str(AQUI / "inject.py"), "--slug", slug(),
                                "--envelope", "plataforma", texto],
                               capture_output=True, text=True, timeout=60, env=env)
            # "enfileirado" NAO e entregue: a fila do runner tem uma vaga e o proximo
            # recado apaga este. So conta o que foi digitado de fato.
            entregue = r.returncode == 0 and "enfileirado" not in (r.stderr or "")
            linhas = (r.stderr or "").strip().splitlines()
            motivo_recado = "" if entregue else (linhas[-1] if linhas else f"o injetor saiu {r.returncode}")
        except (OSError, subprocess.TimeoutExpired) as e:
            motivo_recado = f"o injetor não rodou: {e}"
        if entregue:
            confirmado = _confirmar_recado(sessao_anterior)
    marca["recado"] = {"entregue": entregue, "confirmado": confirmado, "em": iso(),
                       "motivo": motivo_recado or None}
    marca["sessaoNova"] = (card or {}).get("sessionId")
    escrever_atomico(marca_path(), json.dumps(marca, ensure_ascii=False, indent=2))
    pulso_write("modo-seguro", "ok" if entregue else "erro",
                f"{origem}: {plano['mundo']}, recado {'confirmado' if confirmado else 'entregue' if entregue else 'NAO entregue: ' + str(motivo_recado)}")
    log(f"modo de segurança: reiniciado; recado entregue={entregue} confirmado={confirmado} {motivo_recado or ''}")
    if entregue:
        frase = ("Ele foi reiniciado em modo de segurança e recebeu o recado. Em instantes ele deve "
                 "mandar uma mensagem dizendo que voltou.")
    else:
        frase = ("Ele foi reiniciado em modo de segurança, mas não consegui entregar o recado "
                 f"({motivo_recado}). Mande você uma mensagem simples, tipo \"oi, o que houve?\".")
    return {"ok": True, "acao": "seguro", "mundo": plano["mundo"], "recadoEntregue": entregue,
            "recadoConfirmado": confirmado, "frase": frase, "motivo": None if entregue else motivo_recado,
            "quarentena": bool(quarentena)}


def _confirmar_recado(sessao_anterior, prazo_s=60):
    """O recado CHEGOU na sessao nova? Prova = o marcador no transcript dela."""
    fim = time.monotonic() + prazo_s
    while time.monotonic() < fim:
        caminho = inject.live_transcript(slug())
        if caminho and Path(caminho).stem != sessao_anterior:
            try:
                regs, _ = saude_sessao.ler_cauda(caminho, 200 * 1024)
                if any("[modo-seguro]" in json.dumps(o, ensure_ascii=False) for o in regs if o.get("type") == "user"):
                    return True
            except OSError as e:
                log(f"não consegui ler {caminho} para confirmar o recado: {e}")
        time.sleep(4)
    return False


def encerrar_modo_seguro(motivo="o agente voltou ao normal"):
    marca = ler_marca()
    if not marca:
        return {"ok": True, "acao": "encerrar", "frase": "O modo de segurança não estava ligado."}
    hist = dgclaw_dir() / "modo-seguro" / "historico"
    hist.mkdir(parents=True, exist_ok=True)
    marca.update(ativo=False, encerradoEm=iso(), motivoDoEncerramento=motivo)
    escrever_atomico(hist / f"{stamp()}.json", json.dumps(marca, ensure_ascii=False, indent=2))
    marca_path().unlink()
    log(f"modo de segurança encerrado: {motivo}")
    return {"ok": True, "acao": "encerrar", "frase": "O modo de segurança foi encerrado."}


def status_publico():
    """A marca, sem caminho de servidor: e o que pode descer ao navegador."""
    marca = ler_marca()
    if not marca:
        return {"ativo": False}
    q = marca.get("quarentena") or {}
    return {
        "ativo": bool(marca.get("ativo")), "motivo": marca.get("motivo"), "tipo": marca.get("tipo"),
        "origem": marca.get("origem"), "ativadoEm": marca.get("ativadoEm"),
        "reinicioOk": (marca.get("reinicio") or {}).get("ok"),
        "recadoEntregue": (marca.get("recado") or {}).get("entregue"),
        "recadoConfirmado": (marca.get("recado") or {}).get("confirmado"),
        "quarentena": {"mensagemEm": q.get("mensagemEm"), "trechoDaMensagem": q.get("trechoDaMensagem")}
        if q else None,
    }


def main():
    ap = argparse.ArgumentParser(description="Reinicia o agente DG Claw (normal ou modo de segurança).")
    ap.add_argument("acao", choices=["checar", "normal", "seguro", "encerrar-modo-seguro", "status"])
    ap.add_argument("--motivo", default="")
    ap.add_argument("--origem", default="manual", choices=["painel", "watchdog", "manual"])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("config", nargs="?", default=None, help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.acao == "checar":
        r = checar()
    elif a.acao == "normal":
        r = reiniciar_normal(a.motivo, a.origem)
    elif a.acao == "seguro":
        r = reiniciar_seguro(a.motivo, a.origem, a.dry_run)
    elif a.acao == "encerrar-modo-seguro":
        r = encerrar_modo_seguro(a.motivo or "encerrado à mão")
    else:
        r = status_publico()
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(r.get("frase") or json.dumps(r, ensure_ascii=False))
    return 0 if r.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
