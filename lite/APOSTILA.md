# Apostila — Imersão Super Funcionário com Claude

**Seu agente pessoal, com nome e memória, rodando no seu computador e
conversando com você pelo Telegram.**

Esta apostila tem duas partes: o **passo a passo oficial** da instalação, escrito
para você refazer no seu ritmo, e o **perguntão** — as dúvidas que apareceram na
aula, numeradas e respondidas uma a uma.

Nada aqui tem pressa. O passo a passo funciona igual hoje, amanhã ou daqui a um
mês, com a gravação da aula ao lado.

---

# PARTE 1 — O PASSO A PASSO OFICIAL

## Antes de começar: o que você precisa ter

| Item | Precisa? | Observação |
|---|---|---|
| **Assinatura Claude Pro ou Max** | Sim | O plano grátis não abre o Claude Code. |
| **Claude Desktop** (app) ou terminal | Sim | https://claude.com/claude-code |
| **Telegram** | Sim, é o entregável | É por ele que você fala com seu agente do celular. Dá para usar só pelo computador, mas o Telegram é o caminho da aula. |
| **Bun** | Sim, para o Telegram | O canal do Telegram roda nele. O instalador confere e ajuda a instalar. |
| Node, Python, Git | Não | Não são necessários para o agente. |

> **Dica que economiza dor de cabeça:** use o modelo **Opus 5** e deixe a
> aprovação de ações no **modo automático**. Quem fez assim na aula instalou
> quase sempre de primeira; no modo manual você precisa aprovar cada passo.

## O caminho, do zero ao agente falando

```
1. Claude Desktop  →  aba "Claude Code"
2. Criar a pasta do seu agente (ex.: Documentos\MeuAgente)
3. No Claude Desktop, selecionar essa pasta
4. Baixar o pacote DG Claw (o .zip da plataforma)
5. Na aba Claude Code, colar o PROMPT 1 (abaixo)
6. Colar o PROMPT 2 (abaixo)
7. Seguir o instalador, respondendo o que ele perguntar
8. Na hora do Telegram: BotFather → /newbot → nome → copiar o token
9. Colar o token no Claude
10. Seguir o resto das instruções até o teste final
```

### PROMPT 1 — traz o pacote e começa a instalação

> Vá até a pasta de downloads, pegue o zip que eu acabei de baixar — é um
> plugin chamado DG Claw —, traga pra cá e instale seguindo a skill de setup.

### PROMPT 2 — garante o caminho fácil

> tem uma opção de skill pra você fazer manualmente o mesmo que o setup faria,
> quero que você use ela

**Por que esses dois prompts?** O pacote é uma **skill** — um manual de
instruções que o próprio Claude lê e executa. Ele não precisa "instalar" nada no
sistema, nem rodar comandos especiais. Se o seu Claude começar a pedir comandos
de barra (`/plugin ...`) ou falar em "CLI", é sinal de que ele pegou o caminho
difícil: mande o PROMPT 2 e ele volta para o caminho simples.

### O passo do Telegram

1. Abra o BotFather: https://web.telegram.org/k/#@BotFather
2. Mande `/newbot`
3. Dê um **nome** ao bot (pode ser o nome do seu agente)
4. Dê um **@username** — precisa terminar em `bot` (ex.: `luna_da_ana_bot`)
5. Ele devolve um **token** (linha grande, tipo `123456789:AAH...`)
6. **Cole o token no Claude** e siga o que ele pedir
7. Mande uma mensagem qualquer para o seu bot no Telegram → chega um **código de
   pareamento** → o Claude aprova e **tranca** o bot só para você

### O comando da vida dele (guarde este!)

Toda vez que quiser acordar seu agente, abra o Prompt de Comando e cole **esta
linha única**:

```
cd /d "C:\caminho\da\pasta\do\agente" && claude --continue --channels plugin:telegram@claude-plugins-official
```

- `--continue` = retoma a MESMA conversa (é o que faz ele lembrar de tudo)
- `--channels ...` = liga o Telegram (sem isso o bot fica mudo)
- Só pelo computador, sem Telegram: `cd /d "C:\caminho" && claude --continue`

> **Não sabe abrir o Prompt de Comando?** Aperte a tecla **Windows**, digite
> `cmd`, aperte **Enter**. No Mac: **Cmd + Espaço**, digite `Terminal`, Enter.

---

# PARTE 2 — O PERGUNTÃO

## A. Assinatura, pré-requisitos e instalação do Claude

### O Claude precisa ser pago?

Sim. O agente roda em cima do **Claude Code**, que exige assinatura **Pro ou
Max**. O plano gratuito não abre o Claude Code.

### Preciso instalar Node, Python e Git?

**Não são obrigatórios** para o agente funcionar. Eles apareceram na aula porque
são úteis para outras coisas do Claude Code. O que o agente realmente precisa é:
Claude Code logado + o **bun** (para o canal do Telegram).

### Instalei o Python 3.13 / 3.14. Tem problema?

Não. Qualquer versão recente serve — e, de novo, ele não é obrigatório. Só um
cuidado: o site certo é **python.org** (não "phyton.org"). Se você caiu num
endereço estranho, feche e digite de novo.

### Apareceu "verificação humana" ou a tela sumiu na hora de assinar.

É o fluxo do site da Anthropic, não do agente. Recarregue a página e tente de
novo, de preferência em outro navegador ou numa aba anônima.

### Minha máquina é corporativa e a TI não deixa instalar nada. Consigo acompanhar?

Consegue acompanhar a aula, mas não vai conseguir criar o agente sem instalar o
Claude Code. Sugestão: faça a instalação depois, numa máquina pessoal, com a
gravação ao lado.

### Cheguei atrasado / não recebi as instruções. Onde está tudo?

Na plataforma **cpdf.ai**, no curso **Imersão Super Funcionário com Claude**, na
aula **Materiais Extras**: esta apostila, os slides e o pacote do agente.

## B. Onde exatamente eu rodo isso?

### Qual é o lugar certo para colar os prompts?

No **Claude Code**. Ele tem duas portas de entrada: o **app Claude Desktop, aba
"Claude Code"** (mais fácil para quem está começando), ou o **terminal** do
computador, digitando `claude`.

### Apareceu "/plugin isn't available in this environment".

Você está num chat comum do Claude (site ou app), **fora** do Claude Code. Os
comandos de barra só existem lá dentro. Abra a aba Claude Code (ou o terminal) e
refaça.

### Ele está pedindo o "Claude CLI". Preciso instalar mais alguma coisa?

Não. Isso acontece quando o assistente escolheu o caminho difícil (instalar como
plugin). Mande o **PROMPT 2** da Parte 1: ele passa a usar a skill e o problema
desaparece.

### "claude não é reconhecido como um comando interno ou externo".

O computador ainda não enxergou o programa recém-instalado. **Feche o terminal e
abra de novo.** Se continuar, reinicie o computador; se ainda assim persistir,
reinstale o Claude Code pelo site oficial.

### Dá para usar no VS Code?

Dá — o Claude Code funciona no VS Code. Para a imersão, recomendamos o app
Desktop ou o terminal, que é o caminho que a aula seguiu.

### Consigo fazer isso no ChatGPT, Gemini ou Antigravity?

Não. O agente é construído sobre o Claude Code especificamente. Outros
assistentes podem te ajudar a entender os passos, mas não substituem o motor.

## C. Instalando o DG Claw

### Meu Claude disse que o arquivo tem uma tentativa de manipulação e se recusou a instalar.

Foi uma **falha de interpretação**: o `INSTALAR.md` da versão distribuída no
começo da aula trazia um trecho de orientação escrito de um jeito que alguns
modelos leram como tentativa de manipulação, e por precaução recusaram. **Já foi
corrigido na versão nova do pacote (v0.5.0)**, que descreve o processo apenas
para você, humano. Se o seu Claude recusou, **baixe o pacote novo** na
plataforma e refaça com o PROMPT 1.

### Ele pede para eu colar três comandos e depois diz que não consegue rodar.

Caminho difícil de novo. Mande o **PROMPT 2**. A instalação pela skill não usa
comando de barra nenhum.

### Instalei pelo terminal / pelo CLI. Preciso refazer?

Não. Se o agente foi criado e funciona, está valendo. Os dois caminhos chegam ao
mesmo lugar.

### É seguro? O que esse pacote faz na minha máquina?

O pacote é um conjunto de **arquivos de texto** (instruções em Markdown). Ele não
instala programa, não roda serviço em segundo plano e não abre porta na sua
máquina. O que ele faz é dizer ao Claude como criar, na pasta que **você**
escolheu, os arquivos de identidade e memória do seu agente. Tudo fica visível e
editável por você — inclusive dá para abrir cada arquivo do zip antes de
instalar.

### Qual modelo devo usar?

**Opus 5** foi o que mais funcionou de primeira. O Sonnet 5 também funciona, mas
tende a travar mais em decisões de permissão. Para trocar, use o comando
`/model` dentro do Claude Code.

### Ele fica pedindo permissão para tudo.

Ligue o **modo de aprovação automática** no Claude Code. Sem isso, você precisa
autorizar cada leitura e cada escrita — funciona, mas é lento.

### Apareceu "Confiança no workspace necessária".

É o Claude Code perguntando se você confia na pasta que abriu. Como a pasta é
sua, confirme que confia e siga.

## D. Telegram: pareamento, bot mudo e alternativas

### O Telegram é obrigatório?

Ele é o **entregável da aula** — o que faz seu agente virar alguém com quem você
fala do celular, de qualquer lugar. Tecnicamente dá para usar só pelo computador
(conversando na janela do terminal), e tudo o mais funciona igual: personalidade,
memória, rotinas, áudio. Mas o caminho da imersão é o Telegram, e é ele que
entrega a experiência completa.

### Por que Telegram e não WhatsApp?

Porque o agente usa o **Channels**, um recurso nativo do Claude Code que conecta
a sessão a um aplicativo de mensagens. O Channels fala **nativamente com o
Telegram** — e **não existe WhatsApp** nessa lista. Ou seja: não é preferência
nossa, é o que o Claude oferece de fábrica. Fazer WhatsApp exigiria API oficial
paga (ou soluções não oficiais, que derrubam número), o que sai do escopo de uma
instalação simples.

### O bot fica "digitando..." e nunca responde.

Quase sempre são **duas sessões do mesmo bot rodando ao mesmo tempo** (duas
janelas abertas, ou uma sobrando de um teste anterior). Feche TODAS as janelas do
agente e abra **uma** só.

### O bot está completamente mudo, nem "digitando".

O motivo número 1 na aula foi a **falta do `bun`** — o canal do Telegram roda
nele e, sem ele, morre em silêncio, sem mensagem de erro. Instale:

- **Windows:** `winget install Oven-sh.Bun`
- **Mac/Linux:** `curl -fsSL https://bun.sh/install | bash`

E então **feche e reabra o terminal** antes de ligar o agente de novo. Esse
"feche e reabra" é obrigatório: é assim que o sistema enxerga um programa novo.

### Não chega o código de pareamento.

Confira, nesta ordem: (1) a janela do agente está aberta? (2) tem outra sessão
usando o mesmo bot? (3) mande `/start` para o bot; (4) tente pelo Telegram do
celular e também pelo Desktop.

### O BotFather não deixa criar bot ("cannot create new bots at this time").

É limite antispam do Telegram. Fale com **@SpamBot** para liberar, ou use um bot
que você já tenha criado antes.

### O Telegram pede um código por SMS e ele não chega.

Isso é o login do Telegram, não do agente. Use o app no celular (onde você já
está logado) em vez do Telegram Web.

### Meu notebook é Windows e meu celular é iPhone. Dá conflito?

Nenhum. O bot vive na internet; o sistema do seu celular é irrelevante.

### Posso ter mais de um agente? E mais de uma pessoa falando com ele?

Mais de um agente: sim, uma pasta para cada. Mais de uma pessoa: dá, mas por
padrão o bot é trancado **só para você** — liberar outra pessoa é uma decisão
consciente, feita depois.

## E. Depois de instalado: usar, desligar e religar

### Como eu ligo meu agente de novo amanhã?

Abra o Prompt de Comando e cole a **linha única** do fim da Parte 1 (com
`--continue`). Se você pediu o atalho, é só dar dois cliques nele.

### Como faço o atalho de dois cliques?

Peça ao seu próprio agente, na janela dele: *"cria um atalho na minha área de
trabalho pra te acordar"*. Ele escreve o arquivo para você.

### Fechei a janela. Perdi a conversa?

Não. Fechar a janela é o agente "dormindo". A memória e a conversa voltam com o
`--continue`.

### Mandei mensagem com o computador desligado e ele não respondeu.

Mensagem enviada com o agente desligado **se perde** (não existe fila). É só
reenviar quando ligar. Essa é justamente a diferença para a versão em servidor,
que fica ligada 24 horas.

### Ele "esqueceu" o que a gente conversou.

Você religou **sem** o `--continue`? É esse pedacinho que retoma a mesma conversa.
Se religou certo, peça: *"dá uma olhada no seu working-memory antes de
responder"*.

### Ele avisou que ia "organizar a memória" e sumiu alguns segundos.

Normal — é a compactação automática. Ele volta lembrando do essencial.

### Ele escuta áudio?

Sim, se você ligar. Dois caminhos: **Groq** (chave gratuita, em 2 minutos,
funciona em qualquer máquina) ou **local** (roda no seu computador, de graça, mas
pesado sem placa de vídeo). Peça: *"liga a transcrição de áudio"*.

### Ele acessa meu Gmail, Drive e Agenda?

Só se você conectar — e é você quem autoriza no navegador, com a sua conta. Peça:
*"conecta meu Google"*. Depois de autorizar, feche e reabra a janela do agente
para ele enxergar as ferramentas novas.

### Dá para ele fazer coisas sozinho, tipo um resumo todo dia às 8h?

Dá: peça em português mesmo, e ele cria a tarefa agendada. Regra de ouro: **só
roda com o computador ligado e a janela aberta**.

### Ele lembra de mim de verdade?

Sim. Ele anota o que importa em arquivos na **sua** pasta (`working-memory.md` e
a pasta `memoria/`), que você pode abrir e ler. De tempos em tempos ele pede
autorização para "arrumar a casa" e consolidar essas memórias.

## F. Segurança e privacidade

### Que acesso esse agente tem à minha máquina?

O mesmo que o Claude Code tem: os arquivos que você deixa ele ver e os comandos
que você aprova. Ele roda **na sua máquina, com o seu usuário** — nada é enviado
para servidores nossos.

### Ele fica exposto na internet?

Não. O bot do Telegram é seu, criado por você, e trancado para responder **só ao
seu** Telegram.

### Devo deixar tudo em aprovação automática? É arriscado?

O modo automático acelera muito e é o que recomendamos durante a instalação.
Depois, se preferir, volte ao modo manual para o dia a dia.

### Onde guardo tokens e senhas com segurança?

Em gerenciadores como **Bitwarden**, **1Password**, **NordPass** ou **Kaspersky
Password Manager**. Nunca cole senha ou token em chat público ou em grupo.

## G. Capacidades, comparações e próximos passos

### Esse agente é a mesma coisa que a Isa?

Não. Este é o **agente local**: personalidade, memória, Telegram e os arquivos do
seu computador. A Isa é uma construção muito maior, rodando 24 horas em servidor,
com poderes extras (Instagram, CRM, reuniões). O caminho natural é: local →
servidor.

### Qual a diferença para o Hermes e o OpenClaw?

O DG Claw nasceu **em cima da experiência dos dois** — o Danilo construiu com uma
ideia diferente: usar o **Claude nativo** em vez de criar uma camada pesada por
fora. Por isso ele não instala programa nenhum, não roda serviço próprio e não
quebra quando o Claude Code é atualizado. É uma camada fina sobre o que a
ferramenta já faz sozinha.

### Dá para rodar na VPS, 24 horas, sem meu computador ligado?

Dá — é a versão servidor. **Vai ter uma aula específica só sobre isso.** Vale
saber desde já: o agente da VPS é outro agente; ele não enxerga os arquivos do
seu computador local.

### Ele consegue mexer no meu ERP, clicando na tela como um humano?

É possível (automação de navegador e de tela), mas quase sempre existe um caminho
melhor, via integração. Não é assunto da aula de hoje.

### Posso usar esse pacote no agente que eu já tinha?

Pode. Ele adiciona identidade e memória a uma pasta — convive bem com o que você
já usa.

### Vai ter versão para WhatsApp?

É o pedido número 1 e está no radar. Hoje o caminho nativo do Claude é o
Telegram (veja a pergunta sobre Channels, no bloco D).

## H. Sobre a aula

### Vai ficar gravada?

Sim, para quem tem acesso com gravação: fica na plataforma **cpdf.ai** por 1 ano.

### Não comprei a gravação. Ainda dá?

Dá — é só falar com o suporte.

### Fui rápido demais e não consegui acompanhar.

O recado foi alto e claro no chat, e foi ouvido. Esta apostila existe exatamente
por isso: o passo a passo escrito, para você refazer no seu ritmo, com a gravação
ao lado. Nada do que foi feito ao vivo depende de estar ao vivo.

---

## Se travar em qualquer ponto

1. Abra o `TROUBLESHOOTING.md` criado dentro da pasta do seu agente — ele cobre
   os problemas mais comuns, em português e sem jargão.
2. Peça ao seu próprio Claude: *"roda seu diagnóstico"*. Ele confere a instalação
   e gera um relatório técnico (sem dados pessoais) que você pode enviar ao
   suporte.
3. Ainda travado? Fale com o suporte da plataforma com o print do que apareceu na
   tela.
