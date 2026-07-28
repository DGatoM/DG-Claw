---
name: doctor
description: Diagnostica e conserta um assistente DG Claw que nao sobe ou nao responde no Telegram. Use quando o usuario rodar /dgclaw:doctor, disser que "o bot nao responde", "o servico fica reiniciando", "deu erro na instalacao", ou quiser checar se esta tudo certo.
user-invocable: true
---

# /dgclaw:doctor — Diagnostico e conserto

Fale em portugues e seja didatico. Primeiro descubra o MODO do agente:

- **MODO LOCAL** (computador da pessoa; existe `.dgclaw/config.json` na pasta
  do agente) → siga "Modo local" logo abaixo.
- **MODO SERVIDOR** (VPS/systemd; existe `.dgclaw/config.sh`) → siga
  "Modo servidor" mais abaixo (fluxo v0.1, inalterado).

## Modo local

Na pasta do agente (procure `Agente*/.dgclaw/config.json` no home se preciso):

```bash
cd "<pasta do agente>" && bun .dgclaw/scripts/doctor.ts
```

Ele valida token (getMe), limpa sozinho o cache needs-auth que deixa o canal
mudo, detecta 409 (launcher aberto 2x), sessao fechada, hooks nao registrados
e pareamento pendente. Interprete cada [FALTA] em linguagem simples:

- **token invalido/ausente** → refazer o passo do BotFather do wizard.
- **sessao nao esta rodando** → abrir o launcher `Iniciar <Nome>`.
- **outro processo no token (409)** → fechar TODAS as janelas do agente e
  abrir o launcher UMA vez.
- **[CONSERTADO] cache needs-auth** → fechar e reabrir o launcher.
- **hooks nao registrados** → rodar o scaffold do wizard de novo (nao apaga
  nada que ja existe: pareamento e memoria ficam).

Se tudo `[ OK ]`: "esta tudo certo, manda uma mensagem pro bot".

## Modo servidor

Roda uma bateria de checks nas travas conhecidas do `claude --channels` sob
systemd e conserta as automaticas (trust, skip-dangerous), apontando o que ainda
falta.

### Localizar o assistente

```bash
ls -d "$HOME"/dgclaw/*/ /home/*/.dgclaw 2>/dev/null
```
Ache o `config.sh` do agente (geralmente `<workspace>/.dgclaw/config.sh`). Se
houver mais de um, pergunte qual. Descubra o plugin:
`PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' | head -1); cd "$(dirname "$(dirname "$d")")" && pwd)}"`.

### Rodar o doctor

```bash
sudo bash "$PLUGIN_ROOT/scripts/doctor.sh" "<workspace>/.dgclaw/config.sh"
```

Ele imprime cada item como `[ OK ]`, `[CONSERTADO]` ou `[FALTA]`, conserta o que
da (trust + skipDangerousModePermissionPrompt) e reinicia o servico.

### Interpretar e agir

Para cada `[FALTA]`, explique em linguagem simples e resolva:

- **claude/bun ausente** → instalar (bun: `curl -fsSL https://bun.sh/install | bash`).
- **plugin telegram nao esta no config dir do servico** → a causa raiz mais comum.
  Rode o `claude plugin install telegram@claude-plugins-official` no MESMO config
  dir que o servico usa (o doctor mostra o comando exato). Lembre: o servico usa
  o config dir padrao (`~/.claude`) a menos que `DGCLAW_CLAUDE_CONFIG_DIR` esteja
  setado no `config.sh`.
- **unit sem PTY / sem IS_SANDBOX** → reinstale: `sudo bash "$PLUGIN_ROOT/scripts/install-service.sh" "<config.sh>"`.
- **servico nao ativo** → veja `journalctl -u dgclaw-<slug> -n 40` e cite o erro.
- **Telegram nao pareado** → peca pra pessoa mandar msg pro bot e aprove (o wizard
  faz isso lendo o pending do `access.json`).

No fim, se tudo ficou `[ OK ]`, confirme: "esta tudo certo, manda uma mensagem
pro bot". Se sobrou algo, liste os itens que faltam pra terminar.
