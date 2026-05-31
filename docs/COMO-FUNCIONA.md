# Como o DG Claw funciona (explicado pra qualquer pessoa)

Sem jargao. Se voce nunca programou, este texto e pra voce.

---

## 1. O que e o DG Claw, em uma frase

> Um assistente pessoal SEU, que mora no Telegram, lembra das suas coisas,
> e fica ligado 24 horas por dia.

Voce manda mensagem como manda pra um amigo. Ele responde, faz tarefas,
e vai te conhecendo com o tempo.

---

## 2. As 4 pecas (o corpo do assistente)

Pense num ser vivo. Ele tem:

```
   +--------------------------------------------------------------+
   |                        SEU ASSISTENTE                        |
   |                                                              |
   |   [ CEREBRO ]      [ BOCA E OUVIDO ]                         |
   |   Claude Code       Bot do Telegram                          |
   |   pensa e decide    fala e escuta voce                       |
   |                                                              |
   |   [ MEMORIA ]      [ CASA ]                                  |
   |   arquivos que      uma pastinha na VPS +                    |
   |   ele lembra        um "vigia" (systemd) que               |
   |                     mantem ele sempre acordado               |
   +--------------------------------------------------------------+
```

- **Cerebro = Claude Code.** E a inteligencia. O mesmo motor de IA, rodando
  no servidor.
- **Boca e ouvido = bot do Telegram.** O canal por onde voces conversam.
- **Memoria = arquivos de texto.** Onde ele guarda o que aprende sobre voce.
- **Casa = uma pasta na VPS + o systemd.** O systemd e um "vigia" que mantem
  o assistente ligado e o acorda de novo se ele cair.

> VPS = um computador na internet que fica ligado o tempo todo (voce aluga).
> E por isso que o assistente nunca "dorme".

---

## 3. O que acontece quando voce manda uma mensagem

```
  Voce no Telegram
        |
        |  "oi, lembra daquele projeto do mercado?"
        v
  +-------------+      +------------------------+      +-------------------+
  |  Bot do     | ---> |  Cerebro (Claude Code) | ---> |  Resposta volta   |
  |  Telegram   |      |  - le sua mensagem     |      |  pelo Telegram    |
  +-------------+      |  - consulta a memoria  |      +-------------------+
                       |  - decide o que fazer  |
                       +-----------+------------+
                                   |
                                   v
                          +-----------------+
                          |    MEMORIA      |
                          | "ah sim, o      |
                          |  projeto do     |
                          |  mercado e..."  |
                          +-----------------+
```

Tudo isso leva poucos segundos. Voce so ve a resposta chegar no Telegram.

---

## 4. A memoria, explicada (a parte mais legal)

O assistente tem **tres tipos de memoria**, igual a gente:

```
  +----------------------------------------------------------------+
  |  CURTO PRAZO   ->  working-memory.md                           |
  |  "o que ta rolando agora": tarefas de hoje, o que voce         |
  |  acabou de pedir. Ele anota e apaga conforme as coisas mudam.  |
  +----------------------------------------------------------------+
  |  LONGO PRAZO   ->  MEMORY.md                                   |
  |  "o que vale pra sempre": seu nome, suas preferencias,         |
  |  pessoas e projetos importantes. Nao some nunca.               |
  +----------------------------------------------------------------+
  |  MEMORIA QUE ACENDE SOZINHA  ->  busca semantica (opcional)    |
  |  Lembra de coisas POR SEMELHANCA, mesmo sem a palavra exata.   |
  +----------------------------------------------------------------+
```

### Como a "memoria que acende sozinha" funciona

Imagine que voce tem milhares de bilhetes guardados. Quando voce fala um
assunto, um ajudante super-rapido procura nos bilhetes os que tem A VER com o
que voce disse — e cochicha no ouvido do assistente: "psst, lembra disso aqui".

```
  Voce diz:  "como foi a conversa sobre o Zarvanito?"
       |
       v
  [ ajudante rapido ]  -- procura por SIGNIFICADO, nao por palavra --
       |
       |  acha um bilhete de 3 meses atras que fala do assunto
       v
  [ cochicha pro assistente: "voces falaram disso em fevereiro: ..." ]
       |
       v
  Assistente responde ja sabendo do contexto antigo.
```

Isso e o que faz ele parecer que "te conhece de verdade". E opcional (precisa de
uma chave gratis do Google), mas e o efeito que mais impressiona.

---

## 5. Sessoes (a "conversa" dele)

- Enquanto voces conversam, ele lembra de tudo da conversa — e uma **sessao**.
- Se a conversa fica muito longa, o Claude **resume sozinho** o comeco pra nao
  perder o fio. Voce nem percebe.
- Se voce mandar **`/reset`** (ou `/new`), a conversa recomeca do zero.
- MAS: a **memoria em arquivos continua** depois do reset. Por isso ela importa:
  e o que sobrevive. A sessao e a conversa; a memoria e o que ele aprendeu.

```
   Sessao  =  a conversa de agora (pode ser zerada com /reset)
   Memoria =  o que ele aprendeu (fica, mesmo apos /reset)
```

---

## 6. Pra que serve no dia a dia

- Lembrar de compromissos e recados ("me lembra de ligar pro contador").
- Buscar e resumir seus e-mails / agenda / arquivos (se voce conectar o Google).
- Anotar ideias e devolver depois ("o que eu te falei semana passada sobre X?").
- Fazer tarefas no servidor, pesquisar, escrever, organizar.
- Basicamente: um assistente que e SO seu, privado, e que melhora quanto mais
  voce usa.

---

## 7. Privacidade

- So VOCE fala com ele. A "lista de permissao" do Telegram bloqueia estranhos.
- A memoria fica na SUA VPS, em arquivos seus. Nao e um servico de terceiros
  guardando seus dados.
- Voce conecta so os servicos que quiser (Google e opcional).

---

Quer ver os desenhos mais tecnicos (por dentro)? Veja `ARQUITETURA.md`.
Quer instalar passo a passo? Veja `AULA.md`.
