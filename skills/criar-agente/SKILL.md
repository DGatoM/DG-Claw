---
name: criar-agente
description: Conduz o Admin do DG Claw na criação de um agente novo, em conversa com o dono, uma pergunta por vez, até o teste real. Usada quando o dono diz "cria um agente", "quero um agente novo", "faz um agente pra mim", "cria um agente novo pra mim", na primeira conversa depois da instalação e ao receber o recado de primeiro boot (envelope plataforma com recado="primeiro-boot").
---

# Criar um agente

Esta skill é o roteiro do Admin para criar um agente de trabalho. A conversa tem dez passos, com uma
pergunta por vez, e termina com o agente respondendo de verdade. O dono não vê o terminal: toda fala
sai pela ferramenta `mcp__dgchat__reply`, no chat `c_admin`. As mensagens são curtas e sem jargão
("caixa separada" no lugar de container; porta, uid e runner não aparecem).

Princípios da conversa:

- Uma pergunta por vez. Só a pergunta do passo atual aparece.
- O caminho rápido é o único visível. Opções avançadas (modelo específico, chave de API) só entram se
  o dono pedir.
- Detectar em vez de perguntar: o que o Admin consegue descobrir sozinho, ele descobre.
- O agente só é dado como pronto depois que respondeu a um "oi" de verdade.

## O recado de primeiro boot

Se a conversa começou pelo recado `<plataforma recado="primeiro-boot">` (vem da instalação, não do
dono), o Admin manda a mensagem de abertura e espera a resposta:

> Oi! Eu sou o Admin do seu DG Claw. Cuido da máquina e crio os seus agentes, cada um na sua própria
> caixa, separado dos outros. Vamos criar o primeiro? Me conta: pra que você quer ele?

Se o dono pediu um agente novo por conta própria, a conversa começa direto no passo 1.

## Os dez passos

### 1. Para quê

Pergunta: "Pra que você quer esse agente?" A resposta é livre ("me ajudar com Instagram",
"secretária"). O Admin resume o papel em uma linha e segue. Esse texto vai em `--papel`.

### 2. Nome

"Que nome ele vai ter?" O Admin sugere três que combinam com o papel. Com o nome escolhido, gera o
**slug**: minúsculas, sem acento, espaços e símbolos viram hífen (por exemplo "Sofia Pires" vira
`sofia-pires`). O slug não aparece para o dono, a menos que ele pergunte. Se já existir um agente com
esse slug (`dgclaw agente listar`), o Admin pede outro nome.

### 3. Jeito

"Como ele fala com você: mais formal, descontraído, direto?" e depois "Como ele te chama?". O jeito
vai em `--jeito` e o nome do dono em `--dono`.

### 4. Cérebro (provedor)

O Admin detecta em vez de perguntar o que já sabe:

```
jq -r '.agentes[]|select(.slug=="admin")|.provedor' /etc/dgclaw/agentes.json
```

O resultado é `claude` ou `codex`. A pergunta fica assim: "Este servidor usa o Claude na sua assinatura
(ou o Codex, conforme o resultado). Seu agente usa o mesmo?" O padrão é o mesmo do Admin, na
assinatura. Se o dono quiser o outro provedor ou uma chave de API, o Admin anota e usa `--provedor` e
`--auth` (`assinatura` ou `api`). Uma chave de API nunca é digitada no chat: o Admin diz que ela
é colocada depois, no cofre do painel do agente.

### 5. Canal

"Por onde você quer falar com ele? Aqui no chat do DG Claw (o mais simples para começar), no Telegram
ou no WhatsApp?" Valores de `--canal`: `chat`, `telegram`, `whatsapp`. Telegram e WhatsApp não são
ligados pelo Admin: ele anota a escolha e explica que, depois de criado, basta pedir ao próprio agente
("quero falar com você no Telegram"), que conduz a ligação.

### 6. Resumo e confirmação

O Admin mostra o que vai criar, em 5 linhas, e pergunta "Posso criar?":

```
Nome: Sofia
Para quê: secretária, organiza agenda e lembretes
Jeito: descontraído, te chama de Ana
Cérebro: Claude, na sua assinatura
Canal: chat do DG Claw
```

Sem um "sim" do dono, nada é criado. Se ele corrigir algo, o Admin ajusta e mostra o resumo de novo.

### 7. Criação

Antes de criar, o Admin confere a imagem dos agentes:

```
dgclaw imagem status
```

Se a imagem ainda está sendo construída, o Admin explica em uma frase ("a caixa dos agentes ainda
está sendo preparada, leva alguns minutos") e confere de novo a cada minuto ou dois, avisando o dono
só quando muda alguma coisa. Se a construção falhou, o Admin conta a causa em linguagem simples e roda
`dgclaw imagem construir`.

Com a imagem pronta:

```
dgclaw agente criar <slug> --nome "<Nome>" --provedor <claude|codex> --auth <assinatura|api> \
  --papel "<papel>" --jeito "<jeito>" --dono "<nome do dono>" --canal <chat|telegram|whatsapp>
```

Enquanto roda, o Admin conta o andamento em frases curtas ("preparando a caixa do Sofia", "ligando o
Sofia"), sem repetir a saída do comando. O detalhe dos parâmetros e das mensagens de erro está em
`referencia.md`.

### 8. Login do agente

Cada agente entra na conta do dono por conta própria. O Admin explica em uma frase: "Falta o {nome}
entrar na sua conta do Claude (ou do Codex): abra o painel dele pelo menu aqui em cima, clique em
Entrar com a assinatura e siga o passo a passo na tela." Depois espera o dono dizer que entrou. Nada
de senha ou código passa pelo chat do Admin.

### 9. Teste real

O Admin descobre a porta e o arquivo do token do agente no registro, sem mostrar nenhum dos dois ao
dono:

```
jq -r '.agentes[]|select(.slug=="<slug>")|"\(.runner) \(.runner_token_arquivo)"' /etc/dgclaw/agentes.json
```

Manda um "oi" ao agente novo. O token é lido de um arquivo e o cabeçalho também passa por arquivo, para
que o token nunca apareça na linha de comando nem na lista de processos:

```
umask 077
cab=$(mktemp)
printf 'Authorization: Bearer %s\n' "$(cat <runner_token_arquivo>)" > "$cab"
curl -sS -H @"$cab" -H 'Content-Type: application/json' \
  -d '{"text":"oi, acabei de te criar. Diz um oi pra mim.","submit":true}' \
  <runner>/api/agents/<slug>/input
```

Depois lê a resposta (esperando alguns segundos e repetindo se vier vazia):

```
curl -sS -H @"$cab" <runner>/api/agents/<slug>/conversation
rm -f "$cab"
```

Se o agente respondeu, o Admin mostra a resposta ao dono. Se não respondeu em cerca de um minuto, o
Admin roda `dgclaw agente reiniciar <slug>`, tenta de novo uma vez e, persistindo, conta ao dono o que
viu e o que vai fazer. O Admin só diz que terminou depois de uma resposta de verdade.

### 10. Entrega

"Pronto! O {nome} já aparece no menu, lá em cima à esquerda. Clica nele e dá um oi."

Se a escolha foi Telegram ou WhatsApp, acrescenta: "Lá, peça a ele: quero falar com você no Telegram."
(ou WhatsApp).

## Quando algo dá errado

O Admin explica a causa em linguagem simples, diz o que vai tentar e tenta. Exemplos: se a memória do
servidor acabou, "o servidor ficou sem memória para ligar mais um agente, vou conferir o que dá para
liberar"; se o login do dono expirou, "a sua conta precisa entrar de novo". Erros que não se resolvem
em duas tentativas viram uma mensagem ao dono com o que foi tentado e o que ele pode fazer (por
exemplo, abrir o Claude do painel da hospedagem). Tentar de novo é seguro: criar um agente que já
existe não duplica nada.

## Criar outro agente depois

É a mesma conversa. O passo 4 já parte do que foi escolhido antes, e o Admin pode propor "o mesmo
cérebro do {nome anterior}".
