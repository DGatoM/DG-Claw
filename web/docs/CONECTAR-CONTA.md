# Página Conectar conta (`/conectar`)

## Para que serve

Conectar, ou reconectar, a conta do Claude (ou do Codex) de cada agente sozinho, quando você puder, sem
depender de alguém gerar um link e mandar por mensagem. O link de login vale por poucos minutos e vencia antes
de chegar até você. Nesta página ele só nasce no instante em que você toca em **Gerar link de login**.

A página tem um cartão por agente: o Admin primeiro (o agente supervisor, que cuida do servidor) e depois os
agentes de trabalho. Entra quem já tem usuário e senha do painel. O menu ☰ tem o item **Conectar conta**.

## Passo a passo

1. Toque em **Gerar link de login** no cartão do agente.
2. Toque em **Abrir a página de login** e entre com a sua conta do Claude. Para abrir em outro aparelho, use **Copiar link**.
3. No fim, a página mostra um código. Copie e cole no campo **Cole aqui o código**, depois toque em **Conectar**.
4. Repita no próximo cartão.

No Codex não há código para colar: a página mostra um código grande para você digitar no navegador, e o
cartão espera sozinho você terminar.

Só um cartão fica no meio do login por vez. Os outros botões de gerar ficam desligados, com a frase
"Termine o login do <nome> primeiro".

## Os selos

| Selo | Cor | O que quer dizer |
| --- | --- | --- |
| Conectado | verde | A conta está conectada. O programa do Claude do próprio agente confirmou (`conferido`). |
| Falta conectar | âmbar | Sem conta, ou o programa do agente não confirma a conta. |
| Login expirou | vermelho | A conta estava conectada e a credencial morreu. O agente parou de responder. |
| Usa chave de API | cinza | O agente trabalha com chave de API, não com assinatura. Não há conta para conectar e o botão não aparece. |
| Não consegui conferir | cinza | O programa do agente não respondeu. O cartão diz a causa e tem o botão **Conferir de novo**. |

O selo não é uma anotação do painel: vem de `conferido` e `auth`, que o painel pergunta ao programa de cada
agente a cada consulta.

Quando todos os agentes que usam assinatura estão conectados, aparece a faixa **Tudo conectado** com o
atalho **Ir para a conversa**.

## Erros e o que fazer

| Situação | O que a página diz |
| --- | --- |
| Código vencido ou inválido | O código vence em poucos minutos e só serve uma vez. Toque em **Gerar novo link** e cole o código novo logo em seguida. |
| 15 minutos sem terminar | O login foi cancelado sozinho. Gere um link novo. |
| Programa do agente fora do ar (503) | Diz a causa e manda conferir o Status do agente ou pedir ao Admin para reiniciar. |
| Já existe um login em andamento (409) | Termine esse login ou toque em **Cancelar**. |
| Código com espaço ou quebra no meio (400) | Mostra o texto do servidor. A página não conserta o código sozinha; só tira os espaços das pontas. Copie de novo, de uma vez. |
| Sessão do painel vencida (401) | Leva ao login e volta para `/conectar`. |

## Rotas que a página usa

Nenhuma rota é exclusiva dela; todas exigem a sessão do painel e, nas escritas, `Origin` igual ao do Web.
Contrato completo em `web/docs/LOGIN-NA-CONVERSA.md`.

- `GET /api/v1/agents`: a lista de agentes.
- `GET /api/v1/agents/<id>/login`: estado do login e selo (`estado`, `auth`, `conferido`, `precisa_login`, `login_expirado`). A cada 2 s, só para o cartão em andamento e só com a aba à vista.
- `POST /api/v1/agents/<id>/login`: gera o link (o prazo começa aqui).
- `POST /api/v1/agents/<id>/login/codigo`: entrega o código colado.
- `DELETE /api/v1/agents/<id>/login`: cancela.
- `POST /api/v1/agents/<id>/login/oi`: quando o login conclui, pede ao agente um oi curto. Se falhar, a conta continua conectada e a página avisa a causa.
- `GET /api/v1/conectar/docs.md`: este documento.

## O que nunca vai para log

O link de login (ele carrega o estado do OAuth) e o código colado nunca vão para console, log, `localStorage`,
endereço da página nem atributo `title`. O campo do código é limpo logo depois do envio, com sucesso ou erro.
Todo texto vindo do servidor entra na tela como texto, nunca como HTML.
