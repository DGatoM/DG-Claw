# Paridade Claude e Codex

O DG Claw tem dois motores pela assinatura: o **Claude** (Claude Code, login claude.ai) e o
**ChatGPT** (Codex CLI, login ChatGPT). Outras IAs entram só por chave de API. O Claude fica como
está; o objetivo é que o agente no Codex tenha tudo o que o agente no Claude tem, a não ser o que é
produto exclusivo da Anthropic, e que essas exceções tenham um caminho alternativo ou fiquem
registradas aqui.

Esta página é o registro oficial dessa paridade. A regra de projeto (`CLAUDE.md` e `AGENTS.md`)
manda que toda mudança nova funcione nos dois motores ou registre a exceção nesta página.

Levantamento de 06/11/2026 sobre a `main` no commit `15b11ae`, com Codex CLI 0.163.0 e Claude Code
2.1.x. Os testes do Codex rodaram em pastas temporárias, sem tocar em nenhum agente vivo. Base de
pesquisa: o relatório "Login agnóstico com assinatura" (OpenClaw e Hermes) da mesma data.

## O que mudou em relação ao que se sabia

O `docs/PROVEDORES.md` (12/10) dizia "sem hooks do Claude" e listava memória, thread log,
auto-compact e watchdog como perdidos no Codex. Três fatos novos mudam o desenho:

1. **O Codex 0.163 tem hooks nativos** (`codex features list`: `hooks` estável e ligado), com os
   eventos `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` e `Stop`. O hook recebe
   no stdin `hook_event_name`, `session_id`, `transcript_path` (o rollout), `source` e `prompt`, e
   devolve `hookSpecificOutput.additionalContext` no mesmo formato do Claude. Prova: num teste de
   13/10 com `.codex/hooks.json` no projeto, o modelo respondeu as palavras injetadas pelo
   `SessionStart` e pelo `UserPromptSubmit`. A trava: cada hook precisa de **confiança**
   (`trustStatus`); um hook declarado só por `-c` aparece como `untrusted` e não roda.
2. **O Codex lê skills no mesmo formato `SKILL.md` do Claude**, em `.agents/skills/<nome>/` e
   `.codex/skills/<nome>/` do projeto (e nas pastas do usuário). Testado: as duas pastas foram
   listadas e usadas.
3. **O `codex app-server` cobre o que o runner precisa** por JSON-RPC: `thread/start`, `turn/start`,
   `turn/steer`, `turn/interrupt`, `thread/resume`, `thread/compact/start`, `account/rateLimits/read`
   e eventos `turn/started`, `turn/completed`, `item/*`, `thread/tokenUsage/updated`,
   `account/rateLimits/updated`, `hook/*`, além dos pedidos de aprovação e de pergunta
   (`item/*/requestApproval`, `item/tool/requestUserInput`). Testado com um turno real.

Consequência: a proposta da pesquisa de levar memória e skills por MCP deixa de ser necessária. O
caminho mais barato é usar os hooks e as skills nativas do Codex com os mesmos scripts que o Claude
já usa.

## Tabela de paridade

Estados: **funciona**, **parcial**, **não funciona**, **exclusivo Anthropic**. Horas em tempo de
agente (régua: feature de ~2 mil linhas leva 10 a 30 min).

### Execução e sessão (runner)

| Recurso | No Claude | No Codex hoje | Prova | Como fazer no Codex | Horas |
| --- | --- | --- | --- | --- | --- |
| Identidade e instruções | `--append-system-prompt-file` + `CLAUDE.md` do workspace | funciona | `runner/src/provedores/codex.ts:297-309` (`developer_instructions`, teto de 120 KB) | nada | 0 |
| `AGENTS.md` do agente | `CLAUDE.md.tmpl` (288 linhas) | parcial | `templates/AGENTS.md.tmpl` tem 218 linhas; faltam lousa, quadro de avisos, tela de logins, agendar, texto para copiar | gerar os dois arquivos de uma fonte só; `doctor.sh` conferir o `AGENTS.md` também (`doctor.sh:253,618`) | 0,5 |
| Envio de mensagem e fila | PTY, recibo pelo hook `UserPromptSubmit` | funciona | `runner/src/sessao/digitacao.ts:14-163`; recibo por `task_started` do rollout | nada (o app-server elimina o Enter duplo) | 0 |
| Ocioso e ocupado | hooks do `--settings` | funciona | `runner/src/sessao/vigias.ts:282-326`, `codex-rollout.ts:172-185` | nada | 0 |
| Esperando resposta (pergunta ou permissão) | `Notification` e `AskUserQuestion` | não funciona | `runner/src/sessao.ts:472,506` (`PERMISSAO_SO_CLAUDE`, `PERGUNTA_SO_CLAUDE` = 501) | app-server: `item/tool/requestUserInput` e `item/*/requestApproval` | na linha do app-server |
| Medidor de uso do plano | `statusLine` com `rate_limits` | funciona | `runner/src/uso.ts:121-147`; rollout traz `used_percent`, `window_minutes`, `resets_at` | nada | 0 |
| Retomar após reinício | `--session-id` + `--resume` | funciona | `codex resume <uuid>`; id descoberto no rollout (`vigias.ts:293-304`) | o app-server devolve o id no `thread/start`, sem corrida | na linha do app-server |
| Login assistido | `claude auth login` pelo painel | funciona | `codex login --device-auth` (`provedores/login.ts`, `codex.ts:318-340`) | nada; o PR #86 (Conectar conta) já trata o `provedor` | 0 |
| Login expirado | erro sintético no transcript + vigia de `.credentials.json` | funciona | `runner/src/provedores/codex-rollout.ts` (`erroDeTurnoDoRollout`, `erroDeLoginDoCodex`), `runner/src/sessao/vigias.ts` (`aoErroDeTurno`), `runner/src/sessao/login.ts` (`arquivoDaCredencial` escolhe `auth.json` no Codex); testes `Codex login expirado:` em `sessao-codex.test.ts` e `erro de fim de turno` em `codex-motor.test.ts` | nada. O `task_complete` com `error.codex_error_info` `unauthorized` (ou 401/refresh token quando a categoria é `other`), posterior ao `auth.json`, põe o agente em `errored` com `runner:login-expirado`; o `auth.json` regravado reinicia com `codex resume <id>`. Limite de uso e sobrecarga não contam como login (limite de uso do Codex segue sem estado próprio) | 0 |
| Compactação manual | `/compact`, recibo pelo `PreCompact` | parcial | `/compact` funciona; `digitacao.ts:154-157` espera recibo do `PreCompact`, que não vem | recibo pelo registro `compacted` do rollout ou por `thread/compact/start` | 0,25 |
| Aviso de compactação na conversa | `compact_boundary` no transcript | não funciona | `web/lib/thread.js:47-58`; `web/lib/rollout.js` não trata compactação | traduzir o registro `compacted` em `AVISO_COMPACTANDO`/`AVISO_COMPACTADA` | 0,25 |
| Codex por app-server | (não se aplica) | não existe | o motor Codex digita no PTY e lê o rollout (`codex.ts`, `codex-rollout.ts`) | motor novo por JSON-RPC: eventos estruturados, aprovações, id sem corrida, compactação com evento | 1,5 |
| Subagentes | ferramenta Task | parcial | `templates/ambiente/agente.md:82-85` manda usar card | o Codex tem `multi_agent` estável; testar e documentar no `agente.md` | 0,25 |
| Busca na web | WebSearch nativo | parcial | `codex --search` existe; não está nos argumentos do runner | ligar `-c web_search="live"` no motor Codex | 0,1 |

### Hooks, memória e skills

| Recurso | No Claude | No Codex hoje | Prova | Como fazer no Codex | Horas |
| --- | --- | --- | --- | --- | --- |
| Recall de memória a cada mensagem | hook `UserPromptSubmit` (`hooks/memory-recall.sh`) | não funciona | `codex.ts:214-221` ignora `promptHooks` | hook nativo do Codex chamando o mesmo `hooks/dispatch.ts` | 1 (os quatro hooks juntos) |
| Quadro de avisos | hook `avisos` (`hooks/avisos.py`) | parcial | postar funciona; a leitura é hook | mesmo hook nativo; seção que falta no `AGENTS.md.tmpl` | (incluso acima) |
| Contexto de início e pós-compactação | hook `SessionStart` (`hooks/session-context.sh`, `avisos-reset`) | não funciona | `hooks/hooks.json` só chega ao Claude | `SessionStart` nativo do Codex (`source` = `startup`, `resume`, `compact`) | (incluso acima) |
| Fio do Telegram na mensagem | hook `inject-telegram-thread.py` | não se aplica | depende do Telegram | volta junto com a ponte de Telegram | (na ponte) |
| Skills do DG Claw | link em `~/.claude/skills` (`bin/dgclaw:926-940`) | parcial | só o painel contorna, mandando o caminho do `SKILL.md` (`web/lib/comandos.js:357`) | linkar as mesmas pastas em `.agents/skills` do agente Codex; trocar `${CLAUDE_PLUGIN_ROOT}` pelo caminho `.dgclaw/plugin` que já existe | 0,5 |
| Comandos `/dgclaw:*` | namespace do plugin | exclusivo Anthropic | o Codex não tem plugin com namespace de comandos | a skill nativa cobre o mesmo uso (o agente chama a skill pelo nome) | (nas skills) |
| Leitura da conversa (`thread_log`) | transcript JSONL | funciona | `scripts/_lib/thread_log.py:279-281,510`; `test_thread_log_rollout.py` 23/23 verdes | nada | 0 |
| Lista de conversas (working memory, FTS, reflexão) | `glob("*.jsonl")` em `~/.claude/projects` | parcial | `build-working-memory.py:436`, `conversas_fts.py:380`, `reflection.sh:143` | `listar_sessoes()` em `thread_log.py` incluindo `CODEX_HOME/sessions/**/rollout-*.jsonl` | 0,25 |
| Memória semântica (índice) | arquivos `.md` + embedder | funciona | `scripts/memory_index/reindex.py`, `embedder.py` não dependem do motor | nada | 0 |
| Auto-compact | `auto-compact.py` lê `message.usage` e `compact_boundary` | não funciona | `scripts/_lib/auto_compact/transcript.py:58-91`; sai em "sem usage, no-op" | ler `token_count` (`total_token_usage`, `model_context_window`) e `task_*` do rollout; ou perguntar ao runner | 0,5 |
| Watchdog (turno travado) | transcript do Claude | parcial | `scripts/watchdog.py:114-118,328-340` | `ultimo_turno_epoch` ler o rollout | 0,25 |
| Saúde e modo seguro | `saude_sessao.py` + `claude auth status` | não funciona | `scripts/_lib/saude_sessao.py:251-275,561-651` | ramo de rollout e login pelo `codex login status` (já em `conferido.ts`) | 0,5 |

### Canais e integrações

| Recurso | No Claude | No Codex hoje | Prova | Como fazer no Codex | Horas |
| --- | --- | --- | --- | --- | --- |
| Painel (DG Chat) | MCP `dgchat` | funciona | `runner/src/provedores/mcp-codex.ts:93-180`; `web/lib/rollout.js:229` | nada | 0 |
| WhatsApp | ponte própria + MCP `whatsapp_*` | funciona (sem teste ao vivo) | `docs/CANAL-WHATSAPP.md:236`; `scripts/dgchat-mcp/server.mjs:150-170` | teste ao vivo num agente Codex | 0,1 |
| Telegram | `--channels plugin:telegram@claude-plugins-official` | exclusivo Anthropic | `codex.ts:221` ignora `--channels` | ponte própria no molde do WhatsApp (Bot API, `/input`, MCP `telegram_reply`); serve aos dois motores | 1,25 |
| Gmail, Agenda e Drive | conectores do claude.ai | exclusivo Anthropic | `docs/GMAIL-NO-AGENTE.md:15-30` | MCP próprio com OAuth do dono, só leitura e rascunho; a trava vira `enabled_tools` do MCP no Codex | 2 + espera do OAuth do Google |
| Trava do Gmail (`deny`) | `permissions.deny` em `.claude/settings.local.json` | não se aplica hoje | `scripts/gmail-permissao.sh:44`; `codex.ts:219` ignora `denyTools` | `mcp_servers.<n>.enabled_tools`/`disabled_tools` do Codex | (no MCP do Gmail) |
| Cofre no shell do agente | variáveis do PTY | funciona | teste de 06/11: `FOO_API_KEY` e `BAR_SECRET` chegaram ao `env` do shell | nada | 0 |
| Cofre nos MCPs | o Claude repassa o ambiente | parcial | o Codex não repassa; `mcp-codex.ts:133-143` só leva `DGCHAT_*` e o `env` literal | campo `envDoCofre` no `mcpConfig`, ou `mcp_servers.<n>.env_vars` (aceito no 0.163) | 0,25 |
| Cofre na conversa | bloco `dgcofre` | funciona | `templates/AGENTS.md.tmpl:179` | nada | 0 |
| Cards em outro provedor | `bin/dgclaw-card` | funciona | `bin/dgclaw-card:178,192-216` | nada | 0 |
| Lembretes | agendador do Web + `/input` | funciona | `web/lib/lembretes.js:207` | nada | 0 |
| Pokes e heartbeat | `inject.py` em modo bunker | funciona | `scripts/_lib/inject.py:442-474,552`; `poke_ledger.py` não depende do motor | nada | 0 |
| Crons headless (reflexão headless, post, comentários, poderes) | `claude --print` | não funciona | `reflection.sh:303-313`, `scripts/cron/dgclaw-post.sh:105`, `dgclaw-comentarios.sh:101` | um `motor-headless` que escolhe `claude -p` ou `codex exec ... </dev/null` | 0,5 |
| Custos (tokens por mensagem) | `channels-tokens-logger.py` lê o transcript | não funciona | `scripts/channels-tokens-logger.py:76-80,119-136` | ler `token_count` do rollout; na assinatura do ChatGPT não há custo em dólar, só tokens | 0,25 |
| Mesa de tarefas | `dgclaw-mesa` | funciona | `templates/AGENTS.md.tmpl:155` | nada | 0 |
| Modo monitor | `dgclaw-monitor` | funciona | `docs/MODO-MONITOR.md:40` | nada | 0 |
| Modo escondido, voz, anexos, visuais | rodam no Web | funciona | `web/lib/sigilo.js`, `voz.js`, `uploads.js`, `rollout.js:34` (`send_file`) | seção da lousa no `AGENTS.md.tmpl` | (no `AGENTS.md`) |
| Ronda de segurança | lê configs de Claude e Codex | funciona | `seguranca/ronda/ronda.py:986,1141` | nada | 0 |
| Radiografia | texto fixo | funciona | `docs/RADIOGRAFIA.md:117` diz "assinatura do Claude" | texto neutro | 0,05 |

### Exclusivos da Anthropic (limites registrados)

| Recurso | Caminho alternativo no Codex |
| --- | --- |
| Telegram oficial por `--channels` | ponte própria de Telegram pelo runner (Fase 4) |
| Conectores do claude.ai (Gmail, Agenda, Drive e outros) | MCP próprio por serviço; até lá, o que precisa deles fica num agente Claude ou num card Claude |
| Namespace de comandos de plugin (`/dgclaw:x`) | skills nativas do Codex pelo nome |
| `statusLine` | o rollout e o app-server já trazem o uso do plano |
| Regras `allow`/`ask`/`deny` por ferramenta | `enabled_tools`/`disabled_tools` por servidor MCP e a política de aprovação do Codex |

## Total

| Fase | O que entra | Horas de agente |
| --- | --- | --- |
| 1. Fundação | `AGENTS.md` de fonte única e `doctor.sh`; skills em `.agents/skills`; hooks nativos do Codex (recall, avisos, `SessionStart`) com a confiança resolvida | 2 |
| 2. Ciclo de vida | `listar_sessoes()`; auto-compact, aviso e recibo de compactação; login expirado; watchdog e saúde | 2 |
| 3. Headless e custos | `motor-headless` para crons e poderes; tokens do rollout; cofre nos MCPs; busca na web; radiografia | 1,25 |
| 4. Telegram | ponte própria, para os dois motores | 1,25 |
| 5. App-server | motor Codex por JSON-RPC, com perguntas e aprovações no painel | 1,5 |
| 6. Google | MCP próprio de Gmail, Agenda e Drive (opcional; senão fica como limite) | 2 |
| **Total** | | **10 h** (8 h sem a Fase 6) |

Fora do tempo de agente: o teste ao vivo num agente Codex de verdade a cada fase, a aprovação do
Danilo do desenho, e, na Fase 6, a configuração e a verificação do app OAuth no Google, que pode
levar dias.

## Ordem recomendada

1. **Fundação primeiro**, porque é a que o dono sente: com o `AGENTS.md` completo, as skills e os
   hooks nativos, o agente no Codex já lembra, lê o quadro de avisos e conhece as ferramentas.
2. **Ciclo de vida** em seguida, porque hoje um Codex pode estourar o contexto sem aviso e ficar
   parado com o login vencido sem ninguém saber.
3. **Headless e custos**, que são trocas pequenas e mecânicas.
4. **Telegram**, que é trabalho novo mas segue um molde que já existe (WhatsApp).
5. **App-server**, que troca a base do motor. Fica depois das outras para não misturar duas
   mudanças grandes, e porque o PTY atual já funciona.
6. **Google** só se o Danilo quiser; o caminho barato é deixar registrado como limite.

## Riscos

1. **A confiança dos hooks do Codex.** Hook sem confiança não roda, e isso é uma proteção que o
   DG Claw tem de manter. A única saída aceita é dar confiança explícita só aos hooks que o próprio
   DG Claw distribui e revisa: gravar o hash de cada um no `config.toml` do `CODEX_HOME` do agente
   na instalação e na atualização. **`--dangerously-bypass-hook-trust` não pode ser usado**, nem no
   container: com ele, um `.codex/hooks.json` que chegue num repositório clonado ou numa pasta de
   terceiro roda comandos sozinho no começo da sessão, sem o modelo precisar aceitar nada, e leva as
   credenciais e os arquivos do container. Hooks de projetos externos continuam bloqueados. No
   **Admin, que roda como root**, vale o mesmo, e o arquivo de hooks do DG Claw tem de ser de root e
   ficar fora de qualquer pasta em que um agente escreva. A Fase 1 só fecha com um teste que põe um
   hook externo malicioso num projeto e confere que ele **não** roda.
2. **O Codex muda toda semana.** Hooks, skills e app-server são recentes, e o protocolo do
   app-server muda de versão em versão. Fixar a versão testada no instalador e o `doctor` avisar
   quando sair dela.
3. **O `notify` não disparou no `codex exec` nem no app-server** no teste de 06/11. O runner usa o
   `notify` na tela interativa, onde ele é documentado, e tem o rollout como segunda fonte. Com o
   app-server, o `turn/completed` substitui os dois.
4. **`codex exec` pendura sem stdin fechado** ("Reading additional input from stdin"). Todo script
   headless tem de chamar com `</dev/null`.
5. **Duas fontes de instrução.** O Codex lê o `AGENTS.md` e usa o `CLAUDE.md` só quando não existe
   `AGENTS.md` na pasta (`project_doc_fallback_filenames`). Se os dois forem escritos à mão, eles
   divergem, como já aconteceu (218 contra 288 linhas).
6. **Prova de campo.** A maior parte das linhas "funciona" vem do código e de testes com rollouts
   fabricados. Cada fase só fecha depois de rodar num agente Codex de verdade.
7. **Gmail sem trava equivalente.** Um MCP próprio de Gmail só pode ser liberado com a lista de
   ferramentas restrita a leitura e rascunho; sem isso o agente poderia mandar e-mail sozinho.

## Como registrar uma exceção nova

Quando um PR depender de algo que só o Claude Code tem e o equivalente no Codex não couber nele,
acrescente uma linha na tabela da seção certa com o estado, a prova (arquivo:linha) e o caminho
alternativo, e cite esta página no corpo do PR. O item "Testado no Codex" do checklist só se marca
depois de rodar de verdade com o Codex.
