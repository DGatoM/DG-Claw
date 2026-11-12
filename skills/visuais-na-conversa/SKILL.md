---
name: visuais-na-conversa
description: Responde com um visual desenhado dentro do balão da conversa (cartões, comparação, linha do tempo, gráfico simples, números, passo a passo, checklist, botões de escolha) em vez de um textão. Usada quando a resposta tem comparação, lista de opções, passo a passo, números ou uma escolha do dono, e quando ele diz "me mostra", "faz um visual", "compara", "desenha", "monta um quadro", "quero ver isso em gráfico".
user-invocable: true
---

# Visuais na conversa

Quando a resposta fica melhor vista do que lida, eu escrevo um arquivo HTML e mando como anexo.
A tela de conversa desenha ele dentro do balão. Os botões do visual voltam como mensagem para mim.

## Quando usar (e quando não)

- Usar: comparar 2 a 4 coisas, mostrar números ou evolução, explicar um passo a passo, linha do tempo,
  checklist, ou oferecer caminhos para o dono escolher.
- Não usar: resposta curta, conversa solta, resposta de uma frase. Texto resolve.
- Sempre mando uma frase curta junto, dizendo o que o visual mostra.

## Como entregar

1. Escrever o arquivo em `~/visuais/vis-<assunto>.html` (crio a pasta se faltar). O nome TEM que
   começar com `vis-` e terminar em `.html`, senão vira um documento comum. Use a minha pasta pessoal:
   o painel só serve arquivo de dentro dela, então `/tmp` não funciona.
2. Mandar com a tool `send_file` do DG Chat (`chat` = id do envelope, `path` = caminho absoluto,
   `caption` = a frase curta).
3. Se aparecer "Não entreguei", ler o motivo (arquivo inexistente, caminho não absoluto, acima de 64 MB).

## Regras do arquivo

- Autocontido e leve: até 2 MB, sem rede (nada de `fetch`, imagem de link, Google Fonts). Imagem só
  embutida em `data:`.
- Sem `height: 100vh`: a altura do balão acompanha o conteúdo.
- Pode ser um fragmento (só as peças). A base visual entra sozinha na frente. `<title>` vira o título
  do balão.
- Pensar no celular: poucas peças, texto curto, nada de tabela larga.
- Tema claro e escuro já vêm da base. Não fixar cor de fundo nem de texto. Para cor, usar `data-cor`.
- Não usar `alert`, `window.open`, `localStorage`, formulário: tudo bloqueado.

## Peças prontas (classe `dv-*`)

| Peça | Para quê | Exemplo mínimo |
| --- | --- | --- |
| `dv-titulo`, `dv-sub`, `dv-pilula` | título, subtítulo, etiqueta | `<h1 class="dv-titulo">Resumo</h1>` |
| `dv-numero` | número de destaque que conta | `<div class="dv-numero" data-valor="312" data-sufixo=" pedidos" data-delta="+8%"><span class="dv-rotulo">Fechados</span></div>` |
| `dv-grade` | grade de números lado a lado | envolve vários `dv-numero` |
| `dv-barras` | barras comparando valores | `<div class="dv-barras" data-unidade=" mil"><div data-rotulo="Mar" data-valor="48" data-destaque></div></div>` |
| `dv-linhas` | gráfico de linhas | `<div class="dv-linhas" data-rotulos='["Jan","Fev"]' data-series='[{"nome":"2026","valores":[3,5]}]'></div>` |
| `dv-compara` | colunas lado a lado (antes e depois, A e B) | filhos `<div data-cor="ok"><h4>A</h4><ul><li>..</li></ul></div>` |
| `dv-linha-tempo` | marcos em ordem | `<div class="dv-marco" data-data="Mar 2026"><b>Início</b><p>..</p></div>` |
| `dv-passos` | passo a passo numerado | `<ol class="dv-passos"><li data-ico="🔍"><b>Passo</b><p>..</p></li></ol>` |
| `dv-fluxo`, `dv-ciclo` | etapas ligadas por seta, ou ciclo | filhos `dv-etapa` (com `dv-ico`, `<b>`, `<p>`) |
| `dv-cartao` | aviso ou destaque | `<div class="dv-cartao dv-ok">` (também `dv-info`, `dv-alerta`, `dv-destaque`) |
| `dv-tabela` | tabela pequena | `<table class="dv-tabela">`, coluna de número com `class="num"` |
| `dv-abas`, `dv-acordeao` | várias visões sem encher o balão | cada aba é `<section data-aba="Rótulo">` |
| `dv-slider` | controle deslizante | `<div class="dv-slider" data-rotulo="Prazo" data-min="1" data-max="24" data-valor="12"></div>` |
| `dv-opcoes` | cartões de escolha que respondem | veja abaixo |
| `dv-cofre` | pede uma chave ao dono; o campo de senha é do app, o valor não passa pela conversa | `<div class="dv-cofre" data-cofre="NOME_DA_CHAVE" data-rotulo="Token da Hostinger" data-ajuda="Onde gerar"></div>` |

Cores: `data-cor="ok"`, `"perigo"`, `"c1"` a `"c6"`. Em checklist, use `dv-cartao dv-ok` para o que
está feito e `dv-alerta` para o que falta, ou um `dv-passos`.

## Botões que respondem

Qualquer elemento com `data-pergunta="frase"` vira um botão. Ao tocar, aparece embaixo do balão uma
barrinha com o texto e o botão **Enviar**: só quando o dono confirma a mensagem chega para mim, no
formato `[do visual <título>] <frase>`. Eu respondo como a uma pergunta normal dele.

```html
<div class="dv-opcoes" data-titulo="Por onde seguimos?">
  <button data-pergunta="Quero ver o detalhe do funil"><span class="dv-ico">📊</span><b>Funil</b><p>Etapa por etapa.</p></button>
</div>
```

- Escrever o `data-pergunta` como a frase completa que o dono diria (ele lê e confirma). Bom: "Me explica
  melhor o passo 3". Ruim: "passo3", "opt_b".
- Até 4.000 caracteres, texto puro. Um pedido a cada 3 segundos. Para um convite solto,
  `<button class="dv-botao" data-pergunta="...">`.
- Fora da conversa (arquivo aberto direto) o botão só avisa que não funciona. Normal.

## Para quem quer JavaScript

`window.dgvis` existe dentro do visual: `dgvis.tema` (`'claro'` ou `'escuro'`), `dgvis.reduzido`
(aparelho pediu menos movimento), `dgvis.perguntar(texto, el)`, `dgvis.cores()`,
`dgvis.formata(1234.5, {prefixo: 'R$ ', casas: 2})` (dá `R$ 1.234,50`) e `dgvis.on('tema', fn)`.
Só escrever script quando as peças prontas não resolvem.

## Modelo para copiar

`templates/vis-exemplo.html` (comparação com botões de escolha). Copiar para `~/visuais/vis-<assunto>.html`
e trocar o conteúdo.

## Depois de mandar

- Se o dono disser que o visual veio vazio ou com tarja de erro, abrir o arquivo, achar o erro (a tarja
  diz a linha), corrigir e mandar de novo com outro nome (`vis-assunto-2.html`).
- Se ele pedir mudança, gerar um arquivo novo, não editar o antigo.
