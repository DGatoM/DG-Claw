# Modo foco

O modo foco é uma lista curta do que o dono quer fechar agora, pendurada ao lado da conversa
com cada agente. **O agente monta a lista; o dono tica na tela.** É por agente: a lista da
Ana aparece na conversa da Ana, a do Bruno na do Bruno.

Quando o dono pedir algo como "monta meu foco de hoje", o agente grava a lista pela API. Ela
aparece sozinha na tela (evento `foco` do stream da conversa). Cada vez que o dono tica ou
destica, o Web grava um evento, e o agente fica sabendo de dois jeitos:

1. **Sozinho, na próxima mensagem do dono** (agentes Claude): o gancho `foco-hook` acrescenta
   ao contexto do turno o que o dono marcou desde a última vez, com o placar ("3 de 6").
2. **Quando quiser conferir** (Claude e Codex): lendo os eventos pela API, com um cursor.

Funciona sem DG Telegram, sem Bunker e sem serviço externo: tudo fica no Web desta VPS.

## Na tela

- No computador, quando sobra espaço à esquerda da coluna da conversa, o painel fica
  pendurado ali, com barra de progresso, contador ("3 de 6") e botão de recolher.
- Sem espaço (celular, janela estreita) ele vira uma faixa recolhida no topo da conversa
  ("🎯 Foco · 3 de 6"). Tocar na faixa abre a lista; tocar de novo recolhe.
- Lista sem itens não aparece.
- Tocar num item tica ou destica na hora. Se a gravação falhar, o item volta ao estado
  anterior e a tela diz o motivo.
- O botão `?` do painel abre a visita guiada do foco; o Tutorial da página também passa por ele.
- Recolhido ou aberto fica guardado no aparelho.

## A lista

```json
{"ok": true, "lista": {
  "agente": "ana", "titulo": "Foco de hoje",
  "itens": [
    {"id": 41, "texto": "Revisar o contrato da Vitória", "feito": true,
     "feito_em": "2026-10-16T10:12:03-03:00", "feito_por": "dono", "ordem": 1},
    {"id": 42, "texto": "Ligar pro Fernando", "feito": false,
     "feito_em": null, "feito_por": null, "ordem": 2}
  ],
  "feitos": 1, "total": 2, "versao": 4, "atualizada_em": "2026-10-16T10:12:03-03:00"}}
```

- `texto`: de 1 a 300 caracteres (espaços repetidos viram um só, pontas aparadas).
- `titulo`: até 80 caracteres; o padrão é "Modo foco".
- No máximo 50 itens por lista.
- `id` do item nunca se repete dentro da lista do agente, nem depois de apagar.
- `versao` sobe a cada mudança. A tela ignora uma lista mais velha que a que já mostra.
- `feito_por`: o usuário do login quando o tique veio da tela; `"agente"` quando veio do
  próprio agente pela caixa (`dgclaw-api`).
- `feito_em` e `atualizada_em` saem no fuso da instalação, com o deslocamento.
- Lista que nunca existiu volta com `itens: []`, `versao: 0` e `atualizada_em: null`.

## Rotas

Todas pedem login (a mesma sessão da conversa) ou vêm do agente pela caixa (`dgclaw-api`).
Escritas com sessão exigem o `Origin` aceito pelo Web, como as outras rotas.

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/foco/docs.md` | este documento |
| `GET /api/v1/foco/<agente>` | a lista |
| `PUT /api/v1/foco/<agente>` | cria ou substitui a lista inteira |
| `POST /api/v1/foco/<agente>/itens` | acrescenta um item no fim (201) |
| `PATCH /api/v1/foco/<agente>/itens/<id>` | tica, destica e/ou troca o texto |
| `DELETE /api/v1/foco/<agente>/itens/<id>` | apaga um item |
| `DELETE /api/v1/foco/<agente>[?versao=N]` | limpa a lista (o título volta ao padrão). Com `versao`, só limpa se a lista ainda estiver nessa versão; senão responde 409 com a `lista` atual e não apaga nada |
| `GET /api/v1/foco/<agente>/eventos?desde_id=N` | o que mudou, em ordem crescente de id |

Toda resposta de sucesso é `{"ok": true, ...}` e traz a `lista` já atualizada (a de eventos
traz `eventos`, `ultimo_id` e `tem_mais`).

**Quem pode mexer em qual lista.** Com login, o dono mexe em qualquer agente do registro.
Pela caixa, o agente só mexe na **própria** lista: pedir a de outro devolve 403 dizendo de
qual agente veio o pedido. Pela caixa, `<agente>` pode ser `eu`, que quer dizer o próprio
agente que chamou (com login, `eu` volta 400 pedindo o id do agente).

### Pelo agente, dentro do container

O agente não alcança o Web por HTTP. Ele usa o `dgclaw-api`, que entrega o pedido ao Web pela
caixa de arquivos da casa dele e devolve a resposta (veja [a caixa do agente](../../docs/CAIXA-DO-AGENTE.md)).
A rota e o corpo são os mesmos da tabela. Saída 0 é sucesso; 4 é pedido errado (leia o `erro`
no stderr); 2 é o Web fora do ar.

**Montar o foco de hoje.** Cada item aceita texto puro ou `{"texto", "feito"?}`. Sem `titulo`,
mantém o que a lista já tinha.

```bash
dgclaw-api PUT /api/v1/foco/eu \
  '{"titulo": "Foco de hoje", "itens": ["Revisar o contrato da Vitória", {"texto": "Ligar pro Fernando"}, {"texto": "Pagar o boleto", "feito": true}]}'
```

**Acrescentar um item no meio do dia:**

```bash
dgclaw-api POST /api/v1/foco/eu/itens '{"texto": "Mandar a proposta pra Carla"}'
```

**Ticar, desticar ou corrigir o texto** (`mudou: false` quando já estava assim, sem evento novo):

```bash
dgclaw-api PATCH /api/v1/foco/eu/itens/42 '{"feito": true}'
```

**Apagar um item e limpar a lista:**

```bash
dgclaw-api DELETE /api/v1/foco/eu/itens/42
dgclaw-api DELETE /api/v1/foco/eu
```

### Com login (navegador, outro programa com a sessão)

```bash
curl -sS -b "$COOKIE" -H "Origin: https://SEU-DOMINIO" -H "Content-Type: application/json" \
  -X PATCH "https://SEU-DOMINIO/api/v1/foco/ana/itens/42" -d '{"feito": true}'
```

## Como o agente fica sabendo dos tiques

Os tiques do dono **não viram mensagem na conversa**. Há dois caminhos, e os dois leem o mesmo
histórico.

**1. O gancho (agentes Claude).** Antes de cada turno, o `foco-hook` olha o retrato da lista
na casa do agente. Se o dono marcou algo desde a última vez, o turno começa com um bloco como:

```text
🎯 Modo foco (marcado pelo dono na tela desde a sua última mensagem):
- ticou: Ligar pro Fernando
- desticou: Pagar o boleto
Placar: 2 de 3. Faltam: Pagar o boleto.
```

Sem novidade, o gancho não acrescenta nada. Se algo der errado ao ler o retrato, ele fica
calado no turno e anota o motivo em `~/.dgclaw/logs/foco-hook.log`.

**2. A leitura com cursor (Claude e Codex).**

```bash
dgclaw-api GET "/api/v1/foco/eu/eventos?desde_id=0"
```

```json
{"ok": true, "ultimo_id": 9, "tem_mais": false, "eventos": [
  {"id": 8, "agente": "ana", "item_id": 42, "tipo": "ticou",
   "texto": "Ligar pro Fernando", "por": "dono", "em": "2026-10-16T10:12:03-03:00"}]}
```

- `tipo`: `ticou`, `desticou`, `editou`, `criou`, `apagou`, `substituiu` (o `PUT`) ou `limpou`.
- `por`: o usuário do login, ou `"agente"`.
- Guarde o `ultimo_id` e mande na próxima leitura como `desde_id`. Sem evento novo, ele volta
  igual ao que você mandou. Sem `desde_id`, a leitura começa do primeiro evento guardado.
- Devolve até 200 por vez; `tem_mais: true` diz que ainda há eventos depois do `ultimo_id`.
- O Web guarda os últimos 1000 eventos de cada agente.
- Boa hora para ler: antes de perguntar ao dono "já fez X?". Se o item está ticado, a pergunta
  é desnecessária.

**O retrato.** A cada mudança, o Web regrava `~/.dgclaw/retratos/foco.json` na casa do agente
(no host: `<home_host>/.dgclaw/retratos/foco.json`), com `{"lista": {...}, "eventos": [...], "ultimo_id": N, "atualizado_em": "..."}`
(os últimos 50 eventos). O agente pode ler esse arquivo direto, sem passar pela caixa. Ele é
só uma cópia de leitura: o que vale é o que está no Web, e editar o retrato não muda a
lista. O gancho guarda o próprio cursor em `~/.dgclaw/foco-hook-cursor.json`.

## Erros

Sempre `{"ok": false, "erro": "..."}` com o motivo em português e o que fazer:

| Status | Quando |
| --- | --- |
| 400 | corpo que não é objeto JSON, `itens` que não é lista, mais de 50 itens, texto vazio ou com mais de 300 caracteres, título com mais de 80, `feito` que não é booleano, campo desconhecido, `desde_id` que não é inteiro maior ou igual a zero, id de item que não é número |
| 401 | sem login |
| 403 | pedido de um agente (pela caixa) para a lista de outro agente |
| 404 | agente que não está no registro, ou item que não existe nesta lista (o `erro` diz como listar os ids) |
| 405 | método que a rota não aceita (o `erro` lista os aceitos) |
| 503 | o arquivo da lista não pôde ser lido ou gravado (o `erro` diz o caminho e o motivo) |

Uma falha ao regravar o retrato na casa do agente **não** desfaz a mudança: a lista fica
gravada no Web, a resposta sai normal e o motivo vai para o log do Web. A próxima mudança
tenta regravar o retrato de novo.

## Evento `foco` no stream

Vem no `GET /api/v1/agents/<agente>/stream`: `{"agente": "ana", "lista": {...}}`, no formato
acima. Uma vez ao conectar e depois a cada mudança da lista daquele agente. Se o arquivo da
lista não pôde ser lido, vem `{"agente", "lista": null, "erro"}` e a tela mostra o motivo.

## Aviso no celular

Quando o **agente** monta ou substitui a lista (`PUT`), o Web manda um aviso pelo web push
(se o dono ativou as notificações neste aparelho): "🎯 <Agente> montou seu foco: N itens".
Tique, item novo e apagar não avisam, para não virar barulho.

## Estado e distribuição

- A lista e os eventos ficam em `<DGCLAW_WEB_DATA>/foco/<agente>.json`, gravado por
  substituição atômica com modo 0600. Arquivo inválido gera erro explícito (503); nunca é
  trocado em silêncio por uma lista vazia. Preserve esta pasta em backups e atualizações.
- O retrato na casa do agente é gravado por `caixa.gravaRetrato` (escrita segura do Web:
  nada de seguir atalho, dono e modo conferidos).
- O gancho é registrado no `promptHooks` do `runner.json` do agente (`dgclaw agente criar`
  e `dgclaw agente reparar` escrevem). Agentes Codex não usam `promptHooks`: para eles vale a
  leitura com cursor.
- A skill de fábrica `foco` ensina o agente a usar; a regra curta está no `CLAUDE.md` e no
  `AGENTS.md` do agente.
