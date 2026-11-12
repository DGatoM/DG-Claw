---
name: gemini-gratuito
description: Conecta o Gemini (chave gratuita do Google AI Studio) e habilita a análise de vídeos. Usada quando o dono diz "conectar o Gemini", "chave do Gemini", "analisa esse vídeo", "o que acontece nesse vídeo", "resume esse vídeo do YouTube", "assiste esse vídeo pra mim", ou manda um vídeo ou link de vídeo para ser analisado. Também faz o QA dos vídeos que o próprio agente gerou, quando o dono diz "faz QA desse vídeo", "pede pro Gemini avaliar", "confere o vídeo", ou antes de entregar um MP4 criado por código.
user-invocable: true
---

# Gemini grátis: analisar vídeos e fazer QA

Com a chave gratuita do Gemini eu consigo "assistir" um vídeo (arquivo ou link) e responder perguntas
sobre ele: resumo, o que foi dito, o que aparece na tela, trechos importantes.

## Regras da conversa

- Uma etapa por vez, esperando o dono confirmar.
- Linguagem de dia a dia, sem jargão.
- A chave nunca aparece em mensagem, comando ou log. O dono cola só no campo de senha do bloco `dgcofre`.

## Passo 1: criar a chave (grátis)

1. Abrir https://aistudio.google.com/apikey e entrar com a conta do Google.
2. Clicar em **Get API key** e depois em **Create API key**.
3. Se pedir um projeto, escolher "Create API key in new project".
4. Copiar a chave (começa com `AIza`).

## Passo 2: guardar a chave

A chave nunca é colada no chat. Responda com este bloco, que a tela da conversa transforma num campo
de senha ligado direto ao cofre:

```dgcofre
GEMINI_API_KEY
Chave do Gemini
```

Quando chegar "[cofre] GEMINI_API_KEY guardada (final xxxx).", responda curto e siga. Se o dono colar a chave no chat
por engano, avise que ela ficou exposta, peça para apagar e gerar outra no AI Studio, e mande o bloco
de novo. (Sem a tela da conversa: aba **Cofre** do painel, opção **Google (Gemini)**.)

Para conferir, rode qualquer análise (passo abaixo). Se a chave faltar, o script avisa.

## Analisar um vídeo

```bash
python3 ~/.claude/skills/gemini-gratuito/scripts/analisar_video.py <arquivo-ou-link> "pergunta"
```

Exemplos:

```bash
python3 ~/.claude/skills/gemini-gratuito/scripts/analisar_video.py /home/agente/video.mp4 "Resuma o vídeo em 5 tópicos."
python3 ~/.claude/skills/gemini-gratuito/scripts/analisar_video.py "https://youtu.be/XXXX" "Quais são as ideias principais?"
```

- Link do YouTube público: o Gemini lê direto, sem baixar nada.
- Outros links (Instagram, TikTok, Vimeo etc.): o script baixa com o yt-dlp e envia.
- Arquivo que o dono mandou: o script envia, espera o Gemini processar, analisa e apaga o envio no fim.
- Se o dono não fizer pergunta, use "Resuma o vídeo e destaque os pontos principais."
- Vídeo muito longo gasta o limite grátis rápido. Para mais de uma hora, avise o dono antes.

Responda ao dono com o resultado em linguagem simples, sem despejar a saída crua se ela for longa.

## Se algo falhar

| Sintoma | O que fazer |
| --- | --- |
| "Não encontrei a GEMINI_API_KEY" | Chave não gravada ou agente sem reiniciar. Refazer o passo 2. |
| Chave recusada (400, 401, 403) | Chave errada ou apagada. Criar outra no passo 1 e gravar de novo. |
| HTTP 429 | Limite grátis do dia ou do minuto. Esperar, ou usar um vídeo mais curto. |
| Não baixou o link | Link privado ou sem vídeo. Pedir o arquivo ao dono. |

## QA de vídeo: conferir o que eu mesmo gerei

Eu não vejo os quadros de um MP4 que eu gerei (por exemplo com a skill video-animado). O Gemini vê.
Antes de entregar um vídeo ao dono, mando ele ao Gemini com um roteiro de conferência e corrijo o que apontar.

```bash
python3 ~/.claude/skills/gemini-gratuito/scripts/analisar_video.py /home/agente/video.mp4 "$(cat ~/.claude/skills/gemini-gratuito/scripts/prompt_qa.txt)"
```

O `scripts/prompt_qa.txt` pede: texto cortado, legibilidade no celular, ritmo, transições, erros visuais,
nota de 0 a 10 e lista de correções. Se o vídeo tiver um objetivo específico, acrescento uma linha
ao final da pergunta ("o roteiro pedia X, o vídeo entrega?").

Fluxo:

1. Gerar o vídeo e rodar o QA com a mesma `GEMINI_API_KEY`.
2. Nota 8 ou mais e sem problema grave: entregar.
3. Nota abaixo de 8, ou texto cortado e erro visual: aplicar as correções no código, gerar de novo e repetir.
   No máximo 2 rodadas, para não gastar o limite grátis.
4. Ao entregar, contar ao dono em uma frase o que o QA achou e o que foi corrigido.

Cuidados:

- O Gemini estima os momentos "no olho". Tratar os tempos como aproximados e usar "início, meio, fim".
- Para a hora exata de cada palavra falada (legenda, sincronia), o Gemini não serve.
- Vídeo curto (até uns 2 minutos) gasta pouco do limite grátis. Se der 429, esperar e tentar mais tarde.
