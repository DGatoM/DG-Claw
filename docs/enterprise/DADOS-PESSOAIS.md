# Dados pessoais no DG Claw: onde ficam, quanto tempo e como sair

Este documento é o inventário que sustenta a retenção (`dgclaw retencao`) e a exclusão por titular
(`dgclaw titular`). Se um lugar novo passar a guardar texto de conversa, ele entra aqui e nos dois
scripts (`scripts/enterprise/retencao.py` e `titular.py`) no mesmo commit.

Neste documento, `<casa>` é `/var/lib/dgclaw/agentes/<slug>` e `<home>` é `<casa>/home` (o que o
agente enxerga como `/home/agente`). Os arquivos de `<home>` pertencem ao uid mapeado do agente; os
dois scripts rodam como root e preservam dono, modo e data de modificação ao reescrever.

## O inventário

| O quê | Caminho no host | Formato | Quem escreve | Retenção (`retencao_dias`) | Exclusão por titular |
| --- | --- | --- | --- | --- | --- |
| Transcripts do Claude Code | `<home>/.claude/projects/**/*.jsonl` | uma linha JSON por registro, com `uuid`, `parentUuid`, `timestamp` | Claude Code, dentro do container | Arquivo com última modificação mais velha que o prazo é apagado. Arquivo em uso com mensagens velhas: o texto delas vira `[removido pela política de retenção]`, sem apagar linha. | Cada ocorrência vira `[dado removido a pedido do titular]`. A estrutura JSON fica. |
| Rollouts do Codex | `<home>/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl` | uma linha JSON por registro, com `timestamp` e `payload` | Codex, dentro do container | Igual ao Claude Code | Igual ao Claude Code |
| Conversas indexadas | `<home>/.dgclaw/memory_index/conversas.db` (SQLite, FTS5) | tabelas `trechos`, `trechos_fts`, `fontes` (`scripts/memory_index/conversas_fts.py`) | rotina de reindex do agente (de 15 em 15 minutos) | Linhas de conversa (`tipo='conversa'`) mais velhas que o prazo são apagadas; o índice de busca é refeito e o arquivo compactado, para o texto não ficar nas páginas livres. Linhas de memória não. | Apaga as linhas que contêm o termo, refaz o índice e compacta. |
| Índice semântico (embeddings) | `<home>/.dgclaw/memory_index/chunks.db` (SQLite) | tabela `chunks` com `content` e o vetor (`scripts/memory_index/reindex.py`, `docs/MEMORIA-SEMANTICA.md`) | rotina de reindex noturna | Não é tocado por idade: ele nasce dos arquivos de memória (que a retenção não apaga) e o próprio reindex já tira do índice o que sumiu do disco. | Procura pelo texto de origem (`content`), apaga os chunks que contêm o termo. O reindex seguinte recria os trechos já a partir da memória editada. |
| Memória do agente | `<home>/MEMORY.md`, `<home>/working-memory.md`, `<home>/memory/**`, `<home>/data/diary.jsonl` | Markdown e JSON | o próprio agente | **Não apaga sozinha**: é o que o agente sabe. Entra na revisão manual periódica (seção abaixo). | Troca o termo pelo marcador, mantendo o resto do arquivo. |
| Anexos enviados e recebidos | `<home>/uploads/AAAA-MM-DD/` (envio pelo Web, `web/lib/uploads.js`) e `<home>/uploads/whatsapp/AAAA-MM-DD/` (ponte do WhatsApp) | arquivos de qualquer tipo | Web e ponte do WhatsApp | Arquivo mais velho que o prazo é apagado; a pasta de data que ficar vazia também. | Arquivo de texto: troca o termo. Arquivo binário (PDF, imagem...): só lista; remove com `--apagar-anexos`. O nome do arquivo também conta. |
| Entregas do agente | `<home>/.dgclaw/entregas/` | arquivos gerados pelo agente | o agente | Igual aos anexos | Igual aos anexos |
| Miniaturas do chat | `/var/lib/dgclaw/web/miniaturas/*.jpg` | JPEG pequeno | Web (`web/lib/media.js`), sob demanda | Mais velha que o prazo é apagada (é cache e se refaz) | Não são lidas (imagem); somem pelo prazo ou ao apagar o anexo de origem e esperar a retenção |
| Dados vivos do Web | `/var/lib/dgclaw/web/`: `mesa/tarefas.json`, `lembretes/`, `avisos.json`, `push/`, `onboarding/`, `alertas/<slug>.json`, `foco/`, `sigilo-cache.json`, `sessoes.json` (só hashes), `cofre/` (só nomes) | JSON | Web | Não apaga por idade: é estado de trabalho, não histórico. Revisão manual. | Troca o termo em todo arquivo `.json` (reescreve o JSON válido). `sigilo-cache.json` guarda trechos que o modo escondido apontou: entra na busca. |
| Logs dos agentes | `<home>/.dgclaw/logs/` (`runner.log`, `whatsapp.log`, `permissoes.log`...) | texto | runner e ponte | Arquivo mais velho que o prazo é apagado. O `runner.log` é modificado o tempo todo, então o corte dele é o `logrotate` (abaixo). | Troca o termo linha a linha |
| Logs do servidor | `/var/log/dgclaw/*.log` e `*.log.*.gz` (`web`, `admin-runner`, `instalar`...) | texto | serviços do DG Claw | Igual aos logs dos agentes. **A trilha `auditoria.jsonl` nunca é apagada por idade.** | Troca o termo linha a linha |
| Admin (agente de sistema) | transcripts em `/root/.claude/projects/-opt-dgclaw-admin/`, casa em `/opt/dgclaw/admin`, log em `/var/log/dgclaw/admin-runner.log` | os mesmos formatos acima | Admin | Entra como mais um agente (`tipo: admin` no `agentes.json`) | Entra como mais um agente |
| WhatsApp | `<home>/.dgclaw/whatsapp/` (`permitidos.json`, estado da ponte) | JSON | ponte do WhatsApp | Não apaga: é configuração do canal. A mídia recebida já está em `uploads/whatsapp/`. | **Só lista.** Remover o número é com `dgclaw-agente canal whatsapp remover <numero>` (dentro do agente). |
| Trilha de auditoria | `/var/log/dgclaw/auditoria.jsonl` | uma linha JSON por evento, encadeada por hash | CLI e Web | Nunca apaga | **Só lista.** Editar quebraria a corrente de hashes. A trilha não deve guardar dado pessoal; se aparecer, é erro de quem gravou o evento. |
| Recibos de exclusão | `/var/lib/dgclaw/titulares/AAAA-MM-DD-<hash>.json` | JSON, modo 600, pasta 700 | `dgclaw titular apagar` | Guardar enquanto a empresa precisar provar o atendimento | Não guarda o termo, só o HMAC dele |
| Backups | pasta de destino do backup (bloco de backup) | cópia cifrada de tudo acima | timer de backup | `backup_retencao_dias` | O dado sai quando a cópia mais antiga expira. O recibo e a saída do comando dizem a data. |

## Como o chat lê os transcripts (a armadilha)

O chat do Web monta o histórico direto dos transcripts (`web/lib/conversa.js`). Por isso:

- **Apagar um transcript apaga a conversa da tela.** É o que a retenção faz de propósito com o que passou do prazo.
- **Trocar o texto de uma mensagem a mantém na tela**, mas com o marcador no lugar do conteúdo. Por isso a
  retenção só troca texto em arquivo que ainda está em uso, e nunca apaga linhas: remover uma linha quebraria a
  corrente `parentUuid`, e o `--resume` do Claude Code deixaria de achar o fio da conversa.
- O `conversas.db` guarda a posição lida de cada transcript (`fontes`). Quando um transcript é reescrito, os
  scripts atualizam o tamanho, o inode e essa posição; sem isso o indexador acharia que o arquivo encolheu,
  leria tudo de novo e reinseriria o marcador como se fosse conversa.
- Mensagens sem `timestamp` (alguns registros de resumo) não são tocadas pela retenção. A exclusão por titular
  não depende de data e as alcança.

## Retenção (`dgclaw retencao aplicar`)

- O prazo é a proteção `retencao_dias`: 180 no nível `escritorio`, 90 no `empresa`, 30 no `regulado`; 0 (nível
  `pessoal`) quer dizer sem prazo e o comando não faz nada. Mudar: `dgclaw nivel ajustar retencao_dias 60`.
- `dgclaw --ensaio retencao aplicar` só lista o que faria. `--agente <slug>` limita a um agente (e não mexe nos
  logs do servidor).
- O timer `dgclaw-retencao.timer` roda todo dia às 3h30 (mais um atraso aleatório de até 20 minutos). Ele e o
  `logrotate` são instalados por `install.sh --nivel ...` e por `dgclaw protecoes aplicar`.
- Arquivo que mudou nos últimos 2 minutos (sessão escrevendo) não é reescrito. O resumo diz quais foram
  pulados; a rodada do dia seguinte pega.
- O `logrotate` (`/etc/logrotate.d/dgclaw-enterprise`) cuida do que a varredura por idade não alcança: o
  `runner.log` de cada agente cresce sem limite e é modificado o tempo todo. Ele gira por dia, guarda `retencao_dias`
  dias e usa `copytruncate`.
- Cada rodada grava o evento `retencao_aplicada` na auditoria, com os números (arquivos, mensagens trocadas,
  linhas de banco, bytes).

## Exclusão por titular (`dgclaw titular`)

Fluxo recomendado quando uma pessoa pede a eliminação dos dados dela (LGPD, art. 18, VI):

1. `dgclaw titular buscar "Maria Souza" --termo 123.456.789-01 --termo maria@exemplo.com --termo "(11) 98765-4321"`.
   Mostra, por lugar, quantas ocorrências existem e um trecho **mascarado** (nunca o dado inteiro, nem de outras
   pessoas). Não altera nada. O CPF casa com ou sem pontuação, o telefone com ou sem o `+55`.
2. Conferir com quem pediu que é a pessoa certa e que o termo não vai pegar outra (um nome comum pega homônimos).
   O comando recusa termo com menos de 4 caracteres.
3. `dgclaw titular apagar "Maria Souza" --termo 123.456.789-01 ... --confirmar`. Sem `--confirmar` ele recusa.
   Com `dgclaw --ensaio titular apagar ...` ele só mostra o que seria apagado.
4. Anexos binários (PDF, imagem...) o comando lista e pede decisão: `--apagar-anexos` remove os que contêm o termo
   no conteúdo ou no nome.
5. O comando sai com código 2 se algo ficou **pendente**: arquivo em uso (repita em alguns minutos), anexo binário,
   número no WhatsApp, termo na trilha de auditoria. Resolva e repita; ele só mexe no que ainda tiver o termo.
6. Guardar o recibo (`/var/lib/dgclaw/titulares/`) e responder à pessoa. A LGPD pede a resposta completa em até 15
   dias (art. 19, II).

O que o comando faz em cada lugar está na tabela. O recibo traz, por agente e por lugar, as ocorrências e quantos
itens foram alterados, o prazo de saída dos backups e o HMAC-SHA256 dos termos. O HMAC usa um segredo da
instalação (`/var/lib/dgclaw/titulares/.sal`, modo 600), porque um hash simples de CPF se desfaz por força bruta.
A auditoria recebe `titular_apagado` com esse hash e o número de ocorrências, sem o termo.

### O que o comando não alcança (diga isto ao titular)

- **Backups.** O dado continua nas cópias existentes até elas expirarem (`backup_retencao_dias`; a saída do
  comando mostra a data). Quem restaurar um backup anterior à exclusão traz o dado de volta: refaça a exclusão
  logo depois de qualquer restauração.
- **Os provedores de IA.** O que já foi enviado à Anthropic, à OpenAI ou a outro provedor segue a política de
  retenção do contrato da empresa com ele. O `credencial_empresa` e os termos do plano dizem se há retenção
  zero.
- **O journal do sistema** (`journalctl`). Se algum serviço escreveu o dado ali, reduza com
  `journalctl --vacuum-time=<dias>d`.
- **Cópias feitas por fora**: exportações, prints, mensagens no Telegram ou WhatsApp da própria pessoa, e-mails.
- **A trilha de auditoria** (veja a tabela) e o **WhatsApp** (só lista).
- **Variações do dado** que o termo não casa: apelido, nome com erro de digitação, nome sem acento. Repita a busca
  com cada variação que a pessoa usar. A busca ignora maiúsculas e o espaçamento, mas não acentos.

## Revisão manual periódica da memória

A memória do agente (`MEMORY.md`, `working-memory.md`, `memory/`, `data/diary.jsonl`) e os dados vivos do Web
não saem por prazo. Quem administra a instalação revisa a cada trimestre:

1. Abrir `MEMORY.md` e `memory/` de cada agente e apagar o que é dado pessoal que não é mais necessário (cliente
   antigo, candidato, aluno que saiu).
2. Revisar `/var/lib/dgclaw/web/mesa/tarefas.json`, `lembretes/` e `avisos.json` (tarefas e lembretes concluídos
   guardam nomes e telefones).
3. Se `uploads/` e `.dgclaw/entregas/` têm arquivos recentes que já não servem, apagar na mão: a retenção só
   alcança o que passou do prazo.
4. Registrar a revisão (data e quem fez) no controle interno da empresa. Para a ANPD, isso é parte de provar que
   a minimização é praticada.

## Para quem for mexer nos scripts

- Toda operação em arquivo da casa do agente é relativa a um descritor de pasta, com `O_NOFOLLOW`
  (`dados_comum.py`). Atalho plantado pelo agente nunca é seguido, e é reportado.
- Reescrita é atômica (temporário na mesma pasta + rename), preserva dono, modo e datas, e é abandonada se o
  original mudar enquanto era lido.
- O SQLite apagado usa `secure_delete`, reconstrói o FTS e roda `VACUUM`; os arquivos `-wal` e `-shm` que o root
  criar voltam ao dono do banco, para o reindex do agente não falhar com "readonly database".
- Os testes estão em `tests/enterprise/retencao.test.sh` e `titular.test.sh`, com uma casa de agente sintética
  (`tests/enterprise/_dados.sh`).
