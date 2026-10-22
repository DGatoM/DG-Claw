# shellcheck shell=bash
# shellcheck disable=SC2034,SC2016
# (SC2016: os `$http_upgrade` e `$host` dos trechos do nginx sao texto, nao variavel do shell.)
# Casos do modo --proxy-existente, da porta do painel (--porta-painel) e da faixa de rede dos
# agentes (--faixa-rede), mais a cerca de rede do lib/firewall.sh com a faixa configurada.
# Carregado com source por rodar.sh, junto de casos.sh (usa novo_cenario, afirma, tem...).

# Quem esta nas portas 80 e 443 num servidor com nginx (formato do `ss -ltnpH`).
SS_NGINX='LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))
LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=812,fd=7))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=701,fd=3))'

# proxy_basico <args extras...>: instala em modo proxy, com dominio, porta 8400 e faixa 10.91.
proxy_basico() {
    instalar "$PAINEL_PW" --usuario maria --provedor claude --dominio painel.exemplo.com.br \
        --proxy-existente --porta-painel 8400 --faixa-rede 10.91.0.0/16 "$@"
}

# proxy_basico_sem_senha: o mesmo, sem senha no STDIN, para sair o link de primeiro acesso.
proxy_basico_sem_senha() {
    instalar "" --usuario maria --provedor claude --dominio painel.exemplo.com.br \
        --proxy-existente --porta-painel 8400 --faixa-rede 10.91.0.0/16 "$@"
}

caso_proxy_instala_sem_caddy_sem_ufw_e_com_a_porta_do_painel() {
    novo_cenario
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1" "DGCLAW_STUB_SS=$SS_NGINX")
    mkdir -p "$RAIZ/etc/ufw"; printf 'ENABLED=yes\n' >"$RAIZ/etc/ufw/ufw.conf"
    afirma "a instalacao termina com sucesso" proxy_basico_sem_senha
    local e="$RAIZ/etc/dgclaw" u="$RAIZ/etc/systemd/system"
    afirma "80 e 443 do nginx viram aviso, nao falha" tem "$SAIDA" "a porta 80 esta com nginx. Tudo bem"
    afirma "aviso tambem da 443" tem "$SAIDA" "a porta 443 esta com nginx. Tudo bem"
    afirma "a checagem final fala do modo" tem "$SAIDA" "porta 8400 livre em 127.0.0.1 (as portas 80 e 443 ficam com o seu proxy)"
    nega "nada em /etc/caddy" test -e "$RAIZ/etc/caddy"
    nega "nenhum repositorio do Caddy" test -e "$RAIZ/etc/apt/sources.list.d/caddy-stable.list"
    nega "nenhum comando caddy" grep -q '^caddy ' "$STUB_LOG"
    nega "nenhum systemctl de caddy" grep -qE '^systemctl .*caddy' "$STUB_LOG"
    nega "nenhum comando ufw (nem status)" grep -q '^ufw ' "$STUB_LOG"
    nega "o apt nao instalou caddy nem ufw" grep -qE '^apt-get install .*(caddy|ufw)' "$STUB_LOG"
    afirma "o apt instalou o podman" grep -qE '^apt-get install -y .*podman' "$STUB_LOG"
    afirma "ufw ligado: diz que ficou como estava" tem "$SAIDA" "o ufw esta ligado e ficou como estava"
    afirma "unidade do web na porta pedida" tem "$u/dgclaw-web.service" "Environment=DGCLAW_WEB_PORT=8400"
    afirma "unidade do web so em 127.0.0.1" tem "$u/dgclaw-web.service" "Environment=DGCLAW_WEB_HOST=127.0.0.1"
    nega "unidade do web sem a 8300 antiga" tem "$u/dgclaw-web.service" "8300"
    afirma "dgclaw.env: modo proxy" grep -qx 'DGCLAW_PROXY_EXISTENTE=1' "$e/dgclaw.env"
    afirma "dgclaw.env: porta do painel" grep -qx 'DGCLAW_PORTA_PAINEL=8400' "$e/dgclaw.env"
    afirma "dgclaw.env: faixa de rede" grep -qx 'DGCLAW_FAIXA_REDE=10.91.0.0/16' "$e/dgclaw.env"
    afirma "dgclaw.env: dominio" grep -qx 'DGCLAW_DOMINIO=painel.exemplo.com.br' "$e/dgclaw.env"
    afirma "a cerca dos containers continua instalada" test -f "$u/dgclaw-firewall.service"
    afirma "e continua reiniciada" tem "$STUB_LOG" "systemctl restart dgclaw-firewall.service"
    nega "nao testou https do dominio" grep -q 'https://painel.exemplo.com.br' "$STUB_LOG"
    afirma "testou o painel na porta pedida" grep -q 'curl .*http://127.0.0.1:8400/' "$STUB_LOG"
    afirma "testou o runner do Admin" grep -q 'curl .*http://127.0.0.1:4300/api/saude' "$STUB_LOG"
    afirma "deu o primeiro boot ao Admin" tem "$SAIDA" "o Admin recebeu o recado de primeiro boot"
    afirma "diz que esta atras do proxy, em 127.0.0.1:8400" tem "$SAIDA" "atrás do seu proxy, e escuta só em http://127.0.0.1:8400"
    afirma "trecho nginx: server_name" tem "$SAIDA" "server_name painel.exemplo.com.br;"
    afirma "trecho nginx: listen 80" tem "$SAIDA" "listen 80;"
    afirma "trecho nginx: proxy_pass" tem "$SAIDA" "proxy_pass http://127.0.0.1:8400;"
    afirma "trecho nginx: limite de upload" tem "$SAIDA" "client_max_body_size 100m;"
    afirma "trecho nginx: websocket (Upgrade)" tem "$SAIDA" 'proxy_set_header Upgrade $http_upgrade;'
    afirma "trecho nginx: Connection upgrade" tem "$SAIDA" 'proxy_set_header Connection "upgrade";'
    afirma "trecho nginx: Host" tem "$SAIDA" 'proxy_set_header Host $host;'
    afirma "trecho nginx: X-Forwarded-Proto" tem "$SAIDA" 'proxy_set_header X-Forwarded-Proto $scheme;'
    afirma "trecho nginx: sem buffer (streaming do chat)" tem "$SAIDA" "proxy_buffering off;"
    afirma "trecho nginx: timeouts longos" tem "$SAIDA" "proxy_read_timeout 3600s;"
    afirma "dica do certbot" tem "$SAIDA" "certbot --nginx -d painel.exemplo.com.br"
    afirma "dica do nginx -t" tem "$SAIDA" "nginx -t && systemctl reload nginx"
    afirma "trecho cloudflared: hostname" tem "$SAIDA" "- hostname: painel.exemplo.com.br"
    afirma "trecho cloudflared: service" tem "$SAIDA" "service: http://127.0.0.1:8400"
    afirma "trecho cloudflared: DNS" tem "$SAIDA" "cloudflared tunnel route dns <nome-do-tunel> painel.exemplo.com.br"
    afirma "link de primeiro acesso" grep -qE 'https://painel.exemplo.com.br/primeiro-acesso#[A-Za-z0-9_-]{43}' "$SAIDA"
    afirma "avisa que o link so abre com o proxy apontando" tem "$SAIDA" "só abre depois que o seu proxy estiver apontando"
    afirma "avisa como gerar outro" tem "$SAIDA" "sudo dgclaw primeiro-acesso"
    limpar_cenario
}

caso_proxy_com_ufw_desligado_diz_que_continua_desligado_e_nao_chama_ufw() {
    novo_cenario
    afirma "a instalacao termina com sucesso" proxy_basico
    afirma "diz que continua desligado" tem "$SAIDA" "o ufw esta desligado ou nao existe aqui, e continua assim"
    nega "nenhum comando ufw" grep -q '^ufw ' "$STUB_LOG"
    limpar_cenario
}

caso_proxy_com_caddy_ja_instalado_nao_mexe_nele() {
    novo_cenario
    mkdir -p "$RAIZ/etc/caddy"; printf 'loja.exemplo.com {\n\trespond "oi"\n}\n' >"$RAIZ/etc/caddy/Caddyfile"
    EXTRA_ENV=("DGCLAW_STUB_INSTALADOS=caddy")
    afirma "a instalacao termina com sucesso" proxy_basico
    afirma "o Caddyfile dele ficou intacto" grep -q '^loja.exemplo.com {' "$RAIZ/etc/caddy/Caddyfile"
    igual "e sem nenhuma linha nossa" 0 "$(grep -c 'DG Claw' "$RAIZ/etc/caddy/Caddyfile")"
    nega "nenhum systemctl de caddy" grep -qE '^systemctl .*caddy' "$STUB_LOG"
    limpar_cenario
}

caso_proxy_sem_dominio_falha_explicando() {
    novo_cenario
    nega "sem --dominio e sem dominio anterior" instalar "$PAINEL_PW" --usuario maria --provedor claude --proxy-existente
    afirma "diz que o dominio e obrigatorio" tem "$SAIDA" "o dominio e obrigatorio"
    afirma "explica que o nginx ou tunel precisa de um nome" tem "$SAIDA" "nginx ou tunel precisa de um nome"
    afirma "da o exemplo de comando" tem "$SAIDA" "--dominio painel.minhaempresa.com.br --proxy-existente"
    nega "nao caiu no sslip" tem "$SAIDA" "sslip.io"
    limpar_cenario
}

caso_proxy_usa_o_dominio_da_instalacao_anterior() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "instala so com --proxy-existente" instalar "$PAINEL_PW" --usuario maria --provedor claude --proxy-existente
    afirma "manteve o dominio" grep -qx 'DGCLAW_DOMINIO=antigo.exemplo.org' "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "os trechos usam o dominio anterior" tem "$SAIDA" "server_name antigo.exemplo.org;"
    afirma "porta padrao 8300 no trecho" tem "$SAIDA" "proxy_pass http://127.0.0.1:8300;"
    limpar_cenario
}

caso_proxy_reexecucao_sem_a_flag_mantem_o_modo_e_sem_proxy_existente_volta_ao_normal() {
    novo_cenario
    afirma "primeira instalacao em modo proxy" proxy_basico
    : >"$STUB_LOG"
    afirma "reexecucao sem a flag, sem porta e sem faixa" instalar "$PAINEL_PW" --usuario maria --provedor claude
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "continua em modo proxy" grep -qx 'DGCLAW_PROXY_EXISTENTE=1' "$env"
    afirma "continua com a porta 8400" grep -qx 'DGCLAW_PORTA_PAINEL=8400' "$env"
    afirma "continua com a faixa 10.91" grep -qx 'DGCLAW_FAIXA_REDE=10.91.0.0/16' "$env"
    igual "uma so linha de modo" 1 "$(grep -c '^DGCLAW_PROXY_EXISTENTE=' "$env")"
    afirma "a unidade manteve a porta" tem "$RAIZ/etc/systemd/system/dgclaw-web.service" "DGCLAW_WEB_PORT=8400"
    afirma "os trechos continuam saindo" tem "$SAIDA" "proxy_pass http://127.0.0.1:8400;"
    nega "continua sem caddy" test -e "$RAIZ/etc/caddy"
    nega "continua sem ufw" grep -q '^ufw ' "$STUB_LOG"
    : >"$STUB_LOG"
    afirma "--sem-proxy-existente volta ao normal" instalar "$PAINEL_PW" --usuario maria --provedor claude --sem-proxy-existente
    afirma "modo gravado como 0" grep -qx 'DGCLAW_PROXY_EXISTENTE=0' "$env"
    afirma "Caddyfile do DG Claw escrito com a porta do painel" tem "$RAIZ/etc/caddy/Caddyfile" "reverse_proxy 127.0.0.1:8400"
    afirma "Caddyfile com o dominio" tem "$RAIZ/etc/caddy/Caddyfile" "painel.exemplo.com.br {"
    afirma "ufw voltou a ser configurado" tem "$STUB_LOG" "ufw allow 80/tcp"
    afirma "mensagem final de volta ao normal" tem "$SAIDA" "instalado e configurado em https://painel.exemplo.com.br"
    nega "sem trecho de nginx no modo normal" tem "$SAIDA" "proxy_pass"
    limpar_cenario
}

caso_flags_opostas_juntas_falham() {
    novo_cenario
    nega "as duas flags juntas" instalar "$PAINEL_PW" --usuario maria --provedor claude --proxy-existente --sem-proxy-existente
    afirma "explica" tem "$SAIDA" "foram usadas juntas"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_modo_normal_continua_igual_com_porta_e_faixa_padrao() {
    novo_cenario
    afirma "a instalacao termina com sucesso" instalacao_basica
    local env="$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "modo normal gravado como 0" grep -qx 'DGCLAW_PROXY_EXISTENTE=0' "$env"
    afirma "porta padrao gravada" grep -qx 'DGCLAW_PORTA_PAINEL=8300' "$env"
    afirma "faixa padrao gravada" grep -qx 'DGCLAW_FAIXA_REDE=10.89.0.0/16' "$env"
    afirma "ufw configurado como sempre" tem "$STUB_LOG" "ufw allow 443/tcp"
    afirma "caddy instalado pelo apt" grep -qE '^apt-get install .*caddy' "$STUB_LOG"
    afirma "Caddyfile na 8300" tem "$RAIZ/etc/caddy/Caddyfile" "reverse_proxy 127.0.0.1:8300"
    limpar_cenario
}

caso_modo_normal_com_porta_do_painel_diferente_vai_para_o_caddy_e_a_unidade() {
    novo_cenario
    afirma "instala com --porta-painel=8450" instalacao_basica --porta-painel=8450
    afirma "Caddyfile na porta nova" tem "$RAIZ/etc/caddy/Caddyfile" "reverse_proxy 127.0.0.1:8450"
    afirma "unidade na porta nova" tem "$RAIZ/etc/systemd/system/dgclaw-web.service" "DGCLAW_WEB_PORT=8450"
    afirma "testou a porta nova" grep -q 'curl .*http://127.0.0.1:8450/' "$STUB_LOG"
    limpar_cenario
}

caso_ensaio_no_modo_proxy_nao_cria_nada_e_mostra_o_que_faria() {
    novo_cenario
    afirma "o ensaio termina com sucesso" proxy_basico --ensaio
    afirma "a raiz continua vazia" vazio "$RAIZ"
    afirma "anuncia o modo" tem "$SAIDA" "modo proxy existente"
    afirma "diz que nao mexe no caddy" tem "$SAIDA" "Nao escrevi nada em /etc/caddy"
    afirma "anuncia a gravacao do modo no dgclaw.env" tem "$SAIDA" "poria DGCLAW_PROXY_EXISTENTE=1"
    afirma "anuncia o teste na porta do painel" tem "$SAIDA" "testaria http://127.0.0.1:8400/"
    afirma "avisa que e ensaio" tem "$SAIDA" "isto foi um ensaio"
    nega "nenhum ufw" grep -q '^ufw ' "$STUB_LOG"
    limpar_cenario
}

# --- porta do painel ---------------------------------------------------------------

caso_porta_painel_invalida_falha() {
    novo_cenario
    local v
    for v in 80 abc 70000 1023 08300; do
        nega "porta '$v' recusada" instalar "$PAINEL_PW" --usuario maria --provedor claude --porta-painel "$v"
        afirma "porta '$v': mensagem com o valor e o exemplo" tem "$SAIDA" "--porta-painel 8300"
    done
    nega "porta vazia" instalar "$PAINEL_PW" --usuario maria --provedor claude --porta-painel=
    afirma "porta vazia: diz que precisa de valor" tem "$SAIDA" "precisa de um valor"
    nega "faixa vazia" instalar "$PAINEL_PW" --usuario maria --provedor claude --faixa-rede ""
    afirma "faixa vazia: diz que precisa de valor" tem "$SAIDA" "precisa de um valor"
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_PORTA_PAINEL=abc\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    nega "reexecucao com porta ruim no dgclaw.env" instalar "$PAINEL_PW" --usuario maria --provedor claude
    afirma "diz que a linha e do dgclaw.env" tem "$SAIDA" "DGCLAW_PORTA_PAINEL em"
    limpar_cenario
}

caso_porta_painel_ocupada_por_outro_processo_falha() {
    novo_cenario
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1" 'DGCLAW_STUB_SS=LISTEN 0 511 127.0.0.1:8400 0.0.0.0:* users:(("python3",pid=900,fd=4))')
    nega "porta ocupada" proxy_basico
    afirma "diz quem ocupa" tem "$SAIDA" "ja esta em uso por python3"
    afirma "sugere --porta-painel" tem "$SAIDA" "--porta-painel 8400"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_porta_painel_do_proprio_web_de_uma_instalacao_anterior_passa() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1" "DGCLAW_STUB_ATIVOS=dgclaw-web.service"
        'DGCLAW_STUB_SS=LISTEN 0 511 127.0.0.1:8300 0.0.0.0:* users:(("node",pid=900,fd=4))')
    afirma "node do dgclaw-web na 8300 e nosso" instalacao_basica
    limpar_cenario

    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1"
        'DGCLAW_STUB_SS=LISTEN 0 511 127.0.0.1:8300 0.0.0.0:* users:(("node",pid=900,fd=4))')
    nega "node na 8300 com o dgclaw-web parado e de outro" instalacao_basica
    afirma "diz quem ocupa" tem "$SAIDA" "ja esta em uso por node"
    limpar_cenario

    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_DOMINIO=antigo.exemplo.org\nDGCLAW_PORTA_PAINEL=8301\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1" "DGCLAW_STUB_ATIVOS=dgclaw-web.service"
        'DGCLAW_STUB_SS=LISTEN 0 511 127.0.0.1:8300 0.0.0.0:* users:(("node",pid=900,fd=4))')
    nega "node na 8300, mas o nosso estava na 8301 e eu peco a 8300: de outro" instalar "$PAINEL_PW" --usuario maria --provedor claude --porta-painel 8300
    limpar_cenario
}

caso_modo_normal_com_80_ocupada_continua_falhando_e_sugere_o_proxy() {
    novo_cenario
    EXTRA_ENV=("DGCLAW_TESTAR_PORTAS=1" "DGCLAW_STUB_SS=$SS_NGINX")
    nega "80 e 443 ocupadas no modo normal" instalacao_basica
    afirma "diz as portas" tem "$SAIDA" "porta 80 (nginx)"
    afirma "sugere --proxy-existente" tem "$SAIDA" "--proxy-existente"
    limpar_cenario
}

# --- faixa de rede -------------------------------------------------------------------

caso_faixa_rede_invalida_falha() {
    novo_cenario
    local v
    for v in 10.89.1.0/24 8.8.0.0/16 lixo 172.32.0.0/16 192.169.0.0/16 10.89.0.0/8 10.300.0.0/16 10.89.0.1/16; do
        nega "faixa '$v' recusada" instalar "$PAINEL_PW" --usuario maria --provedor claude --faixa-rede "$v"
        afirma "faixa '$v': explica e da o exemplo" tem "$SAIDA" "--faixa-rede 10.91.0.0/16"
    done
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

caso_faixa_rede_validas_passam() {
    novo_cenario
    local v
    for v in 10.0.0.0/16 172.31.0.0/16 192.168.0.0/16; do
        rm -rf "$RAIZ"; mkdir -p "$RAIZ"
        afirma "faixa '$v' aceita" instalacao_basica --faixa-rede "$v"
        afirma "faixa '$v' gravada" grep -qx "DGCLAW_FAIXA_REDE=$v" "$RAIZ/etc/dgclaw/dgclaw.env"
    done
    limpar_cenario
}

caso_faixa_rede_ocupada_por_rede_podman_de_outro_sistema_recusa() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=jaula|10.91.0.0/16|podman5')
    nega "mesma faixa" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz o nome da rede" tem "$SAIDA" "a rede 'jaula' do podman usa 10.91.0.0/16"
    afirma "sugere outra faixa" tem "$SAIDA" "--faixa-rede 10.92.0.0/16"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=jaula|10.91.5.0/24|podman5')
    nega "sobreposicao parcial (um /24 dentro do /16)" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz o nome da rede e a sub-rede" tem "$SAIDA" "a rede 'jaula' do podman usa 10.91.5.0/24"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=podman|10.88.0.0/16|podman0')
    nega "a rede podman padrao conta como de outro sistema" instalacao_basica --faixa-rede 10.88.0.0/16
    afirma "diz o nome" tem "$SAIDA" "a rede 'podman' do podman usa 10.88.0.0/16"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=jaula|10.9.0.0/16|podman5')
    afirma "10.9.0.0/16 NAO se sobrepoe a 10.91.0.0/16 (prefixo de verdade, nao de texto)" instalacao_basica --faixa-rede 10.91.0.0/16
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=outra|10.50.0.0/24 fd00::/64|podman7')
    afirma "faixa livre segue (e sub-rede IPv6 e ignorada)" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz que a faixa esta livre" tem "$SAIDA" "faixa 10.91.0.0/16 livre"
    limpar_cenario
}

caso_faixa_rede_podman_ausente_segue_com_info() {
    novo_cenario
    # PATH sem nenhum podman (o real fica em /usr/bin): um diretorio com os stubs menos o do podman e
    # outro com os programas do sistema menos o podman.
    mkdir -p "$TMP/stubs-sem-podman" "$TMP/bin-sem-podman"
    local f
    for f in "$AQUI"/stubs/*; do
        [ "$(basename "$f")" = podman ] && continue
        ln -s "$f" "$TMP/stubs-sem-podman/$(basename "$f")"
    done
    for f in /usr/bin/*; do
        [ "$(basename "$f")" = podman ] && continue
        ln -sf "$f" "$TMP/bin-sem-podman/$(basename "$f")"
    done
    ENV_BASE=("${ENV_BASE[@]/PATH=*/PATH=$TMP/stubs-sem-podman:$TMP/bin-sem-podman}")
    afirma "instala sem podman" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz que nao ha redes para conferir" tem "$SAIDA" "o podman ainda nao esta instalado"
    limpar_cenario
}

caso_faixa_rede_ocupada_por_rota_de_outra_interface_recusa() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_ROTAS=default via 10.0.0.1 dev eth0 proto dhcp
10.91.0.0/20 dev docker0 proto kernel scope link src 10.91.0.1 linkdown')
    nega "rota do docker dentro da faixa" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz a rota e a interface" tem "$SAIDA" "a rota 10.91.0.0/20 (interface docker0)"
    afirma "sugere outra faixa" tem "$SAIDA" "--faixa-rede 10.92.0.0/16"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_ROTAS=default via 10.0.0.1 dev eth0
10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.5
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown')
    afirma "rotas fora da faixa nao atrapalham" instalacao_basica --faixa-rede 10.91.0.0/16
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_ROTAS=10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.5')
    nega "a rede do proprio servidor dentro da faixa" instalacao_basica --faixa-rede 10.0.0.0/16
    afirma "diz a interface" tem "$SAIDA" "interface eth0"
    limpar_cenario
}

caso_faixa_rede_redes_e_rotas_do_proprio_dgclaw_nao_contam() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-ana|10.91.1.0/24|podman1|1
dgclaw-sonda|10.91.254.0/24|podman9|1'
        'DGCLAW_STUB_ROTAS=10.91.1.0/24 dev podman1 proto kernel scope link src 10.91.1.1
10.91.254.0/24 dev podman9 proto kernel scope link src 10.91.254.1')
    afirma "redes e rotas dos agentes dentro da faixa passam" instalacao_basica --faixa-rede 10.91.0.0/16
    limpar_cenario
}

caso_faixa_rede_so_pela_rota_do_dgclaw_sem_nome_de_interface_tambem_passa() {
    novo_cenario
    # O podman nao devolveu a interface: a rota e reconhecida pela sub-rede exata da rede dgclaw-.
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-ana|10.91.1.0/24||1'
        'DGCLAW_STUB_ROTAS=10.91.1.0/24 dev podman1 proto kernel scope link src 10.91.1.1')
    afirma "passa" instalacao_basica --faixa-rede 10.91.0.0/16
    limpar_cenario
}

caso_faixa_rede_com_agentes_existentes_nao_troca_em_silencio() {
    novo_cenario
    afirma "instalacao inicial em 10.91" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "reexecucao sem a flag mantem 10.91" instalacao_basica
    afirma "o dgclaw.env continua com 10.91" grep -qx 'DGCLAW_FAIXA_REDE=10.91.0.0/16' "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "sem agentes, trocar a faixa e permitido" instalacao_basica --faixa-rede 10.92.0.0/16
    afirma "o dgclaw.env trocou" grep -qx 'DGCLAW_FAIXA_REDE=10.92.0.0/16' "$RAIZ/etc/dgclaw/dgclaw.env"
    # agora ha um agente de verdade no agentes.json
    printf '{"versao": 1, "agentes": [{"slug": "ana", "tipo": "agente"}]}\n' >"$RAIZ/etc/dgclaw/agentes.json"
    nega "com agente, trocar a faixa falha" instalacao_basica --faixa-rede 10.93.0.0/16
    afirma "diz a faixa em que os agentes estao" tem "$SAIDA" "estao na faixa 10.92.0.0/16 e voce pediu 10.93.0.0/16"
    afirma "diz que trocar exige recriar" tem "$SAIDA" "exige recriar"
    afirma "o dgclaw.env nao mudou" grep -qx 'DGCLAW_FAIXA_REDE=10.92.0.0/16' "$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "a mesma faixa continua valendo" instalacao_basica --faixa-rede 10.92.0.0/16
    limpar_cenario

    # instalacao antiga, sem DGCLAW_FAIXA_REDE: os agentes estao na 10.89.
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    printf '{"versao": 1, "agentes": [{"slug": "ana", "tipo": "agente"}]}\n' >"$RAIZ/etc/dgclaw/agentes.json"
    nega "agente antigo na 10.89: pedir 10.91 falha" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz 10.89.0.0/16" tem "$SAIDA" "estao na faixa 10.89.0.0/16"
    afirma "reexecucao sem a flag passa e grava 10.89" instalacao_basica
    afirma "gravou a faixa antiga" grep -qx 'DGCLAW_FAIXA_REDE=10.89.0.0/16' "$RAIZ/etc/dgclaw/dgclaw.env"
    limpar_cenario
}

caso_faixa_rede_com_rede_de_agente_fora_da_faixa_nao_troca_em_silencio() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-ana|10.89.1.0/24|podman1|1')
    nega "rede dgclaw-ana na 10.89 e faixa pedida 10.91" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz qual rede esta fora" tem "$SAIDA" "dgclaw-ana (10.89.1.0/24)"
    afirma "diz que exige recriar" tem "$SAIDA" "exige recriar"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario
}

# --- lib/firewall.sh com a faixa configurada ----------------------------------------------

# rodar_firewall: roda o firewall.sh de verdade contra o iptables falso (sem tocar no sistema).
rodar_firewall_falso() {
    env -i "HOME=$TMP" "PATH=$AQUI/stubs:/usr/bin:/bin" "DGCLAW_RAIZ=$RAIZ" \
        "DGCLAW_STUB_LOG=$STUB_LOG" "DGCLAW_STUB_ESTADO=$TMP/estado" "${EXTRA_ENV[@]}" \
        bash "$REPO/lib/firewall.sh" >"$SAIDA" 2>&1
}

caso_firewall_usa_a_faixa_do_dgclaw_env_em_todos_os_saltos() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_FAIXA_REDE=10.91.0.0/16\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "o firewall aplica" rodar_firewall_falso
    afirma "diz a faixa" tem "$SAIDA" "(10.91.0.0/16)"
    local regras="$TMP/estado/ipt-regras"
    afirma "salto INPUT -> DGCLAW_HOST na faixa" grep -qxF '|INPUT| -s 10.91.0.0/16 -j DGCLAW_HOST' "$regras"
    afirma "salto FORWARD filter -> DGCLAW_EGRESS na faixa" grep -qxF '|FORWARD| -s 10.91.0.0/16 -j DGCLAW_EGRESS' "$regras"
    afirma "salto FORWARD mangle -> DGCLAW_EGRESS na faixa" grep -qxF '|mangle/FORWARD| -s 10.91.0.0/16 -j DGCLAW_EGRESS' "$regras"
    nega "nenhum -s com a faixa padrao" grep -q -- '-s 10.89.0.0/16' "$regras"
    igual "tres saltos, todos com -s" 3 "$(grep -c -- '-s 10.91.0.0/16 -j DGCLAW_' "$regras")"
    limpar_cenario
}

caso_firewall_sem_a_linha_usa_o_padrao_10_89() {
    novo_cenario
    afirma "o firewall aplica sem dgclaw.env" rodar_firewall_falso
    afirma "salto na faixa padrao" grep -qxF '|INPUT| -s 10.89.0.0/16 -j DGCLAW_HOST' "$TMP/estado/ipt-regras"
    limpar_cenario

    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_DOMINIO=x.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "o firewall aplica com dgclaw.env sem a linha" rodar_firewall_falso
    afirma "salto na faixa padrao" grep -qxF '|INPUT| -s 10.89.0.0/16 -j DGCLAW_HOST' "$TMP/estado/ipt-regras"
    limpar_cenario
}

caso_firewall_com_faixa_invalida_falha_sem_tocar_no_iptables() {
    local v
    for v in 10.89.1.0/24 8.8.0.0/16 lixo; do
        novo_cenario
        mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_FAIXA_REDE=%s\n' "$v" >"$RAIZ/etc/dgclaw/dgclaw.env"
        nega "faixa '$v' recusada" rodar_firewall_falso
        afirma "faixa '$v': diz a faixa, o arquivo e o exemplo" grep -q "a faixa de rede '$v'.*10.91.0.0/16" "$SAIDA"
        igual "faixa '$v': nenhum iptables chamado" 0 "$(contar "$STUB_LOG" 'iptables')"
        limpar_cenario
    done
}

caso_firewall_remove_saltos_de_faixa_antiga_sem_tocar_nas_regras_dos_outros() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_FAIXA_REDE=10.89.0.0/16\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "aplica na faixa antiga" rodar_firewall_falso
    # Outra pessoa tem regras proprias na INPUT, uma delas com -s, que nao saltam para o DG Claw.
    # O iptables falso guarda em ordem: poe as dela no topo e uma de cerca de OUTRO sistema.
    printf '|INPUT| -s 10.200.0.0/16 -j ACCEPT\n|INPUT| -p tcp --dport 22 -j ACCEPT\n' >>"$TMP/estado/ipt-regras"
    printf 'DGCLAW_FAIXA_REDE=10.91.0.0/16\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "reaplica na faixa nova" rodar_firewall_falso
    local r="$TMP/estado/ipt-regras"
    afirma "salto novo na INPUT" grep -qxF '|INPUT| -s 10.91.0.0/16 -j DGCLAW_HOST' "$r"
    nega "salto antigo da INPUT sumiu" grep -qxF '|INPUT| -s 10.89.0.0/16 -j DGCLAW_HOST' "$r"
    nega "salto antigo do FORWARD sumiu" grep -qxF '|FORWARD| -s 10.89.0.0/16 -j DGCLAW_EGRESS' "$r"
    nega "salto antigo do mangle sumiu" grep -qxF '|mangle/FORWARD| -s 10.89.0.0/16 -j DGCLAW_EGRESS' "$r"
    afirma "a regra alheia com -s ficou" grep -qxF '|INPUT| -s 10.200.0.0/16 -j ACCEPT' "$r"
    afirma "a regra alheia do ssh ficou" grep -qxF '|INPUT| -p tcp --dport 22 -j ACCEPT' "$r"
    igual "o salto novo esta na posicao 1 da INPUT" "|INPUT| -s 10.91.0.0/16 -j DGCLAW_HOST" "$(grep -F '|INPUT|' "$r" | head -n 1)"
    igual "um salto so na INPUT para a cadeia nossa" 1 "$(grep -c '|INPUT| .*-j DGCLAW_HOST' "$r")"
    limpar_cenario
}

caso_firewall_nao_apaga_o_salto_certo_ao_rodar_de_novo() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"; printf 'DGCLAW_FAIXA_REDE=10.91.0.0/16\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    afirma "primeira vez" rodar_firewall_falso
    afirma "segunda vez" rodar_firewall_falso
    igual "um salto so na INPUT" 1 "$(grep -c '|INPUT| .*-j DGCLAW_HOST' "$TMP/estado/ipt-regras")"
    limpar_cenario
}

# --- redes "dgclaw-*" de OUTRO sistema, e o que e nosso de verdade -----------------------------

caso_rede_dgclaw_net_de_outro_sistema_conta_como_conflito() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-net-akaki|10.89.9.0/24|podman11')
    nega "faixa padrao 10.89 pisa na rede dgclaw-net-akaki (sem label, sem agente)" instalacao_basica
    afirma "cita a rede" tem "$SAIDA" "a rede 'dgclaw-net-akaki' do podman usa 10.89.9.0/24"
    afirma "sugere 10.91.0.0/16" tem "$SAIDA" "--faixa-rede 10.91.0.0/16"
    afirma "nada foi criado" vazio "$RAIZ"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-net-akaki|10.89.9.0/24|podman11')
    afirma "com --faixa-rede 10.91.0.0/16 segue" instalacao_basica --faixa-rede 10.91.0.0/16
    limpar_cenario
}

caso_rede_dgclaw_slug_com_agente_no_agentes_json_e_nossa() {
    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    printf '{"versao": 1, "agentes": [{"slug": "maria", "tipo": "agente"}]}\n' >"$RAIZ/etc/dgclaw/agentes.json"
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-maria|10.89.3.0/24|podman4'
        'DGCLAW_STUB_ROTAS=10.89.3.0/24 dev podman4 proto kernel scope link src 10.89.3.1')
    afirma "dgclaw-maria com agente maria e nossa (passa na faixa padrao)" instalacao_basica
    limpar_cenario

    novo_cenario
    mkdir -p "$RAIZ/etc/dgclaw"
    printf 'DGCLAW_DOMINIO=antigo.exemplo.org\n' >"$RAIZ/etc/dgclaw/dgclaw.env"
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-maria|10.89.3.0/24|podman4')
    nega "dgclaw-maria SEM agente maria no agentes.json e de outro sistema" instalacao_basica
    afirma "cita a rede" tem "$SAIDA" "a rede 'dgclaw-maria' do podman"
    limpar_cenario
}

caso_rede_com_label_dgclaw_v1_e_nossa() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-qualquer|10.89.7.0/24|podman8|1')
    afirma "label dgclaw.v1=1 e nossa (passa na faixa padrao)" instalacao_basica
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_REDES=dgclaw-qualquer|10.89.7.0/24|podman8|1')
    nega "nossa e fora da faixa pedida: nao troca em silencio" instalacao_basica --faixa-rede 10.91.0.0/16
    afirma "diz que exige recriar" tem "$SAIDA" "exige recriar"
    limpar_cenario
}

caso_sugestao_de_faixa_pula_as_ocupadas_e_admite_que_nao_ha_nenhuma() {
    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_ROTAS=10.0.0.0/8 dev tun0 scope link
10.89.0.0/16 dev eth1 scope link')
    nega "faixa padrao ocupada com VPN em 10.0.0.0/8" instalacao_basica
    afirma "sugere 172.16.0.0/16 (10.x inteira esta tomada)" tem "$SAIDA" "--faixa-rede 172.16.0.0/16"
    limpar_cenario

    novo_cenario
    EXTRA_ENV=('DGCLAW_STUB_ROTAS=10.0.0.0/8 dev tun0 scope link
172.16.0.0/12 dev tun1 scope link
192.168.0.0/16 dev tun2 scope link')
    nega "tudo ocupado" instalacao_basica
    afirma "diz que nao achou faixa livre" tem "$SAIDA" "nao achei nenhuma faixa /16 privada livre"
    nega "e nao sugere uma ocupada" tem "$SAIDA" "por exemplo: --faixa-rede"
    limpar_cenario
}
