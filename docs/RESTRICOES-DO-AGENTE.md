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
passa por um atalho (link). Se a pasta ainda não existe e o agente está ligado, o comando pede ao próprio agente que a crie, dentro da caixa (nunca como root na casa dele). Com o agente desligado ele avisa e não cria: o agente cria a pasta quando gravar nela, e a trava já aceita pasta que ainda não existe. O Admin não usa
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

A aplicação grava três coisas, sempre as mesmas, e valida o `restricoes.json` antes de gravar qualquer uma:

| Arquivo | O que recebe |
| --- | --- |
| `runner/managed-settings.json` | a configuração **administrada** do Claude Code: o gancho de escrita e a lista `permissions.deny` (Bash e envio de arquivo). Sem restrição ele contém `{}`, que não muda nada |
| `runner/runner.json` | as mesmas ferramentas em `denyTools`, e o envio de arquivo fora de `allowTools`. A chave `restricoesAplicadas` anota o que o mecanismo acrescentou e o que tirou; desligar devolve só isso, e um `denyTools` que você pôs por fora fica |
| `home/.claude/settings.json` | nada novo. Versões anteriores gravavam o gancho aqui; a aplicação tira essa entrada antiga, se existir |

Se não há `restricoes.json`, `allowTools` e `denyTools` do `runner.json` não são tocados.

### Por que a política é "administrada"

O gancho morava no `settings.json` da casa. Só que o agente é dono da pasta `.claude/` e podia gravar
`{"disableAllHooks": true}` em `.claude/settings.local.json`, desligando o gancho. O que a documentação
oficial do Claude Code diz (páginas de hooks, de settings e de managed settings):

- A configuração administrada (`/etc/claude-code/managed-settings.json` no Linux) fica no topo da ordem de precedência: nada em
  `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` nem em `--settings` a sobrescreve.
- Os ganchos se somam entre os níveis, e **o `disableAllHooks` definido em configuração de usuário, de projeto ou local não
  consegue desligar ganchos administrados**; só o `disableAllHooks` do próprio nível administrado desliga.
- `allowManagedHooksOnly` (também administrado) bloquearia os ganchos de usuário, de projeto e de plugin. Não o usamos: ele
  bloquearia também os ganchos que o próprio DG Claw usa na casa do agente, e o `disableAllHooks` já não consegue desligar o gancho
  administrado.
- As regras `permissions.deny` administradas também somam e vencem qualquer `allow` do agente.

A imagem liga `/etc/claude-code/managed-settings.json` ao arquivo `runner/managed-settings.json` (montado só leitura). A
documentação oficial não fala de atalho (link) nesse caminho, então isso só foi provado nos testes do DG Claw, não contra o Claude Code
de verdade: depois de atualizar, peça a um agente travado uma gravação fora das pastas e confira que foi recusada. Como a imagem nova
é necessária, o `dgclaw atualizar` (que reconstrói a imagem) já cobre; um agente cuja caixa ainda é antiga só ganha a trava depois do
`agente recriar`.

### Envio de arquivo no painel

Quando o agente tem `sem_enviar_arquivo`, a ferramenta é negada pelo Claude Code. O painel também confere: um anexo de
`send_file` só aparece na conversa quando o resultado da ferramenta confirma que o envio deu certo, e o painel lê o
`restricoes.json` do agente e não mostra nenhum anexo vindo de `send_file` ou `whatsapp_send_file` enquanto a trava estiver ligada.
Se o `restricoes.json` existir e não puder ser lido, o anexo fica retido e o log do painel diz o que fazer.

### Duas alterações ao mesmo tempo

Cada agente tem uma trava de arquivo (`/var/lib/dgclaw/agentes/<nome>/.restricoes.lock`, fora da casa dele). Mudar as
restrições, criar, reparar e recriar esperam uma pela outra, então duas alterações simultâneas não se apagam.

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

### O que fica liberado e o que fica fechado

Com a trava de pastas ligada, além das pastas que você indicou o agente só grava a memória dele: `MEMORY.md`,
`working-memory.md` e `memory/`. Todo o resto da casa que começa por ponto fica fechado para as ferramentas de arquivo, e `/tmp`
também. A lista existe porque estes são arquivos que algum executor do próprio agente lê para **executar** o que está escrito
neles, e liberar qualquer um transformaria "só grava em relatórios" em "roda o que quiser":

| Caminho | Quem o executa |
| --- | --- |
| `.dgclaw/config.sh` | o batimento (`scripts/heartbeat.sh`) e todos os temporizadores o carregam com `source` |
| `.dgclaw/ext/*/hooks/heartbeat.sh` e `event.sh` | o batimento e `scripts/ext-event.sh` |
| `.dgclaw/plugin/` e `.dgclaw/self-crons.json` | as rotinas e o que o batimento carrega (`pulso-lib.sh`) |
| `.claude/settings.local.json`, `.claude/skills/`, `.claude/hooks` | o Claude Code (ganchos, permissões, instruções) |
| `.codex/` | o Codex |
| `.plataforma/dgchat.mcp.json` | o comando do servidor MCP que o runner sobe |
| `.bashrc`, `.profile` e qualquer outro arquivo de início na raiz da casa | o shell |

Por isso o comando recusa, em `--escrita-so-em`, qualquer pasta que comece por ponto. As pastas que você libera também não devem
guardar scripts que alguma rotina execute; com o Bash travado o agente não cria rotinas novas, mas as que já existem continuam
rodando o que estiver nos arquivos que elas apontam.

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
