---
name: memory
description: Busca em conversas antigas e na memoria do agente DG Claw, e explica e gerencia essa memoria (working-memory, MEMORY.md, memory/, consolidacao da madrugada, indice da busca). Use SEMPRE que o dono perguntar sobre algo do passado ("lembra quando...", "o que eu falei sobre...", "aquela vez que...", "voce lembra do...", "ja te contei de...", "quando foi que a gente..."): busque antes de responder, e nunca invente. Use tambem quando alguem perguntar "como funciona a memoria", quiser ver ou editar o que o agente lembra, conferir se a consolidacao noturna rodou, ou ligar e reconstruir o indice da busca.
user-invocable: true
---

# /dgclaw:memory: a memoria do agente

Tudo local: nenhuma chave, nenhum servico de fora. A busca semantica com `GEMINI_API_KEY`
existe como complemento opcional; a busca em conversas funciona sem ela.

## 1. Buscar no passado (o agente, quando o dono pergunta)

Quando o dono disser "lembra quando...", "o que eu falei sobre...", "aquela vez que...",
procure ANTES de responder. Rode da pasta do agente (o workspace):

```bash
python3 .dgclaw/plugin/scripts/memory_index/conversas_fts.py buscar "palavras do assunto" --limite 5
```

- Use 1 a 3 palavras que estariam no trecho: nomes, numeros, termos ("Bradesco patrocinio",
  "cena 13"). Acento nao importa.
- `--desde AAAA-MM-DD` corta o que e mais antigo; `--so conversas` ou `--so memoria` filtra.
- Cada resultado vem como `[data hora · canal · quem] trecho com o «termo» destacado`. Cite a
  data na resposta ("em 02/09 voce me disse que...").
- Nada encontrado: tente outra palavra (sinonimo, nome proprio). Se ainda nao achar, diga com
  franqueza que nao achou. Nunca preencha com palpite.
- Fora da pasta do agente: `--workspace <pasta>` antes de `buscar`, ou `DGCLAW_WORKSPACE`.

Lembrete automatico: quando o dono escreve, o hook pode trazer sozinho ate 3 trechos marcados
"CONVERSAS E MEMORIA RELACIONADAS". E dica, nao ordem: use se fizer sentido. Ele so dispara para
fala do dono por um canal (nunca para recado de rotina) e so quando o casamento e bom.

## 2. Como a memoria funciona (para explicar a um leigo)

| Camada | Onde | Para que |
|---|---|---|
| Caderno do dia | `working-memory.md` | objetivos do dono, tarefas em andamento, o que o agente sabe dele, ultimas conversas, hoje, ontem |
| Fatos de longo prazo | `MEMORY.md` | o que vale pra sempre, uma linha cada |
| Pastas por assunto | `memory/` | diario de cada dia (`AAAA-MM-DD.md`), assuntos, skills aprendidas |
| Busca em conversas | `.dgclaw/memory_index/conversas.db` | acha qualquer conversa ou anotacao antiga pela palavra |

A madrugada, em duas etapas:
- **23:30, reflexao:** o proprio agente rele o dia, escreve o diario, atualiza objetivos,
  tarefas e o que sabe do dono, e deixa um resumo do dia na secao "Hoje".
- **7:00, remontagem:** a maquina (sem IA) vira "Hoje" em "Ontem", refaz "Agora" e "Ultimas
  conversas" e atualiza o indice da busca. Durante o dia, o batimento refresca "Agora" e
  "Ultimas conversas" a cada 30 minutos, e o indice anda a cada 15.

## 3. Ver e conferir (o administrador)

Ache o agente com `bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-dgclaw.sh"` (cada linha e
`slug|workspace|config|...`). Com `WS` e `CFG` em maos:

```bash
cat "$WS/working-memory.md"                     # o caderno do dia
cat "$WS/MEMORY.md"                             # longo prazo
ls "$WS/memory/"                                # diarios e assuntos
python3 "$WS/.dgclaw/plugin/scripts/memory_index/conversas_fts.py" --workspace "$WS" status
tail -20 "$WS/.dgclaw/logs/reflection.log"      # a reflexao foi entregue?
tail -20 "$WS/.dgclaw/logs/build-wm.log"        # a remontagem reclamou de algo?
```

**A prova de que a reflexao rodou e o diario de ontem** (`memory/<ontem>.md`), nao o log. O log
diz que o recado foi ENTREGUE na sessao; se o diario nao apareceu, a sessao nao executou (veja
`docs/EMERGENCIA.md`, secao 3.9, "a memoria parou"). O `doctor.sh` confere isso sozinho.

## 4. Editar

Pelos arquivos (Edit) ou pelo painel, que grava direto nos mesmos arquivos e vale na proxima
conversa. Nas secoes do topo da working-memory, mantenha o formato: uma linha por item, com a
data. "Ultimas conversas" e "Agora" nao se editam: a maquina refaz.

Se a working-memory passar do tamanho (9 KB), o que nao cabe vai para
`memory/wm-transbordo.md`, nunca para o lixo; a reflexao decide o que volta.

## 5. O indice da busca

```bash
bash "$WS/.dgclaw/plugin/scripts/conversas-fts.sh" "$CFG"        # atualiza agora (incremental)
python3 "$WS/.dgclaw/plugin/scripts/memory_index/conversas_fts.py" --workspace "$WS" reindex --do-zero   # rele tudo
systemctl list-timers "dgclaw-*-conversas-fts*" --no-pager       # a rotina de 15 em 15 min
```

- Desligada com "indice ainda nao criado": rode a primeira linha (ou espere o build das 7h).
- "nao tem FTS5": o Python da maquina nao tem o SQLite completo; enquanto isso o lembrete
  automatico usa a busca simples por palavra nos arquivos. No Ubuntu e no Debian ele ja vem.
- O indice NAO esquece conversa quando o Claude Code limpa transcript antigo: e de proposito.
  Arquivo de memoria apagado sai do indice.
- O banco e conversa crua do dono: fica com permissao 600 e nunca vai para fora da maquina.

## 6. Consolidacao antiga (so instalacoes de antes da reflexao)

O timer `dgclaw-<slug>-consolidate` (04:00, `consolidate.sh`) foi substituido pela reflexao das
23:30, e o `install-timers.sh` desliga ele sozinho. Se os dois estiverem ligados, o `doctor.sh
--fix` desliga o antigo.
