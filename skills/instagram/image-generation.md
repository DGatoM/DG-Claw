# Geracao de Imagem — regras genericas (DG Claw)

Sub-doc da skill `instagram`. Regras **invariantes** para gerar a imagem de um post a
partir da foto-base da pessoa virtual. Ferramenta: **Nano Banana (Gemini image)**.

> A `referencePhoto` (foto-base) vem do `instagram.json` (default `<ws>/assets/reference/base.jpg`).
> Ela carrega a identidade visual — rosto, cabelo, feicoes. **Deixe a referencia mandar.**

## Regras obrigatorias

### R1 — Sempre usar a foto-base
Toda imagem da pessoa e gerada com a `referencePhoto` como referencia. No prompt, inclua
literalmente:
> "Keep the face, hair style, hair color, and hair length EXACTLY as shown in the
> reference image. Do not change anything about the hair."

### R2 — Nao descrever cabelo/feicoes no prompt
Nao escreva cor, comprimento, textura, volume ou estilo de cabelo, nem feicoes do rosto.
Deixe a referencia definir tudo isso. Descrever leva o modelo a divergir da identidade.

Palavras a **remover** se aparecerem (cabelo): cores (green, dark, blonde, dyed, ombre,
highlights), comprimento (long, short, shoulder-length, cropped), textura (wavy, curly,
straight, sleek), volume (voluminous, thin, thick), estilo (messy, bangs, bun, ponytail,
braid, parted).

### R3 — Reler o prompt antes de chamar a API (checkpoint)
Depois de escrever o prompt e **antes** de chamar a Gemini:
1. Releia o prompt inteiro procurando ativamente descricoes de cabelo/feicoes (R2).
2. Remova o que encontrar.
3. Garanta que a unica instrucao sobre cabelo e a literal de R1.

Esse checkpoint existe porque e facil descrever a cena no automatico e acabar contradizendo
a referencia — o que destroi a consistencia de identidade.

### R4 — QA visual (rode SEMPRE antes de publicar)
Veja a imagem gerada e cheque:

| Item | Reprova se... |
|---|---|
| Identidade/rosto | rosto destoa da `referencePhoto` |
| Olhar pra camera (reels) | nos reels, nao esta olhando pra camera / POV errado |
| Anatomia | maos, dedos, olhos, membros errados |
| Grafia de texto na imagem | texto/overlay com erro de ortografia |
| Consistencia com a foto-base | cabelo/feicoes mudaram em relacao a referencia |

**Qualquer item reprovado -> REGERAR.** Tente ate **2x**. Se ainda assim falhar, avise o
dono e nao publique.

## Formato

| Tipo | Aspect ratio | Resolucao |
|---|---|---|
| Post feed | **4:5 vertical** | 1080x1350 |
| Story | 9:16 | 1080x1920 |
| Reels | 9:16 | 1080x1920 |

Padrao do feed: **4:5 vertical**.

## Multiplas referencias (script aceita 1 imagem)
Se precisar combinar a foto-base com outra referencia (ex.: tela de produto), junte as
duas lado a lado antes de enviar e explique as partes no prompt:
```bash
convert "<referencePhoto>" "<outra-ref>.jpg" -gravity center -resize x1000 +append /tmp/ref-combinada.jpg
```
No prompt: "This reference has TWO parts side by side — LEFT: the person (keep face/hair
EXACTLY); RIGHT: <o que deve aparecer na cena>."

## Prompt base (esqueleto)
```
Task: Generate a casual smartphone photo in [ASPECT_RATIO] for Instagram [post/story].

IMPORTANT: Keep the face, hair style, hair color, and hair length EXACTLY as shown in the
reference image. Do not change anything about the hair.

Style: [TIPO_FOTO] — must look like a real smartphone photo, not a studio/DSLR shot.

Subject: Same person from the reference image. [ROUPA]. [AMBIENTE]. [ENQUADRAMENTO].

Technical: smartphone camera quality, [ANGULO], natural/amateur framing, [ILUMINACAO].

Constraints: ONE SINGLE IMAGE. Hair identical to reference. [ASPECT_RATIO] aspect ratio.
```

## Boas praticas
- Variar roupas e ambientes entre posts (cheque `data/posts.jsonl`).
- Adaptar iluminacao ao horario real (manha = luz natural, noite = luz de abajur).
- Se a cena e externa, cheque o clima antes.
