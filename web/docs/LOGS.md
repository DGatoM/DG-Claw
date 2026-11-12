# Logs dos agentes (tela Logs do Admin)

A tela Logs (`/logs`) mostra ao dono do DG Claw uma lista cronológica, do mais novo para o mais antigo, de tudo o
que cada agente fez: mensagens, comandos, arquivos e ferramentas. A fonte são os arquivos de sessão que o Claude Code
e o Codex já gravam na casa de cada agente. O Web os lê no servidor, somente leitura, sem migração: o histórico que já
existe aparece sozinho.

## Quem pode ler

- Só o dono, na sessão do navegador. Colaborador recebe 403, e quem não entrou recebe 401.
- **Agentes não acessam esta API**, nem pela caixa, nem o Admin por token. O texto de um log nasceu do que o agente
  leu e escreveu (páginas da web, e-mails, arquivos) e não é de confiança: se entrasse no contexto de outro agente
  (ou do Admin), poderia carregar instruções escondidas. Se o Admin precisar de um trecho, o dono o cola na conversa
  depois de conferir.
- Os caminhos `/p/<agente>/logs` e `/p/<agente>/api/v1/logs/...` respondem 403 para todos.

## O que a tela é e o que não é

- É uma ajuda para o dono conferir o que aconteceu. **Não é uma prova**: os arquivos ficam na casa do agente, e um
  agente comprometido pode reescrever a própria casa. Para auditoria séria, use também os logs do sistema.
- Comando que pode levar credencial (o texto contém um programa como curl, mysql, ssh, git, docker, npm ou aws, ou marcadores como pass, token, secret, auth, cookie, `-u `, `-p` ou usuario@ em URL) sai, e é indexado na busca, só com o nome do programa e `[argumentos ocultos: comando que pode levar credencial]`. Os demais comandos aparecem inteiros, passando antes pelo mascarador abaixo. Em qualquer texto (saídas, mensagens), a linha que tem um desses programas e um desses marcadores vira `[linha oculta: pode levar credencial]`, o que cobre o eco do comando no `set -x`.
- O texto sai mascarado (chaves de API, tokens, senhas em linha de comando, cabeçalhos de autorização e o valor inteiro dos cabeçalhos
  Authorization, Proxy-Authorization, X-Api-Key, Cookie e Set-Cookie, até o fim da linha, e o valor de flags e atribuições
  até a aspa de fechamento ou o fim da linha (o valor pode juntar pedaços com e sem aspas, como `"a b"c`, e a barra de escape fora das aspas, como `primeira\ segunda`; em JSON, a vírgula ou a chave depois da aspa de fechamento encerram o valor), viram `[segredo oculto]`, sem deixar pedaço do valor (flags `--password`, `--passwd`, `--pass`, `--pwd`, `--token`, `--secret`, `--senha`, `--api-key`, `--api_key`, `--apikey`, `--auth` e variações; `curl --user`, `--proxy-user`, `-u` e `-U` com ou sem espaço ou `=`, em qualquer posição do comando e em quantas ocorrências houver, com continuação de linha; `mysql -p`, `sshpass -p` e `htpasswd -b`. As flags longas de segredo valem em qualquer comando, com o valor em outra linha (`\` e quebra de linha) ou entre aspas que atravessam linhas. Isso é feito por um tokenizador linear, sem executar nada, que segue a regra do shell: fora de aspas e escapes, `;`, `|`, `&` e quebra de linha terminam o argumento e o comando, e a análise recomeça no comando seguinte), e `\"` dentro de um valor entre aspas não o fecha). Objetos vindos do log (entradas de
  ferramenta, argumentos) trocam por `[segredo oculto]` o valor de toda chave com nome de segredo (password, token, secret,
  authorization, cookie, chave, credential e parecidos), em qualquer nível e também dentro de texto que contém JSON, com orçamento
  global por valor (2000 nós e 64 KB de caracteres somados, chaves incluídas, profundidade 6): ao estourar, o resto vira
  `[entrada grande demais, omitida]` e nada além do corte aparece. A máscara pega formatos conhecidos: um segredo fora desses formatos passa.
- Pensamento do modelo (`thinking` e `reasoning`) não é exibido.
- Arquivos de uma sessão ainda em andamento: a última linha, se estiver incompleta, é ignorada até terminar de ser gravada.

## Rotas

Todas são `GET`, exigem o cookie de sessão do dono e respondem `{"ok":false,"erro":"..."}` em português quando algo
falha. Outro método responde 405.

```bash
curl -s -b cookie.txt https://SEU-SITE/api/v1/logs/agentes
```

### GET /api/v1/logs/docs.md

Este documento.

### GET /api/v1/logs/agentes

Os agentes do registro e o estado de cada fonte (um motor por fonte: `claude` e `codex`).

```json
{"ok":true,"agentes":[{"id":"clara","nome":"Clara","tipo":"agente","provedor":"claude",
  "fontes":[{"motor":"claude","estado":"ok","motivo":null,"arquivos":12,"bytes":3481920,"ultima_atividade":1762600000000},
            {"motor":"codex","estado":"ausente","motivo":"nunca rodou neste motor (.codex/sessions não existe)","arquivos":null,"bytes":null,"ultima_atividade":null}]}]}
```

- `estado`: `ok`, `vazia` (a pasta existe e não tem sessão), `ausente` (a pasta não existe: o agente nunca rodou
  neste motor), `ilegivel` (existe, mas não foi possível ler; o `motivo` diz por quê), `parcial` (a pasta passou de um
  dos tetos ou do prazo e a lista de sessões pode estar incompleta; o `motivo` diz qual) ou `nao_verificada` (a verificação
  passou do prazo total antes de chegar neste agente: atualize para tentar de novo).
- O Admin lê o Claude em `transcripts_dir` e o Codex em `codex_home_host/sessions` (se o registro tiver esse campo).
- Onde as sessões ficam: Claude em `<casa>/.claude/projects` (e `transcripts_dir` no Admin); Codex com assinatura em
  `<casa>/.codex/sessions` e Codex com chave de API em `<casa>/.plataforma/codex-api/<id>/sessions` (uma pasta por sessão do
  runner). As pastas da API entram na mesma fonte do Codex, com os mesmos limites; o `<id>` só vale com letras, números, `_` e
  `-` (até 64), atalhos não são seguidos e o caminho real precisa ficar dentro da casa. A enumeração respeita o teto de entradas e o
  prazo da fonte (arquivos e nomes inválidos também contam) e lê no máximo 200 pastas de sessão: passando disso, as 200
  primeiras entram e a fonte fica `parcial`, com o motivo. Com sessões só no caminho da API, a
  fonte aparece como lida (nunca como "nunca rodou neste motor"). O Admin ganha a fonte do Codex também quando só há sessões
  por chave de API na casa dele.
- Limite conhecido: um agente do Claude configurado com um `CLAUDE_CONFIG_DIR` próprio (variável do `runner.json`, que o registro de
  agentes não traz) grava o histórico fora de `<casa>/.claude`, e a tela não tem como descobrir esse caminho de fora; nesse caso a
  fonte do Claude aparece como "ausente" ou "vazia". O Claude por chave de API usa o mesmo diretório de configuração da assinatura.

### GET /api/v1/logs/agentes/:slug/sessoes

Parâmetros: `limite` (1 a 200, padrão 50) e `cursor` (o `proximo` da resposta anterior).

```bash
curl -s -b cookie.txt "https://SEU-SITE/api/v1/logs/agentes/clara/sessoes?limite=20"
```

Resposta: `sessoes` por data de modificação (mais nova primeiro), cada uma com `id` (12 caracteres hexadecimais, calculado
do caminho relativo), `sessao` (uuid, quando o nome do arquivo traz um), `motor`, `projeto`, `subagente`, `bytes` e
`atualizado`. Nunca traz caminho absoluto. Vêm junto `fontes`, `avisos` e `contagens`.

### GET /api/v1/logs/agentes/:slug/eventos

| Parâmetro | Valor |
| --- | --- |
| `desde`, `ate` | `AAAA-MM-DD` (dia inteiro, no fuso do servidor) ou horário ISO. `desde` depois de `ate` dá 400. |
| `tipo` | Lista separada por vírgula entre `mensagem`, `comando`, `arquivo`, `ferramenta`, `sistema`. |
| `q` | Busca de até 200 caracteres, sem diferenciar maiúsculas nem acentos. A busca olha o texto **já mascarado**: não dá para descobrir um segredo procurando por ele. |
| `sessao` | O `id` curto ou o uuid de uma sessão. Sessão que não existe dá 404. |
| `limite` | 1 a 200 (padrão 50). |
| `cursor` | O `proximo` da resposta anterior (até 8 KB). Cursor adulterado dá 400. |

```bash
curl -s -b cookie.txt "https://SEU-SITE/api/v1/logs/agentes/clara/eventos?tipo=comando&desde=2026-11-01&q=deploy"
```

Resposta:

```json
{"ok":true,"agente":"clara","eventos":[{"id":"a1b2c3d4e5f6:18230","horario":"2026-11-08T14:03:11.000Z","t":1762610591000,
  "sessao":"...uuid...","motor":"claude","subagente":false,"projeto":"-workspace","tipo":"comando",
  "titulo":"Lista os arquivos","texto":"","detalhes":{"comando":"ls -la","descricao":"Lista os arquivos"},
  "resultado":{"erro":false,"texto":"...","truncado":false}}],
 "proximo":"eyJ0Ijo...","parcial":false,"lidos_bytes":262144,
 "fontes":[],"avisos":[],"contagens":{"linhas_ilegiveis":0,"linhas_gigantes":0,"sem_horario":0,"atalhos_ignorados":0}}
```

- `tipo` do evento: `mensagem` (com `papel`: `pessoa`, `agente` ou `sistema`), `comando` (Bash, shell, execução de
  comando), `arquivo` (Read, Write, Edit, MultiEdit, NotebookEdit, alteração de arquivo), `ferramenta` (as demais, incluindo
  MCP) e `sistema` (por exemplo, conversa compactada).
- Eventos de chamada trazem `resultado` com `erro`, `texto` e `truncado`, ou `resultado: null` quando o log não registrou
  o resultado (a tela escreve "sem resultado registrado", que é diferente de um resultado vazio).
- `horario` é o horário original do registro. `horario_suspeito: true` marca registro cujo horário está mais de 5 minutos
  depois da última modificação do arquivo (relógio errado ou arquivo adulterado); a ordem na lista segue a ordem em que o arquivo foi gravado.
- Registro de ação sem horário válido não vira meia-noite de 1970: é contado em `contagens.sem_horario` e não aparece.
- `proximo` vem quando há mais resultados. Se `parcial` for `true`, o pedido gastou o orçamento (64 MB lidos ou 1,5 s)
  antes de encher a página: peça de novo com o `proximo` para continuar procurando.
- `avisos` explica o que não deu para ler (pasta ausente, arquivo recusado, formato não reconhecido). Quando todas as
  fontes faltam, a lista de eventos vem vazia e os `avisos` e as `fontes` dizem por quê: isso é diferente de o agente
  não ter feito nada.

## Limites e proteções

- Cada campo de texto é cortado em 64 KB **antes** de mascarar, e o último pedaço sem espaço desse corte é descartado
  (para não sobrar um segredo cortado). A busca (`q`) roda nesse mesmo texto: o que passa de 64 KB não é achado. Sequência de mais
  de 128 letras e números seguidos, sem espaço (uma chave em base64, um JWT), sai como `[trecho longo omitido]`.
- Textos têm até 4 KB, comandos e entradas de ferramenta até 2 KB e resultados até 4 KB (`truncado: true` quando cortou).
  A máscara roda antes do corte.
- A leitura é de trás para frente, em blocos de 64 KB, sem carregar o arquivo inteiro. Linha de mais de 4 MB é pulada
  (`linhas_gigantes`); JSON quebrado é contado em `linhas_ilegiveis`.
- No máximo 2 varreduras ao mesmo tempo no servidor, somando `agentes`, `sessoes` e `eventos` (a terceira recebe 429),
  32 arquivos abertos por busca, 20000 arquivos de sessão por fonte e 5 níveis de pasta.
- A descoberta de arquivos para em 50000 entradas visitadas, em 10000 subpastas esperando leitura ou em 3 segundos. Ao parar, a
  fonte fica `parcial` com o motivo (e um aviso `limite`). Os avisos de arquivo recusado são limitados a 50 por resposta, com a
  contagem do que foi omitido. Em `agentes`, os agentes são verificados em sequência dentro de um prazo total de 5 segundos.
- O cursor leva a posição global (`g`, o último arquivo já aberto na ordem por data) e o momento em que nasceu (`ts`).
  Arquivo anterior a `g` e sem entrada em `h` (que só guarda os arquivos lidos pela metade) é tratado como esgotado e não
  é reaberto, a não ser que tenha sido modificado depois de `ts`. Se os arquivos em andamento não couberem em `h`, os de menos
  progresso são relidos do fim e a resposta traz o aviso `hints_omitidos`.
- O prazo de leitura (1,5 s e 64 MB) só começa depois da descoberta dos arquivos. Uma resposta `parcial` sempre anda: traz
  eventos ou um `proximo` diferente do recebido. Se não conseguiu avançar, vem sem `proximo` e com o aviso `sem_progresso`,
  que diz a causa e que é para estreitar o período ou o tipo. Registro com campo de tipo inesperado é contado em
  `linhas_ilegiveis`, e a leitura segue.
- O servidor entrega o laço de eventos a cada poucos milissegundos durante a leitura e confere o prazo no meio de linhas com
  muitos blocos: uma linha que não coube no prazo é relida na página seguinte (`parcial: true`).
- Atalhos (symlink) nunca são seguidos (`atalhos_ignorados`); arquivo com mais de um nome no disco, fora da pasta do agente
  ou que não seja regular é recusado, com aviso.
- Formato do Codex: cada linha é decidida pelos campos estruturais (`type` e `payload.type`), nunca por busca de texto, e os
  dois formatos (`item_completed` e `response_item`) valem no mesmo arquivo. A mesma ação costuma estar nos dois, e a
  repetição só é descartada com correspondência inequívoca: o mesmo id (`call_id` igual ao id do item) ou a mesma classe com o
  conteúdo original idêntico por inteiro (comparado por sha256 do texto completo, antes da máscara e de qualquer corte, sem
  normalizar espaço, caixa nem tamanho), um para um, dentro da janela (mensagens 5 segundos, comandos 3 segundos). Só o hash
  fica na memória. Fica a primeira linha vista na leitura de trás para frente.
  Qualquer dúvida mantém os dois eventos, porque num log de auditoria é melhor sobrar repetição do que faltar uma ação.
  Por isso o `exec` do Codex (um trecho de JavaScript que pode chamar várias ferramentas) nunca se junta ao item que ele gerou,
  a não ser que os dois tenham o mesmo id: aparecem o `exec` e o item. Ferramentas e alterações de arquivo sem id também
  aparecem nas duas famílias.
  Arquivo sem nenhum dos dois tipos de registro aparece como "formato não reconhecido", nunca como "sem ações": o aviso só sai
  depois de o arquivo ser lido até o começo (um primeiro registro de conversa longe do início não faz o arquivo sumir).
- Em um arquivo que ainda está crescendo, a página seguinte pode, raramente, repetir ou pular um registro cujo horário
  esteja fora de ordem.
