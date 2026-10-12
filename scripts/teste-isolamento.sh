#!/usr/bin/env bash
# teste-isolamento.sh: PROVA que o container de um agente nao alcanca o host
# nem as redes privadas, e que alcanca so a internet.
#
# Uso:  bash scripts/teste-isolamento.sh [<slug>]
#       bash scripts/teste-isolamento.sh --help
#
#   com <slug>   roda os testes DE DENTRO de dgclaw-<slug> (podman exec, usuario agente).
#   sem slug     testa todos os agentes do registro que estao rodando. Se nao houver
#                nenhum, sobe uma sonda: rede temporaria "dgclaw-sonda" (10.89.254.0/24,
#                reservada para isso) e um container --rm da mesma imagem. A rede e a
#                sonda saem no fim, mesmo quando um teste falha (trap).
#
# Saida: 0 tudo bloqueado e internet ok | 1 qualquer furo | 2 inconclusivo ou erro de ambiente.
#
# Regra de "respondeu" (a mais importante deste script):
#   - Usamos conexao TCP (bash /dev/tcp), com limite de 3 s por alvo. Os alvos rodam em
#     paralelo dentro do container, entao a bateria inteira leva uns poucos segundos.
#   - Para o HOST e o GATEWAY (e o container de outro agente), o firewall (cadeias
#     DGCLAW_HOST e DGCLAW_EGRESS) deve fazer DROP, e DROP so produz TIMEOUT. Conexao
#     aberta E conexao recusada (RST) contam como FURO: RST quer dizer que o pacote
#     CHEGOU no host e a pilha dele respondeu, ou seja, a cadeia nao esta dropando.
#   - Para redes privadas EXTERNAS (10.0.0.1, 172.16.0.1, 192.168.0.1) e metadados de
#     nuvem, aberta e FURO, mas recusada vira so AVISO: pode ser um roteador real da rede
#     do provedor devolvendo RST, o que tambem prova que a saida nao foi dropada, por isso
#     o aviso pede conferencia, sem reprovar.
#   - "Sem rota" (ICMP unreachable) cai em recusado, porque o bash nao distingue. Para o
#     host isso tambem e furo (alguem do host respondeu); nas privadas e aviso.
#   - Internet (https://api.anthropic.com) e a prova de que o teste nao e falso negativo
#     por falta de rede. Qualquer resposta HTTP conta. Sem resposta, o resultado e
#     INCONCLUSIVO (sai 2), nunca "isolado".
#
# Como descobre os enderecos:
#   - gateway: de DENTRO do container, na rota padrao (/proc/net/route). Nao depende de
#     ip/curl existirem na imagem.
#   - IP do host: no host, `ip -4 route get 1.1.1.1` (campo src). Pode ser forcado com
#     DGCLAW_IP_HOST. E passado para dentro como alvo.
#   - portas dos agentes: `podman port dgclaw-<slug>`; se o container esta parado, calcula
#     (runner 4310+N, painel 8310+N).
#
# Variaveis: DGCLAW_ETC (padrao /etc/dgclaw), DGCLAW_IMAGEM (senao a do dgclaw.env, senao
# localhost/dgclaw-agente:latest), DGCLAW_IP_HOST, DGCLAW_VERBOSO=1 (mostra os alvos que a
# bateria paralela errou e o teste isolado corrigiu), DGCLAW_TESTE_SEM_ROOT=1 (so para testes
# automatizados com podman falso).

set -euo pipefail

ETC="${DGCLAW_ETC:-/etc/dgclaw}"
REGISTRO="$ETC/registro.tsv"
REDE_SONDA="dgclaw-sonda"
CTR_SONDA="dgclaw-sonda"
LIMITE=3

FUROS=0
AVISOS=0
BLOQUEADOS=0
INCONCLUSIVOS=0
SONDA_CRIADA=0
REDE_SONDA_CRIADA=0

uso() {
  cat <<'FIM'
Uso: bash scripts/teste-isolamento.sh [<slug>]

Prova que o container de um agente nao alcanca o host nem redes privadas,
so a internet. Com <slug>, testa dentro de dgclaw-<slug>. Sem slug, testa
todos os agentes rodando; se nao houver nenhum, sobe uma sonda temporaria.

Sai 0 (tudo bloqueado e internet ok), 1 (algum furo) ou 2 (inconclusivo
ou erro de ambiente). Precisa rodar como root, com podman instalado.
FIM
}

# Erro de ambiente: diz o que falhou, com que entrada e o que fazer. Sai 2.
erro_ambiente() {
  echo "ERRO: $1" >&2
  echo "      O que fazer: $2" >&2
  exit 2
}

# Limpeza da sonda. Roda sempre (trap EXIT), inclusive depois de erro. Nao usa
# `|| true` mudo: se nao consegue remover, avisa o que sobrou.
# shellcheck disable=SC2329  # chamada pelo trap EXIT
limpar() {
  local rc=$?
  set +e
  if [ "$SONDA_CRIADA" = 1 ]; then
    if ! podman rm -f "$CTR_SONDA" >/dev/null 2>&1; then
      echo "AVISO: nao consegui remover o container $CTR_SONDA. Remova a mao: podman rm -f $CTR_SONDA" >&2
    fi
  fi
  if [ "$REDE_SONDA_CRIADA" = 1 ]; then
    if ! podman network rm -f "$REDE_SONDA" >/dev/null 2>&1; then
      echo "AVISO: nao consegui remover a rede $REDE_SONDA. Remova a mao: podman network rm -f $REDE_SONDA" >&2
    fi
  fi
  exit "$rc"
}

# Script que roda DENTRO do container (como agente). Tres modos:
#   gw   imprime o gateway da rota padrao
#   tcp  recebe alvos "id|ip|porta" e imprime "id<TAB>aberto|recusado|timeout"
#   net  imprime ok ou falhou conforme a internet responda
# shellcheck disable=SC2016  # de proposito: o texto roda em OUTRO bash, dentro do container
INTERNO='
modo=$1; shift
case "$modo" in
gw)
  while read -r _ destino gateway _; do
    if [ "$destino" = 00000000 ]; then
      printf "%d.%d.%d.%d\n" "0x${gateway:6:2}" "0x${gateway:4:2}" "0x${gateway:2:2}" "0x${gateway:0:2}"
      exit 0
    fi
  done < /proc/net/route
  exit 1
  ;;
tcp)
  d=$(mktemp -d)
  for t in "$@"; do
    id=${t%%|*}; resto=${t#*|}; ip=${resto%%|*}; porta=${resto#*|}
    (
      timeout '"$LIMITE"' bash -c "exec 3<>\"/dev/tcp/\$0/\$1\"" "$ip" "$porta" >/dev/null 2>&1
      rc=$?
      case "$rc" in 0) e=aberto;; 124) e=timeout;; *) e=recusado;; esac
      printf "%s\t%s\n" "$id" "$e" > "$d/$id"
    ) &
  done
  wait
  for t in "$@"; do id=${t%%|*}; cat "$d/$id"; done
  rm -rf "$d"
  ;;
net)
  if command -v curl >/dev/null 2>&1; then
    codigo=$(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy curl --noproxy "*" -s -o /dev/null -m 6 --connect-timeout 5 -w "%{http_code}" https://api.anthropic.com 2>/dev/null || true)
    if [ -n "$codigo" ] && [ "$codigo" != 000 ]; then echo ok; else echo falhou; fi
  else
    if timeout 6 bash -c "exec 3<>/dev/tcp/api.anthropic.com/443" >/dev/null 2>&1; then echo ok; else echo falhou; fi
  fi
  ;;
*) exit 64 ;;
esac
'

# Executa o script interno dentro do container. Uso: dentro <container> <modo> [args...]
dentro() {
  local ctr="$1"; shift
  podman exec -u agente "$ctr" bash -c "$INTERNO" interno "$@"
}

# ── leitura do ambiente ─────────────────────────────────────────────────────

SLUGS=()
NUMS=()
ler_registro() {
  [ -f "$REGISTRO" ] || return 0
  local slug uid n
  while IFS=$'\t' read -r slug uid n || [ -n "$slug" ]; do
    case "$slug" in ''|'#'*) continue ;; esac
    if ! [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || ! [[ "${n:-}" =~ ^[0-9]+$ ]]; then
      echo "AVISO: linha ignorada em $REGISTRO (esperado slug<TAB>uid_base<TAB>N): '$slug' '$uid' '${n:-}'" >&2
      continue
    fi
    SLUGS+=("$slug"); NUMS+=("$n")
  done < "$REGISTRO"
}

imagem() {
  local img="${DGCLAW_IMAGEM:-}"
  if [ -z "$img" ] && [ -f "$ETC/dgclaw.env" ]; then
    img=$(sed -n "s/^DGCLAW_IMAGEM=//p" "$ETC/dgclaw.env" | tail -n 1 | tr -d "'\"")
  fi
  echo "${img:-localhost/dgclaw-agente:latest}"
}

rodando() { # rodando <container>: 0 se esta rodando
  podman ps --format '{{.Names}}' | grep -qx "$1"
}

# Portas publicadas no host para um agente: "runner painel". Le o podman; se o
# container esta parado ou nao informa, calcula (xx a partir de 11: 4310+N, 8310+N).
portas_agente() {
  local slug="$1" n="$2" runner="" painel="" linha porta_host
  while IFS= read -r linha; do
    porta_host="${linha##*:}"
    case "$linha" in
      4300/*) runner="$porta_host" ;;
      8300/*) painel="$porta_host" ;;
    esac
  done < <(podman port "dgclaw-$slug" 2>/dev/null || true)
  echo "${runner:-$((4310 + n))} ${painel:-$((8310 + n))}"
}

ip_do_host() {
  local ip="${DGCLAW_IP_HOST:-}"
  if [ -z "$ip" ]; then
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  fi
  echo "$ip"
}

ip_do_container() {
  podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null | head -n 1
}

# ── a bateria ───────────────────────────────────────────────────────────────

ALVOS=()  # cada item: id|ip|porta|tipo|descricao|porque
add_alvo() { # add_alvo ip porta tipo descricao porque
  ALVOS+=("a${#ALVOS[@]}|$1|$2|$3|$4|$5")
}

# Testa um container. testar <container> <slug-ou-"sonda"> <ip-host> <ip-do-container>...
testar() {
  local ctr="$1" rotulo="$2" iphost="$3" meu_ip="$4"
  ALVOS=()
  echo
  echo "== $rotulo (container $ctr) =="

  local gw
  if ! gw=$(dentro "$ctr" gw 2>&1) || ! [[ "$gw" =~ ^[0-9.]+$ ]]; then
    erro_ambiente "nao consegui descobrir o gateway dentro de $ctr (saida: '${gw:-vazia}')" \
      "confira se o container esta de pe (podman ps) e tem rede (podman inspect $ctr)"
  fi

  # Proxy herdado de quem criou o container (o podman copia *_PROXY do shell por padrao).
  # Nao e furo de isolamento, por isso nao reprova: o teste mede a rede. Mas um proxy em
  # 127.0.0.1 aponta para o proprio container, e todo `podman exec` (inclusive o login)
  # deixa de alcancar a internet. Correcao: recriar com --http-proxy=false.
  local proxies
  proxies=$(podman inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ctr" 2>/dev/null \
    | grep -iE '^(https?|all)_proxy=' | cut -d= -f1 | sort -u | tr '\n' ' ' || true)
  if [ -n "$proxies" ]; then
    AVISOS=$((AVISOS + 1))
    echo "AVISO: o ambiente de $ctr traz ${proxies% } (herdado de quem rodou o podman create). Todo 'podman exec' sai por esse proxy e, se ele for 127.0.0.1, nao chega a internet. Recrie o container com --http-proxy=false."
  fi

  # Todas as portas que o host serve para os agentes, mais Admin, Web e ssh.
  local portas=(22 4300 8300) i r p
  for i in "${!SLUGS[@]}"; do
    read -r r p <<<"$(portas_agente "${SLUGS[$i]}" "${NUMS[$i]}")"
    portas+=("$r" "$p")
  done
  local unicas
  unicas=$(printf '%s\n' "${portas[@]}" | sort -nu)

  local porta
  while read -r porta; do
    add_alvo "$gw" "$porta" host "gateway $gw:$porta" \
      "o gateway e a propria maquina hospedeira, alcancar e chegar nos servicos dela"
  done <<<"$unicas"
  if [ -n "$iphost" ] && [ "$iphost" != "$gw" ]; then
    while read -r porta; do
      add_alvo "$iphost" "$porta" host "IP do host $iphost:$porta" \
        "e o mesmo host visto pelo endereco publico, a cerca precisa fechar os dois caminhos"
    done <<<"$unicas"
  fi

  local ip
  for ip in 10.0.0.1 172.16.0.1 192.168.0.1; do
    for porta in 22 80 443; do
      add_alvo "$ip" "$porta" privada "rede privada $ip:$porta" \
        "amostra de rede privada, o agente nao pode chegar na rede do dono nem na do provedor"
    done
  done
  add_alvo 169.254.169.254 80 privada "metadados de nuvem 169.254.169.254:80" \
    "dali sai credencial temporaria da maquina, nunca pode ser alcancado"

  # Containers de OUTROS agentes (so os que estao rodando).
  local outro ipo
  for i in "${!SLUGS[@]}"; do
    outro="dgclaw-${SLUGS[$i]}"
    [ "$outro" = "$ctr" ] && continue
    rodando "$outro" || continue
    ipo=$(ip_do_container "$outro")
    [ -n "$ipo" ] && [ "$ipo" != "$meu_ip" ] || continue
    for porta in 4300 8300; do
      add_alvo "$ipo" "$porta" host "agente ${SLUGS[$i]} em $ipo:$porta" \
        "um agente nao pode falar com o container de outro agente"
    done
  done

  local args=() a
  for a in "${ALVOS[@]}"; do
    IFS='|' read -r id ip porta _ <<<"$a"
    args+=("$id|$ip|$porta")
  done
  local saida
  if ! saida=$(dentro "$ctr" tcp "${args[@]}" 2>&1); then
    erro_ambiente "a bateria de conexoes falhou dentro de $ctr: $saida" \
      "rode 'podman exec -u agente $ctr bash -c true' para ver se o usuario agente existe e o bash roda"
  fi

  local id estado tipo desc porque
  for a in "${ALVOS[@]}"; do
    IFS='|' read -r id ip porta tipo desc porque <<<"$a"
    estado=$(awk -F'\t' -v k="$id" '$1==k {print $2}' <<<"$saida")
    case "$estado" in
      aberto|recusado|timeout) ;;
      *) erro_ambiente "resultado ilegivel para $desc dentro de $ctr (recebi '${estado:-nada}')" \
           "rode o teste de novo; se repetir, olhe 'podman logs $ctr'" ;;
    esac
    # Confirmacao: a bateria roda dezenas de conexoes em paralelo, e um resultado
    # que NAO seja timeout pode ser artefato dessa concorrencia (visto na pratica: RST
    # que nao se repete quando o mesmo alvo e testado sozinho). Antes de acusar furo,
    # repete o alvo isolado e vale o resultado isolado.
    if [ "$estado" != timeout ]; then
      local sozinho
      if sozinho=$(dentro "$ctr" tcp "$id|$ip|$porta" 2>&1); then
        sozinho=$(awk -F'\t' -v k="$id" '$1==k {print $2}' <<<"$sozinho")
        case "$sozinho" in
          aberto|recusado|timeout)
            if [ "$sozinho" != "$estado" ]; then
              if [ "${DGCLAW_VERBOSO:-0}" = 1 ]; then echo "   (nota: $desc deu '$estado' na bateria paralela e '$sozinho' sozinho; vale o isolado)"; fi
            fi
            estado="$sozinho" ;;
        esac
      fi
    fi
    avaliar "$tipo" "$estado" "$desc" "$porque"
  done

  local net
  if ! net=$(dentro "$ctr" net 2>&1); then net=falhou; fi
  if [ "$net" = ok ]; then
    echo "ok  internet alcancada https://api.anthropic.com (prova de que os bloqueios acima nao sao falso negativo)"
  else
    INCONCLUSIVOS=$((INCONCLUSIVOS + 1))
    echo "??  INCONCLUSIVO  https://api.anthropic.com nao respondeu (sem internet o teste nao prova nada / confira DNS e saida do host: podman exec -u agente $ctr curl --noproxy "*" -sI https://api.anthropic.com)"
  fi
}

avaliar() { # avaliar <tipo> <estado> <descricao> <porque>
  local tipo="$1" estado="$2" desc="$3" porque="$4"
  case "$estado" in
    timeout)
      BLOQUEADOS=$((BLOQUEADOS + 1))
      echo "ok  bloqueado  $desc ($porque)"
      ;;
    aberto)
      FUROS=$((FUROS + 1))
      echo "FURO  $desc respondeu, conexao ABERTA ($porque / confira as cadeias com 'iptables -S DGCLAW_HOST' e 'iptables -S DGCLAW_EGRESS' e reaplique com 'systemctl restart dgclaw-firewall')"
      ;;
    recusado)
      if [ "$tipo" = privada ]; then
        AVISOS=$((AVISOS + 1))
        BLOQUEADOS=$((BLOQUEADOS + 1))
        echo "ok  bloqueado  $desc (AVISO: devolveu recusa em vez de ficar mudo; pode ser um roteador real da rede, confira que a cadeia DGCLAW_EGRESS esta ativa)"
      else
        FUROS=$((FUROS + 1))
        echo "FURO  $desc respondeu com RST, o pacote CHEGOU la ($porque / o firewall deveria dar DROP e nao RST: reaplique com 'systemctl restart dgclaw-firewall')"
      fi
      ;;
  esac
}

# ── sonda ───────────────────────────────────────────────────────────────────

subir_sonda() {
  local img="$1"
  podman image exists "$img" 2>/dev/null || erro_ambiente \
    "a imagem '$img' nao existe neste host (precisa dela para subir a sonda)" \
    "construa a imagem (systemctl start dgclaw-imagem) ou aponte DGCLAW_IMAGEM para uma que exista"

  # Rede sobrando de uma execucao anterior: tenta recriar do zero; se algo ainda a
  # usa e nao sai, reaproveita (o nome e exclusivo da sonda) e limpa no fim.
  if podman network exists "$REDE_SONDA" 2>/dev/null; then
    podman rm -f "$CTR_SONDA" >/dev/null 2>&1 || true  # sonda velha pode nem existir
    if ! podman network rm -f "$REDE_SONDA" >/dev/null 2>&1; then
      echo "AVISO: a rede $REDE_SONDA ja existia e nao saiu; vou reaproveitar e remover no fim." >&2
      REDE_SONDA_CRIADA=1
    fi
  fi
  if ! podman network exists "$REDE_SONDA" 2>/dev/null; then
    podman network create --disable-dns --subnet 10.89.254.0/24 "$REDE_SONDA" >/dev/null \
      || erro_ambiente "nao consegui criar a rede $REDE_SONDA (10.89.254.0/24)" \
         "veja se outra rede ja usa essa faixa: podman network ls; podman network inspect"
    REDE_SONDA_CRIADA=1
  fi
  # --entrypoint: a imagem sobe systemd (/sbin/init); a sonda so precisa de um processo vivo.
  SONDA_CRIADA=1
  podman run -d --rm --http-proxy=false --name "$CTR_SONDA" --network "$REDE_SONDA" --entrypoint sleep "$img" 300 >/dev/null \
    || erro_ambiente "nao consegui subir a sonda $CTR_SONDA com a imagem $img" \
       "rode 'podman run --rm --entrypoint true $img' para ver o erro da imagem"
}

# ── principal ───────────────────────────────────────────────────────────────

main() {
  local slug_arg=""
  case "${1:-}" in
    -h|--help) uso; exit 0 ;;
    -*) uso >&2; erro_ambiente "opcao desconhecida '$1'" "use --help para ver o uso" ;;
    *) slug_arg="${1:-}" ;;
  esac
  [ "$#" -le 1 ] || erro_ambiente "argumentos demais: $*" "passe no maximo um <slug>"

  command -v podman >/dev/null 2>&1 || erro_ambiente "o comando podman nao foi encontrado" \
    "instale o podman (apt install podman) ou rode este teste no host onde os agentes vivem"
  if [ "${DGCLAW_TESTE_SEM_ROOT:-0}" != 1 ] && [ "$(id -u)" != 0 ]; then
    erro_ambiente "este teste precisa rodar como root (usuario atual uid $(id -u)); o podman dos agentes e rootful" \
      "rode com sudo: sudo bash scripts/teste-isolamento.sh"
  fi

  trap limpar EXIT
  ler_registro
  local img iphost
  img=$(imagem)
  iphost=$(ip_do_host)
  [ -n "$iphost" ] || echo "AVISO: nao descobri o IP do host ('ip -4 route get 1.1.1.1' vazio); testo so o gateway. Defina DGCLAW_IP_HOST para cobrir o endereco publico." >&2

  if [ -n "$slug_arg" ]; then
    local achou=0 i
    for i in "${!SLUGS[@]}"; do [ "${SLUGS[$i]}" = "$slug_arg" ] && achou=1; done
    [ "$achou" = 1 ] || erro_ambiente "o slug '$slug_arg' nao esta em $REGISTRO" \
      "confira os agentes existentes com 'cut -f1 $REGISTRO'"
    rodando "dgclaw-$slug_arg" || erro_ambiente "o container dgclaw-$slug_arg nao esta rodando" \
      "suba o agente (dgclaw agente iniciar $slug_arg) e rode o teste de novo"
    testar "dgclaw-$slug_arg" "$slug_arg" "$iphost" "$(ip_do_container "dgclaw-$slug_arg")"
  else
    local testou=0 i
    for i in "${!SLUGS[@]}"; do
      if rodando "dgclaw-${SLUGS[$i]}"; then
        testar "dgclaw-${SLUGS[$i]}" "${SLUGS[$i]}" "$iphost" "$(ip_do_container "dgclaw-${SLUGS[$i]}")"
        testou=1
      fi
    done
    if [ "$testou" = 0 ]; then
      echo "Nenhum agente rodando: subindo a sonda temporaria ($REDE_SONDA)."
      subir_sonda "$img"
      testar "$CTR_SONDA" "sonda" "$iphost" "$(ip_do_container "$CTR_SONDA")"
    fi
  fi

  echo
  echo "== Resumo =="
  echo "$BLOQUEADOS alvo(s) bloqueado(s), $FUROS furo(s), $AVISOS aviso(s), $INCONCLUSIVOS internet sem resposta."
  if [ "$FUROS" -gt 0 ]; then
    echo "RESULTADO: FURO. O isolamento NAO esta valendo: nao entregue este servidor a um cliente antes de corrigir."
    exit 1
  fi
  if [ "$INCONCLUSIVOS" -gt 0 ]; then
    echo "RESULTADO: INCONCLUSIVO. Nada vazou, mas sem internet o teste nao prova isolamento. Conserte a saida e rode de novo."
    exit 2
  fi
  echo "RESULTADO: ISOLADO. O container nao alcanca o host nem redes privadas e alcanca a internet."
  exit 0
}

main "$@"
