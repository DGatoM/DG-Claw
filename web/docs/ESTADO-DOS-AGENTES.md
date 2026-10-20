# Estado dos agentes: selos, "não lida" e avisos no celular

Com vários agentes trabalhando, o menu e a fileira de avatares mostram de relance quem está
trabalhando, quem terminou e quem **precisa de você**. O celular recebe um aviso nos dois últimos casos.
Esta página é a fonte do `GET /api/v1/estados/docs.md`.

## Os estados

| Estado | Quando | Selo |
| --- | --- | --- |
| `trabalhando` | o runner diz `working` (ou `spawning`) | três pontinhos verdes (parados se o aparelho pede menos movimento) |
| `precisa_de_voce` | `waiting_input` (permissão ou pergunta de escolha) ou login da conta expirado/faltando | círculo âmbar com "!", texto "precisa de você" e o resumo |
| `terminou` | ocioso com resposta que você não leu, ou conversa que você marcou como não lida | bolinha vermelha com a contagem (ou um ponto, se foi marcada sem mensagem nova) |
| `ocioso` | ocioso e tudo lido | nenhum |
| `sem_sinal` | o runner não respondeu, ou informou um status que não conheço | nenhum (e nunca vira `ocioso`) |

Prioridade do selo quando mais de um vale: **precisa de você, depois não lido, depois trabalhando**.
O agente em que você está não ganha selo (a própria conversa já mostra o que ele faz). O botão ☰ ganha o
mesmo selo âmbar quando **outro** agente precisa de você.

`motivo` diz por que ele precisa de você: `permissao`, `pergunta` ou `login`. Vem do runner
(`GET <runner>/api/agents/<id>`, campo `motivo`, zerado a cada troca de status). Runner antigo, sem o campo,
cai em `permissao`. Codex não informa motivo (`null`) e o resumo fica "está esperando você".

## `GET /api/v1/estados`

Com a sessão do painel. Devolve, por agente:

```json
{"ok":true,"agentes":{
  "ana":{"estado":"precisa_de_voce","motivo":"permissao","resumo":"pede permissão para rodar Bash",
         "nao_lidas":0,"marcada_nao_lida":false,"visto_ep":1791817285,"ultima_ep":1791817285},
  "bia":{"estado":"terminou","motivo":null,"resumo":null,"nao_lidas":2,"marcada_nao_lida":false,
         "visto_ep":1791817000,"ultima_ep":1791817285},
  "caio":{"estado":"sem_sinal","motivo":null,"resumo":null,"nao_lidas":null,"marcada_nao_lida":false,
          "erro":"Não consegui falar com o runner de Caio ..."}
}}
```

- `resumo` é uma frase curta montada pelo servidor só com o **nome** da ferramenta ("pede permissão para
  rodar Bash", "fez uma pergunta", "o login da conta expirou"). Nunca o comando nem o texto do pedido.
  Passa pelo mascarador de segredos e é cortado em 80 caracteres.
- `nao_lidas` e os campos `visto_ep`, `ultima_ep`, `mais`, `marco_novo` são os mesmos de
  `GET /api/v1/nao-lidas` (que continua existindo, agora também com `marcada_nao_lida`). `null` é "não medi", nunca 0.
- Por que uma rota nova em vez de estender `/nao-lidas`: o estado não depende de usuário e vem do runner;
  a contagem depende de usuário e vem da conversa. Misturar os dois num nome que diz "não lidas" confunde
  quem lê a API. A tela faz uma chamada só (o `/estados` já traz a contagem).
- A rota é só do dono, com a sessão do painel. Ela não entra na caixa dos agentes: um agente
  de trabalho que tenta recebe 403, porque não tem por que enxergar o estado nem o nome dos vizinhos.
- A tela consulta a cada 10 s com a aba visível e a cada 60 s escondida.

## Marcar como não lida

| Rota | O que faz |
| --- | --- |
| `POST /api/v1/agents/<slug>/nao-lido` | liga a marca. Resposta `{ok:true, marcada_nao_lida:true}` |
| `DELETE /api/v1/agents/<slug>/nao-lido` | desliga a marca |
| `POST /api/v1/agents/<slug>/lido` com `{ep, abriu:true}` | a pessoa **abriu** a conversa: avança o marco e limpa a marca. `ep` é opcional quando `abriu` é true |
| `POST /api/v1/agents/<slug>/lido` com `{ep}` | o lido automático da rolagem: avança o marco e **não** limpa a marca |

Na tela: no menu ☰, o `⋯` de cada agente (ou segurar o dedo no nome) abre "Marcar como não lida"; no cabeçalho
da conversa aberta, o botão "não lida" marca e abre o menu para a pessoa sair daquela conversa. A tela manda
`abriu:true` uma vez a cada carregamento da página (e ao voltar à aba), por isso a marca some quando você
entra de novo na conversa.

Onde fica: `<dados>/nao-lidas.json` (modo 600). O campo `usuarios` não mudou de formato; a marca vive ao lado,
em `marcadas: {usuario: {slug: true}}`. Arquivo antigo, sem `marcadas`, carrega normalmente e preserva os marcos.

## Aviso no celular

O módulo `lib/vigia-atencao.js` olha o estado de cada agente a cada 5 s e manda um aviso (Web Push, ver
[AVISOS-NO-APARELHO.md](AVISOS-NO-APARELHO.md)) nas transições:

- entrou em `precisa_de_voce`: "**Nome** precisa de você", corpo = o `resumo`, tag `atencao-<slug>`,
  abre `/a/<slug>`, fica na tela até tocar;
- estava trabalhando e ficou ocioso **com resposta nova do agente**: "**Nome** terminou", corpo sempre
  "Respondeu na conversa", tag `fim-<slug>`. O texto da resposta nunca vai para o aviso: a tela
  bloqueada não pede senha, e nenhum filtro reconhece uma senha escrita em texto comum.

Regras: a primeira leitura depois de ligar o Web só grava o estado (reiniciar nunca dispara aviso); sem sinal do
runner não é transição; no máximo 1 aviso por agente e por tipo a cada 60 s; **nenhum aviso de uma conversa que
você está olhando** (a tela manda `POST /api/v1/agents/<slug>/vendo` a cada 20 s com a aba visível; visto há
menos de 45 s suprime). O aviso não tem botão de aprovar ou negar: aprovar uma permissão exige abrir a conversa,
já autenticado.

Preferências: `GET /api/v1/push/preferencias` devolve `{ok, preferencias:{precisa_de_voce, terminou}}` (padrão
os dois `true`) e `POST` com um ou os dois campos booleanos grava (400 com o motivo se vier outra coisa).
Ficam em `<dados>/push/preferencias.json` (modo 600). Os avisos vão para todos os aparelhos inscritos, então um
tipo sai se **algum** usuário o deixou ligado. Os interruptores ficam na tela Lembretes, junto de "Avisos neste
aparelho".

## Como o runner sabe

Claude Code: o runner registra o hook `PreToolUse` (já existia) e, para a ferramenta `AskUserQuestion`, passa a
`waiting_input` com `motivo: "pergunta"`; o hook `PostToolUse` (só dessa ferramenta) devolve a `working`. O hook
`Notification` com `permission_prompt` continua levando a `waiting_input` com `motivo: "permissao"`. Login
expirado já virava `errored` (`runner:login-expirado`) e agora carrega `motivo: "login"`. Se a pergunta for
dispensada com Esc, o `Stop` do turno tira o agente do estado de espera. O `tool_use_id` que o Claude Code manda no
stdin do `PreToolUse` fica em `pendenteId` (o da pergunta, ou o do último `PreToolUse` quando é permissão) e some junto com o motivo. Codex não tem esses hooks: fica sem motivo.

## Se algo falha

- Selo parado em "trabalhando" ou sem selo nenhum: veja `GET /api/v1/estados`. `sem_sinal` com `erro` diz o
  que o runner respondeu.
- Aviso não chega: confira "Avisos neste aparelho" (ativo?), os interruptores e se você não estava com a
  conversa aberta (isso suprime de propósito). O log do Web diz "nenhum aparelho com avisos ativados" quando
  falta inscrição.
- Arquivos: `lib/estados.js`, `lib/vigia-atencao.js`, `lib/prefs-atencao.js`, `lib/nao-lidas.js`,
  `public/menu-lado.js` (selos), `public/conversa.js` (polling, "abriu", "vendo"). Testes: `test/estados.test.js`,
  `test/vigia-atencao.test.js`, `test/selos.test.js`.
