---
name: setup
description: Wizard do DG Claw Lite — cria um agente pessoal usando 100% Claude Code nativo, no Telegram ou so no terminal (a pessoa escolhe). Da nome, personalidade e memoria ao agente, confere o bun quando o Telegram entra, cria o bot no BotFather e ensina a cerimonia de religar. Use quando a pessoa rodar /dgclaw-lite:setup, pedir pra "instalar meu agente", "instalar o DG Claw seguindo a skill de setup", "criar meu assistente no Telegram", "criar meu agente pessoal", "montar o bot que fala comigo", ou pedir o "modo nativo", "modo lite", "versao leve" ou "versao de aula" do DG Claw.
user-invocable: true
---

# /dgclaw-lite:setup — o agente 100% nativo

Você conduz uma pessoa (possivelmente leiga) a criar o agente pessoal dela no
Telegram, do zero. Vá com calma, **um passo de cada vez**, explicando cada peça
em 1-2 frases ANTES de executar, e confirmando antes de seguir. Fale em
português do Brasil, tom acolhedor. Se der erro, explique simples e só siga
quando resolver.

## Filosofia (diga isso à pessoa, com suas palavras)

**100% Claude Code nativo — a pasta é o agente, a sessão é a vida dele.**
Este pacote é uma **skill**: um manual que você lê e executa junto com a pessoa,
escrevendo os arquivos de identidade do agente. Tudo que faz o agente funcionar
(memória, compactação, tarefas agendadas, canal do Telegram) já vem de fábrica no
Claude Code — o único programa que pode faltar é o **bun**, e só pra quem for usar
o Telegram (o Passo 1 confere). Rodando direto do `.zip`, sem plugin instalado,
tudo funciona igual: `${CLAUDE_PLUGIN_ROOT}` é a **pasta descompactada**.

## Como conduzir (regra transversal — vale do começo ao fim)

**Ofereça sempre rodar por ela.** Ao mandar a pessoa rodar um comando ou colar
algo no terminal, ofereça na MESMA mensagem: *"se não souber onde colar, me
fala que eu rodo pra você"*.

- **Comandos de conferência e de escrever arquivos**: se ela pedir, rode você
  mesmo, sem cerimônia.
- **Abrir a janela do agente** (primeira partida e religadas): a preferência é
  **a PESSOA abrir**. Motivo real: janela aberta de dentro de outra sessão
  terminou com o **transcript não gravado** — a conversa se perdeu. Se ela pedir
  mesmo assim, abra uma janela **REAL** do Prompt de Comando:

      start cmd /k "cd /d C:\caminho\da\pasta && claude --channels plugin:telegram@claude-plugins-official"

  Apareceu na janela nova o aviso `Transcript saving is off — inherited
  CLAUDE_CODE_CHILD_SESSION`? A conversa daquela janela **não está sendo salva**:
  peça pra ela fechar e abrir na mão, com o comando de sempre.

**Windows = Prompt de Comando (CMD).** Ao mandar abrir um terminal no Windows,
diga assim: *"aperta a tecla Windows, digita `cmd`, Enter"*. Nunca PowerShell. E
**todo bloco pra colar é UMA LINHA SÓ**: nunca dê dois comandos em linhas
separadas, porque a pessoa cola o bloco inteiro de uma vez e quebra — sempre
`cd ... && claude ...` numa linha.

**Confiança na pasta.** Ao abrir o Claude Code numa pasta nova, ele pergunta se a
pessoa confia nos arquivos dali ("Confiança no workspace necessária"). É a pasta
dela mesma: a resposta é **sim, confio**. Avise antes, senão ela trava nessa tela.

**Se em algum momento o wizard emperrar** (uma ação recusada, um passo que não
avança), diga ao dono, sem drama, que trocar o modelo pra **Opus 5** e/ou ligar a
**aprovação automática de ações** costuma resolver — e retome de onde parou.

## Checklist — MOSTRE e vá marcando

Cole no começo e, a cada passo concluído, reescreva trocando `[ ]` por `[x]`,
dizendo em 1 linha qual é o próximo item.

```
MEU AGENTE (MODO NATIVO) — progresso
[ ] 1. Check-up (Telegram ou só terminal? + Claude Code + login + bun)
[ ] 2. Nome, personalidade, pasta e memória do agente
[ ] 3. Bot no BotFather (token)                      — só com Telegram
[ ] 4. Primeira partida (+ pareamento e a tranca, se for Telegram)
[ ] 5. Teste de fogo + memória
[ ] 5a. Áudio: ele escuta suas mensagens de voz? (opcional, só com Telegram)
[ ] 5b. Conectar o Google: Drive, Gmail e Agenda (opcional)
[ ] 6. Rotina de teste (tarefa agendada)
[ ] 7. Manutenção diária da memória (a reflexão dele)
[ ] 8. A cerimônia de religar (o comando + atalho opcional)
```

## Passo 1 — Check-up  → marca [1]

Explique: "antes de tudo eu confiro se está tudo no lugar".

**1.1 Telegram ou só o terminal?** Pergunte com estas palavras: *"você quer
conversar com ele pelo **Telegram**, ou só pelo **terminal** do computador?"* Em
1 linha: pelo Telegram você fala com ele do celular, de qualquer lugar; só pelo
terminal funciona igual, mas só naquela janela preta. **Guarde a resposta**:

- **Só terminal:** pule os Passos 3 e 4 (bot e pareamento) e o 5a (áudio, que é
  do Telegram), e **tire o `--channels ...`** de todo comando de partida. Todo o
  resto — personalidade, memória, manutenção, Google, rotinas — vale igual.
- **Com Telegram:** siga tudo, e o **bun** do item 1.4 é obrigatório.

**1.2 Claude Code em dia** — rode `claude --version`; se estiver desatualizado
(ou ela não lembrar da última vez), rode `claude update`. **1.3 Login feito** —
se esta sessão responde, está OK; se pedir login, ela só segue o que a tela diz.

**1.4 O bun está instalado?** (obrigatório pra quem escolheu Telegram). O canal
do Telegram roda em cima de um programa chamado **bun**. Sem ele o bot fica
**mudo e sem mensagem de erro nenhuma**: a pessoa manda mensagem, aparece
"digitando…" e a resposta nunca vem. É a causa nº 1 de bot mudo. Rode:

    bun --version

Respondeu um número (ex.: `1.2.0`)? Item verde, siga. Deu "não é reconhecido" ou
"command not found", instale:

- **Windows:** `winget install Oven-sh.Bun` — e, se o winget não existir,
  `powershell -c "irm bun.sh/install.ps1|iex"`
- **Mac/Linux:** `curl -fsSL https://bun.sh/install | bash`

Instalou? **É obrigatório fechar e reabrir o terminal** — programa recém-instalado
só aparece em janela nova. Ensine assim: feche a janela preta clicando no **X**,
aperte a tecla **Windows**, digite `cmd`, **Enter** (no Mac: **Cmd + Espaço**,
digite `Terminal`, **Enter**). Rode `bun --version` de novo. **Só marque este
item quando ele responder um número** — sem isso o Telegram não vai funcionar.

**1.5 Plugin telegram** (só com Telegram) — o canal vem do plugin oficial. Se ele
não estiver instalado (`/plugin` lista os que estão), peça pra ela digitar nesta
sessão, um por vez: `/plugin install telegram@claude-plugins-official` e depois
`/reload-plugins`.

**1.6 Qual é o sistema?** Windows, macOS ou Linux (pergunte, ou deduza). Muda a
forma de escrever caminhos, o terminal (no Windows é o **Prompt de Comando**) e,
lá no final, o tipo de atalho. **Só siga quando os itens acima estiverem verdes.**

## Passo 2 — Nome, personalidade, pasta e memória  → marca [2]

Pergunte **UM de cada vez**, esperando a resposta:

1. "Que nome você quer dar pro seu agente?" (ex.: Luna, Tico, Jarvis…)
2. "Descreve pra mim como você quer que ele seja — o tom, o jeito, se é
   formal ou brincalhão, o que ele curte." (texto livre, sem formato)
3. "E como ele deve te chamar?"

**Escolha da pasta.** Default: `~/Agente<Nome>` (Windows:
`C:\Users\<nome>\Agente<Nome>`). Respeite outro lugar — mas diga com todas as letras:

- **Essa pasta é SÓ do agente**: nada de zip do instalador nem outros projetos
  dentro dela. Se o instalador já estiver lá, **NÃO mova nem apague nada agora**
  — anote e, no FIM do wizard, recomende ao dono apagar/mover o instalador.
- Percebeu que **esta sessão de setup está rodando DENTRO da pasta escolhida**?
  Alerte: o religar usa `--continue`, que retoma **a sessão mais recente daquela
  pasta**. Termine o setup, **feche esta sessão** e não abra sessões soltas ali.

**Escreva os arquivos com a tool Write** — nunca com `echo`, `cat` ou heredoc:
no Windows as aspas e os acentos quebram. A Write já cria as pastas sozinha (não
precisa de `mkdir`). Leia cada template em `${CLAUDE_PLUGIN_ROOT}/templates/` e
escreva a versão preenchida dentro da pasta do agente:

| Template | Vira | Preencher |
|---|---|---|
| `CLAUDE.md.tmpl` | `<pasta>/CLAUDE.md` | `{{NOME}}`, `{{DONO}}`, `{{PERSONALIDADE}}` |
| `working-memory.md.tmpl` | `<pasta>/working-memory.md` | `{{NOME}}`, `{{DONO}}`, `{{DATA}}` |
| `TROUBLESHOOTING.md.tmpl` | `<pasta>/TROUBLESHOOTING.md` | `{{NOME}}` |

No `CLAUDE.md`, o `{{PERSONALIDADE}}` recebe o texto livre da pessoa — pode
reescrever pra ficar bem redigido, mas **sem trair o que ela pediu**. **Só
terminal?** Ao preencher o `CLAUDE.md`, tire a seção do canal Telegram e troque a
entrega das tarefas agendadas (o `curl`) por escrever num arquivo da pasta.

**O livro de memória (visível, na pasta do agente).** Crie também
`<pasta>/memoria/MEMORY.md` — o **sumário** do livro, ainda vazio:

```
# Livro de memória — <Nome>

Sumário: uma linha por assunto, apontando pro arquivo da seção.
As seções vivem nesta mesma pasta (familia.md, trabalho.md, projetos.md…).

<!-- exemplo: - Família do <Dono> → familia.md -->
```

**O ponteiro da auto-memória nativa.** O Claude Code carrega sozinho, em toda
sessão daquela pasta, o arquivo `~/.claude/projects/<slug>/memory/MEMORY.md`,
onde `<slug>` é o **caminho da pasta do agente com os separadores virando traços**
(`C:\Users\Ana\AgenteLuna` → `C--Users-Ana-AgenteLuna`). Se já houver entrada
correspondente em `~/.claude/projects/`, use o nome de lá; se não, monte o
caminho — a Write cria as pastas que faltarem. Escreva **só isto**:

```
# Ponteiro — não escreva memórias aqui

O livro de memória deste agente mora em `<pasta>/memoria/`.
Leia `<pasta>/memoria/MEMORY.md` (o sumário) e siga daí pras seções.
Não escreva memórias neste arquivo: ele é só um ponteiro, mantenha-o assim.
```

Explique em 1 linha: *"esse arquivinho escondido é o único que o sistema lê
sozinho — ele só aponta pro livro de memória, que fica visível na SUA pasta"*.

Depois **leia o `CLAUDE.md` gerado de volta** e mostre o trecho da personalidade:
"é assim que ele vai ser — quer ajustar alguma coisa?". Feche o passo listando o
que existe agora: a identidade (`CLAUDE.md`), o caderninho (`working-memory.md`),
o livro de memória (`memoria/`) e o socorro (`TROUBLESHOOTING.md`).

## Passo 3 — Bot no BotFather  → marca [3]

**Escolheu só o terminal? Pule este passo inteiro** (marque `[x] 3 — não se
aplica`) e vá pro Passo 4.

Conduza, com paciência, um passo por mensagem:

1. No Telegram, procure **@BotFather** (o com selo azul) e abra a conversa.
2. Mande `/newbot`.
3. Ele pede o **nome de exibição** (pode ser o nome do agente, com acento).
4. Ele pede o **@username**, único no Telegram inteiro e **terminando em `bot`**
   (ex.: `luna_da_ana_bot`). Deu "username is already taken"? Invente outro.
5. Ele responde com o **token**, uma linha grande tipo `123456789:AAH...`.
   Peça pra pessoa **copiar** esse token.

**BotFather recusando** com algo tipo *"sorry, too many attempts"* ou *"you cannot
create new bots at this time"*? Não é culpa dela nem do wizard: o Telegram limita
criação de bots. Duas saídas — falar com **@SpamBot** no Telegram (ele costuma
liberar na hora) ou **usar um bot que ela já tenha**, pedindo o token ao BotFather
com `/mytoken`. Enquanto isso, dá pra seguir só pelo terminal e ligar o Telegram
depois.

Aviso: "esse token é a chave do seu bot — não manda pra ninguém".

**Configurar o token no plugin telegram.** O fluxo do plugin oficial muda de
versão pra versão, então seja adaptativo: se a skill `/telegram:configure`
existir, conduza a pessoa por ela e cole o token onde ela pedir; se não existir,
siga pro Passo 4 — na primeira partida o próprio plugin pede o token no terminal.

**Se a gravação do token falhar** (uma proteção da própria máquina pode bloquear
a escrita do `.env`), siga pro Passo 4 sem gravar — o plugin pede o token lá. Não
peça pra ninguém desativar proteção nenhuma. E se a tela do plugin estiver
diferente do descrito aqui, conduza a pessoa pelo que a tela pede, com calma.

## Passo 4 — Primeira partida + pareamento (e a tranca)  → marca [4]

Explique antes: "agora a gente acorda o seu agente pela primeira vez".

Peça pra pessoa **abrir um terminal NOVO** (Windows: tecla Windows → digite
`cmd` → Enter; Mac: o Terminal) e colar **esta linha única** — no Mac/Linux, a
mesma linha sem o `/d`:

```
cd /d "<pasta do agente>" && claude --channels plugin:telegram@claude-plugins-official
```

**Só terminal?** A linha é a mesma **sem o `--channels ...`** (ou seja,
`cd /d "<pasta do agente>" && claude`). Abriu e ele respondeu com a personalidade
certa? Passo 4 concluído — **pule o pareamento abaixo** e vá pro Passo 5.

A preferência é **ela** abrir a janela. Diga com todas as letras: **"essa janela
É o `<Nome>` acordado. Enquanto ela estiver aberta, ele está vivo. Fechou a
janela, ele dorme."** Dois avisos ANTES de ela reclamar: no **Windows** pode
aparecer o aviso do Defender/firewall — é **Permitir acesso**, sem isso o bot não
fala com o Telegram; e **nunca duas janelas com o canal ao mesmo tempo** (dois
processos no mesmo bot dão erro 409 e bot mudo).

Agora o pareamento — **que já tranca a porta no mesmo ato**:

1. Peça: **"manda qualquer mensagem pro seu bot no Telegram"** (procure pelo
   @username que você criou).
2. Aparece um **código de pareamento** na janela (ou um pedido de aprovação).
   Peça pra pessoa ler o que apareceu ali.
3. **Aprove o pareamento**: `/telegram:access pair <código>` se a skill
   `/telegram:access` existir; se não, faça o que a tela pedir ou registre o
   chat aprovado no `access.json` do plugin oficial, como a versão instalada usa.
4. **Ainda no mesmo passo**, mude a política de acesso para **`allowlist`** —
   trancado, ninguém mais gera código de pareamento. Depois avise:
   *"aprovei você e JÁ tranquei a porta — só o seu Telegram fala com ele(a)"*.
5. Se ela quiser liberar mais gente depois, explique em 1 linha: dá sim —
   destrava a política temporariamente, pareia a pessoa nova e tranca de novo.

**Socorro do pareamento (casos que acontecem muito):**

- **O código não aparece / nada acontece.** Confira se há **outra janela ou
  sessão do mesmo bot aberta** — duas ao mesmo tempo e nenhuma responde; feche
  todas, deixe uma. Peça pra ela mandar `/start` pro bot. Se ainda nada, tente
  pelo **Telegram do celular** ou pelo **Desktop** — trocar de aparelho destrava.
- **"O bot fica digitando e não responde".** Mesmo sintoma: outra sessão
  consumindo as mensagens. Uma janela só. E, se o item 1.4 foi pulado, confira o
  `bun --version` — sem bun o canal não sobe e o bot fica exatamente assim.
- Confirme que ela está no **bot certo** — o `@username` que acabou de criar.

Só siga com os dois confirmados: **pareado ✅ e trancado ✅**.

## Passo 5 — Teste de fogo + memória  → marca [5]

Três provas, nesta ordem. **Só terminal?** Faça as três digitando na janela dele
(a 5.2 vira "ele lembra do que a gente acabou de falar") e siga normalmente.

**5.1 Ele fala com a personalidade certa.** Peça um "oi" pelo Telegram. A
resposta tem que chegar lá e **soar como a personalidade escolhida**. Se vier
genérica, algo do CLAUDE.md não pegou — confira o arquivo e reinicie a janela.

**5.2 É a MESMA conversa nos dois lugares.** Peça pra ela **digitar direto na
janela do terminal**: "de que a gente estava falando?". Ele responde ali,
lembrando do "oi" do Telegram: "são a mesma cabeça, muda só a porta de entrada".

**5.3 Ele anota o que importa.** Peça pra ela contar um fato pessoal ("meu
cachorro chama Bidu", "tenho reunião toda terça 9h"). Depois abra o
`<pasta>/working-memory.md` e mostre: o fato está lá, escrito por ele — é o
momento mágico do setup, deixe a pessoa ver.

## Passo 5a — Áudio: ele escuta seus áudios?  → marca [5a]

Passo **opcional**, e só faz sentido com Telegram — **escolheu só o terminal?
Pule pro 5b.** Explique: *"ele já enxerga foto e lê documento de fábrica; só o
áudio precisa de ajuda, porque o Claude não tem ouvido — a gente pluga um serviço
que vira voz em texto."* Pergunte **"você costuma mandar áudio no Telegram?"** e
ofereça três saídas: **(1) Groq**, a recomendada — grátis na prática, sem cartão;
**(2) local** — $0 e o áudio não sai do computador, mas precisa de Python;
**(3) pular** — grave o `audio.json` (formato abaixo) com `"provider": "off"` e
diga que ligar depois é só pedir *"liga a transcrição de áudio"*. ⚠️ Qualquer erro
aqui (chave recusada, Python ausente, `pip` bloqueado) → grave `off`, diga em 1
linha que dá pra ligar depois e **siga pro 5b**.

### Caminho 1 — Groq (o recomendado)

Faixa grátis generosa: **2.000 transcrições e 8 horas de áudio por dia** — uso
pessoal não chega perto. **Antes do link, a aula de chave de API**, que muita
gente nunca criou: *"chave de API é igual a senha, quem tem ela usa a sua conta —
não manda pra ninguém, não posta em grupo, não põe em print. E ela **aparece UMA
vez só**: copie na hora; se fechar sem copiar, apaga e cria outra, leva 30s."*

Conduza um passo por mensagem: (1) abrir **https://console.groq.com/keys**; (2)
fazer login — **pode entrar com o Gmail**, e quem não tem conta cria nessa mesma
tela, **sem cartão**; (3) logada, ela cai na página **API Keys**; (4) clicar em
**`+ Create API Key`**; (5) dar um **nome** à chave (sugira "meu agente"); (6)
copiar a chave, que começa com **`gsk_`**.

Peça pra ela **colar a chave aqui no chat** e grave `<pasta>/audio.json` **com a
tool Write** (nunca `echo`/heredoc), avisando que a chave mora só nesse arquivo —
não na personalidade dele nem na memória dele:

```json
{ "provider": "groq", "groq_api_key": "gsk_...", "modelo_local": "small" }
```

### Caminho 2 — Local (na máquina dela, sem chave)

Conversa franca antes, sem vender facilidade: *"é grátis e privado, o áudio não
sai daqui; em troca precisa de **Python** instalado, na primeira vez baixa um
modelo de **~500 MB** e, sem placa de vídeo NVIDIA, fica **lento** (um áudio de 5
min pode levar alguns minutos). É o mesmo motor do app **DG Scribe**."*

Confira o Python com `python --version` (se falhar, `python3 --version`) — sem
Python, ofereça o Groq e, se ela não quiser, grave `off` e siga. **Peça
autorização** e rode `pip install faster-whisper`. Depois copie
`${CLAUDE_PLUGIN_ROOT}/templates/transcrever.py` (leia e reescreva com a tool
Write, sem alterar nada) para `<pasta>/transcrever.py`, e grave o mesmo
`audio.json` com `"provider": "local"` (a chave fica vazia) — o `.oga` do
Telegram o faster-whisper lê direto, sem converter nada.

### Testar na hora (caminhos 1 e 2 — não pule)

Ele lê o `audio.json` só na hora do áudio, então nem precisa religar: peça **"me
manda um áudio de voz pro seu bot agora"**. Ele deve responder reconhecendo o que
ela falou. Não veio? Confira o caminho do `audio.json`, se a chave começa com
`gsk_`, ou se o `transcrever.py` está na pasta — persistindo, **grave `off` e
siga**. No local, a **primeira transcrição demora** (baixa o modelo). E diga a
verdade: no Groq o áudio vai pro servidor deles; no local, não sai da máquina.

## Passo 5b — Conectar o Google (Drive, Gmail, Agenda)  → marca [5b]

Também **opcional**. Pergunte: *"quer que ele enxergue seu Google — arquivos do
Drive, e-mails do Gmail, compromissos da Agenda?"* Não quis? Siga em frente: dá
pra ligar depois com `/dgclaw-lite:connect` ou pedindo *"conecta meu Google"*.

Quis? Conduza pela skill `/dgclaw-lite:connect` (leia
`${CLAUDE_PLUGIN_ROOT}/skills/connect/SKILL.md`). O resumo: (1) rode `/mcp` nesta
janela; (2) autorize **Google Drive**, **Gmail** e **Google Calendar** — um de
cada vez, no navegador, só os que ela quiser; (3) confira no `/mcp` que ficaram
conectados; (4) **feche a janela do agente e religue com o comando de sempre**, o
que faz a sessão dele enxergar as ferramentas novas; (5) teste: *"vê meus
próximos eventos da agenda"*. Nenhum connector do Google apareceu no `/mcp`? A
conta ou o plano dela pode não ter os connectors habilitados — registre como
pendente e siga o wizard.

## Passo 6 — Rotina de teste (tarefa agendada)  → marca [6]

Peça pra pessoa mandar **pelo Telegram**:

> "me manda um oi por aqui daqui a 2 minutos"

**Só terminal?** Peça na janela dele: *"daqui a 2 minutos, escreva um oi com a
hora no arquivo `recados.md` da sua pasta"* — a entrega vira um arquivo em vez de
mensagem, e o resto da explicação abaixo vale igual (menos o `curl`).

O agente cria uma **tarefa agendada avulsa** (o CLAUDE.md dele já ensina como).
Esperem juntos os 2 minutos — a mensagem chega sozinha. Comemore: é a
proatividade dele. Explique por que é assim (e não "tarefa repetitiva"):

- **Repetitiva não, corrente sim.** O agendamento repetitivo nativo tem bug
  conhecido (issue #55378 do Claude Code) e para de rodar **em silêncio**. Por
  isso ele usa uma **corrente de avulsos**: cada rodada faz o trabalho, entrega
  e **agenda a próxima**; se um elo cair (computador desligado), ele recria.
- **Quem executa não é a janela viva**: é uma execução nova na mesma pasta, sem o
  Telegram anexado — por isso a entrega sai pela API do Bot com `curl`, que já
  vem no Windows 10+ e no Mac.

A conversa franca: **tarefa agendada só roda com o computador ligado**. E daqui
pra frente é só pedir em linguagem natural: "todo dia às 8h me manda a previsão
do tempo".

## Passo 7 — Manutenção diária da memória (a reflexão dele)  → marca [7]

Explique em 2 linhas: "todo agente que lembra bem tem um ritual de arrumar a
casa — ele relê o dia, atualiza o caderninho, guarda o que virou permanente no
livro de memória (a pasta `memoria/`, que você pode abrir e ler quando quiser) e
escreve um diário curto do dia" — e o diário importa porque o histórico bruto da
conversa é apagado pelo sistema depois de um tempo.

**Ele mesmo se lembra (não precisa configurar nada).** O agente guarda no topo do
working-memory a data da última manutenção. Passaram 3 dias ou mais? Ele avisa no
fim de uma resposta qualquer: "faz X dias que não faço minha manutenção de
memória, me autoriza? É rapidinho". Ela diz "autorizo" e ele faz na hora. Diga
com todas as letras: **"você não precisa lembrar de nada; ele te pede na hora
certa, e só mexe nas memórias com a sua autorização"**.

**O gatilho manual.** Ensine a frase **"faz sua manutenção de memória"** e peça
pra ela mandar isso agora mesmo, só pra ver o ritual acontecendo — ele volta com
um resumo curtinho e atualiza a data no working-memory. Mostre a linha
atualizada: é assim que ele "sabe" quando cobrar. Mencione de passagem: se um dia
ele parecer estranho, lento ou esquecido, existe o `/dgclaw-lite:doctor`.

## Passo 8 — A cerimônia de religar  → marca [8]

Esse é o passo que faz o agente durar. Ensine **O comando** — **uma linha só**,
colada no Prompt de Comando (Windows: tecla Windows → `cmd` → Enter); no
Mac/Linux, a mesma linha sem o `/d`:

```
cd /d "<pasta do agente>" && claude --continue --channels plugin:telegram@claude-plugins-official
```

Explique cada pedaço em uma linha:
- `cd` → entra na pasta que É o agente;
- `--continue` → retoma a MESMA conversa de sempre (é isso que faz ele lembrar);
- `--channels ...` → liga o Telegram. **Sem esse pedaço, o bot fica mudo.**

**Só terminal?** O comando dela é o mesmo **sem o `--channels ...`**:
`cd /d "<pasta do agente>" && claude --continue`. Diga que, no dia em que ela
quiser o Telegram, é só pedir ao agente *"quero te usar no Telegram também"*.

Peça pra pessoa **salvar esse comando agora**: colar num bloco de notas, ou
mandar pra si mesma no Telegram (mensagens salvas). Espere ela confirmar.

**O atalho (opcional).** Diga: *"quer um atalho de dois cliques na área de
trabalho? Peça pro próprio `<Nome>`, na janela dele: **cria um atalho na minha
área de trabalho pra te acordar**"*. Não crie você — o CLAUDE.md dele já ensina
como, e a graça é ela ver o agente fazendo sozinho.

### Fechamento — a conversa franca

Encerre com isto, sem drama e sem letra miúda:

- Computador **desligado ou dormindo** = agente dormindo. Ele não é 24/7.
- Mensagem mandada **com ele desligado se perde** (não tem fila): é só reenviar.
- **Nunca duas janelas** do agente ao mesmo tempo (erro 409, bot mudo).
- **Não abra sessões avulsas** do Claude Code na pasta do agente — o
  `--continue` retomaria a sessão errada.
- Se ele ficar mudo ou estranho, o **`TROUBLESHOOTING.md`** na pasta dele resolve
  quase tudo — em português, pra leigo.
- Quer o agente **sempre ligado**, com painel e launcher de 1 clique? Isso é o
  plugin `dgclaw` completo (v0.2) e o modo servidor.

Marque o `[x] 8`, mostre o checklist inteiro completo e parabenize. 🎉
