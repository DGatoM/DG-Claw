# Anonimizar documentos na API do DG Claw Web

Troca dados pessoais dos documentos por marcadores (`[PESSOA_1]`, `[CPF_1]`) antes de o agente ler. Estas
rotas são do dono, usadas pela tela Anonimizar e pela conversa. Todas exigem sessão, menos `GET .../docs.md`, que é pública (o agente lê sem credencial); POST, PUT e DELETE
exigem o cabeçalho `Origin` do próprio site. Os agentes NÃO chamam nenhuma delas: não estão liberadas na caixa
do agente (`dgclaw-api` recebe 403) e o servidor recusa pedido de agente também dentro da rota. Guia para o
dono: `docs/ANONIMIZAR.md`.

Erro é sempre `{"ok":false,"erro":"motivo em português"}` com o status certo. Nenhuma resposta traz dado
pessoal, exceto `GET .../tabela`, `POST .../reverter-texto` e `GET .../final/<id>`, que existem para o dono ler.

## GET /api/v1/anonimizar/estado

```json
{"ok":true,
 "detector":{"nivel":"completo","formatos":[".txt",".pdf"],"modelo_carregado":false,"rss_mb":31,"versao_modelo":"abc"},
 "instalacao":{"em_andamento":false,"nivel":null,"arquivo":null},
 "ram":{"disponivel_mb":3120,"total_mb":3900,"necessaria_completo_mb":2500},
 "agentes":[{"slug":"ana","nome":"Ana","ligado":true,"documentos":4,"aviso":null}]}
```

`nivel`: `regex` (texto simples), `leitores` (também PDF, Word e Excel) ou `completo` (também nomes,
empresas e endereços). Se o motor não responde, `detector` vem como `{"nivel":null,"erro":"..."}`.
`instalacao.arquivo` é o `estado.json` do instalador do detector, sem interpretação.

## GET e PUT /api/v1/anonimizar/:slug/config

Opções do agente (todas gravadas em `<dados do Web>/anonimizar/config.json`):

| Campo | Valores | Padrão |
|---|---|---|
| `ligado` | true, false | false |
| `valores` | true, false (valores em dinheiro) | false |
| `datas` | true, false | false |
| `empresas` | true, false | true |
| `aplicar_no_que_digito` | true, false | false |
| `sem_detector` | `bloquear`, `so_numeros` | `bloquear` |
| `nao_anonimizavel` | `bloquear`, `enviar` | `bloquear` |

O PUT aceita só os campos que mudam: `{"ligado": true}`. Campo desconhecido ou valor de tipo errado dá 400.
O arquivo guarda também chaves que o Web não conhece, sem apagá-las.

## POST /api/v1/anonimizar/testar

Corpo `{"slug":"ana","texto":"..."}` (`slug` é opcional e só escolhe as opções). Devolve
`{"ok":true,"texto":"[PESSOA_1] ...","contagem":{"PESSOA":1},"total":1,"nivel":"completo","aviso":null}`.
Nada é gravado: a tabela do teste é temporária.

## GET /api/v1/anonimizar/:slug/documentos

Lista, do mais novo ao mais antigo: `id`, `nome_original`, `criado_em`, `contagem` (por tipo), `total` e
`saidas` (os caminhos que o agente enxerga). Nunca traz os valores.

## DELETE /api/v1/anonimizar/:slug/documentos/:id e DELETE /api/v1/anonimizar/:slug/documentos

O primeiro apaga um documento do registro e tira da tabela os marcadores que nenhum outro documento usa
(`removidos_da_tabela`). O dado real some do disco, mas a entrada fica na tabela como lápide (`apagado: true`, sem valor) para que o número do marcador nunca seja dado a outra pessoa. O segundo apaga o registro e a tabela inteira do agente. Os arquivos que o agente já
recebeu na casa dele não são tocados. Depois de apagar a tabela, a versão final de um arquivo antigo deixa de
ter como voltar os dados.

## GET /api/v1/anonimizar/:slug/tabela

A tabela em claro (`{"entradas":[{"tipo","valor","marcador"}]}`; marcador apagado vem como `{"tipo","marcador","apagado":true}`), só para o dono conferir. Resposta com
`Cache-Control: no-store`. Cada abertura vai para o log (só a contagem, nunca os valores). O pedido precisa vir
da própria tela: com `Origin` do site, ou com `Sec-Fetch-Site: same-origin`. Sem nenhum dos dois, 403.

## POST /api/v1/anonimizar/:slug/reverter-texto

Marcador dentro de URL, link ou imagem em markdown fica como está. Corpo `{"texto":"Falei com [PESSOA_1]"}` (até 200 mil caracteres). Devolve
`{"ok":true,"texto":"Falei com Maria Souza","trocas":1,"desconhecidos":[]}`. Marcador que a tabela não
conhece fica como está e aparece em `desconhecidos`.

## GET /api/v1/anonimizar/:slug/final/:mediaId

Gera e baixa a versão com os dados reais de um arquivo que o agente mandou (`mediaId` é o id da mídia, o
mesmo de `/api/v1/media/<id>`). A mídia tem de ser registrada daquele agente e ficar dentro da pasta dele; de
outro agente dá 404, fora da pasta dá 403. Formatos: `.docx .xlsx .pptx .md .txt .csv .json`. A troca vale só em texto visível: marcador dentro de URL ou de `](...)` fica como está. `.html .htm .svg .xml` dão 422 (`FORMATO_ATIVO`): peça `.md` ou `.docx`. Arquivo que é atalho, FIFO ou arquivo especial dá 422 sem travar. PDF dá 422 com
a orientação de pedir ao agente o resultado em `.docx` ou `.md`. A resposta é um download
(`Content-Disposition: attachment`, nome com `-final`, `nosniff`, `no-store`).

## POST /api/v1/anonimizar/detector/instalar

Corpo `{"nivel":"leitores"}` ou `{"nivel":"completo"}` (só esses dois valores existem; qualquer outro dá 400).
Inicia a unidade `dgclaw-anonimizar-instalar@<nivel>.service` e responde 202. O progresso aparece em `GET
.../estado`. Já instalando: 409. O completo pede cerca de 2,5 GB de memória livre; com menos, 409, e
`"forcar": true` instala assim mesmo.

## GET /api/v1/anonimizar/docs.md

Este arquivo. Pública, sem sessão.

## Como o upload muda

Com `ligado: true`, `POST /api/v1/agents/:slug/upload` passa o arquivo pelo motor e só entrega a cópia
anonimizada (`doc-<id>.anon.<ext>`). A resposta ganha `anonimizado: {id, contagem, por_tipo, avisos, nivel}`.
Documento que não dá para anonimizar volta 422 (ou 503 se o motor está fora do ar) com o motivo e o que fazer,
e nada chega ao agente. Com `enviar` em `nao_anonimizavel`, o arquivo segue sem filtro e a resposta traz
`anonimizado.enviado_sem_anonimizar: true`.

## Segurança da gravação

Arquivos na casa do agente são gravados e lidos por `web/bin/entrega-segura.py`, que desce `uploads/<dia>` pasta
por pasta com `O_NOFOLLOW` e `dir_fd`, depois de o motor terminar. Se o agente trocar uma pasta por um atalho no meio
do caminho, a gravação é recusada (500, "atalho") e nada sai da casa dele. Se a configuração não puder ser lida, o
envio de mensagens do agente falha com 503 (`CONFIG_CORROMPIDA`) em vez de seguir sem o filtro.
