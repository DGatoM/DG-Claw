---
name: agenda
description: Marca, lista e desmarca compromissos de verdade do agente NA MAQUINA onde ele mora (timers do systemd, via persona-cron-mgr.py), pra ele agir sozinho na hora certa mesmo com ninguem falando com ele. Use SEMPRE que o dono pedir pra agendar, marcar, lembrar ou repetir algo num horario ("todo dia as 9h me manda o resumo", "cria um cron", "cria um agendamento", "me lembra toda segunda", "roda isso de hora em hora", "quais crons voce tem", "cancela aquele agendamento"). Vale tambem quando a transcricao de audio trouxer CHROME, CROME, CRONO, CROM ou CRONI num pedido de horario, que e quase sempre a palavra CRON mal ouvida. NUNCA use o agendamento da sessao do Claude Code pra isso: aquilo morre com a sessao, isto fica na maquina.
user-invocable: true
---

# /dgclaw:agenda, marcar compromisso de verdade

O dono quer que alguma coisa aconteça num horário, sem ele estar por perto. Esta skill
transforma esse pedido num **timer do systemd**, que vive na máquina, sobrevive a reinício e
dispara sozinho.

## A regra de ouro, antes de qualquer coisa

Existem dois "agendamentos" no mundo, e eles não se parecem em nada:

| | O agendamento da sessão do Claude | A agenda do DG Claw (esta skill) |
|---|---|---|
| onde vive | dentro da conversa aberta | na máquina, no systemd |
| quando a conversa fecha | morre junto | continua |
| serve pra | "daqui a 10 minutos volte nisso" dentro do trabalho de agora | "todo dia às 9h faça X", pra sempre |

**Você é um agente DG Claw: você mora numa máquina que fica ligada.** Quando o dono pede um
agendamento, ele está pedindo o da direita. Nunca responda que "só consigo agendar dentro da
minha sessão": isso é falso pra você. Você marca na máquina.

## Quando o áudio disser "Chrome"

O dono manda muita mensagem de voz, e a transcrição erra a palavra **cron** com frequência.
Num pedido de horário, todas estas são a mesma coisa:

> **Chrome, crome, crono, crom, croni, cronn, "corn"**

"Cria um Chrome pra mim das 9h" é **cria um cron das 9h**. Não peça pra ele repetir e não
vá abrir navegador. A única leitura em que Chrome é navegador mesmo é quando o assunto é
abrir site, aba, extensão ou login. Na dúvida entre as duas, confirme numa linha só:
"você quer dizer um agendamento, certo?".

## Como funciona por dentro (diga isso ao dono se ele perguntar)

O timer não executa comando solto. Na hora marcada, ele **cutuca a sua sessão viva com um
recado escrito por você**, e aí você decide o que fazer, com toda a sua memória e o seu jeito.
É a diferença entre um robô que dispara texto pronto e um funcionário que na hora certa se
lembra do que tinha pra fazer.

Por isso o campo mais importante é o `--poke`: é o bilhete que o seu "eu do futuro" vai
receber. Escreva como quem deixa recado pra si mesmo, com contexto suficiente pra agir sem
precisar perguntar nada. Compare:

- ruim: `resumo`
- bom: `Hora do resumo do dia pro Danilo: olhe a working-memory e o que aconteceu hoje, monte um resumo curto e mande pelo Telegram.`

## Hora é a hora do dono. Nunca converta

A hora que ele fala é a hora do relógio dele. "Cinco da tarde" é `17:00:00`, escrito assim,
e ponto. **Não converta pra UTC, não some nem subtraia nada.** O gerenciador carimba o fuso
do dono (`DGCLAW_TZ`) no próprio agendamento, então quem faz a conversão é o sistema, que
não erra. Fazer a conta na mão é o jeito conhecido de marcar 17h e o compromisso cair às 20h.

Duas coisas que ajudam a não escorregar:

- **Descubra que horas são de verdade antes de calcular** qualquer coisa relativa ("daqui a
  duas horas", "amanhã cedo"). A sua sessão pode estar aberta há dias, e a sua noção de agora
  está velha. Rode `date '+%d/%m %H:%M %Z'` e use o que voltou.
- **Confirme repetindo em português.** Depois de criar, diga a ele quando roda a próxima vez,
  com dia e hora. O comando já devolve isso na linha `proxima:`. Se o que voltou não bater com
  o que ele pediu, o problema é agora, não daqui a uma semana.

Se ele estiver num fuso diferente do servidor e isso aparecer, não invente correção: mostre
o que `timedatectl` diz e ofereça acertar (`timedatectl set-timezone <fuso do dono>`), que é
mexida no servidor inteiro e precisa da autorização dele.

## O comando

Sempre pelo gerenciador, nunca mexendo em systemd na mão:

```
MGR="${CLAUDE_PLUGIN_ROOT}/scripts/persona-cron-mgr.py"
CFG="<workspace>/.dgclaw/config.sh"

python3 "$MGR" --config "$CFG" list --json
python3 "$MGR" --config "$CFG" create --name <apelido> --calendar '<horário>' --poke '<recado>' --desc '<o que é>' --dry-run
python3 "$MGR" --config "$CFG" create --name <apelido> --calendar '<horário>' --poke '<recado>' --desc '<o que é>'
python3 "$MGR" --config "$CFG" edit   --name <apelido> ... (mesma assinatura do create)
python3 "$MGR" --config "$CFG" remove --name <apelido>
```

Se você não é root (o agente que roda no container da v1), o gerenciador pede `sudo` sozinho
quando precisa gravar a rotina. Não precisa fazer nada. A rotina roda como o dono da pasta do
agente, não como root.

- `--name`: apelido curto em kebab-case (`resumo-do-dia`, `cobranca-cliente`). É a identidade
  da rotina: é por ele que se edita e se remove.
- `--calendar` **ou** `--every`, nunca os dois:
  - `--calendar '*-*-* 09:00:00'` → todo dia às 9h
  - `--calendar 'Mon..Fri *-*-* 08:30:00'` → de segunda a sexta, 8h30
  - `--calendar 'Mon *-*-* 18:00:00'` → toda segunda, 18h
  - `--calendar '*-*-01 10:00:00'` → todo dia 1º do mês, 10h
  - `--every 30min` (ou `2h`, `1d`) → de tempos em tempos, contado a partir da última vez
- O fuso é o da máquina (`DGCLAW_TZ`), já configurado. Não faça conta de fuso na mão.

**Rode sempre com `--dry-run` primeiro** e mostre ao dono o que vai ser criado, em português:
o apelido, quando roda e o recado. Só depois rode de verdade. É barato, e evita marcar
compromisso errado num horário que ninguém vai conferir.

## O que fazer em cada pedido

**"Marca pra mim..."** → entenda o horário, escolha o apelido, escreva o recado, `--dry-run`,
mostre, confirme, crie. Feche dizendo **quando roda a próxima vez** e que ele pode ver isso
no painel, na aba Operações.

**"Quais agendamentos você tem?"** → `list --json` e traduza pra frases. Não despeje JSON no
Telegram. Diga o apelido, quando roda e o que ele faz quando dispara.

**"Cancela o X"** → `remove --name X`. Confirme que sumiu e avise que ele some do painel
também. Se o dono descrever a rotina em vez de dar o apelido, liste antes e confirme qual é.

**"Muda o horário do X"** → `edit`, não remove-e-cria. O `edit` preserva o apelido e o
histórico da rotina.

## Limites que existem por segurança (e valem ser ditos)

- Você só governa as rotinas **do seu bloco**, com o prefixo `dgclaw-<slug>-self-`. As rotinas
  de vida que vieram com você (reflexão noturna, auditoria, batimento, pulso) e qualquer outra
  coisa da máquina são **intocáveis por este comando**, e isso é proposital.
- **Teto de 10** rotinas próprias. Atingiu, o comando recusa e você precisa remover uma antes.
  Se isso acontecer, mostre a lista ao dono e pergunte qual sai.
- Todo pedido é validado antes: apelido, formato de horário e tamanho do recado. Se o
  gerenciador recusar, ele diz o motivo em uma linha. Leia a mensagem e conserte, não insista.
- O manifesto (`.dgclaw/self-crons.json`) é gravado com backup automático a cada mudança.

## Onde o dono vê isso

No painel, aba **Operações**, cartão **Agenda do agente**. Aquela lista não é um arquivo de
configuração: ela é lida do systemd na hora em que a página abre. Então vale a promessa
simples, e você pode dizer isso a ele com todas as letras: **se está lá, existe; se você
apagar, some de lá sozinho.** Nunca vai aparecer rotina fantasma que já foi removida, nem
faltar uma que você acabou de criar.
