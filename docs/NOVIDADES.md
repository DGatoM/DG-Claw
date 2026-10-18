# Aviso de novidades depois de atualizar

Quando o dono atualiza o DG Claw, cada agente (e o Admin) conta a ele, na primeira conversa depois
da atualização, o que veio de novo e dá para usar. Algo como: "vi que você atualizou o DG Claw, o novo
está com isso, isso e isso". Acontece uma vez por agente e custa quase nada: o texto só entra no
contexto do turno em que a versão mudou.

## Como funciona

1. O instalador grava a versão em `/opt/dgclaw/app/VERSAO` (`v1-<commit>`, ou a do `plugin.json`).
2. O gancho `scripts/novidades-hook.mjs` (UserPromptSubmit, via `promptHooks` do `runner.json`) lê essa
   versão e compara com a última que o agente viu, guardada em `~/.dgclaw/novidades-visto.json`
   (no Admin: `/opt/dgclaw/admin/.dgclaw/novidades-visto.json`).
3. Se a versão é a mesma, não faz nada. Se mudou, acrescenta ao contexto um bloco curto com as
   novidades e o pedido para o agente avisar o dono, e grava o visto na hora.

Quando o gancho falha por qualquer motivo, ele sai com 0, sem texto, e anota o motivo em
`~/.dgclaw/logs/novidades-hook.log`. Nunca atrapalha a conversa.

## De onde vêm as novidades

Do `CHANGELOG.md`. Como as versões instaladas são commits, não dá para casar versão com título de
seção. O arquivo de visto guarda a impressão digital (sha1 curto) de cada item do CHANGELOG que o
agente já conhecia. Novidade é o item cuja impressão ainda não está lá. O bloco é cortado em
cerca de 2500 caracteres, item inteiro por item inteiro.

Consequências para quem escreve o CHANGELOG:

- Escreva o item em linguagem de gente, sobre o que o dono usa. É o texto que o agente vai resumir.
- Reescrever um item que já foi publicado faz ele contar como novo. Corrija com cuidado.
- Um item novo só chega ao agente quando o `CHANGELOG.md` dele muda, ou seja, quando a imagem nova chega.

## Como a versão chega ao container

O app não é montado no container: a imagem do agente copia `/opt/dgclaw/app` inteiro (`COPY . /opt/dgclaw/app`
no `container/Containerfile`), incluindo `VERSAO` e `CHANGELOG.md`. Então o agente enxerga a versão da imagem em que está,
não a do host. O aviso dispara quando todas estas coisas aconteceram:

1. `sudo ./install.sh` rodou com o código novo (grava `VERSAO` e o `CHANGELOG.md` novos no host);
2. a imagem nova foi construída (`dgclaw imagem construir`, ou o instalador com `--com-imagem`);
3. o container do agente passou a usar a imagem nova (agente recriado);
4. o runner leu o `runner.json` com o gancho (`dgclaw agente reparar <slug>` põe o gancho nos agentes
   antigos; depois `dgclaw agente reiniciar <slug>`);
5. o dono mandou uma mensagem na conversa.

Até a imagem ser refeita, o agente continua com a versão velha e não avisa nada, o que é o certo: as
novidades ainda não chegaram a ele. O Admin roda no host, então lê o `VERSAO` do próprio
`/opt/dgclaw/app`: avisa na primeira conversa depois do `install.sh`. O `runner.json` do Admin é
reescrito a cada instalação, então o gancho entra sozinho.

## Quem recebe e quem não recebe

- Agente criado depois desta funcionalidade: o `dgclaw agente criar` roda o gancho com `--semear`, que
  grava o visto com a versão e o CHANGELOG de agora. Ele não recebe aviso do que já nasceu com ele.
  O Admin de uma instalação nova é semeado do mesmo jeito.
- Agente que já existia antes (sem arquivo de visto): recebe o aviso uma vez, com os itens da seção
  `[Não lançado]` do CHANGELOG (ou a seção mais recente, se ela estiver vazia). Depois disso o visto é gravado.
- Arquivo de visto ilegível: o gancho trata como agente antigo e anota no log.
- Só a conversa com o dono consome o aviso. Rotinas, batimentos e recados internos passam pelo mesmo
  gancho, mas não gastam o aviso (o gancho olha se o texto do turno tem o envelope `<dgchat>` ou `<channel>`).
  Sessões paralelas (cards) do mesmo agente dividem o mesmo visto: quem receber a primeira mensagem do dono avisa.
- Se o `node` faltar no host na hora de criar o agente, o `criar` avisa e o agente anuncia as novidades
  na primeira conversa (o mesmo que um agente antigo).

## Testes

`tests/novidades/rodar.sh` (parte `novidades` do `tests/rodar.sh`) roda o gancho com node num app e num
workspace temporários: versão igual, agente antigo, item novo, corte por tamanho, agente semeado,
CHANGELOG ou VERSAO ausentes, visto ilegível.
