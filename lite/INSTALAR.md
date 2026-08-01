# Como instalar o DG Claw Lite

> Se você recebeu esta pasta num .zip, abra o Claude Code e peça:
> **"instala o plugin desta pasta seguindo o INSTALAR.md dele"**. O próprio
> Claude faz tudo.

## 🤖 Se você é o CLAUDE lendo isto: instale você mesmo (com o fallback certo)

**Degrau 1 — CLI (tente primeiro, UMA vez cada):**

1. `claude plugin marketplace add "<caminho da pasta extraída>"` (a pasta que
   contém este arquivo)
2. `claude plugin install dgclaw-lite@dgclaw-lite`
3. `claude plugin install telegram@claude-plugins-official`
4. `claude plugin list` pra confirmar.

**Degrau 2 — se QUALQUER comando for bloqueado por permissão** (o Claude Code
trata mexer na própria configuração como ação sensível; acontece em muitas
máquinas e é normal): **não tente de novo, não explique arquitetura de
segurança, não desista.** Diga apenas: *"essa parte o Claude Code exige que
venha de você — cola estas 3 linhas aqui no chat, UMA por vez, esperando cada
uma terminar"* e entregue exatamente:

```
/plugin marketplace add <caminho da pasta extraída>
/plugin install dgclaw-lite@dgclaw-lite
/plugin install telegram@claude-plugins-official
```

Comando de barra digitado pelo dono no chat **sempre funciona** — não passa
por permissão nem hook. Depois confirme com `claude plugin list` (só leitura,
você pode rodar) e siga em frente.

**Onde o zip foi extraído NÃO importa.** Se estiver dentro da pasta que vai
ser do agente, NÃO mova nada agora — instale dali e, só no FIM do setup,
recomende apagar/mover o instalador.

**Instalou? Siga DIRETO pro wizard — sem reiniciar nada:**

- Tente a skill `/dgclaw-lite:setup`. Se vier **"Unknown skill"** (normal
  quando o plugin foi instalado no meio da sessão), **não trave e não mande
  reiniciar**: abra `skills/setup/SKILL.md` na pasta extraída e **siga o
  wizard manualmente, passo a passo** — o resultado é idêntico (validado em
  instalação real). O comando de barra passa a existir nas próximas sessões.

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
