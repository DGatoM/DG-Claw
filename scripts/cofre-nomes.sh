#!/usr/bin/env bash
# Copia so os NOMES do cofre do agente para um arquivo que o runner consegue ler.
#
# Por que existe: o cofre.env e do root do container (600, numa pasta 700) e o runner
# roda como o usuario agente. O systemd le o cofre e entrega os valores ao runner pelo
# ambiente, mas o runner precisa saber QUAIS variaveis vieram do cofre para nao trata-las
# como herdadas (ver runner/src/provedores/ambiente.ts, nomesDoCofre). Este script roda
# como root no ExecStartPre=+ da unidade e escreve uma linha "NOME=" por chave, sem valor.
#
# Uso:   cofre-nomes.sh [<cofre.env>] [<saida>]
#        padrao: /run/dgclaw/cofre/cofre.env  ->  /run/dgclaw-cofre-nomes
# Saida: 0 sempre que conseguiu escrever a saida (cofre ausente vira saida vazia).
#        1 quando nao conseguiu ler o cofre que existe ou escrever a saida; a mensagem
#        diz o caminho e o que fazer. A unidade usa "+-" para o agente subir mesmo assim.
set -u

COFRE="${1:-/run/dgclaw/cofre/cofre.env}"
SAIDA="${2:-/run/dgclaw-cofre-nomes}"

nomes=""
if [ -e "$COFRE" ]; then
    if ! nomes="$(sed -E -n 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2=/p' "$COFRE")"; then
        echo "cofre-nomes: nao consegui ler $COFRE. Sem a lista, o runner trata as chaves do cofre como herdadas e tira OPENAI_API_KEY e afins do agente. Confira se o arquivo existe e se este passo roda como root (ExecStartPre=+)." >&2
        nomes=""
        falhou=1
    fi
fi

dir="$(dirname "$SAIDA")"
tmp="$(mktemp "$dir/.cofre-nomes.XXXXXX" 2>/dev/null)" || {
    echo "cofre-nomes: nao consegui criar um temporario em $dir para escrever $SAIDA. Confira se a pasta existe e se este passo roda como root." >&2
    exit 1
}
if ! { printf '%s\n' "$nomes" | sed '/^$/d' >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$SAIDA"; }; then
    rm -f "$tmp"
    echo "cofre-nomes: nao consegui gravar $SAIDA (temporario em $dir). Confira o espaco livre e a permissao da pasta, e se este passo roda como root (ExecStartPre=+)." >&2
    exit 1
fi
exit "${falhou:-0}"
