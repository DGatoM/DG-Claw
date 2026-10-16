# EMERGÊNCIA: o agente parou ou está estranho

> Manual para o CLAUDE executar (o Admin ou a sessão de socorro), não para um humano ler
> inteiro. Quem chama é o dono do agente, geralmente leigo, dizendo "aconteceu alguma coisa
> com o meu agente, vê aí". Siga a ordem. Os comandos e caminhos daqui foram conferidos no
> código do DG Claw v1. Se um nome não existir na máquina, NÃO invente outro: diga o que
> achou e o que esperava achar.

## 0. Regras do socorro (valem para tudo abaixo)

1. **Diagnóstico é de graça, conserto se pergunta.** Ler log, status e arquivo: pode sempre.
   Reiniciar, trocar arquivo, apagar, logar de novo: explique em UMA frase e pergunte "posso?".
2. **Nada se apaga.** O que sai do caminho é MOVIDO para um nome com data
   (`<arquivo>.antes-socorro-AAAAMMDD-HHMM`). Antes de editar config ou memória, copie.
3. **Erro 529, "overloaded" ou "server_error": NÃO reinicie.** É a Anthropic sobrecarregada.
   Reiniciar zera o cache da conversa e o próximo turno sai mais caro e mais lento. Espere 5 a
   15 minutos e teste de novo.
4. **Limite de uso da assinatura ("usage limit", "limit reached", "resets ..."): NÃO reinicie.**
   Nada conserta antes do horário que a mensagem diz. Explique e diga a hora.
5. **Nunca faça login com a sessão do agente de pé.** Dois `claude` na mesma casa estragam a
   conversa do agente. Pare o runner dele antes (seção 3.4).
6. **Nunca remova o container do agente** (`podman rm`, `dgclaw agente remover`) para "limpar".
   A conversa, a memória e o login ficam na casa do agente, mas remover derruba a rede, as
   portas e o registro dele. Para desligar, use `dgclaw agente parar <slug>`.
7. **Uma mudança por vez.** Mudou, conferiu (seção 5), só então a próxima.

## 0.1 Onde você está

O manual foi escrito para quem está **no servidor** (o Admin, ou alguém num terminal como
root). A sessão de socorro do painel roda **dentro do container do agente**, como o usuário
`agente`. Confira antes do primeiro comando:

```bash
command -v podman dgclaw || echo "dentro do container"
```

Dentro do container não existem `podman`, `dgclaw` nem `sudo`. Traduza assim:

| No servidor | Dentro do container |
|---|---|
| `$H/...` (a casa vista de fora) | `/home/agente/...` |
| `curl -s http://127.0.0.1:$PORTA/api/saude` | `curl -s http://127.0.0.1:4300/api/saude` |
| `podman exec $C systemctl ...` e `podman exec $C journalctl ...` | o mesmo `systemctl` ou `journalctl`, sem o `podman exec $C` (só leitura; reiniciar unidade pede root, que você não tem) |
| `modo-seguro.sh` pelo `podman exec` (3.6) | `bash /opt/dgclaw/app/scripts/modo-seguro.sh /home/agente/.dgclaw/config.sh --motivo "..." --origem manual --dry-run` |
| `dgclaw agente reiniciar $SLUG` (3.7) | `python3 /opt/dgclaw/app/scripts/_lib/reinicio.py normal --origem manual --json` (volta na mesma conversa) |

O que só se resolve no servidor (container desligado, login pelo terminal, Caddy, DG Claw Web,
imagem, firewall): explique ao dono o que achou e diga que quem cuida do servidor precisa agir,
com o comando da seção correspondente. Se o container estivesse desligado, aliás, esta sessão
nem abriria: ela roda dentro dele.

## 1. Descobrir qual é o agente

```bash
dgclaw agente listar
podman ps -a --filter name=dgclaw- --format '{{.Names}} {{.Status}}'
```

O `listar` mostra uma linha por agente: `SLUG`, `NOME`, `PROVEDOR`, `CONTAINER` (estado do
container: `running`, `exited` ou `ausente`), `PORTA` (a do runner no servidor) e `SAUDE`
(`ok`, `sem resposta` ou `-` quando o container não está ligado).

Se houver mais de um agente, pergunte ao dono qual (pelo nome que ele usa, não pelo slug).
Guarde, trocando `meuagente` pelo slug:

```bash
SLUG=meuagente
C=dgclaw-$SLUG                       # nome do container
CASA=/var/lib/dgclaw/agentes/$SLUG   # a casa do agente, vista do servidor
H=$CASA/home                         # dentro do container isso é /home/agente
PORTA=<a coluna PORTA do dgclaw agente listar>
```

O **Admin** (o agente de sistema, que roda direto no servidor e não em container) não aparece
no `listar` como container. Se o problema é com ele, vá à seção 2.2.

## 2. O mapa: cada peça, como checar em um comando, o normal e o quebrado

O caminho de uma mensagem do dono é: navegador, depois o **Caddy** (porta 443, HTTPS), depois o
**DG Claw Web** (127.0.0.1:8300), depois o **container do agente** (porta publicada só em
127.0.0.1, a partir da 4311), onde o **runner** (porta 4300 lá dentro) é o dono do `claude`.
Uma visão geral de tudo de uma vez:

```bash
dgclaw status
```

Ele confere o domínio, os serviços `caddy`, `dgclaw-web` e `dgclaw-admin`, o Web em
127.0.0.1:8300, o Admin em 127.0.0.1:4300, a imagem, as cadeias de firewall `DGCLAW_HOST` e
`DGCLAW_EGRESS` e cada agente. Linha `FALHOU` é essencial fora do ar; linha `aviso` é
atenção. Ele sai com erro se algo essencial caiu.

### 2.1 Peças do servidor (uma só para todos os agentes)

| Peça | Checar | Normal | Quebrado |
|---|---|---|---|
| **Caddy** (HTTPS) | `systemctl is-active caddy` | `active` | `failed`: o site não abre. Motivo: `journalctl -u caddy -n 30 --no-pager` |
| **DG Claw Web** (login, chat, painéis em `/p/<slug>/`) | `systemctl is-active dgclaw-web` e `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8300/` | `active` e um código HTTP (200 ou 302) | `failed`, ou o `curl` sem resposta. Motivo: `journalctl -u dgclaw-web -n 50 --no-pager` |
| **Admin** (agente de sistema, roda como root em `/opt/dgclaw/admin`) | `systemctl is-active dgclaw-admin` e `curl -s http://127.0.0.1:4300/api/saude` | `active` e um JSON com `"ok":true` | `failed` ou sem resposta. Logs: `journalctl -u dgclaw-admin -n 50 --no-pager` e `/var/log/dgclaw/admin-runner.log` |
| **Imagem dos agentes** | `dgclaw imagem status` | "imagem dos agentes pronta" | construindo ou falhou: `tail -n 30 /var/log/dgclaw/imagem.log` |
| **Firewall dos containers** | `systemctl is-active dgclaw-firewall` | `active` | `failed`: reaplique com `bash /opt/dgclaw/app/lib/firewall.sh` (com o "posso?") |

### 2.2 Peças de cada agente (uma por container)

| Peça | Checar | Normal | Quebrado |
|---|---|---|---|
| **Container** | `podman inspect -f '{{.State.Status}}' $C` | `running` | `exited` ou erro "no such container" |
| **Runner** (dono do `claude`, dentro do container) | `podman exec $C systemctl is-active dgclaw-runner` | `active` | `inactive`, `failed`, ou subindo e caindo |
| **Saúde da sessão** | `curl -s http://127.0.0.1:$PORTA/api/saude` | `"status":"idle"` (ou `"working"` com `ultimaSaidaEm` recente) e `"ptyVivo":true` | `"working"` com `ultimaSaidaEm` de horas atrás (travado), `"errored"`, `"ptyVivo":false` |
| **Log do runner** | `tail -n 30 $H/.dgclaw/logs/runner.log` | trocas `working` para `idle` | só "enfileirados para quando ficar ocioso" por horas; ou a frase "ainda não fez login" |
| **Painel do agente** (a tela do dono, em `/p/$SLUG/`) | `podman exec $C systemctl is-active dgclaw-painel` | `active` | `inactive`: a tela não abre, mas o agente pode seguir funcionando. Log: `podman exec $C journalctl -u dgclaw-painel -n 40 --no-pager` |
| **Tarefas agendadas** (reflexão, batimento, compactação etc.) | `podman exec $C systemctl list-timers --no-pager` | os `dgclaw-$SLUG-*` com `NEXT` preenchido | timer ausente ou sem `NEXT` |

O `/api/saude` do runner é a fonte da verdade da sessão e não pede senha. Estados possíveis:
`spawning` (subindo), `idle` (esperando o dono), `working` (pensando), `waiting_input`,
`stopped`, `resumable` e `errored`. As rotas `/status` e `/health` não existem no runner.

### 2.3 O diagnóstico do último turno

O script `scripts/_lib/saude_sessao.py` lê o fim do transcript e diz se o ÚLTIMO turno do
agente foi normal. Devolve `estado` (ativo, atencao, inativo, indeterminado), `tipo` (ok,
recusa, login, limite, sobrecarga, contexto, sem_resposta, erro_api, sessao_caida), uma
`frase` para leigo e a `recomendacao` (nada, esperar, reiniciar, modo_seguro, refazer_login).
É o atalho da seção 3.3. Roda do servidor sobre o transcript do agente:

```bash
F=$(ls -t $H/.claude/projects/-home-agente/*.jsonl | head -1)
python3 /opt/dgclaw/app/scripts/_lib/saude_sessao.py --json --jsonl "$F" --sem-checar-vida
```

Detalhe de cada tipo em `docs/SAUDE-E-MODO-SEGURO.md`.

## 3. Árvore "parou de responder" (na ordem; pare no primeiro que explicar)

### 3.1 O site abre?
- O dono não consegue abrir o endereço: `dgclaw status`. Se `caddy` ou `dgclaw-web` aparecem
  como `FALHOU`, vá à tabela 2.1 e leia o log da peça. Com o "posso?":
  `systemctl restart caddy` ou `systemctl restart dgclaw-web`. Reiniciar o Web não derruba
  nenhum agente.
- Abre, mas pede senha e não aceita: a senha do painel se troca com
  `printf '%s\n' "senha nova" | dgclaw senha trocar` (a senha nova vem pela entrada padrão;
  nunca a escreva no chat).
- Abre, mas só a tela do agente (`/p/$SLUG/`) não carrega: container ou painel do agente
  (seções 3.2 e a linha "Painel do agente" da tabela 2.2).

### 3.2 O agente aparece e o container está de pé?
```bash
dgclaw agente listar
```
- `CONTAINER` em `exited` ou `ausente`: com o "posso?", `dgclaw agente iniciar $SLUG`. Isso
  liga o container de novo e reaplica o firewall. Se o container está `ausente` e a casa
  existe, não recrie sozinho: diga ao dono o que viu e peça a decisão (recriar é
  `dgclaw agente criar $SLUG ...` com os mesmos dados, e rodar de novo continua de onde parou).
- `CONTAINER` em `running` e `SAUDE` em `sem resposta`: o runner de dentro não responde. Veja o
  log (`podman exec $C journalctl -u dgclaw-runner -n 40 --no-pager`). Com o "posso?":
  `dgclaw agente reparar $SLUG` refaz só a parte de dentro (tarefas agendadas, runner e painel) e
  espera o `/api/saude` responder. Erro que cita a imagem: `dgclaw imagem construir --agora`.
- `running` e `ok`: o container e o runner estão bem. Siga para 3.3.
- Saiu com código 255 logo na partida, sem log (`dgclaw agente iniciar` já explica): falta
  inotify. Cada agente gasta de 5 a 6 instâncias do root e o padrão do Ubuntu é 128. Veja o uso
  com `dgclaw status`, suba o limite com `sysctl -w fs.inotify.max_user_instances=1024` (o
  instalador grava `/etc/sysctl.d/90-dgclaw-inotify.conf`) e rode `dgclaw agente iniciar $SLUG`.
- O container sobe e cai logo: `podman logs --tail 40 $C` mostra o motivo. Imagem faltando:
  `dgclaw imagem status`.

### 3.3 O ÚLTIMO turno foi erro? (a causa mais comum de "de pé e mudo")
Primeiro rode o `saude_sessao.py --json` (2.3) e siga a `recomendacao`, que segue a tabela
abaixo. Sem ele, leia o último registro do assistente no transcript:

```bash
F=$(ls -t $H/.claude/projects/-home-agente/*.jsonl | head -1)
python3 - "$F" <<'PY'
import json, sys
ult = None
for l in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try: d = json.loads(l)
    except ValueError: continue
    if d.get("type") == "assistant": ult = d
if ult:
    txt = [c.get("text") for c in ult["message"].get("content", []) if isinstance(c, dict) and c.get("text")]
    print(ult.get("timestamp"), "erro:", ult.get("error"), "| api:", ult.get("isApiErrorMessage"),
          "| stop:", ult["message"].get("stop_reason"), "|", (txt or [""])[0][:200])
PY
```

| O que aparece | Significa | Conserto |
|---|---|---|
| `erro: authentication_failed`, "Login expired · Please run /login" | o login do Claude venceu. A sessão fica parada; o status pode ficar `working` para sempre e tudo o que chega vai para a fila | **3.4** |
| `erro: server_error`, "API Error: 529", "overloaded" | Anthropic sobrecarregada | **esperar** (regra 0.3); mandar uma mensagem de teste depois de 10 minutos |
| "usage limit", "limit reached", "resets ..." | limite da assinatura | **esperar** até a hora dita; sugerir ao dono um plano maior ou um modelo menor |
| resposta cortada pelo filtro de segurança (`stop_reason` "refusal", aviso "safeguards stopped the response", "stopped by a safety classifier") | a conversa tem um trecho que a Anthropic bloqueia; reiniciar normal reenvia o mesmo trecho e trava de novo | **3.6**, modo de segurança |
| "prompt is too long" ou conversa grande demais | a conversa não cabe mais | modo de segurança, como acima |
| recusa educada do modelo ("não posso ajudar com isso") como última fala, sem os avisos acima | o modelo recusou aquele pedido | nada a consertar na máquina; o dono reformula o pedido |
| texto normal e recente | a sessão responde; o problema está no CANAL | **3.5** |

### 3.4 Login vencido ou ausente
Explique: "O login do Claude do seu agente venceu, então ele parou de pensar. Preciso que você
entre na conta de novo; leva dois minutos. Posso parar o agente enquanto isso?"

O runner só sobe o `claude` quando existe credencial em `$H/.claude/.credentials.json` (ou uma
chave de API no cofre). Sem ela o `runner.log` traz a frase "ainda não fez login" e o runner
espera, e assume sozinho assim que a credencial aparecer.

1. **O caminho do dono:** se a tela do agente mostrar o botão **Entrar com a assinatura**, é
   por ele que o dono entra (a tela mostra um link e um código). Peça para ele clicar e seguir
   os passos. Se o botão não existir ou responder erro, use o passo 2.
2. **Pelo terminal do servidor**, com o "posso?":
   ```bash
   podman exec $C systemctl stop dgclaw-runner
   mv $H/.claude/.credentials.json $H/.claude/.credentials.json.vencida-$(date +%Y%m%d-%H%M)   # só se o arquivo existir
   podman exec -it --user agente -e HOME=/home/agente -e CLAUDE_CONFIG_DIR=/home/agente/.claude $C claude
   ```
   O dono (ou você, com ele ao lado) faz o `/login`, confirma e sai com `/exit`. Depois:
   `podman exec $C systemctl start dgclaw-runner`. O `mv` é cópia de segurança: nada se apaga.

Depois: seção 5. Avise o dono de que o que ele mandou durante a pane pode ter se perdido (a
fila de espera do runner guarda UM recado só, e um reinício apaga ela) e peça para repetir.

### 3.5 O canal está vivo?
- **Painel e chat (o canal padrão):** o `/api/saude` do runner (tabela 2.2) responde e o
  último turno foi normal? Então a resposta existe; confira se o Web entrega: `dgclaw status`
  e `journalctl -u dgclaw-web -n 50 --no-pager`.
- **Telegram (só se o dono ligou o canal):** o container usa o plugin oficial do Telegram do
  Claude. Confira `podman exec --user agente $C bash -c 'cd /home/agente && claude plugin list'`
  (deve listar `telegram@claude-plugins-official`) e se o token do bot foi configurado, sem
  imprimir o valor. Se o plugin sumiu: `dgclaw agente reparar $SLUG` tenta instalar de novo.
- **Dois processos no mesmo bot** (o agente também está ligado em outro computador): o bot
  fica mudo. Pergunte e peça para fechar o outro.

### 3.6 A conversa está envenenada (recusa do filtro ou conversa grande demais)
Um reinício normal nesses dois casos recarrega o problema. O conserto é o **modo de
segurança**: o agente volta numa sessão nova, sem a conversa anterior (que fica guardada),
com a mensagem que travou em quarentena. Explique ao dono antes do "posso?": ele perde o fio
daquela conversa, não a memória.

- **Pelo painel do agente:** a faixa de aviso no alto da tela oferece o botão **Reiniciar em
  modo de segurança** quando é o caso. É o caminho mais simples para o dono.
- **Pelo servidor** (depois do "posso?"; teste antes com `--dry-run`):
  ```bash
  podman exec --user agente $C bash /opt/dgclaw/app/scripts/modo-seguro.sh /home/agente/.dgclaw/config.sh --motivo "recusa do filtro" --origem manual --dry-run
  ```
  Se o plano estiver certo, rode o mesmo comando sem o `--dry-run`. O script lê do
  `config.sh` o endereço do runner do agente (`DGCLAW_BUNKER_URL`, `DGCLAW_BUNKER_CARD`). Se o
  plano disser que vai usar `systemctl`, o `config.sh` está sem essas linhas (foi gerado por
  uma versão antiga do `dgclaw`) e o modo de segurança não vai funcionar por aqui: use o botão
  do painel e avise quem cuida do servidor.

### 3.7 A sessão está travada (de pé, sem erro, sem responder)
- `/api/saude` com `"status":"working"` e `ultimaSaidaEm` de horas atrás, e o `runner.log` só
  com "enfileirados". Antes de qualquer coisa refaça o 3.3 (login vencido dá exatamente isso).
- Sem erro no último turno, com o "posso?": `dgclaw agente reiniciar $SLUG`. Ele reinicia só o
  runner, o container continua de pé, e a conversa volta de onde estava.

### 3.8 Tudo de pé e ele responde, mas "está estranho"
- **Esqueceu o combinado ou responde genérico:** confira que a identidade existe e não está
  vazia: `ls -l $H/AGENT.md $H/.plataforma/identidade.md $H/MEMORY.md`. Depois a memória
  (seção 3.9).
- **Responde coisa que ninguém perguntou:** é o batimento ou uma tarefa agendada falando por conta
  própria. `tail -n 20 $H/.dgclaw/logs/heartbeat.log`.
- **Custo alto:** `tail -n 20 $H/.dgclaw/logs/cost-alerts.log`.

### 3.9 A memória parou (não lembra de ontem)
- **A prova de execução da reflexão é o diário**, não o log: `ls -t $H/memory/ | head -3` deve
  ter o `AAAA-MM-DD.md` de ontem. Diário parado há dias significa sessão parada ou travada:
  volte para 3.3 e 3.7.
- Tarefa agendada que não roda: `podman exec $C systemctl list-timers --no-pager`; timer ausente,
  `dgclaw agente reparar $SLUG` refaz a parte de dentro.

## 4. Restaurar (sempre perguntando ao dono antes)

| O quê | Onde fica | Como voltar |
|---|---|---|
| Agente removido por engano | `/var/lib/dgclaw/aposentados/<slug>-AAAAMMDD-HHMMSS/` (a casa inteira, mais os segredos do host em `segredos-do-host/`) | nada foi apagado. Fale com quem cuida do servidor antes de mexer: recriar é `dgclaw agente criar` e a casa antiga precisa voltar para `/var/lib/dgclaw/agentes/<slug>`. A faixa de usuário (uid) do agente removido fica reservada de propósito |
| Login vencido | `$H/.claude/.credentials.json.vencida-<data>` (cópia feita na seção 3.4) | só serve de registro; o login novo substitui |
| Modo de segurança anterior | `$H/.dgclaw/modo-seguro/<data>/` (o fio antigo) e `$H/.dgclaw/quarentena/` (a mensagem que travou) | nada se perde; a conversa anterior também fica guardada pelo runner (`previousSessionId`) |
| Memória | `$H/memory/`, `$H/MEMORY.md` | copie o arquivo atual para `.antes-socorro-<data>` e só então traga o antigo |

## 5. Conferir que voltou (nunca diga "resolvido" sem isto)

1. `dgclaw agente listar` mostra `running` e `ok` para o agente (e `dgclaw status` sem `FALHOU`).
2. `curl -s http://127.0.0.1:$PORTA/api/saude` mostra `"status":"idle"` e `"ptyVivo":true`.
3. A prova real: peça ao DONO para mandar "oi" pelo canal dele (a tela do agente ou o Telegram)
   e espere a resposta chegar LÁ. Resposta no log não é resposta na tela dele.

## 6. O roteiro da conversa com o leigo

1. **Acolha e pergunte uma coisa só:** "Por onde você fala com ele e desde quando ele não responde?"
2. **Investigue calado** (seções 1 a 3). Não narre comando; no máximo "estou olhando, um minuto".
3. **Explique o que achou em UMA frase, sem jargão:** "O login do Claude dele venceu, por isso
   ele parou de pensar desde quarta." Ou: "A Anthropic está sobrecarregada agora; não é nada no
   seu agente." Ou: "O container dele estava desligado, vou ligar."
4. **Proponha o conserto e o tempo:** "Eu reconecto, leva um minuto e ele não perde a memória."
5. **Pergunte "posso?"** e espere o sim. Para esperar (529, limite), diga quando voltar a testar.
6. **Execute** uma mudança por vez, com cópia antes.
7. **Confira** (seção 5) e conte o resultado: "Voltou. Manda um oi pra ele."
8. **Registre** em uma linha no `memory/<hoje>.md` do agente o que aconteceu e o que foi feito,
   para ele saber depois por que ficou fora do ar.

Se nada aqui explicou o problema: diga isso com franqueza, junte a saída de `dgclaw status`,
de `dgclaw agente listar` e os últimos logs, e entregue a quem cuida do servidor. Não invente
conserto.

## 7. Quando o problema é o próprio Admin

O Admin roda como serviço no servidor (`dgclaw-admin`), sem container. Se for ele que não
responde (tabela 2.1, linha Admin): leia `journalctl -u dgclaw-admin -n 50 --no-pager` e
`/var/log/dgclaw/admin-runner.log`. Se o log disser que ainda não há login, o login é o do
usuário root do servidor: faça o `/login` do `claude` num terminal do servidor. Reiniciar
(`systemctl restart dgclaw-admin`) corta a conversa em curso, inclusive esta, então só com o
"posso?" e avisando que a conversa recomeça. Quem está lendo este manual pelo próprio Admin
deve preferir pedir ao dono que rode o comando num terminal.
