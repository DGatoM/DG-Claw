# runner

> Copiado do `apps/agent-runner` do DG AI Bunker em 12/10/2026 (retrato de 09/10, o que roda em
> produção). As seções sobre provisionar a partir de um card do Bunker e sobre o `agents-server`
> descrevem a origem; no DG Claw quem provisiona é o `dgclaw agente criar` (ver `docs/`).


O processo que **é** um agente entregue. Um por agente, com unidade systemd
própria (`dgclaw-agent-<slug>.service`) e `Restart=always`.

## Por que ele existe

Até 19/08/2026 a sessão viva de um agente entregue a um terceiro era um **card
do `bunker-server`**, ou seja, morava dentro do painel de trabalho do dono. Isso
trouxe três problemas, e os três são do mesmo tipo: o agente do cliente dependia
de uma coisa que não é dele.

1. **Todo restart do painel derrubava os agentes dos clientes.** Eles eram
   filhos daquele processo.
2. **Depois do restart o cofre volta trancado**, e com ele trancado toda a rota
   `/api/agents` responde `VAULT_LOCKED`: nenhum agente sobe, e só o dono
   destranca, com a senha mestra, quando aparecer.
3. **O DG Claw é um produto**, e ele tem que rodar na VPS do cliente, onde não
   existe Bunker nenhum para hospedar card.

O corte do cofre por lista (`AgentConfig.cofre`, commit `bfb08d9`) resolveu o
problema das chaves. Este runner resolve o da execução.

## O desenho

O runner é um **mini-Bunker de um agente só**: ele fala o MESMO protocolo HTTP e
WebSocket que o `bunker-server` fala, no subconjunto que um agente entregue usa.

```
agents-server (:4013) ─┐
painel DG Claw (:830x) ─┼─→ http://127.0.0.1:<porta do agente>  ─→  PTY do claude
rotinas (inject.py)   ─┘         (este processo)
```

Consequência prática, e o motivo da escolha: **quem consome não mudou de
vocabulário, só de endereço**. O `agents-server` reaproveita o mesmo
`BunkerClient`; o painel muda uma linha do `config.json` (`bunkerUrl`); as
rotinas mudam uma linha do `config.sh` (`DGCLAW_BUNKER_URL`).

### O que ele implementa

| Rota | Para quê |
|---|---|
| `GET /api/agents` | a lista (com um item só) |
| `GET /api/agents/:id` | o estado |
| `POST /api/agents/:id/input` | digitar (`submit`, `injectWhenIdle`) |
| `POST /api/agents/:id/resume` | acordar o terminal caído, MESMA conversa |
| `POST /api/agents/:id/revive` | conversa nova, guardando a anterior |
| `DELETE /api/agents/:id/remove` | encerra o terminal (não apaga nada do disco) |
| `GET /api/agents/:id/conversation` | as últimas mensagens |
| `POST /api/agent-hook` | o hook de status, chamado pelo próprio agente |
| `GET /api/saude` | está de pé? tem PTY? em que sessão? |
| `ws://.../ws` | `full_sync`, `agent_update`, `terminal_data`, `terminal_input` |

### O que ele NÃO tem, de propósito

Cofre, criação de agente, projetos, worktree, board, handoff, codex. Tudo isso é
do Bunker. Rota que não existe responde 404 **com o motivo**, não com 500.

## Sessões paralelas

Além da principal (a conversa do cliente, que sobe no boot, nunca dorme e nunca é
barrada), o descritor pode declarar sessões paralelas: outras conversas do MESMO
agente (mesma casa, mesmo HOME, mesmo login), cada uma com PTY, sessionId, nonce,
settings de hooks e `runner-state.json` próprios
(`<pasta do descritor>/sessoes/<id>/runner-state.json`). A primeira é a de
`bastidores`: o canto escondido onde o dono conserta coisas. Tudo passa pela
MESMA porta (o container publica uma só).

Campos novos do `runner.json`, todos opcionais: `chatPrincipal` (padrão
`c_<slug>`), `notasPrincipal` (padrão `.plataforma/bastidores/notas.jsonl`),
`capacidade { gbPorSessao = 0.4, reservaGb, avisoFaltando = 0 }`, `config.promptHooks`
(comandos extras do UserPromptSubmit) e `sessoes[] { id, tipo, chat, slug?,
identidade?[], ociosoMinutos = 20, envExtra?, allowTools?, promptHooks? }`. Sessão
inválida é registrada no log e pulada; a principal sobe do mesmo jeito. Sem
`sessoes`, o runner se comporta como antes.

Rotas: as de sempre valem por id (`/api/agents/<id>/...`). Novas:
`GET /api/agents?todas=1` (todas, com o campo `sessao`), `POST /api/agents/<id>/suspend`
(só paralelas; na principal responde 409 `PRINCIPAL_NAO_SUSPENDE`),
`GET /api/capacidade`, e `ws://.../ws?sessao=<id>`. `/ws` sem parâmetro continua
vendo só a principal. Um `POST /input` para paralela dormindo a acorda e enfileira o
texto (202 `acordando:true`).

Capacidade: o teto de conversas acordadas vem do limite de memória do container
(`memory.max` do cgroup, com 25% de reserva) ou, fora de container, do
`MemAvailable` do host (reserva de 2 GB). Sem vaga, a paralela não acorda: 503
`SEM_CAPACIDADE` e o texto NÃO é guardado. Perto do teto (ou numa recusa) o runner
anota um aviso no arquivo de notas da principal, no máximo a cada 30 min.

Suspensão: a cada 60 s, paralela em `idle`, com fila vazia e parada além de
`ociosoMinutos`, é suspensa (`resumable`; a conversa continua no disco e o próximo
input a acorda com `--resume`). `working`, `waiting_input` e `spawning` nunca são
suspensas. A fila de ocioso agora é FIFO (antes o segundo texto apagava o primeiro).

## Os arquivos de um agente

```
/etc/dgclaw/agents/<slug>.env          o COFRE dele (modo 600). O que está aqui
                                       entra no ambiente do claude, e nada mais.
<casa>/.plataforma/runner.json         o QUE ele é (id, slug, AgentConfig).
                                       Escrito pelo provisionamento; só leitura.
<casa>/.plataforma/runner-state.json   o que ele VIVEU (sessão atual e anterior).
                                       Escrito só pelo runner.
<casa>/.plataforma/runner-hooks/       handler e settings de hook por spawn.
/var/log/dg-bunker/runner-<slug>.log   o log (RUNNER_LOG_DIR muda a pasta).
```

A separação entre `runner.json` e `runner-state.json` não é organização: quem
provisiona reescreve o descritor, e se o `sessionId` morasse lá o agente
perderia a conversa inteira no próximo restart, sem erro nenhum no caminho.

## Provisionar

```bash
node scripts/provisionar-runner.mjs --agente <id do card> --porta 4311
```

Ele lê a configuração REAL do card no Bunker (nunca um chute), escreve os quatro
arquivos e **imprime a ordem da troca**. Não liga nem desliga nada: o card
precisa morrer antes de o runner subir, porque dois processos na mesma sessão
corrompem o transcript, e essa ordem pede uma mão humana.

## Operar

```bash
systemctl status dgclaw-agent-<slug>
journalctl -u dgclaw-agent-<slug> -n 50
curl -s --noproxy '*' 127.0.0.1:<porta>/api/saude
tail -f /var/log/dg-bunker/runner-<slug>.log
```

## Auto-compact: como o poke de retomada chega aqui

**Hoje os agentes entregues NÃO rodam auto-compact.** O `auto-compact.py` pode
estar instalado na casa deles, mas sem timer e sem cron: script inerte. Esta
seção existe para o dia em que alguém ligar, e para essa pessoa não descobrir na
marra o que segue.

O auto-compact pode compactar **no meio de uma tarefa** (é deliberado, no nível
crítico), e por isso ele manda um *poke* devolvendo a tarefa à persona. Num
agente do runner esse poke não tem transporte nenhum por conta própria: aqui não
existe Bunker, não existe tmux e o TIOCSTI está morto. Duas coisas resolvem:

### Qual modo NÃO usar: `restart`

```sh
# NÃO faça isto. Ver o porquê abaixo.
DGCLAW_COMPACT_MODE=restart
```

O modo `restart` do auto-compact existe para os agentes cujo launcher sobe
`claude --channels` **sem `--resume`**: lá, derrubar e subir devolve a sessão
history-zero, e é isso que compacta. **No runner essa premissa é falsa.** O boot
chama `subir("retomar")` (`src/index.ts`) e, havendo sessão registrada, monta
`--resume <sessionId>` (`src/sessao.ts`). Confirmado nos processos vivos: os
agentes entregues rodam `claude --resume <id>`, e esses ids são os transcripts
que estão crescendo.

Consequência de ligar `restart` aqui: o terminal do cliente morre e a sessão
volta **com o mesmo contexto**. Custo alto, benefício zero.

O modo conceitualmente certo é o `inject` (mandar um `/compact` de verdade para a
sessão viva). O que fazia o `inject` não servir neste host era só o transporte:
sem TIOCSTI, sem tmux e sem Bunker. Mas o runner **tem** transporte, e melhor que
os três: o `POST /api/agents/:id/input` escreve direto no PTY do qual ele é dono,
e um slash-command digitado no terminal EXECUTA (diferente de mensagem de canal,
que chega como texto). Falta só o lado do plugin aceitar um transporte de host
para o compact, uma env irmã da `DGCLAW_RESUME_POKE_CMD` (algo como
`DGCLAW_INJECT_CMD`), que **ainda não existe**. Enquanto não existir, não há modo
de auto-compact que sirva a um agente do runner.

```sh
# Um agente entregue, na porta dele. O envelope <plataforma recado="..."> é cheio
# de aspas duplas, então usar {text_json}, que já entrega a string JSON escapada.
# Troque <porta> pela porta do runner e <id-do-agente> pelo id do card.
DGCLAW_RESUME_POKE_CMD='curl -sf --noproxy "*" -X POST 127.0.0.1:<porta>/api/agents/<id-do-agente>/input -H "Content-Type: application/json" -d "{\"text\": {text_json}}"'
```

Versão à prova de aspas, que não depende de template de shell (usa a env que o
auto-compact exporta):

```sh
DGCLAW_RESUME_POKE_CMD='jq -n --arg t "$DGCLAW_POKE_TEXT" "{text:\$t}" | curl -sf --noproxy "*" -X POST 127.0.0.1:4311/api/agents/<id>/input -H "Content-Type: application/json" --data-binary @-'
```

Quatro coisas que não podem ser trocadas por engano:

- **`{text_json}`, não `{file}`.** O `{file}` é o caminho de um arquivo de ~30
  linhas em texto puro; mandá-lo com `--data-binary @{file}` põe texto cru onde o
  runner espera JSON.
- **O `-f` do `curl` não é enfeite.** Sem ele o `curl` sai 0 mesmo quando o
  runner devolve 500, e aí o auto-compact entende que entregou, apaga o poke
  pendente e nunca mais tenta. Perdeu o envio uma vez, calou para sempre. Com
  `-f` ele sai diferente de zero, o poke continua pendente e sai no ciclo
  seguinte.
- **NADA de `injectWhenIdle: true` aqui.** Isto estava recomendado e era o
  contrário do certo. A fila de ocioso tem UMA VAGA (`promptQuandoIdle` em
  `sessao.ts`) e cada novo enfileiramento apaga o anterior sem dizer nada: um cron
  que dispare no intervalo atropela o poke, e o `curl` devolve 200 do mesmo jeito.
  O `/compact` pode viver com isso, porque se repete a cada ciclo e um despejo se
  cura sozinho. O poke dispara UMA VEZ, então despejo ali é perda definitiva, e o
  agente fica esperando calado, que é a mesma assinatura da trava de 8 dias de
  um agente de cliente em setembro. Também é redundante: o auto-compact só escreve na sessão depois de já ter
  decidido que ela está ociosa.
- **O `text` é uma linha só** (`leia <caminho do poke> e execute`). O conteúdo
  pesado fica no arquivo, que a persona lê com a própria ferramenta.

## Armadilhas já pagas

- **`--resume` de uma sessão sem transcript no disco sai com código 1 em ~2s.**
  O runner detecta (a queda dentro de 15s de uma retomada), sobe uma sessão NOVA
  para o agente não ficar mudo, guarda a que não abriu em `previousSessionId` e
  **grita no log**. Sem esse ramo o agente ficaria `resumable` para sempre, e o
  `Restart=always` não ajudaria: quem está de pé é o runner, não o PTY.
- **O transcript de uma sessão nova demora a ser descarregado no disco.** Nos
  primeiros minutos, `--resume` daquela sessão ainda falha. É o caso acima.
- **`409 NO_PTY` não pode virar 503.** O painel do DG Claw separa "não alcancei a
  plataforma" de "o terminal caiu", e só o segundo mostra o botão de acordar.
  Responder o código errado esconde o botão exatamente quando ele é necessário.
- **O `snapshot` do watcher do agents-server é tratado como lista COMPLETA.** Por
  isso `backends.ts` nunca repassa snapshot de runner como snapshot: vira evento
  `agent`, um por agente. Repassar apagaria do banco todos os cards do Bunker.
- **O mesmo agente no Bunker E no runner** é o pior estado possível (dois PTYs na
  mesma conversa). O `backends.ts` detecta e loga como erro.
- **O `Stop` tem DOIS hooks em série**, nesta ordem: primeiro o `runner-hook.mjs`
  (o status), depois cada comando de `config.stopHooks` (no caso dos agentes de
  canal, o `stop-force-reply.py`). É a mesma ordem que o Bunker usava. Se um dia
  o segundo bloquear sem motivo aparente, lembrar que o primeiro roda antes.
- **Recado de operação mandado à mão precisa de envelope.** O `stop-force-reply.py`
  distingue a fala da PESSOA (`<dgchat `) do recado da PLATAFORMA (`<plataforma `,
  o `envelope()` do poker.ts). Um texto cru enviado por `curl` no `/input` não é
  nenhum dos dois, então o hook o trata como a pessoa falando e cobra a resposta
  pela tool. Aconteceu na migração de 20/08: o recado "você saiu do Bunker" foi
  injetado pelado, e o agente reclamou do hook. O hook estava certo.
