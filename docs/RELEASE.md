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

1. **Confira o CHANGELOG.** A seção `## [Não lançado]` precisa descrever o que mudou, em português
   técnico e falando com a pessoa dona do DG Claw (o `tests/changelog` confere). Se algo exige passo
   manual na atualização, a subseção `### Como atualizar` tem que estar lá.
2. **Ensaie.** `scripts/subir-versao.sh --simular <patch|minor|major>` mostra o que mudaria, sem alterar nada.
3. **Suba a versão.** `scripts/subir-versao.sh <patch|minor|major>`. O script grava o número novo em `VERSION`,
   em `runner/package.json`, `panel/package.json` e `runner/package-lock.json`, e no CHANGELOG move o conteúdo
   de `[Não lançado]` para `## [X.Y.Z] - AAAA-MM-DD`, deixando `[Não lançado]` vazio. Ele recusa se
   `[Não lançado]` estiver vazio ou se a versão ou a tag já existirem. Recusa link simbólico e árvore suja. Grava tudo ou nada. Não faz commit, tag nem push.
4. **Commit e PR.** Em uma branch `release/vX.Y.Z`, adicione só os cinco arquivos da release
   (`git add VERSION CHANGELOG.md runner/package.json panel/package.json runner/package-lock.json`), confira
   com `git diff --cached` e faça o commit. O script recusa rodar com a árvore ou o índice sujos (com
   `--simular` só avisa). Abra o PR, siga a revisão de [REVISAO-ADVERSARIAL.md](REVISAO-ADVERSARIAL.md) e
   espere o ok do dono do projeto. Nenhum agente faz o merge sozinho.
5. **Tag anotada no SHA do merge aprovado**, não no HEAD da `main` (que pode ter andado depois do merge):
   `SHA=$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid)`, depois `git show $SHA:VERSION` (tem que
   ser X.Y.Z) e `git tag -a vX.Y.Z $SHA -m "DG Claw X.Y.Z"`.
6. **Publique a tag:** `git push origin vX.Y.Z`.
7. **Release no GitHub:** confira que a tag chegou (`git ls-remote origin refs/tags/vX.Y.Z` lista uma linha) e
   rode `gh release create vX.Y.Z --verify-tag --title "DG Claw X.Y.Z" --notes-file <arquivo>`. As notas
   saem do CHANGELOG da versão, em português técnico, sem frase de efeito.

O teste `tests/versao` confere que `VERSION`, as versões dos `package.json` do runner e do painel, o lock do
runner e o primeiro cabeçalho lançado do CHANGELOG dizem o mesmo número. O `package.json` da raiz (só o lint,
`0.0.0`) e o de `canais/whatsapp` (sem campo de versão) não seguem o número do produto.

## Assinatura da tag

Hoje a tag é **anotada** (`git tag -a`). Quando a conferência de tag assinada (PR #130, com o
`docs/ASSINATURA.md`) entrar na `main`, a tag passa a ser assinada com a chave SSH do projeto
(`git tag -s vX.Y.Z -m "DG Claw X.Y.Z"`), e **sem a chave não se publica**: não crie a tag de outro jeito
para contornar. Até lá, siga o passo 5 como está.

## Por que o aviso às vezes mostra o commit

O aviso de versão nova (terminal, recado ao Admin e faixa do painel) compara a versão instalada com a
publicada. Se os números são diferentes, mostra só eles ("1.0.0 -> 1.1.0"). Se são iguais, o número sozinho
não diria nada, e o aviso mostra o commit curto (7 caracteres) dos dois lados ("1.0.0 (abc1234) -> 1.0.0
(def5678)"). Isso acontece quando a `main` ganhou mudanças depois da última release. Sem número de versão,
aparece só o commit.
