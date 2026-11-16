# shellcheck shell=bash
# Casos do ffmpeg: o painel gera miniatura de video e foto com o ffmpeg do servidor, e o instalador
# (que o "dgclaw atualizar" tambem roda) precisa instala-lo sem nunca derrubar a instalacao.

caso_ffmpeg_e_instalado_pelo_instalador() {
    novo_cenario
    afirma "a instalacao termina com sucesso" instalacao_basica
    afirma "apt instalou o ffmpeg" grep -qE '^apt-get install -y .*ffmpeg' "$STUB_LOG"
    limpar_cenario
}

caso_ffmpeg_ja_instalado_nao_reinstala() {
    novo_cenario
    EXTRA_ENV+=("DGCLAW_STUB_INSTALADOS=ffmpeg")
    afirma "a instalacao termina com sucesso" instalacao_basica
    nega "apt nao deve instalar o ffmpeg de novo" grep -qE '^apt-get install .*ffmpeg' "$STUB_LOG"
    afirma "diz que o ffmpeg ja estava" tem "$SAIDA" "ffmpeg ja instalado"
    limpar_cenario
}

caso_ffmpeg_com_falha_do_apt_avisa_e_segue() {
    novo_cenario
    EXTRA_ENV+=("DGCLAW_STUB_APT_FALHA=ffmpeg")
    afirma "a instalacao termina mesmo com o apt do ffmpeg falhando" instalacao_basica
    afirma "o aviso diz o que rodar" tem "$SAIDA" "apt-get install -y ffmpeg"
    afirma "o aviso diz o que ficou sem" tem "$SAIDA" "miniaturas"
    afirma "o resto da instalacao seguiu (dgclaw.env)" test -f "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_ffmpeg_ensaio_so_mostra() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "o ensaio mostra o que faria" tem "$SAIDA" "apt-get install -y ffmpeg"
    limpar_cenario
}
