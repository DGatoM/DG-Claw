#!/usr/bin/env bash
# install.sh: --nivel, o registro de versao e os ganchos ent_instalar_* (raiz falsa e stubs do instalador).
set -uo pipefail
AQUI_ENT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tests/instalador/ajuda.sh
. "$AQUI_ENT/../instalador/ajuda.sh"

TOTAL=0
verifica() { # verifica "<descricao>" <comando...>
    local desc="$1"; shift
    TOTAL=$((TOTAL + 1))
    if "$@" >/dev/null 2>&1; then printf '  ok     %s\n' "$desc"; else printf '  FALHOU %s\n' "$desc"; FALHAS=$((FALHAS + 1)); fi
}
cenario() {
    novo_cenario
    cp "$REPO/VERSION" "$FALSO/VERSION"
    cp -r "$REPO/config" "$FALSO/config"
    # Um bloco enterprise de mentira: marca que o gancho rodou e com qual nivel.
    cat >"$FALSO/lib/enterprise/zz-teste.sh" <<'FIM'
ent_instalar_zz() { echo "gancho com nivel $(protecao_nivel)" >>"$DGCLAW_RAIZ/gancho-instalar.txt"; }
FIM
}
instalar_ok() { instalar "$PAINEL_PW" --usuario maria --provedor claude "$@"; }
ETC_R() { printf '%s/etc/dgclaw' "$RAIZ"; }

echo "instalar: sem --nivel"
cenario
verifica "instalacao termina bem" instalar_ok
verifica "sem --nivel nao cria protecoes.json (= pessoal)" test ! -e "$(ETC_R)/protecoes.json"
verifica "registro de versao existe e e 644" modo_e "$(ETC_R)/versao" 644
# shellcheck disable=SC2016 # codigo jq
verifica "versao vem do arquivo VERSION" jq -e --arg v "$(tr -d '[:space:]' <"$REPO/VERSION")" '.versao == $v and has("commit") and (.data | test("^[0-9]{4}-"))' "$(ETC_R)/versao"
verifica "o app instalado leva o VERSION e a matriz" test -f "$RAIZ/opt/dgclaw/app/VERSION" -a -f "$RAIZ/opt/dgclaw/app/config/protecoes-matriz.json"
verifica "nivel pessoal: gancho nao roda" test ! -e "$RAIZ/gancho-instalar.txt"
verifica "dgclaw versao (CLI instalada) fala a versao" bash -c "cd '$RAIZ'; env -i PATH='$AQUI_ENT/../cli/stubs:/usr/bin:/bin' DGCLAW_RAIZ='$RAIZ' NO_COLOR=1 bash '$REPO/bin/dgclaw' versao | grep -q 'DG Claw $(tr -d '[:space:]' <"$REPO/VERSION")'"
limpar_cenario

echo "instalar: --nivel escritorio"
cenario
verifica "instalacao termina bem" instalar_ok --nivel escritorio
verifica "protecoes.json com o nivel, 600" jq -e '.nivel == "escritorio" and .versao == 1' "$(ETC_R)/protecoes.json"
verifica "protecoes.json 600" modo_e "$(ETC_R)/protecoes.json" 600
verifica "gancho rodou com o nivel certo" tem "$RAIZ/gancho-instalar.txt" "gancho com nivel escritorio"
verifica "a mudanca de nivel foi auditada" jq -e 'select(.evento == "nivel.definir" and .dados.origem == "instalador")' "$RAIZ/var/log/dgclaw/auditoria.jsonl"
echo "instalar: reinstalar sem --nivel preserva"
verifica "reinstala sem --nivel" instalar_ok
verifica "nivel continua escritorio" jq -e '.nivel == "escritorio"' "$(ETC_R)/protecoes.json"
verifica "gancho rodou de novo" test "$(contar "$RAIZ/gancho-instalar.txt" 'gancho com nivel escritorio')" = 2
echo "instalar: --nivel pessoal nao rebaixa"
verifica "reinstala com --nivel pessoal" instalar_ok --nivel pessoal
verifica "nivel continua escritorio" jq -e '.nivel == "escritorio"' "$(ETC_R)/protecoes.json"
verifica "avisou como rebaixar" tem "$SAIDA" "dgclaw nivel definir pessoal"
echo "instalar: subir para empresa mantem os ajustes validos"
jq '.ajustes = {"sessao_horas": 24}' "$(ETC_R)/protecoes.json" >"$TMP/p.json" && cp "$TMP/p.json" "$(ETC_R)/protecoes.json" && chmod 600 "$(ETC_R)/protecoes.json"
verifica "reinstala com --nivel empresa" instalar_ok --nivel empresa
verifica "nivel empresa e ajuste mantido" jq -e '.nivel == "empresa" and .ajustes.sessao_horas == 24' "$(ETC_R)/protecoes.json"
limpar_cenario

echo "instalar: --nivel invalido e ensaio"
cenario
verifica "nivel inexistente e recusado" bash -c "! env -i HOME='$TMP' PATH='$AQUI/stubs:/usr/bin:/bin' DGCLAW_RAIZ='$RAIZ' DGCLAW_PULAR_CHECAGENS=1 bash '$FALSO/install.sh' --usuario maria --nivel galactico >'$SAIDA' 2>&1"
verifica "a recusa lista os niveis" tem "$SAIDA" "escritorio, empresa ou regulado"
verifica "ensaio com --nivel nao cria nada" instalar "$PAINEL_PW" --usuario maria --provedor claude --nivel regulado --ensaio
verifica "a raiz continua vazia" vazio "$RAIZ"
verifica "o ensaio diz o que faria" tem "$SAIDA" "gravaria o nivel regulado"
limpar_cenario

printf 'instalar.test.sh: %s verificacoes, %s falharam\n' "$TOTAL" "$FALHAS"
[ "$FALHAS" -eq 0 ]
