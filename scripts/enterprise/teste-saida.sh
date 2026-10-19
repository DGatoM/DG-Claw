#!/usr/bin/env bash
# shellcheck disable=SC2016 # de proposito: os textos entre aspas simples rodam em OUTRO bash, dentro do container
# teste-saida.sh: PROVA, de dentro do container, que a saida controlada (protecao `saida`) esta valendo.
#
# Uso:  bash scripts/enterprise/teste-saida.sh <slug> [<modo> [<provedor>]]
#       modo: registro | bloqueio (padrao: o que a matriz manda; sem ele o script le o nivel instalado)
#
# Roda depois do scripts/teste-isolamento.sh (que ja prova que o host e os vizinhos nao respondem); o dgclaw agente
# criar chama os dois, e o agente PARA se qualquer um falhar. Aqui:
#   registro   o proxy do DG Claw responde a um destino permitido.
#   bloqueio   (1) destino permitido passa pelo proxy; (2) destino fora da lista e recusado pelo proprio proxy (403 no
#              CONNECT, nao timeout); (3) saida direta, sem proxy, para a internet NAO conecta; (4) no gateway so a porta
#              do proxy responde (a 22 do host continua fechada).
# Saida: 0 tudo certo | 1 algum furo | 2 inconclusivo ou erro de ambiente (o proxy nao respondeu: sem ele nada se prova).
#
# Variaveis: DGCLAW_ETC (padrao /etc/dgclaw), DGCLAW_TESTE_SEM_ROOT=1 (so para teste automatizado com podman falso).

set -euo pipefail

ETC="${DGCLAW_ETC:-/etc/dgclaw}"
PORTA_PROXY=3128
FORA="dgclaw-teste-fora-da-lista.example.com"
TENTATIVAS="${DGCLAW_SAIDA_TENTATIVAS:-6}"
FUROS=0

erro_ambiente() {
  echo "ERRO: $1" >&2
  echo "      O que fazer: $2" >&2
  exit 2
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  [ "$#" -ge 1 ] && exit 0
  exit 2
fi

SLUG="$1"
MODO="${2:-}"
PROV="${3:-claude}"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || erro_ambiente "o nome de agente '$SLUG' nao e valido" "use o nome curto, como em dgclaw agente listar"
case "$MODO" in
  registro|bloqueio) ;;
  "") erro_ambiente "faltou o modo (registro ou bloqueio)" "use: bash scripts/enterprise/teste-saida.sh $SLUG bloqueio" ;;
  *) erro_ambiente "o modo '$MODO' nao e testavel aqui" "use registro ou bloqueio (a saida livre nao tem o que provar)" ;;
esac
case "$PROV" in
  codex) PERMITIDO="api.openai.com" ;;
  *) PERMITIDO="api.anthropic.com" ;;
esac

command -v podman >/dev/null 2>&1 || erro_ambiente "o comando podman nao foi encontrado" "rode este teste no host onde os agentes vivem"
if [ "${DGCLAW_TESTE_SEM_ROOT:-0}" != 1 ] && [ "$(id -u)" != 0 ]; then
  erro_ambiente "este teste precisa rodar como root (uid atual $(id -u))" "rode com sudo"
fi
CTR="dgclaw-$SLUG"
podman ps --format '{{.Names}}' | grep -qx "$CTR" || erro_ambiente "o container $CTR nao esta rodando" "suba o agente (dgclaw agente iniciar $SLUG) e rode de novo"

N="$(awk -F'\t' -v s="$SLUG" '$1 == s {print $3; exit}' "$ETC/registro.tsv" 2>/dev/null || true)"
[[ "${N:-}" =~ ^[0-9]+$ ]] || erro_ambiente "nao achei o numero de rede do agente $SLUG em $ETC/registro.tsv" "confira com: cat $ETC/registro.tsv"
GW="10.89.$N.1"
PROXY="http://$GW:$PORTA_PROXY"

dentro() { podman exec -u agente "$CTR" bash -c "$@"; }

echo
echo "== saida controlada de $SLUG (modo $MODO, proxy $PROXY) =="

# 1. Destino permitido passa pelo proxy. O proxy pode levar alguns segundos para escutar na rede nova: tenta de novo.
codigo=000
for ((i = 1; i <= TENTATIVAS; i++)); do
  codigo="$(dentro 'curl -x "$0" -s -o /dev/null -m 10 --connect-timeout 5 -w "%{http_code}" "https://$1" 2>/dev/null || true' "$PROXY" "$PERMITIDO")" || codigo=000
  [ -n "$codigo" ] && [ "$codigo" != 000 ] && break
  sleep 3
done
if [ -z "$codigo" ] || [ "$codigo" = 000 ]; then
  echo "??  INCONCLUSIVO  https://$PERMITIDO nao respondeu pelo proxy $PROXY depois de $TENTATIVAS tentativa(s)."
  echo "RESULTADO: INCONCLUSIVO. Veja o servico: systemctl status dgclaw-saida; journalctl -u dgclaw-saida -n 30; e a lista: dgclaw saida mostrar $SLUG"
  exit 2
fi
echo "ok  permitido  https://$PERMITIDO passou pelo proxy (HTTP $codigo)"

if [ "$MODO" = bloqueio ]; then
  # 2. Fora da lista: o proxy responde 403 ao CONNECT. Timeout aqui seria a cerca, nao o proxy, e esconderia um proxy quebrado.
  conn="$(dentro 'curl -x "$0" -s -o /dev/null -m 10 --connect-timeout 5 -w "%{http_connect}" "https://$1" 2>/dev/null || true' "$PROXY" "$FORA")" || conn=""
  if [ "$conn" = 403 ]; then
    echo "ok  recusado  $FORA fora da lista (o proxy respondeu 403)"
  else
    FUROS=$((FUROS + 1))
    echo "FURO  $FORA, que nao esta na lista, nao foi recusado com 403 (CONNECT devolveu '${conn:-nada}'). Confira o modo: dgclaw saida mostrar $SLUG"
  fi

  # 3. Saida direta, sem proxy: DROP na mangle, so timeout vale como bloqueado.
  rc=0
  dentro 'timeout 4 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"' >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "ok  bloqueado  conexao direta a 1.1.1.1:443 sem passar pelo proxy"
  else
    FUROS=$((FUROS + 1))
    echo "FURO  conexao direta a 1.1.1.1:443 SEM proxy nao ficou bloqueada (codigo $rc; 0 = conectou, 1 = recusou). Confira a cadeia: iptables -t mangle -S DGCLAW-SAIDA e reaplique com: systemctl restart dgclaw-firewall"
  fi

  # 4. No gateway so a porta do proxy responde.
  rc=0
  dentro 'timeout 4 bash -c "exec 3<>/dev/tcp/$0/22"' "$GW" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "ok  bloqueado  $GW:22 (o host so deixa o agente falar na porta $PORTA_PROXY)"
  else
    FUROS=$((FUROS + 1))
    echo "FURO  $GW:22 respondeu a partir do agente (codigo $rc). A liberacao do proxy esta larga demais: iptables -S DGCLAW-SAIDA"
  fi
else
  echo "    (modo registro: a saida direta continua aberta de proposito; so o que passa pelo proxy e anotado)"
fi

echo
if [ "$FUROS" -gt 0 ]; then
  echo "RESULTADO: FURO. A saida controlada NAO esta valendo como prometido ($FUROS furo(s))."
  exit 1
fi
echo "RESULTADO: SAIDA CONTROLADA OK."
exit 0
