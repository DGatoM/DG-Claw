#!/usr/bin/env bash
# lib/emergencia.sh: o botao de emergencia do DG Claw ("tirar do ar") e o religar.
#
# Chamado por `dgclaw emergencia ...` (bin/dgclaw) e pelo executor de pedidos da ronda de seguranca.
# Tira o servidor da internet (para o proxy publico e carrega a tabela nft `inet dgclaw_emergencia`,
# que derruba ate as conexoes ja abertas) mantendo so o acesso de administracao (Tailscale ou IPS_ADMIN).
# O ufw nao e alterado. Desenho: docs/EMERGENCIA.md.
#
# Uso:  dgclaw emergencia estado|simular|preparar|cortar|confirmar|religar [opcoes]
# O corte vive na memoria (tabela nft e servicos parados) e NAO sobrevive a um reinicio, por desenho: depois de reiniciar,
# o marcador `cortado` sem a tabela nft vira o estado "inconsistente" e a ronda avisa. Veja docs/EMERGENCIA.md.
# Raiz falsa (testes): DGCLAW_RAIZ=<pasta>, igual ao resto do DG Claw.
set -euo pipefail

PROG="dgclaw emergencia"
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
RAIZ="${DGCLAW_RAIZ:-}"
RAIZ="${RAIZ%/}"
QUEM="${EMERGENCIA_QUEM:-${SUDO_USER:-${USER:-desconhecido}}}"
QUEM="${QUEM//[^A-Za-z0-9._@-]/_}"
UNIDADE_TIMER="emergencia-desfazer"
NFT_TABELA="dgclaw_emergencia"
TRAVA_FD=""
ESPEROU_TRAVA=0
VALIDADE_CODIGO_S=120
MAX_TENTATIVAS=3

CODIGO=""
ISOLAR=0
JSON=0
AUTO=0
CORTE_ARG=""
CORTE_ID=""

SERVICOS_PUBLICOS="caddy cloudflared"
INTERFACES_ADMIN="tailscale0"
IPS_ADMIN=""
REDES_INTERNAS="10.89.0.0/16"
PORTA_SSH=22
PRAZO_CONFIRMAR_MIN=5
URLS_TESTE_RELIGAR=""
URLS_NA_CONF=0
ESTADO_DIR="/var/lib/dgclaw/emergencia"

SERVICOS=()
INTERFACES=()
IPS=()
REDES=()
URLS=()
PROBLEMAS=()
AVISOS=()
ADMIN_IFS=()
ATIVOS=()
PLANO=()
NFT_TEXTO=""

# ---------- utilidades ----------

erro() { printf 'ERRO: %s\n' "$*" >&2; }
falhar() { erro "$*"; exit 1; }
aviso() { printf 'AVISO: %s\n' "$*" >&2; }
agora_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log() {
  local msg="$*"
  if [[ -d "$ESTADO_DIR" ]]; then
    printf '%s %s %s\n' "$(agora_iso)" "$QUEM" "$msg" >>"$ESTADO_DIR/emergencia.log" \
      || aviso "não consegui gravar em $ESTADO_DIR/emergencia.log (mensagem: $msg). Confira a permissão da pasta."
  fi
  logger -t emergencia -- "$QUEM: $msg" \
    || aviso "não consegui mandar para o journal (logger falhou). Mensagem: $msg"
}

json_s() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

json_arr() {
  local primeiro=1 item
  printf '['
  for item in "$@"; do
    if ((primeiro)); then primeiro=0; else printf ','; fi
    json_s "$item"
  done
  printf ']'
}

json_bool() { if (($1)); then printf 'true'; else printf 'false'; fi; }

uso() {
  cat <<USO
Uso:
  $PROG estado [--json]
  $PROG simular [--isolar-saida] [--json]
  $PROG preparar [--json]                  gera o código de uso único (vale 2 min) e mostra o plano
  $PROG cortar --codigo <código> [--isolar-saida]
  $PROG confirmar
  $PROG religar --codigo <código>
Configuração: /etc/dgclaw/emergencia.conf (ou \$EMERGENCIA_CONF). Modelo: docs/EMERGENCIA.md.
USO
}

# ---------- configuração (sem source: leitura linha a linha) ----------

# Dominio do painel, lido do dgclaw.env sem dar `source`.
dominio_do_painel() {
  local arq="$RAIZ/etc/dgclaw/dgclaw.env"
  [[ -f "$arq" ]] || return 0
  sed -n 's/^DGCLAW_DOMINIO=//p;T;q' "$arq"
}

carrega_conf() {
  local arq="${EMERGENCIA_CONF:-$RAIZ/etc/dgclaw/emergencia.conf}"
  if [[ -f "$arq" ]]; then
    local linha chave valor n=0
    while IFS= read -r linha || [[ -n "$linha" ]]; do
      n=$((n + 1))
      linha="${linha#"${linha%%[![:space:]]*}"}"
      linha="${linha%"${linha##*[![:space:]]}"}"
      [[ -z "$linha" || "$linha" == \#* ]] && continue
      if [[ ! "$linha" =~ ^([A-Z_]+)=(.*)$ ]]; then
        falhar "$arq linha $n: esperava CHAVE=valor e recebi '$linha'. Corrija a linha."
      fi
      chave="${BASH_REMATCH[1]}"
      valor="${BASH_REMATCH[2]}"
      if [[ "$valor" =~ ^\"(.*)\"$ || "$valor" =~ ^\'(.*)\'$ ]]; then valor="${BASH_REMATCH[1]}"; fi
      case "$chave" in
        SERVICOS_PUBLICOS) SERVICOS_PUBLICOS="$valor" ;;
        INTERFACES_ADMIN) INTERFACES_ADMIN="$valor" ;;
        IPS_ADMIN) IPS_ADMIN="$valor" ;;
        REDES_INTERNAS) REDES_INTERNAS="$valor" ;;
        PORTA_SSH) PORTA_SSH="$valor" ;;
        PRAZO_CONFIRMAR_MIN) PRAZO_CONFIRMAR_MIN="$valor" ;;
        URLS_TESTE_RELIGAR) URLS_TESTE_RELIGAR="$valor"; URLS_NA_CONF=1 ;;
        ESTADO_DIR) ESTADO_DIR="$valor" ;;
        *) falhar "$arq linha $n: chave desconhecida '$chave'. Chaves aceitas: SERVICOS_PUBLICOS INTERFACES_ADMIN IPS_ADMIN REDES_INTERNAS PORTA_SSH PRAZO_CONFIRMAR_MIN URLS_TESTE_RELIGAR ESTADO_DIR." ;;
      esac
    done <"$arq"
  elif [[ -n "${EMERGENCIA_CONF:-}" ]]; then
    falhar "EMERGENCIA_CONF aponta para '$EMERGENCIA_CONF', que não existe. Crie o arquivo (modelo em docs/EMERGENCIA.md)."
  fi

  if ((! URLS_NA_CONF)); then
    local dom
    dom="$(dominio_do_painel)"
    if [[ "$dom" =~ ^[A-Za-z0-9.-]+$ ]]; then URLS_TESTE_RELIGAR="https://$dom/"; fi
  fi

  local item
  read -ra SERVICOS <<<"${SERVICOS_PUBLICOS//,/ }"
  read -ra INTERFACES <<<"${INTERFACES_ADMIN//,/ }"
  read -ra IPS <<<"${IPS_ADMIN//,/ }"
  read -ra REDES <<<"${REDES_INTERNAS//,/ }"
  read -ra URLS <<<"$URLS_TESTE_RELIGAR"
  for item in "${SERVICOS[@]}"; do
    [[ "$item" =~ ^[A-Za-z0-9@._:-]+$ ]] || falhar "SERVICOS_PUBLICOS tem nome inválido '$item'. Use só letras, números e @ . _ : -."
  done
  for item in "${INTERFACES[@]}"; do
    [[ "$item" =~ ^[A-Za-z0-9._-]+$ ]] || falhar "INTERFACES_ADMIN tem nome inválido '$item'."
  done
  for item in "${IPS[@]}"; do
    [[ "$item" =~ ^[0-9a-fA-F:.]+(/[0-9]{1,3})?$ ]] || falhar "IPS_ADMIN tem valor inválido '$item'. Use IP ou CIDR, separados por espaço."
  done
  for item in "${REDES[@]}"; do
    [[ "$item" =~ ^[0-9a-fA-F:.]+/[0-9]{1,3}$ ]] || falhar "REDES_INTERNAS tem valor inválido '$item'. Use CIDR (ex.: 10.89.0.0/16), separados por espaço."
  done
  for item in "${URLS[@]}"; do
    [[ "$item" =~ ^https://[^[:space:]]+$ ]] || falhar "URLS_TESTE_RELIGAR tem valor inválido '$item'. Use URLs começando com https://."
  done
  { [[ "$PORTA_SSH" =~ ^[0-9]{1,5}$ ]] && ((PORTA_SSH >= 1 && PORTA_SSH <= 65535)); } \
    || falhar "PORTA_SSH inválida '$PORTA_SSH'. Use um número de 1 a 65535."
  { [[ "$PRAZO_CONFIRMAR_MIN" =~ ^[0-9]{1,3}$ ]] && ((PRAZO_CONFIRMAR_MIN >= 1 && PRAZO_CONFIRMAR_MIN <= 240)); } \
    || falhar "PRAZO_CONFIRMAR_MIN inválido '$PRAZO_CONFIRMAR_MIN'. Use minutos de 1 a 240."
  [[ "$ESTADO_DIR" =~ ^/[A-Za-z0-9._/-]*$ ]] || falhar "ESTADO_DIR inválido '$ESTADO_DIR'. Use um caminho absoluto sem espaços."
  ESTADO_DIR="$RAIZ$ESTADO_DIR"
  ARQ_NFT="$ESTADO_DIR/emergencia.nft"
  ARQ_CODIGO="$RAIZ/var/lib/dgclaw/seguranca/emergencia-codigo"
  ARQ_WEB="$RAIZ/var/lib/dgclaw/web/seguranca/emergencia.json"
}

garante_estado_dir() {
  umask 077
  mkdir -p "$ESTADO_DIR" || falhar "não consegui criar $ESTADO_DIR. Rode como root ou ajuste ESTADO_DIR."
  chmod 700 "$ESTADO_DIR" || falhar "não consegui aplicar chmod 700 em $ESTADO_DIR."
}

marcador_valor() { sed -n "s/^$1=//p" "$ESTADO_DIR/cortado" | head -n 1; }

exige_root() {
  if [[ -z "$RAIZ" && "$EUID" -ne 0 ]]; then
    falhar "este comando precisa de root. Rode: sudo $PROG $*"
  fi
}

# ---------- pré-checagens ----------

servico_ativo() { systemctl is-active --quiet "$1"; }

coleta_ativos() {
  local s
  ATIVOS=()
  for s in "${SERVICOS[@]}"; do
    if servico_ativo "$s"; then ATIVOS+=("$s"); fi
  done
}

prechecagens() {
  PROBLEMAS=()
  AVISOS=()
  ADMIN_IFS=()
  local saida

  if [[ -z "$RAIZ" && "$EUID" -ne 0 ]]; then
    PROBLEMAS+=("não está rodando como root. Rode com sudo.")
  fi
  if [[ "$SELF" =~ [[:space:]] || ! "$SELF" =~ ^[A-Za-z0-9._/@:+-]+$ ]]; then
    PROBLEMAS+=("o caminho do script ('$SELF') tem caracteres que o agendamento do religar não aceita. Mova o DG Claw para um caminho simples.")
  fi

  if ! command -v nft >/dev/null 2>&1; then
    PROBLEMAS+=("o nft não está instalado. Sem ele não há como fechar a rede com segurança: instale (apt install nftables) e rode o instalador do DG Claw de novo.")
  fi

  local ts_ok=0 ts_saida="tailscale não instalado" i estado if_up=()
  if command -v tailscale >/dev/null 2>&1; then
    if ts_saida="$(tailscale status 2>&1)" && ! grep -qiE 'logged out|needslogin|stopped' <<<"$ts_saida"; then
      ts_ok=1
    else
      ts_saida="${ts_saida%%$'\n'*}"
    fi
  fi
  for i in "${INTERFACES[@]}"; do
    estado="$(ip -br link show "$i" 2>/dev/null | awk '{print $2}' | head -n 1)" || estado=""
    if [[ "$estado" == "UP" || "$estado" == "UNKNOWN" ]]; then if_up+=("$i"); fi
  done
  if ((ts_ok && ${#if_up[@]} > 0)); then
    ADMIN_IFS=("${if_up[@]}")
  fi
  if ((${#ADMIN_IFS[@]} == 0 && ${#IPS[@]} == 0)); then
    PROBLEMAS+=("o corte trancaria todo mundo fora: ligue o Tailscale (entre na sua conta com 'sudo tailscale up') ou preencha IPS_ADMIN em /etc/dgclaw/emergencia.conf. (interfaces de pé: ${if_up[*]:-nenhuma}; tailscale: ${ts_saida:-respondeu, mas sem interface de pé})")
  fi
  if ((${#ADMIN_IFS[@]} == 0 && ${#if_up[@]} > 0)); then
    AVISOS+=("a interface ${if_up[*]} está de pé, mas o tailscale não está logado (${ts_saida}); só os IPS_ADMIN vão continuar entrando.")
  fi
  AVISOS+=("o corte usa a tabela nft inet $NFT_TABELA (antes das regras do ufw, que não são mexidas) e derruba também as conexões que já estavam abertas, menos as de administração.")
  AVISOS+=("o painel e as conversas também saem do ar durante o corte, porque o proxy público é parado. Para confirmar ou religar, entre no servidor por SSH pelo Tailscale.")
}

# ---------- plano (a mesma lista serve para simular e para cortar) ----------

# Itens (IP ou CIDR) de uma família: 4 = sem ":", 6 = com ":". Devolve "a, b, c" (vazio se não houver).
lista_familia() {
  local fam="$1" item out=""
  shift
  for item in "$@"; do
    if { [[ "$fam" == 6 ]] && [[ "$item" == *:* ]]; } || { [[ "$fam" == 4 ]] && [[ "$item" != *:* ]]; }; then
      out+="${out:+, }$item"
    fi
  done
  printf '%s' "$out"
}

# O arquivo nft do corte. Prioridade -10: roda antes das chains do ufw/iptables-nft (prioridade 0), então o
# drop vale até para conexão já estabelecida. Policy accept: o que a tabela não pega segue o fluxo normal.
monta_nft() {
  local ifs="" i ips4 ips6 red4 red6 t="$NFT_TABELA"
  for i in "${ADMIN_IFS[@]}"; do ifs+="${ifs:+, }\"$i\""; done
  ips4="$(lista_familia 4 "${IPS[@]}")"; ips6="$(lista_familia 6 "${IPS[@]}")"
  red4="$(lista_familia 4 "${REDES[@]}")"; red6="$(lista_familia 6 "${REDES[@]}")"
  local nd='icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept'
  {
    printf 'table inet %s\ndelete table inet %s\ntable inet %s {\n' "$t" "$t" "$t"
    printf '\tchain entrada {\n\t\ttype filter hook input priority -10; policy accept;\n'
    printf '\t\tiifname "lo" accept\n'
    [[ -n "$ifs" ]] && printf '\t\tiifname { %s } accept\n' "$ifs"
    [[ -n "$ips4" ]] && printf '\t\tip saddr { %s } tcp dport %s accept\n' "$ips4" "$PORTA_SSH"
    [[ -n "$ips6" ]] && printf '\t\tip6 saddr { %s } tcp dport %s accept\n' "$ips6" "$PORTA_SSH"
    [[ -n "$red4" ]] && printf '\t\tip saddr { %s } accept\n' "$red4"
    [[ -n "$red6" ]] && printf '\t\tip6 saddr { %s } accept\n' "$red6"
    printf '\t\t%s\n' "$nd"
    # Resposta a conexão que ESTE servidor abriu (direção reply) passa: sem isso o corte de entrada também
    # cortaria a saída (DNS, API das agentes). Com --isolar-saida, a chain de saída já barra o que não é
    # permitido, então só sobram respostas do que foi liberado. Conexão aberta de fora cai no drop.
    printf '\t\tct direction reply accept\n'
    printf '\t\tdrop\n\t}\n'
    printf '\tchain saida {\n\t\ttype filter hook output priority -10; policy accept;\n'
    printf '\t\toifname "lo" accept\n'
    [[ -n "$ifs" ]] && printf '\t\toifname { %s } accept\n' "$ifs"
    [[ -n "$ips4" ]] && printf '\t\tip daddr { %s } accept\n' "$ips4"
    [[ -n "$ips6" ]] && printf '\t\tip6 daddr { %s } accept\n' "$ips6"
    if ((ISOLAR)); then
      [[ -n "$red4" ]] && printf '\t\tip daddr { %s } accept\n' "$red4"
      [[ -n "$red6" ]] && printf '\t\tip6 daddr { %s } accept\n' "$red6"
      printf '\t\t%s\n' "$nd"
      # Tráfego do próprio tailscaled (WireGuard/DERP) sai pela interface pública com a marca 0x80000.
      printf '\t\tmeta mark & 0xff0000 == 0x80000 accept\n'
      printf '\t\tudp dport 53 accept\n\t\ttcp dport 53 accept\n\t\tdrop\n'
    fi
    printf '\t}\n'
    printf '\tchain encaminhamento {\n\t\ttype filter hook forward priority -10; policy accept;\n'
    # Porta publicada de container (DNAT) não pode continuar alcançável de fora durante o corte.
    printf '\t\tct direction original ct status dnat drop\n'
    if ((ISOLAR)); then
      [[ -n "$ifs" ]] && printf '\t\tiifname { %s } accept\n\t\toifname { %s } accept\n' "$ifs" "$ifs"
      [[ -n "$red4" ]] && printf '\t\tip saddr { %s } ip daddr { %s } accept\n' "$red4" "$red4"
      [[ -n "$red6" ]] && printf '\t\tip6 saddr { %s } ip6 daddr { %s } accept\n' "$red6" "$red6"
      printf '\t\tdrop\n'
    else
      # Modo padrão: o que é encaminhado também não pode ser alcançável de fora, com ou sem DNAT (container ou
      # VM com IPv6 roteado, por exemplo). Passam: respostas às conexões que os containers abriram, a
      # administração, o tráfego entre as redes internas e a saída dos containers para a internet.
      # Qualquer conexão nova vinda de fora para dentro cai no drop final.
      printf '\t\tct direction reply accept\n'
      [[ -n "$ifs" ]] && printf '\t\tiifname { %s } accept\n\t\toifname { %s } accept\n' "$ifs" "$ifs"
      [[ -n "$red4" ]] && printf '\t\tip saddr { %s } ip daddr { %s } accept\n' "$red4" "$red4"
      [[ -n "$red6" ]] && printf '\t\tip6 saddr { %s } ip6 daddr { %s } accept\n' "$red6" "$red6"
      [[ -n "$red4" ]] && printf '\t\tct direction original ip saddr { %s } accept\n' "$red4"
      [[ -n "$red6" ]] && printf '\t\tct direction original ip6 saddr { %s } accept\n' "$red6"
      printf '\t\tdrop\n'
    fi
    printf '\t}\n}\n'
  }
}

monta_plano() {
  local s timer
  PLANO=()
  timer="systemd-run --on-active=${PRAZO_CONFIRMAR_MIN}m --unit=$UNIDADE_TIMER"
  if [[ -n "${EMERGENCIA_CONF:-}" ]]; then timer+=" --setenv=EMERGENCIA_CONF=$EMERGENCIA_CONF"; fi
  if [[ -n "$RAIZ" ]]; then timer+=" --setenv=DGCLAW_RAIZ=$RAIZ"; fi
  PLANO+=("$timer $SELF religar --automatico --corte ${CORTE_ID:-ID-DO-CORTE}")
  for s in "${ATIVOS[@]}"; do PLANO+=("systemctl stop $s"); done
  PLANO+=("nft -f $ARQ_NFT")
  NFT_TEXTO="$(monta_nft)"
}

# Uma operação que muda o estado por vez: o religar manual e o automático (ou dois cortes) não se atropelam.
# Quem chegou depois espera até 30 s, e depois da trava confere o estado de novo.
pega_trava() {
  local arq="$ESTADO_DIR/.trava"
  exec {TRAVA_FD}>"$arq" || falhar "não consegui abrir o arquivo de trava $arq. Confira a permissão de $ESTADO_DIR."
  if ! flock -n "$TRAVA_FD"; then
    ESPEROU_TRAVA=1
    log "outra operação de emergência está em andamento; esperando até 30 s"
    flock -w 30 "$TRAVA_FD" \
      || falhar "outra operação de emergência continua em andamento depois de 30 s ($arq). Nada foi mudado. Veja $ESTADO_DIR/emergencia.log e tente de novo."
  fi
}

# ---------- estado ----------

CORTADO=0; DESDE=""; QUEM_CORTOU=""; ISOLAR_MARCA=""; CONFIRMADO=0; TIMER_ATIVO=0; EXPIRA=""
INCONSISTENTE=0; MOTIVO_INCONSISTENTE=""

# O marcador `cortado` diz o que foi pedido; o firewall efetivo diz o que está valendo. O corte não sobrevive a um
# reinício (por desenho): o marcador fica e a tabela nft some, o servidor está exposto e o marcador mentiria.
le_estado() {
  local prazo epoch
  CORTADO=0; DESDE=""; QUEM_CORTOU=""; ISOLAR_MARCA=""; CONFIRMADO=0; TIMER_ATIVO=0; EXPIRA=""
  INCONSISTENTE=0; MOTIVO_INCONSISTENTE=""
  if [[ -f "$ESTADO_DIR/cortado" ]]; then
    CORTADO=1
    if ! nft list table inet "$NFT_TABELA" >/dev/null 2>&1; then
      INCONSISTENTE=1
      MOTIVO_INCONSISTENTE="o marcador diz que está cortado, mas a tabela nft $NFT_TABELA não está carregada (o servidor provavelmente reiniciou): a rede NÃO está protegida pelo corte"
    fi
    DESDE="$(marcador_valor desde)"
    QUEM_CORTOU="$(marcador_valor quem)"
    ISOLAR_MARCA="$(marcador_valor isolar_saida)"
    prazo="$(marcador_valor prazo_min)"
    epoch="$(marcador_valor epoch)"
    [[ -f "$ESTADO_DIR/confirmado" ]] && CONFIRMADO=1
    if [[ "$epoch" =~ ^[0-9]+$ && "$prazo" =~ ^[0-9]+$ ]]; then
      EXPIRA="$(date -u -d "@$((epoch + prazo * 60))" '+%Y-%m-%dT%H:%M:%SZ')"
    fi
  fi
  if systemctl is-active --quiet "$UNIDADE_TIMER.timer" 2>/dev/null; then TIMER_ATIVO=1; fi
}

json_estado() {
  local k
  printf '{"cortado":%s,"inconsistente":%s,"motivo_inconsistente":%s,"desde":%s,"quem":%s,"isolar_saida":%s,"confirmado":%s,"religar_automatico_agendado":%s,"religar_automatico_em":%s,"servicos":[' \
    "$(json_bool "$CORTADO")" "$(json_bool "$INCONSISTENTE")" "$(json_s "$MOTIVO_INCONSISTENTE")" "$(json_s "$DESDE")" "$(json_s "$QUEM_CORTOU")" \
    "$([[ "$ISOLAR_MARCA" == "1" ]] && echo true || echo false)" "$(json_bool "$CONFIRMADO")" \
    "$(json_bool "$TIMER_ATIVO")" "$(json_s "$EXPIRA")"
  for k in "${!SERVICOS[@]}"; do
    ((k > 0)) && printf ','
    printf '{"nome":%s,"ativo":%s}' "$(json_s "${SERVICOS[$k]}")" "$(servico_ativo "${SERVICOS[$k]}" && echo true || echo false)"
  done
  printf ']}'
}

json_plano() {
  printf '{"recusado":%s,"problemas":%s,"avisos":%s,"isolar_saida":%s,"prazo_min":%s,"servicos_a_parar":%s,"comandos":%s,"regras_nft":%s}' \
    "$(json_bool "${#PROBLEMAS[@]}")" "$(json_arr "${PROBLEMAS[@]}")" "$(json_arr "${AVISOS[@]}")" \
    "$(json_bool "$ISOLAR")" "$PRAZO_CONFIRMAR_MIN" "$(json_arr "${ATIVOS[@]}")" "$(json_arr "${PLANO[@]}")" "$(json_s "$NFT_TEXTO")"
}

# Grava o retrato que o painel lê (web/lib/ronda-painel.js). Falha aqui nunca derruba o comando.
grava_web() {
  local dir tmp motivo=""
  dir="$(dirname "$ARQ_WEB")"
  prechecagens
  coleta_ativos
  monta_plano
  le_estado
  if ((${#PROBLEMAS[@]})); then motivo="${PROBLEMAS[*]}"; fi
  if ! { mkdir -p "$dir" 2>/dev/null || true; [[ -d "$dir" ]]; }; then
    aviso "não consegui criar $dir; o painel não vai ver o estado da emergência. Rode como root."
    return 0
  fi
  tmp="$ARQ_WEB.$$.tmp"
  if ! {
    printf '{"versao":1,"atualizado_em":%s,"disponivel":%s,"motivo":%s,"avisos":%s,"estado":' \
      "$(json_s "$(agora_iso)")" "$(json_bool "$((${#PROBLEMAS[@]} == 0))")" "$(json_s "$motivo")" "$(json_arr "${AVISOS[@]}")"
    json_estado
    printf ',"plano":'
    json_plano
    printf '}\n'
  } >"$tmp" 2>/dev/null || ! chmod 644 "$tmp" || ! mv "$tmp" "$ARQ_WEB"; then
    rm -f "$tmp"
    aviso "não consegui gravar $ARQ_WEB; o painel pode mostrar o estado antigo da emergência. Confira o espaço e as permissões de $dir."
  fi
  return 0
}

cmd_estado() {
  carrega_conf
  le_estado
  if ((JSON)); then
    json_estado
    printf '\n'
    grava_web
    return 0
  fi
  local k
  if ((CORTADO && INCONSISTENTE)); then
    echo "Estado: INCONSISTENTE. Registrado como cortado desde $DESDE (pedido por $QUEM_CORTOU), mas $MOTIVO_INCONSISTENTE."
    echo "Para recarregar o corte: '$PROG preparar' e '$PROG cortar --codigo <código>'. Para dar o corte por encerrado: '$PROG religar --codigo <código>'."
  elif ((CORTADO)); then
    echo "Estado: CORTADO desde $DESDE (pedido por $QUEM_CORTOU; saída isolada: $([[ "$ISOLAR_MARCA" == 1 ]] && echo sim || echo não))"
    if ((CONFIRMADO)); then
      echo "Confirmação: feita. O corte fica até alguém rodar o religar (e volta sozinho se o servidor reiniciar)."
    elif ((TIMER_ATIVO)); then
      echo "Confirmação: PENDENTE. Se ninguém rodar '$PROG confirmar', o sistema religa sozinho em $EXPIRA."
    else
      echo "Confirmação: pendente, mas o timer de religar automático NÃO está ativo. Rode '$PROG preparar' e depois '$PROG religar --codigo <código>' para voltar ao normal."
    fi
  else
    echo "Estado: NORMAL (não está cortado)"
  fi
  echo "Serviços públicos:"
  for k in "${!SERVICOS[@]}"; do
    echo "  ${SERVICOS[$k]}: $(servico_ativo "${SERVICOS[$k]}" && echo ativo || echo parado)"
  done
  grava_web
}

# ---------- simular ----------

cmd_simular() {
  carrega_conf
  prechecagens
  coleta_ativos
  monta_plano
  local p n=0
  if ((JSON)); then
    json_plano
    printf '\n'
    grava_web
    return 0
  fi
  echo "SIMULAÇÃO: nada foi executado."
  if ((${#PROBLEMAS[@]})); then
    for p in "${PROBLEMAS[@]}"; do echo "O corte seria recusado porque $p"; done
  else
    echo "Pré-checagens: tudo certo, o corte seria aceito."
  fi
  for p in "${AVISOS[@]}"; do echo "Atenção: $p"; done
  echo "Serviços públicos ativos que seriam parados: ${ATIVOS[*]:-nenhum}"
  echo "Sequência exata que o 'cortar' executaria:"
  for p in "${PLANO[@]}"; do
    n=$((n + 1))
    printf '  %2d. %s\n' "$n" "$p"
  done
  echo "Arquivo nft que o passo final carregaria ($ARQ_NFT):"
  while IFS= read -r p; do printf '    | %s\n' "$p"; done <<<"$NFT_TEXTO"
  echo "Antes disso, o estado atual (nft list ruleset e serviços) seria guardado em $ESTADO_DIR/antes/."
  grava_web
}

# ---------- código de uso único (dupla confirmação) ----------

hash_codigo() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }

cmd_preparar() {
  carrega_conf
  exige_root preparar
  garante_estado_dir
  pega_trava
  prechecagens
  coleta_ativos
  monta_plano
  le_estado
  if { ! ((CORTADO)) || ((INCONSISTENTE)); } && ((${#PROBLEMAS[@]})); then
    local p
    for p in "${PROBLEMAS[@]}"; do erro "não dá para preparar o corte porque $p"; done
    log "preparar recusado: ${PROBLEMAS[*]}"
    exit 1
  fi
  local codigo expira_epoch dir acao
  codigo="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' | head -c 6)" || codigo=""
  [[ "${#codigo}" -eq 6 ]] || falhar "não consegui gerar o código (/dev/urandom não respondeu como esperado). Tente de novo."
  expira_epoch=$(($(date +%s) + VALIDADE_CODIGO_S))
  dir="$(dirname "$ARQ_CODIGO")"
  { mkdir -p "$dir" && chmod 700 "$dir"; } || falhar "não consegui criar $dir para guardar o código."
  printf '%s\n%s\n0\n' "$(hash_codigo "$codigo")" "$expira_epoch" >"$ARQ_CODIGO" \
    || falhar "não consegui gravar $ARQ_CODIGO."
  chmod 600 "$ARQ_CODIGO" || falhar "não consegui aplicar chmod 600 em $ARQ_CODIGO."
  if ((CORTADO && ! INCONSISTENTE)); then acao="religar"; else acao="cortar"; fi
  log "código de confirmação gerado para $acao (vale $VALIDADE_CODIGO_S s)"
  local expira_iso
  expira_iso="$(date -u -d "@$expira_epoch" '+%Y-%m-%dT%H:%M:%SZ')"
  if ((JSON)); then
    printf '{"acao":%s,"codigo":%s,"expira_em":%s,"valido_s":%s,"plano":' \
      "$(json_s "$acao")" "$(json_s "$codigo")" "$(json_s "$expira_iso")" "$VALIDADE_CODIGO_S"
    json_plano
    printf '}\n'
  else
    echo "Código de uso único: $codigo (vale $((VALIDADE_CODIGO_S / 60)) min, até $expira_iso)"
    if [[ "$acao" == "cortar" ]]; then
      echo "Para tirar do ar: $PROG cortar --codigo $codigo"
      local n=0
      echo "Sequência exata que o corte executa:"
      for p in "${PLANO[@]}"; do n=$((n + 1)); printf '  %2d. %s\n' "$n" "$p"; done
    else
      echo "Já está cortado. Para religar: $PROG religar --codigo $codigo"
    fi
    if ((CORTADO && INCONSISTENTE)); then
      echo "ATENÇÃO: $MOTIVO_INCONSISTENTE."
      echo "Para recarregar o corte: $PROG cortar --codigo $codigo (o mesmo código serve para '$PROG religar --codigo $codigo', se preferir encerrar o corte)."
    fi
  fi
  grava_web
}

# Confere o código e o gasta. Código errado conta tentativa; depois de $MAX_TENTATIVAS erros ele é descartado.
exige_codigo() {
  local acao="$1" hash expira tent dado
  [[ -n "$CODIGO" ]] || falhar "faltou o código. Rode '$PROG preparar' para gerar um (vale $((VALIDADE_CODIGO_S / 60)) min) e depois '$PROG $acao --codigo <código>'. Nada foi mudado."
  [[ -f "$ARQ_CODIGO" ]] || falhar "não há código pedido (falta $ARQ_CODIGO). Rode '$PROG preparar'. Nada foi mudado."
  { read -r hash && read -r expira && read -r tent; } <"$ARQ_CODIGO" \
    || { rm -f "$ARQ_CODIGO"; falhar "o arquivo do código estava corrompido e foi descartado. Rode '$PROG preparar' de novo. Nada foi mudado."; }
  if [[ ! "$expira" =~ ^[0-9]+$ || ! "$tent" =~ ^[0-9]+$ ]] || (($(date +%s) > expira)); then
    rm -f "$ARQ_CODIGO"
    falhar "o código venceu (ele vale $((VALIDADE_CODIGO_S / 60)) min). Rode '$PROG preparar' de novo. Nada foi mudado."
  fi
  dado="${CODIGO^^}"
  if [[ "$(hash_codigo "$dado")" != "$hash" ]]; then
    tent=$((tent + 1))
    if ((tent >= MAX_TENTATIVAS)); then
      rm -f "$ARQ_CODIGO"
      log "código errado ($tent tentativas): descartado"
      falhar "o código não confere e já foram $tent tentativas: ele foi descartado. Rode '$PROG preparar' de novo. Nada foi mudado."
    fi
    printf '%s\n%s\n%s\n' "$hash" "$expira" "$tent" >"$ARQ_CODIGO"
    log "código errado ($tent de $MAX_TENTATIVAS)"
    falhar "o código não confere (tentativa $tent de $MAX_TENTATIVAS). Nada foi mudado."
  fi
  rm -f "$ARQ_CODIGO"
}

# ---------- cortar ----------

# Identifica cada corte. O timer carrega o id do corte que o agendou: se o corte atual for outro, o timer é de um
# corte ultrapassado e não pode desfazer o novo.
novo_id_corte() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }

guarda_estado() {
  local d="$ESTADO_DIR/antes" s
  { mkdir -p "$d" && chmod 700 "$d"; } || falhar "não consegui criar $d."
  nft list ruleset >"$d/nft-ruleset.txt" 2>&1 || falhar "nft list ruleset falhou; nada foi mudado. Veja a saída em $d/nft-ruleset.txt."
  : >"$d/servicos.txt"
  for s in "${SERVICOS[@]}"; do
    printf '%s|%s|%s\n' "$s" \
      "$(servico_ativo "$s" && echo ativo || echo parado)" \
      "$(systemctl is-enabled --quiet "$s" 2>/dev/null && echo habilitado || echo desabilitado)" >>"$d/servicos.txt"
  done
  printf 'data=%s\nquem=%s\n' "$(agora_iso)" "$QUEM" >"$d/carimbo.txt"
}

executa() {
  local cmd="$1" argv saida rc=0
  read -ra argv <<<"$cmd"
  log "executando: $cmd"
  saida="$("${argv[@]}" 2>&1)" || rc=$?
  if ((rc != 0)); then
    log "FALHOU (exit $rc): $cmd | $saida"
    return "$rc"
  fi
  return 0
}

# Um passo do corte falhou (ex.: o nft não carregou depois de parar os serviços): volta ao que era antes, em vez de
# deixar serviços parados e/ou marcador de corte sem firewall.
desfaz_corte_parcial() {
  local s falhas=()
  systemctl stop "$UNIDADE_TIMER.timer" >/dev/null 2>&1 || true
  if nft list table inet "$NFT_TABELA" >/dev/null 2>&1; then
    nft delete table inet "$NFT_TABELA" >/dev/null 2>&1 || falhas+=("apagar a tabela nft $NFT_TABELA")
  fi
  for s in "${ATIVOS[@]}"; do
    systemctl start "$s" >/dev/null 2>&1 || falhas+=("religar o serviço $s")
  done
  if ((${#falhas[@]})); then
    log "desfazer corte parcial: FALHOU em: ${falhas[*]}"
    erro "não consegui desfazer tudo (${falhas[*]}). O marcador de corte foi mantido: rode '$PROG preparar' e '$PROG religar --codigo <código>'. Detalhes em $ESTADO_DIR/emergencia.log."
    return 0
  fi
  rm -f "$ESTADO_DIR/cortado" "$ESTADO_DIR/confirmado"
  log "corte parcial desfeito: serviços religados e marcador apagado"
  erro "O corte NÃO foi feito: o que já tinha sido mudado foi desfeito (serviços religados, marcador apagado). Veja $ESTADO_DIR/emergencia.log, corrija a causa e rode '$PROG preparar' e '$PROG cortar' de novo."
}

cmd_cortar() {
  carrega_conf
  exige_root cortar
  garante_estado_dir
  pega_trava
  le_estado
  if ((CORTADO && ! INCONSISTENTE)); then
    falhar "já está cortado desde $DESDE. Use '$PROG estado' ou '$PROG religar'. Nada foi mudado."
  fi
  exige_codigo cortar
  prechecagens
  if ((${#PROBLEMAS[@]})); then
    local p
    for p in "${PROBLEMAS[@]}"; do erro "corte recusado porque $p"; done
    log "corte recusado: ${PROBLEMAS[*]}"
    erro "Nada foi mudado. Rode '$PROG simular' para ver o quadro completo."
    exit 1
  fi
  coleta_ativos
  if ((CORTADO)); then
    # Reaplicar um corte que perdeu a tabela: o snapshot de `antes/` e a lista original de serviços parados são o que
    # o religar usa, então ficam como estão. Só se para de novo o que estava na lista original e o que subiu desde então.
    [[ -f "$ESTADO_DIR/antes/servicos.txt" ]] \
      || falhar "o corte anterior não deixou o estado guardado ($ESTADO_DIR/antes/servicos.txt): reaplicar apagaria a única referência do que religar. Nada foi mudado. Suba à mão o que for preciso (systemctl start caddy cloudflared) e apague $ESTADO_DIR/cortado."
    local orig dup s
    for orig in $(marcador_valor servicos_parados); do
      dup=0
      for s in "${ATIVOS[@]}"; do [[ "$s" == "$orig" ]] && dup=1; done
      ((dup)) || ATIVOS+=("$orig")
    done
  fi
  CORTE_ID="$(novo_id_corte)"
  [[ "$CORTE_ID" =~ ^[0-9a-f]{16}$ ]] || falhar "não consegui gerar o identificador do corte (/dev/urandom). Nada foi mudado."
  monta_plano
  if ((! CORTADO)); then guarda_estado; fi
  printf '%s\n' "$NFT_TEXTO" >"$ARQ_NFT" || falhar "não consegui gravar $ARQ_NFT. Nada foi mudado."
  local saida_nft
  saida_nft="$(nft -c -f "$ARQ_NFT" 2>&1)" \
    || falhar "o nft recusou as regras de $ARQ_NFT (nft -c -f): $saida_nft. Nada foi mudado. Confira INTERFACES_ADMIN, IPS_ADMIN e REDES_INTERNAS em /etc/dgclaw/emergencia.conf."
  if ((CORTADO)); then
    # corte antigo que perdeu a tabela nft (reinício): recarrega, mantendo o "antes" original
    log "recarregando corte inconsistente de $DESDE: $MOTIVO_INCONSISTENTE"
    rm -f "$ESTADO_DIR/confirmado" "$ESTADO_DIR/cortado"
  fi
  log "corte iniciado (isolar_saida=$ISOLAR, servicos: ${ATIVOS[*]:-nenhum}, prazo ${PRAZO_CONFIRMAR_MIN} min)"

  if ! executa "${PLANO[0]}"; then
    falhar "não consegui agendar o religar automático (${PLANO[0]}). Por segurança o corte NÃO foi feito e nada foi mudado. Veja $ESTADO_DIR/emergencia.log. Se já existir um timer antigo, rode: systemctl stop $UNIDADE_TIMER.timer"
  fi
  {
    printf 'desde=%s\nepoch=%s\nquem=%s\nisolar_saida=%s\nprazo_min=%s\nservicos_parados=%s\ncorte_id=%s\n' \
      "$(agora_iso)" "$(date +%s)" "$QUEM" "$ISOLAR" "$PRAZO_CONFIRMAR_MIN" "${ATIVOS[*]:-}" "$CORTE_ID"
  } >"$ESTADO_DIR/cortado" || falhar "não consegui gravar $ESTADO_DIR/cortado. Rode '$PROG preparar' e '$PROG religar --codigo <código>' para garantir que está tudo normal."

  local k
  for ((k = 1; k < ${#PLANO[@]}; k++)); do
    if ! executa "${PLANO[$k]}"; then
      erro "o passo falhou: ${PLANO[$k]}. Vou desfazer o que o corte já fez."
      desfaz_corte_parcial
      grava_web
      exit 1
    fi
  done
  log "corte concluído"
  echo "Máquina cortada. Do seu aparelho de administração (Tailscale), rode em até ${PRAZO_CONFIRMAR_MIN} min: sudo $PROG confirmar"
  echo "Se ninguém confirmar, o sistema religa sozinho. Para religar já: $PROG preparar e depois $PROG religar --codigo <código>"
  grava_web
}

# ---------- confirmar ----------

cmd_confirmar() {
  carrega_conf
  exige_root confirmar
  garante_estado_dir
  pega_trava
  [[ -f "$ESTADO_DIR/cortado" ]] || falhar "não há corte ativo para confirmar (falta $ESTADO_DIR/cortado). Nada foi mudado."
  if [[ -f "$ESTADO_DIR/confirmado" ]]; then
    echo "O corte já estava confirmado."
    return 0
  fi
  if ! systemctl is-active --quiet "$UNIDADE_TIMER.timer"; then
    falhar "o timer $UNIDADE_TIMER.timer não está ativo (talvez o prazo já passou ou o agendamento falhou). Não dá para confirmar. Rode '$PROG preparar' e '$PROG religar --codigo <código>' para voltar ao normal."
  fi
  [[ -s "$ARQ_NFT" ]] || falhar "falta o arquivo nft guardado ($ARQ_NFT): sem ele não dá para confirmar o corte. O religar automático continua agendado. Rode '$PROG preparar' e '$PROG religar --codigo <código>'."
  # Só confirma corte COMPLETO: o firewall carregado e os serviços públicos parados de fato. Um corte pela metade
  # confirmado cancelaria o religar automático e deixaria o servidor exposto.
  local faltas=() s tabela
  if ! tabela="$(nft list table inet "$NFT_TABELA" 2>/dev/null)"; then
    faltas+=("a tabela nft $NFT_TABELA não está carregada")
  else
    for s in entrada saida encaminhamento; do
      grep -q "chain $s" <<<"$tabela" || faltas+=("falta a chain $s na tabela nft")
    done
  fi
  for s in $(marcador_valor servicos_parados); do
    if servico_ativo "$s"; then faltas+=("o serviço $s continua rodando"); fi
  done
  if ((${#faltas[@]})); then
    local juntas="${faltas[0]}" f
    for f in "${faltas[@]:1}"; do juntas+="; $f"; done
    log "confirmar recusado: corte incompleto: $juntas"
    falhar "o corte não se completou: $juntas; o religar automático continua agendado. Rode '$PROG preparar' e '$PROG cortar --codigo <código>' de novo, ou '$PROG religar --codigo <código>'."
  fi
  systemctl stop "$UNIDADE_TIMER.timer" \
    || falhar "não consegui parar $UNIDADE_TIMER.timer; o religar automático continua agendado. Rode: systemctl stop $UNIDADE_TIMER.timer"
  agora_iso >"$ESTADO_DIR/confirmado"
  log "corte confirmado; religar automático cancelado"
  echo "Corte confirmado. O religar automático foi cancelado e o corte vale até o próximo reinício do servidor (depois dele, reaplique). Para voltar ao normal: $PROG preparar e depois $PROG religar --codigo <código>"
  grava_web
}

# ---------- religar ----------

cmd_religar() {
  carrega_conf
  exige_root religar
  garante_estado_dir
  pega_trava
  if [[ ! -f "$ESTADO_DIR/cortado" ]]; then
    if ((AUTO || ESPEROU_TRAVA)); then
      log "religar: já estava religado (outra operação terminou antes), nada a fazer"
      echo "Já estava religado: nada a fazer."
      return 0
    fi
    falhar "não há corte ativo (falta $ESTADO_DIR/cortado). Nada foi mudado."
  fi
  if ((AUTO)); then
    # Já dentro da trava: o estado de agora manda, não o do momento em que o timer disparou.
    if [[ -f "$ESTADO_DIR/confirmado" ]]; then
      log "religar automático: o corte foi confirmado enquanto esperava a trava, nada a fazer"
      echo "O corte já foi confirmado: o religar automático não faz nada."
      return 0
    fi
    if [[ -n "$CORTE_ARG" && "$CORTE_ARG" != "$(marcador_valor corte_id)" ]]; then
      log "religar automático: o timer é do corte $CORTE_ARG, o corte atual é outro ($(marcador_valor corte_id)); nada a fazer"
      echo "Este religar automático era de um corte anterior: nada a fazer."
      return 0
    fi
  else
    exige_codigo religar
  fi
  local d="$ESTADO_DIR/antes"
  log "religar iniciado$( ((AUTO)) && echo ' (automático, prazo de confirmação vencido)')"

  if ! ((AUTO)) && systemctl is-active --quiet "$UNIDADE_TIMER.timer"; then
    systemctl stop "$UNIDADE_TIMER.timer" || aviso "não consegui parar $UNIDADE_TIMER.timer; ele vai tentar religar de novo e dirá que já estava religado."
  fi

  local saida falhas=() relatorio=()
  if nft list table inet "$NFT_TABELA" >/dev/null 2>&1; then
    if ! saida="$(nft delete table inet "$NFT_TABELA" 2>&1)"; then
      log "FALHOU ao apagar a tabela $NFT_TABELA: $saida"
      falhar "não consegui apagar a tabela nft $NFT_TABELA ($saida). O marcador de corte foi mantido. Rode 'nft delete table inet $NFT_TABELA' à mão e o religar de novo."
    fi
    log "tabela nft $NFT_TABELA removida"
  else
    log "tabela nft $NFT_TABELA já não existia"
  fi
  if nft list table inet "$NFT_TABELA" >/dev/null 2>&1; then
    falhar "a tabela nft $NFT_TABELA ainda existe depois da remoção. O marcador de corte foi mantido. Confira com 'nft list ruleset'."
  fi
  [[ -d "$d" && -f "$d/servicos.txt" ]] \
    || falhar "a rede já foi religada, mas o estado guardado antes do corte não está em $d: não sei quais serviços religar. Suba à mão (systemctl start caddy cloudflared) e apague o marcador $ESTADO_DIR/cortado."

  local linha nome ativo _hab
  while IFS='|' read -r nome ativo _hab; do
    [[ -n "$nome" && "$ativo" == "ativo" ]] || continue
    if ! saida="$(systemctl start "$nome" 2>&1)"; then
      falhas+=("systemctl start $nome: $saida")
    fi
  done <"$d/servicos.txt"

  sleep "${EMERGENCIA_ESPERA:-3}"
  while IFS='|' read -r nome ativo _hab; do
    [[ -n "$nome" && "$ativo" == "ativo" ]] || continue
    if servico_ativo "$nome"; then
      relatorio+=("voltou: serviço $nome ativo")
    else
      relatorio+=("NÃO voltou: serviço $nome não está ativo. Veja: journalctl -u $nome -n 50")
      falhas+=("serviço $nome")
    fi
  done <"$d/servicos.txt"
  local url
  for url in "${URLS[@]}"; do
    if saida="$(curl -fsS --max-time 10 -o /dev/null "$url" 2>&1)"; then
      relatorio+=("voltou: $url respondeu")
    else
      relatorio+=("NÃO voltou: $url não respondeu (${saida}). Confira o Caddy e o servidor por trás dele.")
      falhas+=("url $url")
    fi
  done

  local stamp hist
  stamp="$(date '+%Y%m%dT%H%M%S')"
  hist="$ESTADO_DIR/historico/$stamp"
  { mkdir -p "$ESTADO_DIR/historico" && chmod 700 "$ESTADO_DIR/historico"; } || aviso "não consegui criar a pasta de histórico."
  mv "$d" "$hist" || aviso "não consegui mover $d para $hist."
  mv "$ESTADO_DIR/cortado" "$hist/cortado" || aviso "não consegui guardar o marcador no histórico."
  if [[ -f "$ARQ_NFT" ]]; then mv "$ARQ_NFT" "$hist/emergencia.nft" || aviso "não consegui guardar $ARQ_NFT no histórico."; fi
  if [[ -f "$ESTADO_DIR/confirmado" ]]; then mv "$ESTADO_DIR/confirmado" "$hist/confirmado" || aviso "não consegui guardar o marcador 'confirmado'."; fi
  printf '%s\n' "${relatorio[@]:-}" "${falhas[@]:-}" >"$hist/resultado.txt" || aviso "não consegui gravar $hist/resultado.txt."

  echo "Relatório do religar:"
  for linha in "${relatorio[@]:-}"; do [[ -n "$linha" ]] && echo "  $linha"; done
  grava_web
  if ((${#falhas[@]})); then
    log "religar terminou com falhas: ${falhas[*]}"
    erro "o religar terminou, mas algo não voltou: ${falhas[*]}. O firewall já está restaurado. Histórico em $hist."
    exit 1
  fi
  log "religar concluído, tudo voltou"
  echo "Tudo voltou ao normal. Histórico em $hist."
}

# ---------- entrada ----------

main() {
  local cmd="${1:-}"
  if [[ -z "$cmd" || "$cmd" == "-h" || "$cmd" == "--help" ]]; then uso; [[ -n "$cmd" ]] && return 0; exit 1; fi
  shift
  while (($#)); do
    case "$1" in
      --codigo)
        (($# >= 2)) || falhar "--codigo precisa de um valor (o código que o '$PROG preparar' mostrou)."
        CODIGO="$2"; shift 2 ;;
      --isolar-saida) ISOLAR=1; shift ;;
      --json) JSON=1; shift ;;
      --automatico) AUTO=1; shift ;;
      --corte)
        (($# >= 2)) || falhar "--corte precisa de um valor (o id do corte que agendou o religar automático)."
        [[ "$2" =~ ^[0-9a-f]{16}$ ]] || falhar "--corte '$2' não é um id de corte válido (16 caracteres hexadecimais)."
        CORTE_ARG="$2"; shift 2 ;;
      *) uso >&2; falhar "opção desconhecida '$1' para o comando '$cmd'." ;;
    esac
  done
  case "$cmd" in
    estado) cmd_estado ;;
    simular) cmd_simular ;;
    preparar) cmd_preparar ;;
    cortar) cmd_cortar ;;
    confirmar) cmd_confirmar ;;
    religar) cmd_religar ;;
    *) uso >&2; falhar "comando desconhecido '$cmd'." ;;
  esac
}

main "$@"
