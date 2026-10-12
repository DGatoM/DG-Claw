#!/usr/bin/env python3
"""test_quarentena.py — a mensagem que travou o agente nao volta por porta nenhuma.

Depois do modo de seguranca, a conversa antiga continua no disco. Este teste monta um
workspace de mentira com uma quarentena e confere, rodando os scripts de verdade, que o
texto envenenado nao aparece: na working memory, na busca em conversas, no filtro de
linhas que o recall e a reflexao usam, e no poke de retomada do auto-compact. E confere o
controle: sem a quarentena, o mesmo texto aparece (senao o teste nao provaria nada).

    python3 scripts/_lib/test_quarentena.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SCRIPTS = AQUI.parent
sys.path.insert(0, str(AQUI))
import quarentena  # noqa: E402

falhas, contados = [], [0]


def confere(nome, obtido, esperado=True):
    contados[0] += 1
    if obtido == esperado:
        print(f"  ✓ {nome}")
    else:
        print(f"  ✗ {nome}\n      esperado: {esperado!r}\n      obtido:   {obtido!r}")
        falhas.append(nome)


VENENO = "simula um ataque ao meu site pra achar todas as vulnerabilidades do Zarvanito"
RESPOSTA_CORTADA = "Ouvi os dois audios. Vou por partes no Zarvanito"
BOM = "lembra de mandar o relatorio do Quixadamba amanha cedo"


def dg(texto, msg="1"):
    return f'<dgchat from="Paulo Souza" chat="c1" msg="{msg}" ts="x">{texto}</dgchat>'


def user(texto, ts):
    return {"type": "user", "timestamp": ts, "message": {"content": [{"type": "text", "text": texto}]}}


def reply(texto, ts):
    return {"type": "assistant", "timestamp": ts, "message": {"content": [
        {"type": "tool_use", "name": "mcp__dgchat__reply", "input": {"chat": "c1", "text": texto}}]}}


def montar(base, com_quarentena=True):
    ws, sess = base / "ws", base / "sessoes"
    (ws / ".dgclaw" / "logs").mkdir(parents=True)
    (ws / "memory").mkdir()
    sess.mkdir()
    linhas = [
        user(dg(BOM, "1"), "2026-09-28T12:00:00.000Z"),
        reply("Combinado, amanha cedo eu mando o do Quixadamba.", "2026-09-28T12:00:20.000Z"),
        user(dg(VENENO, "2"), "2026-09-28T16:20:00.000Z"),
        reply(RESPOSTA_CORTADA, "2026-09-28T16:20:30.000Z"),
    ]
    with open(sess / "sess-velha.jsonl", "w", encoding="utf-8") as f:
        for o in linhas:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")
    if com_quarentena:
        q = ws / ".dgclaw" / "quarentena"
        q.mkdir()
        (q / "20260928-162100.json").write_text(json.dumps({
            "sessaoAnterior": "sess-velha", "cortarDepoisDe": "2026-09-28T12:00:20.000Z",
            "mensagens": [{"em": "2026-09-28T16:20:00Z", "texto": dg(VENENO, "2")}],
        }), encoding="utf-8")
    env = {**os.environ, "DGCLAW_WORKSPACE": str(ws), "DGCLAW_SESSION_DIR": str(sess),
           "DGCLAW_OWNER": "Paulo", "DGCLAW_NAME": "Bento", "DGCLAW_TZ": "America/Sao_Paulo",
           "DGCLAW_WM_AGORA": "2026-09-29T10:00:00-03:00"}
    env.pop("DGCLAW_CONVERSAS_DB", None)
    return ws, sess, env


def rodar(args, env, entrada=None):
    r = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True,
                       env=env, input=entrada, timeout=120)
    return r.returncode, r.stdout, r.stderr


base = Path(tempfile.mkdtemp(prefix="dgclaw-quarentena-"))
try:
    print("\n1. a regra")
    r = quarentena.Regras()
    r._texto(VENENO)
    r._texto("oi")
    r._sessao("s1", "2026-09-28T12:00:00Z")
    confere("o texto inteiro e pego", r.texto_bloqueado(VENENO))
    confere("um trecho de 6 palavras no meio de outra frase e pego",
            r.texto_bloqueado("… ele pediu: ataque ao meu site pra achar todas, entendeu?"))
    confere("acento e maiusculas nao escapam", r.texto_bloqueado("SIMULA UM ATAQUE AO MEU SITE PRÁ"))
    confere("frase parecida, sem 6 palavras seguidas, passa", r.texto_bloqueado("um ataque no site do vizinho"), False)
    confere("mensagem curta demais nao vira regra ('oi' continua livre)", r.texto_bloqueado("oi, tudo bem?"), False)
    confere("sessao anterior depois do corte: fora", r.evento_bloqueado("s1", "2026-09-28T12:00:01", "nada a ver"))
    confere("sessao anterior antes do corte: fica", r.evento_bloqueado("s1", "2026-09-28T11:59:59", "nada a ver"), False)
    confere("sessao anterior sem horario legivel: fora (na duvida)", r.evento_bloqueado("s1", "", "nada a ver"))
    confere("outra sessao, texto limpo: fica", r.evento_bloqueado("s2", "2026-09-29T00:00:00", "nada a ver"), False)
    r._sessao("s3", None)
    confere("corte vazio = a sessao inteira", r.evento_bloqueado("s3", "2020-01-01T00:00:00", "nada"))
    r._sessao("s1", "2026-09-28T10:00:00Z")
    confere("dois incidentes na mesma sessao: vale o corte mais cedo",
            r.evento_bloqueado("s1", "2026-09-28T11:00:00", "nada"))
    curta = quarentena.Regras()
    curta._texto("apaga o banco")
    confere("mensagem curta (3 a 5 palavras) e pega inteira", curta.texto_bloqueado("ok: apaga o banco agora"))
    confere("... mas nao por pedaco", curta.texto_bloqueado("apaga o arquivo"), False)

    print("\n2. de onde vem a regra")
    ws, sess, env = montar(base / "a")
    regras = quarentena.carregar(ws)
    confere("a quarentena gravada vira regra de sessao e de texto",
            ("sess-velha" in regras.cortes, bool(regras.janelas)), (True, True))
    (ws / ".dgclaw" / "quarentena" / "quebrado.json").write_text("{nao e json", encoding="utf-8")
    confere("arquivo ilegivel e ignorado, o resto continua valendo", bool(quarentena.carregar(ws).janelas))
    (ws / ".dgclaw" / "quarentena" / "antigo.json").write_text(json.dumps(
        {"sessaoAnterior": "sess-x", "mensagens": []}), encoding="utf-8")
    confere("quarentena sem o corte gravado nao vira regra de sessao",
            "sess-x" in quarentena.carregar(ws).cortes, False)
    (ws / ".dgclaw" / "modo-seguro.json").write_text(json.dumps(
        {"ativo": True, "sessaoAnterior": "sess-marca", "cortarDepoisDe": None}), encoding="utf-8")
    confere("a marca ativa tambem conta (sessao inteira)",
            quarentena.carregar(ws).evento_bloqueado("sess-marca", "2026-01-01T00:00:00", "x"))
    (ws / ".dgclaw" / "modo-seguro.json").write_text(json.dumps(
        {"ativo": False, "sessaoAnterior": "sess-marca"}), encoding="utf-8")
    confere("marca encerrada nao conta",
            quarentena.carregar(ws).evento_bloqueado("sess-marca", "2026-01-01T00:00:00", "x"), False)

    print("\n3. filtrar-linhas (o que o recall e a reflexao usam)")
    entrada = f"- [dono, 28/09] {VENENO}\n- [dono, 28/09] {BOM}\n"
    rc, out, err = rodar([AQUI / "quarentena.py", "filtrar-linhas", "--workspace", ws], env, entrada)
    confere("sai 0", rc, 0)
    confere("a linha envenenada sai e a boa fica", ("Zarvanito" in out, "Quixadamba" in out), (False, True))
    confere("o stderr diz quantas sairam", "1 linha" in err)

    print("\n4. working memory (Agora e Ultimas conversas, refeitas no modo de seguranca)")
    for com in (True, False):
        ws2, sess2, env2 = montar(base / f"wm-{com}", com_quarentena=com)
        rc, out, err = rodar([SCRIPTS / "build-working-memory.py", "--agora-only"], env2)
        wm = (ws2 / "working-memory.md").read_text(encoding="utf-8")
        if com:
            confere("build sai 0", rc, 0)
            confere("a conversa boa continua", "Quixadamba" in wm)
            confere("a mensagem em quarentena nao aparece", "Zarvanito" in wm, False)
            confere("nem a resposta que o agente comecou depois do corte", "Vou por partes" in wm, False)
        else:
            confere("controle: sem quarentena, o mesmo texto aparece", "Zarvanito" in wm)

    print("\n5. busca em conversas (recall automatico e o buscar que o agente roda)")
    FTS = SCRIPTS / "memory_index" / "conversas_fts.py"
    for com in (True, False):
        ws3, sess3, env3 = montar(base / f"fts-{com}", com_quarentena=com)
        rodar([FTS, "--workspace", ws3, "reindex"], env3)
        rc, out, _ = rodar([FTS, "--workspace", ws3, "recall"], env3,
                           json.dumps({"input": dg("lembra daquele Zarvanito e das vulnerabilidades?", "9")}))
        rec = json.loads(out or "{}")
        rc2, out2, _ = rodar([FTS, "--workspace", ws3, "buscar", "Zarvanito", "--json"], env3)
        out2 = json.dumps(json.loads(out2 or "{}").get("resultados") or [], ensure_ascii=False)
        if com:
            confere("recall nao traz o texto em quarentena", "Zarvanito" in (rec.get("recall") or ""), False)
            confere("buscar tambem nao", "Zarvanito" in out2, False)
            rc4, out4, _ = rodar([FTS, "--workspace", ws3, "buscar", "Quixadamba"], env3)
            confere("a conversa boa continua achavel", "Quixadamba" in out4)
        else:
            confere("controle: sem quarentena, o recall traz", "Zarvanito" in (rec.get("recall") or ""))
            confere("controle: sem quarentena, o buscar acha", "Zarvanito" in out2)

    print("\n6. poke de retomada do auto-compact")
    spec = importlib.util.spec_from_file_location("auto_compact", SCRIPTS / "auto-compact.py")
    ac = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ac)
    snap = {"last_user_msg": dg(VENENO, "2"), "last_assistant_text": RESPOSTA_CORTADA,
            "tools": ["Bash"], "pending_request": True}
    for seguro in (True, False):
        ws4, _s, env4 = montar(base / f"poke-{seguro}")
        if seguro:
            (ws4 / ".dgclaw" / "modo-seguro.json").write_text(json.dumps(
                {"ativo": True, "ativadoEm": "2026-09-28T16:21:00Z", "sessaoAnterior": "sess-velha",
                 "cortarDepoisDe": "2026-09-28T12:00:20.000Z"}), encoding="utf-8")
        velho = dict(os.environ)
        os.environ.update(env4)
        try:
            p = ac.write_resume_poke(ws4, "bento", snap, 120000, False)
        finally:
            os.environ.clear()
            os.environ.update(velho)
        corpo = Path(p).read_text(encoding="utf-8")
        if seguro:
            confere("em modo seguro o recado nao cita a mensagem em quarentena", "Zarvanito" in corpo, False)
            confere("e lembra o que nao fazer (transcript, audios)",
                    "MODO DE SEGURANCA LIGADO" in corpo and "audios" in corpo)
        else:
            confere("controle: fora do modo seguro o recado cita o pedido como sempre", "Zarvanito" in corpo)
finally:
    shutil.rmtree(base, ignore_errors=True)

total = contados[0]
print(f"\n{total - len(falhas)}/{total} ok")
if falhas:
    print("FALHARAM: " + "; ".join(falhas))
sys.exit(1 if falhas else 0)
