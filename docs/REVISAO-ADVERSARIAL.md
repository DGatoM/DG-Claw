# Revisão adversarial de segurança

O DG Claw roda na VPS de gente que não é programadora, com um Admin que tem acesso de root e agentes
que conversam com o mundo. Uma falha aqui expõe o servidor, as chaves e as conversas de quem confiou
no projeto. Por isso nenhuma mudança entra na `main` sem passar por três etapas: feita, testada e
revisada por um revisor que procura ativamente como quebrá-la.

## A regra

1. **Feita e testada.** A mudança vem com teste (`tests/rodar.sh` verde) e foi conferida rodando de
   verdade, não só lida. Quem fez diz no PR como conferiu.
2. **Revisada pelo Codex, em modo adversarial, antes do merge.** Todo PR, sem exceção (inclusive os
   só de documentação, porque doc errada também ensina a fazer coisa insegura), passa pela revisão
   adversarial do Codex (Codex CLI da OpenAI, rodando `codex exec` em sandbox só de leitura na pasta
   do repositório) com o roteiro abaixo. Um modelo diferente do que escreveu o código enxerga o que o
   autor não vê.
3. **As correções voltam para o Codex até sair limpo.** Cada ponto apontado é corrigido (com teste,
   quando couber) ou recusado com justificativa escrita. Depois de corrigir, a revisão roda de novo,
   na mesma conversa com o Codex, até o veredito `LIMPO` ou até sobrar só o que foi recusado com
   justificativa.
4. **O corpo do PR registra a revisão.** Seção "Revisão adversarial (Codex)" com: quantas rodadas, o
   commit revisado em cada uma, o que ele apontou (severidade, arquivo, problema em uma frase), o que foi feito com cada ponto
   (corrigido em qual commit, ou recusado e por quê) e o veredito final. Sem segredo, sem dado
   pessoal e sem caminho da máquina de quem revisou.
5. **Merge só com o ok do dono do projeto.** Revisão limpa é condição necessária, não autorização, e
   vale só para o commit revisado: commit novo depois do `LIMPO` pede rodada nova.
   Ninguém (pessoa ou agente) faz merge por conta própria.

## O que o revisor procura

Em ordem de prioridade:

- **Injeção:** de shell e de comando (variável sem aspas, `eval`, `source` de arquivo que alguém de fora
  escreve, `bash -c` com texto do usuário), de SQL, e de prompt que chegue ao Admin (texto de fora,
  como e-mail, página, CHANGELOG ou mensagem de canal, entrando no contexto de quem tem root).
- **Exposição de segredo:** chave ou token em argv (o `ps` mostra), em log, em resposta HTTP, em
  mensagem de erro, no repositório, ou em arquivo com permissão aberta demais.
- **Permissão:** arquivo, pasta ou serviço com dono ou modo errado; agente em container alcançando o
  host ou o vizinho; `sudo` amplo; unidade systemd sem endurecimento quando lida com dado de fora.
- **Rota sem autenticação:** rota HTTP nova sem sessão, sem checagem de origem nas que mudam estado,
  ou liberada para a caixa dos agentes sem precisar.
- **Path traversal e symlink:** nome de arquivo, slug ou caminho vindo de fora usado sem validação.
- **Execução de coisa baixada:** script, binário ou pacote baixado e executado sem conferir a origem e
  a integridade.
- **Dados sensíveis:** dado pessoal, e-mail, telefone, conversa ou credencial em teste, exemplo,
  documentação ou log.
- **XSS no painel:** texto vindo de fora inserido no HTML sem escape.
- **Estado inseguro depois de uma falha:** erro engolido, valor padrão silencioso, corrida em arquivo de
  estado, atualização que para no meio e deixa algo aberto.

Depois disso, bugs graves de correção.

## Como rodar

Quem mantém o projeto roda a revisão na própria máquina, com o Codex CLI logado, a partir de um clone
na `main`:

```bash
scripts/revisao-adversarial.sh <número-do-pr>
```

O script existe para que o próprio processo de revisão não seja uma brecha:

- **Nada que vem do PR entra num comando.** Só o número do PR (validado como dígitos) e dois SHAs
  (validados como 40 caracteres hexadecimais). Nome de branch nunca é interpolado em shell ou `sed`.
- **O roteiro vem da `main`, não do PR.** A pergunta é lida de `docs/revisao-adversarial-prompt.txt`
  na `main`, então um PR não consegue reescrever as instruções do revisor.
- **O Codex roda numa cópia isolada da `main`,** em sandbox só de leitura. O `AGENTS.md` que ele carrega
  sozinho é o da `main`; a versão do PR ele lê com `git show <sha>:<caminho>`, como dado em revisão.
- **Base e PR ficam fixados por SHA.** A resposta começa com `COMMIT REVISADO: <sha>`.

Com `--so-preparar`, o script só monta a cópia e a pergunta e diz onde estão, para rodar o revisor
por outro caminho (por exemplo, uma ponte local para o Codex).

Para a rodada seguinte, depois de enviar as correções, rode o script de novo: ele pega o commit novo do
PR. Diga ao Codex, no fim da pergunta, o que foi feito com cada ponto da rodada anterior.

**O aceite vale para um commit.** O registro no PR traz o `COMMIT REVISADO` da rodada limpa. Antes do
merge, o último commit do PR tem que ser esse mesmo; se entrou commit depois do `LIMPO`, a revisão
roda de novo.

O roteiro pede a resposta em português, com veredito (`LIMPO`, `AJUSTES` ou `BLOQUEANTE`) e uma lista
numerada com severidade, arquivo e linha, o problema, o cenário concreto de ataque e a correção.

## Quem contribui de fora

Você não precisa ter o Codex. Abra o PR normalmente: quem mantém roda a revisão e comenta no PR o que
ele apontou. Se você tem o Codex CLI, rodar o roteiro antes de abrir o PR acelera tudo; nesse caso,
rode `scripts/revisao-adversarial.sh <número>` depois de abrir o PR e cole o resultado na seção "Revisão adversarial (Codex)" do PR.
