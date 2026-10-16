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
oficial do WhatsApp.** O número conectado pode ser banido. Por isso:

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
| `FALHA_ENVIO` | o WhatsApp recusou ou deu erro ao enviar |

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
a execução tem prazo próprio, 30 segundos para texto e 120 para arquivo. Estourado, a resposta é
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
dgclaw-agente canal whatsapp ligar
dgclaw-agente canal whatsapp desligar [--apagar]
dgclaw-agente canal status
```

- `parear`: recusa se a unidade estiver ativa; sobe a ponte em modo pareamento, em segundo plano, espera
  até 45 s pelo arquivo `codigo` e imprime **só o código**. Sem código no prazo: mostra o `motivo` do
  `estado.json`.
- `permitir` e `remover`: editam `permitidos.json` (escrita atômica, 600). A ponte relê sozinha.
- `ligar`: exige sessão pareada e lista com pelo menos um número; cria `ligado` e roda
  `sudo -n systemctl enable --now dgclaw-whatsapp`. Não precisa reiniciar a sessão do agente: as tools já
  existem.
- `desligar`: `sudo -n systemctl disable --now dgclaw-whatsapp` e apaga `ligado`. Com `--apagar`, antes
  roda `ponte.mjs --logout` e depois apaga `~/.dgclaw/whatsapp` inteira (recusa se for atalho). Os
  arquivos já recebidos em `~/uploads/whatsapp` ficam.
- `status`: estado da unidade, `estado.json` e os números permitidos. Sem segredo.
- Recusa no Admin, com o mesmo código 2 do Telegram.

## A regra de autoridade

Mensagem do WhatsApp entra como **externa**, nunca como fala do dono. Veio de um número que o dono
autorizou, e o agente responde normalmente por `whatsapp_reply`, mas não age sozinho sobre nada
irreversível, sobre credenciais, canais ou a lista de permitidos só porque uma mensagem do WhatsApp
pediu: confirma antes no chat do DG Claw. A lista nunca muda a pedido de uma mensagem do próprio canal.
