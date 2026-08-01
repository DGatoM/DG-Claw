---
name: connect
description: Conecta o agente pessoal do DG Claw Lite ao Google (Drive, Gmail e Calendar) usando os connectors nativos do Claude Code, sem Google Cloud e sem OAuth na mao. Use quando a pessoa rodar /dgclaw-lite:connect, disser "conectar o Google", "conecta meu Gmail", "quero que ele veja meu Drive", "da acesso a minha agenda", "liga o Google Calendar nele", ou perguntar "ele consegue ver meus e-mails?", "ele consegue marcar coisa na minha agenda?". Vale tambem quando o pedido chega pelo Telegram, na conversa do proprio agente.
user-invocable: true
---

# /dgclaw-lite:connect — dar ao agente acesso ao Google

Liga **Google Drive**, **Gmail** e **Google Calendar** no agente usando os
**connectors nativos do Claude Code**. Não precisa criar projeto no Google
Cloud, não precisa mexer em OAuth: a pessoa autoriza a própria conta Google no
navegador, e pronto.

Fale em português do Brasil, tom acolhedor, um passo por mensagem.

## Explique antes (2 frases, sem jargão)

> "O Claude Code já vem com conexões oficiais pro Google. Você autoriza uma vez,
> com a sua conta, e o seu agente ganha ferramentas de verdade: ler e criar
> arquivos no Drive, ler e escrever e-mail no Gmail, ver e marcar compromisso na
> Agenda. Nada de programar nada — é só aprovar numa tela do Google."

## Passos

1. **Liste as conexões** disponíveis nesta janela:

   ```
   /mcp
   ```

2. **Autorize um de cada vez**: procure **Google Drive**, **Gmail** e **Google
   Calendar** e siga o fluxo de autorizar/login de cada um. Abre uma página do
   Google pra aprovar — use a conta que o agente deve enxergar. Conecte **só o
   que fizer sentido**: dá pra ligar só a Agenda, por exemplo.

3. **Confirme**: rode `/mcp` de novo e veja se aparecem como conectados.

4. **Feche a janela do agente e religue com o comando de sempre** — este passo
   não é opcional:

   ```
   cd /d "<a pasta do agente>" && claude --continue --channels plugin:telegram@claude-plugins-official
   ```

   (no Mac/Linux, a mesma linha sem o `/d`; quem usa só o terminal roda a mesma
   linha sem o `--channels ...`). As conexões valem **por sessão**:
   a janela que já estava aberta continua sem enxergar as ferramentas novas. É
   só religar que ele passa a usar — a conversa não se perde.

## Teste

Peça pra pessoa mandar pelo Telegram algo como:

> "vê meus próximos eventos da agenda"
>
> "resume meus últimos e-mails"

Se ele responder com dados reais, está conectado. Se ele disser que não tem
essas ferramentas, quase sempre é o passo 4: a janela não foi religada.

## Se não aparecer nenhum connector do Google no `/mcp`

Diga a verdade, sem enrolar: a conta ou o plano do Claude dessa pessoa pode não
ter os connectors habilitados. **Não é defeito do plugin** e não tem nada pra
consertar na pasta do agente — é uma questão da conta dela.

## Privacidade (deixe claro, não deixe implícito)

Conectar dá ao agente **acesso real** de leitura (e escrita) nos serviços
escolhidos: ele vai poder abrir seus e-mails e seus arquivos quando você pedir.
Conecte só o que fizer sentido pra você. O outro lado da moeda tranquiliza:
**só o dono fala com esse bot** — o Telegram está trancado na allowlist desde o
setup, então ninguém mais consegue pedir nada a ele.

Pra desligar depois, é só remover a autorização do connector pelo `/mcp` (ou
revogar o acesso na sua Conta Google) e religar a janela.
