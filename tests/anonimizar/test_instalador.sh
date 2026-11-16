#!/usr/bin/env bash
# Testa lib/anonimizar-instalar.sh: ensaio, argumentos invalidos, falhas que gravam o estado.json e espaco insuficiente.
# shellcheck disable=SC2015  # o padrao "teste && ok || ruim" e proposital: ok e ruim nunca falham
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$AQUI/../../lib/anonimizar-instalar.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RUINS=0

ok()  { echo "  ok     $1"; }
ruim() { echo "  FALHOU $1"; RUINS=1; }

# 1. ensaio: imprime o plano e nao cria nada
BASE="$TMP/base1"
saida="$(DGCLAW_ANON_BASE="$BASE" bash "$SCRIPT" --ensaio completo 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "ensaio completo sai com 0" || ruim "ensaio completo saiu com $rc"
case "$saida" in
    *"fastino/gliner2-privacy-filter-PII-multi"*"1cb4166094dc58fa8d836429f060d6c95f62b495"*) ok "ensaio cita o modelo e a revisão fixa" ;;
    *) ruim "ensaio não cita o modelo e a revisão: $saida" ;;
esac
case "$saida" in *"https://download.pytorch.org/whl/cpu"*) ok "ensaio usa o índice CPU do torch" ;; *) ruim "ensaio sem índice CPU" ;; esac
[ ! -e "$BASE" ] && ok "ensaio não criou a pasta base" || ruim "ensaio criou $BASE"
saida="$(DGCLAW_ANON_BASE="$BASE" bash "$SCRIPT" leitores --ensaio 2>&1)"
case "$saida" in *torch*) ruim "ensaio de leitores fala em torch" ;; *) ok "ensaio de leitores não instala torch" ;; esac

# 1b. a escolha dos requisitos e do torch pela versao do Python
for par in "3.10:requisitos-completo-py310.txt:torch==2.14.1" "3.11:requisitos-completo-py311.txt:torch==2.15.0" \
           "3.12:requisitos-completo.txt:torch==2.15.0" "3.14:requisitos-completo.txt:torch==2.15.0"; do
    v="${par%%:*}"; resto="${par#*:}"; arq="${resto%%:*}"; tv="${resto#*:}"
    saida="$(DGCLAW_ANON_PYVER="$v" DGCLAW_ANON_BASE="$TMP/base1" bash "$SCRIPT" --ensaio completo 2>&1)"
    case "$saida" in
        *"Python $v: usaria anonimizar/$arq e $tv"*) ok "Python $v usa $arq com $tv" ;;
        *) ruim "Python $v não escolheu $arq/$tv: $saida" ;;
    esac
    [ -f "$AQUI/../../anonimizar/$arq" ] && ok "$arq existe" || ruim "$arq não existe"
done
saida="$(DGCLAW_ANON_PYVER=3.9 DGCLAW_ANON_BASE="$TMP/base1" bash "$SCRIPT" --ensaio completo 2>&1)"
case "$saida" in *"fora de 3.10 a 3.14"*) ok "ensaio com Python 3.9 avisa que o completo falharia" ;; *) ruim "ensaio 3.9: $saida" ;; esac
saida="$(DGCLAW_ANON_PYVER=3.9 DGCLAW_ANON_BASE="$TMP/base1" bash "$SCRIPT" --ensaio leitores 2>&1)"
case "$saida" in *"fora de 3.10"*) ruim "leitores não deveria depender do Python 3.10 a 3.14" ;; *) ok "leitores não depende da faixa de Python" ;; esac

# 1c. Python fora da faixa no nivel completo: falha clara, estado.json com o erro, nada instalado
BASE="$TMP/base1c"
saida="$(DGCLAW_ANON_PYVER=3.9 DGCLAW_ANON_BASE="$BASE" bash "$SCRIPT" completo 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "completo com Python 3.9 sai com 1" || ruim "completo com Python 3.9 saiu com $rc"
case "$saida" in *"Python 3.9"*"leitores continua"*) ok "mensagem cita o Python e o nível leitores" ;; *) ruim "mensagem: $saida" ;; esac
[ ! -d "$BASE/venv" ] && ok "não criou o venv" || ruim "criou o venv mesmo com Python errado"

# 2. argumentos invalidos
DGCLAW_ANON_BASE="$TMP/base2" bash "$SCRIPT" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "sem nível sai com 2" || ruim "sem nível saiu com $rc"
DGCLAW_ANON_BASE="$TMP/base2" bash "$SCRIPT" ultra >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "nível desconhecido sai com 2" || ruim "nível desconhecido saiu com $rc"

# 3. falta de espaco: falha dizendo quanto, e grava o estado com o erro
BASE="$TMP/base3"
saida="$(DGCLAW_ANON_BASE="$BASE" DGCLAW_ANON_ESPACO_EXIGIDO_MB=999999999 bash "$SCRIPT" leitores 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "sem espaço sai com 1" || ruim "sem espaço saiu com $rc"
case "$saida" in *"MB livres"*"precisa de 999999999 MB"*) ok "mensagem diz quanto há e quanto precisa" ;; *) ruim "mensagem sem os números: $saida" ;; esac
if python3 -I - "$BASE/estado.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
assert e["erro"] and "MB" in e["erro"], e
assert e["nivel"] is None and e["nivel_pedido"] == "leitores", e
PY
then ok "estado.json guarda o erro (e nenhum nível instalado)"; else ruim "estado.json do erro está errado"; fi
[ "$(find "$BASE" -mindepth 1 ! -name estado.json | wc -l)" = 0 ] && ok "só o estado.json foi criado" || ruim "sobrou lixo em $BASE"

# 4. falha do venv: o python3 falso recusa `-m venv` e repassa o resto ao de verdade
BASE="$TMP/base4"
mkdir -p "$TMP/bin"
REAL="$(command -v python3)"
cat > "$TMP/bin/python3" <<FIM
#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then echo "venv de mentira falhou" >&2; exit 1; fi
exec "$REAL" "\$@"
FIM
chmod +x "$TMP/bin/python3"
saida="$(PATH="$TMP/bin:$PATH" DGCLAW_ANON_BASE="$BASE" bash "$SCRIPT" leitores 2>&1)"; rc=$?
[ "$rc" != 0 ] && ok "falha do venv derruba a instalação" || ruim "falha do venv saiu com 0"
if python3 -I - "$BASE/estado.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
assert e["erro"] and "criando o ambiente Python" in e["erro"], e
PY
then ok "estado.json diz em que passo parou"; else ruim "estado.json sem o passo (saída: $saida)"; fi

# 5. um estado bom anterior sobrevive a uma tentativa que falha
BASE="$TMP/base5"
mkdir -p "$BASE"
printf '{"nivel":"leitores","versao_modelo":null,"instalado_em":"2026-01-01T00:00:00Z","erro":null}\n' > "$BASE/estado.json"
DGCLAW_ANON_BASE="$BASE" DGCLAW_ANON_ESPACO_EXIGIDO_MB=999999999 bash "$SCRIPT" completo >/dev/null 2>&1
if python3 -I - "$BASE/estado.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
assert e["nivel"] == "leitores" and e["instalado_em"] == "2026-01-01T00:00:00Z" and e["erro"], e
assert e["nivel_pedido"] == "completo", e
PY
then ok "falha preserva o nível e a data já instalados"; else ruim "falha apagou o estado anterior"; fi

[ "$RUINS" = 0 ] && echo "Instalador do motor de anonimização: tudo certo." || echo "Instalador do motor de anonimização: houve falhas."
exit "$RUINS"
