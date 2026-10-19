#!/usr/bin/env python3
"""dados_comum.py (DG Claw Enterprise): o que retencao.py e titular.py dividem.

Os dois scripts mexem em dado pessoal que mora em pastas controladas pelo agente (a casa dele
e de dono do uid mapeado, e o LLM pode criar atalhos ali). Por isso toda operacao de arquivo
aqui e feita relativa a um descritor de pasta (dir_fd), com O_NOFOLLOW, e nunca por caminho
solto: um atalho plantado no meio do caminho nao leva o root para fora da casa (armadilha 7
do docs/enterprise/DESENHO.md).

Regras que valem para toda reescrita:
  - atomica: escreve num temporario na mesma pasta e troca com rename;
  - dono, modo e datas do arquivo original sao preservados (o arquivo e do uid do agente);
  - arquivo que mudou nos ultimos 2 minutos (sessao escrevendo) NAO e reescrito;
  - se o arquivo mudou enquanto era lido, a troca e abandonada (nada se perde);
  - transcript .jsonl nunca perde linha: o texto e trocado e a estrutura JSON fica
    (uuid, parentUuid, type, timestamp...), senao a corrente do --resume quebra.
"""
import contextlib
import errno
import fcntl
import json
import os
import re
import secrets
import sqlite3
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path

PLACEHOLDER_RETENCAO = "[removido pela política de retenção]"
PLACEHOLDER_TITULAR = "[dado removido a pedido do titular]"
JANELA_ATIVA_S = 120
MAX_TEXTO_BYTES = 64 * 1024 * 1024

# Campos de estrutura dos transcripts do Claude Code e dos rollouts do Codex. O valor deles nunca
# e trocado: sao eles que mantem a corrente (parentUuid), a ordem e o formato.
CHAVES_PROTEGIDAS = frozenset({
    "uuid", "parentUuid", "logicalParentUuid", "leafUuid", "messageId", "message_id", "sessionId",
    "session_id", "id", "tool_use_id", "toolUseID", "parentToolUseID", "requestId", "request_id",
    "call_id", "turn_id", "item_id", "type", "subtype", "timestamp", "ts", "role", "name", "model",
    "version", "cwd", "gitBranch", "userType", "entrypoint", "stop_reason", "stop_sequence",
    "media_type", "signature", "status", "phase", "level", "isSidechain", "isMeta",
})

EXT_TEXTO = frozenset({".md", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".log", ".html", ".htm", ".xml",
                       ".yaml", ".yml", ".ini", ".env", ".sh", ".py", ".js", ".ts", ".sql", ".rtf"})


class ErroDados(Exception):
    """Erro que ja chega com a mensagem completa: o que falhou, com que entrada, o que fazer."""


def erro(o_que, entrada, fazer):
    return ErroDados(f"{o_que} (entrada: {entrada}). O que fazer: {fazer}")


@dataclass
class Alvo:
    slug: str
    tipo: str
    home: Path
    transcripts_dir: Path | None = None
    home_container: str = ""

    def no_agente(self, caminho):
        """O caminho como o agente o enxerga (o indice e escrito de dentro do container)."""
        if self.home_container:
            try:
                return str(Path(self.home_container) / Path(caminho).relative_to(self.home))
            except ValueError:
                pass
        return str(caminho)


def carregar_alvos(agentes_json, so_slug=None):
    """Os agentes do agentes.json (e o Admin) com a casa de cada um. Sem o arquivo, lista vazia."""
    caminho = Path(agentes_json)
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except FileNotFoundError:
        dados = {"agentes": []}
    except (OSError, ValueError) as e:
        raise erro("nao consegui ler a lista de agentes", f"{caminho}: {e}",
                   "confira se o arquivo e um JSON valido: jq . " + str(caminho)) from e
    alvos = []
    for a in dados.get("agentes", []):
        slug, home = a.get("slug"), a.get("home_host")
        if not slug or not home:
            continue
        td = a.get("transcripts_dir")
        alvos.append(Alvo(slug=slug, tipo=a.get("tipo", "agente"), home=Path(home),
                          transcripts_dir=Path(td) if td else None,
                          home_container=a.get("home_container") or ""))
    if so_slug:
        alvos = [a for a in alvos if a.slug == so_slug]
        if not alvos:
            raise erro("nao existe agente com esse nome", f"--agente {so_slug} em {caminho}",
                       "veja os nomes com: dgclaw agente listar")
    return alvos


# --- tempo --------------------------------------------------------------------------------------
def agora():
    """Relogio dos testes: DGCLAW_AGORA (epoch em segundos) so vale com DGCLAW_RAIZ definida."""
    fixo = os.environ.get("DGCLAW_AGORA")
    if fixo and os.environ.get("DGCLAW_RAIZ"):
        return float(fixo)
    return time.time()


# --- caminhos sem atalho ------------------------------------------------------------------------
def sob_casa(base: Path, *partes):
    """base/partes se existir e nenhum componente abaixo de base for atalho; None se nao existe.
    Atalho no meio levanta ErroDados: quem chama registra o problema e segue com o resto."""
    atual = base
    for parte in partes:
        atual = atual / parte
        try:
            st = os.lstat(atual)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(st.st_mode):
            raise erro("um atalho aparece onde deveria haver uma pasta ou arquivo comum",
                       f"{atual} aponta para {os.readlink(atual)!r}",
                       "o agente (ou alguem) criou esse atalho dentro da casa dele. Confira o que ele aponta, apague o atalho "
                       "e rode o comando de novo; por seguranca nao sigo atalho como root.")
    return atual


def abrir_dir(caminho):
    """Descritor da pasta, sem seguir atalho no ultimo componente."""
    return os.open(str(caminho), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def varrer(raiz: Path, atalhos: list):
    """Gera (dfd, nome, caminho_para_mostrar, lstat) de cada arquivo comum sob raiz, sem seguir atalho.
    Atalhos encontrados vao para a lista `atalhos` (para o relatorio avisar)."""
    if not raiz.exists() and not raiz.is_symlink():
        return
    for dirpath, dirnames, filenames, dfd in os.fwalk(str(raiz), follow_symlinks=False):
        for d in dirnames:
            if stat.S_ISLNK(os.stat(d, dir_fd=dfd, follow_symlinks=False).st_mode):
                atalhos.append(os.path.join(dirpath, d))
        for nome in filenames:
            try:
                st = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(st.st_mode):
                atalhos.append(os.path.join(dirpath, nome))
                continue
            if stat.S_ISREG(st.st_mode):
                yield dfd, nome, os.path.join(dirpath, nome), st


def remover_vazias(raiz: Path):
    """Apaga as subpastas que ficaram vazias (nunca a raiz). Devolve quantas."""
    n = 0
    if not raiz.is_dir() or raiz.is_symlink():
        return 0
    for _dp, dirnames, _fn, dfd in os.fwalk(str(raiz), topdown=False, follow_symlinks=False):
        for d in dirnames:
            try:
                os.rmdir(d, dir_fd=dfd)
                n += 1
            except OSError as e:
                if e.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                    raise
    return n


# --- reescrita atomica ---------------------------------------------------------------------------
@dataclass
class Resultado:
    mudou: int = 0
    pulado: str | None = None
    novo_tam: int | None = None
    novo_ino: int | None = None
    mtime: float | None = None
    mapa: dict = field(default_factory=dict)


def _nome_tmp(nome):
    return f".{nome}.{secrets.token_hex(4)}.dgclaw-novo"


def _abrir_leitura(dfd, nome, ignorar_atividade):
    fd = os.open(nome, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    f = os.fdopen(fd, "rb")
    st = os.fstat(f.fileno())
    if not stat.S_ISREG(st.st_mode):
        f.close()
        return None, None, "nao e um arquivo comum"
    if not ignorar_atividade and agora() - st.st_mtime < JANELA_ATIVA_S:
        f.close()
        return None, None, "em uso agora (mudou nos ultimos 2 minutos); rode de novo daqui a pouco"
    return f, st, None


def _criar_tmp(dfd, nome):
    tmp = _nome_tmp(nome)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
    return tmp, fd


def _fechar_e_trocar(dfd, nome, tmp, fd, st, caminho):
    """Copia dono/modo/datas para o temporario, confere que o original nao mudou e troca."""
    try:
        if (st.st_uid, st.st_gid) != (os.geteuid(), os.getegid()):
            os.fchown(fd, st.st_uid, st.st_gid)
        os.fchmod(fd, stat.S_IMODE(st.st_mode))
        os.fsync(fd)
        os.utime(fd, ns=(st.st_atime_ns, st.st_mtime_ns))
    except PermissionError as e:
        raise erro("nao consegui manter o dono do arquivo ao reescreve-lo",
                   f"{caminho} (dono uid {st.st_uid}): {e}",
                   "rode o comando como root (sudo dgclaw ...); o arquivo e do uid do agente e so o root troca o dono.") from e
    st2 = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
    if (st2.st_ino, st2.st_size, st2.st_mtime_ns) != (st.st_ino, st.st_size, st.st_mtime_ns):
        return "mudou enquanto eu lia; nada foi trocado. Rode de novo daqui a pouco"
    os.replace(tmp, nome, src_dir_fd=dfd, dst_dir_fd=dfd)
    return None


def _tmp_limpar(dfd, tmp):
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp, dir_fd=dfd)


def reescrever_linhas(dfd, nome, caminho, trans, ensaio=False, posicoes=(), ignorar_atividade=False):
    """Passa cada linha COMPLETA (termina em \\n) por trans(bytes)->bytes. A ultima linha sem \\n
    (alguem escrevendo agora) passa intacta. `posicoes`: offsets antigos de limite de linha cujo
    offset novo o chamador quer saber (o indice conversas.db guarda a posicao lida)."""
    f, st, motivo = _abrir_leitura(dfd, nome, ignorar_atividade)
    if motivo:
        return Resultado(pulado=motivo)
    posicoes = set(posicoes)
    r = Resultado()
    tmp = fd = saida = None
    try:
        with f:
            if not ensaio:
                tmp, fd = _criar_tmp(dfd, nome)
                saida = os.fdopen(fd, "wb", closefd=False)
            ant = novo = 0
            for linha in f:
                if ant in posicoes:
                    r.mapa[ant] = novo
                nova = trans(linha) if linha.endswith(b"\n") else linha
                if nova != linha:
                    r.mudou += 1
                if saida:
                    saida.write(nova)
                ant += len(linha)
                novo += len(nova)
            if ant in posicoes:
                r.mapa[ant] = novo
            if saida:
                saida.flush()
            if r.mudou == 0 or ensaio:
                return r
            r.novo_tam = novo
            motivo = _fechar_e_trocar(dfd, nome, tmp, fd, st, caminho)
            if motivo:
                return Resultado(pulado=motivo)
            tmp = None
            st3 = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
            r.novo_ino, r.mtime = st3.st_ino, st3.st_mtime
            return r
    finally:
        if fd is not None:
            os.close(fd)
        if tmp:
            _tmp_limpar(dfd, tmp)


def reescrever_inteiro(dfd, nome, caminho, trans, ensaio=False, ignorar_atividade=False):
    """Le o arquivo todo (ate 64 MB), passa por trans(bytes)->bytes e troca se mudou."""
    f, st, motivo = _abrir_leitura(dfd, nome, ignorar_atividade)
    if motivo:
        return Resultado(pulado=motivo)
    with f:
        if st.st_size > MAX_TEXTO_BYTES:
            return Resultado(pulado=f"grande demais para reescrever ({st.st_size // 1048576} MB, o limite e 64 MB); revise na mao")
        dados = f.read()
    novo = trans(dados)
    r = Resultado(mudou=1 if novo != dados else 0)
    if r.mudou == 0 or ensaio:
        return r
    tmp, fd = _criar_tmp(dfd, nome)
    try:
        with os.fdopen(fd, "wb", closefd=False) as saida:
            saida.write(novo)
        motivo = _fechar_e_trocar(dfd, nome, tmp, fd, st, caminho)
        if motivo:
            return Resultado(pulado=motivo)
        tmp = None
        st3 = os.stat(nome, dir_fd=dfd, follow_symlinks=False)
        r.novo_tam, r.novo_ino, r.mtime = len(novo), st3.st_ino, st3.st_mtime
        return r
    finally:
        os.close(fd)
        if tmp:
            _tmp_limpar(dfd, tmp)


# --- JSON ----------------------------------------------------------------------------------------
def mapear_strings(obj, fn, chave=None):
    """Aplica fn a toda string do JSON, menos as de campos de estrutura (CHAVES_PROTEGIDAS)."""
    if isinstance(obj, str):
        return obj if chave in CHAVES_PROTEGIDAS else fn(obj)
    if isinstance(obj, list):
        return [mapear_strings(x, fn, chave) for x in obj]
    if isinstance(obj, dict):
        return {k: mapear_strings(v, fn, k) for k, v in obj.items()}
    return obj


def serializar_linha(obj):
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


# --- sqlite --------------------------------------------------------------------------------------
@contextlib.contextmanager
def trava_do_indice(lock: Path):
    """Respeita a trava do reindex. So abre a trava que ja existe, em leitura: criar um arquivo de
    root na pasta do agente travaria o reindex dele (o agente nao conseguiria abri-lo para escrita)."""
    if not lock.exists():
        yield
        return
    with open(lock, "rb") as t:
        try:
            fcntl.flock(t, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise erro("o reindex deste agente esta rodando agora", str(lock),
                       "espere uns minutos (o reindex dura pouco) e rode o comando de novo.") from e
        yield


def abrir_db(db: Path, somente_leitura=False):
    if somente_leitura:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    else:
        con = sqlite3.connect(str(db), timeout=10)
        con.execute("PRAGMA secure_delete=ON")  # senao o texto apagado continua nas paginas livres
    con.execute("PRAGMA busy_timeout=5000")
    return con


def fechar_db(con, db: Path):
    """Fecha e devolve ao dono do banco os arquivos -wal/-shm que o root possa ter criado: se o agente
    nao conseguir escreve-los, o proximo reindex dele falha com "attempt to write a readonly database"."""
    con.close()
    try:
        st = os.stat(db)
    except FileNotFoundError:
        return
    for suf in ("-wal", "-shm", "-journal"):
        f = Path(str(db) + suf)
        if f.exists() and not f.is_symlink():
            if (st.st_uid, st.st_gid) != (os.geteuid(), os.getegid()):
                os.chown(f, st.st_uid, st.st_gid)
            os.chmod(f, stat.S_IMODE(st.st_mode))


def compactar_db(con):
    """Depois de apagar linhas: recria o indice de busca, devolve as paginas livres ao disco e zera o WAL,
    para o texto apagado nao ficar no arquivo."""
    tem = con.execute("SELECT 1 FROM sqlite_master WHERE name='trechos_fts'").fetchone()
    if tem:
        con.execute("INSERT INTO trechos_fts(trechos_fts) VALUES('rebuild')")
    con.commit()
    con.execute("VACUUM")
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def tem_tabela(con, nome):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (nome,)).fetchone() is not None


def corrigir_fontes(db: Path, caminho, resultado: Resultado, posicao_antiga):
    """Depois de reescrever um transcript, o conversas.db precisa saber o novo tamanho, o novo inode
    e a nova posicao lida; senao o indexador acha que o arquivo encolheu e le tudo de novo (e
    reinsere o texto trocado pelo marcador). Sem linha em `fontes` nao ha o que corrigir."""
    con = abrir_db(db)
    try:
        if not tem_tabela(con, "fontes"):
            return
        nova = resultado.mapa.get(posicao_antiga)
        if nova is None:
            # posicao no meio de uma linha (indice antigo ou arquivo editado por fora): deixa o
            # indexador reler esse arquivo do zero; a impressao digital impede duplicar.
            con.execute("DELETE FROM fontes WHERE caminho=?", (str(caminho),))
        else:
            con.execute("UPDATE fontes SET tamanho=?, posicao=?, inode=?, mtime=? WHERE caminho=?",
                        (resultado.novo_tam, nova, resultado.novo_ino, resultado.mtime, str(caminho)))
        con.commit()
    finally:
        fechar_db(con, db)


def posicoes_lidas(db: Path):
    """{caminho do transcript: posicao ja indexada} do conversas.db; vazio se nao existe."""
    if not db.is_file():
        return {}
    con = abrir_db(db, somente_leitura=True)
    try:
        if not tem_tabela(con, "fontes"):
            return {}
        return {c: p for c, p in con.execute("SELECT caminho, posicao FROM fontes WHERE tipo='transcript'")}
    except sqlite3.DatabaseError as e:
        raise erro("nao consegui ler o indice de conversas", f"{db}: {e}",
                   "se o arquivo estiver corrompido, apague-o e rode: conversas_fts.py reindex --do-zero (o indice se refaz dos transcripts).") from e
    finally:
        fechar_db(con, db)


# --- onde cada agente guarda o que ---------------------------------------------------------------
def raizes_transcripts(alvo: Alvo):
    """Pastas de transcripts (Claude e Codex) que existem, sem atalho no caminho."""
    achadas, vistas = [], set()
    candidatos = []
    if alvo.transcripts_dir:
        candidatos.append(alvo.transcripts_dir)
    for partes in ((".claude", "projects"), (".codex", "sessions")):
        c = sob_casa(alvo.home, *partes)
        if c:
            candidatos.append(c)
    for c in candidatos:
        if c.is_dir() and not c.is_symlink() and str(c) not in vistas:
            vistas.add(str(c))
            achadas.append(c)
    # transcripts_dir costuma ser uma subpasta de .claude/projects: varrer as duas contaria tudo duas vezes
    return [c for c in achadas if not any(o != c and o in c.parents for o in achadas)]


def eh_transcript(nome):
    return nome.endswith(".jsonl")


def db_conversas(alvo: Alvo):
    o = os.environ.get("DGCLAW_CONVERSAS_DB")
    return Path(o) if o else alvo.home / ".dgclaw" / "memory_index" / "conversas.db"


def db_chunks(alvo: Alvo):
    return alvo.home / ".dgclaw" / "memory_index" / "chunks.db"


def formatar_bytes(n):
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.1f} KB"


_ISO = re.compile(r"^\d{4}-\d\d-\d\d")


def dia_de(ts):
    return ts[:10] if isinstance(ts, str) and _ISO.match(ts) else None
