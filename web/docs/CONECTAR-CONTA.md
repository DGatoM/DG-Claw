# Página Conectar conta (`/conectar`)

## Para que serve

Conectar, ou reconectar, a conta do Claude (ou do Codex) de cada agente sozinho, quando você puder, sem
depender de alguém gerar um link e mandar por mensagem. O link de login vale por poucos minutos e vencia antes
de chegar até você. Nesta página ele só nasce no instante em que você toca em **Gerar link de login**.

A página tem um cartão por agente: o Admin primeiro (o agente supervisor, que cuida do servidor) e depois os
agentes de trabalho. Entra quem já tem usuário e senha do painel. O menu ☰ tem o item **Conectar conta**.

## Passo a passo

1. Toque em **Gerar link de login** no cartão do agente.
2. Toque em **Abrir a página de login** e entre com a sua conta do Claude. Para abrir em outro aparelho, use **Copiar link**.
3. No fim, a página mostra um código. Copie e cole no campo **Cole aqui o código**, depois toque em **Conectar**.
4. Repita no próximo cartão.

No Codex não há código para colar: a página mostra um código grande para você digitar no navegador, e o
cartão espera sozinho você terminar.

Só um cartão fica no meio do login por vez. Os outros botões de gerar ficam desligados, com a frase
"Termine o login do <nome> primeiro".

## Para o colaborador

O colaborador (pessoa convidada para um agente só) abre a mesma página, mas vê um cartão só, o do agente dele, sem menção ao Admin. O que ele pode fazer depende de o agente estar sem conta:

| Situação do agente | O que o cartão dele mostra |
| --- | --- |
| Sem conta de IA | O botão **Gerar link de login** e o passo a passo, igual ao do dono. |
| Já conectado | Só "Este agente já está conectado.", sem nenhum botão. |
| Outra pessoa conectando agora | "Outra pessoa está conectando a conta deste agente agora...", sem link, sem código e sem botão. |
| Login expirado (e a conta não é dele) | Pede para avisar o dono, sem botão. Se foi ele quem conectou a conta, ele reconecta. |
| Usa chave de API | Aviso de que não há conta para conectar. |
| O agente não confirmou o estado | Erro 503 explicando; ele tenta de novo mais tarde ou avisa o dono. |

O modal "Faça o login no seu agente" abre para ele com os mesmos textos, só quando o agente dele está com "Falta conectar", sem a memória entre cargas do dono e sem o botão "Não mostrar mais". As regras de quem pode o quê vivem no servidor (`web/lib/conta-colaborador.js`); a tela só reflete.

## Os rótulos dos cartões

Cada cartão mostra um rótulo, com o nome do agente ao lado: **Agente admin** ("Para administrar: atualizar o DG Claw,
criar agentes e configurar."), **Agente principal** (o primeiro agente de trabalho: "O seu agente do dia a dia: é com ele
que você conversa e pede tarefas.") e **Agente de trabalho** para os demais. Ao concluir, o cartão diz "Seu agente DG Claw
já está conectado."

## Tudo pronto

Quando todos os agentes que usam assinatura estão conectados, aparece a seção **Tudo pronto! Agora é só usar**: o endereço do
painel (com os botões Abrir o painel e Copiar endereço), o usuário para entrar (a senha é a mesma usada aqui e nunca aparece),
o que você vai ver (Admin e agente principal) e o vídeo "Veja em menos de 1 minuto"
(`/videos/conhecendo-o-dgclaw.mp4`, servido como arquivo estático comum, sem sessão, com suporte a Range). Se o vídeo não
carregar, só o vídeo some.

## Os selos

| Selo | Cor | O que quer dizer |
| --- | --- | --- |
| Conectado | verde | A conta está conectada. O programa do Claude do próprio agente confirmou (`conferido`). |
| Falta conectar | âmbar | Sem conta, ou o programa do agente não confirma a conta. |
| Login expirou | vermelho | A conta estava conectada e a credencial morreu. O agente parou de responder. |
| Usa chave de API | cinza | O agente trabalha com chave de API, não com assinatura. Não há conta para conectar e o botão não aparece. |
| Não consegui conferir | cinza | O programa do agente não respondeu. O cartão diz a causa e tem o botão **Conferir de novo**. |

O selo não é uma anotação do painel: vem de `conferido` e `auth`, que o painel pergunta ao programa de cada
agente a cada consulta.

## O modal de login na conversa

Você não precisa lembrar de abrir a página. Ao entrar na tela de conversa do painel, se algum agente estiver sem
login (selo **Falta conectar** ou **Login expirou**), abre sozinho o modal **Faça o login nos seus agentes**, com
um cartão por agente, os mesmos desta página: o Admin, o agente principal e os demais agentes de trabalho, nessa
ordem. Com um agente só, o título é **Faça o login no seu agente**. O link só nasce quando você toca em **Gerar
link de login**, e o resto do fluxo (abrir ou copiar o link, colar o código, selo **Conectado**) é igual ao desta página.

- **Quando abre.** Só quando pelo menos um agente está com **Falta conectar** ou **Login expirou**. Quem usa chave de
  API, um agente que não respondeu à conferência e um login já em andamento não abrem o modal. Se a conferência inicial
  falhar (sem rede, sessão vencida, erro do servidor), o modal não abre e a tela não redireciona: só fica um aviso no
  console do navegador com a causa.
- **Aparece uma única vez.** Ao abrir, o servidor guarda quais agentes sem login o modal apresentou
  (`POST /api/v1/modal-login/preferencia`, arquivo `modal-login.json` na pasta de dados, por usuário). Fechar com
  **Fazer depois** ou Esc, recarregar a página ou entrar de outro aparelho não o traz de volta. Um agente criado depois,
  que ainda não tinha sido apresentado e está sem login, reabre o modal uma vez (só com ele na conta).
- **Não mostrar mais.** Guarda no servidor que nem agente novo reabre o modal. Não há botão para desfazer, mas nada se
  perde: o caminho para conectar continua na página **Conectar conta** (menu ☰) e no cartão do agente. Se o servidor
  não responder, o modal não abre (melhor calar do que repetir) e o console diz a causa.
- **Pop-up "Seu login do Claude expirou".** O modal toma o lugar dele: se o modal abriu nesta carga da página, o pop-up
  não abre nem depois que o modal fechar (nada de dois avisos sobre a mesma coisa). Se o modal não abriu, o pop-up continua
  como antes para as expirações que surgirem depois. Se a pessoa tentar escrever ao agente com o login vencido, a faixa de
  erro orienta a reconectar pelo cartão de login ou por esta página.
- **Tela final.** Quando todos os cartões do modal ficam conectados, o modal troca de tela: **Login efetuado nos dois
  agentes** (ou **no seu agente**; com três ou mais, **nos seus N agentes**), o que fazer agora e o vídeo
  `/videos/conhecendo-o-dgclaw.mp4` (poster `.jpg`, só carrega quando você toca em reproduzir). Se o vídeo não carregar, só
  ele some. **Começar a usar** fecha o modal.
- **Sessão vencida (401)** durante o uso do modal leva ao login e volta para a mesma conversa.
- **Rotas.** Nenhuma rota nova: o modal usa `GET /api/v1/agents` e as rotas de login listadas abaixo.

## Outras IAs no futuro

A lista das IAs que o DG Claw conhece fica num lugar só, `web/public/provedores.js` (o navegador e o servidor usam o mesmo
arquivo): hoje Claude e Codex, cada uma com `ativo`. Cada cartão mostra "Com qual IA este agente vai entrar?" e o nome da IA
do agente. Como só há uma opção compatível por agente, não há seletor; a função `provedoresDoAgente` em `conectar-puro.js`
devolve só as IAs ativas e compatíveis, e o cartão vira seletor quando ela devolver mais de uma. O `POST` que gera o link manda
`provedor` com a IA escolhida. O servidor recusa com 400 (e uma frase em português) uma IA desconhecida, uma desligada e uma
diferente da do agente: trocar a IA de um agente que já existe ainda não está disponível. Sem `provedor`, nada muda.

## Erros e o que fazer

| Situação | O que a página diz |
| --- | --- |
| Código vencido ou inválido | O código vence em poucos minutos e só serve uma vez. Toque em **Gerar novo link** e cole o código novo logo em seguida. |
| 15 minutos sem terminar | O login foi cancelado sozinho. Gere um link novo. |
| Programa do agente fora do ar (503) | Diz a causa e manda conferir o Status do agente ou pedir ao Admin para reiniciar. |
| Já existe um login em andamento (409) | Termine esse login ou toque em **Cancelar**. |
| Código com espaço ou quebra no meio (400) | Mostra o texto do servidor. A página não conserta o código sozinha; só tira os espaços das pontas. Copie de novo, de uma vez. |
| Sessão do painel vencida (401) | Leva ao login e volta para `/conectar`. |

## Rotas que a página usa

Nenhuma rota é exclusiva dela; todas exigem a sessão do painel e, nas escritas, `Origin` igual ao do Web.
Contrato completo em `web/docs/LOGIN-NA-CONVERSA.md`.

- `GET /api/v1/agents`: a lista de agentes.
- `GET /api/v1/agents/<id>/login`: estado do login e selo (`estado`, `auth`, `conferido`, `precisa_login`, `login_expirado`). A cada 2 s, só para o cartão em andamento e só com a aba à vista.
- `POST /api/v1/agents/<id>/login`: gera o link (o prazo começa aqui). Aceita `{"provedor":"claude"|"codex"}` (opcional; veja "Outras IAs no futuro").
- `POST /api/v1/agents/<id>/login/codigo`: entrega o código colado.
- `DELETE /api/v1/agents/<id>/login`: cancela.
- `POST /api/v1/agents/<id>/login/oi`: quando o login conclui, pede ao agente um oi curto. Se falhar, a conta continua conectada e a página avisa a causa.
- `GET /api/v1/conectar/docs.md`: este documento.

### Respostas para o colaborador

As rotas de login são as mesmas, mas o servidor filtra a resposta e aplica as regras abaixo (código em `web/lib/conta-colaborador.js`):

- `GET`: com a conta conectada devolve só `{ok, conectado:true, precisa_login:false, provedor}`. Sem conta, devolve `estado`, `link`, `codigoDispositivo` e `mensagem` **só se a reserva em andamento for dele** (senão `ocupado:true` e `estado:"nenhum"`), mais `conectado:false`, `precisa_login:true` e `provedor`. Login expirado que não é dele: `so_dono:true`, `login_expirado:true`. Chave de API: `chave_api:true`. Nunca `auth`, `conferido`, e-mail da conta.
- `POST` (começar): só com o agente sem conta (confirmado na hora); `409` se já há conta, se usa chave de API ou se outra pessoa tem a reserva; `403` se o login expirou (só o dono reconecta, mesmo que o colaborador tenha conectado a conta); `503` na dúvida.
- `POST .../codigo`: só com a reserva dele, e reconfere que a conta ainda não existe imediatamente antes de mandar ao runner.
- `DELETE`: só a própria reserva (`403` sem reserva). `POST .../oi`: só com reserva dele ou se foi ele quem conectou a conta.
- **Reserva:** uma por agente, em memória, de 15 minutos, com fila por agente cobrindo a conferência e a reserva. O dono também a segura quando começa um login; o dono recebe `409` no `POST` e no `codigo` enquanto o colaborador está conectando, e vê `login_de:"colaborador"` e `login_de_email` no `GET` (sem link nem código). O dono pode cancelar com `DELETE`.
- Quando o `GET` observa a conta conectada depois de uma reserva com código enviado, grava quem conectou em `conta-agentes.json` e solta a reserva. O log diz `Conta de IA do agente <slug> conectada por <e-mail> (colaborador|dono)` e nunca traz link, código ou senha.
- `sem conta` = `status errored` com `runner:sem-login`, ou `conferido.ok:false` com `conferido.motivo:"sem_credencial"`. Qualquer outro `ok:false` (tempo, ilegível, método diferente, runner antigo sem o campo) é dúvida e recusa. Antes de iniciar e de mandar o código a conferência é refeita sem cache (`GET /api/provedor?fresco=1` no runner, que responde `fresco:true`); runner antigo é dúvida.
- A sessão é conferida de novo depois de ler o corpo; se o acesso foi revogado no meio, `401`.

## O que nunca vai para log

O link de login (ele carrega o estado do OAuth) e o código colado nunca vão para console, log, `localStorage`,
endereço da página nem atributo `title`. O campo do código é limpo logo depois do envio, com sucesso ou erro.
Todo texto vindo do servidor entra na tela como texto, nunca como HTML.
