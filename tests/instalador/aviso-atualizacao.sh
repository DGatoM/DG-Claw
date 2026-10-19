# shellcheck shell=bash
# shellcheck disable=SC2034
# Casos do AVISO DE NOVA VERSAO no instalador (carregado com source por rodar.sh, junto de casos.sh):
# o timer de 6 h, a unidade endurecida e, acima de tudo, a regra "atualizar nunca apaga configuracao".

caso_aviso_instala_unidade_endurecida_e_liga_o_timer() {
    novo_cenario
    afirma "a instalacao termina" instalacao_basica
    local u="$RAIZ/etc/systemd/system" s
    s="$u/dgclaw-checar-atualizacao.service"
    afirma "unidade de servico existe" test -f "$s"
    afirma "oneshot" tem "$s" "Type=oneshot"
    afirma "como root" tem "$s" "User=root"
    afirma "roda o script do app sob flock, esperando ate 90 s pela trava" tem "$s" "ExecStart=/usr/bin/flock -w 90 -E 75 /var/lib/dgclaw/web/atualizacao/.trava /usr/bin/node /opt/dgclaw/app/scripts/checar-atualizacao.mjs"
    afirma "o alvo do flock existe com modo 600" modo_e "$RAIZ/var/lib/dgclaw/web/atualizacao/.trava" 600
    for linha in NoNewPrivileges=yes ProtectSystem=strict PrivateTmp=yes ProtectHome=yes ProtectKernelTunables=yes \
                 ProtectControlGroups=yes RestrictSUIDSGID=yes TimeoutStartSec=120 \
                 "ReadWritePaths=/var/lib/dgclaw/web/atualizacao /var/log/dgclaw"; do
        afirma "endurecimento: $linha" tem "$s" "$linha"
    done
    afirma "unidade do timer existe" test -f "$u/dgclaw-checar-atualizacao.timer"
    for linha in OnBootSec=15min OnUnitActiveSec=6h RandomizedDelaySec=30min Persistent=true; do
        afirma "timer: $linha" tem "$u/dgclaw-checar-atualizacao.timer" "$linha"
    done
    afirma "o timer foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-checar-atualizacao.timer"
    afirma "confere logo depois de instalar" tem "$STUB_LOG" "systemctl start --no-block dgclaw-checar-atualizacao.service"
    afirma "pasta do estado 700" modo_e "$RAIZ/var/lib/dgclaw/web/atualizacao" 700
    nega "o instalador nao cria a linha DGCLAW_AVISO_ATUALIZACAO (padrao = ligado)" grep -q '^DGCLAW_AVISO_ATUALIZACAO=' "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_aviso_desligado_no_dgclaw_env_nao_liga_o_timer_e_preserva_as_linhas() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_AVISO_ATUALIZACAO=0\nLINHA_DA_MARTA=oi\nDGCLAW_VERSAO=0.9\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina" instalacao_basica
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a linha que desliga o aviso sobreviveu" grep -qx 'DGCLAW_AVISO_ATUALIZACAO=0' "$env"
    igual "e continua uma so" 1 "$(grep -c '^DGCLAW_AVISO_ATUALIZACAO=' "$env")"
    afirma "a linha alheia sobreviveu" grep -qx 'LINHA_DA_MARTA=oi' "$env"
    afirma "o modo do arquivo foi mantido" modo_e "$env" 640
    afirma "as unidades foram instaladas mesmo assim" test -f "$RAIZ/etc/systemd/system/dgclaw-checar-atualizacao.timer"
    nega "o timer NAO foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-checar-atualizacao.timer"
    nega "nenhuma checagem foi disparada" tem "$STUB_LOG" "dgclaw-checar-atualizacao.service"
    afirma "o timer foi desligado" tem "$STUB_LOG" "systemctl disable --now dgclaw-checar-atualizacao.timer"
    afirma "a saida explica como ligar" tem "$SAIDA" "dgclaw atualizar --aviso ligar"
    limpar_cenario
}

caso_aviso_desligado_com_aspas_tambem_vale() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf "DGCLAW_AVISO_ATUALIZACAO='0'\n" >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina" instalacao_basica
    nega "o timer NAO foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-checar-atualizacao.timer"
    limpar_cenario
}

caso_aviso_ensaio_so_descreve() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "anuncia a unidade do aviso" tem "$SAIDA" "dgclaw-checar-atualizacao.service"
    afirma "a raiz continua vazia" vazio "$RAIZ"
    nega "nenhum systemctl enable" tem "$STUB_LOG" "systemctl enable"
    limpar_cenario
}
