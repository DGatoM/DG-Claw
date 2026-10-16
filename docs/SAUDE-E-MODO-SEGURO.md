# Saúde do agente e modo de segurança

Este documento explica como o DG Claw sabe se o agente está **respondendo** (e não só
"de pé"), o que o dono vê na tela, o que fazer em cada caso e como funciona o modo de
segurança. Cada agente roda no seu container; tudo o que está aqui vale por agente.

## Por que isto existe

Um processo de pé que só devolve recusa, ou "faça login", está tão fora do ar quanto um
processo morto, para quem fala com ele. Dois casos mostraram isso:

- **A resposta cortada pelo filtro de segurança.** Quando o filtro da Anthropic lê uma mensagem
  como ataque, a resposta é cortada no meio e a sessão congela. Reiniciar do jeito normal não
  resolve: a retomada manda o agente reler a mesma conversa, o texto volta e o filtro corta de
  novo. Nesse caso o sinal de "está vivo" continua verde, porque o processo está de pé.
- **O login vencido** (`Login expired · Please run /login`). O runner continua dizendo
  "working", mas cada mensagem do dono se perde numa tela de login e nenhum aviso chega.

Por isso o DG Claw mede também a **resposta**: ele olha o último turno do agente e diz se foi
normal.

## Os quatro estados

| Estado | Cor no selo | O que quer dizer |
| --- | --- | --- |
| `ativo` | verde | O último turno do agente foi normal. Ou ele está trabalhando na sua mensagem agora. |
| `atencao` | amarelo | Algo fora do normal, mas que pode passar sozinho (sobrecarga da Anthropic, um bloqueio que acabou de acontecer, mensagem sem resposta há mais de 10 minutos). |
| `inativo` | vermelho | Ele não vai responder até alguém agir (ou até o limite voltar). |
| `indeterminado` | amarelo ("Sem contato") | Não foi possível medir (sem contato com o runner, sessão que acabou de subir e ainda não conversou). Nunca vira "ativo" por falta de dado. |

## Os tipos (o que deu errado) e o que fazer

| Tipo | Estado | Recomendação | Por quê |
| --- | --- | --- | --- |
| `ok` | ativo | `nada` | |
| `recusa` | inativo (atenção nos primeiros 2 minutos) | `modo_seguro` | O filtro de segurança da Anthropic bloqueou uma resposta. Reiniciar do jeito normal recarrega a mesma conversa e o bloqueio volta. |
| `contexto` | inativo | `modo_seguro` | A conversa ficou grande demais ("prompt is too long"). Só uma conversa nova resolve. |
| `login` | inativo | `refazer_login` | O login venceu. Reiniciar não resolve: ele volta sem login do mesmo jeito. Quem cuida do servidor refaz o login da conta do agente (passo a passo no manual de emergência, seção 3.4). |
| `limite` | inativo | `esperar` | O limite de uso da conta acabou. A frase diz quando volta, se a mensagem trouxer o horário. |
| `sobrecarga` | atenção (inativo depois de 30 minutos) | `esperar` | 529, 500, "connection lost". Passa sozinho. **Não reinicie**: reiniciar zera o cache e cada resposta fica mais lenta e mais cara enquanto a falha durar. |
| `erro_api` | atenção (inativo depois de 30 minutos) | `esperar`, depois `reiniciar` | Um erro da Anthropic que não foi possível classificar. |
| `sem_resposta` | atenção | `reiniciar` | O dono mandou mensagem há mais de 10 minutos, a sessão está parada e não houve resposta. |
| `sessao_caida` | inativo | `reiniciar` (ou `modo_seguro`) | O terminal do agente não está rodando. Se a última coisa antes da queda foi uma recusa, a recomendação vira modo de segurança. |
| `desconhecido` | atenção | `esperar` | Uma resposta fora do normal que o sistema não reconhece. Ela é sinalizada mesmo assim: qualquer coisa diferente do normal aparece. |

Um turno normal **depois** do erro apaga o erro: o problema é passado, volta a `ativo`.
As regras acima estão no cabeçalho de `scripts/_lib/saude_sessao.py`.

## De onde vem o dado e onde o dono vê

`scripts/_lib/saude_sessao.py` lê os **últimos ~300 KB** do transcript da sessão (nunca o
arquivo inteiro; um transcript longo passa de 50 MB) e acha o último turno do agente depois da
última mensagem do dono. As assinaturas que ele reconhece:

- **Recusa:** `message.stop_reason == "refusal"` com `stop_details.explanation`, ou o aviso
  `system/informational` "safeguards stopped the response above", ou o companheiro
  `turnCompanion` "stopped by a safety classifier". Os três contam porque, num dos casos
  reais, o primeiro registro nem chegou a ser gravado.
- **Erro de API:** a mensagem sintética do Claude Code (`model: "<synthetic>"`,
  `isApiErrorMessage: true`), classificada pelo `error`, pelo `apiErrorStatus` e pelo texto.
- **Login:** além do transcript, o script consulta `claude auth status --json` sem gastar turno
  (resultado guardado por 5 minutos). Como esse comando olha o diretório de configuração do
  próprio processo, "sem login" só por ele vira `atencao`, nunca `inativo` sozinho.
- **Limite e "prompt is too long":** as expressões que reconhecem esses dois são inferidas do
  texto que o Claude Code costuma mostrar e largas de propósito, porque ainda não apareceram
  num transcript real.

**Na tela do agente** (`panel/lib/rotas-saude.js` e `panel/lib/saude.js`): a rota
`GET /api/saude` do painel traz o campo `diagnostico`, medido na hora e guardado em cache por
20 segundos. Com ele, o painel mostra:

- o **selo** no cabeçalho, com a cor do estado e a frase do motivo;
- a **faixa na aba Conversa**, quando o agente está mal, com o botão certo para aquele caso
  (`panel/public/js/app.js`): **Reiniciar**, **Reiniciar em modo de segurança** ou, para
  `esperar`, **Tentar agora mesmo assim**. Para `login` não há botão: a faixa diz que quem cuida
  do servidor precisa refazer o login.

Quem administra roda o diagnóstico direto no transcript do agente, a partir do servidor:

```bash
F=$(ls -t /var/lib/dgclaw/agentes/<slug>/home/.claude/projects/-home-agente/*.jsonl | head -1)
python3 /opt/dgclaw/app/scripts/_lib/saude_sessao.py --json --jsonl "$F" --sem-checar-vida
```

## O que o dono faz

- **Selo verde:** nada.
- **Selo amarelo:** ler a frase. Na maior parte das vezes é esperar alguns minutos.
- **Selo vermelho:** usar o botão que a faixa oferece (reiniciar, ou reiniciar em modo de
  segurança), ou avisar quem cuida do servidor para refazer o login.
- **Não entendeu o que houve:** abrir a aba **Socorro** (ver `panel/docs/SOCORRO.md`). Ela abre
  um Claude neutro, que lê os registros, explica e pergunta antes de mexer em qualquer coisa.
  Para quem administra, o passo a passo está em `docs/EMERGENCIA.md`.

## O modo de segurança

Quando o problema **está na conversa**, o agente volta numa conversa nova, sem carregar a
anterior. O código é um só (`scripts/_lib/reinicio.py`, ação `seguro`) e serve ao botão do
painel e ao `scripts/modo-seguro.sh`. Passo a passo:

1. **Quarentena.** A mensagem do dono que abriu o turno que travou vai para
   `.dgclaw/quarentena/<data>.json`. Ela fica guardada, nunca é reenviada ao agente, e o painel
   mostra ao dono qual foi (para ele reescrever, se ainda quiser).
2. **O fio.** O `chat-tail.md` antigo é movido para `.dgclaw/modo-seguro/<data>/` e um novo é
   escrito só com a conversa até o último turno bom (`cortarDepoisDe`). Nada é apagado.
3. **A marca.** `.dgclaw/modo-seguro.json` registra motivo, tipo, sessão anterior e o ponto de
   corte. Quem lê a marca: `hooks/session-context.sh` (que, com a marca, só reinjeta o fio
   refeito e avisa o agente que ele está em modo de segurança) e `scripts/auto-compact.py`
   (que descarta qualquer recado de retomada nascido antes da marca).
4. **Sessão nova.** O código pede ao runner do agente `POST /api/agents/<slug>/revive`
   (`runner/src/servidor.ts`): a sessão atual é encerrada e sobe uma nova, e a anterior fica
   guardada em `previousSessionId`.
5. **O recado.** Quando a sessão nova fica ociosa, o agente recebe um recado curto: foi
   reiniciado em modo de segurança por tal motivo, a conversa anterior ficou guardada mas não foi
   carregada, ele deve ler a working-memory, **não** retomar o último assunto sozinho, **não**
   abrir o transcript anterior nem reprocessar anexos e áudios daquela conversa, avisar o dono
   que voltou e perguntar como ele quer seguir. O texto do recado está em
   `scripts/_lib/reinicio.py` (`recado_modo_seguro`).

### As portas que a quarentena fecha

Tirar o fio do caminho não basta: a conversa antiga continua no disco, e várias tarefas agendadas leem o
disco e entregam o que acharam ao agente. Todas consultam a mesma regra,
`scripts/_lib/quarentena.py`:

| Porta | Como ela traria o texto de volta | Onde a regra é aplicada |
| --- | --- | --- |
| Working memory ("Agora", "Últimas conversas", "Ontem") | É montada do transcript e lida em todo boot | `scripts/build-working-memory.py` |
| Reflexão da noite | Digita na sessão "o que se falou hoje" | `scripts/reflection.sh` |
| Busca em conversas | Acha a mensagem pela palavra rara | `scripts/memory_index/conversas_fts.py` |
| Recall de memória | Monta um recado com falas antigas | `hooks/memory-recall.sh` |
| Recado de retomada do auto-compact | Cita o último pedido ao pé da letra | `scripts/auto-compact.py` |

A regra tem dois critérios. **Sessão e horário:** o que a sessão anterior gravou depois do ponto
de corte (corte vazio é a sessão inteira). **Texto:** qualquer trecho que repita 6 palavras
seguidas da mensagem em quarentena (ou a mensagem inteira, se ela for curta), para as fontes que
só guardam o texto. Ela vem de todo `.dgclaw/quarentena/*.json`, **para sempre**, e da marca
enquanto ela existir. Se o dono mandar o mesmo pedido de novo numa conversa nova, a escolha é
dele: a regra só barra o que veio da conversa antiga.

**O que o modo de segurança não protege:** se o próprio agente escreveu o assunto que travou na
working-memory dele (na seção de hoje, por exemplo), ele vai ler isso de novo. Se travar outra
vez, o próximo passo é a aba Socorro, ou quem cuida do servidor olhar a working-memory.

## Para quem administra

Os comandos rodam dentro do container do agente, como o usuário `agente`. O `modo-seguro.sh`
lê do `config.sh` do agente o endereço do runner (gravado pelo `dgclaw agente criar`):

```bash
SLUG=meuagente
podman exec --user agente dgclaw-$SLUG bash /opt/dgclaw/app/scripts/modo-seguro.sh /home/agente/.dgclaw/config.sh --motivo "texto" --dry-run
```

Tire o `--dry-run` para executar (com ele, o script mostra o plano sem mudar nada). Também aceita `--json`.
Os outros dois comandos precisam do mesmo ambiente, então carregam o `config.sh` antes:

```bash
podman exec --user agente dgclaw-$SLUG bash -c '. /home/agente/.dgclaw/config.sh; python3 /opt/dgclaw/app/scripts/_lib/reinicio.py encerrar-modo-seguro'   # encerra a marca à mão
podman exec --user agente dgclaw-$SLUG bash -c '. /home/agente/.dgclaw/config.sh; python3 /opt/dgclaw/app/scripts/_lib/quarentena.py status'              # o que está em quarentena
```

Testes: `python3 scripts/_lib/test_saude_sessao.py`, `python3 scripts/_lib/test_reinicio.py` e
`python3 scripts/_lib/test_quarentena.py` (runner falso, nunca tocam agente real).
