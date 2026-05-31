---
name: doctor
description: Diagnostica e conserta um assistente DG Claw que nao sobe ou nao responde no Telegram. Use quando o usuario rodar /dgclaw:doctor, disser que "o bot nao responde", "o servico fica reiniciando", "deu erro na instalacao", ou quiser checar se esta tudo certo.
user-invocable: true
---

# /dgclaw:doctor — Diagnostico e conserto

Roda uma bateria de checks nas travas conhecidas do `claude --channels` sob
systemd e conserta as automaticas (trust, skip-dangerous), apontando o que ainda
falta. Fale em portugues e seja didatico.

## Localizar o assistente

```bash
ls -d "$HOME"/dgclaw/*/ /home/*/.dgclaw 2>/dev/null
```
Ache o `config.sh` do agente (geralmente `<workspace>/.dgclaw/config.sh`). Se
houver mais de um, pergunte qual. Descubra o plugin:
`PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' | head -1); cd "$(dirname "$(dirname "$d")")" && pwd)}"`.

## Rodar o doctor

```bash
sudo bash "$PLUGIN_ROOT/scripts/doctor.sh" "<workspace>/.dgclaw/config.sh"
```

Ele imprime cada item como `[ OK ]`, `[CONSERTADO]` ou `[FALTA]`, conserta o que
da (trust + skipDangerousModePermissionPrompt) e reinicia o servico.

## Interpretar e agir

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
