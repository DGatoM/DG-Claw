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
| Sem Bash | O agente não abre terminal. Valem também as ferramentas que acompanham o Bash (`BashOutput`, `KillShell`) e o `Monitor`, que executa comandos por conta própria e ignoraria a regra do Bash. |
| Sem enviar arquivo | O agente não manda arquivo pelo chat do painel nem pelo WhatsApp. Ele continua respondendo em texto. Só vale junto com "sem Bash": com o terminal liberado o agente consegue mandar o arquivo por fora das ferramentas (por exemplo, falando direto com a ponte do WhatsApp), e por isso o comando recusa essa combinação. |
| Escrita só em certas pastas | As ferramentas de arquivo (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) só gravam dentro das pastas que você indicar. |

## O comando

Ver o estado de um agente:

```
sudo dgclaw agente restricoes ana
```

A consulta mostra o que está **configurado** e, separado disso, o que está **valendo**. Ela só lê: não grava nada, não
reinicia nada, não para o agente, e sai sempre com código 0 (o chat do Admin pinta de vermelho todo comando que sai com outro
código, e uma consulta é informação). O que ela acrescenta ao configurado:

- `Pendente:` uma linha por marcador em `runner/` (`restricoes-transacao.pendente`, `restricoes.pendente`,
  `restricoes-suporte.pendente`, `restricoes-migracao.pendente`), com o texto do marcador (desde quando) e o comando que resolve. Com algum marcador, as
  travas aparecem como `configurado, AINDA NAO VALE` em vez de `TRAVADO`.
- `NAO VALE:` com o agente ligado e alguma restrição ligada, a consulta roda a mesma conferência de suporte do `iniciar`
  (link, conteúdo e script do gancho, só lendo `/etc` e a imagem) contra o `managed-settings.json` do disco. Se a imagem não
  carrega a configuração administrada, mostra o motivo, avisa que o agente está ligado sem a trava e diz como resolver. Com o
  agente parado, avisa que a conferência será feita quando ele ligar.
- `NAO VALE:` por divergência, com o agente ligado ou parado: a consulta deriva a política esperada do `restricoes.json`
  (pela mesma função que grava os arquivos) e compara com o `managed-settings.json` e com o `denyTools` do `runner.json`
  em `runner/`. Se uma restrição foi gravada no `restricoes.json` e não chegou a ser aplicada (por exemplo, uma interrupção
  no meio do comando), ela aparece como `NAO VALE`, com o comando que resolve, e nunca como `TRAVADO`. Arquivo ausente,
  link ou inválido, com restrição ligada, também conta. O marcador `restricoes-transacao.pendente` é gravado antes do
  `restricoes.json` e retirado quando os arquivos aplicados conferem com ele.
- `Codex:` as sessões em Codex, ou com o provedor em dúvida, e o aviso de que lá as travas não valem.

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

Se o reinício falhar (ou o runner não voltar a responder `active`), o comando falha e deixa uma pendência em
`runner/restricoes.pendente`, na pasta do dono do servidor. Rodar o mesmo comando de novo reinicia o runner, mesmo com os
arquivos já iguais, e a pendência só sai depois que o runner está `active`.

Versões antigas guardavam o gancho de escrita no `settings.json` da casa do agente. O comando tira esse gancho **por dentro da
caixa**, como o usuário `agente` (o root nunca lê nem grava na casa do agente, porque o agente poderia trocar uma pasta por um
atalho no meio do caminho). Com o agente parado, o gancho antigo fica onde está, o comando avisa e guarda a pendência em
`runner/restricoes-migracao.pendente`; ele sai quando o agente ligar e
`dgclaw agente reparar <nome>` rodar de novo.

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
- `allowManagedHooksOnly` existe, mas **não o usamos**: o runner passa os ganchos de status do agente (Stop, PreToolUse e outros)
  por `--settings` a cada sessão, e a documentação não garante que eles continuem rodando com essa chave. Uma skill com gancho no
  cabeçalho é barrada de outro jeito: o gancho de escrita protege `SKILL.md` e as pastas ocultas, onde as skills ficam.
- Cada gancho que geramos leva `onFailure: "block"`: se ele não inicia, é morto por falta de memória ou passa do tempo (10 s), a
  ferramenta é bloqueada em vez de liberada.
- As regras `permissions.deny` administradas também somam e vencem qualquer `allow` do agente.

A imagem liga `/etc/claude-code/managed-settings.json` ao arquivo `runner/managed-settings.json` (montado só leitura). A
documentação oficial não fala de atalho (link) nesse caminho, então isso só foi provado nos testes do DG Claw, não contra o Claude Code
de verdade: depois de atualizar, peça a um agente travado uma gravação fora das pastas e confira que foi recusada. Como a imagem nova
é necessária, o `dgclaw atualizar` (que reconstrói a imagem) já cobre; um agente cuja caixa ainda é antiga só ganha a trava depois do
`agente recriar`.

Por isso `dgclaw agente restricoes` não diz que as travas valem só por ter gravado os arquivos. Com o agente ligado, ele confere
dentro do container (como root, só lendo `/etc` e a imagem) que o link existe, que o conteúdo visto lá é o que acabou de ser gravado
e que o script do gancho está na imagem. Se faltar algo, o comando falha, **para o container** (a mesma regra do `iniciar`:
agente com restrição ligada não roda sem a trava), registra no `restricoes.log` e manda rodar
`dgclaw agente recriar <agente> --forcar` (`--forcar` porque o agente ficou parado; se a imagem do servidor também for velha,
antes `dgclaw imagem construir --agora`). O recriar liga o agente pelo mesmo caminho do `iniciar`, que refaz os arquivos e
confere de novo; consultar o estado com `dgclaw agente restricoes <agente>` não reinicia nem confere nada.
Com o agente parado não dá para conferir: o comando grava `runner/restricoes-suporte.pendente` e avisa. No `dgclaw agente iniciar`
a conferência roda assim que o container sobe; se falhar, o container é parado e o comando manda recriar com `--forcar`. Se
passar, os marcadores de suporte e de reinício saem (o runner acabou de subir com os arquivos regenerados).

Para resolver cada pendência: `restricoes.pendente` e `restricoes-suporte.pendente` saem com `dgclaw agente reiniciar <agente>`
(ligado) ou `dgclaw agente iniciar <agente>` (parado); `restricoes-migracao.pendente` sai com `dgclaw agente reparar <agente>`
com o agente ligado.

**Antes de ligar, não depois.** O runner sobe sozinho pelo systemd assim que o container liga, e uma conferência feita só
depois deixaria uma janela sem o gancho de escrita. Por isso `dgclaw agente iniciar` e `dgclaw agente reiniciar`, para um
agente que tem `restricoes.json`, fazem tudo dentro da trava do agente e nesta ordem: (1) refazem `managed-settings.json` e
`runner.json` a partir do `restricoes.json` e releem o que gravaram (um arquivo permissivo antigo, ausente, `{}` ou inválido
nunca vale); (2) conferem, sem ligar nada, que a imagem do container tem o marcador `dgclaw.configuracao-administrada`
(`LABEL` do `container/Containerfile`); (3) só então ligam; (4) conferem de dentro do container, como segunda camada, e param o
container se falhar. Se o `restricoes.json` estiver ilegível, inválido ou for um link, ou se a gravação falhar (disco cheio), ou
se a imagem não tiver o marcador, o agente não liga e a mensagem diz o que fazer (`dgclaw agente recriar <agente>`, e antes
`dgclaw imagem construir --agora` se a imagem do servidor também for velha). Agente sem `restricoes.json` liga como sempre.

Os `provedor.json` da casa são do agente, então a leitura do aviso do Codex não deixa o root abri-los com o agente ligado: ela
roda dentro do container, como o usuário `agente`, com prazo de 10 s, só aceitando arquivo regular de até 64 KiB e sem seguir
link. Com o agente parado o root lê com as mesmas recusas e prazo de 5 s. Qualquer falha vira "provedor em dúvida" no aviso e nunca
impede o reinício do runner.

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

O contrário é recusado: travar o envio de arquivo (`--sem-enviar-arquivo sim`) com o Bash liberado não adianta, porque o terminal
manda o arquivo por fora das ferramentas. Ligue os dois: `--sem-bash sim --sem-enviar-arquivo sim`.

### O gancho de escrita

Com **qualquer** restrição ligada (sem Bash, sem enviar arquivo ou pastas), o gancho de escrita fica na configuração
administrada. Sem Bash o agente ainda tem Write e Edit, e editar a configuração dele seria executar comando por outro caminho.

- Sem `escrita_so_em`: modo "só protegidos". O agente grava em qualquer lugar da casa (`/home/agente`) e em `/tmp`, menos nos
  caminhos protegidos abaixo. **Todo o resto do sistema de arquivos é recusado**, depois de normalizar o caminho e resolver
  atalhos: o usuário agente tem `sudo` dentro da caixa e pode ser dono de arquivos que o sistema executa (o `crontab` em
  `/var/spool/cron`, `/etc/sudoers.d`, `/opt/dgclaw`), e gravar neles seria executar comando sem o Bash.
- Com `escrita_so_em`: além das pastas indicadas, o agente só grava a memória dele (`MEMORY.md`, `working-memory.md` e
  `memory/`), e `/tmp` fica fechado. Os caminhos protegidos valem também **dentro** das pastas liberadas.

Caminhos protegidos, em qualquer profundidade, depois de normalizar o caminho (`..`, barras duplas e atalhos):

| Caminho | Por que é protegido |
| --- | --- |
| qualquer pasta ou arquivo que comece por ponto (`.dgclaw`, `.claude`, `.codex`, `.plataforma`, `.config`, `.bashrc`, `.profile`, `.mcp.json`, `.git/hooks`...) | `.dgclaw/config.sh` é carregado com `source` pelo batimento e pelos temporizadores; `.dgclaw/ext/*/hooks` e `self-crons.json` são executados pelas rotinas; o Claude Code descobre `.claude/settings*` e `.claude/skills` também em subpastas (`relatorios/.claude/skills/x`); `.plataforma/dgchat.mcp.json` é o comando do servidor MCP; o shell lê `.bashrc` e `.profile` |
| `SKILL.md`, `CLAUDE.md`, `CLAUDE.local.md` e `AGENTS.md` em qualquer pasta (sem diferenciar maiúsculas) | o Claude Code lê como instrução, e uma skill pode trazer gancho no cabeçalho |
| `AGENT.md`, `PERSONALITY.md`, `IDENTITY.md`, `ETHICS.md`, `CREATOR.md` e `LAWS.md` na raiz da casa | a identidade que o DG Claw regrava |

Levantamento feito na imagem (`container/`): as unidades do systemd só executam arquivos de `/opt/dgclaw` e leem, da casa, o
`.dgclaw/tela/vnc.senha` e `.dgclaw/whatsapp/ligado` (ambos já cobertos pelo ponto). Não há outro arquivo de nome comum na casa
que seja carregado com `source` ou executado.

Por isso o comando também recusa, em `--escrita-so-em`, qualquer pasta que comece por ponto. As pastas que você libera não devem
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

## Contas de organização com política remota

Uma conta de IA que pertence a uma organização do claude.ai (planos Team ou Enterprise) pode trazer uma política administrada
remota ("server-managed settings"). No modo padrão do Claude Code essa política é a primeira da fila e **substitui por inteiro**
o `managed-settings.json` do DG Claw, inclusive o gancho de escrita. O DG Claw não consegue impor o contrário, porque a política
remota é do administrador da organização. Nesta versão, conta de organização com política administrada remota não é compatível
com as restrições: nem uma política que combine com a local serve, porque a própria organização pode desligar os ganchos nela.

O Claude Code guarda a cópia dessa política em `/home/agente/.claude/remote-settings.json` e a aplica no início das sessões
seguintes. Por isso, com o agente ligado, a conferência (ao aplicar, ao iniciar, ao reiniciar, ao criar o container e na consulta)
lê esse arquivo por dentro da caixa, como o usuário `agente`, com prazo e sem seguir link:

| Situação do arquivo | Resultado |
| --- | --- |
| ausente, ou objeto vazio `{}` | segue |
| política com qualquer chave, inclusive `"managedSourcesBehavior": "merge"` | falha: as restrições não valem e o container é parado |
| link, não é arquivo comum, maior que 1 MiB, JSON inválido, prazo estourado | falha, pela dúvida |

O cache só mostra o momento: uma conta Team ou Enterprise sem política hoje pode receber uma depois (o Claude Code busca a política
de hora em hora), e ela substitui a configuração do DG Claw, inclusive o gancho de escrita. Por isso a conferência também pergunta,
dentro da caixa e como o usuário `agente`, `claude auth status --json` (prazo de 20 segundos, saída limitada) e olha só `loggedIn`,
`authMethod` e `subscriptionType`; a saída traz e-mail e organização e nunca é impressa nem gravada. Contas Team e Enterprise
não são compatíveis com as restrições nesta versão:

| Conta | Resultado |
| --- | --- |
| `subscriptionType` team ou enterprise | falha: as restrições não valem e o container é parado |
| `claude.ai` com login e sem plano legível, saída que não é JSON, vazia ou prazo estourado | falha, pela dúvida |
| sem login, chave de API, token OAuth, Pro ou Max | segue (sem login o dono precisa do agente ligado para conectar a conta) |

Para resolver, em ordem (funciona com o agente parado, que é como o DG Claw o deixa, e o `reiniciar` recusa agente parado):

1. desligar as restrições: `dgclaw agente restricoes <agente> --sem-bash nao --sem-enviar-arquivo nao --escrita-livre`;
2. ligar o agente: `dgclaw agente iniciar <agente>` (pule este passo se ele já estiver ligado);
3. no painel do agente, conectar uma conta pessoal (Pro ou Max) ou uma chave de API no lugar da conta da organização;
4. ligar as restrições de novo com o mesmo comando `restricoes` e as opções desejadas. Ele confere outra vez e para o agente se a
   política remota continuar.

Quando o DG Claw para o agente por causa de uma falha dessas, ele confere que o container parou de verdade (`podman stop`, e
`podman kill` se ainda não houver confirmação) antes de gravar o marcador e o log. Só vale confirmação positiva: o `podman inspect`
responder com sucesso e o estado ser `exited`, `stopped`, `created` ou `configured`, ou o `podman container exists` dizer que o
container não existe. Erro, prazo estourado, resposta vazia, `running`, `stopping`, `paused` ou estado desconhecido não confirmam. Se nem assim ele parar, a mensagem diz que o agente está
LIGADO SEM A TRAVA e manda parar na mão (`dgclaw agente parar <agente>`). Se o marcador não puder ser gravado (disco cheio, por
exemplo), o agente continua parado e o comando avisa.

Limite: o arquivo é do agente e só se lê com o container ligado. A checagem de antes de ligar (rótulo da imagem) não o vê; a
conferência logo depois da partida o pega e para o container. A política remota baixada durante a sessão só aparece no cache no
início da seguinte, e a conferência a pega no próximo `iniciar`/`reiniciar`/consulta. A prova com o Claude Code real fica para o
QA na VPS; os testes usam um `podman` de mentira que monta o arquivo e o `node` de verdade o lê.

## O que o teste prova e o que não prova

`tests/cli/restricoes.sh`, `tests/cli/restricoes-gancho.sh` e o `tests/cli/atualizar.sh` provam que o
arquivo e as travas sobrevivem a criar, reparar, recriar e atualizar, que o gancho decide certo para cada
caminho e que um arquivo estragado não solta nada. O que só uma VPS real prova é o Claude Code de verdade
respeitando o `denyTools` e o gancho. Depois de travar um agente, peça a ele uma gravação fora das pastas
e confirme que foi recusada. Também fica para o QA na VPS (a validação no Claude Code real não foi feita aqui): recusa de `/var/spool/cron/crontabs/agente` e `/etc/sudoers.d/x`, gravar `relatorios/.claude/skills/x/SKILL.md` e `.dgclaw/config.sh` por Write e Edit com só o Bash travado, e conferir que `onFailure` (valores `continue` e `block`, desde o Claude Code 2.1.295; a imagem fixa a 2.1.296) é respeitado.
