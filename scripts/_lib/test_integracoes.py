#!/usr/bin/env python3
"""Testes do scripts/_lib/integracoes.py: formatos, aparo, limites, poda, estado e concorrencia."""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import integracoes as I  # noqa: E402

ERA_ROOT = os.geteuid() == 0   # antes de qualquer mock
T0 = datetime.datetime(2026, 11, 17, 12, 0, 0, tzinfo=datetime.timezone.utc)


def em(seg):
    return T0 + datetime.timedelta(seconds=seg)


def ev(seg, iid, resultado, origem="uso"):
    return {"em": I._fmt(em(seg)), "id": iid, "resultado": resultado, "origem": origem}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "integracoes")
        self._antigo = os.environ.get("DGCLAW_INTEGRACOES_DIR")
        os.environ["DGCLAW_INTEGRACOES_DIR"] = self.dir
        # o registro recusa root; os testes simulam o usuario do agente (os de root usam o proprio mock)
        self._nao_root = mock.patch.object(I.os, "geteuid", return_value=1000)
        self._nao_root.start()

    def tearDown(self):
        self._nao_root.stop()
        if self._antigo is None:
            os.environ.pop("DGCLAW_INTEGRACOES_DIR", None)
        else:
            os.environ["DGCLAW_INTEGRACOES_DIR"] = self._antigo
        self.tmp.cleanup()

    def linhas(self):
        with open(os.path.join(self.dir, "eventos.jsonl")) as f:
            return [json.loads(x) for x in f if x.strip()]

    def estado(self):
        with open(os.path.join(self.dir, "estado.json")) as f:
            return json.load(f)

    def estado_de(self, iid):
        return next(x for x in self.estado()["integracoes"] if x["id"] == iid)


class TestEntradas(Base):
    def test_formatos_de_id_recusados(self):
        for ruim in ["", "A", "-a", "a b", "a/b", "a" * 33, "ação", "../x", None]:
            with self.assertRaises(I.ErroUso, msg=repr(ruim)):
                I.registrar(ruim, "ok", agora=T0)
        self.assertFalse(os.path.exists(self.dir))

    def test_id_com_quebra_de_linha_final_e_recusado(self):
        with self.assertRaises(I.ErroUso):
            I.registrar("instagram\n", "ok", agora=T0)
        self.assertFalse(os.path.exists(self.dir))

    def test_releitura_ignora_id_com_quebra_de_linha_e_id_que_nao_e_texto(self):
        bom = ev(0, "groq", "ok")
        linhas = [json.dumps({**bom, "id": "instagram\n"}), json.dumps({**bom, "id": 5}), json.dumps({**bom, "id": ["groq"]}), json.dumps(bom)]
        self.assertEqual(I._eventos_validos(linhas), [bom])

    def test_ids_validos(self):
        for bom in ["a", "0", "nota-fiscal", "a" * 32]:
            I.registrar(bom, "erro", agora=T0)

    def test_lista_fechada_de_resultados_e_origens(self):
        with self.assertRaises(I.ErroUso):
            I.registrar("instagram", "talvez", agora=T0)
        with self.assertRaises(I.ErroUso):
            I.registrar("instagram", "ok", origem="manual", agora=T0)
        for r in I.RESULTADOS:
            I.registrar("x", r, agora=T0)

    def test_nunca_grava_texto_livre(self):
        I.registrar("instagram", "erro", agora=T0)
        self.assertEqual(set(self.linhas()[0]), {"em", "id", "resultado", "origem"})


class TestGravacao(Base):
    def test_aparo_de_ok_em_60_minutos(self):
        self.assertEqual(I.registrar("groq", "ok", agora=em(0)), "gravado")
        self.assertEqual(I.registrar("groq", "ok", agora=em(30 * 60)), "aparado")
        self.assertEqual(len(self.linhas()), 1)
        self.assertEqual(I.registrar("groq", "ok", agora=em(61 * 60)), "gravado")
        self.assertEqual(len(self.linhas()), 2)

    def test_aparo_e_por_integracao(self):
        I.registrar("groq", "ok", agora=em(0))
        self.assertEqual(I.registrar("openai", "ok", agora=em(10)), "gravado")

    def test_falha_sempre_grava(self):
        I.registrar("groq", "ok", agora=em(0))
        for i in range(1, 4):
            self.assertEqual(I.registrar("groq", "rede", agora=em(i)), "gravado")
        self.assertEqual(len(self.linhas()), 4)

    def test_limite_de_50_ids(self):
        for i in range(50):
            I.registrar(f"i{i}", "ok", agora=em(i))
        with self.assertRaises(I.ErroGravacao) as c:
            I.registrar("i50", "ok", agora=em(100))
        self.assertIn("50", str(c.exception))
        I.registrar("i3", "erro", agora=em(101))  # id que ja existe continua valendo

    def test_poda_30_dias_e_5000_linhas(self):
        os.makedirs(self.dir)
        antigo = ev(-31 * 86400, "velho", "erro")
        recentes = [ev(-3600 + i % 3000, "volume", "erro") for i in range(5100)]
        with open(os.path.join(self.dir, "eventos.jsonl"), "w") as f:
            for e in [antigo] + recentes:
                f.write(json.dumps(e) + "\n")
        I.registrar("novo", "erro", agora=T0)
        linhas = self.linhas()
        self.assertEqual(len(linhas), 5000)
        self.assertNotIn("velho", {e["id"] for e in linhas})
        self.assertEqual(linhas[-1]["id"], "novo")

    def test_arquivos_e_modos(self):
        I.registrar("groq", "ok", agora=T0)
        self.assertEqual(os.stat(self.dir).st_mode & 0o777, 0o755)
        for nome in ("eventos.jsonl", "estado.json"):
            self.assertEqual(os.stat(os.path.join(self.dir, nome)).st_mode & 0o777, 0o644, nome)
        self.assertEqual(sorted(os.listdir(self.dir)), [".trava", "estado.json", "eventos.jsonl"])

    def test_falha_na_troca_do_historico_deixa_o_estado_com_o_evento(self):
        original = I._troca_atomica
        def falha_no_historico(caminho, conteudo):
            if caminho.endswith("eventos.jsonl"):
                raise OSError(28, "No space left on device")
            return original(caminho, conteudo)
        with mock.patch.object(I, "_troca_atomica", side_effect=falha_no_historico):
            with self.assertRaises(I.ErroGravacao):
                I.registrar("groq", "erro", agora=T0)
        self.assertEqual(self.estado_de("groq")["ultimoResultado"], "erro")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "eventos.jsonl")))

    def test_gravacao_atomica_nao_deixa_temporario(self):
        for i in range(5):
            I.registrar("groq", "erro", agora=em(i))
        self.assertFalse([n for n in os.listdir(self.dir) if n.startswith(".tmp-")])
        self.assertEqual(self.estado()["versao"], 1)

    def test_root_e_recusado_com_mensagem_clara(self):
        with mock.patch.object(I.os, "geteuid", return_value=0):
            with self.assertRaises(I.ErroGravacao) as c:
                I.registrar("groq", "ok", agora=T0)
        self.assertIn("root", str(c.exception))
        self.assertFalse(os.path.exists(self.dir))
        antigo, sys.stderr = sys.stderr, open(os.devnull, "w")
        try:
            with mock.patch.object(I.os, "geteuid", return_value=0):
                I.registrar_silencioso("groq", "ok")   # nao levanta
        finally:
            sys.stderr.close()
            sys.stderr = antigo

    def test_pasta_que_ja_existe_nao_tem_o_modo_mexido(self):
        os.makedirs(self.dir, mode=0o700)
        os.chmod(self.dir, 0o700)
        I.registrar("groq", "ok", agora=T0)
        self.assertEqual(os.stat(self.dir).st_mode & 0o777, 0o700)

    def test_pasta_final_link_simbolico_e_recusada(self):
        alvo = os.path.join(self.tmp.name, "outra")
        os.makedirs(alvo)
        os.symlink(alvo, self.dir)
        with self.assertRaises(I.ErroGravacao) as c:
            I.registrar("groq", "ok", agora=T0)
        self.assertIn("link simbolico", str(c.exception))
        self.assertEqual(os.listdir(alvo), [])

    def test_linha_estragada_e_ignorada(self):
        os.makedirs(self.dir)
        with open(os.path.join(self.dir, "eventos.jsonl"), "w") as f:
            f.write("isto nao e json\n" + json.dumps(ev(-10, "groq", "ok")) + "\n" + '{"id":"x"}\n')
        I.registrar("groq", "erro", agora=T0)
        self.assertEqual(len(self.linhas()), 2)

    def test_erro_de_gravacao_explica(self):
        arq = os.path.join(self.tmp.name, "arquivo")
        open(arq, "w").close()
        os.environ["DGCLAW_INTEGRACOES_DIR"] = os.path.join(arq, "sub")
        with self.assertRaises(I.ErroGravacao) as c:
            I.registrar("groq", "ok", agora=T0)
        self.assertIn("groq", str(c.exception))
        self.assertIn("Confira", str(c.exception))

    def test_registrar_silencioso_nao_derruba(self):
        arq = os.path.join(self.tmp.name, "arquivo")
        open(arq, "w").close()
        os.environ["DGCLAW_INTEGRACOES_DIR"] = os.path.join(arq, "sub")
        antigo, sys.stderr = sys.stderr, open(os.devnull, "w")
        try:
            I.registrar_silencioso("groq", "ok")
            I.registrar_silencioso("ID RUIM", "ok")
        finally:
            sys.stderr.close()
            sys.stderr = antigo

    def test_concorrencia_dois_processos_sem_perder_linha(self):
        codigo = (
            "import sys; sys.path.insert(0, sys.argv[1]); import integracoes as I\n"
            "import os; os.geteuid = lambda: 1000\n"
            "for i in range(40): I.registrar(sys.argv[2], 'erro')\n"
        )
        env = dict(os.environ)
        ps = [subprocess.Popen([sys.executable, "-I", "-c", codigo, AQUI, nome], env=env) for nome in ("aa", "bb", "cc")]
        for p in ps:
            self.assertEqual(p.wait(), 0)
        linhas = self.linhas()
        self.assertEqual(len(linhas), 120)
        for nome in ("aa", "bb", "cc"):
            self.assertEqual(sum(1 for e in linhas if e["id"] == nome), 40)


class TestEstado(unittest.TestCase):
    def calc(self, eventos, seg=0):
        return {x["id"]: x for x in I.calcular_estado(eventos, em(seg))}

    def test_verde_com_ok(self):
        e = self.calc([ev(0, "a", "ok")])["a"]
        self.assertEqual(e["estado"], "verde")
        self.assertEqual(e["ultimoOk"], I._fmt(em(0)))
        self.assertIsNone(e["ultimaFalha"])

    def test_amarelo_para_ultimo_leve(self):
        for r in ("rede", "limite", "incerto", "vencendo", "erro"):
            self.assertEqual(self.calc([ev(0, "a", "ok"), ev(10, "a", r)], 20)["a"]["estado"], "amarelo", r)

    def test_amarelo_para_falha_grave_unica(self):
        for r in ("credencial_recusada", "sem_saldo", "fora_do_ar"):
            self.assertEqual(self.calc([ev(0, "a", "ok"), ev(10, "a", r)], 20)["a"]["estado"], "amarelo", r)

    def test_vermelho_com_duas_observacoes_a_120s(self):
        e = self.calc([ev(0, "a", "credencial_recusada"), ev(120, "a", "sem_saldo")], 130)["a"]
        self.assertEqual(e["estado"], "vermelho")

    def test_nao_vermelho_com_duas_a_30s(self):
        e = self.calc([ev(0, "a", "fora_do_ar"), ev(30, "a", "fora_do_ar")], 40)["a"]
        self.assertEqual(e["estado"], "amarelo")

    def test_desconectado_e_vermelho_direto(self):
        self.assertEqual(self.calc([ev(0, "a", "desconectado", "canal")], 5)["a"]["estado"], "vermelho")

    def test_ok_depois_volta_a_verde(self):
        ev_ = [ev(0, "a", "credencial_recusada"), ev(200, "a", "credencial_recusada"), ev(300, "a", "ok")]
        self.assertEqual(self.calc(ev_, 310)["a"]["estado"], "verde")
        ev_ = [ev(0, "a", "desconectado"), ev(300, "a", "ok")]
        self.assertEqual(self.calc(ev_, 310)["a"]["estado"], "verde")

    def test_falha_antes_do_ok_nao_conta(self):
        ev_ = [ev(0, "a", "fora_do_ar"), ev(10, "a", "ok"), ev(300, "a", "fora_do_ar")]
        self.assertEqual(self.calc(ev_, 310)["a"]["estado"], "amarelo")

    def test_vermelho_persiste_com_evento_leve_depois(self):
        ev_ = [ev(0, "a", "sem_saldo"), ev(200, "a", "sem_saldo"), ev(300, "a", "rede")]
        self.assertEqual(self.calc(ev_, 310)["a"]["estado"], "vermelho")

    def test_sem_uso_recente_apos_7_dias(self):
        e = self.calc([ev(0, "a", "ok")], 7 * 86400 + 1)["a"]
        self.assertEqual(e["estado"], "sem_uso_recente")
        self.assertEqual(self.calc([ev(0, "a", "ok")], 7 * 86400 - 1)["a"]["estado"], "verde")

    def test_sai_do_estado_apos_30_dias(self):
        self.assertNotIn("a", self.calc([ev(0, "a", "ok")], 30 * 86400 + 1))
        self.assertIn("a", self.calc([ev(0, "a", "ok")], 30 * 86400 - 1))

    def test_campos_de_falha_e_tentativa(self):
        e = self.calc([ev(0, "a", "ok"), ev(10, "a", "limite", "canal"), ev(20, "a", "ok")], 30)["a"]
        self.assertEqual(e["ultimaFalha"], I._fmt(em(10)))
        self.assertEqual(e["ultimaFalhaResultado"], "limite")
        self.assertEqual(e["ultimaTentativaReal"], I._fmt(em(20)))
        self.assertEqual(e["ultimoResultado"], "ok")

    def test_integracoes_independentes(self):
        r = self.calc([ev(0, "a", "ok"), ev(5, "b", "desconectado")], 10)
        self.assertEqual((r["a"]["estado"], r["b"]["estado"]), ("verde", "vermelho"))


    def test_ok_apos_falha_termina_verde(self):
        r = self.calc([ev(0, "a", "ok"), ev(120, "a", "desconectado", "canal"), ev(240, "a", "ok")], 250)["a"]
        self.assertEqual(r["estado"], "verde")

    def test_empate_de_horario_vale_a_ordem_de_registro(self):
        r = self.calc([ev(0, "a", "ok"), ev(0, "a", "desconectado", "canal")], 5)["a"]
        self.assertEqual(r["estado"], "vermelho")


class TestAparoConsecutivo(Base):
    def test_ok_depois_de_falha_nunca_e_descartado(self):
        self.assertEqual(I.registrar("groq", "ok", agora=em(0)), "gravado")
        self.assertEqual(I.registrar("groq", "desconectado", "canal", agora=em(120)), "gravado")
        self.assertEqual(I.registrar("groq", "ok", agora=em(240)), "gravado")
        self.assertEqual(self.estado_de("groq")["estado"], "verde")


class TestLeituraEtrava(Base):
    def test_link_simbolico_no_eventos_e_recusado(self):
        os.makedirs(self.dir)
        alvo = os.path.join(self.tmp.name, "alvo.jsonl")
        with open(alvo, "w") as f:
            f.write("")
        os.symlink(alvo, os.path.join(self.dir, "eventos.jsonl"))
        with self.assertRaises(I.ErroGravacao):
            I.registrar("groq", "ok", agora=T0)

    def test_eventos_que_nao_e_arquivo_comum_e_recusado(self):
        os.makedirs(os.path.join(self.dir, "eventos.jsonl"))
        with self.assertRaises(I.ErroGravacao):
            I.registrar("groq", "ok", agora=T0)

    def test_leitura_limitada_ao_fim_do_arquivo(self):
        os.makedirs(self.dir)
        linha = json.dumps(ev(0, "velho", "ok")) + "\n"
        com_o_velho = linha * (I.MAX_BYTES_LEITURA // len(linha) + 50)
        with open(os.path.join(self.dir, "eventos.jsonl"), "w") as f:
            f.write(com_o_velho)
            f.write(json.dumps(ev(10, "novo", "ok")) + "\n")
        lidos = I._ler_eventos(os.path.join(self.dir, "eventos.jsonl"))
        self.assertLess(len(lidos), I.MAX_BYTES_LEITURA // len(linha) + 50)
        self.assertEqual(lidos[-1]["id"], "novo")
        self.assertTrue(all(e["id"] in ("velho", "novo") for e in lidos))  # a linha cortada ao meio ficou de fora

    def test_trava_ocupada_desiste_no_prazo(self):
        import fcntl
        os.makedirs(self.dir)
        antigo = I.ESPERA_TRAVA_SEG
        I.ESPERA_TRAVA_SEG = 0.2
        with open(os.path.join(self.dir, ".trava"), "a") as t:
            fcntl.flock(t.fileno(), fcntl.LOCK_EX)
            try:
                with self.assertRaises(I.ErroGravacao) as c:
                    I.registrar("groq", "ok", agora=T0)
            finally:
                I.ESPERA_TRAVA_SEG = antigo
        self.assertIn("trava", str(c.exception))


class TestCli(Base):
    def rodar(self, *args):
        return subprocess.run([os.path.join(AQUI, "..", "..", "bin", "dgclaw-integracao"), *args],
                              capture_output=True, text=True, env=dict(os.environ))

    def rodar_sem_root(self, *args):
        """Como root o registro recusa; neste caso roda o comando como o usuario sem privilegio."""
        if not ERA_ROOT:
            return self.rodar(*args)
        os.chmod(self.tmp.name, 0o777)
        def baixa():
            os.setgid(65534)
            os.setuid(65534)
        return subprocess.run([os.path.join(AQUI, "..", "..", "bin", "dgclaw-integracao"), *args],
                              capture_output=True, text=True, env=dict(os.environ), preexec_fn=baixa)

    def test_registrar_como_root_sai_1_com_mensagem(self):
        if not ERA_ROOT:
            self.skipTest("so faz sentido rodando como root")
        r = self.rodar("registrar", "instagram", "ok")
        self.assertEqual(r.returncode, 1)
        self.assertIn("root", r.stderr)
        self.assertFalse(os.path.exists(self.dir))

    def test_registrar_e_estado(self):
        r0 = self.rodar_sem_root("registrar", "instagram", "ok")
        self.assertEqual(r0.returncode, 0, r0.stderr)
        r = self.rodar_sem_root("estado")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["integracoes"][0]["id"], "instagram")

    def test_uso_errado_sai_2_em_portugues(self):
        for args in [(), ("registrar",), ("registrar", "a"), ("registrar", "a", "xpto"), ("registrar", "A", "ok"),
                     ("registrar", "a", "ok", "--origem"), ("voar",)]:
            r = self.rodar(*args)
            self.assertEqual(r.returncode, 2, args)
            self.assertTrue(r.stderr.strip(), args)

    def test_estado_sem_arquivo(self):
        self.assertEqual(json.loads(self.rodar_sem_root("estado").stdout)["integracoes"], [])

    def test_estado_como_root_sai_1_com_a_mesma_mensagem(self):
        if not ERA_ROOT:
            self.skipTest("so faz sentido rodando como root")
        r = self.rodar("estado")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nao pode rodar como root", r.stderr)
        self.assertEqual(r.stdout, "")

    def _estado_bom(self):
        return {"versao": 1, "geradoEm": I._fmt(T0), "integracoes": [{
            "id": "groq", "estado": "verde", "ultimoEvento": I._fmt(T0), "ultimoResultado": "ok", "ultimoOk": I._fmt(T0),
            "ultimaTentativaReal": I._fmt(T0), "ultimaFalha": None, "ultimaFalhaResultado": None}]}

    def test_estado_imprime_so_campos_validados(self):
        os.makedirs(self.dir)
        e = self._estado_bom()
        e["integracoes"][0]["extra"] = "SEGREDO-DO-AGENTE"
        e["lixo"] = "SEGREDO-DO-AGENTE"
        with open(os.path.join(self.dir, "estado.json"), "w") as f:
            json.dump(e, f)
        os.chmod(self.dir, 0o755)
        os.chmod(os.path.join(self.dir, "estado.json"), 0o644)
        r = self.rodar_sem_root("estado")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("SEGREDO", r.stdout)
        self.assertEqual(json.loads(r.stdout)["integracoes"][0]["id"], "groq")

    def test_estado_invalido_grande_link_e_fifo_sao_recusados(self):
        os.makedirs(self.dir)
        os.chmod(self.dir, 0o755)
        arq = os.path.join(self.dir, "estado.json")
        ruins = {
            "json": "{SEGREDO quebrado",
            "formato": json.dumps({"versao": 2, "integracoes": []}),
            "id": json.dumps({**self._estado_bom(), "integracoes": [{**self._estado_bom()["integracoes"][0], "id": "groq\n"}]}),
            "grande": json.dumps({**self._estado_bom(), "lixo": "x" * (I.MAX_BYTES_ESTADO + 10)}),
        }
        for nome, texto in ruins.items():
            with self.subTest(nome):
                with open(arq, "w") as f:
                    f.write(texto)
                os.chmod(arq, 0o644)
                r = self.rodar_sem_root("estado")
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertEqual(r.stdout, "")
                self.assertNotIn("SEGREDO", r.stderr)
                os.unlink(arq)
        with self.subTest("link"):
            alvo = os.path.join(self.tmp.name, "alvo.json")
            with open(alvo, "w") as f:
                json.dump(self._estado_bom(), f)
            os.chmod(alvo, 0o644)
            os.symlink(alvo, arq)
            self.assertEqual(self.rodar_sem_root("estado").returncode, 1)
            os.unlink(arq)
        with self.subTest("fifo"):
            os.mkfifo(arq)
            r = self.rodar_sem_root("estado")
            self.assertEqual(r.returncode, 1)
            self.assertIn("arquivo comum", r.stderr)


if __name__ == "__main__":
    unittest.main()
