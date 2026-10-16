# A sessão principal é o terminal do agente

Escrito em 12/10/2026 para a v1 (requisito C1 da Imersão). Uma página: quem quiser o detalhe de
cada peça segue os links do fim.

## A regra

Cada agente tem **uma sessão principal**, e ela é o terminal dele: o processo `claude` (ou `codex`)
que o runner mantém aberto num PTY. Todas as portas de conversa escrevem nesse mesmo terminal. Nenhum
canal é dono da sessão.

Até a versão anterior era o contrário: a sessão principal nascia já presa ao Telegram
(`claude --channels plugin:telegram...` dentro de um tmux) e o painel entrava de carona, digitando
no tmux. Quem não tinha bot ficava com um agente sem porta de entrada própria, e desligar o Telegram
derrubava a sessão.

## Quem entra e por onde

```
DG Claw Web (chat)  ──POST /input──┐
painel do agente    ──POST /input──┼──> runner ──> PTY da sessão principal (claude)
Telegram (opcional) ──--channels───┘                       │
                                                           v
                                          transcript (.jsonl) = a conversa
```

| Porta | Como entra | Como a resposta volta |
| --- | --- | --- |
| Chat do DG Claw Web | `POST <runner>/api/agents/<id>/input` com o envelope `<dgchat from="pessoa" ...>` | tool `mcp__dgchat__reply` / `send_file`, lida do transcript |
| Aba Conversa do painel | `scripts/_lib/inject.py` no modo `bunker`, que chama o mesmo `/input` do runner | a mesma leitura do transcript |
| Telegram | plugin oficial pelo `--channels`, na sessão principal, só com motor Claude | tool `telegram__reply`, que o Web também mostra (marcada `via: telegram`) |
| WhatsApp (quando entrar) | mensagem marcada como externa, só de número da allowlist | a mesma ideia do Telegram |

O transcript é a fonte única da conversa. O Web e o painel leem o mesmo `.jsonl`, por isso uma
mensagem mandada pelo Telegram aparece no chat do navegador na ordem certa, sem sincronizar nada.

## Consequências que valem saber

1. **O chat funciona sem canal nenhum.** O agente nasce falando pelo DG Claw Web. Telegram e
   WhatsApp são opcionais e se ligam por pedido em linguagem natural (skill `canais`).
2. **Ligar ou desligar um canal não perde a conversa.** O comando `dgclaw-agente canal telegram
   ligar|desligar` grava `~/.dgclaw/canais.json` e pede `POST /api/agents/<id>/reiniciar` ao runner,
   que sobe o mesmo terminal com `retomar` (mesma conversa, argumentos novos).
3. **Só a principal escuta o canal.** Sessões paralelas (cards) e motor Codex rodam com o Telegram
   desligado de propósito, senão uma delas consumiria as mensagens do bot e jogaria fora.
4. **O Admin não tem canal.** Ele só fala pelo chat do Web, e lá aceita comandos de terminal crus
   (`/compact`, `/clear`), porque o chat digita no PTY dele.
5. **Segredo não passa pelo terminal.** Se o dono colar no chat um token do BotFather, o Web guarda o
   token direto em `~/.dgclaw/telegram/.env` do agente e manda ao terminal só
   `[token do Telegram guardado com segurança, final XXXX]`. O token não entra no transcript.

## Onde está cada coisa

- Runner, canais e reinício: `runner/src/sessao.ts` (`lerCanais`, `--channels`, sessões paralelas sem
  canal) e a seção 4b da especificação do adaptador de provedor.
- Chat do Web: `web/lib/conversa.js` (envio e envelope) e `web/lib/thread.js` (leitura do transcript).
- Aba Conversa do painel: `docs/CONVERSA.md`. Tool de resposta: `docs/CANAL-DG-CHAT.md`.
- Passo a passo do Telegram que o agente conduz: `skills/canais/SKILL.md`.
