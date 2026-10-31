# shellcheck shell=bash
# shellcheck disable=SC2034
# Casos do AVISO DE SEGURANCA no instalador (carregado com source por rodar.sh, junto de casos.sh):
# o timer de 1 h, a unidade endurecida e a regra "atualizar nunca apaga configuracao".

caso_boletins_instala_unidade_endurecida_e_liga_o_timer() {
    novo_cenario
    afirma "a instalacao termina" instalacao_basica
    local u="$RAIZ/etc/systemd/system" s
    s="$u/dgclaw-checar-boletins.service"
    afirma "unidade de servico existe" test -f "$s"
    afirma "oneshot" tem "$s" "Type=oneshot"
    afirma "como root" tem "$s" "User=root"
    afirma "roda o script do app sob flock proprio, esperando ate 90 s pela trava" tem "$s" "ExecStart=/usr/bin/flock -w 90 -E 75 /var/lib/dgclaw/web/atualizacao/.trava-boletins /usr/bin/node /opt/dgclaw/app/scripts/checar-boletins.mjs"
    afirma "o alvo do flock existe com modo 600" modo_e "$RAIZ/var/lib/dgclaw/web/atualizacao/.trava-boletins" 600
    for linha in NoNewPrivileges=yes ProtectSystem=strict PrivateTmp=yes ProtectHome=yes ProtectKernelTunables=yes \
                 ProtectControlGroups=yes RestrictSUIDSGID=yes TimeoutStartSec=120 \
                 "ReadWritePaths=/var/lib/dgclaw/web/atualizacao /var/log/dgclaw"; do
        afirma "endurecimento: $linha" tem "$s" "$linha"
    done
    afirma "unidade do timer existe" test -f "$u/dgclaw-checar-boletins.timer"
    for linha in OnBootSec=5min OnUnitActiveSec=1h RandomizedDelaySec=5min Persistent=true; do
        afirma "timer: $linha" tem "$u/dgclaw-checar-boletins.timer" "$linha"
    done
    afirma "o timer foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-checar-boletins.timer"
    afirma "confere logo depois de instalar" tem "$STUB_LOG" "systemctl start --no-block dgclaw-checar-boletins.service"
    nega "o instalador nao cria a linha DGCLAW_BOLETINS_SEGURANCA (padrao = ligado)" grep -q '^DGCLAW_BOLETINS_SEGURANCA=' "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_boletins_desligado_no_dgclaw_env_nao_liga_o_timer_e_preserva_as_linhas() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_BOLETINS_SEGURANCA=0\nLINHA_DA_MARTA=oi\nDGCLAW_VERSAO=0.9\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a instalacao termina" instalacao_basica
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a linha que desliga os boletins sobreviveu" grep -qx 'DGCLAW_BOLETINS_SEGURANCA=0' "$env"
    igual "e continua uma so" 1 "$(grep -c '^DGCLAW_BOLETINS_SEGURANCA=' "$env")"
    afirma "a linha alheia sobreviveu" grep -qx 'LINHA_DA_MARTA=oi' "$env"
    afirma "as unidades foram instaladas mesmo assim" test -f "$RAIZ/etc/systemd/system/dgclaw-checar-boletins.timer"
    nega "o timer NAO foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-checar-boletins.timer"
    nega "nenhuma checagem foi disparada" tem "$STUB_LOG" "dgclaw-checar-boletins.service"
    afirma "o timer foi desligado" tem "$STUB_LOG" "systemctl disable --now dgclaw-checar-boletins.timer"
    afirma "a saida explica como ligar" tem "$SAIDA" "DGCLAW_BOLETINS_SEGURANCA"
    limpar_cenario
}

caso_boletins_ensaio_so_descreve() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "anuncia a unidade dos boletins" tem "$SAIDA" "dgclaw-checar-boletins.service"
    afirma "a raiz continua vazia" vazio "$RAIZ"
    limpar_cenario
}
