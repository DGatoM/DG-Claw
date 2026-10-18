#!/usr/bin/env bash
# dgclaw usuario (listar, criar, desativar, link, zerar-2fa): mexe no mesmo usuarios.json do Web, com trava e auditoria.
# Nenhuma senha real aqui: o hash do web.env e montado na hora so para o teste.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_QUEM=testador
ARQ="$LIB/web/usuarios.json"
LOGA="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
HASH_FALSO="scrypt\$1024\$8\$1\$$(head -c 12 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')\$$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

echo "usuario: nivel pessoal nao tem usuarios"
dgclaw usuario listar >"$TMP/o.txt" 2>&1
igual "pessoal: recusa" 1 "$?"
afirma "explica que o multiusuario esta desligado e como ligar" grep -q "multiusuario esta desligado" "$TMP/o.txt"
afirma "diz o que fazer" grep -q "dgclaw nivel definir escritorio" "$TMP/o.txt"
nega "pessoal: o arquivo nem e criado" test -e "$ARQ"

echo "usuario: escritorio, primeira vez, o usuario do web.env vira o primeiro TI"
nivel_na_raiz escritorio
printf "DGCLAW_PANEL_USER=maria\nDGCLAW_PANEL_PASSWORD_HASH='%s'\n" "$HASH_FALSO" >"$ETC/web.env"
printf '{"versao":1,"agentes":[{"slug":"admin","tipo":"admin"},{"slug":"luna","tipo":"agente"},{"slug":"marina","tipo":"agente"}]}\n' >"$ETC/agentes.json"
dgclaw usuario listar >"$TMP/o.txt" 2>&1
igual "listar sai com 0" 0 "$?"
afirma "maria e TI, ativa, sem 2fa" grep -qE '^maria +ti +ativo +sem 2fa +todos' "$TMP/o.txt"
igual "o arquivo e 600" 600 "$(stat -c %a "$ARQ")"
igual "o hash e o mesmo do web.env" "$HASH_FALSO" "$(jq -r '.usuarios[0].hash' "$ARQ")"
igual "marcado como vindo do web.env" web.env "$(jq -r '.usuarios[0].origem' "$ARQ")"

echo "usuario: criar"
nega "sem nome" dgclaw usuario criar
nega "nome invalido" dgclaw usuario criar "Ana Silva" --papel ti
dgclaw usuario criar ana.silva >"$TMP/o.txt" 2>&1
igual "sem papel: recusa" 1 "$?"
afirma "o erro diz as opcoes" grep -q -- "--papel ti ou --papel funcionario" "$TMP/o.txt"
dgclaw usuario criar ana.silva --papel chefe >"$TMP/o.txt" 2>&1
igual "papel inexistente: recusa" 1 "$?"
dgclaw usuario criar ana.silva --papel funcionario --agentes luna,fantasma >"$TMP/o.txt" 2>&1
igual "agente inexistente: recusa" 1 "$?"
afirma "o erro lista os que existem" grep -q "luna marina" "$TMP/o.txt"
dgclaw usuario criar ana.silva --papel funcionario --agentes admin >"$TMP/o.txt" 2>&1
igual "o Admin nao pode ser liberado" 1 "$?"
afirma "o erro explica" grep -q "O Admin nao pode" "$TMP/o.txt"
dgclaw usuario criar ana.silva --papel >"$TMP/o.txt" 2>&1
igual "opcao sem valor nao trava" 1 "$?"
igual "nada foi criado com os erros" 1 "$(jq '.usuarios | length' "$ARQ")"

dgclaw usuario criar Ana.Silva --papel funcionario --agentes luna --nome "Ana Silva" --email ana@empresa.com >"$TMP/o.txt" 2>"$TMP/e.txt"
igual "criar sai com 0" 0 "$?"
LINK="$(grep -E 'primeiro-acesso#' "$TMP/o.txt")"
afirma "imprime o link de uso unico" bash -c "[[ '$LINK' =~ ^https://teste.exemplo.org/primeiro-acesso#[A-Za-z0-9_-]{43}$ ]]"
afirma "avisa que vale 24 h" grep -q "vale 24 h" "$TMP/e.txt"
TOKEN="${LINK#*#}"
igual "usuario em minusculas" ana.silva "$(jq -r '.usuarios[1].usuario' "$ARQ")"
igual "papel e agentes" "funcionario luna" "$(jq -r '.usuarios[1] | "\(.papel) \(.agentes | join(","))"' "$ARQ")"
igual "sem hash de senha ate usar o link" "" "$(jq -r '.usuarios[1].hash' "$ARQ")"
igual "o disco guarda so o sha256 do token" "$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)" "$(jq -r '.usuarios[1].link.token_sha256' "$ARQ")"
nega "o token nao esta no arquivo" grep -q "$TOKEN" "$ARQ"
nega "o token nao esta na auditoria" grep -q "$TOKEN" "$LOGA"
igual "o link vale 24 h" 86400000 "$(jq '.usuarios[1].link | .expira - .criado' "$ARQ")"
igual "evento na auditoria" usuario_criado "$(jq -r .evento "$LOGA" | tail -1)"
igual "com papel e via cli" "funcionario cli" "$(tail -1 "$LOGA" | jq -r '.dados | "\(.papel) \(.via)"')"
dgclaw usuario criar ANA.SILVA --papel ti >"$TMP/o.txt" 2>&1
igual "duplicado (mesmo com outra caixa): recusa" 1 "$?"
nega "nenhuma trava sobrando" test -e "$ARQ.trava"

echo "usuario: o Node le o que o bash escreveu e o bash le o que o Node escreve"
igual "o Node enxerga os dois" "maria,ana.silva" "$(ARQ_DIR="$LIB/web" node -e '
    const { criarArquivoUsuarios } = require(process.argv[1] + "/web/lib/usuarios-arquivo");
    const a = criarArquivoUsuarios({ dataDir: process.env.ARQ_DIR, log: () => {} });
    console.log(a.lista().map((u) => u.usuario).join(","));' "$REPO")"
ARQ_DIR="$LIB/web" node -e '
    const { criarArquivoUsuarios } = require(process.argv[1] + "/web/lib/usuarios-arquivo");
    const a = criarArquivoUsuarios({ dataDir: process.env.ARQ_DIR, log: () => {} });
    a.atualizar((d) => { d.usuarios.push({ usuario: "do.node", papel: "ti", totp: { ativo: true, segredo: "AAAA" } }); return null; });' "$REPO"
dgclaw usuario listar >"$TMP/o.txt" 2>&1
afirma "o bash lista quem o Node criou, com 2fa" grep -qE '^do.node +ti +ativo +2fa' "$TMP/o.txt"

echo "usuario: desativar"
nega "sem nome" dgclaw usuario desativar
nega "usuario inexistente" dgclaw usuario desativar ninguem
dgclaw usuario desativar do.node >"$TMP/o.txt" 2>&1
igual "desativar TI com outro TI ativo: ok" 0 "$?"
afirma "o arquivo marca a data" jq -e '.usuarios[] | select(.usuario == "do.node") | .desativado_em != null' "$ARQ"
igual "evento usuario_desativado" usuario_desativado "$(jq -r .evento "$LOGA" | tail -1)"
dgclaw usuario desativar do.node >/dev/null 2>&1
igual "desativar de novo e inofensivo" 0 "$?"
dgclaw usuario desativar maria >"$TMP/o.txt" 2>&1
igual "o ultimo TI ativo nao sai" 1 "$?"
afirma "explica e diz o que fazer" grep -q "unico usuario TI ativo" "$TMP/o.txt"
afirma "maria continua ativa" jq -e '.usuarios[] | select(.usuario == "maria") | .desativado_em == null' "$ARQ"

echo "usuario: link e zerar-2fa"
ANTES="$(jq -r '.usuarios[1].link.token_sha256' "$ARQ")"
dgclaw usuario link ana.silva >"$TMP/o.txt" 2>"$TMP/e.txt"
igual "link sai com 0" 0 "$?"
afirma "imprime o link" grep -qE 'primeiro-acesso#[A-Za-z0-9_-]{43}$' "$TMP/o.txt"
nega "o link anterior deixou de valer" test "$ANTES" = "$(jq -r '.usuarios[1].link.token_sha256' "$ARQ")"
igual "evento de link" "usuario_alterado link_de_senha" "$(tail -1 "$LOGA" | jq -r '"\(.evento) \(.dados.acao)"')"
nega "link de usuario desativado" dgclaw usuario link do.node
dgclaw usuario link do.node >"$TMP/o.txt" 2>&1
afirma "explica que esta desativado" grep -q "esta desativado" "$TMP/o.txt"
dgclaw usuario zerar-2fa maria >"$TMP/o.txt" 2>&1
igual "zerar-2fa sai com 0" 0 "$?"
dgclaw usuario zerar-2fa do.node >/dev/null 2>&1
afirma "o 2fa do usuario ficou desligado e sem segredo" jq -e '.usuarios[] | select(.usuario == "do.node") | .totp.ativo == false and .totp.segredo == ""' "$ARQ"
igual "evento 2fa_desativado" "2fa_desativado cli" "$(tail -1 "$LOGA" | jq -r '"\(.evento) \(.dados.via)"')"
nega "zerar usuario inexistente" dgclaw usuario zerar-2fa ninguem

echo "usuario: erros que se explicam"
dgclaw usuario >"$TMP/o.txt" 2>&1
igual "sem subcomando: recusa" 1 "$?"
afirma "lista os subcomandos" grep -q "listar | criar" "$TMP/o.txt"
dgclaw usuario xpto >"$TMP/o.txt" 2>&1
afirma "subcomando inexistente: diz qual" grep -q "usuario xpto" "$TMP/o.txt"
cp "$ARQ" "$TMP/bom.json"
printf '{quebrado' >"$ARQ"
dgclaw usuario listar >"$TMP/o.txt" 2>&1
igual "arquivo quebrado: recusa" 1 "$?"
afirma "pede para restaurar e nao apagar" grep -q "nao apague sem copia" "$TMP/o.txt"
igual "o arquivo quebrado nao foi tocado" '{quebrado' "$(cat "$ARQ")"
cp "$TMP/bom.json" "$ARQ"

echo "usuario: trava"
mkdir "$ARQ.trava"
touch -d '2 minutes ago' "$ARQ.trava"
dgclaw usuario desativar do.node >"$TMP/o.txt" 2>&1
igual "trava velha nao impede" 0 "$?"
afirma "avisa que removeu a trava velha" grep -q "provavelmente morreu" "$TMP/o.txt"
nega "a trava velha saiu" test -e "$ARQ.trava"

echo "usuario: ensaio nao grava"
rm -f "$ARQ"
dgclaw --ensaio usuario criar bia --papel ti >"$TMP/o.txt" 2>&1
nega "o ensaio nao cria o arquivo" test -e "$ARQ"
fim
