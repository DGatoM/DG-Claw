---
name: uninstall
description: Tira um assistente DG Claw do ar no servidor, desligando o servico, as rotinas e o painel, e guardando tudo num backup datado. Use quando o usuario pedir "desinstalar o DG Claw", "tirar o agente do ar", "remover o assistente da VPS", "parar tudo dele", "apagar o agente", ou rodar /dgclaw:uninstall. Por padrao preserva identidade, memoria e credenciais; com --purge move tambem os dados pro backup, sempre com confirmacao.
user-invocable: true
---

# /dgclaw:uninstall: tirar o assistente do ar

Nada e apagado aqui. Tudo o que sai do lugar vai pra uma pasta de backup datada
dentro do workspace (`.dgclaw-desinstalado-<data>/`), pra que qualquer
desinstalacao tenha volta. Diga isso ao dono logo no comeco: tira o peso da
decisao.

## Mostre o progresso

Crie os passos com TaskCreate e va marcando, pra o dono ver o que esta sendo
desfeito. Sem a ferramenta de tarefas, re-imprima o checklist.

```
[ ] 1. Achar o agente e confirmar qual e
[ ] 2. Combinar o que sai e o que fica
[ ] 3. Desligar servico, rotinas e painel
[ ] 4. (so com --purge) Mover os dados pro backup
[ ] 5. Resumo
```

## Passo 1 e 2: achar e combinar

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-dgclaw.sh"
```

Se houver mais de um agente, pergunte qual. Depois pergunte qual dos dois modos:

- **Conservador (padrao):** desliga o servico, as rotinas e o painel. Identidade,
  memoria, diarios, credenciais e arquivos das extensoes ficam onde estao.
  Reinstalar por cima devolve o agente com tudo o que ele sabia.
- **`--purge`:** alem disso, tira do workspace a identidade, a memoria, a persona,
  o planning e o `.dgclaw` inteiro, movendo tudo pro backup. O agente some da vista,
  mas os arquivos continuam la pra ele conferir.

Diga tambem o que **nao** e mexido em nenhum dos casos: o usuario do sistema
(`dgclaw-<slug>`) continua existindo, e o bot no Telegram continua existindo (quem
apaga bot e o dono, no @BotFather).

## Passo 3 e 4: executar

```bash
WS="<workspace>"
PLUGIN="$WS/.dgclaw/plugin"; [ -d "$PLUGIN/scripts" ] || PLUGIN="${CLAUDE_PLUGIN_ROOT}"

sudo bash "$PLUGIN/scripts/uninstall.sh" "$WS"            # conservador (pergunta antes)
# ou
sudo bash "$PLUGIN/scripts/uninstall.sh" "$WS" --purge    # move tambem os dados
```

O script lista as unidades que vai desligar ANTES de desligar, pede confirmacao, e
no modo `--purge` exige que o dono digite o slug do agente. Acrescente `--yes` so
quando o dono ja confirmou na conversa e voce quer evitar a pergunta repetida (no
purge a confirmacao digitada continua valendo mesmo assim).

## Passo 5: resumo

Feche com: o que foi desligado, onde ficou o backup (caminho completo), o que
continua no lugar, e como trazer de volta. No modo conservador, trazer de volta e
rodar `/dgclaw:setup` apontando pro mesmo workspace: ele volta com a memoria e a
personalidade que tinha. Lembre tambem que a pasta de backup ocupa espaco e pode
ser apagada por ele quando tiver certeza.
