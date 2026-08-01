# DG Claw Lite — seu agente pessoal no Telegram, 100% nativo

Um agente com nome, personalidade e memória, que conversa com você pelo
Telegram e roda no seu próprio computador — usando **só o que o Claude Code já
faz de fábrica**. Sem Bun, sem hooks, sem scripts, sem launcher, sem painel.
**Nenhum programa extra é instalado.**

A pasta é o agente. A sessão aberta é a vida dele.

É a versão ideal pra **aprender como um agente pessoal funciona por dentro** —
e pra aula ao vivo, onde nada pode dar errado por causa de dependência.

## Instalação

Dentro do Claude Code:

```
/plugin marketplace add DGatoM/DG-Claw-Lite
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

Depois **feche e reabra o Claude Code** (ou `/reload-plugins`) — sem isso dá
"Unknown skill" — e rode `/dgclaw-lite:setup`.

Recebeu esta pasta num **.zip**? Veja o `INSTALAR.md` (descompacte numa pasta
neutra, nunca dentro da pasta que será do agente).

O wizard cuida do resto: check-up, nome e personalidade, pasta e memória, bot
no BotFather, primeira partida com pareamento já trancado e os testes.

## Dois extras opcionais (o wizard pergunta, você decide)

**Áudio — ele escuta suas mensagens de voz** (Passo 5a). Dois caminhos: a
**Groq**, recomendada, com faixa grátis generosa (2.000 transcrições e 8h de
áudio por dia) e sem cartão — é só criar uma chave; ou **100% local**, com o
`faster-whisper`, em que o áudio não sai do seu computador (precisa de Python e,
sem placa NVIDIA, fica lento). A escolha mora num `audio.json` na pasta do
agente. Não quis? Ele avisa honesto que não escuta e pede por texto — e você liga
depois pedindo *"liga a transcrição de áudio"*.

**Google — Drive, Gmail e Agenda** (Passo 5b, ou `/dgclaw-lite:connect` quando
quiser). Usa os **connectors nativos** do Claude Code: você autoriza sua conta
no navegador, sem Google Cloud e sem OAuth na mão. Depois de autorizar, **religue
a janela** do agente pra ele enxergar as ferramentas novas.

## A cerimônia de religar

Toda vez que quiser acordar seu agente, abra o **Prompt de Comando** (tecla
Windows → `cmd` → Enter) e cole **esta linha única**:

```
cd /d "<a pasta do seu agente>" && claude --continue --channels plugin:telegram@claude-plugins-official
```

No Mac/Linux, a mesma linha sem o `/d`.

- `--continue` → retoma a MESMA conversa (é o que faz ele lembrar de tudo).
- `--channels ...` → liga o Telegram. **Sem isso o bot fica mudo.**

Quer dois cliques em vez de comando? Peça pro próprio agente: *"cria um atalho
na minha área de trabalho pra te acordar"* — ele escreve o `.bat` (Windows) ou
o `.command` (Mac) pra você.

## Memória — e você pode ler

O livro de memória de longo prazo fica **visível, em `memoria/` dentro da pasta
do agente**: `memoria/MEMORY.md` é o sumário (uma linha por assunto) e cada
assunto vira um arquivo ao lado (`familia.md`, `trabalho.md`…). São arquivos de
texto comuns — abra e leia quando quiser.

De tempos em tempos o agente arruma a casa: relê o dia, atualiza o caderninho
`working-memory.md`, promove o que virou permanente pro livro e escreve um
diário curto em `diario/` — o registro que sobra depois que o sistema apaga o
histórico bruto da conversa. **Ele mesmo controla o prazo**: passados 3+ dias,
pede sua autorização na conversa ("me autoriza? é rapidinho"). Também funciona
sob demanda: *"faz sua manutenção de memória"*.

Se algo parecer errado — ele mudo, lento ou esquecido —, rode
`/dgclaw-lite:doctor` (ou peça pra ele: *"roda seu diagnóstico"*). Ele confere a
estrutura, arruma a memória bagunçada perguntando antes de mudar e salva um
`diagnostico-<data>.md` **sem nenhum dado pessoal**, pronto pra você mandar pra
quem te deu o plugin.

## Limitações — conversa franca

- Computador desligado ou dormindo = agente dormindo. **Não é 24/7.**
- Mensagem mandada com ele desligado **se perde**. É só reenviar depois.
- **Nunca duas janelas** do agente ao mesmo tempo (erro 409, bot mudo).
- **Áudio e Google são opcionais e ficam desligados** até você ligar (Passos 5a
  e 5b). Sem áudio ligado, ele avisa que não escuta e pede por texto; sem Google
  conectado, ele diz que dá pra conectar em vez de inventar resposta.
- Tarefa agendada só roda com o computador ligado.
- **Agendamento repetitivo nativo é evitado** (bug conhecido: para de rodar em
  silêncio). O agente usa uma **corrente de avulsos** — cada rodada entrega o
  resultado e agenda a próxima; se um elo cair, é só pedir pra ele remarcar.

O `TROUBLESHOOTING.md` criado na pasta do agente resolve quase tudo, em
português e sem jargão.

## E se eu quiser mais?

- **Hooks garantidos, launcher de 1 clique e painel no navegador** → use o
  plugin `dgclaw` (v0.2), no repo irmão: https://github.com/DGatoM/DG-Claw.
- **Agente ligado 24/7**, respondendo mesmo com seu computador desligado →
  modo SERVIDOR (VPS) do `dgclaw`.
