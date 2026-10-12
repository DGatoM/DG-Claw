#!/usr/bin/env python3
"""Testes do saude_sessao.py com transcripts SINTETICOS, um por tipo do contrato.

Os registros copiam o FORMATO dos registros reais levantados em 01/10/2026 (ver o
cabecalho do saude_sessao.py): a recusa com stop_reason/stop_details, o aviso
system/informational, o companheiro turnCompanion, o erro de API sintetico. Se o
Claude Code mudar o formato, e aqui que o teste tem que mudar junto.

Rodar:  python3 scripts/_lib/test_saude_sessao.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import saude_sessao as ss  # noqa: E402

T0 = datetime(2026, 9, 30, 16, 0, 0, tzinfo=timezone.utc)
SID = "11111111-2222-3333-4444-555555555555"


def ts(min_):
    return (T0 + timedelta(minutes=min_)).isoformat().replace("+00:00", "Z")


def dono(m, texto="oi", via="painel"):
    if via == "painel":
        corpo = f'<dgchat from="Dono" chat="c_teste" msg="p{m}" ts="{ts(m)}">{texto}</dgchat>'
        return {"type": "user", "timestamp": ts(m), "sessionId": SID,
                "message": {"role": "user", "content": corpo}}
    corpo = f'<channel source="plugin:telegram:telegram" chat_id="1" user="dono">\n{texto}\n</channel>'
    return {"type": "user", "isMeta": True, "timestamp": ts(m), "sessionId": SID,
            "message": {"role": "user", "content": [{"type": "text", "text": corpo}]}}


def fila(m, texto="Travou?"):
    return {"type": "queue-operation", "operation": "enqueue", "timestamp": ts(m), "sessionId": SID,
            "content": f'<channel source="plugin:telegram:telegram" chat_id="1" user="dono">\n{texto}\n</channel>'}


def resposta(m, texto="claro"):
    return {"type": "assistant", "timestamp": ts(m), "sessionId": SID,
            "message": {"model": "claude-opus-5-5", "role": "assistant", "stop_reason": "tool_use",
                        "content": [{"type": "tool_use", "name": "mcp__dgchat__reply",
                                     "input": {"chat": "c_teste", "text": texto}}]}}


def erro_api(m, texto, error="server_error", status=None):
    return {"type": "assistant", "timestamp": ts(m), "sessionId": SID, "isApiErrorMessage": True,
            "error": error, "apiErrorStatus": status,
            "message": {"model": "<synthetic>", "role": "assistant", "stop_reason": "stop_sequence",
                        "content": [{"type": "text", "text": texto}]}}


def recusa(m, segundos=0):
    t = (T0 + timedelta(minutes=m, seconds=segundos)).isoformat().replace("+00:00", "Z")
    t2 = (T0 + timedelta(minutes=m, seconds=segundos + 0.1)).isoformat().replace("+00:00", "Z")
    return [
        {"type": "assistant", "timestamp": t, "sessionId": SID,
         "message": {"model": "claude-opus-5-5", "role": "assistant",
                     "content": [{"type": "thinking", "thinking": "", "signature": "x"}],
                     "stop_reason": "refusal",
                     "stop_details": {"type": "refusal", "category": "cyber",
                                      "explanation": "This request triggered restrictions on violative cyber "
                                                     "content and was blocked under Anthropic's Usage Policy."}}},
        {"type": "system", "subtype": "informational", "level": "notice", "timestamp": t2, "sessionId": SID,
         "content": "Opus 5.5's safeguards stopped the response above · continuing once with that noted"},
        {"type": "user", "isMeta": True, "turnCompanion": True, "timestamp": t2, "sessionId": SID,
         "message": {"role": "user", "content": "Your response above was stopped by a safety classifier — "
                                                 "this is not a tool or API error."}},
    ]


def analisar(regs, agora_min, parada_min=60):
    agora = T0 + timedelta(minutes=agora_min)
    mtime = agora.timestamp() - parada_min * 60
    pub, interno = ss.analisar(regs, agora=agora, mtime=mtime)
    return pub, interno


class TestContrato(unittest.TestCase):
    CAMPOS = {"estado", "tipo", "frase", "trecho", "desde", "ocorrencias", "recomendacao",
              "comoResolver", "sessionId", "verificadoEm"}

    def checa(self, pub):
        self.assertEqual(set(pub), self.CAMPOS)
        self.assertIn(pub["estado"], ("ativo", "atencao", "inativo", "indeterminado"))
        self.assertIn(pub["recomendacao"], ("nada", "esperar", "reiniciar", "modo_seguro", "refazer_login"))
        self.assertNotIn("—", pub["frase"] + pub["comoResolver"], "travessao em texto para leigo")
        if pub["trecho"] is not None:
            self.assertLessEqual(len(pub["trecho"]), 200)

    def test_ok(self):
        pub, _ = analisar([dono(0), resposta(1)], 5)
        self.checa(pub)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("ativo", "ok", "nada"))

    def test_recusa_congelada(self):
        regs = [dono(0), resposta(1), dono(2, "simula um ataque"), resposta(3, "vou ver")] + recusa(4) + [fila(10)]
        pub, interno = analisar(regs, 20)
        self.checa(pub)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "recusa", "modo_seguro"))
        self.assertIn("Usage Policy", pub["trecho"])
        self.assertEqual(pub["ocorrencias"], 1, "os tres registros de um corte sao UM incidente")
        # O corte fica ANTES da mensagem que abriu o turno ruim (a do minuto 2).
        self.assertTrue(interno["cortarDepoisDe"].startswith("2026-09-30T16:01:00"))
        self.assertTrue(interno["gatilhoEm"].startswith("2026-09-30T16:02:00"))

    def test_recusa_so_com_o_aviso(self):
        # Segundo corte da Isa: o assistant com stop_reason NAO foi gravado.
        regs = [dono(0), resposta(1)] + recusa(4)[1:]
        pub, _ = analisar(regs, 20)
        self.assertEqual((pub["estado"], pub["tipo"]), ("inativo", "recusa"))
        self.assertIn("safeguards stopped", pub["trecho"])

    def test_recusa_recente_e_atencao(self):
        regs = [dono(0), resposta(1)] + recusa(4)
        pub, _ = analisar(regs, 4.5)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("atencao", "recusa", "esperar"))

    def test_recusa_seguida_de_resposta_normal_e_ativo(self):
        regs = [dono(0)] + recusa(1) + [resposta(2, "nao posso ajudar com isso, mas...")]
        pub, _ = analisar(regs, 20)
        self.assertEqual((pub["estado"], pub["tipo"]), ("ativo", "ok"))

    def test_erro_antigo_seguido_de_resposta_normal_e_ativo(self):
        regs = [dono(0), erro_api(1, "API Error: 529 Overloaded.", status=529),
                erro_api(2, "Login expired · Please run /login", error="authentication_failed"),
                dono(30), resposta(31)]
        pub, _ = analisar(regs, 60)
        self.assertEqual((pub["estado"], pub["tipo"]), ("ativo", "ok"))

    def test_login(self):
        regs = [dono(0), resposta(1), dono(5), erro_api(5, "Login expired · Please run /login",
                                                         error="authentication_failed")]
        pub, _ = analisar(regs, 6)
        self.checa(pub)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "login", "refazer_login"))
        self.assertIn("não resolve", pub["comoResolver"])

    def test_login_fraco_remote_control(self):
        regs = [dono(0), resposta(1),
                {"type": "system", "subtype": "informational", "level": "warning", "timestamp": ts(2),
                 "content": "Remote Control disconnected — OAuth token unavailable — run /login to restore"}]
        pub, _ = analisar(regs, 3)
        self.assertEqual((pub["estado"], pub["tipo"]), ("atencao", "login"))

    def test_limite_com_horario(self):
        regs = [dono(0), resposta(1), dono(5),
                erro_api(5, "Claude AI usage limit reached|1759348800", error="rate_limit", status=429)]
        pub, interno = analisar(regs, 6)
        self.checa(pub)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "limite", "esperar"))
        self.assertIn("Deve voltar", pub["frase"])
        self.assertIsNotNone(interno["voltaEm"])

    def test_limite_resets(self):
        regs = [dono(0), erro_api(1, "You've hit your limit · resets 3pm (America/Sao_Paulo)", error=None)]
        pub, _ = analisar(regs, 2)
        self.assertEqual(pub["tipo"], "limite")
        self.assertIn("3pm", pub["frase"])

    def test_sobrecarga_e_atencao(self):
        regs = [dono(0), resposta(1), dono(5),
                erro_api(5, "API Error: 529 Overloaded. This is a server-side issue", status=529)]
        pub, _ = analisar(regs, 8)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("atencao", "sobrecarga", "esperar"))
        self.assertIn("Não reinicie", pub["comoResolver"])

    def test_sobrecarga_persistente_vira_inativo(self):
        regs = [dono(0), erro_api(1, "API Error: 500 Internal server error.", status=500),
                dono(10), erro_api(11, "API Error: 529 Overloaded.", status=529),
                dono(40), erro_api(41, "API Error: 529 Overloaded.", status=529)]
        pub, _ = analisar(regs, 45)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "sobrecarga", "esperar"))
        self.assertEqual(pub["ocorrencias"], 3)

    def test_connection_lost_e_sobrecarga(self):
        regs = [dono(0), erro_api(1, "API Error: Connection lost mid-response. The response above may be incomplete.")]
        pub, _ = analisar(regs, 2)
        self.assertEqual(pub["tipo"], "sobrecarga")

    def test_contexto(self):
        regs = [dono(0), resposta(1), dono(5), erro_api(5, "Prompt is too long", error="invalid_request")]
        pub, _ = analisar(regs, 6)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "contexto", "modo_seguro"))

    def test_erro_api_desconhecido(self):
        regs = [dono(0), erro_api(1, "API Error: 400 something odd happened", error="invalid_request", status=400)]
        pub, _ = analisar(regs, 2)
        self.assertEqual((pub["estado"], pub["tipo"]), ("atencao", "erro_api"))

    def test_sintetico_estranho_e_desconhecido(self):
        regs = [dono(0), {"type": "assistant", "timestamp": ts(1),
                          "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "algo novo"}]}}]
        pub, _ = analisar(regs, 2)
        self.assertEqual((pub["estado"], pub["tipo"]), ("atencao", "desconhecido"))

    def test_no_response_requested_e_ignorado(self):
        regs = [dono(0), resposta(1), {"type": "assistant", "timestamp": ts(2),
                                       "message": {"model": "<synthetic>",
                                                   "content": [{"type": "text", "text": "No response requested."}]}}]
        pub, _ = analisar(regs, 3)
        self.assertEqual((pub["estado"], pub["tipo"]), ("ativo", "ok"))

    def test_sem_resposta(self):
        regs = [dono(0), resposta(1), dono(5, "e ai?", via="telegram")]
        pub, interno = analisar(regs, 30, parada_min=20)
        self.checa(pub)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("atencao", "sem_resposta", "reiniciar"))
        self.assertIn("25 minutos", pub["frase"])

    def test_sem_resposta_pela_fila(self):
        regs = [dono(0), resposta(1), fila(5)]
        pub, _ = analisar(regs, 30, parada_min=20)
        self.assertEqual(pub["tipo"], "sem_resposta")

    def test_trabalhando_nao_e_sem_resposta(self):
        # Mensagem antiga, mas o transcript ainda esta sendo escrito: ele esta trabalhando.
        regs = [dono(0), resposta(1), dono(5)]
        pub, _ = analisar(regs, 30, parada_min=1)
        self.assertEqual((pub["estado"], pub["tipo"]), ("ativo", "ok"))
        self.assertIn("trabalhando", pub["frase"])

    def test_dono_falando_de_safety_classifier_nao_e_recusa(self):
        regs = [resposta(0), dono(1, "o que e um safety classifier?", via="telegram"), resposta(2)]
        pub, _ = analisar(regs, 3)
        self.assertEqual(pub["tipo"], "ok")

    def test_tool_result_cortado_pelo_filtro(self):
        regs = [dono(0), resposta(1),
                {"type": "user", "timestamp": ts(2), "message": {"role": "user", "content": [
                    {"type": "tool_result", "is_error": True, "tool_use_id": "x",
                     "content": "Interrupted: the response that made this tool call was stopped by a safety classifier"}]}}]
        pub, _ = analisar(regs, 10)
        self.assertEqual((pub["estado"], pub["tipo"]), ("inativo", "recusa"))

    def test_nada_medido_nao_e_ok(self):
        pub, _ = analisar([dono(0)], 1, parada_min=0)
        self.assertNotEqual(pub["tipo"], "sessao_caida")
        pub, _ = analisar([], 1)
        self.assertEqual(pub["estado"], "indeterminado")


class TestDiagnostico(unittest.TestCase):
    """O caminho completo, por arquivo, com a vida da sessao afirmada pelo teste."""

    def escreve(self, regs):
        d = tempfile.mkdtemp(prefix="saude-teste-")
        self.addCleanup(shutil.rmtree, d, True)
        p = Path(d, f"{SID}.jsonl")
        p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in regs))
        os.utime(p, (T0.timestamp(), T0.timestamp()))
        return p

    def test_sessao_caida(self):
        p = self.escreve([dono(0), resposta(1)])
        pub, _ = ss.diagnosticar("teste", str(p), agora=T0 + timedelta(minutes=5), vivo=False, checar_login=False)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("inativo", "sessao_caida", "reiniciar"))

    def test_sessao_caida_com_veneno_pede_modo_seguro(self):
        p = self.escreve([dono(0), resposta(1), dono(2)] + recusa(3))
        pub, _ = ss.diagnosticar("teste", str(p), agora=T0 + timedelta(minutes=30), vivo=False, checar_login=False)
        self.assertEqual((pub["tipo"], pub["recomendacao"]), ("sessao_caida", "modo_seguro"))
        self.assertIsNotNone(pub["trecho"])

    def test_cli_json(self):
        p = self.escreve([dono(0), resposta(1), dono(2)] + recusa(3))
        env = dict(os.environ, DGCLAW_WORKSPACE=str(p.parent), DGCLAW_SAUDE_CHECAR_LOGIN="off")
        r = subprocess.run([sys.executable, str(AQUI / "saude_sessao.py"), "--json", "--jsonl", str(p),
                            "--sem-checar-vida", "--agora", ts(30)], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["tipo"], "recusa")
        self.assertNotIn("_interno", d, "sem --interno, nada de caminho do servidor")
        r = subprocess.run([sys.executable, str(AQUI / "saude_sessao.py"), "--json", "--interno", "--jsonl", str(p),
                            "--sem-checar-vida", "--agora", ts(30)], capture_output=True, text=True, env=env)
        self.assertIn("_interno", json.loads(r.stdout))

    def test_login_conferido_sem_gastar_turno(self):
        # Um claude de mentira que diz "nao logado": o diagnostico ok vira atencao/login.
        d = tempfile.mkdtemp(prefix="saude-bin-")
        self.addCleanup(shutil.rmtree, d, True)
        fake = Path(d, "claude")
        fake.write_text("#!/bin/sh\necho '{\"loggedIn\": false, \"authMethod\": \"none\"}'\n")
        fake.chmod(0o755)
        p = self.escreve([dono(0), resposta(1)])
        velho = dict(os.environ)
        try:
            os.environ["DGCLAW_CLAUDE_BIN"] = str(fake)
            os.environ["DGCLAW_WORKSPACE"] = d
            pub, interno = ss.diagnosticar("teste", str(p), agora=T0 + timedelta(minutes=5),
                                           vivo=True, checar_login=True)
        finally:
            os.environ.clear()
            os.environ.update(velho)
        self.assertEqual((pub["estado"], pub["tipo"], pub["recomendacao"]), ("atencao", "login", "refazer_login"))
        self.assertIs(interno["login"]["logado"], False)


class TestAceiteProducao(unittest.TestCase):
    """Teste de ACEITE com os transcripts reais (so leitura), quando a maquina os tem.
    dois agentes mudos por "Login expired": o detector tem
    que dar inativo/login nos dois (vistoria de 01/10/2026, P0-1). Em outra maquina, pula."""

    def caso(self, agente):
        d = Path(f"/opt/dgclaw/agentes/{agente}/.claude/projects/-home-agente")
        if not d.is_dir():
            self.skipTest(f"sem os transcripts de {agente} nesta maquina")
        try:
            vivo = max(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
        except (ValueError, PermissionError) as e:
            self.skipTest(f"nao consegui ler {d}: {e}")
        pub, _ = ss.diagnosticar("x", str(vivo), checar_login=False)
        return pub

    def test_bento_login(self):
        pub = self.caso("bento-v2")
        if pub["tipo"] == "ok":
            self.skipTest("o login do Bento ja foi refeito; o caso de aceite passou")
        self.assertEqual((pub["estado"], pub["tipo"]), ("inativo", "login"))

    def test_ana_login(self):
        pub = self.caso("ana-v2")
        if pub["tipo"] == "ok":
            self.skipTest("o login da Ana ja foi refeito; o caso de aceite passou")
        self.assertEqual((pub["estado"], pub["tipo"]), ("inativo", "login"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
