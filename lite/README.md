# DG Claw Lite — seu agente pessoal, 100% nativo

Um agente com nome, personalidade e memória, que roda no seu próprio computador e
conversa com você **pelo Telegram ou só pelo terminal** — usando o que o Claude
Code já faz de fábrica. Sem hooks, sem scripts, sem launcher, sem painel. A pasta
é o agente, a sessão aberta é a vida dele. É a versão ideal pra **aprender como um
agente pessoal funciona por dentro** e pra aula ao vivo.

## Instalação — pela skill (recomendado)

Não precisa instalar plugin. Descompacte o `.zip`, abra o **Claude Code** na pasta
onde você quer criar o seu agente e peça:

```
Vá até a pasta de downloads, pegue o zip que eu acabei de baixar — é um plugin chamado DG Claw —, traga pra cá e instale seguindo a skill de setup.
```

O pacote é uma **skill**: um manual (`skills/setup/SKILL.md`) que o Claude Code lê
e vai executando com você — check-up, nome e personalidade, memória, bot no
Telegram (se quiser), primeira partida e testes. Detalhes no `INSTALAR.md`. Usar o
modelo **Opus 5** e a **aprovação automática de ações** reduz as idas e vindas.

**Como plugin (opcional)**, só pra ter o comando `/dgclaw-lite:setup` sempre à
mão: no Claude Code, um por vez, `/plugin marketplace add DGatoM/DG-Claw-Lite`,
`/plugin install dgclaw-lite@dgclaw-lite` e
`/plugin install telegram@claude-plugins-official`; depois `/reload-plugins`.

## Requisitos

Claude Code logado (Pro ou Max). **O Telegram é opcional** — dá pra usar o agente
só pelo terminal, e o wizard pergunta o que você prefere. Pra usar o Telegram é
preciso ter o **bun** (https://bun.sh), que faz o canal funcionar: sem ele o bot
fica mudo sem dar erro nenhum — o wizard confere e ajuda a instalar.

## Dois extras opcionais (o wizard pergunta, você decide)

**Áudio — ele escuta suas mensagens de voz** (Passo 5a, só com Telegram). Dois
caminhos: a **Groq**, recomendada, com faixa grátis generosa e sem cartão; ou
**100% local**, com o `faster-whisper` (precisa de Python e, sem placa NVIDIA,
fica lento). Dá pra ligar depois: *"liga a transcrição de áudio"*.

**Google — Drive, Gmail e Agenda** (Passo 5b, ou `/dgclaw-lite:connect` quando
quiser). Usa os **connectors nativos** do Claude Code: você autoriza sua conta no
navegador, sem Google Cloud e sem OAuth na mão. Depois de autorizar, **religue a
janela** do agente pra ele ver as ferramentas novas.

## A cerimônia de religar

Toda vez que quiser acordar seu agente, abra o **Prompt de Comando** (tecla
Windows → `cmd` → Enter) e cole **esta linha única**:

```
cd /d "<a pasta do seu agente>" && claude --continue --channels plugin:telegram@claude-plugins-official
```

No Mac/Linux, a mesma linha sem o `/d`; só no terminal, a mesma linha **sem o
`--channels ...`**. O `--continue` retoma a MESMA conversa (é o que faz ele
lembrar de tudo) e o `--channels` liga o Telegram — sem ele, o bot fica mudo.
Quer dois cliques em vez de comando? Peça pro próprio agente: *"cria um atalho na
minha área de trabalho pra te acordar"*.

## Memória — e você pode ler

O livro de memória de longo prazo fica **visível, em `memoria/` dentro da pasta do
agente**: `memoria/MEMORY.md` é o sumário e cada assunto vira um arquivo ao lado
(`familia.md`, `trabalho.md`…) — arquivos de texto comuns, que você pode abrir.

De tempos em tempos o agente arruma a casa: relê o dia, atualiza o caderninho
`working-memory.md`, promove o que virou permanente pro livro e escreve um diário
curto em `diario/`. **Ele mesmo controla o prazo**: passados 3+ dias, pede sua
autorização. Também funciona sob demanda: *"faz sua manutenção de memória"*. E se
algo parecer errado — ele mudo, lento ou esquecido —, rode `/dgclaw-lite:doctor`
(ou peça: *"roda seu diagnóstico"*): ele confere a estrutura, arruma a memória
bagunçada perguntando antes de mudar e salva um `diagnostico-<data>.md` **sem
nenhum dado pessoal**.

## Limitações — conversa franca

- Computador desligado ou dormindo = agente dormindo. **Não é 24/7**, e mensagem
  mandada com ele desligado **se perde** — é só reenviar depois.
- **Nunca duas janelas** do agente ao mesmo tempo (erro 409, bot mudo), e **sem o
  `bun` o canal do Telegram não sobe** — o bot fica mudo sem avisar.
- **Áudio e Google são opcionais** e ficam desligados até você ligar; tarefa
  agendada só roda com o computador ligado.
- **Agendamento repetitivo nativo é evitado** (bug conhecido: para de rodar em
  silêncio). O agente usa uma **corrente de avulsos** — cada rodada entrega o
  resultado e agenda a próxima; se um elo cair, é só pedir pra ele remarcar.

O `TROUBLESHOOTING.md` criado na pasta do agente resolve quase tudo.

## E se eu quiser mais?

Hooks garantidos, launcher de 1 clique e painel no navegador → plugin `dgclaw`
(v0.2): https://github.com/DGatoM/DG-Claw. Agente ligado 24/7, respondendo com seu
computador desligado → modo SERVIDOR (VPS) do `dgclaw`.
