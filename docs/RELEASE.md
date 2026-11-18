# Lançar uma versão do DG Claw

Este documento é para quem mantém o repositório. Cada release sobe o número da versão, e a tag e a
release no GitHub saem do mesmo commit. Quem só usa o DG Claw não precisa dele: o roteiro da atualização
está em [ATUALIZAR.md](ATUALIZAR.md).

## Quando subir, e quanto

A versão segue o [Versionamento Semântico](https://semver.org/lang/pt-BR/) (`X.Y.Z`):

| Mudança | Nível | Exemplo |
| --- | --- | --- |
| Correção, sem recurso novo | `patch` | 1.0.0 -> 1.0.1 |
| Recurso novo, que não quebra o que já existe | `minor` | 1.0.1 -> 1.1.0 |
| Mudança que quebra (comando removido, formato de dado que exige migração) | `major` | 1.1.0 -> 2.0.0 |

## Passo a passo

### 1. No PR de release

Antes, confira o CHANGELOG: a seção `## [Não lançado]` precisa descrever o que mudou, em português técnico
e falando com a pessoa dona do DG Claw (o `tests/changelog` confere). Se algo exige passo manual na
atualização, a subseção `### Como atualizar` tem que estar lá.

Numa branch `release/vX.Y.Z`, a partir da `main` atualizada e com a árvore limpa, troque o número em cinco
arquivos. Nos comandos, `X.Y.Z` é a versão nova:

```bash
printf '%s\n' "X.Y.Z" > VERSION
jq --indent 2 --arg v "X.Y.Z" '.version = $v' runner/package.json > /tmp/runner-package.json && mv /tmp/runner-package.json runner/package.json
jq --indent 2 --arg v "X.Y.Z" '.version = $v' panel/package.json > /tmp/panel-package.json && mv /tmp/panel-package.json panel/package.json
jq --indent 2 --arg v "X.Y.Z" '.version = $v | .packages[""].version = $v' runner/package-lock.json > /tmp/runner-lock.json && mv /tmp/runner-lock.json runner/package-lock.json
```

No `CHANGELOG.md`, troque a linha `## [Não lançado]` por três linhas: `## [Não lançado]`, uma linha vazia e
`## [X.Y.Z] - AAAA-MM-DD` (a data de hoje). O que estava em Não lançado passa a ser da versão nova, e Não
lançado fica vazio.

Depois confira, adicione só esses cinco arquivos, olhe o que entra e faça o commit:

```bash
bash tests/versao/rodar.sh
git add VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json
git diff --cached
git commit -m "Versão X.Y.Z"
```

Abra o PR, siga a revisão de [REVISAO-ADVERSARIAL.md](REVISAO-ADVERSARIAL.md) e espere o ok do dono do
projeto. Nenhum agente faz o merge sozinho.

### 2. Depois do merge: a tag no SHA do merge

A tag vai no commit do merge aprovado, não no HEAD da `main` (que pode ter andado depois do merge):

```bash
SHA="$(gh pr view <n> --json mergeCommit,state -q 'select(.state=="MERGED").mergeCommit.oid')"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || echo "PARE: o PR não está mergeado ou o SHA não veio"
git fetch origin
git merge-base --is-ancestor "$SHA" origin/main && echo "está na main"
git cat-file -t "$SHA"            # tem que dizer: commit
git show "$SHA":VERSION           # tem que ser X.Y.Z
git tag -a vX.Y.Z "$SHA" -m "DG Claw X.Y.Z"
```

Se qualquer conferência falhar, pare e não crie a tag.

### 3. Publicar a tag e a release

```bash
git push origin vX.Y.Z
git ls-remote origin 'refs/tags/vX.Y.Z^{}'     # tem que ser igual a "$SHA"
gh release create vX.Y.Z --verify-tag --title "DG Claw X.Y.Z" --notes-file <arquivo>
```

As notas saem do CHANGELOG da versão, em português técnico, sem frase de efeito.

O teste `tests/versao` confere que `VERSION`, as versões dos `package.json` do runner e do painel, o lock do
runner e o primeiro cabeçalho lançado do CHANGELOG dizem o mesmo número. O `package.json` da raiz (só o lint,
`0.0.0`) e o de `canais/whatsapp` (sem campo de versão) não seguem o número do produto.

## Assinatura da tag

Hoje a tag é **anotada** (`git tag -a`). Quando a conferência de tag assinada (PR #130, com o
`docs/ASSINATURA.md`) entrar na `main`, a tag passa a ser assinada com a chave SSH do projeto
(`git tag -s vX.Y.Z "$SHA" -m "DG Claw X.Y.Z"`), e **sem a chave não se publica**: não crie a tag de outro
jeito para contornar. Até lá, siga o passo 2 como está.

## Por que o aviso às vezes mostra o commit

O aviso de versão nova (terminal, recado ao Admin e faixa do painel) compara a versão instalada com a
publicada. Se os números são diferentes, mostra só eles ("1.0.0 -> 1.1.0"). Se são iguais, o número sozinho
não diria nada, e o aviso mostra o commit curto (7 caracteres) dos dois lados ("1.0.0 (abc1234) -> 1.0.0
(def5678)"). Isso acontece quando a `main` ganhou mudanças depois da última release. Sem número de versão,
aparece só o commit.
