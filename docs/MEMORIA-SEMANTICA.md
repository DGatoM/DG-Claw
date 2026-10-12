# Memória semântica: o agente acha o que o dono disse, mesmo com outras palavras

## O que é, para o dono

O agente guarda o que aprende em arquivos (`MEMORY.md`, a `working-memory.md` e um diário
por dia em `memory/`). A **busca em conversas** acha uma lembrança quando a palavra é a
mesma. A **memória semântica** acha pelo sentido: o dono pergunta "quando eu marquei com o
contabilista?" e ela acha o diário que diz "o contador Paulo marcou a reunião de quinta".

Vem **ligada de fábrica, sem conta, sem chave e sem custo**: um modelo pequeno do Google
(EmbeddingGemma 300M) roda na própria VPS. Nenhum texto da memória sai da máquina.

## Como funciona

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Instalador | `scripts/install-embedding-local.sh` | Baixa uma vez o llama.cpp (18 MB, binário pronto) e o modelo (333 MB), confere os dois por SHA-256 e testa. Como root instala em `/opt/dgclaw/embed`, que todos os agentes da máquina usam. |
| Provedor | `scripts/memory_index/embedder.py` | Escolhe quem transforma texto em vetor: o modelo local, o Gemini ou nenhum. `python3 embedder.py status` diz qual está valendo e por quê. |
| Índice | `scripts/memory-reindex.sh` (e `reindex.py`) | Corta a memória em trechos de 200 palavras e guarda o vetor de cada um em `.dgclaw/memory_index/chunks.db`. Incremental: só trecho novo ou mudado. Roda de madrugada. |
| Busca | `memory_search.py` e `memory_search_fast.py` | **Termo exato primeiro, vetor depois** (ver abaixo). Usada pela reflexão da noite e pelo eco do passado na conversa. |

**Quem liga e quem cuida, sem ninguém pedir:**

| Momento | Onde | O que acontece |
| --- | --- | --- |
| Instalação | `install.sh`, passo 7b | Baixa o modelo para a máquina toda. Se falhar, avisa e segue: a busca em conversas funciona sem ele. |
| Wizard | `/dgclaw:setup`, passo 9.3 | Confere o modelo, faz o primeiro índice do agente e diz ao dono se a memória semântica ficou ligada. |
| Toda madrugada | timer `dgclaw-<slug>-memory-reindex`, 04:20 | Reindex incremental, com `nice` e `ionice`, para não disputar a CPU com a conversa. |
| Cada mensagem do dono | `hooks/memory-recall.sh` | Só quando a busca em conversas não acha nada e a mensagem tem palavra estranha: roda a busca rápida, com teto de 3 s e no máximo ~700 caracteres de lembrete. `DGCLAW_SEMANTIC_RECALL=off` desliga. |
| Toda noite | `scripts/reflection.sh` | "Eco do passado": busca o que a working-memory de hoje lembra do passado e entrega à reflexão. |
| Quando algo sai do lugar | `scripts/doctor.sh`, seção 4b | Diz se está ligada, com qual modelo e quantos trechos. Com `--fix`, instala o modelo ou refaz o índice. |

**Quanto pesa.** O modelo só ocupa memória enquanto uma busca acontece: o `llama-server`
sobe numa porta interna, responde e morre junto com quem pediu. Medido em 05/10/2026 com
1 núcleo: 2 s para subir, 0,24 s por busca, ~600 MB de RAM durante esses segundos e ~1 s por
trecho novo no reindex. Cabe numa KVM 1 da Hostinger (1 vCPU, 4 GB).

## Termo exato antes do vetor (por quê)

Nome próprio raro não tem significado para um modelo de vetores. Em 05/10/2026, na Isa, o
vetor de "Jev" trouxe trechos sobre HeyGen, e o modelo que decide o lembrete inventou que o
Jev era uma pessoa, com "JEV (TypeSafe AI)" escrito com todas as letras num diário.

Por isso a busca procura primeiro a palavra **escrita** nos trechos (palavra inteira, sem
diferença de maiúscula). Só nomes e códigos entram nessa etapa ("Jev", "BL-271"), e um termo
que aparece em mais de 12 trechos é comum demais para servir de âncora. Se nada aparece
escrito, entra o vetor. E o prompt que decide o lembrete proíbe deduzir o que um nome é a
partir de trechos que não o mencionam.

## Escolher o provedor

No `.dgclaw/config.sh` do agente:

| `DGCLAW_EMBED_PROVIDER` | Efeito |
| --- | --- |
| `auto` (padrão) | Local se estiver instalado; senão Gemini se houver `GEMINI_API_KEY`; senão desligada, com o motivo escrito. |
| `local` | Só o modelo local. |
| `gemini` | Só o Gemini. Atenção: a chave gratuita do AI Studio deixa o Google usar o texto enviado; memória do dono, só com projeto que tem billing. |
| `off` | Desligada de propósito. |

Vetores de modelos diferentes não se comparam. Trocar de provedor faz o próximo reindex
refazer tudo, e até lá a busca por vetor fica de lado com o aviso "rode o reindex" (a busca
pelo termo exato continua).

Outras: `DGCLAW_EMBED_DIR` (onde está a instalação), `DGCLAW_EMBED_THREADS` (núcleos para o
modelo; padrão, todos).

## O que o dono decide com isto

Nada no dia a dia. O `/dgclaw:doctor` diz se a memória semântica está ligada, com qual
modelo, e quantos trechos o índice tem. Se aparecer desligada, o próprio aviso traz o
comando que liga.

## Testar na mão

```bash
python3 <plugin>/scripts/memory_index/embedder.py status   # ligada ou não, e por quê
python3 <plugin>/scripts/memory_index/embedder.py teste    # sobe o modelo e embeda uma frase
bash <plugin>/scripts/memory-reindex.sh <ws>/.dgclaw/config.sh
echo '{"input":"o que você sabe do Fulano?"}' | DGCLAW_WORKSPACE=<ws> python3 <plugin>/scripts/memory_index/memory_search_fast.py
```
