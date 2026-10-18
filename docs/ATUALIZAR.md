# Atualizar o DG Claw

Este documento é o roteiro que o Admin segue quando o dono pede "atualiza o DG Claw". Foi escrito
para um agente ler e executar, passo a passo. O dono não é programador: ele vê só o chat.

Resumo: use **`dgclaw atualizar`**. Ele faz backup, baixa a versão nova, reinstala, recria a máquina de
cada agente e confere que nada do dono sumiu ou mudou. Nunca monte esse caminho na mão com `git pull`,
`install.sh` e `dgclaw imagem construir` soltos: o comando existe justamente para a ordem e as
conferências não dependerem de quem está lembrando.

## Quando usar

- O dono pede para atualizar o DG Claw, "pegar a versão nova" ou "ficar com as novidades".
- O dono diz que viu uma novidade ou correção que ainda não aparece no painel dele.
- Uma correção que você precisa já saiu no repositório.

Para só reiniciar um serviço ou um agente travado, não atualize: use `dgclaw agente reiniciar <slug>` ou
`dgclaw agente reparar <slug>`.

## O que NUNCA tocar

Estes caminhos são dados do dono. A atualização preserva todos, e você também nunca os apaga, move ou
sobrescreve, nem "só para limpar":

| Caminho | O que é | Por que não se toca |
|---|---|---|
| `/etc/dgclaw/web.env` | usuário e hash da senha do painel, chaves de voz e de IA (`GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) e qualquer ajuste que o dono pôs | perder uma linha desliga o microfone ou a senha. Já aconteceu em 17/10/2026. Só se edita linha a linha |
| `/etc/dgclaw/dgclaw.env` | domínio, provedor do Admin, usuário, imagem, onde está o clone | o instalador troca só as linhas dele (`DGCLAW_VERSAO`, `DGCLAW_COMMIT` mudam de propósito) e mantém as outras |
| `/etc/dgclaw/agentes.json`, `registro.tsv`, `portas.tsv` | a lista de agentes, a faixa de usuário e as portas de cada um | sem isso os agentes somem do painel ou dois agentes disputam a mesma porta; a faixa de usuário de um agente removido fica "queimada" de propósito |
| `/etc/dgclaw/runner/*.token`, `/etc/dgclaw/proxy/*.segredo` | credenciais entre o Web e cada agente | trocar derruba a conversa entre eles |
| `/etc/dgclaw/primeiro-acesso.json` | link de primeiro acesso pendente | só o instalador e o `dgclaw primeiro-acesso` mexem |
| `/var/lib/dgclaw/agentes/<slug>/home` | a casa do agente: memória, conversas (`.claude/projects`), uploads, `IDENTITY.md`, `PERSONALITY.md`, rotinas (`.dgclaw/self-crons.json`) | é o trabalho de meses do dono |
| `/var/lib/dgclaw/agentes/<slug>/cofre/cofre.env` | as chaves que o dono guardou no cofre daquele agente | insubstituível: só o dono tem os valores |
| `/var/lib/dgclaw/agentes/<slug>/runner`, `segredos`, `config` | configuração do agente fora da casa (o agente só lê) | o `agente recriar` e o `reparar` regravam o necessário; não edite na mão |
| `/var/lib/dgclaw/web/` | `sessoes.json` (conversas do painel), cofre do painel, mesa de tarefas, avisos no aparelho, onboarding | histórico e configuração do painel |
| `/var/lib/dgclaw/aposentados/` | casas de agentes removidos | o dono pode querer de volta |
| `/opt/dgclaw/admin` | a pasta do Admin: `CLAUDE.md` e `AGENTS.md` (podem estar personalizados), uploads, skills | o que o dono ensinou ao Admin |
| `/root/.claude/projects/-opt-dgclaw-admin` (ou `/root/.codex/sessions`) | a conversa do próprio Admin | o histórico dele |
| `/var/backups/dgclaw/` | os backups da atualização | só se apaga um backup velho se o dono pedir, e nunca o mais recente |

O que **pode** ser reescrito sem dó, porque é cópia do repositório: `/opt/dgclaw/app` (o instalador faz
`rsync --delete` ali, sem encostar nos dados acima), as unidades em `/etc/systemd/system/dgclaw-*` e a
imagem dos agentes. Cada agente também tem rotinas que ele mesmo criou (unidades `dgclaw-<slug>-self-*`
dentro do container): o `dgclaw agente recriar` guarda e devolve.

Também nunca, em hipótese alguma: `git reset --hard`, `git clean`, `rm -rf` em pasta de agente, `podman
system prune --volumes`, `podman rm` de container sem passar por `dgclaw agente recriar`.

## Antes de começar

1. Avise o dono, em uma frase: "Vou atualizar o DG Claw. Faço um backup antes de mexer em qualquer
   coisa. Leva de 10 a 30 minutos, os agentes ficam fora do ar por um minuto cada e eu aviso quando
   terminar."
2. Veja se há conversa em andamento com algum agente que não pode cair agora (`dgclaw agente listar`).
   Se o dono disser que sim, combine outro horário.
3. Simule primeiro. Não muda nada e mostra tudo o que seria feito:

   ```bash
   sudo dgclaw atualizar --simular
   ```

   Se a simulação já parar com um erro (clone com alteração, clone não encontrado, disco curto), resolva
   pelo capítulo "Conflitos" antes de seguir.

## Não mexa no clone antes do comando

Quando o dono pede só "atualiza", **não faça `git checkout`, `git pull` nem `git fetch` no clone antes**.
O `dgclaw atualizar` baixa a versão nova sozinho. Se o clone for mudado à mão antes, o comando ainda
descobre qual versão estava instalada (ver o capítulo "O commit de antes"), mas é uma complicação
que não precisa existir.

Se o dono pedir uma **branch específica**, não existe opção própria para isso. O jeito é preparar o clone
e dizer ao comando para não baixar de novo:

```bash
git -C <clone> fetch origin
git -C <clone> checkout -B <branch> origin/<branch>
sudo dgclaw atualizar --sem-baixar
```

O commit de antes continua certo (item abaixo), então o `--voltar` volta para a versão que estava
instalada, e não para a branch que você acabou de puxar.

## Rodar

O Admin tem tempo limite por comando, e a atualização demora por causa da imagem. Rode **solta do
terminal** e acompanhe o log:

```bash
sudo dgclaw atualizar --segundo-plano
```

Ele imprime o nome da unidade e o arquivo de log, algo como `/var/log/dgclaw/dgclaw-atualizar-20261018-093000.log`.
Acompanhe:

```bash
tail -n 40 /var/log/dgclaw/dgclaw-atualizar-*.log        # o fim do log
systemctl is-active dgclaw-atualizar-<data>              # "inactive" = terminou; o fim do log diz se deu certo
```

Olhe o log a cada poucos minutos e conte ao dono em que passo está. O fim do log traz
`Atualizacao concluida.` (deu certo), `Atualizacao INCOMPLETA` (algum agente ficou com problema, ver
adiante) ou `A atualizacao parou em: ...` (veja "Conflitos"). Se o terminal aguentar,
`sudo dgclaw atualizar` faz o mesmo em primeiro plano.

Opções que você usa só quando preciso:

| Opção | Quando |
|---|---|
| `--repo <pasta>` | o instalador não anotou onde está o clone (instalação antiga). Procure com `find / -name install.sh -path '*DG-Claw*' 2>/dev/null` |
| `--forcar-local` | o clone tem alteração local e o dono autorizou guardá-la num stash datado |
| `--sem-baixar` | o clone já foi atualizado à mão (ou veio de um zip novo); só reinstala o que está na pasta |
| `--sem-backup-agentes` | **só se o dono pedir explicitamente** (disco curto): o backup não leva as casas dos agentes. O resto do backup entra sempre |
| `--simular` | mostra tudo sem mudar nada |

## O que o comando faz, na ordem

1. **Acha o clone** (onde está o `install.sh` que instalou): `--repo`, ou `DGCLAW_REPO` do `dgclaw.env`
   (o instalador anota sozinho), ou `/root/DG-Claw`.
2. **Pré-checagem do clone**: `git status --porcelain`. Com qualquer alteração local ele **para** e lista
   os arquivos. Com `--forcar-local` guarda tudo em `git stash push -u -m dgclaw-atualizar-<data>` e
   avisa o nome do stash. Nunca faz `reset --hard` nem `clean`.
3. **Confere o disco**: precisa do tamanho do backup mais uns 6 GB para a imagem nova.
4. **Backup datado** em `/var/backups/dgclaw/<AAAAMMDD-HHMMSS>/` (pasta 700, só root): `config.tar.gz`
   (`/etc/dgclaw`), `dados.tar.gz` (`/var/lib/dgclaw` inteiro), `admin.tar.gz` (`/opt/dgclaw/admin`),
   `transcricoes-admin.tar.gz` (a conversa do Admin) e o `MANIFESTO.txt` (commit anterior, lista de
   agentes, sha256 dos arquivos de configuração e das identidades). Cada tar é aberto (`tar -tzf`) antes
   de seguir: se não abrir, o comando para e nada foi mudado.
5. **Baixa a versão nova**: `git fetch` e `git pull --ff-only`. Se o clone divergiu, para e explica;
   nunca faz merge sozinho.
6. **Roda o `install.sh` do clone** sem nenhuma pergunta, reaproveitando usuário, domínio e provedor que já
   estão configurados. A senha atual do painel continua valendo. O instalador edita as configurações
   linha a linha e não troca um `CLAUDE.md` ou `AGENTS.md` do Admin que foi personalizado (ver adiante).
7. **Reconstrói a imagem** dos agentes (`dgclaw imagem construir --agora`). É o passo mais longo.
8. **Recria o container de cada agente** (`dgclaw agente recriar <slug>`): guarda as rotinas que o agente
   criou, para e remove **só o container**, cria de novo com a imagem nova e os **mesmos** volumes, portas e
   rede, devolve as rotinas e espera o agente responder. Casa, cofre e segredos não são tocados. Antes de
   remover, o comando para o container (`podman stop -t 60`) e espera até 90 segundos (`DGCLAW_TEMPO_PARADA`)
   ele sair de `running`/`stopping`. Se o podman deixar o container preso em `stopping`, ele remove só o
   container com `podman rm -f` (a casa, o cofre e os segredos são pastas do servidor, não volumes do
   podman, e ficam intactos; se algum dia houver volume do podman, o comando não usa `-f` e explica).
   Agente que o dono deixou parado fica parado e com a imagem velha (só `--forcar` recria). Se o container
   já usa a imagem atual, nada é recriado.
9. **Confere**: toda linha que existia no `web.env`/`dgclaw.env` continua lá com o mesmo valor; os
   registros dos agentes em `agentes.json` são idênticos; tokens, segredos, cofres e `CLAUDE.md` do Admin
   personalizado estão intactos; roda `dgclaw status`; cada agente ligado responde. Reprova se algo sumiu.
10. **Grava o resumo** num arquivo (`/var/log/dgclaw/dgclaw-atualizar-<data>.resumo.txt`, ao lado do log) e
    **agenda o reinício do Admin** para 20 segundos depois (`systemd-run --on-active=20`), porque este
    comando pode estar rodando dentro do próprio Admin. Se qualquer agente falhou ou a conferência acusou
    problema, o Admin **não** é reiniciado: ele precisa continuar de pé, com o chat funcionando, para
    consertar.
11. Imprime o resumo: versão antiga e nova (com o commit de antes certo), onde ficou o backup, o comando
    para voltar atrás e quais agentes ficaram bem ou com problema.

### O commit de antes

O manifesto do backup (e, portanto, o `--voltar`) usa o commit que estava **instalado**, não o `HEAD`
do clone no momento do comando. Ordem: `DGCLAW_COMMIT` do `dgclaw.env`; se não houver, o hash curto
que está em `DGCLAW_VERSAO` (formato `v1-<12 hex>`); só em último caso o `HEAD`, e então o comando avisa
que pode estar errado. Assim, mesmo que o clone tenha sido puxado à mão antes, o `--voltar` leva para a
versão certa.

## Atualização INCOMPLETA (algum agente não foi recriado)

Se **qualquer** agente falhar ao recriar, ou não responder no fim, o resumo diz
`Atualizacao INCOMPLETA` (nunca "concluída"), lista os agentes com problema, traz o comando para refazer
cada um e o comando sai com código diferente de 0. O Admin **não** é reiniciado.

O que você faz e diz ao dono:

1. Leia as linhas `FALHOU` e a mensagem do agente (ela diz se o container antigo continua lá, em que
   estado, e que a casa está intacta).
2. Refaça cada agente: `sudo dgclaw agente recriar <slug> --forcar`. Ele também recria container que ficou
   parado, preso em `stopping` ou que sumiu, com os mesmos volumes e portas.
3. Confira com `sudo dgclaw agente listar` e conte ao dono, em palavras simples: "A atualização terminou, mas
   a caixa do agente <nome> não subiu de primeira. Os dados dele estão intactos. Já refiz a caixa e ele
   voltou." (ou, se não conseguiu: "ainda não consegui; posso voltar tudo à versão de antes").
4. Só depois que todos estiverem bem, reinicie o Admin como na seção "O reinício do Admin".

## Conflitos possíveis e como resolver

**Clone com alteração local.** O comando para e lista os arquivos. Pergunte ao dono se aquilo é dele.
Se não for (costuma ser um arquivo que o próprio Admin editou numa sessão antiga), rode com
`--forcar-local`: nada se perde, fica no stash. Para devolver depois: `cd <clone> && git stash list` e
`git stash apply <stash>`. Se for trabalho do dono, não force: peça para ele decidir.

**Clone não encontrado.** O erro diz como passar `--repo`. Instalações feitas antes desta função não
anotaram o caminho; o próximo `install.sh` (que a atualização roda) passa a anotar.

**Clone pertence a outro usuário.** O comando já ignora a trava "dubious ownership" do git para o clone.
Se ainda assim o `git` reclamar de permissão, rode `ls -ld <clone>` e conte ao dono o que viu; não
mude o dono dos arquivos sem necessidade.

**`git pull --ff-only` recusou (não é avanço simples).** O clone tem commits que o GitHub não tem, ou o
histórico do GitHub mudou. O comando para sem mexer em nada além do backup. Veja `git log --oneline
--graph --all -20` no clone. Se são commits que o dono nunca fez (acontece quando alguém editou o clone),
salve-os numa branch (`git branch copia-<data>`) e peça ajuda antes de alinhar o clone com o GitHub.
Nunca resolva com `reset --hard`.

**Sem rede para o GitHub (`git fetch` falhou).** Confira a internet (`curl -I https://github.com`). Nada foi
mudado além do backup. Rode de novo quando a rede voltar.

**`CLAUDE.md` ou `AGENTS.md` do Admin personalizado.** O instalador compara o arquivo do Admin com todas as
versões já publicadas do modelo (pelo histórico do git do clone):

- igual a alguma versão publicada (nunca foi editado): é trocado pelo modelo novo;
- diferente de todas (o dono ou o Admin personalizou): **não é tocado**. O modelo novo é gravado ao lado,
  como `/opt/dgclaw/admin/CLAUDE.md.novo` (ou `AGENTS.md.novo`), e o instalador avisa;
- clone sem histórico git (zip): o lado seguro, também não troca e grava o `.novo`.

Quando houver `.novo`, faça a junção **manual e conservadora**: rode `diff /opt/dgclaw/admin/CLAUDE.md
/opt/dgclaw/admin/CLAUDE.md.novo`, traga para o arquivo do dono as seções e linhas que são novidades do
modelo (no mínimo a linha `dgclaw atualizar` da tabela de ferramentas e a seção "Atualizar o DG Claw"),
**sem apagar nada que o dono escreveu**, e depois apague o `.novo`. Conte ao dono em uma frase o que
entrou. O backup tem a versão dele de antes (`admin.tar.gz`). A junção só vale para as próximas
conversas do Admin, depois do reinício.

**Configuração com linha nova.** Normal: o `dgclaw.env` ganha `DGCLAW_REPO` e `DGCLAW_COMMIT`. O que não
pode é uma linha de antes sumir ou mudar de valor. A conferência olha isso e reprova mostrando só o
**nome** da chave, nunca o valor. Se reprovar, não reinicie o Admin: restaure a linha do backup
(`tar -xzOf <backup>/config.tar.gz etc/dgclaw/web.env`, com o cuidado de não imprimir os valores no chat) ou
volte tudo com `--voltar`.

**Container preso em `stopping`.** O `podman stop` devolve, mas o estado fica `stopping` e o `podman rm`
recusa ("running or paused containers cannot be removed"). O `agente recriar` já trata sozinho (espera e
usa `rm -f` só do container). Se mesmo assim falhar, a mensagem diz que o container **antigo** continua
lá e em que estado; nada foi removido. Rode `sudo dgclaw agente recriar <slug> --forcar` (recria também
um container preso em `stopping`).

**Container de um agente que não sobe.** O comando diz qual agente. A casa dele está intacta. Veja:
`podman logs --tail 40 dgclaw-<slug>`. Se terminar com código 255, é falta de inotify: `sysctl -w
fs.inotify.max_user_instances=1024` (o instalador grava `/etc/sysctl.d/90-dgclaw-inotify.conf`). Depois
`dgclaw agente recriar <slug> --forcar`. Se o container foi removido e o novo não terminou de subir, a
mensagem de erro diz isso e repete o comando acima; os dados estão em
`/var/lib/dgclaw/agentes/<slug>/`.

**Imagem não constrói (falta de disco ou rede).** O fim de `/var/log/dgclaw/imagem.log` diz a causa. Para
disco: `df -h /` e `podman system df`. Libere só o que é reconstruível: `podman image prune` (imagens
soltas) e backups velhos de `/var/backups/dgclaw` que o dono aprovar apagar. **Nunca** `podman system
prune --volumes` nem apagar `/var/lib/dgclaw`. Depois rode `sudo dgclaw atualizar --sem-baixar`.

**A atualização parou no meio.** A mensagem final diz em qual passo e onde está o backup. Os dados estão
salvos. Descubra a causa no log, corrija e rode `sudo dgclaw atualizar --sem-baixar` (rodar de novo é
seguro: o instalador só confere o que já está feito e `agente recriar` pula o que já usa a imagem atual).
Se não houver conserto rápido, volte (próximo capítulo).

**Link de primeiro acesso.** Se a senha do painel nunca foi cadastrada, o instalador gera um link novo. O
log o esconde (`primeiro-acesso#(oculto...)`); gere outro com `sudo dgclaw primeiro-acesso` e entregue
ao dono por um canal seguro.

**O que não volta depois de recriar.** Programas que alguém instalou **dentro** do container com `apt` ou
`pip` fora da casa (`/home/agente`) somem, porque a imagem nova é o que vale. Peça ao agente para
reinstalar ou ponha o que for importante na casa dele. Avise o dono se ele costumava instalar coisas assim.

## Conferir depois

O comando já confere, mas confirme com os próprios olhos antes de dizer "pronto":

1. `sudo dgclaw status`: tudo "ok", nenhuma linha FALHOU.
2. `sudo dgclaw agente listar`: todos com `running` e saúde `ok` (os que o dono tinha parado continuam
   parados).
3. Mande uma mensagem de teste a cada agente que estava ligado, pelo chat dele, e espere a resposta. Peça
   algo que prove a memória, por exemplo "me diga em uma frase o que você sabe sobre mim".
4. Abra o painel no navegador (`https://<domínio>/`), entre e veja que as conversas antigas continuam.
5. Se o dono tinha rotinas (aba de agenda ou crons), confira que continuam listadas.
6. Se houver `CLAUDE.md.novo` ou `AGENTS.md.novo`, faça a junção descrita acima.

## O reinício do Admin

Até o reinício, o Admin continua rodando o código velho. O comando agenda o reinício para **20 segundos**
depois do fim. Esse intervalo é para você, Admin, mandar ao dono o resumo **antes** de cair.

**Antes do reinício** (assim que o comando terminar): mande ao dono, pelo chat, o resumo (versão de antes
e nova, backup, como voltar, agentes ok ou com problema) e diga: "Vou reiniciar em instantes e volto
contando o resultado. Se o chat parar, espere uns 20 segundos e recarregue a página."

**Depois do reinício**: o Admin reiniciado recebe sozinho uma mensagem da plataforma
(`<plataforma recado="atualizacao-terminou">`) com o caminho do resumo
(`/var/log/dgclaw/dgclaw-atualizar-<data>.resumo.txt`) e do log. Quando ela chegar, **leia o arquivo do
resumo e responda ao dono**: o resultado em palavras simples (versão de antes -> nova, onde ficou o
backup, como voltar, quais agentes estão bem e quais têm problema e o que você vai fazer). Isso existe
porque o reinício mata a sessão do Admin no meio, e antes o dono nunca recebia o fim da história. Se a
mensagem não chegar em 1 minuto, leia o resumo mesmo assim e conte; o log do roteiro que reinicia fica
no fim do `dgclaw-atualizar-<data>.log`.

Nunca reinicie o Admin com `systemctl restart dgclaw-admin` de dentro do chat dele. O caminho certo é o do
comando, que usa `systemd-run` e o roteiro `lib/reiniciar-admin.sh` (reinicia, espera o Admin responder em
`127.0.0.1:4300` e entrega a mensagem; o token é lido de `/etc/dgclaw/runner/admin.token` dentro do
roteiro e nunca aparece em log nem na linha de comando).

## Voltar atrás

O resumo da atualização termina com o comando exato. Para voltar:

```bash
sudo dgclaw atualizar --voltar /var/backups/dgclaw/<AAAAMMDD-HHMMSS> --segundo-plano
```

Simule antes com `--simular`. O que ele faz:

1. Confere o backup (o `MANIFESTO.txt`, o commit e que os tar abrem) e que o clone está limpo.
2. Faz **um backup do estado de agora** (para desfazer o desfazer).
3. Cria no clone a branch `dgclaw-volta-<data>` no commit do manifesto (a branch de antes continua lá, nada
   é apagado).
4. Restaura `/etc/dgclaw` e `/opt/dgclaw/admin` do backup, por cima. Não toca em `/var/lib/dgclaw` (as casas
   dos agentes ficam como estão) nem na conversa do Admin.
5. Reinstala, reconstrói a imagem, recria os containers, confere e reinicia o Admin.

Se existirem agentes criados **depois** do backup, o comando para e lista quais: restaurar o
`agentes.json` os tiraria do painel (as pastas ficam). Se o dono quer voltar mesmo assim, use
`--mesmo-assim`; senão escolha um backup mais recente.

Para atualizar de novo depois de voltar, volte o clone para a branch principal (`cd <clone> && git switch
main`) e rode `dgclaw atualizar`.

## O que dizer ao dono em cada etapa

Frases curtas e sem jargão. Container vira "a caixa do agente".

- **Início**: "Vou atualizar o DG Claw. Primeiro faço uma cópia de segurança de tudo o que é seu, depois
  instalo a versão nova. Leva de 10 a 30 minutos."
- **Clone com alteração**: "Achei uma alteração local nos arquivos do programa. Posso guardá-la de lado e
  seguir? Nada se perde." (só continue com `--forcar-local` depois do sim)
- **Backup**: "A cópia de segurança está pronta (tantos GB). Se algo der errado, eu volto ao que era."
- **Baixando e instalando**: "Baixei a versão nova e estou instalando. Suas chaves, senha e conversas não
  são mexidas."
- **Imagem**: "Agora estou preparando a base nova dos agentes. É o passo mais demorado."
- **Agentes**: "Estou trocando a caixa de cada agente pela nova. Cada um fica fora do ar por cerca de um
  minuto; a memória, o cofre e as rotinas ficam como estão."
- **Conferência**: "Conferi que tudo o que existia antes continua igual e que cada agente responde."
- **Fim**: "Atualizei: da versão X para a Y. A cópia de segurança fica guardada em <pasta>. Vou reiniciar o
  meu serviço agora; se o chat parar, espere uns 20 segundos e recarregue a página."
- **Problema**: "Parei no meio por causa de <causa em uma frase>. Seus dados estão salvos. Vou <o que fará>.
  Se preferir, volto à versão de antes."
