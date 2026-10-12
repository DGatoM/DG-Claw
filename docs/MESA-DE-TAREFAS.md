# Mesa de tarefas (opcional)

A mesa de tarefas é uma coluna do app **DG Telegram** que mostra, para o dono, o que cada
agente está fazendo: quem está em quê, quanto falta, o que travou e o que está esperando ele.
**A tela só mostra.** Quem cria, atualiza e conclui as tarefas é o próprio agente, por API.

É **opcional**: só existe para quem tem o DG Telegram. Agente sem mesa funciona igual, e a
seção da regra no CLAUDE.md manda ele ignorar tudo isso.

## Como ligar

1. No DG Telegram, em `/settings/api-keys`, crie uma chave com **Agente dono** = o slug deste
   agente. Com dono, o POST já sai no nome dele e a chave só altera as tarefas dele (403 nas
   dos outros). Ler, ela lê a mesa inteira.
2. Acrescente as duas linhas no fim do `.dgclaw/config.sh` do agente (o arquivo é 600, do dono
   do workspace):

   ```bash
   export DGCLAW_MESA_URL="http://127.0.0.1:4045/api/v1/tarefas"
   export DGCLAW_MESA_KEY="<a chave do agente>"
   ```

3. Rode o doctor (`/dgclaw:doctor`). A seção **10. Extensões instaladas** diz se a mesa está
   configurada e se o GET responde 200. Com `--fix`, se o CLAUDE.md do agente for anterior a
   esta regra, a seção da mesa é acrescentada no fim dele (com backup ao lado).

**Precisa reiniciar?** Não. A variável só entra no ambiente da sessão viva no próximo
restart do `dgclaw-<slug>.service`, mas todo comando da regra começa por
`[ -n "$DGCLAW_MESA_KEY" ] || . "$DGCLAW_WORKSPACE/.dgclaw/config.sh"`, que lê o config quando a
variável ainda não está lá. Vale já no próximo turno em que o agente ler o CLAUDE.md.

**Reinstalar o plugin** (`install-core.sh bootstrap`) reescreve o `config.sh` inteiro, mas leva
as duas linhas da mesa para o arquivo novo. A chave não passa pela tela.

**Uma chave, dois usos.** `DGCLAW_MESA_KEY` é a chave do agente no DG Telegram. O
[quadro de avisos da equipe](QUADRO-DE-AVISOS.md) usa a mesma chave e o mesmo servidor (a base
é o `DGCLAW_MESA_URL` sem o `/api/v1/tarefas`). Não crie uma segunda chave para ele.

## A regra que o agente segue

Está no `templates/CLAUDE.md.tmpl`, seção "Mesa de tarefas", e só vale quando o ambiente tem
`DGCLAW_MESA_URL`:

1. Pedido rápido não vira tarefa: responder, mandar arquivo, conferir algo em 2 minutos.
2. Trabalho de verdade vira tarefa ANTES de começar: conteúdo, desenvolvimento, projeto,
   levantamento de várias etapas.
3. Na dúvida, o agente pergunta ao dono: "quer que eu crie um projeto pra isso?".
4. Atualiza enquanto trabalha (`progresso`, `passos`, `nota`). Em `fazendo` sem atualização há
   45 minutos, a tarefa aparece na mesa como "parada?".
5. Travou ou precisa do dono: estado `travada` ou `esperando_danilo`, sempre com `motivo`.
   `esperando_danilo` é o nome do estado na API e vale para qualquer dono; o texto da regra usa
   o nome do dono.
6. Terminou: estado `concluida`, com `link`. Quando o dono diz "pode dar como concluído", o
   agente conclui.

## Por que a regra fica no template para todos, e não só para quem tem mesa

A mesa pode ser ligada depois da instalação, só acrescentando duas linhas no config. Se a seção
dependesse do setup, ligar a mesa exigiria regerar o CLAUDE.md, e o agente teria a chave sem
saber quando usar. Com a seção condicional, ligar e desligar é só mexer no config. O custo é
uma seção a mais no CLAUDE.md de quem não tem mesa, que começa dizendo para ignorá-la.

## A API, em resumo

A referência completa fica na doc do DG Telegram, `/api/v1/docs.md`, seção "Mesa de tarefas".

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/tarefas?agente=<slug>` | as tarefas abertas e as concluídas de hoje |
| `POST /api/v1/tarefas` | cria (`titulo` e `origem` obrigatórios; `tipo`, `passos`, `progresso`, `nota`, `link` opcionais) |
| `PATCH /api/v1/tarefas/<id>` | muda só o que veio; `{}` é sinal de vida |
| `DELETE /api/v1/tarefas/<id>` | cancela (não apaga) |

Erros: `400` com `erros` campo a campo, `401` chave recusada, `403` tarefa de outro agente,
`404` tarefa inexistente, `503` o banco da mesa não abriu.

## O que o doctor diz

| Linha | O que quer dizer | O que fazer |
| --- | --- | --- |
| `[info] mesa de tarefas: desligada` | o config não tem as variáveis | nada, se o dono não usa o DG Telegram |
| `[FALTA] mesa de tarefas pela metade` | tem uma das duas variáveis e falta a outra | completar o config |
| `[ ok ] ... deu 200` | configurada e respondendo | nada |
| `[FALTA] ... recusou a chave (401)` | chave revogada ou errada | criar outra com Agente dono e trocar no config |
| `[aviso] ninguém respondeu` | DG Telegram fora do ar ou URL errada | conferir o serviço e a URL |
| `[aviso] ... CLAUDE.md não tem a seção` | agente instalado antes da regra | `--fix` |
