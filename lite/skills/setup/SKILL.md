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
Este plugin só te guia e escreve os arquivos de identidade do agente; ele
**não instala NENHUM programa extra** no seu computador.
Tudo que faz o agente funcionar (conversa pelo Telegram, memória, compactação,
tarefas agendadas) já vem de fábrica no Claude Code que você já tem.

## Checklist — MOSTRE e vá marcando

Cole no começo e, a cada passo concluído, reescreva trocando `[ ]` por `[x]`,
dizendo em 1 linha qual é o próximo item.

```
MEU AGENTE (MODO NATIVO) — progresso
[ ] 1. Check-up (Claude Code em dia + login + plugin telegram)
[ ] 2. Nome, personalidade e pasta do agente
[ ] 3. Bot no BotFather (token)
[ ] 4. Primeira partida + pareamento
[ ] 5. Teste de fogo + memória
[ ] 6. Rotina de teste (tarefa agendada)
[ ] 7. Manutenção diária da memória (a reflexão dele)
[ ] 8. A cerimônia de religar (o comando + atalho opcional)
```

---

## Passo 1 — Check-up  → marca [1]

Explique: "antes de tudo eu confiro se está tudo no lugar — não vamos instalar
nada, só conferir".

**1.1 Claude Code em dia**

```bash
claude --version
```

Se estiver desatualizado (ou a pessoa não lembrar da última vez), rode:

```bash
claude update
```

**1.2 Login feito**

Se esta sessão está rodando e respondendo, o login está OK. Se em algum momento
aparecer pedido de login, é só a pessoa seguir o que a tela pedir.

**1.3 Plugin telegram instalado**

Confira se o plugin oficial do Telegram está presente (`/plugin` lista os
instalados, ou tente rodar a skill `/telegram:configure`). Se faltar, peça pra
pessoa rodar, **nesta mesma sessão**:

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

**1.4 Qual é o sistema?**

Descubra se é Windows, macOS ou Linux (pergunte, ou deduza pelo ambiente). Isso
só muda a forma de escrever caminhos e, lá no final, o tipo de atalho.

Não precisa de Bun, node, python nem nada disso. **Só siga quando os 3 itens
acima estiverem verdes.**

---

## Passo 2 — Nome, personalidade e pasta  → marca [2]

Pergunte **UM de cada vez**, esperando a resposta:

1. "Que nome você quer dar pro seu agente?" (ex.: Luna, Tico, Jarvis…)
2. "Descreve pra mim como você quer que ele seja — o tom, o jeito, se é
   formal ou brincalhão, o que ele curte." (texto livre, sem formato)
3. "E como ele deve te chamar?"

**Crie a pasta do agente.** Default: `~/Agente<Nome>` (no Windows isso é
`C:\Users\<nome>\Agente<Nome>`). Respeite se a pessoa preferir outro lugar.

**Escreva os três arquivos com a tool Write** — nunca com `echo`, `cat` ou
heredoc: no Windows as aspas e os acentos quebram. A tool Write já cria a
pasta sozinha ao escrever o primeiro arquivo (não precisa de `mkdir`, que
muda de sintaxe entre os sistemas).

Leia cada template em `${CLAUDE_PLUGIN_ROOT}/templates/` e escreva a versão
preenchida dentro da pasta do agente:

| Template | Vira | Preencher |
|---|---|---|
| `CLAUDE.md.tmpl` | `<pasta>/CLAUDE.md` | `{{NOME}}`, `{{DONO}}`, `{{PERSONALIDADE}}` |
| `working-memory.md.tmpl` | `<pasta>/working-memory.md` | `{{NOME}}`, `{{DONO}}`, `{{DATA}}` |
| `TROUBLESHOOTING.md.tmpl` | `<pasta>/TROUBLESHOOTING.md` | `{{NOME}}` |

No `CLAUDE.md`, o `{{PERSONALIDADE}}` recebe o texto livre da pessoa —
pode reescrever pra ficar bem redigido, mas **sem trair o que ela pediu**.

Depois, **leia o `CLAUDE.md` gerado de volta** e mostre pra ela o trecho da
personalidade: "é assim que ele vai ser — quer ajustar alguma coisa?". Se ela
quiser mudar, edite e mostre de novo.

Feche o passo dizendo em 2-3 linhas o que existe agora na pasta: a identidade
(CLAUDE.md), o caderninho de memória (working-memory.md) e o guia de socorro
(TROUBLESHOOTING.md).

---

## Passo 3 — Bot no BotFather  → marca [3]

Conduza, com paciência, um passo por mensagem:

1. No Telegram, procure **@BotFather** (o com selo azul) e abra a conversa.
2. Mande `/newbot`.
3. Ele pede o **nome de exibição** do bot (pode ser o nome do agente, com
   acento e espaço mesmo).
4. Ele pede o **@username** — esse precisa ser único no Telegram inteiro e
   **terminar em `bot`** (ex.: `luna_da_ana_bot`). Se der "sorry, this username
   is already taken", é só inventar outro.
5. Ele responde com o **token**, uma linha grande tipo
   `123456789:AAH...`. Peça pra pessoa **copiar** esse token.

Aviso importante pra dizer: "esse token é a chave do seu bot — não manda pra
ninguém, não posta em grupo".

**Configurar o token no plugin telegram.** Use o fluxo do próprio plugin
oficial — ele muda de versão pra versão, então seja adaptativo:

- Se a skill `/telegram:configure` existir, conduza a pessoa por ela (é o
  caminho preferido) e cole o token onde ela pedir.
- Se não existir, tudo bem: siga direto pro Passo 4 — na primeira partida com
  o canal ligado o próprio plugin pede o token no terminal.

**Não trave o wizard aqui.** Se a UX do plugin estiver diferente do descrito,
leia o que a tela está pedindo e conduza a pessoa por aquilo, com calma.

---

## Passo 4 — Primeira partida + pareamento  → marca [4]

Explique antes: "agora a gente acorda o seu agente pela primeira vez".

Peça pra pessoa **abrir um terminal NOVO** (Prompt de Comando / PowerShell no
Windows, Terminal no Mac) e rodar, exatamente:

```bash
cd "<pasta do agente>"
claude --channels plugin:telegram@claude-plugins-official
```

Diga com todas as letras: **"essa janela É o `<Nome>` acordado. Enquanto ela
estiver aberta, ele está vivo. Fechou a janela, ele dorme."**

Avisos pra dar ANTES de a pessoa reclamar:
- **Windows**: pode aparecer o aviso do Defender/firewall — é **Permitir
  acesso**. Sem isso o bot não fala com o Telegram.
- **Nunca abra duas janelas com o canal ao mesmo tempo.** Dois processos
  disputando o mesmo bot dá erro 409 e o bot fica mudo. Uma janela só.

Agora o pareamento:

1. Peça: **"manda qualquer mensagem pro seu bot no Telegram"** (procure pelo
   @username que você criou).
2. O plugin vai conduzir o pareamento — normalmente aparece um **código de
   pareamento** no terminal (ou uma pergunta de aprovação). Peça pra pessoa
   ler o que apareceu na janela e fazer o que está escrito ali.
3. Se a versão do plugin oferecer a skill `/telegram:access`, ela também
   resolve a liberação. Use o que estiver disponível.

Só siga quando a pessoa confirmar: "pareado / liberado".

---

## Passo 5 — Teste de fogo + memória  → marca [5]

Três provas, nesta ordem:

**5.1 Ele fala com a personalidade certa.** Peça um "oi" pelo Telegram. A
resposta tem que chegar no Telegram e **soar como a personalidade escolhida**.
Se vier genérica, algo do CLAUDE.md não pegou — confira o arquivo e reinicie a
janela.

**5.2 É a MESMA conversa nos dois lugares.** Peça pra ela **digitar direto na
janela do terminal**: "de que a gente estava falando?". Ele responde ali,
lembrando do "oi" do Telegram. Explique: "Telegram e terminal são a mesma
cabeça, a mesma conversa — muda só a porta de entrada".

**5.3 Ele anota o que importa.** Peça pra ela contar um fato pessoal pelo
Telegram ("meu cachorro chama Bidu", "tenho reunião toda terça 9h"). Depois,
abra o `<pasta>/working-memory.md` e mostre pra ela: o fato está lá, escrito
por ele. Esse é o momento mágico do setup — deixe a pessoa ver.

---

## Passo 6 — Rotina de teste (tarefa agendada)  → marca [6]

Peça pra pessoa mandar **pelo Telegram**:

> "me manda um oi por aqui daqui a 2 minutos"

O agente cria uma **tarefa agendada nativa** do Claude Code (o CLAUDE.md dele
já ensina como). Esperem juntos os 2 minutos — a mensagem chega no Telegram
sozinha. Comemore: isso é a proatividade dele.

A conversa franca que tem que vir junto: **tarefa agendada só roda com o
computador ligado E a janela do agente aberta.** Se o computador estiver
desligado na hora, aquela rodada simplesmente não acontece.

Diga também que a partir de agora é só pedir em linguagem natural: "todo dia
às 8h me manda a previsão do tempo", "sexta me lembra de mandar o relatório".

---

## Passo 7 — Manutenção diária da memória (a reflexão dele)  → marca [7]

Explique, em 2 linhas: "todo agente que lembra bem tem um ritual de arrumar a
casa — ele relê o dia, atualiza o caderninho, guarda o que virou permanente no
livro de memória e escreve um diário curto daquele dia" — e esse diário importa
porque o histórico bruto da conversa é apagado pelo sistema depois de um tempo.

**Ele mesmo se lembra (não precisa configurar nada).** O agente guarda, no
topo do working-memory, a data da última manutenção — e ele sempre sabe o dia
de hoje. Passaram 3 dias ou mais? Ele mesmo avisa, no fim de uma resposta
qualquer: "faz X dias que não faço minha manutenção de memória, me autoriza?
É rapidinho". A pessoa diz "autorizo" e ele faz na hora — e anota a data nova.
Diga isso a ela com todas as letras: **"você não precisa lembrar de nada; ele
te pede quando estiver na hora, e só mexe nas memórias com a sua autorização"**.

**O gatilho manual (pra quando ela quiser).** Ensine a frase:

> "faz sua manutenção de memória"

Peça pra ela mandar isso agora mesmo, pelo Telegram, só pra ver o ritual
acontecendo — ele volta com um resumo curtinho e atualiza a data da última
manutenção no working-memory. Mostre a linha atualizada pra ela: é assim que
ele "sabe" quando cobrar a próxima.

(Quem fizer questão de horário fixo pode, opcionalmente, pedir uma rotina
agendada diária — mas ela só roda com o computador ligado e a janela aberta.
O lembrete automático acima funciona sempre; por isso ele é o padrão.)

Mencione de passagem: se um dia ele parecer estranho, lento ou esquecido,
existe o `/dgclaw-lite:doctor`, que faz um diagnóstico completo.

---

## Passo 8 — A cerimônia de religar  → marca [8]

Esse é o passo que faz o agente durar. Ensine **O comando**:

```bash
cd "<pasta do agente>"
claude --continue --channels plugin:telegram@claude-plugins-official
```

Explique cada pedaço em uma linha:
- `cd` → entra na pasta que É o agente;
- `--continue` → retoma a MESMA conversa de sempre (é isso que faz ele lembrar);
- `--channels ...` → liga o Telegram. **Sem esse pedaço, o bot fica mudo.**

Peça pra pessoa **salvar esse comando agora**: colar num bloco de notas, ou
mandar pra si mesma no Telegram (mensagens salvas). Espere ela confirmar que
salvou.

**O atalho (opcional, e é um gesto bonito de ensinar).** Diga:

> "Se você quiser um atalho de dois cliques na sua área de trabalho, peça pro
> próprio `<Nome>`, na janela dele: *cria um atalho na minha área de trabalho
> pra te acordar*. Ele mesmo escreve o arquivo pra você."

Não crie o atalho você. O CLAUDE.md dele já ensina como fazer — a graça é ela
ver o agente fazendo isso sozinho quando pedir.

### Fechamento — a conversa franca

Encerre com isto, sem drama e sem letra miúda:

- Computador **desligado ou dormindo** = agente dormindo. Ele não é 24/7.
- Mensagem mandada **com ele desligado se perde** (não tem fila). É só
  reenviar quando ele voltar.
- **Nunca duas janelas** do agente ao mesmo tempo (erro 409, bot mudo).
- Se ele ficar mudo ou estranho, o arquivo **`TROUBLESHOOTING.md`** na pasta
  dele resolve quase tudo — está escrito em português, pra leigo.
- Quer o agente **sempre ligado**, com transcrição de áudio, painel e launcher
  de 1 clique? Isso é o plugin `dgclaw` completo (v0.2) e o modo servidor.

Marque o `[x] 8`, mostre o checklist inteiro completo e parabenize. 🎉
