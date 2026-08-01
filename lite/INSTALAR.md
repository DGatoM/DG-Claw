# Como instalar o DG Claw Lite

O DG Claw Lite é uma **skill**: um manual de instruções em texto que o Claude Code
lê e vai executando junto com você, passo a passo. Nada é instalado no seu sistema.

## Onde rodar

Ele roda dentro do **Claude Code** — o Claude que trabalha na sua máquina. Você
abre o Claude Code no terminal (no Windows: aperte a tecla **Windows**, digite
`cmd`, dê **Enter**) ou na aba **Claude Code** do aplicativo Claude Desktop.

No chat comum do site ou do app (fora do Claude Code) os comandos de barra, como
`/plugin`, não existem e não há acesso aos arquivos do seu computador.

## Instalação recomendada — pela skill

1. Descompacte o `.zip` numa pasta qualquer (a de Downloads serve).
2. Abra o Claude Code **na pasta onde você quer criar o seu agente**.
3. Cole este pedido no chat:

```
Vá até a pasta de downloads, pegue o zip que eu acabei de baixar — é um plugin chamado DG Claw —, traga pra cá e instale seguindo a skill de setup.
```

O wizard de instalação é o arquivo `skills/setup/SKILL.md`, dentro do pacote. É
ele que o Claude Code lê e segue com você: check-up da máquina, nome e
personalidade do agente, memória, bot do Telegram (se você quiser) e o comando de
religar. Não é preciso instalar plugin nenhum pra isso funcionar.

## O que aumenta a chance de dar certo de primeira

Observação de instalações reais: usar o modelo **Opus 5** e deixar ligado o **modo
de aprovação automática de ações** reduz bastante as idas e vindas. Com aprovação
manual funciona igual — só que você precisa autorizar cada passo na tela.

## Instalação opcional como plugin

Isto não é necessário. Serve só pra deixar o comando `/dgclaw-lite:setup`
disponível nas próximas sessões do Claude Code. Digite você mesmo, no Claude Code,
**um comando por vez**, esperando cada um terminar:

```
/plugin marketplace add <caminho da pasta descompactada>
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

Depois rode `/reload-plugins`, ou feche e reabra o Claude Code.

## Requisitos

- **Claude Code** instalado e logado, com assinatura Pro ou Max —
  https://claude.com/claude-code
- **Telegram é opcional.** Dá pra conversar com o agente só pelo terminal do
  computador; o wizard pergunta o que você prefere.
- **bun** (https://bun.sh) — necessário **apenas** se você for usar o Telegram, que
  é o programa que faz o canal funcionar. O wizard confere e ajuda a instalar.
- Windows, Mac ou Linux.
