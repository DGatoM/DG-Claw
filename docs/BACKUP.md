# Backup e restauração do DG Claw

Este documento é o roteiro que o Admin segue quando o dono pede "faz um backup" ou "volta ao que era
ontem". O dono não é programador: ele vê só o chat. Os comandos rodam como root, no terminal do servidor.

Resumo: **`dgclaw backup`** guarda tudo o que é do dono numa pasta datada e conferida. **`dgclaw restaurar`**
devolve o conteúdo de um backup, depois de guardar o estado de agora, então restaurar nunca perde dado:
sempre dá para voltar.

## Fazer um backup

```bash
sudo dgclaw backup                  # backup completo
sudo dgclaw backup --sem-casas      # sem as casas dos agentes (só se o disco estiver curto)
sudo dgclaw backup --simular        # mostra o que faria, sem criar nada
```

Cada backup vira uma pasta `/var/backups/dgclaw/<AAAAMMDD-HHMMSS>-manual/` (permissão 700, só root). No
fim o comando imprime a pasta, o tamanho e o comando para restaurar. Todo arquivo é aberto (`tar -tzf`)
antes de seguir: se algum não abrir, o comando para e diz o motivo.

### O que entra

| Arquivo da pasta | O que leva |
|---|---|
| `config.tar.gz` | `/etc/dgclaw` inteiro: `web.env`, `dgclaw.env`, `agentes.json`, tokens, segredos, hash da senha do painel |
| `dados.tar.gz` | `/var/lib/dgclaw`: as casas dos agentes (memória, conversas, uploads, rotinas), os cofres e os dados do painel |
| `admin.tar.gz` | `/opt/dgclaw/admin`: `CLAUDE.md`, `AGENTS.md`, uploads e skills do Admin |
| `transcricoes-admin.tar.gz` | a conversa do próprio Admin |
| `extras.tar.gz` | só existe se uma edição que estende o DG Claw pedir caminhos a mais (ver "Para quem estende") |
| `MANIFESTO.txt` | quando foi feito, o motivo, a **versão e o commit instalados**, os agentes, se as casas entraram e o sha256 dos arquivos de configuração |

Com `--sem-casas`, `dados.tar.gz` leva tudo de `/var/lib/dgclaw` **menos** `agentes/*/home` (a memória e as
conversas dos agentes). Os cofres entram do mesmo jeito.

### O que não entra

- O código do DG Claw (`/opt/dgclaw/app`) e o clone: vêm do GitHub e o instalador regrava.
- A imagem dos agentes e os containers: o `dgclaw imagem construir` e o `dgclaw agente recriar` refazem.
- Programas que alguém instalou dentro do container, fora da casa do agente.

### Os motivos que aparecem na lista

| Motivo | Quem fez |
|---|---|
| `manual` | você, com `dgclaw backup` |
| `atualizar` | o `dgclaw atualizar`, antes de mexer em qualquer coisa |
| `antes-de-restaurar` | o `dgclaw restaurar`, para você poder desfazer a restauração |
| `antes-de-voltar` | o `dgclaw atualizar --voltar` (ou a volta automática), pelo mesmo motivo |

## Ver os backups

```bash
sudo dgclaw backup listar
```

Mostra, para cada pasta: a data, o motivo, a versão, o tamanho e se as casas dos agentes entraram. Uma pasta
sem `MANIFESTO.txt` aparece como "incompleto": o backup foi interrompido (disco cheio, por exemplo) e não
serve para restaurar.

## Restaurar

```bash
sudo dgclaw restaurar /var/backups/dgclaw/<pasta> --simular   # primeiro, só olhar
sudo dgclaw restaurar /var/backups/dgclaw/<pasta>
```

Na ordem:

1. Confere que o backup abre (todos os `.tar.gz`) e que tem `MANIFESTO.txt`.
2. Recusa se a **versão** do backup for diferente da instalada. O motivo: devolver configuração e dados de
   uma versão para o código de outra pode deixar o sistema inconsistente. Para voltar código e dados juntos,
   use `sudo dgclaw atualizar --voltar <pasta>`. Para restaurar só os dados e a configuração mesmo assim,
   `--mesmo-assim`.
3. Recusa se existirem agentes criados **depois** do backup (restaurar o `agentes.json` os tiraria do painel;
   as pastas deles ficariam, mas sumiriam da lista). `--mesmo-assim` também libera isso.
4. Faz um backup do estado de agora, com o motivo `antes-de-restaurar` (com as casas dos agentes).
5. Para os agentes que estavam ligados.
6. Devolve `/etc/dgclaw`, `/var/lib/dgclaw` (as casas, se o backup as tiver) e a pasta do Admin, por cima,
   sem apagar arquivo novo que o backup não conhecia. A conversa do Admin não é tocada, para o chat em que
   você está não voltar no tempo.
7. Confere por sha256 que configuração, Admin e cofres ficaram idênticos aos do backup.
8. Religa os agentes que estavam ligados.
9. Agenda o reinício do Admin para o fim, solto do chat (o mesmo roteiro do `dgclaw atualizar`), porque o
   comando pode estar rodando dentro do próprio Admin. Ele nunca reinicia o Admin no meio.

O painel (`dgclaw-web`) só lê o `web.env` quando sobe. Se ele ainda mostrar valores antigos depois de
restaurar, reinicie-o de fora do chat: `sudo systemctl restart dgclaw-web`.

Para desfazer uma restauração: `sudo dgclaw restaurar /var/backups/dgclaw/<pasta antes-de-restaurar>`. O
comando imprime essa pasta no fim.

## Quando usar `restaurar` e quando usar `atualizar --voltar`

| Situação | Comando |
|---|---|
| O dono apagou ou estragou dados, e a versão instalada é a mesma do backup | `dgclaw restaurar <pasta>` |
| A atualização deu problema e o dono quer o código de antes | `dgclaw atualizar --voltar <pasta>` |

O `--voltar` faz o que o `restaurar` faz com a configuração e o Admin e também volta o clone ao commit do
backup, reinstala, reconstrói a imagem e recria os agentes. Ele não restaura as casas dos agentes.

## Copiar o backup para fora do servidor

Um backup que mora só na VPS some junto com ela. Copie de vez em quando para outro lugar. Ele guarda chaves e
o hash da senha, então só por canal seguro (SSH) e para um lugar que só o dono acessa.

```bash
# do seu computador, puxando a pasta inteira
scp -r root@seu-servidor:/var/backups/dgclaw/20261018-093000-manual ./backups-dgclaw/

# ou com rsync, que só envia o que mudou
rsync -a root@seu-servidor:/var/backups/dgclaw/ ./backups-dgclaw/
```

Para restaurar a partir de uma cópia, devolva a pasta ao servidor (`rsync -a ./backups-dgclaw/<pasta> root@seu-servidor:/var/backups/dgclaw/`)
e rode `sudo dgclaw restaurar` apontando para ela.

## Regras que valem sempre

- **Nenhum comando do DG Claw apaga backup.** Só o dono pede para apagar um, e o Admin nunca apaga o mais
  recente nem um `antes-de-restaurar` ou `antes-de-voltar`.
- Se o disco encher, o `tar` falha e o comando diz isso sem seguir. Libere espaço (`du -sh /var/backups/dgclaw/*`,
  `podman image prune`) e rode de novo.
- Backup tem segredos. Nunca cole o conteúdo de `config.tar.gz` ou `cofre.env` no chat.

## Para quem estende o DG Claw

O `lib/backup.sh` tem quatro funções pequenas, com um padrão que não faz nada. Uma edição que estende o DG
Claw (a enterprise, por exemplo) carrega o arquivo e **redefine** as que precisar:

| Função | Para que serve |
|---|---|
| `backup_caminhos_extras` | imprime, um por linha, caminhos absolutos que também entram no backup (viram o `extras.tar.gz` e voltam no `restaurar`) |
| `backup_aplicar_retencao <pasta-dos-backups>` | roda depois de cada backup criado. O padrão não apaga nada |
| `depois_de_restaurar <pasta>` | roda no fim de um `dgclaw restaurar` que deu certo |
| `depois_de_atualizar <resultado>` | roda no fim de um `dgclaw atualizar`; o resultado é `concluida`, `incompleta` ou `voltou-sozinho` |
