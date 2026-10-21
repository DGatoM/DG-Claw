# Conversa no DG Claw v1

O chat do navegador é o ponto de entrada do DG Claw. Depois de entrar com usuário e senha,
o dono abre a conversa do Admin em `/a/admin` ou escolhe um agente no menu à esquerda.

## Como uma mensagem chega

1. O navegador envia o texto ou anexo para a API autenticada do Web.
2. O Web localiza o agente no registro e encaminha a mensagem ao runner correspondente.
3. O runner entrega a mensagem à sessão Claude Code ou Codex do agente.
4. O agente responde pelo MCP dgchat. O Web acompanha o registro e apresenta a resposta.
5. A conexão de eventos do navegador atualiza a conversa e o estado do agente.

Uma conexão aberta com o painel não significa que o agente está disponível. O cabeçalho
mostra **agente sem sinal** quando o runner não responde. Durante o envio, a gravação de áudio
ou outras ações, ele informa o andamento da ação em curso.

## Admin e primeiro agente

O Admin é a sessão administradora do servidor. O botão **Quero criar meu primeiro agente**
inicia a conversa e o formulário reúne as escolhas do dono. O Admin executa a criação e
acompanha a conexão da assinatura. Uma resposta real de teste libera a apresentação final.

O [fluxo do primeiro agente](../web/docs/PRIMEIRO-AGENTE.md) descreve os estados, o formulário,
a foto e a apresentação com movimento reduzido.

## Conversa, arquivos e visuais

O chat apresenta mensagens, anexos, arquivos e visuais interativos conforme os recursos
habilitados. Os arquivos passam pelas rotas autenticadas do Web. Um visual pode oferecer
botões que enviam uma escolha para a conversa; isso exige a interação da pessoa.

Telegram e outros canais são opcionais. A instalação inicial funciona pelo chat do painel,
sem configurar um bot. O histórico disponível depende dos registros da sessão e das conexões
habilitadas no agente.

## Voz: ouvir a resposta

Com o modo de ouvir (🔊) ligado, a tela manda `voz: true` no corpo do `/send` e o envelope chega ao
agente com `voz="1"` no fim dos atributos: `<dgchat from chat msg ts voz="1">texto</dgchat>`. O
significado é que a resposta vai ser OUVIDA, então o agente responde curto, em frases simples e
faladas, sem tabela, lista longa nem URL. Só o booleano `true` liga (qualquer outro valor sai sem o
atributo) e comando de barra nunca leva a tag. Quem lê o envelope pega `from`, `chat`, `msg` e `ts`
por nome, então o atributo extra passa sem efeito e a tela não o mostra.

Para tocar, a tela pede `POST /api/v1/tts` com `parte`. O servidor limpa o texto (markdown, tabela,
código e link não viram fala), fatia por parágrafo e frase (1º pedaço até 450 caracteres, os demais
até 1200, no máximo 40 pedaços) e devolve o pedaço pedido com `X-TTS-Partes`, `X-TTS-Parte` e
`X-TTS-Chars`. A tela toca em sequência e já pede o próximo enquanto o atual toca. Parar de falar ou
gravar um áudio novo interrompe a fila inteira. O botão 🎧 de cada fala do agente toca ela de novo
(só com o modo de ouvir ligado) e não abre o microfone no fim.

## Modo escondido

O botão 👁 do cabeçalho esconde nomes, valores e contatos de todas as mensagens para mostrar a tela
numa aula. Como funciona, variáveis, cache e limites: [MODO-ESCONDIDO.md](MODO-ESCONDIDO.md).

## Campo de senha na conversa

Quando o dono vai guardar uma chave de API, o agente responde com um bloco ```` ```dgcofre ````
contendo o nome da variável (ex. `GROQ_API_KEY`) e, na segunda linha, um rótulo opcional. A tela
(`web/public/campo-cofre.js`) troca o bloco por um cartão com campo de senha e o botão **Salvar no
cofre**. O valor vai por `POST /p/<agente>/api/cofre` (com `aplicar: true`) e nunca entra na
conversa, no histórico nem no `localStorage`; este guarda só o marcador `dgcofre-salvo:<agente>:<hash>`.
Nome fora de `^[A-Z_][A-Z0-9_]{1,63}$` vira bloco de código comum. Depois de salvar, a tela manda ao
agente "NOME salva no cofre." (com novas tentativas enquanto ele reinicia).

## Componentes

| Componente | Responsabilidade |
| --- | --- |
| `web/server.js` | API autenticada, páginas e encaminhamento |
| `web/lib/` | Registro, conversa, mídia e serviços do Web |
| `web/public/conversa.js` | Interface do chat e eventos |
| `runner/` | Sessões dos provedores |
| `scripts/dgchat-mcp/` | Respostas e anexos enviados pelos agentes |

O botão **Tutorial** explica a interface. A [arquitetura](ARQUITETURA.md) descreve os serviços
instalados e a separação entre Admin e agentes.
