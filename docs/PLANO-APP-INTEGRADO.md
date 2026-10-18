# Plano: um app só, com a mesma casca em todas as telas

Escrito em 18/10/2026, depois do teste do Danilo na VPS de teste e do roteiro de QA novo
(`qa/roteiro-navegacao.mjs`). Este documento diz o que o app tem que ser, o que estava errado e
em que ordem a gente conserta. O detalhe de cada medida fica no relatório do roteiro.

## O que o app tem que ser

Uma pessoa entra, escolhe o agente e, daí para frente, **nada muda de lugar nem de cara** quando
ela troca de página. Em todas as telas (Conversa, Mesa, Lembretes, Avisos, Sessões e as páginas
do painel: Status, Skills, Rotinas, Cofre, Pasta, Memória, Operações, Custos, Como funciona,
Identidade, Personalidade, Apps, Socorro e as dos poderes):

| Parte | Regra |
| --- | --- |
| Cabeçalho | o mesmo, montado por `web/public/casca.js`: ☰, foto, nome do agente, nome da página embaixo, Tutorial |
| Avatar | um só, o do registro do agente (`/api/v1/agents`: `avatar_img`, `avatar`, `cor`). Nenhuma tela pinta outra foto |
| Menu | um só, montado por `menu-lado.js` a partir de uma única marcação (a da casca). Mesmos itens, na mesma ordem, em todas as telas |
| Cor | a do agente (`--accent`). O roxo antigo do painel não aparece dentro da casca |
| Tipografia | a pilha de fontes da casca, no cabeçalho, no menu e no conteúdo |
| Celular | 390 px sem rolagem horizontal, menu em gaveta; 1440 px com o menu fixo à esquerda |

## O que estava errado (e por quê)

1. **A causa principal foi a atualização.** O painel de cada agente roda dentro da imagem do
   container. Na VPS de teste, o Web foi atualizado, mas a imagem não foi reconstruída: as páginas
   do painel continuaram na versão de 17/10, com o menu roxo e outra foto. Clicar em Status trocava
   de servidor e, por isso, de visual. Correção: `dgclaw atualizar` (PR #29) sempre reconstrói a
   imagem e recria o container de cada agente.
2. **Sessões só aparecia no menu depois de abrir o painel.** Quem acrescentava o item era o
   próprio painel. Na Conversa ele não existia, e foi por isso que o Danilo não achou o mini-Bunker.
3. **O conteúdo do painel ainda tinha a fonte e o roxo dele**, e um segundo cabeçalho ("Status,
   como ele está agora") embaixo do cabeçalho da casca.
4. **O menu estava escrito duas vezes** (na `conversa.html` e na `casca.js`). Qualquer ajuste
   feito só numa delas fazia o menu voltar a divergir.
5. **Avisos não tinha item no menu**, e o endereço raiz `/` abria sempre o Admin, com outra foto e
   outra cor.
6. **O QA anterior não pegava nada disso** porque abria cada página pelo endereço, sem clicar no
   menu, e não comparava uma tela com a outra. O roteiro novo clica em cada item e reprova quando
   cabeçalho, avatar, menu, cor, fonte ou largura mudam.

## Ordem do conserto

1. **Atualização segura** (PR #29): `dgclaw atualizar` com backup, imagem nova, container recriado,
   conferência dos dados do aluno e reinício do Admin. `docs/ATUALIZAR.md` é o roteiro do Admin.
2. **Casca única** (este PR):
   - a Conversa passa a montar o menu pela mesma marcação da casca (uma fonte só);
   - Sessões vira item fixo do menu para todo agente com painel, em todas as telas, e o menu
     esconde o item só quando o painel diz que a aba está desligada;
   - Avisos entra no menu;
   - `/` abre o último agente usado ou o primeiro que não é o Admin;
   - sob a casca, o painel usa a fonte e a cor da casca, perde o segundo cabeçalho e não pinta
     outro avatar.
3. **Mini-Bunker visível**: botão 🖥 Sessões no topo da Conversa, como no DG Telegram, abrindo a
   tela de Sessões dentro da casca. No formulário de card novo, a pessoa escolhe Claude ou Codex
   quando os dois estiverem disponíveis no agente.
4. **QA**: o roteiro roda local e na VPS de teste, em 1440 e 390, e precisa passar antes de
   cada PR (`docs/QA.md`).
5. **Teste como aluno na VPS de teste**: o pedido de atualização vai pelo chat do Admin, que segue
   o `ATUALIZAR.md`. Se ele errar, o defeito é do documento ou do comando, e a gente corrige lá.
6. **Sugestões de UX**: subagentes visitam cada página como uma pessoa leiga e anotam o que
   mudariam. A lista priorizada fica em `docs/SUGESTOES-UX.md`, sem aplicar: quem escolhe é o Danilo.

## O que fica de fora por enquanto

- O balão cortado embaixo não se reproduz no Chromium, nem local nem na VPS de teste. Ele deve
  depender do app instalado no iPhone (teclado e `visualViewport`). Precisa de um teste no aparelho.
- Juntar de vez o painel e o Web num servidor só. A casca resolve o visual; a fusão é uma decisão
  de arquitetura maior e fica para depois.
