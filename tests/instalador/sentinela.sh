# shellcheck shell=bash
# shellcheck disable=SC2034
# Casos da SENTINELA DO SERVIDOR no instalador (carregado com source por rodar.sh, junto de casos.sh): as unidades, a protecao
# contra falta de memoria, o teto do journal e o que a atualizacao nao pode tocar (sentinela.conf e config do journal do dono).

caso_sentinela_instala_unidades_dropins_e_liga_o_timer() {
    novo_cenario
    afirma "a instalacao termina" instalacao_basica
    local u="$RAIZ/etc/systemd/system" s
    s="$u/dgclaw-sentinela.service"
    afirma "servico da sentinela existe" test -f "$s"
    for linha in Type=oneshot User=root OOMScoreAdjust=-900 MemoryMax=96M Nice=-5 TimeoutStartSec=55 \
        "ExecStart=/usr/bin/python3 -I /opt/dgclaw/app/seguranca/sentinela/sentinela.py rodar"; do
        afirma "servico: $linha" tem "$s" "$linha"
    done
    nega "a sentinela nao leva PrivateTmp (ela mede e limpa o /tmp de verdade)" tem "$s" "PrivateTmp"
    nega "a sentinela nao leva ProtectHome (ela mede /root e /home)" tem "$s" "ProtectHome"
    local t="$u/dgclaw-sentinela.timer"
    afirma "timer existe" test -f "$t"
    for linha in OnBootSec=1min OnUnitActiveSec=1min Unit=dgclaw-sentinela.service WantedBy=timers.target; do
        afirma "timer: $linha" tem "$t" "$linha"
    done
    afirma "o painel (dgclaw-web) leva OOMScoreAdjust=-500" tem "$u/dgclaw-web.service" "OOMScoreAdjust=-500"
    afirma "drop-in do ssh com -900" tem "$u/ssh.service.d/90-dgclaw-oom.conf" "OOMScoreAdjust=-900"
    afirma "o drop-in do ssh abre [Service]" tem "$u/ssh.service.d/90-dgclaw-oom.conf" "[Service]"
    afirma "drop-in do caddy com -500" tem "$u/caddy.service.d/90-dgclaw-oom.conf" "OOMScoreAdjust=-500"
    local j="$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf"
    afirma "teto do journal criado" tem "$j" "SystemMaxUse=1G"
    local c="$RAIZ/etc/dgclaw/sentinela.conf"
    afirma "sentinela.conf criado" test -f "$c"
    afirma "sentinela.conf com modo 600" modo_e "$c" 600
    afirma "sentinela.conf traz os padroes comentados" tem "$c" "#DISCO_AVISO=75"
    nega "sentinela.conf nao traz segredo nenhum" grep -Eq '^(TELEGRAM_TOKEN|EMAIL_SENHA|PULSO_URL)=.+' "$c"
    afirma "pasta de estado com modo 700" modo_e "$RAIZ/var/lib/dgclaw/sentinela" 700
    afirma "pasta da reserva com modo 700" modo_e "$RAIZ/var/lib/dgclaw/reserva" 700
    afirma "pasta do painel com modo 750 (o Web grava o push.json ali)" modo_e "$RAIZ/var/lib/dgclaw/web/sentinela" 750
    afirma "o timer foi ligado" tem "$STUB_LOG" "systemctl enable dgclaw-sentinela.timer"
    afirma "dispara uma rodada logo depois de instalar" tem "$STUB_LOG" "systemctl start --no-block dgclaw-sentinela.service"
    nega "a instalacao nunca reinicia o ssh" tem "$STUB_LOG" "systemctl restart ssh"
    nega "nem o caddy por causa da sentinela" tem "$STUB_LOG" "systemctl restart caddy"
    limpar_cenario
}

caso_sentinela_atualizar_nao_toca_no_conf_nem_no_journal_do_dono() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw" "$RAIZ/etc/systemd/journald.conf.d"
    printf '# da Marta\nLINHA_DA_MARTA=oi\nTELEGRAM_CHATS=111\nDISCO_AVISO=70\n' >"$RAIZ/etc/dgclaw/sentinela.conf"
    chmod 600 "$RAIZ/etc/dgclaw/sentinela.conf"
    cp "$RAIZ/etc/dgclaw/sentinela.conf" "$TMP/conf.antes"
    printf '[Journal]\nSystemMaxUse=200M\n' >"$RAIZ/etc/systemd/journald.conf.d/10-marta.conf"
    afirma "a instalacao termina" instalacao_basica
    afirma "o sentinela.conf do dono ficou identico (linha alheia, comentario, valores)" cmp -s "$TMP/conf.antes" "$RAIZ/etc/dgclaw/sentinela.conf"
    nega "o journald nao ganha o arquivo nosso quando a pessoa ja definiu SystemMaxUse em outro" test -e "$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf"
    afirma "o arquivo do dono continua como estava" tem "$RAIZ/etc/systemd/journald.conf.d/10-marta.conf" "SystemMaxUse=200M"
    afirma "a atualizacao (instalador de novo) termina" instalacao_basica
    afirma "e o sentinela.conf segue identico" cmp -s "$TMP/conf.antes" "$RAIZ/etc/dgclaw/sentinela.conf"
    limpar_cenario
}

caso_sentinela_journal_proprio_nao_e_reescrito_e_main_conf_vale() {
    novo_cenario
    mkdir -p "$RAIZ/etc/systemd/journald.conf.d"
    printf '[Journal]\nSystemMaxUse=300M\n' >"$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf"
    afirma "a instalacao termina" instalacao_basica
    afirma "o arquivo 90-dgclaw.conf que ja existia nao foi reescrito" tem "$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf" "SystemMaxUse=300M"
    nega "nao virou 1G" tem "$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf" "SystemMaxUse=1G"
    limpar_cenario
    novo_cenario
    mkdir -p "$RAIZ/etc/systemd"
    printf '[Journal]\nSystemMaxUse=2G\n' >"$RAIZ/etc/systemd/journald.conf"
    afirma "a instalacao termina" instalacao_basica
    nega "SystemMaxUse no journald.conf principal tambem conta: nao cria o nosso" test -e "$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf"
    limpar_cenario
    novo_cenario
    mkdir -p "$RAIZ/etc/systemd"
    printf '[Journal]\n#SystemMaxUse=\n' >"$RAIZ/etc/systemd/journald.conf"
    afirma "a instalacao termina" instalacao_basica
    afirma "linha so comentada no journald.conf nao conta como teto da pessoa: o nosso entra" test -e "$RAIZ/etc/systemd/journald.conf.d/90-dgclaw.conf"
    limpar_cenario
}

caso_sentinela_atualizar_refaz_as_unidades() {
    novo_cenario
    afirma "a primeira instalacao termina" instalacao_basica
    local s="$RAIZ/etc/systemd/system/dgclaw-sentinela.service"
    printf 'lixo de uma versao velha\n' >"$s"
    afirma "a atualizacao termina" instalacao_basica
    afirma "a unidade voltou ao texto certo" tem "$s" "sentinela.py rodar"
    nega "o lixo foi embora" tem "$s" "lixo de uma versao velha"
    limpar_cenario
}

caso_sentinela_ensaio_so_descreve() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "anuncia a unidade da sentinela" tem "$SAIDA" "dgclaw-sentinela.service"
    afirma "a raiz continua vazia" vazio "$RAIZ"
    limpar_cenario
}
