# O canal WhatsApp do DG Claw

Escrito em 12/10/2026 (card C5 da Imersão). É o contrato das peças do WhatsApp: a ponte, as tools de
resposta, o comando `dgclaw-agente canal whatsapp` e a leitura da conversa. Quem conduz o dono pelo
passo a passo é a skill `canais` (`skills/canais/SKILL.md`).

## O que é, em uma frase

Um número de WhatsApp **secundário** do dono vira um aparelho conectado ao agente. O dono manda
mensagem do número pessoal dele para esse número, a ponte entrega ao agente como mensagem externa, e o
agente responde por uma tool que devolve o texto pelo mesmo número.

## O risco, antes de tudo

A ponte usa o Baileys (`@whiskeysockets/baileys`), que fala o protocolo do WhatsApp Web. **Não é uma API
oficial do WhatsApp.** Conectar o WhatsApp por uma API não oficial (a ponte do DG Claw, a Z-API, a
Evolution e parecidas) tem risco de banimento do número, e em alguns casos até pela API oficial o risco
existe. O que derruba um número é comportamento de robô: muitas mensagens de uma vez, o mesmo texto para
várias pessoas, ritmo sempre igual, número que só manda e quase nunca recebe resposta. Usando o WhatsApp
para análise (ler, entender, resumir) ou mandando mensagens como uma pessoa mandaria, poucas e em conversa,
o risco fica muito baixo. E o padrão do DG Claw já envia com intervalos variados e com as travas descritas
em [Comportamento humano: as travas contra banimento](#comportamento-humano-as-travas-contra-banimento).
Por isso:

- só com número secundário (um chip barato ou um número virtual), nunca o número principal do dono;
- o agente avisa o risco ANTES de começar, e só segue com o "sim" do dono;
- para quem quer estabilidade, a recomendação continua sendo o Telegram, que é oficial.

## As peças

| Peça | Onde | O que faz |
| --- | --- | --- |
| ponte | `canais/whatsapp/ponte.mjs` | conecta ao WhatsApp, recebe, filtra pela lista e entrega ao runner; envia o que chega pelo socket |
| dependências | `canais/whatsapp/package.json` e `package-lock.json` | só o Baileys e o logger, versões exatas, `integrity` no lock |
| unidade | `container/units/dgclaw-whatsapp.service` | roda a ponte como `agente`; instalada na imagem, mas NÃO habilitada |
| tools | `scripts/dgchat-mcp/server.mjs` | `whatsapp_reply` e `whatsapp_send_file`, que falam com o socket |
| comando | `bin/dgclaw-agente canal whatsapp ...` | parear, permitir, remover, ligar, desligar, status |
| leitura | `web/lib/thread.js`, `scripts/_lib/thread_log.py` | mostram as falas do WhatsApp na conversa, com o selo |

## Versão do Baileys

`6.7.24`, a última versão estável (tag `legacy` do npm, publicada em 29/07/2026). A tag `latest` aponta
para `7.0.0-rc14`, que é release candidate e traz uma dependência nova em WebAssembly
(`whatsapp-rust-bridge`) mantida por uma pessoa fora do WhiskeySockets. Ficamos na estável.

A 6.7.24 declara o `libsignal` como dependência git do GitHub do WhiskeySockets. Isso tornaria o GitHub
obrigatório na instalação de todo aluno, até de quem não usa o WhatsApp, então o `package.json` traz
`"overrides": {"libsignal": "6.0.0"}`: o mesmo pacote, vindo do registro npm (mantenedores `purpshell` e
`mayfield`, repositório WhiskeySockets/libsignal-node). A instalação na imagem usa `npm ci --omit=dev --ignore-scripts`, para nenhum script de
instalação de dependência rodar no build.

Conferido em 12/10/2026 (condições do card 4):

- `@whiskeysockets/baileys` 6.7.24, integrity
  `sha512-Ljq7si+gsNIE9d5dP69E99TTQp+BxxPgitWvmZMXExGc1Ctr0SCDLFZmxRLUDC5HB0/Itw5uk+HJeBONrLP99Q==`.
- `libsignal` 6.0.0 do registro npm, integrity
  `sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==`.
  Comparado com o commit `bcea72df9ec34d9d9140ab30619cf479c7c144c7` do GitHub (o que a 6.7.24 puxava):
  `src/`, `index.js`, `index.d.ts`, `package.json`, `LICENSE` e `README.md` idênticos; o GitHub só tem a
  mais arquivos de desenvolvimento (`protos/`, `.github`, `yarn.lock`, configurações de lint e release).
- Nenhum `resolved` do lock é git: todos vêm de `registry.npmjs.org` com `integrity`. O `npm ci
  --omit=dev --ignore-scripts` passa sem `git` no PATH e com `GIT_SSH_COMMAND=/bin/false`.
- `canais/whatsapp/test/lock.test.mjs` falha se aparecer qualquer pacote que não seja do registro,
  pacote sem `integrity` ou versão não exata no `package.json`.
- Com `--ignore-scripts` nada deixa de funcionar: só o `protobufjs` (postinstall de versão) e o próprio
  Baileys (preinstall que confere a versão do node) têm script, e nenhum pacote tem binário nativo.
  `sharp` e `jimp` são opcionais; sem eles a imagem enviada sai sem miniatura.

## Arquivos na casa do agente

Tudo dentro de `~/.dgclaw/whatsapp/` (pasta 700, arquivos 600). Fica fora das pastas que o painel serve e
fora do backup.

| Arquivo | Quem escreve | O que é |
| --- | --- | --- |
| `sessao/` | ponte | as credenciais do aparelho conectado (`useMultiFileAuthState`). Segredo. |
| `permitidos.json` | `dgclaw-agente canal whatsapp permitir/remover` | `{"versao":1,"numeros":["+5511987654321"]}`. Relido quando o mtime muda. |
| `ligado` | `dgclaw-agente canal whatsapp ligar` | vazio. A unidade só sobe se ele existir (`ConditionPathExists`). |
| `ponte.sock` | ponte | socket unix (600) por onde as tools pedem envio |
| `estado.json` | ponte | `{"versao":1,"estado":"...","desde":"<iso>","numero_bot":"+55..."\|null,"motivo":"..."\|null}` |
| `codigo` | ponte, no pareamento | uma linha, `ABCD-1234`. Apagado quando o pareamento termina ou expira. |
| `ultimo.json` | ponte | `{"numero":"+55...","ts":"<iso>"}`: quem mandou a última mensagem aceita (informativo; não decide destino) |
| `envio.json` | dono (opcional) | configuração das travas contra banimento (abaixo). Sem o arquivo, valem os padrões |
| `grupos-liberados.json` | `dgclaw-agente canal whatsapp grupo liberar/remover` | `{"versao":1,"grupos":[{"id":"120363000000000000-group","nome":"...","liberado_em":"<iso>"}]}`. Os grupos em que o agente pode escrever pela Z-API. Lido a cada envio. Sem o arquivo, nenhum grupo está liberado |
| `envio/` | ponte e script da Z-API | histórico de envios (só hora e hashes, nunca número nem texto), a trava `PARADO` e o marcador `PENDENTE`. A ponte e a Z-API usam a mesma pasta: contam como um só remetente, com o mesmo ritmo, teto e trava |
| `lids.json` | ponte | `{"versao":1,"lids":{"123@lid":"+55..."}}`: mapa de LID para número (600, escrita atômica) |

Valores de `estado`: `aguardando_codigo` (pareamento pedindo o código), `codigo_pronto` (código no
arquivo, esperando o dono digitar), `pareado` (pareamento concluído, ponte de pareamento encerrada),
`conectado`, `reconectando`, `deslogado` (o WhatsApp encerrou o aparelho; é preciso parear de novo),
`erro` (com `motivo`).

O log fica em `~/.dgclaw/logs/whatsapp.log` (600) e também sai no stdout (journal da unidade).
**O log nunca guarda corpo de mensagem, código de pareamento nem credencial.** Recusa por lista é uma
linha só: `whatsapp: recusado +5511987654321 às 14:32`.

## Números

- Formato canônico: E.164 com `+` (`+5511987654321`). Na entrada, aceita espaço, traço, parênteses e
  ponto; sem `+` na frente, 10 ou 11 dígitos são tratados como Brasil (`55` na frente). Com `+`, o código do
  país já veio (`+1 415 555 2671` continua americano). Fora de 10 a 15
  dígitos depois de limpar, é recusado com o motivo.
- **Nono dígito do Brasil.** Contas antigas aparecem no WhatsApp sem o 9 do celular
  (`551187654321@s.whatsapp.net` para quem a pessoa conhece como `+55 11 98765-4321`). Dois números
  `+55` são o mesmo quando um é `55 + DDD + 9 + 8 dígitos` e o outro é `55 + DDD + os mesmos 8 dígitos`.
  A comparação com a lista usa essa equivalência; na saída, a ponte pergunta ao WhatsApp
  (`onWhatsApp`) qual é o JID real e guarda em memória.
- **Remetente em LID.** Mensagens podem chegar de `xxxx@lid` em vez de `55...@s.whatsapp.net`. O número
  vem de `key.senderPn` (ou `key.participantPn`), mas o servidor nem sempre o manda. Por isso a ponte
  guarda um mapa LID para número em `lids.json`, alimentado por: (a) `onWhatsApp(<numero>)` de cada
  número da lista, ao abrir a conexão e sempre que a lista muda (a resposta traz o `lid`); (b) toda
  mensagem em `@lid` que traga `senderPn`/`participantPn`; (c) o evento `chats.phoneNumberShare`. Em `@lid`
  sem número, consulta o mapa; sem resposta, a mensagem é recusada com a linha
  `whatsapp: recusado (número oculto) às 14:32`. Falha do `onWhatsApp` vira linha de log, sem derrubar nada.
- **Recusas no log.** No máximo uma linha `recusado` por número a cada 10 minutos, para um desconhecido
  insistente não encher o log.

## A ponte

`node ponte.mjs` (modo serviço, o da unidade), `node ponte.mjs --parear <digitos>` e
`node ponte.mjs --logout`. Ela exporta `iniciar(opcoes)` para os testes injetarem um Baileys falso, um
relógio e os caminhos; só importa o Baileys de verdade quando não recebe um.

Ambiente: `HOME`, `DGCLAW_RUNNER_URL` (padrão `http://127.0.0.1:4300`), `DGCLAW_AGENTE_ID` (se faltar, lê
o campo `id` de `DGCLAW_RUNNER_JSON`, padrão `/etc/dgclaw-runner/runner.json`), `RUNNER_TOKEN_FILE`
(relido a cada envio).

### Entrada (WhatsApp para o agente)

1. Só `messages.upsert` do tipo `notify`. Ignora `fromMe`, grupos (`@g.us`), `status@broadcast`, listas e
   canais (`@newsletter`), reações e mensagens de protocolo. Ignora id repetido.
2. Número fora da lista (ou lista ausente ou inválida): descarta, loga a linha de recusa, não marca como
   lida e não responde nada.
3. Número na lista: monta o corpo. Texto puro, legenda, ou, para imagem, áudio, vídeo e documento, baixa
   o arquivo para `~/uploads/whatsapp/<AAAA-MM-DD>/<id>.<ext>` (limite de 25 MB) e escreve
   `[áudio salvo em /home/agente/uploads/whatsapp/2026-10-17/ABC.ogg]` no corpo. Tipo que a ponte não lê
   vira `[mensagem do tipo <tipo>, que a ponte ainda não lê]`.
4. Escapa o corpo (`&` para `&amp;`, `<` para `&lt;`, `>` para `&gt;`), para nenhum texto de fora conseguir
   fechar o envelope ou forjar um `<dgchat>`. Os atributos só levam valores limpos (o id da mensagem fica
   restrito a `[A-Za-z0-9_-]`).
5. Entrega: `POST <runner>/api/agents/<id>/input`, Bearer do `RUNNER_TOKEN_FILE`, corpo
   `{"text": <envelope>, "submit": true, "injectWhenIdle": true}`, com

   ```
   <canal-externo origem="whatsapp" de="+5511987654321" msg="3EB0A1B2" ts="2026-10-17T14:32:05.000Z">corpo escapado</canal-externo>
   ```

6. Falha de rede ou 5xx: tenta de novo em 2, 5 e 15 segundos. 409 (agente sem login ou sem chave) ou
   falha final: loga o motivo (sem o corpo) e avisa o remetente pelo WhatsApp que a mensagem não chegou
   ao agente e por quê, em uma frase.
7. Entregue: grava `ultimo.json` e marca a mensagem como lida.

### Saída (agente para o WhatsApp), o socket

Cada conexão manda **uma linha JSON** (até 64 KB) e recebe uma linha JSON de volta; depois a ponte fecha.

| Pedido | Campos |
| --- | --- |
| `{"acao":"enviar","para":"+55...","texto":"..."}` | `para` opcional |
| `{"acao":"arquivo","para":"+55...","caminho":"/abs/arquivo.pdf","legenda":"..."}` | `para` e `legenda` opcionais |

Resposta: `{"ok":true,"para":"+55...","id":"<id da mensagem>"}` ou
`{"ok":false,"codigo":"<CODIGO>","erro":"<motivo em português, com o que fazer>"}`.

| Código | Quando |
| --- | --- |
| `PEDIDO_INVALIDO` | linha que não é JSON, ação desconhecida, texto vazio ou acima de 32.000 caracteres |
| `FORA_DA_LISTA` | `para` não está na lista de permitidos |
| `SEM_DESTINO` | sem `para` e a lista não tem exatamente um número (com 2 ou mais, `para` é obrigatório) |
| `SEM_WHATSAPP` | o número não tem conta no WhatsApp |
| `DESCONECTADO` | a ponte não está conectada agora (reconectando, deslogada) |
| `ARQUIVO` | caminho relativo, inexistente, que não é arquivo comum (atalho, dispositivo, fifo), acima de 64 MB, ou fora das pastas permitidas (abaixo) |
| `FALHA_ENVIO` | o WhatsApp recusou ou deu erro ao enviar. **Os envios ficam travados** (veja `PARADO`) |
| `PARADO` | os envios estão travados por um erro, queda do aparelho ou sinal de bloqueio; só o dono libera |
| `RITMO` | a mensagem anterior saiu há pouco e a espera passaria de 25 s; o erro diz quantos segundos esperar |
| `PAUSA_DA_RODADA` | a rodada chegou ao teto (30 mensagens) e a pausa de 30 minutos está correndo |
| `TETO_DIA` | o teto de 60 mensagens em 24 horas foi atingido |
| `AQUECIMENTO` | número novo no teto do dia de aquecimento |
| `TEXTO_REPETIDO` | o mesmo texto já foi para outra pessoa nas últimas 24 horas |
| `GRUPO_NAO_LIBERADO` | (só Z-API) o ID do grupo não está em `grupos-liberados.json`; o dono libera com `grupo liberar` |
| `LISTA_DE_GRUPOS_ILEGIVEL` | (só Z-API) `grupos-liberados.json` existe e não pôde ser lido ou tem formato errado; nenhum grupo vale até o dono corrigir |
| `ESTADO_INVALIDO` | o histórico de envios (`envio/estado.json`) existe mas não pôde ser lido; nada sai até o dono conferir (apagar recomeça o histórico) |
| `EXPIRADO` | o pedido esperou na fila além do prazo e não foi enviado; a tool já tinha desistido |
| `AINDA_PODE_ESTAR_ENVIANDO` | o `retomar` veio logo depois de um envio sem resposta; espere 5 minutos, confira o celular e rode de novo |
| `OCUPADO` | outro envio segurou a vez por mais de 45 s |
| `CONFIG_INVALIDA` | o `envio.json` tem valor errado; o erro diz qual |

**Pastas permitidas para envio de arquivo** (revisão do card 4, 12/10): só a casa do agente
(`/home/agente`) é raiz; nada de `/tmp`. A raiz tem de ser ela mesma (se for atalho, recusa), o caminho
pedido e o realpath têm de cair nela, e nenhum componente a partir da casa pode começar com ponto. Isso
barra `~/.dgclaw`, `~/.claude` (`.credentials.json`), `~/.codex`, `~/.ssh` e `/etc`, mesmo que o pedido
venha de uma mensagem com injeção de prompt. O arquivo é aberto UMA vez, com `O_NOFOLLOW`; dali em diante
tudo se confere e se lê pelo descritor (mesmo arquivo do `lstat` por `dev`/`ino`, arquivo comum, destino
real em `/proc/self/fd` dentro da raiz), então trocar o arquivo por um atalho no meio do caminho não adianta.
Arquivo com mais de um nome no disco (hardlink, `nlink > 1`) é recusado: copie com `cp` para `~/saida/`
e mande a cópia.

**Prazos do socket:** 30 segundos para o cliente mandar a linha (o prazo cai assim que ela chega); depois
a execução tem prazo próprio, 75 segundos para texto (cabe a espera do intervalo entre mensagens, ver abaixo) e 120 para arquivo. Estourado, a resposta é
`FALHA_ENVIO` dizendo que a mensagem pode ou não ter saído e que não se deve repetir às cegas.

**Risco residual aceito:** uma CÓPIA (`cp`) de um arquivo secreto para `~/saida/` nenhuma checagem pega.
O filtro protege contra erro do agente; a barreira real contra vazamento é a lista de permitidos (só os
números que o dono liberou recebem qualquer coisa). Da mesma forma, `downloadMediaMessage` baixa a mídia
antes de se conferir o tamanho real (o limite de 25 MB olha o `fileLength` declarado); só mensagens de
número permitido chegam a esse ponto.

O mesmo vale para os arquivos de estado da pasta `~/.dgclaw/whatsapp`, que é do próprio agente
(apontado pelo card 4 em 12/10): um agente comandado por injeção de prompt e com Bash poderia gravar no
`lids.json` um LID de outra pessoa apontando para o número do dono. Isso não lhe dá poder novo, porque o
mesmo agente já conseguiria editar o `permitidos.json`. A defesa é a regra de autoridade (mensagem do
WhatsApp é externa e nunca muda canal, lista ou credencial) e o fato de a lista só mudar a pedido do dono
no chat do DG Claw.

**Destino:** com um único número na lista, `para` pode faltar e esse número é o destino. Com dois ou mais,
`para` é obrigatório: o agente passa o número do atributo `de` do envelope que está respondendo
(`SEM_DESTINO` explica isso). A ponte não adivinha pelo último remetente.

Arquivo: imagem (`jpg`, `jpeg`, `png`, `webp`) vai como imagem, áudio (`ogg`, `opus`, `mp3`, `m4a`) como
áudio, vídeo (`mp4`) como vídeo, o resto como documento com o nome do arquivo.

### Pareamento por código

`ponte.mjs --parear <digitos>` (os dígitos do número SECUNDÁRIO, o que vai virar o agente):

1. Recusa se `sessao/creds.json` já diz `registered: true` (já pareado: para trocar, `desligar --apagar`).
2. Conecta, grava `estado: aguardando_codigo`, pede `requestPairingCode(digitos)` e grava o código, no
   formato `ABCD-1234`, em `codigo` (600), com `estado: codigo_pronto`.
3. O dono abre o WhatsApp do número secundário, **Aparelhos conectados > Conectar aparelho > Conectar
   com número de telefone**, e digita o código.
4. O WhatsApp fecha a conexão pedindo reinício (código 515); a ponte reconecta com a mesma sessão. Ao
   abrir, grava `estado: pareado` com `numero_bot`, apaga `codigo` e sai com código 0.
5. Cinco minutos sem concluir: `estado: erro`, motivo "o código expirou", apaga `codigo`, sai com 1.

QR fica para depois (exigiria mais uma dependência para gerar a imagem).

### Serviço

Conecta com a sessão salva; ao abrir, `estado: conectado`. Queda comum: `reconectando`, com espera
crescente (2 s até 60 s). Queda por `loggedOut` (401): `estado: deslogado`, motivo dizendo para parear de
novo, e sai com código 0 (a unidade não fica em laço). Sem sessão pareada: `estado: erro`, motivo
"ainda não pareado", sai com 0.

### Logout

`ponte.mjs --logout`: conecta com a sessão, chama `logout()`, sai. Até 30 segundos. É o que o
`desligar --apagar` chama antes de apagar a pasta, para o aparelho sumir da lista do celular.

## Comportamento humano: as travas contra banimento

Vale para **toda** conexão de WhatsApp do agente: a ponte (Baileys), a Z-API, a Evolution e as outras não
oficiais, e também a oficial. O código está em `canais/whatsapp/lib/envio-seguro.mjs`; a ponte passa todo
envio por ele, e o script `canais/whatsapp/enviar-zapi.mjs` (skill `whatsapp-enviar`) faz o mesmo para a Z-API.
Para outra conexão (Evolution, API oficial), o agente usa o mesmo módulo: o que muda é só a função que envia.

### O que o módulo faz

| Trava | Padrão | O que acontece |
| --- | --- | --- |
| Uma mensagem por chamada | sempre | nada de lote: cada pedido manda um texto |
| O que é disparo | 2 pessoas diferentes em 60 minutos | conversa com uma pessoa só nunca espera nem é limitada pela rodada |
| Intervalo no disparo | aleatório entre **8 e 20 segundos** | sorteado a cada mensagem, nunca fixo. Não há "modo lento" por padrão |
| Rodada | 30 mensagens, depois pausa de 30 minutos | a mensagem 31 volta `PAUSA_DA_RODADA` com o tempo que falta |
| Teto do dia | 60 mensagens em 24 horas por agente | vale quando se está em disparo e conta tudo o que saiu em 24 h |
| Texto igual | recusa o mesmo texto para 2 pessoas em 24 h | vale para textos de 15 letras ou mais; reescreva para cada pessoa |
| Trava | no primeiro erro de envio, desconexão forçada (401, 403) ou sinal de bloqueio | cria o arquivo `PARADO`; nada mais sai até o dono liberar com `retomar` |
| Número novo | `numero_novo_desde` com a data de início | teto por dia de aquecimento: dias 1 a 3, 10 mensagens; 4 a 7, 30; 8 a 14, 60 |

Se o histórico não puder ser gravado depois de um envio, a mensagem já saiu, a resposta traz o campo `aviso` e os envios seguintes ficam travados (sem histórico as travas de ritmo ficariam cegas). A trava entre processos (a ponte e o script da Z-API) só é tomada de volta quando o processo que a segurava morreu, nunca por idade. As tools MCP esperam até 90 s pela resposta de texto, para caber o intervalo.

Antes de cada envio o módulo grava um marcador `PENDENTE` e o apaga quando o resultado é conhecido. Se o processo morrer no meio, ou o disco recusar o arquivo `PARADO` depois de um erro, o marcador continua e segura os envios (resultado incerto) até o dono conferir o número e liberar com `retomar`. Enquanto um envio está no ar o marcador é normal: o pedido seguinte espera a vez, o `status` não acusa travamento e o `retomar` se recusa a rodar. Só um marcador sem ninguém segurando a vez conta como envio interrompido. O prazo de um pedido na fila conta do momento em que ele chegou à ponte, então nada sai depois de o cliente já ter recebido a falha.

A queda comum de rede (reconexão normal do Baileys) não trava, porque acontece o tempo todo. O erro de envio
trava de propósito: continuar tentando num número que o WhatsApp está recusando é o jeito mais rápido de
perdê-lo. A mensagem do erro diz que ela pode ou não ter saído e que não se deve repetir às cegas.

### Configuração (`~/.dgclaw/whatsapp/envio.json`)

O dono pode ir mais devagar, nunca mais depressa do que o piso. Chave desconhecida ou valor fora do limite
**recusa o envio** com o motivo (`CONFIG_INVALIDA`); o módulo não troca valor errado por padrão em silêncio.

```json
{
  "intervalo_min_s": 8,
  "intervalo_max_s": 20,
  "teto_rodada": 30,
  "pausa_rodada_min": 30,
  "teto_dia": 60,
  "repetido_horas": 24,
  "numero_novo_desde": "2026-11-16"
}
```

Piso do intervalo: 3 segundos. Teto máximo do `teto_dia`: 500. Quem quer mais cuidado sobe `intervalo_min_s` e
`intervalo_max_s` (por exemplo, 45 e 90 para uma base fria). Chaves restantes: `janela_disparo_min` (60),
`pessoas_disparo` (2), `texto_minimo` (15) e `espera_max_s` (25).

### De onde vêm os números (pesquisa de 16/11/2026)

O WhatsApp não publica nenhum limite seguro para clientes não oficiais. Tudo abaixo é recomendação de
fornecedor ou de comunidade, e os valores variam muito de uma fonte para outra, então o padrão foi calibrado
no meio da faixa, para o uso do DG Claw (um agente que responde e avisa poucas pessoas, e não uma campanha).

| Fonte | O que recomenda |
| --- | --- |
| [Z-API, guia de boas práticas](https://developer.z-api.io/tips/best-practices) | ponto de partida de 5 minutos entre disparos de campanha, reduzindo aos poucos; cerca de 40 envios ativos por dia para quem recebe uns 50; começar com cerca de 10 por dia; pelo menos 5 versões do mesmo texto; alerta para número que envia muito e recebe pouca resposta |
| [Z-API, blog sobre banimento](https://z-api.io/blog/whatsapp-banido-causas-cuidados-e-como-reduzir-riscos-em-automacoes/) | causas: muitas mensagens em poucos segundos, texto idêntico, conversa de mão única, lista sem autorização; começar com volume baixo e crescer |
| [Evolution API e banimento](https://automacaohoje.com/guias/evolution-api-banimento-como-evitar/) | 45 a 120 s aleatórios; até 30 por hora; aquecimento de 10 a 30 por dia nos dias 1 a 3 e 30 a 80 nos dias 4 a 7; 150 a 200 por dia depois; texto idêntico em série e taxa de resposta abaixo de 30% aumentam o risco |
| [Baileys, issue 2309](https://github.com/WhiskeySockets/Baileys/issues/2309) | atrasos aleatórios de 2 a 8 s, pausa mais longa a cada 20 a 30 envios, até 8 por minuto e 200 por hora, aquecimento de pelo menos 7 dias (opinião de usuário, sem fonte oficial) |
| [baileys-antiban](https://github.com/kobie3717/baileys-antiban) | 1,5 a 5 s por padrão, mais espera para quem nunca falou com você, rampa de 7 dias |
| [Genuka, resumo de APIs não oficiais](https://wa.genuka.com/en/docs/compare/unofficial-whatsapp-apis) | aquecer um número novo por pelo menos 10 dias e não passar de 200 clientes por dia |
| [Issue de proteção contra banimento](https://github.com/franciscoaraujo/shopee-automatic/issues/1) | 20 a 60 s entre mensagens, 15 por hora, 120 por dia, silêncio da meia-noite às 7 h |

O que a decisão levou em conta:

- **Intervalo de 8 a 20 s.** Fica acima do que as bibliotecas sugerem para conversa (2 a 8 s) e abaixo do que os
  fornecedores pedem para campanha em massa (45 s a 5 min). Como o disparo do DG Claw é de poucas pessoas, e a
  conversa com uma pessoa só nem espera, o valor cabe. O que importa mais que o número é o sorteio: intervalo
  fixo é padrão de robô. A sugestão inicial do Danilo era de 3 a 10 s; a pesquisa pesou para cima, e o piso de 3 s
  continua valendo para quem quiser ir até lá.
- **30 por rodada e 60 por dia.** Abaixo dos 120 a 200 por dia de número maduro e acima dos 10 a 30 do início.
  O pico de uma rodada seguida de pausa fica perto de 50 por hora, acima dos 30 por hora de uma fonte, mas o teto
  de 60 em 24 h faz o total do dia ficar baixo. Número novo usa a tabela de aquecimento, que é mais apertada.
- **Texto igual.** Aparece em todas as fontes como a causa mais citada, e por isso é recusa, não só aviso.
- **Quem recebe pesa mais que o volume.** Mensagem para quem não tem o seu número salvo, ou para quem não
  respondeu, é o que mais gera denúncia. Mande só para quem espera a mensagem.

### O que o agente faz e não faz

Todo envio passa por esse módulo: pela tool `whatsapp_reply`/`whatsapp_send_file` (a ponte) ou por
`enviar-zapi.mjs` (Z-API). O agente **nunca** chama a API da Z-API, da Evolution ou da Meta por conta
própria (`curl`, script solto, `fetch`), porque assim as travas somem. Se um envio voltar com `PARADO`, o
agente avisa o dono, explica o motivo que veio no erro e espera: não tenta de novo, não contorna e não apaga o
arquivo `PARADO` sozinho.

### Z-API

O adaptador (`canais/whatsapp/lib/adaptador-zapi.mjs`) chama `POST /instances/{instância}/token/{token}/send-text`
com o cabeçalho `Client-Token`. As três chaves ficam no cofre do agente: `ZAPI_INSTANCE`, `ZAPI_TOKEN` e
`ZAPI_CLIENT_TOKEN`. Elas nunca aparecem no log nem nas mensagens de erro (o adaptador troca qualquer pedaço
delas por `***`). Resposta sem id de mensagem conta como falha: não dá para saber se saiu.

```
node /opt/dgclaw/app/canais/whatsapp/enviar-zapi.mjs enviar --para +5511999999999 --texto "..."
node /opt/dgclaw/app/canais/whatsapp/enviar-zapi.mjs status
```

Para texto com aspas ou várias linhas, use `--texto-stdin` e passe o texto pela entrada. A saída é sempre uma
linha JSON. Código de saída 0 enviou, 1 recusou ou falhou, 2 uso errado.

### Grupo pela Z-API

`enviar --grupo <id>` manda um texto para um grupo. O ID tem dígitos seguidos de `-group` (por exemplo
`120363000000000000-group`), o mesmo que a Z-API devolve em `GET /groups` e aceita no campo `phone` do `send-text`.
O script valida o formato (código de saída 2 se estiver errado) e manda o ID intacto, sem tirar nada. `--grupo` e
`--para` não se misturam. Só o formato novo é aceito. O formato legado da Z-API é `<número>-<timestamp>` (sem o `-group`, conforme
https://developer.z-api.io/group/introduction): o DG Claw não o aceita, e os grupos com esse ID são contados como omitidos.

```
node /opt/dgclaw/app/canais/whatsapp/enviar-zapi.mjs grupos
node /opt/dgclaw/app/canais/whatsapp/enviar-zapi.mjs enviar --grupo 120363000000000000-group --texto-stdin < "$ARQ"; rc=$?; rm -f "$ARQ"; (exit "$rc")
```

Antes, o agente reserva um arquivo exclusivo para o envio, com `mkdir -p -m 700 ~/.dgclaw/tmp && mktemp ~/.dgclaw/tmp/msg-XXXXXX.txt` (comando sem o texto; ele anota o caminho devolvido e o usa como `ARQ`). Depois grava o texto nesse caminho com a ferramenta de escrever arquivo (nunca por comando de shell, como `echo`, `cat`, `printf` ou heredoc). Um nome fixo faria duas sessões do mesmo agente trocarem o texto uma da outra. Depois do envio o arquivo é apagado, e o código de saída da CLI é guardado antes da limpeza e devolvido depois dela, para o `rm` não esconder uma recusa. Para grupo a CLI exige `--texto-stdin` e recusa `--texto` (código 2, antes de tocar na rede), porque o texto na linha de comando ficaria visível aos outros usuários da VPS pelo `ps`.

`grupos` chama `GET /instances/{instância}/token/{token}/groups`, página por página (50 por página, até 20 páginas;
passando disso a resposta traz o campo `aviso`) e imprime `{"ok":true,"grupos":[{"id","nome","liberado"}]}`. A paginação
avança pelo tamanho da página que a Z-API devolveu, com ou sem filtro. Os grupos com ID no formato antigo ficam de
fora, e a resposta diz quantos foram no campo `omitidos` (com o `aviso_omitidos`). O nome do
grupo vem de fora: o script tira caracteres de controle, quebras de linha e os símbolos `[ ] ( ) < >` e a crase (para o nome não virar link Markdown no chat), troca `://` por `:/ /` (para não virar link) e corta em 100 caracteres. Os erros passam
pela mesma limpeza de credencial do envio.

**O destino é sempre o ID.** O nome do grupo vem de terceiros, pode mudar e repetir. O nome remoto nunca basta para escolher o destino. Quando o pedido não traz o ID, o agente mostra ao dono o nome (entre crases, como texto literal) e o ID em linha separada e pede confirmação antes do primeiro envio àquele grupo; depois guarda nas próprias notas o apelido que o dono usa ligado ao ID confirmado e usa sempre esse vínculo, nunca o nome remoto atual, e avisa o dono se o nome remoto do ID guardado mudar. Com homônimo, ou com a listagem truncada ou com grupos omitidos, pergunta qual ID usar (só depois o envio confere se o ID está liberado).

**Quem libera é o dono.** O agente só escreve nos grupos que estão em `~/.dgclaw/whatsapp/grupos-liberados.json`,
que o dono mexe pelo comando `dgclaw-agente canal whatsapp grupo (listar | liberar <id> | remover <id>)`. Libere sempre só com o ID: o nome do grupo vem de quem participa dele e não deve ser colado no comando.
Arquivo ausente quer dizer nenhum grupo liberado. Arquivo que existe e não pôde ser lido recusa o envio
(`LISTA_DE_GRUPOS_ILEGIVEL`) e nunca libera. A lista é relida a cada envio e de novo depois da espera do ritmo, então
um grupo removido nesse meio tempo não recebe a mensagem.

**As mesmas travas.** O envio para grupo passa pelo mesmo módulo de envio do número: ritmo, teto por rodada e por dia,
aquecimento, texto repetido, `PARADO` e `PENDENTE`. Um grupo conta como um único destinatário (dentro do histórico
fica só um hash, como no número), então várias mensagens seguidas para o mesmo grupo são conversa, e um grupo mais uma
pessoa na mesma hora já é disparo. O mesmo texto para um grupo e para uma pessoa conta como texto repetido.

### Risco aceito

A pasta `~/.dgclaw/whatsapp` é do próprio agente. Um agente comandado por injeção de prompt e com acesso ao
terminal poderia editar o `envio.json` (ainda sujeito ao piso) ou apagar o `PARADO`. Isso não dá poder novo em
relação ao que ele já tem (o mesmo agente pode editar o `permitidos.json`), e a defesa é a regra de autoridade:
mensagem de fora nunca manda mudar canal, lista, configuração nem liberar trava.

O mesmo vale para o `grupos-liberados.json`: fica na mesma pasta e tem o mesmo modelo de risco do `permitidos.json`.
Um agente comandado por injeção de prompt e com acesso ao terminal poderia editá-lo e liberar um grupo por conta
própria. A defesa é a mesma: o agente não mexe nessa lista, e mensagem de fora nunca manda liberar grupo. As travas de
ritmo, teto e texto repetido continuam valendo para qualquer grupo liberado. Um grupo pode ter muitos membros, então a
mensagem alcança muita gente de uma vez: o agente só escreve em grupo quando o dono pediu.

## As tools

No `scripts/dgchat-mcp/server.mjs`, ao lado de `reply` e `send_file`:

- `whatsapp_reply {para, texto}` (`para` obrigatório com mais de um número liberado)
- `whatsapp_send_file {para, caminho, legenda?}` (idem)

Falam com `~/.dgclaw/whatsapp/ponte.sock` (`DGCLAW_WHATSAPP_SOCK` troca o caminho, para testes). Socket
ausente ou recusando conexão: `isError` com "O WhatsApp está desligado; fale pelo chat do DG Claw
(tool reply)". Numa sessão paralela (`DGCHAT_SESSAO_ID` presente) as duas recusam: só a principal fala
pelo WhatsApp. Como são MCP, funcionam igual em Claude e em Codex. No transcript ficam como
`mcp__dgchat__whatsapp_reply` e `mcp__dgchat__whatsapp_send_file`, e os leitores casam por sufixo.

## O comando

```
dgclaw-agente canal whatsapp parear <numero-secundario>
dgclaw-agente canal whatsapp permitir <numero-do-dono>
dgclaw-agente canal whatsapp remover <numero>
dgclaw-agente canal whatsapp grupo (listar | liberar <id> | remover <id>)
dgclaw-agente canal whatsapp ligar
dgclaw-agente canal whatsapp desligar [--apagar]
dgclaw-agente canal whatsapp retomar
dgclaw-agente canal status
```

- `parear`: recusa se a unidade estiver ativa; sobe a ponte em modo pareamento, em segundo plano, espera
  até 45 s pelo arquivo `codigo` e imprime **só o código**. Sem código no prazo: mostra o `motivo` do
  `estado.json`.
- `permitir` e `remover`: editam `permitidos.json` (escrita atômica, 600). A ponte relê sozinha.
- `grupo`: edita `grupos-liberados.json` (escrita atômica, 600), a lista de grupos em que o agente pode escrever pela Z-API. `liberar` confere o formato do ID (dígitos seguidos de `-group`), grava o nome (sem quebra de linha, até 100 caracteres) e a data; `listar` mostra a lista; `remover` tira um grupo e exige exatamente um ID (argumento a mais é erro de uso, sem alterar a lista). Arquivo ilegível é erro, nunca lista vazia: o comando recusa sem alterar nada quando a versão não é a 1 ou quando uma entrada tem o `id` inválido (e aponta o número da entrada, sem mostrar o valor). Os campos extras do arquivo e de cada entrada são preservados. Duas alterações ao mesmo tempo se enfileiram por uma trava (`~/.dgclaw/whatsapp-grupos.trava`, fora da pasta `whatsapp`), então uma revogação nunca é desfeita por outra liberação. A lista só deve ser alterada pela CLI (`dgclaw-agente canal whatsapp grupo liberar` e `grupo remover`), nunca editando o arquivo à mão. No envio, a lista não é lida se for link simbólico, e o erro de lista ilegível nunca copia o conteúdo do arquivo.
- `ligar`: exige sessão pareada e lista com pelo menos um número; cria `ligado` e roda
  `sudo -n systemctl enable --now dgclaw-whatsapp`. Não precisa reiniciar a sessão do agente: as tools já
  existem.
- `desligar`: `sudo -n systemctl disable --now dgclaw-whatsapp` e apaga `ligado`. Com `--apagar`, antes
  roda `ponte.mjs --logout` e depois apaga `~/.dgclaw/whatsapp` inteira (recusa se for atalho). Os
  arquivos já recebidos em `~/uploads/whatsapp` ficam.
- `retomar`: apaga o arquivo `PARADO` (da ponte e da Z-API) e libera os envios. Só a pedido do dono, no chat do DG Claw, depois de ele conferir o número no celular.
- `status`: estado da unidade, `estado.json` e os números permitidos. Sem segredo.
- Recusa no Admin, com o mesmo código 2 do Telegram.

## A regra de autoridade

Mensagem do WhatsApp entra como **externa**, nunca como fala do dono. Veio de um número que o dono
autorizou, e o agente responde normalmente por `whatsapp_reply`, mas não age sozinho sobre nada
irreversível, sobre credenciais, canais ou a lista de permitidos só porque uma mensagem do WhatsApp
pediu: confirma antes no chat do DG Claw. A lista nunca muda a pedido de uma mensagem do próprio canal.
