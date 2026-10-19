# DG Claw Web

Servidor Node 22, sem nenhuma dependência npm (só módulos nativos), que roda uma vez no host e entrega:

1. **Login** (`/login`, `/sair`) com usuário e senha, sessão em cookie e limite de tentativas.
2. **Chat** em `/a/<agente>` (e `/`, que leva ao primeiro agente): a conversa com cada agente, montada a partir do registro da sessão dele.
3. **Proxy** dos painéis em `/p/<agente>/...`, só para quem está logado.

Ele escuta em `127.0.0.1:8300` e fica atrás de um proxy reverso com HTTPS (Caddy, nginx). Roda como root, porque lê as pastas dos agentes.

## Como rodar

```bash
node web/server.js
```

Em produção ele roda como serviço (`dgclaw-web.service`). O servidor escreve uma linha de log por evento, e cada falha diz o que aconteceu, com que entrada e o que fazer.

## Variáveis de ambiente

Valem as do processo e, por baixo delas, as do arquivo `DGCLAW_WEB_ENV` (formato `CHAVE=VALOR`, lido no boot).

| Variável | Padrão | O que faz |
|---|---|---|
| `DGCLAW_WEB_HOST` | `127.0.0.1` | Endereço em que escuta. |
| `DGCLAW_WEB_PORT` | `8300` | Porta. |
| `DGCLAW_AGENTES` | `/etc/dgclaw/agentes.json` | Registro de agentes (relido quando o arquivo muda). |
| `DGCLAW_WEB_ENV` | `/etc/dgclaw/web.env` | Arquivo com as demais variáveis. |
| `DGCLAW_WEB_DATA` | `/var/lib/dgclaw/web` | Pasta de dados (criada com permissão 700). Guarda `sessoes.json`. |
| `DGCLAW_PANEL_USER` | (obrigatória) | Usuário do login. |
| `DGCLAW_PANEL_PASSWORD_HASH` | (obrigatória) | Hash `scrypt$<N>$<r>$<p>$<sal base64url>$<hash base64url>`. Sem ele o login fica **trancado**. |
| `DGCLAW_WEB_ORIGENS` | vazio | Origens extras aceitas nas escritas, separadas por vírgula (ex.: `https://app.exemplo.com`). |
| `DGCLAW_WEB_PROXIES_CONFIAVEIS` | vazio | IPs, além de 127.0.0.1 e ::1, de quem pode informar `X-Forwarded-*`. |
| `DGCLAW_WEB_MAX_UPLOAD_MB` | `50` | Limite de um anexo (o corpo é lido em memória até esse tamanho). |
| `DGCLAW_WEB_MAX_TEXTO` | `20000` | Limite de caracteres de uma mensagem. |
| `DGCLAW_WEB_TZ` | `TZ` do sistema | Fuso usado em `hhmm`, `dia` e na pasta de uploads. |
| `DGCLAW_CHANNEL_SOURCE` | `plugin:telegram` | Prefixo do canal externo reconhecido no registro da sessão. |
| `ELEVENLABS_API_KEY` | vazio | Liga microfone e voz. |
| `ELEVENLABS_VOICE_ID` | vazio | Voz padrão (cada agente pode ter a sua no campo `voz`). |
| `OPENAI_API_KEY` | vazio | Liga só o microfone (transcrição), se não houver chave da ElevenLabs. Também liga o modo escondido, se não houver `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY` | vazio | Liga o modo escondido completo (Claude Haiku). Sem nenhuma chave de modelo, só o filtro automático da tela age. |
| `DGCLAW_SIGILO_MODELO` | `claude-haiku-4-5` ou `gpt-4.1-mini` | Troca o modelo do modo escondido. |
| `DGCLAW_SIGILO_LIBERADOS` | vazio | Nomes que o modo escondido nunca esconde, separados por vírgula. |

Sem chave de voz, `voz` e `microfone` saem `false` em `/api/v1/agents` (a tela esconde os botões) e as rotas respondem 503 com o motivo.

## Registro de agentes (`agentes.json`)

```json
{"versao":1,"agentes":[{
  "slug":"admin","nome":"Admin","tipo":"admin",
  "runner":"http://127.0.0.1:4300","agente_id":"...","chat_id":"c_admin",
  "avatar":"🛠","cor":"#4A5D78","provedor":"claude","modelo":"opus",
  "transcripts_dir":"/root/.claude/projects",
  "porta_painel":null,"proxy_segredo_arquivo":null,"runner_token_arquivo":null,
  "home_host":"/opt/dgclaw/admin","home_container":"/opt/dgclaw/admin",
  "cofre_arquivo":null,"container":null,"dono":null
}]}
```

- `slug`: `^[a-z0-9][a-z0-9-]{0,31}$`. O agente com `tipo: "admin"` vem primeiro na lista.
- `runner` e `agente_id`: onde falar com o runner do agente. `runner_token_arquivo` (ou o sinônimo `tokenArquivo`) aponta para o arquivo com o token; se existir, vai como `Authorization: Bearer`.
- `chat_id`: o id da conversa no envelope (padrão `c_<slug>`).
- `transcripts_dir`: onde ficam os `.jsonl` das sessões. O arquivo é `<transcripts_dir>/*/<sessionId>.jsonl`, e o `sessionId` vem do runner.
- `home_host` e `home_container`: a pasta do agente vista pelo host e por dentro do container. Anexos são gravados em `<home_host>/uploads/AAAA-MM-DD/` e o agente recebe o caminho traduzido para `home_container`.
- `porta_painel` e `proxy_segredo_arquivo`: o painel do agente (porta local) e o arquivo com o segredo de confiança do proxy. O Admin não tem painel.
- `voz`: id da voz do agente (ElevenLabs).
- `cofre_arquivo`: o `cofre.env` do agente no host (`<casa>/cofre/cofre.env`). Só quem tem esse campo está no layout da v1 e tem o cofre gravado pelo Web (ver "Cofre dos agentes da v1"). `container` é o nome do container (padrão `dgclaw-<slug>`) e `dono` o nome que a tela do cofre mostra (padrão `Dono`).
- Um agente inválido é ignorado, com um aviso no log que diz qual e por quê. Arquivo ausente ou ilegível: a API responde **503 com o motivo**, nunca uma lista vazia calada.

## Rotas

Páginas: `GET /login`, `POST /login` (campos `usuario`, `senha`, `next`), `GET|POST /sair`, `GET /` (leva ao primeiro agente), `GET /a/<slug>`, `GET /mesa` (Mesa de tarefas). Sem sessão, a página redireciona para `/login?next=...`; a API responde 401 JSON.

O erro do login por formulário volta como 302 para `/login?erro=<código>&next=...`. Códigos: `credenciais`, `limite` (429 de tentativas), `origem` (Origin recusada), `campos` (faltou campo), `bloqueado` (login trancado, sem hash). Quem pede JSON (`Accept` ou `Content-Type` `application/json`) recebe o status e `{ok:false, erro}`.

Livres (sem sessão): `GET /api/saude` e `GET /api/login-estado` (diz se o login está trancado e por quê). Arquivos estáticos de `web/public/` (CSS, JS, ícones, manifest, `sw.js`) também saem sem sessão; as páginas `.html`, exceto `login.html`, exigem sessão.

API (todas com sessão; erros sempre `{ok:false, erro:"motivo em português"}`):

| Rota | Faz |
|---|---|
| `GET /api/v1/agents` | Lista de agentes: `id`, `nome`, `subtitulo`, `avatar`, `avatar_img`, `cor`, `tipo`, `provedor`, `modelo`, `rotulo_provedor`, `tem_painel`, `painel_url`, `voz`, `microfone`. |
| `GET /api/v1/agents/:id/messages?limit&before&after` | Thread: `{ok, msgs, avisos, mais_antigas, before, limit}`. Padrão: as 60 mais novas. |
| `GET /api/v1/agents/:id/stream?since` | SSE: `ola`, `msgs {novas, sumidas, avisos}` (id = maior `ep`; respeita `Last-Event-ID`), `atividade`. `: ping` a cada 15 s, fecha em 50 min. |
| `GET /api/v1/agents/:id/wait?since&timeout` | Reserva do SSE (long-poll de até 28 s). |
| `GET /api/v1/nao-lidas` | Bolinha de não lidas: `{ok, agentes: {<slug>: {nao_lidas, mais?, visto_ep, ultima_ep, marco_novo?, erro?}}}`. Conta só mensagens do agente (sem avisos de sistema) com `ep` maior que o `visto_ep` guardado no servidor para o usuário da sessão. Teto 99 (com `mais: true`). Agente sem marco ganha um na hora, com `marco_novo: true` e contagem 0. Conversa que não respondeu em 1,5 s vem com `nao_lidas: null` e `erro` (nunca 0) e sem marco. |
| `POST /api/v1/agents/:id/lido` | `{ep}`: marca a conversa como lida até esse `ep` e devolve `{ok, visto_ep}`. O marco só avança (um `ep` menor não recua). `ep` inválido: 400. Estado em `<dados>/nao-lidas.json` (permissão 600). |
| `POST /api/v1/agents/:id/send` | `{text, anexos?, cliente_id?}`; idempotente por `cliente_id`. |
| `POST /api/v1/agents/:id/upload` | Multipart (`file`, `enviar`, `legenda`, `cliente_id`). |
| `GET`/`POST`/`DELETE /api/v1/agents/:id/login`, `POST .../login/codigo`, `POST .../login/oi` | Login assistido do Claude/Codex pela conversa (repasse ao runner) e o primeiro oi. Docs em `GET /api/v1/login/docs.md` (fonte: `docs/LOGIN-NA-CONVERSA.md`). |
| `GET /api/v1/media/:id` e `/thumb` | Arquivo registrado, com `Range`. `?baixar=1` força o download. HTML, SVG, XML e JS abertos direto saem com CSP `sandbox` e `nosniff`. |
| `GET` e `HEAD /api/v1/media/:id/visual?tema=claro` (ou `escuro`) | Documento do visual (`vis-*.html` do agente, com a base `dgvis` na frente), com CSP `sandbox allow-scripts` no cabeçalho. Erro vem como página HTML com o motivo (404, 410, 413, 415, 500). Ver `docs/VISUAIS.md`. |
| `POST /api/v1/transcribe` | Multipart com `audio`. Resposta `{ok, text}`. |
| `POST /api/v1/tts` | `{agent_id, text}`; responde o áudio (`audio/mpeg`). `X-TTS-Cortado: 1` quando o texto foi cortado. |
| `GET /api/v1/tts/cota` | Uso da cota de voz. |
| `POST /api/v1/sigilo` | `{textos:[...]}` (até 600). Aponta os trechos sensíveis de cada texto para o modo escondido: `{trechos, avisos, analisados, modelo, so_regex}`. `GET /api/v1/sigilo/estado` diz o modelo ativo; docs em `GET /api/v1/sigilo/docs.md`. Ver `docs/MODO-ESCONDIDO.md`. |
| `GET /api/v1/eu` | `{ok, usuario}`. |
| `GET`/`PUT`/`DELETE /api/v1/foco/:agente`, `POST .../itens`, `PATCH`/`DELETE .../itens/:id`, `GET .../eventos?desde_id`, `GET /api/v1/foco/docs.md` | Modo foco: lista curta por agente que o agente monta e o dono tica na tela; evento `foco` no stream. Docs em `docs/MODO-FOCO.md`. |
| `GET`/`POST`/`PATCH`/`DELETE /api/v1/tarefas[/:id]` | Mesa de tarefas dos agentes (criar, atualizar, concluir, cancelar). Contrato completo em `docs/MESA.md` (também em `GET /api/v1/tarefas/docs.md`). |
| `ANY /p/<slug>/*` | Proxy do painel do agente. |

**Mensagem da thread:** `{id, ep, hhmm, dia, origin, text, kind, media, fmt, editada, reacoes, cita, via, quem}`. `origin` é `dono`, `agente` ou `rotina`. `media` é `{id, kind, nome, bytes, disponivel, url, thumb, path}`.

**Montagem da thread** (porta do `scripts/_lib/thread_log.py`, com leitura incremental por offset, sem reler o arquivo inteiro):

- fala do dono: turno `user` com o envelope `<dgchat from chat msg ts>texto</dgchat>` (só o corpo aparece); com o Telegram ligado, também `<channel source="plugin:telegram...">`;
- fala do agente: `tool_use` terminado em `__dgchat__reply` (texto) ou `__dgchat__send_file` (mídia), e `telegram__reply` (marcado `via:"telegram"`). Texto solto do assistente não conta;
- somem: `<plataforma ...>`, `system-reminder`, `tool_result`, eco de comando, recado do sistema e poke de rotina. Depois de um `<plataforma ...>` ou de um poke, o que o agente diz sai como `rotina`.

**Envio:** o texto vira `<dgchat from="pessoa" chat="<chat_id>" msg="<id>" ts="<iso>">texto</dgchat>` (com `</dgchat>` escapado no corpo) e segue para `POST <runner>/api/agents/<agente_id>/input` com `{text, submit:true, injectWhenIdle:true}`. No Admin, texto que começa com `/` (`/compact`, `/clear`) vai cru, sem envelope. Anexos entram no texto como linhas `[anexo: <caminho visto de dentro>]`.

**Atividade:** `GET <runner>/api/agents/<agente_id>` (cache de 2 s). `working` vira `trabalhando` (ação = ferramenta atual ou `pensando`), `waiting_input` vira `alerta:"permissao"`, `idle` vira `ocioso`, e runner fora do ar (ou status desconhecido) vira `sem_sinal` com o motivo.

**Rótulo do provedor:** `rotulo_provedor` vem de `GET <runner>/api/provedor` (campo `rotulo`), com cache de 60 s por agente e espera máxima de 1,5 s. Se a rota não existir, falhar ou demorar, vale a reserva montada do registro (`provedor, modelo`), com uma linha de log dizendo o motivo.

## Cofre dos agentes da v1

Na v1 o painel roda dentro do container e não pode guardar chave (o agente a leria). Quem grava é o Web, no host, em `lib/cofre-agente.js`. Para agente com `cofre_arquivo`, estas rotas do painel são respondidas pelo próprio Web (`lib/cofre-rotas.js`) e **nunca chegam ao painel**; o formato das respostas e dos erros (`{error, howToFix}`) é o do painel, porque é a tela dele que as lê:

| Rota | Faz |
|---|---|
| `GET /p/<slug>/api/cofre` | Estado: chaves (só os 4 últimos caracteres), provedores, onde fica a chave. |
| `POST` ou `PUT /p/<slug>/api/cofre` | `{envName, valor, provedor, aplicar}`. Guarda; com `aplicar:true` também reinicia. Se o reinício falhar, a chave continua guardada e a resposta traz `guardado` e `aplicado:{ok:false}`. |
| `DELETE /p/<slug>/api/cofre?envName=X` | Revoga (tira do cofre e data o registro). |
| `POST /p/<slug>/api/cofre/aplicar` | Reinicia o agente: `podman exec <container> systemctl restart dgclaw-runner`, porque o runner só lê o cofre quando parte. |
| `POST /p/<slug>/api/provedor` | O Web assume quando o modo de pagar usa chave ou token: guarda a chave, manda a escolha ao runner (`reiniciar:false`) e reinicia. A chave nunca vai ao painel nem ao runner. Modo de assinatura (sem variável) segue para o painel com o corpo intacto (sem o campo `chave`, se veio um). |

Só essas rotas exatas leem o corpo (até 64 KB; acima disso, 413). O caminho é comparado depois de `/p/<slug>`, sem olhar maiúscula, barra final nem query string. Tudo o mais, e todo agente sem `cofre_arquivo`, passa pelo proxy como sempre. A sessão e o CSRF continuam sendo conferidos antes.

Onde fica cada coisa: o valor em `<casa>/cofre/cofre.env` (uma linha `NOME='valor'`), a lista de nomes em `<casa>/config/cofre-nomes` (644, o que o painel de dentro lê) e os metadados (quem cadastrou, quando, últimos 4) em `<DGCLAW_WEB_DATA>/cofre/<slug>.json` (600, fora da casa). Toda escrita usa `lib/grava-seguro.js`. Duas gravações ao mesmo tempo não perdem linha (trava por agente). Segredo nunca vai a log, a erro nem a resposta.

### Linha de comando

```bash
printf %s "$CHAVE" | node web/bin/cofre.js guardar <agente> OPENAI_API_KEY --provedor openai [--aplicar] [--quem "texto"] [--json]
node web/bin/cofre.js revogar <agente> OPENAI_API_KEY [--quem "texto"] [--json]
node web/bin/cofre.js listar  <agente> [--json]
node web/bin/cofre.js aplicar <agente> [--json]
```

O valor do `guardar` entra sempre pelo stdin; valor em argumento e stdin de teclado são recusados. Usa `DGCLAW_WEB_ENV`, `DGCLAW_AGENTES` e `DGCLAW_WEB_DATA`. Saída 0 (deu certo), 1 (recusa, com o motivo), 2 (uso errado). É o que `dgclaw agente cofre` chama.

## Segurança

- **Senha:** scrypt com `crypto.scrypt`, N máximo de 2^20, comparação com `timingSafeEqual`; o usuário também é comparado em tempo constante. O scrypt roda mesmo com o usuário errado, para o tempo não revelar qual dos dois falhou. Sem hash válido, o login fica trancado (ninguém entra) e a tela diz que falta rodar o gerador de hash do instalador.
- **Limite de tentativas:** 5 erros por IP em 15 minutos viram 429 com `Retry-After`. O IP vem da conexão; `X-Forwarded-For` só vale (o último valor) quando a conexão vem de 127.0.0.1, ::1 ou de um IP de `DGCLAW_WEB_PROXIES_CONFIAVEIS`.
- **Sessão:** token aleatório de 32 bytes no cookie `dgclaw_sessao` (`HttpOnly`, `SameSite=Lax`, `Path=/`, 30 dias, `Secure` quando o proxy local avisa `X-Forwarded-Proto: https`). No disco fica só o sha256 do token, em `sessoes.json` (escrita atômica, permissão 600).
- **CSRF:** toda escrita (POST, PUT, PATCH, DELETE, inclusive login, sair e proxy) exige `Origin` igual à origem do próprio Web ou listada em `DGCLAW_WEB_ORIGENS`. Sem `Origin`, ou `null`: 403 com o motivo. Vale também para o upgrade de WebSocket.
- **Proxy dos painéis:** só logado; apaga do pedido `X-DGClaw-Proxy` e `X-DGClaw-Usuario` (em qualquer caixa) e acrescenta os dois, com o segredo lido de `proxy_segredo_arquivo` e o usuário logado; tira o cookie da sessão do Web do que vai ao painel; repassa em stream (SSE, corpo grande) e WebSocket. O segredo não aparece em log nem em resposta. Painel fora do ar: 502 com motivo. Agente sem painel: 404 com motivo.
- **Mídia:** só sai arquivo dentro do `home_host` do agente dono (ou de `DGCLAW_WEB_DATA`), conferido com `realpath` a cada pedido; link simbólico para fora é recusado. Arquivos estáticos: sem listar pasta e sem sair de `web/public/`.
- **Logs:** nunca levam senha, token, cookie ou segredo.

## Token do Telegram colado no chat

Se a mensagem enviada for **só** um token do BotFather (`^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$`, depois do `trim`), o Web não repassa o texto ao runner. Em `lib/token-telegram.js`:

- No Admin: responde 400, sem gravar nada (o Admin não tem canal externo).
- Em agente de trabalho: grava `<home_host>/.dgclaw/telegram/.env` (`TELEGRAM_BOT_TOKEN=...`, pastas 700, arquivo 600), preserva as outras linhas do `.env` e manda ao agente só `[token do Telegram guardado com segurança, final XXXX]`.
- A gravação roda num processo filho com o uid/gid do dono de `home_host` (`lib/grava-token-filho.js`, token pelo stdin, nunca por argv nem ambiente), porque a pasta é do agente e ele poderia trocá-la por um atalho: como o filho não é root, o kernel só deixa escrever onde o próprio agente já pode. Casa pertencendo ao root é recusada.
- A resposta do `/send` traz `token_guardado: true` e `mascarado` (`123456789:••••••XXXX`); a tela troca o balão pelo mascarado. Com `cliente_id` repetido, devolve a mesma resposta sem regravar.
- Mensagem com outras palavras junto não é interceptada. O token nunca entra em log, em erro nem no registro de idempotência.
- O agente confere com `dgclaw-agente canal telegram conferir`.

## Como testar

```bash
node --test web/test/
```

Sem dependências. Os testes sobem o servidor em porta livre (porta 0), com um runner FALSO (`web/test/runner-falso.js`), um painel falso e fixtures em `web/test/fixtures/`.

## Smoke manual

```bash
mkdir -p /tmp/dgclaw-smoke && cd /tmp/dgclaw-smoke
printf '{"versao":1,"agentes":[{"slug":"admin","nome":"Admin","tipo":"admin","runner":"http://127.0.0.1:4300","agente_id":"x"}]}' > agentes.json
HASH=$(node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync('minha-senha',s,32,{N:16384,r:8,p:1});console.log('scrypt\$16384\$8\$1\$'+s.toString('base64url')+'\$'+h.toString('base64url'))")
DGCLAW_WEB_ENV=/dev/null DGCLAW_AGENTES=$PWD/agentes.json DGCLAW_WEB_DATA=$PWD/dados DGCLAW_WEB_PORT=8399 \
  DGCLAW_PANEL_USER=admin DGCLAW_PANEL_PASSWORD_HASH="$HASH" node /caminho/do/repo/web/server.js &
curl -si -c jar -H 'Origin: http://127.0.0.1:8399' -H 'Content-Type: application/json' \
  -d '{"usuario":"admin","senha":"minha-senha"}' http://127.0.0.1:8399/login
curl -s -b jar http://127.0.0.1:8399/api/v1/agents
```

## Alertas de entrega e pedido

Veja [a marcação, a API e a persistência](docs/ALERTAS.md). Prefixos `[ENTREGA]`
e `[PEDIDO]` geram ícones e balões coloridos em todos os chats desta instalação.

## Acervo com cache no aparelho

Toque na foto do agente para abrir Mídias, Links e Arquivos, com cache por conta,
paginação incremental e miniaturas reais. Contrato e limites: [MIDIAS-CACHE.md](docs/MIDIAS-CACHE.md).
