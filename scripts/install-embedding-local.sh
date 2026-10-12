#!/bin/bash
# install-embedding-local.sh — liga a memoria semantica LOCAL do DG Claw: sem conta, sem
# chave, sem custo, e nada sai da maquina.
#
# O QUE BAIXA (uma vez so, ~350 MB):
#   - llama.cpp (o programa que roda o modelo), versao fixa, binario pronto para Linux x64
#     ou arm64. Nao compila nada.
#   - EmbeddingGemma 300M do Google em GGUF Q8_0 (333 MB), do repositorio oficial ggml-org
#     no Hugging Face. Sem login.
# Os dois sao conferidos por SHA-256 contra os valores publicados pelo GitHub e pelo Hugging
# Face. Arquivo que nao bate e apagado e a instalacao para, dizendo isso.
#
# QUANTO PESA NA MAQUINA: o modelo so ocupa memoria enquanto uma busca esta acontecendo
# (~600 MB, por poucos segundos) e o reindex roda de madrugada. Cabe numa KVM 1 (1 vCPU,
# 4 GB). Detalhes: scripts/memory_index/embedder.py.
#
# ONDE INSTALA: como root, em /opt/dgclaw/embed (todos os agentes da maquina usam a mesma
# copia); como usuario comum, em ~/.local/share/dgclaw/embed. --dir <pasta> escolhe outra.
#
# Uso:  bash install-embedding-local.sh [--dir <pasta>] [--reinstalar] [<config.sh>]
#       Com o <config.sh> do agente, no fim ja roda o primeiro reindex da memoria dele.
# Saida: 0 instalado e testado; 1 falhou (o motivo vem escrito); 64 uso errado.
set -uo pipefail

LLAMA_TAG="b11425"
declare -A LLAMA_SHA=(
    [x64]="6a47856d08ecc4030b2fa8b8bf761c96d142d689567f69a0f75e42de430dc34c"
    [arm64]="82b9804017436f624c1751f54a74469a879b16c8edcb721c4d68ef88d472af12"
)
MODELO="embeddinggemma-300M-Q8_0.gguf"
MODELO_URL="https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/$MODELO"
MODELO_SHA="b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMBEDDER="$SELF_DIR/memory_index/embedder.py"

DIR="${DGCLAW_EMBED_DIR:-}"
REINSTALAR=0
CONFIG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) DIR="${2:?--dir precisa de uma pasta}"; shift 2 ;;
        --reinstalar) REINSTALAR=1; shift ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        -*) echo "opcao desconhecida: $1 (use --dir, --reinstalar ou o caminho do config.sh)" >&2; exit 64 ;;
        *) CONFIG="$1"; shift ;;
    esac
done
if [ -z "$DIR" ]; then
    if [ "$(id -u)" = "0" ]; then DIR="/opt/dgclaw/embed"; else DIR="$HOME/.local/share/dgclaw/embed"; fi
fi

falha() { echo "ERRO: $*" >&2; exit 1; }

case "$(uname -m)" in
    x86_64|amd64) ARQ="x64" ;;
    aarch64|arm64) ARQ="arm64" ;;
    *) falha "processador $(uname -m) sem binario pronto do llama.cpp. A memoria semantica pode usar o Gemini: GEMINI_API_KEY no config.sh e DGCLAW_EMBED_PROVIDER=gemini." ;;
esac
[ "$(uname -s)" = "Linux" ] || falha "este instalador e para Linux (a VPS). No PC, a memoria semantica do modo local ainda nao existe."
for prog in curl tar sha256sum python3; do
    command -v "$prog" >/dev/null 2>&1 || falha "falta o programa '$prog'. No Ubuntu: apt-get install -y $prog"
done

# memoria e disco: avisa cedo em vez de falhar no meio
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 1500 ]; then
    falha "a maquina tem ${MEM_MB} MB de RAM; o modelo precisa de ~600 MB livres durante a busca. Com menos de 1,5 GB no total, prefira o Gemini (DGCLAW_EMBED_PROVIDER=gemini)."
fi
mkdir -p "$DIR" || falha "nao consegui criar $DIR (permissao?)"
LIVRE_MB=$(df -Pm "$DIR" | awk 'NR==2 {print $4}')
if [ -n "$LIVRE_MB" ] && [ "$LIVRE_MB" -lt 600 ]; then
    falha "so ${LIVRE_MB} MB livres em $DIR; a instalacao precisa de ~600 MB (o download e o modelo)."
fi

baixar() {  # baixar <url> <destino> <sha256> <o que e>
    local url="$1" destino="$2" sha="$3" oque="$4" tmp="$2.parcial"
    echo "==> baixando $oque (em silencio; o modelo leva ~1 min numa VPS comum)"
    if ! curl -fsSL --retry 3 --retry-delay 3 --connect-timeout 20 -o "$tmp" "$url"; then
        rm -f "$tmp"
        falha "o download de $oque falhou ($url). Confira a internet da VPS e rode de novo."
    fi
    local veio
    veio=$(sha256sum "$tmp" | awk '{print $1}')
    if [ "$veio" != "$sha" ]; then
        rm -f "$tmp"
        falha "o arquivo de $oque nao bate com o publicado (SHA-256 esperado $sha, veio $veio). Apaguei a copia. Pode ser download corrompido: rode de novo. Se repetir, nao use."
    fi
    mv "$tmp" "$destino"
}

# 1) llama.cpp
if [ "$REINSTALAR" = "1" ] || [ ! -x "$DIR/llama/llama-server" ] || [ "$(cat "$DIR/llama/VERSAO" 2>/dev/null)" != "$LLAMA_TAG" ]; then
    TGZ="$DIR/llama-$LLAMA_TAG-$ARQ.tar.gz"
    baixar "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-ubuntu-$ARQ.tar.gz" \
        "$TGZ" "${LLAMA_SHA[$ARQ]}" "o llama.cpp $LLAMA_TAG ($ARQ, ~18 MB)"
    rm -rf "$DIR/llama.novo" && mkdir -p "$DIR/llama.novo"
    tar xzf "$TGZ" -C "$DIR/llama.novo" --strip-components=1 || falha "nao consegui abrir $TGZ"
    [ -x "$DIR/llama.novo/llama-server" ] || falha "o pacote do llama.cpp $LLAMA_TAG nao trouxe o llama-server (mudou o formato?)"
    echo "$LLAMA_TAG" > "$DIR/llama.novo/VERSAO"
    rm -rf "$DIR/llama" && mv "$DIR/llama.novo" "$DIR/llama"
    rm -f "$TGZ"
else
    echo "==> llama.cpp $LLAMA_TAG ja instalado em $DIR/llama"
fi

# 2) o modelo
if [ "$REINSTALAR" = "1" ] || [ ! -f "$DIR/$MODELO" ]; then
    baixar "$MODELO_URL" "$DIR/$MODELO" "$MODELO_SHA" "o modelo EmbeddingGemma 300M (333 MB)"
else
    echo "==> modelo ja presente em $DIR/$MODELO"
fi

# os agentes rodam com usuario proprio (dgclaw-<slug>): precisam ler e executar
chmod -R a+rX "$DIR" 2>/dev/null

# 3) prova de vida: sobe, embeda uma frase, desce
echo "==> testando"
if ! DGCLAW_EMBED_DIR="$DIR" DGCLAW_EMBED_PROVIDER=local python3 "$EMBEDDER" teste; then
    falha "instalado, mas o teste nao passou (linha acima). Mande essa linha para o suporte."
fi

echo
echo "Memoria semantica local instalada em $DIR."
echo "Ela liga sozinha (DGCLAW_EMBED_PROVIDER=auto). O indice da memoria e refeito toda madrugada."

# 4) primeiro indice, se veio a config do agente
if [ -n "$CONFIG" ]; then
    [ -f "$CONFIG" ] || falha "config nao encontrada: $CONFIG"
    echo "==> montando o primeiro indice da memoria do agente (pode levar alguns minutos)"
    if DGCLAW_EMBED_DIR="$DIR" bash "$SELF_DIR/memory-reindex.sh" "$CONFIG"; then
        echo "Indice pronto."
    else
        echo "AVISO: o primeiro indice falhou (o motivo esta no log acima). Ele tenta de novo de madrugada." >&2
    fi
fi
exit 0
