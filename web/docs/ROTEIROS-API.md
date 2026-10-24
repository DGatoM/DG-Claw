# API de roteiros (modo roteiro)

Base: `/api/v1/roteiros`. Pela caixa: `dgclaw-api GET /api/v1/roteiros`. Você só enxerga e escreve nos
roteiros em que `agente` é o seu slug. Erro é sempre `{ "ok": false, "erro": "<causa e o que fazer>" }`.

## O ciclo de um ajuste

Quando a mensagem do dono chegar com o prefixo `[roteiro <id>]`, o roteiro está aberto na tela dele e
o pedido é sobre aquele roteiro. Não cole o roteiro inteiro na conversa: grave uma versão.

1. **Ler.** `GET /api/v1/roteiros/<id>` devolve o roteiro com `texto` e `versao`. Guarde o número da `versao`.
2. **Avisar que começou.** `POST /api/v1/roteiros/<id>/ajustando` com `{"ativo": true, "nota": "cortando o gancho"}`.
   O aviso some sozinho em 15 minutos e quando entra versão nova.
3. **Gravar.** `POST /api/v1/roteiros/<id>/versoes` com
   `{"texto": "...", "resumo": "Gancho mais curto e número da Bloomberg no 2º parágrafo", "base_versao": <versao que você leu>}`.
   - `resumo` é obrigatório para você: uma linha, até 160 caracteres, dizendo o que mudou.
   - Texto igual ao atual não cria versão (`mudou: false`).
   - O roteiro vai para `aguardando_aprovacao` sozinho.
4. **Se vier 409.** Alguém (quase sempre o dono, editando à mão) gravou antes de você. A resposta traz
   `atual` com o roteiro e o texto novos. Leia, refaça o ajuste em cima do texto atual e grave de novo com a
   `versao` nova. Só mande `"forcar": true` se o dono pediu para passar por cima.
5. **Responder.** Diga em uma linha o que mudou. A tela do dono já mostra a versão nova.

## Rotas

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/roteiros?q=&estado=&agente=` | lista (sem `texto`), mais recente primeiro; `fontes.dgsocial` diz se o DG Social respondeu |
| `POST /api/v1/roteiros` | cria um roteiro local: `{titulo, texto, resumo?}` (201). O `agente` é você |
| `GET /api/v1/roteiros/<id>` | o roteiro com `texto` |
| `GET /api/v1/roteiros/<id>/estado` | só `versao`, `estado`, `ajustando`, `resumo`, `autor`, `atualizado_em` |
| `GET /api/v1/roteiros/<id>/versoes` e `/versoes/<n>` | histórico e uma versão com `texto` |
| `POST /api/v1/roteiros/<id>/versoes` | grava versão: `{texto, resumo, base_versao, forcar?}` |
| `POST /api/v1/roteiros/<id>/ajustando` | `{ativo: true, nota?}` liga, `{ativo: false}` desliga |
| `POST /api/v1/roteiros/<id>/restaurar` | `{versao, base_versao}` volta ao texto de uma versão (cria versão nova) |
| `POST /api/v1/roteiros/<id>/estado` | `{estado, nota?}` com `em_ajuste`, `aguardando_aprovacao` ou `arquivado` |
| `POST /api/v1/roteiros/<id>/abrir` | pede que a conversa aberta do dono mostre este roteiro (em até 8 s); devolve `{link}` |
| `GET /api/v1/roteiros/<id>/eventos?desde=<n>` | o que aconteceu, com `n` crescente |

O que **não** é seu: aprovar (`POST /aprovar`), desfazer (`POST /desfazer`) e marcar `aprovado`. Dão 403.
Quando o dono aprovar, chega `[roteiro <id>] [aviso] Aprovei a versão N. Pode mandar pra produção.`

## Mensagens que chegam a você

| Mensagem | O que fazer |
| --- | --- |
| `[roteiro <id>] <texto>` | pedido de ajuste do dono: faça o ciclo acima |
| `[roteiro <id>] [aviso] Salvei uma edição à mão: versão N.` | só leia a versão N antes do próximo ajuste; não responda com o roteiro |
| `[roteiro <id>] [aviso] Desfiz: voltei ao texto da versão N (agora é a versão M).` | leia a M e siga dela |
| `[roteiro <id>] [aviso] Aprovei a versão N. Pode mandar pra produção.` | siga para a próxima etapa |

## Roteiros do DG Social

Se o conector estiver ligado, os roteiros do DG Social aparecem na lista com `origem: "dgsocial"` e id
`dgs-<slug>`. O texto vive no arquivo do conteúdo lá; gravar uma versão aqui grava lá também. Se o DG Social
estiver fora do ar, a lista traz `fontes.dgsocial.ok: false` com a causa e ler ou gravar um deles dá 502.
