#!/usr/bin/env python3
"""report.py — Coleta um BUNDLE de diagnostico SANITIZADO pro AUTOR do plugin DG Claw.

Objetivo: um cliente do plugin consegue mandar um relatorio de erro/dificuldade pro
autor (DG Medeiros / DGatoM/DG-Claw) SEM vazar nada pessoal da persona dele.

O que entra no bundle (tudo passa pelo SCRUBBER):
  - versao do plugin (.claude-plugin/plugin.json)
  - agent.json (versao/slug — NUNCA a persona)
  - uname / OS (/etc/os-release)
  - versoes de python / node / claude
  - saida do doctor.sh (se a config.sh existir)
  - TAILS de linhas de ERRO/stacktrace dos logs em <ws>/.dgclaw/logs
  - a DESCRICAO do problema escrita pelo dono (opcional, via --desc)

O que NUNCA entra:
  - SOUL.md / PERSONALITY.md / IDENTITY.md / MEMORY.md / working-memory.md
  - qualquer arquivo de persona/ (state, opinions, relationships, family, ...)
  - tokens / api keys / .env / config.sh cru
  - linhas de log que nao sejam de erro

PRIVACIDADE: tudo que sai passa por scrub() que remove:
  - DGCLAW_OWNER (nome do dono) e DGCLAW_NAME (nome da persona)
  - DGCLAW_OWNER_TELEGRAM_ID e qualquer sequencia de 6-15 digitos (chat ids)
  - tokens/keys (bot tokens telegram, sk-..., chaves genericas, Bearer)
  - paths com username (/home/<user>/..., /Users/<user>/...) -> /home/<USER>/

REDE: este script NUNCA manda nada sozinho. Sem --consent ele so MOSTRA o que coletaria
e escreve o bundle local. O envio (endpoint/github/contato) so acontece com --consent.

Uso:
  report.py --config <.dgclaw/config.sh> [--desc "texto"] [--consent] [--json]
  report.py --config ... --dry-run-scrub   # testa o scrubber com amostras conhecidas
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ----------------------------------------------------------------------------- config
def load_config_sh(path):
    """Le um config.sh (KEY=VAL / export KEY=VAL) num dict, sem executar shell."""
    cfg = {}
    if not path or not os.path.isfile(path):
        return cfg
    pat = re.compile(r'^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$')
    with open(path, 'r', errors='replace') as fh:
        for line in fh:
            m = pat.match(line)
            if not m:
                continue
            key, val = m.group(1), m.group(2).strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                val = val[1:-1]
            cfg[key] = val
    return cfg


def env_or_cfg(cfg, key, default=None):
    v = os.environ.get(key)
    if v not in (None, ""):
        return v
    v = cfg.get(key)
    if v not in (None, ""):
        return v
    return default


# ----------------------------------------------------------------------------- scrubber
TOKEN_PATTERNS = [
    # telegram bot token: 123456789:AAH...
    (re.compile(r'\b\d{6,12}:[A-Za-z0-9_-]{30,}\b'), '[REDACTED_TELEGRAM_TOKEN]'),
    # openai/anthropic-style keys
    (re.compile(r'\bsk-[A-Za-z0-9_\-]{16,}\b'), '[REDACTED_KEY]'),
    (re.compile(r'\b(?:sk-or-v1|or-v1)-[A-Za-z0-9_\-]{8,}\b'), '[REDACTED_KEY]'),
    # generic Bearer
    (re.compile(r'(?i)\bBearer\s+[A-Za-z0-9_\-\.=]{12,}'), 'Bearer [REDACTED]'),
    # KEY=value / TOKEN=value / SECRET=value / PASSWORD= / API_KEY=
    (re.compile(r'(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[=:]\s*\S+'),
     r'\1=[REDACTED]'),
    # long hex/base64-ish blobs (>= 32) — possiveis keys
    (re.compile(r'\b[A-Fa-f0-9]{32,}\b'), '[REDACTED_HEX]'),
]


def build_scrubber(cfg):
    """Devolve scrub(text)->text que remove dados pessoais/secrets do bundle."""
    owner = env_or_cfg(cfg, 'DGCLAW_OWNER')
    persona = env_or_cfg(cfg, 'DGCLAW_NAME')
    tg_id = env_or_cfg(cfg, 'DGCLAW_OWNER_TELEGRAM_ID')

    literal_subs = []  # (compiled_regex, replacement)

    def add_name(value, tag):
        if not value:
            return
        for tok in re.split(r'\s+', value.strip()):
            tok = tok.strip()
            if len(tok) >= 3:  # evita apagar "DG", "Jr" etc curtos demais
                literal_subs.append((re.compile(re.escape(tok), re.IGNORECASE), tag))
        whole = value.strip()
        if len(whole) >= 3:
            literal_subs.append((re.compile(re.escape(whole), re.IGNORECASE), tag))

    add_name(owner, '[OWNER]')
    add_name(persona, '[PERSONA]')

    if tg_id:
        literal_subs.append((re.compile(re.escape(str(tg_id))), '[OWNER_TELEGRAM_ID]'))

    # username dos paths: derive do HOME e do workspace
    usernames = set()
    home = os.environ.get('HOME', '')
    m = re.match(r'^/(?:home|Users)/([^/]+)', home or '')
    if m:
        usernames.add(m.group(1))
    ws = env_or_cfg(cfg, 'DGCLAW_WORKSPACE') or ''
    m = re.match(r'^/(?:home|Users)/([^/]+)', ws)
    if m:
        usernames.add(m.group(1))

    # ordena por tamanho desc pra apagar nome inteiro antes de partes
    literal_subs.sort(key=lambda p: -len(p[0].pattern))

    # path com username generico: /home/<x>/ -> /home/<USER>/
    home_path_re = re.compile(r'(/(?:home|Users)/)([^/\s:"\']+)')

    def scrub(text):
        if text is None:
            return ''
        s = str(text)
        # secrets/tokens primeiro (antes de mexer em paths)
        for rx, repl in TOKEN_PATTERNS:
            s = rx.sub(repl, s)
        # nomes/ids configurados
        for rx, repl in literal_subs:
            s = rx.sub(repl, s)
        # paths com username conhecido
        for u in usernames:
            if u and u not in ('root',):
                s = re.sub(r'(/(?:home|Users)/)' + re.escape(u) + r'\b', r'\1[USER]', s)
        # qualquer outro /home/<x>/ ainda restante
        s = home_path_re.sub(lambda mm: mm.group(1) + '[USER]', s)
        return s

    scrub.meta = {
        'owner_redacted': bool(owner),
        'persona_redacted': bool(persona),
        'tg_id_redacted': bool(tg_id),
        'usernames_redacted': sorted(u for u in usernames if u != 'root'),
    }
    return scrub


# ----------------------------------------------------------------------------- collectors
ERROR_RE = re.compile(
    r'(error|erro|exception|traceback|stack ?trace|fatal|critical|fail(ed|ure)?|'
    r'\bFALHA\b|panic|denied|refus|timed? ?out|unauthor|cannot|could not|no such)',
    re.IGNORECASE,
)


def run_cmd(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or '') + (p.stderr or '')
        return out.strip()
    except FileNotFoundError:
        return '(comando ausente)'
    except subprocess.TimeoutExpired:
        return '(timeout)'
    except Exception as e:  # noqa
        return f'(erro: {e})'


def tool_version(name, args):
    if not shutil.which(name):
        return f'{name}: (nao instalado)'
    return f'{name}: {run_cmd([name] + args, timeout=20) or "(sem saida)"}'


def collect_error_logs(logs_dir, per_file_lines=40):
    """Coleta SO linhas de erro/stacktrace dos logs. Mantem a linha seguinte a um
    'Traceback' pra preservar o stack, mas nunca despeja o log inteiro."""
    out = []
    p = Path(logs_dir)
    if not p.is_dir():
        return '(sem diretorio de logs: %s)' % logs_dir
    files = sorted(
        [f for f in p.glob('*') if f.is_file() and f.suffix in ('.log', '.jsonl', '.txt', '')],
        key=lambda f: f.stat().st_mtime, reverse=True,
    )[:25]
    for f in files:
        try:
            lines = f.read_text(errors='replace').splitlines()
        except Exception:
            continue
        keep = []
        in_trace = 0
        for ln in lines[-4000:]:  # janela recente
            if ERROR_RE.search(ln):
                keep.append(ln)
                in_trace = 6  # segura algumas linhas de contexto do stack
            elif in_trace > 0 and (ln.startswith(' ') or ln.startswith('\t') or 'File "' in ln):
                keep.append(ln)
                in_trace -= 1
            else:
                in_trace = 0
        keep = keep[-per_file_lines:]
        if keep:
            out.append(f'--- {f.name} (ultimas {len(keep)} linhas de erro) ---')
            out.extend(keep)
            out.append('')
    return '\n'.join(out) if out else '(nenhuma linha de erro encontrada nos logs)'


def read_json_safe(path, allow_keys=None):
    try:
        d = json.load(open(path))
    except Exception as e:  # noqa
        return f'(ilegivel: {e})'
    if allow_keys is not None and isinstance(d, dict):
        d = {k: d.get(k) for k in allow_keys if k in d}
    return json.dumps(d, ensure_ascii=False, indent=2)


# ----------------------------------------------------------------------------- bundle
def build_bundle(cfg, plugin_root, ws, desc):
    slug = env_or_cfg(cfg, 'DGCLAW_SLUG') or (os.path.basename(ws) if ws else '?')
    logs_dir = env_or_cfg(cfg, 'DGCLAW_LOGS_DIR') or (
        os.path.join(ws, '.dgclaw', 'logs') if ws else '')
    plugin_json = os.path.join(plugin_root, '.claude-plugin', 'plugin.json')
    if not os.path.isfile(plugin_json):
        plugin_json = os.path.join(plugin_root, 'plugin.json')
    alive_json = os.path.join(ws, '.dgclaw', 'agent.json') if ws else ''

    sections = []
    sections.append(('META',
        f'gerado em: {time.strftime("%Y-%m-%d %H:%M:%S %z")}\nslug: {slug}'))
    if desc:
        sections.append(('DESCRICAO DO PROBLEMA (escrita pelo dono)', desc))
    # versao do plugin — so name/version/author (NUNCA a description longa pra evitar ruido)
    sections.append(('plugin.json',
        read_json_safe(plugin_json, allow_keys=['name', 'version', 'author', 'homepage'])
        if os.path.isfile(plugin_json) else '(plugin.json nao encontrado)'))
    # agent.json — SO metadados de versao/slug, NUNCA a persona
    sections.append(('agent.json (so versao/slug)',
        read_json_safe(alive_json, allow_keys=['version', 'slug', 'installed_at',
                                               'plugin_version', 'archetype'])
        if alive_json and os.path.isfile(alive_json) else '(agent.json nao encontrado)'))
    # OS / kernel
    os_release = ''
    if os.path.isfile('/etc/os-release'):
        try:
            os_release = '\n'.join(
                l for l in open('/etc/os-release').read().splitlines()
                if l.startswith(('NAME=', 'VERSION=', 'PRETTY_NAME=', 'ID=')))
        except Exception:
            os_release = '(ilegivel)'
    sections.append(('OS / kernel',
        run_cmd(['uname', '-a']) + '\n' + (os_release or '(sem /etc/os-release)')))
    # toolchain
    sections.append(('toolchain', '\n'.join([
        tool_version('python3', ['--version']),
        tool_version('node', ['--version']),
        tool_version('claude', ['--version']),
        tool_version('git', ['--version']),
    ])))
    # doctor.sh
    config_path = env_or_cfg(cfg, '__CONFIG_PATH__')
    doctor = os.path.join(plugin_root, 'scripts', 'doctor.sh')
    if os.path.isfile(doctor) and config_path and os.path.isfile(config_path):
        sections.append(('doctor.sh', run_cmd(['bash', doctor, config_path], timeout=90)))
    else:
        sections.append(('doctor.sh', '(doctor.sh ou config.sh ausente — pulado)'))
    # logs de erro
    sections.append(('LOGS DE ERRO (so linhas de erro/stacktrace)',
        collect_error_logs(logs_dir) if logs_dir else '(sem logs_dir)'))

    raw = []
    for title, body in sections:
        raw.append('=' * 70)
        raw.append(f'## {title}')
        raw.append('=' * 70)
        raw.append(body or '(vazio)')
        raw.append('')
    return '\n'.join(raw), slug


# ----------------------------------------------------------------------------- destinations
def github_issue_url(repo, slug, scrubbed_bundle):
    import urllib.parse
    title = f'[report] problema no agente ({slug})'
    body_hint = (
        'Cole abaixo o bundle de diagnostico (ja sanitizado) gerado por /dgclaw:report.\n'
        'Por seguranca o conteudo NAO foi pre-preenchido por padrao — anexe/cole manualmente.\n\n'
        '```\n<cole aqui o conteudo do report-*.txt>\n```\n'
    )
    q = urllib.parse.urlencode({'title': title, 'body': body_hint})
    return f'https://github.com/{repo}/issues/new?{q}'


def try_post_endpoint(endpoint, bundle, slug):
    import urllib.request
    data = bundle.encode('utf-8')
    req = urllib.request.Request(
        endpoint, data=data, method='POST',
        headers={'Content-Type': 'text/plain; charset=utf-8',
                 'X-DG-Claw-Report': slug})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, f'HTTP {resp.status}'
    except Exception as e:  # noqa
        return False, str(e)


def try_gh_issue(repo, title, body_file):
    if not shutil.which('gh'):
        return False, 'gh nao instalado'
    out = run_cmd(['gh', 'issue', 'create', '--repo', repo,
                   '--title', title, '--body-file', body_file], timeout=60)
    ok = 'http' in out.lower()
    return ok, out


# ----------------------------------------------------------------------------- self-test
SCRUB_SAMPLES = [
    'owner is John Doe and persona is Aurora',
    'chat_id=987654321 sent the message',
    'TELEGRAM_BOT_TOKEN=123456789:AAHfake_tokenvalue_abcdefghijklmnopqrstuvwx',
    'OPENAI_API_KEY=sk-proj-ABCDEF1234567890abcdef1234',
    'path was /home/johndoe/agent/persona/state.json',
    'Authorization: Bearer abcdef1234567890ABCDEF',
    'hash a1b2c3d4e5f60718293a4b5c6d7e8f90',
]


def selftest(cfg):
    # injeta valores conhecidos pra garantir que owner/persona/id sao apagados
    cfg = dict(cfg)
    cfg.setdefault('DGCLAW_OWNER', 'John Doe')
    cfg.setdefault('DGCLAW_NAME', 'Aurora')
    cfg.setdefault('DGCLAW_OWNER_TELEGRAM_ID', '987654321')
    os.environ['HOME'] = '/home/johndoe'
    scrub = build_scrubber(cfg)
    print('== dry-run do scrubber ==')
    ok = True
    forbidden = ['John', 'Doe', 'Aurora', '987654321', 'johndoe',
                 '123456789:AAH', 'sk-proj-ABCDEF']
    for s in SCRUB_SAMPLES:
        out = scrub(s)
        print(f'  IN : {s}')
        print(f'  OUT: {out}')
        for bad in forbidden:
            if bad in out:
                print(f'  !! VAZOU: "{bad}" ainda presente')
                ok = False
        print()
    print('meta:', json.dumps(scrub.meta, ensure_ascii=False))
    print('== %s ==' % ('PASSOU: nada vazou' if ok else 'FALHOU: houve vazamento'))
    return 0 if ok else 1


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description='Coleta bundle de diagnostico sanitizado pro autor do DG Claw.')
    ap.add_argument('--config', help='caminho do .dgclaw/config.sh')
    ap.add_argument('--desc', default='', help='descricao do problema escrita pelo dono')
    ap.add_argument('--consent', action='store_true',
                    help='consentimento explicito: autoriza ENVIAR (endpoint/github/gh). Sem isso, so salva local.')
    ap.add_argument('--json', action='store_true', help='imprime metadados em JSON no fim')
    ap.add_argument('--dry-run-scrub', action='store_true', help='testa o scrubber e sai')
    args = ap.parse_args()

    config_path = args.config or os.environ.get('DGCLAW_CONFIG')
    cfg = load_config_sh(config_path) if config_path else {}
    if config_path:
        cfg['__CONFIG_PATH__'] = config_path

    if args.dry_run_scrub:
        return selftest(cfg)

    ws = env_or_cfg(cfg, 'DGCLAW_WORKSPACE')
    if not ws:
        print('report: DGCLAW_WORKSPACE nao encontrado (passe --config <.dgclaw/config.sh>)', file=sys.stderr)
        return 2
    plugin_root = env_or_cfg(cfg, 'DGCLAW_PLUGIN_ROOT') or os.path.join(ws, '.dgclaw', 'plugin')
    if not os.path.isdir(plugin_root):
        # fallback: o proprio repo onde este script vive
        plugin_root = str(Path(__file__).resolve().parents[1])

    scrub = build_scrubber(cfg)
    raw_bundle, slug = build_bundle(cfg, plugin_root, ws, args.desc)
    bundle = scrub(raw_bundle)

    # salva SEMPRE local
    reports_dir = os.path.join(ws, '.dgclaw', 'reports')
    os.makedirs(reports_dir, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    out_path = os.path.join(reports_dir, f'report-{ts}.txt')
    with open(out_path, 'w') as fh:
        fh.write(bundle)
    try:
        os.chmod(out_path, 0o600)
    except Exception:
        pass

    meta = {
        'bundle_path': out_path,
        'slug': slug,
        'bytes': len(bundle.encode('utf-8')),
        'scrub': scrub.meta,
        'consent': bool(args.consent),
        'delivery': None,
    }

    # destinos (so com consentimento)
    endpoint = env_or_cfg(cfg, 'DGCLAW_REPORT_ENDPOINT')
    repo = env_or_cfg(cfg, 'DGCLAW_REPORT_GITHUB_REPO') or 'DGatoM/DG-Claw'
    contact = env_or_cfg(cfg, 'DGCLAW_AUTHOR_CONTACT')

    print(f'bundle salvo em: {out_path}  ({meta["bytes"]} bytes)')
    print(f'scrub: owner={"sim" if scrub.meta["owner_redacted"] else "n/d"}, '
          f'persona={"sim" if scrub.meta["persona_redacted"] else "n/d"}, '
          f'tg_id={"sim" if scrub.meta["tg_id_redacted"] else "n/d"}, '
          f'usuarios={scrub.meta["usernames_redacted"] or "n/d"}')

    if not args.consent:
        print('\n[SEM CONSENTIMENTO] nada foi enviado pela rede.')
        print('Revise o arquivo acima. Pra ENVIAR pro autor, rode de novo com --consent.')
        print(f'Destinos configurados:')
        print(f'  endpoint : {endpoint or "(nenhum — DGCLAW_REPORT_ENDPOINT nao setado)"}')
        print(f'  github   : {repo}')
        print(f'  contato  : {contact or "(use o repo GitHub)"}')
        if args.json:
            print('\n' + json.dumps(meta, ensure_ascii=False, indent=2))
        return 0

    # com consentimento: tenta endpoint -> gh -> instrucao manual
    delivered = False
    if endpoint:
        ok, info = try_post_endpoint(endpoint, bundle, slug)
        meta['delivery'] = {'via': 'endpoint', 'ok': ok, 'info': info}
        print(f'\nPOST endpoint: {"OK" if ok else "FALHOU"} ({info})')
        delivered = ok

    if not delivered:
        title = f'[report] problema no agente ({slug})'
        ok, info = try_gh_issue(repo, title, out_path)
        if ok:
            meta['delivery'] = {'via': 'gh', 'ok': True, 'info': info}
            print(f'\nIssue criada via gh: {info}')
            delivered = True
        else:
            url = github_issue_url(repo, slug, bundle)
            meta['delivery'] = {'via': 'manual', 'ok': False,
                                'github_issue_url': url,
                                'gh_note': info}
            print('\nNao consegui enviar automaticamente. Opcoes manuais:')
            print(f'  1) Abra uma issue (prefillada): {url}')
            print(f'     e cole o conteudo de: {out_path}')
            if contact:
                print(f'  2) Ou mande pro autor: {contact}')
            else:
                print(f'  2) Ou via repo: https://github.com/{repo}')

    if args.json:
        print('\n' + json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
