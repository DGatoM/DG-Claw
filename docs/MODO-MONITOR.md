# Modo monitor

Tarefa longa vira um card (uma sessão paralela do runner, aberta com `dgclaw-card abrir`). O modo
monitor vigia esses cards por você, sem gastar nada, e só acorda o agente quando acontece algo que
pede uma decisão.

## O que é e por que custa zero quando nada acontece

O monitor é o comando `dgclaw-monitor`, um script Python que não usa modelo nenhum. Um timer o
chama a cada 5 minutos. Ele pergunta ao runner local (`GET /api/agents?todas=1`) como está cada
card monitorado e compara com o que viu da última vez.

- Rodada sem evento: nenhuma chamada de modelo, nenhum texto digitado na sessão do agente, nada
  escrito no log. O agente nem fica sabendo que a rodada existiu.
- Sem nenhum card monitorado: o comando sai na hora, sem sequer falar com o runner.
- Com evento: uma única mensagem, no envelope `<plataforma recado="modo-monitor" ...>`, entra na
  sessão principal do agente (`POST /api/agents/<id>/input` com `injectWhenIdle`, então ela espera o
  agente terminar o que está fazendo). Só aí o modelo gasta alguma coisa.

## Comandos

```
dgclaw-monitor add <id> [--cada MIN] --entregue "<critério de entregue>"
dgclaw-monitor rm <id>
dgclaw-monitor list
dgclaw-monitor run [--dry]
dgclaw-monitor ajuda
```

- `add` confere no runner que o card existe antes de gravar. O padrão de `--cada` é 10 minutos.
  O critério de entregue é a frase que diz como saber que o card terminou.
- `rm` para de vigiar o card (o card continua aberto, só deixa de ser monitorado).
- `list` mostra id, título, intervalo, critério, último estado visto e a hora da última olhada.
- `run` é a rodada, o que o timer chama. Com `--dry` mostra o que faria, sem acordar ninguém,
  sem retomar card e sem gravar.

O jeito normal de ligar é já na hora de abrir o card:

```bash
dgclaw-card abrir --provedor codex --titulo "Relatório de vendas" \
  --pedido-arquivo /tmp/pedido.md \
  --monitor --entregue "o arquivo /home/agente/relatorio.md existe e tem as três seções" --cada 10
```

Com `--monitor`, o `--entregue` é obrigatório (sem ele o comando falha antes de abrir o card).
Se o card abrir e o monitor não ligar, a saída é 8: o card fica aberto e a mensagem traz o
comando para ligar à mão.

## Regras de evento

| Situação do card | O que o monitor faz |
|---|---|
| trabalhando (`working`, `spawning`) com atualização recente | silêncio |
| `pendingPermission` preenchido | acorda com o resumo do que ele pediu (vale em qualquer status) |
| parado (`idle`, `waiting_input`, `completed`, `stopped`) com `updatedAt` novo | acorda com um trecho da última mensagem do card |
| trabalhando sem atualizar há mais de 20 minutos | acorda uma vez por travamento |
| estava trabalhando e virou `resumable` | tenta `POST /resume` sozinho; só acorda se o resume falhar |
| `errored` | acorda com o erro |
| sumiu da lista | acorda uma vez e marca |
| runner fora por 3 rodadas seguidas | tenta acordar uma vez (com o runner fora a mensagem também não entra: fica no log e tenta de novo na rodada seguinte) |

Nunca acorda duas vezes pelo mesmo evento: cada evento tem uma assinatura (tipo, `updatedAt` e, nas
permissões, um resumo do pedido) guardada no estado. Vários eventos na mesma rodada viram uma
mensagem só. Cada card respeita o próprio `--cada`; o timer de 5 minutos só confere os que
venceram. Se a mensagem não entrar (por exemplo, o agente sem login), a assinatura não é gravada e
a rodada seguinte tenta de novo.

## Quem é acordado

A sessão principal do agente. O monitor decide assim:

1. `DGCLAW_MONITOR_DONO`, se estiver definida;
2. senão `DGCLAW_AGENTE_ID` (no agente, o id da sessão principal é o slug, e o runner já entrega
   essa variável à sessão e ao timer);
3. senão `admin` (no Admin, o runner chama a sessão principal de `admin`).

## O que o agente faz ao ser acordado

A mensagem diz, para cada card: o id, o título, o que aconteceu, o que ele pediu, a última fala
dele e o critério de entregue. O agente então:

1. avisa o dono pelo canal dele, em linguagem simples: "o card X parou por causa disto, ele pediu
   tal coisa, posso continuar?";
2. com o "pode" do dono, responde no card: `dgclaw-card mandar <id> "..."`;
3. se a entrega bateu o critério de entregue: confere o resultado, avisa o dono e roda
   `dgclaw-monitor rm <id>`;
4. se não há nada a fazer, fica quieto.

Permissão destrutiva só com o aval do dono. Ele também pode aprovar pela aba Sessões do painel.

## Arquivos

| O que | Agente | Admin |
|---|---|---|
| comando | `/opt/dgclaw/app/bin/dgclaw-monitor` (também em `/usr/local/bin`) | `/opt/dgclaw/app/bin/dgclaw-monitor` (fora do PATH) |
| timer | `dgclaw-<slug>-monitor.timer`, dentro do container | `dgclaw-admin-monitor.timer`, no servidor |
| estado | `$HOME/.dgclaw/estado/modo-monitor.json` | `/opt/dgclaw/admin/.dgclaw/estado/modo-monitor.json` |
| log | `$HOME/.dgclaw/logs/modo-monitor.log` | `/opt/dgclaw/admin/.dgclaw/logs/modo-monitor.log` |

O estado é gravado de forma atômica, com permissão 600. O log só ganha linha quando algo acontece
(cadastro, remoção, aviso entregue, resume, falha). O token do runner nunca aparece em nenhum dos
dois, nem na linha de comando.

`DGCLAW_MONITOR_ESTADO` e `DGCLAW_MONITOR_LOG` mudam os caminhos. `RUNNER_PORT` (padrão 4300) e
`RUNNER_TOKEN_FILE` seguem o mesmo padrão do `dgclaw-card`.

## Como desligar

- Um card: `dgclaw-monitor rm <id>`.
- O monitor inteiro de um agente: `systemctl disable --now dgclaw-<slug>-monitor.timer` (dentro do
  container).
- O do Admin: `systemctl disable --now dgclaw-admin-monitor.timer`.

Sem o timer, os cards continuam funcionando normalmente. Só deixam de ser vigiados.

## Limites conhecidos

- Card parado que o runner suspende por ociosidade vira `resumable`. Se o monitor nunca tinha visto
  o card parado (intervalo `--cada` maior que o tempo de suspensão), ele o confunde com um card que
  caiu e o retoma uma vez. Não perde nada, só acorda o card à toa.
- A rodada olha o que o runner informa. Um card que trava por dentro, sem o runner perceber, só
  aparece quando passa dos 20 minutos sem atualização.
