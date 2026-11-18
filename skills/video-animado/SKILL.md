---
name: video-animado
description: Cria vídeos curtos animados (5 a 15 s) em MP4, renderizados dentro da caixa, a partir de uma composição HTML controlada por tempo. Use quando o aluno pedir "cria um vídeo animado", "vídeo de cinco segundos sobre X", "vídeo de N segundos sobre X", "animação em vídeo", "motion design", "MP4 animado", "vídeo curto animado", "anima esse texto" ou "faz um vídeo vertical/quadrado/horizontal com animação". Não usa HyperFrames nem npm, só Python, Chromium do Playwright e ffmpeg.
user-invocable: true
---

# Vídeo animado (MP4 curto, renderizado na caixa)

Você escreve UMA página HTML cuja animação depende só do tempo `t`. O script `scripts/renderizar.py`
abre a página no Chrome da Tela do agente (num contexto só dele; se a Tela não estiver no ar, abre um Chromium novo), chama `__render(t)` quadro a quadro, e o ffmpeg monta o MP4
(H.264, 30 fps). Um vídeo de 5 s leva cerca de 20 segundos para renderizar.

## Passo a passo

1. **Planeje antes de codar.** Escreva no chat, em poucas linhas: formato, duração, cenas com tempos
   e o texto de cada uma. Exemplo para 5 s: cena 1 (0 a 1,8 s) gancho, cena 2 (1,8 a 3,6 s) ideia,
   cena 3 (3,6 a 5 s) fecho. Formato padrão: vertical 1080x1920. Horizontal: 1920x1080. Quadrado: 1080x1080.
2. **Copie o template** e adapte:
   `cp ~/.claude/skills/video-animado/templates/composicao-base.html ./video.html`
   Troque textos, cores e a função `__render(t)`. Não mexa no motor (easings, `tween`, `pose`).
   Se mudar o formato, ajuste juntos o CSS de `html, body, #palco` e `window.__tamanho`.
3. **Renderize:**
   `/opt/venv/bin/python ~/.claude/skills/video-animado/scripts/renderizar.py video.html video.mp4`
   (opções: `--fps 30`, `--largura N --altura N`). Mostra o progresso a cada 30 quadros e, no fim,
   caminho, duração e tamanho, conferindo a duração com o ffprobe.
4. **Confira com os olhos.** Extraia 3 quadros e olhe cada um com a ferramenta de leitura de imagem:
   ```
   for s in 0.5 2.5 4.5; do ffmpeg -y -loglevel error -ss $s -i video.mp4 -frames:v 1 q$s.png; done
   ```
   Procure texto cortado, fora da margem segura, sobreposto ou pequeno demais. Se achar, corrija e renderize de novo.
5. **Entregue** o MP4 ao aluno (anexo ou caminho do arquivo, como o canal permitir) e diga em uma
   linha o que tem em cada cena.

## O contrato da página

- `window.__duracao = 5;` (segundos) e `window.__tamanho = [1080, 1920];`
- `window.__render = function (t) { ... }` desenha o estado EXATO do instante `t`, sempre do zero,
  sem depender do quadro anterior.
- Proibido: `requestAnimationFrame`, `setTimeout`, `setInterval`, CSS `animation` rodando sozinha,
  vídeo ou GIF embutido, imagens da internet. Tudo é calculado de `t`.
- Helpers do template: `tween(t, inicio, fim, de, para, 'saida')` devolve o valor interpolado;
  `pose(id, {x, y, escala, rot, op, w, h, raio})` aplica o estado do elemento.
  Easings: `suave`, `saida`, `entrada`, `volta`, `elastico`, `linear`.
- Alternativa avançada: WAAPI com `animation.pause()` e `animation.currentTime = t * 1000`.
- Fontes: use só as da caixa (`DejaVu Sans`, `Liberation Sans`, `Arial`). Fonte da internet não carrega.

## Regras de qualidade

- **Texto grande e curto.** Título de 110 a 160 px no vertical, subtítulo de 50 a 64 px. No máximo
  6 palavras por linha, 2 linhas por cena. Contraste alto (texto claro em fundo escuro, ou o inverso).
- **Margens seguras.** 90 px nas laterais e 160 px em cima e embaixo (nas redes, a interface cobre as bordas).
- **No máximo 3 cenas em 5 s.** Cada cena precisa de pelo menos 1,2 s para dar tempo de ler.
  Em 10 s, até 5 cenas.
- **Transição por transformação.** Um elemento vira o próximo (a bolinha vira a xícara, o número
  cresce e vira o título). Nada de corte seco, nada de fade para preto.
- **Easing suave.** Entradas com `saida` ou `volta`, saídas com `entrada`. Evite `linear` em movimento
  de entrada. Dê um movimento lento e contínuo (zoom de 3%) à cena final para o vídeo não "congelar".
- **Uma ideia por vídeo, uma cor de destaque.** Paleta de 3 cores: fundo, texto, acento.
- **Fim com respiro.** A última ideia fica legível por pelo menos 0,8 s antes do corte.

## Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| "o Chromium do Playwright não está nesta caixa" | `sudo -E /opt/venv/bin/python -m playwright install --with-deps chromium` |
| "a página precisa definir window.__duracao..." | O HTML perdeu o motor. Recomece do template. |
| Texto cortado nas bordas | Reduza `font-size` ou quebre a linha com `<br>`; confira a largura do `.centro` (900 px). |
| Quadro final igual ao inicial | `__render` está ignorando `t`. Todo valor animado precisa sair de `tween(t, ...)`. |
| Render lento | Reduza sombras e blur grandes (`filter: blur`, `box-shadow` enorme). |

## Duração

O ideal é 5 a 15 s. Acima de 15 s funciona, mas o render demora proporcionalmente mais na caixa
(cerca de 4 s de render por segundo de vídeo). Se o aluno pedir mais de 15 s, avise antes e confirme.
O script recusa mais de 60 s.

## Comando pesado avulso

Render, ffmpeg, script de numpy e transcrição rodam com `dgclaw-pesado -- <comando>`, que põe o comando num grupo
próprio com teto de memória e de tempo (use `--mem 3G` ou `--timeout 900` se precisar de mais). Se estourar, morre só
ele e o agente segue de pé. Em numpy, use `uint8` ou `float32` e processe em blocos, nunca `float64` da imagem inteira.
O código de saída 137 quer dizer morto à força (quase sempre o teto de memória), e 124 que estourou o tempo.
Quando o render usa o Chrome da Tela, a memória da página fica no Chrome da Tela e não entra no teto do `dgclaw-pesado`: o teto vale para o Chrome headless próprio, o ffmpeg e o Python.
