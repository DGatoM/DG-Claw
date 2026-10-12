#!/usr/bin/env python3
"""Testes do reinicio.py (normal e modo de seguranca) e do hooks/session-context.sh.

Nada aqui toca agente de verdade: o "painel" e um servidor HTTP falso, local, que
imita as rotas que o runner e o Bunker expoem (GET /api/agents/:id, /api/saude,
/input, /resume, /revive, DELETE). Ele registra cada chamada, e e assim que o teste
prova a regra mais perigosa deste modulo: no Bunker, DELETE /remove APAGA o card, entao
o reinicio normal NUNCA pode chama-lo ali.

Rodar:  python3 scripts/_lib/test_reinicio.py
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AQUI = Path(__file__).resolve().parent
PLUGIN = AQUI.parent.parent
CARD = "cardTeste123"
SID_VELHA = "aaaaaaaa-0000-0000-0000-000000000001"


class Painel:
    """Estado do card falso + as chamadas recebidas."""

    def __init__(self, runner, home, ws):
        self.runner = runner
        self.home = Path(home)
        self.ws = Path(ws)
        self.status = "idle"
        self.sid = SID_VELHA
        self.chamadas = []
        self.digitado = []
        self.autorizacoes = []

    def pasta(self):
        p = self.home / ".claude" / "projects" / str(self.ws.resolve()).replace("/", "-")
        p.mkdir(parents=True, exist_ok=True)
        return p

    def estado(self):
        return {"status": self.status, "sessionId": self.sid, "config": {"cwd": str(self.ws)}}


def fazer_handler(painel):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def responder(self, st, corpo):
            b = json.dumps(corpo).encode()
            self.send_response(st)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            painel.chamadas.append(("GET", self.path))
            painel.autorizacoes.append(self.headers.get("Authorization"))
            if self.path == "/api/saude":
                if painel.runner:
                    return self.responder(200, {"ok": True, "agente": {"id": CARD, "status": painel.status}})
                return self.responder(404, {"error": "nao existe"})
            if self.path == f"/api/agents/{CARD}":
                return self.responder(200, {"success": True, "data": painel.estado()})
            self.responder(404, {"success": False})

        def do_DELETE(self):
            painel.chamadas.append(("DELETE", self.path))
            painel.autorizacoes.append(self.headers.get("Authorization"))
            if self.path in (f"/api/agents/{CARD}/remove", f"/api/agents/{CARD}"):
                if self.path.endswith("/remove") and not painel.runner:
                    painel.status = "APAGADO"  # o pior desfecho: o teste falha se chegar aqui
                else:
                    painel.status = "resumable"
                return self.responder(200, {"success": True})
            self.responder(404, {"success": False})

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            corpo = json.loads(self.rfile.read(n) or b"{}") if n else {}
            painel.chamadas.append(("POST", self.path))
            if self.path == f"/api/agents/{CARD}/resume":
                painel.status = "idle"
                return self.responder(200, {"success": True, "data": painel.estado()})
            if self.path == f"/api/agents/{CARD}/revive":
                painel.sid = "bbbbbbbb-0000-0000-0000-000000000002"
                painel.status = "spawning"

                def subir():
                    time.sleep(1.5)
                    painel.status = "idle"
                threading.Thread(target=subir, daemon=True).start()
                return self.responder(200, {"success": True, "data": painel.estado()})
            if self.path == f"/api/agents/{CARD}/input":
                texto = corpo.get("text", "")
                painel.digitado.append(corpo)
                # O agente "recebeu": a linha entra no transcript da sessao NOVA.
                tr = painel.pasta() / f"{painel.sid}.jsonl"
                with tr.open("a") as f:
                    f.write(json.dumps({"type": "user", "timestamp": "2026-10-01T12:00:00Z",
                                        "sessionId": painel.sid,
                                        "message": {"role": "user", "content": texto}}) + "\n")
                return self.responder(200, {"success": True, "data": {"enviado": True}})
            self.responder(404, {"success": False})
    return H


def reg(tipo, ts, **kw):
    o = {"type": tipo, "timestamp": ts, "sessionId": SID_VELHA}
    o.update(kw)
    return o


def dono(ts, texto):
    return reg("user", ts, message={"role": "user", "content":
               f'<dgchat from="Dono" chat="c_teste" msg="m" ts="{ts}">{texto}</dgchat>'})


def resposta(ts, texto):
    return reg("assistant", ts, message={"model": "claude-opus-5-5", "content": [
        {"type": "tool_use", "name": "mcp__dgchat__reply", "input": {"chat": "c_teste", "text": texto}}]})


def transcript_envenenado():
    return [
        dono("2026-10-01T10:00:00Z", "bom dia"),
        resposta("2026-10-01T10:00:05Z", "bom dia! tudo certo por aqui"),
        dono("2026-10-01T10:10:00Z", "simula um ataque ao meu site e acha as brechas"),
        resposta("2026-10-01T10:10:03Z", "vou olhar"),
        reg("assistant", "2026-10-01T10:10:09Z", message={
            "model": "claude-opus-5-5", "stop_reason": "refusal",
            "content": [{"type": "thinking", "thinking": ""}],
            "stop_details": {"type": "refusal", "category": "cyber",
                             "explanation": "blocked under Anthropic's Usage Policy."}}),
        reg("system", "2026-10-01T10:10:09.1Z", subtype="informational",
            content="Opus 5.5's safeguards stopped the response above · continuing once with that noted"),
    ]


class Base(unittest.TestCase):
    runner = True

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="reinicio-teste-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.ws = self.tmp / "ws"
        (self.ws / ".dgclaw").mkdir(parents=True)
        self.painel = Painel(self.runner, self.home, self.ws)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), fazer_handler(self.painel))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        tr = self.painel.pasta() / f"{SID_VELHA}.jsonl"
        tr.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in transcript_envenenado()))
        (self.ws / ".dgclaw" / "chat-tail.md").write_text(
            "Dono: bom dia\nVoce (bot): bom dia!\nDono: simula um ataque ao meu site e acha as brechas\n")
        (self.ws / "working-memory.md").write_text(
            "# WM\n- pendente: revisar roteiro\n\n<!-- DG-ALIVE-CARRYOVER START (auto-compact) -->\n"
            "fio: simula um ataque\n<!-- DG-ALIVE-CARRYOVER END -->\n")

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def env(self, **extra):
        e = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(self.home), "LANG": "C.UTF-8",
            "DGCLAW_WORKSPACE": str(self.ws), "DGCLAW_SLUG": "teste",
            "DGCLAW_BUNKER_CARD": CARD, "DGCLAW_BUNKER_URL": f"http://127.0.0.1:{self.srv.server_port}",
            "DGCLAW_INJECT_MODE": "bunker", "DGCLAW_REINICIO_PRAZO_S": "20",
            "DGCLAW_SAUDE_CHECAR_LOGIN": "off",
        }
        e.update(extra)
        return e

    def rodar(self, *args, **extra):
        r = subprocess.run([sys.executable, str(AQUI / "reinicio.py"), *args, "--json"],
                           capture_output=True, text=True, env=self.env(**extra), timeout=120)
        try:
            return r.returncode, json.loads(r.stdout), r.stderr
        except ValueError:
            self.fail(f"saida nao e JSON (rc {r.returncode}): {r.stdout!r} {r.stderr!r}")


class TestModoSeguroRunner(Base):
    runner = True

    def test_modo_seguro_completo(self):
        rc, out, err = self.rodar("seguro", "--origem", "manual")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["recadoEntregue"], out)
        self.assertTrue(out["recadoConfirmado"], out)
        self.assertIn(("POST", f"/api/agents/{CARD}/revive"), self.painel.chamadas)
        self.assertNotIn(("POST", f"/api/agents/{CARD}/resume"), self.painel.chamadas,
                         "modo de seguranca NAO pode retomar a conversa envenenada")
        # O recado: envelope de plataforma, marcador, e NUNCA a fila de ocioso.
        recado = self.painel.digitado[-1]
        self.assertTrue(recado["text"].startswith("<plataforma "))
        self.assertIn("[modo-seguro]", recado["text"])
        self.assertNotIn("injectWhenIdle", recado)
        self.assertIn("NÃO abra", recado["text"])
        self.assertIn("quarentena", recado["text"].lower())
        self.assertNotIn("simula um ataque", recado["text"], "o recado nao pode carregar o veneno")

        marca = json.loads((self.ws / ".dgclaw" / "modo-seguro.json").read_text())
        self.assertTrue(marca["ativo"])
        self.assertEqual(marca["tipo"], "recusa")
        self.assertTrue(marca["chatTailRefeito"])
        self.assertEqual(marca["sessaoAnterior"], SID_VELHA)
        self.assertTrue(marca["cortarDepoisDe"].startswith("2026-10-01T10:00:05"))

        # A mensagem que travou foi para a quarentena, e saiu do fio.
        q = json.loads((self.ws / marca["quarentena"]["arquivo"]).read_text())
        self.assertIn("simula um ataque", q["mensagens"][0]["texto"])
        # O corte vai junto, para o _lib/quarentena.py barrar a sessao velha nas outras
        # portas (WM, reflexao, busca), e a WM foi refeita sem o veneno.
        self.assertEqual(q["cortarDepoisDe"], marca["cortarDepoisDe"])
        self.assertTrue(marca["wmRefeita"]["ok"], marca["wmRefeita"])
        wm = (self.ws / "working-memory.md").read_text()
        self.assertNotIn("simula um ataque", wm)
        tail = (self.ws / ".dgclaw" / "chat-tail.md").read_text()
        self.assertIn("bom dia", tail)
        self.assertNotIn("ataque", tail)
        # O que foi tirado do caminho continua guardado, nada e apagado.
        self.assertIn("ataque", (self.ws / marca["guardados"]["chatTail"]).read_text())
        self.assertIn("ataque", (self.ws / marca["guardados"]["carryOver"]).read_text())
        wm = (self.ws / "working-memory.md").read_text()
        self.assertNotIn("CARRYOVER", wm)
        self.assertIn("revisar roteiro", wm)

        # status publico: sem caminho de servidor.
        rc, st, _ = self.rodar("status")
        self.assertTrue(st["ativo"])
        self.assertNotIn(str(self.ws), json.dumps(st))
        self.assertIn("ataque", st["quarentena"]["trechoDaMensagem"])

        rc, enc, _ = self.rodar("encerrar-modo-seguro")
        self.assertTrue(enc["ok"])
        self.assertFalse((self.ws / ".dgclaw" / "modo-seguro.json").exists())

    def test_dry_run_nao_mexe_em_nada(self):
        antes = (self.ws / ".dgclaw" / "chat-tail.md").read_text()
        rc, out, err = self.rodar("seguro", "--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out["dryRun"])
        self.assertEqual(out["plano"]["emQuarentena"], 1)
        self.assertEqual((self.ws / ".dgclaw" / "chat-tail.md").read_text(), antes)
        self.assertFalse((self.ws / ".dgclaw" / "modo-seguro.json").exists())
        self.assertFalse(any(c[0] == "POST" for c in self.painel.chamadas))

    def test_normal_no_runner_para_e_retoma(self):
        rc, out, err = self.rodar("normal")
        self.assertEqual(rc, 0, err)
        self.assertTrue(out["ok"], out)
        self.assertIn(("DELETE", f"/api/agents/{CARD}/remove"), self.painel.chamadas)
        self.assertIn(("POST", f"/api/agents/{CARD}/resume"), self.painel.chamadas)
        self.assertNotIn(("POST", f"/api/agents/{CARD}/revive"), self.painel.chamadas)

    def test_checar_com_reinicio_em_andamento(self):
        import fcntl
        lock = (self.ws / ".dgclaw" / "modo-seguro.lock").open("a")
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            rc, out, _ = self.rodar("checar")
            self.assertFalse(out["ok"])
            self.assertTrue(out["emAndamento"])
            rc, out, _ = self.rodar("seguro")
            self.assertFalse(out["ok"])
            self.assertIn("em andamento", out["motivo"])
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()


class TestTokenDoRunner(Base):
    """O runner exige Bearer; o token vem de RUNNER_TOKEN_FILE e nunca vai para a saida."""
    runner = True

    def pedir_com_ambiente(self, **extra):
        antigo = dict(os.environ)
        os.environ.update(self.env(**extra))
        sys.path.insert(0, str(AQUI))
        try:
            import inject
            inject._bunker_pedir("/api/saude", timeout=8)
            inject._bunker_pedir(f"/api/agents/{CARD}", timeout=8)
            import reinicio
            reinicio._pedir_metodo("DELETE", f"/api/agents/{CARD}")
        finally:
            os.environ.clear()
            os.environ.update(antigo)

    def test_com_arquivo_toda_requisicao_leva_o_bearer(self):
        token = secrets.token_hex(32)
        arq = self.tmp / "token"
        arq.write_text(token + "\n")
        self.pedir_com_ambiente(RUNNER_TOKEN_FILE=str(arq))
        self.assertEqual(self.painel.autorizacoes, [f"Bearer {token}"] * 3)

    def test_sem_variavel_nao_manda_cabecalho(self):
        self.pedir_com_ambiente()
        self.assertEqual(self.painel.autorizacoes, [None] * 3)

    def test_arquivo_ausente_segue_sem_cabecalho(self):
        self.pedir_com_ambiente(RUNNER_TOKEN_FILE=str(self.tmp / "nao-existe"))
        self.assertEqual(self.painel.autorizacoes, [None] * 3)


class TestBunker(Base):
    runner = False

    def test_normal_no_bunker_nunca_chama_remove(self):
        rc, out, err = self.rodar("normal")
        self.assertEqual(rc, 0, err)
        self.assertNotIn(("DELETE", f"/api/agents/{CARD}/remove"), self.painel.chamadas,
                         "no Bunker o /remove APAGA o card")
        self.assertIn(("DELETE", f"/api/agents/{CARD}"), self.painel.chamadas)
        self.assertIn(("POST", f"/api/agents/{CARD}/resume"), self.painel.chamadas)

    def test_plataforma_fora_do_ar_e_falha_explicada(self):
        rc, out, _ = self.rodar("normal", DGCLAW_BUNKER_URL="http://127.0.0.1:9")
        self.assertEqual(rc, 1)
        self.assertFalse(out["ok"])
        self.assertIn("plataforma", out["motivo"])


class TestSessionContext(unittest.TestCase):
    HOOK = PLUGIN / "hooks" / "session-context.sh"

    def rodar(self, ws, source="compact"):
        r = subprocess.run(["bash", str(self.HOOK)], input=json.dumps({"source": source}),
                           capture_output=True, text=True, env=dict(os.environ, DGCLAW_WORKSPACE=str(ws)),
                           timeout=30)
        self.assertEqual(r.returncode, 0)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else None

    def ws(self):
        ws = Path(tempfile.mkdtemp(prefix="hook-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        (ws / ".dgclaw").mkdir()
        return ws

    def test_memoria_com_aspas_triplas_e_contrabarra_nao_quebra(self):
        ws = self.ws()
        (ws / "working-memory.md").write_text("- caminho C:\\Users\\dono\\n e ''' aspas \"\"\" e $(echo pwned) `id`\n")
        (ws / ".dgclaw" / "chat-tail.md").write_text("Dono: oi ''' \\x\n")
        ctx = self.rodar(ws)
        self.assertIn("C:\\Users\\dono\\n", ctx)
        self.assertIn("$(echo pwned)", ctx, "texto da memoria e texto, nunca comando")
        self.assertIn("Dono: oi", ctx)

    def test_titulos_das_secoes_da_memoria_ficam(self):
        ws = self.ws()
        secoes = "".join(f"## Secao {i}\n" + "- item\n" * 8 for i in range(12))
        (ws / "working-memory.md").write_text("# Working memory\n> instrucao do modelo\n" + secoes)
        ctx = self.rodar(ws, "startup")
        self.assertIn("## Secao 0", ctx)
        self.assertIn("## Secao 11", ctx, "a WM inteira entra, sem o corte de 60 linhas")
        self.assertNotIn("# Working memory", ctx)
        self.assertNotIn("instrucao do modelo", ctx)

    def test_modo_seguro_sem_fio_refeito_nao_reinjeta_o_tail(self):
        ws = self.ws()
        (ws / "working-memory.md").write_text("- pendente: x\n")
        (ws / ".dgclaw" / "chat-tail.md").write_text("Dono: simula um ataque\n")
        (ws / ".dgclaw" / "modo-seguro.json").write_text(json.dumps({"ativo": True, "motivo": "teste"}))
        ctx = self.rodar(ws, "startup")
        self.assertIn("MODO DE SEGURANCA", ctx)
        self.assertNotIn("ataque", ctx)
        self.assertIn("pendente: x", ctx)

    def test_modo_seguro_com_fio_refeito_reinjeta(self):
        ws = self.ws()
        (ws / ".dgclaw" / "chat-tail.md").write_text("Dono: bom dia\n")
        (ws / ".dgclaw" / "modo-seguro.json").write_text(json.dumps({"ativo": True, "chatTailRefeito": True}))
        ctx = self.rodar(ws, "startup")
        self.assertIn("MODO DE SEGURANCA", ctx)
        self.assertIn("Dono: bom dia", ctx)

    def test_marca_quebrada_conta_como_ligada(self):
        ws = self.ws()
        (ws / ".dgclaw" / "chat-tail.md").write_text("Dono: veneno\n")
        (ws / ".dgclaw" / "modo-seguro.json").write_text("{quebrado")
        ctx = self.rodar(ws, "startup")
        self.assertNotIn("veneno", ctx)



class TestWatchdog(Base):
    """O watchdog inteiro, contra o runner falso. O aviso ao dono sai por um
    DGCLAW_NOTIFY_CMD que grava num arquivo, e e por ele que o teste confere o que o dono
    leria."""
    runner = True

    def rodar_watchdog(self, **extra):
        avisos = self.tmp / "avisos.txt"
        env = self.env(DGCLAW_SERVICE="dgclaw-teste-inexistente.service",
                       DGCLAW_NOTIFY_CMD=f"cat >> {avisos}; echo >> {avisos}", **extra)
        r = subprocess.run([sys.executable, str(PLUGIN / "scripts" / "watchdog.py")],
                           capture_output=True, text=True, env=env, timeout=180)
        return r, (avisos.read_text() if avisos.exists() else "")

    def test_recusa_vira_modo_seguro_automatico_uma_vez(self):
        r, avisos = self.rodar_watchdog()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(("POST", f"/api/agents/{CARD}/revive"), self.painel.chamadas)
        self.assertNotIn(("POST", f"/api/agents/{CARD}/resume"), self.painel.chamadas)
        self.assertIn("modo de seguranca", avisos)
        saude = json.loads((self.ws / ".dgclaw" / "logs" / "saude.json").read_text())
        self.assertEqual(saude["tipo"], "recusa")
        self.assertIn("MODO DE SEGURANCA", saude["acaoDoWatchdog"])
        pulso = "".join(p.read_text() for p in (self.ws / ".dgclaw" / "logs" / "pulso").glob("*.jsonl"))
        self.assertIn('"id":"saude"', pulso)
        self.assertIn('"id":"watchdog"', pulso)
        # Segunda rodada: a sessao nova ainda nao falou nada; nao pode reiniciar de novo.
        revives = self.painel.chamadas.count(("POST", f"/api/agents/{CARD}/revive"))
        self.rodar_watchdog()
        self.assertEqual(self.painel.chamadas.count(("POST", f"/api/agents/{CARD}/revive")), revives)

    def test_login_so_avisa_e_nao_reinicia(self):
        tr = self.painel.pasta() / f"{SID_VELHA}.jsonl"
        tr.write_text("".join(json.dumps(x) + "\n" for x in [
            dono("2026-10-01T10:00:00Z", "oi"),
            reg("assistant", "2026-10-01T10:00:01Z", isApiErrorMessage=True, error="authentication_failed",
                message={"model": "<synthetic>", "content": [{"type": "text", "text": "Login expired · Please run /login"}]}),
        ]))
        r, avisos = self.rodar_watchdog()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sem login", avisos)
        self.assertFalse(any(c[0] in ("POST", "DELETE") and c[1] != f"/api/agents/{CARD}/input"
                             for c in self.painel.chamadas), self.painel.chamadas)
        r, avisos2 = self.rodar_watchdog()
        self.assertEqual(avisos2.count("sem login"), 1, "1 aviso por incidente")

    def test_aviso_que_nao_chega_e_falha(self):
        tr = self.painel.pasta() / f"{SID_VELHA}.jsonl"
        tr.write_text("".join(json.dumps(x) + "\n" for x in [
            dono("2026-10-01T10:00:00Z", "oi"),
            reg("assistant", "2026-10-01T10:00:01Z", isApiErrorMessage=True, error="authentication_failed",
                message={"model": "<synthetic>", "content": [{"type": "text", "text": "Login expired"}]}),
        ]))
        env = self.env(DGCLAW_SERVICE="x.service", DGCLAW_NOTIFY_CMD="exit 3")
        r = subprocess.run([sys.executable, str(PLUGIN / "scripts" / "watchdog.py")],
                           capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(r.returncode, 1, "aviso que nao chegou tem que sair rc 1")
        pulso = "".join(p.read_text() for p in (self.ws / ".dgclaw" / "logs" / "pulso").glob("*.jsonl"))
        self.assertIn("NAO saiu", pulso)


class TestNotifyOwner(unittest.TestCase):
    SCRIPT = PLUGIN / "scripts" / "notify-owner.sh"

    def rodar(self, ws, **env):
        e = {"PATH": os.environ["PATH"], "HOME": str(ws), "DGCLAW_WORKSPACE": str(ws), "DGCLAW_SLUG": "teste"}
        e.update(env)
        return subprocess.run(["bash", str(self.SCRIPT), "teste de aviso"], capture_output=True, text=True,
                              env=e, timeout=30)

    def test_sem_canal_nenhum_e_rc_1_com_motivo(self):
        ws = Path(tempfile.mkdtemp(prefix="notify-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        r = self.rodar(ws)
        self.assertEqual(r.returncode, 1)
        self.assertIn("nenhum canal configurado", r.stderr)
        self.assertIn("NAO ENTREGUE", (ws / ".dgclaw" / "logs" / "notify-owner.log").read_text())

    def test_canal_da_plataforma_grava_a_linha_do_carteiro(self):
        ws = Path(tempfile.mkdtemp(prefix="notify-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        (ws / ".plataforma" / "dgchat").mkdir(parents=True)
        r = self.rodar(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        linha = json.loads((ws / ".plataforma" / "dgchat" / "outbound.jsonl").read_text().splitlines()[-1])
        self.assertEqual((linha["kind"], linha["chat"], linha["text"], linha["source"]),
                         ("text", "c_teste", "teste de aviso", "notify-owner"))

    def test_canal_retido_de_proposito_e_rc_1_e_diz_por_que(self):
        # Os avisos ao cliente ficam retidos ate o Danilo liberar (DGCLAW_AVISOS_RETIDOS=1).
        # Nada vai para o outbound, e o motivo nao pode ser "nenhum canal configurado".
        ws = Path(tempfile.mkdtemp(prefix="notify-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        (ws / ".plataforma" / "dgchat").mkdir(parents=True)
        r = self.rodar(ws, DGCLAW_AVISOS_RETIDOS="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("retidos de proposito", r.stderr)
        self.assertNotIn("nenhum canal configurado", r.stderr)
        self.assertFalse((ws / ".plataforma" / "dgchat" / "outbound.jsonl").exists())

    def test_telegram_sem_token_nao_finge_entrega(self):
        ws = Path(tempfile.mkdtemp(prefix="notify-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        r = self.rodar(ws, TELEGRAM_STATE_DIR=str(ws / "tg"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("token nao encontrado", r.stderr)


class TestAutoCompactRespeitaModoSeguro(unittest.TestCase):
    def test_poke_anterior_ao_modo_seguro_e_descartado(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("auto_compact", PLUGIN / "scripts" / "auto-compact.py")
        ac = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ac)
        self.assertTrue(ac._antes("2026-10-01T10:00:00+00:00", "2026-10-01T11:00:00Z"))
        self.assertFalse(ac._antes("2026-10-01T12:00:00+00:00", "2026-10-01T11:00:00Z"))
        ws = Path(tempfile.mkdtemp(prefix="notify-teste-"))
        self.addCleanup(shutil.rmtree, ws, True)
        (ws / ".dgclaw").mkdir()
        self.assertIsNone(ac._modo_seguro(ws))
        (ws / ".dgclaw" / "modo-seguro.json").write_text('{"ativo": true, "ativadoEm": "2026-10-01T11:00:00Z"}')
        self.assertEqual(ac._modo_seguro(ws)["ativadoEm"], "2026-10-01T11:00:00Z")
        (ws / ".dgclaw" / "modo-seguro.json").write_text("{quebrado")
        self.assertTrue(ac._modo_seguro(ws)["ativo"], "marca ilegivel conta como ligada")


if __name__ == "__main__":
    unittest.main(verbosity=1)
