---
name: memory
description: Explica e gerencia a memoria de um assistente DG Claw — memoria curta (working-memory), longa (MEMORY.md), o recall automatico local, a consolidacao noturna e o painel de memoria. Use quando o usuario perguntar "como funciona a memoria", quiser ver/editar o que o assistente lembra, ligar a consolidacao noturna, ou abrir o painel.
user-invocable: true
---

# /dgclaw:memory — Memoria do assistente

Ajuda a entender e operar a memoria de um assistente DG Claw. **Tudo local, no
proprio Claude — sem API externa nem chave.**

## Localizar o assistente

```bash
ls -d "$HOME"/dgclaw/*/ 2>/dev/null
```
Se houver mais de um, pergunte qual (`SLUG`); defina `WORKSPACE="$HOME/dgclaw/$SLUG"`
e `CONFIG="$WORKSPACE/.dgclaw/config.sh"`. O plugin: descubra com
`PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' | head -1); cd "$(dirname "$(dirname "$d")")" && pwd)}"`.

## Explicar (se perguntarem "como funciona")

1. **Curto prazo — `working-memory.md`**: o "agora". Ele le e escreve sozinho.
2. **Longo prazo — `MEMORY.md`**: fatos duraveis. Sobrevive a `/reset`.
3. **Recall automatico**: antes de responder, um hook procura nesses arquivos
   linhas relacionadas a mensagem (busca por palavra-chave, local, instantanea) e
   injeta como lembrete. Sem chave, sem servico externo.
4. **Consolidacao noturna**: o proprio Claude organiza a memoria toda madrugada
   (promove o duradouro pro MEMORY.md, limpa o working-memory).

## Ver o que ele lembra

```bash
echo "--- curto prazo ---"; cat "$WORKSPACE/working-memory.md"
echo "--- longo prazo ---"; cat "$WORKSPACE/MEMORY.md"
ls "$WORKSPACE/memory/" 2>/dev/null
```

## Editar memoria

Edite os arquivos direto (Edit/Write) ou use o **painel** (mais facil pro leigo):

```bash
sudo bash "$PLUGIN_ROOT/scripts/install-panel-service.sh" "$CONFIG" 8200
# mostra a URL com token: http://SEU_IP:8200/?t=...
```
O que for salvo no painel grava direto nos arquivos e vale na proxima conversa.

## Consolidacao noturna

```bash
# ligar (default 04:00; pode passar outro horario, ex 03:30)
sudo bash "$PLUGIN_ROOT/scripts/install-consolidate-timer.sh" "$CONFIG" 04:00
# rodar agora pra testar
sudo systemctl start "dgclaw-$(basename "$WORKSPACE")-consolidate.service"
cat "$WORKSPACE/.dgclaw/logs/consolidate.log"
# ver agendamento
systemctl list-timers "dgclaw-*consolidate*" --no-pager
```

## Limpar / recomecar memoria

Edite ou esvazie `working-memory.md` / `MEMORY.md` (pelo painel ou na mao).
Nao ha indice/banco pra reconstruir — o recall le os arquivos direto.
