# Pendências do manual

Aqui ficam os itens do DG Claw que estão sem documento ou em conflito com o código, para quem mantém o manual
resolver. Base: `main` no commit `fcb79a6`. Quando um documento antigo discorda do manual, vale o que está no
manual, porque ele foi conferido no código.

## Documentos que contradizem o código

| Documento | O que diz | O que o código faz |
| --- | --- | --- |
| `templates/ambiente/admin.md` | O dono convida colaborador também pela API | `/api/v1/colaboradores` só aceita a sessão do dono. Será resolvido com o colaborador criado pelo Admin, [em desenvolvimento](em-desenvolvimento.md) |
| `web/docs/COLABORADORES.md`, `docs/BOLETINS-DE-SEGURANCA.md` | O Admin opera as rotas do Web | O Web só cria sessão pelo cookie do dono ou pela caixa de um agente, e o Admin não tem caixa |
| `docs/SEGURANCA.md` | Só a porta do Caddy fica aberta | O instalador libera as portas 22, 80 e 443 |
| `docs/SEGURANCA.md` | Bloqueio em 10 senhas erradas | Isso vale para o login direto do painel. O login do dono usa 5 por conta e 20 por IP |
| `docs/EMERGENCIA.md` | Rota da ronda disponível para os agentes | A rota é só do dono, e o agente recebe 403 |
| `docs/MEMORIA-SEMANTICA.md`, `docs/MEMORY-HOOK.md` | O instalador baixa o modelo de memória | O `install.sh` não instala o modelo |
| `docs/QUADRO-DE-AVISOS.md`, `docs/MEMORIA-SEMANTICA.md` | Ganchos `avisos.py` e `memory-recall.sh` rodam a cada mensagem | Não encontrei a ligação deles na criação do agente. Falta conferir em um servidor |
| `docs/POKES.md`, `docs/MEMORY-HOOK.md` | Transporte por teclas | O DG Claw atual entrega pelo runner |
| `docs/PROVEDORES.md` | Codex sem ganchos | `docs/PARIDADE-CODEX.md` registra ganchos nativos no Codex |
| `panel/public/js/app.js` (aba Sessões) | Permissão só se decide no DG Telegram | `panel/docs/SESSOES.md` descreve a decisão na própria tela |
| `templates/ambiente/agente.md` | Manda usar as skills `tela` e `canais` | A criação do agente liga 14 skills, e essas duas ficam de fora |

## Documentos desatualizados

- `docs/RADIOGRAFIA.md` parou em 17/10: fala só do Claude e não cita a Mesa, as sessões, os colaboradores nem o Anonimizar. É o texto da `aba:como` do painel. Até ser revista, o mapa deste manual faz o papel de visão geral.
- `docs/COMO-FUNCIONA.md`, `docs/SESSAO-PRINCIPAL.md` e `docs/CANAL-DG-CHAT.md` ainda descrevem o Telegram como canal principal.
- `docs/PARIDADE-CODEX.md` traz números de linha e commit de base antigos.
- Skills `doctor`, `importar`, `panel`, `service`, `uninstall`, `connect`, `report` e `powers` usam o vocabulário do antigo plugin.

## Sem documento próprio

- Canal Telegram: só existem os comandos na skill `canais`.
- Rotas da conversa (`/api/v1/agents` e derivadas) e várias rotas do painel de cada agente: a [referência](referencia-admin.md) marca quais são.
- Tutorial (`web/public/tour.js`).

## A conferir em um servidor de verdade

- Avisos de rotina numa instalação que só usa o chat do painel: `scripts/notify-owner.sh` depende de Telegram ou de outro transporte configurado, então o dono pode ficar sem esses avisos.
- Testes que existem e não entram no `tests/rodar.sh`: `scripts/test-gmail-permissao.sh`, `scripts/test-canal-dgchat.sh`, `scripts/test-falas-personalidade.sh`, `scripts/test-teste-isolamento.sh`, `scripts/memory_index/test_conversas_fts.py`, `scripts/test_build_working_memory.py` e `scripts/test_auto_compact_assentar.py`.
