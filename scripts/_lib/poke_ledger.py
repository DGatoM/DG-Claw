#!/usr/bin/env python3
"""poke_ledger.py — Recibo deterministico de poke (ACK) pro DG Claw.

PROBLEMA: a injecao de poke na sessao viva (reflection/heartbeat/audit/...) e
fire-and-forget. O inject.py so confirma que CONSEGUIU digitar no /dev/pts, NAO
que a persona leu e executou. Se a sessao estava ocupada (turno em voo) os
keystrokes se perdem em silencio — e ninguem fica sabendo.

SOLUCAO (transporte-agnostica): cada poke "verificavel" ganha uma CHAVE unica e
deixa um RECIBO deterministico quando concluido. Dois sinais de sucesso (basta um):
  1. ACK explicito: a persona roda `poke-ack.sh <slug> <key>` no fim do poke
     (instrucao vai no proprio poke-file). So acontece se ela recebeu E concluiu.
  2. Artefato: um arquivo esperado (ex: memory/<data>.md) escrito DEPOIS do envio
     (rede de seguranca caso a persona esqueca o ACK).
O verificador (poke-verify.py) varre os pendentes vencidos, confere o recibo,
re-injeta K vezes e, esgotado, alerta o dono. Tudo deterministico, ZERO token LLM.

Layout (por agente, sob o workspace):
  <ws>/.dgclaw/pokes/
    pending/<key>.json   poke aguardando recibo
    done/<key>           marcador de ACK/sucesso (touch)
    failed/<key>.json    escalado (esgotou retries sem recibo)
    acks.log             auditoria append-only

CLI (usado por inject.sh / poke-ack.sh / poke-verify.py):
  poke_ledger.py register --ws WS --slug S --tag T [--key K] [--deadline-sec N]
                 [--max-retries N] [--retry-interval-sec N] [--artifact REL]
                 [--retrigger CMD]
  poke_ledger.py ack   --ws WS --key K            # persona confirma
  poke_ledger.py list  --ws WS [--due]            # pendentes (todos ou vencidos)
  poke_ledger.py succeeded --ws WS --key K        # rc 0 se ja tem recibo
"""

import argparse
import json
import os
import sys
import time

# 'key' so pode conter estes chars (vira nome de arquivo; evita path traversal).
_SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def _safe_key(key: str) -> str:
    k = "".join(c for c in (key or "") if c in _SAFE).strip("._-")
    if not k:
        raise ValueError("key vazia/invalida")
    return k


def pokes_dir(ws: str) -> str:
    return os.path.join(ws, ".dgclaw", "pokes")


def _sub(ws: str, *parts) -> str:
    return os.path.join(pokes_dir(ws), *parts)


def _ensure_dirs(ws: str):
    for d in ("pending", "done", "failed"):
        os.makedirs(_sub(ws, d), mode=0o700, exist_ok=True)


def _pending_path(ws: str, key: str) -> str:
    return _sub(ws, "pending", _safe_key(key) + ".json")


def _done_path(ws: str, key: str) -> str:
    return _sub(ws, "done", _safe_key(key))


def _failed_path(ws: str, key: str) -> str:
    return _sub(ws, "failed", _safe_key(key) + ".json")


def _load(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _save(path: str, rec: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f, indent=2)
    os.replace(tmp, path)


def load_pending(ws: str):
    """Lista de records pendentes (dicts)."""
    out = []
    d = _sub(ws, "pending")
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json"):
            continue
        rec = _load(os.path.join(d, fn))
        if rec:
            out.append(rec)
    return out


def register(ws, slug, tag, key=None, deadline_sec=1500, max_retries=2,
             retry_interval_sec=1200, artifact=None, retrigger=None):
    """Cria o pendente (idempotente por key). Se ja existe, so atualiza last_sent
    — NAO mexe em retries_used/deadline (quem governa o retry e o verificador)."""
    _ensure_dirs(ws)
    key = _safe_key(key or f"{tag}-{time.strftime('%Y-%m-%d')}")
    now = int(time.time())
    path = _pending_path(ws, key)
    existing = _load(path)
    if existing:
        existing["last_sent_epoch"] = now
        _save(path, existing)
        return key
    rec = {
        "key": key,
        "slug": slug,
        "tag": tag,
        "created_epoch": now,
        "last_sent_epoch": now,
        "deadline_epoch": now + int(deadline_sec),
        "retries_used": 0,
        "max_retries": int(max_retries),
        "retry_interval_sec": int(retry_interval_sec),
        "artifact": artifact or "",
        # artefato so conta como sucesso se mtime > momento do 1o envio
        "artifact_after_epoch": now,
        "retrigger": retrigger or "",
    }
    _save(path, rec)
    return key


def has_receipt(ws, key) -> bool:
    """True se ja existe recibo (ACK explicito OU artefato fresco)."""
    key = _safe_key(key)
    if os.path.exists(_done_path(ws, key)):
        return True
    rec = _load(_pending_path(ws, key))
    if not rec:
        return False
    art = rec.get("artifact") or ""
    if art:
        ap = art if os.path.isabs(art) else os.path.join(ws, art)
        try:
            if os.path.getmtime(ap) > rec.get("artifact_after_epoch", 0):
                return True
        except OSError:
            pass
    return False


def ack(ws, key):
    """Persona confirma: escreve o marcador done/, loga e remove o pendente."""
    _ensure_dirs(ws)
    key = _safe_key(key)
    now = int(time.time())
    with open(_done_path(ws, key), "w") as f:
        f.write(str(now) + "\n")
    with open(_sub(ws, "acks.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} ACK {key}\n")
    try:
        os.remove(_pending_path(ws, key))
    except OSError:
        pass
    return True


def resolve(ws, key, reason="receipt"):
    """Marca sucesso (recibo via artefato/ack ja detectado) e tira de pending."""
    _ensure_dirs(ws)
    key = _safe_key(key)
    if not os.path.exists(_done_path(ws, key)):
        with open(_done_path(ws, key), "w") as f:
            f.write(f"{int(time.time())} {reason}\n")
    with open(_sub(ws, "acks.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} OK({reason}) {key}\n")
    try:
        os.remove(_pending_path(ws, key))
    except OSError:
        pass


def bump_retry(ws, key):
    """Incrementa retries_used e empurra o deadline (chamado pelo verificador)."""
    key = _safe_key(key)
    path = _pending_path(ws, key)
    rec = _load(path)
    if not rec:
        return None
    rec["retries_used"] = rec.get("retries_used", 0) + 1
    rec["deadline_epoch"] = int(time.time()) + rec.get("retry_interval_sec", 1200)
    rec["last_retry_epoch"] = int(time.time())
    _save(path, rec)
    return rec


def mark_failed(ws, key, note=""):
    """Move pra failed/ (esgotou retries sem recibo). Vira flag pro build-wm/dono."""
    _ensure_dirs(ws)
    key = _safe_key(key)
    rec = _load(_pending_path(ws, key)) or {"key": key}
    rec["failed_epoch"] = int(time.time())
    rec["note"] = note
    _save(_failed_path(ws, key), rec)
    with open(_sub(ws, "acks.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} FAILED {key} {note}\n")
    try:
        os.remove(_pending_path(ws, key))
    except OSError:
        pass


def _cli():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("register")
    r.add_argument("--ws", required=True)
    r.add_argument("--slug", required=True)
    r.add_argument("--tag", required=True)
    r.add_argument("--key")
    r.add_argument("--deadline-sec", type=int, default=1500)
    r.add_argument("--max-retries", type=int, default=2)
    r.add_argument("--retry-interval-sec", type=int, default=1200)
    r.add_argument("--artifact", default=None)
    r.add_argument("--retrigger", default=None)

    a = sub.add_parser("ack")
    a.add_argument("--ws", required=True)
    a.add_argument("--key", required=True)

    s = sub.add_parser("succeeded")
    s.add_argument("--ws", required=True)
    s.add_argument("--key", required=True)

    l = sub.add_parser("list")
    l.add_argument("--ws", required=True)
    l.add_argument("--due", action="store_true", help="so os vencidos (deadline passou)")

    args = ap.parse_args()

    if args.cmd == "register":
        key = register(args.ws, args.slug, args.tag, key=args.key,
                       deadline_sec=args.deadline_sec, max_retries=args.max_retries,
                       retry_interval_sec=args.retry_interval_sec,
                       artifact=args.artifact, retrigger=args.retrigger)
        print(key)
    elif args.cmd == "ack":
        ack(args.ws, args.key)
        print(f"ACK {args.key}")
    elif args.cmd == "succeeded":
        sys.exit(0 if has_receipt(args.ws, args.key) else 1)
    elif args.cmd == "list":
        now = int(time.time())
        for rec in load_pending(args.ws):
            if args.due and now < rec.get("deadline_epoch", 0):
                continue
            print(json.dumps(rec))


if __name__ == "__main__":
    _cli()
