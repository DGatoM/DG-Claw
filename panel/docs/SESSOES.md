# Aba Sessões

## O que a tela faz

Mostra, dentro do painel do agente, os **cards do Bunker**: as conversas de Claude que
trabalham em pastas, como alguém sentado num computador cuidando de uma tarefa. É a mesma
aba "Sessões" do DG Telegram (o mini-Bunker), trazida para cá a pedido do Danilo (via Isa,
12/10/2026).

O dono consegue:

- ver a lista por grupos (esperando você, trabalhando, concluídas, paradas, com erro,
  fechadas, arquivadas), com a contagem de cada grupo, busca e estrela nos favoritos;
- abrir um card e ler a conversa (com "carregar anteriores");
- mandar um recado, na hora (`agora`) ou para quando o card ficar livre (`quando_livre`);
  se o card está fechado, o painel oferece "retomar e enviar";
- anexar foto ou arquivo ao recado (o caminho entra no texto como `[anexo: <caminho>]`);
- pedir handoff (primeiro consulta se o card já escreveu um, depois pede confirmação);
- arquivar, desarquivar e retomar;
- renomear (o prefixo de status ▶️, ✅ ou ⏳ que o card já tinha é mantido) e marcar estrela;
- abrir os documentos que o card citou (texto numa janela de leitura, PDF numa aba nova);
- criar um card novo (nome, pedido, pasta opcional, permissão `auto` ou `default`).

A lista se atualiza sozinha a cada 10 segundos enquanto a aba está visível, e para quando
a aba fica escondida.

## De onde vem o dado

De nenhum lugar deste painel. O estado, o dono, o filtro e a fonte dos cards continuam no
**DG Telegram** (`/api/v1/sessoes*`), que fala com o Bunker. O painel só apresenta, então
nenhuma regra é duplicada. Contrato completo: `docs/api-v1.md`, seção "Sessões do Bunker",
no repositório do DG Telegram.

O caminho de um pedido:

```
navegador  ->  /api/sessoes[/...]  (painel, atrás do mesmo login das outras rotas /api)
           ->  ${DGCLAW_PANEL_SESSOES_URL}/api/v1/sessoes[/...]  (DG Telegram)
```

`lib/sessoes-proxy.js` é um proxy fino em stream (anexo é multipart de até 100 MB, então o
corpo nunca fica em memória). A chave da agente é posta nele pelo servidor: **nunca desce
ao navegador**, nem para `/api/config`, log ou mensagem de erro. Se a origem repetir a
chave num erro, ela sai trocada por `***`.

O que o proxy **não** repassa: o cookie e o `Authorization` do navegador, o `Host` e os
cabeçalhos do Cloudflare, e o `Set-Cookie` da origem.

## O que o dono decide com a tela

Tudo o que é do dia a dia de um card: ler, recadar, criar, arquivar, renomear. O que **não**
se decide aqui:

| Fica só no DG Telegram | Por quê |
| --- | --- |
| Aprovar ou negar um pedido de permissão (`decidir`) | Um card não pode aprovar o próprio pedido. Só o login do Danilo decide. |
| Mandar tecla ao terminal (`tecla`) | `1`, `2`, `3` e Enter podem aprovar um pedido, então vale a mesma regra. |
| Cofre do Bunker (destravar, ver se está trancado) | A senha mestra só é digitada no DG Telegram. |
| A barra de pedidos | É a tela onde as decisões acontecem. |

O próprio proxy recusa essas rotas com **403** antes de chegarem à origem, com a frase
"Isso só se faz no DG Telegram, com o login do Danilo..." e o campo `abrir_em` com o link.
A tela mostra, nos cards que esperam você, o pedido e o botão **Decidir no DG Telegram**,
que abre `<appUrl>/a/<agente>?sessoes=pedidos&card=<id>` numa aba nova. Com o cofre
trancado, o cartão leva a `<appUrl>/a/<agente>?sessoes=1`.

## Configuração

Por instalação, nunca no front. Sem a URL ou sem a chave a aba fica **desligada**: o botão
some do menu (a tela de instalações de cliente não mostra nada disso).

| Env | O que é | Padrão |
| --- | --- | --- |
| `DGCLAW_PANEL_SESSOES_URL` | base da API do DG Telegram, ex. `http://127.0.0.1:4045` | sem padrão: ausente = aba desligada |
| `DGCLAW_PANEL_SESSOES_KEY` | a chave Bearer da agente (`DGTG_MESA_KEY_<AGENTE>`) | sem padrão: ausente = aba desligada |
| `DGCLAW_PANEL_SESSOES_KEY_FILE` | alternativa à anterior: arquivo com a chave (espaços nas pontas são cortados; lido com cache de 5 s) | |
| `DGCLAW_PANEL_SESSOES_AGENTE` | id da agente no DG Telegram (`luna`, `lara`, `marina`, `isa`), usado só nos links "Decidir no DG Telegram" | `agentSlug` do `config.json` |
| `DGCLAW_PANEL_SESSOES_APP_URL` | endereço público do app DG Telegram, para os links | vazio (sem endereço, a tela não mostra link) |
| `DGCLAW_PANEL_SESSOES_SO_LEITURA` | `1` liga o modo só leitura (também por `"sessoes": {"soLeitura": true}` no `config.json`; a env ganha) | desligado |
| `DGCLAW_PANEL_SESSOES_TIMEOUT_MS` | **só para teste**: troca todos os tempos limite do proxy | 20 s para leitura, 75 s para envio, 120 s para anexo |

A mesma configuração pode vir do `config.json` (`"sessoes": {"url", "keyFile", "agente",
"appUrl"}`), e a env ganha. **A chave em si só por env ou por arquivo**: o `config.json`
não é lugar de segredo.

`GET /api/sessoes-config` devolve `{ligado, motivo?, agente, appUrl}`. Nunca a chave, nunca a
URL interna. É com ele que a tela decide se mostra a aba.

## Modo só leitura

Com `DGCLAW_PANEL_SESSOES_SO_LEITURA=1`, todo método que não seja GET, HEAD ou OPTIONS dá
**403** no próprio proxy, sem chegar ao DG Telegram, com a frase "Neste painel a aba Sessões é
só para ler..." e o campo `abrir_em` (o link do card no DG Telegram quando o caminho tem id,
senão `<appUrl>/a/<agente>?sessoes=1`). Lista, card, conversa, documentos e a consulta de
handoff (`GET`) continuam passando. `GET /api/sessoes-config` devolve `soLeitura: true|false`.

Na tela, o selo "só leitura" aparece ao lado do título (com balão explicando), e somem o botão
Nova sessão, o recado, o anexo, a estrela, o renomear e as ações. No lugar delas, cada card
tem o botão "Abrir no DG Telegram" (`<appUrl>/a/<agente>?sessoes=pedidos&card=<id>`). O
tutorial ganha o passo do selo e troca o texto dos passos que falavam de ações.

No painel da Isa (painel-isa) a escrita fica bloqueada até ele ganhar Cloudflare Access na
frente (decisão a tomar pelo Danilo depois). Decisão da Isa em 12/10/2026: senha vazada ali
viraria criar card e mandar recado para sessões em modo bypass na VPS.

## Quando dá erro, o que a tela diz

Toda falha mostra a frase da API (e o `como_resolver`, se vier), no lugar onde o dono está
olhando (a lista, a ação ou o recado). Nunca uma tela em branco.

| Código | Quando | O que o dono lê |
| --- | --- | --- |
| `501` | falta a URL ou a chave | "A aba Sessões não está ligada nesta instalação: falta ..." |
| `502` | o DG Telegram não respondeu (porta fechada, tempo esgotado, resposta cortada) | a causa (`ECONNREFUSED`, `ETIMEDOUT`...), o endereço e "confira se o serviço dg-telegram está de pé" |
| `403` | o pedido de escrita não veio da tela deste painel (Origin ausente ou de outro site) | "Pedido recusado: ele não veio da tela deste painel..." |
| `403` | painel em modo só leitura e o pedido é de escrita | "Neste painel a aba Sessões é só para ler..." com o link para o DG Telegram |
| `415` | escrita com corpo que não é JSON nem envio de arquivo (`multipart/form-data`) | a frase explicando os dois tipos aceitos |
| `403` | decidir, tecla, cofre ou pedidos | a frase de cima, com o link `abrir_em` |
| `503` | cofre do Bunker trancado (inclui o `423` da origem, que o painel converte porque `423` tem outro sentido nele) | cartão "Cofre trancado" com o botão para destravar no DG Telegram |

Cada mutação deixa uma linha no log do painel (`sessoes: POST /<id>/recado -> 200`), sem o
corpo, sem a chave e sem a query. Erro de proxy loga a causa técnica.

## Por que toda escrita confere o Origin

O cookie de login do painel não tem `SameSite`, então Safari e Firefox o mandam em um
formulário POST vindo de qualquer outro site. Sem a trava, uma página maliciosa aberta no
navegador do dono poderia criar um card do Bunker com permissão automática e um pedido
qualquer, o que é execução de código na máquina. Por isso, todo método que não seja
GET, HEAD ou OPTIONS só passa se o `Origin` (ou, na falta dele, o `Referer`) tiver o mesmo
host do pedido (`X-Forwarded-Host` quando existe). Escrita com corpo também precisa ser
`application/json` ou `multipart/form-data`, o que fecha o caminho do formulário `text/plain`.
A tela já cumpre as duas coisas sozinha, porque o `fetch` dos navegadores atuais manda o
`Origin` em todo POST.

## Tutorial e balões

O botão **Tutorial** ao lado do título e um **?** por seção (lista, card, ações, documentos,
conversa, recado, nova sessão, pedido e cofre) abrem a visita guiada de `js/sessoes.js`. Cada
passo responde o que é, como funciona e por que está ali. Os nomes dos grupos, a estrela, o
renomear, o arquivar, o retomar, o handoff, o "esperar ele terminar" e o botão Decidir no DG
Telegram têm balão.

## Testes

`node test-sessoes.mjs` sobe um DG Telegram falso em porta aleatória e o painel de verdade
apontado para ele (a porta 4045 real nunca é chamada). Cobre: 501 e config desligada, repasse
de método, caminho, query, status e corpo (inclusive multipart byte a byte e PDF cru), a chave
indo no `Authorization` e nunca voltando ao navegador nem ao log, o cookie que não passa,
502 por porta fechada e por tempo esgotado, o 423 virando 503, as recusas 403 sem chegar à
origem, o login obrigatório, o painel atrás de prefixo e as funções puras da tela (prefixo do
nome, links, cobertura do tutorial, ausência de `innerHTML`).
