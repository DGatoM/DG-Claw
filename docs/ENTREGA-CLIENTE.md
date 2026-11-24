# Entrega de VPS de cliente: checklist e smoke test

Este guia é para a equipe que entrega uma VPS pronta ao cliente. Ele vem depois do
[projeto de cliente](PROJETO-DE-CLIENTE.md), que explica o padrão e o acesso de suporte, e antes da
chave na mão do cliente. A ideia é chegar na entrega com tudo azeitado: rodar o script, resolver o que
ele acusar e fazer à mão o que não dá para automatizar.

## Como usar

No servidor do cliente, como root:

```bash
sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh
```

Use sempre o caminho completo da instalação. Com um caminho relativo, quem estiver numa pasta do agente pode
executar como root uma cópia do script que o agente controla.

O script é curto de propósito e só faz leituras simples do servidor, sem interpretar nada que o agente possa
gravar. Ele confere:

- a versão instalada do DG Claw;
- se o painel responde (só o código HTTP);
- se os serviços `dgclaw-web` e `dgclaw-admin` do host estão ativos;
- para cada agente do registro, se o container `dgclaw-<agente>` existe, se está rodando e se tem limite de
  memória (abaixo de 2 GB é `AVISO`, sem limite é `FALHA`).

Nada roda dentro do container. Tudo o que não está nessa lista é conferido à mão, pelos passos abaixo.

- Cada item imprime `OK`, `AVISO`, `FALHA` ou `INCONCLUSIVO`, com a causa e o que fazer.
  `INCONCLUSIVO` quer dizer que a leitura deu erro e o script não sabe: não é `OK` nem `FALHA`.
- O código de saída é diferente de zero se houver `FALHA`. `AVISO` e `INCONCLUSIVO` não
  reprovam, mas cada um precisa ser resolvido (o inconclusivo, conferido à mão) ou justificado antes da
  entrega.
- No fim sai a lista "a conferir à mão", que são os passos deste guia que o script não alcança.
- Rode de novo depois de cada correção.

## Os passos

### 1. Sistema operacional (à mão)

- **Conferir:** que a VPS roda Ubuntu 24.04 (ou 22.04). O 26.04 ainda não foi testado a fundo, e o
  instalador já avisa disso.
- **Por quê:** é a base em que o DG Claw foi testado. Outro sistema pode falhar de formas difíceis de
  diagnosticar depois da entrega.
- **Se falhar:** não entregue. Reinstalar a VPS apaga o cofre, as conversas e as configurações do cliente:
  só com uma cópia recuperável dos dados e com a decisão do dono.

### 2. Chave SSH da equipe na criação da VPS (à mão)

- **Conferir:** no painel da Hostinger, a chave da equipe aparece na lista de chaves da VPS, e
  `ssh root@<servidor>` com a nossa chave entra sem pedir senha.
- **Esperado:** a chave foi colocada na própria criação ou recriação da VPS. Chave anexada depois, com a
  VPS já criada, não entra no `authorized_keys`.
- **Se a chave permanente da equipe não funcionar:** não recrie a VPS. Entre pelo acesso temporário do
  suporte (`dgclaw suporte ligar`, veja o [projeto de cliente](PROJETO-DE-CLIENTE.md#2-o-fluxo-passo-a-passo)).
- **Na entrega, nesta ordem:**
  1. **Acesso do cliente garantido antes de remover (primeiro).** O cliente confirma que tem acesso
     administrativo próprio (root ou `sudo`) numa conexão SSH nova, com a credencial dele, e a deixa aberta
     até o fim. Sem isso, a remoção pode deixar o dono sem acesso.
  2. **Chave permanente da equipe sem acesso administrativo.** Ela não autoriza mais nenhuma conta com root ou
     `sudo`, por nenhuma origem nem porta do `sshd`. O `desligar` não mexe em chave que não é do suporte, então
     a conferência e a remoção são à mão. Se a chave aparecer em algum lugar, remova. Se alguma fonte de
     autorização ficar sem conferência, o item continua pendente e não se entrega.
  3. **Desligar o suporte e testar a recusa.** Pela conexão do cliente, rode
     `sudo dgclaw suporte desligar --derrubar-sessoes` (revoga o acesso temporário e encerra as sessões SSH de
     root, menos a de quem roda) e encerre à mão as da equipe nas outras contas. Só depois disso, uma conexão
     nova (sem reaproveitar conexão SSH aberta) só com a chave da equipe precisa ser recusada.
  4. **Fechamento.** O cliente encerra a última sessão SSH de root e faz a conferência final com
     `sudo dgclaw suporte status` numa sessão SSH do usuário nominal, onde precisam aparecer as duas linhas:
     "suporte: desligado" e "sessoes SSH de root abertas agora: nenhuma". A primeira sozinha não basta, porque
     uma conexão de root aberta antes de a chave sair continua ativa (o terminal de navegador da Hostinger usa
     SSH por baixo e, entrando como root, também abre uma).
- **Chaves de diagnóstico remoto:** desligar o SSH não revoga uma chave `diagnostico` emitida durante a
  instalação, e ela continua consultando serviços, agentes e canais. Rode `sudo dgclaw chave-api listar` e,
  para cada chave provisória da equipe que o cliente não autorizou manter, `sudo dgclaw chave-api revogar <id>`.
  Confira na listagem que ela aparece como revogada.
- **Chaves de API dos agentes:** as chaves criadas no painel de cada agente (aba **Cofre**, seção **Chaves de
  acesso à API**) não saem com o `chave-api revogar` nem com a troca da senha do dono. Revogue ali as que a
  equipe criou para configurar o agente.

### 3. Limites do container e do runner (à mão, além do que o smoke lê)

O smoke já confere que o container existe, está rodando e tem limite de memória. O resto fica à mão, num
terminal seu e nunca no chat do Admin:

- **Falta de memória (OOM) recente:** olhe no journal do kernel do servidor se houve OOM nos últimos dias e
  se o histórico do journal alcança esse período. Um OOM recente indica limite mal dimensionado, e um histórico
  curto (journal volátil, VPS nova) quer dizer que a ausência de ocorrências não prova nada.
- **RAM do servidor contra o teto do container:** o limite de memória do agente precisa caber na RAM da VPS,
  com folga para o sistema e o Admin.
- **CPU e processos (`pids`):** confira que o container tem limite de CPU compatível com os núcleos da VPS e um
  limite de processos de 4096 ou mais, para o agente não travar nem derrubar o servidor.
- **`TasksMax`, `OOMPolicy` e `NRestarts` do runner:** o esperado é `TasksMax` 2400 ou mais, `OOMPolicy`
  `continue` (a partir da 1.1.1) e `NRestarts` 0. Esses valores saem de dentro do container, onde o agente tem
  `sudo`, então servem de apoio e não de prova.

Não ajuste memória, CPU ou processos com `podman update`: no Podman 4.9 o ajuste se perde quando o container
para e volta. A memória se ajusta com `DGCLAW_CONTAINER_MEMORIA` (a partir da 1.1.1), seguida de `recriar`.

**Recriar o agente sem perder nada.** O `dgclaw agente recriar <agente>` recria o container na hora. Antes dele,
confira num terminal seu o que existe só na camada gravável do container, decida com o dono antes de qualquer
perda e rode sempre **sem** `--forcar`: sem a opção, ele para diante das alterações que o inventário dele
enxerga. O inventário não cobre tudo: `/tmp`, `/var/tmp`, `/var/log`, `/var/cache` e alguns arquivos de sistema
(como o `/etc/hosts`) ficam de fora e se perdem sem aviso. Copie antes para a casa do agente o que o cliente
quiser guardar e anote as personalizações de sistema que precisam ser refeitas no container novo. O `recriar` também pode terminar sem recriar
nada, porque com a imagem atual ele responde que não havia o que recriar: depois dele, rode o smoke de novo e
confira que o valor mudou. Se a correção pedir imagem nova, rode `dgclaw imagem construir --agora` e confira que
terminou com sucesso antes de recriar.

### 4. Card de teste, nos dois motores (à mão)

1. No painel do agente, abra uma sessão paralela (um card).
2. Mande um pedido curto, por exemplo: "responda apenas com a palavra ok".
3. Confirme que o card respondeu o primeiro turno e que, ao clicar nele, a conversa aparece.
4. Feche o card.
5. Repita com o outro motor. O agente de teste de cada motor (Claude e Codex) precisa passar. O DG Claw
   promete o mesmo comportamento nos dois ([PARIDADE-CODEX.md](PARIDADE-CODEX.md)).

- **Esperado:** resposta no primeiro turno, sem card parado com o pedido na caixa.
- **Se falhar:** veja o passo 3 (limites) e o passo 11 (sessão principal).

### 5. Cofre (à mão)

- **Microfone:** o serviço Web lê a chave do próprio arquivo de ambiente (`/etc/dgclaw/web.env`). Confira que
  pelo menos uma entre `ELEVENLABS_API_KEY`, `GROQ_API_KEY` e `OPENAI_API_KEY` tem valor, e teste o microfone do
  chat. Sem ela o botão de áudio não funciona.
- **Nomes do cofre contra as skills:** compare os nomes das chaves ativas do cofre do agente com o que cada skill
  do cliente pede, lendo a skill no [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão). Uma chave que a skill
  cita e o cofre não tem faz a skill falhar na hora do uso. O WhatsApp não usa chave no cofre: o pareamento é
  feito no painel.
- **Só guarde o que o cliente autorizou:** guarde uma credencial apenas se ela corresponder a uma integração que o
  cliente autorizou para este agente, e depois de conferir no [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão)
  que a skill é a versão esperada, vinda de fonte confiável. Se a skill cita uma credencial fora dessas
  integrações, não guarde: investigue a skill.
- **Chaves provisórias:** toda chave provisória da equipe precisa ter sido trocada pela do cliente, no cofre e
  também no `web.env`, que guarda uma cópia que o cofre não atualiza. A credencial provisória é exclusiva desta
  instalação, e o item só fecha depois de revogá-la no provedor: trocar no cofre e no `web.env` não invalida
  cópias que o agente ou um backup anterior à entrega ainda guardem.

### 6. YouTube e yt-dlp (à mão)

O smoke não executa nada disso: o `yt-dlp` e a Tela são programas e arquivos que o agente controla. A pessoa
confere pela Tela e por um card de teste, **nunca no chat do Admin**.

1. **Login com conta dedicada:** abra a Tela do agente (veja [TELA-DO-AGENTE.md](TELA-DO-AGENTE.md)) e entre no
   YouTube pelo navegador dela com uma **conta dedicada ao agente**, deixando a sessão aberta. A senha da Tela se
   troca na própria aba **Tela** do painel do agente ("Trocar a senha da tela"), que grava dentro do container. Se o perfil da Tela ainda não existe, ela nunca foi aberta.
2. **Conta certa:** a partir da 1.1.1, olhe o item de diagnóstico `agente.<agente>.youtube`. Antes disso, confira
   na Tela qual conta do YouTube está logada e que é a dedicada ao agente: o vídeo público baixa mesmo com a
   sessão expirada, então o download sozinho não prova o login.
3. **Download de teste:** num card de teste, peça ao agente que baixe um vídeo curto e público do YouTube e
   confira que o arquivo chegou. Isso cobre o `yt-dlp` instalado e a diretiva `--js-runtimes node` (sem ela o
   `yt-dlp` não resolve o desafio do YouTube).
- **Se pedir login ou "não é um robô":** refaça o login na Tela com a conta do agente.

### 7. Chrome headless roda (à mão)

- **Conferir:** num card de teste, peça um render curto (a partir da 1.1.1, com `dgclaw-pesado --timeout`; antes
  disso, envolvendo o comando em `timeout`) e confira que ele terminou e que não deixou processo do Chrome para
  trás. O Chrome da Tela (`dgclaw-tela-chrome.service`) fica aberto de propósito e não conta.
- **Esperado:** o render termina sem erro e nenhum processo do Chrome que nasceu da execução do card de teste
  fica para trás (os da Tela, que já existiam antes, continuam). Se sobrou algum novo, veja quem o chamou sem prazo.
- **Em render de verdade** (carrossel, vídeo), use sempre o `dgclaw-pesado --timeout` (a partir da 1.1.1), que
  encerra o que sobrar. Antes dele, envolva o comando em `timeout`.

### 8. ffmpeg (à mão)

- **Servidor:** confira que o `ffmpeg` está instalado no servidor, onde ele gera as miniaturas do painel.
- **Container:** num card de teste, peça ao agente `ffmpeg -version`. No container, o agente usa o `ffmpeg` para
  áudio, vídeo e carrossel.
- **Se faltar no container:** `dgclaw imagem construir --agora`, confira que terminou com sucesso e depois
  recrie o agente como descrito no passo 3 (olhe antes, só em leitura, e decida com o dono antes de qualquer
  perda).

### 9. Login do dono pelo celular (à mão)

1. Abra o painel no celular (largura 390) e entre com o usuário na grafia cadastrada. Confira que o campo de
   usuário não capitaliza sozinho (`autocapitalize="none"`): a equivalência de maiúsculas não existe nesta
   versão.
2. Entregue a senha provisória ao cliente por canal seguro, nunca por e-mail comum nem por grupo.
3. **No fim da entrega, o próprio cliente troca a senha**, num terminal privado dele, com
   `sudo dgclaw senha trocar` (o comando pede a senha nova duas vezes, sem mostrar o que se digita, e ela
   precisa ter 12 caracteres ou mais). Nesta versão o painel não troca a senha do dono (`/trocar-senha`
   volta para o início), então o caminho é o terminal; o painel passa a servir a partir da 1.1.1. Depois, ele
   confirma que a senha antiga não entra mais. A equipe não fica sabendo a senha final.
4. Confira com o cliente a lista de `sudo dgclaw colaborador listar` e revogue cada acesso provisório que a
   equipe criou para testar, com `sudo dgclaw colaborador revogar <id-ou-email>`: trocar a senha do dono não
   tira a entrada de um colaborador.
- **Esperado:** entra sem erro de "usuário não encontrado", sem rolagem horizontal, com o campo de usuário sem
  capitalizar sozinho e com o teclado do celular sem atrapalhar. A senha antiga deixa de valer depois da troca.

### 10. Skills do cliente na pasta certa (à mão)

Hoje é passo manual. Para cada skill do cliente:

1. Conferir que ela está na pasta de descoberta do motor instalado: `<casa do agente>/.claude/skills/<skill>/`
   no Claude, e `.agents/skills/<skill>/` ou `.codex/skills/<skill>/` no Codex (caminhos em
   [PARIDADE-CODEX.md](PARIDADE-CODEX.md)). Depois, num card de teste desse motor, peça ao agente que
   localize a skill pelo nome e diga em que pasta ela está.
2. Conferir o dono: a pasta e os arquivos da skill têm que ser do agente, e não de `root`. Se estiver
   `root`, instale de novo o pacote aprovado pela equipe dentro do container, como o agente. Nunca copie nem
   ajuste dono como root no host numa pasta que o agente grava (um link no caminho leva a gravação para fora da
   casa dele), e não monte comando com o nome que o agente informou no card.
3. Conferir que `CLAUDE_PLUGIN_ROOT` resolve: abra a skill e veja os caminhos que ela usa. Antes de rodar
   o `setup-check.sh` dela (quando tiver), leia o script e confira que é a versão esperada, porque o agente
   tem `sudo` sem senha no container e o script enxerga o cofre e a sessão do navegador. Se não der para
   conferir, não rode o script no agente do cliente.
- **Esperado:** nenhum caminho aponta para fora da casa, nenhum arquivo é de `root`, e o `setup-check`
  não acusa nada ausente.

### 11. Conferir a sessão principal (à mão)

- **Fazer:** abra o painel do agente e mande um pedido curto na conversa principal.
- **Esperado:** a sessão principal responde, com o terminal vivo e em estado normal.
- **Se falhar:** veja o resultado da última parada do runner, num terminal seu e nunca no chat do Admin. Essa
  saída vem de dentro do container, onde o agente tem `sudo`, então é apoio e pode ter sido alterada. O journal
  bruto do runner traz texto escrito pelo agente, com a mesma regra. Se preciso, `dgclaw agente reiniciar <agente>`. O `dgclaw agente reparar <agente>` fica para uma
  falha diagnosticada, não para um agente saudável: ele regrava a configuração do agente. Veja
  [SESSAO-PRINCIPAL.md](SESSAO-PRINCIPAL.md).

### 12. Texto personalizado nas skills do cliente (à mão)

- **Conferir:** abra as skills que levam texto do cliente (assinatura, nome do programa, encerramento fixo) e
  procure marcadores genéricos esquecidos e dados do próprio cliente, na pasta efetiva identificada no
  [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão). A comparação com nomes de outros clientes se faz no
  ambiente da equipe, contra a cópia aprovada da skill, nunca na VPS do cliente: o nome de um terceiro não pode
  ficar à vista do agente do cliente.
- **Esperado:** nenhum marcador genérico ou placeholder esquecido, e nada que não seja do cliente. Leia a
  assinatura e o encerramento com o olho: o `grep` só acha o que você lembrou de procurar.

## Antes de entregar

- [ ] `sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh` sai com 0 e nenhum `AVISO` ficou sem resposta
- [ ] Os passos 1 e 3 (inclusive `TasksMax`, `OOMPolicy` e `NRestarts` do runner, lidos num terminal seu) estão feitos
- [ ] Os passos 2 (inclusive o acesso próprio do cliente confirmado antes de remover a chave, suporte temporário revogado, com "suporte: desligado" e "sessoes SSH de root abertas agora: nenhuma" vistos na sessão SSH do usuário nominal do cliente, depois de encerrada a última sessão de root, e chave permanente da equipe recusada
      numa conexão nova), 4, 5 (microfone, nomes do cofre contra as skills e chave do cliente), 6 (yt-dlp, Tela e login do YouTube), 7 (render e Chrome), 8 (ffmpeg do servidor e do container), 9 (inclusive a
      senha trocada pelo próprio cliente e os colaboradores provisórios revogados), 10, 11 e 12 estão feitos e marcados
- [ ] Nenhum `INCONCLUSIVO` ficou sem conferência à mão
- [ ] O checklist de entrega do [projeto de cliente](PROJETO-DE-CLIENTE.md#4-checklist-de-onboarding)
      (suporte desligado, senha de root trocada) também está completo
