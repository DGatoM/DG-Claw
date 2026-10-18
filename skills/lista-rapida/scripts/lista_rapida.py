#!/usr/bin/env python3
"""Síntese isolada em Haiku e entrega de texto/HTML a partir das mesmas evidências."""
import argparse
from datetime import datetime
from html import escape
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

GRUPOS = {"pronto": "Pronto", "andando": "Andando",
          "esperando_voce": "Esperando você", "travado": "Travado"}


def data(valor):
    dt = datetime.fromisoformat(valor.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("data sem fuso; use ISO-8601 com deslocamento")
    return dt


def validar_fontes(fontes):
    inicio, fim = data(fontes["inicio"]), data(fontes["fim"])
    if inicio > fim:
        raise ValueError("início posterior ao fim")
    if not isinstance(fontes.get("periodo"), str) or not fontes["periodo"].strip():
        raise ValueError("período sem descrição")
    ids = set()
    for fonte in fontes["fontes"]:
        if not isinstance(fonte["id"], str) or not fonte["id"] or fonte["id"] in ids:
            raise ValueError("ID de fonte vazio ou repetido")
        ids.add(fonte["id"])
        if fonte["tipo"] not in {"chat", "memoria", "mesa", "diario"}:
            raise ValueError("tipo de fonte desconhecido")
        if fonte["papel"] not in {"pessoa", "agente", "contexto"}:
            raise ValueError("papel de fonte desconhecido")
        if data(fonte["data"]) > fim:
            raise ValueError("fonte posterior ao momento da consulta")
        if not isinstance(fonte["texto"], str):
            raise ValueError("texto de fonte inválido")
    if not isinstance(fontes.get("avisos", []), list) or any(
            not isinstance(a, str) for a in fontes.get("avisos", [])):
        raise ValueError("avisos devem ser uma lista de textos")
    return ids


def validar(fontes, resumo):
    ids = validar_fontes(fontes)
    if not isinstance(resumo.get("itens"), list):
        raise ValueError("resumo sem lista de itens")
    vistos = set()
    for item in resumo["itens"]:
        texto = item["pedido"]
        if (not isinstance(texto, str) or not texto.strip() or len(texto) > 160
                or any(c in texto for c in "\n\r\t\u2014")):
            raise ValueError("pedido precisa de uma frase de até 160 caracteres, sem travessão")
        if item["status"] not in GRUPOS:
            raise ValueError("status desconhecido")
        if not data(fontes["inicio"]) <= data(item["pedido_em"]) <= data(fontes["fim"]):
            raise ValueError("pedido fora do período")
        for campo in ("evidencias", "evidencias_status"):
            evidencias = item.get(campo)
            if (not isinstance(evidencias, list) or not evidencias
                    or any(not isinstance(e, str) or e not in ids for e in evidencias)):
                raise ValueError("pedido ou status sem evidência válida")
        chave = " ".join(texto.casefold().split())
        if chave in vistos:
            raise ValueError("pedido duplicado; reconcilie antes de entregar")
        vistos.add(chave)
    return resumo["itens"]


def gravar(path, texto):
    # Exclusivo e privado: não sobrescreve entregas nem segue symlinks existentes.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(texto)


def resumir(fontes, credenciais):
    validar_fontes(fontes)
    cli = shutil.which("claude")
    if not cli or not credenciais.is_file():
        raise ValueError("Haiku indisponível; confira o CLI e o arquivo de login OAuth do agente")
    prompt = Path(__file__).with_name("sintese.txt").read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="lista-rapida-haiku-") as tmp:
        cfg = Path(tmp) / "config"
        cfg.mkdir(mode=0o700)
        shutil.copyfile(credenciais, cfg / ".credentials.json")
        (cfg / ".credentials.json").chmod(0o600)
        # Evita cobrança por API e impede que contexto ou MCP do agente entre na síntese.
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("ANTHROPIC_", "CLAUDE", "DGTG_", "DGCLAW_"))}
        env.update(CLAUDE_CONFIG_DIR=str(cfg), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                   CLAUDE_CODE_MAX_OUTPUT_TOKENS="12000")
        cmd = [cli, "--print", "--safe-mode", "--model", "haiku", "--tools", "",
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--setting-sources", "", "--no-session-persistence", "--max-turns", "1",
               "--output-format", "json", "--system-prompt", prompt]
        proc = subprocess.run(cmd, input=json.dumps(fontes, ensure_ascii=False),
                              capture_output=True, text=True, cwd=tmp, env=env, timeout=180)
        if proc.returncode:
            raise ValueError(f"Haiku saiu com código {proc.returncode}; confira login/modelo")
        resposta = json.loads(proc.stdout)
        if resposta.get("is_error"):
            raise ValueError("Haiku não concluiu a síntese; confira login/modelo")
        texto = resposta.get("result", "").strip()
        if texto.startswith("```"):
            texto = texto.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        resumo = json.loads(texto)
        validar(fontes, resumo)
        # Metadados comprovam a execução sem guardar o histórico privado do processo.
        resumo["motor"] = {"provedor": "claude", "modelo": "haiku",
                            "modelos_usados": list(resposta.get("modelUsage", {})),
                            "uso": resposta.get("usage", {})}
        return resumo


CSS = """
*{box-sizing:border-box}html{color-scheme:light dark;--fundo:#f3f5f9;--papel:#fff;
--texto:#19253a;--suave:#59657a;--linha:#dfe5ef;--acento:#405cd6}
@media(prefers-color-scheme:dark){html:not([data-lista-tema=claro]){--fundo:#10151f;
--papel:#1b2331;--texto:#f0f3fb;--suave:#b3bed0;--linha:#344155;--acento:#a2b3ff}}
html[data-lista-tema=escuro]{color-scheme:dark;--fundo:#10151f;--papel:#1b2331;
--texto:#f0f3fb;--suave:#b3bed0;--linha:#344155;--acento:#a2b3ff}
html[data-lista-tema=claro]{color-scheme:light}
body{margin:0;padding:24px 16px;background:var(--fundo);color:var(--texto);
font:16px/1.5 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}
main{max-width:720px;margin:0 auto}.topo{display:flex;align-items:center;gap:12px;
justify-content:space-between}.marca{font-size:12px;font-weight:750;letter-spacing:.12em;
color:var(--acento)}button{border:1px solid var(--linha);border-radius:99px;
padding:9px 13px;background:var(--papel);color:var(--texto);font:inherit;font-size:13px;
cursor:pointer;flex-shrink:0}button:focus-visible{outline:3px solid var(--acento)}
h1{font-size:clamp(28px,7vw,42px);line-height:1.1;letter-spacing:-.04em;margin:22px 0 8px}
.periodo,.rodape{color:var(--suave);font-size:14px}.periodo{margin:0 0 22px}
section{border:1px solid var(--linha);border-radius:18px;background:var(--papel);
margin:12px 0;padding:18px}h2{display:flex;gap:9px;align-items:center;font-size:15px;
margin:0 0 12px}.ponto{width:9px;height:9px;border-radius:50%;background:#6287ee}
.pronto .ponto{background:#37b98a}.esperando_voce .ponto{background:#ddaa45}
.travado .ponto{background:#e97678}.contagem{margin-left:auto;color:var(--suave);
font-size:12px}ol{margin:0;padding-left:28px}li{padding:7px 0 7px 5px}
li+li{border-top:1px solid var(--linha)}li::marker{color:var(--suave);font-size:13px}
.rodape{margin:20px 2px 0}.aviso{border-left:3px solid #ddaa45;padding-left:12px}
@media(max-width:360px){body{padding:16px 10px}section{padding:14px}}
"""
JS = """
(()=>{const root=document.documentElement,botao=document.getElementById('tema');
const aplica=t=>{root.dataset.listaTema=t;botao.setAttribute('aria-label',
t==='escuro'?'Ativar tema claro':'Ativar tema escuro')};
const inicial=window.dgvis?.tema||(matchMedia('(prefers-color-scheme:dark)').matches?'escuro':'claro');
aplica(inicial);window.dgvis?.on('tema',aplica);
botao.addEventListener('click',()=>aplica(root.dataset.listaTema==='escuro'?'claro':'escuro'));
})();
"""


def renderizar(fontes, resumo, destino):
    itens = validar(fontes, resumo)
    periodo = fontes["periodo"]
    instante = data(fontes["fim"]).strftime("%d/%m/%Y às %H:%M %z")
    linhas = [f"Lista rápida • {periodo}", ""]
    secoes, numero = [], 1
    for status, nome in GRUPOS.items():
        grupo = [i for i in itens if i["status"] == status]
        if not grupo:
            continue
        linhas.append(nome)
        lista = []
        inicio = numero
        for item in grupo:
            linhas.append(f"{numero}. {item['pedido']}")
            lista.append(f"<li>{escape(item['pedido'])}</li>")
            numero += 1
        linhas.append("")
        secoes.append(f'<section class="{status}"><h2><span class="ponto" aria-hidden="true"></span>'
                      f'{nome}<span class="contagem">{len(grupo)}</span></h2>'
                      f'<ol start="{inicio}">{"".join(lista)}</ol></section>')
    if not itens:
        vazio = "Nenhum pedido encontrado neste período nas fontes consultadas."
        linhas.append(vazio)
        secoes.append(f"<section><p>{vazio}</p></section>")
    avisos = fontes.get("avisos", [])
    for aviso in avisos:
        linhas.append(f"Cobertura: {aviso}")
    linhas.append(f"Atualizada em {instante}.")
    alertas = "".join(f'<p class="rodape aviso">Cobertura: {escape(a)}</p>' for a in avisos)
    html = ('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="color-scheme" content="light dark">'
            '<title>Lista rápida</title><style>' + CSS + '</style></head><body><main>'
            '<div class="topo"><span class="marca">DG CLAW · SEUS PEDIDOS</span>'
            '<button id="tema" type="button">Claro / escuro</button></div>'
            f'<h1>Lista rápida</h1><p class="periodo">{escape(periodo)} · {len(itens)} '
            f'{"pedido" if len(itens) == 1 else "pedidos"}</p>' + "".join(secoes) + alertas +
            f'<p class="rodape">Atualizada em {escape(instante)}.</p></main><script>' + JS +
            '</script></body></html>')
    if len(html.encode("utf-8")) > 2_000_000:
        raise ValueError("visual excede 2 MB; divida a entrega sem omitir pedidos")
    destino.mkdir(parents=True, exist_ok=True, mode=0o700)
    nome = f"vis-lista-rapida-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    arquivo = destino / (nome + ".html")
    texto = destino / (nome + ".txt")
    gravar(arquivo, html)
    gravar(texto, "\n".join(linhas).strip() + "\n")
    return {"html": str(arquivo.resolve()), "texto": str(texto.resolve()), "pedidos": len(itens)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="comando", required=True)
    for nome in ("resumir", "renderizar"):
        p = sub.add_parser(nome)
        p.add_argument("--fontes", type=Path, required=True)
        if nome == "resumir":
            p.add_argument("--credenciais", type=Path, required=True)
            p.add_argument("--saida", type=Path, required=True)
        else:
            p.add_argument("--resumo", type=Path, required=True)
            p.add_argument("--destino", type=Path, required=True)
    args = parser.parse_args()
    try:
        fontes = json.loads(args.fontes.read_text(encoding="utf-8"))
        if args.comando == "resumir":
            resumo = resumir(fontes, args.credenciais)
            gravar(args.saida, json.dumps(resumo, ensure_ascii=False, indent=2))
            print(json.dumps({"resumo": str(args.saida), "pedidos": len(resumo["itens"])}))
        else:
            resumo = json.loads(args.resumo.read_text(encoding="utf-8"))
            print(json.dumps(renderizar(fontes, resumo, args.destino), ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        # Não reproduz erros do provedor nem trechos do pacote privado no terminal.
        parser.exit(2, "Lista rápida falhou: confira caminhos, login OAuth, JSON, datas com fuso, "
                    "evidências e limite de 160 caracteres. Nenhuma entrega foi enviada.\n")


if __name__ == "__main__":
    main()
