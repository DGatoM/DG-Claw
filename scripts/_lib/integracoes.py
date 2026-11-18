#!/usr/bin/env python3
"""integracoes.py (DG Claw): registro de saude das integracoes do agente.

Os programas que falam com um sistema externo (Instagram, transcricao, WhatsApp...) anotam o
RESULTADO de cada uso real. Daqui sai o estado.json que o painel desenha como mapa de integracoes.
Plano: docs/PLANO-INTEGRACOES-E-VIGIA.md (secoes 3.2 e 3.4).

Onde grava: $DGCLAW_INTEGRACOES_DIR, ou $DGCLAW_WORKSPACE/.dgclaw/integracoes, ou
$HOME/.dgclaw/integracoes.
  eventos.jsonl   uma linha por evento: {"em","id","resultado","origem"}
  estado.json     o estado calculado por integracao (troca atomica)
  .trava          trava de arquivo (flock) para quem grava

Regras:
  * Nunca ha texto livre: id pelo formato, resultado e origem de listas fechadas.
  * So operacao real registra (consulta de teste nao).
  * `ok` consecutivo e aparado: um ok logo depois de outro ok, dentro de uma hora, nao grava. Um ok
    depois de uma falha sempre grava, e a falha sempre grava.
  * No maximo 50 integracoes por agente.
  * Poda: 30 dias e 5000 linhas.

Uso na linha de comando (via bin/dgclaw-integracao):
  python3 -I integracoes.py registrar <id> <resultado> [--origem uso|canal]
  python3 -I integracoes.py estado

Uso em Python:
  sys.path.insert(0, os.path.join(os.path.dirname(__file__), "_lib"))
  from integracoes import registrar_silencioso
  registrar_silencioso("instagram", "ok")
"""
import datetime
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import time

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
RESULTADOS = (
    "ok", "credencial_recusada", "sem_saldo", "limite", "fora_do_ar",
    "desconectado", "rede", "incerto", "vencendo", "erro",
)
ORIGENS = ("uso", "canal")
GRAVES = ("credencial_recusada", "sem_saldo", "fora_do_ar")
AMARELOS = ("rede", "limite", "incerto", "vencendo", "erro")

MAX_IDS = 50
MAX_LINHAS = 5000
DIAS_RETENCAO = 30
DIAS_SEM_USO = 7
APARO_OK_SEG = 60 * 60
CONFIRMACAO_SEG = 120
ESPERA_TRAVA_SEG = 2.0
MAX_BYTES_LEITURA = 1024 * 1024   # cabe com folga as 5000 linhas da poda (~100 bytes cada)

FORMATO_TEMPO = "%Y-%m-%dT%H:%M:%SZ"


class ErroUso(Exception):
    """Entrada invalida de quem chamou (id, resultado ou origem fora do combinado)."""


class ErroGravacao(Exception):
    """Nao deu para gravar (disco, permissao, limite de integracoes)."""


def pasta():
    d = os.environ.get("DGCLAW_INTEGRACOES_DIR")
    if d:
        return d
    ws = os.environ.get("DGCLAW_WORKSPACE")
    base = ws if ws else os.path.expanduser("~")
    return os.path.join(base, ".dgclaw", "integracoes")


def _agora():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def _fmt(dt):
    return dt.astimezone(datetime.timezone.utc).strftime(FORMATO_TEMPO)


def _parse(texto):
    return datetime.datetime.strptime(texto, FORMATO_TEMPO).replace(tzinfo=datetime.timezone.utc)


def _eventos_validos(linhas):
    """Converte linhas de texto em eventos; linha estragada ou fora do esquema e ignorada."""
    saida = []
    for linha in linhas:
        linha = linha.strip()
        if not linha:
            continue
        try:
            e = json.loads(linha)
            if (isinstance(e, dict) and isinstance(e.get("id"), str) and ID_RE.fullmatch(e["id"]) and e.get("resultado") in RESULTADOS
                    and e.get("origem") in ORIGENS):
                _parse(e["em"])
                saida.append({"em": e["em"], "id": e["id"], "resultado": e["resultado"], "origem": e["origem"]})
        except (ValueError, TypeError, KeyError):
            continue
    return saida


def calcular_estado(eventos, agora):
    """Funcao pura: lista de eventos (dicts em/id/resultado/origem) -> lista de itens do estado.

    Tabela do plano (3.4): verde, amarelo, vermelho, sem_uso_recente. Quem esta desligado e
    marcado depois, pelo painel (preferencia do dono).
    """
    # A ordem e a de REGISTRO no arquivo (nao a do horario): o que veio depois do ultimo ok e o que foi
    # gravado depois dele, mesmo que o relogio tenha empatado ou voltado.
    por_id = {}
    for e in eventos:
        por_id.setdefault(e["id"], []).append(e)
    itens = []
    for iid in sorted(por_id):
        evs = por_id[iid]
        ultimo = evs[-1]
        t_ultimo = _parse(ultimo["em"])
        idade = (agora - t_ultimo).total_seconds()
        if idade > DIAS_RETENCAO * 86400:
            continue
        ultimo_ok = None
        pos_ok = -1
        for i, e in enumerate(evs):
            if e["resultado"] == "ok":
                ultimo_ok = e["em"]
                pos_ok = i
        falha = None
        for e in evs:
            if e["resultado"] != "ok":
                falha = e
        apos_ok = evs[pos_ok + 1:]
        graves = [_parse(e["em"]) for e in apos_ok if e["resultado"] in GRAVES]
        desconectado = any(e["resultado"] == "desconectado" for e in apos_ok)
        if idade > DIAS_SEM_USO * 86400:
            estado = "sem_uso_recente"
        elif desconectado or (len(graves) >= 2 and (max(graves) - min(graves)).total_seconds() >= CONFIRMACAO_SEG):
            estado = "vermelho"
        elif graves or ultimo["resultado"] in AMARELOS:
            estado = "amarelo"
        else:
            estado = "verde"
        itens.append({
            "id": iid,
            "estado": estado,
            "ultimoEvento": ultimo["em"],
            "ultimoResultado": ultimo["resultado"],
            "ultimoOk": ultimo_ok,
            "ultimaTentativaReal": ultimo["em"],
            "ultimaFalha": falha["em"] if falha else None,
            "ultimaFalhaResultado": falha["resultado"] if falha else None,
        })
    return itens


def _troca_atomica(caminho, conteudo):
    """Grava em arquivo temporario na mesma pasta e troca com os.replace (modo 0644)."""
    d = os.path.dirname(caminho)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(conteudo)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, caminho)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _recusar_root():
    if os.geteuid() == 0:
        raise ErroGravacao("O registro de integracoes e do usuario do agente e nao pode rodar como root: como root ele "
                           "gravaria numa pasta que o agente controla. Rode o comando como o usuario do agente "
                           "(dentro do container do agente) e nao como root.")


def registrar(iid, resultado, origem="uso", agora=None):
    """Anota um resultado. Devolve "gravado" ou "aparado". Levanta ErroUso ou ErroGravacao."""
    if not isinstance(iid, str) or not ID_RE.fullmatch(iid):
        raise ErroUso(f"O id da integracao {iid!r} nao serve. Use de 1 a 32 caracteres: letras minusculas, "
                      "numeros e hifen, comecando por letra ou numero (exemplo: instagram, nota-fiscal).")
    if resultado not in RESULTADOS:
        raise ErroUso(f"O resultado {resultado!r} nao existe. Use um destes: {', '.join(RESULTADOS)}.")
    if origem not in ORIGENS:
        raise ErroUso(f"A origem {origem!r} nao existe. Use uma destas: {', '.join(ORIGENS)}.")
    agora = (agora or _agora()).astimezone(datetime.timezone.utc).replace(microsecond=0)
    _recusar_root()
    d = pasta()
    try:
        # Modo so na criacao: pasta que ja existe nao tem o modo mexido.
        os.makedirs(d, mode=0o755, exist_ok=True)
        if stat.S_ISLNK(os.lstat(d).st_mode):
            raise ErroGravacao(f"{d} e um link simbolico, entao nao gravei nada ali. Peca ao dono para conferir essa pasta.")
        fd_trava = os.open(os.path.join(d, ".trava"), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd_trava, "a") as trava:
            _pegar_trava(trava, d)
            try:
                return _registrar_travado(d, iid, resultado, origem, agora)
            finally:
                fcntl.flock(trava.fileno(), fcntl.LOCK_UN)
    except ErroGravacao:
        raise
    except OSError as e:
        raise ErroGravacao(f"Nao consegui gravar o registro da integracao {iid} ({resultado}) em {d}: {e.strerror or e}. "
                           "Confira se a pasta existe e se este usuario pode escrever nela.") from e


def _pegar_trava(trava, d):
    """Espera a trava por no maximo ESPERA_TRAVA_SEG; passado o prazo desiste, para nao prender quem chamou."""
    limite = time.monotonic() + ESPERA_TRAVA_SEG
    while True:
        try:
            fcntl.flock(trava.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= limite:
                raise ErroGravacao(f"Nao consegui a trava de {d} em {ESPERA_TRAVA_SEG:g} segundos: outro programa esta "
                                   "gravando o registro. O resultado nao foi anotado; tente de novo em instantes.") from None
            time.sleep(0.05)


def _ler_eventos(arq):
    """Le o eventos.jsonl sem seguir link simbolico, so se for arquivo comum, e so o fim (MAX_BYTES_LEITURA)."""
    try:
        fd = os.open(arq, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return []
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ErroGravacao(f"{arq} nao e um arquivo comum, entao nao o li nem o substitui. "
                               "Peca ao dono para conferir essa pasta.")
        cortado = st.st_size > MAX_BYTES_LEITURA
        if cortado:
            os.lseek(fd, st.st_size - MAX_BYTES_LEITURA, os.SEEK_SET)
        pedacos = []
        restante = MAX_BYTES_LEITURA
        while restante > 0:
            b = os.read(fd, restante)
            if not b:
                break
            pedacos.append(b)
            restante -= len(b)
    finally:
        os.close(fd)
    texto = b"".join(pedacos).decode("utf-8", errors="replace")
    linhas = texto.split("\n")
    if cortado:
        linhas = linhas[1:]   # a primeira linha do pedaco pode estar cortada ao meio
    return _eventos_validos(linhas)


def _registrar_travado(d, iid, resultado, origem, agora):
    arq_eventos = os.path.join(d, "eventos.jsonl")
    eventos = _ler_eventos(arq_eventos)
    corte = _fmt(agora - datetime.timedelta(days=DIAS_RETENCAO))
    eventos = [e for e in eventos if e["em"] >= corte]
    ids = {e["id"] for e in eventos}
    if iid not in ids and len(ids) >= MAX_IDS:
        raise ErroGravacao(f"Ja ha {MAX_IDS} integracoes registradas e {iid!r} seria a {MAX_IDS + 1}a. "
                           "Esse e o limite por agente. Reaproveite um id que ja existe ou espere as "
                           "sem uso por 30 dias sairem do registro.")
    resultado_gravacao = "gravado"
    if resultado == "ok":
        limite_aparo = _fmt(agora - datetime.timedelta(seconds=APARO_OK_SEG))
        anteriores = [e for e in eventos if e["id"] == iid]
        # so condensa ok CONSECUTIVO: se o ultimo registro desta integracao e um ok recente
        if anteriores and anteriores[-1]["resultado"] == "ok" and anteriores[-1]["em"] > limite_aparo:
            resultado_gravacao = "aparado"
    if resultado_gravacao == "gravado":
        eventos.append({"em": _fmt(agora), "id": iid, "resultado": resultado, "origem": origem})
    eventos = eventos[-MAX_LINHAS:]
    estado = {"versao": 1, "geradoEm": _fmt(agora), "integracoes": calcular_estado(eventos, agora)}
    # Estado primeiro: o vigia le o estado, e se a segunda troca falhar ele ja mostra o evento (a direcao segura).
    _troca_atomica(os.path.join(d, "estado.json"), json.dumps(estado, ensure_ascii=False, indent=1) + "\n")
    _troca_atomica(arq_eventos, "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in eventos))
    return resultado_gravacao


def registrar_silencioso(iid, resultado, origem="uso"):
    """Para os scripts instrumentados: nunca derruba quem chamou. Em falha, avisa em stderr."""
    try:
        registrar(iid, resultado, origem)
    except (ErroUso, ErroGravacao) as e:
        print(f"[integracoes] AVISO: nao registrei {iid} {resultado}: {e}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 - registrar e auxiliar e nao pode derrubar o programa que o chamou
        print(f"[integracoes] AVISO: erro inesperado ao registrar {iid} {resultado} ({type(e).__name__}: {e}). "
              "O programa seguiu normalmente.", file=sys.stderr)


MAX_BYTES_ESTADO = 256 * 1024
CAMPOS_TEMPO = ("ultimoEvento", "ultimoOk", "ultimaTentativaReal", "ultimaFalha")
ESTADOS = ("verde", "amarelo", "vermelho", "sem_uso_recente")


def _tempo_ou_nulo(v):
    if v is None:
        return True
    try:
        _parse(v)
        return True
    except (ValueError, TypeError):
        return False


def _estado_validado(j):
    """Confere o esquema do estado.json e devolve so os campos conhecidos. Levanta ValueError se nao servir."""
    if not isinstance(j, dict) or j.get("versao") != 1 or not isinstance(j.get("integracoes"), list):
        raise ValueError("nao tem o formato esperado (versao 1 com a lista de integracoes)")
    if len(j["integracoes"]) > MAX_IDS:
        raise ValueError(f"lista mais de {MAX_IDS} integracoes")
    if not _tempo_ou_nulo(j.get("geradoEm")):
        raise ValueError("geradoEm invalido")
    itens, vistos = [], set()
    for it in j["integracoes"]:
        if (not isinstance(it, dict) or not isinstance(it.get("id"), str) or not ID_RE.fullmatch(it["id"]) or it["id"] in vistos
                or it.get("estado") not in ESTADOS or it.get("ultimoResultado") not in RESULTADOS
                or not isinstance(it.get("ultimoEvento"), str)
                or any(not _tempo_ou_nulo(it.get(c)) for c in CAMPOS_TEMPO)
                or not (it.get("ultimaFalhaResultado") is None or it.get("ultimaFalhaResultado") in RESULTADOS)):
            raise ValueError("uma integracao esta fora do formato (id, estado, resultado ou data invalidos)")
        vistos.add(it["id"])
        itens.append({"id": it["id"], "estado": it["estado"], "ultimoEvento": it["ultimoEvento"],
                      "ultimoResultado": it["ultimoResultado"], "ultimoOk": it.get("ultimoOk"),
                      "ultimaTentativaReal": it.get("ultimaTentativaReal"), "ultimaFalha": it.get("ultimaFalha"),
                      "ultimaFalhaResultado": it.get("ultimaFalhaResultado")})
    return {"versao": 1, "geradoEm": j.get("geradoEm"), "integracoes": itens}


def _ler_estado(arq):
    """Le o estado.json sem seguir link simbolico, so se for arquivo comum e ate MAX_BYTES_ESTADO. None se ausente."""
    try:
        fd = os.open(arq, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ErroGravacao(f"{arq} nao e um arquivo comum, entao nao o li. Peca ao dono para conferir essa pasta.")
        pedacos, restante = [], MAX_BYTES_ESTADO + 1
        while restante > 0:
            b = os.read(fd, restante)
            if not b:
                break
            pedacos.append(b)
            restante -= len(b)
        bruto = b"".join(pedacos)
    finally:
        os.close(fd)
    if len(bruto) > MAX_BYTES_ESTADO:
        raise ErroGravacao(f"{arq} passa de {MAX_BYTES_ESTADO} bytes, entao nao o li.")
    try:
        return _estado_validado(json.loads(bruto.decode("utf-8")))
    except (ValueError, UnicodeDecodeError) as e:
        raise ErroGravacao(f"{arq} esta fora do formato esperado ({e}). Nada foi mostrado.") from None


def _uso():
    print("Uso: dgclaw-integracao registrar <id> <resultado> [--origem uso|canal]\n"
          "     dgclaw-integracao estado\n"
          f"Resultados: {', '.join(RESULTADOS)}.", file=sys.stderr)
    return 2


def main(argv):
    if not argv:
        return _uso()
    cmd, resto = argv[0], argv[1:]
    if cmd == "estado" and not resto:
        arq = os.path.join(pasta(), "estado.json")
        try:
            _recusar_root()
            estado = _ler_estado(arq)
        except ErroGravacao as e:
            print(f"Erro: {e}", file=sys.stderr)
            return 1
        except OSError as e:
            print(f"Nao consegui ler {arq}: {e.strerror or e}. Confira a permissao da pasta.", file=sys.stderr)
            return 1
        print(json.dumps(estado if estado is not None else {"versao": 1, "geradoEm": None, "integracoes": []}, ensure_ascii=False))
        return 0
    if cmd == "registrar":
        origem = "uso"
        pos = []
        i = 0
        while i < len(resto):
            if resto[i] == "--origem":
                if i + 1 >= len(resto):
                    return _uso()
                origem = resto[i + 1]
                i += 2
            else:
                pos.append(resto[i])
                i += 1
        if len(pos) != 2:
            return _uso()
        try:
            registrar(pos[0], pos[1], origem)
        except ErroUso as e:
            print(f"Uso errado: {e}", file=sys.stderr)
            return 2
        except ErroGravacao as e:
            print(f"Erro: {e}", file=sys.stderr)
            return 1
        return 0
    return _uso()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
