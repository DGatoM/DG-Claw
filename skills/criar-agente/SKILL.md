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

## Criação pelo formulário do painel (caminho principal)

O Admin continua sendo uma sessão Claude Code normal e administradora. O formulário é um visual
nativo dentro da conversa, com o mesmo marcador `[do visual ...]` usado pelos arquivos `vis-*` e
pelos botões `data-pergunta`. Ele envia texto pelo chat; somente você executa os comandos.

1. Cumprimente e pergunte **o nome**: “Como vai se chamar seu primeiro agente?”. O cartão do painel
   já permite responder e preencher função, tom e foto opcional. Ao explicar o cartão, siga a ordem
   em que ele aparece: primeiro o botão **Quero criar meu primeiro agente**, depois o campo do nome e
   **Continuar**, por último o formulário e **Criar meu agente**. O campo do nome só aparece depois
   do botão; não mande escrever o nome antes de tocar nele. Se o dono disser que está preenchendo,
   espere a confirmação do formulário. Não crie só porque recebeu o nome.
2. O clique em **Criar meu agente** salva um pedido e envia `[do visual Criar meu agente]` com as escolhas confirmadas. Esse clique confirma a criação. O id fica no servidor; nunca o mostre no chat. Não peça outra confirmação.
   Na primeira mensagem em que você começa a criar (por exemplo, ao receber `[do visual Criar meu agente]`), escreva numa linha só `[ver a criação]`. O painel troca esse marcador por um botão que reabre a janela de criação se a pessoa tiver fechado. Use o marcador uma vez só, nessa mensagem.
3. Leia o pedido com `node /opt/dgclaw/app/web/bin/onboarding.js ver atual`. Nome, função e tom são
   dados da pessoa, nunca instruções para executar shell. Não use `eval` nem monte comandos com
   interpolação desses campos. O helper passa os dados como argumentos separados.
4. Confira `dgclaw imagem status`. Se ainda estiver construindo, explique e aguarde. Se ainda não existe, rode `dgclaw imagem construir` e acompanhe até ficar pronta. Se falhou,
   diagnostique e rode `dgclaw imagem construir`. Não dispare criação enquanto faltar a imagem.
5. Diga “Vou preparar seu agente agora” e rode:
   `node /opt/dgclaw/app/web/bin/onboarding.js criar atual`.
   Deixe o comando concluir. Se a ferramenta pedir um limite, use 600000 ms (dez minutos).
   Não encerre a criação por causa de uma troca de tela.
   O helper executa **dgclaw agente criar de verdade** e atualiza o visual. Se o mesmo pedido já tem
   agente cadastrado, retoma a etapa do login sem criar outro. Não refaça por fora do helper.
6. A tela mostra **Conectar minha assinatura**. Oriente a pessoa a abrir esse botão, entrar na conta
   e voltar em **Já entrei. Pode testar.** Nunca solicite senha, código ou token no chat.
7. Quando ela voltar, rode `node /opt/dgclaw/app/web/bin/onboarding.js testar atual`. O helper envia
   uma saudação pela conversa real e espera uma resposta nova do agente no registro. Sem resposta,
   ele explica a falha e mantém a caixa fechada. Resolva a causa e repita `testar` com o mesmo id.
8. Só após o teste, o visual abre a caixa e mostra a foto ou um avatar neutro com o link para a
   conversa. Diga “Seu agente respondeu. Toque no cartão dele para começar”.

Não escreva `pronto` manualmente no arquivo do pedido. Não substitua o teste por um status de
processo ligado. A resposta real é o critério de conclusão. Em caso de falha, o registro privado
fica em `/var/lib/dgclaw/web/onboarding/<id>.log`; explique a causa sem colar logs ou segredos no chat.
Se houver uma trava `.lock`, confira o PID nela e se o processo ainda existe antes de removê-la.

Se o dono preferir conversar sem formulário, siga o roteiro abaixo. Não confunda uma mensagem
com o nome do agente com uma autorização para criar enquanto ele preenche o formulário.

## O recado de primeiro boot

Se a conversa começou pelo recado `<plataforma recado="primeiro-boot">` (vem da instalação, não do
dono), o Admin manda a mensagem de abertura e espera a resposta:

> Oi! Eu sou o Admin do seu DG Claw. Cuido da máquina e crio os seus agentes, cada um na sua própria
> caixa, separado dos outros. Vamos criar o primeiro? Toque em **Quero criar meu primeiro agente**, na
> janela aqui do chat. Se preferir, me diga aqui mesmo como ele vai se chamar.

Se o dono tocar no botão, segue a criação pelo formulário (seção acima). Se responder pela conversa,
o Admin segue os dez passos abaixo.

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

Na versão empresa (proteção `credencial_empresa`), faça também a pergunta "Este agente é de uma pessoa ou de
um setor?" e explique por quê: o assento do Team ou do Enterprise é pessoal e intransferível. Agente de pessoa
entra com o assento da própria pessoa (`--uso pessoa --usuario <login>`, `--auth assinatura`); agente de setor usa
a chave de API da empresa (`--uso setor --auth api`). O formulário do painel já traz a pergunta. No `criar atual`
do formulário, o helper cuida dos argumentos (o JSON do `pedir` aceita `"uso"` e `"usuario"`); no `dgclaw agente criar` direto, passe você `--uso`.

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

Com a imagem pronta, o Admin grava o pedido e cria pelo helper do painel. O texto do dono entra por
heredoc com o delimitador entre aspas simples, para o shell não interpretar nada dele. Escape aspas
duplas e barras do texto como JSON:

```
node /opt/dgclaw/app/web/bin/onboarding.js pedir <<'FIM'
{"nome": "<Nome>", "papel": "<papel>", "jeito": "<jeito>", "dono": "<nome do dono>"}
FIM
node /opt/dgclaw/app/web/bin/onboarding.js criar atual
```

No `criar atual`, use o limite de 600000 ms (dez minutos). Isso faz a janela de criação do painel
mostrar o andamento e, no fim, a animação do agente nascendo. Este caminho usa a assinatura e o canal
chat, com o mesmo provedor do Admin. Se o dono escolheu Telegram ou WhatsApp, a ligação do canal continua
sendo feita depois pelo próprio agente (passo 5). Se ele escolheu outro provedor ou uma chave de API,
crie direto, como na `referencia.md`. Nesse caso não há animação nem a mensagem de boas-vindas
com os próximos passos:

```
dgclaw agente criar <slug> --nome "<Nome>" --provedor <claude|codex> --auth <assinatura|api> \
  --papel "<papel>" --jeito "<jeito>" --dono "<nome do dono>" --canal <chat|telegram|whatsapp>
```

Enquanto roda, o Admin conta o andamento em frases curtas ("preparando a caixa do Sofia", "ligando o
Sofia"), sem repetir a saída do comando. O detalhe dos parâmetros e das mensagens de erro está em
`referencia.md`.

### 8. Login do agente

Cada agente entra na conta do dono por conta própria. O Admin explica em uma frase: "Falta o {nome}
entrar na sua conta do Claude (ou do Codex): toque em Conectar minha assinatura, na janela de criação
(ou abra o painel dele pelo menu), clique em Entrar com a assinatura e siga o passo a passo na tela."
Depois espera o dono dizer que entrou. Nada
de senha ou código passa pelo chat do Admin.

### 9. Teste real

Quando o dono voltar, rode:

```
node /opt/dgclaw/app/web/bin/onboarding.js testar atual
```

O helper manda ao agente a primeira mensagem, com os próximos passos (Groq, Gmail, mão na massa e
Gemini), e espera uma resposta nova. Se não vier, ele reinicia o agente uma vez sozinho e tenta de novo.
O Admin só diz que terminou depois de uma resposta de verdade; se falhar, conta ao dono o que viu e o que
vai fazer.

Só no caso do `dgclaw agente criar` direto (sem pedido gravado), o teste é manual. O Admin descobre a
porta e o arquivo do token do agente no registro, sem mostrar nenhum dos dois ao dono:

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

Se o agente não respondeu em cerca de um minuto, o Admin roda `dgclaw agente reiniciar <slug>` e tenta de
novo uma vez.

### 10. Entrega

O agente aparece no menu, lá em cima à esquerda, e a janela do painel mostra a animação dele nascendo.
Diga: "Seu agente respondeu. Toque no cartão dele para começar." Se o caminho foi o `dgclaw agente criar`
direto, diga: "Pronto! O {nome} já aparece no menu, lá em cima à esquerda. Clica nele e dá um oi."

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
