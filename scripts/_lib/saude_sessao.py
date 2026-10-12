#!/usr/bin/env python3
"""saude_sessao.py (DG Claw) — O agente esta respondendo NORMALMENTE? Se nao, por que?

POR QUE ESTE ARQUIVO EXISTE (30/09/2026)
  A Isa, agente irma do DG Claw, ficou 56 minutos muda. O Danilo mandou um audio
  sobre um assunto que o filtro de seguranca da Anthropic leu como ciberataque, a
  resposta dela foi cortada no meio ("Ouvi os dois audios. Vou por part") e a sessao
  congelou. Ninguem percebeu: o vigia que existia so olhava erro de API, e o corte do
  filtro NAO e erro de API. Pior: reiniciar nao resolvia, porque a retomada mandou ela
  reler a conversa morta, o texto voltou ao contexto e o filtro cortou de novo.

  Ate aqui, todo sinal de "esta vivo" do DG Claw media o PROCESSO: tem terminal? o
  card esta de pe? Um processo de pe que so devolve recusa esta, para quem fala com
  ele, tao fora do ar quanto um processo morto. Este modulo mede a outra coisa: a
  RESPOSTA. Le o fim do transcript da sessao viva, acha o ultimo turno do assistente
  depois da ultima mensagem do dono e diz se ele foi normal.

O QUE ELE DEVOLVE (contrato, a tela do painel e o watchdog dependem dele)
  {"estado": "ativo|atencao|inativo|indeterminado",
   "tipo": "ok|recusa|login|limite|sobrecarga|contexto|sem_resposta|erro_api|sessao_caida|desconhecido",
   "frase": "frase curta em portugues para leigo",
   "trecho": "o pedaco principal da resposta anormal, literal, ate 200 caracteres, ou null",
   "desde": "ISO8601 ou null", "ocorrencias": 3,
   "recomendacao": "nada|esperar|reiniciar|modo_seguro|refazer_login",
   "comoResolver": "o que o dono faz, em uma ou duas frases",
   "sessionId": "...", "verificadoEm": "ISO8601"}

  Campos ADICIONAIS so com --interno (nunca descem ao navegador, levam caminho do
  servidor): "_interno": {transcript, cortarDepoisDe, gatilhoEm, ...}. Quem usa e o
  modo de seguranca, para saber ate onde a conversa anterior e segura.

AS ASSINATURAS (levantadas nos transcripts reais em 01/10/2026; relatorio completo em
docs/interno/dgclaw-assinaturas-erro-api-2026-10-01.md)
  - Recusa do filtro de seguranca: NAO e erro de API. Tres registros, e nem sempre os
    tres aparecem (no segundo corte da Isa o primeiro nem foi gravado):
      assistant normal com message.stop_reason == "refusal" e stop_details.explanation;
      system/informational "...safeguards stopped the response above...";
      user isMeta "Your response above was stopped by a safety classifier...".
    E tool_result is_error "Interrupted: ... stopped by a safety classifier".
  - Erro de API: assistant SINTETICO (message.model "<synthetic>", isApiErrorMessage
    true). Visto: "Login expired · Please run /login" (error authentication_failed),
    "API Error: 529 Overloaded...", "API Error: 500 Internal server error...",
    "API Error: Connection lost mid-response...", "API Error: Server error mid-response...".
  - "No response requested." e sintetico MAS e normal (isApiErrorMessage falso).
  - Limite de uso e "prompt is too long" NAO apareceram em 30 dias de transcript: as
    regex desses dois sao INFERIDAS (do texto que o Claude Code costuma mostrar) e
    largas de proposito. Quando aparecer um caso real, conferir aqui.

AS REGRAS DE ESTADO (decisao do Danilo, 01/10/2026)
  recusa       -> inativo + modo_seguro (reiniciar normal reenvia o veneno)
  contexto     -> inativo + modo_seguro
  login        -> inativo + refazer_login (reiniciar NAO resolve, e a frase diz isso)
  limite       -> inativo + esperar (com o horario de volta, se vier na mensagem)
  sobrecarga   -> atencao + esperar; inativo so se passar de 30 min. Reiniciar ZERA o
                  cache do prompt e piora: cada turno passa a custar a conversa inteira.
  sem_resposta -> atencao + reiniciar (mensagem do dono sem resposta > 10 min, sessao parada)
  Turno normal DEPOIS do erro: o erro e passado, volta a ativo.
  Nao medido nunca vira ok: sem transcript, sem plataforma, leitura quebrada =
  indeterminado.

POR QUE SO O FIM DO ARQUIVO
  Um transcript de sessao longa passa de 50 MB e isto roda a cada 20 s no painel e a
  cada 5 min no watchdog. Os ultimos ~300 KB cobrem dezenas de turnos, que e o que
  importa para "o ultimo turno foi normal?".

ONDE ESTA A SESSAO
  Quem sabe e o _lib/inject.py (card do Bunker, runner, --channels, tmux). Este modulo
  NAO reimplementa: pergunta a ele (inject.live_transcript / is_session_alive).

CLI:
  saude_sessao.py --json                      diagnostico da sessao viva (envs DGCLAW_*)
  saude_sessao.py --json --jsonl <arquivo>    diagnostico de um transcript dado (testes)
  saude_sessao.py --json --interno            inclui o bloco _interno (modo de seguranca)
  Opcoes de teste: --agora <ISO> (relogio fixo), --sem-checar-vida, --vivo / --morto.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inject  # noqa: E402  (a fonte unica de "onde esta a sessao")


# ─── parametros ───────────────────────────────────────────────────────────────

def _env_int(nome, padrao):
    bruto = os.environ.get(nome, "")
    if not bruto:
        return padrao
    try:
        return int(bruto)
    except ValueError:
        # Nao engole calado: um valor errado aqui muda quando o dono e avisado.
        print(f"[saude] {nome}={bruto!r} nao e numero inteiro; usando {padrao}", file=sys.stderr)
        return padrao


TAIL_BYTES = _env_int("DGCLAW_SAUDE_TAIL_KB", 300) * 1024
SEM_RESPOSTA_MIN = _env_int("DGCLAW_SAUDE_SEM_RESPOSTA_MIN", 10)
PERSISTE_MIN = _env_int("DGCLAW_SAUDE_PERSISTE_MIN", 30)
# O Claude Code tenta continuar sozinho UMA vez depois de um corte ("continuing once
# with that noted"). Nas sessoes interativas isso funciona; na Isa nao funcionou.
# Antes deste prazo, um corte recente e "atencao"; depois, sem resposta, e inativo.
RECUSA_CARENCIA_S = _env_int("DGCLAW_SAUDE_RECUSA_CARENCIA_S", 120)
# Registros do mesmo tipo a menos disto um do outro sao UM incidente (um corte grava
# ate tres registros em menos de um segundo).
AGRUPA_S = 20
TRECHO_MAX = 200


# ─── leitura ──────────────────────────────────────────────────────────────────

def ler_cauda(caminho, nbytes=None):
    """As linhas JSON do fim do arquivo. Devolve (registros, cortado_no_inicio).
    A primeira linha e descartada quando nao comecamos do byte zero (pode ter vindo
    pela metade). Linha truncada no FIM e o transcript sendo escrito agora: pula."""
    nbytes = nbytes or TAIL_BYTES
    with open(caminho, "rb") as f:
        f.seek(0, os.SEEK_END)
        tam = f.tell()
        inicio = max(0, tam - nbytes)
        f.seek(inicio)
        bruto = f.read()
    linhas = bruto.decode("utf-8", "replace").split("\n")
    if inicio > 0 and linhas:
        linhas = linhas[1:]
    regs = []
    for l in linhas:
        l = l.strip()
        if not l:
            continue
        try:
            o = json.loads(l)
        except ValueError:
            continue
        if isinstance(o, dict):
            regs.append(o)
    return regs, inicio > 0


def _ts(o):
    bruto = o.get("timestamp") or ""
    if not bruto:
        return None
    try:
        dt = datetime.fromisoformat(bruto.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def _texto(conteudo):
    """Texto de um content (string ou lista de blocos). Inclui o texto de tool_result
    porque o corte do filtro tambem aparece ali."""
    if isinstance(conteudo, str):
        return conteudo
    if not isinstance(conteudo, list):
        return ""
    partes = []
    for b in conteudo:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            partes.append(b.get("text") or "")
        elif b.get("type") == "tool_result":
            c = b.get("content")
            partes.append(_texto(c) if not isinstance(c, str) else c)
    return "\n".join(p for p in partes if p)


def _corta(s):
    s = " ".join(str(s or "").split())
    if len(s) > TRECHO_MAX:
        s = s[: TRECHO_MAX - 1].rstrip() + "…"
    return s or None


# ─── classificacao de UM texto de erro ────────────────────────────────────────
# Ordem importa: "exceeds the maximum" de contexto nao pode cair em limite, e o 401
# dentro de um texto de login nao pode virar sobrecarga.

_RE_CONTEXTO = re.compile(
    r"prompt is too long|context (window|length)|too many tokens|input length|"
    r"exceeds? the (maximum|context)|maximum context", re.I)
_RE_LOGIN = re.compile(
    r"/login|login expired|not logged in|please log ?in|invalid api key|"
    r"authentication|unauthori[sz]ed|\b401\b|oauth|organization membership|\b403\b|"
    r"invalid x-api-key|credentials", re.I)
# INFERIDO: nenhum caso real em 30 dias. Largo de proposito.
_RE_LIMITE = re.compile(
    r"usage limit|hit your limit|limit reached|limit will reset|rate.?limit|"
    r"out of (extra )?usage|credit balance|billing|quota|\b429\b|too many requests|resets? at", re.I)
_RE_SOBRECARGA = re.compile(
    r"overloaded|internal server error|server error|connection lost|mid-response|"
    r"\b5(00|02|03|04|29)\b|timed? ?out|econnreset|socket hang up|service unavailable|bad gateway", re.I)



def classificar_texto_erro(texto, erro=None, status=None):
    """Para um registro que JA se sabe anormal, diz de que tipo. Nunca devolve 'ok'."""
    t = texto or ""
    if _RE_CONTEXTO.search(t):
        return "contexto"
    if erro == "authentication_failed" or status in (401, 403) or _RE_LOGIN.search(t):
        return "login"
    if erro == "rate_limit" or status == 429 or _RE_LIMITE.search(t):
        return "limite"
    if erro == "server_error" or (isinstance(status, int) and status >= 500) or _RE_SOBRECARGA.search(t):
        return "sobrecarga"
    return "erro_api"


def extrair_volta(texto):
    """O horario de volta do limite, se a mensagem trouxer. Formatos INFERIDOS:
    'Claude AI usage limit reached|1759340000' (epoch, formato antigo do Claude Code)
    e 'resets 3pm (America/Sao_Paulo)' / 'resets at 15:00'. Devolve (iso|None, literal|None)."""
    t = texto or ""
    m = re.search(r"\|(\d{10})\b", t)
    if m:
        dt = datetime.fromtimestamp(int(m.group(1)), tz=timezone.utc)
        local = dt.astimezone()
        return _iso(dt), local.strftime("%d/%m às %H:%M")
    m = re.search(r"resets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?:\s*\([^)]*\))?)", t, re.I)
    if m:
        return None, m.group(1).strip()
    m = re.search(r"try again (?:at|after|in)\s+([^.\n]+)", t, re.I)
    if m:
        return None, m.group(1).strip()
    return None, None


# ─── classificacao de UM registro ─────────────────────────────────────────────

_DONO_CANAL = re.compile(r"<channel\b[^>]*source=", re.S)
_DONO_DGCHAT = re.compile(r"<dgchat\b[^>]*\bchat=\"[^\"]+\"", re.S)
_POKE = re.compile(r"/tmp/dgclaw-poke-|^\s*<plataforma\b|\[retomada-poscompact\]|\[modo-seguro\]")


def evento(o):
    """Um registro do transcript virado evento. Devolve dict ou None (irrelevante).

    kind: normal   resposta comum do assistente (inclusive chamada de ferramenta)
          anormal  qualquer coisa diferente disso (erro de API, recusa, sintetico estranho)
          dono     mensagem do dono (Telegram ou painel), inclusive a que ficou na FILA
          poke     recado da maquina (cron, retomada, modo de seguranca)
    """
    tipo = o.get("type")
    ts = _ts(o)
    msg = o.get("message") if isinstance(o.get("message"), dict) else {}

    if tipo == "assistant":
        conteudo = msg.get("content")
        texto = _texto(conteudo)
        if o.get("isApiErrorMessage"):
            t = classificar_texto_erro(texto, o.get("error"), o.get("apiErrorStatus"))
            return {"kind": "anormal", "tipo": t, "ts": ts, "trecho": texto, "sid": o.get("sessionId")}
        if msg.get("stop_reason") == "refusal":
            det = msg.get("stop_details") if isinstance(msg.get("stop_details"), dict) else {}
            trecho = det.get("explanation") or texto or "resposta bloqueada pelo filtro de segurança"
            return {"kind": "anormal", "tipo": "recusa", "ts": ts, "trecho": trecho,
                    "categoria": det.get("category"), "sid": o.get("sessionId")}
        if msg.get("model") == "<synthetic>":
            # "No response requested." e o Claude Code dizendo que nao havia o que
            # responder: normal, e por isso nem conta como turno.
            if texto.strip().lower().startswith("no response requested"):
                return None
            # Sintetico que nao e erro conhecido: diferente do normal, entao e pego.
            return {"kind": "anormal", "tipo": "desconhecido", "ts": ts, "trecho": texto,
                    "sid": o.get("sessionId")}
        return {"kind": "normal", "ts": ts, "sid": o.get("sessionId")}

    if tipo == "system":
        conteudo = o.get("content")
        texto = conteudo if isinstance(conteudo, str) else _texto(conteudo)
        if re.search(r"safeguards stopped|safety classifier", texto or "", re.I):
            return {"kind": "anormal", "tipo": "recusa", "ts": ts, "trecho": texto,
                    "sid": o.get("sessionId")}
        if o.get("subtype") == "informational" and re.search(r"oauth token unavailable|run /login", texto or "", re.I):
            # Remote Control sem token. Nao prova que ele parou de responder, mas prova
            # que o login esta podre: vira login FRACO (atencao, nao inativo).
            return {"kind": "anormal", "tipo": "login", "fraco": True, "ts": ts, "trecho": texto,
                    "sid": o.get("sessionId")}
        if o.get("subtype") == "api_error":
            # Formato INFERIDO (versoes que gravam a tentativa de novo como system).
            err = o.get("error") if isinstance(o.get("error"), dict) else {}
            status = err.get("status") if isinstance(err.get("status"), int) else None
            t = classificar_texto_erro(texto or json.dumps(err)[:300], None, status)
            return {"kind": "anormal", "tipo": t, "ts": ts, "trecho": texto or json.dumps(err)[:300],
                    "sid": o.get("sessionId")}
        return None

    if tipo == "user":
        conteudo = msg.get("content")
        texto = _texto(conteudo)
        if not texto.strip():
            return None
        # O companheiro do corte ("Your response above was stopped by a safety
        # classifier", gravado com turnCompanion) e o tool_result interrompido pelo
        # filtro (is_error). NAO basta isMeta: a mensagem do dono pelo Telegram tambem
        # chega com isMeta, e um dono que escreva "safety classifier" nao e uma recusa.
        if "safety classifier" in texto:
            erro_de_ferramenta = isinstance(conteudo, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error")
                for b in conteudo)
            if o.get("turnCompanion") or erro_de_ferramenta:
                return {"kind": "anormal", "tipo": "recusa", "ts": ts, "trecho": texto,
                        "sid": o.get("sessionId")}
        if isinstance(conteudo, list) and all(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in conteudo):
            return None  # resultado de ferramenta: meio de turno, nao e gatilho
        if _DONO_DGCHAT.search(texto) or _DONO_CANAL.search(texto[:400]):
            return {"kind": "dono", "ts": ts, "sid": o.get("sessionId")}
        if _POKE.search(texto):
            return {"kind": "poke", "ts": ts, "sid": o.get("sessionId")}
        return None

    if tipo == "queue-operation" and o.get("operation") == "enqueue":
        # A mensagem que chegou enquanto a sessao estava ocupada (ou congelada) fica
        # aqui, e nao como user turn. Na Isa, todas as cobrancas do Danilo depois do
        # corte ("Que aconteceu? Travou?") so existem neste formato.
        c = o.get("content")
        texto = c if isinstance(c, str) else _texto(c)
        if texto and (_DONO_DGCHAT.search(texto) or _DONO_CANAL.search(texto[:400])):
            return {"kind": "dono", "ts": ts, "sid": o.get("sessionId"), "fila": True}
        return None

    return None


# ─── textos para leigo ────────────────────────────────────────────────────────
# Nenhuma frase usa adjetivo com genero: o painel serve agente de qualquer nome.

def _min(seg):
    m = int(seg // 60)
    if m < 1:
        return "menos de um minuto"
    if m == 1:
        return "1 minuto"
    if m < 120:
        return f"{m} minutos"
    h = m // 60
    return f"{h} horas" if h > 1 else "1 hora"


TEXTOS = {
    "ok": ("Está ativo e respondendo normalmente.", "Nada a fazer."),
    "trabalhando": ("Recebeu a sua mensagem e está trabalhando nela.",
                    "Nada a fazer: a resposta chega quando ele terminar."),
    "recusa": ("A Anthropic bloqueou uma resposta dele pelo filtro de segurança, e ele travou nesse assunto.",
               "Reinicie em modo de segurança: ele volta sem carregar a conversa que travou (ela fica "
               "guardada) e você consegue perguntar o que houve. Reiniciar do jeito normal não resolve, "
               "porque ele relê a mesma conversa e é bloqueado de novo."),
    "recusa_recente": ("A Anthropic acabou de bloquear uma resposta dele pelo filtro de segurança.",
                       "Espere uns dois minutos: às vezes ele continua sozinho. Se não voltar, "
                       "reinicie em modo de segurança."),
    "contexto": ("A conversa ficou grande demais para ele ler de uma vez, e ele parou de responder.",
                 "Reinicie em modo de segurança: ele começa uma conversa nova e leve, e a anterior "
                 "fica guardada."),
    "login": ("O login da conta dele na Anthropic não está valendo (expirou ou foi desfeito), então ele "
              "não consegue responder.",
              "Quem cuida do sistema precisa refazer o login da conta deste agente. Reiniciar não "
              "resolve: ele volta sem login do mesmo jeito."),
    "login_fraco": ("A conta dele na Anthropic deu sinal de login vencido. Ele ainda pode estar "
                    "respondendo, mas o login precisa ser refeito logo.",
                    "Avise quem cuida do sistema para refazer o login da conta deste agente. "
                    "Reiniciar não resolve."),
    "limite": ("Ele atingiu o limite de uso da conta na Anthropic e está esperando o limite voltar.",
               "Esperar. Reiniciar não adianta, porque o limite é da conta e não do agente. Se isso "
               "acontece sempre, vale rever o plano da conta."),
    "sobrecarga": ("Os servidores da Anthropic estão sobrecarregados ou com falha passageira, e "
                   "alguma resposta dele não saiu.",
                   "Esperar alguns minutos: isso costuma passar sozinho. Não reinicie, porque "
                   "reiniciar faz ele reler tudo do zero e deixa cada resposta mais lenta e mais cara "
                   "enquanto a falha durar."),
    "sobrecarga_longa": ("A Anthropic está com falha há mais de meia hora, e ele não consegue responder.",
                         "Continue esperando e confira https://status.claude.com. Reiniciar não "
                         "resolve falha do lado de lá."),
    "erro_api": ("A Anthropic devolveu um erro que eu não sei classificar, e a resposta dele não saiu.",
                 "Espere alguns minutos e mande de novo. Se continuar por mais de meia hora, reinicie."),
    "erro_api_longo": ("A Anthropic devolve erro nas respostas dele há mais de meia hora.",
                       "Reinicie. Se continuar depois disso, avise quem cuida do sistema."),
    "desconhecido": ("Ele deu uma resposta fora do normal, que eu não sei classificar.",
                     "Mande uma mensagem simples e veja se ele responde. Se não responder, reinicie."),
    "sem_resposta": ("Você mandou mensagem há {quanto} e ele não respondeu, e a sessão dele está parada.",
                     "Reinicie do jeito normal. Ele volta e vê a sua mensagem."),
    "sessao_caida": ("Ele está fora do ar: a sessão dele não está rodando.",
                     "Reinicie. Se ele cair de novo logo em seguida, chame quem cuida do sistema."),
    "sessao_caida_veneno": ("Ele está fora do ar, e a última coisa que aconteceu foi um bloqueio da "
                            "Anthropic na conversa.",
                            "Reinicie em modo de segurança. Reiniciar do jeito normal faria ele reler "
                            "a conversa que travou."),
}

PRIORIDADE = ["recusa", "contexto", "login", "limite", "sobrecarga", "erro_api", "desconhecido"]


def _saida(estado, tipo, chave_texto, recomendacao, *, trecho=None, desde=None, ocorrencias=0,
           sid=None, agora=None, fmt=None):
    frase, como = TEXTOS[chave_texto]
    if fmt:
        frase = frase.format(**fmt)
        como = como.format(**fmt)
    return {
        "estado": estado,
        "tipo": tipo,
        "frase": frase,
        "trecho": _corta(trecho) if trecho else None,
        "desde": _iso(desde),
        "ocorrencias": int(ocorrencias or 0),
        "recomendacao": recomendacao,
        "comoResolver": como,
        "sessionId": sid,
        "verificadoEm": _iso(agora or datetime.now(timezone.utc)),
    }


def _contar_incidentes(eventos):
    """Quantos incidentes (e nao registros) ha numa lista de eventos do mesmo tipo."""
    n, ultimo = 0, None
    for e in eventos:
        if ultimo is None or e["ts"] is None or ultimo is None or (e["ts"] - ultimo).total_seconds() > AGRUPA_S:
            n += 1
        ultimo = e["ts"] or ultimo
    return n


# ─── o veredito ───────────────────────────────────────────────────────────────

def analisar(registros, agora=None, mtime=None, sid_arquivo=None):
    """O veredito sobre uma lista de registros (em ordem de arquivo).

    agora: datetime aware (relogio; fixo nos testes).
    mtime: epoch da ultima escrita no transcript (sessao "parada" = sem escrita).
    Devolve (publico, interno)."""
    agora = agora or datetime.now(timezone.utc)
    evs = [e for e in (evento(o) for o in registros) if e]
    sid = next((o.get("sessionId") for o in reversed(registros) if o.get("sessionId")), None) or sid_arquivo

    idx_normal = max((i for i, e in enumerate(evs) if e["kind"] == "normal"), default=-1)
    depois = evs[idx_normal + 1:]
    anormais = [e for e in depois if e["kind"] == "anormal"]
    donos = [e for e in depois if e["kind"] == "dono"]
    ultimo_normal_ts = evs[idx_normal]["ts"] if idx_normal >= 0 else None

    interno = {"ultimoNormalEm": _iso(ultimo_normal_ts), "eventos": len(evs)}

    def ponto_de_corte(primeiro_ruim_idx_global):
        """ts do ultimo turno BOM antes do gatilho que abriu o turno ruim. Tudo depois
        disso fica de fora quando o modo de seguranca remonta o fio da conversa."""
        gat = None
        for j in range(primeiro_ruim_idx_global - 1, -1, -1):
            if evs[j]["kind"] in ("dono", "poke"):
                gat = j
                break
        if gat is None:
            return None, None
        bom = next((evs[k]["ts"] for k in range(gat - 1, -1, -1) if evs[k]["kind"] == "normal"), None)
        corte = bom or (evs[gat]["ts"] - timedelta(milliseconds=1) if evs[gat]["ts"] else None)
        return _iso(corte), _iso(evs[gat]["ts"])

    if anormais:
        # Recusa e contexto mandam mesmo que um erro passageiro venha depois: um 529
        # depois do corte nao tira o veneno da conversa.
        tipo = min((e["tipo"] for e in anormais), key=lambda t: PRIORIDADE.index(t) if t in PRIORIDADE else 99)
        do_tipo = [e for e in anormais if e["tipo"] == tipo]
        primeiro, ultimo = do_tipo[0], do_tipo[-1]
        trecho = ultimo.get("trecho")
        if tipo == "recusa":
            # A explicacao oficial (stop_details) e o trecho mais claro; o companheiro
            # isMeta repete em ingles o que a gente ja diz na frase.
            # Na falta dela (no segundo corte da Isa o registro com stop_details nem foi
            # gravado), o aviso do proprio Claude Code ("safeguards stopped...").
            oficial = next((e for e in reversed(do_tipo) if e.get("categoria") or "Usage Policy" in (e.get("trecho") or "")), None) \
                or next((e for e in reversed(do_tipo) if "safeguards stopped" in (e.get("trecho") or "")), None)
            if oficial:
                trecho = oficial["trecho"]
        if tipo == "login":
            # O erro de verdade ("Login expired") diz mais que o aviso do Remote Control.
            forte = next((e for e in reversed(do_tipo) if not e.get("fraco")), None)
            if forte:
                trecho = forte["trecho"]
        ocorr = _contar_incidentes(do_tipo)
        desde = primeiro["ts"]
        idx_global = evs.index(primeiro)
        corte, gatilho = ponto_de_corte(idx_global)
        interno.update({"cortarDepoisDe": corte, "gatilhoEm": gatilho, "tipoInterno": tipo})
        idade_ultimo = (agora - ultimo["ts"]).total_seconds() if ultimo["ts"] else None
        duracao = (agora - desde).total_seconds() if desde else None
        dono_depois = [d for d in donos if d["ts"] and ultimo["ts"] and d["ts"] > ultimo["ts"]]
        kw = dict(trecho=trecho, desde=desde, ocorrencias=ocorr, sid=sid, agora=agora)

        if tipo == "recusa":
            if idade_ultimo is not None and idade_ultimo < RECUSA_CARENCIA_S and not dono_depois:
                return _saida("atencao", "recusa", "recusa_recente", "esperar", **kw), interno
            return _saida("inativo", "recusa", "recusa", "modo_seguro", **kw), interno
        if tipo == "contexto":
            return _saida("inativo", "contexto", "contexto", "modo_seguro", **kw), interno
        if tipo == "login":
            if all(e.get("fraco") for e in do_tipo):
                return _saida("atencao", "login", "login_fraco", "refazer_login", **kw), interno
            return _saida("inativo", "login", "login", "refazer_login", **kw), interno
        if tipo == "limite":
            volta_iso, volta_txt = extrair_volta(" ".join(e.get("trecho") or "" for e in do_tipo))
            out = _saida("inativo", "limite", "limite", "esperar", **kw)
            if volta_txt:
                out["frase"] += f" Deve voltar {('em ' + volta_txt) if volta_iso else ('às ' + volta_txt) if re.match(r'^[0-9]', volta_txt) else volta_txt}."
            interno["voltaEm"] = volta_iso
            return out, interno
        if tipo == "sobrecarga":
            if duracao is not None and duracao > PERSISTE_MIN * 60:
                return _saida("inativo", "sobrecarga", "sobrecarga_longa", "esperar", **kw), interno
            return _saida("atencao", "sobrecarga", "sobrecarga", "esperar", **kw), interno
        if tipo == "erro_api":
            if duracao is not None and duracao > PERSISTE_MIN * 60:
                return _saida("inativo", "erro_api", "erro_api_longo", "reiniciar", **kw), interno
            return _saida("atencao", "erro_api", "erro_api", "esperar", **kw), interno
        return _saida("atencao", "desconhecido", "desconhecido", "esperar", **kw), interno

    # Nenhuma resposta anormal depois do ultimo turno normal.
    corte = _iso(ultimo_normal_ts)
    interno.update({"cortarDepoisDe": corte, "gatilhoEm": None})
    if donos:
        pendente = donos[0]
        espera = (agora - pendente["ts"]).total_seconds() if pendente["ts"] else None
        parada = None if mtime is None else agora.timestamp() - mtime
        if espera is not None and espera > SEM_RESPOSTA_MIN * 60 and parada is not None \
                and parada > SEM_RESPOSTA_MIN * 60:
            interno["donoEsperandoDesde"] = _iso(pendente["ts"])
            return _saida("atencao", "sem_resposta", "sem_resposta", "reiniciar",
                          desde=pendente["ts"], ocorrencias=len(donos), sid=sid, agora=agora,
                          fmt={"quanto": _min(espera)}), interno
        return _saida("ativo", "ok", "trabalhando", "nada", sid=sid, agora=agora), interno
    if idx_normal < 0:
        # Nenhum turno do assistente no trecho lido: nao da para afirmar que esta bem.
        out = _saida("indeterminado", "desconhecido", "desconhecido", "esperar", sid=sid, agora=agora)
        out["frase"] = "Ainda não há resposta dele para medir nesta sessão."
        out["comoResolver"] = "Mande uma mensagem e veja se ele responde."
        return out, interno
    return _saida("ativo", "ok", "ok", "nada", sid=sid, agora=agora), interno


# ─── a sessao viva ────────────────────────────────────────────────────────────

def _indeterminado(frase, como, agora, sid=None):
    return {"estado": "indeterminado", "tipo": "desconhecido", "frase": frase, "trecho": None,
            "desde": None, "ocorrencias": 0, "recomendacao": "esperar", "comoResolver": como,
            "sessionId": sid, "verificadoEm": _iso(agora)}


def _claude_bin():
    cand = os.environ.get("DGCLAW_CLAUDE_BIN") or os.environ.get("CLAUDE_BIN")
    if cand and os.path.exists(cand):
        return cand
    for d in os.environ.get("PATH", "").split(os.pathsep) + [str(Path.home() / ".local" / "bin")]:
        p = os.path.join(d, "claude")
        if d and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def estado_do_login(config_dir=None, cache_s=300):
    """O login da conta do agente, SEM gastar turno: `claude auth status --json`.

    Existe para pegar login vencido ANTES da proxima mensagem do dono: o erro de login
    so aparece no transcript quando alguem fala com ele, e ai o dono ja ficou sem
    resposta uma vez. Custa ~0,2 s, mas o painel pergunta a cada 20 s; por isso o
    resultado fica guardado 5 minutos em <ws>/.dgclaw/logs/.login-status.json.

    Devolve {"logado": True|False|None, "motivo": str}. None = nao medi (sem binario,
    timeout, saida estranha): e nunca vira "esta logado".

    CUIDADO COM O DIRETORIO: o login mora no config dir do claude DO AGENTE. Se este
    processo olhar outro (HOME diferente, CLAUDE_CONFIG_DIR diferente), a resposta e
    sobre a conta errada. Por isso quem chama passa o config dir do card quando sabe, e
    por isso "sem login" aqui vira ATENCAO, nunca inativo sozinho."""
    import subprocess
    ws = os.environ.get("DGCLAW_WORKSPACE") or ""
    cache = Path(ws, ".dgclaw", "logs", ".login-status.json") if ws else None
    if cache and cache.exists():
        try:
            c = json.loads(cache.read_text())
            if time.time() - float(c.get("em", 0)) < cache_s and c.get("configDir") == (config_dir or ""):
                return {"logado": c.get("logado"), "motivo": c.get("motivo") or "", "doCache": True}
        except (OSError, ValueError) as e:
            print(f"[saude] cache de login ilegivel em {cache} ({e}); medindo de novo", file=sys.stderr)
    binario = _claude_bin()
    if not binario:
        return {"logado": None, "motivo": "não achei o binário do claude para conferir o login"}
    env = dict(os.environ)
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    try:
        r = subprocess.run([binario, "auth", "status", "--json"], capture_output=True, text=True,
                           timeout=15, env=env)
        d = json.loads(r.stdout or "{}")
        logado = d.get("loggedIn")
        res = {"logado": logado if isinstance(logado, bool) else None,
               "motivo": f"authMethod={d.get('authMethod')}"}
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        res = {"logado": None, "motivo": f"claude auth status falhou: {e}"}
    if cache and res["logado"] is not None:
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({"em": time.time(), "configDir": config_dir or "", **res}))
        except OSError as e:
            print(f"[saude] nao consegui gravar o cache de login em {cache}: {e}", file=sys.stderr)
    return res


def diagnosticar(slug=None, jsonl=None, agora=None, checar_vida=True, vivo=None, checar_login=None):
    """O diagnostico da sessao viva do agente (ou do transcript dado). Devolve
    (publico, interno). Nunca levanta: falha de leitura vira 'indeterminado' COM o
    motivo, porque erro aqui nao pode virar selo verde nem vermelho."""
    agora = agora or datetime.now(timezone.utc)
    slug = slug if slug is not None else (os.environ.get("DGCLAW_SLUG") or "")
    interno = {"modo": inject.resolve_mode()}
    if checar_login is None:
        checar_login = not jsonl and (os.environ.get("DGCLAW_SAUDE_CHECAR_LOGIN", "on").lower()
                                      not in ("0", "off", "no", "false"))
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.environ.get("DGCLAW_CLAUDE_CONFIG_DIR") or None

    publico, interno = _diagnosticar(slug, jsonl, agora, checar_vida, vivo, interno)

    # O login, conferido sem gastar turno. So rebaixa um diagnostico que nao tinha
    # problema mais grave: "sem login" nao apaga uma recusa nem um limite.
    if checar_login and publico["tipo"] in ("ok", "sem_resposta", "desconhecido", "sessao_caida") \
            and publico["estado"] != "indeterminado":
        cfg = (interno.get("cardConfigDir") or config_dir)
        login = estado_do_login(cfg)
        interno["login"] = login
        if login["logado"] is False:
            publico = _saida("inativo" if publico["estado"] == "inativo" else "atencao", "login",
                             "login", "refazer_login", trecho="claude auth status: loggedIn=false",
                             sid=publico.get("sessionId"), agora=agora)
    return publico, interno


def _diagnosticar(slug, jsonl, agora, checar_vida, vivo, interno):
    if vivo is None and checar_vida and not jsonl:
        modo = interno["modo"]
        if modo == "bunker":
            card = inject._bunker_estado()
            if card is not None:
                env_extra = ((card.get("config") or {}).get("envExtra") or {})
                if env_extra.get("CLAUDE_CONFIG_DIR"):
                    interno["cardConfigDir"] = env_extra["CLAUDE_CONFIG_DIR"]
            if card is None:
                return _indeterminado(
                    "Não consegui falar com a plataforma que hospeda o agente, então não sei como ele está.",
                    "Espere um minuto. Se continuar, avise quem cuida do sistema.", agora), interno
            interno["cardStatus"] = card.get("status")
            vivo = inject._bunker_vivo(card)
            if not vivo:
                erro = " ".join(str(card.get(k) or "") for k in ("error", "statusReason"))
                interno["cardErro"] = erro.strip() or None
        else:
            vivo = inject.is_session_alive(slug)

    caminho = jsonl or inject.live_transcript(slug)
    interno["transcript"] = caminho
    if not caminho:
        if vivo is False:
            erro = interno.get("cardErro") or ""
            if erro and _RE_LOGIN.search(erro):
                return _saida("inativo", "login", "login", "refazer_login", trecho=erro, agora=agora), interno
            return _saida("inativo", "sessao_caida", "sessao_caida", "reiniciar", agora=agora), interno
        return _indeterminado(
            "A sessão dele está de pé, mas ainda não achei o diário dela para conferir as respostas. "
            "Isso é normal logo depois de ele subir, antes da primeira conversa.",
            "Mande uma mensagem e veja se ele responde.", agora), interno

    try:
        regs, cortado = ler_cauda(caminho)
        mtime = os.path.getmtime(caminho)
    except OSError as e:
        print(f"[saude] nao consegui ler o transcript {caminho}: {e}", file=sys.stderr)
        return _indeterminado(f"Não consegui ler o diário da sessão dele ({e.strerror or e}).",
                              "Avise quem cuida do sistema: o registro do painel diz qual arquivo falhou.",
                              agora), interno
    interno["cortadoNoInicio"] = cortado
    publico, extra = analisar(regs, agora=agora, mtime=mtime, sid_arquivo=Path(caminho).stem)
    interno.update(extra)

    if vivo is False:
        # Sessao caida. Se o que derrubou foi veneno na conversa, retomar traz o
        # veneno de volta: a recomendacao muda.
        veneno = publico["tipo"] in ("recusa", "contexto")
        if publico["tipo"] == "login":
            publico["estado"] = "inativo"
            return publico, interno
        base = _saida("inativo", "sessao_caida", "sessao_caida_veneno" if veneno else "sessao_caida",
                      "modo_seguro" if veneno else "reiniciar",
                      trecho=publico.get("trecho") if veneno else None,
                      desde=None, sid=publico.get("sessionId"), agora=agora)
        if veneno:
            base["desde"] = publico.get("desde")
            base["ocorrencias"] = publico.get("ocorrencias", 0)
        return base, interno
    return publico, interno


def main():
    ap = argparse.ArgumentParser(description="Saude da resposta do agente DG Claw.")
    ap.add_argument("--json", action="store_true", help="saida JSON (contrato)")
    ap.add_argument("--jsonl", help="transcript a analisar (default: o da sessao viva)")
    ap.add_argument("--slug", default=None)
    ap.add_argument("--interno", action="store_true",
                    help="inclui o bloco _interno (caminhos do servidor; NUNCA para o navegador)")
    ap.add_argument("--agora", help="relogio fixo ISO8601 (testes)")
    ap.add_argument("--sem-checar-vida", action="store_true", help="nao pergunta se a sessao esta de pe")
    ap.add_argument("--vivo", action="store_true", help="afirma que a sessao esta de pe (testes)")
    ap.add_argument("--morto", action="store_true", help="afirma que a sessao caiu (testes)")
    a = ap.parse_args()

    agora = None
    if a.agora:
        agora = datetime.fromisoformat(a.agora.replace("Z", "+00:00"))
        if agora.tzinfo is None:
            agora = agora.replace(tzinfo=timezone.utc)
    vivo = True if a.vivo else False if a.morto else None
    publico, interno = diagnosticar(a.slug, a.jsonl, agora=agora,
                                    checar_vida=not a.sem_checar_vida, vivo=vivo)
    if a.interno:
        publico = dict(publico, _interno=interno)
    if a.json:
        print(json.dumps(publico, ensure_ascii=False))
    else:
        print(f"[{publico['estado']}] {publico['tipo']}: {publico['frase']}"
              + (f" | trecho: {publico['trecho']}" if publico.get("trecho") else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
