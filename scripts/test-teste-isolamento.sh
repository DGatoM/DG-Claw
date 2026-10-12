#!/bin/bash
# test-teste-isolamento.sh: valida scripts/teste-isolamento.sh SEM podman real.
#
# Um `podman` falso no PATH simula ps, port, inspect, image, network, run, rm e
# exec (o exec responde a bateria de dentro a partir de variaveis FAKE_*). Um
# DGCLAW_ETC temporario traz o registro.tsv. Nada toca container nem rede de verdade.
#
# Uso: bash scripts/test-teste-isolamento.sh

# shellcheck disable=SC2015  # A && ok || falhou e o padrao destes testes
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$AQUI/teste-isolamento.sh"
FALHAS=0
ok()     { echo "✅ $1"; }
falhou() { echo "❌ $1" >&2; FALHAS=$((FALHAS + 1)); }

RAIZ="$(mktemp -d /tmp/dgclaw-iso-XXXXXX)"
trap 'rm -rf "$RAIZ"' EXIT
mkdir -p "$RAIZ/bin" "$RAIZ/etc"
export FAKE_LOG="$RAIZ/podman.log"
export FAKE_ESTADO="$RAIZ/estado"
mkdir -p "$FAKE_ESTADO"

# ── o podman de mentira ─────────────────────────────────────────────────────
cat > "$RAIZ/bin/podman" <<'EOF'
#!/bin/bash
echo "podman $*" >> "$FAKE_LOG"
cmd="$1"; shift
case "$cmd" in
  ps) printf '%s\n' $FAKE_RODANDO ;;
  port)
    case "$1" in
      dgclaw-ana) printf '4300/tcp -> 127.0.0.1:4311\n8300/tcp -> 127.0.0.1:8311\n' ;;
      dgclaw-bia) printf '4300/tcp -> 127.0.0.1:4312\n8300/tcp -> 127.0.0.1:8312\n' ;;
      *) exit 125 ;;
    esac ;;
  inspect)
    # pedido do ambiente (Config.Env): so devolve proxy quando o caso pede
    if [[ "$*" == *Config.Env* ]]; then
      [ -n "${FAKE_PROXY:-}" ] && printf 'PATH=/usr/bin\nHTTPS_PROXY=%s\nhttps_proxy=%s\n' "$FAKE_PROXY" "$FAKE_PROXY"
      exit 0
    fi
    case "${*: -1}" in
      dgclaw-ana) echo 10.89.1.2 ;; dgclaw-bia) echo 10.89.2.2 ;; dgclaw-sonda) echo 10.89.254.2 ;;
    esac ;;
  image) [ "$1" = exists ] && [ "${FAKE_SEM_IMAGEM:-0}" != 1 ] ;;
  network)
    case "$1" in
      exists) [ -e "$FAKE_ESTADO/rede-$2" ] ;;
      create) touch "$FAKE_ESTADO/rede-${@: -1}" ;;
      rm) rm -f "$FAKE_ESTADO/rede-${@: -1}" ;;
    esac ;;
  run) [ "${FAKE_RUN_FALHA:-0}" != 1 ] ;;
  rm) exit 0 ;;
  exec)
    # acha o modo: o argumento logo depois de "interno"
    modo=""; args=(); achou=0
    for a in "$@"; do
      if [ "$achou" = 1 ] && [ -z "$modo" ]; then modo="$a"; continue; fi
      [ "$achou" = 1 ] && args+=("$a")
      [ "$a" = interno ] && achou=1
    done
    case "$modo" in
      gw) echo "${FAKE_GW:-10.89.1.1}" ;;
      net) echo "${FAKE_NET:-ok}" ;;
      tcp)
        for t in "${args[@]}"; do
          id=${t%%|*}; r=${t#*|}; chave="${r%%|*}:${r#*|}"
          estado=timeout
          case ",$FAKE_ABERTOS," in *",$chave,"*) estado=aberto ;; esac
          case ",$FAKE_RECUSADOS," in *",$chave,"*) estado=recusado ;; esac
          # artefato da execucao paralela: so aparece quando ha mais de um alvo no lote
          if [ "${#args[@]}" -gt 1 ]; then
            case ",${FAKE_FALSO_RST:-}," in *",$chave,"*) estado=recusado ;; esac
          fi
          printf '%s\t%s\n' "$id" "$estado"
        done ;;
    esac ;;
esac
EOF
chmod +x "$RAIZ/bin/podman"

printf 'ana\t1000000\t1\nbia\t1065536\t2\n' > "$RAIZ/etc/registro.tsv"
echo 'DGCLAW_IMAGEM=localhost/dgclaw-agente:teste' > "$RAIZ/etc/dgclaw.env"

# rodar <variaveis...> -- <args>: devolve a saida em $SAIDA e o codigo em $RC.
rodar() {
  : > "$FAKE_LOG"; rm -f "$FAKE_ESTADO"/rede-*
  SAIDA="$(env PATH="$RAIZ/bin:$PATH" DGCLAW_ETC="$RAIZ/etc" DGCLAW_TESTE_SEM_ROOT=1 \
    DGCLAW_IP_HOST=203.0.113.9 FAKE_RODANDO="" FAKE_ABERTOS="" FAKE_RECUSADOS="" \
    "$@" 2>&1)"
  RC=$?
}
tem()  { grep -qF -- "$2" <<<"$SAIDA" && ok "$1" || { falhou "$1 (faltou: $2)"; echo "$SAIDA" | head -30 >&2; }; }
nao()  { grep -qF -- "$2" <<<"$SAIDA" && { falhou "$1 (apareceu: $2)"; } || ok "$1"; }
cod()  { [ "$RC" = "$2" ] && ok "$1" || { falhou "$1 (saiu $RC, esperado $2)"; echo "$SAIDA" | tail -15 >&2; }; }

# (a) tudo bloqueado + internet ok
rodar FAKE_RODANDO="dgclaw-ana" bash "$SCRIPT" ana
cod "(a) tudo bloqueado e internet ok sai 0" 0
tem "(a) resumo diz ISOLADO" "RESULTADO: ISOLADO"
tem "(a) gateway testado na porta calculada do outro agente" "gateway 10.89.1.1:4312"
tem "(a) IP do host testado" "IP do host 203.0.113.9:8300"
nao "(a) sem FURO" "FURO"

# (a2) sem slug, com agentes rodando: testa os dois, inclusive o alvo "outro agente"
rodar FAKE_RODANDO="dgclaw-ana dgclaw-bia" bash "$SCRIPT"
cod "(a2) varredura de todos sai 0" 0
tem "(a2) testou outro agente a partir da ana" "agente bia em 10.89.2.2:4300"
tem "(a2) testou a bia" "== bia (container dgclaw-bia)"

# (b) um alvo respondendo
rodar FAKE_RODANDO="dgclaw-ana" FAKE_ABERTOS="10.89.1.1:4300" bash "$SCRIPT" ana
cod "(b) alvo aberto sai 1" 1
tem "(b) linha FURO aparece" "FURO  gateway 10.89.1.1:4300 respondeu"
# recusa no gateway tambem e furo
rodar FAKE_RODANDO="dgclaw-ana" FAKE_RECUSADOS="203.0.113.9:22" bash "$SCRIPT" ana
cod "(b2) RST no host sai 1" 1
tem "(b2) explica o RST" "RST"
# recusa em rede privada externa e so aviso
rodar FAKE_RODANDO="dgclaw-ana" FAKE_RECUSADOS="10.0.0.1:80" bash "$SCRIPT" ana
cod "(b3) RST em rede privada externa nao reprova" 0
tem "(b3) vira AVISO" "AVISO: devolveu recusa"
# aberto em metadados e furo
rodar FAKE_RODANDO="dgclaw-ana" FAKE_ABERTOS="169.254.169.254:80" bash "$SCRIPT" ana
cod "(b4) metadados abertos sai 1" 1
# aberto em container de outro agente
rodar FAKE_RODANDO="dgclaw-ana dgclaw-bia" FAKE_ABERTOS="10.89.2.2:8300" bash "$SCRIPT" ana
cod "(b5) outro agente alcancavel sai 1" 1

# (b6) falso RST so na bateria paralela: confirmado sozinho, nao pode virar furo
rodar DGCLAW_VERBOSO=1 FAKE_RODANDO="dgclaw-ana" FAKE_FALSO_RST="10.89.1.1:4312,10.89.1.1:8312" bash "$SCRIPT" ana
cod "(b6) RST so em paralelo nao vira furo, sai 0" 0
tem "(b6) explica a nota" "vale o isolado"
nao "(b6) sem FURO" "FURO"
# e RST que persiste sozinho continua sendo furo (FAKE_RECUSADOS vale em qualquer lote)
rodar FAKE_RODANDO="dgclaw-ana" FAKE_RECUSADOS="10.89.1.1:4312" bash "$SCRIPT" ana
cod "(b7) RST que persiste sozinho sai 1" 1

# (b8) proxy herdado no ambiente do container: avisa, mas nao reprova (o teste mede a rede)
rodar FAKE_RODANDO="dgclaw-ana" FAKE_PROXY="http://127.0.0.1:4002" bash "$SCRIPT" ana
cod "(b8) proxy herdado nao reprova" 0
tem "(b8) avisa do proxy herdado" "AVISO: o ambiente de dgclaw-ana traz HTTPS_PROXY https_proxy"
tem "(b8) diz como corrigir" "--http-proxy=false"
nao "(b8) nao imprime o valor do proxy" "127.0.0.1:4002"
rodar FAKE_RODANDO="dgclaw-ana" bash "$SCRIPT" ana
nao "(b8) sem proxy, sem aviso" "traz HTTPS_PROXY"

# (c) internet fora
rodar FAKE_RODANDO="dgclaw-ana" FAKE_NET=falhou bash "$SCRIPT" ana
cod "(c) internet fora sai 2" 2
tem "(c) diz INCONCLUSIVO" "INCONCLUSIVO"
nao "(c) nao declara ISOLADO" "RESULTADO: ISOLADO"
# furo vence a internet fora
rodar FAKE_RODANDO="dgclaw-ana" FAKE_NET=falhou FAKE_ABERTOS="10.89.1.1:22" bash "$SCRIPT" ana
cod "(c2) furo com internet fora ainda sai 1" 1

# (d) --help
rodar bash "$SCRIPT" --help
cod "(d) --help sai 0" 0
tem "(d) mostra o uso" "Uso: bash scripts/teste-isolamento.sh"

# (e) slug inexistente e container parado
rodar bash "$SCRIPT" fantasma
cod "(e) slug inexistente sai 2" 2
tem "(e) mensagem clara" "o slug 'fantasma' nao esta em"
tem "(e) diz o que fazer" "O que fazer"
rodar FAKE_RODANDO="dgclaw-ana" bash "$SCRIPT" bia
cod "(e2) container parado sai 2" 2
tem "(e2) mensagem clara" "dgclaw-bia nao esta rodando"

# (f) sonda: sem agentes rodando, cria e remove a rede, mesmo com falha
rodar bash "$SCRIPT"
cod "(f) sonda limpa sai 0" 0
grep -qF "network create --disable-dns --subnet 10.89.254.0/24 dgclaw-sonda" "$FAKE_LOG" && ok "(f) criou a rede da sonda" || falhou "(f) nao criou a rede da sonda"
grep -qF -- "--entrypoint sleep localhost/dgclaw-agente:teste" "$FAKE_LOG" && ok "(f) subiu com entrypoint" || falhou "(f) sem entrypoint"
grep -qF "network rm -f dgclaw-sonda" "$FAKE_LOG" && ok "(f) removeu a rede" || falhou "(f) nao removeu a rede"
[ ! -e "$FAKE_ESTADO/rede-dgclaw-sonda" ] && ok "(f) rede nao sobrou" || falhou "(f) rede sobrou"
rodar FAKE_GW=10.89.254.1 FAKE_ABERTOS="10.89.254.1:4300" bash "$SCRIPT"
cod "(f2) sonda com furo sai 1" 1
grep -qF "network rm -f dgclaw-sonda" "$FAKE_LOG" && ok "(f2) rede removida mesmo com furo" || falhou "(f2) rede nao removida"
rodar FAKE_RUN_FALHA=1 bash "$SCRIPT"
cod "(f3) sonda que nao sobe sai 2" 2
grep -qF "network rm -f dgclaw-sonda" "$FAKE_LOG" && ok "(f3) rede removida mesmo com erro" || falhou "(f3) rede nao removida"
rodar FAKE_SEM_IMAGEM=1 bash "$SCRIPT"
cod "(f4) sem imagem sai 2" 2
tem "(f4) mensagem clara" "a imagem 'localhost/dgclaw-agente:teste' nao existe"
# rede sobrando de execucao anterior e recriada
: > "$FAKE_LOG"; touch "$FAKE_ESTADO/rede-dgclaw-sonda"
SAIDA="$(env PATH="$RAIZ/bin:$PATH" DGCLAW_ETC="$RAIZ/etc" DGCLAW_TESTE_SEM_ROOT=1 DGCLAW_IP_HOST=203.0.113.9 \
  FAKE_RODANDO="" FAKE_ABERTOS="" FAKE_RECUSADOS="" bash "$SCRIPT" 2>&1)"; RC=$?
cod "(f5) rede velha da sonda e refeita, sai 0" 0

# texto sem travessao e sintaxe
if grep -nP '\x{2014}|\x{2013}' "$SCRIPT" >/dev/null 2>&1; then falhou "script tem travessao"; else ok "sem travessao no script"; fi
bash -n "$SCRIPT" && ok "bash -n" || falhou "bash -n"

echo
[ "$FALHAS" = 0 ] && { echo "TUDO OK"; exit 0; } || { echo "$FALHAS falha(s)" >&2; exit 1; }
