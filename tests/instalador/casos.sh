# shellcheck shell=bash
# EXTRA_ENV e lida por instalar(), em ajuda.sh; aqui so e preenchida.
# shellcheck disable=SC2034
# Os casos de teste do install.sh e do lib/firewall.sh (carregado com source por rodar.sh).
# Cada funcao caso_* e um cenario isolado: raiz falsa, repositorio falso e stubs no PATH.

# Roda a instalacao completa e padrao: usuario maria, Claude, sem DNS publico (cai no sslip.io).
instalacao_basica() { instalar "$PAINEL_PW" --usuario maria --provedor claude "$@"; }

caso_ensaio_nao_cria_nada() {
    novo_cenario
    afirma "o ensaio termina com sucesso" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "a raiz continua vazia" vazio "$RAIZ"
    afirma "a saida mostra o que faria" tem "$SAIDA" "[ensaio]"
    afirma "avisa que e ensaio no fim" tem "$SAIDA" "isto foi um ensaio"
    igual "$(contar "$STUB_LOG" 'apt-get')" 0 || { echo "      FALHOU: o ensaio chamou apt-get"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$STUB_LOG" 'ufw allow')" 0 || { echo "      FALHOU: o ensaio mexeu no ufw"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$STUB_LOG" 'systemctl enable')" 0 || { echo "      FALHOU: o ensaio ligou unidade"; FALHAS=$((FALHAS + 1)); }
}

caso_instalacao_cria_arquivos_com_os_modos_certos() {
    novo_cenario
    afirma "a instalacao termina com sucesso" instalacao_basica
    local e="$RAIZ/etc/dgclaw" a="$RAIZ/opt/dgclaw" u="$RAIZ/etc/systemd/system"
    afirma "dgclaw.env 644" modo_e "$e/dgclaw.env" 644
    afirma "dominio sslip no dgclaw.env" tem "$e/dgclaw.env" "DGCLAW_DOMINIO=203-0-113-7.sslip.io"
    afirma "versao vem do plugin.json" tem "$e/dgclaw.env" "DGCLAW_VERSAO=1.0.0-teste"
    afirma "provedor do admin no env" tem "$e/dgclaw.env" "DGCLAW_PROVEDOR_ADMIN=claude"
    afirma "web.env 600" modo_e "$e/web.env" 600
    afirma "web.env tem o usuario" tem "$e/web.env" "DGCLAW_PANEL_USER=maria"
    afirma "web.env tem o hash entre aspas simples" grep -qE "^DGCLAW_PANEL_PASSWORD_HASH='scrypt\\\$" "$e/web.env"
    afirma "token do admin 600" modo_e "$e/runner/admin.token" 600
    afirma "token do admin com 64 hex" grep -qE '^[0-9a-f]{64}$' "$e/runner/admin.token"
    afirma "agentes.json 640" modo_e "$e/agentes.json" 640
    afirma "agentes.json com um Admin" jq -e '(.agentes | length) == 1 and .agentes[0].slug == "admin" and .agentes[0].tipo == "admin" and .agentes[0].runner == "http://127.0.0.1:4300" and .agentes[0].chat_id == "c_admin" and .agentes[0].transcripts_dir == "/root/.claude/projects/-opt-dgclaw-admin" and .agentes[0].runner_token_arquivo == "/etc/dgclaw/runner/admin.token" and .agentes[0].porta_painel == null' "$e/agentes.json"
    nega "agentes.json sem caminho da raiz de teste" tem "$e/agentes.json" "$RAIZ"
    afirma "pasta do admin 700" modo_e "$a/admin" 700
    afirma "CLAUDE.md do admin" tem "$a/admin/CLAUDE.md" "Admin (Claude)"
    afirma "AGENTS.md do admin" tem "$a/admin/AGENTS.md" "Admin (Codex)"
    afirma "skill criar-agente copiada" test -f "$a/admin/.claude/skills/criar-agente/SKILL.md"
    afirma "runner.json 444" modo_e "$a/admin/.plataforma/runner.json" 444
    afirma "runner.json do admin" jq -e '.id == "admin" and .config.provider == "local-cli" and .config.cwd == "/opt/dgclaw/admin" and .config.identidadeArquivo == "" and .config.envExtra.CODEX_HOME == "/root/.codex"' "$a/admin/.plataforma/runner.json"
    afirma "dgchat.mcp.json do admin" jq -e '.mcpServers.dgchat.command == "node" and .mcpServers.dgchat.args[0] == "/opt/dgclaw/app/scripts/dgchat-mcp/server.mjs"' "$a/admin/.plataforma/dgchat.mcp.json"
    afirma "codigo copiado" test -f "$a/app/install.sh"
    nega "tests nao vai para o app" test -e "$a/app/tests"
    nega ".git nao vai para o app" test -e "$a/app/.git"
    nega "node_modules da fonte nao vai para o app" test -e "$a/app/web/node_modules"
    afirma "symlink do comando dgclaw" test -L "$RAIZ/usr/local/bin/dgclaw"
    afirma "Caddyfile com o dominio" tem "$RAIZ/etc/caddy/Caddyfile" "203-0-113-7.sslip.io {"
    afirma "Caddyfile com o proxy" tem "$RAIZ/etc/caddy/Caddyfile" "reverse_proxy 127.0.0.1:8300"
    afirma "pasta do web 700" modo_e "$RAIZ/var/lib/dgclaw/web" 700
    afirma "pasta de log 750" modo_e "$RAIZ/var/log/dgclaw" 750
    local un
    for un in web admin imagem firewall; do
        afirma "unidade dgclaw-$un.service existe" test -f "$u/dgclaw-$un.service"
    done
    afirma "unidade do admin com a porta 4300" tem "$u/dgclaw-admin.service" "RUNNER_PORT=4300"
    afirma "unidade do admin com o arquivo do token" tem "$u/dgclaw-admin.service" "RUNNER_TOKEN_FILE=/etc/dgclaw/runner/admin.token"
    afirma "unidade do admin como root" tem "$u/dgclaw-admin.service" "User=root"
    afirma "unidade do admin com a frase do login (RUNNER_LOGIN_HINT)" tem "$u/dgclaw-admin.service" "RUNNER_LOGIN_HINT=Abra o painel do agente e use o botão Entrar com a assinatura."
    afirma "unidade do web na porta 8300" tem "$u/dgclaw-web.service" "DGCLAW_WEB_PORT=8300"
    afirma "unidade da imagem sem navegador" tem "$u/dgclaw-imagem.service" "COM_NAVEGADOR=0"
    afirma "unidade da imagem com a versao" tem "$u/dgclaw-imagem.service" "localhost/dgclaw-agente:1.0.0-teste"
    afirma "unidade do firewall" tem "$u/dgclaw-firewall.service" "ExecStart=/bin/bash /opt/dgclaw/app/lib/firewall.sh"
    afirma "chave do NodeSource" test -s "$RAIZ/usr/share/keyrings/nodesource.gpg"
    afirma "repo do NodeSource" tem "$RAIZ/etc/apt/sources.list.d/nodesource.list" "node_22.x nodistro main"
    afirma "repo do Caddy" tem "$RAIZ/etc/apt/sources.list.d/caddy-stable.list" "signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    afirma "apt instalou o podman" grep -qE '^apt-get install -y .*podman' "$STUB_LOG"
    afirma "ufw liberou a 22" tem "$STUB_LOG" "ufw allow 22/tcp"
    afirma "ufw ligou" tem "$STUB_LOG" "ufw --force enable"
    afirma "caddy validado" tem "$STUB_LOG" "caddy validate --config $RAIZ/etc/caddy/Caddyfile"
    afirma "npm do web" tem "$STUB_LOG" "npm ci --omit=dev (em $a/app/web)"
    afirma "npm do runner (ci)" tem "$STUB_LOG" "npm ci (em $a/app/runner)"
    afirma "npm do runner (build)" tem "$STUB_LOG" "npm run build (em $a/app/runner)"
    afirma "imagem em segundo plano" tem "$STUB_LOG" "systemctl start --no-block dgclaw-imagem.service"
    afirma "primeiro boot por arquivo de configuracao" grep -qE 'curl .*--config .*127\.0\.0\.1:4300/api/agents/admin/input' "$STUB_LOG"
    afirma "marca de primeiro boot" test -f "$RAIZ/var/lib/dgclaw/web/admin-saudado"
    nega "token do admin em argv" tem "$STUB_LOG" "$(cat "$e/runner/admin.token")"
    afirma "mensagem final com o endereco" tem "$SAIDA" "https://203-0-113-7.sslip.io"
    afirma "mensagem final com a senha" tem "$SAIDA" "a que voce escolheu"
    limpar_cenario
}

caso_provedor_codex() {
    novo_cenario
    afirma "instala com codex" instalar "$PAINEL_PW" --usuario maria --provedor codex
    afirma "runner.json usa codex-cli" jq -e '.config.provider == "codex-cli"' "$RAIZ/opt/dgclaw/admin/.plataforma/runner.json"
    afirma "agentes.json aponta as sessoes do codex" jq -e '.agentes[0].provedor == "codex" and .agentes[0].transcripts_dir == "/root/.codex/sessions"' "$RAIZ/etc/dgclaw/agentes.json"
    limpar_cenario
}

caso_rodar_duas_vezes_nao_duplica() {
    novo_cenario
    afirma "primeira rodada" instalacao_basica
    local e="$RAIZ/etc/dgclaw" n1
    cp "$e/runner/admin.token" "$TMP/token1"
    cp "$e/web.env" "$TMP/webenv1"
    cp "$RAIZ/etc/caddy/Caddyfile" "$TMP/caddy1"
    n1="$(wc -l <"$STUB_LOG")"
    # Segunda rodada: sem senha, e com outro IP (o dominio da primeira precisa ser mantido).
    EXTRA_ENV=(DGCLAW_STUB_IP=198.51.100.9)
    afirma "segunda rodada" instalar "" --usuario maria --provedor claude
    tail -n "+$((n1 + 1))" "$STUB_LOG" >"$TMP/log2"
    afirma "um Admin so no agentes.json" jq -e '(.agentes | length) == 1' "$e/agentes.json"
    afirma "token do admin nao mudou" cmp "$TMP/token1" "$e/runner/admin.token"
    afirma "hash da senha nao mudou" cmp "$TMP/webenv1" "$e/web.env"
    afirma "avisa que a senha atual vale" tem "$SAIDA" "senha atual"
    afirma "Caddyfile nao mudou" cmp "$TMP/caddy1" "$RAIZ/etc/caddy/Caddyfile"
    igual "$(contar "$RAIZ/etc/caddy/Caddyfile" reverse_proxy)" 1 || { echo "      FALHOU: reverse_proxy duplicado"; FALHAS=$((FALHAS + 1)); }
    afirma "dominio da primeira rodada mantido" tem "$e/dgclaw.env" "DGCLAW_DOMINIO=203-0-113-7.sslip.io"
    igual "$(contar "$STUB_LOG" 'ufw --force enable')" 1 || { echo "      FALHOU: ufw ligado mais de uma vez"; FALHAS=$((FALHAS + 1)); }
    igual "$(sort -u "$TMP/estado/ufw-regras" | wc -l)" "$(wc -l <"$TMP/estado/ufw-regras")" || { echo "      FALHOU: regra do ufw duplicada"; FALHAS=$((FALHAS + 1)); }
    nega "segunda rodada reinstalou pacote" grep -q '^apt-get install' "$TMP/log2"
    nega "segunda rodada baixou chave de novo" grep -qE "curl .*(gpg\.key|nodesource-repo)" "$TMP/log2"
    afirma "web reiniciado para pegar o codigo novo" tem "$TMP/log2" "systemctl restart dgclaw-web.service"
    nega "admin nao e reiniciado sozinho" tem "$TMP/log2" "systemctl restart dgclaw-admin.service"
    afirma "primeiro boot nao repete" tem "$SAIDA" "ja foi avisado"
    nega "primeiro boot repetido" grep -q 'agents/admin/input' "$TMP/log2"
    limpar_cenario
}

caso_senha_nova_troca_o_hash() {
    novo_cenario
    afirma "primeira rodada" instalacao_basica
    cp "$RAIZ/etc/dgclaw/web.env" "$TMP/webenv1"
    afirma "segunda rodada com senha nova" instalar "outra-frase-comprida-456" --usuario maria --provedor claude
    nega "o hash devia mudar" cmp -s "$TMP/webenv1" "$RAIZ/etc/dgclaw/web.env"
    afirma "ainda 600" modo_e "$RAIZ/etc/dgclaw/web.env" 600
    limpar_cenario
}

caso_dominio_hstgr_quando_o_dns_aponta() {
    novo_cenario
    EXTRA_ENV=(DGCLAW_STUB_DIG_IP=203.0.113.7)
    afirma "instala" instalacao_basica
    afirma "dominio hstgr.cloud" tem "$RAIZ/etc/dgclaw/dgclaw.env" "DGCLAW_DOMINIO=vps-teste.hstgr.cloud"
    afirma "Caddyfile com o hstgr.cloud" tem "$RAIZ/etc/caddy/Caddyfile" "vps-teste.hstgr.cloud {"
    afirma "consultou o 1.1.1.1" grep -q '^dig .*@1.1.1.1' "$STUB_LOG"
    afirma "consultou o 8.8.8.8" grep -q '^dig .*@8.8.8.8' "$STUB_LOG"
    limpar_cenario
}

caso_dominio_sslip_quando_o_dns_nao_aponta() {
    novo_cenario
    EXTRA_ENV=(DGCLAW_STUB_DIG_IP=192.0.2.55)
    afirma "instala" instalacao_basica
    afirma "dominio sslip.io" tem "$RAIZ/etc/dgclaw/dgclaw.env" "DGCLAW_DOMINIO=203-0-113-7.sslip.io"
    limpar_cenario
}

caso_opcao_dominio_vence() {
    novo_cenario
    EXTRA_ENV=(DGCLAW_STUB_DIG_IP=203.0.113.7)
    afirma "instala" instalacao_basica --dominio painel.exemplo.com.br
    afirma "dominio escolhido" tem "$RAIZ/etc/dgclaw/dgclaw.env" "DGCLAW_DOMINIO=painel.exemplo.com.br"
    afirma "Caddyfile com o dominio escolhido" tem "$RAIZ/etc/caddy/Caddyfile" "painel.exemplo.com.br {"
    limpar_cenario
}

caso_dominio_invalido_e_recusado() {
    novo_cenario
    nega "dominio com chave e espaco" instalacao_basica --dominio 'x.com { respond "oi" }'
    afirma "explica o problema" tem "$SAIDA" "nao parece um endereco valido"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_senha_curta_e_recusada() {
    novo_cenario
    nega "senha de 5 letras" instalar "curta" --usuario maria
    afirma "diz o minimo" tem "$SAIDA" "minimo e 12"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_sem_senha_na_primeira_vez() {
    novo_cenario
    nega "sem senha nenhuma" instalar "" --usuario maria
    afirma "explica como mandar a senha" tem "$SAIDA" "senha do painel nao chegou"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_a_senha_nunca_aparece() {
    novo_cenario
    local pw='Segredo-Unico-ZXQ-98765'
    afirma "instala" instalar "$pw" --usuario maria --provedor claude
    nega "senha no registro de argv dos stubs" tem "$STUB_LOG" "$pw"
    nega "senha na saida do instalador" tem "$SAIDA" "$pw"
    nega "senha em algum arquivo da raiz" grep -rqF -- "$pw" "$RAIZ"
    afirma "so o hash foi gravado" grep -q "^DGCLAW_PANEL_PASSWORD_HASH='scrypt" "$RAIZ/etc/dgclaw/web.env"
    limpar_cenario
}

caso_usuario_obrigatorio_e_opcao_desconhecida() {
    novo_cenario
    nega "sem --usuario" instalar "$PAINEL_PW"
    afirma "pede o usuario" tem "$SAIDA" "--usuario"
    nega "opcao desconhecida" instalar "$PAINEL_PW" --usuario maria --voar
    afirma "diz qual opcao" tem "$SAIDA" "--voar"
    afirma "ajuda sai com 0" instalar "" --ajuda
    afirma "ajuda mostra o uso" tem "$SAIDA" "Uso: sudo ./install.sh"
    limpar_cenario
}

caso_caddyfile_com_outro_site_e_preservado() {
    novo_cenario
    mkdir -p "$RAIZ/etc/caddy"
    printf 'import conf.d/*\n\noutro.exemplo.com {\n\trespond "oi"\n}\n' >"$RAIZ/etc/caddy/Caddyfile"
    cp "$RAIZ/etc/caddy/Caddyfile" "$TMP/original"
    afirma "instala" instalacao_basica
    afirma "Caddyfile do outro site intacto" cmp "$TMP/original" "$RAIZ/etc/caddy/Caddyfile"
    afirma "site do DG Claw em conf.d" tem "$RAIZ/etc/caddy/conf.d/dgclaw.caddy" "reverse_proxy 127.0.0.1:8300"
    limpar_cenario
}

caso_caddyfile_com_outro_site_sem_import_para_com_explicacao() {
    novo_cenario
    mkdir -p "$RAIZ/etc/caddy"
    printf 'outro.exemplo.com {\n\trespond "oi"\n}\n' >"$RAIZ/etc/caddy/Caddyfile"
    cp "$RAIZ/etc/caddy/Caddyfile" "$TMP/original"
    nega "sem import conf.d" instalacao_basica
    afirma "explica a linha a acrescentar" tem "$SAIDA" "import conf.d/*"
    afirma "Caddyfile intacto" cmp "$TMP/original" "$RAIZ/etc/caddy/Caddyfile"
    nega "nada escrito em conf.d" test -e "$RAIZ/etc/caddy/conf.d/dgclaw.caddy"
    limpar_cenario
}

caso_caddyfile_padrao_do_pacote_e_substituido() {
    novo_cenario
    mkdir -p "$RAIZ/etc/caddy"
    cat >"$RAIZ/etc/caddy/Caddyfile" <<'FIM'
# The Caddyfile is an easy way to configure your Caddy web server.
#
# Refer to the Caddy docs for more information:
# https://caddyserver.com/docs/caddyfile

:80 {
	# Set this path to your site's directory.
	root * /usr/share/caddy

	# Enable the static file server.
	file_server
}
FIM
    afirma "instala" instalacao_basica
    afirma "virou o nosso" tem "$RAIZ/etc/caddy/Caddyfile" "# DG Claw"
    nega "o exemplo sumiu" tem "$RAIZ/etc/caddy/Caddyfile" "file_server"
    limpar_cenario
}

caso_sem_imagem_nao_constroi() {
    novo_cenario
    afirma "instala" instalacao_basica --sem-imagem
    nega "nao inicia a construcao" tem "$STUB_LOG" "dgclaw-imagem.service"
    nega "nao cria a unidade da imagem" test -e "$RAIZ/etc/systemd/system/dgclaw-imagem.service"
    limpar_cenario
}

caso_firewall_da_cerca_e_idempotente() {
    novo_cenario
    local rc=0
    local _
    for _ in 1 2; do
        env -i "HOME=$TMP" "PATH=$AQUI/stubs:/usr/bin:/bin" "DGCLAW_STUB_LOG=$STUB_LOG" "DGCLAW_STUB_ESTADO=$TMP/estado" \
            bash "$REPO/lib/firewall.sh" >"$SAIDA" 2>&1 || rc=$?
    done
    igual "$rc" 0 || { echo "      FALHOU: firewall.sh terminou com $rc"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$STUB_LOG" 'iptables -w -I INPUT 1')" 1 || { echo "      FALHOU: salto de INPUT duplicado"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$STUB_LOG" 'iptables -w -I FORWARD 1')" 1 || { echo "      FALHOU: salto de FORWARD duplicado"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$TMP/estado/ipt-regras" '|DGCLAW_EGRESS|')" 7 || { echo "      FALHOU: regras da cadeia EGRESS duplicadas"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$TMP/estado/ipt-regras" '|DGCLAW_HOST|')" 2 || { echo "      FALHOU: regras da cadeia HOST duplicadas"; FALHAS=$((FALHAS + 1)); }
    limpar_cenario
}

# proc_inotify <instancias> <watches>: poe os limites atuais no /proc falso da raiz.
proc_inotify() {
    mkdir -p "$RAIZ/proc/sys/fs/inotify"
    printf '%s\n' "$1" >"$RAIZ/proc/sys/fs/inotify/max_user_instances"
    printf '%s\n' "$2" >"$RAIZ/proc/sys/fs/inotify/max_user_watches"
}

caso_inotify_sobe_o_padrao_do_ubuntu() {
    novo_cenario
    local conf="$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    proc_inotify 128 65536
    afirma "instala" instalacao_basica
    afirma "instancias subiram para 1024" tem "$conf" "fs.inotify.max_user_instances=1024"
    afirma "watches subiram para 524288" tem "$conf" "fs.inotify.max_user_watches=524288"
    afirma "arquivo com modo 644" modo_e "$conf" 644
    afirma "sysctl chamado com -p e o arquivo" tem "$STUB_LOG" "sysctl -p $conf"
    nega "nunca com --system" tem "$STUB_LOG" "sysctl --system"
    limpar_cenario
}

caso_inotify_nunca_abaixa() {
    novo_cenario
    local conf="$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    proc_inotify 4096 1048576
    afirma "instala" instalacao_basica
    afirma "mantem as instancias maiores (4096)" tem "$conf" "fs.inotify.max_user_instances=4096"
    afirma "mantem os watches maiores" tem "$conf" "fs.inotify.max_user_watches=1048576"
    limpar_cenario
}

caso_inotify_sem_proc_usa_o_minimo() {
    novo_cenario
    local conf="$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    afirma "instala sem /proc falso" instalacao_basica
    afirma "usa 1024" tem "$conf" "fs.inotify.max_user_instances=1024"
    afirma "usa 524288" tem "$conf" "fs.inotify.max_user_watches=524288"
    limpar_cenario
}

caso_inotify_ensaio_nao_grava_nem_aplica() {
    novo_cenario
    proc_inotify 128 65536
    afirma "ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    nega "nao gravou o arquivo" test -e "$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    nega "nao chamou o sysctl" tem "$STUB_LOG" "sysctl"
    afirma "anuncia o sysctl -p" tem "$SAIDA" "[ensaio] sysctl -p"
    limpar_cenario
}

caso_inotify_sysctl_recusado_nao_derruba_o_install() {
    novo_cenario
    local conf="$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    proc_inotify 128 65536
    mkdir -p "$TMP/estado"; touch "$TMP/estado/sysctl-falha"
    afirma "instala mesmo com o sysctl recusado (VPS em container)" instalacao_basica
    afirma "o arquivo ficou gravado" tem "$conf" "fs.inotify.max_user_instances=1024"
    afirma "avisa que nao aplicou" tem "$SAIDA" "nao consegui aplicar o limite de inotify"
    afirma "diz o limite atual e quantos agentes cabem" tem "$SAIDA" "O limite atual e 128"
    afirma "faz a conta de agentes" tem "$SAIDA" "cabem uns 21 agentes"
    afirma "a instalacao chegou ao fim (Admin configurado depois)" test -f "$RAIZ/etc/systemd/system/dgclaw-admin.service"
    limpar_cenario
}

caso_inotify_rodar_duas_vezes_nao_muda() {
    novo_cenario
    local conf="$RAIZ/etc/sysctl.d/90-dgclaw-inotify.conf"
    proc_inotify 128 65536
    afirma "primeira rodada" instalacao_basica
    cp "$conf" "$TMP/conf1"
    touch -d '2020-01-01' "$conf"
    afirma "segunda rodada" instalar "" --usuario maria --provedor claude
    afirma "conteudo igual" cmp "$TMP/conf1" "$conf"
    afirma "nem reescreveu o arquivo (data intacta)" test "$(stat -c %Y "$conf")" = "$(date -d '2020-01-01' +%s)"
    limpar_cenario
}
