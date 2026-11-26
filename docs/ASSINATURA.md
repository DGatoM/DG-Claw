# Assinatura das versões do DG Claw

O `dgclaw atualizar` baixa código do GitHub e roda o `install.sh` dele como root. Sem conferência, quem
controlasse o repositório (ou o clone) executaria código como root em todos os servidores. Por isso a
atualização só instala uma **versão assinada**: uma tag `vX.Y.Z` com assinatura SSH feita pela chave do
projeto.

## Como a conferência funciona

- A chave pública do projeto viaja em `seguranca/assinatura/allowed_signers`, mas **a chave que vale fica
  fora do clone**, em `/etc/dgclaw/assinatura/allowed_signers` (só o root grava). Ao lado dela ficam dois
  marcadores: `ativada` (a proteção já foi ligada nesta máquina) e `instalado` (o commit que foi instalado
  depois de conferido). Quem altera o clone não altera a chave que vale.
- A versão nova só é aceita se for assinada pela chave que **já estava gravada**. A chave do repositório só
  entra na máquina depois que a versão que a traz foi aceita e o instalador dela terminou com sucesso. Troca
  de chave: a versão que traz a chave nova vem assinada pela chave antiga.
- Só vale assinatura **SSH**. Tag assinada em outro formato (OpenPGP, X.509) é recusada, e um arquivo de chaves
  vazio, ilegível ou com linha `cert-authority` também.
- A atualização instala a **tag assinada mais nova** (e não mais a ponta da `main`). Tag sem assinatura, tag
  leve e tag assinada por outra chave são recusadas, com a mensagem dizendo o que fazer. Não existe opção
  para pular a conferência.
- Sem versão assinada mais nova, o que está no clone só é aceito se já tiver sido autenticado: é o commit
  gravado em `instalado`, ou o commit de uma tag assinada válida. Um clone com commit que ninguém assinou é
  recusado.
- Uma vez ativada, a proteção não volta para a adoção: se a chave gravada sumir ou ficar vazia, o comando
  recusa e pede a chave de fora.
- Personalizações (`dgclaw personalizar`): os commits do próprio dono ficam por cima da versão oficial. A
  conferência vale para a versão oficial; o clone precisa conter a versão assinada no histórico.
- O `git` roda neutralizado na conferência (sem configuração global ou de sistema, sem hooks, sem
  `gpg` e com o `ssh-keygen` e o arquivo de chaves fixados na linha de comando). Antes de rodar o instalador, o
  comando confere de novo que a tag não mudou, que o clone está exatamente no commit assinado e que nenhum
  arquivo rastreado difere dele (inclusive os escondidos com `skip-worktree`).
- A volta (`--voltar` e a volta automática) devolve o commit e o estado de assinatura do backup, e por isso
  não repete a conferência da atualização.
- `--sem-baixar` não baixa nem confere nada: roda o instalador com o clone como está. É para quem atualizou o
  clone à mão e sabe o que fez.

### O que esta proteção não cobre

- Quem já escreve como root na máquina (o clone fica na pasta do root) pode trocar a chave gravada ou usar
  `--sem-baixar`. A defesa é contra o repositório e o GitHub, não contra o root.
- O `install.sh` roda a partir do próprio clone (ele registra onde o DG Claw está instalado), e não de uma
  extração separada. A conferência de que o clone está exatamente no commit assinado cobre a troca de arquivo,
  mas arquivo novo não rastreado dentro do clone não é examinado.

## Primeira adoção (quem ainda não tem a chave)

A instalação que ainda não tem a chave gravada não tem como conferir a versão que traz a chave. Esse é o
único momento sem verificação. O comando mostra a **impressão digital** (`SHA256:...`) da chave que passa a
valer (e é gravada em `/etc/dgclaw/assinatura`, o que liga a proteção para sempre). Confira com a impressão digital que o Danilo divulgou **fora do repositório** (aula, site ou mensagem
direta). Se for diferente, interrompa ou volte com `sudo dgclaw atualizar --voltar <backup>`.

Quem quer evitar até esse momento recebe o arquivo `allowed_signers` por um canal de confiança e roda:

```bash
sudo dgclaw atualizar --exigir-assinatura --chave-assinatura /caminho/allowed_signers
```

Com `--exigir-assinatura` e sem chave, o comando recusa e não baixa nada.

## Passo a passo de quem mantém o projeto (uma vez)

Os comandos rodam no computador de quem assina; a chave **privada** nunca sai de lá e nunca vai para o repositório.

1. Gerar a chave de assinatura (use uma senha forte):
   `ssh-keygen -t ed25519 -C "DG Claw releases" -f ~/.ssh/dgclaw_assinatura`
2. Criar o arquivo de chaves do repositório, com a parte pública:
   `mkdir -p seguranca/assinatura && printf 'releases namespaces="git" %s\n' "$(cut -d' ' -f1,2 ~/.ssh/dgclaw_assinatura.pub)" > seguranca/assinatura/allowed_signers`
   e subir por PR como qualquer mudança.
3. Guardar a impressão digital (`ssh-keygen -lf ~/.ssh/dgclaw_assinatura.pub`) e divulgá-la **fora do repositório**
   (aula, site, mensagem direta), para a primeira adoção poder ser conferida.
4. Configurar o git para assinar com SSH:
   `git config gpg.format ssh` e `git config user.signingkey ~/.ssh/dgclaw_assinatura.pub`
5. A cada versão, depois do merge na `main`, criar e subir a tag **assinada**:
   `git tag -s vX.Y.Z -m "DG Claw X.Y.Z"` e `git push origin vX.Y.Z`
   (confira antes com `git -c gpg.ssh.allowedSignersFile=seguranca/assinatura/allowed_signers verify-tag vX.Y.Z`).
6. Opcional: adicionar a chave pública em *Settings > SSH and GPG keys > New SSH key > Signing Key* no GitHub, para
   a tag aparecer como "Verified" na página de releases.

A primeira versão com a chave (e o código que confere) deve ser a versão que o arquivo `allowed_signers` acompanha:
quem atualiza para ela cai na primeira adoção acima; as seguintes já são conferidas.

## Perda ou vazamento da chave privada

Gere uma chave nova e publique uma versão que a acrescente ao `allowed_signers`, **assinada pela chave antiga**
(se ela ainda for confiável). Se a chave antiga vazou, as instalações precisam receber o arquivo novo por fora
(`--chave-assinatura`), porque ninguém consegue distinguir a assinatura de quem a roubou.
