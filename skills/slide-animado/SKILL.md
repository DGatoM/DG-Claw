---
name: slide-animado
description: Cria apresentações e slides animados em um único arquivo .html, com transição de verdade entre as telas (os elementos se transformam na tela seguinte, como o Morph do PowerPoint), bullets que entram um por um, navegação por setas, clique e swipe, tela cheia e exportação para PDF. Usar quando o aluno pedir "cria um slide animado", "faz uma apresentação", "monta um deck", "slides sobre X", "apresentação animada", "PowerPoint", "quero uns slides para minha aula/reunião/palestra" ou variações. Não usar para site de rolagem (use site-animado) nem para vídeo.
user-invocable: true
---

# Slide animado

Entrega um único `.html` autocontido que funciona como PowerPoint: o aluno abre no navegador e apresenta. Parte do template pronto em `templates/deck-base.html`, que você copia e adapta.

## Fluxo (siga a ordem)

1. **Planejar antes de desenhar.** Escreva o roteiro e mostre ao aluno em poucas linhas. Para cada tela: título (uma frase que carrega a mensagem), a mensagem em uma linha e quantos bullets (de 0 a 4, curtos). Ritmo: capa, 2 a 5 telas de conteúdo, fechamento. Sem o aluno pedir mais, são 4 a 6 telas. Se o pedido for claro, siga sem esperar aprovação.
2. **Escolher o estilo.** Pedido sem detalhe usa o design system padrão do template. Instrução extra ("mais sóbrio", "mais colorido", "elegante", "com a minha marca") muda só o bloco `DESIGN SYSTEM` (ver `references/design-system.md`).
3. **Copiar o template e adaptar.** `cp templates/deck-base.html ~/slide-<tema>.html`. Troque textos, cores no bloco do design system e as telas. Mantenha o script do final do arquivo como está.
4. **Conferir** (seção abaixo), corrigir o que estiver feio.
5. **Entregar** o arquivo ao aluno com uma linha de como usar (setas, F para tela cheia, P para PDF).

## Como o template funciona

- Palco fixo de 1920x1080 escalado para caber em qualquer tela (16:9, com faixas nas sobras).
- Cada tela é um `<section class="slide">`. Dentro dela:
  - `.bg` com `data-morph="fundo"`: a forma de fundo. Em cada tela ela tem outra posição, tamanho, raio e cor, e viaja de uma para a outra.
  - Elementos com `data-morph="nome"` (titulo, marca, card-1...): o mesmo nome em telas vizinhas faz o elemento **viajar** (posição, tamanho, cor, raio). Nome que só existe em uma das telas entra ou sai sozinho.
  - `<div class="rest">`: o conteúdo que não viaja (textos, bullets). Ele sai deslizando e o novo entra com animação própria.
  - `data-build` em um item: aparece só no avanço seguinte (cada seta ou espaço revela um). Depois do último, passa de tela.
  - `data-anim` em um item: entra com animação (sobe e aparece) ao chegar na tela.
- Posição e tamanho de cada elemento vão no `style` inline (em pixels do palco 1920x1080). Para a transição ficar bonita, mude de verdade a posição, o tamanho ou a cor dos elementos morph entre as telas.
- Transição: `document.startViewTransition` com `view-transition-name` dado por JS a partir de `data-morph`. Formas e cartões esticam até o tamanho final (`vt-box`); texto que muda sai na primeira metade e o novo entra na segunda (`vt-swap`), então as telas nunca ficam sobrepostas em transparência. Sem suporte do navegador, cai no fallback FLIP (mede antes e depois e anima com Web Animations API). Não troque por fade de tela inteira: é o defeito que esta skill existe para evitar.
- Controles: setas, espaço, Enter, PageUp/PageDown, clique (esquerda 20% volta), swipe no celular, F tela cheia, P imprime (abre com `?print` para ver as telas empilhadas). O número da tela fica no canto e `#3` na URL abre direto na tela 3.
- Respeita `prefers-reduced-motion` (troca de tela sem animação).

## Regras de desenho

- Um título por tela, no máximo 4 bullets, cada um com no máximo uma linha e meia. Texto do palco nunca abaixo de 40px (o palco é 1920 de largura).
- Mantenha o elemento `titulo` e `marca` em todas as telas: é o que dá a sensação de continuidade.
- No mínimo 2 formas de fundo diferentes ao longo do deck (círculo, faixa, painel, tela cheia). Fundo cheio de cor clara exige texto escuro (`--on-accent`).
- Sem imagens externas obrigatórias. Se usar ilustração, SVG inline. Fontes: o link do Google Fonts é opcional, o fallback do sistema já funciona.
- Português do Brasil, sem travessão no meio de frase.

## Conferir antes de entregar

```bash
python3 ~/.claude/skills/slide-animado/scripts/conferir.py ~/slide-<tema>.html
python3 ~/.claude/skills/slide-animado/scripts/conferir.py ~/slide-<tema>.html --flip   # testa o fallback
```

O script avança todos os passos e grava prints em `/tmp/conferir-slide/`. Abra cada print (Read na imagem). Se o navegador do playwright não estiver instalado ele avisa com uma mensagem clara: nesse caso entregue assim mesmo e diga ao aluno que não foi possível testar visualmente.

Checklist:

- [ ] Roteiro escrito antes (títulos, mensagens, bullets)
- [ ] Nenhum erro de console no script
- [ ] Nenhum texto cortado, sobreposto ou fora do palco em nenhum print
- [ ] Contraste bom em todas as telas (texto claro no escuro e vice-versa)
- [ ] Os elementos `titulo`, `marca` e `fundo` mudam de posição/cor entre as telas e viajam
- [ ] Bullets aparecem um por um e a seta para trás desfaz um por um
- [ ] Todo `data-morph` tem o mesmo nome na tela vizinha (se quer que viaje)
- [ ] Rodou o `--flip` sem erro
- [ ] `grep -n $'—\|–' arquivo.html` sem travessão dentro de frase
- [ ] Arquivo único, abre com duplo clique, sem dependência obrigatória de internet

## Erros comuns

- Elemento morph que não viaja: o nome em `data-morph` está diferente ou a tela não é vizinha.
- Texto do título quebrando em muitas linhas: aumente o `width` no style da tela.
- Quer outra transição entre duas telas específicas: mude só posição, tamanho e cor dos elementos morph nelas.

## Comando pesado avulso

Render, ffmpeg, script de numpy e transcrição rodam com `dgclaw-pesado -- <comando>`, que põe o comando num grupo
próprio com teto de memória e de tempo (use `--mem 3G` ou `--timeout 900` se precisar de mais). Se estourar, morre só
ele e o agente segue de pé. Em numpy, use `uint8` ou `float32` e processe em blocos, nunca `float64` da imagem inteira.
O código de saída 137 quer dizer morto à força (quase sempre o teto de memória), e 124 que estourou o tempo.
