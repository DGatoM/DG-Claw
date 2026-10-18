# QA de navegação do DG Claw

Este roteiro existe porque o QA antigo abria cada URL direto e olhava só o computador. O dono
percebe o problema de outro jeito: ele **clica no menu da esquerda** e vê a tela inteira mudar
(cabeçalho, avatar, cores, tipografia). O roteiro faz o mesmo caminho do dono, de verdade.

**Regra: rode o roteiro em toda atualização, antes de abrir o PR.** Mexeu em `web/public`,
`panel/public`, na casca, no menu ou em qualquer CSS? Rode. Reprovou, não abra o PR.

## Como rodar

### Local (sobe tudo numa pasta temporária)

```bash
node qa/roteiro-navegacao.mjs
```

O `qa/montar-ambiente.mjs` liga o DG Claw Web (`web/server.js`) e o painel de um agente falso
(`panel/server.js`, sob `/p/tina`) do mesmo jeito que a produção liga os dois: `agentes.json` com o
Admin e o agente "tina" (foto, cor, `porta_painel`, `proxy_segredo_arquivo`), `web.env` com usuário e
hash scrypt, runner falso e um histórico de 40 trocas de mensagem. Nada toca `/etc`, `/var` nem
a máquina. A pasta temporária some no fim (`DGCLAW_QA_MANTER=1` mantém, para investigar).

Precisa de dois pacotes que o repositório não traz:

- **express do painel.** O roteiro procura em `DGCLAW_TEST_NODE_PATH`, `NODE_PATH` e
  `panel/node_modules`. Se não achar, faz `npm install` numa pasta temporária (nunca em `panel/`).
- **Playwright.** `PLAYWRIGHT_PATH=<pasta node_modules que tem o playwright>`; sem a variável ele
  tenta alguns lugares conhecidos da máquina. Os navegadores ficam em `~/.cache/ms-playwright`
  (`npx playwright install chromium` se faltar).

### Contra uma instalação de verdade (VPS de teste)

```bash
DGCLAW_QA_COOKIE=<valor do cookie dgclaw_sessao> \
  node qa/roteiro-navegacao.mjs --url https://seu-dominio --agente tina --sufixo vps
```

Entre no painel pelo navegador, copie o cookie `dgclaw_sessao` e passe pela variável (ou
`--cookie`, mas aí o valor fica no histórico do shell). É **só leitura**: o roteiro navega e tira
prints. A lista de lembretes e o foco do teste do balão são simulados no navegador, nada é criado
no servidor.

Opções: `--saida <pasta>`, `--sufixo <texto>` (vai no nome da pasta), `--larguras 1440x900,390x844`,
`--so-avisar` (relata tudo mas não reprova; saída 0).

Saída: `0` aprovado, `1` reprovado, `2` o roteiro não conseguiu rodar (a mensagem diz por quê).

## O que ele faz

1. Entra como o dono e abre a **Conversa** do agente.
2. **Clica**, no menu da esquerda, em cada item: Mesa de tarefas, Lembretes e todas as abas do
   painel (Sessões, Status, Skills, Rotinas, Cofre, Pasta, Memória, Operações, Custos, Como funciona,
   Identidade, Personalidade, Apps, Socorro), os Lembretes e os Avisos, e volta para a Conversa clicando.
   Antes disso, na Conversa, clica no botão 🖥 Sessões do cabeçalho e confere que ele abre a aba Sessões
   dentro da casca (mesmo cabeçalho, item Sessões marcado).
3. Em cada tela, em **1440x900** e **390x844** (no celular com a gaveta do menu aberta também), mede e
   grava em `medidas.json`: caixa e estilos do cabeçalho, do avatar, do nome, do menu, do item ativo e
   da área de conteúdo, mais a rolagem horizontal. Tira um print por tela.
4. Compara cada tela com a Conversa e **reprova** com mensagem em português (tela, medida, esperado,
   obtido).
5. Testa o **balão final**: abre a Conversa já rolada até o fim, faz a faixa de lembretes e a de foco
   aparecerem depois (como acontece na vida real) e confere que o último balão fica inteiro, acima da
   barra de digitação, e que a conversa continua no fim.

## O que cada checagem prova

| Checagem | O que prova |
| --- | --- |
| Cabeçalho (posição, tamanho, fonte, cores, borda) | todas as telas têm o mesmo topo. No celular a altura não entra, porque a Conversa tem a fileira das ferramentas |
| Avatar (foto ou letra, cor de fundo) | a foto e a cor do agente são as mesmas em toda tela, no cabeçalho e no menu |
| Nome do agente | mesmo texto, fonte, tamanho e peso |
| Cor de destaque (`--accent`) | ninguém pinta a tela com outra cor (o painel solto é roxo) |
| Tipografia do corpo | a família de fonte do `body` não muda entre telas |
| Menu (fundo, posição, tamanho, itens) | a barra à esquerda é a mesma, com os mesmos itens, na mesma ordem |
| Item ativo | o item marcado é o da tela aberta, com o mesmo visual |
| Menu antigo do painel (`.lado`) e segundo cabeçalho (`.header`) | os dois estão escondidos: só vale o cabeçalho da casca |
| Botão 🖥 Sessões | existe e está visível em todas as telas, com alvo de toque de pelo menos 32 px, leva a `#aba=sessoes`, mostra o rótulo no computador e só o ícone no celular |
| Ordem do menu | Conversa, Mesa, Sessões, as páginas do painel, Lembretes, Avisos, igual em todas as telas |
| Rolagem horizontal | `scrollWidth` não passa de `clientWidth`, em 390 e 1440 |
| Casca ausente | se o painel entrega uma página sem `casca.js`, o relatório diz que a causa é a versão antiga do painel (ver abaixo) |
| Balão final | o último balão não é cortado pela faixa nem escondido pela barra de digitação |

Avisos (não reprovam): arquivos que responderam 4xx ou 5xx, erro de JavaScript, faixa de foco que não apareceu.

## Quando a instalação real reprova e a local passa

O código do painel mora **dentro da imagem do container do agente** (`container/Containerfile`
copia `panel/` e roda `npm install`). Atualizar o clone na VPS não muda o painel que o dono vê: só
`dgclaw imagem construir` seguido da recriação do container muda. Se o roteiro disser "o painel
entregou uma página SEM o casca.js", é isso: a imagem ficou velha. O Web (que serve a Conversa, a
Mesa e os Lembretes) já está novo e o painel está velho, e o dono vê duas aparências.

## Onde ficam os prints

`/root/claude/qa-dgclaw-padrao/<data-hora>[-sufixo]/<largura>/NN-<tela>.png`, fora do git.
Também `medidas.json` por largura e `resultado.json` com todas as divergências.
