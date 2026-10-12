# Memory Hook: "eco do passado" na DM (opt-in, default OFF)

> **Desde 01/10/2026 este hook e COMPLEMENTO, nao requisito.** O recall de fabrica e a busca em
> conversas (`scripts/memory_index/conversas_fts.py`, SQLite FTS5, sem chave), que o hook
> `hooks/memory-recall.sh` ja usa sozinho. Este documento trata so do hook SEMANTICO separado,
> que acha por significado o que a busca literal nao acha.
>
> **Desde 05/10/2026 a memoria semantica nao precisa de chave.** O modelo local EmbeddingGemma
> (instalado pelo `install.sh` ou por `scripts/install-embedding-local.sh`) e o padrao, e o
> `GEMINI_API_KEY` virou alternativa. O proprio `hooks/memory-recall.sh` ja roda a busca
> semantica rapida quando a busca em conversas nao acha nada, entao este hook so faz sentido
> para quem quer o eco em TODA mensagem. Como ligar, quanto pesa e como conferir:
> [MEMORIA-SEMANTICA.md](MEMORIA-SEMANTICA.md).

O DG Claw pode injetar um **"eco do passado"** na DM do assistente: antes de responder, um hook `UserPromptSubmit` roda a busca semantica na memoria dele e, se algo do
passado bater com a mensagem, injeta esse contexto extra (o assistente usa so se fizer sentido).

E o hook de memoria por sessao viva, generalizado e parametrizado por env `DGCLAW_*`.
**Nao tem nada hardcoded** (sem vault externo, sem path de workspace fixo, sem slug fixo).

Script: `scripts/memory_index/hook-memory-inject.sh`.

---

## Pre-requisitos

1. **Module 3 (indice semantico) instalado** no workspace: os scripts
   `memory_search_fast.py` (e/ou `memory_search.py`) e `reindex.py` em
   `DGCLAW_MEMORY_INDEX_DIR` (default `<ws>/.dgclaw/memory_index`), com o
   `chunks.db` ja gerado por `reindex.py`. Se nao existirem, o hook degrada
   gracioso (loga "nenhum script de busca" e sai 0, nao injeta nada, nao quebra a DM).
2. **Um provedor de embeddings**: o modelo local (padrao, sem chave) ou o `GEMINI_API_KEY`. O
   `embedder.py` escolhe sozinho (`DGCLAW_EMBED_PROVIDER=auto`). Sem nenhum dos dois e com o
   indice pronto, a busca ainda acha o termo escrito; sem indice, o hook loga e sai 0. Para
   conferir: `python3 scripts/memory_index/embedder.py status`.

## Gates (o hook so faz algo se TODOS passarem)

| Env | Default | Efeito |
|-----|---------|--------|
| `DGCLAW_MEMORY_HOOK` | `0` (OFF) | `=1` liga o hook. Default desligado. |
| `DGCLAW_PRIVATE_CONTEXT` | `0` | `=1` so em sessao PRIVADA do dono (DM). Spawns publicos (ronda/post) nao setam -> nada injetado. |
| `DGCLAW_EMBED_PROVIDER` | `auto` | `local`, `gemini` ou `off`. Em `auto`, o modelo local vence; o Gemini entra se nao houver modelo local e houver chave. |
| `DGCLAW_MEMORY_INDEX_DIR` | `<ws>/.dgclaw/memory_index` | onde estao os scripts de busca + `chunks.db`. |
| `DGCLAW_MEMORY_HOOK_TIMEOUT` | `3` | timeout duro (segundos) da busca, pra nao travar a DM. |

Qualquer gate que falhe => `exit 0` sem output (DM segue normal).

## Envs de infra (nao-gate, usadas pelos crons/timers/uninstall)

Estas nao ligam/desligam o hook, mas sao necessarias pro plugin rodar fora da maquina de dev:

| Env | Default | Usada por | Efeito |
|-----|---------|-----------|--------|
| `DGCLAW_PLUGIN_ROOT` | (raiz do plugin DG Claw) | timers/crons (`install-life-timers.sh`, `reflection.sh`, `doctor.sh`, `install-ig-timers.sh`, ...) | caminho estavel da instalacao do plugin DG Claw. Os timers chamam os scripts por aqui. |
| `DGCLAW_CONFIG` |, | hook e crons | aponta pro `.dgclaw/config.sh` (carrega `DGCLAW_WORKSPACE/SLUG/GEMINI...`). |
| `DGCLAW_PLUGIN_ROOT` | (auto-detect / fallback minimo) | `uninstall.sh` | raiz do plugin DG Claw, pra restaurar o `working-memory.md` no formato original ao desinstalar. Sem ela, o uninstall tenta candidatos conhecidos e, em ultimo caso, gera um template minimo (nunca falha). |

---

## Como LIGAR (duas opcoes: ambas opt-in)

O hook nunca liga sozinho. O dono escolhe registrar e setar as envs. **Nao edite o
dgclaw-plugin**, as duas opcoes abaixo vivem no lado DG Claw / workspace.

### Opcao A (recomendada): workspace `.claude/settings.json`

No `.claude/settings.json` do workspace do assistente, adicione:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${DGCLAW_PLUGIN_ROOT}/scripts/memory_index/hook-memory-inject.sh\" \"${DGCLAW_CONFIG}\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

E no **launch da sessao viva** (o script que sobe o `claude --channels` do assistente),
exporte os gates ANTES de subir o `claude`:

```sh
export DGCLAW_MEMORY_HOOK=1
export DGCLAW_PRIVATE_CONTEXT=1      # SO na sessao privada do dono (DM)
# DGCLAW_CONFIG ja deve apontar pro .dgclaw/config.sh (tem WORKSPACE/SLUG/GEMINI)
```

Vantagem: o registro vive no workspace (sob controle do dono), o gate `DGCLAW_MEMORY_HOOK`
garante default-OFF, e passar `"${DGCLAW_CONFIG}"` faz o hook herdar `DGCLAW_*` e
`GEMINI_API_KEY` mesmo que o ambiente do Claude nao os tenha.

### Opcao B: `hooks/hooks.json` proprio do plugin DG Claw

Um plugin Claude Code pode declarar hooks proprios (igual o dgclaw-plugin faz no
`hooks/hooks.json`). Se quiser que o registro viaje junto com o plugin DG Claw, crie
`hooks/hooks.json` na raiz do plugin:

```json
{
  "description": "DG Claw, eco do passado (memoria semantica) na DM. Opt-in via DGCLAW_MEMORY_HOOK=1.",
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/memory_index/hook-memory-inject.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

> Importante: um hook declarado no plugin dispara em **toda** sessao que carregar o plugin
> DG Claw. Por isso o gate `DGCLAW_MEMORY_HOOK=1` (default OFF) + `DGCLAW_PRIVATE_CONTEXT=1`
> sao o que efetivamente liga. Sem as envs, o hook sai 0 imediatamente, inerte.
> Como a opcao B muda o comportamento default de instalacoes existentes do plugin, ela
> e marcada como **follow-up**: prefira a Opcao A (registro por-workspace, mais cirurgico)
> ate validarmos a opcao B numa instalacao limpa.

---

## Garantias de seguranca

- **Nunca quebra a DM**: todo caminho de erro/timeout/ausencia faz `exit 0` sem output.
- **Default OFF**: sem `DGCLAW_MEMORY_HOOK=1`, nao faz nada.
- **So privado**: sem `DGCLAW_PRIVATE_CONTEXT=1`, nao injeta memoria pessoal.
- **Timeout duro** (~3s) pra nao atrasar a resposta do assistente.
- **Degrada gracioso** sem provedor de embeddings ou sem indice, apenas loga e sai 0.

Log: `<ws>/.dgclaw/logs/hook-memory-inject.log`.

---

## Status / follow-up

- [x] Script do hook entregue (`scripts/memory_index/hook-memory-inject.sh`), com gates e
      degradacao graciosa.
- [x] Reflexao (`scripts/reflection.sh`) anexa "Eco do passado" no poke quando ha indice
      (desde 05/10/2026 sem exigir Gemini).
- [x] Indice semantico de fabrica: timer `memory-reindex` (04:20) e modelo local instalado pelo
      `install.sh`. Ver [MEMORIA-SEMANTICA.md](MEMORIA-SEMANTICA.md).
- [] **Follow-up**: depende do Module 3 (reindex/memory_search no DG Claw) para o hook ter
      o que buscar. Ate la, o hook fica inerte (sai 0).
- [ ] **Follow-up**: decidir entre Opcao A (workspace settings, default) e Opcao B
      (`hooks/hooks.json` do plugin), ver nota acima. O wiring NAO foi ligado
      automaticamente para nao alterar instalacoes existentes.
