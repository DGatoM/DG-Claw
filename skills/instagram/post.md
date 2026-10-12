# Post no Instagram — passo a passo (DG Claw)

Sub-doc da skill `instagram`. Cobre a publicacao de um post (foto ou reels).
Acionado pelos crons de 8h/13h/19h e sob demanda. **Voz = SOUL.md/PERSONALITY.md.**

## 1. Contexto (ler antes de decidir)

1. `.dgclaw/instagram.json` — `igAccountId`, `tokenPath`, `referencePhoto`, `postModel`,
   `voiceId`, `sheets`, `schedule`.
2. `working-memory.md` — o que ja rolou hoje + secao **"Instrucoes do <dono>"**.
3. `SOUL.md` + `PERSONALITY.md` — sua voz (tom da legenda, o que te empolga).
4. A secao "## Agora" da working-memory, que traz o clima do momento (se houver
   extensao de emocoes, o humor aparece ali) e adapta a energia da legenda.
5. Ultimos posts: `tail` em `data/posts.jsonl` (evitar repetir tema/formato recente).

**Avisar o dono — inicio:**
```bash
bash $DGCLAW_PLUGIN_ROOT/scripts/notify-owner.sh "Iniciando post <HORARIO>"
```

## 2. Instrucoes do dono (working-memory)

Na secao "Instrucoes do <dono>", aplique apenas linhas cuja tag bata com este cron:
- `[post-8h]`, `[post-13h]`, `[post-19h]` -> so no horario correspondente
- `[post]` -> qualquer post
- `[qualquer]` -> qualquer cron

Ao aplicar uma instrucao, **marque a linha** com ` [APLICADO <HORARIO>]`. Ignore tags de
outros crons (ex.: `[comentarios]`).

## 3. Decidir tema e formato

- Respeite primeiro as instrucoes do dono (passo 2).
- Senao, escolha um tema coerente com a persona (SOUL/PERSONALITY) e com o dia
  (working-memory, humor). Varie em relacao aos ultimos posts (`data/posts.jsonl`).
- Formato:
  - **Foto** (default) -> siga `image-generation.md`.
  - **Reels com avatar falante** -> so se `voiceId` estiver definido no instagram.json
    e o post pedir video; siga `heygen-video.md`. (19h costuma ser o slot de reels.)

## 4. Gerar a imagem (ou o video)

Siga `image-generation.md` (regras R1-R4) ou `heygen-video.md`.

**QA visual OBRIGATORIO** (tabela em `image-generation.md`): identidade/rosto, anatomia,
grafia de texto na imagem, consistencia com a `referencePhoto`. **Off-model -> regenerar
(ate 2x).** Nunca publique imagem reprovada no QA.

## 5. Aprovacao do dono

Mostre o preview (imagem + legenda) ao dono e **aguarde OK** antes de publicar. Em cron
sem resposta sincrona: mande o preview e a legenda pelo notify-owner e siga a politica do
projeto (publicar so apos aprovacao quando exigida; senao manter como rascunho e avisar).

## 6. Publicar via Graph API

A imagem precisa estar numa **URL publica** (faca upload pro servico de host configurado).
Depois:
```bash
TOKEN_PATH=$(python3 -c "import json,os;c=json.load(open('.dgclaw/instagram.json'));print(c.get('tokenPath') or os.path.join(os.environ['DGCLAW_WORKSPACE'],'.instagram_token'))")
IG_ID=$(python3 -c "import json;print(json.load(open('.dgclaw/instagram.json'))['igAccountId'])")

python3 $DGCLAW_PLUGIN_ROOT/scripts/ig-publish.py publish-image \
  --account "$IG_ID" \
  --image-url "<URL_PUBLICA_DA_IMAGEM>" \
  --caption-file /tmp/caption.txt \
  --token-file "$TOKEN_PATH"
```
(Use `--caption-file` para legendas longas/multilinha — evita problemas de shell quoting.)
A saida traz `mediaId` e, quando disponivel, `permalink`.

## 7. Registrar (OBRIGATORIO — imediatamente apos publicar)

Sem isto, o cron de comentarios **nao ve o post** e nao responde os comentarios dele:
```bash
echo '{"date":"'$(date +%F)'","time":"'$(date +%H:%M)'","theme":"<TEMA>","type":"<foto|reels>","postId":"<MEDIA_ID>","postUrl":"<PERMALINK>","status":"PUBLICADO"}' >> data/posts.jsonl
```
Se `sheets` estiver configurado no instagram.json, espelhe na planilha (senao, pule).

## 8. Anunciar o resultado e atualizar a memoria

```bash
bash $DGCLAW_PLUGIN_ROOT/scripts/ext-event.sh post_success
```
Atualize `working-memory.md`:
- **Hoje**: tema postado + por que + a fisgada/hipotese testada.
- **Na Minha Cabeca**: se foi uma decisao editorial notavel.
- **Quero Falar com o <dono> Sobre**: se teve escolha que ele pode querer opinar.

## 9. Relatorio final ao dono

```bash
bash $DGCLAW_PLUGIN_ROOT/scripts/notify-owner.sh "Post <HORARIO> publicado: <PERMALINK>"
```

> Se algo falhar (geracao, API, upload): anuncie `post_failed` com o `ext-event.sh`, avise
> o dono dizendo em que passo parou e qual foi o erro, e **nao** marque como publicado.
