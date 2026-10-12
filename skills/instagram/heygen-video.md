# Reels com avatar falante (HeyGen) — DG Claw

Sub-doc da skill `instagram`. Reels de **30-40s** com a pessoa virtual falando, via
**HeyGen (Avatar IV)** + foto-base. Acionado quando `voiceId` esta definido no
`instagram.json` e o post pede video (tipicamente 19h). **Voz/conteudo = SOUL/PERSONALITY.**

## Pre-requisitos
- `voiceId` no `instagram.json` (sem ele, nao gere reels — caia para foto).
- Chave HeyGen acessivel ao agente (segredo; nunca logar).
- Foto-base (`referencePhoto`) seguindo as regras de `image-generation.md`.

## 1. Roteiro (~30-40s)
Regras de roteiro (o TTS depende disso):
- **Teto de ~20 palavras por frase** e **< 375 caracteres** no total. Conte antes de enviar.
- Acentuacao correta (o TTS usa acento pra entonacao).
- Pelo menos 3 exclamacoes em frases de impacto (senao sai monocordio).
- **Sem markdown** (`**`, `_`, `` ` ``), sem travessao (use virgula).
- Contracoes coloquiais (esta->ta, para->pra, estou->to).
- Numeros grandes por extenso.
- Pergunta final **especifica do tema**, dicotomica, com o sujeito concreto dentro.
- **Nao citar objetos fisicos** (celular, oculos, copo...) — o Avatar IV materializa o
  objeto na mao em tempo de fala. Descreva o comportamento/efeito, nao o objeto.
- Fonetizar siglas SEM espaco entre as letras (ex.: FGV -> "efgeve"), senao o TTS pausa.

## 2. Imagem-base do avatar
Gere a foto-base seguindo `image-generation.md` (R1-R4), formato **9:16**, enquadramento
cintura-pra-cima, rosto bem visivel (lip-sync), olhando pra camera (POV do celular — sem
mostrar celular/tripe). Rode o QA visual.

## 3. Upload do asset + generate
1. Upload da imagem como asset no HeyGen -> guarde o `image_key`/`asset_id`.
2. Gerar o video com: `image_key`, `script` (roteiro), `voice_id` (= `voiceId` do
   instagram.json) e um `motion_prompt` em ingles (expressoes faciais, micro-movimentos,
   movimento sutil no fundo).

## 4. Polling
Guarde o `video_id`, faca polling ate `status == completed`, baixe o MP4.

## 5. QA do video
- **Lip-sync** casa com a fala?
- Sem glitch/artefato no rosto e nas maos?
- Enquadramento e duracao corretos (30-40s)?
- Audio limpo, sem gagueira do TTS?

Reprovou -> ajuste roteiro/imagem e regenere.

## 6. Pos-producao (opcional, ffmpeg)
Overlays/trilha de fundo conforme a identidade. Manter qualidade (`-crf 18 -preset slow`
ao reencodar; `-c:a copy` quando possivel).

## 7. Publicar e registrar
Suba o MP4 final para URL publica, publique o reels e **registre em `data/posts.jsonl`**
com `"type":"reels"` (igual ao post de foto — passo 7 de `post.md`). Atualize emocoes e
memoria, e mande o relatorio ao dono.
