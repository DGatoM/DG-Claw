# Assinatura das versões do DG Claw

O `dgclaw atualizar` baixa código do GitHub e roda o `install.sh` dele como root. Sem conferência, quem
controlasse o repositório (ou o clone) executaria código como root em todos os servidores. Por isso a
atualização só instala uma **versão assinada**: uma tag `vX.Y.Z` com assinatura SSH feita pela chave do
projeto.

## Como a conferência funciona

- A chave pública do projeto fica em `seguranca/assinatura/allowed_signers`.
- A chave que vale na conferência é a do código **que já está instalado** (o `HEAD` do clone antes de baixar
  nada), nunca a da versão nova. Um atacante que controla o repositório troca o arquivo de chaves junto com o
  código; por isso a versão nova só é aceita se for assinada pela chave que já estava lá.
- A atualização instala a **tag assinada mais nova** (e não mais a ponta da `main`). Tag sem assinatura, tag
  leve, tag assinada por outra chave e tag que continua de outro histórico são recusadas, com a mensagem
  dizendo o que fazer. Não existe opção para pular a conferência.
- Troca de chave: a versão que traz a chave nova vem assinada pela chave antiga. Uma versão assinada não pode
  remover o arquivo de chaves.
- O `git` roda neutralizado na conferência (sem configuração global ou de sistema, sem hooks, com o
  `ssh-keygen` e o arquivo de chaves fixados na linha de comando), e antes de rodar o instalador o comando
  confere de novo que a tag não mudou e que o clone está exatamente no commit assinado.
- `--sem-baixar` não baixa nem confere nada: roda o instalador com o clone como está. É para quem atualizou o
  clone à mão e sabe o que fez.

## Primeira adoção (quem ainda não tem a chave)

A instalação que ainda não tem o arquivo de chaves não tem como conferir a versão que traz a chave. Esse é o
único momento sem verificação. O comando mostra a **impressão digital** (`SHA256:...`) da chave que passa a
valer. Confira com a impressão digital que o Danilo divulgou **fora do repositório** (aula, site ou mensagem
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
