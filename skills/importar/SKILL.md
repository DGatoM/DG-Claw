---
name: importar
description: Recebe na VPS a MUDANCA de um agente que rodava no computador da pessoa (DG Claw Lite), pescando o arquivo cifrado pelo proprio bot de Telegram dela, mostrando o que veio e so entao escrevendo. Ative quando a pessoa colar uma linha comecando com MUDANCA, disser "trouxe meu agente do meu computador", "importar meu agente", "recebi o arquivo da mudanca", "meu agente estava no PC e quero por aqui", ou rodar /dgclaw:importar. Trabalha junto com a skill de setup: sem agente instalado ainda, ela guarda a mudanca e manda instalar primeiro.
user-invocable: true
---

# /dgclaw:importar, receber o agente que veio do computador

Do outro lado desta mudança, no computador da pessoa, a skill `/dgclaw-lite:mudar-pra-vps`
empacotou o agente inteiro (a pasta mais a memória nativa que fica fora dela) num arquivo cifrado e
mandou pelo bot de Telegram dela. Aqui você recebe.

Duas regras que valem a skill toda:

1. **Mostrar antes de escrever.** Nunca sobrescreva memória sem a pessoa ver o que vai entrar.
2. **Um bot, um processo.** Se o computador dela ainda estiver rodando o agente, o Telegram vai
   brigar entre os dois. Isso se confere antes, não depois.

## Mostre o progresso (OBRIGATÓRIO)

Lista de passos com **TaskCreate**, atualizada com **TaskUpdate** a cada etapa.

```
[ ] 1. Pegar a linha da mudanca e o token do bot
[ ] 2. Confirmar que o computador dela nao esta mais rodando o agente
[ ] 3. Pescar o arquivo e abrir num canto separado
[ ] 4. Mostrar o que veio
[ ] 5. Colocar cada coisa no lugar
[ ] 6. Conferir e fechar
```

## Passo 1, a linha e o token

A linha que ela traz tem a forma:

```
MUDANCA <file_id> <senha>
```

O `file_id` é o endereço do arquivo dentro do Telegram e a senha abre o cofre. Se ela só tiver o
arquivo (veio por pen drive, ou ela mesma anexou no chat), tudo bem: você precisa só da senha, e
pesca o arquivo de outro jeito no Passo 3.

**O token do bot.** O servidor precisa dele para falar com o Telegram:

- Se já existe um agente instalado aqui, o token está no `.env` da pasta de estado do canal dele
  (`<state dir>/telegram/.env`). Use esse, sem imprimir na tela.
- Se ainda não existe nada, peça a ela: **@BotFather** no Telegram, `/mybots`, escolhe o bot,
  `API Token`. É o **mesmo bot** de antes, e é por isso que a conversa dela continua de onde parou.

## Passo 2, o computador dela precisa estar quieto

Pergunte com todas as letras: **a janela do agente no computador foi fechada?** Se ela não tem
certeza, faça o teste: peça para ela mandar uma mensagem ao bot. Se **alguém responder**, o
computador ainda está no ar e precisa ser desligado antes de continuar. Bot mudo aqui é o esperado.

Não siga sem essa confirmação. Dois processos no mesmo bot é a causa número um de "instalei tudo e
o bot ficou mudo".

## Passo 3, pescar o arquivo

```
MUD="${CLAUDE_PLUGIN_ROOT}/scripts/mudanca.mjs"
ENTRADA="<pasta de mudancas>/$(date +%Y-%m-%d-%H%M%S)"

node "$MUD" baixar "<file_id>" "<token>" "$ENTRADA/mudanca.cofre"
```

Se ela não tem o `file_id` (ela mesma anexou o arquivo no chat), ache o último documento que chegou
no bot:
```
node "$MUD" achar "<token>"
```
Isso lista os documentos recentes com os respectivos `file_id`; escolha o que faz sentido pelo nome
e pelo tamanho, confirme com ela, e volte ao `baixar`.

Se o arquivo veio pela mão (pen drive, upload), pule esta parte: aponte direto para o caminho dele.

## Passo 4, mostrar o que veio

**Antes de escrever qualquer coisa**, abra só o índice:

```
node "$MUD" listar "$ENTRADA/mudanca.cofre" "<senha>"
```

Isso não escreve nada em lugar nenhum: só lê o cofre e mostra de onde veio, quando foi feito e a
lista de arquivos. Traduza para ela: "vieram N arquivos, o livro de memória com X assuntos, o
caderninho e a identidade dele". Se a senha estiver errada, o erro diz isso claramente; peça a linha
de novo (o traço faz parte da senha).

Depois abra num canto separado, que ainda não é a casa do agente:

```
node "$MUD" abrir "$ENTRADA/mudanca.cofre" "<senha>" "$ENTRADA/aberto"
```

Dentro de `$ENTRADA/aberto` você encontra `agente/` (a pasta como estava no computador dela) e, se
existir, `memoria-nativa/`.

## Passo 5, cada coisa no seu lugar

**Ainda não existe agente nesta VPS?** Então pare aqui e diga: primeiro a instalação, depois a
mudança. Rode `/dgclaw:setup` no modo servidor **avisando que existe uma mudança esperando em
`$ENTRADA/aberto`**. Na entrevista de identidade, em vez de inventar, leia o `CLAUDE.md` que veio de
lá: nome, jeito de falar e valores já estão escritos, e a pessoa só confirma. Volte para cá depois
que o agente estiver de pé.

**Já existe agente?** Faça a mudança arquivo por arquivo, mostrando cada decisão. O de lá é do
DG Claw Lite, o daqui é do DG Claw servidor, e os formatos não são iguais:

| Veio de lá | Vai para cá | Como |
|---|---|---|
| `agente/CLAUDE.md` | `IDENTITY.md`, `PERSONALITY.md`, `CREATOR.md` | leia e extraia: nome e ficha para o IDENTITY, jeito de falar e traços para o PERSONALITY (mantendo a tabela, senão o painel fica vazio), o que ele sabe sobre o dono para o CREATOR |
| `agente/working-memory.md` | `working-memory.md` | não sobrescreva: leve as pendências e os fatos abertos para as seções equivalentes daqui |
| `agente/memoria/*.md` | `memory/` | copie os arquivos de assunto como estão e acrescente uma linha por assunto no `MEMORY.md` daqui |
| `agente/memoria/MEMORY.md` | `MEMORY.md` | é o sumário do livro dele; funda com o sumário daqui, sem apagar o que já existe |
| `memoria-nativa/MEMORY.md` | `MEMORY.md` | normalmente é só um ponteiro; se tiver conteúdo de verdade, funda também |
| `agente/TROUBLESHOOTING.md` | nada | era socorro do computador dela, não vale mais aqui. Diga isso a ela |

Regras ao fundir:

- **Nunca apague o que já está aqui.** Fundir é somar; em caso de conflito, mostre os dois textos e
  pergunte.
- Faça uma cópia de segurança do arquivo antes de mexer (`cp arquivo arquivo.antes-da-mudanca`).
- Depois de mexer em identidade, materialize de novo e reinicie:
  ```
  bash "<ws>/.dgclaw/plugin/scripts/materialize-identity.sh" "<ws>"
  systemctl restart "dgclaw-<slug>.service"
  ```

## Passo 6, conferir e fechar

Três provas, na frente dela:

1. **Ele lembra.** Mande uma mensagem ao bot perguntando algo que só estava na memória antiga ("de
   que a gente falou sobre o Bidu?"). A resposta tem que vir com o fato certo.
2. **É o mesmo bot.** A conversa dela no Telegram continua na mesma tela de sempre, sem bot novo.
3. **Não depende mais do computador.** Peça para ela desligar ou fechar tudo no computador e mandar
   outra mensagem. Ele responde igual.

Feche dizendo onde ficou a cópia do que veio (`$ENTRADA`, que é backup e pode ser apagado quando ela
quiser), e que a pasta antiga no computador dela continua lá, intacta, como segunda cópia.
