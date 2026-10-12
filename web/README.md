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
| `OPENAI_API_KEY` | vazio | Liga só o microfone (transcrição), se não houver chave da ElevenLabs. |

Sem chave de voz, `voz` e `microfone` saem `false` em `/api/v1/agents` (a tela esconde os botões) e as rotas respondem 503 com o motivo.

## Registro de agentes (`agentes.json`)

```json
{"versao":1,"agentes":[{
  "slug":"admin","nome":"Admin","tipo":"admin",
  "runner":"http://127.0.0.1:4300","agente_id":"...","chat_id":"c_admin",
  "avatar":"🛠","cor":"#4A5D78","provedor":"claude","modelo":"opus",
  "transcripts_dir":"/root/.claude/projects",
  "porta_painel":null,"proxy_segredo_arquivo":null,"runner_token_arquivo":null,
  "home_host":"/opt/dgclaw/admin","home_container":"/opt/dgclaw/admin"
}]}
```

- `slug`: `^[a-z0-9][a-z0-9-]{0,31}$`. O agente com `tipo: "admin"` vem primeiro na lista.
- `runner` e `agente_id`: onde falar com o runner do agente. `runner_token_arquivo` (ou o sinônimo `tokenArquivo`) aponta para o arquivo com o token; se existir, vai como `Authorization: Bearer`.
- `chat_id`: o id da conversa no envelope (padrão `c_<slug>`).
- `transcripts_dir`: onde ficam os `.jsonl` das sessões. O arquivo é `<transcripts_dir>/*/<sessionId>.jsonl`, e o `sessionId` vem do runner.
- `home_host` e `home_container`: a pasta do agente vista pelo host e por dentro do container. Anexos são gravados em `<home_host>/uploads/AAAA-MM-DD/` e o agente recebe o caminho traduzido para `home_container`.
- `porta_painel` e `proxy_segredo_arquivo`: o painel do agente (porta local) e o arquivo com o segredo de confiança do proxy. O Admin não tem painel.
- `voz`: id da voz do agente (ElevenLabs).
- Um agente inválido é ignorado, com um aviso no log que diz qual e por quê. Arquivo ausente ou ilegível: a API responde **503 com o motivo**, nunca uma lista vazia calada.

## Rotas

Páginas: `GET /login`, `POST /login` (campos `usuario`, `senha`, `next`), `GET|POST /sair`, `GET /` (leva ao primeiro agente), `GET /a/<slug>`. Sem sessão, a página redireciona para `/login?next=...`; a API responde 401 JSON.

O erro do login por formulário volta como 302 para `/login?erro=<código>&next=...`. Códigos: `credenciais`, `limite` (429 de tentativas), `origem` (Origin recusada), `campos` (faltou campo), `bloqueado` (login trancado, sem hash). Quem pede JSON (`Accept` ou `Content-Type` `application/json`) recebe o status e `{ok:false, erro}`.

Livres (sem sessão): `GET /api/saude` e `GET /api/login-estado` (diz se o login está trancado e por quê). Arquivos estáticos de `web/public/` (CSS, JS, ícones, manifest, `sw.js`) também saem sem sessão; as páginas `.html`, exceto `login.html`, exigem sessão.

API (todas com sessão; erros sempre `{ok:false, erro:"motivo em português"}`):

| Rota | Faz |
|---|---|
| `GET /api/v1/agents` | Lista de agentes: `id`, `nome`, `subtitulo`, `avatar`, `avatar_img`, `cor`, `tipo`, `provedor`, `modelo`, `rotulo_provedor`, `tem_painel`, `painel_url`, `voz`, `microfone`. |
| `GET /api/v1/agents/:id/messages?limit&before&after` | Thread: `{ok, msgs, avisos, mais_antigas, before, limit}`. Padrão: as 60 mais novas. |
| `GET /api/v1/agents/:id/stream?since` | SSE: `ola`, `msgs {novas, sumidas, avisos}` (id = maior `ep`; respeita `Last-Event-ID`), `atividade`. `: ping` a cada 15 s, fecha em 50 min. |
| `GET /api/v1/agents/:id/wait?since&timeout` | Reserva do SSE (long-poll de até 28 s). |
| `POST /api/v1/agents/:id/send` | `{text, anexos?, cliente_id?}`; idempotente por `cliente_id`. |
| `POST /api/v1/agents/:id/upload` | Multipart (`file`, `enviar`, `legenda`, `cliente_id`). |
| `GET /api/v1/media/:id` e `/thumb` | Arquivo registrado, com `Range`. `?baixar=1` força o download. |
| `POST /api/v1/transcribe` | Multipart com `audio`. Resposta `{ok, text}`. |
| `POST /api/v1/tts` | `{agent_id, text}`; responde o áudio (`audio/mpeg`). `X-TTS-Cortado: 1` quando o texto foi cortado. |
| `GET /api/v1/tts/cota` | Uso da cota de voz. |
| `GET /api/v1/eu` | `{ok, usuario}`. |
| `ANY /p/<slug>/*` | Proxy do painel do agente. |

**Mensagem da thread:** `{id, ep, hhmm, dia, origin, text, kind, media, fmt, editada, reacoes, cita, via, quem}`. `origin` é `dono`, `agente` ou `rotina`. `media` é `{id, kind, nome, bytes, disponivel, url, thumb, path}`.

**Montagem da thread** (porta do `scripts/_lib/thread_log.py`, com leitura incremental por offset, sem reler o arquivo inteiro):

- fala do dono: turno `user` com o envelope `<dgchat from chat msg ts>texto</dgchat>` (só o corpo aparece); com o Telegram ligado, também `<channel source="plugin:telegram...">`;
- fala do agente: `tool_use` terminado em `__dgchat__reply` (texto) ou `__dgchat__send_file` (mídia), e `telegram__reply` (marcado `via:"telegram"`). Texto solto do assistente não conta;
- somem: `<plataforma ...>`, `system-reminder`, `tool_result`, eco de comando, recado do sistema e poke de rotina. Depois de um `<plataforma ...>` ou de um poke, o que o agente diz sai como `rotina`.

**Envio:** o texto vira `<dgchat from="pessoa" chat="<chat_id>" msg="<id>" ts="<iso>">texto</dgchat>` (com `</dgchat>` escapado no corpo) e segue para `POST <runner>/api/agents/<agente_id>/input` com `{text, submit:true, injectWhenIdle:true}`. No Admin, texto que começa com `/` (`/compact`, `/clear`) vai cru, sem envelope. Anexos entram no texto como linhas `[anexo: <caminho visto de dentro>]`.

**Atividade:** `GET <runner>/api/agents/<agente_id>` (cache de 2 s). `working` vira `trabalhando` (ação = ferramenta atual ou `pensando`), `waiting_input` vira `alerta:"permissao"`, `idle` vira `ocioso`, e runner fora do ar (ou status desconhecido) vira `sem_sinal` com o motivo.

**Rótulo do provedor:** `rotulo_provedor` vem de `GET <runner>/api/provedor` (campo `rotulo`), com cache de 60 s por agente e espera máxima de 1,5 s. Se a rota não existir, falhar ou demorar, vale a reserva montada do registro (`provedor, modelo`), com uma linha de log dizendo o motivo.

## Segurança

- **Senha:** scrypt com `crypto.scrypt`, N máximo de 2^20, comparação com `timingSafeEqual`; o usuário também é comparado em tempo constante. O scrypt roda mesmo com o usuário errado, para o tempo não revelar qual dos dois falhou. Sem hash válido, o login fica trancado (ninguém entra) e a tela diz que falta rodar o gerador de hash do instalador.
- **Limite de tentativas:** 5 erros por IP em 15 minutos viram 429 com `Retry-After`. O IP vem da conexão; `X-Forwarded-For` só vale (o último valor) quando a conexão vem de 127.0.0.1, ::1 ou de um IP de `DGCLAW_WEB_PROXIES_CONFIAVEIS`.
- **Sessão:** token aleatório de 32 bytes no cookie `dgclaw_sessao` (`HttpOnly`, `SameSite=Lax`, `Path=/`, 30 dias, `Secure` quando o proxy local avisa `X-Forwarded-Proto: https`). No disco fica só o sha256 do token, em `sessoes.json` (escrita atômica, permissão 600).
- **CSRF:** toda escrita (POST, PUT, PATCH, DELETE, inclusive login, sair e proxy) exige `Origin` igual à origem do próprio Web ou listada em `DGCLAW_WEB_ORIGENS`. Sem `Origin`, ou `null`: 403 com o motivo. Vale também para o upgrade de WebSocket.
- **Proxy dos painéis:** só logado; apaga do pedido `X-DGClaw-Proxy` e `X-DGClaw-Usuario` (em qualquer caixa) e acrescenta os dois, com o segredo lido de `proxy_segredo_arquivo` e o usuário logado; tira o cookie da sessão do Web do que vai ao painel; repassa em stream (SSE, corpo grande) e WebSocket. O segredo não aparece em log nem em resposta. Painel fora do ar: 502 com motivo. Agente sem painel: 404 com motivo.
- **Mídia:** só sai arquivo dentro do `home_host` do agente dono (ou de `DGCLAW_WEB_DATA`), conferido com `realpath` a cada pedido; link simbólico para fora é recusado. Arquivos estáticos: sem listar pasta e sem sair de `web/public/`.
- **Logs:** nunca levam senha, token, cookie ou segredo.

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
