# Poder: meetings (Reuniões) — TRAVADO nesta versão

> Status: **não acoplado no v1 do DG Claw.** Aparece como tile travado no painel (aba REUNIOES) e em
> `/dgclaw:powers`. Este arquivo documenta o que o poder fará quando for acoplado — não tente instalar.

## O que vai fazer
Deixar a pessoa virtual **participar de reuniões** (Zoom/Meet/Teams) via **Recall.ai**: entrar como bot,
transcrever em tempo real, monitorar o chat e, conforme o modo (interno/cliente/aula), contribuir ou
mandar insights pro dono no Telegram. Os transcripts viram memória (diário + vault).

## O que vai instalar (quando acoplado)
- Config do poder: `<ws>/.dgclaw/meetings.json` (API key Recall, modo default, pasta de transcripts).
- Servidor de webhook (realtime endpoints) + túnel.
- Aba REUNIOES do painel destrava (lê `meetingsDir`).
- `powers.py enable meetings`.

## Dependências
- Conta/API key da Recall.ai.
- Captions habilitadas pelo host nas chamadas (requisito do Zoom).

## Ativar / desativar (futuro)
- Ativar: `/dgclaw:powers install meetings` (vai conduzir a coleta da API key etc.).
- Desativar: `python3 .../powers.py disable meetings` → aba REUNIOES volta a travar; dados preservados.
