---
name: connect
description: Conecta o assistente DG Claw a servicos Google (Drive, Gmail, Calendar) usando os connectors nativos do Claude. Use quando o usuario quiser dar ao assistente acesso ao Drive/Gmail/Agenda, perguntar "como conecto o Google", ou pedir pra ligar os connectors.
user-invocable: true
---

# /dgclaw:connect — Conectar servicos (Google)

Liga Drive / Gmail / Google Calendar no assistente usando os **connectors
nativos do Claude Code** (sem precisar criar projeto no Google Cloud nem mexer
em OAuth na mao). Cada pessoa conecta a propria conta Google.

## Como funciona (explique simples)

O Claude Code tem connectors oficiais. Voce autoriza uma vez, com sua conta
Google, e o assistente ganha ferramentas pra ler/criar arquivos no Drive, ler/
escrever e-mails no Gmail e gerenciar eventos no Calendar. A autorizacao fica
guardada e o assistente passa a usar essas ferramentas quando precisar.

## Passos

1. Liste os connectors / MCP disponiveis na sessao:
   ```
   /mcp
   ```
2. Procure os connectors **Google Drive**, **Gmail** e **Google Calendar** e
   siga o fluxo de **autorizar/login** de cada um (abre uma URL do Google pra
   aprovar). Use a conta Google que o assistente deve enxergar.
3. Confirme que ficaram conectados (no `/mcp` aparecem como conectados/ativos).

> Numa VPS sem navegador, o fluxo de login mostra uma URL pra abrir no navegador
> do seu computador e colar o codigo de volta. Oriente a pessoa nesse vai-e-volta.

## Importante pro assistente (servico 24/7)

Os connectors valem pra **sessao** do Claude. O assistente roda como uma sessao
longeva no systemd — entao a autorizacao precisa existir para o usuario que roda
o servico (o mesmo HOME). Depois de conectar, **reinicie o servico** pra sessao
do bot enxergar os connectors:

```bash
SLUG=tina   # ajuste
sudo systemctl restart "dgclaw-$SLUG"
```

## Teste

Peca pra pessoa mandar no Telegram algo como: "ve meus proximos eventos da
agenda" ou "resume meus ultimos e-mails". Se o assistente responder com dados
reais, a conexao esta funcionando.

## Privacidade (deixe claro)

Conectar da ao assistente acesso de leitura/escrita aos servicos escolhidos.
Conecte so o que fizer sentido, e lembre que so o dono (allowlist do Telegram)
consegue pedir coisas a ele.
