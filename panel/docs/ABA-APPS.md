# Aba Apps

## O que esta tela faz

Mostra ao dono do agente **o que o agente já produziu por conta própria**, sem que
ele precise perguntar nada no chat.

Um "app" aqui é um trabalho que o agente toca do começo ao fim. Hoje existe um, o
**Conteúdo**: cada vídeo preparado para o canal vira um cartão, e cada cartão tem
a régua de etapas do trabalho (pesquisa, assets, roteiro). Clicar numa etapa abre
o arquivo que aquela etapa produziu, dentro da própria tela.

A aba é **genérica**. Ela não sabe nada sobre canal de YouTube: a lista de apps
fica no agente, em `.dgclaw/apps.json`. Agente sem esse arquivo (a Ana, por
exemplo) vê uma explicação do que a aba seria, nunca uma tela vazia.

## De onde vem o dado

| Camada | Onde |
| --- | --- |
| Lista de apps | `<agente>/.dgclaw/apps.json` |
| Conteúdos | `<agente>/arquivos/projetos/<AAAA-MM-DD-slug>/` |
| Estado das etapas | `estado.json` dentro da pasta do projeto, **quando existe** |
| Rotas | `GET /api/apps`, `/api/apps/:app/conteudos`, `/conteudos/:slug`, `/conteudos/:slug/assets`, `/conteudos/:slug/arquivo/:nome` |
| Servidor | `panel/lib/apps.js` (leitura e validação) e as rotas em `panel/server.js` |
| Tela | `panel/public/js/apps.js` e `panel/public/css/apps.css` |

### O estado.json é opcional, e a tela conta isso

Se o agente escreveu `estado.json`, a tela mostra o que ele declarou. Se não
escreveu, a tela **deduz da pasta**: o arquivo da etapa existe, logo a etapa saiu
do papel. Nesse caso aparece o selo **"lido da pasta"**.

Os dois casos não são a mesma afirmação, e a tela nunca finge que são. "O agente
declarou que terminou" é mais forte do que "o arquivo está lá". Apagar essa
diferença deixaria o cartão mais bonito e mais mentiroso.

### O vocabulário de status

Copiado do `content_stages` do DG Social, para o dono não aprender duas línguas:

| No dado | Na tela | O que quer dizer |
| --- | --- | --- |
| `pendente` | não começou | O agente ainda não começou esta etapa. |
| `em_producao` | em produção | Ele está trabalhando nela agora. |
| `aguardando_aprovacao` | esperando você | Terminou e parou de propósito, esperando sua decisão. |
| `concluido` | pronto | Terminada e aprovada. |
| `reprovado` | refazer | Você mandou refazer; o motivo aparece ao abrir. |
| `nao_aplicavel` | não se aplica | Não vale para este conteúdo, e sai da conta do progresso. |

## O que o dono decide com esta tela

1. **Aprovar ou mandar refazer.** Etapa em "esperando você" é a única que pede
   ação. Ele abre, lê o material inteiro e responde ao agente no chat.
2. **Saber se vale cobrar.** A régua mostra onde o trabalho parou e há quanto
   tempo.
3. **Achar o material fora do painel.** O nome da pasta aparece no cartão de
   propósito: é por ele que se encontra o arquivo no disco.

## Como a tela se explica sozinha (regra do repo)

O `CLAUDE.md` deste repositório manda três coisas junto com o código: tooltip,
tutorial e documentação. Nesta aba elas estão assim.

**Tooltip** em todo rótulo que não se explica: nome da aba, nome do app, contador
de progresso, cada status, o selo "lido da pasta", a data do cartão, a data da
etapa e o "sem resumo". O padrão usado é o **atributo `title` do HTML**, sem
biblioteca nenhuma.

**Tutorial** com holofote, sete passos, em `panel/public/js/apps.js`
(`abrirTutorial`, `passosDoTutorial`). Cada passo responde o que é, como a conta é
feita e por que aquilo está na tela. Dois jeitos de entrar:

- botão `Tutorial`, ao lado do nome do app, que começa do primeiro passo;
- botão `?` por seção, que abre direto no passo daquela seção (`data-tutorial="cartao"`).

Passo cujo alvo não está na tela naquele momento é **pulado**, nunca apontado para
o vazio. Por isso o contador diz "1 de 7" quando existe um app só, e diria "1 de 8"
com dois.

### Nota para quem for padronizar o acabamento do painel

O tutorial daqui foi escrito **sem dependência**: holofote é `box-shadow` de
9999px em volta do alvo, o balão é posicionado por JS e no celular vira faixa
presa embaixo. As classes são `app-tut-fundo`, `app-tut-holofote`, `app-tut-balao`
e `app-ajuda-secao`, todas em `panel/public/css/apps.css`.

Quando a fase de acabamento unificar o tutorial de todas as telas (o padrão de
referência é um tour guiado com `driver.js`), **o texto dos sete passos é o que importa preservar**: ele é a parte
cara, e está em `passosDoTutorial()`. O motor pode ser trocado inteiro.

## Armadilhas

- **Reinstalar o painel apaga a pasta `assets/`.** O `rsync` do
  `install-panel-service.sh` não exclui `assets/`, então o avatar do agente vai
  junto. Repor a imagem a partir da
  cópia que o dono guardou fora do agente.
- **A aba se redesenha sozinha a cada minuto** (`refreshCurrentPanel`, no
  `app.js`). Quem mexer em `apps.js` precisa lembrar que o estado `abertos`
  sobrevive ao redesenho: é por isso que `abrirEtapa` (o toggle) e `desenharEtapa`
  (o desenho) são funções separadas, e que `reabrirAbertas` roda depois de cada
  redesenho.
- **Nada de `git add -A` neste repo.** Commitar só os próprios arquivos, pelo
  caminho.
