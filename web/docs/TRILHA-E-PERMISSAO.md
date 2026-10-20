# Trilha de comandos, cartão de permissão e fila

Três coisas que a conversa mostra para que o dono nunca fique no escuro quando o agente mexe na máquina.

## 1. Trilha de comandos (não aparece mais no histórico)

Até 18/10/2026 tudo que o agente rodava no terminal aparecia na conversa como linhas cinzas ("rodou: ...",
"falhou: ...", "rodou 5 comandos"). O dono pediu para tirar: a conversa fica só com as falas. A atividade do
agente continua visível na barrinha de status ("<agente> está trabalhando · Bash"), que some quando ele termina.

O servidor **não empurra mais itens `origin: "trilha"`** em `GET /messages` nem no evento `msgs`. Continua vivo o
controle interno dos comandos ainda sem resultado (`trilhaPend`), que alimenta o cartão de permissão (seção 2):
o `tool_use` entra no controle e o `tool_result` tira. O código que desenha o bloco em `public/conversa.js` e
`public/trilha-tela.js` ficou sem uso, porque a tela nunca recebe o item.

O que a trilha reconhece (vale para o cartão de permissão):

- Entram: `Bash` (usa a `description` que o agente escreveu, ou o próprio comando), `Write`, `Edit`, `MultiEdit` e
  `NotebookEdit` (resumo: "gravou <arquivo>", "editou <arquivo>"). Leituras (`Read`, `Grep`, `Glob`) e as
  ferramentas da própria conversa ficam de fora.
- Fonte: o transcript da sessão (`tool_use` e `tool_result`).
- Limites: comando até 1200 caracteres, resultado até 8 linhas e 700 caracteres (o corte aparece como "…").
- Segredos: comando e resultado passam por `lib/mascara.js` antes de sair do servidor (chaves de API, Bearer,
  token de bot, `NOME_DA_CHAVE=valor`, `"password": "..."`). É porte dos padrões de `runner/src/mascara.ts`; o Web
  não conhece as variáveis do agente, então um segredo fora desses formatos passa. Por isso o bloco é fechado.
- Codex: melhor esforço. Chamadas de shell do rollout (`function_call` e `function_call_output`) viram a mesma
  trilha, mas o formato muda entre versões do CLI e não foi conferido contra um rollout real. Edições de arquivo
  do Codex não entram.

## 2. Cartão de permissão

Quando o runner está em `waiting_input` (hook `Notification` com `permission_prompt`), a atividade traz
`alerta: "permissao"`, `acao: "esperando permissão"`, `detalhe: "Bash: <descrição>"` e `permissao`
(`{id, ferramenta, titulo, comando}`, onde `id` é o `tool_use_id` do pedido): o último `tool_use` do transcript que ainda não tem `tool_result`. A conversa
mostra o cartão "O agente está esperando a sua permissão" com esse pedido e os botões Aprovar e Negar. O cartão
some quando o estado sai de `waiting_input`. A linha de estado diz "esperando a sua permissão" no lugar de
"trabalhando".

### `POST /api/v1/agents/<slug>/permissao`

Corpo: `{"decisao":"aprovar"}` ou `{"decisao":"negar"}`, com `tool_use_id` opcional (o `permissao.id` do cartão que a tela
mostra). Com ele, o runner recusa se o pedido de agora for outro, e uma aba com o cartão antigo não aprova o pedido novo. Sem
ele segue como antes. Exige sessão e `Origin`, como as outras escritas.

| Status | Quando | O que fazer |
| --- | --- | --- |
| 200 | `{ok:true, decisao}` | Nada. O agente continua sozinho. |
| 400 | `decisao` diferente de aprovar/negar | Corrigir o corpo. |
| 409 | O agente não está esperando permissão (o pedido já foi resolvido), está esperando a resposta de uma pergunta de escolha (`E_PERGUNTA_NAO_PERMISSAO`: o `1` escolheria a primeira opção dela), o `tool_use_id` não é o do pedido atual (`PERMISSAO_DIFERENTE`) ou uma resposta de pergunta está sendo digitada (`RESPOSTA_EM_ANDAMENTO`) | Atualizar a conversa. Nada foi digitado. |
| 501 | O runner do agente é antigo e não tem `POST /api/agents/<id>/permissao` | Atualizar o agente pelo Admin. Até lá, responder pelo terminal. |
| 502 | O runner recusou (`error` e `howToFix` dele vêm na mensagem) | Seguir o `howToFix`. |
| 503 | Não consegui falar com o runner | Conferir se o serviço do agente está rodando e tentar de novo. Nada foi enviado. |

Antes de repassar, o Web lê o estado do runner na hora (sem cache) e só segue se for `waiting_input`. O runner
confere de novo e só então digita:

- Aprovar: a tecla `1`, a opção "Yes" do diálogo do Claude Code (atalho numérico).
- Negar: `Esc`, que o Claude Code trata como "No". Não usamos o número da opção "No" porque ele muda entre
  diálogos (com ou sem "don't ask again"); `Esc` vale em todos.
- Codex: o runner responde 501 (`PERMISSAO_SO_CLAUDE`); a aprovação continua pelo terminal.

Não há texto do hook `Notification` no cartão: o handler de hook do runner não repassa a mensagem. O pedido
mostrado vem do transcript.

### Pergunta de escolha (`AskUserQuestion`)

Quando o agente chama a ferramenta de pergunta, o runner fica em `waiting_input` com `motivo: "pergunta"` e a
atividade traz `alerta: "pergunta"` e `pergunta`: `{id, perguntas:[{pergunta, cabecalho, multipla, opcoes:[{rotulo, descricao}]}]}`
lida do transcript (o `id` é o `tool_use_id`), ou `null` se não deu para ler (a tela manda responder pelo terminal,
na aba Sessões). O Codex não tem essa ferramenta: lá é sempre `null`. Textos passam pela máscara de segredos.

#### `POST /api/v1/agents/<slug>/pergunta`

Corpo: `{"tool_use_id":"<pergunta.id>","respostas":[...]}` com uma resposta por pergunta, na ordem:
`{"opcao":2}` (escolha única, número de 1 a N), `{"opcoes":[1,3]}` (múltipla escolha, sem repetir) ou
`{"texto":"..."}` (escolha única com outra resposta: uma linha, até 2000 caracteres, sem caractere de controle).
Para cancelar: `{"tool_use_id":"...","cancelar":true}`. Exige sessão e `Origin`.

| Status | Quando | O que fazer |
| --- | --- | --- |
| 200 | `{ok:true, agente, tool_use_id}` | Nada. O agente continua sozinho. |
| 400 | Corpo inválido (resposta faltando, número fora do intervalo, texto vazio/longo/com quebra de linha, texto numa pergunta de múltipla escolha) | Corrigir o corpo. Nada foi digitado. |
| 409 | O agente não está esperando uma pergunta, ou o `tool_use_id` não é o da pergunta atual | Atualizar a conversa. Nada foi digitado. |
| 409 `PERGUNTA_JA_MEXIDA` | Alguém digitou no terminal depois que a pergunta abriu; a sequência do chat poderia cair na etapa errada (numa pergunta dupla, a primeira escolha viraria a da segunda). Nada foi digitado | Terminar a resposta pelo terminal, na aba Sessões. A tela mostra o motivo e o link. |
| 409 `PERGUNTA_JA_RESPONDIDA` | A resposta desta pergunta (mesmo `tool_use_id`, mesmo processo) já começou a ser digitada, por esta ou outra aba, inclusive se ficou pela metade. Nada foi digitado agora | Atualizar a conversa. Se o terminal ficou no meio, terminar pela aba Sessões. |
| 409 (do runner, no meio) | O terminal saiu da pergunta durante a digitação (`PERGUNTA_MUDOU`; o erro diz em que tecla parou) | Conferir o terminal na aba Sessões: a pergunta pode ter ficado pela metade. |
| 501 | O runner do agente é antigo e não tem `POST /api/agents/<id>/pergunta` | Atualizar o agente pelo Admin. Até lá, responder pelo terminal. |
| 502 | O runner recusou por outro motivo | Seguir o `howToFix` da mensagem. |
| 504 | O pedido saiu e a resposta do runner não voltou | Conferir o terminal na aba Sessões antes de tentar de novo. |
| 503 | Não consegui falar com o runner | Conferir o serviço do agente e tentar de novo. Nada foi enviado. |

O Web confere o estado e a pergunta e entrega a sequência de teclas ao runner (`POST /api/agents/<id>/pergunta`, abaixo).
O runner digita com 350 ms entre uma e outra: escolha única = o dígito da opção; texto livre = o dígito `opções+1` ("Type something"), o texto e
Enter; múltipla = um dígito por opção marcada e Tab; com mais de uma pergunta, ou com a última de múltipla
escolha, a tela "Review your answers" aparece e o `1` envia; cancelar = Esc. Protocolo conferido no Claude Code
2.1.304. Antes de CADA tecla o runner confere, no mesmo instante da escrita, que o agente
continua em `waiting_input` com `motivo: "pergunta"`, no mesmo `tool_use_id` e no mesmo processo; se a pessoa respondeu pelo
terminal no meio e surgiu um pedido de permissão, o `1` que sobraria aprovaria um comando, então ele para sem escrever o resto.
Enquanto a pergunta está aberta, `POST /send` responde 409 `PERGUNTA_PENDENTE` e não enfileira
a mensagem (ela nunca seria lida, porque o agente só fica ocioso depois da resposta).

#### Rota do runner: `POST /api/agents/<id>/pergunta`

Corpo: `{"tool_use_id":"<id da pergunta>","teclas":["2","\r","1"]}`, de 1 a 40 teclas, cada uma um texto não vazio de até
2000 caracteres. Só Claude (Codex responde 501 `PERGUNTA_SO_CLAUDE`). Sucesso: `{success:true, data:{teclas:N}}`.
Erros: 400 (`TOOL_USE_ID_INVALIDO`, `TECLAS_INVALIDAS`); 409 `NO_PTY`, `NAO_ESPERA_PERGUNTA`, `PERGUNTA_DIFERENTE` (nada
escrito), `PERGUNTA_JA_RESPONDIDA` (a mesma pergunta já recebeu teclas, mesmo que pela metade; nada escrito), `PERGUNTA_MUDOU` (parou no meio; o erro diz "tecla N de M") e `RESPOSTA_EM_ANDAMENTO` (uma resposta por vez por sessão;
enquanto dura, `/permissao` e `/input` (com ou sem `submit`, com ou sem `injectWhenIdle`) também respondem 409, e o `terminal_input` do WebSocket é descartado com um aviso `{type:"error", code:"RESPOSTA_EM_ANDAMENTO"}`).
Regra: a resposta pelo chat só vale se ninguém mexeu na pergunta pelo terminal. O runner conta toda escrita no PTY que não é da própria resposta
(`Sessao.escrever`: terminal, `/input`, turnos, permissão) e guarda o contador quando a pergunta abre; se mudou, responde 409 `PERGUNTA_JA_MEXIDA` antes da primeira
tecla, e se mudar no meio da sequência para com `PERGUNTA_MUDOU`. O estado do agente (`GET /api/agents/<id>`) traz
`pendenteId`: o `tool_use_id` da pergunta (ou, em permissão, do último `PreToolUse`, que vale para todas as ferramentas).
O log registra só a quantidade de teclas e de caracteres, nunca o conteúdo.

## 3. Fila

O Web sempre entrega pelo `/input` com `injectWhenIdle`, e o runner responde 202 mesmo quando vai segurar o
texto. Por isso o `POST /send` consulta o estado do runner na hora e, se ele está `working` ou `waiting_input`,
devolve `fila: {motivo: "resposta" | "permissao"}` junto com `ep_enviado`. O balão da mensagem mostra
"na fila: o agente ainda está respondendo a anterior" ou "na fila: o agente está esperando a sua permissão" e o
aviso some quando a mensagem aparece na conversa (entregue ao agente) ou quando o agente fica ocioso.
Limite: a decisão "foi para a fila" é tirada do estado no instante do envio; se o agente mudar de estado nessa
fração de segundo, o aviso pode faltar ou sobrar.

## Se algo falha

- Trilha vazia com o agente trabalhando: confira `transcripts_dir` no registro (o aviso da conversa já diz).
- Cartão sem o comando: o transcript não tinha `tool_use` pendente (diálogo de outra origem). O cartão ainda
  deixa aprovar ou negar.
- Arquivos: `lib/trilha.js`, `lib/mascara.js`, `lib/thread.js`, `lib/conversa.js` (`permissao`, `responderPergunta`, `teclasDaResposta`, `entregar`),
  `public/trilha-tela.js` (parte pura), `public/conversa.js` e `conversa.css` (desenho). Testes em
  `test/trilha.test.js`.
