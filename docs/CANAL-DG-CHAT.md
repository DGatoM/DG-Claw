# O canal DG Chat dentro do DG Claw

Escrito em 11/08/2026, quando o servidor MCP do DG Chat foi portado da plataforma
(DG AI Bunker) para o plugin. Requisito da release v0.5.

## O buraco que isto fecha

O painel do agente tem a aba Conversa desde 10/08. Ela lê a conversa do transcript da
sessão viva, pelo `scripts/_lib/thread_log.py`, e escreve na sessão viva pelo
`scripts/_lib/inject.py`. Escrever sempre funcionou. **Ler a resposta, não.**

O `thread_log.py` só conta como fala do agente o que sai por uma *tool de envio*
(`telegram__reply`, `mcp__dgchat__reply`, `mcp__dgchat__send_file`). Texto solto do
assistente não conta, e isso é de propósito: é o mesmo contrato do Telegram, o que
permite ao agente trabalhar, errar, tentar de novo e só então falar.

Só que numa VPS sem a plataforma o agente **não tinha a tool `mcp__dgchat__reply`**. Ela
mora no `agents-server`, que a aluna não instala. Resultado medido: a dona escrevia no
painel, a mensagem chegava no agente, ele respondia em texto, e a resposta não chegava em
ninguém. A tela ficava com a pergunta dela e silêncio embaixo.

## A decisão: a entrega é o próprio transcript

O prompt desta tarefa abria três caminhos (POST no painel, escrita no `outbound.jsonl` que
o painel lê, ou os dois). Nenhum dos três é o certo, porque os três inventam um segundo
caminho de entrega para uma conversa que já tem um.

**A chamada da tool É a entrega.** O `tools/call` fica gravado no transcript como
`tool_use`, o `thread_log.py` já casa `__dgchat__reply` e `__dgchat__send_file` por sufixo,
e o painel já relê o transcript a cada poll. Não falta transporte nenhum: falta a tool
existir para o agente poder chamá-la.

Consequências que valem o texto:

1. **O painel não ganha rota de escrita.** Ele continua praticamente só-leitura, sem
   receber POST de um processo que roda como o agente. Um POST compraria 1,5 s de cache e
   custaria uma superfície autenticada nova.
2. **Não existe segunda versão da conversa.** É a mesma regra do `panel/lib/conversa.js`:
   uma tabela paralela é uma segunda verdade que um dia discorda da primeira.
3. **Plugar o Telegram depois não muda nada aqui.** As duas origens caem na mesma sessão e
   aparecem na mesma lista, marcadas por `via`.

O `outbound.jsonl` continua existindo, e é **registro de entrega, não a conversa**. Ninguém
o lê para montar a tela. Ele serve para o `/doctor` e para responder à pergunta que sempre
aparece quando algo some: "ele acha que falou; saiu alguma coisa?". Fica igual ao da
plataforma de propósito, para os dois arquivos continuarem diffáveis.

## A diferença de comportamento que NÃO podia ser copiada

Na plataforma, `DGCHAT_URL` ausente significa canal degradado, e a tool responde ao agente
"registrado para entrega, a pessoa vê quando a janela dela reconectar".

No plugin, `DGCHAT_URL` ausente é o **estado normal**: não há `agents-server` para empurrar
nada, e a dona já vê a mensagem no próximo poll. Repetir a frase da plataforma seria mentir
para o agente, e um agente que acredita que a mensagem ficou pelo caminho reenvia.

Por isso o servidor tem dois modos, decididos por ambiente:

| Modo | Quando | O que a tool responde |
| --- | --- | --- |
| `transcript` | sem `DGCHAT_URL` (aluna, DG Claw sozinho) | `Entregue.` |
| `plataforma` | com `DGCHAT_URL` (card do Bunker) | `Entregue.` ou, se o empurrão falhar, o aviso de atraso |

## As peças

| Peça | Onde | O que faz |
| --- | --- | --- |
| servidor MCP | `scripts/dgchat-mcp/server.mjs` | as tools `reply` e `send_file`, só builtins do node |
| bancada | `scripts/dgchat-mcp/test-server.mjs` | fala JSON-RPC no stdio do servidor de verdade |
| fiação | `scripts/launch.sh` | escreve o `.dgclaw/dgchat.mcp.json` e passa `--mcp-config` |
| a regra | `scripts/bootstrap-identity.sh` | a REGRA ZERO do DG Chat entra sempre; a do Telegram, só se plugado |
| leitura | `scripts/_lib/thread_log.py` | já casava as duas tools por sufixo, não mudou |

## Armadilhas

- **`--strict-mcp-config` derrubaria os MCPs globais.** Nunca usar. O `--mcp-config`
  sozinho soma.
- **As tools precisam estar em `permissions.allow`** em qualquer modo que não seja
  `bypassPermissions`, senão o agente para em "aguardando permissão" a CADA resposta. O
  `launch.sh` do modo servidor sobe em bypass, então lá não morde; o modo local
  (`local/templates/settings.json.tmpl`) precisa da liberação escrita, e a tem.
- **O painel e a cópia do plugin (`.dgclaw/plugin/`) têm que ser da mesma versão.** Um
  painel novo com um plugin velho não tem o `server.mjs`, e o agente volta a não ter como
  falar. O `install-panel-service.sh` avisa.
- **O `chat` vem do envelope.** O painel monta `c_<slug>` por padrão
  (`DGCLAW_CHAT_ID` sobrescreve). O agente nunca deve inventar esse valor.
