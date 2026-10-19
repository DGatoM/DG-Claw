# Usuários, papéis e segundo fator (versão enterprise)

Vale quando a proteção `multiusuario` está ligada (níveis `escritorio`, `empresa` e `regulado`). No nível `pessoal`
nada disto existe: o Web tem um login só, o do `web.env`, e o arquivo de usuários nem é lido.

## Papéis

| Papel | Vê |
|---|---|
| `ti` | Tudo: todos os agentes, o Admin, usuários, avisos entre agentes, avisos no aparelho, proteções e a auditoria. |
| `funcionario` | Só os agentes da lista `agentes` dele. Nunca o Admin, nem as áreas do TI. |

A regra única é `podeVerAgente(sessao, slug)` (`web/lib/ent/usuarios.js`). O `server.js` a aplica em toda rota que
recebe o id de um agente; recusa com `403` e um motivo em português. Pedido que vem pela caixa do agente
(`dgclaw-api`) continua como antes: o agente fala por si.

## O arquivo

`<dados do Web>/usuarios.json` (600), `{versao:1, usuarios:[...]}`. Cada usuário: `usuario`, `nome`, `email`, `papel`,
`agentes`, `hash` (scrypt), `totp {segredo, ativo, ativado_em, codigos_reserva (sha256), ultimo_passo}`,
`link {token_sha256, criado, expira, usado_em}`, `origem`, `criado_em`, `desativado_em`, `ultimo_login`.
Na primeira partida o usuário do `web.env` vira o primeiro `ti` (mesmo hash). Gravação atômica, com a trava
`usuarios.json.trava`; a CLI usa a mesma trava.

Quem altera a lista de agentes de um funcionário vê o efeito na hora, sem novo login: a regra consulta o arquivo a cada pedido.

## Login

1. `POST /login` com usuário e a credencial. Sempre gasta o scrypt, mesmo com usuário que não existe.
2. Se a pessoa tem 2FA ativo, ou o nível exige e ela ainda não ativou, o servidor devolve uma sessão "meia" (5 minutos, só abre a tela do código)
   e a resposta traz `etapa: "codigo"` ou `"ativar"` e `destino: "/login/2fa"`. O formulário recebe um `303` para lá.
3. `GET /api/v1/login/2fa` diz a etapa (e, na ativação, o segredo, o texto agrupado de 4 em 4 e o link `otpauth://`).
   `POST /api/v1/login/2fa` com `codigo` (e `next`) confere o código e troca a sessão meia por uma completa (cookie novo).
   Na ativação a resposta traz `codigos_reserva` (10, uma vez só).
4. O código de reserva (`xxxx-xxxx-xxxx`) vale no mesmo campo e uma única vez. O mesmo código TOTP não vale duas vezes.

Exigência pela matriz: `2fa = ti` obriga o TI; `todos` obriga todo mundo. Quem tem 2FA ativo sempre usa, mesmo que o nível não exija.
Subir o nível derruba as sessões que passariam a precisar de 2FA (a pessoa entra de novo).

Bloqueios: 5 erros de código na mesma etapa derrubam a etapa; 10 falhas em 15 minutos trancam a conta por 15 minutos
(`conta_trancada` na auditoria). O bloqueio por IP do `auth.js` continua valendo. Usuário inexistente gasta o mesmo tempo e conta
como falha igual, então não dá para descobrir quem existe.

A sessão dura `sessao_horas` da matriz (padrão do nível). A meia dura 5 minutos.

## Telas

- `GET /usuarios` (só TI): lista, criar, editar perfil e agentes, desativar e reativar, link de acesso, zerar 2FA, sessões.
- `GET /conta` (todo usuário): trocar a credencial, ativar ou desativar o 2FA (só se a matriz deixar), sessões abertas e "sair de todas".
- `GET /login/2fa`: a segunda etapa do login.

Todas têm o botão Tutorial (o que é, como funciona, por que está aqui) e funcionam no celular. O QR code não é desenhado
(o repositório não tem biblioteca de QR): a tela mostra a chave em grupos de 4 e o link `otpauth://`, que abre direto no aplicativo no celular.

## API

Erros sempre `{ok:false, erro:"motivo em português"}` com o status certo. Nenhuma destas rotas é liberada para a caixa dos agentes.

| Rota | Quem | Faz |
|---|---|---|
| `GET /api/v1/usuarios` | TI | Lista (sem hash nem segredo) e os agentes que dá para liberar. |
| `POST /api/v1/usuarios` | TI | Corpo: `usuario`, `papel`, e opcionais `nome`, `email`, `agentes`. Cria sem credencial e devolve `link` de uso único (24 h). |
| `GET /api/v1/usuarios/<u>` | TI | Um usuário. |
| `PATCH /api/v1/usuarios/<u>` | TI | `nome`, `email`, `papel`, `agentes`, `ativo`. O último TI ativo não é rebaixado nem desativado. |
| `DELETE /api/v1/usuarios/<u>` | TI | Desativa (não apaga) e encerra as sessões. Ninguém desativa a si mesmo. |
| `POST /api/v1/usuarios/<u>/link` | TI | Link novo de acesso (o anterior deixa de valer). |
| `POST /api/v1/usuarios/<u>/zerar-2fa` | TI | Zera o segundo fator e encerra as sessões. |
| `GET`/`DELETE /api/v1/usuarios/<u>/sessoes` | TI | Lista e revoga (`?id=` revoga uma). |
| `GET /api/v1/eu` | todos | Quem sou: papel, agentes, estado do 2FA, `pode_desativar_2fa`. |
| `POST /api/v1/eu/senha` | todos | Troca a credencial: informe a atual, a nova e a confirmação. Encerra as outras sessões. |
| `POST /api/v1/eu/2fa/iniciar` · `/ativar` · `/desativar` | todos | Ativar (segredo e depois código) e desativar (confirmação da credencial e código). |
| `POST /api/v1/eu/reautenticar` | todos | Corpo com `codigo`: renova a prova de 2FA da sessão (para ações perigosas). |
| `GET`/`DELETE /api/v1/eu/sessoes` e `DELETE /api/v1/eu/sessoes/<id>` | todos | Minhas sessões; `?manter_atual=1` poupa a atual. |

Link de acesso: `POST /api/primeiro-acesso` com o token do link (a mesma tela `/primeiro-acesso`). Depois de cadastrar a credencial a
pessoa volta ao `/login` (não entra direto, para não pular o 2FA).

## Para o bloco de aprovações

`require('./lib/ent/usuarios').exigeReautenticacao(sessao, minutos = 15)` devolve `true` quando a pessoa tem 2FA e o último código
dela (login ou `POST /api/v1/eu/reautenticar`) tem mais de `minutos`. Sem 2FA ativo devolve `false`: ter 2FA é exigência da matriz.
A sessão que a função recebe é a de `auth.sessaoDoPedido` (traz `com_2fa` e `fa2_em`).

## Auditoria

`login_ok`, `login_falha` (sem a credencial digitada), `conta_trancada`, `2fa_ativado`, `2fa_desativado`, `2fa_falha`,
`codigo_reserva_usado`, `sessao_revogada`, `logout`, `usuario_criado`, `usuario_alterado`, `usuario_desativado`, `senha_trocada`,
`acesso_negado` e `reautenticado`. `quem` é o usuário; os dados trazem IP e o user-agent cortado em 120 caracteres.

## CLI (o socorro)

```
dgclaw usuario listar
dgclaw usuario criar <usuario> --papel ti|funcionario [--agentes luna,marina] [--nome "..."] [--email ...]
dgclaw usuario desativar <usuario>
dgclaw usuario link <usuario>
dgclaw usuario zerar-2fa <usuario>
```

Mexe no mesmo arquivo, com a mesma trava, e audita. `dgclaw senha` troca só a credencial do `web.env`; com o multiusuário ligado
use `dgclaw usuario link <usuario>` para redefinir a de qualquer pessoa, inclusive a do TI que perdeu a dele.

## O que o funcionário não usa

Quadro de avisos entre agentes (`/avisos`, `/api/v1/avisos`), avisos no aparelho (`/api/v1/push`), criar agente pelo Admin
(`/api/v1/onboarding`) e a tela de proteções recebem `403` para o funcionário: são áreas que misturam os agentes de todo mundo.
Mesa, lembretes e foco ficam abertos, mas filtrados pelos agentes dele.
