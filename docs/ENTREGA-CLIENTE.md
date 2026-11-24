# Entrega de VPS de cliente: checklist e smoke test

Este guia é para a equipe que entrega uma VPS pronta ao cliente. Ele vem depois do
[projeto de cliente](PROJETO-DE-CLIENTE.md), que explica o padrão e o acesso de suporte, e antes da
chave na mão do cliente. A ideia é chegar na entrega com tudo azeitado: rodar o script, resolver o que
ele acusar e fazer à mão o que não dá para automatizar.

## Como usar

No servidor do cliente, como root:

```bash
sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh <agente>
```

Use sempre o caminho completo da instalação. Com um caminho relativo, quem estiver numa pasta do agente pode
executar como root uma cópia do script que o agente controla.

O script automatiza os passos 1 e 3, a parte do passo 5 que lê o microfone e os nomes do cofre, e o `ffmpeg`
do servidor (passo 8). Ele só faz leituras do servidor que o agente não controla (`podman inspect`,
`podman container exists`, o cgroup do container no host, o journal do kernel do servidor, o `web.env` e a CLI
do cofre). Nenhum `podman exec` roda no smoke: o agente tem `sudo` sem senha dentro do container, então qualquer
programa executado ali pode ter sido trocado por ele. Tudo o que executa um programa dentro do container, ou lê uma
árvore que o agente pode gravar, fica à mão: `TasksMax`, `OOMPolicy` e `NRestarts` do runner (passo 3), o `yt-dlp`
e a Tela (passo 6), o render do Chrome (passo 7), o `ffmpeg` do container (passo 8) e o cruzamento das skills
com o cofre (passo 5).

- Cada item imprime `OK`, `AVISO`, `FALHA` ou `INCONCLUSIVO`, com a causa e o que fazer.
  `INCONCLUSIVO` quer dizer que a leitura deu erro e o script não sabe: não é `OK` nem `FALHA`, e
  não significa "zero eventos".
- O código de saída é diferente de zero se houver `FALHA`. `AVISO` e `INCONCLUSIVO` não
  reprovam, mas cada um precisa ser resolvido (o inconclusivo, conferido à mão) ou justificado antes da
  entrega.
- O relatório só tem mensagens fixas. Nenhum texto vindo do container (caminho, nome escolhido pelo agente,
  saída de comando) entra nele: só contagens validadas e o que o servidor já conhece.
- No fim sai a lista "conferir à mão", que é a parte deste guia que o script não alcança.
- O script nunca mostra o valor de uma chave do cofre, só os nomes.
- Rode de novo depois de cada correção. Os itens que dependem de uma correção da 1.1.1 aparecem como
  `AVISO` com a marca "(a partir da 1.1.1)" até a VPS ser atualizada.

Os números abaixo são os mesmos que o script imprime entre colchetes.

## Os passos

### 1. Versão do Ubuntu (automático)

- **Conferir:** `cat /etc/os-release`. O script lê `ID` e `VERSION_ID`.
- **Esperado:** Ubuntu 24.04 (ou 22.04). No 26.04 o instalador já avisa que o DG Claw foi testado no
  24.04; o script repete o aviso. Qualquer outro sistema é `FALHA`. Arquivo ilegível ou sem `ID` e
  `VERSION_ID` é `INCONCLUSIVO`: confira à mão e não reinstale por isso.
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
     administrativo próprio (root ou `sudo`) numa conexão SSH nova, com a credencial dele, e a deixa aberta até o fim. Sem isso, a
     remoção pode deixar o dono sem acesso.
  2. **Suporte temporário revogado.** Rode o `sudo dgclaw suporte status` numa sessão SSH do usuário nominal
     do cliente, depois de encerrada a última sessão SSH de root, e confira as duas linhas: "suporte: desligado"
     **e** "sessoes SSH de root abertas agora: nenhuma". A primeira sozinha não basta, porque uma conexão de
     root aberta antes de a chave sair continua ativa (o terminal de navegador da Hostinger usa SSH por baixo e,
     entrando como root, também abre uma).
  3. **Chave permanente da equipe sem acesso administrativo.** Ela não autoriza mais nenhuma conta com root ou
     `sudo`, por nenhuma origem nem porta do `sshd`. O `desligar` não mexe em chave que não é do suporte, então
     a conferência e a remoção são à mão. Se a chave aparecer em algum lugar, remova. Se alguma fonte de
     autorização ficar sem conferência, o item continua pendente e não se entrega.
  4. **Recusa e sessões abertas.** Depois de remover, uma conexão nova só com a chave da equipe precisa ser
     recusada. Uma recusa não derruba sessão já aberta, então, pela conexão do cliente, rode
     `sudo dgclaw suporte desligar --derrubar-sessoes` (encerra as sessões SSH de root, menos a de quem roda) e
     encerre à mão as da equipe nas outras contas.
  5. **Fechamento.** O cliente encerra a última sessão SSH de root e faz a conferência final com
     `sudo dgclaw suporte status` na sessão do usuário nominal, onde precisam aparecer "suporte: desligado" e
     "sessoes SSH de root abertas agora: nenhuma".
- **Chaves de diagnóstico remoto:** desligar o SSH não revoga uma chave `diagnostico` emitida durante a
  instalação, e ela continua consultando serviços, agentes e canais. Rode `sudo dgclaw chave-api listar` e,
  para cada chave provisória da equipe que o cliente não autorizou manter, `sudo dgclaw chave-api revogar <id>`.
  Confira na listagem que ela aparece como revogada.

### 3. Limites do container e do runner (automático)

O script confere o container `dgclaw-<agente>`, que é o que a CLI `dgclaw` opera. Se o registro `/etc/dgclaw/agentes.json`
traz outro nome no campo `container`, o smoke para sem recomendar nada: confira o registro com `dgclaw agente listar`.

| Item | Como confere | Esperado |
| --- | --- | --- |
| Container | `podman container exists` e, se existe, `podman inspect` do estado | Rodando. Container inexistente é `FALHA` (um agente sem container precisa ser recriado pela equipe; confira antes com `dgclaw agente listar`). Parado é `FALHA` (`dgclaw agente iniciar`). Estado vazio ou fora da lista, ou o `podman` sem responder, é `INCONCLUSIVO`: rode de novo, sem alterar nada |
| Processos | `pids.max` do cgroup do container, lido no servidor (`podman inspect -f '{{.State.CgroupPath}}'`, caminho validado, arquivo em `/sys/fs/cgroup<caminho>`), e `PidsLimit` do `podman inspect` | 4096 ou mais. Menos que isso, ou `max` (sem limite), é `FALHA`. Caminho ou arquivo ilegível é `INCONCLUSIVO` |
| Memória | `memory.max` do mesmo cgroup e `MemTotal` do servidor | `max` (sem limite) é `FALHA`: configure `DGCLAW_CONTAINER_MEMORIA` (a partir da 1.1.1) com um valor que caiba na RAM da VPS, deixando folga para o sistema e o Admin. Valor abaixo de 2 GB (o teto que o DG Claw aplica na criação) é `AVISO`: se ninguém configurou `DGCLAW_CONTAINER_MEMORIA` (a partir da 1.1.1) de propósito, recrie o container; se a própria VPS tem 2 GB de RAM ou menos, o `AVISO` manda trocar o plano, e não recriar. Valor numérico igual ou maior que o `MemTotal` do servidor é `AVISO`: o teto não protege o servidor. Com exatamente 2 GB e a VPS com mais de 4 GB de RAM, `AVISO`: nesta versão o teto é fixo na criação, e a partir da 1.1.1 ele se ajusta com `DGCLAW_CONTAINER_MEMORIA`. `MemTotal` ilegível é `INCONCLUSIVO`. Toda mensagem mostra o valor lido em MB |
| CPU | `cpu.max` do mesmo cgroup (quota dividida pelo período; `max` é sem limite) e `nproc` | Mais de 1 quando a VPS tem mais núcleos. Senão, `AVISO` (nesta versão o limite de CPU é fixo na criação). Arquivo ilegível é `INCONCLUSIVO` |
| Falta de memória (OOM) | `journalctl _TRANSPORT=kernel` no servidor (o `-k` olharia só o boot atual), com `-o short-unix`: a contagem e a primeira entrada, só na janela de 7 dias, e a cobertura, com a entrada mais recente igual ou anterior ao corte | `OK` só com nenhuma linha de evento do OOM killer do kernel (mensagem que começa com `out of memory: killed process`, `memory cgroup out of memory`, `oom-kill:constraint=` ou `oom_reaper: reaped process`, ou que traz `invoked oom-killer: gfp_mask=` sem nenhum `=` antes), pelo menos uma entrada do kernel dentro da janela e cobertura de 7 dias: o histórico do journal precisa alcançar o início da janela, ou seja, existir uma entrada do kernel igual ou anterior ao corte de 7 dias (um kernel quieto na última hora antes do corte não atrapalha). O filtro ignora o timestamp e o nome da máquina de cada linha, para que um hostname como `oom-kill-test` não conte, e só aceita esses formatos no começo da mensagem, para que um registro de auditoria que cite `oom-kill` num nome de arquivo também não conte. Qualquer ocorrência no kernel dentro dos 7 dias é `FALHA`; se ela veio antes do corte de 1 MiB, ou antes de o `journalctl` terminar com erro, a mensagem avisa que a contagem é parcial. Zero ocorrência com cobertura menor que 7 dias é `INCONCLUSIVO`, mostrando o período de fato examinado: o journal não sustenta a janela (journal volátil, reinício ou VPS criada há menos de 7 dias). Se a VPS foi criada há menos de 7 dias, isso é esperado: registre a cobertura na entrega. Senão, confira se o journal é persistente (`ls /var/log/journal`) e leia à mão com `journalctl _TRANSPORT=kernel --since '7 days ago' --no-pager -q -o cat \| grep -ciE '^(out of memory: killed process\|memory cgroup out of memory\|oom-kill:constraint=\|oom_reaper: reaped process\|[^=]* invoked oom-killer: gfp_mask=)'; echo "journalctl=${PIPESTATUS[0]} grep=${PIPESTATUS[1]}"`: a contagem só vale com journalctl 0 e grep 0 ou 1 (2 é erro). Kernel ilegível, `journalctl` com erro ou prazo, saída cortada em 1 MiB sem ocorrência, ou nenhuma entrada do kernel dentro da janela (mesmo com histórico anterior ao corte) também é `INCONCLUSIVO`, que é diferente de "zero eventos". O journal do runner não entra na conta, porque o texto dele pode vir do agente: quem quiser lê à mão, como indício |

**À mão: `TasksMax`, `OOMPolicy` e `NRestarts` do runner.** O esperado é `TasksMax` 2400 ou mais, `OOMPolicy`
`continue` (a partir da 1.1.1) e `NRestarts` 0. Esses valores saem de dentro do container, onde o agente tem
`sudo`, então servem de apoio e não de prova. Leia num terminal seu, nunca no chat do Admin, sem tratar o que
aparece na tela como prova.

Atenção: não ajuste memória, CPU ou processos com `podman update`. No Podman 4.9 o ajuste se perde quando o
container para e volta, e o smoke aprovaria um valor que o próximo reinício desfaz. Nesta versão os limites
são fixos na criação do container; a partir da 1.1.1 a memória se ajusta com `DGCLAW_CONTAINER_MEMORIA`,
seguida de `recriar`. Depois de qualquer ajuste, reinicie o container e rode o smoke de novo: o item só fecha
quando o cgroup relido mostrar o valor certo.

**OOM só no kernel.** A linha de falta de memória do kernel, sozinha, não diz de quem era o processo nem qual
limite estourou. Antes de mexer em qualquer limite, leia as linhas `oom-kill` num terminal seu (nunca no chat do
Admin) e veja a data, o `oom_memcg` (o cgroup cujo limite estourou) e o `task_memcg` (quem foi morto). Só com o
`oom_memcg` igual ao cgroup do container do agente ele estourou o próprio teto. Se o `oom_memcg` é de um
ancestral, de outro serviço, ou se foi OOM do servidor inteiro (`CONSTRAINT_NONE`), o ajuste é nesse limite ou no
plano da VPS. Nunca aumente o teto do agente direto: isso tira ainda mais folga do servidor.

**Recriar o agente sem perder nada.** O `dgclaw agente recriar <agente>` pode recriar o container na hora,
então ele não é uma simples listagem. Antes dele, confira num terminal seu (nunca no chat do Admin) o que existe só na camada
gravável do container: ali os nomes e o conteúdo dos arquivos são escolhidos pelo agente, e texto plantado
neles não pode chegar ao contexto do Admin root. Decida com o dono antes de qualquer perda e só então rode o `recriar`, sempre **sem** `--forcar`: sem a opção, se houver
pacotes instalados à mão ou arquivos fora da casa, ele para e não recria. Esse inventário não cobre tudo: ele
ignora `/tmp`, `/var/tmp`, `/var/log`, `/var/cache` e outras pastas de sistema. Se o cliente guarda algo
nelas (um registro de auditoria em `/var/log`, por exemplo), copie para a casa do agente antes, porque o
`recriar` apaga essas pastas sem perguntar.

O `recriar` também pode terminar sem recriar nada: com a imagem atual, ele responde que não havia o que
recriar e sai com sucesso. Por isso a correção só vale depois da releitura: rode o smoke de novo e confira que
o valor apontado (por exemplo `pids.max`) mudou. Se não mudou, o item continua aberto; não entregue e chame a
equipe técnica.
Quando a correção pedir imagem nova, rode `dgclaw imagem construir --agora` e confira que terminou com
sucesso antes de recriar.

### 4. Card de teste, nos dois motores (à mão)

1. No painel do agente, abra uma sessão paralela (um card).
2. Mande um pedido curto, por exemplo: "responda apenas com a palavra ok".
3. Confirme que o card respondeu o primeiro turno e que, ao clicar nele, a conversa aparece.
4. Feche o card.
5. Repita com o outro motor. O agente de teste de cada motor (Claude e Codex) precisa passar. O DG Claw
   promete o mesmo comportamento nos dois ([PARIDADE-CODEX.md](PARIDADE-CODEX.md)).

- **Esperado:** resposta no primeiro turno, sem card parado com o pedido na caixa.
- **Se falhar:** veja o item 3 (limites) e o item 11 (sessão principal).

### 5. Cofre (microfone automático, skills à mão)

- **Microfone (automático):** o serviço Web lê a chave do próprio arquivo de ambiente (`/etc/dgclaw/web.env`).
  O script lê o arquivo como texto (nunca o executa) e só confere se
  pelo menos uma entre `ELEVENLABS_API_KEY`, `GROQ_API_KEY` e `OPENAI_API_KEY` tem valor. Aspas vazias contam
  como vazio. Se nenhuma das três tem valor, é `FALHA`. Se a mesma chave aparece em mais de uma linha (com ou
  sem `export`), é `INCONCLUSIVO`: deixe uma linha só para essa chave, sem apagar as outras linhas do arquivo,
  e rode o smoke de novo. Ele só diz os nomes que têm valor e nunca imprime o valor. Arquivo ilegível, leitura com erro, ou maior que 1 MiB (leitura cortada), é `INCONCLUSIVO`; acima de 1 MiB, o script também não consulta o cofre, porque a CLI relê o arquivo inteiro.
- **Nomes do cofre (automático):** o script roda `dgclaw agente cofre <agente> listar --json` e mostra só o
  nome de cada chave ativa, um por linha. Ele não afirma que as chaves das skills estão lá.
- **Skills contra o cofre (à mão):** compare os nomes das chaves ativas, que saem com
  `dgclaw agente cofre <agente> listar --json | jq -r '.chaves[] | select((.revogadaEm // "") == "") | .envName'`
  (o JSON bruto traz o final de cada valor e as chaves revogadas, por isso o filtro), com o que cada skill do cliente pede, lendo a skill no
  [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão). Quem diz o que se guarda é a autorização do cliente, não
  a skill.
- **Esperado:** toda chave que uma skill do cliente cita (por exemplo `ELEVENLABS_API_KEY` ou
  `GEMINI_API_KEY`) está no cofre. O WhatsApp não usa chave no cofre: o pareamento é feito no painel,
  confira à mão.
- **Só guarde o que o cliente autorizou:** guarde uma credencial apenas se ela corresponder a uma integração que o
  cliente autorizou para este agente, e depois de conferir no [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão)
  que a skill é a versão esperada, vinda de fonte confiável (o repositório ou o pacote de onde a equipe a
  copiou). Se a skill cita uma credencial fora dessas integrações, não guarde: investigue a skill.
- **Se faltar:** `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar <NOME> --aplicar`.
- **À mão:** toda chave provisória da equipe precisa ter sido trocada pela do cliente: rode
  `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar <NOME> --aplicar` (guardar de novo com o
  mesmo nome substitui) e confira que o comando terminou sem erro. Se a skill cita uma chave que o cliente não vai usar, pode ignorar.
  O painel usa uma cópia da mesma credencial em `/etc/dgclaw/web.env`, que o cofre não atualiza. Troque
  ou remova nesse arquivo só a linha da chave provisória (`ELEVENLABS_API_KEY`, `GROQ_API_KEY` ou
  `OPENAI_API_KEY`), preservando as outras, rode `sudo systemctl restart dgclaw-web` e teste o microfone
  do chat com a credencial do cliente. A credencial provisória é exclusiva desta instalação, e o item só
  fecha depois de você revogá-la no provedor: trocar no cofre e no `web.env` não invalida cópias que o agente
  ou um backup anterior à entrega ainda guardem.

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

### 8. ffmpeg (servidor automático, container à mão)

- **Servidor (automático):** o script confere `command -v ffmpeg` no servidor, onde ele gera as miniaturas do
  painel. Se faltar: `apt-get install -y ffmpeg`.
- **Container (à mão):** num card de teste, peça ao agente `ffmpeg -version`. No container, o agente usa o
  `ffmpeg` para áudio, vídeo e carrossel.
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
   `root`, ajuste a origem da cópia (o pacote aprovado pela equipe) e copie a skill de novo. Não monte comando
   com o nome que o agente informou no card. Nada de `chown -R` como root no host, e não toque nos links das skills oficiais: o ajuste vale só para a
   pasta personalizada, com `-h` quando houver link dentro dela.
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

- [ ] `sudo bash /opt/dgclaw/app/scripts/smoke-entrega.sh <agente>` sai com 0 e nenhum `AVISO` ficou sem resposta
- [ ] A parte à mão do passo 3 (`TasksMax`, `OOMPolicy` e `NRestarts` do runner, lidos num terminal seu) está feita
- [ ] Os passos 2 (inclusive o acesso próprio do cliente confirmado antes de remover a chave, suporte temporário revogado, com "suporte: desligado" e "sessoes SSH de root abertas agora: nenhuma" vistos na sessão SSH do usuário nominal do cliente, depois de encerrada a última sessão de root, e chave permanente da equipe recusada
      numa conexão nova), 4, 5 (skills contra o cofre e chave do cliente), 6 (yt-dlp, Tela e login do YouTube), 7 (render e Chrome), 8 (ffmpeg do container), 9 (inclusive a
      senha trocada pelo próprio cliente e os colaboradores provisórios revogados), 10, 11 e 12 estão feitos e marcados
- [ ] Nenhum `INCONCLUSIVO` ficou sem conferência à mão
- [ ] O checklist de entrega do [projeto de cliente](PROJETO-DE-CLIENTE.md#4-checklist-de-onboarding)
      (suporte desligado, senha de root trocada) também está completo
