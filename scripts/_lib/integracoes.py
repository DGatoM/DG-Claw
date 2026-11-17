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
  * `ok` repetido e aparado: no maximo um por hora por integracao. Falha sempre grava.
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
import sys
import tempfile

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
            if (isinstance(e, dict) and ID_RE.match(str(e.get("id", ""))) and e.get("resultado") in RESULTADOS
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
    por_id = {}
    for e in sorted(eventos, key=lambda x: x["em"]):
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
        for e in evs:
            if e["resultado"] == "ok":
                ultimo_ok = e["em"]
        falha = None
        for e in evs:
            if e["resultado"] != "ok":
                falha = e
        apos_ok = [e for e in evs if ultimo_ok is None or e["em"] > ultimo_ok]
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


def registrar(iid, resultado, origem="uso", agora=None):
    """Anota um resultado. Devolve "gravado" ou "aparado". Levanta ErroUso ou ErroGravacao."""
    if not isinstance(iid, str) or not ID_RE.match(iid):
        raise ErroUso(f"O id da integracao {iid!r} nao serve. Use de 1 a 32 caracteres: letras minusculas, "
                      "numeros e hifen, comecando por letra ou numero (exemplo: instagram, nota-fiscal).")
    if resultado not in RESULTADOS:
        raise ErroUso(f"O resultado {resultado!r} nao existe. Use um destes: {', '.join(RESULTADOS)}.")
    if origem not in ORIGENS:
        raise ErroUso(f"A origem {origem!r} nao existe. Use uma destas: {', '.join(ORIGENS)}.")
    agora = (agora or _agora()).astimezone(datetime.timezone.utc).replace(microsecond=0)
    d = pasta()
    try:
        os.makedirs(d, mode=0o755, exist_ok=True)
        try:
            os.chmod(d, 0o755)
        except OSError:
            pass
        with open(os.path.join(d, ".trava"), "a") as trava:
            fcntl.flock(trava.fileno(), fcntl.LOCK_EX)
            try:
                return _registrar_travado(d, iid, resultado, origem, agora)
            finally:
                fcntl.flock(trava.fileno(), fcntl.LOCK_UN)
    except ErroGravacao:
        raise
    except OSError as e:
        raise ErroGravacao(f"Nao consegui gravar o registro da integracao {iid} ({resultado}) em {d}: {e.strerror or e}. "
                           "Confira se a pasta existe e se este usuario pode escrever nela.") from e


def _registrar_travado(d, iid, resultado, origem, agora):
    arq_eventos = os.path.join(d, "eventos.jsonl")
    try:
        with open(arq_eventos, "r", encoding="utf-8", errors="replace") as f:
            eventos = _eventos_validos(f.readlines())
    except FileNotFoundError:
        eventos = []
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
        if any(e["id"] == iid and e["resultado"] == "ok" and e["em"] > limite_aparo for e in eventos):
            resultado_gravacao = "aparado"
    if resultado_gravacao == "gravado":
        eventos.append({"em": _fmt(agora), "id": iid, "resultado": resultado, "origem": origem})
    eventos = eventos[-MAX_LINHAS:]
    _troca_atomica(arq_eventos, "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in eventos))
    estado = {"versao": 1, "geradoEm": _fmt(agora), "integracoes": calcular_estado(eventos, agora)}
    _troca_atomica(os.path.join(d, "estado.json"), json.dumps(estado, ensure_ascii=False, indent=1) + "\n")
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
            with open(arq, "r", encoding="utf-8") as f:
                sys.stdout.write(f.read())
        except FileNotFoundError:
            print(json.dumps({"versao": 1, "geradoEm": None, "integracoes": []}))
        except OSError as e:
            print(f"Nao consegui ler {arq}: {e.strerror or e}. Confira a permissao da pasta.", file=sys.stderr)
            return 1
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
