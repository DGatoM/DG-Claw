# Alertas de entrega e pedido

No começo do texto ou legenda da mesma tool de reply, use `[ENTREGA] ` para uma
entrega importante concluída e `[PEDIDO] ` para trabalho parado esperando decisão
do dono. Um espaço ou quebra de linha deve separar o prefixo do conteúdo.

```text
[ENTREGA] O arquivo ficou pronto: https://exemplo.com/arquivo
[PEDIDO] Parei antes de publicar. Você autoriza?
```

Vale para agentes Claude e Codex e para respostas no DG Chat, Telegram e WhatsApp.
O Web remove o prefixo da exibição e colore o balão. Texto do dono, emojis sozinhos,
marcações no meio da frase e blocos de código não geram alertas. Não use para progresso.
O canal externo original pode mostrar a tag.

A pilha na direita mostra ✅ para entrega e ⚠️ para pedido. Tocar retira o ícone na
hora, carrega a origem e destaca o balão. Se a gravação falhar, o aviso volta com
explicação. O balão continua colorido depois de visto. Não há expiração automática
nem tela de gestão. **Reconhecer um pedido não significa autorizá-lo.** Responda
na conversa. O botão `?` da pilha e o Tutorial da página explicam o uso.

## API

A interface usa as mesmas rotas que agentes podem chamar. Todas usam a sessão do
login existente. Escritas exigem também `Origin` aceito pelo Web, como as outras
rotas. O acesso continua restrito ao registro de agentes desta instalação.

- `GET /api/v1/agents/<id>/alertas`: `{ok:true,alertas:[{id,mensagem_id,ep,tipo}],avisos:[]}`.
- `GET /api/v1/agents/<id>/alertas/<id-alerta>/mensagem`: origem e sequência até o
  fim da conversa, para navegar sem lacuna, inclusive fora da janela inicial.
- `POST /api/v1/agents/<id>/alertas/<id-alerta>/visto`: `{ok:true}`, idempotente.
  404 quando não pertence ao agente e 503 quando não conseguiu persistir.
- `GET /api/v1/alertas/docs.md`: este documento.

As mensagens em `/messages`, `/stream` e `/wait` incluem `alerta: entrega|pedido`
e texto limpo. O reconhecimento é compartilhado entre aparelhos, com atualização
em até 10 segundos enquanto a página está aberta. Falha na fonte aparece em
`avisos`, sem apagar os lembretes já guardados.

## Estado e distribuição

O estado mora em `<DGCLAW_WEB_DATA>/alertas/<slug>.json`, escrito por substituição
atômica com modo 0600. Preserve-o em backups e atualizações. Arquivo inválido gera
erro explícito; nunca é silenciosamente substituído por uma lista vazia.
O transcript continua como fonte da conversa. Somente as mensagens marcadas têm
uma cópia da origem no estado do alerta, para que o toque ainda funcione após a
troca de sessão. Na leitura inicial, os alertas de todo o transcript disponível
são registrados antes da paginação. A leitura incremental existente é preservada.

A implementação comum em `web/` vale para todos os agentes e instalações do
produto, sem nomes, credenciais ou caminhos de clientes fixos. Os templates de
instruções dos agentes também ensinam a marcação.

Validação: `node --test web/test/`, `node --check` nos arquivos JS e smoke por curl.
O Web usa Node nativo, sem dependências ou bundler; seus fontes são o artefato de
produção. A suíte geral é `bash tests/rodar.sh`.
