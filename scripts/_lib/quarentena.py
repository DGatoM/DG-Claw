#!/usr/bin/env python3
"""quarentena.py (DG Claw) — O que NUNCA volta ao agente depois de um modo de seguranca.

POR QUE EXISTE (05/10/2026). O modo de seguranca (_lib/reinicio.py) sobe uma sessao nova
sem a conversa que travou e guarda a mensagem culpada em <ws>/.dgclaw/quarentena/. Mas a
conversa antiga continua no disco, e varias rotinas leem o disco e entregam o que acharam
ao agente: a working memory ("Ultimas conversas", "Agora", "Ontem"), a reflexao da noite
("o que se falou hoje"), a busca em conversas do recall e a memoria semantica. Qualquer
uma delas traria o texto envenenado de volta, e foi exatamente assim que a Isa travou a
segunda vez em 30/09: um recado mandou ela reler a conversa morta. Este modulo e a regra
unica que todas essas portas consultam.

O QUE CONTA COMO QUARENTENA
  1. Sessao e horario: o que a sessao anterior registrou DEPOIS do ponto de corte
     (`cortarDepoisDe`). Corte vazio quer dizer a sessao inteira (no segundo corte da Isa,
     a sessao toda nasceu do recado que mandou reler o veneno). Vale para quem sabe de
     que sessao e de que hora veio o trecho (thread_log, indice da busca em conversas).
  2. Texto: qualquer trecho que repita 6 palavras seguidas de uma mensagem em quarentena
     (ou a mensagem inteira, se ela for curta). Vale para quem so tem o texto (a memoria
     semantica, o recado que o recall monta).

DE ONDE VEM A REGRA: todo <ws>/.dgclaw/quarentena/*.json (para sempre: o texto nao volta
nem depois que o modo de seguranca acaba) e a marca <ws>/.dgclaw/modo-seguro.json enquanto
ela existir. Arquivo ilegivel e registrado no stderr e ignorado; nunca derruba quem chamou.

CLI:
  quarentena.py filtrar-linhas [--workspace WS]   stdin -> stdout sem as linhas em quarentena
  quarentena.py status [--workspace WS]           quantas regras, em JSON
"""
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

JANELA = 6       # palavras seguidas que denunciam a mensagem
MINIMO = 3       # mensagem com menos palavras que isto nao vira regra de texto ("oi", "e ai?")


def _sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def palavras(texto):
    return re.findall(r"\w+", _sem_acento(str(texto or "")).lower())


def _data(s):
    """ISO com ou sem Z, com ou sem fuso (o thread_log grava sem). Sem fuso = UTC."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Regras:
    def __init__(self):
        self.cortes = {}       # sessao -> datetime | None (None = a sessao inteira)
        self.janelas = set()   # tuplas de JANELA palavras
        self.curtas = []       # mensagens curtas, como " a b c "

    def __bool__(self):
        return bool(self.cortes or self.janelas or self.curtas)

    def _sessao(self, sessao, corte):
        if not sessao:
            return
        dt = _data(corte)
        if sessao in self.cortes:
            antigo = self.cortes[sessao]
            # dois incidentes na mesma sessao: vale o corte mais cedo (o mais restritivo)
            self.cortes[sessao] = None if (antigo is None or dt is None) else min(antigo, dt)
        else:
            self.cortes[sessao] = dt

    def _texto(self, texto):
        p = palavras(texto)
        if len(p) < MINIMO:
            return
        if len(p) < JANELA:
            self.curtas.append(" " + " ".join(p) + " ")
            return
        for i in range(len(p) - JANELA + 1):
            self.janelas.add(tuple(p[i:i + JANELA]))

    def texto_bloqueado(self, texto):
        if not (self.janelas or self.curtas):
            return False
        p = palavras(texto)
        if self.curtas:
            corrido = " " + " ".join(p) + " "
            if any(c in corrido for c in self.curtas):
                return True
        return any(tuple(p[i:i + JANELA]) in self.janelas for i in range(len(p) - JANELA + 1))

    def evento_bloqueado(self, sessao, ts, texto):
        """sessao = o id (nome do .jsonl sem extensao). ts = horario do trecho."""
        if sessao in self.cortes:
            corte = self.cortes[sessao]
            if corte is None:
                return True
            quando = _data(ts)
            if quando is None or quando > corte:
                return True  # sem horario legivel, na duvida fica de fora
        return self.texto_bloqueado(texto)


def _ler_json(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"[quarentena] ignorei {p}: {e}", file=sys.stderr)
        return None


def carregar(ws=None):
    ws = Path(ws or os.environ.get("DGCLAW_WORKSPACE") or os.getcwd())
    dg = ws / ".dgclaw"
    r = Regras()
    pasta = dg / "quarentena"
    if pasta.is_dir():
        for p in sorted(pasta.glob("*.json")):
            q = _ler_json(p)
            if not isinstance(q, dict):
                continue
            # A regra de sessao so vale com o corte gravado (reinicio.py grava desde
            # 05/10/2026). Sem a chave, nao da para saber onde comeca o veneno.
            if "cortarDepoisDe" in q:
                r._sessao(q.get("sessaoAnterior"), q.get("cortarDepoisDe"))
            for m in q.get("mensagens") or []:
                r._texto((m or {}).get("texto"))
    marca_p = dg / "modo-seguro.json"
    if marca_p.exists():
        m = _ler_json(marca_p)
        if isinstance(m, dict) and m.get("ativo", True):
            r._sessao(m.get("sessaoAnterior"), m.get("cortarDepoisDe"))
    return r


def filtrar_linhas(texto, regras):
    """Tira as linhas em quarentena. Devolve (texto, quantas saíram)."""
    fora, ficam = 0, []
    for linha in str(texto or "").splitlines():
        if regras.texto_bloqueado(linha):
            fora += 1
        else:
            ficam.append(linha)
    return "\n".join(ficam), fora


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Regra da quarentena do modo de seguranca do DG Claw.")
    ap.add_argument("acao", choices=["filtrar-linhas", "status"])
    ap.add_argument("--workspace", default=None)
    a = ap.parse_args(argv)
    regras = carregar(a.workspace)
    if a.acao == "status":
        print(json.dumps({"sessoes": len(regras.cortes), "janelas": len(regras.janelas),
                          "curtas": len(regras.curtas)}))
        return 0
    entrada = sys.stdin.read()
    saida, fora = filtrar_linhas(entrada, regras)
    if fora:
        print(f"[quarentena] {fora} linha(s) em quarentena ficaram de fora", file=sys.stderr)
    if saida.strip():
        sys.stdout.write(saida + ("\n" if entrada.endswith("\n") else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
