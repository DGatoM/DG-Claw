# A aba Conversa do painel

**Estado: no ar em 10/08/2026**, provada contra um agente vivo (um agente de cliente), com o gate de
navegador verde em 1440 e em 390.

O painel deixou de ser só uma janela para olhar o agente. A primeira aba agora é a
conversa com ele, e ela abre por padrão, porque é o que a dona vem fazer aqui.

---

## A decisão que manda em tudo: uma fonte só

**A conversa É o transcript da sessão viva** (o `.jsonl` do Claude Code). Não existe
banco de mensagens do painel, e isso não é economia, é desenho.

Três consequências, e vale saber as três antes de mexer em qualquer coisa aqui:

1. **O Telegram e o painel aparecem na mesma lista, em ordem, sem sincronizar nada.**
   Os dois caem na mesma sessão. Ler o transcript uma vez já devolve a conversa
   inteira, marcada por origem.
2. **Plugar o Telegram depois não perde nem duplica nada.** Quem nunca plugou um bot
   vê só o painel; no dia em que plugar, as duas origens passam a aparecer juntas. Não
   há dado para migrar.
3. **Não há duas verdades para divergirem.** Uma tabela paralela seria uma segunda
   versão da conversa que um dia discorda da primeira.

Precedente em produção: o `dg-telegram` (Flask :4045) serve a thread da Isa assim
desde 01/08/2026.

---

## As peças

| Peça | Onde | O que faz |
| --- | --- | --- |
| O leitor | `scripts/_lib/thread_log.py` | reconstrói a conversa do transcript, das duas origens |
| O motor | `scripts/_lib/inject.py` | acha a sessão, diz se está viva, escreve nela e freia |
| A cola | `panel/lib/conversa.js` | chama os dois, com cache, e traduz estado em frase de gente |
| As rotas | `panel/server.js` | `GET /api/chat/mensagens`, `POST /api/chat/mensagem`, `POST /api/chat/parar` |
| A tela | `panel/public/` | a aba, as bolhas, o sinal de vida e o botão de parar |

**O painel não reimplementa nem o leitor nem o motor**, e é isto que faz o conserto
valer para todo mundo: a tela, os crons de vida e os self-crons da persona enxergam
exatamente a mesma sessão.

### O motor: três mundos, um injetor

`inject.py` ganhou um terceiro modo, e o default agora se decide sozinho:

| Modo | Quando | Como escreve |
| --- | --- | --- |
| `tiocsti` | DG Claw sozinho, sessão `claude --channels` neste host | ioctl no `/dev/pts` (exige root) |
| `tmux` | opt-in portável | `tmux send-keys` |
| `bunker` | a sessão é um **card do painel do Bunker** (gestor e agente entregue) | HTTP no painel |

Sem `DGCLAW_INJECT_MODE`, ter `DGCLAW_BUNKER_CARD` definido já escolhe `bunker`.

**Por que o modo `bunker` existe:** um card não tem `--channels` no argv nem pts para
achar, então os dois modos antigos diziam "sessão morta" e o cron virava no-op **em
silêncio**. Três coisas travavam nesse mesmo ponto: a aba Conversa, os self-crons da
persona e as rotinas de vida. Um card é uma sessão viva legítima, e passou a ser
tratada como tal.

⚠️ **`DGCLAW_BUNKER_URL` nunca sai de `SERVER_PORT`.** Uma sessão que roda dentro de
um card da instância de administração exporta `SERVER_PORT=4201`, e herdar isso em
silêncio manda o recado para o painel errado, onde o card nem existe.

### Comandos novos do injetor

```bash
inject.py --slug <slug> --check        # a sessão está viva? (exit 0 / 2)
inject.py --slug <slug> --transcript   # onde a conversa está gravada (stdout)
inject.py --slug <slug> --stop         # ESC: interrompe o turno em voo
```

---

## Configuração

No `config.json` do painel (ou por env, que tem precedência):

| Chave | Env | Para quê |
| --- | --- | --- |
| `chat` | `DGCLAW_CHAT_ID` | o id da conversa no envelope. Default `c_<slug>` |
| `bunkerCard` | `DGCLAW_BUNKER_CARD` | o card, quando a sessão vive no Bunker |
| `bunkerUrl` | `DGCLAW_BUNKER_URL` | o painel do Bunker. Default `http://127.0.0.1:4001` |

Sem `bunkerCard`, o painel opera um DG Claw sozinho e o injetor usa TIOCSTI.

---

## Quatro decisões da tela

1. **Uma conversa só, sem "novo chat".** A sessão do agente é uma e continua. Um botão
   de começar do zero prometeria um recomeço que não existe.
2. **A mensagem enviada não aparece por otimismo.** A bolha só nasce quando o servidor
   confirma que ela entrou na sessão. Bolha otimista mostraria como enviada uma
   mensagem que ficou pelo caminho, e a pessoa esperaria uma resposta que nunca viria.
   Pelo mesmo motivo, a caixa de texto **só se limpa depois da confirmação**.
3. **A altura é repartida por flex, e a medida é `svh`.** No celular a barra do
   navegador entra e sai, e qualquer `calc(100vh - <número mágico>)` deixa a caixa de
   escrever onde o polegar não alcança. No palco pequeno quem limita é a **altura**.
4. **`trabalhando: null` quer dizer "não medido", e nunca vira "pronto".** Dizer
   "pronta para o que você precisar" sem ter medido é a mentira que faz a pessoa
   mandar mensagem para um agente que não vai responder.

---

## O defeito que o botão de parar revelou

O ESC **interrompe de verdade**, mas **não dispara o hook `Stop`**. Consequência
medida em 10/08/2026, logo no primeiro teste do botão:

1. o card do Bunker fica marcado como `working` **para sempre**, então a tela mostraria
   "está trabalhando nisso agora" eternamente, que é exatamente o spinner que esta fase
   existe para matar;
2. pior: a mensagem **seguinte** ficava presa. Ela é enviada com "entregue quando ele
   ficar ocioso", e o ocioso nunca chegava, então o recado esperava para sempre e a
   pessoa aguardava resposta de algo que o agente nunca viu.

**O conserto no painel** usa o sinal honesto, que é o `[Request interrupted by user]`
gravado pelo próprio Claude Code no transcript (`foiInterrompido()` em
`panel/lib/conversa.js`). Com ele, a tela diz "parou porque você pediu", e o envio
seguinte digita direto em vez de entrar na fila. Serve também para quem apertou ESC
pelo terminal.

**O conserto definitivo é no `bunker-server`** (mapear o evento para o status). É o
mesmo defeito do `/compact`, que também deixa o card preso em "trabalhando" e ainda faz
o vigia abrir um escalonamento de "travado" que é falso. Os dois se consertam juntos,
num restart só.

---

## Os aceites

```bash
python3 scripts/_lib/test_thread_log.py        # 15 itens, sem agente vivo, sem rede
node panel/qa-conversa.mjs --url <painel> --senha <senha>            # navegador, 1440 e 390
node panel/qa-conversa.mjs --url <painel> --senha <senha> --escrever # + o ciclo real
```

A bancada do leitor monta transcripts de mentira num temporário e confere o que sai. É
o teste que importa mais aqui, porque um extrator errado **não dá erro nenhum**: ele só
devolve uma conversa a menos, e ninguém percebe até a pessoa reclamar que sumiu
mensagem.

`--escrever` fica **fora do padrão de propósito**: ele fala com o agente vivo, gasta um
turno da assinatura e deixa ruído na conversa da pessoa.

---

## O que ainda falta para a aluna

Numa VPS **sem Bunker**, o agente ainda não tem como responder ao painel: a tool de
resposta (`mcp__dgchat__reply`) hoje vem do `agents-server`. Uma mensagem escrita no
painel chega no agente, e a resposta dele não chega em ninguém. Falta portar o servidor
MCP do DG Chat para cá (sem dependência, entrando no `--mcp-config` do `launch.sh`).
Isso é requisito da release v0.5, não do aceite com o agente de cliente.
