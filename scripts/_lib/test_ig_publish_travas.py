#!/usr/bin/env python3
"""Testa o modo travado do scripts/ig-publish.py (DGCLAW_TRAVAS=1): o script nao chama a Graph API nem le o token,
pede a acao pela caixa (dgclaw-api, aqui um falso) e espera a aprovacao do TI.

Rodar: python3 scripts/_lib/test_ig_publish_travas.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "ig-publish.py"
ID = "a" * 24

# dgclaw-api de mentira: POST guarda o corpo recebido e devolve 202; GET devolve o arquivo aprovacao.json.
FALSO = """#!/usr/bin/env bash
dir="${FAKE_DIR:?}"
metodo="$1"; rota="$2"
echo "$metodo $rota" >> "$dir/chamadas.txt"
if [ "$metodo" = POST ]; then
  cat > "$dir/pedido.json"
  if [ -f "$dir/recusa-post" ]; then
    echo '{"status":409,"corpo":{"ok":false,"erro":"O token do Instagram deste agente nao esta no cofre do host."}}'
    exit 4
  fi
  echo '{"status":202,"corpo":{"ok":true,"pendente":true,"aprovacao":"%s"}}'
  exit 0
fi
printf '{"status":200,"corpo":{"aprovacao":%%s}}\\n' "$(cat "$dir/aprovacao.json")"
""" % ID


class ModoTravado(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        falso = self.dir / "dgclaw-api"
        falso.write_text(FALSO)
        falso.chmod(falso.stat().st_mode | stat.S_IXUSR)
        self.env = dict(os.environ, DGCLAW_TRAVAS="1", DGCLAW_API_CMD=str(falso), FAKE_DIR=str(self.dir))
        self.env.pop("DGCLAW_IG_ESPERA", None)

    def tearDown(self):
        self.tmp.cleanup()

    def aprovacao(self, estado, resultado=None):
        (self.dir / "aprovacao.json").write_text(json.dumps({"id": ID, "estado": estado, "resultado": resultado}))

    def rodar(self, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env or self.env, timeout=60)

    def pedido(self):
        return json.loads((self.dir / "pedido.json").read_text())

    def test_publicar_aprovado_imprime_o_permalink_e_nao_le_o_token(self):
        self.aprovacao("executada", {"saida": "Publicado no Instagram: https://instagram.com/p/x", "media_id": "99", "permalink": "https://instagram.com/p/x"})
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg",
                       "--caption", "Legenda do post", "--token-file", str(self.dir / "nao-existe"), "--espera", "5")
        self.assertEqual(r.returncode, 0, r.stderr)
        saida = json.loads(r.stdout)
        self.assertEqual(saida["permalink"], "https://instagram.com/p/x")
        self.assertEqual(saida["mediaId"], "99")
        p = self.pedido()
        self.assertEqual(p, {"op": "publicar", "conta": "17841400000000000", "legenda": "Legenda do post", "imagem_url": "https://exemplo.com/a.jpg"})
        self.assertNotIn("access_token", json.dumps(p))
        self.assertNotIn("graph.facebook.com", r.stdout + r.stderr)

    def test_legenda_longa_vem_do_arquivo(self):
        self.aprovacao("executada", {"saida": "ok"})
        (self.dir / "leg.txt").write_text("Linha 1\nLinha 2 com acento: coração\n")
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg",
                       "--caption-file", str(self.dir / "leg.txt"), "--token-file", "x", "--espera", "5")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.pedido()["legenda"], "Linha 1\nLinha 2 com acento: coração")

    def test_responder_comentario(self):
        self.aprovacao("executada", {"saida": "Respondi", "reply_id": "7"})
        r = self.rodar("reply-comment", "--comment-id", "17858893269000001", "--message", "Obrigado!", "--token-file", "x", "--espera", "5")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.pedido(), {"op": "responder", "comentario_id": "17858893269000001", "mensagem": "Obrigado!"})
        self.assertEqual(json.loads(r.stdout)["replyId"], "7")

    def test_recusado_pelo_ti_sai_com_1_e_diz_o_motivo(self):
        self.aprovacao("recusada", {"motivo": "a imagem esta errada"})
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg", "--caption", "x", "--token-file", "x", "--espera", "5")
        self.assertEqual(r.returncode, 1)
        self.assertIn("a imagem esta errada", r.stderr)
        self.assertIn("Nada foi publicado", r.stderr)

    def test_vencido_e_falhou(self):
        self.aprovacao("expirada")
        r = self.rodar("reply-comment", "--comment-id", "17858893269000001", "--message", "x", "--token-file", "x", "--espera", "5")
        self.assertEqual(r.returncode, 1)
        self.assertIn("venceu", r.stderr)
        self.aprovacao("falhou", {"erro": "O Instagram recusou publicar o post"})
        r = self.rodar("reply-comment", "--comment-id", "17858893269000001", "--message", "x", "--token-file", "x", "--espera", "5")
        self.assertEqual(r.returncode, 1)
        self.assertIn("O Instagram recusou", r.stderr)

    def test_ainda_pendente_sai_com_3_e_o_status_consulta_depois(self):
        self.aprovacao("pendente")
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg", "--caption", "x", "--token-file", "x", "--espera", "0")
        self.assertEqual(r.returncode, 3, r.stderr)
        saida = json.loads(r.stdout)
        self.assertTrue(saida["pendente"])
        self.assertEqual(saida["aprovacao"], ID)
        self.aprovacao("executada", {"saida": "ok", "permalink": "https://instagram.com/p/y"})
        r = self.rodar("status", "--aprovacao", ID)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["permalink"], "https://instagram.com/p/y")

    def test_o_web_recusa_o_pedido(self):
        (self.dir / "recusa-post").write_text("1")
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg", "--caption", "x", "--token-file", "x", "--espera", "0")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nao esta no cofre do host", r.stderr)

    def test_validate_explica_que_o_token_fica_no_host(self):
        r = self.rodar("validate", "--token-file", "x")
        self.assertEqual(r.returncode, 1)
        self.assertIn("dgclaw acoes instagram testar", r.stderr)

    def test_sem_dgclaw_api_diz_o_que_fazer(self):
        env = dict(self.env, DGCLAW_API_CMD=str(self.dir / "nao-existe"))
        r = self.rodar("publish-image", "--account", "17841400000000000", "--image-url", "https://exemplo.com/a.jpg", "--caption", "x", "--token-file", "x", env=env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("agente reparar", r.stderr)


class SemTravas(unittest.TestCase):
    def test_nivel_pessoal_continua_exigindo_o_token_file_e_nao_tem_status(self):
        env = {k: v for k, v in os.environ.items() if k != "DGCLAW_TRAVAS"}
        r = subprocess.run([sys.executable, str(SCRIPT), "publish-image", "--account", "1", "--image-url", "https://x/a.jpg"],
                           capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--token-file", r.stderr)
        r = subprocess.run([sys.executable, str(SCRIPT), "status", "--aprovacao", "x"], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("so existe no modo travado", r.stderr)


if __name__ == "__main__":
    unittest.main()
