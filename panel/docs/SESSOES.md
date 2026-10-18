# Aba Sessões (mini-Bunker)

A aba Sessões mostra as sessões de trabalho do agente como cards: o que cada uma faz agora,
a conversa dela, e os botões para aprovar ou negar um pedido, mandar recado, anexar arquivo,
arquivar, retomar, renomear, dar estrela, fazer handoff e criar um card novo. É o mini-Bunker
do DG Claw.

Tudo o que se faz clicando na tela se faz também por API, com a mesma rota. Este documento
serve para a pessoa e para o agente que vai operar a aba (também em `GET /api/sessoes/docs.md`).

## Duas fontes, uma tela

| Modo | Quando | Quem guarda os cards |
| --- | --- | --- |
| `local` (padrão) | sempre que `DGCLAW_PANEL_SESSOES_URL` (ou `sessoes.url` no `config.json`) não está definida | o **runner do próprio agente** (sessões paralelas) |
| `proxy` | `DGCLAW_PANEL_SESSOES_URL` definida (instalação do Danilo) | o DG Telegram / Bunker, via `lib/sessoes-proxy.js` |

A escolha é feita quando o painel sobe. A tela (`public/js/sessoes.js`) é a mesma nos dois
modos e esconde o que a fonte não sabe fazer, olhando `fonte.recursos`. O modo local fala o
mesmo contrato de `/api/sessoes*` do DG Telegram, com as diferenças descritas abaixo.

## Como chamar

A rota pública de um agente é `/p/<agente>/api/sessoes...`. Vale com o login do painel (cookie)
e com chave de API (`Authorization: Bearer dgc_...`, criada na aba Cofre).

```bash
BASE="https://<seu-dominio>/p/<agente>"
CHAVE="dgc_..."

# a lista (grupo: ativos, todos, arquivado, esperando_voce, trabalhando, concluido, parado, erro, fechado)
curl -s -H "Authorization: Bearer $CHAVE" "$BASE/api/sessoes?grupo=ativos&q=contrato&limite=50"

# criar uma sessão (pasta é opcional e precisa ficar dentro da casa do agente)
curl -s -X POST -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{"nome":"Revisar o contrato","prompt":"Leia docs/contrato.md e liste os riscos.","pasta":"docs"}' \
  "$BASE/api/sessoes"

# mandar um recado (quando: "agora" ou "quando_livre")
curl -s -X POST -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{"texto":"Foque na cláusula 7.","quando":"quando_livre"}' \
  "$BASE/api/sessoes/card-a1b2c3/recado"

# anexar um arquivo (campo "arquivo"; "texto" opcional manda um recado citando o caminho)
curl -s -X POST -H "Authorization: Bearer $CHAVE" \
  -F "arquivo=@/tmp/planilha.xlsx" -F "texto=Veja esta planilha" \
  "$BASE/api/sessoes/card-a1b2c3/anexo"

# arquivar e depois apagar
curl -s -X POST -H "Authorization: Bearer $CHAVE" "$BASE/api/sessoes/card-a1b2c3/arquivar"
curl -s -X POST -H "Authorization: Bearer $CHAVE" "$BASE/api/sessoes/card-a1b2c3/apagar"
```

Toda mutação feita pelo navegador (cookie) precisa vir da própria tela: o painel confere que o
`Origin` é o mesmo do painel e recusa com 403 o que veio de outro site. Chave de API não passa
por essa conferência, porque navegador nenhum a manda sozinho.

## Modo local: de onde vêm os cards

O painel roda dentro do container do agente e já conhece o runner (`bunkerUrl`, por padrão
`http://127.0.0.1:4300`, e o token no arquivo `RUNNER_TOKEN_FILE`). **Um card é uma sessão
paralela do runner.** O agente cria cards pelo mesmo runner com o comando `dgclaw-card` (skill
`cards`), então o que ele abre aparece na tela, e o que a pessoa abre na tela o agente enxerga.
O `--titulo` do `dgclaw-card` vira o nome do card.

O runner não guarda nome escolhido na tela, estrela, arquivado, quem criou nem pasta. Isso fica
em `<casa do agente>/.dgclaw/panel/sessoes-local.json` (permissão 600, escrita atômica):
`{ "<id>": { nome, favorito, arquivado: {quando, por} | null, criado_em, criado_por, pasta } }`.
`criado_por` é `tela` ou `chave:<nome da chave>`. Sessão sem registro usa o título do runner como
nome. Registro de sessão que o runner não tem mais é limpo quando o painel sobe.

A sessão principal e a de bastidores aparecem na lista (campo `papel`: `principal`,
`bastidores` ou `card`), mas não podem ser arquivadas nem apagadas: respondem 409 com o motivo.

O limite de sessões abertas ao mesmo tempo é `RUNNER_MAX_SESSOES_EXTRAS` (8 na unidade do
container). Sessão dormindo não gasta memória, e o teto de capacidade do runner barra acordar
mais do que a máquina aguenta. Passou do limite: 429 explicando que é preciso arquivar e apagar
um card antigo.

### Estado e grupo

| Runner (`status`) | `grupo` / `estado` | `tem_terminal` |
| --- | --- | --- |
| `waiting_input` | `esperando_voce` (`pedindo_permissao` com pedido, senão `esperando_resposta`) | true |
| `working`, `spawning` | `trabalhando` | true |
| `idle`, `completed` | `concluido` (`ocioso`) | true |
| `errored` | `erro` | false (o Retomar fica disponível) |
| `stopped` | `parado` | false |
| `resumable` (dormindo) | `fechado` | false |

`ultima_fala` vem da última mensagem do assistente na conversa (280 caracteres,
`fonte: "transcript"`; sem conversa, o texto da tela com `fonte: "tela"`). `motivo` é uma frase
em português ("trabalhando agora", "esperando sua decisão", "dormindo: acorda com um recado").
`arquivado` é verdadeiro/falso e `arquivado_em` diz quando.

### Recursos do modo local

`criar, pedidos, decidir, handoff, parar, retomar, anexo, renomear, favorito, documentos, apagar`:
true. `link_externo, cofre, teclado`: false (as rotas de cofre, pedidos, donos e tecla respondem
501 dizendo que não existem nesta instalação).

## Rotas (todas sob `/api/sessoes`)

| Rota | O que faz no modo local |
| --- | --- |
| `GET /api/sessoes-config` | `{ligado: true, modo: "local", agente, appUrl: null, soLeitura}` |
| `GET /api/sessoes?grupo=&q=&limite=` | lista no formato do contrato: `itens`, `contagem` por grupo (mais `arquivado`), `total_filtrado`, `fonte`. Quem espera você vem primeiro; favoritos sobem dentro do grupo; as fechadas são as 60 mais recentes. `q` ignora acento e maiúscula. `limite` de 1 a 300 (padrão 100) |
| `GET /api/sessoes/:id` | `{ok, item, fonte}`; 404 se não existe |
| `GET /api/sessoes/:id/conversa?limite=30&before=n` | do `conversation` do runner. `before` é quantas mensagens do fim já foram entregues; a resposta traz `antes` (use no pedido seguinte), `truncado` e `mensagens: [{role, texto, cortado?}]` |
| `GET /api/sessoes/provedores` | `{ok, principal, disponiveis: [{id, nome}]}`. Os motores que um card novo pode usar neste agente. Vem do campo `disponiveis` de `GET /api/provedor` do runner (provedor liberado no catálogo E programa instalado no PATH do agente; o login não é conferido aqui, falta de login aparece ao criar, como `SEM_LOGIN`). Runner antigo, sem o campo: só o provedor da principal. A tela só mostra a escolha Claude/Codex quando há mais de um |
| `POST /api/sessoes` | `{nome, prompt, pasta?, provedor?}`. Cria a sessão no runner e entrega o prompt. Sem `provedor`, usa o provedor, a forma de pagar e o modelo da principal. Com `provedor` (um dos `disponiveis`), usa esse motor com a forma de pagar e o modelo padrão dele; valor que não vale devolve 400 `PROVEDOR_INVALIDO` dizendo quais valem. `pasta` (relativa à casa ou absoluta dentro dela) vira uma linha no começo do prompt. 201 com `{ok, item}` |
| `POST /api/sessoes/:id/recado` | `{texto, quando: "agora" \| "quando_livre", retomar?}`. `agora` digita no terminal; `quando_livre` entra na fila do runner e chega quando a sessão ficar livre (202). Em `esperando_voce`, 409 (decida o pedido primeiro). Sem terminal e sem `retomar: true`, 409 com `como_resolver`. Com `retomar: true` a sessão é acordada e o recado entra na fila. Pela chave de API o texto sai com o prefixo `[recado de <nome da chave> pelo painel] ` |
| `POST /api/sessoes/:id/decidir` | `{acao: "aprovar" \| "negar"}`. **Só com login humano**: chave de API recebe 403, porque um agente não aprova o próprio pedido. 409 se não há pedido esperando |
| `POST /api/sessoes/:id/arquivar` | suspende o terminal (se aberto) e marca arquivado. Principal e bastidores: 409 |
| `POST /api/sessoes/:id/desarquivar` | só tira a marca (404 se não estava arquivada) |
| `POST /api/sessoes/:id/retomar` | mesma conversa (`/resume`); com `{"nova": true}`, conversa nova (`/revive`, útil quando a conversa travou). 409 se já tem terminal |
| `POST /api/sessoes/:id/apagar` | só card arquivado: remove a sessão do runner (libera a vaga) e o registro. A conversa continua no disco. Principal e bastidores: 409 |
| `GET/POST /api/sessoes/:id/handoff` | ver abaixo |
| `POST /api/sessoes/:id/anexo` | multipart, campo `arquivo`, até 50 MB. Grava em `<casa>/anexos/<id>/<nome-saneado>` (nome repetido ganha `-2`, `-3`...) e devolve `{caminho, nome, tamanho}`. Com `texto` no form, manda um recado citando o caminho |
| `POST /api/sessoes/:id/renomear` | `{nome}` de 1 a 120 caracteres. Devolve `{ok, item}` |
| `POST /api/sessoes/:id/favorito` | `{favorito: true \| false}`, ou sem corpo para alternar. Devolve `{ok, item}` |
| `GET /api/sessoes/:id/documentos` | arquivos citados nas últimas mensagens que existem dentro da casa do agente: `{caminho, nome, pasta, tipo, tamanho, quando}` |
| `GET /api/sessoes/:id/documentos/conteudo?caminho=` | abre um documento da lista (texto até 2 MB em `{nome, texto, cortado}`; PDF e imagem servidos com o tipo certo). Nunca sai da casa do agente, só abre o que foi citado e recusa arquivos escondidos (como `.env`) |
| `GET /api/sessoes/docs.md` | este documento, em `text/markdown` |

### Handoff local

`GET .../handoff` procura na última resposta do card uma mensagem no formato do handoff (primeira
linha começando com `▶️`, um bloco de código com o prompt, última linha com `✅`) e devolve
`{encontrado, nome_novo, nome_antigo, prompt}` (o prompt cortado em 600 caracteres, também em
`trecho`). Sem handoff pronto: `{encontrado: false, motivo}`.

`POST .../handoff` com `{usar_existente: true, apagar_antigo: false}`:

- achou o handoff: cria um card com `nome_novo` e o prompt, renomeia o antigo com `nome_antigo` e
  arquiva o antigo (apaga, se `apagar_antigo`). 201 com `{novo: item, abrir_em: id}`;
- não achou: manda um recado `quando_livre` pedindo o handoff no formato e responde 202 com
  `aviso: "Pedi o handoff. Quando ele responder, aperte Handoff de novo."`.

## Modo só leitura

Com `DGCLAW_PANEL_SESSOES_SO_LEITURA=1` (ou `sessoes.soLeitura: true` no `config.json`) toda
escrita responde 403 e a tela esconde os botões. Vale nos dois modos. Serve para painel sem
proteção de login na frente.

## Erros

Todo erro sai `{ok: false, erro, como_resolver, code}` em português, com o status certo.

| Situação | Resposta |
| --- | --- |
| Runner fora do ar ou sem responder | 503 `RUNNER_FORA`, dizendo o endereço tentado e "reinicie o agente pelo Admin" |
| Token do runner ilegível ou ausente | 503 `SEM_TOKEN_RUNNER`, com o caminho do arquivo |
| Runner recusou o token | 503 `RUNNER_RECUSOU_TOKEN` |
| Chave de API tentando decidir pedido | 403 `DECIDIR_SO_COM_LOGIN` |
| Pedido que não veio da tela (cookie sem `Origin` do painel) | 403 |
| Principal ou bastidores arquivada ou apagada | 409 `SESSAO_FIXA` |
| Limite de sessões atingido | 429 `LIMITE_DE_SESSOES`, com como liberar vaga |
| Provedor da conta sem login ou sem chave | 409 `SEM_LOGIN` ou `SEM_CHAVE`; a sessão recém criada é fechada |
| Documento fora da casa ou não citado | 403 `FORA_DA_CASA` ou `NAO_CITADO` |

Nunca há resposta 200 com lista vazia quando o runner falhou. O token do runner não aparece em
resposta nem em log.

## Para quem mantém o painel

- Código do modo local: `lib/sessoes-local.js`. Código do modo proxy: `lib/sessoes-proxy.js`.
  A escolha está em `server.js`.
- Testes: `node test-sessoes-local.mjs` (contra um runner falso) e `node test-sessoes.mjs` (modo
  proxy, contra um DG Telegram falso), na pasta `panel`.
- Para mudar o limite de sessões: `RUNNER_MAX_SESSOES_EXTRAS` em `container/units/dgclaw-runner.service`.
