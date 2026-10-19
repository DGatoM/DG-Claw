#!/usr/bin/env python3
"""titular.py (DG Claw Enterprise): busca e exclusao de dado pessoal por titular (LGPD, art. 18).

Chamado por `dgclaw titular buscar|apagar` (lib/enterprise/retencao.sh). So biblioteca padrao.

Procura o(s) termo(s) (nome, CPF com ou sem pontuacao, e-mail, telefone) em todos os lugares do
inventario de docs/enterprise/DADOS-PESSOAIS.md:
  transcripts (Claude e Codex), conversas.db, chunks.db (embeddings, pelo texto de origem),
  memoria (MEMORY.md, working-memory.md, memory/, diary), anexos e entregas, logs do agente e do
  servidor, dados do Web (mesa, lembretes, avisos, push, onboarding...), WhatsApp e auditoria.

`buscar` nunca altera nada e nunca imprime o dado inteiro: mostra onde achou, quantas vezes e um
trecho mascarado. `apagar` troca cada ocorrencia por "[dado removido a pedido do titular]" (a
estrutura dos transcripts fica), apaga as linhas do indice e dos embeddings que contem o termo,
edita a memoria, remove anexos binarios so com --apagar-anexos e grava um recibo SEM o termo em
claro (so um HMAC dele). O que ainda esta em backup sai quando o backup mais velho expira.

Lugares que so sao LISTADOS (nunca alterados): a trilha de auditoria (editar quebraria a corrente
de hashes; ela nao deve guardar dado pessoal) e o WhatsApp (permitidos.json e estado da ponte; use
`dgclaw-agente canal whatsapp remover`).

Codigos de saida: 0 ok (ou nada achado), 1 erro, 2 achou coisa que ficou pendente (arquivo em uso,
anexo binario sem --apagar-anexos...). Em `buscar`, 0 sempre que a busca terminou.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dados_comum as dc  # noqa: E402

MIN_TERMO = 4


# --- padroes -------------------------------------------------------------------------------------
def so_digitos(t):
    return re.sub(r"[\s.\-/()+]", "", t)


def normalizar(termo):
    d = so_digitos(termo)
    if d.isdigit() and len(d) >= 8:
        return d[2:] if d.startswith("55") and len(d) in (12, 13) else d
    return " ".join(termo.casefold().split())


def padrao_de(termo):
    """Regex (texto) que acha o termo. Numero casa com ou sem pontuacao entre os digitos; nome casa
    sem diferenca de maiuscula e com qualquer espaco entre as palavras; nao casa dentro de outra palavra."""
    d = so_digitos(termo)
    if d.isdigit() and len(d) >= 8:
        variantes = {d}
        if d.startswith("55") and len(d) in (12, 13):
            variantes.add(d[2:])
        if len(d) in (10, 11):
            variantes.add("55" + d)   # o mesmo telefone com o codigo do pais ("+55 11 98765-4321")
        # `\(?` antes: "(11) 98765-4321" some inteiro, sem deixar o parenteses de abertura para tras
        partes = [r"\(?(?<!\d)" + r"[\s.\-/()]{0,3}".join(re.escape(c) for c in v) + r"(?!\d)" for v in sorted(variantes)]
        return "|".join(f"(?:{p})" for p in partes)
    palavras = termo.split()
    return r"(?<!\w)" + r"\s+".join(re.escape(p) for p in palavras) + r"(?!\w)"


class Termos:
    def __init__(self, termos):
        limpos = [t.strip() for t in termos if t and t.strip()]
        if not limpos:
            raise dc.erro("faltou o termo a procurar", "nenhum termo informado",
                          'use: dgclaw titular buscar "Maria Souza" --termo 123.456.789-01')
        for t in limpos:
            if len(so_digitos(t)) < MIN_TERMO:
                raise dc.erro("o termo e curto demais e apagaria texto de outras pessoas", repr(t),
                              f"use pelo menos {MIN_TERMO} caracteres (nome e sobrenome, CPF, e-mail ou telefone completo).")
        self.originais = limpos
        fonte = "|".join(f"(?:{padrao_de(t)})" for t in limpos)
        self.rx = re.compile(fonte, re.IGNORECASE)
        self.rx_bytes = re.compile(fonte.encode("utf-8"), re.IGNORECASE)

    def hash(self, sal):
        base = "\n".join(sorted({normalizar(t) for t in self.originais})).encode("utf-8")
        return hmac.new(sal, base, hashlib.sha256).hexdigest()


def mascarar(texto, m, contexto=24):
    """Trecho para a tela: o termo vira so as pontas, numeros e e-mails ao redor somem e as palavras
    longas ficam so com a primeira letra. Nunca devolve o dado inteiro de ninguem."""
    ini, fim = max(0, m.start() - contexto), min(len(texto), m.end() + contexto)
    achado = m.group(0)
    if len(achado) > 6:
        achado_m = achado[0] + "*" * (len(achado) - 3) + achado[-2:]
    else:
        achado_m = achado[0] + "*" * (len(achado) - 1)

    def lado(s):
        s = re.sub(r"[\w.+-]+@[\w.-]+", "***@***", s)
        s = re.sub(r"\d{3,}", "***", s)
        return re.sub(r"[^\W\d_]{4,}", lambda w: w.group(0)[0] + "…", s)

    ctx = (lado(texto[ini:m.start()]) + "«" + achado_m + "»" + lado(texto[m.end():fim]))
    return ctx.replace("\n", " ")


# --- coleta por lugar ----------------------------------------------------------------------------
class Lugar:
    def __init__(self, nome):
        self.nome = nome
        self.arquivos = 0          # arquivos (ou linhas de banco) com ocorrencia
        self.ocorrencias = 0
        self.exemplos = []
        self.alterados = 0
        self.pendentes = []        # o que ficou sem tratar e por que

    def achou(self, n, exemplo=None):
        self.arquivos += 1
        self.ocorrencias += n
        if exemplo and len(self.exemplos) < 2:
            self.exemplos.append(exemplo)

    def como_dict(self):
        d = {"arquivos_ou_linhas": self.arquivos, "ocorrencias": self.ocorrencias, "alterados": self.alterados}
        if self.pendentes:
            d["pendentes"] = self.pendentes
        return d


class Titular:
    def __init__(self, termos, apagar, apagar_anexos):
        self.termos = termos
        self.apagar = apagar
        self.apagar_anexos = apagar_anexos
        self.erros = []

    def protegido(self, onde, fn):
        try:
            fn()
        except dc.ErroDados as e:
            self.erros.append(f"{onde}: {e}")
        except (OSError, sqlite3.DatabaseError) as e:
            self.erros.append(f"{onde}: {e} (entrada: {getattr(e, 'filename', '') or ''}). "
                              "O que fazer: confira a permissao e o espaco em disco e rode de novo; se for o banco, "
                              "veja se ele nao esta corrompido (sqlite3 <arquivo> 'PRAGMA integrity_check').")

    # substituicao com contagem
    def _sub(self, texto):
        n = [0]

        def troca(_m):
            n[0] += 1
            return dc.PLACEHOLDER_TITULAR

        novo = self.termos.rx.sub(troca, texto)
        return novo, n[0]

    def _exemplo(self, texto):
        m = self.termos.rx.search(texto)
        return mascarar(texto, m) if m else None

    # --- texto de arquivo: json, jsonl, ou texto cru ------------------------------------------------
    def arquivo_texto(self, lugar, dfd, nome, caminho, st, pos=None, alvo=None, db=None):
        """Conta e, em modo apagar, reescreve um arquivo de texto. Devolve True se o arquivo tem o termo."""
        ext = os.path.splitext(nome)[1].lower()
        contagem = [0]
        ex = []

        def fn_str(s):
            novo, n = self._sub(s)
            if n:
                contagem[0] += n
                if not ex:
                    ex.append(self._exemplo(s))
            return novo

        def trans_linha(linha):
            s = linha.decode("utf-8", errors="surrogateescape")
            if "\\u" not in s and not self.termos.rx.search(s):
                return linha
            try:
                obj = json.loads(s)
            except ValueError:
                novo = fn_str(s)
                return novo.encode("utf-8", errors="surrogateescape")
            novo = dc.mapear_strings(obj, fn_str)
            return linha if novo == obj else dc.serializar_linha(novo)

        def trans_inteiro(dados):
            try:
                s = dados.decode("utf-8")
            except UnicodeDecodeError:
                raise dc.erro("o arquivo nao e UTF-8", caminho, "revise na mao") from None
            if ext == ".json":
                try:
                    obj = json.loads(s)
                except ValueError:
                    return fn_str(s).encode("utf-8")
                novo = dc.mapear_strings(obj, fn_str)
                if novo == obj:
                    return dados
                indentado = "\n  " in s[:200] or "\n    " in s[:200]
                return (json.dumps(novo, ensure_ascii=False, indent=2 if indentado else None,
                                   separators=None if indentado else (",", ":")) + ("\n" if s.endswith("\n") else "")).encode("utf-8")
            return fn_str(s).encode("utf-8")

        if ext in (".jsonl", ".log") or ext == "":
            usar_linhas = True
        elif ext in dc.EXT_TEXTO:
            usar_linhas = False
        else:
            return False
        def rodar(ensaio, ignorar):
            if usar_linhas:
                return dc.reescrever_linhas(dfd, nome, caminho, trans_linha, ensaio=ensaio,
                                            posicoes=[pos] if pos is not None else (), ignorar_atividade=ignorar)
            return dc.reescrever_inteiro(dfd, nome, caminho, trans_inteiro, ensaio=ensaio, ignorar_atividade=ignorar)

        # buscar so le: arquivo em uso tambem pode ser lido
        r = rodar(ensaio=not self.apagar, ignorar=not self.apagar)
        if r.pulado:
            if self.apagar and r.pulado.startswith("em uso"):
                # nao reescrevo arquivo em uso, mas leio para dizer se o termo esta nele
                contagem[0] = 0
                ex.clear()
                rodar(ensaio=True, ignorar=True)
                if contagem[0]:
                    lugar.achou(contagem[0], ex[0] if ex else None)
                    lugar.pendentes.append(f"{self._seguro(caminho)}: {r.pulado}")
                return False
            lugar.pendentes.append(f"{self._seguro(caminho)}: {r.pulado}")
            return False
        if contagem[0]:
            lugar.achou(contagem[0], ex[0] if ex else None)
            if self.apagar:
                lugar.alterados += 1
                if db is not None and pos is not None:
                    dc.corrigir_fontes(db, alvo.no_agente(caminho), r, pos)
            return True
        return False

    def _seguro(self, caminho):
        """Caminho para mostrar: se o nome do arquivo contem o termo, ele aparece mascarado."""
        return self.termos.rx.sub("***", str(caminho))

    # --- varredura de uma pasta de texto ------------------------------------------------------------
    def pasta_texto(self, lugar, raiz: Path, filtro=None):
        atalhos = []
        for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
            if filtro and not filtro(nome):
                continue
            self.arquivo_texto(lugar, dfd, nome, caminho, st)
        for a in atalhos:
            lugar.pendentes.append(f"{a}: atalho, nao segui")

    # --- por agente -----------------------------------------------------------------------------------
    def agente(self, alvo, lugares):
        L = lambda n: lugares.setdefault(n, Lugar(n))  # noqa: E731

        def transcripts():
            lg = L("transcripts")
            db = dc.db_conversas(alvo)
            lidas = dc.posicoes_lidas(db)
            atalhos = []
            for raiz in dc.raizes_transcripts(alvo):
                for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
                    if not dc.eh_transcript(nome):
                        continue
                    chave = alvo.no_agente(caminho)
                    self.arquivo_texto(lg, dfd, nome, caminho, st, pos=lidas.get(chave), alvo=alvo,
                                       db=db if chave in lidas else None)
            for a in atalhos:
                lg.pendentes.append(f"{a}: atalho, nao segui")
        self.protegido(f"{alvo.slug}: transcripts", transcripts)

        self.protegido(f"{alvo.slug}: conversas.db", lambda: self.banco(
            L("conversas.db"), dc.db_conversas(alvo), "trechos", ("texto", "nome", "ref"), dc.db_conversas(alvo).with_suffix(".reindex.lock")))
        self.protegido(f"{alvo.slug}: chunks.db", lambda: self.banco(
            L("embeddings (chunks.db)"), dc.db_chunks(alvo), "chunks", ("content",), dc.db_chunks(alvo).parent / "reindex.lock"))

        def memoria():
            lg = L("memoria")
            dfd = dc.abrir_dir(alvo.home)
            try:
                for nome in ("MEMORY.md", "working-memory.md"):
                    try:
                        st = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if not stat.S_ISREG(st.st_mode):
                        lg.pendentes.append(f"{alvo.home / nome}: nao e arquivo comum (atalho?); nao segui")
                        continue
                    self.arquivo_texto(lg, dfd, nome, alvo.home / nome, st)
            finally:
                os.close(dfd)
            for partes in (("memory",), ("data",)):
                raiz = dc.sob_casa(alvo.home, *partes)
                if raiz and raiz.is_dir():
                    self.pasta_texto(lg, raiz)
        self.protegido(f"{alvo.slug}: memoria", memoria)

        def anexos():
            lg = L("anexos e entregas")
            for partes in (("uploads",), (".dgclaw", "entregas")):
                raiz = dc.sob_casa(alvo.home, *partes)
                if raiz and raiz.is_dir():
                    self.anexos(lg, raiz)
        self.protegido(f"{alvo.slug}: anexos", anexos)

        def logs():
            raiz = dc.sob_casa(alvo.home, ".dgclaw", "logs")
            if raiz and raiz.is_dir():
                self.pasta_texto(L("logs"), raiz)
        self.protegido(f"{alvo.slug}: logs", logs)

        def whatsapp():
            raiz = dc.sob_casa(alvo.home, ".dgclaw", "whatsapp")
            if raiz and raiz.is_dir():
                self.so_listar(L("whatsapp (so lista)"), raiz,
                               "remova o numero com: dgclaw-agente canal whatsapp remover <numero> (dentro do agente)")
        self.protegido(f"{alvo.slug}: whatsapp", whatsapp)

    # --- anexos: texto edita, binario lista (e remove com --apagar-anexos) ---------------------------
    def anexos(self, lugar, raiz: Path):
        atalhos = []
        for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
            ext = os.path.splitext(nome)[1].lower()
            if ext in dc.EXT_TEXTO and ext != ".rtf" and not self.termos.rx.search(nome):
                self.arquivo_texto(lugar, dfd, nome, caminho, st)
                continue
            achou = bool(self.termos.rx.search(nome))
            n = 1 if achou else 0
            if not achou and st.st_size <= dc.MAX_TEXTO_BYTES:
                fd = os.open(nome, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
                with os.fdopen(fd, "rb") as f:
                    n = len(self.termos.rx_bytes.findall(f.read()))
                achou = n > 0
            if not achou:
                continue
            lugar.achou(n, None)
            rotulo = self._seguro(caminho)
            if self.apagar and self.apagar_anexos:
                os.unlink(nome, dir_fd=dfd)
                lugar.alterados += 1
                if len(lugar.exemplos) < 2:
                    lugar.exemplos.append(f"removido: {rotulo}")
            else:
                lugar.pendentes.append(f"{rotulo}: anexo que contem o termo (arquivo binario ou nome); "
                                       "para remover rode de novo com --apagar-anexos")
        for a in atalhos:
            lugar.pendentes.append(f"{a}: atalho, nao segui")

    def so_listar(self, lugar, raiz: Path, instrucao):
        atalhos = []
        for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
            if st.st_size > 20 * 1048576:
                continue
            fd = os.open(nome, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
            with os.fdopen(fd, "rb") as f:
                n = len(self.termos.rx_bytes.findall(f.read()))
            if n:
                lugar.achou(n)
                lugar.pendentes.append(f"{self._seguro(caminho)}: {instrucao}")

    # --- bancos ---------------------------------------------------------------------------------------
    def banco(self, lugar, db: Path, tabela, colunas, lock):
        if not db.is_file():
            return
        with dc.trava_do_indice(lock):
            con = dc.abrir_db(db, somente_leitura=not self.apagar)
            try:
                if not dc.tem_tabela(con, tabela):
                    return
                ids = []
                for linha in con.execute(f"SELECT id, {', '.join(colunas)} FROM {tabela}"):
                    total = 0
                    ex = None
                    for valor in linha[1:]:
                        if isinstance(valor, str):
                            achados = list(self.termos.rx.finditer(valor))
                            if achados and ex is None:
                                ex = mascarar(valor, achados[0])
                            total += len(achados)
                    if total:
                        ids.append(linha[0])
                        lugar.achou(total, ex)
                if ids and self.apagar:
                    for i in range(0, len(ids), 500):
                        lote = ids[i:i + 500]
                        con.execute(f"DELETE FROM {tabela} WHERE id IN ({','.join('?' * len(lote))})", lote)
                    lugar.alterados += len(ids)
                    dc.compactar_db(con)
            finally:
                dc.fechar_db(con, db)

    # --- fora dos agentes ------------------------------------------------------------------------------
    def servidor(self, lugares, web_data, log_dir, auditoria):
        if web_data:
            def web():
                raiz = Path(web_data)
                if raiz.is_dir() and not raiz.is_symlink():
                    self.pasta_texto(lugares.setdefault("dados do Web", Lugar("dados do Web")), raiz,
                                     filtro=lambda n: os.path.splitext(n)[1].lower() in dc.EXT_TEXTO)
            self.protegido("dados do Web", web)
        if log_dir:
            def logs():
                raiz = Path(log_dir)
                if raiz.is_dir() and not raiz.is_symlink():
                    self.pasta_texto(lugares.setdefault("logs do servidor", Lugar("logs do servidor")), raiz,
                                     filtro=lambda n: ".log" in n and not n.startswith("auditoria"))
            self.protegido("logs do servidor", logs)
        if auditoria and Path(auditoria).is_file():
            def aud():
                lg = lugares.setdefault("auditoria (so lista)", Lugar("auditoria (so lista)"))
                n = len(self.termos.rx_bytes.findall(Path(auditoria).read_bytes()))
                if n:
                    lg.achou(n)
                    lg.pendentes.append(f"{auditoria}: a trilha de auditoria nao e editada (quebraria a corrente de hashes). "
                                        "Ela nao devia guardar dado pessoal; avise quem mantem o DG Claw para corrigir o evento que gravou isso.")
            self.protegido("auditoria", aud)


# --- sal e recibo --------------------------------------------------------------------------------------
def obter_sal(pasta: Path):
    """Segredo da instalacao usado no HMAC do recibo. Um hash simples de CPF se desfaz por forca bruta
    (sao so 10^9 combinacoes); com o sal, quem nao tem a maquina nao confirma o termo."""
    pasta.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(pasta, 0o700)
    arq = pasta / ".sal"
    if not arq.exists():
        fd = os.open(arq, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    return arq.read_text(encoding="utf-8").strip().encode("utf-8")


def main():
    ap = argparse.ArgumentParser(description="Busca e exclusao por titular (LGPD)")
    ap.add_argument("acao", choices=["buscar", "apagar"])
    ap.add_argument("termos", nargs="*")
    ap.add_argument("--termos-stdin", action="store_true", help="le os termos do stdin, um por linha (fora do argv)")
    ap.add_argument("--agentes-json", required=True)
    ap.add_argument("--agente")
    ap.add_argument("--web-data")
    ap.add_argument("--log-dir")
    ap.add_argument("--auditoria")
    ap.add_argument("--recibos-dir", required=True)
    ap.add_argument("--backup-dias", type=int, default=0)
    ap.add_argument("--apagar-anexos", action="store_true")
    ap.add_argument("--resumo-json")
    a = ap.parse_args()
    apagar = a.acao == "apagar"
    try:
        termos = Termos(list(a.termos) + (sys.stdin.read().splitlines() if a.termos_stdin else []))
        alvos = dc.carregar_alvos(a.agentes_json, a.agente)
        sal = obter_sal(Path(a.recibos_dir)) if apagar else b"somente-busca"
    except (dc.ErroDados, OSError) as e:
        print(f"Nao deu certo: {e}", file=sys.stderr)
        return 1
    t = Titular(termos, apagar, a.apagar_anexos)
    por_agente = {}
    for alvo in alvos:
        lugares = {}
        t.agente(alvo, lugares)
        por_agente[alvo.slug] = lugares
    servidor = {}
    if not a.agente:
        t.servidor(servidor, a.web_data, a.log_dir, a.auditoria)

    h = termos.hash(sal)
    verbo = "apagado" if apagar else "encontrado"
    total = 0
    pendencias = 0

    def mostrar(titulo, lugares):
        nonlocal total, pendencias
        achou = [lg for lg in lugares.values() if lg.ocorrencias or lg.pendentes]
        if not achou:
            return
        print(f"{titulo}:")
        for lg in achou:
            total += lg.ocorrencias
            extra = f", {lg.alterados} alterado(s)" if apagar else ""
            print(f"  {lg.nome}: {lg.ocorrencias} ocorrencia(s) em {lg.arquivos} arquivo(s)/linha(s){extra}")
            for ex in lg.exemplos:
                print(f"      trecho: {ex}")
            for p in lg.pendentes:
                pendencias += 1
                print(f"      pendente: {p}")

    for slug, lugares in por_agente.items():
        mostrar(f"agente {slug}", lugares)
    mostrar("servidor", servidor)
    for e in t.erros:
        print(f"Nao deu certo: {e}", file=sys.stderr)
    if total == 0 and not pendencias:
        print("Nada encontrado com esse(s) termo(s) nos lugares do inventario.")
    else:
        print(f"Total {verbo}: {total} ocorrencia(s).")

    if apagar:
        agora = datetime.fromtimestamp(dc.agora(), timezone.utc)
        sai = agora + timedelta(days=a.backup_dias) if a.backup_dias > 0 else None
        recibo = {
            "versao": 1, "quando": agora.strftime("%Y-%m-%dT%H:%M:%SZ"), "hash_hmac_sha256": h,
            "quantos_termos": len(termos.originais),
            "agentes": {s: {n: lg.como_dict() for n, lg in lugares.items() if lg.ocorrencias or lg.pendentes} for s, lugares in por_agente.items()},
            "servidor": {n: lg.como_dict() for n, lg in servidor.items() if lg.ocorrencias or lg.pendentes},
            "pendencias": pendencias, "erros": len(t.erros),
            "backup_retencao_dias": a.backup_dias,
            "sai_dos_backups_ate": sai.strftime("%Y-%m-%d") if sai else None,
        }
        pasta = Path(a.recibos_dir)
        destino = pasta / f"{agora.strftime('%Y-%m-%d')}-{h[:16]}.json"
        fd = os.open(destino, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(recibo, f, ensure_ascii=False, indent=2)
        print(f"Recibo: {destino} (guarda so o HMAC do termo, nunca o termo).")
        if sai:
            print(f"Backups: o dado ainda existe nas copias de seguranca e sai de la quando elas expirarem "
                  f"(backup_retencao_dias = {a.backup_dias}): ate {sai.strftime('%d/%m/%Y')}. Nao restaure backup anterior a hoje sem refazer esta exclusao.")
        else:
            print("Backups: o backup esta desligado neste nivel; se existir copia feita por fora, apague nela tambem.")
        print("Indices: o conversas.db e o chunks.db foram limpos; o proximo reindex refaz os trechos de memoria ja sem o termo.")
    if a.resumo_json:
        Path(a.resumo_json).write_text(json.dumps({"hash": h, "ocorrencias": total, "pendencias": pendencias,
                                                    "agentes": len(alvos), "erros": len(t.erros)}), encoding="utf-8")
    if t.erros:
        return 1
    return 2 if (apagar and pendencias) else 0


if __name__ == "__main__":
    sys.exit(main())
