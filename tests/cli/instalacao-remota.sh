#!/usr/bin/env bash
# dgclaw instalacao-remota: troca a senha por uma forte, so o hash vai para o disco, reinicia o painel
# e imprime a mensagem de entrega uma vez. Raiz falsa, hash e systemctl de mentira.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

export DGCLAW_SENHA_HASH_CMD="$REPO/tests/instalador/senha-hash-falso.sh"
HASH_VELHO="scrypt\$velho\$velho"

echo "instalacao-remota: caminho feliz"
printf "GROQ_API_KEY=x\nDGCLAW_PANEL_USER=dono\nDGCLAW_PANEL_PASSWORD_HASH='%s'\nOPCAO_QUALQUER=1\n" "$HASH_VELHO" >"$ETC/web.env"
chmod 600 "$ETC/web.env"
printf '{"versao":1}\n' >"$ETC/primeiro-acesso.json"
: >"$STUB_LOG"
dgclaw instalacao-remota >"$TMP/o.out" 2>"$TMP/o.err"
igual "sai com 0" "0" "$?"
afirma "a mensagem traz o endereco, o usuario e o texto de entrega" \
    grep -q '^Seu DG Claw esta pronto\. Acesse https://teste\.exemplo\.org/, entre com o usuario dono e a senha ' "$TMP/o.out"
afirma "a mensagem fala do login do Claude e do tutorial" grep -q 'login do Claude nos seus agentes, um de cada vez.*tutorial rapido' "$TMP/o.out"
SENHA="$(sed -n 's/.* e a senha \([^ ]*\)\. La dentro.*/\1/p' "$TMP/o.out")"
afirma "a senha tem 5 grupos de 4 sem caracteres ambiguos" bash -c "[[ '$SENHA' =~ ^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){4}\$ ]]"
HASH_NOVO="$(grep ^DGCLAW_PANEL_PASSWORD_HASH "$ETC/web.env")"
nega "o hash mudou" test "$HASH_NOVO" = "DGCLAW_PANEL_PASSWORD_HASH='$HASH_VELHO'"
igual "o hash confere com a senha impressa" "DGCLAW_PANEL_PASSWORD_HASH='scrypt\$teste\$$(printf '%s' "$SENHA" | sha256sum | cut -d' ' -f1)'" "$HASH_NOVO"
igual "as outras linhas sobrevivem na ordem" "GROQ_API_KEY|DGCLAW_PANEL_USER|DGCLAW_PANEL_PASSWORD_HASH|OPCAO_QUALQUER" \
    "$(cut -d= -f1 "$ETC/web.env" | paste -sd'|')"
igual "web.env continua 600" "600" "$(stat -c %a "$ETC/web.env")"
nega "o primeiro-acesso.json pendente foi apagado" test -e "$ETC/primeiro-acesso.json"
afirma "dgclaw-web foi reiniciado" grep -q '^systemctl restart dgclaw-web' "$STUB_LOG"
nega "a senha nao aparece em nenhum arquivo da raiz falsa" grep -rqF -- "$SENHA" "$DGCLAW_RAIZ"
nega "a senha nao aparece no log dos programas de mentira" grep -qF -- "$SENHA" "$STUB_LOG"
nega "a senha nao aparece no stderr" grep -qF -- "$SENHA" "$TMP/o.err"

echo "instalacao-remota: rodar de novo gera outra senha"
dgclaw instalacao-remota >"$TMP/o2.out" 2>/dev/null
SENHA2="$(sed -n 's/.* e a senha \([^ ]*\)\. La dentro.*/\1/p' "$TMP/o2.out")"
nega "a segunda senha e diferente" test "$SENHA" = "$SENHA2"

echo "instalacao-remota: ensaio nao muda nada"
ANTES="$(cat "$ETC/web.env")"
dgclaw instalacao-remota --ensaio >"$TMP/e.out" 2>&1
igual "ensaio deixa o web.env igual" "$ANTES" "$(cat "$ETC/web.env")"
nega "ensaio nao imprime senha" grep -q 'e a senha' "$TMP/e.out"

echo "instalacao-remota: sem usuario no web.env"
printf "GROQ_API_KEY=x\nDGCLAW_PANEL_PASSWORD_HASH='%s'\n" "$HASH_VELHO" >"$ETC/web.env"
: >"$STUB_LOG"
dgclaw instalacao-remota >"$TMP/s.out" 2>&1
CODIGO=$?
nega "sai com codigo diferente de 0" test "$CODIGO" = 0
afirma "o erro diz o que fazer" grep -qz 'DGCLAW_PANEL_USER.*install.sh --usuario' "$TMP/s.out"
igual "o hash antigo ficou" "1" "$(grep -c velho "$ETC/web.env")"
nega "nao reiniciou nada" grep -q '^systemctl restart dgclaw-web' "$STUB_LOG"

echo "instalacao-remota: sem web.env"
mv "$ETC/web.env" "$ETC/web.env.guardado"
nega "recusa sem web.env" dgclaw instalacao-remota

fim
