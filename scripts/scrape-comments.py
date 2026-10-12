#!/usr/bin/env python3
"""scrape-comments.py (DG Claw) — Extrai comentarios COM user_id via API privada do IG.

Versao GENERICA (nada de persona hardcoded). A Graph API oficial NAO retorna o
username/user_id de quem comentou; este script preenche essa lacuna lendo a API
privada do Instagram autenticada por COOKIES de login.

Resolucao de paths (nesta ordem):
  --workspace <dir>  |  $DGCLAW_WORKSPACE  |  pai do diretorio do script
    -> data/posts.jsonl, data/scraped_comments.json, persona/followers/
  cookies:
    --cookies <file> (repetivel)  |  $DGCLAW_IG_COOKIES (lista separada por ':')
    |  instagram.json -> cookiesPath  |  <ws>/.dgclaw/creds/cookies.txt

REGRA DE SEGURANCA:
  - cada comentario ganha {field}_marked + {field}_flags (datamarking via untrusted.py).
    O consumidor (cron) le 'text_marked' e pula se 'text_flags' tiver injection_*/url_external.
  - se NENHUM cookie valido existir -> falha com mensagem clara (rc 3). O cron, ao ver
    o scrape falhar, NAO responde comentarios (regra inviolavel).

Uso:
  python3 scrape-comments.py --posts 15
  python3 scrape-comments.py --days 3 --workspace ~/dgclaw/ana
  python3 scrape-comments.py --update-followers
"""

import json
import sys
import os
import http.cookiejar
from pathlib import Path
from datetime import datetime, timedelta, timezone

try:
    import requests
except ImportError:
    print("ERRO: a lib 'requests' nao esta instalada.", file=sys.stderr)
    sys.exit(2)

# Sanitizer de conteudo externo (datamarking + red-flags).
sys.path.insert(0, str(Path(__file__).parent))
try:
    from untrusted import mark_field  # noqa: E402
except ImportError:
    def mark_field(obj, field):  # fallback no-op
        return obj

SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'


def resolve_workspace(argv):
    for i, a in enumerate(argv):
        if a == "--workspace" and i + 1 < len(argv):
            return Path(argv[i + 1])
    env = os.environ.get("DGCLAW_WORKSPACE")
    if env:
        return Path(env)
    return Path(__file__).parent.parent


def resolve_cookie_files(argv, ws):
    """Lista de cookie files a tentar, na ordem. Para no primeiro que funcionar."""
    files = []
    for i, a in enumerate(argv):
        if a == "--cookies" and i + 1 < len(argv):
            files.append(Path(argv[i + 1]))
    env = os.environ.get("DGCLAW_IG_COOKIES")
    if env:
        files += [Path(x) for x in env.split(":") if x]
    # instagram.json -> cookiesPath
    ig_json = ws / ".dgclaw" / "instagram.json"
    if ig_json.exists():
        try:
            cfg = json.loads(ig_json.read_text(encoding="utf-8"))
            cp = cfg.get("cookiesPath")
            if cp:
                files.append(Path(cp))
        except (json.JSONDecodeError, OSError):
            pass
    # default
    files.append(ws / ".dgclaw" / "creds" / "cookies.txt")
    # de-dup preservando ordem
    seen, out = set(), []
    for f in files:
        if str(f) not in seen:
            seen.add(str(f))
            out.append(f)
    return out


def shortcode_to_media_id(shortcode):
    media_id = 0
    for char in shortcode:
        media_id = media_id * 64 + SHORTCODE_ALPHABET.index(char)
    return media_id


def load_session_from_cookies(cookie_file):
    if not cookie_file.exists():
        return None
    cj = http.cookiejar.MozillaCookieJar(cookie_file)
    try:
        cj.load(ignore_discard=True, ignore_expires=True)
    except Exception:
        return None
    session = requests.Session()
    for cookie in cj:
        session.cookies.set(cookie.name, cookie.value, domain=cookie.domain)
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
    })
    return session


def get_recent_posts(data_dir):
    posts_file = data_dir / "posts.jsonl"
    if not posts_file.exists():
        print(f"AVISO: posts.jsonl nao encontrado em {posts_file}", file=sys.stderr)
        return []
    posts = []
    with open(posts_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                post = json.loads(line)
            except json.JSONDecodeError:
                continue
            if post.get('postUrl') and post.get('status') == 'PUBLICADO':
                url = post['postUrl']
                if '/p/' in url:
                    shortcode = url.split('/p/')[1].rstrip('/')
                elif '/reel/' in url:
                    shortcode = url.split('/reel/')[1].rstrip('/')
                else:
                    continue
                post['shortcode'] = shortcode
                posts.append(post)
    posts.reverse()
    return posts


def fetch_comments_for_post(session, shortcode, max_comments=500):
    """Retorna (comments_list, rate_limited_bool)."""
    media_id = shortcode_to_media_id(shortcode)
    comments_url = f"https://www.instagram.com/api/v1/media/{media_id}/comments/"
    all_comments = []
    next_min_id = None
    rate_limited = False

    while len(all_comments) < max_comments:
        params = {}
        if next_min_id:
            params['min_id'] = next_min_id
        try:
            resp = session.get(comments_url, params=params, timeout=15)
            if resp.status_code == 429:
                print("   AVISO: rate limit (429)", file=sys.stderr)
                rate_limited = True
                break
            elif resp.status_code in (401, 403):
                print(f"   AVISO: auth {resp.status_code} — cookies expirados?", file=sys.stderr)
                rate_limited = True
                break
            elif resp.status_code != 200:
                print(f"   ERRO {resp.status_code}: {resp.text[:100]}", file=sys.stderr)
                break
            try:
                data = resp.json()
            except (json.JSONDecodeError, ValueError):
                print("   AVISO: resposta nao-JSON (cookies expirados?)", file=sys.stderr)
                rate_limited = True
                break
            comments = data.get('comments', [])
            for c in comments:
                user = c.get('user', {})
                comment_data = {
                    "postId": str(media_id),
                    "postShortcode": shortcode,
                    "commentId": str(c.get('pk')),
                    "instagramId": str(user.get('pk')) if user.get('pk') else None,
                    "username": user.get('username'),
                    "text": c.get('text', ''),
                    "createdAt": datetime.fromtimestamp(c.get('created_at', 0)).isoformat() if c.get('created_at') else None,
                    "isReply": c.get('parent_comment_id') is not None,
                }
                mark_field(comment_data, "text")
                mark_field(comment_data, "username")
                all_comments.append(comment_data)
            if data.get('next_min_id'):
                next_min_id = data['next_min_id']
            else:
                break
        except Exception as e:
            print(f"   ERRO: {e}", file=sys.stderr)
            break
    return all_comments, rate_limited


def scrape_comments(ws, num_posts=None, num_days=3, output_file=None, cookie_files=None):
    data_dir = ws / "data"
    print("=" * 60)
    print("SCRAPE DE COMENTARIOS — API PRIVADA DO INSTAGRAM")
    print("=" * 60)

    posts = get_recent_posts(data_dir)
    if not posts:
        print("ERRO: nenhum post publicado encontrado em data/posts.jsonl", file=sys.stderr)
        return None

    if num_posts:
        posts_to_process = posts[:num_posts]
        print(f"{len(posts)} posts; processando {len(posts_to_process)} (por quantidade)\n")
    else:
        cutoff = (datetime.now() - timedelta(days=num_days)).strftime("%Y-%m-%d")
        posts_to_process = [p for p in posts if (p.get('date', '') or '') >= cutoff]
        print(f"{len(posts)} posts; {len(posts_to_process)} dos ultimos {num_days} dias\n")

    available_cookies = [cf for cf in (cookie_files or []) if cf.exists()]
    if not available_cookies:
        print("ERRO: nenhum arquivo de cookies de login encontrado.", file=sys.stderr)
        print("      O scrape do IG depende de cookies de uma sessao logada.", file=sys.stderr)
        print("      Configure cookiesPath no instagram.json ou passe --cookies <file>.", file=sys.stderr)
        sys.exit(3)

    all_comments = []
    posts_processed = 0
    post_index = 0

    for cookie_idx, cookie_file in enumerate(available_cookies):
        if post_index >= len(posts_to_process):
            break
        session = load_session_from_cookies(cookie_file)
        if not session:
            print(f"AVISO: cookies invalidos em {cookie_file.name}, tentando proximo", file=sys.stderr)
            continue
        print(f"Usando cookies: {cookie_file.name}")

        hit_limit = False
        while post_index < len(posts_to_process):
            post = posts_to_process[post_index]
            shortcode = post['shortcode']
            print(f"Post {post_index + 1}: {shortcode} ({post.get('date')} - {post.get('theme', '')})")
            comments, rate_limited = fetch_comments_for_post(session, shortcode, max_comments=500)
            print(f"   {len(comments)} comentarios")

            if rate_limited and len(comments) == 0:
                remaining = len(posts_to_process) - post_index
                if cookie_idx + 1 < len(available_cookies):
                    print(f"   rate limited sem dados; trocando de cookies ({remaining} restantes)\n")
                else:
                    print(f"   rate limited e sem mais cookies; {remaining} posts nao processados", file=sys.stderr)
                hit_limit = True
                break

            all_comments.extend(comments)
            posts_processed += 1
            post_index += 1

            if rate_limited:
                remaining = len(posts_to_process) - post_index
                if remaining > 0 and cookie_idx + 1 < len(available_cookies):
                    print(f"   rate limited; trocando de cookies ({remaining} restantes)\n")
                hit_limit = True
                break

        if not hit_limit:
            break

    print(f"Total: {len(all_comments)} comentarios de {posts_processed} posts")

    result = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "postsProcessed": posts_processed,
        "totalComments": len(all_comments),
        "comments": all_comments,
    }
    output_path = Path(output_file) if output_file else (data_dir / "scraped_comments.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"Salvo em: {output_path}")

    # Se NENHUM comentario foi obtido E nada foi processado, sinaliza falha pro cron parar.
    if posts_processed == 0:
        print("ERRO: scrape nao processou nenhum post (cookies/rate limit).", file=sys.stderr)
        sys.exit(3)

    check_cookie_expiry(available_cookies)
    return result


def check_cookie_expiry(cookie_files, warn_days=7):
    warnings = []
    now = datetime.now().timestamp()
    for cookie_file in cookie_files:
        if not cookie_file.exists():
            continue
        try:
            cj = http.cookiejar.MozillaCookieJar(cookie_file)
            cj.load(ignore_discard=True, ignore_expires=True)
            expiry = None
            for cookie in cj:
                if cookie.name == "sessionid" and cookie.expires:
                    expiry = cookie.expires
                    break
            if not expiry:
                warnings.append(f"{cookie_file.name}: sem sessionid")
                continue
            days_left = (expiry - now) / 86400
            if days_left <= 0:
                warnings.append(f"{cookie_file.name}: cookies EXPIRADOS")
            elif days_left <= warn_days:
                warnings.append(f"{cookie_file.name}: expiram em {int(days_left)} dias")
        except Exception as e:
            warnings.append(f"{cookie_file.name}: erro {e}")
    if warnings:
        print("\nAVISO DE COOKIES (renovar antes de expirar):", file=sys.stderr)
        for w in warnings:
            print(f"   {w}", file=sys.stderr)
    return warnings


def parse_comment_date(created_at):
    if not created_at:
        return None
    try:
        if 'T' in str(created_at):
            return datetime.fromisoformat(str(created_at).replace('Z', '+00:00')).strftime("%Y-%m-%d")
        return datetime.fromtimestamp(int(created_at)).strftime("%Y-%m-%d")
    except Exception:
        return None


def update_followers_from_scrape(ws, scrape_file=None):
    data_dir = ws / "data"
    followers_dir = ws / "persona" / "followers"
    path = Path(scrape_file) if scrape_file else (data_dir / "scraped_comments.json")
    if not path.exists():
        print("ERRO: scrape nao encontrado. Rode o scrape primeiro.", file=sys.stderr)
        sys.exit(1)
    data = json.loads(path.read_text(encoding='utf-8'))
    comments = data.get("comments", [])

    by_user = {}
    for c in comments:
        uid = c.get("instagramId")
        if not uid:
            continue
        u = by_user.setdefault(uid, {"instagramId": uid, "username": c.get("username"), "comments": [], "dates": []})
        u["comments"].append(c)
        d = parse_comment_date(c.get("createdAt"))
        if d:
            u["dates"].append(d)
        if c.get("username"):
            u["username"] = c.get("username")

    print(f"{len(by_user)} usuarios unicos")
    followers_dir.mkdir(parents=True, exist_ok=True)
    created = updated = 0

    for uid, ud in by_user.items():
        filepath = followers_dir / f"{uid}.json"
        dates = sorted(ud["dates"]) if ud["dates"] else []
        today = datetime.now().strftime("%Y-%m-%d")
        first_date = dates[0] if dates else today
        last_date = dates[-1] if dates else today
        history = [{
            "date": parse_comment_date(c.get("createdAt")) or "?",
            "text": c.get("text", "")[:100],
            "postShortcode": c.get("postShortcode"),
        } for c in ud["comments"][-5:]]
        count = len(ud["comments"])
        tier = "newcomer"
        if count >= 10:
            tier = "close"
        elif count >= 4:
            tier = "regular"
        elif count >= 2:
            tier = "returning"

        if filepath.exists():
            f = json.loads(filepath.read_text(encoding='utf-8'))
            if ud["username"] and f.get("username") != ud["username"]:
                if ud["username"] not in f.get("usernameHistory", []):
                    f.setdefault("usernameHistory", []).append(ud["username"])
                f["username"] = ud["username"]
            f["interactionCount"] = max(f.get("interactionCount", 0), count)
            f["tier"] = tier
            existing_first = f.get("firstCommentDate") or f.get("firstSeen")
            f["firstCommentDate"] = min(existing_first, first_date) if existing_first else first_date
            f["lastCommentDate"] = last_date
            f["lastSeen"] = today
            f["recentComments"] = history
            if count >= 3 and not f.get("knownName") and not f.get("nameRequested"):
                f["askNameNext"] = True
            updated += 1
        else:
            f = {
                "instagramId": uid, "tempId": None, "username": ud["username"],
                "usernameHistory": [ud["username"]] if ud["username"] else [],
                "knownName": None, "nameRequested": False, "tier": tier,
                "interactionCount": count, "firstSeen": today, "lastSeen": today,
                "firstCommentDate": first_date, "lastCommentDate": last_date,
                "sentiment": "neutral", "emotionalBond": None, "myPerception": None,
                "lifeDetails": {}, "emotionalDiary": [], "interactionStrategy": {},
                "recentComments": history, "askNameNext": count >= 3,
            }
            created += 1
        filepath.write_text(json.dumps(f, indent=2, ensure_ascii=False), encoding='utf-8')

    print(f"{created} criados, {updated} atualizados em {followers_dir}")


def main():
    argv = sys.argv[1:]
    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return
    ws = resolve_workspace(argv)

    if "--update-followers" in argv:
        scrape_file = None
        for i, a in enumerate(argv):
            if a == "--file" and i + 1 < len(argv):
                scrape_file = argv[i + 1]
        update_followers_from_scrape(ws, scrape_file)
        return

    num_posts = None
    num_days = 3
    output_file = None
    for i, a in enumerate(argv):
        if a == "--posts" and i + 1 < len(argv):
            num_posts = int(argv[i + 1])
        if a == "--days" and i + 1 < len(argv):
            num_days = int(argv[i + 1])
        if a == "--output" and i + 1 < len(argv):
            output_file = argv[i + 1]

    cookie_files = resolve_cookie_files(argv, ws)
    scrape_comments(ws, num_posts, num_days, output_file, cookie_files)


if __name__ == "__main__":
    main()
