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

caso_versao_vem_do_arquivo_VERSION() {
    novo_cenario
    printf '1.2.3\n' >"$FALSO/VERSION"
    afirma "a instalacao termina com sucesso" instalacao_basica
    afirma "a versao do arquivo VERSION ganha do plugin.json" tem "$RAIZ/etc/dgclaw/dgclaw.env" "DGCLAW_VERSAO=1.2.3"
    afirma "o arquivo VERSION vai junto para o app instalado" tem "$RAIZ/opt/dgclaw/app/VERSION" "1.2.3"
}

caso_instalacao_cria_arquivos_com_os_modos_certos() {
    novo_cenario
    afirma "a instalacao termina com sucesso" instalacao_basica --com-imagem
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
    afirma "skill trocar-dominio copiada" test -f "$a/admin/.claude/skills/trocar-dominio/SKILL.md"
    afirma "runner.json 444" modo_e "$a/admin/.plataforma/runner.json" 444
    afirma "runner.json do admin" jq -e '.id == "admin" and .config.provider == "local-cli" and .config.cwd == "/opt/dgclaw/admin" and .config.identidadeArquivo == "/opt/dgclaw/admin/.plataforma/ambiente.md" and .config.envExtra.CODEX_HOME == "/root/.codex"' "$a/admin/.plataforma/runner.json"
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
    afirma "unidade da imagem com navegador (render de vídeo das skills)" tem "$u/dgclaw-imagem.service" "COM_NAVEGADOR=1"
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
    afirma "mensagem final traz o painel" tem "$SAIDA" "Painel:   https://203-0-113-7.sslip.io/"
    afirma "mensagem final orienta sair do terminal" tem "$SAIDA" "Daqui pra frente é pelo painel"
    limpar_cenario
}

caso_admin_claude_pula_o_aviso_do_bypass() {
    novo_cenario
    afirma "instala com claude" instalacao_basica
    local st="$RAIZ/root/.claude/settings.json"
    afirma "settings do HOME do Admin nasce so com a chave" jq -e '. == {skipDangerousModePermissionPrompt: true}' "$st"
    limpar_cenario
}

caso_admin_settings_existente_e_mesclado_sem_perder_nada() {
    novo_cenario
    local st="$RAIZ/root/.claude/settings.json"
    mkdir -p "$RAIZ/root/.claude"
    printf '{"model": "opus", "hooks": {"Stop": []}}\n' >"$st"
    chmod 600 "$st"
    afirma "instala com claude" instalacao_basica
    afirma "a chave entrou" jq -e '.skipDangerousModePermissionPrompt == true' "$st"
    afirma "o resto ficou" jq -e '.model == "opus" and .hooks.Stop == []' "$st"
    afirma "o modo do arquivo foi mantido" modo_e "$st" 600
    limpar_cenario
}

caso_admin_settings_invalido_nao_e_sobrescrito() {
    novo_cenario
    local st="$RAIZ/root/.claude/settings.json"
    mkdir -p "$RAIZ/root/.claude"
    printf '{ isto nao e json' >"$st"
    afirma "a instalacao nao cai por causa disso" instalacao_basica
    afirma "o arquivo ficou como estava" tem "$st" "{ isto nao e json"
    afirma "o aviso diz o caminho" tem "$SAIDA" "root/.claude/settings.json nao e um JSON valido"
    limpar_cenario
}

caso_admin_codex_nao_mexe_no_settings_do_claude() {
    novo_cenario
    afirma "instala com codex" instalar "$PAINEL_PW" --usuario maria --provedor codex
    nega "nenhum settings do Claude criado" test -e "$RAIZ/root/.claude/settings.json"
    limpar_cenario
}

caso_ensaio_nao_cria_settings_do_admin() {
    novo_cenario
    afirma "o ensaio termina" instalar "$PAINEL_PW" --usuario maria --provedor claude --ensaio
    afirma "a raiz continua vazia" vazio "$RAIZ"
    limpar_cenario
}

caso_provedor_codex() {
    novo_cenario
    afirma "instala com codex" instalar "$PAINEL_PW" --usuario maria --provedor codex
    afirma "runner.json usa codex-cli" jq -e '.config.provider == "codex-cli"' "$RAIZ/opt/dgclaw/admin/.plataforma/runner.json"
    afirma "agentes.json aponta as sessoes do codex" jq -e '.agentes[0].provedor == "codex" and .agentes[0].transcripts_dir == "/root/.codex/sessions"' "$RAIZ/etc/dgclaw/agentes.json"
    limpar_cenario
}

# Sem --provedor, o login vence o programa instalado: o comando claude pode existir no PATH
# (o caso poe um claude falso nele) sem login, e quem so tem o Codex logado precisa cair no Codex.
caso_sem_opcao_so_codex_logado_escolhe_codex() {
    novo_cenario
    mkdir -p "$RAIZ/root/.codex" "$TMP/bin" && echo '{}' > "$RAIZ/root/.codex/auth.json"
    printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/claude"; chmod +x "$TMP/bin/claude"
    EXTRA_ENV=("PATH=$TMP/bin:$AQUI/stubs:/usr/bin:/bin")
    afirma "instala sem --provedor" instalar "$PAINEL_PW" --usuario maria
    afirma "runner.json usa codex-cli" jq -e '.config.provider == "codex-cli"' "$RAIZ/opt/dgclaw/admin/.plataforma/runner.json"
    afirma "provedor do admin no env" tem "$RAIZ/etc/dgclaw/dgclaw.env" "DGCLAW_PROVEDOR_ADMIN=codex"
    limpar_cenario
}

caso_sem_opcao_os_dois_logados_escolhe_claude() {
    novo_cenario
    mkdir -p "$RAIZ/root/.codex" "$RAIZ/root/.claude"
    echo '{}' > "$RAIZ/root/.codex/auth.json"; echo '{}' > "$RAIZ/root/.claude/.credentials.json"
    afirma "instala sem --provedor" instalar "$PAINEL_PW" --usuario maria
    afirma "runner.json usa local-cli" jq -e '.config.provider == "local-cli"' "$RAIZ/opt/dgclaw/admin/.plataforma/runner.json"
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

caso_reinstalar_preserva_chaves_do_web_env() {
    novo_cenario
    afirma "primeira rodada" instalacao_basica
    local e="$RAIZ/etc/dgclaw/web.env"
    printf 'GROQ_API_KEY=x\nDGCLAW_WEB_AVISOS=off\n' >>"$e"
    afirma "segunda rodada sem senha nova" instalar "" --usuario maria --provedor claude
    afirma "GROQ_API_KEY continua" grep -qx 'GROQ_API_KEY=x' "$e"
    afirma "DGCLAW_WEB_AVISOS continua" grep -qx 'DGCLAW_WEB_AVISOS=off' "$e"
    igual "$(contar "$e" 'DGCLAW_PANEL_USER=')" 1 || { echo "      FALHOU: usuario duplicado"; FALHAS=$((FALHAS + 1)); }
    igual "$(contar "$e" 'DGCLAW_PANEL_PASSWORD_HASH=')" 1 || { echo "      FALHOU: hash duplicado"; FALHAS=$((FALHAS + 1)); }
    afirma "usuario certo" grep -qx 'DGCLAW_PANEL_USER=maria' "$e"
    afirma "hash no formato" grep -qE "^DGCLAW_PANEL_PASSWORD_HASH='scrypt[$]teste[$][0-9a-f]{64}'$" "$e"
    afirma "ainda 600" modo_e "$e" 600
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

caso_sem_senha_gera_link_de_primeiro_acesso() {
    novo_cenario
    afirma "instala sem senha" instalar "" --usuario maria --provedor claude
    local e="$RAIZ/etc/dgclaw" arq="$RAIZ/etc/dgclaw/primeiro-acesso.json" tk hash_impresso
    afirma "criou primeiro-acesso.json" test -f "$arq"
    afirma "arquivo em modo 600" modo_e "$arq" 600
    afirma "campos do contrato" jq -e '.versao == 1 and .usuario == "maria" and (.token_sha256 | test("^[0-9a-f]{64}$")) and .usado_em == null and (.expira - .criado) == 1800000' "$arq"
    afirma "web.env com usuario" tem "$e/web.env" "DGCLAW_PANEL_USER=maria"
    afirma "web.env com hash vazio" tem "$e/web.env" "DGCLAW_PANEL_PASSWORD_HASH=''"
    afirma "a saida traz o link" tem "$SAIDA" "/primeiro-acesso#"
    tk="$(grep -o 'primeiro-acesso#[A-Za-z0-9_-]*' "$SAIDA" | head -1 | cut -d'#' -f2)"
    igual "$(printf '%s' "$tk" | wc -c)" 43 || { echo "      FALHOU: o link nao tem 43 caracteres"; FALHAS=$((FALHAS + 1)); }
    hash_impresso="$(printf '%s' "$tk" | sha256sum | cut -d' ' -f1)"
    igual "$hash_impresso" "$(jq -r .token_sha256 "$arq")" || { echo "      FALHOU: sha256 do link diferente do arquivo"; FALHAS=$((FALHAS + 1)); }
    nega "o link em algum arquivo da raiz" grep -rqF -- "$tk" "$RAIZ"
    nega "o link no registro dos stubs" tem "$STUB_LOG" "$tk"
    nega "a saida mostra uma senha" grep -q "Senha:    [^ae]" "$SAIDA"
    afirma "explica como gerar outro" tem "$SAIDA" "sudo dgclaw primeiro-acesso"
    limpar_cenario
}

caso_senha_por_pipe_grava_hash_e_nao_gera_link() {
    novo_cenario
    local pw='Segredo-Unico-ZXQ-98765'
    afirma "instala" instalar "$pw" --usuario maria --provedor claude
    afirma "hash gravado" grep -q "^DGCLAW_PANEL_PASSWORD_HASH='scrypt" "$RAIZ/etc/dgclaw/web.env"
    nega "nao cria primeiro-acesso.json" test -e "$RAIZ/etc/dgclaw/primeiro-acesso.json"
    nega "saida com link" tem "$SAIDA" "/primeiro-acesso#"
    nega "senha na saida" tem "$SAIDA" "$pw"
    nega "senha no registro de argv dos stubs" tem "$STUB_LOG" "$pw"
    nega "senha em algum arquivo da raiz" grep -rqF -- "$pw" "$RAIZ"
    limpar_cenario
}

caso_senha_stdin_funciona() {
    novo_cenario
    local pw='Outra-Senha-Longa-4455'
    afirma "instala com --senha-stdin" instalar "$pw" --usuario maria --provedor claude --senha-stdin
    afirma "hash gravado" grep -q "^DGCLAW_PANEL_PASSWORD_HASH='scrypt" "$RAIZ/etc/dgclaw/web.env"
    nega "sem link" test -e "$RAIZ/etc/dgclaw/primeiro-acesso.json"
    nega "senha na saida" tem "$SAIDA" "$pw"
    limpar_cenario
}

caso_senha_stdin_vazia_falha() {
    novo_cenario
    nega "--senha-stdin sem senha" instalar "" --usuario maria --senha-stdin
    afirma "explica" tem "$SAIDA" "--senha-stdin"
    limpar_cenario
}

caso_reinstalar_sem_senha_mantem_a_atual() {
    novo_cenario
    afirma "primeira rodada com senha" instalacao_basica
    cp "$RAIZ/etc/dgclaw/web.env" "$TMP/webenv1"
    afirma "segunda rodada sem senha" instalar "" --usuario maria --provedor claude
    afirma "hash igual" cmp "$TMP/webenv1" "$RAIZ/etc/dgclaw/web.env"
    nega "nao gerou link" test -e "$RAIZ/etc/dgclaw/primeiro-acesso.json"
    nega "saida sem link" tem "$SAIDA" "/primeiro-acesso#"
    limpar_cenario
}

caso_novo_primeiro_acesso_gera_link_e_mantem_hash() {
    novo_cenario
    afirma "primeira rodada com senha" instalacao_basica
    cp "$RAIZ/etc/dgclaw/web.env" "$TMP/webenv1"
    afirma "segunda rodada com --novo-primeiro-acesso" instalar "" --usuario maria --provedor claude --novo-primeiro-acesso
    afirma "criou o arquivo" test -f "$RAIZ/etc/dgclaw/primeiro-acesso.json"
    afirma "hash antigo mantido" cmp "$TMP/webenv1" "$RAIZ/etc/dgclaw/web.env"
    afirma "saida com link" tem "$SAIDA" "/primeiro-acesso#"
    limpar_cenario
}

caso_ensaio_sem_senha_nao_cria_nada() {
    novo_cenario
    afirma "ensaio sem senha" instalar "" --usuario maria --provedor claude --ensaio
    afirma "a raiz continua vazia" vazio "$RAIZ"
    nega "nao imprime link" tem "$SAIDA" "/primeiro-acesso#"
    limpar_cenario
}

caso_senha_nunca_e_impressa_nem_gravada_nem_em_argv() {
    novo_cenario
    local pw='Segredo-Unico-ZXQ-98765'
    afirma "instala" instalar "$pw" --usuario maria --provedor claude
    nega "senha no registro de argv dos stubs" tem "$STUB_LOG" "$pw"
    nega "senha na saida" tem "$SAIDA" "$pw"
    nega "senha em algum arquivo da raiz" grep -rqF -- "$pw" "$RAIZ"
    afirma "so o hash foi gravado" grep -q "^DGCLAW_PANEL_PASSWORD_HASH='scrypt" "$RAIZ/etc/dgclaw/web.env"
    limpar_cenario
}

# --- versao do Ubuntu (so a checagem de versao roda quando ha os-release na raiz falsa) ---
os_release() { # os_release <id> <versao>
    mkdir -p "$RAIZ/etc"
    printf 'ID=%s\nVERSION_ID="%s"\n' "$1" "$2" >"$RAIZ/etc/os-release"
}

caso_versao_ubuntu_24_passa_sem_aviso() {
    novo_cenario
    os_release ubuntu 24.04
    afirma "instala no 24.04" instalacao_basica
    afirma "mostra o sistema" tem "$SAIDA" "sistema: ubuntu 24.04"
    nega "sem aviso de versao" tem "$SAIDA" "tem funcionado"
    limpar_cenario
}

caso_versao_ubuntu_26_passa_com_aviso() {
    novo_cenario
    os_release ubuntu 26.04
    afirma "instala no 26.04" instalacao_basica
    afirma "avisa que o 26.04 tem funcionado" tem "$SAIDA" "O 26.04 tem funcionado"
    limpar_cenario
}

caso_versao_ubuntu_25_10_falha() {
    novo_cenario
    os_release ubuntu 25.10
    nega "o 25.10 e recusado" instalacao_basica
    afirma "mensagem de versao" tem "$SAIDA" "este sistema e 'ubuntu 25.10'"
    afirma "diz o que fazer" tem "$SAIDA" "O que fazer:"
    limpar_cenario
}

caso_versao_debian_12_falha() {
    novo_cenario
    os_release debian 12
    nega "o debian 12 e recusado" instalacao_basica
    afirma "mensagem de versao" tem "$SAIDA" "este sistema e 'debian 12'"
    limpar_cenario
}

caso_sem_slirp4netns_nem_passt_falha_explicando() {
    novo_cenario
    EXTRA_ENV=("DGCLAW_STUB_PASST=0")
    nega "sem slirp4netns nem passt a instalacao falha" instalacao_basica
    afirma "mensagem da rede dos agentes" tem "$SAIDA" "nem o pacote slirp4netns nem o passt"
    limpar_cenario
}

# --- comando claude fora do PATH ---
# PATH sem o stub do claude: copia dos outros stubs por link simbolico.
esconder_claude() {
    mkdir -p "$TMP/stubs-sem-claude"
    local f
    for f in "$AQUI"/stubs/*; do
        [ "$(basename "$f")" = claude ] && continue
        ln -s "$f" "$TMP/stubs-sem-claude/$(basename "$f")"
    done
    ENV_BASE=("${ENV_BASE[@]/PATH=*/PATH=$TMP/stubs-sem-claude:/usr/bin:/bin}")
}

caso_claude_fora_do_path_mas_em_local_bin_instala_e_avisa() {
    novo_cenario
    esconder_claude
    mkdir -p "$RAIZ/root/.local/bin"
    printf '#!/bin/sh\nexit 0\n' >"$RAIZ/root/.local/bin/claude"; chmod +x "$RAIZ/root/.local/bin/claude"
    afirma "instala mesmo assim" instalacao_basica
    afirma "diz onde achou" tem "$SAIDA" "Claude Code encontrado em $RAIZ/root/.local/bin"
    afirma "ensina a linha do bashrc" tem "$SAIDA" ">> ~/.bashrc && source ~/.bashrc"
    limpar_cenario
}

caso_claude_inexistente_com_provedor_claude_falha() {
    novo_cenario
    esconder_claude
    nega "sem claude a instalacao falha" instalacao_basica
    afirma "diz que nao encontrou o Claude Code" tem "$SAIDA" "o Claude Code nao foi encontrado"
    afirma "aponta a pagina de instalacao" tem "$SAIDA" "https://code.claude.com/docs/en/setup"
    afirma "ensina a linha do bashrc" tem "$SAIDA" ">> ~/.bashrc && source ~/.bashrc"
    limpar_cenario
}

caso_claude_inexistente_com_provedor_codex_nao_exige() {
    novo_cenario
    esconder_claude
    afirma "codex instala sem claude" instalar "$PAINEL_PW" --usuario maria --provedor codex
    nega "nao reclama do claude" tem "$SAIDA" "o Claude Code nao foi encontrado"
    limpar_cenario
}

caso_reinstalar_preserva_linhas_alheias_do_dgclaw_env_e_anota_o_clone() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_DOMINIO=antigo.exemplo.org\nLINHA_DA_MARTA=oi\nDGCLAW_VERSAO=0.9\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    chmod 640 "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "reinstala" instalacao_basica
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a linha alheia sobreviveu" grep -qx 'LINHA_DA_MARTA=oi' "$env"
    afirma "o dominio de antes foi mantido" grep -qx 'DGCLAW_DOMINIO=antigo.exemplo.org' "$env"
    afirma "a versao foi trocada no lugar" grep -qx 'DGCLAW_VERSAO=1.0.0-teste' "$env"
    afirma "so uma linha de versao" igual 1 "$(grep -c '^DGCLAW_VERSAO=' "$env")"
    afirma "a ordem das linhas antigas foi mantida" bash -c "[ \"\$(grep -n -e '^DGCLAW_DOMINIO=' -e '^LINHA_DA_MARTA=' -e '^DGCLAW_VERSAO=' '$env' | cut -d: -f1 | tr '\n' ' ')\" = '1 2 3 ' ]"
    afirma "anota onde esta o clone" grep -qx "DGCLAW_REPO=$FALSO" "$env"
    afirma "o modo do arquivo que ja existia foi mantido" modo_e "$env" 640
    limpar_cenario
}

caso_admin_personalizado_nao_e_sobrescrito_e_o_de_fabrica_e_atualizado() {
    novo_cenario
    rm -rf "$FALSO/.git"
    local g=(git -C "$FALSO" -c user.name=t -c user.email=t@t)
    "${g[@]}" init -q
    "${g[@]}" add -A
    "${g[@]}" commit -q -m v1
    afirma "primeira instalacao" instalacao_basica
    local adm="$RAIZ/opt/dgclaw/admin"
    afirma "CLAUDE.md de fabrica" tem "$adm/CLAUDE.md" "# Admin (Claude)"
    printf '# Meu Admin personalizado\nDona Marta.\n' >"$adm/CLAUDE.md"
    printf '# Admin (Claude) v2\n' >"$FALSO/templates/admin/CLAUDE.md"
    printf '# Admin (Codex) v2\n' >"$FALSO/templates/admin/AGENTS.md"
    "${g[@]}" add -A
    "${g[@]}" commit -q -m v2
    afirma "segunda instalacao" instalacao_basica
    afirma "o CLAUDE.md personalizado nao foi tocado" tem "$adm/CLAUDE.md" "Dona Marta"
    nega "o CLAUDE.md personalizado nao virou o modelo novo" tem "$adm/CLAUDE.md" "v2"
    afirma "o modelo novo ficou ao lado" tem "$adm/CLAUDE.md.novo" "# Admin (Claude) v2"
    afirma "o aviso diz que foi personalizado" tem "$SAIDA" "foi personalizado"
    afirma "o AGENTS.md de fabrica (versao antiga do historico) foi atualizado" tem "$adm/AGENTS.md" "# Admin (Codex) v2"
    nega "o AGENTS.md atualizado nao deixa .novo" test -e "$adm/AGENTS.md.novo"
    # Rodar de novo com o modelo ja igual limpa o .novo de um arquivo que voltou ao modelo.
    cp "$FALSO/templates/admin/CLAUDE.md" "$adm/CLAUDE.md"
    afirma "terceira instalacao" instalacao_basica
    nega "arquivo igual ao modelo apaga o .novo" test -e "$adm/CLAUDE.md.novo"
    limpar_cenario
}

caso_admin_sem_historico_git_e_diferente_do_modelo_vira_novo() {
    novo_cenario
    afirma "primeira instalacao" instalacao_basica
    local adm="$RAIZ/opt/dgclaw/admin"
    printf '# Admin (Claude) v2\n' >"$FALSO/templates/admin/CLAUDE.md"
    afirma "segunda instalacao (zip, sem historico)" instalacao_basica
    afirma "sem como provar que e de fabrica, o lado seguro: nao troca" tem "$adm/CLAUDE.md" "# Admin (Claude)"
    afirma "e deixa o novo ao lado" tem "$adm/CLAUDE.md.novo" "v2"
    limpar_cenario
}

# --- personalizacoes: o rsync --delete nao pode levar embora o que o Admin mexeu no app ---------

# repo_git_falso: torna o repositorio falso um git de verdade (com PERSONALIZAR.md no oficial).
repo_git_falso() {
    rm -rf "$FALSO/.git"
    mkdir -p "$FALSO/docs"
    echo '# personalizar' >"$FALSO/docs/PERSONALIZAR.md"
    printf '# Personalizações do meu DG Claw\n\nCaderno.\n' >"$FALSO/templates/admin/PERSONALIZACOES.md"
    echo 'oficial' >"$FALSO/web/apagar-depois.js"
    GIT_F=(git -C "$FALSO" -c user.name=t -c user.email=t@t)
    "${GIT_F[@]}" init -q
    "${GIT_F[@]}" add -A
    "${GIT_F[@]}" commit -q -m v1
}

caso_app_alterado_a_mao_vai_para_a_pasta_de_migracao() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin"
    afirma "instalacao nova nao cria pasta de migracao" test ! -e "$adm/personalizacoes-migracao"
    printf '// editado pelo Admin\n' >>"$app/web/server.js"
    echo 'novo' >"$app/web/extra.js"
    rm -f "$app/web/apagar-depois.js"
    afirma "segunda instalacao" instalacao_basica
    local pasta lista
    pasta="$(find "$adm/personalizacoes-migracao" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    lista="$pasta/LISTA.txt"
    afirma "criou a pasta de migracao" test -d "$pasta"
    afirma "a pasta e so do root (700)" modo_e "$pasta" 700
    afirma "LISTA tem M do arquivo editado" grep -qxP 'M\tweb/server.js' "$lista"
    afirma "LISTA tem A do arquivo acrescentado" grep -qxP 'A\tweb/extra.js' "$lista"
    afirma "LISTA tem D do arquivo apagado" grep -qxP 'D\tweb/apagar-depois.js' "$lista"
    afirma "LISTA so tem as 3 linhas" igual 3 "$(grep -c . "$lista")"
    afirma "o patch tem a edicao" tem "$pasta/diff.patch" "+// editado pelo Admin"
    afirma "o tar abre e guarda o arquivo novo" bash -c "tar -tzf '$pasta/app-antes.tar.gz' | grep -q 'web/extra.js'"
    afirma "o tar guarda a edicao" bash -c "tar -xzOf '$pasta/app-antes.tar.gz' ./web/server.js | grep -q 'editado pelo Admin'"
    afirma "tem o LEIA.txt" test -s "$pasta/LEIA.txt"
    afirma "o PENDENTE existe" test -s "$adm/personalizacoes-migracao/PENDENTE"
    afirma "o aviso aparece na saida" tem "$SAIDA" "dgclaw personalizacoes levantar"
    afirma "o app voltou a ser igual ao oficial (editado)" bash -c "! grep -q 'editado pelo Admin' '$app/web/server.js'"
    afirma "o app voltou a ser igual ao oficial (acrescentado)" test ! -e "$app/web/extra.js"
    afirma "o app voltou a ser igual ao oficial (apagado)" test -f "$app/web/apagar-depois.js"
    limpar_cenario
}

caso_reinstalar_sem_diferenca_nao_cria_pasta_nem_pendente() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local adm="$RAIZ/opt/dgclaw/admin"
    afirma "o registro nasceu do modelo" test -s "$adm/PERSONALIZACOES.md"
    afirma "segunda instalacao" instalacao_basica
    afirma "terceira instalacao" instalacao_basica
    afirma "nenhuma pasta de migracao" test ! -e "$adm/personalizacoes-migracao"
    afirma "nenhum PENDENTE" test ! -e "$adm/personalizacoes-migracao/PENDENTE"
    limpar_cenario
}

caso_instalacao_anterior_ao_registro_deixa_pendente() {
    novo_cenario
    repo_git_falso
    # versao do programa sem docs/PERSONALIZAR.md (como as distribuidas antes desta funcionalidade)
    "${GIT_F[@]}" rm -q -f docs/PERSONALIZAR.md
    "${GIT_F[@]}" commit -q -m sem-doc
    afirma "primeira instalacao" instalacao_basica
    local adm="$RAIZ/opt/dgclaw/admin"
    rm -f "$adm/PERSONALIZACOES.md"
    afirma "segunda instalacao" instalacao_basica
    afirma "o PENDENTE existe" test -s "$adm/personalizacoes-migracao/PENDENTE"
    afirma "o PENDENTE diz o motivo" tem "$adm/personalizacoes-migracao/PENDENTE" "instalacao anterior ao registro de personalizacoes"
    afirma "sem diferenca no app nao cria pasta datada" test -z "$(find "$adm/personalizacoes-migracao" -mindepth 1 -type d)"
    afirma "o registro foi criado" test -s "$adm/PERSONALIZACOES.md"
    limpar_cenario
}

caso_registro_existente_nao_e_sobrescrito() {
    novo_cenario
    repo_git_falso
    mkdir -p "$RAIZ/opt/dgclaw/admin"
    printf '# meu registro\n## 2026-10-19 - Algo\n' >"$RAIZ/opt/dgclaw/admin/PERSONALIZACOES.md"
    afirma "instalacao" instalacao_basica
    afirma "o registro existente foi mantido" tem "$RAIZ/opt/dgclaw/admin/PERSONALIZACOES.md" "# meu registro"
    nega "e nao virou o modelo" tem "$RAIZ/opt/dgclaw/admin/PERSONALIZACOES.md" "Personalizações do meu DG Claw"
    limpar_cenario
}

caso_versao_sem_hash_guarda_copia_sem_base() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" env="$RAIZ/etc/dgclaw/dgclaw.env"
    sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=v1/; /^DGCLAW_COMMIT=/d' "$env"
    printf '// editado\n' >>"$app/web/server.js"
    # Simula a instalacao de antes do registro (zip de 17/10): o app ainda nao tinha o guia.
    rm -f "$app/docs/PERSONALIZAR.md"
    afirma "segunda instalacao" instalacao_basica
    local pasta
    pasta="$(find "$adm/personalizacoes-migracao" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    afirma "criou a pasta" test -d "$pasta"
    afirma "LISTA diz que nao ha base" tem "$pasta/LISTA.txt" "sem base de comparacao"
    nega "nao ha diff.patch" test -e "$pasta/diff.patch"
    afirma "o tar do app abre e tem a edicao" bash -c "tar -xzOf '$pasta/app-antes.tar.gz' ./web/server.js | grep -q editado"
    afirma "o PENDENTE existe" test -s "$adm/personalizacoes-migracao/PENDENTE"
    limpar_cenario
}

# sem_base: apaga o commit anotado no dgclaw.env (a instalacao seguinte nao tem com o que comparar).
sem_base() { sed -i 's/^DGCLAW_VERSAO=.*/DGCLAW_VERSAO=v1/; /^DGCLAW_COMMIT=/d' "$RAIZ/etc/dgclaw/dgclaw.env"; }


caso_sem_base_com_guia_guarda_copia_e_nao_acumula_copias_iguais() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" mig
    mig="$adm/personalizacoes-migracao"
    sem_base
    afirma "segunda instalacao" instalacao_basica
    afirma "sem base, mesmo com o guia, guarda uma copia" igual 1 "$(find "$mig" -mindepth 1 -maxdepth 1 -type d | wc -l)"
    local pasta; pasta="$(find "$mig" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    afirma "a copia tem a IMPRESSAO" test -s "$pasta/IMPRESSAO"
    afirma "a copia tem o tar" bash -c "tar -tzf '$pasta/app-antes.tar.gz' >/dev/null"
    afirma "o PENDENTE existe" test -s "$mig/PENDENTE"
    sem_base
    afirma "terceira instalacao (app igual)" instalacao_basica
    afirma "app igual: nao cria outra copia" igual 1 "$(find "$mig" -mindepth 1 -maxdepth 1 -type d | wc -l)"
    afirma "diz numa linha que e identico" tem "$SAIDA" "identico ao da ultima copia"
    printf '// mexido\n' >>"$app/web/server.js"
    sem_base
    afirma "quarta instalacao (app mudou)" instalacao_basica
    afirma "app diferente: cria outra copia" igual 2 "$(find "$mig" -mindepth 1 -maxdepth 1 -type d | wc -l)"
    limpar_cenario
}

caso_env_e_banco_nao_somem_sem_copia_mas_artefatos_regeneraveis_sim() {
    novo_cenario
    repo_git_falso
    # O .gitignore do repositorio ignora .env e *.db: isso NAO pode esconder o arquivo da copia.
    printf '.env\n*.db\nrunner/dist/\n' >"$FALSO/.gitignore"
    "${GIT_F[@]}" add -A
    "${GIT_F[@]}" commit -q -m gitignore
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" lista
    printf 'CHAVE=segredo\n' >"$app/.env"
    printf 'dados\n' >"$app/web/dados.db"
    mkdir -p "$app/runner/dist" "$app/web/__pycache__"
    printf 'js\n' >"$app/runner/dist/x.js"
    printf 'pyc\n' >"$app/web/__pycache__/a.pyc"
    printf 'pyc\n' >"$app/web/solto.pyc"
    afirma "segunda instalacao" instalacao_basica
    lista="$(find "$adm/personalizacoes-migracao" -mindepth 2 -maxdepth 2 -name LISTA.txt | head -n 1)"
    afirma "LISTA.txt existe" test -s "$lista"
    afirma ".env entra na lista" grep -qxP 'A\t\.env' "$lista"
    afirma "*.db entra na lista" grep -qxP 'A\tweb/dados.db' "$lista"
    nega "runner/dist nao entra" grep -q 'runner/dist' "$lista"
    nega "__pycache__ nao entra" grep -q '__pycache__' "$lista"
    nega "*.pyc nao entra" grep -q 'pyc' "$lista"
    afirma ".env esta no tar da copia" bash -c "tar -xzOf '$(dirname "$lista")/app-antes.tar.gz' ./.env | grep -q segredo"
    limpar_cenario
}

caso_permissao_e_link_trocado_sao_detectados() {
    novo_cenario
    repo_git_falso
    ln -s server.js "$FALSO/web/atalho"
    ln -s server.js "$FALSO/web/atalho2"
    "${GIT_F[@]}" add -A
    "${GIT_F[@]}" commit -q -m links
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" lista
    chmod +x "$app/web/package.json"
    ln -sfn outro-alvo.js "$app/web/atalho"
    rm -f "$app/web/atalho2"
    ln -s server.js "$app/web/novo-link"
    afirma "segunda instalacao" instalacao_basica
    lista="$(find "$adm/personalizacoes-migracao" -mindepth 2 -maxdepth 2 -name LISTA.txt | head -n 1)"
    afirma "a mudanca so de permissao e P" grep -qxP 'P\tweb/package.json' "$lista"
    afirma "link trocado e L" grep -qxP 'L\tweb/atalho' "$lista"
    afirma "link apagado e L" grep -qxP 'L\tweb/atalho2' "$lista"
    afirma "link novo e L" grep -qxP 'L\tweb/novo-link' "$lista"
    afirma "so essas 4 linhas" igual 4 "$(grep -c . "$lista")"
    afirma "o LEIA.txt explica as letras" tem "$(dirname "$lista")/LEIA.txt" "P  so a permissao mudou"
    afirma "o app voltou ao oficial (sem o +x)" test ! -x "$app/web/package.json"
    limpar_cenario
}

caso_comparacao_que_falha_guarda_copia_e_marca_pendente() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" pasta
    mkdir -p "$TMP/bin"
    printf '#!/bin/sh\ncase "$*" in *-rlpcni*) echo "rsync: falha de mentira" >&2; exit 23 ;; esac\nexec /usr/bin/rsync "$@"\n' >"$TMP/bin/rsync"
    chmod +x "$TMP/bin/rsync"
    printf '// editado\n' >>"$app/web/server.js"
    EXTRA_ENV=("PATH=$TMP/bin:$AQUI/stubs:/usr/bin:/bin")
    afirma "segunda instalacao (comparacao falha)" instalacao_basica
    pasta="$(find "$adm/personalizacoes-migracao" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    afirma "guardou a copia" test -s "$pasta/app-antes.tar.gz"
    afirma "a LISTA diz que nao deu para comparar" tem "$pasta/LISTA.txt" "nao deu para comparar"
    afirma "o PENDENTE existe" test -s "$adm/personalizacoes-migracao/PENDENTE"
    afirma "o aviso cita o codigo do rsync" tem "$SAIDA" "codigo 23"
    nega "nao ha diff.patch" test -e "$pasta/diff.patch"
    limpar_cenario
}

caso_link_quebrado_no_app_nao_trava_a_reinstalacao() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    local app="$RAIZ/opt/dgclaw/app" adm="$RAIZ/opt/dgclaw/admin" pasta
    ln -s /nao/existe/mesmo "$app/web/quebrado"
    printf '// editado\n' >>"$app/web/server.js"
    afirma "segunda instalacao termina" instalacao_basica
    pasta="$(find "$adm/personalizacoes-migracao" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    afirma "o tar guardou o link quebrado" bash -c "tar -tzf '$pasta/app-antes.tar.gz' | grep -q 'web/quebrado'"
    afirma "o link quebrado esta na LISTA como L" grep -qxP 'L\tweb/quebrado' "$pasta/LISTA.txt"
    afirma "o patch tem a edicao do arquivo regular" tem "$pasta/diff.patch" "+// editado"
    nega "o patch nao fala do link" tem "$pasta/diff.patch" "quebrado"
    limpar_cenario
}

caso_ensaio_nao_grava_pasta_de_migracao() {
    novo_cenario
    repo_git_falso
    afirma "primeira instalacao" instalacao_basica
    printf '// editado\n' >>"$RAIZ/opt/dgclaw/app/web/server.js"
    afirma "ensaio" instalacao_basica --ensaio
    afirma "o ensaio anuncia a copia" tem "$SAIDA" "guardaria uma copia"
    afirma "nenhuma pasta de migracao" test ! -e "$RAIZ/opt/dgclaw/admin/personalizacoes-migracao"
    afirma "a edicao continua no app" tem "$RAIZ/opt/dgclaw/app/web/server.js" "// editado"
    limpar_cenario
}
