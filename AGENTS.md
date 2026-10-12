# DG Claw (repositório)

O DG Claw instala, num servidor Ubuntu, um painel web com chat, um agente de sistema (o Admin) e a
infraestrutura para agentes de trabalho, cada um em um container separado.

## Instalar

O passo a passo está em `INSTALL.md`. O `README.md` explica o que o DG Claw é e o que a instalação
muda na máquina. O instalador é `install.sh`, e `./install.sh --ensaio` mostra o que ele faria sem
mudar nada.

## Estrutura

- `install.sh`, `lib/`: o instalador e as funções que ele usa
- `bin/dgclaw`: o comando de administração (`dgclaw status`, `dgclaw agente ...`)
- `runner/`: o programa que mantém a sessão do agente viva
- `web/`: o painel e o chat
- `container/`: a imagem dos agentes
- `templates/`: os arquivos que Admin e agentes ganham ao nascer
- `skills/`: roteiros de conversa (por exemplo, `criar-agente`)
- `tests/`: os testes

## Testes

`tests/rodar.sh` roda tudo e sai com código diferente de zero se algo falhar. Os testes do instalador
usam uma raiz falsa (`DGCLAW_RAIZ`) e comandos de mentira, então não mexem na máquina.

## Convenções

- Texto para pessoas em português do Brasil. Comentários de código também, explicando o porquê.
- Scripts em bash com `set -euo pipefail`, tudo em funções, e `shellcheck` sem avisos.
- Segredos não vão em linha de comando, em log nem no repositório.
