#!/usr/bin/env python3
"""search-follower.py (DG Claw) — Busca/cria/atualiza seguidor por ID ou username.

Versao GENERICA (nada de persona hardcoded). A API do Instagram as vezes retorna
so o ID (perfis privados) — este script reconcilia ID <-> username e mantem os
TIERS de relacionamento (newcomer/returning/regular/close/negative).

Resolucao do diretorio de followers (nesta ordem):
  --workspace <dir>  |  $DGCLAW_WORKSPACE  |  pai do diretorio do script
    -> <ws>/persona/followers/

Uso:
  python3 search-follower.py --id 12345678901
  python3 search-follower.py --username mari_santos_rj
  python3 search-follower.py --id 12345 --username mari --create --increment
  python3 search-follower.py --list
  python3 search-follower.py --stats
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime


def resolve_followers_dir(argv):
    ws = None
    for i, a in enumerate(argv):
        if a == "--workspace" and i + 1 < len(argv):
            ws = Path(argv[i + 1])
    if ws is None:
        env = os.environ.get("DGCLAW_WORKSPACE")
        ws = Path(env) if env else Path(__file__).parent.parent
    return ws / "persona" / "followers"


FOLLOWERS_DIR = resolve_followers_dir(sys.argv[1:])

# Rate-limit por follower por sessao de cron. Objetivo: dificultar memory poisoning
# via flood de comentarios. NAO bloqueia — loga excesso no stderr p/ auditoria.
SLUG = os.environ.get("DGCLAW_SLUG", "agent")
SESSION_COUNTER_FILE = Path(f"/tmp/{SLUG}-follower-increments.json")
SESSION_COUNTER_TTL = 1800  # 30min
RATE_LIMIT_PER_SESSION = 5

TIER_THRESHOLDS = {"newcomer": 1, "returning": 2, "regular": 4, "close": 10}


def _load_session_counter():
    try:
        if not SESSION_COUNTER_FILE.exists():
            return {}
        age = datetime.now().timestamp() - SESSION_COUNTER_FILE.stat().st_mtime
        if age > SESSION_COUNTER_TTL:
            return {}
        return json.loads(SESSION_COUNTER_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _bump_counter(instagram_id):
    counter = _load_session_counter()
    counter[str(instagram_id)] = counter.get(str(instagram_id), 0) + 1
    try:
        SESSION_COUNTER_FILE.write_text(json.dumps(counter))
        os.chmod(SESSION_COUNTER_FILE, 0o666)
    except OSError:
        pass
    return counter[str(instagram_id)]


def find_by_id(instagram_id):
    filepath = FOLLOWERS_DIR / f"{instagram_id}.json"
    if filepath.exists():
        return json.loads(filepath.read_text(encoding='utf-8'))
    return None


def find_by_username(username):
    if not FOLLOWERS_DIR.exists():
        return None
    username_lower = username.lower()
    for filepath in FOLLOWERS_DIR.glob("*.json"):
        try:
            data = json.loads(filepath.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        if (data.get("username") or "").lower() == username_lower:
            return data
        if username_lower in [u.lower() for u in data.get("usernameHistory", [])]:
            return data
    return None


def calculate_tier(interaction_count, sentiment="neutral"):
    if sentiment == "negative":
        return "negative"
    if interaction_count >= TIER_THRESHOLDS["close"]:
        return "close"
    if interaction_count >= TIER_THRESHOLDS["regular"]:
        return "regular"
    if interaction_count >= TIER_THRESHOLDS["returning"]:
        return "returning"
    if interaction_count >= TIER_THRESHOLDS["newcomer"]:
        return "newcomer"
    return "stranger"


def create_new_follower(instagram_id, username=None):
    today = datetime.now().strftime("%Y-%m-%d")
    return {
        "instagramId": instagram_id, "tempId": None, "username": username,
        "usernameHistory": [username] if username else [],
        "knownName": None, "nameRequested": False, "nameObtainedOn": None,
        "tier": "newcomer", "interactionCount": 1,
        "firstSeen": today, "lastSeen": today,
        "firstCommentDate": today, "lastCommentDate": today,
        "sentiment": "neutral", "emotionalBond": None, "myPerception": None,
        "lifeDetails": {}, "emotionalDiary": [],
        "interactionStrategy": {"always": None, "ifSadComment": None, "ifAbsentForLong": None, "never": None},
        "recentComments": [], "askNameNext": False,
    }


def update_follower(follower, username=None, increment_interaction=False):
    today = datetime.now().strftime("%Y-%m-%d")
    if username and follower.get("username") != username:
        if username not in follower.get("usernameHistory", []):
            follower.setdefault("usernameHistory", []).append(username)
        follower["username"] = username
    follower["lastSeen"] = today
    if increment_interaction:
        session_count = _bump_counter(follower.get("instagramId"))
        if session_count > RATE_LIMIT_PER_SESSION:
            sys.stderr.write(
                f"[RATE_LIMIT_WARN] follower {follower.get('instagramId')} "
                f"({follower.get('username')}): {session_count} increments nesta sessao "
                f"(cap={RATE_LIMIT_PER_SESSION}) — possivel flood\n"
            )
        follower["interactionCount"] = follower.get("interactionCount", 0) + 1
        follower["lastCommentDate"] = today
        follower["tier"] = calculate_tier(follower["interactionCount"], follower.get("sentiment", "neutral"))
        if follower["interactionCount"] == 3 and not follower.get("nameRequested"):
            follower["askNameNext"] = True
    return follower


def save_follower(follower):
    instagram_id = follower.get("instagramId")
    if not instagram_id:
        return False
    FOLLOWERS_DIR.mkdir(parents=True, exist_ok=True)
    (FOLLOWERS_DIR / f"{instagram_id}.json").write_text(
        json.dumps(follower, indent=2, ensure_ascii=False), encoding='utf-8')
    return True


def list_all_followers():
    if not FOLLOWERS_DIR.exists():
        return []
    followers = []
    for filepath in FOLLOWERS_DIR.glob("*.json"):
        try:
            data = json.loads(filepath.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        followers.append({
            "instagramId": data.get("instagramId"), "username": data.get("username"),
            "knownName": data.get("knownName"), "tier": data.get("tier"),
            "interactionCount": data.get("interactionCount"), "lastSeen": data.get("lastSeen"),
        })
    return sorted(followers, key=lambda x: x.get("interactionCount", 0) or 0, reverse=True)


def get_stats():
    if not FOLLOWERS_DIR.exists():
        return {"total": 0}
    stats = {"total": 0, "byTier": {}, "withName": 0, "askNamePending": 0}
    for filepath in FOLLOWERS_DIR.glob("*.json"):
        try:
            data = json.loads(filepath.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        stats["total"] += 1
        tier = data.get("tier", "unknown")
        stats["byTier"][tier] = stats["byTier"].get(tier, 0) + 1
        if data.get("knownName"):
            stats["withName"] += 1
        if data.get("askNameNext"):
            stats["askNamePending"] += 1
    return stats


def main():
    args = sys.argv[1:]
    if not args or "--help" in args:
        print(__doc__)
        return
    if "--list" in args:
        print(json.dumps(list_all_followers(), indent=2, ensure_ascii=False))
        return
    if "--stats" in args:
        print(json.dumps(get_stats(), indent=2, ensure_ascii=False))
        return

    instagram_id = username = None
    create = "--create" in args
    increment = "--increment" in args
    for i, arg in enumerate(args):
        if arg == "--id" and i + 1 < len(args):
            instagram_id = args[i + 1]
        if arg == "--username" and i + 1 < len(args):
            username = args[i + 1]

    result = None
    if instagram_id:
        result = find_by_id(instagram_id)
        if result:
            result = update_follower(result, username, increment)
            if increment or username:
                save_follower(result)
    if not result and username:
        result = find_by_username(username)
        if result:
            result = update_follower(result, username, increment)
            if increment:
                save_follower(result)
    if not result and create:
        if instagram_id:
            result = create_new_follower(instagram_id, username)
            save_follower(result)
        elif username:
            result = create_new_follower(f"username_{username}", username)
            save_follower(result)

    if result:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({"found": False, "instagramId": instagram_id,
                          "username": username, "suggestion": "Use --create para criar"}))


if __name__ == "__main__":
    main()
