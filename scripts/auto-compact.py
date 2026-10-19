#!/usr/bin/env python3
"""auto-compact.py (DG Claw) — Auto-compacta a sessao --channels VIVA da persona
quando o contexto passa de um teto, sem reiniciar nem intervencao manual.

A sessao viva e a MESMA que serve o canal (claude --channels ... --name dgclaw-<slug>,
subida pelo dgclaw-<slug>.service). Quando o contexto cresce, o motor compacta sozinho
no limite duro — mas isso costuma cair NO MEIO de um turno e custa caro/lento. Este cron
antecipa: estima o tamanho do contexto lendo o transcript .jsonl da sessao e, se passar
de DGCLAW_COMPACT_THRESHOLD, INJETA "/compact" na sessao viva (via _lib/inject, NUNCA
claude -p — assim a sumarizacao roda na assinatura FLAT do dono, sem queimar credito API).

Generalizado pro contrato DG Claw: ZERO hardcode de persona/paths. Tudo por env DGCLAW_*.

Salvaguardas:
  - COOLDOWN (DGCLAW_COMPACT_COOLDOWN_MIN, default 20min) gravado em state file: o
    /compact demora ~min pra baixar o contexto; sem cooldown o cron re-dispararia em cima.
  - So injeta quando a sessao parece OCIOSA (ultimo evento do transcript = assistant, e
    nenhuma escrita recente no .jsonl). Compactar no meio de um turno atrapalha a resposta.
  - A ociosidade tem ESCALADA (20/08/2026): a espera encolhe conforme o contexto passa do
    teto (quente = 1/4 da espera, critico = compacta mesmo com turno em voo). Sem isso, numa
    conversa viva a checagem adiava TODO ciclo e o contexto subia sem teto.
  - SEGUNDO PLANO (25/09/2026, modo restart): subagente assincrono ou Bash em background
    sem aviso de termino segura o restart nos niveis normal e quente. No critico reinicia e
    o poke leva a lista do que morreu. Logo antes do restart a sessao e conferida de novo.
  - POKE DE RETOMADA (20/08/2026): se a compactacao pegou tarefa pela metade, o script
    fotografa o que a persona estava fazendo, grava num arquivo e manda ela retomar depois
    que a compactacao assenta. Sem isso ela acorda muda e o dono tem que repetir o pedido.
  - Degrada gracioso: sessao morta / sem transcript / sem usage -> no-op (exit 0).
  - Notifica o dono (curto, opcional) que compactou — desliga com DGCLAW_COMPACT_NOTIFY=0.

Threshold (DGCLAW_COMPACT_THRESHOLD) aceita:
  - fracao 0<f<=1   -> fracao do limite do modelo (DGCLAW_CONTEXT_LIMIT, default 200000).
                       Ex.: 0.70 -> compacta a 70% do limite.
  - numero > 1      -> teto absoluto em tokens. Ex.: 400000.
  Default: 0.70 (= 70% do limite).

Modos (DGCLAW_COMPACT_MODE):
  inject   (default) injeta "/compact" na sessao viva via _lib/inject (bunker/TIOCSTI/tmux).
           Preserva a sessao; ideal onde a injecao funciona (painel, tmux, ou TIOCSTI vivo).
           No modo bunker (card do painel ou agente de runner proprio) o painel enfileira o
           /compact e entrega quando o card fica ocioso, entao inject e SEMPRE o modo certo la:
           o terminal e do supervisor, e reiniciar seria matar a sessao do cliente.
  restart  RESTART-COM-CARRY-OVER: grava um bloco de carry-over (log canonico da thread
           do canal) no working-memory.md e da `systemctl restart` na unit da sessao. A
           sessao volta history-zero (~base) e relê o working-memory no boot. Use em hosts
           onde a injecao NAO funciona (kernel legacy_tiocsti=0 + sem tmux, sessao sob
           expect/script). Verifica pela saude do systemd (PID novo + active estavel).

           ⚠️ PRE-REQUISITO, e o erro mais caro de cometer aqui: o modo restart SO baixa
           o contexto se o launcher da sessao subir SEM `--resume`. E o caso dos
           agentes pessoais (`claude --channels ...`), onde reiniciar nasce sessao nova. NAO e o
           caso de supervisor que guarda o sessionId e retoma: o agent-runner do DG Claw
           monta `claude --resume <sessionId>` no boot, entao restart ali MATA O TERMINAL
           DO CLIENTE e a sessao volta com o MESMO contexto (custo alto, beneficio zero).
           Antes de ligar restart, confira o comando real: `ps -eo args | grep claude`.
           Se aparecer `--resume`, restart NAO serve; o caminho e inject com transporte
           que escreva no PTY (slash-command digitado no terminal executa; mensagem de
           canal chega como texto e nao executa).

Env:
  DGCLAW_WORKSPACE              raiz do workspace da persona (default: cwd).
  DGCLAW_SLUG                   slug da persona (lock, --name default, state). Default "agente".
  DGCLAW_CHANNEL_NAME          override do --name alvo (default dgclaw-<slug>).
  DGCLAW_COMPACT_MODE          "inject" (default) ou "restart". Ver "Modos" acima.
  DGCLAW_CHANNEL_SERVICE       (modo restart) unit da sessao. Default dgclaw-<slug>.service.
  DGCLAW_WORKING_MEMORY        (modo restart) caminho do working-memory.md. Default
                                 <ws>/working-memory.md ou <ws>/persona/working-memory.md.
  DGCLAW_CARRYOVER_THREAD_N    (modo restart) nº de msgs da thread no carry-over. Default 14.
  DGCLAW_SESSION_DIR           dir dos transcripts .jsonl (default ~/.claude/projects/<enc>).
  DGCLAW_COMPACT_THRESHOLD     fracao (<=1) ou tokens absolutos (>1). Default 0.70.
  DGCLAW_CONTEXT_LIMIT         limite de contexto do modelo, p/ fracao. Default 200000.
  DGCLAW_COMPACT_COOLDOWN_MIN  minutos de cooldown pos-compact. Default 20.
  DGCLAW_COMPACT_IDLE_SEC      quietude minima do transcript p/ considerar ocioso. Default 45.
  DGCLAW_COMPACT_STATE         state file (cooldown). Default <ws>/.dgclaw/logs/.<slug>-compact-state.json
  DGCLAW_COMPACT_NOTIFY        "0" desliga a notificacao ao dono. Default ligado.
  DGCLAW_COMPACT_HOT_FACTOR    multiplo do teto que liga o nivel "quente" (espera cai
                                 pra 1/4). Default 2.0. Vale a regua que disparar antes:
                                 esta, ou 40% da folga entre teto e limite.
  DGCLAW_COMPACT_CRITICAL_FACTOR multiplo do teto que liga o nivel "critico" (compacta
                                 mesmo com turno em voo). Default 3.0. Idem: ou 75% da folga.
  DGCLAW_COMPACT_RESUME_POKE   "0" desliga o poke de retomada. Default ligado.
  DGCLAW_RESUME_POKE_WAIT_S    (modo restart) segundos de espera antes de acordar a sessao
                                 nova pro poke. Default 25.
  DGCLAW_RESUME_POKE_TTL_MIN   (modo inject) minutos que o poke pendente espera a
                                 compactacao assentar antes de ser descartado. Default 60.
  DGCLAW_COMPACT_SETTLE_WAIT_S (modo inject) segundos que o run que injetou o /compact
                                 espera o recibo pra mandar o "Voltei" na hora. Default 600;
                                 0 deixa o fechamento pro proximo ciclo do timer.
  DGCLAW_INJECT_CMD            comando do HOST pra escrever na sessao viva, quando nenhum
                                 transporte do plugin funciona (TIOCSTI morto + sem tmux +
                                 sem Bunker). Vence tiocsti/tmux. Destrava o modo inject
                                 nesses hosts, e serve tambem pro poke de retomada (uma env
                                 so). Placeholders {text}, {text_json}, {file}; o comando
                                 tambem recebe o texto no STDIN e em DGCLAW_POKE_TEXT.
                                 No agent-runner do DG Claw voce NAO precisa desta env: ele
                                 fala o protocolo do painel, entao o modo bunker (abaixo) ja
                                 resolve, e resolve pros 13 timers, nao so pra este.
                                 Se ainda assim quiser um comando, use ASPAS SIMPLES no corpo:
                                   curl -sf --noproxy '*' -X POST 127.0.0.1:4311/api/agents/<id>/input \
                                     -H 'Content-Type: application/json' \
                                     -d '{"text": {text_json}}'
                                 Com aspas duplas o bash cola as aspas que o {text_json} traz e
                                 o payload sai invalido no primeiro texto com espaco.
                                 ⚠️ O `-f` do curl NAO e enfeite. Sem ele o curl sai 0 mesmo
                                 com HTTP 500, e ai o rodar_comando_de_host devolve 0, o
                                 send_resume_poke diz que deu certo e o handler APAGA o poke
                                 pendente. Perdeu o envio uma vez, calou para sempre. Com -f
                                 o curl sai != 0, isto devolve 7, o pendente fica e tenta no
                                 ciclo seguinte. Vale pra qualquer transporte que voce puser
                                 aqui: ele PRECISA falhar alto quando nao entregou.
                                 ⚠️ NAO ponha "injectWhenIdle": true aqui. A fila de ocioso do
                                 runner tem UMA VAGA (promptQuandoIdle em sessao.ts) e cada
                                 novo enfileiramento APAGA o anterior, sem avisar. O /compact
                                 se repete a cada ciclo, entao um despejo se cura sozinho; o
                                 poke de retomada dispara UMA VEZ, e despejo ali e perda
                                 definitiva. E redundante de qualquer forma: este script so
                                 escreve na sessao depois de ja ter decidido que ela esta
                                 ociosa (looks_idle), ou de proposito no nivel critico, onde
                                 esperar e justamente o que nao se quer.
  DGCLAW_INJECT_MODE           "bunker" | "tiocsti" (default) | "tmux". Resolvido pelo
                                 _lib/inject: ter DGCLAW_BUNKER_CARD definido ja liga o
                                 bunker sozinho. Ver DGCLAW_BUNKER_CARD/URL no _lib/inject.py.
  DGCLAW_RESUME_POKE_ENVELOPE  "auto" (default) embrulha o poke em <plataforma> quando a
                                 persona usa o canal dgchat; "plataforma" forca; "none" manda
                                 cru. Sem isso, no agente entregue o hook stop-force-reply le
                                 o poke como a PESSOA falando e cobra resposta pelo canal.
  DGCLAW_RESUME_POKE_CMD       comando do host pra entregar o poke quando a injecao do
                                 plugin nao funciona (TIOCSTI morto, sem tmux, sem Bunker).
                                 Placeholders: {file} = caminho do arquivo do poke (texto),
                                 {text} = mensagem pronta, {text_json} = a mesma mensagem
                                 como string JSON (com aspas). O comando tambem recebe a
                                 mensagem no STDIN e nas envs DGCLAW_POKE_FILE/DGCLAW_POKE_TEXT.
                                 Ex. (runner proprio, POST /api/agents/<id>/input) — de novo
                                 com aspas SIMPLES no corpo, pelo mesmo motivo de cima:
                                   curl -sf --noproxy '*' -X POST 127.0.0.1:4311/api/agents/<id>/input \
                                     -H 'Content-Type: application/json' \
                                     -d '{"text": {text_json}}'

  DGCLAW_NAME                  nome da persona (so pra mensagem ao dono).

CLI:
  auto-compact.py                       checa e compacta se acima do teto
  auto-compact.py --dry-run             so reporta, NAO injeta
  auto-compact.py --threshold 0.6       override do teto (fracao ou tokens)
  auto-compact.py --force               ignora cooldown e checagem de ociosidade
"""

import sys
from pathlib import Path

# reusa a lib de injecao do plugin (NAO reimplementar TIOCSTI/identificacao da sessao)
sys.path.insert(0, str(Path(__file__).resolve().parent / "_lib"))

# A logica fica em scripts/_lib/auto_compact/. Os nomes abaixo continuam acessiveis aqui
# porque os testes carregam este arquivo como modulo.
from auto_compact.ambiente import (  # noqa: E402,F401
    log,
    env,
    resolve_workspace,
    resolve_slug,
    resolve_session_dir,
    resolve_logs_dir,
    resolve_state_file,
    resolve_threshold,
    escalation_marks,
    resolve_compact_mode,
    resolve_channel_service,
    resolve_working_memory,
)
from auto_compact.estado import (  # noqa: E402,F401
    load_state,
    save_state,
    cooldown_remaining,
    notify_owner,
    _modo_seguro,
    _antes,
)
from auto_compact.transcript import (  # noqa: E402,F401
    find_live_transcript,
    resolve_live_transcript,
    context_tokens,
    looks_idle,
    had_compact_since,
)
from auto_compact.tarefas import (  # noqa: E402,F401
    _CHANNEL_TAG,
    _CHANNEL_END,
    _META_TYPES,
    _blocks,
    _is_channel_msg,
    _strip_channel,
    turn_snapshot,
    _NOTIF_RE,
    _SUMMARY_RE,
    background_tasks,
    _resumo_bg,
)
from auto_compact.injecao import (  # noqa: E402,F401
    inject_compact,
    rodar_comando_de_host,
    inject_text,
)
from auto_compact.carryover import (  # noqa: E402,F401
    CARRYOVER_START,
    CARRYOVER_END,
    _load_thread_log,
    build_carryover_block,
    write_carryover,
    service_main_pid,
    pid_da_sessao,
    restart_and_verify,
)
from auto_compact.poke import (  # noqa: E402,F401
    resume_poke_enabled,
    write_resume_poke,
    usa_canal_dgchat,
    envelope_poke,
    send_resume_poke,
)
from auto_compact.modo_restart import (  # noqa: E402,F401
    do_restart_compact,
)
from auto_compact.ciclo import (  # noqa: E402,F401
    fechar_ciclo_pendente,
    esperar_assentar_e_fechar,
)
from auto_compact.principal import (  # noqa: E402,F401
    main,
)


if __name__ == "__main__":
    sys.exit(main())
