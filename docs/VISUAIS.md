# Visuais na conversa

O agente pode explicar com desenho, número ou animação dentro do balão do chat do DG Claw
Web, em vez de despejar um textão. Ele escreve um arquivo `.html`, manda pelo `send_file` do
dgchat, e o Web mostra o arquivo desenhado.

## Como o agente manda

1. Escreve o arquivo com nome `vis-<assunto>.html` (ex.: `/tmp/vis-funil-outubro.html`).
   O nome com o prefixo `vis-` é o que faz o Web reconhecer o visual. Qualquer outro `.html`
   continua sendo um documento comum.
2. Chama `mcp__dgchat__send_file` com o `chat` do envelope, o `path` absoluto do arquivo e uma
   `caption` de uma frase dizendo o que o visual mostra (quem lê por outro canal só vê o arquivo).
3. O arquivo precisa ficar dentro da pasta do próprio agente, como qualquer anexo.

Pode ser um fragmento (`<div class="dv-numero" ...>`) ou um documento inteiro
(`<!doctype html>...`). O `<title>` vira o título do balão. Teto de 2 MB. Imagem vai embutida
em `data:`. Não use `height: 100vh`: a altura do balão segue o conteúdo.

```html
<title>Funil de outubro</title>
<h1 class="dv-titulo">Funil de outubro</h1>
<div class="dv-numero" data-valor="312" data-sufixo=" pedidos">
  <span class="dv-rotulo">Fechados</span>
</div>
```

## O que a base já traz (`dgvis.css` e `dgvis.js`)

O servidor põe a base na frente do HTML do agente. Peças prontas, em claro e escuro, boas de
300 a 700 px:

`.dv-titulo`, `.dv-sub`, `.dv-pilula`, `.dv-numero` (conta até `data-valor`; aceita
`data-prefixo`, `data-sufixo`, `data-casas`, `data-moeda`, `data-max`, `data-delta`),
`.dv-grade`, `.dv-fluxo`, `.dv-ciclo`, `.dv-passos`, `.dv-compara`, `.dv-linha-tempo`,
`.dv-tabela`, `.dv-barras`, `.dv-linhas`, `.dv-cartao` (com `.dv-alerta`, `.dv-ok`, `.dv-info`,
`.dv-destaque`). A cor muda com `data-cor="c1"` a `c6`, `ok`, `alerta`, `perigo`, `info`.

Em JavaScript existe `window.dgvis`: `tema`, `reduzido` (aparelho com Reduzir Movimento: encurte
a animação que explica e desligue o enfeite), `visivel`, `on(evento, fn)`, `cores()`,
`anima(el)` e `formata(n, opts)`. A sintaxe de cada peça está nos exemplos de
`docs/VISUAIS-EXEMPLOS/` (`vis-catalogo-pecas.html` mostra todas).

## Perguntar de dentro do visual

O visual nunca manda mensagem sozinho: ele só PEDE. Qualquer elemento com `data-pergunta="texto"`
(botão, linha de tabela, opção) pede ao tocar, e em JavaScript existe `dgvis.perguntar(texto)`.
O app abre uma barrinha fora do iframe com o texto exato e só o toque do dono em Enviar manda;
a mensagem chega ao agente como `[do visual <título>] <texto>` e aparece na conversa com a
etiqueta "do visual". O texto tem até 500 caracteres, sem HTML; há uma barrinha por visual, 3 s
entre pedidos e recusa quando o visual não está à vista. O visual recebe de volta
`pergunta-espera`, `pergunta-ok` ou `pergunta-erro` (motivos: vazio, longo, html, rapido,
limite, ocupado, fora, cancelado, envio). Peças novas que também emitem eventos: `.dv-abas`,
`.dv-passos[data-play]`, `.dv-acordeao`, `.dv-slider`, `.dv-opcoes` e `.dv-botao`. O exemplo
completo está em `docs/VISUAIS-EXEMPLOS/vis-exemplo-interativo.html`.

## O que a caixa bloqueia

O visual roda num `<iframe sandbox="allow-scripts">` (origem opaca) e a rota
`/api/v1/media/<id>/visual` entrega o CSP no cabeçalho. Sem rede (`fetch`, imagem de URL),
sem `localStorage` nem cookie, sem `alert`, sem abrir janela, sem formulário. Funcionam
JavaScript, CSS, SVG e canvas. Script e estilo de fora só de `https://cdn.jsdelivr.net` e
`https://cdnjs.cloudflare.com`, com a versão fixa na URL.

## Erros

O erro aparece no balão, em português: tarja vermelha quando o JavaScript do visual falha,
aviso quando ele não responde em 12 s ou chega vazio. Se a rota recusar o arquivo, a página de
erro dentro do balão diz o motivo (404 não conheço, 410 saiu do disco, 413 passa de 2 MB,
415 não é `.html`).

## Segurança

1. `sandbox` sem `allow-same-origin`: o visual não lê cookie, storage nem a página do chat.
2. CSP com `connect-src 'none'` e `default-src 'none'`: nenhum pedido de rede sai.
3. O `sandbox` também está no CSP da rota, então vale se alguém abrir a URL numa aba.
4. O chat trata o que o iframe manda por `postMessage` como entrada hostil.
5. Arquivo `.html`, `.svg`, `.xml` e `.js` aberto direto em `/api/v1/media/<id>` sai com
   `Content-Security-Policy: sandbox; ...` e `nosniff`.

Contrato completo: `docs/ESPEC-VISUAIS.md` e `docs/api-v1.md` do repositório do DG Telegram
(commits 14bb7e1, 9000c5a, 8c1f172, 06122ad e a190536).
