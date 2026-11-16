# Design system do DG Claw (visual "Névoa")

Este guia diz onde ficam as cores, os ícones e o indicador de carregamento do DG Claw, e como mudar cada um sem
quebrar o resto. Vale para o Web (`web/public/`) e para o painel de cada agente (`panel/public/`), que usam os mesmos
arquivos. Para trocar nome, logo e cores da sua empresa sem mexer no código, leia [WHITE-LABEL.md](WHITE-LABEL.md).

## O que existe e onde fica

| Arquivo | Para que serve |
| --- | --- |
| `web/public/ds/tokens.css` | O único arquivo com valores literais: cores, fontes, espaçamentos, raios, sombras e tempos |
| `web/public/ds/componentes.css` | Botão, campo, cartão, alerta, menu, avatar e o foco visível de teclado, todos escritos só com tokens |
| `web/public/ds/icones.svg` | O sprite de ícones (um `<symbol id="i-nome">` por ícone) |
| `web/public/ds/icone.js` | `dsIcone('nome')`: devolve o HTML do ícone, validando o nome |
| `web/public/ds/carregando.css` e `carregando.js` | O indicador de carregamento (a constelação do logo) |
| `web/public/ds/marca.js` | `dsMarca.nome`: o nome da marca para os scripts das telas |
| `web/public/marca.css` (gerado) | As cores e fontes que a empresa trocou no `marca.json`, carregadas depois dos tokens |

O painel do agente (`/p/<agente>/`) é servido na mesma origem do Web, então pede `/ds/...` e `/marca.css` ao Web. O painel
rodando sozinho, sem o Web na frente, serve a pasta `web/public/ds` do próprio repositório (veja `panel/server.js`).

## Os tokens

Todo valor de cor, tamanho e tempo vive em `tokens.css`. As telas só citam `var(--nome)`.

| Grupo | Tokens principais | O que controla |
| --- | --- | --- |
| Primitivos | `--p-azul`, `--p-azul-escuro`, `--p-grafite`, `--p-cinza-*`, `--p-vermelho`, `--p-verde`, `--p-ambar` | A paleta crua. Ninguém usa direto nas telas |
| Cores semânticas | `--cor-fundo`, `--cor-superficie`, `--cor-texto`, `--cor-texto-2`, `--cor-borda`, `--cor-acento`, `--cor-sobre-acento`, `--cor-link`, `--cor-foco` | O papel de cada cor. `--cor-sobre-acento` é o texto que fica em cima do acento |
| Estados | `--cor-perigo`, `--cor-sucesso`, `--cor-aviso` (cada um com `-fundo` e `-borda`), `--cor-info-fundo` | Erros, sucessos e avisos |
| Botões | `--botao-fundo`, `--botao-texto`, `--botao-borda`, `--botao2-*`, `--botao-perigo-*` | Botão principal, secundário e de perigo |
| Campos e cartões | `--campo-*`, `--cartao-fundo`, `--cartao-borda` | Caixas de texto e cartões |
| Conversa | `--conversa-fundo`, `--balao-meu-*`, `--balao-agente-*`, `--balao-hora` | O papel de parede e os balões |
| Logo | `--logo-no`, `--logo-centro` | As cores do símbolo da constelação e do carregando |
| Tipografia | `--fonte-base`, `--fonte-mono`, `--texto-p`, `--texto-m`, `--texto-g`, `--texto-h1` | Fontes e tamanhos |
| Medidas | `--esp-1` a `--esp-6`, `--raio-1` a `--raio-3`, `--raio-pilula`, `--alvo-toque` | Espaços, cantos e o tamanho mínimo do toque (32 px no computador, 44 px no celular) |
| Tempo | `--tempo-rapido`, `--tempo-medio`, `--tempo-carregando`, `--tempo-carregando-quieto` | Duração das animações |

O acento é o azul `#00B4FF`. Como o branco sobre esse azul não passa no contraste AA, o texto sobre o acento é o
grafite (`--cor-sobre-acento`). O contorno de foco usa `--cor-foco`, azul escuro no tema claro (3:1 ou mais, como pede o WCAG para elementos de interface). Texto azul sobre fundo claro usa `--cor-link` (`#0074A8`, com 5,2:1 sobre o branco), nunca o acento puro.

## Mudar a cor de todos os botões

Os botões principais usam `--botao-fundo` e `--botao-texto`. Mudando esses dois valores, todos os botões das telas do Web e
do painel mudam juntos. No `marca.json` (veja o WHITE-LABEL.md):

```json
{ "cores": { "botao-fundo": "#D32F2F", "botao-texto": "#FFFFFF" } }
```

Para mudar também os destaques (foco, abas ativas, links), troque `cor-acento` e `cor-sobre-acento`. Os botões seguem o
acento enquanto `botao-fundo` não for definido.

## Trocar o fundo da conversa para azul

O papel de parede verde da conversa é um único token, `--conversa-fundo`. Para ficar azul, mude só esse valor:

```json
{ "cores": { "conversa-fundo": "#DCEBFA" } }
```

Os balões têm os próprios tokens (`balao-meu-fundo`, `balao-agente-fundo`). Se o fundo novo for escuro, ajuste também os
textos dos balões.

## Tema escuro

O tema escuro vale quando o `<html>` tem `data-tema="escuro"`. Ele nunca liga sozinho pelo sistema do aparelho. Duas formas
de usar:

- Marca inteira escura: `"tema": "escuro"` no `marca.json`.
- Só trocar alguns valores no escuro: use o bloco `cores_escuro` do `marca.json`, que só vale com o tema escuro ligado.

Os tokens do escuro ficam no bloco `html[data-tema="escuro"]` do `tokens.css`.

## Ícones

Os ícones são traços de 1,5 sobre uma grade de 24, com pontas redondas e a cor vinda de `currentColor`, então acompanham a
cor do texto em volta.

**Em HTML:**

```html
<svg class="ds-ico" aria-hidden="true"><use href="/ds/icones.svg#i-clock"/></svg>
```

**Em JavaScript** (o nome precisa ser um texto escrito no código, nunca vindo de fora):

```js
botao.innerHTML = dsIcone('send');
```

`dsIcone` recusa nomes fora do formato `a-z`, `0-9` e hífen e avisa no console. Se um dado do sistema precisa virar nome de
ícone, passe por uma tabela do próprio código (`{ foto: 'camera', video: 'film' }`) e use o valor da tabela.

**Botão só com ícone** leva `aria-label` dizendo o que ele faz. O ícone em si fica com `aria-hidden="true"`.

**Dentro de CSS** (`content` de um `::before`), o sprite não funciona. Use uma máscara com o desenho embutido, como em
`web/public/dgvis.css`.

**Para acrescentar um ícone:**

1. Desenhe em grade 24, traço 1,5, `stroke-linecap="round"` e `stroke-linejoin="round"`, sem cor fixa.
2. Acrescente um `<symbol id="i-nome" viewBox="0 0 24 24">` em `ds/icones.svg`, copiando a estrutura dos vizinhos.
3. Regra dos nós: só os ícones complexos levam de 1 a 3 pequenos círculos cheios (`r="1.6"`), a assinatura da constelação
   do logo. Os ícones comuns (seta, X, check, mais) ficam sem nó. A lista dos complexos está em
   `web/test/design-system.test.js` (`COM_NOS`); se o seu ícone é complexo, acrescente o nome lá.
4. Rode `node --test web/test/design-system.test.js`. O teste confere a estrutura e que todo ícone citado nas telas existe.

## Carregando

Use o indicador do logo em todo carregamento de verdade, no lugar de "Carregando..." solto ou de um spinner próprio.

```js
el.innerHTML = dsCarregando({ rotulo: 'Carregando as tarefas', tamanho: 'p' }) + ' Carregando as tarefas…';
```

```html
<span data-carregando="Carregando as tarefas" data-tam="p"></span>
```

Os tamanhos são `p` (16 px), `m` (28 px) e `g` (48 px). O rótulo vai para o `aria-label` e o elemento anuncia
`role="status"` aos leitores de tela. O marcador `data-carregando` do HTML vira o indicador quando a página termina de
abrir; se a tela já tiver trocado o conteúdo antes disso, nada é desenhado.

**Reduzir Movimento.** Com a opção "Reduzir movimento" ligada no aparelho, o indicador não para: continua batendo, só que
com um deslocamento curto, que não passa do desenho do símbolo, e num ritmo mais lento (`--tempo-carregando-quieto`).
Um carregamento parado pareceria travado, então ele segue indicando que há trabalho em andamento.

Se a empresa colocar um logo próprio, o indicador deixa de mostrar as bolinhas e passa a "respirar" o logo dela.

O indicador de digitação da conversa (os três pontos do agente escrevendo) é outro elemento e continua como está.

## O que nunca fazer

- Nunca usar emoji ou símbolo (✓, ✕, ☰, ➤, 🎯) como ícone de interface. Use o sprite. Emoji só aparece quando é conteúdo:
  mensagens, texto digitado, nomes e o emoji que a pessoa escolhe para o avatar de um agente.
- Nunca escrever cor, tamanho de fonte ou duração de animação literais numa tela. Se falta um valor, crie o token em
  `tokens.css`.
- Nunca pôr texto branco sobre o acento azul. Use `--cor-sobre-acento` (ou `--botao-texto`).
- Nunca usar o acento puro como cor de texto sobre fundo claro. Use `--cor-link`.
- Nunca montar o nome de um ícone com texto vindo de fora (nome de arquivo, campo do agente, resposta da API).
- Nunca escrever o nome da marca no HTML ou no JavaScript. Em HTML use `{{MARCA_NOME}}`, em JavaScript `dsMarca.nome`.
- Nunca pôr texto de fora em `innerHTML` sem escapar.
- Nunca ligar o tema escuro pelo sistema do aparelho (`prefers-color-scheme`). Quem decide é a marca.

## Como conferir

- `node --test web/test/design-system.test.js` confere os tokens, o sprite, os ícones citados, a ausência de emoji de
  interface nas telas e no painel, e o cache do service worker.
- Para ver o resultado, abra as telas com um valor trocado no `marca.json` e olhe: nada depende de compilar.
