#!/usr/bin/env bash
# fixar-digest-ubuntu.sh: prende o `FROM ubuntu:24.04` do container/Containerfile ao digest oficial do
# manifest list, para a imagem do agente sair igual hoje e daqui a seis meses.
#
#   bash scripts/enterprise/fixar-digest-ubuntu.sh           mostra o digest e o que mudaria
#   bash scripts/enterprise/fixar-digest-ubuntu.sh --aplicar grava no Containerfile (os dois FROM)
#
# Para ATUALIZAR depois (patches de seguranca do Ubuntu): rode de novo com --aplicar, reconstrua a imagem
# (dgclaw imagem construir) e comite o Containerfile com a data na mensagem.
# Precisa de curl e jq e de acesso a hub.docker.com.
set -euo pipefail

TAG="${UBUNTU_TAG:-24.04}"
ARQ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/container/Containerfile"
APLICAR=0
[ "${1:-}" != --aplicar ] || APLICAR=1

falha() { printf 'Nao deu certo: %s\nO que fazer: %s\n' "$1" "$2" >&2; exit 1; }
for f in curl jq; do command -v "$f" >/dev/null || falha "falta o programa $f." "instale com: apt-get install -y curl jq"; done
[ -f "$ARQ" ] || falha "nao achei $ARQ." "rode de dentro do repositorio do DG Claw."

digest="$(curl --proto '=https' --tlsv1.2 -fsS --max-time 30 "https://hub.docker.com/v2/repositories/library/ubuntu/tags/$TAG" | jq -r '.digest // empty')" \
    || falha "a consulta a hub.docker.com falhou para a tag ubuntu:$TAG." "confira a rede (este endereco precisa estar liberado) e repita."
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || falha "o Docker Hub devolveu um digest que nao parece sha256: '${digest:0:80}'." "abra https://hub.docker.com/_/ubuntu/tags?name=$TAG e confira a tag."

printf 'ubuntu:%s -> %s\n' "$TAG" "$digest"
if [ "$APLICAR" != 1 ]; then
    printf 'Nada mudou. Para gravar no Containerfile: bash scripts/enterprise/fixar-digest-ubuntu.sh --aplicar\n'
    exit 0
fi
hoje="$(date +%Y-%m-%d)"
# Troca "FROM docker.io/library/ubuntu:24.04[@sha256:...]" (e "ubuntu:24.04" sem registro) pela forma com digest.
sed -E -i "s#^FROM (docker\.io/library/)?ubuntu:${TAG}(@sha256:[0-9a-f]{64})?( AS .*)?\$#FROM \1ubuntu:${TAG}@${digest}\3#" "$ARQ"
n="$(grep -c "ubuntu:${TAG}@${digest}" "$ARQ" || true)"
[ "$n" -ge 1 ] || falha "nao encontrei nenhuma linha FROM ubuntu:$TAG no Containerfile para fixar." "confira o arquivo $ARQ."
printf 'Containerfile atualizado em %s: %s linha(s) FROM fixadas (digest de %s).\n' "$hoje" "$n" "$hoje"
printf 'Comente a data no Containerfile e reconstrua: dgclaw imagem construir\n'
