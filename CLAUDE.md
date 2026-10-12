# DG Claw (repositório)

Este repositório contém o DG Claw: um instalador, um painel web com chat, o Admin (agente de sistema)
e a infraestrutura de agentes em containers. Quem só quer instalar deve ler o `README.md` e o
`INSTALL.md`.

## Estrutura

- `install.sh`, `lib/`: o instalador e as funções que ele usa
- `bin/dgclaw`: o comando de administração
- `runner/`: mantém a sessão do agente viva
- `web/`: o painel e o chat
- `container/`: a imagem dos agentes
- `templates/`: arquivos que Admin e agentes ganham ao nascer
- `skills/`: roteiros de conversa (`criar-agente`)
- `docs/`: documentação; `docs/interno/` guarda notas de desenvolvimento
- `tests/`: os testes
- `skills/setup/`, `local/`, `lite/`: a versão anterior (plugin do Claude Code)

## Testes

`tests/rodar.sh` roda tudo. Os testes do instalador usam `DGCLAW_RAIZ` para trabalhar numa raiz falsa
e comandos de mentira no PATH; não precisam de root nem alteram a máquina.

## Convenções

- Português do Brasil em todo texto voltado a pessoas; comentários explicam o porquê.
- Bash com `set -euo pipefail`, em funções, com `shellcheck` limpo.
- Toda falha diz o que falhou, com que entrada e o que fazer. Sem `|| true` mudo.
- Segredos fora de argv, de logs e do repositório; arquivos de segredo com permissão 600.
- Commits só com os arquivos da própria mudança, nomeados um a um.

Quem desenvolve este repositório: leia docs/interno/CLAUDE-dev.md antes de editar.
