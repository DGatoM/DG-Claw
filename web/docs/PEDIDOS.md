# Fila de pedidos

A fila de pedidos mostra ao dono, na aba **Pedidos** da Mesa (`/mesa`), o que ele pediu a cada
agente e em que pé está: fazendo, esperando uma resposta dele, entregue ou já resolvido. Cada
pedido do dono a um agente vira um item, em ordem de chegada.

**Quem cria e move os itens é o próprio agente**, pelo comando `dgclaw-mesa pedido` (ou pela API
crua, com `dgclaw-api`). O dono acompanha pela tela, abre o item entregue, marca como feito ou
cancela. Tudo o que a tela faz passa por esta mesma API.

Funciona sozinha em cada VPS, sem nenhum serviço de fora. A verdade fica no Web, em
`<DGCLAW_WEB_DATA>/pedidos/pedidos.json`.

**O que não existe nesta versão:** um vigia que crie sozinho, com um modelo barato, o item que o
agente esqueceu de abrir. Isso exigiria uma chamada de modelo do lado do Web, na assinatura de
quem instalou. Quem garante o item é a regra "Fila de pedidos" nas instruções do agente.

## O pedido

```json
{
  "id": 7,
  "agente": "luna",
  "agente_nome": "Luna",
  "texto": "Dono, 12/11 10h25: refazer a capa",
  "estado": "entregue",
  "aberto": true,
  "motivo": null,
  "msg_entrega": {"id": "3fa9c01b22d4e7a1", "ep": 1794488000.12},
  "link_conversa": "/a/luna?msg=3fa9c01b22d4e7a1",
  "criado_por": "agente luna",
  "criado_em": "2026-11-12T10:25:00-03:00",
  "atualizado_em": "2026-11-12T11:02:00-03:00",
  "entregue_em": "2026-11-12T11:02:00-03:00",
  "fechado_em": null
}
```

| Campo | O que é |
| --- | --- |
| `texto` | o pedido em uma linha, com a data ("Dono, 12/11 10h25: ..."). Até 300 caracteres. Obrigatório |
| `estado` | `fazendo` (nasce assim), `esperando_dono`, `entregue`, `feito` ou `cancelado` |
| `motivo` | obrigatório em `esperando_dono` (o que o agente precisa do dono) e em `cancelado` quando quem cancela é o agente. Até 300. Some sozinho quando o pedido sai de `esperando_dono` |
| `msg_entrega` | em `entregue`: a mensagem da conversa em que o agente entregou (`id` e `ep`). Pode ser `null` se a conversa não pôde ser lida na hora |
| `link_conversa` | para onde a tela leva o dono: a conversa do agente, já rolada até a mensagem da entrega |
| `historico` | só em `GET /api/v1/pedidos/<id>`: quem mudou o quê e quando (os 50 mais recentes) |

## Os estados

- `fazendo`: o agente está trabalhando nisso.
- `esperando_dono`: o agente depende de uma resposta do dono. Vem com `motivo`.
- `entregue`: o agente entregou e aguarda o dono ver. Guarda `msg_entrega`: se o agente não
  passar `msg`, o servidor usa a **última mensagem do agente** naquela conversa, no momento da
  marcação.
- `feito`: o dono viu. **O agente não marca `feito`**: o servidor recusa com `403`.
- `cancelado`: encerrado sem entrega, com motivo.

`feito` e `cancelado` não mudam mais. Trabalho novo é um pedido novo.

Um pedido `entregue` vira `feito` de dois jeitos, ambos do dono:

1. ele **abre o item** na aba (`POST /api/v1/pedidos/<id>/abrir`);
2. ele **escreve na conversa daquele agente depois da entrega**. A conversa não tem "resposta a",
   então vale a primeira mensagem do dono (não de colaborador) com horário posterior à da
   entrega. O Web confere isso a cada consulta à lista, e só quando existe item `entregue`.

## Quem pode o quê

| Quem chama | Ler | Criar | Mudar |
| --- | --- | --- | --- |
| o dono (sessão do navegador) | todos | não (`403`) | `feito` e `cancelado`, em qualquer pedido aberto; abrir o item |
| um agente (pela caixa, `dgclaw-api` ou `dgclaw-mesa`) | **só os seus** (o dos outros dá `404`) | só para si | `fazendo`, `esperando_dono`, `entregue` e `cancelado`, só nos seus; `feito` dá `403` |

Colaboradores não têm acesso: a rota é só do dono e da caixa do agente.

## Rotas

Todas exigem login (navegador) ou chegam pela caixa do agente. Escrita pelo navegador exige que a
`Origin` seja a do próprio Web. Erros sempre `{"ok": false, "erro": "motivo em português"}`.

| Rota | Quem | O que faz |
| --- | --- | --- |
| `GET /api/v1/pedidos` | dono, agente | a fila. Padrão: todos os abertos + feitos e cancelados de hoje e ontem |
| `POST /api/v1/pedidos` | agente | cria, com `{"texto": "..."}`. `201` com `{ok, pedido}` |
| `GET /api/v1/pedidos/<id>` | dono, agente | um pedido, com `historico` |
| `PATCH /api/v1/pedidos/<id>` | dono, agente | muda o estado: `{"estado": "...", "motivo": "...", "msg": "<id da mensagem>"}`. Repetir o mesmo estado devolve `ja_estava: true` |
| `DELETE /api/v1/pedidos/<id>` | dono, agente | **cancela** (não apaga). Corpo `{"motivo": "..."}`: obrigatório para o agente, opcional para o dono |
| `POST /api/v1/pedidos/<id>/abrir` | dono | abre o item: se estava `entregue`, vira `feito` (`mudou: true`). Em outro estado não muda nada |
| `GET /api/v1/pedidos/docs.md` | quem tem acesso | este documento |

Filtros do `GET /api/v1/pedidos`:

- `agente=luna` ou `agente=luna,marina` (só o dono; slug que não existe dá `400` com a lista);
- `estado=esperando_dono,entregue`: só esses estados;
- `dia=recentes` (padrão), `hoje`, `todos` (inclui os arquivados) ou `2026-11-12`: o dia em que o
  pedido fechado foi encerrado. Os abertos aparecem sempre.

A resposta traz `pedidos` (esperando o dono, entregue, fazendo; depois os fechados, do mais novo
ao mais velho), `agora`, `filtro` e `contagem` (`abertos`, `esperando_dono`, `entregues`,
`fazendo`). Traz `ETag`: com `If-None-Match` o Web responde `304` quando nada mudou.

**Erros:** `400` com `erros` campo a campo, `403` (agente marcando `feito`, mexendo em pedido
alheio, ou dono tentando criar), `404`, `409` (pedido já fechado, ou limite de 100 abertos por
agente), `413` (corpo maior que 16 KB), `503` (o arquivo da fila não abriu ou não gravou; o motivo
vem no `erro`, e o arquivo nunca é trocado por uma fila vazia).

Se a conversa do agente não pode ser lida na hora de marcar `entregue` sem `msg`, o pedido é
marcado mesmo assim, sem apontar a mensagem, e a resposta traz `aviso` dizendo isso. Com `msg`
explícita e a conversa ilegível, a resposta é `503`: a mensagem não pôde ser conferida.

## Pelo agente: `dgclaw-mesa pedido`

Roda dentro do container, pela caixa (veja `docs/CAIXA-DO-AGENTE.md`).

```bash
dgclaw-mesa pedido criar --texto "Dono, 12/11 10h25: refazer a capa"
# imprime: pedido #7 criado (fazendo)
dgclaw-mesa pedido esperar 7 --motivo "capa azul ou verde? mandei as duas na conversa"
dgclaw-mesa pedido fazendo 7                    # de volta a fazendo
dgclaw-mesa pedido entregar 7                   # usa a minha última mensagem na conversa
dgclaw-mesa pedido entregar 7 --msg 3fa9c01b22d4e7a1
dgclaw-mesa pedido cancelar 7 --motivo "o dono desistiu"
dgclaw-mesa pedido ver 7
dgclaw-mesa pedido listar                       # os meus abertos e os fechados de hoje e ontem
dgclaw-mesa pedido listar --dia todos
```

Todo subcomando aceita `--json`. Os códigos de saída são os do `dgclaw-mesa`: 0 ok, 1 erro de
uso, 2 o Web não respondeu, 3 caixa indisponível, 4 o Web recusou (4xx), 5 erro do Web (5xx).

## Na tela

Aba **Pedidos**, a primeira da Mesa. Os itens são cartões com o texto do pedido, o agente, o
estado e há quanto tempo mudou. A aba acende uma bolinha quando há item esperando o dono ou
entregue. Tocar num item entregue o marca como feito e leva à conversa do agente, na mensagem da
entrega. Os botões do cartão são **Marcar como feito** e **Cancelar** (com motivo opcional).
"Ver arquivados" traz os fechados mais antigos. A tela se atualiza sozinha a cada 15 segundos.
