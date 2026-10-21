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

```bash
curl -s -H "Authorization: Bearer $CHAVE" https://SEU-DOMINIO/api/v1/diagnostico
```

Um resumo legível, só com o que não está bem:

```bash
curl -s -H "Authorization: Bearer $CHAVE" https://SEU-DOMINIO/api/v1/diagnostico \
  | jq '.resumo.frase, (.verificacoes[] | select(.estado != "ok") | {id, estado, motivo, o_que_fazer})'
```

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
      "evidencia": { "horario": "2026-10-20T03:10:00Z", "codigo_saida": null, "trecho": "runner:login-expirado" },
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
| `evidencia` | `horario`, `codigo_saida` e `trecho` (poucas linhas, já higienizadas), ou `null` |
| `o_que_fazer` | A instrução para quem lê. Sempre presente quando o estado não é `ok` |
| `prompt_sugerido` | Texto para o cliente colar na conversa do Admin do DG Claw, em primeira pessoa, pedindo para conferir e consertar. `null` quando o conserto depende de uma ação do próprio cliente (como refazer o login) |

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

Tudo o que vem de log, arquivo ou comando passa por uma higienização antes de sair: segredos e dados de pessoas são
trocados por `[segredo oculto]`, caminhos de segredo por `[arquivo protegido]`, e os trechos são cortados. Os
arquivos dentro da casa de cada agente só são lidos se forem arquivos comuns que ficam dentro dela (um link que
aponte para fora é recusado) e só pelos campos permitidos.

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
