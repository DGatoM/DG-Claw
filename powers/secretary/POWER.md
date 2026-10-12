# Poder: secretary (Secretária — Gmail / Agenda) — TRAVADO nesta versão

> Status: **não acoplado no v1 do DG Claw.** Aparece travado em `/dgclaw:powers`. Documentação do que
> virá — não tente instalar.

## O que vai fazer
Dar à pessoa virtual funções de **secretária executiva**: triagem de e-mails (digest priorizado), briefing
de agenda (próximas reuniões/bloqueios), lembretes — entregues ao dono pelo Telegram. Crons próprios
(ex.: digest de manhã, brief antes das reuniões).

## O que vai instalar (quando acoplado)
- Config: `<ws>/.dgclaw/secretary.json` (conta Google, filtros de prioridade, horários dos digests).
- Crons/timers de digest e brief.
- `powers.py enable secretary`.

## Dependências
- **`google_connect`**: o DG Claw já conecta Google (Drive/Gmail/Calendar) via `/dgclaw:connect`. Este
  poder pressupõe essa conexão feita.

## Ativar / desativar (futuro)
- Ativar: `/dgclaw:powers install secretary` (checa `google_connect` antes).
- Desativar: `python3 .../powers.py disable secretary` (para os timers; dados preservados).
