# Provedores: Claude e Codex no DG Claw

Esta página explica quais motores o DG Claw sabe usar, como cada um é pago e o que
mudou de verdade quando o motor é o Codex. A segunda metade guarda os testes que
fizemos em 12/10/2026, com o comando exato, para ninguém precisar descobrir de novo.

## O catálogo

Existe um arquivo só com a lista de provedores: `providers/catalogo.json`. O painel e os
scripts leem dele, então nome de tela, comando de instalação, variável da chave e lista de
modelos ficam num lugar só.

| Provedor | Estado | Binário | Pagar na assinatura | Pagar na API |
| --- | --- | --- | --- | --- |
| Claude | disponível | `claude` | login claude.ai (Pro ou Max), conferido por `claude auth status --json` | `ANTHROPIC_API_KEY` |
| Codex | disponível | `codex` | login ChatGPT, conferido por `codex login status` | `OPENAI_API_KEY` |
| Gemini CLI | desenhado, ainda recusado | `gemini` | (depois) | `GEMINI_API_KEY` |

Cada provedor tem `auth.assinatura` e `auth.api` (o Claude tem também `auth.token`), cada um
com um texto `explica` em português simples para o dono e a lista `limpar`: as variáveis que
saem do ambiente da sessão naquele modo, porque qualquer uma delas passaria por cima do login
escolhido. O que isso significa na prática:

- **Na assinatura:** valor fixo por mês, uso dentro do limite do plano. Entra com a conta uma vez.
  No Claude é o login do próprio agente (`claude auth login`), o único modo em que os
  conectores do claude.ai (Gmail, Agenda, Drive) carregam
  (https://code.claude.com/docs/en/authentication, seção "Generate a long-lived token").
- **Na assinatura, sem conectores (só Claude):** o mesmo plano, por um token de longa duração
  (`claude setup-token`) guardado no Cofre como `CLAUDE_CODE_OAUTH_TOKEN`. Os conectores do
  claude.ai não carregam neste modo.
- **Na API:** paga só pelo que usar, contado em tokens. Pode ficar caro se o agente trabalhar
  muito. A chave fica no Cofre do painel.

Os modelos do Claude são fixos no catálogo (com apelidos `opus`, `sonnet`, `haiku`). Os do
Codex mudam toda semana, então a lista vem do `models_cache.json` do próprio Codex
(`slug`, `display_name`, só `visibility == "list"`, e só `supported_in_api == true` quando a
forma de pagar é a API). Sem esse arquivo, vale a lista de reserva do catálogo. Modelo vazio
quer dizer "o padrão do provedor".

### `scripts/provedores/catalogo.mjs`

Funciona como módulo e como linha de comando, sem dependências.

```
catalogo.mjs validar <provedor> <auth> [modelo]   # exit 0 e imprime o id canônico; exit 2 com o motivo
catalogo.mjs rotulo  <provedor> <auth> [modelo]   # "Claude Opus 5.5, na assinatura"
catalogo.mjs modelos <provedor> [--codex-home DIR] [--api]
catalogo.mjs campo   <provedor> <caminho>          # ex.: auth.api.variavel
```

Testes: `node --test scripts/provedores/test_catalogo.mjs`.

## O que muda quando o motor é o Codex

- **Sem Telegram oficial.** O `--channels` só existe no Claude. O agente conversa pelo painel.
- **Sem hooks do Claude.** Tudo que depende do transcript ou dos hooks do Claude Code pode não
  funcionar com o Codex: memória, thread log, auto-compact, watchdog e injeção por `--name`.
  Arquivos que citam `transcript` ou `--name dgclaw` (conferir caso a caso antes de prometer
  que funciona): `scripts/auto-compact.py`, `scripts/watchdog.py`, `scripts/_lib/inject.py`,
  `scripts/_lib/reinicio.py`, `scripts/build-working-memory.py`, `scripts/reflection.sh`,
  `scripts/memory_index/conversas_fts.py`, `scripts/channels-tokens-logger.py`,
  `scripts/inject-telegram-thread.py`.
- **A resposta ao painel** continua saindo pela tool `reply` do MCP `dgchat`.

## Achados dos testes (12/10/2026)

Versões: Claude Code 2.1.296, Codex CLI 0.162.1. Tudo em pastas temporárias, chave falsa,
nenhum agente vivo tocado.

### 1. Claude Code na API: a pergunta "Detected a custom API key"

Com `ANTHROPIC_API_KEY` no ambiente e config já com onboarding feito, o Claude Code abre,
a cada config nova, a tela "Do you want to use this API key?" com o padrão em **No**. Num
agente sob systemd essa tela trava o terminal.

- **Funciona:** gravar no `.claude.json` do `CLAUDE_CONFIG_DIR` em uso (ou `~/.claude.json`
  quando não há `CLAUDE_CONFIG_DIR`) a chave pré-aprovada, que são **os últimos 20
  caracteres** da chave:
  `"customApiKeyResponses": {"approved": ["<últimos 20 caracteres>"], "rejected": []}`.
  Depois disso a pergunta não aparece e o cabeçalho mostra "API Usage Billing".
  A escrita tem de ser atômica (arquivo temporário na mesma pasta e `mv`) e preservar o resto
  do JSON.
- **Não funciona:** `--settings '{"apiKeyHelper":"..."}'`. A pergunta aparece do mesmo jeito,
  porque ela é sobre a variável de ambiente.
- Limitação do teste: o guardião de segredos do ambiente bloqueou escrever uma chave com o
  prefixo `sk-ant-` em arquivo, então o teste usou uma chave falsa com outro prefixo. A tela
  mostra só o começo e o fim da chave, e a conferência é pelo fim, então o prefixo não deve
  mudar o resultado, mas ficou sem teste com o prefixo real.
- A tela "Bypass Permissions mode" aparece em config nova; nos agentes já instalados ela já
  foi aceita (não faz parte desta camada).

### 2. Codex: flags que funcionam

Comando testado (assinatura, login normal do usuário):

```
codex --dangerously-bypass-approvals-and-sandbox \
  -c 'projects."<workspace>".trust_level="trusted"' \
  -c 'mcp_servers.dgchat.command="node"' \
  -c 'mcp_servers.dgchat.args=["<server.mjs>"]' \
  -c 'mcp_servers.dgchat.env={DGCHAT_AGENT="<slug>", DGCHAT_OUTBOUND="<caminho>"}' \
  -c 'developer_instructions="<identidade>"'
```

- **Confiança por `-c`:** funciona, sem pergunta de confiança e sem escrever no `config.toml`.
- **MCP por `-c`:** `/mcp` mostra `dgchat: connected (2 tools)`.
- **O Codex NÃO repassa variáveis do ambiente ao servidor MCP.** Um `env | grep ^DGCHAT` dentro
  do servidor voltou vazio mesmo com as variáveis exportadas. É obrigatório declarar em
  `mcp_servers.dgchat.env={...}`; com a tabela, as duas variáveis chegaram.
- **Identidade:** a chave certa é `developer_instructions`. Pedindo "qual a palavra-código?", o
  agente respondeu a palavra que estava na identidade de teste. Ela soma às instruções base
  (é uma mensagem de desenvolvedor extra); quem substitui as instruções base é
  `base_instructions`/`model_instructions_file`, que não devem ser usadas. O valor vai como
  string TOML; `JSON.stringify` do texto serve. Cuidado com o tamanho: um argumento de linha de
  comando no Linux aceita no máximo 128 KB.
- **`-c` liga o modo "embedded"**: o Codex avisa "Running without the shared background
  server". É só um aviso na tela (F2), a sessão funciona.
- **Marcador no argv para o `inject.py`:** `-c dgclaw_sessao="dgclaw-<slug>"` é aceito, mas o
  Codex mostra o aviso "`dgclaw_sessao` is ignored" na tela. O argv aparece em
  `/proc/<pid>/cmdline` (há dois processos, o wrapper node e o binário). Sem precisar de
  marcador falso, o argv já leva o caminho do workspace (na confiança) e o slug (em
  `mcp_servers.dgchat.env.DGCHAT_AGENT`), que bastam para achar a sessão. O `inject.py` não
  foi alterado.
- **Enter depois do texto:** digitado por `tmux send-keys` junto com o texto, o Enter não enviou;
  precisou de um segundo Enter depois de uma pausa (o Codex trata texto rápido como colagem).

### 3. Codex na API: `CODEX_HOME` separado

```
printf '%s' "$OPENAI_API_KEY" | CODEX_HOME=<pasta 700> codex login --with-api-key
CODEX_HOME=<pasta 700> codex login status
```

- A chave entra só por stdin. O `auth.json` criado fica com modo 600.
- `codex login status` sai com **exit 0 e imprime `Logged in using an API key - <começo>***<fim>`**
  quando está logado, e **exit 1 e `Not logged in`** quando não está. A linha traz um pedaço da
  chave: nunca repasse essa saída crua para a tela ou para o log. Na assinatura imprime
  `Logged in using ChatGPT`.
- Em `/tmp` o Codex avisa que não cria "PATH aliases" (ajudantes) sob pasta temporária. Em
  `<workspace>/.dgclaw/codex-api` isso não deve ocorrer.

### 4. `OPENAI_API_KEY` no ambiente muda o login do ChatGPT?

Não. Com o login do ChatGPT no `~/.codex` e `OPENAI_API_KEY` falsa no ambiente, `codex login
status` continuou "Logged in using ChatGPT" e `codex exec "responda so OK"` respondeu OK. Já
`CODEX_API_KEY` falsa deixou o `codex exec` pendurado até o timeout de 90 s (ele tentou usar a
chave), então essa variável **precisa** sair do ambiente no modo assinatura. Mesmo assim vale
tirar também `OPENAI_API_KEY`, `OPENAI_BASE_URL` e `OPENAI_API_BASE` (o `OPENAI_BASE_URL`
muda para onde vão os pedidos e não foi testado).

### 5. Codex como root: o flag de bypass é aceito (13/10/2026, Codex 0.162.1)

O runner do Admin roda como root no host, e o Claude recusa `--dangerously-skip-permissions` sob
root (por isso usa `--permission-mode bypassPermissions` e `IS_SANDBOX=1`). Com o Codex rodando como
root, numa pasta temporária e com confiança por `-c`:

```
codex --dangerously-bypass-approvals-and-sandbox -c 'projects."<pasta>".trust_level="trusted"'
```

o Codex abriu normalmente (a tela mostra `permissions: YOLO mode`) e executou um prompt. **Não é
preciso `IS_SANDBOX` nem outro truque no Codex.**

### 6. Codex: um Enter extra com a caixa vazia não faz nada

Depois de um turno concluído, um `\r` a mais com a caixa de entrada vazia só redesenhou a tela
(86 bytes de controle) e o rollout continuou com **um** `task_started`. Por isso o runner pode
repetir o Enter até 3 vezes quando o rollout não mostra o turno, sem risco de abrir turno duplicado.
O que dá certo para enviar: texto, pausa de 500 ms, `\r`; o texto e o Enter juntos, ou rápido demais,
são tratados como colagem.

### 7. `claude auth status --json`: o que o runner usa

Conforme a especificação do runner (a saída real não foi reexecutada nesta rodada): o JSON traz
`loggedIn`, `authMethod` (`claude.ai` = assinatura, `oauth_token` = token de longa duração,
`api_key` = chave de API, `none`), `subscriptionType` e também dados pessoais (e-mail, `orgId`,
`orgName`). O runner lê **só** os três primeiros campos e descarta o resto. Com chave falsa o
comando também diz `loggedIn: true` (ele não valida a chave), então a tela fala em "chave
configurada", nunca em "chave válida".

### 8. Rollout do Codex: o que o runner lê

`<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<data>-<uuid>.jsonl`, uma linha JSON por registro:
`session_meta` (traz `id`, `cwd` e `timestamp`; a primeira linha chega a dezenas de KB por causa do
`base_instructions`), `event_msg` com `task_started` e `task_complete`/`task_aborted`/`turn_aborted`,
`response_item` com `function_call`/`custom_tool_call` e `message` (papéis `developer`, `user`,
`assistant`). O rollout só nasce no primeiro turno. O id da sessão é descoberto por cwd, mtime e pelo
`timestamp` do `session_meta` (a conversa nova nasce depois do spawn), excluindo os ids que outras
sessões do runner já usam.

## Cards em outro provedor

O agente principal (Claude) abre uma sessão paralela em outro provedor, por exemplo o Codex (GPT),
manda um pedido, espera, lê a resposta e fecha. O dono diz "abre um card no GPT para revisar isso" e
o agente cuida do resto. É a skill `cards` (`/dgclaw:cards`) usando o comando `bin/dgclaw-card`
(`abrir`, `mandar`, `estado`, `esperar`, `ler`, `listar`, `fechar`), que fala com as rotas
`POST /api/sessoes`, `/input`, `/conversation` e `DELETE /api/sessoes/<id>` do runner.

**Limite:** no máximo 3 cards abertos ao mesmo tempo (`RUNNER_MAX_SESSOES_EXTRAS` na unidade do
runner, inteiro >= 0). A 4ª recebe 429 `LIMITE_DE_SESSOES`, e o comando diz como fechar um.

**As quatro condições de segurança** (aprovadas pelo card de segurança):

1. O token do runner nunca vai no argv nem na saída. O comando monta a configuração do curl com o
   `printf` (builtin do bash) e a entrega pelo stdin (`curl -K -`), como o `dgclaw-agente` faz.
2. O endereço é fixo, `http://127.0.0.1:${RUNNER_PORT:-4300}`. Qualquer URL vinda de argumento ou de
   variável (como `DGCLAW_RUNNER_URL`) é ignorada, e `RUNNER_PORT` precisa ser numérico.
3. O runner limita as sessões criadas por API (o teto acima), para um card em laço não esgotar a RAM
   do container do cliente.
4. O card herda as travas da principal: roda no mesmo `cwd` (`/home/agente`), onde ficam as regras
   `deny` do Gmail em `.claude/settings.local.json`. O comando não tem opção de outro `cwd`.

O card no Codex não tem os conectores do claude.ai (Gmail, Agenda, Drive) nem o Telegram: o que
precisa deles fica na principal.

## Em aberto

- `provedor.sh definir/estado`, adaptadores bash e o `launch.sh` ficaram de fora: a sessão
  passa a ser subida pelo agent-runner.
- Codex na API com chave real nunca foi exercitado (só chave falsa, sem prompt).
- Duas sessões Codex que sobem no mesmo segundo, na mesma casa, podem trocar os rollouts na
  descoberta (a descoberta é por cwd e hora). O runner exclui os ids já reivindicados, mas a corrida
  na primeira descoberta não tem como ser eliminada sem o Codex aceitar um id pré-fixado.
