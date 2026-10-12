# Colocar chaves no cofre de um agente por API

Para quem opera (a assistente principal ou o Admin) e precisa guardar a chave de um
serviço no cofre de **um agente**, sem abrir a tela dele. O cofre em si está
descrito em `panel/docs/COFRE.md`; aqui está só o caminho por API.

## A ideia em quatro linhas

1. Cada agente tem o próprio cofre e o próprio painel. Uma chave guardada num agente
   vale **só para ele**.
2. Para guardar por API você precisa de uma **chave de API daquele agente**
   (`dgc_...`). Ela não abre mais nada: só guarda chaves de serviço.
3. O valor da chave de serviço vai por variável de ambiente, **nunca na linha de
   comando**.
4. O dono do agente enxerga tudo na aba Cofre: quem guardou (`Admin (por API)`),
   quando e os quatro últimos caracteres. Nunca o valor.

## 1. Criar a chave de API do agente

Uma chave de API **não cria outra chave de API** (se uma vazasse, ela não poderia
gerar outra para continuar entrando depois de revogada). Então a primeira nasce por
um destes caminhos:

**Pela tela (o dono):** aba Cofre, seção "Quem pode guardar chaves aqui por API",
botão "criar chave de API". O token aparece uma vez, com botão de copiar.

**Na máquina (quem administra, por exemplo o Admin ao criar o agente):**

```bash
# O token sai SÓ no stdout; o resto vai para o stderr.
umask 077
node panel/bin/chave-api.js criar "Admin" > /caminho/seguro/chave-api-do-agente.txt
```

O arquivo precisa ficar em modo 600. O `umask 077` acima já cria assim. O painel
guarda só o hash: perdeu o token, revoga e cria outro.

Para ver o que existe: `node panel/bin/chave-api.js listar`.

## 2. Guardar uma chave de serviço

```bash
# O valor entra só no ambiente DESTE comando. Não aparece no ps nem no histórico.
OPENAI_API_KEY="$(cat /caminho/seguro/valor-da-chave.txt)" \
  scripts/cofre-injetar.sh \
    --painel https://endereco-do-painel-do-agente \
    --chave-api-arquivo /caminho/seguro/chave-api-do-agente.txt \
    --aplicar \
    OPENAI_API_KEY
```

- `--aplicar` reinicia o agente **uma vez**, depois da última chave, para as chaves
  valerem. Sem ele a chave fica guardada e passa a valer só no próximo reinício.
  Reiniciar interrompe o que o agente estiver fazendo: decida antes.
- Várias chaves de uma vez: exporte cada uma e liste os nomes
  (`... NOME_UM NOME_DOIS`).
- A saída é uma linha por chave (`OPENAI_API_KEY ok (final 1234)`). Se algo falhar,
  o script diz o motivo que o painel devolveu e sai com código diferente de zero.

### Sem o script, com curl

O corpo vai pelo stdin e o token por arquivo de cabeçalhos, para nada sensível entrar
na linha de comando:

```bash
# cabeçalho de autorização montado em arquivo 600 (curl lê com -H @arquivo)
umask 077
printf 'Authorization: Bearer %s\n' "$(cat /caminho/seguro/chave-api-do-agente.txt)" > /tmp/cab.$$

# o corpo sai do ambiente e vai pelo stdin
python3 -I -c 'import json,os; print(json.dumps({"envName":"OPENAI_API_KEY","valor":os.environ["OPENAI_API_KEY"]}))' \
  | curl -sS -X POST "https://endereco-do-painel-do-agente/api/cofre" \
      -H @/tmp/cab.$$ -H 'Content-Type: application/json' --data @-

rm -f /tmp/cab.$$
```

Para guardar e reiniciar na mesma chamada, some `"aplicar": true` ao corpo. A
resposta traz o que foi guardado (`ultimos4`) e o resultado do reinício
(`aplicado`). Se a chave foi guardada mas o reinício falhou, o status é de erro e o
corpo diz as duas coisas (`guardado` e `aplicado`): a chave **está** guardada.

### Conferir se uma chave já está lá, sem ver o valor

`GET /api/cofre` lista os nomes, os quatro últimos caracteres, quem cadastrou e a
origem (`tela` ou `api`). Nunca o valor.

## 3. Revogar

- **Uma chave de serviço:** aba Cofre, botão revogar, ou
  `DELETE /api/cofre?envName=NOME`. Revogar é datar: o registro fica. Se a chave
  vazou, cancele também no site do serviço, que é o único lugar onde ela deixa de
  funcionar de verdade.
- **Uma chave de API:** aba Cofre, seção "Quem pode guardar chaves aqui por API",
  botão revogar, ou na máquina `node panel/bin/chave-api.js revogar <código>`. Vale na
  hora.

## As garantias

| Pergunta | Resposta |
| --- | --- |
| A chave de API lê o valor de uma chave já guardada? | Não. Nenhuma rota devolve valor, para ninguém. |
| Lê a lista do cofre? | Lê nomes e quatro últimos caracteres (`GET /api/cofre`), como a tela. |
| Cria, lista ou revoga chaves de API? | Não. Recebe 403. Só a pessoa (senha do painel) ou quem administra a máquina. |
| Guarda uma chave com nome perigoso (`NODE_OPTIONS`, `LD_PRELOAD`)? | Não. As mesmas recusas da tela valem por API, com o motivo na resposta. |
| Uma chave de API de um agente funciona em outro? | Não. Cada painel guarda as suas. |
| O token da chave de API fica guardado? | Só o hash. O token aparece uma vez, na criação. |
| E o valor da chave de serviço? | Cifrado em repouso, em arquivo próprio, e some do arquivo quando a chave é revogada. |

## Quando passa pelo proxy (DG Claw Web)

Se o painel roda atrás do proxy que faz o login do dono, a chave de API continua
funcionando do mesmo jeito (cabeçalho `Authorization: Bearer`), desde que o endereço
usado chegue ao painel. Quem estiver logado pelo proxy gerencia as chaves de API
como o dono.
