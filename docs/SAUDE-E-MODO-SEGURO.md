# Saúde do agente e modo de segurança

Este documento explica como o DG Claw sabe se o agente está **respondendo** (e não só
"de pé"), o que ele faz sozinho quando algo dá errado, e o que o dono faz.

## Por que isto existe

Até 01/10/2026, todo sinal de "está vivo" media o **processo**: tem terminal? o card está
de pé? Três casos reais mostraram que isso não basta:

- **Isa, 30/09/2026.** O Danilo mandou um áudio sobre um assunto que o filtro de
  segurança da Anthropic leu como ciberataque. A resposta foi cortada no meio e a sessão
  congelou. Ficou 56 minutos muda, e nenhum alarme tocou: o vigia que existia só olhava
  erro de API, e o corte do filtro **não é** erro de API. Reiniciar não resolvia, porque a
  retomada mandou ela reler a conversa morta, o texto voltou e o filtro cortou de novo.
- **Dois agentes de clientes (desde 24/09 e desde 27/09).** O login da conta deles na Anthropic
  venceu (`Login expired · Please run /login`). O runner dizia "working", o watchdog dizia
  "VIVA e saudável" umas 1.500 vezes, o Pulso ficava verde, e nenhum aviso chegou ao dono.

Um processo de pé que só devolve recusa, ou "faça login", está tão fora do ar quanto um
processo morto, para quem fala com ele.

## Os quatro estados

| Estado | Cor no selo | O que quer dizer |
| --- | --- | --- |
| `ativo` | verde | O último turno do agente foi normal. Ou ele está trabalhando na sua mensagem agora. |
| `atencao` | amarelo | Algo fora do normal, mas que pode passar sozinho (sobrecarga da Anthropic, bloqueio que acabou de acontecer, mensagem sem resposta há mais de 10 minutos). |
| `inativo` | vermelho | Ele não vai responder até alguém agir (ou até o limite voltar). |
| `indeterminado` | amarelo | Não consegui medir (sem contato com a plataforma, sessão que acabou de subir e ainda não conversou). Nunca vira "ativo" por falta de dado. |

## Os tipos (o que deu errado) e o que fazer

| Tipo | Estado | Recomendação | Por quê |
| --- | --- | --- | --- |
| `ok` | ativo | `nada` | |
| `recusa` | inativo (atenção nos primeiros 2 min) | `modo_seguro` | O filtro de segurança da Anthropic bloqueou uma resposta. Reiniciar do jeito normal recarrega a mesma conversa e o bloqueio volta. |
| `contexto` | inativo | `modo_seguro` | A conversa ficou grande demais ("prompt is too long"). Só uma conversa nova resolve. |
| `login` | inativo | `refazer_login` | O login venceu. Reiniciar não resolve: ele volta sem login do mesmo jeito. Quem cuida do sistema refaz o login da conta do agente. |
| `limite` | inativo | `esperar` | O limite de uso da conta acabou. A frase diz quando volta, se a mensagem trouxer o horário. |
| `sobrecarga` | atenção (inativo depois de 30 min) | `esperar` | 529, 500, "connection lost". Passa sozinho. **Não reinicie**: reiniciar zera o cache e cada resposta fica mais lenta e mais cara enquanto a falha durar. |
| `erro_api` | atenção (inativo depois de 30 min) | `esperar`, depois `reiniciar` | Um erro da Anthropic que não sei classificar. |
| `sem_resposta` | atenção | `reiniciar` | O dono mandou mensagem há mais de 10 minutos, a sessão está parada e não houve resposta. |
| `sessao_caida` | inativo | `reiniciar` (ou `modo_seguro`) | O terminal não está rodando. Se a última coisa antes da queda foi uma recusa, a recomendação vira modo de segurança. |
| `desconhecido` | atenção | `esperar` | Uma resposta fora do normal que não reconheço. Ela é pega mesmo assim: qualquer coisa diferente do normal é sinalizada. |

Um turno normal **depois** do erro apaga o erro: o problema é passado, volta a `ativo`.

## De onde vem o dado

`scripts/_lib/saude_sessao.py` lê os **últimos ~300 KB** do transcript da sessão viva
(nunca o arquivo inteiro; um transcript longo passa de 50 MB) e acha o último turno do
assistente depois da última mensagem do dono. Quem diz onde está a sessão é o
`_lib/inject.py`, que conhece os três mundos: card do Bunker, runner da jaula e sessão
`--channels` clássica.

As assinaturas foram levantadas nos transcripts reais em 01/10/2026
(notas internas do autor):

- **Recusa:** `message.stop_reason == "refusal"` com `stop_details.explanation`, **ou** o
  aviso `system/informational` "safeguards stopped the response above", **ou** o
  companheiro `turnCompanion` "stopped by a safety classifier". No segundo corte da Isa o
  primeiro registro nem foi gravado, por isso os três contam.
- **Erro de API:** mensagem sintética do Claude Code (`model: "<synthetic>"`,
  `isApiErrorMessage: true`), classificada pelo `error`, pelo `apiErrorStatus` e pelo texto.
- **Login:** além do transcript, `claude auth status --json` é consultado sem gastar
  turno (guardado 5 minutos), para pegar login vencido antes da próxima mensagem do dono.
  Como ele olha o diretório de configuração deste processo, "sem login" só por ele vira
  `atencao`, nunca `inativo` sozinho.
- **Limite e "prompt is too long"** não apareceram em 30 dias de transcript: as regex
  desses dois são inferidas e largas de propósito. Quando aparecer um caso real, conferir.

Uso direto, para quem administra:

```bash
python3 scripts/_lib/saude_sessao.py --json            # a sessão viva (envs DGCLAW_*)
python3 scripts/_lib/saude_sessao.py --json --jsonl <arquivo> --sem-checar-vida
```

O watchdog grava o último diagnóstico em `<ws>/.dgclaw/logs/saude.json` e no ledger do
Pulso com id `saude`. O painel pede o diagnóstico na hora (cache de 20 s) pela rota
`/api/saude`, no campo `diagnostico`.

## O que o watchdog faz sozinho (a cada 5 minutos)

| Tipo | Ação automática |
| --- | --- |
| `recusa`, `contexto` | **Modo de segurança automático**, uma vez por incidente, com cooldown próprio de 60 min (`DGCLAW_WATCHDOG_SEGURO_COOLDOWN_MIN`) e dentro do mesmo limite anti-tempestade dos reinícios (3 por hora). Se não resolver, avisa o dono e não tenta de novo. |
| `login` | Só avisa o dono, uma vez por incidente. Não reinicia. |
| `limite`, `sobrecarga`, `erro_api` | Não reinicia. Avisa uma vez se passar de 30 min. |
| `sem_resposta` | Reinício normal (com o limite anti-tempestade). |
| `sessao_caida` | O reinício de sempre; se houve veneno na conversa, modo de segurança. |

Com `DGCLAW_AUTO_RECOVERY=off` ele só observa e avisa.

Duas regras que não podem ser quebradas:

- **No mundo do runner (a jaula) e no card do Bunker, nada de `systemctl restart`.** O
  runner sobe `claude --resume`, e o veneno volta junto. E o watchdog da jaula roda como
  usuário comum: cada `systemctl restart` falhava (119 vezes num agente de cliente até 01/10). Lá o
  reinício é por HTTP: parar + `/resume` (normal) ou `/revive` (seguro).
- **Aviso que não chegou é falha.** O `notify-owner.sh` agora tenta, em ordem, o comando
  do host (`DGCLAW_NOTIFY_CMD`), o Telegram (só conta com HTTP 2xx) e o canal DG Chat da
  plataforma (uma linha no `outbound.jsonl`, que o carteiro do runner entrega). Se nenhum
  entregar, sai com código 1, registra em `.dgclaw/logs/notify-owner.log`, e o watchdog
  sai com código 1 e grava `erro` no Pulso.

## O modo de segurança

Quando o problema **está na conversa**, o agente volta numa conversa nova, sem carregar a
anterior. Passo a passo (`scripts/_lib/reinicio.py seguro`, que é o mesmo código para o
painel, o watchdog e o `scripts/modo-seguro.sh`):

1. **Quarentena.** A mensagem do dono que abriu o turno que travou vai para
   `.dgclaw/quarentena/<data>.json`. Ela fica guardada, nunca é reenviada ao agente, e o
   painel mostra ao dono qual foi (para ele reescrever, se ainda quiser).
2. **O fio.** O `chat-tail.md` antigo é movido para `.dgclaw/modo-seguro/<data>/` e um
   novo é escrito só com a conversa até o último turno bom (`cortarDepoisDe`). O bloco de
   carry-over da working-memory (que o auto-compact escreve com o fio da conversa) também
   sai do caminho e fica guardado. Nada é apagado.
3. **A marca.** `.dgclaw/modo-seguro.json` registra motivo, tipo, sessão anterior e o
   ponto de corte. Quem lê: o `hooks/session-context.sh` (que, com a marca, só reinjeta o
   fio refeito e avisa o agente que ele está em modo de segurança), o `auto-compact.py`
   (que descarta qualquer poke de retomada nascido antes da marca: foi um poke assim que
   mandou a Isa reler o transcript morto), o watchdog e o painel.
4. **Sessão nova.** Card ou runner: `POST /api/agents/<card>/revive` (a conversa anterior
   fica guardada em `previousSessionId`). Clássico: `systemctl restart`, porque o
   `launch.sh` não usa `--resume`.
5. **O recado.** Quando a sessão nova fica ociosa, o agente recebe um recado curto, com
   envelope de plataforma: foi reiniciado em modo de segurança por tal motivo, a conversa
   anterior ficou guardada mas não foi carregada, leia a working-memory, **não** retome o
   último assunto sozinho, **não** abra o transcript anterior nem reprocesse anexos e
   áudios daquela conversa, avise o dono que voltou e pergunte como ele quer seguir. O
   recado é digitado direto, nunca pela fila de ocioso do runner (que tem uma vaga só e
   apaga o anterior), e só conta como entregue quando aparece no transcript da sessão nova.

### As portas que a quarentena fecha

Tirar o fio do caminho não basta: a conversa antiga continua no disco, e várias rotinas
leem o disco e entregam o que acharam ao agente. Todas consultam a mesma regra,
`scripts/_lib/quarentena.py`:

| Porta | Como ela traria o texto de volta | O que faz agora |
| --- | --- | --- |
| Working memory ("Agora", "Últimas conversas", "Ontem") | É montada do transcript e lida em todo boot | O build pula a quarentena, e o modo de segurança refaz essas seções na hora (`--agora-only`, resultado em `wmRefeita` na marca) |
| Reflexão da noite | Digita na sessão "o que se falou hoje" e o "eco do passado" | Os dois blocos passam pelo filtro |
| Busca em conversas (recall e `buscar`) | Acha a mensagem pela palavra rara | Os resultados passam pelo filtro |
| Memória semântica (recall) | Guarda as falas antigas do dono como texto | O recado do recall passa pelo filtro de texto |
| Poke de retomada do auto-compact | Cita o último pedido ao pé da letra | Em modo de segurança não cita pedido nem resposta em quarentena e lembra que não deve abrir transcript nem reprocessar áudio |

A regra tem dois critérios. **Sessão e horário:** o que a sessão anterior gravou depois
do ponto de corte (corte vazio é a sessão inteira). **Texto:** qualquer trecho que repita
6 palavras seguidas da mensagem em quarentena (ou a mensagem inteira, se ela tiver de 3 a
5 palavras), para as fontes que só guardam o texto. Ela vem de todo
`.dgclaw/quarentena/*.json`, **para sempre**, e da marca enquanto ela existir. Se o dono
mandar o mesmo pedido de novo numa conversa nova, a escolha é dele: a regra só barra o que
veio da conversa antiga. Conferir: `python3 scripts/_lib/quarentena.py status`.

A marca se encerra sozinha depois de 24 h com o agente respondendo normalmente
(`DGCLAW_MODO_SEGURO_EXPIRA_H`), ou à mão com `python3 scripts/_lib/reinicio.py
encerrar-modo-seguro`.

**O que o modo de segurança não protege:** se o próprio agente escreveu o assunto que
travou na working-memory dele (na seção de hoje, por exemplo), ele vai ler isso de novo.
Se o modo de segurança automático rodar e o agente travar outra vez, o watchdog não
repete: avisa o dono, e o próximo passo é a sessão de socorro do painel ou quem cuida do
sistema olhar a working-memory.

## O que o dono faz

- **Selo verde:** nada.
- **Selo amarelo:** ler a frase. Na maior parte das vezes é esperar alguns minutos.
- **Selo vermelho:** o botão que o painel oferece é o certo para aquele caso
  (`recomendacao`): reiniciar, reiniciar em modo de segurança, ou avisar quem cuida do
  sistema para refazer o login.
- **Não entendeu o que houve:** abrir a aba **Socorro** (ver `panel/docs/SOCORRO.md`).

## Para quem administra

```bash
bash scripts/modo-seguro.sh <ws>/.dgclaw/config.sh --motivo "texto" [--dry-run] [--json]
python3 scripts/_lib/reinicio.py checar|normal|seguro|status|encerrar-modo-seguro --json
```

Testes: `python3 scripts/_lib/test_saude_sessao.py`, `python3 scripts/_lib/test_reinicio.py`,
`python3 scripts/_lib/test_quarentena.py`
(runner falso, nunca toca agente real) e `node panel/test-saude.mjs`.
