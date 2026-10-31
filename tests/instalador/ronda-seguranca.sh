# shellcheck shell=bash
# shellcheck disable=SC2034
# Casos da RONDA DE SEGURANCA no instalador (carregado com source por rodar.sh, junto de casos.sh): as unidades,
# o endurecimento possivel, os horarios do dgclaw.env, o desligar e a atualizacao (que roda o instalador de novo).

caso_ronda_instala_as_unidades_e_liga_tudo() {
    novo_cenario
    afirma "a instalacao termina" instalacao_basica
    local u="$RAIZ/etc/systemd/system" s
    s="$u/dgclaw-ronda.service"
    afirma "servico da ronda existe" test -f "$s"
    afirma "oneshot" tem "$s" "Type=oneshot"
    afirma "como root" tem "$s" "User=root"
    afirma "roda o motor do app instalado" tem "$s" "ExecStart=/usr/bin/python3 -I /opt/dgclaw/app/seguranca/ronda/ronda.py executar"
    for linha in NoNewPrivileges=yes ProtectHome=read-only PrivateTmp=yes ProtectControlGroups=yes ProtectKernelModules=yes LockPersonality=yes; do
        afirma "endurecimento da ronda: $linha" tem "$s" "$linha"
    done
    nega "a ronda nao pode ter RestrictSUIDSGID (o apt do catalogo atualiza pacote com binario setuid)" tem "$s" "RestrictSUIDSGID"
    nega "a ronda nao pode ter ProtectKernelTunables (o sysctl do catalogo precisa escrever em /proc/sys)" tem "$s" "ProtectKernelTunables"
    nega "a ronda nao pode ter ProtectSystem=strict (o apt e o nft do catalogo precisam escrever em /usr e /etc)" tem "$s" "ProtectSystem"
    local t="$u/dgclaw-ronda.timer"
    afirma "timer da ronda existe" test -f "$t"
    for linha in "OnCalendar=*-*-* 07:00:00" "OnCalendar=*-*-* 13:00:00" "OnCalendar=*-*-* 19:00:00" RandomizedDelaySec=20min Persistent=true Unit=dgclaw-ronda.service; do
        afirma "timer: $linha" tem "$t" "$linha"
    done
    afirma "vigia de hora em hora" tem "$u/dgclaw-ronda-vigia.timer" "OnCalendar=hourly"
    afirma "vigia roda o subcomando vigiar" tem "$u/dgclaw-ronda-vigia.service" "ronda.py vigiar"
    afirma "inventario a cada 3 dias" tem "$u/dgclaw-ronda-inventario.timer" "OnUnitActiveSec=3d"
    afirma "o inventario nao aplica nada: sistema de arquivos so leitura" tem "$u/dgclaw-ronda-inventario.service" "ProtectSystem=strict"
    afirma "o inventario, que nao instala nada, leva RestrictSUIDSGID" tem "$u/dgclaw-ronda-inventario.service" "RestrictSUIDSGID=yes"
    afirma "o inventario escreve so na pasta da ronda e no log" tem "$u/dgclaw-ronda-inventario.service" "ReadWritePaths=/var/lib/dgclaw/seguranca /var/log/dgclaw"
    afirma "path vigia a pasta de pedidos do painel" tem "$u/dgclaw-seguranca-pedidos.path" "PathChanged=/var/lib/dgclaw/web/seguranca/pedidos"
    afirma "o path cria a pasta se faltar, com 0700" tem "$u/dgclaw-seguranca-pedidos.path" "MakeDirectory=yes"
    nega "DirectoryNotEmpty religaria o executor sem parar (feitos/ mora dentro da pasta)" tem "$u/dgclaw-seguranca-pedidos.path" "DirectoryNotEmpty"
    afirma "o executor roda a fila inteira pela CLI, como root" tem "$u/dgclaw-seguranca-pedidos.service" "ExecStart=/usr/local/bin/dgclaw seguranca pedido-todos"
    afirma "o executor e root" tem "$u/dgclaw-seguranca-pedidos.service" "User=root"
    afirma "o estado da emergencia vem do dgclaw emergencia estado" tem "$u/dgclaw-emergencia-estado.service" "ExecStart=/usr/local/bin/dgclaw emergencia estado"
    afirma "a cada 10 minutos" tem "$u/dgclaw-emergencia-estado.timer" "OnUnitActiveSec=10min"
    for unidade in dgclaw-ronda.timer dgclaw-ronda-vigia.timer dgclaw-ronda-inventario.timer dgclaw-seguranca-pedidos.path dgclaw-emergencia-estado.timer; do
        afirma "$unidade foi ligada" tem "$STUB_LOG" "systemctl enable $unidade"
    done
    afirma "dispara uma rodada logo depois de instalar" tem "$STUB_LOG" "systemctl start --no-block dgclaw-ronda.service"
    afirma "pasta de estado com modo 700" modo_e "$RAIZ/var/lib/dgclaw/seguranca" 700
    afirma "pasta de pedidos com modo 700" modo_e "$RAIZ/var/lib/dgclaw/web/seguranca/pedidos" 700
    afirma "pasta de resultados dos pedidos existe" test -d "$RAIZ/var/lib/dgclaw/web/seguranca/pedidos/feitos"
    nega "o instalador nao cria a linha DGCLAW_RONDA_SEGURANCA (padrao = ligada)" grep -q '^DGCLAW_RONDA_SEGURANCA=' "$RAIZ/etc/dgclaw/dgclaw.env"
    nega "nem a de horarios" grep -q '^DGCLAW_RONDA_HORARIOS=' "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_ronda_horarios_vem_do_dgclaw_env() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_RONDA_HORARIOS="06:30 18:45"\nDGCLAW_VERSAO=0.9\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina" instalacao_basica
    local t="$RAIZ/etc/systemd/system/dgclaw-ronda.timer"
    afirma "primeiro horario" tem "$t" "OnCalendar=*-*-* 06:30:00"
    afirma "segundo horario" tem "$t" "OnCalendar=*-*-* 18:45:00"
    nega "o padrao nao sobra" tem "$t" "07:00:00"
    afirma "a linha do dono sobreviveu" grep -qx 'DGCLAW_RONDA_HORARIOS="06:30 18:45"' "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_ronda_horario_invalido_usa_o_padrao_e_avisa() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_RONDA_HORARIOS="7h 25:00"\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina mesmo assim" instalacao_basica
    afirma "usou o padrao" tem "$RAIZ/etc/systemd/system/dgclaw-ronda.timer" "OnCalendar=*-*-* 13:00:00"
    afirma "a saida explica o que corrigir" tem "$SAIDA" "DGCLAW_RONDA_HORARIOS"
    limpar_cenario
}

caso_ronda_desligada_no_dgclaw_env_nao_liga_nada_e_preserva_as_linhas() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_RONDA_SEGURANCA=0\nLINHA_DA_MARTA=oi\nDGCLAW_VERSAO=0.9\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina" instalacao_basica
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a linha que desliga a ronda sobreviveu, uma so" igual 1 "$(grep -c '^DGCLAW_RONDA_SEGURANCA=0$' "$env")"
    afirma "a linha alheia sobreviveu" grep -qx 'LINHA_DA_MARTA=oi' "$env"
    afirma "as unidades foram instaladas mesmo assim" test -f "$RAIZ/etc/systemd/system/dgclaw-ronda.timer"
    for unidade in dgclaw-ronda.timer dgclaw-ronda-vigia.timer dgclaw-ronda-inventario.timer dgclaw-seguranca-pedidos.path dgclaw-emergencia-estado.timer; do
        nega "$unidade NAO foi ligada" tem "$STUB_LOG" "systemctl enable $unidade"
    done
    nega "nenhuma rodada foi disparada" tem "$STUB_LOG" "systemctl start --no-block dgclaw-ronda.service"
    afirma "todas foram desligadas" tem "$STUB_LOG" "systemctl disable --now dgclaw-ronda.timer dgclaw-ronda-vigia.timer dgclaw-ronda-inventario.timer dgclaw-seguranca-pedidos.path dgclaw-emergencia-estado.timer"
    afirma "a saida explica como ligar" tem "$SAIDA" "DGCLAW_RONDA_SEGURANCA"
    limpar_cenario
}

caso_ronda_atualizar_roda_de_novo_e_refaz_as_unidades() {
    novo_cenario
    afirma "a primeira instalacao termina" instalacao_basica
    local s="$RAIZ/etc/systemd/system/dgclaw-ronda.service"
    printf 'lixo de uma versao velha\n' >"$s"
    afirma "a atualizacao (instalador de novo) termina" instalacao_basica
    afirma "a unidade voltou ao texto certo" tem "$s" "ronda.py executar"
    nega "o lixo foi embora" tem "$s" "lixo de uma versao velha"
    igual 2 "$(contar "$STUB_LOG" 'systemctl start --no-block dgclaw-ronda.service')" || { echo "      FALHOU: a atualizacao precisa disparar uma rodada nova"; FALHAS=$((FALHAS + 1)); }
    limpar_cenario
}

caso_ronda_ensaio_so_descreve() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "anuncia a unidade da ronda" tem "$SAIDA" "dgclaw-ronda.service"
    afirma "a raiz continua vazia" vazio "$RAIZ"
    limpar_cenario
}
