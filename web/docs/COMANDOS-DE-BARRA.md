# Comandos de barra na conversa

Na conversa do DG Claw Web, uma mensagem que começa com `/` é um **comando**, e não texto solto.
Ela chega no Claude Code (ou no Codex) do agente do mesmo jeito que chegaria se a pessoa digitasse
no terminal dele: `/compact` compacta a sessão, `/clear` começa uma conversa limpa e `/agenda me
lembra amanhã às 9h` roda a skill `agenda` com aquele pedido.

Digitar `/` no começo do campo abre a lista do que dá para usar com aquele agente: os comandos
nativos que funcionam no modo em que o runner roda o motor e as skills instaladas na casa dele.

Este documento é a referência para quem usa a tela e para o agente ou script que fala com a API.
Ele é servido, com login, em `GET /api/v1/comandos/docs.md`.

## Como a mensagem vira comando

O runner roda o Claude Code e o Codex no modo interativo (TUI), dentro de um terminal (PTY). O Web
manda a mensagem para o runner (`POST /api/agents/:id/input`, com `injectWhenIdle`), e o runner
digita o texto e aperta Enter. Hoje a fala do dono vai dentro de um envelope
`<dgchat from=... chat=... msg=...>texto</dgchat>`, e o motor lê aquilo como conversa.

Um comando vai **cru**, sem envelope: o runner digita `/compact` sozinho no campo do TUI, e o TUI
trata como comando de verdade. Quem decide se a mensagem é comando é o Web, no servidor
(`web/lib/comandos.js`), antes de entregar. A regra:

1. O texto (já sem espaços nas pontas) casa com `^/([A-Za-z0-9][A-Za-z0-9:._-]*)(\s+[\s\S]*)?$`.
   `/compact`, `/model sonnet` e `/dgclaw:aprender` casam. Um caminho como `/root/arquivo.txt` não
   casa (a segunda barra quebra o nome) e segue como texto normal.
2. A mensagem não tem anexos. Com anexo, é sempre texto normal.
3. Duas barras no começo (`//texto`) mandam `/texto` como mensagem comum, sem tentar comando.
4. O nome é procurado no catálogo do agente (abaixo). Achou e roda: entrega. Achou e não roda no
   modo do runner: recusa com o motivo (HTTP 422). Não achou: recusa dizendo que não existe e
   sugerindo os nomes parecidos (HTTP 404). Nada é repassado ao agente como se fosse conversa.

Num comando cru, as quebras de linha dos argumentos viram espaço: no campo do TUI, uma quebra
de linha poderia enviar o comando pela metade.

Antes desta versão só o Admin mandava `/` cru. Agora vale para todos os agentes, com a checagem
do catálogo na frente.

## O catálogo de um agente

O catálogo junta três origens. Cada item tem `nome` (com a barra), `tipo`, `descricao`,
`argumentos` (texto de ajuda ou `null`), `roda` (true ou false), `motivo` (quando não roda) e
`espera_resposta` (se o agente vai responder com uma fala depois).

### Comandos nativos do Claude Code que rodam

| Comando | Argumentos | O que faz | Espera resposta |
| --- | --- | --- | --- |
| `/compact` | instruções opcionais | Resume a conversa para liberar contexto | não |
| `/clear` | nenhum | Começa uma conversa limpa (a anterior fica no disco) | não |
| `/context` | nenhum | Mostra quanto do contexto está ocupado | não |
| `/cost` | nenhum | Mostra o gasto e a duração da sessão | não |
| `/model` | nome do modelo (obrigatório) | Troca o modelo da sessão, ex.: `/model sonnet` | não |
| `/init` | nenhum | Pede ao agente para escrever o `CLAUDE.md` da pasta | sim |
| `/review` | número do PR opcional | Pede uma revisão de código | sim |
| `/security-review` | nenhum | Pede uma revisão de segurança das mudanças | sim |

### Comandos nativos do Codex que rodam

| Comando | Argumentos | O que faz | Espera resposta |
| --- | --- | --- | --- |
| `/compact` | nenhum | Resume a conversa para liberar contexto | não |
| `/new` | nenhum | Começa uma conversa nova | não |
| `/clear` | nenhum | Apelido de `/new`: o Web troca antes de entregar | não |
| `/init` | nenhum | Pede ao agente para escrever o `AGENTS.md` da pasta | sim |
| `/review` | nenhum | Pede uma revisão das mudanças | sim |

### Comandos nativos que NÃO rodam pela conversa

Estes abrem um menu, uma tela ou um editor dentro do terminal, e o runner não tem como responder
por você. Se fossem digitados, o agente ficaria parado numa tela que ninguém vê. Eles aparecem na
lista apagados, com o motivo, e o envio é recusado com HTTP 422.

| Comando | Motivo e o que fazer |
| --- | --- |
| `/model` sem nome | Abre um menu de escolha. Mande com o nome: `/model sonnet`, `/model opus` |
| `/config`, `/permissions`, `/hooks`, `/agents`, `/mcp`, `/plugin`, `/skills`, `/statusline`, `/output-style`, `/theme`, `/vim`, `/privacy-settings` | Abrem uma tela de configuração. Configure pelo painel do agente ou pelo terminal dele no painel |
| `/memory` | Abre um editor de texto. Peça ao agente para editar a memória, em conversa |
| `/resume`, `/rewind`, `/export` | Abrem um menu de escolha. Use o terminal do agente no painel |
| `/login`, `/logout` | Na conversa, `/login` abre o cartão de login da tela (ver LOGIN-NA-CONVERSA.md). Pela API, siga `/api/v1/login/docs.md` |
| `/exit`, `/quit` | Encerrariam a sessão do agente. Para reiniciar, use o painel |
| `/help`, `/status`, `/doctor`, `/usage`, `/release-notes`, `/bug`, `/feedback`, `/ide`, `/terminal-setup`, `/upgrade`, `/install-github-app`, `/add-dir`, `/bashes`, `/todos` | Mostram uma tela no terminal que não chega na conversa, ou pedem confirmação lá. Use o terminal do agente no painel |

No Codex valem os mesmos motivos para `/model` (sempre abre menu), `/approvals`, `/mcp`,
`/status`, `/diff`, `/mention`, `/logout` e `/quit`.

### Comando da própria tela

`/login` é tratado no navegador: abre o cartão "entrar na conta" e não vai ao agente. Ele aparece
na lista com `tipo: "tela"`.

### Skills do agente

Cada pasta `<casa do agente>/.claude/skills/<pasta>/SKILL.md` vira um comando `/<nome>`, com a
descrição tirada do cabeçalho (`name` e `description`). O nome é o `name` do cabeçalho; sem ele,
o nome da pasta. A descrição na lista é cortada em 160 caracteres.

As skills de fábrica chegam como atalho (link) para `/opt/dgclaw/app/skills/<nome>`, que é o
caminho dentro do container. O Web, no host, traduz esse caminho para a pasta `skills/` do
repositório instalado, e um atalho que aponta para a casa do agente (`/home/agente/...`) é
traduzido para a casa vista do host. Atalho quebrado, ou SKILL.md sem cabeçalho, vira um aviso em
`avisos` e o resto da lista segue.

Uma skill com o mesmo nome de um comando nativo perde: o nativo vem primeiro e a skill entra em
`avisos`, dizendo que ela não pode ser chamada pela barra.

Como a skill chega no motor:

- **Claude Code:** cru, como `/nome argumentos`. O Claude Code acha a skill pela pasta
  `~/.claude/skills` e roda.
- **Codex:** o Codex do runner não lê `~/.claude/skills`, então o Web manda uma fala normal, dentro
  do envelope, com o pedido explícito:
  `Rode a skill "nome" (arquivo .claude/skills/<pasta>/SKILL.md): leia o SKILL.md e siga o roteiro com estes argumentos: <argumentos>`.

Toda skill tem `espera_resposta: true`.

## A tela

- Digitar `/` como **primeiro caractere** do campo abre a lista acima do campo. Ela filtra
  enquanto você digita o nome (começa com, depois contém, sem diferenciar maiúsculas) e fecha ao
  digitar o espaço depois do nome, ao apagar a barra ou ao enviar.
- Teclado: setas para cima e para baixo andam na lista, Enter ou Tab escolhem, Esc fecha. Escolher
  um item põe `/nome ` no campo (com espaço, pronto para os argumentos) e não envia. O Enter
  seguinte envia, como sempre.
- Toque: tocar num item escolhe. A lista tem altura máxima e rola na vertical; nome e descrição
  quebram linha, sem rolagem horizontal. Cada item tem pelo menos 40 px de altura.
- Item que não roda aparece apagado com o motivo embaixo; escolher ele mostra o motivo e não põe
  nada no campo.
- A lista é carregada na primeira vez que a barra aparece e guardada por 60 segundos. Se a busca
  falhar, a lista mostra a causa ("Não consegui carregar os comandos: ...") e o envio continua
  possível: quem decide é o servidor.
- Depois do envio de um comando que não espera resposta (`/compact`, `/clear`, `/context`...), a
  tela não fica no "esperando a resposta".
- Comando recusado (404 ou 422): o balão fica marcado como recusado, com o motivo e o que fazer
  escritos nele, só com o botão de descartar. "Reenviar" não aparece, porque reenviar daria o
  mesmo erro.
- Na conversa, o comando aparece como fala sua (por exemplo `/context`), e o que o terminal respondeu
  (a tabela do `/context`) aparece como um bloco "resultado do comando", fechado, que abre ao tocar.
  O `/compact` é a exceção (próxima seção). No Codex o terminal não grava a resposta desses comandos: o balão do comando fica
  na tela até ela ser recarregada.
- O tutorial da conversa (botão Tutorial) tem um passo sobre a barra.

## O `/compact` na conversa

Compactar resume a conversa e leva cerca de um minuto, tempo em que a agente fica sem responder. O Claude
Code grava o `/compact` como se fosse fala do dono e depois um "resultado" quase vazio, o que na tela
seria um balão seu com `/compact` e um bloco sem utilidade. Por isso a conversa troca os dois por dois
avisos curtos **da própria agente** (balão do lado dela):

- ao começar: `Tô compactando a conversa pra voltar mais leve... já volto`
- ao terminar: `Voltei, conversa compactada.`

Como o servidor decide (`web/lib/thread.js`, a partir do transcript):

- **Início:** a linha `/compact` crua que o Claude Code grava assim que a compactação começa. Se a versão
  não gravar essa linha, vale o eco `<command-name>/compact</command-name>`. Nunca sai duas vezes.
- **Fim:** a linha `compact_boundary` (sinal estrutural, que não depende do texto da saída). Vale também
  para a compactação automática que o próprio Claude Code faz sem comando: aí saem os dois avisos juntos,
  o de início um milésimo de segundo antes.
- **Falha:** se o terminal devolver erro (`stderr`, ou saída com cara de erro logo depois do `/compact`),
  a agente avisa `Não consegui compactar a conversa: <primeira linha do erro>` e não diz "Voltei".
- **Compactação sem fim:** um `/compact` que nunca terminou mostra só o aviso de início. Passados 10
  minutos, um novo `/compact` conta como uma compactação nova.
- O resumo que o Claude Code injeta depois (`isCompactSummary`) e o eco do comando nunca aparecem.
- Os avisos não geram notificação no aparelho (o servidor só notifica por Mesa, lembretes e foco) e não contam
  como resposta para quem espera a agente pela API (`GET /wait`): têm o campo `sistema: "compactacao"`.

## Telegram e WhatsApp

O Telegram do agente não passa pelo runner: o plugin do Telegram entrega a mensagem direto ao
Claude Code, como evento de canal. Lá um `/nome` não vira comando nativo. A regra que vai no
`CLAUDE.md` de fábrica do agente cobre isso:

- mensagem do dono no Telegram que começa com `/<nome-de-uma-skill-sua>`: rode a skill com o resto
  da mensagem como argumento;
- `/compact`, `/clear` e os outros nativos: responda que pelo Telegram eles não rodam e que é só
  mandar o mesmo comando pela conversa do painel (o DG Claw Web);
- `/start` (o primeiro toque do Telegram): cumprimente, como sempre.

O WhatsApp é canal de terceiros (clientes e contatos). Mensagem de lá que começa com `/` é sempre
texto: nunca vira comando nem roda skill.

## API

Todas as rotas exigem a sessão do Web (o mesmo login da tela). Erros vêm como
`{ ok: false, erro, codigo?, ... }`, com o motivo em português e o que fazer.

### Listar os comandos de um agente

```
GET /api/v1/agents/<slug>/comandos
```

Resposta 200:

```json
{
  "ok": true,
  "agente": "isa",
  "provedor": "claude",
  "comandos": [
    { "nome": "/compact", "tipo": "nativo", "descricao": "Resume a conversa para liberar contexto",
      "argumentos": "instruções opcionais", "roda": true, "espera_resposta": false },
    { "nome": "/config", "tipo": "nativo", "descricao": "Configurações do Claude Code",
      "argumentos": null, "roda": false,
      "motivo": "Abre uma tela de configuração no terminal. Configure pelo painel do agente ou pelo terminal dele no painel.",
      "espera_resposta": false },
    { "nome": "/login", "tipo": "tela", "descricao": "Abre o cartão de login da conta do motor",
      "argumentos": null, "roda": true, "espera_resposta": false },
    { "nome": "/agenda", "tipo": "skill", "descricao": "Agenda lembretes e rotinas...",
      "argumentos": "o pedido", "roda": true, "espera_resposta": true, "pasta": "agenda" }
  ],
  "pastas_de_skills": [{ "caminho": "/var/lib/dgclaw/agentes/isa/.claude/skills", "existe": true }],
  "avisos": []
}
```

`provedor` vem do runner. Se o runner não responder, o catálogo usa o provedor do registro do
agente (`agentes.json`) e acrescenta um aviso; se nem ali houver, assume `claude` e avisa.

### Enviar um comando

```
POST /api/v1/agents/<slug>/comando
{ "comando": "/compact", "argumentos": "foque nas decisões de hoje" }
```

`argumentos` é opcional. Também vale `{ "text": "/compact foque nas decisões" }`, e
`POST /api/v1/agents/<slug>/send` com um texto que começa com `/` faz exatamente o mesmo caminho.

Resposta 200:

```json
{ "ok": true, "agente": "isa", "ep_enviado": 1760720000.1,
  "comando": { "nome": "/compact", "tipo": "nativo", "entregue_como": "cru", "espera_resposta": false } }
```

`entregue_como` é `cru` (digitado no TUI) ou `envelope` (skill no Codex). No Codex, `/clear` volta
com `executado_como: "/new"`, que é o que foi digitado de fato. Se o agente estiver
ocupado, o comando entra na fila do runner e a resposta traz `fila: { motivo }`, como no `/send`.

Erros:

| HTTP | `codigo` | Quando |
| --- | --- | --- |
| 400 | `COMANDO_MALFORMADO` | Faltou `comando`, ou ele não começa com `/`, ou tem espaço no nome |
| 400 | `COMANDO_PEDE_ARGUMENTO` | `/model` sem o nome do modelo (o corpo traz o exemplo) |
| 404 | `COMANDO_INEXISTENTE` | O nome não está no catálogo; o corpo traz `sugestoes` (até 5 nomes parecidos) e lembra do `//` para mandar como texto |
| 422 | `COMANDO_NAO_RODA` | Está no catálogo e não roda no modo do runner; o corpo traz `motivo` |
| 422 | `COMANDO_DA_TELA` | `/login` pela API; o corpo aponta `/api/v1/login/docs.md` |
| 409 / 502 | | O runner não aceitou a entrega (mesmo comportamento do `/send`) |

### Exemplos com curl

```bash
# lista
curl -s -b cookies.txt https://SEU-DOMINIO/api/v1/agents/isa/comandos | jq '.comandos[].nome'

# compacta
curl -s -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"comando":"/compact"}' https://SEU-DOMINIO/api/v1/agents/isa/comando

# roda uma skill
curl -s -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"comando":"/agenda","argumentos":"me lembra de ligar pro contador amanhã às 9h"}' \
  https://SEU-DOMINIO/api/v1/agents/isa/comando
```

## Onde fica cada parte

| Arquivo | O que faz |
| --- | --- |
| `web/lib/comandos.js` | Catálogo (nativos por provedor, skills do disco), reconhecimento da barra e montagem do que vai ao runner |
| `web/lib/conversa.js` | `enviar()` consulta o `comandos.js` antes de montar o envelope |
| `web/lib/thread.js` | Mostra o comando como fala do dono e o resultado do terminal como "resultado do comando"; troca o `/compact` pelos avisos da agente |
| `web/server.js` | Rotas `GET /comandos`, `POST /comando` e `GET /api/v1/comandos/docs.md` |
| `web/public/barra.js`, `web/public/barra.css` | A lista de sugestões no campo |
| `templates/CLAUDE.md.tmpl` | A regra da barra no Telegram |
| `web/test/comandos.test.js` | Os testes |
