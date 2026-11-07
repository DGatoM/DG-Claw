#!/usr/bin/env bash
# lib/anonimizar-instalar.sh: instala o motor opcional de "Anonimizar documentos" (anonimizar/CONTRATO.md).
#
# Dois niveis:
#   leitores   venv com pypdf, python-docx e openpyxl (PDF, Word e Excel)
#   completo   leitores + torch (CPU) + gliner2 + o modelo de nomes, numa revisao fixa do Hugging Face
#
#   lib/anonimizar-instalar.sh [--ensaio] leitores|completo
#
# Tudo fica em $DGCLAW_ANON_BASE (padrao /opt/dgclaw/anonimizar): venv/, modelo/ e estado.json.
# --ensaio so imprime o que faria. O estado.json e gravado sempre, inclusive quando a instalacao falha.
# Nao cria a unidade do systemd: quem chama (a unidade dgclaw-anonimizar-instalar.service) vem do install.sh.
#
# Versoes por Python (nivel completo). O Ubuntu 22.04 traz Python 3.10, o 24.04 o 3.12 e o 26.04 o 3.14, e as
# versoes de torch, transformers e numpy mudam conforme o Python:
#   Python 3.10        requisitos-completo-py310.txt  torch 2.14.1 (a ultima com roda cp310), transformers 5.20.2
#   Python 3.11        requisitos-completo-py311.txt  torch 2.15.0
#   Python 3.12 a 3.14 requisitos-completo.txt        torch 2.15.0
#   Outro Python       o nivel completo falha explicando; o nivel leitores continua funcionando.
# Antes de subir qualquer versao, confira o que existe de verdade (nunca chute):
#   Rodas do torch para o Python alvo:  curl -s https://pypi.org/pypi/torch/<versao>/json  (ver as tags cpNNN dos arquivos)
#                                       e https://download.pytorch.org/whl/cpu/torch/ (a roda +cpu precisa existir ali)
#   Python minimo de cada pacote:       curl -s https://pypi.org/pypi/<pacote>/<versao>/json  (campo info.requires_python)
#   Conjunto completo para um Python:   pip install --dry-run --no-deps --only-binary=:all: --python-version 3.10 \
#                                         --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 --platform any \
#                                         --target /tmp/x -r anonimizar/requisitos-completo-py310.txt
#                                       (repita para 3.11, 3.12 e 3.14; sai 0 quando todas as rodas existem)
set -euo pipefail

BASE="${DGCLAW_ANON_BASE:-/opt/dgclaw/anonimizar}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANON_DIR="$AQUI/../anonimizar"
ESTADO="$BASE/estado.json"

MODELO_REPO="fastino/gliner2-privacy-filter-PII-multi"
# Revisao FIXA (commit do Hugging Face): o modelo nao muda por baixo da instalacao.
MODELO_REVISAO="1cb4166094dc58fa8d836429f060d6c95f62b495"
TORCH_VERSAO=""
REQUISITOS_COMPLETO=""
TORCH_INDICE="https://download.pytorch.org/whl/cpu"
# Nunca .bin, .pkl ou .py: so pesos em safetensors e arquivos de configuracao.
MODELO_PADROES='["*.json","*.safetensors","*.model","*.spm","*.txt"]'

ENSAIO=0
NIVEL=""
PASSO="começando"
ERRO_MSG=""

uso() {
    echo "uso: $0 [--ensaio] leitores|completo" >&2
}

passo() {
    PASSO="$1"
    echo "==> $1"
}

falha() {
    ERRO_MSG="$1${2:+ $2}"
    echo "erro: $ERRO_MSG" >&2
    exit 1
}

# Grava o estado.json por inteiro, atomicamente (arquivo temporario e rename), preservando o que ja
# estava instalado quando a tentativa falha. $1 = mensagem de erro (vazia = sucesso).
grava_estado() {
    local erro="$1" versao="null"
    [ "$NIVEL" = completo ] && versao="$MODELO_REVISAO"
    mkdir -p "$BASE"
    python3 - "$ESTADO" "$NIVEL" "$versao" "$erro" <<'PY'
import json, os, sys, datetime
caminho, nivel, versao, erro = sys.argv[1:5]
anterior = {}
try:
    with open(caminho, encoding="utf-8") as f:
        anterior = json.load(f)
except (OSError, ValueError):
    pass
if erro:
    estado = {"nivel": anterior.get("nivel"), "versao_modelo": anterior.get("versao_modelo"),
              "instalado_em": anterior.get("instalado_em"), "erro": erro, "nivel_pedido": nivel}
else:
    estado = {"nivel": nivel, "versao_modelo": None if versao == "null" else versao,
              "instalado_em": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "erro": None, "nivel_pedido": nivel}
tmp = "%s.tmp.%d" % (caminho, os.getpid())
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(estado, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, caminho)
PY
}

ao_sair() {
    local rc=$?
    if [ "$rc" -ne 0 ] && [ "$ENSAIO" = 0 ] && [ -n "$NIVEL" ]; then
        [ -n "$ERRO_MSG" ] || ERRO_MSG="a instalação parou no passo '$PASSO' (veja o log da unidade dgclaw-anonimizar-instalar para o detalhe)."
        grava_estado "$ERRO_MSG" || echo "aviso: não consegui gravar $ESTADO" >&2
    fi
    exit "$rc"
}
trap ao_sair EXIT

while [ "$#" -gt 0 ]; do
    case "$1" in
        --ensaio) ENSAIO=1 ;;
        leitores|completo) NIVEL="$1" ;;
        -h|--ajuda) uso; exit 0 ;;
        *) uso; echo "erro: argumento desconhecido '$1'. Use leitores ou completo." >&2; exit 2 ;;
    esac
    shift
done
[ -n "$NIVEL" ] || { uso; echo "erro: diga o nível: leitores ou completo." >&2; exit 2; }

# Escolhe o arquivo de requisitos e o torch pela versao do python3 (so o nivel completo depende disso).
escolhe_versoes() {
    # DGCLAW_ANON_PYVER so existe para os testes simularem outro Python.
    PYVER="${DGCLAW_ANON_PYVER:-$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')}"
    case "$PYVER" in
        3.10) REQUISITOS_COMPLETO="requisitos-completo-py310.txt"; TORCH_VERSAO="2.14.1" ;;
        3.11) REQUISITOS_COMPLETO="requisitos-completo-py311.txt"; TORCH_VERSAO="2.15.0" ;;
        3.12|3.13|3.14) REQUISITOS_COMPLETO="requisitos-completo.txt"; TORCH_VERSAO="2.15.0" ;;
        *) return 1 ;;
    esac
}

# Espaco livre no ponto de montagem mais proximo de $BASE (a pasta pode ainda nao existir).
espaco_livre_mb() {
    local d="$BASE"
    while [ ! -d "$d" ] && [ "$d" != "/" ]; do d="$(dirname "$d")"; done
    df -Pm "$d" | awk 'NR==2 {print $4}'
}

if [ "$NIVEL" = completo ]; then
    EXIGIDO_MB="${DGCLAW_ANON_ESPACO_EXIGIDO_MB:-3072}"
else
    EXIGIDO_MB="${DGCLAW_ANON_ESPACO_EXIGIDO_MB:-500}"
fi

if [ "$ENSAIO" = 1 ]; then
    echo "[ensaio] nível: $NIVEL"
    echo "[ensaio] base: $BASE"
    echo "[ensaio] conferiria python3 com venv e pelo menos ${EXIGIDO_MB} MB livres"
    if [ "$NIVEL" = completo ]; then
        if ! escolhe_versoes; then
            echo "[ensaio] o Python $PYVER está fora de 3.10 a 3.14: o nível completo falharia explicando"
            exit 0
        fi
        echo "[ensaio] Python $PYVER: usaria anonimizar/$REQUISITOS_COMPLETO e torch==$TORCH_VERSAO"
    fi
    echo "[ensaio] criaria o ambiente Python em $BASE/venv"
    echo "[ensaio] instalaria os leitores (versões fixadas em anonimizar/requisitos-leitores.txt)"
    if [ "$NIVEL" = completo ]; then
        echo "[ensaio] instalaria torch==$TORCH_VERSAO pelo índice CPU $TORCH_INDICE"
        echo "[ensaio] instalaria as dependências fixadas de anonimizar/$REQUISITOS_COMPLETO"
        echo "[ensaio] baixaria $MODELO_REPO na revisão $MODELO_REVISAO (só safetensors e json) para $BASE/modelo"
    fi
    echo "[ensaio] testaria o motor com: $BASE/venv/bin/python -I anonimizar/motor.py estado"
    echo "[ensaio] gravaria $ESTADO"
    exit 0
fi

passo "conferindo o python3"
command -v python3 >/dev/null 2>&1 \
    || falha "o python3 não foi encontrado nesta máquina." "Instale com: apt-get install -y python3 python3-venv"
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 \
    || falha "faltam o venv/ensurepip do Python." "Instale com: apt-get install -y python3-venv"

if [ "$NIVEL" = completo ]; then
    passo "escolhendo as versões para o Python desta máquina"
    escolhe_versoes \
        || falha "o nível completo funciona com o Python 3.10 a 3.14 e esta máquina tem o Python $PYVER." \
                 "O nível leitores continua disponível; para o completo, instale um Python entre 3.10 e 3.14."
    echo "    Python $PYVER: anonimizar/$REQUISITOS_COMPLETO e torch $TORCH_VERSAO"
fi

passo "conferindo o espaço em disco"
LIVRE_MB="$(espaco_livre_mb)"
[ "${LIVRE_MB:-0}" -ge "$EXIGIDO_MB" ] \
    || falha "há ${LIVRE_MB:-0} MB livres perto de $BASE e o nível $NIVEL precisa de ${EXIGIDO_MB} MB." "Libere espaço no disco e tente de novo."

mkdir -p "$BASE"

passo "criando o ambiente Python"
if ! "$BASE/venv/bin/python" -c 'pass' >/dev/null 2>&1; then
    rm -rf "$BASE/venv"
    python3 -m venv "$BASE/venv"
fi
PIP=("$BASE/venv/bin/python" -m pip --disable-pip-version-check --no-input)

passo "instalando os leitores de PDF, Word e Excel"
"${PIP[@]}" install --quiet -r "$ANON_DIR/requisitos-leitores.txt"

if [ "$NIVEL" = completo ]; then
    passo "instalando o torch (CPU, sem CUDA)"
    "${PIP[@]}" install --quiet --index-url "$TORCH_INDICE" "torch==$TORCH_VERSAO"
    passo "instalando o detector de nomes (gliner2)"
    "${PIP[@]}" install --quiet -r "$ANON_DIR/$REQUISITOS_COMPLETO"

    passo "baixando o modelo $MODELO_REPO (revisão $MODELO_REVISAO)"
    rm -rf "$BASE/modelo.novo"
    HF_HUB_DISABLE_TELEMETRY=1 "$BASE/venv/bin/python" - "$MODELO_REPO" "$MODELO_REVISAO" "$BASE/modelo.novo" "$MODELO_PADROES" <<'PY'
import json, sys
from huggingface_hub import snapshot_download
repo, revisao, destino, padroes = sys.argv[1:5]
snapshot_download(repo, revision=revisao, local_dir=destino, allow_patterns=json.loads(padroes))
PY
    [ -s "$BASE/modelo.novo/model.safetensors" ] \
        || falha "o download do modelo terminou sem o arquivo model.safetensors." "Tente de novo; se repetir, confira a conexão com huggingface.co."
    rm -rf "$BASE/modelo.novo/.cache"
    find "$BASE/modelo.novo" \( -name '*.bin' -o -name '*.pkl' -o -name '*.py' -o -name '*.pt' -o -name '*.pth' \) -delete
    rm -rf "$BASE/modelo.antigo"
    [ ! -d "$BASE/modelo" ] || mv "$BASE/modelo" "$BASE/modelo.antigo"
    mv "$BASE/modelo.novo" "$BASE/modelo"
    rm -rf "$BASE/modelo.antigo"
fi

passo "testando o motor"
SAIDA_TESTE="$(DGCLAW_ANON_BASE="$BASE" "$BASE/venv/bin/python" -I "$ANON_DIR/motor.py" estado)" \
    || falha "o motor não respondeu ao teste depois de instalado." "Rode: $BASE/venv/bin/python -I $ANON_DIR/motor.py estado"
case "$NIVEL:$SAIDA_TESTE" in
    leitores:*'"nivel": "leitores"'*|completo:*'"nivel": "completo"'*) ;;
    *) falha "o motor respondeu, mas não no nível pedido ($NIVEL)." "Resposta: $SAIDA_TESTE" ;;
esac

passo "gravando o estado"
grava_estado ""
echo "Pronto: motor de anonimização no nível $NIVEL em $BASE."
