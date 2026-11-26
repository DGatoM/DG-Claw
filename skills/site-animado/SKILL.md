---
name: site-animado
description: Cria sites de uma página, animados e responsivos, em um único arquivo .html, com hero forte, animações de scroll profissionais (revelar ao rolar, parallax suave, texto que entra por palavras, números que contam, seção sticky que troca de conteúdo). Usar quando o aluno pedir "cria um site animado", "faz uma landing page", "monta um site de uma página sobre X", "site com animação de scroll", "página de apresentação animada", "site para minha empresa/produto/evento" ou variações. Não usar para apresentação de slides (use slide-animado) nem para site com várias páginas ou back-end.
user-invocable: true
---

# Site animado

Entrega um único `.html` autocontido (CSS e JS inline, sem dependência obrigatória de internet) que o aluno abre no navegador ou publica em qualquer hospedagem. Parte do template `templates/site-base.html`, que você copia e adapta.

## Fluxo (siga a ordem)

1. **Planejar antes de desenhar.** Escreva o roteiro das seções e mostre em poucas linhas: para cada seção, o objetivo, o título e o que anima nela. Total de 4 a 6 seções: hero, uma frase de impacto (manifesto), números, uma seção sticky (passo a passo ou etapas), cartões e chamada final. Se o pedido for claro, siga sem esperar aprovação.
2. **Escolher o estilo.** Pedido sem detalhe usa o design system padrão. Instrução extra ("mais sóbrio", "mais colorido", "elegante", "com a minha marca") muda só o bloco `DESIGN SYSTEM` no topo do CSS (cores, fontes, raio, espaços, easings). Para marca do aluno, peça cores em hex, fonte e logo (logo em SVG inline).
3. **Copiar e adaptar.** `cp templates/site-base.html ~/site-<tema>.html`. Troque textos, números, cores e a ordem das seções. Mantenha o script do final.
4. **Conferir** (seção abaixo) e corrigir.
5. **Entregar** o arquivo ao aluno, dizendo que abre com duplo clique.

## O que o template já faz

- **Hero:** título que entra palavra por palavra (`data-words`), formas com parallax (`data-parallax`, `data-p` controla a intensidade).
- **Revelar ao rolar:** classe `reveal` (use `style="--d:120ms"` para atrasar). Usa scroll-driven animations CSS (`animation-timeline: view()`) quando o navegador suporta e IntersectionObserver como fallback.
- **Manifesto:** as palavras acendem conforme a rolagem.
- **Números que contam:** `<b data-count="92" data-suffix="°C">`; `data-dec` define as casas decimais.
- **Seção sticky (`.pin`):** o painel fica fixo e o conteúdo troca conforme a rolagem. Para mudar a quantidade de passos, altere os `.step`, os `.dots i`, o array `look` no JS e a altura `320vh` (aprox. 100vh por passo).
- **Barra de progresso** no topo e menu fixo.
- **Responsivo:** fontes com `clamp()`, grades que viram uma coluna abaixo de 760px, nada de largura fixa. Testado em 390px sem rolagem horizontal.
- **`prefers-reduced-motion`:** tudo aparece direto, sem animar.

## Regras de desenho

- Uma ideia por seção, texto curto. Títulos com no máximo 8 palavras.
- Alterne fundo escuro e claro para dar ritmo (o manifesto é a seção clara).
- Animações de 500 a 900 ms, easing `--ease` ou `--ease-out`. Nada pisca, nada pula, nada anima sem motivo.
- Imagens: prefira formas, gradientes e SVG inline. Imagem externa só se o aluno enviar (embutir em base64 se for pequena).
- Nunca use larguras fixas em pixel para blocos de conteúdo; use `max-width`, `%`, `clamp()`.
- Português do Brasil, sem travessão no meio de frase.

## Conferir antes de entregar

```bash
python3 ~/.claude/skills/site-animado/scripts/conferir.py ~/site-<tema>.html
```

O script abre o site em 1440px e 390px, rola a página, grava prints em `/tmp/conferir-site/`, aponta rolagem horizontal e erros de console. Abra os prints (Read na imagem), principalmente os de celular e os da seção sticky. Se o navegador do playwright não estiver instalado, ele avisa com mensagem clara: entregue mesmo assim e diga ao aluno que não foi possível testar visualmente.

Checklist:

- [ ] Roteiro das seções escrito antes
- [ ] Sem erro de console e sem rolagem horizontal em 390px (o script confere)
- [ ] Nenhum texto cortado, sobreposto ou ilegível nos prints de desktop e celular
- [ ] Contraste bom em todas as seções
- [ ] A seção sticky troca os passos na ordem e mostra o último no fim
- [ ] Números chegam ao valor final
- [ ] Botões e links funcionam (âncoras `#id` existem)
- [ ] `grep -n $'—\|–' arquivo.html` sem travessão dentro de frase
- [ ] Arquivo único, abre com duplo clique

## Comando pesado avulso

Render, ffmpeg, script de numpy e transcrição rodam com `dgclaw-pesado -- <comando>`, que põe o comando num grupo
próprio com teto de memória e de tempo (`--mem 1G` e `--timeout 900` são exemplos de ajuste; o teto de memória padrão já é calculado pela memória do container, então só suba se souber que cabe). Se estourar, morre só
ele e o agente segue de pé. Em numpy, use `uint8` ou `float32` e processe em blocos, nunca `float64` da imagem inteira.
O código de saída 137 quer dizer morto à força (quase sempre o teto de memória), e 124 que estourou o tempo.
