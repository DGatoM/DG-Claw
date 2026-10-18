#!/usr/bin/env bash
# dgclaw atualizar: sucesso, falha com rollback, preservacao do web.env e dos cofres, --sem-rollback e
# as 3 copias. Raiz falsa; os stubs sao os do instalador, com o curl de tests/enterprise/stubs.
# O git e o de verdade, apontando para um repositorio local feito aqui (nada sai da maquina).
set -uo pipefail
AQUI_ENT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tests/instalador/ajuda.sh
. "$AQUI_ENT/../instalador/ajuda.sh"

TOTAL=0
verifica() {
    local desc="$1"; shift
    TOTAL=$((TOTAL + 1))
    if "$@" >/dev/null 2>&1; then printf '  ok     %s\n' "$desc"; else printf '  FALHOU %s\n' "$desc"; FALHAS=$((FALHAS + 1)); fi
}
mesmo() { # mesmo "<descricao>" <esperado> <obtido>
    TOTAL=$((TOTAL + 1))
    if [ "$2" = "$3" ]; then printf '  ok     %s\n' "$1"; else printf '  FALHOU %s (esperado "%s", veio "%s")\n' "$1" "$2" "$3"; FALHAS=$((FALHAS + 1)); fi
}

novo_cenario
export GIT_AUTHOR_NAME=teste GIT_AUTHOR_EMAIL=t@exemplo.org GIT_COMMITTER_NAME=teste GIT_COMMITTER_EMAIL=t@exemplo.org
cp "$REPO/bin/dgclaw" "$FALSO/bin/dgclaw"
cp "$REPO/VERSION" "$FALSO/VERSION"
cp -r "$REPO/config" "$FALSO/config"
echo "1.0.0" >"$FALSO/VERSION"
# O PATH do cenario ganha o curl com defeito sob encomenda na frente, e a espera de saude encurta.
for i in "${!ENV_BASE[@]}"; do
    case "${ENV_BASE[$i]}" in PATH=*) ENV_BASE[i]="PATH=$AQUI_ENT/stubs:${ENV_BASE[$i]#PATH=}" ;; esac
done
ENV_BASE+=("DGCLAW_TEMPO_ESPERA=2" "GIT_AUTHOR_NAME=teste" "GIT_AUTHOR_EMAIL=t@exemplo.org" "GIT_COMMITTER_NAME=teste" "GIT_COMMITTER_EMAIL=t@exemplo.org")
ETC_R="$RAIZ/etc/dgclaw"
APP="$RAIZ/opt/dgclaw/app"
AUD="$RAIZ/var/log/dgclaw/auditoria.jsonl"
SNAPS="$RAIZ/var/lib/dgclaw/atualizacoes"

dgc() { env -i "${ENV_BASE[@]}" bash "$APP/bin/dgclaw" "$@" </dev/null; }

# versao_origem <tag> <o que fazer na pasta antes do commit>: cria o repositorio da versao nova.
ORIGEM="$TMP/origem"
git init -q -b main "$ORIGEM"
cp -r "$FALSO/." "$ORIGEM/"
rm -rf "$ORIGEM/.git" "$ORIGEM/web/node_modules"
git -C "$ORIGEM" init -q -b main
publicar() { # publicar <tag> <versao> [comando-de-ajuste]
    echo "$2" >"$ORIGEM/VERSION"
    if [ -n "${3:-}" ]; then ( cd "$ORIGEM" && eval "$3" ); fi
    git -C "$ORIGEM" add -A >/dev/null
    git -C "$ORIGEM" commit -q -m "versao $2" --allow-empty
    git -C "$ORIGEM" tag "$1"
}

echo "atualizar: instalacao inicial e dados do dono"
verifica "instalacao inicial" instalar "$PAINEL_PW" --usuario maria --provedor claude --nivel empresa
printf 'GROQ_API_KEY=gsk_segredo_de_teste\nOUTRA_COISA=1\n' >>"$ETC_R/web.env"
verifica "reinstala para o web.env ficar na ordem canonica do instalador" instalar "" --usuario maria
mkdir -p "$ETC_R/proxy" "$RAIZ/var/lib/dgclaw/agentes/ana/cofre"
echo "segredo-do-proxy" >"$ETC_R/proxy/ana.segredo"
echo "OPENAI_API_KEY=sk-de-teste" >"$RAIZ/var/lib/dgclaw/agentes/ana/cofre/cofre.env"
SOMA_ANTES="$(cd "$RAIZ" && sha256sum etc/dgclaw/web.env etc/dgclaw/protecoes.json etc/dgclaw/runner/admin.token etc/dgclaw/proxy/ana.segredo var/lib/dgclaw/agentes/ana/cofre/cofre.env)"
mesmo "versao instalada" 1.0.0 "$(jq -r .versao "$ETC_R/versao")"

echo "atualizar: ensaio e entradas ruins"
publicar v1.1.0 1.1.0
dgc --ensaio atualizar --origem "$ORIGEM" --ref v1.1.0 >"$SAIDA" 2>&1
mesmo "ensaio sai com 0" 0 "$?"
verifica "ensaio nao cria copia" test ! -e "$SNAPS"
verifica "ensaio nao mexe na versao" test "$(tr -d '[:space:]' <"$APP/VERSION")" = 1.0.0
dgc atualizar --ref '--evil' >"$SAIDA" 2>&1; mesmo "ref com hifen recusado" 1 "$?"
dgc atualizar --foo >"$SAIDA" 2>&1; mesmo "opcao desconhecida recusada" 1 "$?"
verifica "a recusa diz o que fazer" tem "$SAIDA" "O que fazer"

echo "atualizar: sucesso"
dgc atualizar --origem "$ORIGEM" --ref v1.1.0 >"$SAIDA" 2>&1
mesmo "atualizar sai com 0" 0 "$?"
mesmo "o app passou a ser 1.1.0" 1.1.0 "$(tr -d '[:space:]' <"$APP/VERSION")"
mesmo "o registro de versao e 1.1.0" 1.1.0 "$(jq -r .versao "$ETC_R/versao")"
verifica "o registro de versao tem o commit (a pasta baixada tem git)" jq -e '.commit | test("^[0-9a-f]{7,}")' "$ETC_R/versao"
SOMA_DEPOIS="$(cd "$RAIZ" && sha256sum etc/dgclaw/web.env etc/dgclaw/protecoes.json etc/dgclaw/runner/admin.token etc/dgclaw/proxy/ana.segredo var/lib/dgclaw/agentes/ana/cofre/cofre.env)"
mesmo "web.env, nivel, token, segredo do proxy e cofre ficaram byte a byte iguais" "$SOMA_ANTES" "$SOMA_DEPOIS"
verifica "o web.env ainda tem a chave de voz" tem "$ETC_R/web.env" "GROQ_API_KEY=gsk_segredo_de_teste"
snaps() { local d; for d in "$SNAPS"/[0-9]*; do basename "$d"; done; }
SNAP1="$(snaps | head -1)"
verifica "a copia de seguranca existe com app, etc e unidades" test -s "$SNAPS/$SNAP1/app.tar" -a -s "$SNAPS/$SNAP1/etc.tar" -a -s "$SNAPS/$SNAP1/unidades.tar"
verifica "a pasta das copias e 700" modo_e "$SNAPS" 700
verifica "a copia e 700 e os arquivos 600" bash -c "[ \"\$(stat -c %a '$SNAPS/$SNAP1')\" = 700 ] && [ \"\$(stat -c %a '$SNAPS/$SNAP1/etc.tar')\" = 600 ] && [ \"\$(stat -c %a '$SNAPS/$SNAP1/app.tar')\" = 600 ]"
verifica "a copia do etc tem o web.env de antes (com a chave de voz)" bash -c "tar -xOf '$SNAPS/$SNAP1/etc.tar' etc/dgclaw/web.env | grep -q gsk_segredo_de_teste"
verifica "a copia guarda a versao anterior" jq -e '.versao_anterior == "1.0.0"' "$SNAPS/$SNAP1/info.json"
verifica "nenhuma pasta temporaria sobrou" bash -c "[ -z \"\$(find '$SNAPS' -maxdepth 1 -name '.novo*')\" ]"
verifica "o log da atualizacao existe e e 600" bash -c "f=\$(ls '$RAIZ'/var/log/dgclaw/atualizar-*.log | head -1); [ \"\$(stat -c %a \$f)\" = 600 ]"
verifica "auditoria: inicio e sucesso" bash -c "jq -r .evento '$AUD' | grep -x atualizar.inicio >/dev/null && jq -r .evento '$AUD' | grep -x atualizar.sucesso >/dev/null"
verifica "o Web foi consultado em /api/saude" tem "$STUB_LOG" "127.0.0.1:8300/api/saude"
verifica "a senha nao foi pedida nem aparece em argv" bash -c "! grep -q '$PAINEL_PW' '$STUB_LOG'"

echo "atualizar: a saude falha, volta sozinho"
publicar v1.2.0 1.2.0 "touch QUEBRADO"
dgc atualizar --origem "$ORIGEM" --ref v1.2.0 >"$SAIDA" 2>&1
mesmo "falha: sai com 1" 1 "$?"
verifica "diz a etapa" tem "$SAIDA" 'na etapa "saude"'
verifica "diz que voltou e para qual versao" tem "$SAIDA" "voltei para a versao 1.1.0"
verifica "diz onde esta o log" tem "$SAIDA" "atualizar-"
mesmo "o app voltou para 1.1.0" 1.1.0 "$(tr -d '[:space:]' <"$APP/VERSION")"
verifica "o arquivo QUEBRADO da versao falha nao esta mais no app" test ! -e "$APP/QUEBRADO"
mesmo "o registro de versao voltou" 1.1.0 "$(jq -r .versao "$ETC_R/versao")"
mesmo "web.env e demais segredos iguais depois do rollback" "$SOMA_ANTES" "$(cd "$RAIZ" && sha256sum etc/dgclaw/web.env etc/dgclaw/protecoes.json etc/dgclaw/runner/admin.token etc/dgclaw/proxy/ana.segredo var/lib/dgclaw/agentes/ana/cofre/cofre.env)"
SNAP2="$(snaps | tail -1)"
verifica "o estado que falhou ficou guardado para estudo" test -e "$SNAPS/$SNAP2/app-que-falhou/QUEBRADO" -a -d "$SNAPS/$SNAP2/etc-que-falhou"
verifica "os servicos foram reiniciados" tem "$STUB_LOG" "restart dgclaw-web"
verifica "auditoria: falha e rollback" bash -c "jq -r .evento '$AUD' | tail -n 3 | paste -sd' ' | grep -q 'atualizar.inicio atualizar.falha atualizar.rollback'"
verifica "a trilha continua inteira depois do rollback" node -e '
    const { criarAuditoria } = require(process.argv[1] + "/web/lib/auditoria");
    const r = criarAuditoria({ caminho: process.argv[2] }).verificar(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1)' "$REPO" "$AUD"

echo "atualizar: o instalador novo apaga uma chave do web.env"
publicar v1.3.0 1.3.0 "printf '#!/usr/bin/env bash\nsed -i \"/^GROQ_API_KEY=/d\" \"\$DGCLAW_RAIZ/etc/dgclaw/web.env\"\nexit 0\n' >install.sh; rm -f QUEBRADO"
dgc atualizar --origem "$ORIGEM" --ref v1.3.0 >"$SAIDA" 2>&1
mesmo "sai com 1" 1 "$?"
verifica "diz a etapa e QUAL chave sumiu, sem mostrar o valor" bash -c "grep -q 'etapa \"preservacao\"' '$SAIDA' && grep -q 'web.env:GROQ_API_KEY' '$SAIDA' && ! grep -q gsk_segredo_de_teste '$SAIDA'"
verifica "o web.env voltou com a chave" tem "$ETC_R/web.env" "GROQ_API_KEY=gsk_segredo_de_teste"
mesmo "o app voltou para 1.1.0" 1.1.0 "$(tr -d '[:space:]' <"$APP/VERSION")"

echo "atualizar: o instalador novo quebra"
publicar v1.4.0 1.4.0 "printf '#!/usr/bin/env bash\necho \"vou falhar\"; exit 5\n' >install.sh"
dgc atualizar --origem "$ORIGEM" --ref v1.4.0 >"$SAIDA" 2>&1
mesmo "sai com 1" 1 "$?"
verifica "diz o codigo do instalador" tem "$SAIDA" "terminou com codigo 5"
verifica "voltou" tem "$SAIDA" "voltei para a versao 1.1.0"

echo "atualizar: ref que nao existe"
dgc atualizar --origem "$ORIGEM" --ref v9.9.9 >"$SAIDA" 2>&1
mesmo "sai com 1" 1 "$?"
verifica "diz que o git nao baixou" tem "$SAIDA" 'etapa "download"'
mesmo "nada mudou" 1.1.0 "$(tr -d '[:space:]' <"$APP/VERSION")"

echo "atualizar: --sem-rollback deixa como esta"
publicar v1.5.0 1.5.0 "git show v1.1.0:install.sh >install.sh; touch QUEBRADO"
dgc atualizar --origem "$ORIGEM" --ref v1.5.0 --sem-rollback >"$SAIDA" 2>&1
mesmo "sai com 1" 1 "$?"
verifica "diz que nada foi desfeito e onde esta a copia" bash -c "grep -q 'nada foi desfeito' '$SAIDA' && grep -q 'etc.tar' '$SAIDA'"
mesmo "o app ficou na versao nova (sem rollback)" 1.5.0 "$(tr -d '[:space:]' <"$APP/VERSION")"
verifica "nao registrou rollback" bash -c "! jq -r .evento '$AUD' | tail -n 2 | grep -q atualizar.rollback"

echo "atualizar: guarda so as 3 copias mais novas"
mesmo "tres copias" 3 "$(snaps | wc -l | tr -d ' ')"

limpar_cenario
printf 'atualizar.test.sh: %s verificacoes, %s falharam\n' "$TOTAL" "$FALHAS"
[ "$FALHAS" -eq 0 ]
