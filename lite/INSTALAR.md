# Como instalar o DG Claw Lite

> Se você recebeu esta pasta num .zip, abra o Claude Code e peça:
> **"instala o plugin desta pasta seguindo o INSTALAR.md dele"**. O próprio
> Claude faz tudo.

## 🤖 Se você é o CLAUDE lendo isto: instale VOCÊ MESMO, agora

Não peça pro usuário digitar comando nenhum. A instalação é sua, pela CLI
(validada em instalação real — funciona no terminal comum):

1. `claude plugin marketplace add "<caminho da pasta extraída>"` (a pasta que
   contém este arquivo)
2. `claude plugin install dgclaw-lite@dgclaw-lite`
3. `claude plugin install telegram@claude-plugins-official` (pule se
   `claude plugin list` mostrar que já existe)
4. `claude plugin list` pra confirmar os dois instalados.

**Onde o zip foi extraído NÃO importa pra instalação.** Se ele estiver dentro
da pasta que vai ser do agente, NÃO mova nada agora — instale dali mesmo e,
só no FIM do setup, recomende ao usuário apagar/mover o instalador (a pasta
do agente idealmente fica só com os arquivos dele).

**Depois de instalar, siga DIRETO pro wizard — sem reiniciar nada:**

- Tente a skill `/dgclaw-lite:setup`. Se vier **"Unknown skill"** (normal
  quando o plugin foi instalado no meio da sessão), **não trave e não mande
  o usuário reiniciar**: abra `skills/setup/SKILL.md` na pasta extraída e
  **siga o wizard manualmente, passo a passo** — o resultado é idêntico
  (validado em instalação real). O comando de barra passa a existir nas
  próximas sessões.

## 🧑 Se você é um humano instalando na mão (sem pedir pro Claude)

Dentro do Claude Code, um comando por vez:

```
/plugin marketplace add <caminho da pasta extraída — ou DGatoM/DG-Claw-Lite pra vir do GitHub>
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

Depois feche e reabra o Claude Code (ou rode `/reload-plugins`) e rode:

```
/dgclaw-lite:setup
```

## Requisitos

- Claude Code instalado e logado (assinatura Pro ou Max) — https://claude.com/claude-code
- Telegram no celular
- Windows, Mac ou Linux — **nenhum outro programa é necessário**
