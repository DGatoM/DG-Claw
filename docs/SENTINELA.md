# Sentinela do servidor

A sentinela é a vigia do seu servidor. A cada minuto ela confere se o disco está enchendo, se a memória está no limite,
se os seus agentes estão respondendo e se o painel e o Caddy estão de pé. Quando algo sai do normal, ela avisa você
**antes** de o servidor parar, no Telegram, no e-mail e no próprio painel.

Ela existe por um motivo simples: disco cheio derruba tudo, os agentes param de responder e, no pior caso, você fica
sem conseguir entrar no servidor. Com a sentinela, você recebe um aviso quando o disco chega a 75% e tem dias para
resolver, não minutos.

## O que ela vigia

| O quê | Como ela olha |
| --- | --- |
| Disco | Quanto está usado e quantos arquivos existem, em cada disco do servidor |
| Memória | Quanto da memória está em uso (um pico de um minuto não conta, só dois seguidos) |
| Agentes | Se o programa de cada agente responde. Se não responde duas vezes seguidas, ela diz o motivo (container parado, container que não existe, programa que não responde) |
| WhatsApp dos agentes | Se o canal do WhatsApp de cada agente está de pé. Se parou, os clientes ficam sem resposta |
| Serviços | O painel (`dgclaw-web`), o Admin (`dgclaw-admin`) e o Caddy |

## Os níveis

| Nível | Disco | Memória | O que significa |
| --- | --- | --- | --- |
| 🟡 Aviso | a partir de 75% | a partir de 85% | Ainda dá tempo. Vale liberar espaço nos próximos dias |
| 🟠 Sério | a partir de 85% | a partir de 92% | Se continuar subindo, os agentes vão parar. A faxina automática roda |
| 🔴 Crítico | a partir de 92% | a partir de 96% | Risco real de parar. Também é crítico qualquer agente ou serviço fora do ar |
| ✅ Resolvido | | | Tudo voltou ao normal. Você recebe esta mensagem dizendo quanto tempo durou |

Para não ficar alternando entre dois níveis, o nível só desce quando o número fica 3 pontos percentuais abaixo do limite.
Os limites são ajustáveis (veja "Ajustes" no fim).

Enquanto o problema continua, ela repete o aviso: a cada 6 horas no aviso, a cada 1 hora no sério e a cada 10 minutos no
crítico. A mensagem de repetição diz "Continua há 40 min". Ela manda no máximo uma mensagem por minuto, juntando tudo o
que mudou.

## O que ela faz sozinha

A sentinela só mexe no que está num catálogo fechado, escrito pela equipe do DG Claw. Nada vem de texto de fora, e nenhum
item aceita comando livre.

- **Faxina do disco** (quando o disco chega ao nível sério, e de novo a cada 6 horas enquanto continuar): limpa registros
  antigos do sistema, pacotes baixados pelo apt, imagens de container sem nome, arquivos temporários com mais de 3 dias,
  logs antigos já compactados e os caches de pip, npm e navegador dentro das casas dos agentes. Ela nunca apaga código,
  banco de dados, conversas, memória, chaves nem o `.env` de ninguém.
- **Reserva de disco** (o "balão de ar"): ela guarda um arquivo de 2 GB (no máximo 5% do disco) que não tem nada dentro.
  Se o disco passar de 97%, ela apaga esse arquivo sozinha. Isso devolve fôlego para o servidor seguir funcionando
  enquanto você resolve. **Compra tempo, não resolve.** Quando o disco volta a menos de 70% por meia hora, ela recria a
  reserva e avisa.
- **Alívio de memória** (quando a memória fica crítica por 3 minutos seguidos): primeiro para a ronda de segurança, que
  roda de novo depois no modo econômico. Se continuar crítico, fecha **só o navegador** do agente que mais gasta
  memória. A conversa dele continua de pé e o navegador volta quando ele precisar. Ela nunca para o programa do agente,
  o WhatsApp, o painel, o Admin nem o Caddy.

Ela **nunca reinicia** um agente ou um serviço sozinha, porque reiniciar no meio da conversa de um cliente é uma decisão
sua. Ela avisa e escreve o comando exato (por exemplo `sudo dgclaw agente reiniciar luna`).

O servidor também ganha duas proteções: o painel, o ssh e o Caddy ficam por último na fila de quem o sistema fecha
quando falta memória (para você nunca ficar trancado fora), e o diário do sistema (journal) passa a ter um teto de 1 GB,
a menos que você já tenha definido o seu.

## Como você recebe os avisos

| Canal | Precisa configurar? |
| --- | --- |
| Painel (faixa no alto das telas, cartão **Saúde do servidor** na tela Segurança e notificação no celular) | Não. Funciona sozinho |
| Telegram | Sim |
| E-mail | Sim (opcional) |
| Admin (recebe um recado e conversa com você) | Não. Funciona sozinho |
| Pulso externo (avisa se o servidor inteiro cair) | Sim, e é o mais importante: veja abaixo |

**Sem Telegram nem e-mail configurados, os alarmes só aparecem no painel.** Se o servidor travar ou você não estiver
com o painel aberto, ninguém avisa. Configure pelo menos o Telegram e o pulso externo.

### Ligar os avisos no Telegram

O jeito mais fácil: peça ao Admin, no chat, "configura os avisos da sentinela no Telegram". Ele guia você. Em resumo:

1. No Telegram, abra uma conversa com o **@BotFather**, mande `/newbot` e siga as perguntas. No fim ele entrega um
   **token** (números, dois-pontos e letras). Guarde, é a chave do seu bot.
2. Abra uma conversa com o bot novo e mande qualquer mensagem (um "oi"). Sem isso o bot não pode escrever para você.
3. Descubra o seu **id de chat**: mande uma mensagem para o **@userinfobot** e ele responde com o seu id (um número).
   Para avisar também outras pessoas de confiança, junte os ids delas separados por vírgula.
4. Entregue as duas coisas ao Admin. Ele grava com um comando que não deixa o token aparecer na conversa nem no
   histórico do servidor:

   ```
   printf 'TELEGRAM_TOKEN=<o token>\nTELEGRAM_CHATS=<o id>\n' | sudo dgclaw sentinela configurar
   ```

5. Teste: `sudo dgclaw sentinela testar-avisos`, ou o botão **Testar avisos** do cartão Saúde do servidor. Deve chegar
   uma mensagem de teste no seu Telegram.

### Ligar os avisos por e-mail (opcional)

Peça ao Admin os dados do seu servidor de e-mail (endereço do servidor SMTP, porta, usuário e senha; no Gmail, uma "senha
de app") e as chaves `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORTA`, `EMAIL_USUARIO`, `EMAIL_SENHA`, `EMAIL_DE` e `EMAIL_PARA` são
gravadas do mesmo jeito, pelo `sudo dgclaw sentinela configurar`.

## O pulso externo: quem avisa quando o servidor inteiro cai

Se o servidor desligar, perder a internet ou travar de vez, ele não consegue avisar ninguém, nem a sentinela. Por isso a
sentinela "dá um pulso" a cada minuto num serviço de fora. Se o pulso parar de chegar, o serviço de fora avisa você. Em
cerca de 5 minutos você sabe. Isso não depende de nada do seu servidor funcionar.

O serviço gratuito mais simples é o **healthchecks.io**:

1. Entre em **healthchecks.io** e crie uma conta grátis.
2. Clique em **Add Check**. Dê um nome (por exemplo "Meu servidor DG Claw").
3. Em **Period** coloque **2 minutes** e em **Grace Time** coloque **3 minutes**.
4. Na aba **Integrations**, ligue o Telegram (ou o e-mail) para receber o alerta quando o pulso falhar. O próprio site
   explica a conexão, é só seguir os botões.
5. Na página do check aparece uma **URL de ping**, parecida com `https://hc-ping.com/xxxxxxxx-xxxx-...`. Copie.
6. Entregue a URL ao Admin ou rode você mesmo:

   ```
   printf 'PULSO_URL=https://hc-ping.com/<a sua url>\n' | sudo dgclaw sentinela configurar
   ```

7. Em um ou dois minutos o check fica verde no healthchecks.io. Daí em diante, se o pulso sumir por mais de uns 5
   minutos, você recebe o alerta. Quando o servidor tem um problema grave mas continua ligado, a sentinela avisa o
   healthchecks na hora (o check fica vermelho), sem esperar o tempo acabar.

**Alternativa:** o **Uptime Kuma**, que você instala em **outra** máquina (nunca no mesmo servidor, senão cai junto). Crie
um monitor do tipo **Push** e use a URL dele como `PULSO_URL`.

### Um segundo monitor de fora, para o site

Além do pulso, crie um monitor de HTTP (no **UptimeRobot** ou no próprio healthchecks) apontando para
`https://<o seu domínio>/api/saude`. Esse endereço é público, não pede login, e responde `ok` quando o painel está de pé.
Ele avisa se o painel ou o Caddy cair, mesmo que o servidor continue ligado.

## Comandos (o Admin usa, e você também pode)

| Comando | O que faz |
| --- | --- |
| `sudo dgclaw sentinela estado` | Mostra o que a sentinela vê agora |
| `sudo dgclaw sentinela levantar` | Lista as 20 maiores pastas e diz quais a faxina cobre. Não apaga nada |
| `sudo dgclaw sentinela faxinar` | Simula a faxina e mostra quanto cada item liberaria |
| `sudo dgclaw sentinela faxinar --executar` | Roda a faxina de verdade |
| `sudo dgclaw sentinela reserva estado` | Mostra a reserva de disco (também há `liberar` e `recriar`) |
| `sudo dgclaw sentinela testar-avisos` | Manda um aviso de teste em cada canal configurado |
| `sudo dgclaw sentinela rodar` | Faz uma rodada agora |
| `sudo dgclaw sentinela configurar` | Grava ajustes, lidos da entrada padrão |

## Quando o disco enche de coisa que a faxina não cobre

Se o disco continua cheio depois da faxina, a sentinela diz quais são as maiores pastas. A **faxina guiada** é uma
conversa com o Admin: ele roda `sudo dgclaw sentinela levantar`, mostra a lista para você e explica o que cada pasta é.
**Só apaga com o seu ok, pasta por pasta.** Código, bancos de dados, conversas, memória e o `.env` ficam sempre de fora.
Se a solução for mais espaço, o caminho é aumentar o disco no provedor da VPS.

## Ajustes

Os padrões servem para a maioria. O arquivo é `/etc/dgclaw/sentinela.conf` (formato `CHAVE=valor`) e a atualização do DG
Claw nunca o reescreve. Para mudar, use `sudo dgclaw sentinela configurar`, que troca só as linhas que você mandou e mantém
as outras.

| Chave | Padrão | O que é |
| --- | --- | --- |
| `NOME_SERVIDOR` | o seu domínio | O nome que aparece nas mensagens |
| `DISCO_AVISO`, `DISCO_SERIO`, `DISCO_CRITICO`, `DISCO_EXTREMO` | 75, 85, 92, 97 | Limites do disco, em % (precisam ser crescentes). No extremo a reserva é liberada |
| `RAM_AVISO`, `RAM_SERIO`, `RAM_CRITICO` | 85, 92, 96 | Limites da memória, em % |
| `RESERVA_GB` | 2 | Tamanho da reserva de disco. `0` desliga |
| `FAXINA_AUTOMATICA` | 1 | `0` desliga a faxina sozinha |
| `ALIVIO_RAM_AUTOMATICO` | 1 | `0` desliga o fechamento do navegador e a parada da ronda |
| `REPETIR_AVISO_MIN`, `REPETIR_SERIO_MIN`, `REPETIR_CRITICO_MIN` | 360, 60, 10 | De quanto em quanto tempo repete o aviso |
| `AGENTE_CAIDO_RODADAS` | 2 | Quantos minutos seguidos sem responder até dar o agente como caído |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHATS` | vazio | Telegram (veja acima) |
| `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORTA`, `EMAIL_USUARIO`, `EMAIL_SENHA`, `EMAIL_DE`, `EMAIL_PARA` | vazio | E-mail. Porta 587 usa STARTTLS e 465 usa SSL |
| `PULSO_URL` | vazio | O endereço do pulso externo (precisa começar com `https://`) |

Token, senha do e-mail e o endereço do pulso são segredos: a sentinela nunca os escreve em log, no painel nem na saída dos
comandos.

## Se algo não funcionar

- **O cartão diz que a sentinela ainda não rodou:** rode `sudo dgclaw sentinela rodar` e confira
  `systemctl status dgclaw-sentinela.timer`.
- **Não chegou nada no Telegram:** `sudo dgclaw sentinela testar-avisos` mostra qual canal falhou e por quê. O erro mais
  comum é esquecer de mandar uma primeira mensagem ao bot.
- **O aviso diz "não consegui gravar o estado: disco cheio":** o disco está tão cheio que nem o estado da sentinela cabe.
  Libere espaço agora (veja "Quando o disco enche de coisa que a faxina não cobre").
- O registro do que ela fez fica em `/var/log/dgclaw/sentinela.log` e em `/var/lib/dgclaw/sentinela/historico.jsonl`.

Os detalhes técnicos das rotas do painel estão em [web/docs/SENTINELA.md](../web/docs/SENTINELA.md).
