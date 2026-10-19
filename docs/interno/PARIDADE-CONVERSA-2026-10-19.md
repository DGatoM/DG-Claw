# Paridade da conversa com a interface da VPS (19/10/2026)

O dono usa uma cópia da interface de conversa rodando na VPS dele (repositório `dg-telegram`). Entre
15 e 18/10 essa cópia ganhou melhorias que não tinham chegado ao DG Claw oficial. Esta tabela confere
cada commit de interface daquele período contra o `main` do oficial (cc4cda5) e diz o que foi feito com ele.

Estados: **já tinha** (o comportamento existe no oficial, às vezes com outro nome), **portado** (entrou
neste PR), **não se aplica** (é só da VPS do dono ou foi desfeito depois), **a decidir** (precisa de uma
decisão antes de portar).

## Consertos que o dono apontou

| Problema | Causa | Conserto |
| --- | --- | --- |
| Menu ☰ no celular não fechava ao tocar fora | `web/public/conversa.css` tinha um `</style></head>` perdido (sobra de quando o estilo saiu do HTML). O navegador juntava isso ao seletor da regra seguinte e descartava `#overlayMenu{position:fixed;inset:0;z-index:40}`: o véu abria sem tamanho e o toque caía no balão. Reproduzido no WebKit a 390x844 com toque. | Linhas removidas e teste que reprova tag HTML dentro de qualquer `.css` público. A animação de deslizar já existia. |
| Fundo verde sobe e aparece faixa branca no fim da rolagem (iPhone) | `background-attachment:local` no `#chat` (`chat.css`) | Portado do 1883934: `scroll` + `overscroll-behavior-y:contain`. |

## Commits de interface desde 15/10

| Commit | O que é | Estado |
| --- | --- | --- |
| d42ea54 | Pilha de alertas de entrega e pedido, balão destacado | já tinha |
| f97dbec | Alerta retirado não reaparece por resposta atrasada | já tinha |
| 18f46fe | Tutorial dos alertas com holofote; prefixo fora da citação | já tinha (o oficial não tem citação) |
| 7b44ddb | Estilos do tutorial restritos; citação sem texto | não se aplica (sem citação no oficial) |
| fc81853 | Mesa: filtros de estado, tipo, busca, contadores e memória no aparelho | portado |
| c4df429 | Mídias guardadas no aparelho, acervo aos poucos | já tinha |
| e239e15 | Sem tela em branco se o módulo de mídias faltar | portado |
| f599852 | Mesa ao vivo (poll com ETag) e reconciliação com Haiku | já tinha a parte da tela; o `mesa_sync` com Haiku é da VPS: não se aplica |
| 9e55b9c | Mensagem que chega na fila é classificada certo | já tinha |
| 2776417 | Modo foco: lista ticável ao lado da conversa | já tinha |
| 4e4d182 | Modo foco recolhe em pílula e anima | portado |
| fd06b38 | Modo foco empurra a conversa quando a Mesa está ao lado | não se aplica (no oficial a Mesa é página à parte) |
| 1267e75 | Casos de uso curados na conversa da Isa (BL-600) | não se aplica (só do dono) |
| 5f51873 | Botão "Reiniciar sessão" e fim da faixa dos 3 minutos | portado (no oficial usa o `POST /reiniciar` do runner: a conversa continua de onde estava) |
| d12b396 | Aviso amarelo fechado no ✕ descansa 48 h | portado |
| 46353e9 | Conserto do ✕ do aviso (nome de função repetido) | portado junto, com o nome `fechaFaixaAviso` |
| facb1f9 | Fileira de avatares dos agentes embaixo da barra (celular) | portado, sem a bolinha de não lidas |
| ba7e767 | Corpo com a altura da tela física no iPhone | não se aplica (desfeito pelo cf10f2d) |
| cf10f2d | Fileira de agentes volta a aparecer no iPhone | não se aplica (só desfaz o ba7e767) |
| 280495b | Conversa com a Carla escondida por padrão | não se aplica (regra pessoal do dono) |
| 81eb951 | Casca do DG Claw como cópia travada na VPS | não se aplica (o oficial é a origem) |
| bf1eb16 | Lembretes com a casca e visita guiada | já tinha |
| 2be2462 | Conversa com o menu do DG Claw e a seção Mais | já tinha (a seção Mais é só da VPS) |
| 0b35048 | Sessões respeitam a barra do menu no computador | não se aplica (no oficial Sessões é aba do painel) |
| 03d573a | Painel abre em `/p/<id>/` na mesma aba | já tinha |
| 988bd29 | Hora da última mensagem de cada agente na lista do menu | portado (o `/api/v1/agents` ganhou `ultima_ts`) |
| 6101564 | Campos com 16px: nada dá zoom no app | já tinha |
| ede06f5 | Bolinha do "está trabalhando" respira | já tinha (substituída pelo 843cc13) |
| 843cc13 | Pontinhos em onda e brilho no "está trabalhando" | já tinha (#36) |
| c3df837 | Brilho do "está trabalhando" em verde claro | já tinha |
| 1883934 | Fundo verde parado no elástico do iOS | portado |
| faae5b8 | Pular em todo tutorial e zoom banido | já tinha; faltava o zoom próprio da foto aberta no visor: portado |
| e59ddce | Zoom banido na página de erro e nos visuais | já tinha |
| 8a3a973 | `sem-zoom.js` e `tour.js` iguais aos do DG Claw | já tinha (arquivos idênticos) |
| 6900c27 | Faixa branca embaixo some no app instalado | portado (a parte da conversa; a Mesa da VPS não existe aqui) |
| 09cf57e | Modo foco: botão Concluir quando tudo está ticado | portado |
| 97a8f00 | Mídias das agentes copiadas para `data/midias` | não entra, decisão do Danilo 19/10 (no oficial a mídia continua servida da casa do agente) |

## Decididos pelo Danilo (19/10)

- **97a8f00** (cópia das mídias fora da casa do agente): não entra.
- **Bolinha de não lidas por agente** (no menu e na fileira de avatares): entra, num PR separado
  (branch `feat/bolinha-nao-lidas`), com rota nova de contagem no web.

## Item novo do mesmo PR: áudio transcrito

O áudio que é transcrito e enviado direto (inclusive na conversa contínua) vai ao agente com o prefixo
`[áudio transcrito] `. O balão mostra 🎤 no lugar do prefixo. Transcrição que vai para o campo e é revisada
não leva marca. A identidade de todo agente e do Admin (`templates/ambiente/`) explica o que a marca quer dizer.

## Outros pedidos que entraram no mesmo PR

- **🦞 fora do cabeçalho da conversa:** o menu lateral já leva ao painel (seção do painel no menu). O 🦞 da
  tela vazia, do login e do primeiro acesso continua (é a marca).
- **Pendências ativas em lista** (painel, aba Status): o texto da memória de trabalho é separado em itens
  por ` | `, por marcadores `(A) `, `(B) `... ou, sem nenhum dos dois, por `; `.
- **Passo manual de atualização no CHANGELOG:** regra nova no `CLAUDE.md`, capítulo novo no
  `docs/ATUALIZAR.md` e o teste `tests/changelog`.
