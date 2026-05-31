---
name: memory
description: Explica e gerencia a memoria de um assistente DG Claw — memoria curta (working-memory), longa (MEMORY.md) e a busca semantica (indice de embeddings). Use quando o usuario perguntar "como funciona a memoria", quiser ligar/reindexar a busca semantica, ver o que o assistente lembra, ou limpar/editar memoria.
user-invocable: true
---

# /dgclaw:memory — Memoria do assistente

Ajuda a entender e operar a memoria de um assistente DG Claw.

## Localizar o assistente

```bash
ls -d "$HOME"/dgclaw/*/ 2>/dev/null
```
Se houver mais de um, pergunte qual (`SLUG`); defina `WORKSPACE="$HOME/dgclaw/$SLUG"`.

## Explicar (se a pessoa perguntar "como funciona")

Sao 3 camadas, em linguagem simples:

1. **Curto prazo — `working-memory.md`**: o rascunho do "agora" (tarefas,
   contexto recente). O assistente le e escreve aqui sozinho.
2. **Longo prazo — `MEMORY.md`**: fatos que valem pra sempre (preferencias,
   pessoas, projetos). Sobrevive a `/reset`.
3. **Busca semantica (opcional)**: um indice que deixa ele lembrar por
   *semelhanca de assunto*, mesmo sem a palavra exata. Precisa de chave Gemini.

## Ver o que ele lembra

```bash
echo "--- curto prazo ---"; cat "$WORKSPACE/working-memory.md"
echo "--- longo prazo ---"; cat "$WORKSPACE/MEMORY.md"
ls "$WORKSPACE/memory/" 2>/dev/null
```

## Ligar / reindexar a busca semantica

Precisa de `GEMINI_API_KEY` (free tier: https://aistudio.google.com/apikey).

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(d=$(find "$HOME/.claude/plugins" -path '*dgclaw*/.claude-plugin/plugin.json' | head -1); cd "$(dirname "$(dirname "$d")")" && pwd)}"
export GEMINI_API_KEY="AIza..."   # cole a chave

# (re)indexa a memoria atual
DGCLAW_WORKSPACE="$WORKSPACE" python3 "$PLUGIN_ROOT/scripts/memory_index/reindex.py" --workspace "$WORKSPACE"

# testa uma busca
DGCLAW_WORKSPACE="$WORKSPACE" python3 "$PLUGIN_ROOT/scripts/memory_index/memory_search.py" "algum assunto que ele deveria lembrar"
```

Se ligou agora, grave a chave na config pra valer no servico, e reinicie:

```bash
grep -q GEMINI_API_KEY "$WORKSPACE/.dgclaw/config.sh" \
  && sed -i "s|.*GEMINI_API_KEY.*|export GEMINI_API_KEY=\"$GEMINI_API_KEY\"|" "$WORKSPACE/.dgclaw/config.sh" \
  || echo "export GEMINI_API_KEY=\"$GEMINI_API_KEY\"" >> "$WORKSPACE/.dgclaw/config.sh"
sudo systemctl restart "dgclaw-$(basename "$WORKSPACE")"
```

Reindexe de tempos em tempos (ou crie um cron) pra novas memorias entrarem na
busca. A reindexacao e incremental (so embeda o que mudou).

## Editar / limpar memoria

E so editar os arquivos `MEMORY.md` / `working-memory.md` (Edit/Write).
Depois de mexer, reindexe se a busca semantica estiver ligada. Pra zerar a
busca: apague `"$WORKSPACE/memory_index/chunks.db"` e reindexe.
