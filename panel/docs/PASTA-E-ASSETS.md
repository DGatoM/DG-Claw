# Aba Pasta, e a prévia dos assets

Duas entregas, um assunto só: fazer o painel MOSTRAR o arquivo, em vez de contar
quantos existem.

## 1. Prévia dos assets (dentro da aba Apps)

Na etapa "Assets" de um conteúdo, o material que o agente baixou aparece em grade de
miniaturas. Clicar abre grande numa janela por cima (imagem, vídeo, áudio e PDF).
Planilha, zip e afins não fingem que abrem: a janela diz que aquele formato não é
mostrado por navegador nenhum e oferece o download.

**Por que precisou existir.** Até aqui o `apps.assets()` devolvia nome, tipo e
tamanho "sem servir o binário", e não havia rota nenhuma que servisse o arquivo. O
dono abria a aba, lia "14 arquivos" e continuava sem saber se o material presta.
Contagem não é conteúdo.

**Onde mexer:** `lib/apps.js` → `assetBinario()`; a rota
`GET /api/apps/:app/conteudos/:slug/asset/:nome` e o helper `servirBinario` no
`server.js`; `public/js/apps.js` → `desenharAssets`; `public/css/apps.css`.

O catálogo em markdown continua embaixo da grade, e o texto de pasta vazia continua
igual. Ele é importante: "catálogo escrito, pasta vazia" é o jeito mais comum de uma
etapa estar pela metade, e é a única frase da tela que distingue as duas coisas.

## 2. Aba Pasta

Navega pela pasta de trabalho do agente. Por arquivo: **Ver** (texto abre na página,
mídia abre na janela por cima), **Editar** (só texto), **Baixar** e **Apagar**. E um
botão **Subir arquivo**, que guarda o arquivo na pasta aberta no momento.

**O que o dono decide olhando.** Se o agente produziu mesmo o que disse que produziu,
se o material que ele baixou presta, e o que ainda falta chegar. Subir arquivo é o
caminho de mão dupla: até aqui, mandar um documento para o agente exigia acesso à
máquina.

**Onde mexer:** `lib/arquivos.js`; as rotas `/api/arquivos`, `/api/arquivos/conteudo`,
`/api/arquivos/baixar` e `/api/arquivos/upload` no `server.js`;
`public/js/arquivos.js` e `public/css/arquivos.css`.

### Por que a raiz é travada em `arquivos/`

A raiz da aba é `<agentDir>/arquivos`, **não** o `agentDir`. A tentação é óbvia: o
`agentDir` já é a raiz de tudo, o `lib/sanitize.js` já é ancorado nele, e "a pasta do
agente" foi literalmente o que o Danilo pediu. Só que a pasta do agente também tem
`.dgclaw/creds`, `.plataforma/identidade.md`, `.claude/` e os arquivos de alma dele.
Quem abre este painel é a Marta e o Paulo, e nenhum dos dois pediu para ver
credencial: eles querem ver o material do trabalho.

Fora da raiz não é "escondido", é inexistente para este módulo. Pedido que aponte para
fora volta como erro com motivo, nunca como lista vazia.

**As três camadas de conferência**, em toda função sem exceção: (1) o caminho é
relativo, sem `..` e sem segmento que comece com ponto; (2) o caminho resolvido cai
dentro da raiz; (3) o caminho REAL, com link simbólico já seguido (`fs.realpathSync`),
também cai dentro da raiz. A terceira existe porque as duas primeiras olham para o
texto do caminho, e um atalho chamado `notas` apontando para `/etc` passa nas duas.

**A pasta não é criada pelo painel.** Se `arquivos/` não existe, a tela diz isso.
Criar sozinho faria o painel mentir duas vezes: diria que o agente tem um lugar de
trabalho que nunca usou, e esconderia que ele ainda não guardou nada.

### As recusas que são de propósito

- **Apagar pasta, não.** Apagar pasta é apagar o que está dentro, inclusive o que a
  pessoa não viu na tela. Um clique que destrói o que não está à vista não é honesto.
- **Upload não sobrescreve.** Nome repetido volta como erro. Sobrescrever calado
  apagaria um trabalho do agente sem ninguém saber.
- **Editar só texto.** Um `.xlsx` aberto como texto vira uma parede de lixo, e salvar
  por cima destrói a planilha. O botão não existe nesses.
- **Teto de 2 MB para texto.** Não é medo de disco, é a tela: um `.log` de 400 MB
  abriria um `<textarea>` que trava o navegador do dono, sem ele saber por quê.

### Por que não entrou multer

O painel tem três dependências (`express`, `cookie-parser`, `express-rate-limit`) e é
bom que continue assim: ele é instalado na VPS de cliente, e cada pacote novo é mais
uma coisa para atualizar e auditar em máquina que ninguém visita.

O upload não precisa de multer porque **não é multipart**: o corpo do POST é o arquivo
inteiro e nada mais, com nome e pasta na URL. `express.raw({ type: '*/*', limit:
'25mb' })` entra como middleware **só daquela rota**, nunca global, senão engoliria o
corpo de toda rota JSON do painel.

**A armadilha, e ela é real:** o `express.json()` é global e roda ANTES do router. Se
o navegador anunciasse o tipo verdadeiro de um `.json` subido pelo dono, o arquivo
seria comido pelo parser errado e chegaria na rota como objeto, nunca como Buffer. Por
isso a tela manda `Content-Type: application/octet-stream` fixo e a rota confere
`Buffer.isBuffer` antes de gravar. Trocar por `body: arquivo` sem o cabeçalho quebra
exatamente esse caso, e só ele.

## O que ficou compartilhado, e por quê

Três peças saíram do lugar para não existirem em duas versões: `js/visualizador.js`
(a janela por cima), `js/tutorial.js` (o motor da visita guiada, com cada aba
entregando só a sua lista de passos) e `lib/mime.js` (a tabela de tipo por extensão).
As classes do tutorial continuam `app-tut-*`, com o estilo em `css/apps.css`, onde
nasceram. Com uma tabela de mime em cada lugar, um dia o `.webp` abre numa tela e vira
download na outra sem ninguém ter decidido isso.
