# Uso da assinatura

Mostra quanto da assinatura de cada agente já foi gasto: a janela de 5 horas e a janela semanal.
O dono vê no Status do painel do agente e em ☰ > Uso das assinaturas. O Admin consulta pela API.

O número não é calculado pelo Web. Quem mede é o runner de cada agente, com o que o próprio
Claude Code (linha de status) ou Codex (arquivo da conversa) informa a cada resposta. Sem rede e
sem consultar a conta.

## Rota

`GET /api/v1/uso` (sessão do dono, ou `dgclaw-api GET /api/v1/uso` pelo agente):

```json
{"ok":true,"agentes":{
  "admin":{"uso":{"provedor":"claude",
    "sessao_5h":{"usado_pct":37.5,"zera_em":"2026-10-19T21:40:00.000Z","vencida":false},
    "semanal":{"usado_pct":12,"zera_em":"2026-10-24T09:00:00.000Z","vencida":false},
    "plano":null,"medido_em":"2026-10-19T18:02:11.000Z","fonte":"statusline"}},
  "ana":{"uso":{"provedor":"claude","sessao_5h":null,"semanal":null,"plano":null,"medido_em":null,"fonte":null},
    "motivo":"Ainda não houve resposta desde que o medidor foi instalado; o número aparece depois da próxima resposta do agente."},
  "bia":{"uso":null,"erro":"Não consegui falar com o runner de Bia em http://127.0.0.1:4310 (ECONNREFUSED). Confira se o serviço do agente está rodando."}
}}
```

- `agentes` tem uma chave por agente do registro (o `slug`), o Admin inclusive. Pedido feito por um agente (pela caixa, `dgclaw-api`) recebe só a chave dele: um agente não vê o uso dos outros.
- `sessao_5h` e `semanal` são `{usado_pct, zera_em, vencida}` ou `null`. **`null` quer dizer "não
  medido"**, nunca zero por cento. `usado_pct` vai de 0 a 100; `zera_em` é um horário ISO em UTC.
- `vencida: true`: o horário de zerar já passou. O valor velho continua na resposta, mas não vale
  como atual; a nova medição chega na próxima resposta do agente.
- `fonte`: `statusline` (Claude) ou `rollout` (Codex). `plano` vem preenchido só no Codex.
- `medido_em`: quando o número foi medido. `null` se nunca houve medição; aí vem também `motivo`.
- Um agente que não respondeu em 3 segundos, ou cujo runner é antigo, vem como
  `{"uso":null,"erro":"<motivo e o que fazer>"}`. Os outros agentes não são afetados.
- Agente que paga por chave de API não tem janela: as duas vêm `null`.
- Erros da rota seguem o padrão `{ok:false, erro}`: 401 sem sessão, 405 para método errado, 503 se
  o registro de agentes não pôde ser lido.

## Como o agente deve usar

Antes de começar uma tarefa pesada, ou quando o dono perguntar "quanto eu ainda tenho", leia
`GET /api/v1/uso`. Se a janela de 5 horas passa de 90%, avise o dono antes de seguir. Nunca trate
`null` como "sobrou tudo": ele só diz que ainda não há medição.
