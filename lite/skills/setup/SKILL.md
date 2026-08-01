---
name: setup
description: Wizard do DG Claw Lite — cria um agente pessoal no Telegram usando 100% Claude Code nativo, sem instalar nada extra (sem Bun, sem hooks, sem scripts, sem launcher, sem painel). Da nome, personalidade e memoria ao agente, cria o bot no BotFather e ensina a cerimonia de religar. Use quando a pessoa rodar /dgclaw-lite:setup, pedir pra "instalar meu agente", "criar meu assistente no Telegram", "criar meu agente pessoal", "montar o bot que fala comigo", ou pedir o "modo nativo", "modo lite", "versao leve" ou "versao de aula" do DG Claw.
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
Este plugin só te guia e escreve os arquivos de identidade do agente; ele **não
instala NENHUM programa extra**. Tudo que faz o agente funcionar (Telegram,
memória, compactação, tarefas agendadas) já vem de fábrica no Claude Code.

## Como conduzir (regra transversal — vale do começo ao fim)

**Ofereça sempre rodar por ela.** Ao mandar a pessoa rodar um comando ou colar
algo no terminal, ofereça na MESMA mensagem: *"se não souber onde colar, me
fala que eu rodo pra você"*.

- **Comandos de configuração** (marketplace, instalar plugin, conferir versão,
  gravar arquivos): se ela pedir, rode você mesmo, sem cerimônia.
- **Abrir a janela do agente** (primeira partida e religadas): a preferência é
  **a PESSOA abrir**. Motivo real: em teste, janela aberta de dentro de outra
  sessão terminou com o **transcript não gravado** — a conversa se perdeu. Se
  ela pedir mesmo assim, abra uma janela **REAL** do Prompt de Comando:

      start cmd /k "cd /d C:\caminho\da\pasta && claude --channels plugin:telegram@claude-plugins-official"

  e **confira depois**: passado ~1 minuto de conversa, veja se apareceu um
  `.jsonl` NOVO em `~/.claude/projects/<pasta-do-agente-com-traços>/`. Não
  apareceu? Avise que a conversa daquela janela **pode não estar sendo salva** e
  recomende fechar e reabrir a janela na mão.

**Windows = Prompt de Comando (CMD).** Ao mandar abrir um terminal no Windows,
diga assim: *"aperta a tecla Windows, digita `cmd`, Enter"*. Nunca PowerShell.

**Todo bloco pra colar é UMA LINHA SÓ.** Nunca dê dois comandos em linhas
separadas: a pessoa cola o bloco inteiro de uma vez e quebra. Sempre
`cd ... && claude ...` numa linha.

## Checklist — MOSTRE e vá marcando

Cole no começo e, a cada passo concluído, reescreva trocando `[ ]` por `[x]`,
dizendo em 1 linha qual é o próximo item.

```
MEU AGENTE (MODO NATIVO) — progresso
[ ] 1. Check-up (Claude Code em dia + login + plugin telegram)
[ ] 2. Nome, personalidade, pasta e memória do agente
[ ] 3. Bot no BotFather (token)
[ ] 4. Primeira partida + pareamento (e a tranca)
[ ] 5. Teste de fogo + memória
[ ] 6. Rotina de teste (tarefa agendada)
[ ] 7. Manutenção diária da memória (a reflexão dele)
[ ] 8. A cerimônia de religar (o comando + atalho opcional)
```

## Passo 1 — Check-up  → marca [1]

Explique: "antes de tudo eu confiro se está tudo no lugar — não vamos instalar
nada, só conferir".

**1.1 Claude Code em dia** — rode `claude --version`. Se estiver desatualizado
(ou a pessoa não lembrar da última vez), rode `claude update`.

**1.2 Login feito** — se esta sessão está rodando e respondendo, está OK. Se
aparecer pedido de login, a pessoa só segue o que a tela pedir.

**1.3 Plugin telegram instalado** — confira se o plugin oficial está presente
(`/plugin` lista os instalados). Se faltar, peça pra rodar **nesta sessão**:

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

**1.4 Qual é o sistema?** Windows, macOS ou Linux (pergunte, ou deduza). Muda a
forma de escrever caminhos, o terminal (no Windows é o **Prompt de Comando**) e,
lá no final, o tipo de atalho. Não precisa de Bun, node nem python. **Só siga
quando os 3 primeiros itens estiverem verdes.**

## Passo 2 — Nome, personalidade, pasta e memória  → marca [2]

Pergunte **UM de cada vez**, esperando a resposta:

1. "Que nome você quer dar pro seu agente?" (ex.: Luna, Tico, Jarvis…)
2. "Descreve pra mim como você quer que ele seja — o tom, o jeito, se é
   formal ou brincalhão, o que ele curte." (texto livre, sem formato)
3. "E como ele deve te chamar?"

**Escolha da pasta.** Default: `~/Agente<Nome>` (Windows:
`C:\Users\<nome>\Agente<Nome>`). Respeite outro lugar — mas diga com todas as letras:

- **Essa pasta é SÓ do agente**: nada de zip do instalador, arquivos do plugin
  ou outros projetos dentro dela. Se o instalador já estiver lá dentro, **NÃO
  mova nem apague nada agora** (não interrompa o setup pra arrumação) — só
  anote e, no FIM do wizard, recomende ao dono apagar/mover o instalador.
- Se você perceber que **esta sessão de setup está rodando DENTRO da pasta
  escolhida**, alerte: o religar usa `--continue`, que retoma **a sessão mais
  recente daquela pasta** — sessões avulsas ali dentro podem ser retomadas por
  engano no lugar do agente. Recomendação: terminar o setup, **fechar esta
  sessão** e não abrir outras sessões soltas na pasta do agente.

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
reescrever pra ficar bem redigido, mas **sem trair o que ela pediu**.

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
onde `<slug>` é o **caminho da pasta do agente com os separadores virando
traços** (ex.: `C:\Users\Ana\AgenteLuna` → `C--Users-Ana-AgenteLuna`;
`/home/ana/AgenteLuna` → `-home-ana-AgenteLuna`). Se já houver entrada
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

Depois **leia o `CLAUDE.md` gerado de volta** e mostre o trecho da
personalidade: "é assim que ele vai ser — quer ajustar alguma coisa?". Se ela
quiser mudar, edite e mostre de novo. Feche o passo listando o que existe agora:
a identidade (`CLAUDE.md`), o caderninho (`working-memory.md`), o livro de
memória (`memoria/`) e o guia de socorro (`TROUBLESHOOTING.md`).

## Passo 3 — Bot no BotFather  → marca [3]

Conduza, com paciência, um passo por mensagem:

1. No Telegram, procure **@BotFather** (o com selo azul) e abra a conversa.
2. Mande `/newbot`.
3. Ele pede o **nome de exibição** (pode ser o nome do agente, com acento).
4. Ele pede o **@username**, único no Telegram inteiro e **terminando em `bot`**
   (ex.: `luna_da_ana_bot`). Deu "username is already taken"? Invente outro.
5. Ele responde com o **token**, uma linha grande tipo `123456789:AAH...`.
   Peça pra pessoa **copiar** esse token.

Aviso importante pra dizer: "esse token é a chave do seu bot — não manda pra
ninguém, não posta em grupo".

**Configurar o token no plugin telegram.** Use o fluxo do próprio plugin
oficial — ele muda de versão pra versão, então seja adaptativo. Se a skill
`/telegram:configure` existir, conduza a pessoa por ela (caminho preferido) e
cole o token onde ela pedir. Se não existir, siga direto pro Passo 4: na
primeira partida com o canal ligado o próprio plugin pede o token no terminal.

**Se a gravação do token FALHAR, não insista.** Aconteceu em teste real: um hook
de proteção do próprio usuário bloqueou a escrita do `.env`. Nesse caso **não
peça pra desativar proteção nenhuma** — use o fallback: siga pro Passo 4 sem
gravar; o plugin pede o token no terminal na primeira partida.

**Não trave o wizard aqui.** Se a UX do plugin estiver diferente do descrito,
leia o que a tela está pedindo e conduza a pessoa por aquilo, com calma.

## Passo 4 — Primeira partida + pareamento (e a tranca)  → marca [4]

Explique antes: "agora a gente acorda o seu agente pela primeira vez".

Peça pra pessoa **abrir um terminal NOVO** (Windows: tecla Windows → digite
`cmd` → Enter; Mac: o Terminal) e colar **esta linha única** — no Mac/Linux, a
mesma linha sem o `/d`:

```
cd /d "<pasta do agente>" && claude --channels plugin:telegram@claude-plugins-official
```

Ofereça ajuda ("se não souber onde colar, me fala") — mas lembre da regra do
"Como conduzir": a preferência é **ela** abrir a janela. E diga com todas as
letras: **"essa janela É o `<Nome>` acordado. Enquanto ela estiver aberta, ele
está vivo. Fechou a janela, ele dorme."**

Avisos pra dar ANTES de a pessoa reclamar:
- **Windows**: pode aparecer o aviso do Defender/firewall — é **Permitir
  acesso**. Sem isso o bot não fala com o Telegram.
- **Nunca abra duas janelas com o canal ao mesmo tempo.** Dois processos
  disputando o mesmo bot dá erro 409 e o bot fica mudo. Uma janela só.

Agora o pareamento — **que já tranca a porta no mesmo ato**:

1. Peça: **"manda qualquer mensagem pro seu bot no Telegram"** (procure pelo
   @username que você criou).
2. Aparece um **código de pareamento** na janela (ou um pedido de aprovação).
   Peça pra pessoa ler o que apareceu ali.
3. **Aprove o pareamento**: `/telegram:access pair <código>` se a skill
   `/telegram:access` existir; se não, faça o que a tela pedir ou registre o
   chat aprovado no `access.json` do plugin oficial, como a versão instalada usa.
4. **NO MESMO ATO, sem perguntar nada**, mude a política de acesso para
   **`allowlist`** — trancado, ninguém mais gera código de pareamento. E avise:
   *"aprovei você e JÁ tranquei a porta — só o seu Telegram fala com ele(a)"*.
5. Se ela quiser liberar mais gente depois, explique em 1 linha: dá sim —
   destrava a política temporariamente, pareia a pessoa nova e tranca de novo.

Só siga com os dois confirmados: **pareado ✅ e trancado ✅**.

## Passo 5 — Teste de fogo + memória  → marca [5]

Três provas, nesta ordem:

**5.1 Ele fala com a personalidade certa.** Peça um "oi" pelo Telegram. A
resposta tem que chegar lá e **soar como a personalidade escolhida**. Se vier
genérica, algo do CLAUDE.md não pegou — confira o arquivo e reinicie a janela.

**5.2 É a MESMA conversa nos dois lugares.** Peça pra ela **digitar direto na
janela do terminal**: "de que a gente estava falando?". Ele responde ali,
lembrando do "oi" do Telegram. Explique: "Telegram e terminal são a mesma
cabeça — muda só a porta de entrada".

**5.3 Ele anota o que importa.** Peça pra ela contar um fato pessoal pelo
Telegram ("meu cachorro chama Bidu", "tenho reunião toda terça 9h"). Depois abra
o `<pasta>/working-memory.md` e mostre: o fato está lá, escrito por ele. Esse é
o momento mágico do setup — deixe a pessoa ver.

## Passo 6 — Rotina de teste (tarefa agendada)  → marca [6]

Peça pra pessoa mandar **pelo Telegram**:

> "me manda um oi por aqui daqui a 2 minutos"

O agente cria uma **tarefa agendada avulsa** (o CLAUDE.md dele já ensina como).
Esperem juntos os 2 minutos — a mensagem chega sozinha. Comemore: é a
proatividade dele. Explique por que é assim (e não "tarefa repetitiva"):

- **Repetitiva não, corrente sim.** O agendamento repetitivo nativo tem bug
  conhecido (issue #55378 do Claude Code) e para de rodar **em silêncio**. Por
  isso ele usa uma **corrente de avulsos**: cada rodada faz o trabalho, entrega
  e **agenda a próxima**; se um elo cair (computador desligado), ele recria.
- **Quem executa não é a janela viva**: é uma execução nova na mesma pasta,
  **sem o Telegram anexado**. Por isso a entrega sai pela API do Bot com
  `curl` — que já vem no Windows 10+ e no Mac, nada pra instalar.

A conversa franca que vem junto: **tarefa agendada só roda com o computador
ligado.** Desligado na hora, aquela rodada não acontece — e a corrente é
recriada na próxima oportunidade. Diga também que a partir de agora é só pedir
em linguagem natural: "todo dia às 8h me manda a previsão do tempo".

## Passo 7 — Manutenção diária da memória (a reflexão dele)  → marca [7]

Explique em 2 linhas: "todo agente que lembra bem tem um ritual de arrumar a
casa — ele relê o dia, atualiza o caderninho, guarda o que virou permanente no
livro de memória (a pasta `memoria/`, que você pode abrir e ler quando quiser) e
escreve um diário curto do dia" — e o diário importa porque o histórico bruto da
conversa é apagado pelo sistema depois de um tempo.

**Ele mesmo se lembra (não precisa configurar nada).** O agente guarda no topo do
working-memory a data da última manutenção — e sempre sabe o dia de hoje.
Passaram 3 dias ou mais? Ele avisa no fim de uma resposta qualquer: "faz X dias
que não faço minha manutenção de memória, me autoriza? É rapidinho". Ela diz
"autorizo" e ele faz na hora, anotando a data nova. Diga com todas as letras:
**"você não precisa lembrar de nada; ele te pede na hora certa, e só mexe nas
memórias com a sua autorização"**.

**O gatilho manual (pra quando ela quiser).** Ensine a frase:

> "faz sua manutenção de memória"

Peça pra ela mandar isso agora mesmo, pelo Telegram, só pra ver o ritual
acontecendo — ele volta com um resumo curtinho e atualiza a data no
working-memory. Mostre a linha atualizada: é assim que ele "sabe" quando cobrar.
(Quem fizer questão de horário fixo pode pedir uma corrente diária agendada —
mas ela só roda com o computador ligado; o lembrete automático funciona sempre,
por isso é o padrão.) Mencione de passagem: se um dia ele parecer estranho,
lento ou esquecido, existe o `/dgclaw-lite:doctor`, o diagnóstico completo.

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

Peça pra pessoa **salvar esse comando agora**: colar num bloco de notas, ou
mandar pra si mesma no Telegram (mensagens salvas). Espere ela confirmar.

**O atalho (opcional, e é um gesto bonito de ensinar).** Diga:

> "Se você quiser um atalho de dois cliques na sua área de trabalho, peça pro
> próprio `<Nome>`, na janela dele: *cria um atalho na minha área de trabalho
> pra te acordar*. Ele mesmo escreve o arquivo pra você."

Não crie o atalho você: o CLAUDE.md dele já ensina como — a graça é ela ver o
agente fazendo sozinho.

### Fechamento — a conversa franca

Encerre com isto, sem drama e sem letra miúda:

- Computador **desligado ou dormindo** = agente dormindo. Ele não é 24/7.
- Mensagem mandada **com ele desligado se perde** (não tem fila): é só reenviar.
- **Nunca duas janelas** do agente ao mesmo tempo (erro 409, bot mudo).
- **Não abra sessões avulsas** do Claude Code na pasta do agente — o
  `--continue` retomaria a sessão errada.
- Se ele ficar mudo ou estranho, o **`TROUBLESHOOTING.md`** na pasta dele
  resolve quase tudo — está em português, pra leigo.
- Quer o agente **sempre ligado**, com transcrição de áudio, painel e launcher
  de 1 clique? Isso é o plugin `dgclaw` completo (v0.2) e o modo servidor.

Marque o `[x] 8`, mostre o checklist inteiro completo e parabenize. 🎉
