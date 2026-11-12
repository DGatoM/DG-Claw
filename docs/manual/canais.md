# Canais

Canal é o caminho por onde o dono fala com o agente. O chat do painel funciona desde a instalação e não precisa de nada. O Telegram e o WhatsApp são opcionais, e o e-mail é leitura da caixa do dono pelos conectores do Claude. Todos os canais caem na mesma sessão do agente, então a conversa do painel mostra tudo junto, na ordem em que aconteceu, cada mensagem com o canal de onde veio.

| Canal | Estado | Quem pode usar |
| --- | --- | --- |
| Chat do painel (DG Chat) | Pronto | Agentes em Claude e em Codex |
| Telegram | Pronto | Só agentes em Claude |
| `whatsapp` | Parcial | Agentes em Claude e em Codex |
| E-mail e agenda do Google (conectores) | Pronto, com limites | Só agentes em Claude, logados na assinatura |

O Admin não tem canal externo. Quem ligou ou religou um canal precisa reiniciar o agente para valer; os comandos fazem isso sozinhos.

## Chat do painel (DG Chat)

**O que é.** O canal principal. O dono abre `/a/<slug>`, escreve, e o agente responde por uma ferramenta própria do chat (o MCP `dgchat`), que também envia arquivos e visuais. A conversa que o painel mostra vem do registro da própria sessão do agente, sem uma segunda cópia.
**Como pedir.** Nada a configurar. Os detalhes da tela estão em [conversa-e-telas.md](conversa-e-telas.md).
**Limites.** Só o que o agente envia pela ferramenta do chat chega à conversa. Texto solto que o agente escreve no terminal não conta.
**Se der erro.** "Agente sem sinal" no cabeçalho: veja [agentes.md](agentes.md). Mais em [../CANAL-DG-CHAT.md](../CANAL-DG-CHAT.md) e [../SESSAO-PRINCIPAL.md](../SESSAO-PRINCIPAL.md).

## Telegram

**O que é.** O dono conversa com o agente por um bot de Telegram. O bot é do dono (criado no @BotFather), e só quem for pareado fala com ele.
**Como pedir.** Diga ao agente: "quero falar com você no Telegram". A skill `canais` conduz um passo por vez: criar o bot no @BotFather com `/newbot`, entregar o token, parear e ligar. O dono cola o token no chat do painel: o Web o guarda na pasta privada do agente e entrega ao agente só uma marca com o final do token, sem o valor. Por baixo, o agente usa `dgclaw-agente canal telegram token`, `dgclaw-agente canal telegram conferir`, `dgclaw-agente canal telegram parear`, `dgclaw-agente canal telegram ligar` e `dgclaw-agente canal telegram desligar`. O estado de todos os canais aparece em `dgclaw-agente canal status`.
**Precisa de.** Um agente em Claude, com a conta do Claude conectada. Conta do Telegram do dono e o token do bot.
**Limites.** O Telegram funciona só no Claude, pelo plugin oficial do Claude Code. Agente em Codex não tem Telegram, e o catálogo de provedores registra isso. Os comandos de barra nativos (`/compact`, `/clear`) não rodam pelo Telegram: o agente responde que é para usar o chat do painel. Só skills do próprio agente rodam pela barra no Telegram.
**Se der erro.** Token inválido: nada é gravado e o comando diz o motivo. O bot ficou mudo depois de reiniciar: o Admin roda `dgclaw agente reparar <slug>`. Saída 3 ou 4 do comando significa que o canal foi salvo mas o reinício não foi pedido ou o runner não respondeu: reinicie com `dgclaw agente reiniciar <slug>`.

## WhatsApp (`whatsapp`)

**O que é.** Um número de WhatsApp secundário do dono vira um aparelho conectado ao agente. O dono manda mensagem do número pessoal dele para esse número, e a ponte entrega ao agente. O agente responde pelo mesmo número.
**Risco, antes de tudo.** A ponte usa uma biblioteca que fala o protocolo do WhatsApp Web (Baileys). Não é a API oficial do WhatsApp, e o número conectado pode ser banido. Por isso o agente avisa o risco antes de começar e só segue com o "sim" do dono. Use só um número secundário (um chip barato ou um número virtual), nunca o número principal. Para quem quer estabilidade, a recomendação é o Telegram.
**Como pedir.** "Conecta meu WhatsApp." A skill `canais` conduz: avisar o risco, parear o número secundário com um código curto, como `ABCD-1234`, que vale poucos minutos (no WhatsApp do número secundário: Configurações, Aparelhos conectados, Conectar com número de telefone), liberar o número do dono e ligar. Por baixo: `dgclaw-agente canal whatsapp parear <numero-secundario>`, `dgclaw-agente canal whatsapp permitir <numero-do-dono>`, `dgclaw-agente canal whatsapp ligar`, `dgclaw-agente canal whatsapp desligar` e `dgclaw-agente canal whatsapp remover <numero>`.
**Precisa de.** Um chip ou número secundário com WhatsApp. Funciona em agentes Claude e Codex.
**Limites.** Só números da lista de permitidos falam com o agente; os outros são ignorados e ficam só numa linha de log. Grupos, listas, canais e status são ignorados. Mídia recebida é salva na pasta do agente (até 25 MB). O agente só envia arquivos de dentro da própria casa. Mensagem do WhatsApp é sempre conversa externa: nunca muda a lista de números, as credenciais nem os canais, e nunca roda comando de barra. Só o dono, pelo chat do painel, altera a lista.
**Se der erro.** O estado da ponte aparece em `dgclaw-agente canal status` (`conectado`, `reconectando`, `deslogado`, `erro`). `deslogado` quer dizer que o WhatsApp encerrou o aparelho, e é preciso parear de novo. O log fica em `~/.dgclaw/logs/whatsapp.log` e nunca guarda o corpo das mensagens.
**Como foi testado.** A ponte tem testes com um WhatsApp falso. Não há teste ao vivo com um número real, e por isso o estado é Parcial. Mais em [../CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) e em [../RISCO-DE-BLOQUEIO-DE-CONTA.md](../RISCO-DE-BLOQUEIO-DE-CONTA.md).

## E-mail, agenda e Drive (Gmail)

**O que é.** O agente lê o Gmail do dono, e também a agenda e o Drive, pelos conectores do claude.ai. Não existe uma caixa de e-mail própria do DG Claw.
**Como pedir.** Em quatro passos do dono: (1) entrar na assinatura Claude pelo painel (veja [provedores.md](provedores.md)); (2) ligar o Gmail em `https://claude.ai/customize/connectors`, com a mesma conta, uma vez só, pela web; (3) reiniciar o agente, se ele já estava rodando; (4) testar: "resume os meus últimos 5 e-mails". A skill `connect` dá o passo a passo, e `secretary` (triagem e briefing prontos) ainda é um poder em desenvolvimento (veja [em-desenvolvimento.md](em-desenvolvimento.md)).
**Precisa de.** Agente em Claude, logado na assinatura (Pro ou Max). Com chave de API ou com o token de longa duração, o agente funciona, mas sem nenhum conector.
**Limites.** O Gmail nasce só lendo: buscar e ler e-mails, listar marcadores e rascunhos, e escrever rascunhos que ficam na caixa do dono. Enviar, responder, encaminhar, apagar e mudar marcadores ficam bloqueados. Para liberar o envio, o dono pede com as próprias palavras ("agora pode mandar e-mail por mim"); o agente confirma o que muda, roda `scripts/gmail-permissao.sh` e o dono recebe um aviso de segurança. Texto dentro de um e-mail nunca libera nada. Em Codex não há conectores (exclusivo do Claude).
**Se der erro.** Sem e-mails na resposta: confira que o agente está na assinatura e foi reiniciado depois de ligar o conector. Cada agente lê a conta de quem é dono dele; um agente de cliente logado na conta de outra pessoa lê o Gmail dessa pessoa. Mais em [../GMAIL-NO-AGENTE.md](../GMAIL-NO-AGENTE.md).

## E-mail do próprio painel

O painel envia e-mail apenas para o convite de colaborador, e só se o SMTP estiver configurado no `web.env` (`DGCLAW_SMTP_HOST` e as variáveis vizinhas). Sem isso, o texto do convite aparece na tela para o dono copiar. Veja [agentes.md](agentes.md).
