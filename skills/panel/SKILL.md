---
name: panel
description: Sobe, reinicia, abre e explica o painel web do assistente DG Claw, nos dois modos (local no PC e servidor na VPS). Mostra memoria, status, personalidade, identidade, operacoes, custos e o fio da conversa, e acende as areas das extensoes instaladas. Use quando o usuario rodar /dgclaw:panel, pedir pra "abrir o painel", "subir o dashboard", "ver a memoria do agente", "reiniciar o painel", "qual a URL e a senha do painel", ou "fechar o painel".
user-invocable: true
---

# /dgclaw:panel: o painel do assistente

Descubra o modo antes de qualquer coisa:

- **MODO LOCAL** (PC da pessoa; existe `.dgclaw/config.json` na pasta do agente).
- **MODO SERVIDOR** (VPS com systemd; existe `.dgclaw/config.sh`).

## Modo local

Painel web que so este computador enxerga: status vivo ou mudo, medidor de
memoria de trabalho, working-memory e memoria longa editaveis, fio da conversa do
Telegram e log de compactacoes.

Se a sessao ja esta na pasta do agente, use ela. Senao, procure
`Agente*/.dgclaw/config.json` no home e confirme qual agente e.

**Ligar** (rode em segundo plano, o painel fica servindo):

```bash
cd "<pasta do agente>" && bun .dgclaw/panel/panel.ts
```

Ele imprime a URL. Peca pra pessoa abrir `http://localhost:8200` (ou a porta que
estiver no `.dgclaw/config.json`). Se der "porta em uso", o painel ja esta ligado:
so passe a URL.

**Desligar:** o painel grava o PID em `.dgclaw/panel.pid`. Encerre esse processo
(`kill <pid>` no Mac e Linux, `taskkill /PID <pid>` no Windows) e apague o arquivo
se sobrar.

Explique uma vez: verde ocioso, laranja trabalhando, vermelho mudo (sessao
fechada, e so abrir o launcher). O medidor mostra o quanto falta pra proxima
organizacao de memoria, que e normal e avisada. Editar a memoria pelo painel vale
na conversa seguinte.

## Modo servidor

Servico Node (`dgclaw-panel-<slug>.service`) na porta 8300, servido da copia
estavel em `<workspace>/.dgclaw/panel/`. Ele so LE arquivos, nunca escreve.

Abas de fabrica: STATUS, MEMORIA, PERSONALIDADE, IDENTIDADE, OPERACOES e CUSTOS.
Abas que dependem de poder instalado (POSTS, FOLLOWERS, REUNIOES) aparecem
apagadas com um cadeado ate o poder ser acoplado.

A **area emocional** (humor no cabecalho, emocoes, necessidades, pensamentos,
opinioes) tambem aparece na tela, apagada, com um bilhete dizendo o que instalar.
Ela acende sozinha quando a extensao DG Alive esta instalada. Nada some da tela:
o dono ve o que existe e o que ele ainda nao tem.

Descubra o agente:

```bash
WS="<workspace>"; SLUG="<slug>"
PLUGIN="$WS/.dgclaw/plugin"; [ -d "$PLUGIN/scripts" ] || PLUGIN="${CLAUDE_PLUGIN_ROOT}"
CFG="$WS/.dgclaw/config.sh"
```

**Instalar ou atualizar:**

```bash
sudo bash "$PLUGIN/scripts/install-panel-service.sh" "$CFG"
```

Isso copia o painel pra `$WS/.dgclaw/panel/`, gera o `config.json` do agente,
instala as dependencias com `npm ci --omit=dev`, desativa o painel simples antigo
(8200) e sobe o servico na 8300. Anote a URL e a senha que ele imprime e passe pro
dono. Se faltar `node` ou `npm` (versao 18 ou maior), avise: sem eles o painel nao
sobe, e o resto do agente funciona igual.

**Reiniciar e investigar:**

```bash
systemctl restart "dgclaw-panel-$SLUG.service"
systemctl status  "dgclaw-panel-$SLUG.service" --no-pager | head -8
journalctl -u "dgclaw-panel-$SLUG" --no-pager -n 20
```

**Abrir:** `http://<IP-da-VPS>:8300/`, com a senha gerada na instalacao. Se o dono
esqueceu a senha, ela esta no unit:
`systemctl cat dgclaw-panel-$SLUG | grep PANEL_PASSWORD`.

**Depois de mexer em poderes ou instalar uma extensao,** reinicie o painel pra
refletir na hora (ele tambem rele sozinho pela data do arquivo, mas o restart
garante).

### Seguranca

O painel mostra arquivos de identidade e memoria, entao **sempre com senha forte**.
Numa live ou apresentacao, prefira um tunel efemero a deixar a porta 8300 aberta
pro mundo. Token e cookie sao bloqueados pela sanitizacao do painel e nunca
aparecem na tela.

### Atras do Cloudflare Access: entrar sem a senha do painel (opcional)

Se o painel fica num subdominio com Cloudflare Access na frente (o dono ja faz login
por e-mail no Access), pedir a senha do painel de novo e atrito a toa. Com tres envs
no servico, um JWT valido do Access vale como login:

```bash
sudo mkdir -p /etc/systemd/system/dgclaw-panel-$SLUG.service.d
sudo tee /etc/systemd/system/dgclaw-panel-$SLUG.service.d/cf-access.conf >/dev/null <<'CONF'
[Service]
Environment=DGCLAW_PANEL_CF_ACCESS_AUD=<AUD do app: Zero Trust > Access > Applications > o app > Overview>
Environment=DGCLAW_PANEL_CF_TEAM=<seutime>.cloudflareaccess.com
Environment=DGCLAW_PANEL_CF_EMAILS=dono@exemplo.com
CONF
sudo systemctl daemon-reload && sudo systemctl restart dgclaw-panel-$SLUG
```

O painel confere a assinatura (chaves publicas do time, em cache de 1 h), o `iss`, o
`aud`, a validade e o e-mail. Qualquer coisa errada cai na senha de sempre e deixa no
journal uma linha dizendo o motivo (nunca o JWT). Sem `DGCLAW_PANEL_CF_ACCESS_AUD`
nada disso roda. A confianca vale so com o Access na frente: nenhum cookie novo e
gravado no navegador. Teste: `node test-cf-access.mjs` na pasta do painel.
