# Conectar o Claude ou o Codex pela conversa

Quando o agente não tem uma conta conectada, ele não responde. A conversa mostra, no fim das
mensagens, o cartão "Conectar o seu Claude" (ou "Codex"), com o passo a passo e sem terminal.
A pessoa também pode digitar `/login` no campo de mensagem e enviar: nada vai ao agente, o cartão
abre (mesmo com a conta já conectada, para entrar de novo).

O cartão aparece sozinho quando a atividade do agente traz `alerta: "sem_login"`: o runner informa
`status "errored"` com `statusReason "runner:sem-login"`. Quando a conta é conectada, o runner sobe
a sessão sozinho e o agente volta a `idle`.

## Login que expirou

É outro caso: a conta ESTAVA conectada e a credencial morreu (token vencido e a renovação falhou). O arquivo
`.credentials.json` continua no disco, então nem o runner nem o `claude auth status --json` (que segue dizendo
`loggedIn: true`) percebem sozinhos, e o agente simplesmente para de responder.

- **O sinal.** O Claude Code dispara o hook `StopFailure` (com `error: "authentication_failed"`) no fim do turno
  que falhou; o hook `Stop` não dispara. O transcript ganha uma linha sintética (`model "<synthetic>"`,
  `isApiErrorMessage`, texto "Login expired · Please run /login"), que o runner também lê como rede de
  segurança. Então o runner informa `status "errored"`, `statusReason "runner:login-expirado"` e `loginExpiradoEm`
  (ISO). Outros erros de `StopFailure` (limite, sobrecarga) só voltam o agente a `idle`, com o motivo no log.
- **O alerta.** A atividade do agente traz `alerta: "login_expirado"` (diferente de `sem_login`), com `expirou_em`,
  `provedor` e `desde`. A conversa abre na frente o pop-up "Seu login do Claude expirou": Reconectar conta (abre o
  cartão de login dentro do pop-up), Reiniciar a sessão (o mesmo reinício do menu, com a faixa de acompanhamento) e
  Agora não (dispensa só aquele incidente neste navegador; o cartão no fim da conversa continua).
- **Envio.** Com o login expirado, `POST .../send` responde 409 com `codigo: "LOGIN_EXPIRADO"` e a causa em `erro`.
  A tela mantém o texto no campo e abre o pop-up. No runner, o mesmo 409 vem com `code: "LOGIN_EXPIRADO"` em
  `POST /api/agents/<id>/input` (tecla crua, `submit: false`, continua passando, para o terminal do cartão).
- **A volta.** Diferente do "sem login" de primeira vez, a sessão tem conversa e NÃO é trocada por uma nova. O
  runner reinicia retomando a mesma sessão (`--resume`, o mesmo caminho do `POST .../reiniciar`) quando o login
  assistido termina ou quando o `.credentials.json` fica mais novo que `loginExpiradoEm` (conferido a cada 30 s;
  cobre o login feito pelo terminal e várias agentes na mesma conta). Se a retomada falhar, vale o comportamento
  de sempre para retomada que não abre, e o log diz por quê.
- **O recado.** Quando a sessão volta a `idle` depois de um incidente, o runner entrega ao agente UM recado
  `<plataforma recado="login-reconectado">` dizendo a hora em que o login expirou e a hora em que voltou, para ele
  conferir as últimas mensagens do dono e responder o que ficou pendente. Esse caminho não usa o "primeiro oi"
  (`/login/oi`), que a tela não pede quando o incidente é de login expirado.

## Rotas

Todas exigem a sessão do login e, nas escritas, `Origin` igual ao do Web, como as outras rotas.
Valem para qualquer agente do registro, o Admin incluso. O Web fala direto com o runner (o Admin
não tem painel). Erros vêm como `{ok:false, erro:"o que falhou e o que fazer"}` com o status certo
(runner fora do ar: 503; recusa do runner: o mesmo status, com `error` e `howToFix` juntos).

- `GET /api/v1/agents/<id>/login`: estado do login e do provedor.
  `{ok, estado, link?, codigoDispositivo?, mensagem?, provedor:"claude"|"codex", auth, conferido, precisa_login}`.
  `auth` e `conferido` vêm do runner (`auth` é `null` se ele não respondeu). `precisa_login` é
  verdadeiro quando o agente está sem login ou o runner não confirma a conta.
- `POST /api/v1/agents/<id>/login`: começa o login (202). O runner recusa (409) se o agente usa
  chave de API em vez de assinatura, ou se já há um login em andamento.
- `POST /api/v1/agents/<id>/login/codigo` com `{"codigo":"..."}`: entrega o código que a página
  mostrou no fim (só no Claude). Texto sem espaço nem quebra de linha, até 512 caracteres.
- `DELETE /api/v1/agents/<id>/login`: cancela.
- `POST /api/v1/agents/<id>/login/oi`: o "primeiro oi". Espera até 60 s o agente ficar pronto e
  entrega a ele um recado `<plataforma recado="login-concluido">` pedindo um oi curto pelo dgchat.
  O recado não aparece na conversa: só a resposta do agente. No máximo uma entrega por agente a cada
  10 minutos; a segunda chamada responde `{ok:true, ja_enviado:true}`. Se o agente não ficar
  pronto no prazo: 504.

## Estados (`estado`)

| Estado | O que a pessoa faz |
| --- | --- |
| `nenhum` | Nada em andamento. |
| `aguardando_link` | O runner prepara o link (alguns segundos). |
| `aguardando_codigo` | Claude: abrir `link`, entrar, copiar o código do fim da página e enviar em `/login/codigo`. |
| `aguardando_navegador` | Codex: abrir `link` e digitar `codigoDispositivo`; o runner percebe sozinho. |
| `concluido` | Conta conectada. |
| `falhou` | Veja `mensagem`; começar de novo. |

## Exemplos

```bash
# com o cookie da sessão em $JAR e o Origin do próprio Web
curl -s -b $JAR http://127.0.0.1:3000/api/v1/agents/admin/login
curl -s -b $JAR -H 'Origin: http://127.0.0.1:3000' -X POST http://127.0.0.1:3000/api/v1/agents/admin/login
curl -s -b $JAR -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  -d '{"codigo":"<código da página>"}' http://127.0.0.1:3000/api/v1/agents/admin/login/codigo
curl -s -b $JAR -H 'Origin: http://127.0.0.1:3000' -X DELETE http://127.0.0.1:3000/api/v1/agents/admin/login
curl -s -b $JAR -H 'Origin: http://127.0.0.1:3000' -X POST http://127.0.0.1:3000/api/v1/agents/admin/login/oi
```

O código colado e o link de login (que carrega o estado do OAuth) nunca vão para o log do Web.
