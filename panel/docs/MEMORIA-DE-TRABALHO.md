# A memória de trabalho na aba Status

O pedido do Danilo (05/10/2026, "importantíssimo"): ele abriu o painel e achou que
o agente não tinha working memory. Ela tinha, mas só aparecia inteira na aba
Memória, e na Status vinha com outro nome ("Memória de curto prazo") mostrando
só a linha "Agora". Quem abre a página inicial precisa ver, sem procurar, que a
memória de trabalho existe e se ela está em dia.

## O que é a memória de trabalho

É o arquivo `working-memory.md`, na raiz da pasta do agente (nas instalações
antigas, `persona/working-memory.md`). É o bloco de anotações do momento: o que
ele está fazendo, o que ficou pendente com o dono, o que ele sabe sobre o dono e
as últimas conversas. Ele lê este arquivo no começo de toda conversa.

Quem escreve nele:

| Quem | Quando | O que muda |
| --- | --- | --- |
| a remontagem (`build-wm`) | todo dia às 7h | vira o "Hoje" em "Ontem", refaz as últimas conversas, corta o que passou do teto |
| o batimento | a cada 30 min | reescreve a linha "Agora" e as últimas conversas |
| o próprio agente | ao longo do dia | pendências, tarefas, o que aprendeu |
| o dono | quando quiser, pela aba Memória ou pelo raio-X | qualquer coisa |

## O cartão "Memória de trabalho (working memory)"

Fica na aba Status, logo acima do "O que ele sabe agora". Mostra o **estado** da
memória; o **conteúdo** continua no raio-X logo abaixo e na aba Memória (o link
do rodapé do cartão leva até lá).

### O selo

| Selo | Quando | O que o dono faz |
| --- | --- | --- |
| **Em dia** | a remontagem das 7h rodou hoje (ou ainda não era hora, ou o timer foi ligado hoje depois das 7h) e a máquina mexeu nela há menos de 6 horas | nada |
| **Atrasada** | a remontagem não rodou hoje, rodou e falhou, ou a linha "Agora" está parada há mais de 6 horas | o cartão diz a causa e o que fazer; em geral, ver a aba Operações e, se repetir no dia seguinte, avisar quem instalou |
| **Ausente** | o arquivo não existe | avisar quem instalou: é preciso rodar a remontagem uma vez |
| **Vazia** | o arquivo existe sem nenhum texto | esperar a remontagem das 7h; se continuar vazio, avisar quem instalou |

Quando o estado não é "em dia", o cartão traz duas linhas: **Por quê** (a causa,
com o horário da última remontagem e o erro, se houve) e **O que fazer**.

### Os quatro números

| Rótulo | De onde vem |
| --- | --- |
| **Atualizada** | a linha `- **Agora:** segunda, 05/10/2026 15:16` do arquivo, que a máquina reescreve. Sem essa linha, a data em que o arquivo foi gravado (o tooltip diz qual das duas foi usada). Mostra "há quanto tempo" e o dia e a hora. |
| **Tamanho** | caracteres do arquivo, e embaixo os bytes (letra com acento ocupa dois bytes). |
| **Ocupação do teto** | bytes do arquivo divididos pelo teto da remontagem. O teto é o `MAX_BYTES` do `scripts/build-working-memory.py` **instalado naquele agente** (9000 no plugin de 05/10/2026; 6500 em instalações de setembro), lido do script para o número da tela ser o número que corta. Acima de 100%, a remontagem encolhe as seções mais descartáveis e manda o excesso para `memory/wm-transbordo.md`, que continua pesquisável. Verde até 89%, amarelo de 90% a 100%, vermelho acima. |
| **Remontagem das 7h** | "rodou hoje", "não rodou hoje", "falhou hoje", "ainda não" (antes das 7h15 ou timer ligado hoje depois das 7h) ou "não consegui ver" (nenhuma fonte legível). |

O tooltip da ocupação diz também quanto da memória chega ao começo de cada
conversa: **inteira**, quando o `CLAUDE.md` do agente importa
`@working-memory.md` (o padrão desde 05/10/2026); senão, até o `TETO` do
`hooks/session-context.sh` (14000 caracteres). Passando desse limite, aparece um
aviso embaixo do cartão.

### Como a remontagem é conferida

Qualquer uma destas fontes dizendo "rodou hoje, depois das 7h" basta:

1. o **registro do pulso**, `.dgclaw/logs/pulso/AAAA-MM-DD.jsonl`, linhas com
   `"id":"build-wm"`, que o `build-wm.sh` grava a cada rodada completa (com
   `"status":"erro"` quando falha);
2. o **systemd**: o timer `dgclaw-<slug>-build-wm.timer` (existe? quando foi
   ligado? quando é o próximo?) e o fim da última execução do service;
3. um **log configurado** em `config.json` (`wmRebuildLog`), para quem roda a
   remontagem por cron em vez de timer (é o caso da Isa);
4. a marca `<!-- virada do dia: AAAA-MM-DD -->` que o build escreve no topo do
   arquivo (só a data, sem hora).

Nenhuma fonte legível: `rodouHoje` sai `null` e a tela escreve "não consegui
ver". **Não medido nunca vira zero, nem vira atraso.**

### Pendências ativas

A linha `⚡ PENDÊNCIAS ATIVAS: ...` do topo do arquivo, escrita pelo agente. "(nenhuma
...)" aparece como "Nenhuma pendência ativa anotada"; arquivo sem a linha aparece
como "A memória dele não tem a linha de pendências ativas".

## A rota

`GET /api/working-memory/status` (agentes e scripts usam a mesma rota que a tela).
O conteúdo do arquivo continua em `GET /api/working-memory` e no `GET /api/cerebro`.

```json
{
  "estado": "em-dia | atrasada | ausente | vazia",
  "frase": "Atualizada há 22 min e remontada hoje às 07:00.",
  "causa": null,
  "oQueFazer": null,
  "avisos": [],
  "arquivo": { "caminho": "working-memory.md", "existe": true, "caracteres": 5125, "bytes": 5200, "gravadoEm": "ISO" },
  "atualizadaEm": "ISO", "atualizadaTexto": "segunda, 05/10 às 15:16",
  "atualizadaFonte": "a linha \"Agora\" do arquivo",
  "idadeMin": 22, "idadeTexto": "há 22 min",
  "teto": { "bytes": 6500, "fonte": "MAX_BYTES do scripts/build-working-memory.py instalado neste agente" },
  "tetoInicioSessao": { "caracteres": null, "inteira": true, "fonte": "o CLAUDE.md dele importa o arquivo inteiro (@working-memory.md), sem corte" },
  "ocupacaoPct": 80,
  "remontagem": {
    "rodouHoje": true, "falhou": false, "frase": "Rodou hoje às 07:00.",
    "fontes": ["registro do pulso", "systemd"],
    "ultima": { "em": "ISO", "ok": true, "detalhe": "", "fonte": "registro do pulso", "soData": false },
    "proxima": "ISO",
    "timer": { "unidade": "dgclaw-lara-build-wm.timer", "existe": true, "instaladoEm": "ISO", "proxima": "ISO" }
  },
  "pendencias": { "existe": true, "texto": "...", "nenhuma": false },
  "geradoEm": "ISO"
}
```

Campos que não deu para medir saem `null`. Erro de leitura sai `500` com `error`
e `howToFix` em português.

Ajustes opcionais no `config.json` do painel: `wmTetoBytes` (força o teto),
`wmRebuildLog` (log de quem roda por cron), `wmRebuildHora` (hora da remontagem,
padrão 7), `pluginDir` (onde está o plugin, padrão `<agentDir>/.dgclaw/plugin`).

## Arquivos

- `panel/lib/wm-status.js`: o cálculo e a rota. Não depende de outra lib do
  painel, para poder ser levado à mão a painéis antigos e ao painel da Isa.
- `panel/public/js/wm-status.js` e `panel/public/css/wm-status.css`: o cartão.
- `panel/public/js/tutoriais.js`: o passo `memoria-trabalho` da aba Status e o
  "?" do cartão.
- `panel/test-wm-status.mjs`: todos os estados, o "não consegui ver" e o cartão.

## Painéis instalados antes de 01/10 (Lara, Marina, Luna)

Esses painéis ainda não têm o raio-X "O que ele sabe agora". Lá, o cartão
antigo "Memória de curto prazo" passou a se chamar "Memória de trabalho (working
memory)" e ganhou este estado em cima da prévia de sempre. Quando o painel deles
for atualizado para a versão nova, o cartão fica como descrito acima.

## Como o texto livre aparece (12/10/2026)

Tudo o que o agente escreve em texto corrido (pensamentos, assuntos que ficaram
remoendo, metas, pendências, recados das rotinas, opiniões, avisos e motivos das
telas) passa por UM renderizador, `panel/public/js/markdown.js`. Antes, o
pensamento chegava como um bloco cru, com asteriscos, crases e endereços
enormes à mostra.

- **O que é formatado:** parágrafos (cada linha), listas com "- ", **negrito**,
  `código`, links `[texto](url)` e endereços http/https soltos (viram link). Um
  pensamento que começa com TÍTULO EM CAIXA ALTA seguido de ponto ou dois-pontos
  mostra o título em destaque.
- **De onde vem:** dos arquivos do agente (`thoughts.json`, `goals.json`,
  `working-memory.md`) e das rotas do painel. O painel só desenha; não muda o texto.
- **"ler inteiro":** pensamento longo aparece cortado em uma fronteira de palavra,
  sem deixar marca aberta (um `**` sem par). O botão mostra o texto completo, do
  jeito que ele escreveu. Nada é perdido: o arquivo inteiro continua na aba Memória.
- **Segurança:** todo o texto é escapado ANTES de virar HTML, então tag escrita no
  texto (`<script>`, `<img onerror>`) aparece como texto e nunca roda. Link só
  http e https: `javascript:` e `data:` nunca viram link. Teste:
  `panel/test-texto-rico.mjs`.
- **Sem o renderizador:** se `markdown.js` não carregar, as telas voltam ao texto
  escapado de sempre, nunca a HTML cru.
