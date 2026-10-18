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
(`{ferramenta, titulo, comando}`): o último `tool_use` do transcript que ainda não tem `tool_result`. A conversa
mostra o cartão "O agente está esperando a sua permissão" com esse pedido e os botões Aprovar e Negar. O cartão
some quando o estado sai de `waiting_input`. A linha de estado diz "esperando a sua permissão" no lugar de
"trabalhando".

### `POST /api/v1/agents/<slug>/permissao`

Corpo: `{"decisao":"aprovar"}` ou `{"decisao":"negar"}`. Exige sessão e `Origin`, como as outras escritas.

| Status | Quando | O que fazer |
| --- | --- | --- |
| 200 | `{ok:true, decisao}` | Nada. O agente continua sozinho. |
| 400 | `decisao` diferente de aprovar/negar | Corrigir o corpo. |
| 409 | O agente não está esperando permissão (o pedido já foi resolvido) | Atualizar a conversa. |
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
- Arquivos: `lib/trilha.js`, `lib/mascara.js`, `lib/thread.js`, `lib/conversa.js` (`permissao`, `entregar`),
  `public/trilha-tela.js` (parte pura), `public/conversa.js` e `conversa.css` (desenho). Testes em
  `test/trilha.test.js`.
