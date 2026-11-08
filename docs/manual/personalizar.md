# Personalizar o seu DG Claw

Você pode pedir ao Admin para ajustar o que quiser: uma habilidade nova, o jeito de um agente falar, uma rotina,
um botão. O cuidado é um só: a atualização oficial troca os arquivos do programa por completo, então uma mudança
feita no lugar errado some na próxima vez que você pedir "atualiza o DG Claw".

O guia completo, que o Admin lê antes de mexer em qualquer coisa, é o [PERSONALIZAR.md](../PERSONALIZAR.md). Este
resumo diz o essencial.

## Onde a mudança sobrevive

Em ordem de preferência:

1. **Pontos de extensão que a atualização não toca.** Habilidades novas (com nome próprio), a identidade e a
   personalidade de um agente, as instruções do Admin (`CLAUDE.md` e `AGENTS.md`), as rotinas do agente, as linhas do
   `web.env` e as chaves no cofre. Aqui o Admin trabalha direto, sem procedimento especial.
2. **Um arquivo novo e próprio, na branch `personalizacoes`.** Um arquivo que só você tem quase nunca cruza com a
   versão oficial.
3. **Só por último, editar um arquivo do núcleo**, com a mudança pequena e isolada.

Toda mudança no programa entra no registro de personalizações do Admin (`PERSONALIZACOES.md`). É esse registro que
permite à atualização conferir se a sua mudança cruza com a versão nova.

## Mudança no nível do sistema: pode, com aviso

Você pode pedir mudanças na base do DG Claw, como uma nova forma de gerar agentes, um ajuste no comando `dgclaw`, no
instalador ou no `runner/`. O combinado:

1. O Admin avisa, em linguagem simples, que o pedido mexe na base e pode dar problema nas próximas atualizações.
2. Se você mantiver o pedido, ele faz, na branch `personalizacoes`.
3. Ele registra no `PERSONALIZACOES.md` que a mudança mexe na base.
4. A cada atualização, tenta manter as duas coisas funcionando. Se não der, para e conta o que cruzou, antes de
   colocar no ar.

## O que continua fora, mesmo a pedido

- o cofre e os segredos (tokens do runner, segredos do proxy e o cofre de cada agente);
- o firewall e as regras de rede;
- a autenticação do painel (login, hash da senha, link de primeiro acesso);
- o isolamento dos containers (a pasta `container/`);
- os ganchos de segurança e os testes de isolamento.

Se o pedido esbarra em algum deles, o Admin explica o risco e propõe outro caminho. O porquê está em
[seguranca.md](seguranca.md).

## Comandos relacionados

| Comando | Para que serve |
| --- | --- |
| `sudo dgclaw personalizacoes levantar` | Lista o que foi personalizado: registro, clone, cópias do instalador e conversas do Admin |
| `sudo dgclaw personalizacoes conferir` | Confere o registro contra a versão nova e diz se algo cruza. Não muda nada |
| `sudo dgclaw personalizacoes concluir` | Marca o levantamento pendente como concluído |
| `sudo dgclaw atualizar --simular` | Mostra, entre outras coisas, o cruzamento das personalizações com a versão nova |

## Se der erro

- A atualização parou dizendo que uma personalização cruza com a versão nova: o Admin resolve cada conflito mantendo
  a novidade oficial e refazendo a sua mudança por cima. Veja [atualizar-e-backup.md](atualizar-e-backup.md).
- Uma habilidade de fábrica que você mandou alterar voltou ao que era: o instalador refaz as habilidades que ele
  mesmo traz. Peça uma habilidade nova, com nome próprio.
