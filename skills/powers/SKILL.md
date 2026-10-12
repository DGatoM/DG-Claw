---
name: powers
description: Gerencia os PODERES do assistente DG Claw, ou seja, as capacidades que dao a ele um trabalho novo (Instagram hoje; Reunioes, CRM e Secretaria ainda travados). Lista, instala e desativa. Use quando o usuario pedir "dar um poder pra ele", "ativar o Instagram", "instalar/remover poder", "o que ele sabe fazer", "destravar a aba X do painel", ou rodar /dgclaw:powers. Cada poder ativo destrava a aba correspondente no painel; poder travado aparece apagado.
user-invocable: true
---

# /dgclaw:powers: os poderes do assistente

Poder e capacidade de trabalho: postar no Instagram, cuidar de reunioes, tocar um
CRM. E diferente de **extensao**, que muda o jeito de ser do agente (o DG Alive,
por exemplo, acrescenta vida emocional). Poder se instala aqui; extensao se
instala pelo instalador dela.

A fonte da verdade e `<workspace>/.dgclaw/powers.json`, lida pelos crons e pelo
painel. (O painel aceita outro caminho pela variavel `DGCLAW_PANEL_POWERS`, para
agente que guarda o arquivo fora do workspace; no agente instalado pelo plugin
ela nao existe.) O `core` (memoria, personalidade e operacao) e sempre ativo. Os demais
comecam travados.

```bash
WS="<workspace do agente>"
PLUGIN="$WS/.dgclaw/plugin"; [ -d "$PLUGIN/scripts" ] || PLUGIN="${CLAUDE_PLUGIN_ROOT}"
CFG="$WS/.dgclaw/config.sh"
```

## Listar

```bash
python3 "$PLUGIN/scripts/powers.py" list --file "$WS/.dgclaw/powers.json"
```

Traduza pro dono: o que esta **ativo** e o que esta **travado**, com o motivo de
cada travado.

## Instalar

Cada poder tem uma definicao declarativa em `$PLUGIN/powers/<id>/POWER.md`, que
descreve o que instalar e o que perguntar. **Leia o POWER.md antes de instalar** e
siga o que ele manda.

- **instagram** (o unico acoplavel nesta versao): coleta token, conta e cookies,
  cria os timers de post e de comentarios, e destrava as abas POSTS e FOLLOWERS do
  painel. Conduza pela skill `/dgclaw:instagram` ou pelo
  `powers/instagram/POWER.md`. No fim o poder fica `enabled:true` e os timers
  aparecem em `systemctl list-timers 'dgclaw-<slug>-*'`.
- **meetings, crm, secretary:** ainda nao acoplados. Explique que aparecem
  travados no painel e serao liberados numa proxima versao. Nao tente instalar.

## Desativar

```bash
python3 "$PLUGIN/scripts/powers.py" disable <id> --file "$WS/.dgclaw/powers.json"
```

Depois pare os timers do poder
(`systemctl disable --now dgclaw-<slug>-<...>.timer`). Os **dados sao
preservados** (posts, seguidores, token): e so desativar, e reativar depois e
facil. As abas voltam a aparecer travadas no painel.

## Depois de mexer

```bash
systemctl restart "dgclaw-panel-<slug>.service" 2>/dev/null || true
```

O painel rele o `powers.json` sozinho pela data do arquivo, mas o restart garante
que o dono ve a mudanca na hora.
