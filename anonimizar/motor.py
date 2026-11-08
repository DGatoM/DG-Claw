#!/usr/bin/env python3
"""Motor de anonimização de documentos do DG Claw (contrato em anonimizar/CONTRATO.md).

Subcomandos:
  servir                       protocolo de linhas JSON no stdin/stdout (é o que o painel usa)
  anonimizar-texto [opções]    lê o texto do stdin e imprime o resultado (teste manual)
                               --valores --datas --empresas  ligam esses detectores
  estado                       imprime o estado do motor (nível, formatos, modelo)

Roda com `python3 -I`: por isso o diretório deste arquivo entra no sys.path explicitamente.
Nada além de JSON vai para o stdout no `servir`; o log vai para o stderr e nunca leva valor detectado.
"""
import contextlib
import importlib.util
import json
import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import documentos as docs  # noqa: E402
import ooxml  # noqa: E402
import verificacao  # noqa: E402
import ner_gliner  # noqa: E402
from detectores import TIPOS  # noqa: E402
from documentos import ErroMotor  # noqa: E402
from tabela import _RX_MARCADOR, Reversor, Sessao, Tabela, desativar_links_md, desativar_marcadores_restantes, escapar_md  # noqa: E402

AVISO_SEM_NER = "O detector de nomes e endereços não está instalado: só números, contatos e documentos foram trocados."
_NER = {"obj": None, "pronto": False}


def log(msg):
    print("anonimizar: " + msg, file=sys.stderr, flush=True)


def base_dir():
    return os.environ.get("DGCLAW_ANON_BASE", "/opt/dgclaw/anonimizar")


def tem(modulo):
    try:
        return importlib.util.find_spec(modulo) is not None
    except (ImportError, ValueError):
        return False


def versao_modelo():
    try:
        with open(os.path.join(base_dir(), "estado.json"), encoding="utf-8") as f:
            return json.load(f).get("versao_modelo")
    except (OSError, ValueError):
        return None


def obter_ner():
    """O detector de nomes (ou None). O modelo só é carregado na primeira chamada de `detectar`."""
    if _NER["pronto"]:
        return _NER["obj"]
    if os.environ.get("DGCLAW_ANON_NER") == "falso":
        from ner_falso import NerFalso
        _NER["obj"] = NerFalso()
    else:
        pasta = os.path.join(base_dir(), "modelo")
        if tem("gliner2") and tem("torch") and os.path.isfile(os.path.join(pasta, "model.safetensors")):
            _NER["obj"] = ner_gliner.NerGliner(pasta, versao_modelo())
    _NER["pronto"] = True
    return _NER["obj"]


def formatos():
    f = list(docs.FORMATOS_TEXTO)
    if tem("pypdf"):
        f.append(".pdf")
    if tem("docx") and tem("lxml"):
        f.append(".docx")
    if tem("openpyxl"):
        f.append(".xlsx")
    return f


def nivel():
    if obter_ner() is not None:
        return "completo"
    return "leitores" if all(tem(m) for m in ("pypdf", "docx", "openpyxl")) else "regex"


_TETO = {"ativo": False}


def _vm_size_bytes():
    with open("/proc/self/status") as f:
        for linha in f:
            if linha.startswith("VmSize:"):
                return int(linha.split()[1]) * 1024
    return 0


def _aplicar_teto(extra_mb):
    import resource
    _, duro = resource.getrlimit(resource.RLIMIT_AS)
    novo = _vm_size_bytes() + extra_mb * 1024 * 1024
    if duro != resource.RLIM_INFINITY:
        novo = min(novo, duro)
    resource.setrlimit(resource.RLIMIT_AS, (novo, duro))


@contextlib.contextmanager
def teto_de_memoria(extra_mb=None):
    """Teto de memória virtual (RLIMIT_AS) para LER e GRAVAR documento: o tamanho de agora mais `extra_mb` (padrão 3072).

    Documento malicioso (planilha com milhões de células, XML enorme) vira MemoryError em vez de derrubar a VPS.
    O detector de nomes (torch) não passa por aqui: ver `sem_teto`. Sem /proc ou sem RLIMIT_AS (outro sistema), segue sem teto.
    """
    extra = extra_mb or int(os.environ.get("DGCLAW_ANON_TETO_MB", "3072"))
    try:
        import resource
        antes = resource.getrlimit(resource.RLIMIT_AS)
        _aplicar_teto(extra)
    except (ImportError, OSError, ValueError, AttributeError):
        yield
        return
    _TETO.update(ativo=True, extra=extra)
    try:
        yield
    finally:
        _TETO["ativo"] = False
        resource.setrlimit(resource.RLIMIT_AS, antes)


@contextlib.contextmanager
def sem_teto():
    """Solta o teto enquanto o detector de nomes roda (o torch reserva muito espaço virtual) e o refaz depois."""
    if not _TETO["ativo"]:
        yield
        return
    import resource
    antes = resource.getrlimit(resource.RLIMIT_AS)
    resource.setrlimit(resource.RLIMIT_AS, (resource.RLIM_INFINITY if antes[1] == resource.RLIM_INFINITY else antes[1], antes[1]))
    try:
        yield
    finally:
        _aplicar_teto(_TETO["extra"])


def erro(codigo, mensagem):
    return {"ok": False, "erro": mensagem, "codigo": codigo}


# ---------- operações ----------

def op_estado(_req):
    ner = obter_ner()
    return {"ok": True, "nivel": nivel(), "formatos": formatos(),
            "modelo_carregado": bool(ner is not None and getattr(ner, "carregado", False)),
            "rss_mb": ner_gliner.rss_mb(), "versao_modelo": versao_modelo()}


def _opcoes(req):
    o = req.get("opcoes") or {}
    return {"valores": bool(o.get("valores")), "datas": bool(o.get("datas")), "empresas": bool(o.get("empresas"))}


def _tabela(req):
    t = req.get("tabela")
    if t is None:
        return Tabela([])
    if not isinstance(t, list):
        raise ErroMotor("pedido_invalido", "O campo 'tabela' precisa ser uma lista de {tipo, valor, marcador}.")
    try:
        return Tabela(t)
    except (ValueError, AttributeError) as e:
        raise ErroMotor("tabela_invalida", "A tabela de marcadores recebida está inválida: %s. Confira o registro do agente." % e) from None


def _novas(tabela):
    return [dict(e) for e in tabela.novas]


def _com_ner(req):
    ner = obter_ner()
    avisos = [] if ner is not None else [AVISO_SEM_NER]
    return ner, avisos


def _texto_str(req, campo):
    v = req.get(campo)
    if not isinstance(v, str):
        raise ErroMotor("pedido_invalido", "O campo '%s' é obrigatório e precisa ser texto." % campo)
    return v


def op_anonimizar_texto(req):
    texto = _texto_str(req, "texto")
    tabela = _tabela(req)
    ner, avisos = _com_ner(req)
    sessao = Sessao(tabela, _opcoes(req), ner)
    try:
        sessao.preparar(texto)
    except ner_gliner.ErroNer as e:
        raise ErroMotor(e.codigo, e.mensagem) from None
    saida = sessao.trocar(texto)
    return {"ok": True, "texto": saida, "novas": _novas(tabela), "usados": sorted({m.group(0) for m in _RX_MARCADOR.finditer(saida)}),
            "contagem": sessao.contagem, "avisos": avisos, "nivel": nivel()}


def op_reverter_texto(req):
    texto = _texto_str(req, "texto")
    rev = Reversor(req.get("tabela") or [])
    return {"ok": True, "texto": rev.reverter(texto), "trocas": rev.trocas, "desconhecidos": rev.desconhecidos}


def _validar_caminhos(req, entrada_obrigatoria=True):
    entrada = req.get("entrada")
    if not isinstance(entrada, str) or not os.path.isfile(entrada):
        raise ErroMotor("entrada_inexistente", "O arquivo de entrada não existe ou não é um arquivo: %s. Envie o documento de novo."
                        % (entrada if isinstance(entrada, str) else "(campo 'entrada' ausente)"))
    return entrada, os.path.basename(entrada)


def _gravar_atomico(destino_dir, arquivos, antes_de_mover=None):
    """arquivos: [(nome_final, funcao_que_grava(caminho))]. Tudo ou nada.

    `antes_de_mover(caminhos_temporarios)` roda sobre as saídas prontas (verificação final) e devolve algo que
    esta função repassa; se levantar erro, nada chega a `destino_dir`.
    """
    os.makedirs(destino_dir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".anon-", dir=destino_dir)
    movidos = []
    resultado = None
    try:
        for nome, grava in arquivos:
            grava(os.path.join(tmp, nome))
        if antes_de_mover is not None:
            resultado = antes_de_mover([os.path.join(tmp, n) for n, _ in arquivos])
        for nome, _ in arquivos:
            os.replace(os.path.join(tmp, nome), os.path.join(destino_dir, nome))
            movidos.append(os.path.join(destino_dir, nome))
    except BaseException:
        for m in movidos:
            try:
                os.unlink(m)
            except OSError as e:
                log("não consegui desfazer a saída parcial (%s)" % type(e).__name__)
        raise
    finally:
        for nome in os.listdir(tmp):
            try:
                os.unlink(os.path.join(tmp, nome))
            except OSError as e:
                log("sobrou arquivo temporário (%s)" % type(e).__name__)
        try:
            os.rmdir(tmp)
        except OSError as e:
            log("sobrou pasta temporária (%s)" % type(e).__name__)
    return resultado


def _escreve(texto):
    return lambda caminho: docs.escrever_texto(caminho, texto)


def op_anonimizar(req):
    entrada, nome = _validar_caminhos(req)
    saida_dir = req.get("saida_dir")
    base = req.get("nome_base")
    if not isinstance(saida_dir, str) or not saida_dir:
        raise ErroMotor("pedido_invalido", "O campo 'saida_dir' é obrigatório.")
    if not isinstance(base, str) or not base or not all(c.isalnum() or c in "-_." for c in base) or base.startswith("."):
        raise ErroMotor("pedido_invalido", "O campo 'nome_base' é obrigatório e só pode ter letras, números, '-', '_' e '.'.")
    ext = os.path.splitext(nome)[1].lower()
    if ext not in formatos():
        if ext in docs.FORMATOS_LEITORES:
            raise ErroMotor("formato_nao_lido", "O arquivo '%s' (%s) precisa do nível 'leitores' do motor de anonimização, que não está instalado. "
                            "Instale pelo painel (Anonimizar documentos) ou envie em .txt, .md, .csv ou .json." % (nome, ext))
        raise ErroMotor("formato_nao_suportado", "O formato '%s' do arquivo '%s' não é lido pelo motor. Formatos aceitos: %s."
                        % (ext or "(sem extensão)", nome, ", ".join(formatos())))
    tabela = _tabela(req)
    ner, avisos = _com_ner(req)
    sessao = Sessao(tabela, _opcoes(req), ner)
    pref = base + ".anon"
    arquivos = []   # (nome_final, grava)
    preparar = sessao.preparar

    def preparar_sem_teto(*a, **k):
        with sem_teto():
            return preparar(*a, **k)
    sessao.preparar = preparar_sem_teto
    try:
        with teto_de_memoria():
            if ext in (".txt", ".md", ".csv"):
                texto = docs.ler_texto(entrada)
                sessao.preparar(texto)
                arquivos.append((pref + (".csv" if ext == ".csv" else ".md"), _escreve(sessao.trocar(texto))))
            elif ext == ".json":
                texto = docs.ler_texto(entrada)
                try:
                    obj = json.loads(texto)
                except ValueError:
                    avisos.append("O arquivo '%s' não é um JSON válido; foi tratado como texto simples." % nome)
                    sessao.preparar(texto)
                    arquivos.append((pref + ".md", _escreve(sessao.trocar(texto))))
                else:
                    sessao.preparar("\n".join(docs.json_strings(obj)))
                    novo = json.dumps(docs.json_mapear(obj, sessao.trocar, sessao.numero_para_marcador), ensure_ascii=False, indent=2) + "\n"
                    arquivos.append((pref + ".json", _escreve(novo)))
            elif ext == ".pdf":
                texto = docs.pdf_texto(entrada, nome)
                sessao.preparar(texto)
                arquivos.append((pref + ".md", _escreve(sessao.trocar(texto))))
            elif ext == ".docx":
                conteudo, attr_ner, attr_regex = ooxml.textos_para_deteccao(entrada, nome)
                sessao.preparar("\n".join(conteudo + attr_ner))
                sessao.preparar("\n".join(attr_regex), ner=False)
                sessao.registrar_pessoas(ooxml.autores_para_registro(entrada, nome))
                tmp_docx = tempfile.mkdtemp(prefix=".anon-docx-")
                try:
                    caminho_docx = os.path.join(tmp_docx, "x.docx")
                    ooxml.reescrever(entrada, caminho_docx, nome, sessao.encontrar, avisos)
                    md = docs.docx_para_md(caminho_docx)
                    with open(caminho_docx, "rb") as f:
                        dados = f.read()
                finally:
                    _limpar(tmp_docx)
                arquivos.append((pref + ".docx", lambda c, d=dados: _grava_bytes(c, d)))
                arquivos.append((pref + ".md", _escreve(md)))
            elif ext == ".xlsx":
                wb = docs.xlsx_abrir(entrada, nome)
                avisos += docs.xlsx_avisos(wb, nome)
                conteudo, attr_ner, attr_regex = ooxml.textos_para_deteccao(entrada, nome, so_nao_celulas=True)
                sessao.preparar("\n".join(docs.xlsx_textos(wb) + conteudo + attr_ner))
                sessao.preparar("\n".join(attr_regex), ner=False)
                sessao.registrar_pessoas(list(dict.fromkeys(ooxml.autores_para_registro(entrada, nome) + docs.xlsx_autores(wb))))
                formulas = docs.xlsx_transformar(wb, sessao)
                if formulas:
                    avisos.append("%d fórmula(s) de '%s' levavam dado pessoal e foram trocadas pelo texto com marcador." % (formulas, nome))
                sessao.contando = False
                csvs = docs.xlsx_csvs(entrada, nome, wb, sessao)
                tmp_x = tempfile.mkdtemp(prefix=".anon-xlsx-")
                try:
                    parcial, final = os.path.join(tmp_x, "a.xlsx"), os.path.join(tmp_x, "b.xlsx")
                    wb.save(parcial)
                    ooxml.reescrever(parcial, final, nome, sessao.encontrar, avisos, so_nao_celulas=True)
                    with open(final, "rb") as f:
                        dados = f.read()
                finally:
                    _limpar(tmp_x)
                arquivos.append((pref + ".xlsx", lambda c, d=dados: _grava_bytes(c, d)))
                for n, conteudo_csv in enumerate(csvs, 1):
                    arquivos.append((pref + (".csv" if len(csvs) == 1 else ".%d.csv" % n), _escreve(conteudo_csv)))

            def verifica(caminhos):
                verificacao.verificar(caminhos, sessao.detectados, nome)
                return verificacao.marcadores_usados(caminhos)

            usados = _gravar_atomico(saida_dir, arquivos, verifica)
    except ner_gliner.ErroNer as e:
        raise ErroMotor(e.codigo, e.mensagem) from None
    caminhos = [{"caminho": os.path.join(saida_dir, n), "formato": n.rsplit(".", 1)[1]} for n, _ in arquivos]
    return {"ok": True, "saidas": caminhos, "novas": _novas(tabela), "usados": usados, "contagem": sessao.contagem,
            "avisos": avisos, "nivel": nivel()}


def _grava_bytes(caminho, dados):
    with open(caminho, "wb") as f:
        f.write(dados)


def _limpar(pasta):
    for n in os.listdir(pasta):
        os.unlink(os.path.join(pasta, n))
    os.rmdir(pasta)


FORMATOS_ATIVOS = (".html", ".htm", ".xhtml", ".svg", ".xml", ".xsl", ".js", ".mjs", ".css")


def op_reverter(req):
    with teto_de_memoria():
        return _reverter(req)


def _reverter(req):
    entrada, nome = _validar_caminhos(req)
    saida = req.get("saida")
    if not isinstance(saida, str) or not saida:
        raise ErroMotor("pedido_invalido", "O campo 'saida' é obrigatório.")
    ext = os.path.splitext(nome)[1].lower()
    rev = Reversor(req.get("tabela") or [], escapar_md if ext == ".md" else None)
    if ext == ".pdf":
        raise ErroMotor("pdf", "Não dá para trazer os dados reais de volta num PDF (o texto dele não é editável aqui). "
                        "Peça ao agente o resultado em .docx ou .md.")
    if ext in FORMATOS_ATIVOS:
        raise ErroMotor("formato_ativo", "O arquivo '%s' (%s) pode abrir links, imagens ou scripts: colocar dados reais nele poderia mandá-los "
                        "para fora. Peça ao agente o resultado em .docx, .md ou .txt." % (nome, ext))
    destino_dir = os.path.dirname(os.path.abspath(saida))
    os.makedirs(destino_dir, exist_ok=True)
    avisos_rev = []
    tmp = tempfile.mkdtemp(prefix=".rev-", dir=destino_dir)
    tmp_arq = os.path.join(tmp, "saida")
    try:
        if ext == ".md":
            # HTML cru do agente (<style>, <script>, <iframe>, <svg>...) vira texto antes de qualquer dado real entrar
            texto_md, desativou = docs.neutralizar_html_md(docs.ler_texto(entrada))
            if desativou:
                avisos_rev.append("O HTML escrito pelo agente em '%s' foi desativado (cada '<' virou '&lt;') antes de trazer os dados reais de volta." % nome)
            # e toda sintaxe de link/imagem também: sem destino de link não há para onde o dado restaurado vazar
            docs.escrever_texto(tmp_arq, desativar_marcadores_restantes(rev.reverter(desativar_links_md(texto_md))))
        elif ext == ".txt":
            docs.escrever_texto(tmp_arq, rev.reverter(docs.ler_texto(entrada)))
        elif ext == ".csv":
            docs.escrever_texto(tmp_arq, docs.csv_mapear(docs.ler_texto(entrada), lambda c: docs.csv_inerte(rev.reverter(c))))
        elif ext == ".json":
            try:
                obj = json.loads(docs.ler_texto(entrada))
            except ValueError:
                raise ErroMotor("arquivo_invalido", "O arquivo '%s' não é um JSON válido. Peça ao agente para gerar de novo." % nome) from None
            docs.escrever_texto(tmp_arq, json.dumps(docs.json_mapear(obj, rev.reverter), ensure_ascii=False, indent=2) + "\n")
        elif ext == ".docx":
            docs.docx_reverter(entrada, tmp_arq, nome, rev.encontrar)
        elif ext == ".pptx":
            docs.pptx_transformar(entrada, tmp_arq, nome, rev.encontrar, reverter=True)
        elif ext == ".xlsx":
            wb = docs.xlsx_abrir(entrada, nome)
            docs.xlsx_reverter(wb, docs.xlsx_abrir(entrada, nome, data_only=True), rev.encontrar)
            parcial = os.path.join(tmp, "parcial.xlsx")
            wb.save(parcial)
            ooxml.reescrever(parcial, tmp_arq, nome, lambda texto, estrutural=False: [], avisos_rev, so_nao_celulas=True, sem_formulas=True)
            ooxml.conferir_sem_formulas(tmp_arq, nome)
            docs.conferir_sem_vinculos_externos(tmp_arq, nome)
        else:
            raise ErroMotor("formato_nao_suportado", "O formato '%s' do arquivo '%s' não tem reversão. Aceitos: .txt .md .csv .json .docx .xlsx .pptx."
                            % (ext or "(sem extensão)", nome))
        os.replace(tmp_arq, saida)
    finally:
        _limpar(tmp)
    return {"ok": True, "trocas": rev.trocas, "desconhecidos": rev.desconhecidos, "avisos": avisos_rev}


OPS = {"estado": op_estado, "anonimizar": op_anonimizar, "anonimizar_texto": op_anonimizar_texto,
       "reverter": op_reverter, "reverter_texto": op_reverter_texto}


def tratar(req):
    if not isinstance(req, dict):
        return erro("pedido_invalido", "O pedido precisa ser um objeto JSON com o campo 'op'.")
    fn = OPS.get(req.get("op"))
    if fn is None:
        return erro("op_desconhecida", "A operação '%s' não existe. Operações: %s." % (str(req.get("op"))[:40], ", ".join(sorted(OPS))))
    nome = os.path.basename(req["entrada"]) if isinstance(req.get("entrada"), str) else "(sem arquivo)"
    try:
        return fn(req)
    except ErroMotor as e:
        return erro(e.codigo, e.mensagem)
    except MemoryError:
        return erro("memoria", "Faltou memória ao processar '%s'. Tente um arquivo menor ou libere memória na VPS." % nome)
    except Exception as e:
        # Só o tipo e as linhas do código: a mensagem da exceção pode carregar conteúdo do documento.
        log("falha inesperada em '%s' (op %s): %s\n%s" % (nome, req.get("op"), type(e).__name__,
                                                          "".join(traceback.format_tb(e.__traceback__))))
        return erro("erro_interno", "O motor falhou de forma inesperada ao processar '%s' (%s). Veja o log do serviço de anonimização e tente de novo."
                    % (nome, type(e).__name__))


def servir():
    saida = sys.stdout
    sys.stdout = sys.stderr   # qualquer print perdido de biblioteca vai para o stderr, nunca para o protocolo
    entrada = open(sys.stdin.fileno(), encoding="utf-8", errors="replace", closefd=False)
    for linha in entrada:
        if not linha.strip():
            continue
        try:
            req = json.loads(linha)
        except ValueError:
            resp = erro("json_invalido", "A linha recebida não é um JSON válido. Mande um objeto JSON por linha.")
        else:
            resp = tratar(req)
        saida.write(json.dumps(resp, ensure_ascii=True) + "\n")
        saida.flush()


def principal(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "servir":
        servir()
    elif cmd == "anonimizar-texto":
        resp = tratar({"op": "anonimizar_texto", "texto": sys.stdin.read(),
                       "opcoes": {"valores": "--valores" in argv, "datas": "--datas" in argv, "empresas": "--empresas" in argv}})
        if not resp["ok"]:
            print(resp["erro"], file=sys.stderr)
            return 1
        for a in resp["avisos"]:
            print(a, file=sys.stderr)
        sys.stdout.write(resp["texto"])
    elif cmd == "estado":
        print(json.dumps(op_estado({}), ensure_ascii=False))
    else:
        print("uso: motor.py servir | anonimizar-texto [--valores] [--datas] [--empresas] | estado", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv))
