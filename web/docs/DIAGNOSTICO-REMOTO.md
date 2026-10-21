# Diagnóstico remoto

Uma rota só de leitura que mostra o estado de tudo o que precisa estar vivo no DG Claw: os serviços da
máquina, o disco, a memória, a versão, o Admin e cada agente (container, sessão, login, canais, rotinas e
memória). Cada item parado vem com o motivo e com o que fazer. Quem dá suporte consulta essa rota com uma
chave própria, sem precisar de senha da máquina e sem poder mexer em nada.

## Para que serve

- O suporte vê o que quebrou antes de pedir qualquer coisa ao cliente.
- O cliente recebe a instrução pronta, ou um texto para colar na conversa do Admin, que conserta.
- A chave só lê o estado de saúde. Ela não lê conversas, memória, cofre nem arquivos, e não opera nada.

## Autenticação

- Cabeçalho `Authorization: Bearer dgc_...` com uma chave de escopo `diagnostico`.
- Essa chave só vale para `GET` e `HEAD` em `/api/v1/diagnostico`. Qualquer outra rota ou método com a chave
  recebe `403` com o motivo.
- Chave ausente, errada ou revogada recebe `401`. Muitas tentativas inválidas seguidas do mesmo IP recebem `429`.
- Quem está logado no painel (o dono) também pode abrir a rota e vê exatamente o mesmo que o suporte vê.
- `GET /api/v1/diagnostico/docs.md` (este documento) é público: não traz dado nenhum da máquina.

## Criar e revogar a chave

Pela tela: menu **Suporte remoto**, botão de criar chave. O valor aparece uma vez só, com o botão Copiar.

Pelo servidor:

```bash
sudo dgclaw chave-api criar --escopo diagnostico --nome "Suporte DG"
sudo dgclaw chave-api listar
sudo dgclaw chave-api revogar <id>
```

O cliente revoga quando quiser, pela mesma tela ou pelo comando. Revogada, a chave para de funcionar na hora e o
registro dela continua na lista, com a data.

## Exemplo

Guarde o token num arquivo só seu (`chmod 600 ~/.config/dgclaw-suporte/token-cliente`) e mande o cabeçalho pela
entrada padrão do curl. Assim o token não aparece nos argumentos do processo, que qualquer usuário da máquina
enxerga com `ps`. O `printf` é um comando interno do shell e o `cat` só recebe o nome do arquivo, então a chave
nunca vai parar na lista de processos:

```bash
printf 'Authorization: Bearer %s\n' "$(cat ~/.config/dgclaw-suporte/token-cliente)" \
  | curl -sS --fail-with-body -H @- https://SEU-DOMINIO/api/v1/diagnostico
```

Um resumo legível, só com o que não está bem:

```bash
printf 'Authorization: Bearer %s\n' "$(cat ~/.config/dgclaw-suporte/token-cliente)" \
  | curl -sS --fail-with-body -H @- https://SEU-DOMINIO/api/v1/diagnostico \
  | jq '.resumo.frase, (.verificacoes[] | select(.estado != "ok") | {id, estado, motivo, o_que_fazer})'
```

Outra forma é um arquivo de cabeçalho com permissão 600 (`Authorization: Bearer dgc_...` numa linha só) e
`curl -sS --fail-with-body -H @arquivo-do-cabecalho https://SEU-DOMINIO/api/v1/diagnostico`. Use sempre `https://`:
com `http://` a chave passaria aberta pela rede.

## Formato da resposta

```json
{
  "ok": true,
  "schema": 1,
  "gerado_em": "2026-10-21T12:00:00Z",
  "duracao_ms": 840,
  "versao": {
    "instalada": "1.0.0", "commit": "5745089", "publicada": "1.0.1",
    "atualizacao_disponivel": true, "commits_a_frente": 4, "verificado_em": "2026-10-21T06:54:14Z"
  },
  "resumo": {
    "estado": "quebrado",
    "frase": "1 item quebrado e 2 pedindo atenção.",
    "contagem": { "ok": 30, "atencao": 2, "quebrado": 1, "nao_medido": 3 }
  },
  "verificacoes": [
    {
      "id": "agente.tina.login", "grupo": "agente", "alvo": "tina",
      "nome": "Login do Claude do agente Tina",
      "estado": "quebrado",
      "ultimo_sinal": "2026-10-20T03:10:00Z",
      "motivo": "O login do Claude expirou em 20/10 às 00h10 e o agente Tina parou de responder.",
      "evidencia": { "horario": "2026-10-20T03:10:00Z", "codigo_saida": null, "sinal": "runner:login-expirado", "ocorrencias": null },
      "o_que_fazer": "Abra a conversa do agente Tina no painel do DG Claw e refaça o login do Claude.",
      "prompt_sugerido": null
    }
  ]
}
```

Campos de cada verificação:

| Campo | O que é |
|---|---|
| `id` | Identificador estável, na forma `grupo.alvo.coisa` (tabela abaixo) |
| `grupo` | `maquina`, `versao`, `admin` ou `agente` |
| `alvo` | O agente de que o item trata, ou `null` |
| `nome` | Nome para ler, em português |
| `estado` | `ok`, `atencao`, `quebrado` ou `nao_medido` |
| `ultimo_sinal` | Quando houve o último sinal de vida do item (ISO 8601), ou `null` |
| `motivo` | Por que não está bem. Sempre presente quando o estado não é `ok` |
| `evidencia` | `horario`, `codigo_saida`, `sinal` e `ocorrencias`, ou `null` (veja abaixo). Nunca traz linha de log |
| `o_que_fazer` | A instrução para quem lê. Sempre presente quando o estado não é `ok` |
| `prompt_sugerido` | Texto para o cliente colar na conversa do Admin do DG Claw, em primeira pessoa, pedindo para conferir e consertar. `null` quando o conserto depende de uma ação do próprio cliente (como refazer o login) |

### A evidência

- `sinal`: uma frase fixa escrita pelo diagnóstico (por exemplo `timer inactive` ou `conmon morto com o container
  marcado como running`), ou `null`. Só leva valores conferidos contra listas fechadas, como o estado do systemd.
- `ocorrencias`: quando a causa aparece num log, o diagnóstico não devolve a linha. Ele **classifica** as linhas de
  erro e devolve só a categoria, quantas vezes apareceu e quando foi a última vez:

  ```json
  "ocorrencias": [
    { "categoria": "permissao_negada", "frase": "permissão negada", "quantidade": 3, "ultima_em": "2026-10-21T10:00:20Z" }
  ]
  ```

  As categorias (e as frases fixas) são `permissao_negada` ("permissão negada"), `arquivo_ausente` ("arquivo ou pasta
  não encontrado"), `disco_cheio` ("sem espaço em disco"), `tempo_esgotado` ("tempo esgotado"), `rede` ("falha de
  rede ou DNS"), `login` ("credencial recusada ou login expirado"), `limite` ("limite de uso ou 429"),
  `comando_ausente` ("comando não encontrado"), `python_excecao` ("exceção Python", com o nome da classe só quando
  ele tem o formato `NomeError` ou `NomeException`), `memoria` ("sem memória / killed") e `outro` ("erro não
  classificado"). `ultima_em` é `null` quando o log não traz horário com fuso.
- `codigo_saida`: o código de saída do processo (0 a 255) ou o código HTTP, quando existe.

O resumo é `quebrado` se algum item estiver quebrado. Senão é `atencao` se algum item pedir atenção, ou se nada
pôde ser medido. Senão é `ok`.

## Regra do `null` e do `nao_medido`

`nao_medido` quer dizer "não consegui ver", e nunca quer dizer "está bom". Acontece quando o arquivo não existe,
quando o JSON está inválido, quando o comando não respondeu em 5 segundos ou quando o container está parado e por
isso não dá para olhar lá dentro. O motivo diz qual foi o caso. Do mesmo jeito, no bloco `versao`, `null` é "não
medi" e nunca é zero: `atualizacao_disponivel: null` é diferente de `false`.

## O que cada id mede

| Id | O que mede |
|---|---|
| `maquina.servico.caddy`, `.dgclaw-web`, `.dgclaw-admin`, `.dgclaw-firewall` | Se o serviço do systemd está ativo; se não está, o resultado e o código de saída |
| `maquina.timer.dgclaw-admin-monitor`, `.dgclaw-checar-atualizacao` | Se o timer está ativo e se a última execução deu certo e está em dia |
| `maquina.disco` | Uso de `/` e da pasta de dados: mais de 85% é atenção, mais de 95% é quebrado |
| `maquina.memoria` | Memória disponível: menos de 10% é atenção, menos de 5% é quebrado |
| `maquina.reinicio` | Se a máquina reiniciou nas últimas 24 horas (informativo: é quando containers ficam parados) |
| `maquina.registro` | Só aparece se a lista de agentes não pôde ser lida |
| `versao` | Versão instalada e se há atualização disponível (`docs/ATUALIZAR.md`) |
| `admin.sessao` | O Admin: runner, sessão viva e login |
| `agente.<slug>.container` | O container no podman: rodando, parado, e se o processo conmon que o sustenta está vivo |
| `agente.<slug>.sessao` | O runner e a sessão do Claude: viva, parada ou parecendo travada (30 minutos trabalhando sem escrever nada) |
| `agente.<slug>.login` | Se a conta do Claude está conectada, expirou ou foi recusada |
| `agente.<slug>.saude_resposta` | O vigia da sessão (watchdog): recusa, limite, sobrecarga, contexto cheio, sem resposta e outros |
| `agente.<slug>.canal.painel` | Se a conversa pelo painel está alcançável |
| `agente.<slug>.canal.telegram` | Telegram ligado ou desligado e se o canal está respondendo. Desligado é `ok` e não é defeito |
| `agente.<slug>.canal.whatsapp` | WhatsApp ligado ou desligado, estado da conexão e se a ponte está de pé |
| `agente.<slug>.cron.<nome>` | Uma por rotina automática do agente (reflexão noturna, batimento, vigia, compactação e as próprias do agente): ligada, última execução, atraso |
| `agente.<slug>.cron` | Aparece no lugar das anteriores quando nenhuma rotina foi encontrada ou não deu para listá-las |
| `agente.<slug>.memoria.injecao` | Falhas das últimas 24 horas ao colocar a memória na conversa |
| `agente.<slug>.memoria.working_memory` | Se a memória de trabalho existe, cabe no teto e foi remontada hoje |
| `agente.<slug>.compactacao` | Estado da compactação automática da conversa |

## O que NUNCA sai na resposta

- Chaves, tokens, senhas, cookies e o conteúdo do cofre.
- Conversas, memória, nomes de contatos, números de telefone e e-mails.
- Caminhos de arquivos de segredo e mensagens cruas de erro do sistema.
- **Nenhuma linha de log.** Nem do journal, nem dos logs da memória, nem do registro do pulso, nem a saída de erro
  de um comando. Filtro por padrão não garante sigilo (um cabeçalho, um nome ou uma frase do cliente passam por
  qualquer lista de padrões), então o diagnóstico só devolve a categoria do erro, a contagem e o horário.

Todo valor que vem de fora do código (saída do `systemctl`, arquivos da casa do agente, respostas do runner, estado
do WhatsApp, arquivo do vigia) só entra na resposta depois de conferido contra uma lista fechada ou um formato
estrito: estados do systemd, resultados, códigos de saída de 0 a 255, datas que de fato se leem, nomes de unit no
formato `dgclaw-...`, motivos conhecidos do runner. Valor fora da lista vira `desconhecido`, e o item mostra "o
sistema devolveu um valor inesperado" em vez do valor. Os campos `motivo`, `o_que_fazer` e `prompt_sugerido` são
montados só com frases fixas do código e esses valores conferidos, e o `prompt_sugerido` identifica o agente pelo
slug. Assim texto escrito dentro de um container nunca chega a um prompt que o dono cola na conversa do Admin.
Por fim, o texto lido de fora tem tamanho máximo antes de qualquer análise (1000 caracteres por linha), para que
um arquivo gigante não trave o painel. Os arquivos dentro da casa de cada agente só são lidos se forem arquivos
comuns que ficam dentro dela (um link que aponte para fora é recusado) e só pelos campos permitidos.

## Limites

- A resposta fica em cache por 20 segundos. Pedidos feitos ao mesmo tempo dividem a mesma coleta.
- Cada verificação tem 5 segundos para responder. Se estourar, o item vira `nao_medido` e as outras seguem. A coleta
  inteira leva poucos segundos.
- Tentativas com chave inválida são limitadas por IP (`429`).
- Erro interno responde `500` com o motivo em português. O detalhe fica no log do serviço (`journalctl -u dgclaw-web`).

## Rede

Na instalação padrão o Caddy já repassa essa rota para o painel, junto com o cabeçalho `Authorization`, e não é
preciso mudar nada. Se existir um porteiro na frente (Cloudflare Access ou outro), crie uma regra de bypass só
para o caminho `/api/v1/diagnostico`. A chave continua protegendo a rota.
