# Modo roteiro

Pedido do Danilo (áudios de 23/10/2026, 22h45 e 22h47): quando ele ajusta um roteiro com o agente
pela conversa, cada versão nova vira mais um visual no meio das mensagens. Para saber o que mudou,
ele precisa achar o último, abrir e reler tudo. O modo roteiro deixa o roteiro **parado num lugar
só** e usa a conversa apenas para pedir os ajustes.

## O que a pessoa vê

**Celular.** O roteiro ocupa a parte de cima da tela (uns 70%), rola sozinho e não sai do lugar.
Embaixo fica uma faixa fina com a última resposta do agente em uma linha e, logo abaixo, o campo de
digitar de sempre (o microfone continua lá, mas o uso principal é ler e digitar). Tocar na faixa, ou
puxá-la para cima, recolhe o roteiro numa barra e mostra a conversa inteira; tocar de novo volta.

**Computador (a partir de 1024 px).** A conversa fica à esquerda e o roteiro à direita, como a lousa
do ChatGPT.

**Topo do roteiro:**

- o **seletor**: o nome do roteiro atual com uma setinha. Tocar abre a lista com busca, agrupada em
  *Em ajuste*, *Aguardando aprovação* e *Aprovados*, os mais recentes em cima. Com 20 roteiros, a
  busca e os grupos resolvem; ninguém passa para o lado procurando;
- a versão atual ("versão 6, da Isa, há 3 min") e o estado;
- os botões **Ver o que mudou**, **Desfazer**, **Histórico**, **Aprovar e mandar pra produção** e
  **Tutorial**.

**Ajuste pedido.** Com o modo aberto, o que a pessoa digita vai para o agente com o prefixo
`[roteiro <id>]`. O roteiro mostra "Pedido enviado, esperando a Isa" e, quando o agente marca que
começou, "Isa ajustando…". A versão nova entra **no mesmo lugar**, sem mensagem nova com o roteiro
inteiro.

**O que mudou.** Os trechos alterados ganham uma barra lateral grossa, um fundo colorido e o rótulo
"mudou" (nada disso depende de animação, porque o iPhone do Danilo está com Reduzir Movimento ligado).
O realce some sozinho depois de uns 10 segundos; com Reduzir Movimento ele some sem transição.
Uma faixa fica no topo com o resumo de uma linha que o agente escreveu, mais **Ver o que mudou**
(antes e depois, com o que saiu riscado e o que entrou sublinhado) e **Desfazer**.

**Edição à mão.** Tocar num parágrafo transforma aquele parágrafo em campo de texto, com **Salvar** e
**Cancelar**. Há também "Editar tudo". Salvar grava uma versão nova com autor "dono" e avisa o agente.

**Aprovar.** Pede confirmação ("Aprovar a versão 7 e mandar pra produção?"), grava o estado
*aprovado* e avisa o agente. Com o DG Social ligado, aprova a etapa Roteiro lá também, o que solta a
produção do conteúdo.

**Sem botão de ouvir o roteiro.** O Danilo descartou (23/10/2026).

## Decisão de arquitetura

### Uma fonte de verdade, com dois donos possíveis

No produto dos alunos não existe DG Social. Por isso o DG Claw guarda os roteiros sozinho (origem
`local`) e tem um **conector opcional para o DG Social** (origem `dgsocial`). Quando o conector está
ligado, o texto atual de um roteiro do DG Social **é sempre o arquivo do conteúdo no DG Social**
(`roteiro.md`, ou o `artifact_path` da etapa Roteiro): o DG Claw lê de lá a cada abertura e grava lá
a cada versão nova (`POST /api/v1/content/{slug}/roteiro`). Não existe "versão do chat" diferente da
"versão do painel".

O DG Claw guarda, para cada roteiro do DG Social, só o que o DG Social não tem: o **registro das
versões** (texto de cada uma, resumo de uma linha, autor), o aviso "ajustando" e os pedidos de
abrir. Se alguém mudar o roteiro fora do modo roteiro (a tela do DG Social, a sessão do card
editando o arquivo), a próxima leitura percebe pelo hash do texto e registra uma versão com autor
`externo` e o resumo "Mudou fora do modo roteiro". Nada se perde e nada fica duplicado como verdade.

*Por que não guardar tudo no DG Social:* o produto dos alunos não tem DG Social, e o histórico de
versões com resumo é do modo roteiro (o `historico/` do DG Social guarda cópias, sem autor nem
resumo). *Por que não copiar o texto para o DG Claw e sincronizar depois:* duas cópias editáveis
sempre acabam divergindo; aqui a escrita vai direto para o dono do texto.

### O módulo de tela é um só, nos dois apps

A tela vive em dois arquivos sem build, `roteiro.js` e `roteiro.css`, em `web/public/`. Eles só
dependem do contrato HTTP abaixo e de uma **ponte** de poucas linhas que cada app oferece. A
instância do Danilo (DG Telegram, Flask) recebe **cópia travada** desses dois arquivos, igual à casca
(`static/roteiro/ORIGEM` com commit e hash, e um teste que falha se alguém editar a cópia). O backend
é reescrito em cada app (Node aqui, Python lá) seguindo este documento, e um teste de contrato roda
contra os dois.

A ponte (`window.DGRoteiro.iniciar(ponte)`):

| Campo | O que é |
| --- | --- |
| `agente` | id do agente da conversa aberta |
| `enviar(texto, aoEntregar)` | manda uma mensagem para o agente pelo caminho normal da conversa, sem descer a rolagem; `aoEntregar(ok, motivo)` |
| `seletores.composer` | o campo de digitar do app (o módulo mede a altura dele para o roteiro não cobrir) |
| `seletores.topo` | a barra de cima do app (idem) |
| `seletores.raiz` | o contêiner da conversa, que no computador ganha margem à direita |

E dois ganchos que o app chama:

- `DGRoteiro.prefixar(texto)`: no envio pelo campo. Com o modo aberto devolve `[roteiro <id>] texto`;
  fechado, devolve o texto como veio;
- `DGRoteiro.respostaDoAgente(texto)`: quando chega mensagem nova do agente, para a faixa de baixo.

*Por que sondagem e não SSE:* os dois apps têm SSE, mas com formatos diferentes. Sondar
`GET …/estado` a cada 2,5 s, só com o modo aberto e a página visível, custa pouco, funciona igual nos
dois e mantém a ponte pequena. Fechado, o módulo sonda `GET /api/v1/roteiros/aberto` a cada 8 s para
atender o pedido de abrir que o agente fizer.

## Contrato HTTP

Base `/api/v1/roteiros`. Erro é sempre `{ ok:false, erro:"<o que falhou, com que entrada, o que
fazer>" }` com o status certo, em português. Datas em ISO 8601.

### O roteiro

```json
{
  "id": "dgs-china-demissao-ia",
  "titulo": "China demite com IA",
  "agente": "isa",
  "origem": "dgsocial",
  "ref": "china-demissao-ia",
  "link": "https://social.dgmedeiros.com.br/content/china-demissao-ia",
  "estado": "aguardando_aprovacao",
  "ajustando": { "desde": "2026-10-23T23:10:00-03:00", "por": "isa", "nota": "cortando o gancho" },
  "versao": 6,
  "resumo": "Gancho mais curto e número da Bloomberg no segundo parágrafo",
  "autor": "isa",
  "atualizado_em": "2026-10-23T23:12:41-03:00",
  "criado_em": "2026-10-22T10:00:00-03:00",
  "aprovado_em": null,
  "texto": "…só no GET de um roteiro…"
}
```

- `id`: `[a-z0-9][a-z0-9-]{0,127}`. Local nasce como `rt-<slug do título>-<4 letras>`; do DG Social é
  `dgs-<slug>`.
- `estado`: `em_ajuste`, `aguardando_aprovacao`, `aprovado`, `arquivado`.
- `ajustando`: `null` ou o aviso; expira sozinho em 15 minutos (na leitura) e some quando entra
  versão nova.
- `autor` das versões: `agente` (o slug do agente), `dono`, `externo` ou `desfazer`.

Estado no DG Social (derivado da fase do card, `GET /api/v1/content/fases`): `aprovada` vira
`em_ajuste`, `roteiro` vira `aguardando_aprovacao`, e `assets`, `prontos`, `render`, `publicar` viram
`aprovado`. Ideia sem pasta não aparece. Por cima disso, o DG Claw guarda o estado que o agente ou o
dono marcar e usa o mais recente dos dois.

### Rotas

| Rota | Quem | O que faz |
| --- | --- | --- |
| `GET /api/v1/roteiros?q=&estado=&agente=` | dono, agente | lista sem `texto`, mais recente primeiro; `fontes.dgsocial` = `{ligado, ok, erro?}` |
| `POST /api/v1/roteiros` | dono, agente | cria local: `{titulo, texto, resumo?, agente?}` (201) |
| `GET /api/v1/roteiros/aberto?agente=` | dono | último pedido de abrir: `{id, pedido_em}` ou `{id:null}` |
| `GET /api/v1/roteiros/docs.md` | público | este contrato, curto, para agente |
| `GET /api/v1/roteiros/{id}` | dono, agente | o roteiro com `texto` |
| `GET /api/v1/roteiros/{id}/estado` | dono, agente | só `{id, versao, estado, ajustando, resumo, autor, atualizado_em}` (é o que a tela sonda) |
| `GET /api/v1/roteiros/{id}/versoes` | dono, agente | `[{versao, resumo, autor, criado_em, caracteres, restaurada_de}]` |
| `GET /api/v1/roteiros/{id}/versoes/{n}` | dono, agente | a versão com `texto` |
| `POST /api/v1/roteiros/{id}/versoes` | dono, agente | grava versão nova: `{texto, resumo, base_versao, forcar?}` |
| `POST /api/v1/roteiros/{id}/ajustando` | dono, agente | `{ativo: true, nota?}` liga, `{ativo:false}` desliga |
| `POST /api/v1/roteiros/{id}/desfazer` | dono | volta à versão anterior: `{base_versao}` |
| `POST /api/v1/roteiros/{id}/restaurar` | dono, agente | volta a uma versão: `{versao, base_versao}` |
| `POST /api/v1/roteiros/{id}/estado` | dono, agente | `{estado, nota?}`; agente não pode marcar `aprovado` |
| `POST /api/v1/roteiros/{id}/aprovar` | dono | aprova a versão: `{base_versao}` |
| `POST /api/v1/roteiros/{id}/abrir` | dono, agente | pede que a conversa aberta do agente mostre este roteiro; devolve `{link}` |
| `GET /api/v1/roteiros/{id}/eventos?desde=` | dono, agente | o que aconteceu: `[{n, tipo, autor, versao, quando, nota}]` |

Regras de escrita:

- **`base_versao` é obrigatório** em versões, desfazer, restaurar e aprovar. Se a versão atual já
  for outra, a resposta é **409** com `atual` (o roteiro com texto) e a frase "A versão atual é a 7
  (de isa, 23:14); você partiu da 6. Leia a 7 e grave de novo, ou mande forcar:true." O agente nunca
  grava por cima de uma edição do dono sem saber.
- Texto igual ao atual não cria versão (`{ok:true, mudou:false}`).
- `resumo`: uma linha, até 160 caracteres, obrigatório para o agente (é o que aparece na faixa).
  Para o dono, se vier vazio, o servidor escreve "Edição à mão".
- Versão do agente: estado vira `aguardando_aprovacao` e o `ajustando` some. Versão do dono: estado
  vira `em_ajuste` se estava aprovado, senão fica.
- `desfazer`: alvo = (`restaurada_de` da versão atual, ou a própria versão atual) menos 1. Cria uma
  versão nova com o texto do alvo, autor `desfazer`, `restaurada_de` = alvo e resumo "Voltou ao texto
  da versão N". Na versão 1 é 409 "não há versão anterior".
- `aprovar` no DG Social chama `POST /api/v1/content/{slug}/aprovar-roteiro` com `{actor:"danilo"}`
  e devolve o `session` de lá. Se o DG Social falhar, nada muda aqui e a resposta é 502 com a causa.
- Limites: texto até 200 KB, 300 versões por roteiro (as mais antigas saem do registro, a 1 fica).
- Quem é quem: no DG Claw, a caixa (`via: 'caixa'`) é o agente e só enxerga roteiros com `agente`
  igual ao seu slug; o resto é o dono. No DG Telegram, cookie é o dono e chave de API é o agente
  dono da chave (todas as chaves de lá são do admin único, então o agente pode tudo, inclusive
  aprovar a pedido do Danilo; fica registrado como autor).

### Mensagens que chegam ao agente

| Mensagem | Quando |
| --- | --- |
| `[roteiro <id>] <texto do dono>` | o dono digitou um pedido com o modo aberto |
| `[roteiro <id>] [aviso] Salvei uma edição à mão: versão N.` | o dono salvou à mão |
| `[roteiro <id>] [aviso] Desfiz: voltei ao texto da versão N (agora é a versão M).` | o dono desfez |
| `[roteiro <id>] [aviso] Aprovei a versão N. Pode mandar pra produção.` | o dono aprovou |

### Onde fica

- DG Claw: `<DGCLAW_WEB_DATA>/roteiros/<id>.json` (0600, gravação atômica). Arquivo inválido nunca é
  sobrescrito: aquele roteiro responde 503 com o motivo.
- DG Telegram: `data/roteiros/<id>.json`, mesmo formato.
- Conector: no DG Claw, `DGCLAW_ROTEIROS_DGSOCIAL_URL` e `DGCLAW_ROTEIROS_DGSOCIAL_CHAVE` (vazio =
  desligado); no DG Telegram, `DGSOCIAL_API_URL` e `DGSOCIAL_API_KEY`, que já existem.

## Abrir o modo

- Link direto: `/a/<agente>?roteiro=<id>` (ou `?roteiro=` vazio para abrir o seletor).
- O agente chama `POST …/{id}/abrir`; a conversa aberta abre o roteiro em até 8 s.
- O app guarda o último roteiro aberto no aparelho, e recarregar a página mantém o modo.
- Botão "Roteiros" no menu.
