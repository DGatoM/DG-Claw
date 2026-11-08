# QA de navegador: ícones espalhados e menu em grupos

Data: 08/11/2026. Código testado: o worktree `dgclaw-oficial-nevoa` (branch `feat/redesign-nevoa`) como será servido, sem etapa de build.
Ambiente: servidor Web e painel de um agente falso ("Tina") numa pasta temporária, em porta alta (`qa/montar-ambiente.mjs`), Chromium
headless do `~/.cache/ms-playwright`, Playwright 1.64. O roteiro de teste e os prints ficam fora do git, em
`/root/claude/projetos/dgclaw-vitrine-arte/redesign-interface/qa/` (`qa-redesign.mjs`, pasta `redesign/` com os prints e o `resultado.json`,
mais `menu-1440.png` e `menu-390.png`).

## Telas e fluxos exercitados (1440x900 e 390x844)

| Tela ou fluxo | O que foi feito |
| --- | --- |
| Login | Usuário e senha errados (mensagem "Usuário ou senha incorretos..." aparece) e certos (chega na conversa) |
| Conversa | Mandar mensagem, anexar uma imagem, abrir o menu (celular), trocar de agente pelo seletor (foi para o Admin), abrir o Tutorial |
| Mesa, Lembretes, Avisos, Segurança, Anonimizar, Colaboradores, Conectar | Abertas, medidas e varridas |
| Painel do agente (`/p/tina/`) | Conversa e as 14 abas pelo menu: Status, Memória, Operações, Custos, Como funciona, Identidade, Personalidade, Apps, Skills, Rotinas, Pasta, Cofre, Socorro e Sessões |
| Menu em grupos | Grupo ativo abre sozinho, selo no cabeçalho com o grupo fechado, teclado, foco, estado lembrado ao recarregar, visita guiada |
| Reduzir Movimento | Contexto com `reducedMotion: reduce`, tela de Lembretes com a API lenta |

Em cada tela, medido por script: rolagem horizontal, emoji ou símbolo visível (texto, `title`, `aria-label`, `placeholder` e `::before`/`::after`),
todo `<use>` apontando para um símbolo que existe e com tamanho maior que zero, nenhum ícone com mais de 60 px, erros de console, contorno de
foco ao apertar Tab, alvos de toque com menos de 32 px (só no celular) e contraste AA dos botões.

## Resultado por viewport

| Conferência | 1440x900 | 390x844 |
| --- | --- | --- |
| Rolagem horizontal | 0 em todas as telas | 0 em todas as telas |
| Emoji ou símbolo de interface visível | 0 (depois da correção do tooltip abaixo) | 0 |
| Ícone quebrado (`<use>` sem símbolo ou sem tamanho) | 0 | 0 |
| Ícone enorme | 0 | 0 |
| Erro de console que não seja do ambiente falso | 0 | 0 |
| Foco visível ao Tab | contorno em todas as telas | contorno em todas as telas |
| Alvo de toque menor que 32 px | não se aplica | só as caixas de seleção nativas (13 a 22 px), cuja linha inteira (rótulo, 32 a 85 px de altura) é o alvo |
| Contraste AA dos botões | 0 reprovações depois da correção | 0 reprovações depois da correção |
| Menu: grupo ativo abre sozinho | sim (Dia a dia em `/lembretes`) | sim |
| Menu: selo com grupo fechado | "3" com `aria-label` "3 pedidos esperando você nas Sessões" | idem |
| Menu: teclado | Enter abre o grupo, `aria-expanded` vira true, contorno de foco | idem |
| Menu: item de grupo fechado no Tab | `visibility:hidden`, fora da ordem do Tab | idem |
| Menu: lembra o estado ao recarregar | sim | sim |
| Menu: visita guiada abre o grupo antes de apontar | sim (item de 36 px) | sim (item de 44 px) |
| Reduzir Movimento | animação `ds-car-no-curta` (batida curta, sem passar do símbolo) | não medido neste tamanho |

Os avisos de console `menu-lado: sem a contagem de pedidos das Sessões (o painel respondeu 503...)` vêm do runner falso do ambiente de teste, que
não implementa essa rota, e foram filtrados.

## Problemas achados e o que foi corrigido

1. **Contraste do botão "?" do quadro de avisos**: 4,18:1 (texto `#6c8172` sobre branco). Corrigido para `#5f7566`, 4,9:1.
2. **Contraste do link azul**: `--cor-link` `#007FB8` dá 4,44:1 sobre o branco e 4,07:1 sobre o fundo cinza (abaixo de 4,5). Corrigido para `#0074A8`
   (5,17:1 e 4,73:1).
3. **Contorno de foco azul-claro**: `#00B4FF` sobre o branco dá 2,3:1 (o WCAG pede 3:1 para o contorno). No tema claro o foco passou a usar o azul escuro
   (5,2:1); no escuro continua o azul-claro (7,2:1).
4. **Tooltip da aba Status com emoji**: o texto da dica de "Pendências ativas" citava a linha do arquivo de memória com o raio. Reescrito em palavras.
5. **Falso positivo do próprio roteiro de QA** (ícones em contêiner oculto contados como sem tamanho) e seletores do roteiro desatualizados depois do menu em
   grupos: corrigidos no roteiro, não no produto.
6. Achados de código, pegos pelos testes e não pelo navegador: `dsIcone` ausente nos testes que carregam arquivos soltos em Node (substituto em
   `web/test/_ds-stub.js`), `innerHTML` proibido na aba Sessões do painel (o ícone passou a ser criado por DOM), `[data-extra]` marcando o Navegador e
   fazendo `extras()` apagá-lo (corrigido: só os extras de verdade levam a marca).

## O que ficou

- Caixas de seleção nativas com 13 a 22 px no celular (Lembretes, Avisos, Anonimizar): o alvo de toque é o rótulo, de pelo menos 32 px de altura. Não mexi.
- Cor de acento das visualizações do agente (`web/public/dgvis.css`, `--dv-acento: #2f9e5e`): o CSS é injetado num iframe isolado e as cores fazem parte do que o
  agente desenha. Não foi trocada.
- A cor do avatar de cada agente (o círculo do menu e do cabeçalho) continua vindo do cadastro do agente e, sem cor, cai em `#2f9e5e`. É dado do agente, não
  acento da interface.
- O destaque do item ativo do menu usa a cor do agente (como antes), com texto branco; para a cor de teste (`#c2410c`) dá 5,2:1. Um agente com cor clara pode
  reprovar AA nesse destaque.
- Não foi feito QA de impressão, de tema escuro e de leitor de tela real.
