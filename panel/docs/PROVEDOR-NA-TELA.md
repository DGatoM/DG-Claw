# Modelo e autenticação na tela Status

O cartão "Modelo e autenticação" fica no topo da aba Status. Ele responde duas perguntas do dono do agente: qual modelo de IA o agente usa agora, e como isso é pago.

## O que a tela mostra

- **Linha grande:** o modelo e a forma de pagar, por exemplo "Claude Opus 5.5, na assinatura". Passando o mouse na forma de pagar, o painel explica o que ela significa.
- **Linha pequena, "conferido":** há quanto tempo o painel checou. A conferência não lê a configuração. O painel pergunta ao agente, e o agente pergunta ao próprio programa do Claude ou do Codex se ele está logado e de que jeito.
- **Amarelo:** o que foi escolhido e o que o programa confirma não batem. O texto diz o motivo e o que fazer. Os casos:
  - "configurado na API, mas a chave não está no Cofre": clique em Trocar e cole a chave;
  - "o agente não está logado na assinatura": aparece o botão "Entrar com a assinatura";
  - "o programa não confirmou a chave de API": cole a chave de novo em Trocar.
- **Sem runner novo:** se a plataforma que roda o agente é antiga e não sabe informar o modelo, o cartão diz "O agente ainda não sabe informar o modelo", com o que fazer, e esconde os botões. O resto do painel não é afetado.

## De onde vem cada dado

| Dado | Fonte |
| --- | --- |
| Provedor, forma de pagar, modelo, rótulo, conferido, estado do login | O runner (`GET /api/provedor`). Ele nunca manda e-mail, token nem pedaço de chave. |
| Lista de provedores, modos, explicações, modelos | `providers/catalogo.json`, lido por `scripts/provedores/catalogo.mjs` (o mesmo validador dos scripts). Os modelos do Codex vêm do runner quando ele manda `modelos`; senão da lista de reserva do catálogo. |
| "A chave está no Cofre?" | O Cofre do painel (`lib/cofre.js`). Só metadado (existe e não foi revogada), nunca o valor. |

## O que o dono decide

- **Trocar:** abre uma janela com Provedor (o Gemini aparece desabilitado, com o motivo), Modelo e Forma de pagar. Cada forma de pagar traz a explicação embaixo. Se a forma exige chave e o Cofre não tem, a janela pede a chave ali mesmo.
- **Entrar com a assinatura:** login assistido. A tela mostra o link; no Codex mostra também o código para digitar; no Claude há uma caixa para colar o código que a página mostra no fim. A tela confere sozinha a cada 2 segundos e para quando o login termina, falha ou é fechado.

## O que acontece ao trocar

1. O painel valida a escolha pelo catálogo (erro 400 em português se algo não existe).
2. Se a forma de pagar exige uma variável (chave de API ou token) e veio chave, o painel confere a forma mínima (Anthropic começa com `sk-ant-`, OpenAI com `sk-`) e guarda no Cofre.
3. O painel avisa o runner. A chave **não** vai no corpo desse pedido.
4. Com chave: o runner grava a escolha sem reiniciar (`reiniciar:false`) e o painel chama `cofre.aplicar()`, que reinicia a unidade com a chave no ambiente. Sem chave (assinatura): o runner grava e reinicia sozinho (`reiniciar:true`).
5. A conversa atual fecha e o agente volta numa conversa nova. A memória continua. A tela mostra "reiniciando..." e consulta de novo até o agente responder.

A chave nunca vai para log, nunca volta numa resposta e é apagada do campo logo depois do envio.

## Rotas (para o agente operar por API)

Todas atrás do mesmo login das outras rotas `/api`.

| Rota | Para quê |
| --- | --- |
| `GET /api/provedor` | Escolha atual + `conferido` + `login` + `chaves` (`{VARIAVEL: true/false}`) + `catalogo`. |
| `POST /api/provedor` | `{provedor, auth, modelo, chave?}`. `provedor`: `claude` ou `codex`. `auth`: `assinatura`, `token` (só Claude) ou `api`. `modelo`: id ou apelido do catálogo, vazio para o padrão. Respostas: 200 `{ok, reiniciando, rotulo}`; 400 escolha inválida ou chave com forma errada; 409 `{precisaChave, ondeCriar}` quando falta a chave; 503 runner antigo ou fora do ar. |
| `POST /api/provedor/login` | Começa o login assistido do provedor atual. |
| `GET /api/provedor/login` | Estado: `nenhum`, `aguardando_link`, `aguardando_codigo`, `aguardando_navegador`, `concluido`, `falhou`. |
| `POST /api/provedor/login/codigo` | `{codigo}`: cola o código no terminal do login (Claude). |
| `DELETE /api/provedor/login` | Cancela. |

Todo erro vem como `{error, howToFix}` em português. As chamadas ao runner têm limite de 8 segundos.

## Onde está o código

`panel/lib/provedores.js` (rotas), `panel/public/js/provedor.js` e `panel/public/css/provedor.css` (tela), passos do tutorial em `panel/public/js/tutoriais.js` (chaves `modelo` e `modelo-trocar` da aba `status`), teste em `panel/test-provedor.mjs`.
