# Restrições de cada agente

Este guia é para o dono do DG Claw. Ele explica como tirar de um agente o terminal (Bash), o envio de
arquivos ou o direito de gravar fora de certas pastas, e por que essa trava continua valendo depois de
`sudo dgclaw atualizar`.

## O problema que isto resolve

Quem trava um agente mexendo dentro da caixa dele (o container) perde a trava na próxima atualização,
porque a atualização recria a caixa. A restrição então precisa morar fora da caixa. Ela mora em um
arquivo que só o servidor altera.

## O que dá para travar

| Restrição | O que faz |
| --- | --- |
| Sem Bash | O agente não abre terminal. Valem também as ferramentas que acompanham o Bash (`BashOutput`, `KillShell`). |
| Sem enviar arquivo | O agente não manda arquivo pelo chat do painel nem pelo WhatsApp. Ele continua respondendo em texto. |
| Escrita só em certas pastas | As ferramentas de arquivo (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) só gravam dentro das pastas que você indicar. |

## O comando

Ver o estado de um agente:

```
sudo dgclaw agente restricoes ana
```

Travar (as opções que você não escrever ficam como estavam):

```
sudo dgclaw agente restricoes ana --sem-bash sim --sem-enviar-arquivo sim --escrita-so-em relatorios,rascunhos
```

Soltar:

```
sudo dgclaw agente restricoes ana --sem-bash nao --sem-enviar-arquivo nao --escrita-livre
```

As pastas são sempre dentro da casa do agente (`/home/agente`, por dentro da caixa). Escreva só o nome,
como `relatorios` ou `clientes/2026`. O comando recusa caminho que começa por `/`, que tem `..` ou que
passa por um atalho (link). Se a pasta ainda não existe, ele a cria com o dono certo. O Admin não usa
este mecanismo: ele roda como root para cuidar do servidor, e o comando se recusa a mexer nele.

O agente é reiniciado só quando algo mudou e ele está ligado. Agente parado recebe a trava quando ligar.

## Onde fica e por que sobrevive

O arquivo é `/var/lib/dgclaw/agentes/<nome>/runner/restricoes.json`, na mesma pasta do `runner.json`:
dono root, só leitura, e montado como somente leitura dentro da caixa. O agente não consegue alterá-lo.

```json
{"versao": 1, "sem_bash": true, "sem_enviar_arquivo": true,
 "escrita_so_em": ["relatorios", "rascunhos"],
 "atualizado_em": "2026-11-07T15:00:00Z", "atualizado_por": "root"}
```

Sem o arquivo, não há restrição (o comportamento de sempre). `escrita_so_em: null` quer dizer "grava em
qualquer lugar".

Toda vez que o DG Claw regrava a configuração de um agente, ele relê esse arquivo e refaz as travas:

| Comando | O que acontece |
| --- | --- |
| `dgclaw agente criar <nome>` (inclusive repetido) | o `runner.json` nasce com os padrões e as travas voltam por cima |
| `dgclaw agente reparar <nome>` | as travas são reaplicadas antes de refazer a parte de dentro |
| `dgclaw agente recriar <nome>` | confere o arquivo antes de tocar na caixa e reaplica no fim |
| `sudo dgclaw atualizar` | recria cada agente, então vale o mesmo |

A aplicação mexe só no que é dela: acrescenta as travas em `denyTools` do `runner.json` (e tira o envio
de arquivo de `allowTools`) e registra um gancho de escrita no `settings.json` da casa do agente. Tudo o
mais que existir nesses arquivos fica como está.

## Arquivo estragado

Se o `restricoes.json` não for um JSON válido, ou tiver uma pasta que não serve, o comando para com a
mensagem dizendo qual arquivo e qual o motivo, e **não solta nenhuma trava**. O `agente recriar` confere o
arquivo antes de remover a caixa. Na atualização, o agente aparece em "Agentes COM PROBLEMA" no resumo.
Conserte o arquivo (ou refaça com o comando acima) e rode `sudo dgclaw agente recriar <nome> --forcar`.

## Combine a trava de pastas com "sem Bash"

O gancho de escrita só enxerga as ferramentas de arquivo. Com o Bash ligado, o agente grava em qualquer
lugar por comando de terminal (`echo > arquivo`, `cp`, `tee`), e a trava de pastas não barra isso. Para a
trava valer de verdade, use `--escrita-so-em` junto com `--sem-bash sim`. Se você travar as pastas sem
travar o Bash, o comando avisa.

Sempre liberados, para o agente funcionar: a memória (`MEMORY.md`, `working-memory.md`, `memory/`), as
pastas `.dgclaw/` e `.claude/` da casa dele e `/tmp`. O `settings.json` do servidor nunca é liberado.

## Codex

Os agentes que rodam no Codex ainda não obedecem a estas travas: o runner do Codex ignora as regras de
ferramentas e os ganchos do Claude Code, e registra um aviso disso. O comando grava o arquivo, avisa em
destaque e escreve uma linha em `/var/lib/dgclaw/agentes/<nome>/restricoes.log`. Se o agente trocar para o
Claude, a restrição já guardada passa a valer no próximo `agente reparar`. Para um agente no Codex que
precisa de trava hoje, não use o Codex nele.

Texto para a página de paridade: "Restrições do dono (`dgclaw agente restricoes`): no Claude, `sem_bash` e
`sem_enviar_arquivo` viram `denyTools` e `escrita_so_em` vira um gancho PreToolUse. No Codex o runner
ignora `allowTools`/`denyTools` e os ganchos, então nenhuma das três vale; o comando avisa e registra. Exceção
de paridade aberta até o Codex ter regras de ferramenta equivalentes."

## O que o teste prova e o que não prova

`tests/cli/restricoes.sh`, `tests/cli/restricoes-gancho.sh` e o `tests/cli/atualizar.sh` provam que o
arquivo e as travas sobrevivem a criar, reparar, recriar e atualizar, que o gancho decide certo para cada
caminho e que um arquivo estragado não solta nada. O que só uma VPS real prova é o Claude Code de verdade
respeitando o `denyTools` e o gancho. Depois de travar um agente, peça a ele uma gravação fora das pastas
e confirme que foi recusada.
