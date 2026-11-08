#!/usr/bin/env bash
# scripts/_lib/anexo-seguro.sh: o doctor --fix acrescenta secoes no AGENTS.md/CLAUDE.md/MEMORY.md sem
# seguir link simbolico (o arquivo fica na casa do agente e o doctor roda como root no host).
# Uso: bash tests/anexo-seguro/rodar.sh
# shellcheck disable=SC2015,SC2016
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO/scripts/_lib/anexo-seguro.sh"
ruins=0
ok()  { printf '  ok     %s\n' "$1"; }
mal() { printf '  FALHOU %s\n' "$1"; ruins=$((ruins + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WS="$TMP/ws"; FORA="$TMP/fora"
mkdir -p "$WS" "$FORA"
DONO="$(id -un)"
SECAO=$'## Mesa de tarefas\nTexto novo da mesa.'

echo "anexo-seguro: arquivo comum"
printf '# Instrucoes\nlinha do dono\n' > "$WS/AGENTS.md"; chmod 640 "$WS/AGENTS.md"
if anexar_secao_segura "$WS/AGENTS.md" "$WS" "$SECAO" "$WS/AGENTS.md.bak-t" "$DONO"; then ok "acrescentou"; else mal "recusou arquivo comum: $ANEXO_MOTIVO"; fi
grep -q 'Texto novo da mesa' "$WS/AGENTS.md" && head -2 "$WS/AGENTS.md" | grep -q 'linha do dono' && ok "o texto do dono ficou e a secao entrou no fim" || mal "conteudo do AGENTS.md"
[ "$(stat -c %a "$WS/AGENTS.md")" = "640" ] && ok "o modo do arquivo foi mantido" || mal "modo mudou: $(stat -c %a "$WS/AGENTS.md")"
[ "$(cat "$WS/AGENTS.md.bak-t")" = $'# Instrucoes\nlinha do dono' ] && ok "o backup tem o conteudo de antes" || mal "backup errado"
[ -z "$(find "$WS" -maxdepth 1 \( -name '.anexo.*' -o -name '.bak.*' \))" ] && ok "nenhum temporario sobrou" || mal "sobrou temporario: $(ls -A "$WS")"
anexar_secao_segura "$WS/AGENTS.md" "$WS" $'## Outra\nx' "$WS/AGENTS.md.bak-t" "$DONO" && [ "$(head -1 "$WS/AGENTS.md.bak-t")" = "# Instrucoes" ] && ok "backup que ja existe nao e sobrescrito" || mal "backup sobrescrito ou falha"

echo "anexo-seguro: AGENTS.md vira link para fora do workspace"
rm -f "$WS/AGENTS.md" "$WS"/AGENTS.md.bak-*
printf 'PermitRootLogin no\n' > "$FORA/sshd_config"; chmod 600 "$FORA/sshd_config"
ln -s "$FORA/sshd_config" "$WS/AGENTS.md"
ANTES="$(sha256sum "$FORA/sshd_config")"; DONO_ANTES="$(stat -c '%U:%G %a %i' "$FORA/sshd_config")"
anexar_secao_segura "$WS/AGENTS.md" "$WS" "$SECAO" "$WS/AGENTS.md.bak-t" "$DONO"; rc=$?
[ "$rc" = "1" ] && ok "recusou (codigo 1)" || mal "codigo $rc"
[ "$(sha256sum "$FORA/sshd_config")" = "$ANTES" ] && ok "o alvo ficou igual, byte a byte" || mal "o alvo mudou"
[ "$(stat -c '%U:%G %a %i' "$FORA/sshd_config")" = "$DONO_ANTES" ] && ok "dono, modo e inode do alvo nao mudaram" || mal "dono/modo do alvo mudou"
[ -L "$WS/AGENTS.md" ] && ok "o link ficou como estava (o doctor nao apaga nada)" || mal "o link sumiu"
case "$ANEXO_MOTIVO" in *"link simbolico"*"Apague o link"*) ok "o motivo diz o que fazer, em portugues" ;; *) mal "motivo: $ANEXO_MOTIVO" ;; esac
[ ! -e "$WS/AGENTS.md.bak-t" ] && ok "nenhum backup criado" || mal "criou backup a partir do link"

echo "anexo-seguro: backup pre-plantado como link"
rm -f "$WS/AGENTS.md"; printf 'x\n' > "$WS/AGENTS.md"
printf 'conteudo de sistema\n' > "$FORA/alvo-bak"
ln -s "$FORA/alvo-bak" "$WS/AGENTS.md.bak-t"
ANTES_BAK="$(sha256sum "$FORA/alvo-bak")"
anexar_secao_segura "$WS/AGENTS.md" "$WS" "$SECAO" "$WS/AGENTS.md.bak-t" "$DONO"; rc=$?
[ "$rc" = "1" ] && ok "recusou (codigo 1)" || mal "codigo $rc"
[ "$(sha256sum "$FORA/alvo-bak")" = "$ANTES_BAK" ] && ok "o alvo do backup ficou intacto" || mal "escreveu pelo link do backup"
[ "$(cat "$WS/AGENTS.md")" = "x" ] && ok "o AGENTS.md nao foi alterado" || mal "AGENTS.md alterado"
case "$ANEXO_MOTIVO" in *backup*link*) ok "o motivo cita o backup" ;; *) mal "motivo: $ANEXO_MOTIVO" ;; esac
rm -f "$WS/AGENTS.md.bak-t"

echo "anexo-seguro: pasta do caminho e link, ou arquivo fora do workspace"
mkdir -p "$FORA/casa"; printf 'y\n' > "$FORA/casa/AGENTS.md"
ln -s "$FORA/casa" "$TMP/ws-link"
anexar_secao_segura "$TMP/ws-link/AGENTS.md" "$WS" "$SECAO" "$TMP/b" "$DONO"; rc=$?
[ "$rc" = "1" ] && [ "$(cat "$FORA/casa/AGENTS.md")" = "y" ] && ok "arquivo cujo caminho real fica fora do workspace e recusado" || mal "nao recusou (codigo $rc)"

echo "anexo-seguro: o rename nao segue link no destino"
printf 'a\n' > "$TMP/tmp1"; ln -s "$FORA/sshd_config" "$TMP/dest"
ANTES="$(sha256sum "$FORA/sshd_config")"
mv -T -- "$TMP/tmp1" "$TMP/dest"
[ "$(sha256sum "$FORA/sshd_config")" = "$ANTES" ] && [ ! -L "$TMP/dest" ] && ok "mv -T trocou o nome e deixou o alvo do link em paz" || mal "mv -T seguiu o link"

echo "anexo-seguro: o doctor usa a funcao e nao escreve direto"
if grep -nE '>> *"\$WS/(AGENTS|CLAUDE|MEMORY)\.md"' "$REPO/scripts/doctor.sh" >/dev/null; then mal "doctor.sh ainda faz >> direto num arquivo de instrucoes"; else ok "nenhum >> direto em AGENTS.md, CLAUDE.md ou MEMORY.md"; fi
[ "$(grep -c 'anexar_secao_segura' "$REPO/scripts/doctor.sh")" -ge 4 ] && ok "as 4 secoes (mesa, avisos, AGENTS, MEMORY) passam pela funcao" || mal "faltam usos da funcao"

echo
if [ "$ruins" -eq 0 ]; then echo "anexo-seguro: tudo certo"; exit 0; fi
echo "anexo-seguro: $ruins falha(s)"; exit 1
