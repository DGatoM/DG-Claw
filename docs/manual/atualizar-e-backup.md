# Atualizar, backup e manutenção

Esta página cobre o que você faz (ou pede ao Admin) para manter o DG Claw em dia e seguro contra erro: atualizar,
fazer e restaurar backup, trocar o domínio e a senha do painel, reconstruir a imagem dos agentes e conferir se
tudo está de pé. Quase tudo isso é um comando que o Admin roda no servidor; você só precisa dizer em português o que quer.

Todos os comandos rodam como root (`sudo dgclaw ...`) e aceitam `--ensaio`, que mostra o que seria feito sem mudar
nada. A lista completa dos comandos está em [referencia-admin.md](referencia-admin.md). A exceção é o `dgclaw emergencia`, que ignora o `--ensaio` e age de verdade: para ver o plano sem mudar nada, use `dgclaw emergencia simular`.

## Atualizar o DG Claw

**O que é.** `dgclaw atualizar` baixa a versão nova, faz um backup datado, reinstala o programa, reconstrói a imagem
dos agentes, recria o container de cada agente e confere que nada do que existia sumiu ou mudou. Só no fim reinicia
o Admin, e solto do chat, para a conversa em que você está não cair no meio.

**Como pedir.** Diga ao Admin: "atualiza o DG Claw". Ele conta o que vem na versão nova antes de instalar e só
segue com o seu sim. A atualização leva de 10 a 30 minutos, e cada agente fica fora do ar por cerca de um minuto.

**Fluxo recomendado, em ordem.**

1. `sudo dgclaw atualizar --simular`: mostra tudo o que faria, sem mudar nada, e grava o relatório "O que muda"
   (commits novos, itens do CHANGELOG e pontos de atenção em áreas sensíveis) em `/var/log/dgclaw/`.
2. O Admin lê o relatório e conta a você, em linguagem simples, o que vem e se há risco.
3. Com o seu ok: `sudo dgclaw atualizar --ok-do-dono --segundo-plano`. Sem o `--ok-do-dono`, e havendo algo novo, o
   comando para antes do backup e não muda nada.
4. Se a versão nova traz um passo manual, ele está na subseção "Como atualizar" do `CHANGELOG.md`, escrita para
   você. O Admin aplica.

**As opções.**

| Opção | Para que serve |
| --- | --- |
| `--simular` | Mostra o que faria, sem mudar nada |
| `--ok-do-dono` | Você leu o relatório "O que muda" e autorizou. Sem isso a atualização de verdade não segue |
| `--segundo-plano` | Roda solto do terminal e deixa o registro em `/var/log/dgclaw/` (recomendado para o Admin) |
| `--repo <pasta>` | Onde está o clone do DG Claw, se o instalador não souber |
| `--forcar-local` | Se o clone tiver alteração local, guarda num stash datado e segue |
| `--sem-baixar` | Não faz `git fetch` nem `git pull` (o clone já foi atualizado à mão) |
| `--sem-backup-agentes` | Pula o backup das casas dos agentes. Só se você pedir |
| `--sem-voltar-sozinho` | Se o instalador novo ou a conferência falharem, para e deixa como está, para investigar |
| `--voltar <pasta>` | Volta ao backup indicado (veja "Voltar atrás") |

**O que é preservado.** A atualização nunca apaga o que é seu: as linhas de `web.env` e `dgclaw.env` (inclusive as
chaves de voz e de IA que você pôs), a lista de agentes e as portas, os tokens e segredos entre o Web e os agentes,
a casa de cada agente (memória, conversas, uploads, rotinas), o cofre de cada agente, os dados do painel (conversas,
mesa de tarefas, avisos no aparelho), os agentes aposentados, a pasta do Admin com o `CLAUDE.md` e o `AGENTS.md`
personalizados, a conversa do próprio Admin e os backups. Os arquivos de configuração são editados linha a linha;
nenhum é reescrito inteiro. O que pode ser reescrito é só cópia do repositório: o programa em `/opt/dgclaw/app`, as
unidades do systemd e a imagem dos agentes. No fim, o comando confere isso e reprova se algo sumiu.

**Quando volta sozinha.** Se o instalador novo terminar com erro, ou a conferência de configuração reprovar, o
comando desfaz tudo sozinho usando o backup que acabou de fazer. Se um agente apenas não subir, ele **não** volta
(voltar repetiria o problema do container): o resumo diz "Atualizacao INCOMPLETA", lista os agentes com problema e o
Admin refaz cada um com `sudo dgclaw agente recriar <slug> --forcar`. O Admin só é reiniciado quando tudo está bem.

**Se der erro.**

- *Clone com alteração local:* o comando para e lista os arquivos. Use `--forcar-local` se pode guardar a alteração.
- *Disco curto:* precisa do tamanho do backup mais uns 6 GB para a imagem nova. Libere espaço e rode de novo.
- *Personalização que cruza com a versão nova:* o comando para e explica. Veja [personalizar.md](personalizar.md).

Roteiro completo, com todos os conflitos conhecidos: [ATUALIZAR.md](../ATUALIZAR.md).

## Aviso de versão nova

**O que é.** A cada 6 horas o seu servidor consulta o repositório oficial (leitura pública, sem conta). Quando a
`main` tem commits que a sua instalação não tem, aparece uma faixa no painel: "Nova versão do DG Claw disponível".
**Ver o que mudou** abre o resumo; **Instalar** leva ao chat do Admin com o pedido já escrito; **Agora não** esconde
o aviso até sair uma versão mais nova. O Admin também recebe um recado, no máximo uma vez por versão.

**Como usar na linha de comando.** `sudo dgclaw atualizar --checar` confere na hora (só lê o GitHub, não baixa nem
instala). `sudo dgclaw atualizar --aviso desligar` desliga o aviso automático e `--aviso ligar` volta. `sudo dgclaw
status` mostra uma linha com o resultado da última checagem.

**Limites.** O que sai do servidor é o IP e o número do commit instalado. Nada é baixado ou instalado sem o seu ok.
Detalhes em [AVISO-DE-ATUALIZACAO.md](../AVISO-DE-ATUALIZACAO.md).

## Backup

**O que é.** `dgclaw backup` guarda tudo o que é seu numa pasta datada e conferida em
`/var/backups/dgclaw/<AAAAMMDD-HHMMSS>-manual/` (acesso só do root). Cada arquivo é aberto para ver se não ficou
corrompido; se algum não abrir, o comando para e diz o motivo.

**Como pedir.** "Admin, faz um backup." Ou, no terminal: `sudo dgclaw backup`. Variações: `--sem-casas` deixa de
fora a memória e as conversas dos agentes (só se o disco estiver curto) e `--simular` mostra o que faria.
`sudo dgclaw backup listar` mostra a data, o motivo, a versão, o tamanho e se as casas entraram. Uma pasta sem
`MANIFESTO.txt` aparece como "incompleto" e não serve para restaurar.

**O que entra:**

- a configuração (`/etc/dgclaw`): `web.env`, `dgclaw.env`, `agentes.json`, tokens, segredos e o hash da senha do painel;
- os dados (`/var/lib/dgclaw`): as casas dos agentes (memória, conversas, uploads, rotinas), os cofres e os dados do painel;
- a pasta do Admin e a conversa do Admin.

**O que não entra:** o programa (`/opt/dgclaw/app`) e o clone, que vêm do GitHub; a imagem e os containers dos
agentes, que o DG Claw refaz; e programas que alguém instalou dentro do container, fora da casa do agente.

**Limites.**

- Um backup que fica só na VPS some junto com ela. Copie de vez em quando para outro lugar por canal seguro (SSH),
  porque ele guarda chaves e o hash da senha. O [BACKUP.md](../BACKUP.md) traz os comandos `scp` e `rsync`.
- Nenhum comando do DG Claw apaga backup. O Admin nunca apaga o mais recente nem os que o sistema fez antes de
  restaurar ou voltar.
- Nunca cole o conteúdo de um backup na conversa: ele tem segredos.

## Restaurar

**O que é.** `dgclaw restaurar <pasta-do-backup>` devolve a configuração, os dados e o Admin de um backup. Antes de
tocar em qualquer coisa, ele guarda o estado de agora num backup com o motivo `antes-de-restaurar`. Por isso restaurar
nunca perde dado: dá sempre para desfazer.

**Como pedir.** "Admin, volta ao backup de ontem." Ele roda primeiro `sudo dgclaw restaurar <pasta> --simular`, mostra
o que vai acontecer e só depois restaura.

**Quando ele recusa.**

- Se a versão do backup for diferente da instalada. Para voltar código e dados juntos, o caminho é
  `sudo dgclaw atualizar --voltar <pasta>`. Para restaurar só os dados mesmo assim, `--mesmo-assim`.
- Se existirem agentes criados depois do backup (eles sumiriam do painel). `--mesmo-assim` também libera.

**O que ele faz.** Para os agentes que estavam ligados, devolve os arquivos por cima (sem apagar o que o backup não
conhecia), confere por sha256 que configuração, Admin e cofres ficaram idênticos ao backup, religa os agentes e agenda
o reinício do Admin para o fim. A conversa do Admin não é tocada, para o chat em que você está não voltar no tempo.
O painel só relê o `web.env` quando sobe: se ele mostrar valores antigos, reinicie com `sudo systemctl restart dgclaw-web`.

**Desfazer uma restauração.** `sudo dgclaw restaurar <pasta antes-de-restaurar>`. O comando imprime essa pasta no fim.

## Voltar atrás numa atualização

Se a atualização deu problema e você quer o código de antes: `sudo dgclaw atualizar --voltar <pasta>`. Ele faz o que o
`restaurar` faz com a configuração e o Admin, e também volta o clone ao commit do backup, reinstala, reconstrói a
imagem e recria os agentes. **Não** restaura as casas dos agentes: a memória e as conversas ficam como estão.

| Situação | Comando |
| --- | --- |
| Você apagou ou estragou dados, e a versão instalada é a mesma do backup | `dgclaw restaurar <pasta>` |
| A atualização deu problema e você quer o código de antes | `dgclaw atualizar --voltar <pasta>` |

## Trocar o domínio do painel

**O que é.** Passa o painel de um endereço de teste para um domínio seu, como `painel.minhaempresa.com.br`.

**Como pedir.** "Admin, quero usar o domínio painel.minhaempresa.com.br." Existe a skill `trocar-dominio`, que
explica cada passo a quem é leigo. Antes de tudo você cria, no lugar onde comprou o domínio, um registro DNS do tipo A
apontando para o IP da VPS. `sudo dgclaw dominio mostrar` mostra o domínio atual e o IP que você deve usar.

**O que o comando faz.** `sudo dgclaw dominio trocar painel.minhaempresa.com.br` confere o DNS (e não muda nada se não
apontar), reescreve o Caddy, recarrega, grava o domínio no `dgclaw.env` e espera o HTTPS (o certificado sai sozinho).

**Limites.** O endereço antigo deixa de abrir o painel, e quem estava logado precisa entrar de novo no endereço novo.
A senha e os agentes continuam os mesmos. A opção `--sem-conferir-dns` pula a conferência e é por sua conta e risco.

**Se der erro.**

- *"O DNS ainda não aponta":* crie ou corrija o registro A (apague um registro AAAA antigo do mesmo nome; na Cloudflare,
  deixe a nuvem cinza) e espere a propagação, que leva de minutos a algumas horas.
- *"O HTTPS não respondeu em 90 segundos":* o Caddy já está com o nome novo. Confira se as portas 80 e 443 estão
  abertas no firewall do provedor da VPS. Ele tenta de novo sozinho. Para voltar: `dgclaw dominio trocar <nome antigo>`.

## Senha do painel e primeiro acesso

- **Trocar a senha:** `sudo dgclaw senha trocar`. Mínimo de 12 caracteres, digitados sem aparecer na tela. Troca só a
  linha da senha no `web.env`, apaga um link de primeiro acesso pendente e reinicia o Web. As sessões abertas deixam de valer.
- **Perdeu o link de primeiro acesso:** `sudo dgclaw primeiro-acesso` gera um novo (uso único, vale 30 minutos); o
  anterior deixa de valer.
- **Instalação feita pela equipe na VPS de outra pessoa:** `sudo dgclaw instalacao-remota` troca a senha por uma forte
  e mostra a mensagem de entrega uma única vez. Não rode numa instalação que você mesmo fez: ele troca a sua senha.

## Imagem dos agentes

A imagem é o "molde" de onde sai o container de cada agente. A atualização já a reconstrói sozinha. Para olhar:
`sudo dgclaw imagem status` diz se ela está pronta, construindo ou falhou (com `--exigir-pronta` sai com erro se não
estiver). Para reconstruir: `sudo dgclaw imagem construir` (em segundo plano) ou com `--agora`, na hora. Reconstruir a
imagem não muda os containers que já existem; para um agente usar a imagem nova, `sudo dgclaw agente recriar <slug>`
(mantém a casa, o cofre, as portas e as rotinas).

## Conferir se tudo está de pé

- `sudo dgclaw status` confere o que é essencial e sai com erro se algo caiu. As linhas `FALHOU` dizem o que
  consertar.
- `sudo dgclaw versao` mostra a versão e o commit instalados.
- `sudo dgclaw agente listar` lista os agentes e diz se estão de pé.

## Consertar um agente

| Problema | O que fazer |
| --- | --- |
| O agente travou, mas o container está bem | `sudo dgclaw agente reiniciar <slug>` |
| Falta arquivo ou configuração dentro do agente | `sudo dgclaw agente reparar <slug>`: regrava o `config.sh` e refaz runner, painel e rotinas |
| O container ficou preso ou usa a imagem velha | `sudo dgclaw agente recriar <slug>` (com `--forcar` se for preciso) |
| A identidade do agente mudou e ele precisa reler | `sudo dgclaw agente identidade <slug>` (vale na próxima sessão) |
| A Tela não aparece | `sudo dgclaw agente tela <slug>`: diz, linha a linha, o que falta |
| O agente parou de responder ou ficou estranho | Aba **Socorro** do painel (skill `socorro`) |

Para tirar um agente do ar sem apagar nada: `sudo dgclaw agente remover <slug>`. A casa dele vai para
`/var/lib/dgclaw/aposentados/`.
