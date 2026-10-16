#!/usr/bin/env python3
"""Contrato da lista: evidência, recorte temporal e entrega segura do mesmo conteúdo."""
import copy
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

CAMINHO = Path(__file__).resolve().parents[2] / "skills/lista-rapida/scripts/lista_rapida.py"
SPEC = importlib.util.spec_from_file_location("lista_rapida", CAMINHO)
lista = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lista)


class ListaRapidaTest(unittest.TestCase):
    def setUp(self):
        self.fontes = {"periodo": "Hoje", "inicio": "2026-10-16T00:00:00-03:00",
                       "fim": "2026-10-16T12:00:00-03:00", "avisos": [], "fontes": [
                           {"id": "p1", "tipo": "chat", "data": "2026-10-16T03:00:00Z",
                            "papel": "pessoa", "texto": "Prepare o relatório"},
                           {"id": "r1", "tipo": "mesa", "data": "2026-10-16T11:00:00-03:00",
                            "papel": "contexto", "texto": "Relatório entregue"}]}
        self.item = {"pedido": "Relatório entregue", "status": "pronto",
                     "pedido_em": "2026-10-16T03:00:00Z", "evidencias": ["p1"],
                     "evidencias_status": ["r1"]}

    def test_meia_noite_no_fuso_e_nao_em_utc(self):
        lista.validar(self.fontes, {"itens": [self.item]})
        self.item["pedido_em"] = "2026-10-16T02:59:59Z"
        with self.assertRaises(ValueError):
            lista.validar(self.fontes, {"itens": [self.item]})

    def test_evidencia_de_status_obrigatoria(self):
        for valor in ([], ["inventada"], "r1"):
            self.item["evidencias_status"] = valor
            with self.assertRaises(ValueError):
                lista.validar(self.fontes, {"itens": [self.item]})

    def test_nao_aceita_evidencia_do_futuro(self):
        self.fontes["fontes"][1]["data"] = "2026-10-17T00:00:00-03:00"
        with self.assertRaises(ValueError):
            lista.validar(self.fontes, {"itens": [self.item]})

    def test_nao_inventa_status_e_nao_repete_pedido(self):
        with self.assertRaises(ValueError):
            lista.validar(self.fontes, {"itens": [self.item, self.item]})
        self.item["status"] = "quase"
        with self.assertRaises(ValueError):
            lista.validar(self.fontes, {"itens": [self.item]})

    def test_html_escapa_conteudo_e_texto_preserva_numero(self):
        self.item["pedido"] = 'Revisar <img src=x onerror="alert(1)"> & contrato'
        segundo = copy.deepcopy(self.item)
        segundo.update(status="esperando_voce", pedido="Escolher a versão do contrato")
        self.fontes["periodo"] = "Hoje <script>"
        self.fontes["avisos"] = ["Diário <indisponível>"]
        with tempfile.TemporaryDirectory() as tmp:
            saida = lista.renderizar(self.fontes, {"itens": [segundo, self.item]}, Path(tmp))
            html = Path(saida["html"]).read_text()
            texto = Path(saida["texto"]).read_text()
            self.assertNotIn('<img src=x', html)
            self.assertIn('&lt;img', html)
            self.assertIn('2. Escolher', texto)
            self.assertIn('<ol start="2">', html)
            self.assertIn('Cobertura: Diário <indisponível>', texto)
            self.assertTrue(Path(saida["html"]).name.startswith('vis-lista-rapida-'))
            self.assertEqual(stat.S_IMODE(Path(saida["html"]).stat().st_mode), 0o600)

    def test_vazio_explica_nos_dois_formatos(self):
        with tempfile.TemporaryDirectory() as tmp:
            saida = lista.renderizar(self.fontes, {"itens": []}, Path(tmp))
            for formato in ("html", "texto"):
                self.assertIn("Nenhum pedido encontrado", Path(saida[formato]).read_text())

    def test_nao_sobrescreve_arquivo_ou_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'privado'
            p.write_text('preservar')
            link = Path(tmp) / 'link'
            link.symlink_to(p)
            with self.assertRaises(FileExistsError):
                lista.gravar(link, 'substituir')
            self.assertEqual(p.read_text(), 'preservar')

    def test_haiku_isolado_nao_herda_chave_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            cred = Path(tmp) / 'login.json'
            cred.write_text('{}')

            def executar(cmd, **kwargs):
                self.assertEqual(cmd[cmd.index('--model') + 1], 'haiku')
                self.assertEqual(cmd[cmd.index('--tools') + 1], '')
                self.assertNotIn('ANTHROPIC_API_KEY', kwargs['env'])
                self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN', kwargs['env'])
                self.assertEqual(json.loads(kwargs['input']), self.fontes)
                cfg = Path(kwargs['env']['CLAUDE_CONFIG_DIR'])
                self.assertEqual(stat.S_IMODE((cfg / '.credentials.json').stat().st_mode), 0o600)
                return type('Resultado', (), {'returncode': 0, 'stdout': json.dumps({
                    'result': json.dumps({'itens': [self.item]}), 'modelUsage': {'haiku': {}}})})()

            with patch.object(lista.shutil, 'which', return_value='/bin/claude'), \
                 patch.object(lista.subprocess, 'run', side_effect=executar), \
                 patch.dict(lista.os.environ, {'ANTHROPIC_API_KEY': 'chave-falsa',
                                              'CLAUDE_CODE_OAUTH_TOKEN': 'token-falso'}):
                self.assertEqual(lista.resumir(self.fontes, cred)['itens'], [self.item])


if __name__ == '__main__':
    unittest.main()
