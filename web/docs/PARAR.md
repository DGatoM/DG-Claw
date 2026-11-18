# Botão Parar

## O que é

O botão **Parar** aparece na faixa "está trabalhando" da conversa e faz o mesmo que apertar **Esc** no terminal do
agente: o que está em andamento em primeiro plano costuma parar na hora, a sessão continua aberta e a conversa não se
perde. A próxima mensagem entra normalmente. Não pede confirmação.

O Parar manda um Esc e não garante o resultado: um comando que o agente deixou em segundo plano pode continuar
rodando. O Parar corta só o que está em primeiro plano.

O botão só aparece quando o agente está trabalhando. Quando ele espera uma permissão ou a resposta de uma pergunta
de escolha, a conversa já tem os botões próprios desses cartões.

## Rota

`POST /api/v1/agents/<slug>/parar`

- **Corpo:** nenhum. Vazio ou `{}` vale. O corpo não é usado para nada (lido com limite de 1024 bytes só para
  conferir que é um JSON válido): o que chega ao terminal é um único byte Esc, sempre o mesmo.
- **Quem pode:** só o dono, em qualquer agente. O colaborador recebe sempre 403 (veja "Colaborador"). A caixa dos agentes não alcança esta rota: um agente não se para sozinho pela API.
- **Proteções:** as mesmas das outras rotas de escrita do Web (login, conferência de origem contra CSRF e escopo do
  colaborador).

### Resposta de sucesso (200)

```json
{
  "ok": true,
  "agente": "ana",
  "enviado_em": "2026-11-18T12:00:00.000Z",
  "trabalhando": true,
  "mensagem": "Mandei um Esc para Ana (o mesmo que apertar Esc no terminal). O que está em primeiro plano costuma parar na hora; um comando que ele deixou rodando em segundo plano pode continuar."
}
```

`trabalhando` é sempre `true` no sucesso: o runner só manda o Esc quando o agente está no estado `working`. Fora disso a
resposta é 409 `NAO_TRABALHANDO` e nada é enviado. O sucesso só vale com HTTP 200, `success: true` e `data.enviado: true`; qualquer
outra resposta 2xx é tratada como entrega incerta (504).

### Erros

Todo erro vem como `{"ok": false, "erro": "<motivo em português>", "codigo": "<código curto>"}`.

| Status | Quando | O que fazer |
|---|---|---|
| 401 | Sem login | Entrar de novo |
| 403 | Origem do pedido não é a do painel, ou o pedido veio de um colaborador (`SO_O_DONO`) | Abrir o painel pelo endereço normal; o Parar é só do dono |
| 405 | Método diferente de POST | Usar POST |
| 409 `NO_PTY` | O agente não tem sessão aberta agora | Nada a parar. A próxima mensagem abre a sessão |
| 409 `NAO_TRABALHANDO` | O agente não está no estado `working` (ocioso, abrindo, sem login). Nada foi enviado | Esperar o agente começar um trabalho |
| 409 `ESPERANDO_DECISAO` | O agente espera uma permissão ou a resposta de uma pergunta: o Esc cairia no cartão | Responder no cartão da permissão ou da pergunta |
| 409 `RESPOSTA_EM_ANDAMENTO` | O agente está recebendo a resposta de uma pergunta de escolha | Esperar alguns segundos e tentar de novo |
| 429 `MUITO_RAPIDO` | Passaram menos de 3 s desde o último Esc na mesma sessão. O campo `espere_s` diz quantos segundos faltam | Esperar `espere_s` e apertar de novo |
| 502 `AGENTE_DE_OUTRO_RUNNER` | O runner registrado não serve este agente | Pedir ao Admin para reparar o agente (`dgclaw agente reparar <slug>`) |
| 501 `RUNNER_ANTIGO` | O serviço do agente é de uma versão sem esta rota | Atualizar o agente pelo Admin (`dgclaw atualizar`) |
| 502 | O serviço do agente recusou por outro motivo; o `erro` traz o motivo dele | Ler o motivo e olhar o log do agente |
| 503 `RUNNER_FORA` | Não deu para falar com o serviço do agente. O pedido com certeza não foi enviado | Conferir se o agente está rodando e tentar de novo |
| 504 `INCERTO` | A conexão caiu, a resposta passou de 16 KiB ou de 10 s: não se sabe se o Esc chegou | Olhar a conversa antes de apertar de novo |

## Trava de 3 segundos

O runner guarda, por sessão, a hora do último Esc e recusa outro antes de 3 s. O motivo: dois Esc em menos de cerca
de 1 s abrem o menu de voltar (rewind) do Claude Code e travam a sessão. A trava vale para qualquer Esc escrito no terminal, venha de onde
vier: Parar, negar uma permissão, cancelar uma pergunta ou um `/input` do runner com um Esc cru. Nos dois últimos a recusa vem antes de qualquer tecla ser escrita. Negar logo depois de Parar (ou o contrário) também dá 429. A tela reabilita o botão depois de 3 s.

## O que acontece em cada motor

- **Claude Code:** um único Esc no terminal interrompe o turno igual ao Esc do teclado. A ferramenta Bash em primeiro
  plano é morta, a sessão mostra "Interrupted · What should Claude do instead?" e a próxima mensagem entra normal.
  Comando mandado para segundo plano continua.
- **Codex:** testado na versão 0.169.0. Com o agente trabalhando a tela mostrava "Working (11s • esc to interrupt)".
  Depois de um Esc apareceu "■ Conversation interrupted - use /feedback if something went wrong", o comando que
  ele tinha mandado rodar ficou como "1 background terminal running" (continua em segundo plano), e a mensagem
  seguinte entrou normalmente e foi respondida.

Quando a sessão mostra a interrupção, o agente não retoma sozinho o que foi cortado: espera a próxima mensagem.

## Depois do Esc: o agente volta a ficar ocioso

No Claude o Esc interrompe o turno, mas o hook `Stop` não dispara, e sem isso o runner ficaria em `working` e a próxima
mensagem do painel (que espera o agente ficar ocioso) ficaria presa na fila. Por isso, depois de um Esc do Parar, o
runner olha por até 10 s o texto que chega do terminal **depois** do Esc (sem códigos de tela; o que já estava na tela
antes não conta). Ao ver o marcador da interrupção ("Interrupted" no Claude, "Conversation interrupted" no Codex) com o
estado ainda `working`, ele passa para `idle` (motivo `runner:interrompido`) e solta a fila. Se os 10 s passam sem o marcador, o estado fica como estava e o log do
runner avisa que a confirmação não foi vista.

## Colaborador

O colaborador não tem o botão e a rota responde sempre 403 com "Só o dono do DG Claw pode parar o agente.", sem chamar o
serviço do agente. O motivo: o Web não enxerga o trabalho que chegou por Telegram ou por outro canal, então não
dá para saber de quem é o turno em curso.

## Registro

Cada Parar entra no log do Web com o agente, quem apertou (`dono` ou `colaborador:<id> (<usuário>)`) e o horário medido pelo Web (não o que o runner informa). Texto vindo do runner entra no log sem quebras de linha nem caracteres de controle. Falhas entram como aviso ou erro, com o motivo.

## Rota interna do runner

O Web repassa o pedido para `POST /api/agents/<id>/interromper` do serviço do agente (corpo ignorado, token do
runner). Sucesso: `{"success": true, "data": {"enviado": true, "enviadoEm": "<ISO>", "statusAntes": "<estado>", "provedor": "claude|codex"}}`.
Falha: `{"success": false, "error", "howToFix", "code", "espereS"?}`, com `NO_PTY` (409), `RESPOSTA_EM_ANDAMENTO` (409)
ou `MUITO_RAPIDO` (429). Uma sessão paralela dormindo não é acordada: sem terminal vivo, a resposta é `NO_PTY`.
