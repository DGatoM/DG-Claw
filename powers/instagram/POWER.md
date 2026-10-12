# Poder: Instagram (influencer) — DG Claw

Definicao declarativa do poder **instagram**: o que instala, como ativa e como desativa.
Da a pessoa virtual a capacidade de **postar** (foto/reels) e **responder comentarios** no
Instagram, com QA visual, anti-injection e registro local. Tudo parametrizado por
`<ws>/.dgclaw/instagram.json` — **zero id hardcoded**.

## O que este poder instala

| Componente | Onde |
|---|---|
| Skill `instagram` (+ sub-docs post/comments/image-generation/heygen) | `$DGCLAW_PLUGIN_ROOT/skills/instagram/` |
| Crons de post e comentarios | `$DGCLAW_PLUGIN_ROOT/scripts/cron/dgclaw-post.sh`, `dgclaw-comentarios.sh` |
| Helpers Graph API / scrape / followers / anti-injection | `$DGCLAW_PLUGIN_ROOT/scripts/{ig-publish,scrape-comments,search-follower,untrusted}.py` |
| Timers systemd | `dgclaw-<slug>-post-{8h,13h,19h}.timer`, `dgclaw-<slug>-comments.timer` |
| Config do poder | `<ws>/.dgclaw/instagram.json` |
| Credenciais | `<ws>/.instagram_token` (chmod 600), `<ws>/.dgclaw/creds/cookies.txt` (chmod 600) |

O painel le `<ws>/.dgclaw/powers.json`: com o poder `enabled`, as abas **POSTS** e
**FOLLOWERS** ficam destravadas; desativado, voltam a travar.

## Schema do `instagram.json`

```json
{
  "igAccountId": "<id da conta Instagram Business>",
  "ownerNotifyTarget": "<telegram id do dono>",
  "tokenPath": "<ws>/.instagram_token",
  "cookiesPath": "<ws>/.dgclaw/creds/cookies.txt",
  "referencePhoto": "<ws>/assets/reference/base.jpg",
  "postModel": "opus",
  "commentsModel": "sonnet",
  "schedule": [
    {"time": "08:00", "type": "post"},
    {"time": "13:00", "type": "post"},
    {"time": "19:00", "type": "post"}
  ],
  "voiceId": "<opcional: voz HeyGen para reels>",
  "sheets": []
}
```

Defaults: `tokenPath=<ws>/.instagram_token`, `cookiesPath=<ws>/.dgclaw/creds/cookies.txt`,
`referencePhoto=<ws>/assets/reference/base.jpg`, `postModel=opus`, `commentsModel=sonnet`,
`sheets=[]` (vazio = pular planilhas Google).

> **Por que `commentsModel=sonnet`:** o classifier de seguranca server-side da Anthropic
> passou a **recusar** o cron de comentarios com Opus (AUP), porque o prompt manda
> processar texto adversario de terceiros em lote. Sonnet passa. Posts usam Opus.

## Ativacao

Coletar do dono e gravar em `instagram.json`:

1. **Token IG** (Graph API). **Validar antes de salvar** — so salva se o `GET /me` der ok:
   ```bash
   echo -n "<TOKEN>" > "$DGCLAW_WORKSPACE/.instagram_token"
   chmod 600 "$DGCLAW_WORKSPACE/.instagram_token"
   python3 $DGCLAW_PLUGIN_ROOT/scripts/ig-publish.py validate \
     --token-file "$DGCLAW_WORKSPACE/.instagram_token"
   # rc 0 = valido. Se falhar, NAO prosseguir.
   ```
2. **`igAccountId`** — id da conta Instagram Business.
3. **Cookies de login** (para o scrape de comentarios, que obtem usernames que a Graph API
   nao retorna). Formato Netscape/Mozilla cookies.txt:
   ```bash
   mkdir -p "$DGCLAW_WORKSPACE/.dgclaw/creds"
   cp <cookies.txt> "$DGCLAW_WORKSPACE/.dgclaw/creds/cookies.txt"
   chmod 600 "$DGCLAW_WORKSPACE/.dgclaw/creds/cookies.txt"
   ```
4. **Horarios** (`schedule`) — default 8h/13h/19h.
5. **`voiceId`** (opcional) — habilita reels HeyGen.
6. **`sheets`** (opcional) — IDs de planilha Google; vazio = pular.

Gravar `instagram.json`, depois instalar timers e ativar o poder:
```bash
sudo bash $DGCLAW_PLUGIN_ROOT/scripts/install-ig-timers.sh "$DGCLAW_WORKSPACE/.dgclaw/config.sh"
```
O `install-ig-timers.sh`:
- cria os timers de post (derivados do `schedule`) com `TZ=America/Sao_Paulo` (senao
  disparam em UTC), `User=root`, `HOME=/root`, `IS_SANDBOX=1`;
- cria o timer de comentarios (10/30min apos cada post + de hora em hora);
- roda `powers.py enable instagram --timers <nomes criados>` -> destrava POSTS/FOLLOWERS.

## Desativacao

```bash
sudo bash $DGCLAW_PLUGIN_ROOT/scripts/install-ig-timers.sh "$DGCLAW_WORKSPACE/.dgclaw/config.sh" --off
```
Isso para e remove os timers e roda `powers.py disable instagram`. Alternativa minima
(so travar a aba, sem mexer nos timers): `powers.py disable instagram`.

Apos desativar: abas POSTS/FOLLOWERS voltam a **travar** no painel; os crons saem cedo
(checam `powers.py is-enabled`). **Dados sao preservados** (`data/posts.jsonl`,
`data/comments.jsonl`, `persona/followers/`, `memory/relationships.json`). Token e cookies
permanecem (chmod 600); remova manualmente se quiser revogar o acesso.

## Gotchas

- **Token/cookies sao segredos** — chmod 600, nunca logar. Validar token com `GET /me`.
- **Anti-injection e o maior risco** — scrape falhou = nao responde; flag injection/url =
  pular comentario; nunca chutar username ausente.
- **Timezone** — timers com `TZ=America/Sao_Paulo`.
- **Cookies de login expiram** — quando expiram, o scrape falha e os comentarios sao
  pausados (por design). O dono precisa reexportar os cookies periodicamente; o
  `scrape-comments.py` avisa no stderr quando faltam <= 7 dias.
