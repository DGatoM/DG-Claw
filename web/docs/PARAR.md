# Botão Parar

## O que é

O botão **Parar** aparece na faixa "está trabalhando" da conversa e faz o mesmo que apertar **Esc** no terminal do
agente: o que estava em andamento em primeiro plano é interrompido, a sessão continua aberta e a conversa não se
perde. A próxima mensagem entra normalmente. Não pede confirmação.

O que continua: comandos que o agente mandou para segundo plano seguem rodando. O Parar corta só o que está em
primeiro plano.

O botão só aparece quando o agente está trabalhando. Quando ele espera uma permissão ou a resposta de uma pergunta
de escolha, a conversa já tem os botões próprios desses cartões.

## Rota

`POST /api/v1/agents/<slug>/parar`

- **Corpo:** nenhum. Vazio ou `{}` vale. O corpo não é usado para nada (lido com limite de 1024 bytes só para
  conferir que é um JSON válido): o que chega ao terminal é um único byte Esc, sempre o mesmo.
- **Quem pode:** o dono, em qualquer agente. O colaborador, só no agente dele e só quando o turno em curso foi pedido
  por ele (veja "Colaborador"). A caixa dos agentes não alcança esta rota: um agente não se para sozinho pela API.
- **Proteções:** as mesmas das outras rotas de escrita do Web (login, conferência de origem contra CSRF e escopo do
  colaborador).

### Resposta de sucesso (200)

```json
{
  "ok": true,
  "agente": "ana",
  "enviado_em": "2026-11-18T12:00:00.000Z",
  "trabalhando": true,
  "mensagem": "Pedi para Ana parar (é o mesmo que apertar Esc no terminal). O que estava em andamento foi interrompido; comandos que ele deixou rodando em segundo plano continuam."
}
```

`trabalhando` é `false` quando o agente não estava trabalhando na hora do pedido. Nesse caso o Esc foi enviado, mas
não muda nada, e a `mensagem` diz isso.

### Erros

Todo erro vem como `{"ok": false, "erro": "<motivo em português>", "codigo": "<código curto>"}`.

| Status | Quando | O que fazer |
|---|---|---|
| 401 | Sem login | Entrar de novo |
| 403 | Origem do pedido não é a do painel, ou colaborador tentando parar um trabalho que o dono pediu (`NAO_E_SEU_TURNO`) | Abrir o painel pelo endereço normal; no caso do colaborador, só o dono pode parar |
| 405 | Método diferente de POST | Usar POST |
| 409 `NO_PTY` | O agente não tem sessão aberta agora | Nada a parar. A próxima mensagem abre a sessão |
| 409 `RESPOSTA_EM_ANDAMENTO` | O agente está recebendo a resposta de uma pergunta de escolha | Esperar alguns segundos e tentar de novo |
| 429 `MUITO_RAPIDO` | Passaram menos de 3 s desde o último Esc na mesma sessão. O campo `espere_s` diz quantos segundos faltam | Esperar `espere_s` e apertar de novo |
| 501 `RUNNER_ANTIGO` | O serviço do agente é de uma versão sem esta rota | Atualizar o agente pelo Admin (`dgclaw atualizar`) |
| 502 | O serviço do agente recusou por outro motivo; o `erro` traz o motivo dele | Ler o motivo e olhar o log do agente |
| 503 `RUNNER_FORA` | Não deu para falar com o serviço do agente. O pedido com certeza não foi enviado | Conferir se o agente está rodando e tentar de novo |
| 504 `INCERTO` | A conexão caiu depois do envio: não se sabe se o Esc chegou | Olhar a conversa antes de apertar de novo |

## Trava de 3 segundos

O runner guarda, por sessão, a hora do último Esc e recusa outro antes de 3 s. O motivo: dois Esc em menos de cerca
de 1 s abrem o menu de voltar (rewind) do Claude Code e travam a sessão. A trava vale para qualquer Esc, venha de onde
vier: o Esc que nega uma permissão também conta. A tela reabilita o botão depois de 3 s.

## O que acontece em cada motor

- **Claude Code:** um único Esc no terminal interrompe o turno igual ao Esc do teclado. A ferramenta Bash em primeiro
  plano é morta, a sessão mostra "Interrupted · What should Claude do instead?" e a próxima mensagem entra normal.
  Comando mandado para segundo plano continua.
- **Codex:** testado na versão 0.169.0. Com o agente trabalhando a tela mostrava "Working (11s • esc to interrupt)".
  Depois de um Esc apareceu "■ Conversation interrupted - use /feedback if something went wrong", o comando que
  ele tinha mandado rodar ficou como "1 background terminal running" (continua em segundo plano), e a mensagem
  seguinte entrou normalmente e foi respondida.

Quando a sessão mostra a interrupção, o agente não retoma sozinho o que foi cortado: espera a próxima mensagem.

## Colaborador

O colaborador só pode parar um trabalho que ele mesmo pediu: o turno em curso precisa ter sido iniciado por ele, sem
mensagem de outra pessoa misturada. Se o trabalho foi pedido pelo dono, a resposta é 403 com "Esse trabalho foi pedido
pelo dono do DG Claw; só ele pode parar." e o serviço do agente nem é chamado.

## Registro

Cada Parar entra no log do Web com o agente, quem apertou (`dono` ou `colaborador:<id> (<usuário>)`) e o horário do
envio. Falhas entram como aviso ou erro, com o motivo.

## Rota interna do runner

O Web repassa o pedido para `POST /api/agents/<id>/interromper` do serviço do agente (corpo ignorado, token do
runner). Sucesso: `{"success": true, "data": {"enviado": true, "enviadoEm": "<ISO>", "statusAntes": "<estado>", "provedor": "claude|codex"}}`.
Falha: `{"success": false, "error", "howToFix", "code", "espereS"?}`, com `NO_PTY` (409), `RESPOSTA_EM_ANDAMENTO` (409)
ou `MUITO_RAPIDO` (429). Uma sessão paralela dormindo não é acordada: sem terminal vivo, a resposta é `NO_PTY`.
