# Changelog

Todas as mudanças importantes do DG Claw ficam neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Corrigido

- O vigia de saúde não confunde mais o resumo da compactação com uma mensagem sua sem resposta. Antes, depois de cada compactação, o agente era reiniciado várias vezes seguidas sem motivo e o painel avisava que ele não estava respondendo.
- Os agentes que usam o Claude deixam de "responder no vazio". Às vezes o agente escrevia a resposta como texto solto no fim do turno, sem usar a ferramenta de resposta do chat (ou do WhatsApp), e esse texto ficava no terminal sem chegar a você. Agora, quando isso acontece, a plataforma devolve o turno uma vez e o agente reenvia a resposta pelo canal certo. Recados da própria plataforma, turnos sem nenhum texto e qualquer falha da conferência passam sem cobrança, e as decisões ficam no arquivo `trava-resposta.log`, sem o conteúdo das mensagens. Só vale como resposta a ferramenta do canal certo e que não falhou, e, quando o turno é devolvido, o painel continua mostrando o agente como trabalhando até ele terminar de verdade.
- Quando o texto entregue ao agente demora a ser aceito, o sistema continua tentando enviar por mais de um minuto em vez de deixá-lo parado na caixa de entrada.

**Nova tela Logs no Admin.** No menu do Admin, o item **Logs** (endereço `/logs`) mostra, do mais novo para o mais antigo,
tudo o que cada agente fez: mensagens, comandos, arquivos e ferramentas, tanto dos agentes que usam o Claude quanto dos que
usam o Codex. Há filtros por período, tipo, sessão e palavra, e cada registro abre para mostrar o comando, o arquivo e o
resultado. O texto sai com chaves e senhas escondidas, e a tela diz com clareza quando uma fonte não existe ou não pôde ser
lida, em vez de parecer que o agente não fez nada. Só você, no navegador, vê os logs: colaboradores e agentes não têm acesso.
Comando que pode levar senha ou chave aparece só com o nome do programa, sem os argumentos. A tela ajuda a conferir, mas não prova nada, porque um agente pode reescrever a própria casa.

### Como atualizar (logs dos agentes)

Nesta versão há uma instrução nova para o Admin, que explica a tela Logs e pede que ele não leia o conteúdo dos logs. Ela
precisa entrar nas instruções dele sem apagar o que você já personalizou. O histórico que os agentes já têm aparece sozinho
na tela, sem migração e sem nada a configurar.

### Como atualizar (resposta no chat)

Depois de atualizar, reinicie cada agente que usa o Claude para ele ganhar a conferência de resposta: ela é gravada nas configurações que o agente recebe ao subir. Não há nada para configurar nem para juntar às instruções dele.

**Vários colaboradores no mesmo agente.** Antes, cada agente aceitava um colaborador só, e um segundo convite era recusado até você revogar o primeiro. Agora você convida quantas pessoas quiser para o mesmo agente. Na tela **Convidar colaborador** cada pessoa aparece num cartão, com os botões de mandar o convite de novo e de revogar o acesso, e o formulário para convidar mais alguém fica sempre abaixo. Revogar ou reenviar o convite de uma pessoa não mexe nas outras. Cada pessoa continua acessando um agente só, e as mensagens de cada uma chegam ao agente marcadas com o nome e o e-mail de quem falou. Nada precisa ser feito para atualizar.

**Correção na rede dos containers no Ubuntu 26.04: netavark em modo iptables.** No Ubuntu 26.04 o netavark usa nftables por padrão, e o `ufw` (que o instalador liga) bloqueia o encaminhamento de pacotes, então nenhum container de agente tinha internet (a construção da imagem falhava com "Temporary failure resolving archive.ubuntu.com"). O instalador agora grava `/etc/containers/containers.conf.d/50-dgclaw-firewall-iptables.conf` com `firewall_driver = "iptables"`, que é o modo em que a cerca de rede do DG Claw foi desenhada. No Ubuntu 24.04 isso não muda nada. Se você já definiu `firewall_driver` em qualquer arquivo do podman (`/etc/containers/containers.conf`, a pasta `containers.conf.d` ou o padrão em `/usr/share/containers`), o instalador não grava o dele e não mexe no seu: só avisa quando o valor não é `iptables`.

**A cerca contra o servidor também vale antes de o netavark mexer no firewall.** Ao subir um container, o netavark libera a porta 53 do servidor para a rede do agente numa regra que ficava à frente da cerca, e o agente alcançava essa porta por alguns segundos, até a cerca ser reaplicada. A cerca agora também fica na tabela `mangle` (que o netavark não usa), do mesmo jeito que já era feito para o tráfego entre redes, e o teste de isolamento passou a conferir a porta 53 do servidor.

**Correção no DNS dos agentes em servidor dentro de rede privada.** Em servidor físico na rede de uma empresa, o DNS do servidor costuma ficar num endereço privado (por exemplo `192.168.25.6`), que a cerca de rede dos agentes bloqueia de propósito, e os agentes ficavam sem DNS. Agora, quando isso acontece, só os containers do DG Claw (os agentes e a sonda do teste de isolamento) são criados com DNS público (`1.1.1.1` e `8.8.8.8`), sem abrir exceção na cerca e sem mudar a configuração do podman no resto do servidor. Se o DNS do servidor já é público, nada muda.

### Como atualizar

Rode `sudo ./install.sh` de novo (ou peça ao Admin para atualizar): ele aplica as correções sozinho. Há dois casos em que falta um passo seu:

- Servidor com Ubuntu 26.04 e agentes ligados: o instalador só apaga as regras antigas do netavark quando todos os containers estão parados, para não derrubar a rede deles, e avisa com a lista do que está ligado. Nesse caso, pare cada agente com `sudo dgclaw agente parar <slug>`, rode `sudo ./install.sh` de novo e ligue cada um com `sudo dgclaw agente iniciar <slug>`. Containers que não são do DG Claw também precisam estar parados.
- Servidor cujo DNS fica numa rede privada: o container de um agente já existente continua com o DNS antigo, porque o podman não troca o DNS de um container criado. Para ele passar a usar DNS público, rode `sudo dgclaw agente recriar <slug> --forcar` (a casa e a memória do agente não são tocadas). O `--forcar` é preciso quando o agente está parado; com o agente ligado, o `recriar` já percebe sozinho que o DNS precisa mudar.

**O DG Claw instala em servidor sem IP público, atrás de um túnel.** Com `--atras-de-tunel` (junto de `--dominio`), o Caddy usa
certificado interno, o instalador não consulta o IP público e não abre as portas 80 e 443 no firewall; o túnel da Cloudflare
aponta para `https://127.0.0.1:443`, com o nome do servidor de origem igual ao domínio e sem verificação do certificado. A
escolha fica no `dgclaw.env` e vale para reinstalar, atualizar e `dgclaw dominio trocar`. Nesse modo o Caddy escuta só no loopback, então o túnel
precisa rodar no próprio servidor, e ele passa o IP real do visitante ao painel, para o limite de tentativas de login valer
por pessoa. O firewall agora também libera a porta real do SSH (lida da configuração do `sshd`, dos processos em escuta, do
`ssh.socket` e da sua conexão atual), e não só a 22. Para quem usa o Claude Code, o instalador confere se a CPU tem SSE4.2 (CPU genérica
`kvm64` de hipervisor não tem) e explica como trocar o tipo de CPU da máquina virtual. Quando o Claude Code falta e você usa
`sudo`, a mensagem mostra como instalá-lo para o root. Nada muda para quem já instalou.

**Instalação atrás de um proxy que já existe (`--proxy-existente`).** Para servidor que já tem nginx, Caddy ou túnel da Cloudflare nas portas 80 e 443, o instalador ganhou `--proxy-existente`. Nesse modo ele não instala o Caddy, não mexe no ufw (nem para ler o estado) e trata as portas 80 e 443 ocupadas como aviso. O DG Claw Web escuta só em `127.0.0.1`, na porta de `--porta-painel` (padrão 8300), e o instalador imprime no fim o trecho pronto para o nginx e as linhas do `ingress` para o túnel, com o link de primeiro acesso. O domínio passa a ser obrigatório nesse modo. O modo e a porta ficam no `dgclaw.env` e valem nas próximas execuções e no `dgclaw atualizar`; `--sem-proxy-existente` volta ao Caddy do DG Claw. Os comandos `dgclaw dominio`, `dgclaw dominio trocar` e `dgclaw status` respeitam o modo. O modo não combina com `--atras-de-tunel`, porque o túnel do DG Claw depende do Caddy: o instalador recusa os dois juntos (por opção ou gravados) e diz qual desligar.

**Faixa de rede própria dos agentes (`--faixa-rede`).** A nova opção `--faixa-rede <A.B.0.0/16>` (padrão 10.89.0.0/16, a de sempre) deixa escolher a faixa de IPs das redes dos agentes. Antes de mexer em qualquer coisa, o instalador confere as redes do podman e as rotas da máquina e recusa uma faixa que outro sistema já usa, dizendo qual e sugerindo outra. Com agentes já criados ele não troca a faixa em silêncio. A cerca de firewall (`lib/firewall.sh`, nas tabelas filter e mangle) e o botão de emergência seguem a faixa gravada em `DGCLAW_FAIXA_REDE`. A porta do painel também pode ser trocada numa reinstalação com `--porta-painel`: o Caddyfile que o próprio instalador gerou é regravado com a porta nova, e um Caddyfile que você personalizou continua como está.

**Aba Pedidos na Mesa: a fila de tudo o que você pediu aos agentes.** A Mesa (`/mesa`) ganha uma aba nova, a primeira e a que
abre por padrão. Cada pedido seu a um agente vira um item, na ordem em que chegou, com o estado: fazendo, esperando você (com o
motivo), entregue, feito ou cancelado. O agente abre o item antes de começar e vai movendo enquanto trabalha. Quando ele marca
"entregue", tocar no item leva você à conversa, já na mensagem da entrega, e o pedido vira "feito". Ele também vira "feito" se você
responder ao agente na conversa depois da entrega. O agente não fecha o pedido por você. A aba mostra os abertos e os fechados de
hoje e de ontem (o resto fica em "Ver arquivados") e acende uma bolinha quando há algo esperando você. Nesta versão não existe um
vigia que crie sozinho o item que o agente esqueceu, porque isso gastaria a assinatura de quem instalou. O contrato das rotas e do
comando `dgclaw-mesa pedido` está em `web/docs/PEDIDOS.md`.

### Como atualizar (proxy existente e faixa de rede)

Quem já instalou e não usa as opções novas não precisa fazer nada: o `dgclaw atualizar` continua como sempre, o DG Claw segue com o Caddy e com a faixa 10.89.0.0/16.

Se o `dgclaw atualizar` ou o `./install.sh` parar dizendo que a faixa 10.89.0.0/16 se sobrepõe a outra rede da máquina (uma rede de outro sistema no podman ou no docker, uma rota de VPN), o motivo é que outro programa passou a usar parte dessa faixa. A mensagem mostra o que está ocupado e sugere uma faixa livre. Com agentes já criados a faixa não troca sozinha, porque trocar exige recriar a rede de cada agente, e o instalador recusa em vez de fazer isso em silêncio. Você tem dois caminhos seguros. O primeiro é liberar a faixa: tire do ar ou mude a rede do outro sistema e rode a atualização de novo. O segundo é recomeçar com a faixa nova: remova cada agente com `sudo dgclaw agente remover <agente>` (a casa dele fica guardada em `/var/lib/dgclaw/aposentados/`) e rode `sudo ./install.sh --faixa-rede <faixa sugerida>`; a faixa escolhida fica gravada e vale nas próximas execuções.

Para usar o proxy que você já tem, rode `sudo ./install.sh --usuario <nome> --dominio <seu domínio> --proxy-existente` (com `--porta-painel` se a 8300 estiver ocupada) e cole no nginx ou no túnel o trecho que o instalador mostra no fim. Se a sua instalação usa `--atras-de-tunel`, essas duas opções não funcionam juntas: use `--sem-tunel` para ficar com o seu proxy, ou `--sem-proxy-existente` para voltar ao Caddy do DG Claw.

### Como atualizar (fila de pedidos)

Peça ao Admin, no chat: "atualiza o DG Claw". A aba e as rotas já vêm na atualização. Nesta versão há uma instrução nova para os
seus agentes abrirem e moverem os itens da fila. Ela entra na identidade de cada agente, regravada com
`dgclaw agente identidade <agente>`, sem apagar o que você personalizou neles. Agentes novos já nascem com ela. Os itens ficam
guardados na pasta de dados do Web, e as suas chaves, conversas e agentes continuam como estavam.

**Convide quem vai usar o seu agente por um comando, e deixe a pessoa conectar a conta de IA dela.** Três mudanças
nos colaboradores (pessoas convidadas para conversar com um agente só):

- Novo comando no servidor, `dgclaw colaborador criar <agente> <email>`, que cria o acesso e mostra o texto do convite
  pronto para copiar, com o endereço, o login e a senha temporária. Também há `listar`, `reenviar` e `revogar`. Ao criar
  um agente, o Admin passa a oferecer "Quer que eu crie um usuário e senha para essa pessoa entrar?" e entrega o convite
  na conversa, numa caixinha com o botão de copiar.
- Se o agente ainda não tem conta de IA conectada, o colaborador agora pode conectar a dele na página **Conectar conta**,
  sem depender do dono. Só uma pessoa conecta por vez, um agente que já tem conta continua só com o dono, e um login
  expirado também: o colaborador só inicia o login quando o agente confirma, na hora, que não há nenhuma credencial; com
  credencial presente, mesmo vencida e mesmo que ele a tenha conectado antes, quem reconecta é o dono, em Conectar conta. Revogar o colaborador não desconecta a conta que ele
  conectou, e o aviso aparece no comando e no log.
- A conversa do colaborador não tem mais a fileira nem o menu de troca de agentes, porque ele só enxerga o agente dele.

### Como atualizar

- Depois do `dgclaw atualizar`, reinicie o painel (`sudo systemctl restart dgclaw-web`). É o reinício que cria o canal
  local que o novo comando `dgclaw colaborador` usa para falar com o painel. Sem ele, o comando avisa que não consegue
  falar com o Web e diz o que fazer.
- Para o colaborador conseguir conectar a conta, o programa de cada agente (o runner, que vai dentro da imagem dos
  agentes) também precisa estar na versão nova. Por segurança, o painel só deixa o colaborador conectar quando o agente
  confirma, na hora, que está sem conta; um agente com versão antiga não sabe confirmar, então o colaborador recebe
  "avise o dono para atualizar" e nada é conectado. O `dgclaw atualizar` normal já cobre isso: ele reconstrói a imagem e
  recria o container de cada agente que está ligado. Só um agente que você deixou **parado** continua com a versão antiga;
  para esse, ligue-o e rode `sudo dgclaw agente recriar <agente>` (ou `dgclaw atualizar --forcar`). O convite pelo
  comando `dgclaw colaborador` não depende disso.
- Esta versão traz uma instrução nova para o Admin entender o comando de convite. Ela precisa entrar nas instruções dele
  sem apagar o que você já personalizou: peça ao Admin para juntar a seção "Convidar um colaborador" do arquivo
  `templates/ambiente/admin.md` à dele, preservando as suas alterações. Os agentes de trabalho ganham uma frase nova sobre o
  assunto do mesmo jeito (`templates/ambiente/agente.md`).

**Os agentes no ChatGPT (Codex) passam a ter as mesmas instruções dos agentes no Claude.** Até aqui o arquivo de
instruções do agente no Codex (o `AGENTS.md`) era escrito separado do `CLAUDE.md` e tinha menos conteúdo: faltavam a
lousa, o texto para copiar com botão, o quadro de avisos da equipe, a tela para fazer logins, o agendamento e os
lembretes. Agora os dois arquivos saem de uma fonte só (`scripts/gerar-instrucoes.sh`), e um teste reprova a mudança se
eles ficarem diferentes. Onde o Claude e o Codex funcionam de jeitos distintos (por exemplo, o Claude chama uma skill
por `/nome` e o Codex abre o roteiro dela pelo nome), cada um recebe o seu caminho. O `doctor` também passou a
conferir o `AGENTS.md` do agente. Agentes novos já nascem com as instruções completas. Os que já existem
mantêm o arquivo como está, porque você pode tê-lo personalizado.

### Como atualizar (instruções do Codex)

Se você tem agentes no ChatGPT (Codex) criados antes desta versão, peça ao Admin, no chat: "atualiza o DG Claw" e depois
"junta as seções que faltam no AGENTS.md dos meus agentes no Codex". Ele roda a verificação do agente com a opção de conserto (`--fix`, do `doctor`),
que acrescenta no fim do `AGENTS.md` só as seções que não existem (mesa de tarefas, quadro de avisos, lousa, texto para
copiar, tela de logins, agendamento e lembretes), guarda uma cópia do arquivo ao lado e não apaga nada do que você
personalizou. Agentes no Claude não precisam de nenhum passo.

**O agente no ChatGPT (Codex) passa a lembrar das conversas e a ler o quadro de avisos, como o do Claude.** Antes, o
Codex não executava os lembretes automáticos do DG Claw: o agente não recebia, antes de cada resposta, as memórias
e conversas relacionadas, não via o quadro de avisos da equipe e não começava a sessão já sabendo o que estava na
memória de curto prazo. Agora o DG Claw liga esses lembretes no Codex usando o recurso de hooks do próprio Codex, e
só dá confiança aos hooks que ele mesmo distribui. Um arquivo de hooks que chegue num repositório clonado pelo agente
continua sem rodar. O ajuste acontece sozinho quando o agente sobe.

### Como atualizar (hooks do Codex)

Depois de atualizar, reinicie os agentes que usam o ChatGPT (Codex) para que os lembretes passem a valer: peça ao
Admin "reinicia meus agentes no Codex". Se você mantinha um `hooks.json` seu na pasta `.codex` do agente, ele é
preservado; só as linhas do DG Claw são regravadas. Agentes no Claude não precisam de nenhum passo.

**A regra de ficar livre para conversar passa para o topo das instruções do agente.** A regra que manda o agente
responder primeiro e separar o pedido em "na hora", "curto" (subagente) e "longo" (card) já existia, mas ficava no
fim das instruções, depois do AGENT.md. Num agente com o AGENT.md muito personalizado ela ficava longe demais e o
agente prendia a conversa em tarefa longa. Agora um resumo curto dela abre as instruções de todo agente, antes do
AGENT.md, e o passo a passo completo continua no mesmo lugar.

### Como atualizar (regra no topo)

Peça ao Admin, no chat: "atualiza o DG Claw". A atualização regrava as instruções de cada agente sozinha, sem apagar
o que você personalizou no AGENT.md. Vale a partir da próxima conversa de cada agente. Quem não quiser atualizar
tudo agora pode rodar `dgclaw agente identidade <agente>` para cada agente.

**A reflexão da noite não acorda o agente em dia sem conversa com você.** Antes, às 23h30 ela rodava todo dia, e cada rodada
gastava o contexto inteiro da sessão (em agentes pouco usados, mais da metade das reflexões só dizia que nada aconteceu). Agora, se o
registro das conversas foi lido por completo e você não mandou nenhuma mensagem naquele dia, a reflexão é pulada: fica anotado no
`reflection.log` e no Pulso ("dia sem conversa com o dono; reflexão pulada"), e naquele dia não existe diário. A auditoria das 23h50 e o
`doctor` entendem o dia pulado e não dão alarme por falta de diário. Na dúvida a reflexão roda como sempre: isso vale quando o agente
usa o Codex, quando a configuração do agente é antiga e não informa o provedor, ou quando o registro das conversas não pôde ser lido. Para
rodar a reflexão mesmo assim, use `DGCLAW_REFLECT_SEMPRE=1 bash scripts/reflection.sh <config>`.

### Como atualizar (reflexão em dia sem conversa)

Peça ao Admin, no chat: "atualiza o DG Claw". A reflexão confere o provedor do agente (Claude ou Codex) na configuração dele
(`config.sh`) antes de pular um dia. Se um agente antigo não tem o provedor ali, a reflexão segue rodando todo dia, como antes. Para
ele passar a pular os dias parados, peça ao Admin `dgclaw agente reparar <nome>`, que regrava essa configuração. Se você quiser que
um agente nunca pule a reflexão, não conte com uma linha `DGCLAW_REFLECT_SEMPRE=1` acrescentada à mão no `config.sh`, porque o reparo
regrava o arquivo e a linha se perde; defina a variável no ambiente da rotina.

**O painel e a conversa passam a carregar mais rápido, sobretudo no celular.** O servidor da web agora entrega os arquivos da tela
(scripts, estilos, páginas e dados em JSON) comprimidos: o `conversa.js`, por exemplo, sai de cerca de 243 KB para uns 77 KB. A conversa
em tempo real continua chegando na hora, porque o fluxo dela fica de fora da compressão. A mudança é no site que o instalador grava no
Caddy; o `dgclaw atualizar` troca esse arquivo sozinho quando ele ainda é o que o instalador gerou, e só recarrega o Caddy depois de
conferir que a configuração nova é válida. Se algo der errado na conferência, o arquivo volta ao que era e o Caddy não é recarregado.

### Como atualizar (compressão no Caddy)

Nada a fazer se você nunca editou o arquivo do Caddy: peça ao Admin, no chat, "atualiza o DG Claw". Se você personalizou o
`/etc/caddy/Caddyfile` ou o `/etc/caddy/conf.d/dgclaw.caddy` (por exemplo, acrescentou cabeçalhos ou um segundo endereço), o DG Claw não
substitui o seu arquivo, porque ali estão as suas escolhas; ele avisa durante a atualização e a compressão fica desligada até você
acrescentar o bloco `encode` dentro do site, antes do `reverse_proxy`. O aviso traz o bloco pronto. Não use `text/*` na lista de tipos:
isso comprimiria também a conversa em tempo real e as mensagens deixariam de chegar na hora. Depois confira e recarregue com
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy`.
Nesse caso o `dgclaw dominio trocar` é a exceção: como o nome do site precisa mudar, ele guarda uma cópia do seu arquivo ao lado, em
`/etc/caddy/` (por exemplo `Caddyfile.antes-dominio-<data>`), e grava no lugar o site padrão do DG Claw com o domínio novo. O aviso mostra
o caminho da cópia; para levar suas personalizações de volta, copie as linhas que quiser para dentro do bloco do site, valide e recarregue o Caddy.

**O batimento deixa de acordar o agente várias vezes pelo mesmo assunto.** A cada 30 minutos o sistema confere a seção
"Quero Falar com o dono Sobre" da memória de trabalho. Se o agente decidia não incomodar e não tirava a linha, o batimento
voltava a acordá-lo sem parar (umas 9 vezes por dia), e cada despertar gastava uma parte grande da sua assinatura. Agora o
sistema guarda o que já levou ao agente e só o acorda de novo se o conteúdo da seção mudar ou depois de 24 horas (ajustável
com `DGCLAW_HEARTBEAT_REPETIR_H`). O agente também ganha a marca `[a partir de AAAA-MM-DD]` para adiar uma linha até a data em
que quer ser lembrado. O sorteio de 1 em 4 e o ramo da memória de trabalho velha saíram, porque não faziam mais efeito.

### Como atualizar (batimento)

Peça ao Admin, no chat: "atualiza o DG Claw". O script do batimento já vem na atualização. Nesta versão há uma instrução nova
para os seus agentes conhecerem a marca de adiar. Ela entra na identidade de cada agente, regravada com
`dgclaw agente identidade <agente>`, sem apagar o que você personalizou neles.

**A conversa abre mais rápido.** A tela pedia a lista de agentes, depois o histórico e só então ligava o tempo real, uma
coisa de cada vez. Agora o histórico sai junto com a lista de agentes. No servidor, a lista deixa de esperar a consulta
a cada agente quando as informações dela vencem: responde na hora com o que já sabe e atualiza em segundo plano (se a
atualização falhar, o motivo vai para o registro e a lista segue com o último valor bom). O `dgclaw atualizar` já resolve.

**A aba Operações volta a mostrar as barrinhas de cada rotina, com rotina, horário e resultado.** O painel do agente não
tinha permissão para ler o diário do sistema, e sem ela a aba dizia que não havia histórico, mesmo com as rotinas
rodando. Agora, dentro do contêiner, o usuário do agente passa a poder ler o diário do sistema daquele contêiner. Se o
painel ainda assim não conseguir ler o diário, a aba explica o motivo e o que fazer, em vez de mostrar contagens como
"nenhuma falha" sobre o que não foi medido. As barrinhas mostram só o resultado de cada execução, sem texto copiado de
logs. O `dgclaw atualizar` já resolve. Quem não quiser atualizar tudo agora pode rodar `dgclaw agente reparar <slug>`
para cada agente já instalado: o reparo dá o acesso e reinicia o painel dele.

**Guia de boas práticas de ronda.** Quando você pedir ao seu agente uma ronda (olhar o CRM, atender o suporte, responder
comentários, conferir dados), ele passa a seguir o novo `docs/BOAS-PRATICAS-RONDAS.md`: dez regras tiradas de erros e acertos
reais e um checklist para combinar com você o que a ronda olha, cada quanto, quem é avisado, o que ela corrige sozinha e o que
acontece se a fonte falhar.

### Como atualizar (guia de rondas)

Peça ao Admin, no chat: "atualiza o DG Claw". Nesta versão há uma instrução nova para os seus agentes conhecerem o guia. Ela
entra na identidade de cada agente, regravada com `dgclaw agente identidade <agente>`, sem apagar o que você personalizou neles.

**Manual do DG Claw no painel.** O menu ☰ ganha o item **Manual**, uma tela (`/manual`) que mostra, página por página, o que o DG Claw faz e como se usa, com busca pelos títulos e uma visita guiada. O Admin lê o mesmo manual direto da pasta `docs/manual` e os agentes o consultam pelo painel antes de dizer que algo não existe. O contrato das rotas está em `web/docs/MANUAL.md`.

### Como atualizar (manual e personalização no nível do sistema)

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** Esta versão traz uma instrução nova para o Admin e para os agentes saberem que o manual existe e onde consultá-lo. Ela entra na seção de ambiente que o DG Claw mantém para cada agente, sem apagar o que você personalizou nas instruções deles. Se algum agente antigo não a mostrar depois da atualização, peça ao Admin para regravar essa seção com `sudo dgclaw agente identidade <nome>`.
2. **Regra nova para o Admin.** Pedidos no nível do sistema (nova forma de gerar agentes, mudança no `bin/dgclaw`, no instalador ou no `runner/`) passam a ser permitidos. O Admin avisa você, em linguagem simples, que aquilo mexe na base e pode dar problema nas próximas atualizações; se você mantiver o pedido, ele faz, anota em `PERSONALIZACOES.md` que a mudança mexe na base e tenta mantê-la funcionando a cada atualização. Cofre e segredos, firewall, autenticação do painel, isolamento dos containers e ganchos de segurança continuam fora, mesmo a pedido. O guia está em `docs/PERSONALIZAR.md`.

**Trocar de página no painel do agente deixou de mostrar o layout antigo.** Ao abrir uma página do painel (Status,
Memória, Sessões e as outras), aparecia por um instante o menu antigo, com a foto padrão, traços "--" e a frase
"carregando a conversa", e o conteúdo ficava cortado à direita até a tela terminar de montar. Agora o painel abre
escondido, mostra só um indicador cinza no meio da área de conteúdo, e o cabeçalho e o menu verdadeiros aparecem assim
que a página chega. O conteúdo passou a usar a largura toda ao lado do menu, sem sobra em monitor largo. Os arquivos
de estilo e de script do painel agora ficam guardados no navegador, então trocar de página é mais rápido. Se a tela
demorar mais de 8 segundos ou falhar ao abrir, ela deixa de ficar presa e diz o que aconteceu e o que fazer.

### Como atualizar (troca de páginas do painel)

Basta atualizar o DG Claw e recarregar a página do painel (no celular, feche e abra de novo, ou use Ctrl+F5 no
computador). Nada precisa ser configurado nem apagado: as suas chaves, conversas e agentes continuam como estavam.

**O aviso "Faça o login nos seus agentes" agora aparece uma única vez.** Antes, ele voltava a cada aba nova e a cada
visita ao painel enquanto algum agente estivesse sem login. Agora o painel guarda, no servidor, que você já viu o aviso:
fechar com **Fazer depois** ou recarregar a página não o traz de volta, e o novo botão **Não mostrar mais** o desliga de
vez. Se você criar um agente novo e ele ficar sem login, o aviso aparece mais uma vez, só para ele (a não ser que você
tenha escolhido **Não mostrar mais**). Em qualquer caso, a página **Conectar conta** e o cartão de cada agente continuam
disponíveis. A escolha fica em `modal-login.json`, na pasta de dados do painel, e uma atualização não a apaga.

**Login expirado também avisa no agente do ChatGPT.** Quando o login da conta do ChatGPT de um agente vence, o agente
passa a mostrar o aviso "O login da conta do ChatGPT expirou", com o que fazer (reconectar pelo cartão de login da conversa
ou rodar `codex login --device-auth` no terminal do agente), em vez de ficar parado sem explicação. Depois do novo login, o
agente volta sozinho, na mesma conversa. Isso já funcionava para o agente do Claude. Nada precisa ser feito para atualizar.
**O painel do Admin mostra de novo o histórico e as respostas quando o Admin usa o ChatGPT (Codex).** Antes, nesse caso a conversa do Admin ficava vazia na tela, porque o Web não procurava o registro da conversa na pasta onde o Codex do Admin o grava. Depois de atualizar, o histórico e as respostas aparecem.
**Endurecimento do Web, do painel e do cofre.**

- O proxy de `/p/<agente>/` deixa de repassar ao navegador os cabeçalhos `Set-Cookie` vindos do painel do agente,
  tanto nas respostas HTTP quanto na abertura do WebSocket. O painel continua autenticado pelo proxy e funciona igual.
- O upload de anexos cria `uploads/<dia>/` e grava o arquivo sem seguir atalho em nenhuma pasta do caminho, com o
  dono da casa do agente. Se `uploads` ou a pasta do dia forem um atalho, o upload é recusado com a explicação.
  A criação de pastas da caixa do agente passa pelo mesmo gravador.
- A rota de mídia serve, da pasta de dados do Web, só as subpastas `avatares` e `miniaturas`.
- A unidade `dgclaw-web.service` ganha proteções do systemd compatíveis com o que o Web executa hoje (`/usr`,
  `/boot` e `/etc` somente leitura, exceto `/etc/dgclaw`; `/tmp` próprio; restrições de módulos, logs do kernel,
  SUID, tempo real e arquitetura). As que ficaram de fora estão comentadas na unidade com o motivo.
- O cofre do painel (motor `local`) só gera a chave mestra quando o arquivo não existe, e cria o arquivo sem
  sobrescrever. Se a chave existir mas não puder ser lida ou estiver com tamanho errado, o cofre para com erro que
  diz o caminho e o motivo, em vez de gerar outra chave.
- O painel valida `trust_level` como número e escapa os valores vindos do servidor e da memória do agente que
  eram inseridos no HTML sem escape.
- A ponte do WhatsApp atualiza `follow-redirects` para 1.16.2.
**Anonimizar documentos.** Nova tela **Anonimizar** (no menu ☰, em `/anonimizar`). Ligando a opção para um agente, os
documentos que você manda pelo clipe da conversa passam antes por um filtro que troca nomes, CPF, telefone, e-mail e outros
dados pessoais por marcadores, como `[PESSOA_1]` e `[CPF_1]`. O agente e o modelo na nuvem só recebem a versão com marcadores,
e o original e o nome original do arquivo não entram na pasta dele. A tabela que liga cada marcador ao dado real fica cifrada
no servidor. Na conversa, as respostas do agente com marcadores ganham o botão "Ver com dados reais", os arquivos que ele
devolve ganham "Baixar versão final" (com os dados reais no lugar dos marcadores), e um selo no alto leva de volta à tela.
Por enquanto vale só para o clipe da conversa web: o que chega por WhatsApp, Telegram ou e-mail ainda não passa pelo filtro.
O guia está em `docs/ANONIMIZAR.md`.

### Como atualizar (anonimizar documentos)

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** A atualização grava a unidade que instala o detector de nomes e traz a
   tela nova. Nada é instalado nem ligado sozinho: a anonimização começa desligada em todos os agentes.
2. **O detector de nomes é opcional e se instala pela tela Anonimizar.** Sem ele, o filtro só troca o que tem formato fixo (CPF,
   CNPJ, telefone, e-mail) e, por segurança, bloqueia o envio de documentos até você escolher outra opção. Os leitores de PDF,
   Word e Excel ocupam cerca de 30 MB; o detector completo, que acha nomes, empresas e endereços, ocupa cerca de 2 GB de
   disco e precisa de uns 2,5 GB de memória livre na hora de rodar.
3. **As instruções dos agentes ganharam um trecho novo**, para eles tratarem os marcadores do jeito certo (manter exatamente
   como vieram, nunca adivinhar o dado real e entregar resultados em `.docx`, `.xlsx`, `.md` ou `.txt`). Depois de atualizar,
   peça ao Admin para regravar a identidade de cada agente que você já tem (o comando é `sudo dgclaw agente identidade <agente>`);
   o que você personalizou neles não muda.
4. **Guarde a chave da tabela no seu backup.** Ela é criada sozinha no primeiro uso, em `/etc/dgclaw/anonimizar.chave`. Sem ela
   a tabela não abre e os dados reais não voltam.
5. No celular, feche e abra o app uma vez para ele buscar os arquivos novos.
**A Tela do agente (o navegador dele, onde você faz os logins) ficou sempre à mão e passou a explicar o que falta.**
Alunos relataram que não tinham tela nenhuma. Havia quatro causas, e as quatro foram tratadas:

- *Atalho na conversa.* O menu de cada agente ganhou o item **Tela (navegador do agente)**. Ele abre o painel do agente
  já na aba Tela, onde você digita e clica direto no navegador dele para fazer o login dos sistemas. O Admin não tem o
  item, porque não tem navegador.
- *Senha que nunca falta.* Se a senha da Tela ainda não foi definida, a aba abre direto em "Defina a senha da tela"
  (de 6 a 8 caracteres), com a explicação do porquê, e a tela abre sozinha depois de gravar. Antes, a aba abria um
  navegador que não conectava. O `dgclaw agente recriar`, o `reparar` e o `atualizar` não inventam senha: avisam, numa
  linha por agente, que ela falta e como definir.
- *Diagnóstico que se explica.* A aba Tela mostra o que está errado em linguagem simples (sem navegador na imagem,
  senha não definida, tela parada, navegador sem resposta) e o que fazer. Quem administra o servidor tem o mesmo
  em `dgclaw agente tela <slug>`, que sai com código diferente de zero quando algo falta.
- *Servidor arm64.* Antes, a construção da imagem parava com erro nessa arquitetura, porque o Google Chrome só existe
  para amd64, e quem instalava ficava sem imagem. Agora a imagem sai, e a Tela usa o Chromium. Para você é a mesma
  tela; alguns sites com proteção contra robôs podem tratá-lo de outro jeito que o Chrome.

O teclado também foi ajustado: letras com acento e o `ç` digitados direto na Tela devem chegar certos, e a Tela
reconecta sozinha depois de uma troca de senha. Nada do que protegia a Tela mudou: ela continua só em `localhost`
dentro do agente, atrás do login do painel e da senha própria dela, e agora há um teste que falha se uma dessas
travas sumir.

### Como atualizar (a Tela do agente)

Peça ao Admin, no chat: "atualiza o DG Claw". Ele confirma com você e instala; agentes, conversas e configurações
ficam como estão. Se algum dos seus agentes foi criado antes da Tela existir, ele ainda não tem a senha dela, e sem
ela a Tela não conecta. Defina a senha uma vez, na aba Tela do painel desse agente (menu do agente, item Tela): é a
segunda trava, além do login do painel, e o DG Claw não inventa uma por você porque ninguém saberia qual é. O resumo
da atualização lista os agentes que ainda precisam disso. Servidor arm64 precisa reconstruir a imagem uma vez
(o Admin faz isso na atualização).
**Convidar um colaborador.** Agora você pode convidar uma pessoa para conversar com um dos seus agentes de trabalho, sem dar acesso ao resto do DG Claw. No menu ☰ do agente há o item **Convidar colaborador** (ou a página `/colaboradores`): você informa o e-mail da pessoa, e ela recebe o link, o login e uma senha temporária que vale por 7 dias. No primeiro acesso ela cria a própria senha e passa a usar aquele agente: a conversa e a leitura das sessões, das rotinas, da memória e dos arquivos. Ela não grava memória, arquivos nem configuração pelo painel, e o login da conta de IA do agente também fica só com você. Ela não sai desse agente: o Admin, os outros agentes e as telas da caixa inteira (chaves de API do sistema, convidar colaborador, configurações globais) continuam só seus. Dentro do agente, o cofre, as chaves de API do painel, o login da conta de IA, as credenciais dos canais e a Tela também ficam com você. Você manda o convite de novo ou revoga o acesso quando quiser, e a lista guarda o histórico com as datas. As mensagens dele chegam ao agente marcadas como vindas de um colaborador. O envio do convite por e-mail é opcional: sem configurar nada, a tela mostra o texto pronto para você copiar e mandar por WhatsApp. Para o DG Claw mandar o e-mail sozinho, veja as variáveis `DGCLAW_SMTP_*` em `web/docs/COLABORADORES.md`. Nada precisa ser feito para atualizar.

**Anexos na casa do agente.** Os arquivos enviados pela conversa agora são gravados pelo dono do agente, e não mais pelo root do servidor, para que uma pasta trocada por um atalho dentro da casa do agente não leve o arquivo para fora dela. Em instalações antigas, a pasta `uploads/` que o root tinha criado passa sozinha para o dono do agente no primeiro anexo; as pastas de dias antigos ficam como estão. Nada precisa ser feito para atualizar.

**Nova página Conectar conta.** Antes, para conectar a conta do Claude de um agente alguém tinha de gerar um link de login
e mandar por mensagem, e o link vencia antes de você ver. Agora o painel tem a página **Conectar conta** (no menu ☰, ou em
`/conectar`): você entra quando puder, toca em "Gerar link de login" no cartão do agente, entra na sua conta do Claude e cola
o código que aparece no fim. Há um cartão para o Admin e um para cada agente de trabalho, cada um com um selo que mostra se
a conta está conectada, se falta conectar ou se o login expirou. Quem usa chave de API aparece como tal, sem botão. O aviso
"Seu login do Claude expirou" também ganhou um atalho discreto para essa página. Os cartões agora se chamam Agente admin, Agente principal e Agente de trabalho, e, quando tudo está conectado, a página mostra
um passo a passo curto (endereço do painel, usuário para entrar e o que você vai ver) com um vídeo de menos de 1 minuto.
Nada precisa ser feito para atualizar.

**Modal de login ao abrir o painel.** Se algum dos seus agentes estiver sem login (ou com o login vencido), ao abrir a
conversa aparece sozinho o aviso "Faça o login nos seus agentes", com um cartão para cada agente: o Admin, o agente principal e os demais.
Você gera o link, entra na sua conta, cola o código e pronto, sem precisar achar a página Conectar conta. Quando todos
conectam, o aviso mostra "Login efetuado" (nos dois agentes, no seu agente ou nos seus N agentes), o que fazer agora e o vídeo
curto "Conhecendo o DG Claw". "Fazer depois" fecha o aviso e ele não volta naquela aba. Quando esse aviso abre, ele toma o lugar do
pop-up "Seu login do Claude expirou". A página Conectar conta continua no menu como plano B. Os cartões também passaram a
mostrar com qual IA o agente vai entrar; por enquanto é a IA em que ele já foi criado, e trocar de IA ainda não está disponível.
Nada precisa ser feito para atualizar.

**Comando para entregar um DG Claw instalado por outra pessoa.** Quando a equipe instala o DG Claw na VPS de alguém e
quer entregar pronto, o comando `sudo dgclaw instalacao-remota` troca a senha do painel por uma senha forte nova, reinicia o
painel e mostra uma única vez a mensagem pronta com o endereço, o usuário e a senha. A senha não fica guardada em lugar
nenhum, só o hash. É opcional e não muda a instalação normal. Nada precisa ser feito para atualizar.

**Trocar a senha do painel agora desconecta todo mundo.** Antes, quem já estava logado continuava dentro depois da
troca de senha (`dgclaw senha trocar`), inclusive uma sessão copiada por outra pessoa. Agora cada sessão guarda uma
marca da senha e do usuário de quando foi aberta, e mudar qualquer um dos dois derruba as sessões abertas antes.

### Como atualizar (sessão amarrada à senha)

Depois desta atualização, todo mundo precisa entrar no painel de novo uma vez, porque as sessões abertas até agora
não guardavam a marca da senha. Basta digitar usuário e senha como de costume; nada mais muda.

**A ronda de segurança deixou de pesar na memória.** Em servidores pequenos, de 4 GB, a verificação de segurança podia
passar de 1 GB de memória e fazer o sistema derrubar os seus agentes. Agora ela lê uma falha por vez e guarda só o
que importa, então o pico fica abaixo de 100 MB nos testes. Servidores de até 4,5 GB rodam a ronda no modo econômico, uma
vez por dia às 04:00 (se você tiver definido os seus horários, eles valem). Se mesmo assim a ronda passar do limite de
memória, ela termina avisando que ficou parcial e o motivo, e o sistema, se precisar encerrar alguém, encerra a ronda
e nunca um agente. Nada muda no que você vê na tela Segurança, só ganha um aviso de "parcial" quando for o caso.

### Como atualizar (ronda leve)

Peça ao Admin, no chat: "atualiza o DG Claw". Ele confirma com você e instala; agentes, conversas e configurações
ficam como estão. Em servidor pequeno, o horário da ronda passa para as 04:00 a não ser que você já tenha escolhido o seu.

**Um aviso de segurança só, no lugar da pilha de janelas.** Antes, cada falha crítica da ronda e cada boletim
abria a própria janela, e quem tinha várias precisava fechar uma por uma, todo dia. Agora aparece uma janela só,
"Seu ambiente está em risco", que conta quantos pontos de segurança pedem a sua atenção, mostra os mais graves e
tem o botão "Ver na Segurança". Fechar uma vez fecha tudo. Ela só volta sozinha se aparecer um problema novo, se
algum ficar mais grave ou depois de 24 horas, no máximo uma vez por dia. Enquanto houver pendência, um selo
discreto no alto da tela leva à Segurança. Nenhum aviso sumiu: cada falha continua na tela Segurança com os fatos e
os botões de antes, e os boletins ganharam uma seção própria lá, "Avisos de segurança do DG Claw", com Atualizar,
Lembrar depois e Entendi. Ideia de um aluno.

### Como atualizar este aviso

Peça ao Admin, no chat: "atualiza o DG Claw". Ele confirma com você e instala; agentes, conversas e configurações
ficam como estão. Depois, no celular, feche o painel e abra de novo para o navegador baixar a tela nova. Na
primeira visita a janela nova aparece uma vez; feche e ela só volta pelos motivos acima.

**Tela Segurança e botão de emergência.** O menu ganhou a tela Segurança: o horário da última ronda, o que foi
aplicado sozinho (com o botão Desfazer), as falhas críticas que pedem a sua decisão (aplicar, agendar ou tirar do
ar) e as de impacto leve, com a correção pronta esperando o seu ok. Falha crítica abre uma janela vermelha que volta
a cada visita até você decidir. O botão de emergência tira o sistema da internet e mantém só o seu acesso pelo
Tailscale; pede um código de uso único e a frase de confirmação, e religa sozinho em 5 minutos se ninguém confirmar.
No terminal: `sudo dgclaw emergencia simular`. Detalhes em `docs/EMERGENCIA.md`.

**Aviso de segurança no painel.** Quando a equipe publica um boletim sobre uma falha de segurança numa das
ferramentas que o DG Claw usa, o servidor percebe sozinho (uma leitura pública do GitHub a cada hora) e o painel
mostra uma janela "Aviso de segurança", com a fonte oficial e o que muda, e um selo discreto que fica no alto das
telas até o assunto se resolver. O botão Atualizar leva ao chat do Admin com o pedido já escrito; você só envia.
Nada é instalado sem o seu sim, e ao atualizar o aviso some sozinho. Para desligar, ponha
`DGCLAW_BOLETINS_SEGURANCA=0` no `dgclaw.env`. Detalhes em `docs/BOLETINS-DE-SEGURANCA.md`.

**Ronda de segurança de fábrica.** Todo DG Claw instalado passa a ter uma ronda que, três vezes ao dia (07:00,
13:00 e 19:00, no horário do servidor), procura falhas de segurança que afetam aquela instalação: os pacotes do
servidor, o kernel que está rodando, o que escuta na rede, os pacotes do DG Claw e os serviços que você conectou
(Notion, Slack, Google Drive e outros). Quem não usa o Notion não recebe aviso sobre o Notion. As falhas aparecem
em três níveis: o que a ronda corrigiu sozinha, o que precisa da sua decisão e o que dá para corrigir sem
pressa. Só quando há uma falha nova o Admin é avisado e conta a você no chat; nos outros dias ninguém fala nada.
Se alguma fonte de consulta ficar fora do ar, a ronda diz que ficou parcial, e nunca finge que está tudo limpo.
Para desligar, ponha `DGCLAW_RONDA_SEGURANCA=0` no `dgclaw.env`. Detalhes em `docs/RONDA-DE-SEGURANCA.md`.

Duas correções da imagem dos agentes. A Tela não derruba mais a aba nova: o Chrome da Tela passava do limite
de processos que o sistema dá a cada serviço e a segunda aba abria em branco ou quebrava. E o Pillow, a
biblioteca de imagens do Python que vem na imagem, subiu para a 13.0.0, que fecha cinco falhas críticas de
segurança da versão anterior. As duas valem depois de atualizar, quando a imagem é reconstruída.

Duas ideias trazidas do Orca (https://github.com/stablyai/orca, licença MIT; crédito no `NOTICE`): o
medidor de uso da assinatura e o aviso de que um agente precisa de você.

Agora dá para responder pelo chat a pergunta de escolha que o agente faz (aquela com opções para marcar): a
pergunta aparece num cartão acima da caixa de mensagem, com as opções, um campo para outra resposta e o botão de
cancelar. A mensagem digitada enquanto ele espera essa resposta não fica mais presa em silêncio: a tela avisa, mantém o seu texto na
caixa e manda você responder a pergunta primeiro. A aprovação de um comando também não pode mais ser confundida
com a resposta da pergunta: se você responder pelo terminal no meio, o resto da resposta é interrompido em vez de
aprovar sem querer o comando que surgiu em seguida, e o botão Aprovar de uma tela desatualizada é recusado.

### Como atualizar

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** A atualização reconstrói a imagem e recria os
   agentes, e é isso que liga o medidor: a medição sai do runner (o processo que mantém cada agente vivo)
   e do hook novo que ele grava a cada subida. Agente que você deixou parado continua com o runner
   antigo e mostra "sem dado" até ser ligado de novo.
2. **Espere uma resposta de cada agente.** O número do uso só aparece depois da primeira resposta
   desde a atualização, porque é o próprio Claude Code (ou o Codex) que informa o quanto já foi gasto
   ao responder. Até lá, o Status mostra "sem dado", e isso é esperado, não erro.
3. **Regrave a identidade dos agentes que você já tem**, com `sudo dgclaw agente identidade <agente>`
   para cada um. Nesta versão eles aprendem que você vê o uso da assinatura no Status e que um agente
   pode consultar o próprio uso. O comando não mexe no `CLAUDE.md`, no `AGENT.md` nem na memória que
   você personalizou.
4. **Se você personalizou o `CLAUDE.md` ou o `AGENTS.md` do Admin,** leve do `.novo` para o seu
   arquivo as duas linhas sobre "uso da assinatura" e "estado de cada agente", sem apagar o que você
   escreveu. Sem elas o Admin não sabe onde fica o medidor quando você perguntar.
5. **Para receber os avisos no celular,** ative "Avisos neste aparelho" na tela de Lembretes, se
   ainda não ativou. No iPhone, o aviso só chega com o DG Claw instalado na tela de início. Se o app
   instalado abrir com aviso de erro, feche e abra de novo para ele buscar os arquivos novos.
6. **Para ter a ronda de segurança, clique em Instalar na faixa de nova versão do painel ou peça ao Admin:
   "atualiza o DG Claw".** Depois de atualizar, a ronda faz a primeira rodada sozinha e passa a varrer o
   servidor três vezes ao dia, sem você configurar nada. Quando aparecer uma falha nova que afeta o seu
   servidor, o Admin avisa no chat e o painel mostra o que fazer. Nesta versão a lista de correções que a
   ronda pode aplicar sozinha começa vazia, então nada é mexido sem o seu sim. Se mais tarde ela passar a
   corrigir algo sozinha, ela conta o que fez e você desfaz com um pedido ao Admin.

### Adicionado

- **Caixa de cofre na conversa.** Quando o agente precisa de uma senha ou chave de um serviço (OpenAI,
  Hostinger, Groq...), ele mostra na própria conversa um cartão com um campo de senha, e o valor vai
  direto para o cofre dele, sem passar pela conversa. O cartão ficou mais completo: avisa "Já tem uma
  guardada (final 9z8y)" quando a chave já existe (também depois de recarregar a página), tem botão
  para mostrar o que você colou, cabe em tela de celular e explica que salvar reinicia o agente para a
  chave valer, e que a conversa continua de onde parou. O agente recebe, entregue pelo servidor, só o nome e o final da chave
  (`[cofre] NOME guardada (final 1a2b).`), e a mensagem aparece com a etiqueta "do cofre". Os visuais da
  lousa ganharam a peça `dv-cofre`, que abre o mesmo cartão quando a chave faz parte de um passo a
  passo. Na aba Cofre, a seção das chaves que deixam outro programa usar a API passou a se chamar
  "Chaves de acesso à API" e diz que não é ali que se guarda senha de serviço, com um atalho para o
  formulário "Guardar uma chave". O tutorial da conversa ganhou um passo sobre a caixa de cofre.
  Documento em `docs/COFRE-NA-CONVERSA.md` (também em `GET /api/v1/cofre/docs.md`).
- **Uso da assinatura.** O Status de cada agente ganhou o cartão "Uso da assinatura", com quanto já foi
  gasto da janela de 5 horas e do limite semanal, a hora em que cada um zera e há quanto tempo foi
  medido. O menu ☰ ganhou "Uso das assinaturas", com todos os agentes juntos. No Claude, o número vem
  da linha de status do próprio Claude Code a cada resposta; no Codex, do registro da sessão. O que não
  foi medido aparece como "sem dado", nunca como zero. Janela que já zerou mostra a hora em que zerou,
  e não o percentual antigo. Pela API: `GET /api/v1/uso` (o agente que pergunta pela caixa recebe só o
  dele), `GET /api/uso` no painel do agente e `GET /api/agents/<id>/uso` no runner. Documento em
  `web/docs/USO-DA-ASSINATURA.md`.
- **"Precisa de você".** O menu ☰ e a fileira de avatares do celular mostram o estado de cada agente:
  trabalhando (pontinhos), terminou com resposta não lida (a bolinha de sempre) ou precisa de você
  (selo âmbar com "!"), quando ele pede permissão para usar uma ferramenta, faz uma pergunta de
  escolha ou perde o login. Pela API: `GET /api/v1/estados`. Documento em
  `web/docs/ESTADO-DOS-AGENTES.md`.
- **Aviso no celular** quando um agente precisa de você ou termina uma resposta. O aviso não sai
  quando você já está olhando aquela conversa, e sai no máximo um por agente a cada minuto. O aviso de
  "terminou" diz só "Respondeu na conversa", sem nada do texto, porque a tela bloqueada do celular não
  pede senha. Os dois
  tipos se ligam e desligam na tela de Lembretes. O aviso não aprova nada: para aprovar uma permissão
  é preciso abrir a conversa.
- **Marcar como não lida.** No menu ☰ (botão ⋯ ou toque longo no agente) e no cabeçalho da conversa.
  A marca fica até você abrir a conversa de novo; rolar a tela não a apaga.

- A voz agora lê a resposta inteira, não só o começo. O texto é limpo (tabela, código e link não viram
  fala), fatiado por parágrafo e frase, e a tela toca os pedaços em sequência, já preparando o próximo
  enquanto o atual toca. Parar de falar ou gravar um áudio novo interrompe a leitura toda. O aviso de
  "resposta cortada" saiu, e um texto de mais de 40 pedaços é recusado com o motivo.
- Com o modo de ouvir ligado, a mensagem segue ao agente com `voz="1"` no envelope, e ele responde curto, em
  frases faladas, sem tabela nem URL. O campo `voz: true` também vale para quem usa o `/send` por API.
- Cada fala do agente ganha um botão 🎧 (só com o modo de ouvir ligado) para ouvir de novo, sem reabrir o
  microfone.

- Fila de leitura em voz. Uma resposta nova do agente não derruba mais a que você está ouvindo: ela entra no
  fim da fila e toca depois, uma por vez. Enquanto você grava, nada toca; a que estava tocando pausa e, quando
  você envia ou cancela a gravação, ela continua (do começo, se tinha tocado menos de 20%, senão de onde
  parou), seguida das que chegaram nesse meio tempo. Cada balão mostra se está tocando agora ou na fila. Para
  pular, toque no 🎧 do balão que quer ouvir: ele toca e segue dali. Só as respostas normais do agente entram
  na fila sozinhas; as mensagens de rotina só tocam se você apertar o 🎧 delas.

### Como atualizar (voz)

Nesta versão há uma instrução nova para o seu agente saber quando você está ouvindo a resposta, e ela
precisa entrar nas instruções dele sem apagar o que você personalizou. Para isso, rode
`sudo dgclaw agente identidade <agente>` para cada agente que você já tem. No celular, feche e abra o app
uma vez para ele buscar os arquivos novos.

### Como atualizar (fila de voz)

Não há nada para rodar: é só a tela. No celular, feche e abra o app uma vez para ele buscar os arquivos novos
(ou recarregue a página no computador). Quem ainda não atualizou a parte de voz acima precisa fazer aquele
passo primeiro.

### Como atualizar (caixa de cofre)

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** Isso traz a tela nova. Se o painel ainda mostrar o
   cartão antigo, reinicie-o de fora do chat com `sudo systemctl restart dgclaw-web`. No celular, feche e
   abra o app uma vez para ele buscar os arquivos novos.
2. **Para os agentes que você já tem**, rode `sudo dgclaw agente identidade <agente>` para cada um. Assim
   eles aprendem o aviso novo (`[cofre] NOME guardada (final 1a2b).`) e a peça `dv-cofre`, sem apagar o
   que você personalizou.

### Como atualizar (seu agente sempre livre para conversar)

Nesta versão os agentes ganham uma regra nova: trabalho demorado (montar uma apresentação, um site,
um relatório, uma pesquisa grande) vai para um card na aba Sessões, e o agente avisa você na conversa
quando terminar. Tarefa de poucos minutos ele passa para um ajudante em segundo plano. Assim ele
continua respondendo você enquanto trabalha.

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** A atualização recria os agentes, e é nesse passo
   que a regra entra nas instruções de cada um, inclusive dos que você já tem. Nada do que você
   personalizou (`AGENT.md`, `CLAUDE.md`, memória) é tocado.
2. **Agente que estava desligado** só recebe a regra quando for ligado de novo. Se quiser aplicar sem
   esperar, rode `sudo dgclaw agente identidade <agente>`.

### Corrigido

- **O primeiro pedido de um card ficava parado na caixa de entrada.** A sessão do card nasce em modo
  `auto`, e na primeira vez o Claude Code mostrava um aviso sobre esse modo na frente da caixa. O texto
  do pedido ficava escrito ali, sem ninguém processar, até alguém dar Enter à mão (7 minutos, na aula de
  27/10). Agora o aviso já vem marcado como visto. Se ele aparecer mesmo assim, o agente não digita o
  pedido e o log diz o que fazer.
- **Reiniciar o Admin levava 90 segundos e derrubava o vigia do container do agente.** O container
  criado pelo Admin ficava pendurado no serviço dele, e cada reinício (inclusive o automático das
  atualizações de segurança do Ubuntu) esperava 90 segundos e encerrava à força o processo que cuida do
  container. Agora cada container sobe separado do serviço de quem o ligou.
- **Erros vermelhos falsos no log logo depois de instalar.** O painel subia antes de existir a lista de
  agentes e registrava três erros, que sumiam sozinhos. Agora ele só liga depois que a lista existe.
- **Avisos que não eram problema.** "Digitei 3 Enters e nenhum abriu turno" aparecia no `/compact`
  automático; "não achei o registro da sessão" aparecia
  para conversa recém-criada; e "agente fora do ar" se repetia a cada 30 segundos enquanto o agente só
  esperava o login. Os três agora só aparecem quando há algo de errado de verdade, e uma vez por estado.

- A foto do agente cadastrada por endereço (`https://...`) aparecia pela metade no iPhone, com o verde do
  avatar por baixo. A mesma foto de fora era pedida várias vezes por página. Agora o painel baixa a foto
  uma vez, guarda em `/var/lib/dgclaw/web/avatares/` e entrega do próprio endereço do painel
  (`/api/v1/agents/<agente>/avatar`), inteira e com cache de um ano. O cache se renova sozinho quando você
  troca o endereço da foto no cadastro. Enquanto a foto carrega, o círculo fica cinza claro em vez da cor
  do agente. Foto de SVG não é aceita (PNG, JPEG, WebP, GIF e AVIF até 5 MB); se o download falhar, a
  resposta e o log dizem o motivo.

### Alterado

- As sessões paralelas do agente (as do descritor e as criadas por `POST /api/sessoes`, inclusive a de
  bastidores) agora sobem sempre em modo `auto`, em vez de herdar o `bypassPermissions` da principal. O
  agente principal continua em `bypassPermissions`, que é obrigatório. Os pedidos de permissão das outras
  sessões aparecem na tela pelo cartão de permissão.
- Dependências atualizadas: pino 10 no canal do WhatsApp, express-rate-limit 8 no painel,
  TypeScript 7 no runner e as GitHub Actions do CI (checkout, setup-node e setup-python 7,
  upload-artifact 7, sbom-action 0.24.3).
- O Dependabot passa a abrir no máximo um PR por pasta por semana (toda segunda), juntando as
  versões minor e patch; as GitHub Actions vêm todas num PR só. As versões major continuam
  separadas, com no máximo três PRs abertos por pasta. A versão major do Express fica de fora: o
  Express 5 muda o roteamento e quebrou o CI do painel, e a migração vai ser uma tarefa própria.

### Como atualizar

Nada a configurar: atualize como de costume (`sudo dgclaw atualizar` ou peça ao Admin). Depois, no
celular, feche e abra o app uma vez para ele buscar os arquivos novos. A primeira vez que cada foto for
pedida demora um instante a mais, porque é quando o painel a baixa; as seguintes vêm na hora. Fotos que
você enviou pelo formulário de criar agente já saíam do painel e não mudam.

## [1.0.0] - 2026-10-19

A v1 troca o plugin do Claude Code por uma plataforma completa: um instalador, um painel web com
chat e agentes que rodam isolados em containers. É a primeira versão publicada com tag, e traz também a
versão instalada à vista (`dgclaw versao`), backup e restauração (`dgclaw backup` e `dgclaw restaurar`),
atualização que volta sozinha quando algo dá errado, aviso de versão nova e personalizações que
sobrevivem à atualização.

### Como atualizar

Para quem já tem o DG Claw instalado, na ordem:

1. **Peça ao Admin, no chat: "atualiza o DG Claw".** Ele faz a simulação, conta em palavras simples o
   que muda e só instala depois do seu ok. Pelo terminal, o caminho é `sudo dgclaw atualizar --simular`
   e, depois de ler o relatório, `sudo dgclaw atualizar --ok-do-dono --segundo-plano`. Se o seu DG Claw é
   anterior a esta versão (instalado até 19/10/2026), o comando que você tem ainda não conhece o
   `--ok-do-dono`: rode só `sudo dgclaw atualizar --segundo-plano`. A partir desta versão, toda
   atualização passa pelo seu ok.
2. **Reinicie os agentes.** O aviso de login expirado depende de uma mudança no runner (o processo que
   mantém cada agente vivo) e de um hook novo que ele grava a cada subida. Um agente com o runner antigo
   continua mudo quando o login do Claude morre. Reinicie cada um com
   `sudo dgclaw agente reiniciar <agente>` ou pelo botão "Reiniciar sessão" da conversa; a conversa
   continua de onde estava.
3. **Regrave a identidade dos agentes que você já tem.** Nesta versão eles aprendem a lidar com a
   mensagem falada que chega marcada como `[áudio transcrito]` (ela pode ter erro de transcrição). A
   instrução fica na parte que o próprio DG Claw mantém, e a atualização não regrava essa parte sozinha.
   Rode `sudo dgclaw agente identidade <agente>` para cada um. O comando não mexe no `CLAUDE.md`, no
   `AGENT.md` nem na memória que você personalizou; só refaz o texto de plataforma. Agentes criados
   depois desta versão já nascem com a instrução, e o Admin recebe a dele na reinstalação.
4. **Recarregue o app no celular.** A conversa ganhou arquivos novos; o app instalado busca a versão
   nova sozinho, mas se a conversa abrir com aviso de erro, feche e abra o app de novo.
5. **Se você personalizou o `CLAUDE.md` ou o `AGENTS.md` do Admin,** a atualização não troca o seu
   arquivo e grava o modelo novo ao lado, como `.novo`. Leve para o seu arquivo duas seções do `.novo`,
   sem apagar o que você escreveu: "Personalizar o programa do DG Claw" e o parágrafo do ok do dono na
   seção "Atualizar o DG Claw". Sem elas o Admin não segue o registro de personalizações nem pede o seu
   ok antes de atualizar.
6. **Se alguém mudou o programa direto em `/opt/dgclaw/app`,** nada se perde: antes de copiar o
   programa novo, o instalador guarda tudo o que foi mudado em
   `/opt/dgclaw/admin/personalizacoes-migracao/<data>/` e deixa um levantamento pendente. Depois de
   atualizar, o Admin roda `sudo dgclaw personalizacoes levantar`, conta a você o que achou, confirma
   cada mudança, reaplica na branch `personalizacoes`, registra em `/opt/dgclaw/admin/PERSONALIZACOES.md`
   e fecha com `sudo dgclaw personalizacoes concluir`. O passo a passo está no capítulo "Quem já tinha o
   DG Claw antes desta versão" do `docs/PERSONALIZAR.md`.

### Adicionado

- Versão instalada: o arquivo `VERSION` (1.0.0) é a fonte única, o instalador grava `DGCLAW_VERSAO` e
  `DGCLAW_COMMIT` no `dgclaw.env`, `dgclaw status` mostra `DG Claw 1.0.0 (commit ...)` na primeira linha e
  `dgclaw versao` (ou `--version`) imprime só isso. Um teste reprova se `VERSION`, `panel/package.json` e
  `runner/package.json` divergirem.
- `dgclaw backup [--sem-casas] [--simular]` e `dgclaw backup listar`: backup conferido e datado em
  `/var/backups/dgclaw/<data>-manual`, com manifesto que traz a versão e o commit instalados. Nunca apaga
  backup nenhum.
- `dgclaw restaurar <backup> [--simular] [--mesmo-assim]`: devolve configuração, dados e Admin de um backup,
  depois de guardar o estado de agora (`antes-de-restaurar`), parando e religando os agentes e reiniciando o
  Admin só no fim, solto do chat. Recusa backup de outra versão sem `--mesmo-assim`. Guia em `docs/BACKUP.md`.
- `lib/backup.sh` com os pontos de extensão `backup_caminhos_extras`, `backup_aplicar_retencao`,
  `depois_de_restaurar` e `depois_de_atualizar`, para edições que estendem o DG Claw.
- `dgclaw atualizar` agora volta sozinho ao backup quando o `install.sh` da versão nova falha ou a conferência
  de configuração reprova, explicando o que deu errado, o que foi desfeito e o que fazer. Agente que não sobe
  nunca faz voltar (o conserto é `dgclaw agente recriar <slug> --forcar`). `--sem-voltar-sozinho` desliga.
- Login do Claude que expira: quando a conta estava conectada e a credencial morre (token vencido e a renovação
  falhou), o agente passa a mostrar isso na hora em vez de ficar mudo. A conversa abre na frente o aviso "Seu login
  do Claude expirou", com os botões Reconectar conta, Reiniciar a sessão e Agora não. Depois do login o runner
  reinicia a MESMA sessão sozinho (a conversa não é trocada por uma nova) e o agente recebe um recado para
  responder o que ficou pendente. Enquanto o login está expirado, o envio de mensagem responde 409 com o código
  `LOGIN_EXPIRADO`, o texto digitado fica no campo, e o estado do agente traz `statusReason "runner:login-expirado"`
  e `loginExpiradoEm`. A foto de atividade ganhou o alerta `login_expirado`.
- Bolinha de mensagens não lidas por agente. Na fileira de avatares do celular e no seletor do menu, cada agente
  mostra quantas mensagens novas ele mandou desde a última vez que você viu a conversa dele (de 1 a 99, depois
  "99+"). O botão "trocar de agente" mostra o total e o ☰ ganha uma bolinha quando há algo novo em outro
  agente. A conversa em que você está nunca mostra bolinha, e ela só conta como lida quando você chega ao fim dela. Quem guarda o que já foi lido é o servidor, então o
  celular e o computador concordam. Ao atualizar, ninguém aparece com tudo aceso: cada agente começa zerado. Também
  existe como rota de API (`GET /api/v1/nao-lidas` e `POST /api/v1/agents/<agente>/lido`).
- **Mudança muito importante para quem personaliza o DG Claw.** O seu DG Claw vai ser personalizado por
  você e continuar sendo atualizado pelo Danilo. Para manter a estabilidade e preservar as suas
  alterações, daqui para frente toda personalização do programa (um botão novo, uma cor, um comportamento
  diferente) segue duas regras: o Admin lê antes o guia `docs/PERSONALIZAR.md`, que mostra a arquitetura
  em uma página e onde a mudança deve entrar, e anota cada personalização no registro
  `/opt/dgclaw/admin/PERSONALIZACOES.md` (data, o que você pediu, arquivos, por quê e como testar). Na hora
  de atualizar, o `dgclaw atualizar` confere esse registro contra a versão nova: se nada cruza, reaplica as
  suas personalizações por cima; se algo cruza, para antes de mexer e o Admin pergunta se pode ajustar.
  Quem já usava o DG Claw passa por uma migração na primeira atualização: o que tinha sido mudado direto
  no programa é guardado antes de a versão nova entrar, e o Admin levanta e registra tudo com você
  (`dgclaw personalizacoes levantar`).
- Antes de instalar uma versão nova, o `dgclaw atualizar` mostra o que muda: os commits, os itens novos do
  CHANGELOG e os pontos de atenção (instalador, firewall, credenciais, banco de dados, rotas do painel e os
  arquivos que você personalizou). O Admin lê, conta a você se vê algum risco para os seus arquivos, dados e
  personalizações, e só instala com o seu ok (`--ok-do-dono`).
- Botão "Reiniciar sessão" no menu da conversa: quando um agente trava, o dono confirma, o processo dele é
  refeito e a conversa continua de onde estava. Uma faixa no topo mostra "reiniciando", "de volta" ou o motivo
  da falha. Também existe como rota de API (`POST /api/v1/agents/<agente>/reiniciar`).
- Mensagem falada que vai direto, sem revisão (botão de microfone no envio direto e conversa contínua), chega ao
  agente marcada como `[áudio transcrito]`, para ele saber que pode haver erro de transcrição e deduzir pelo
  contexto. Na tela, o balão mostra só um 🎤 pequeno no rodapé. Texto que vai para o campo e é revisado não leva
  a marca. Os agentes e o Admin ganharam a instrução correspondente.
- Celular: uma fileira de avatares embaixo da barra de escrever troca de agente com o polegar. A conversa atual
  fica com um anel na cor do agente. A fileira some com o teclado aberto e quando só existe um agente.
- Mesa de tarefas: busca (sem diferenciar acento) e filtros por estado, agente, tipo e dia, com a contagem em
  cada opção e um botão "Limpar filtros". A escolha fica guardada no aparelho.
- Modo foco: quando tudo está ticado aparece "Tudo ticado 🎉" com o botão Concluir, que limpa a lista e esconde o
  foco. Recolhido ao lado da conversa, o foco vira uma pílula pequena, com animação (desligada para quem pede
  menos movimento no aparelho).
- Lista "trocar de agente" do menu mostra a hora da última mensagem de cada um (hora, "ontem" ou dia). A rota
  `GET /api/v1/agents` ganhou o campo `ultima_ts` (vazio quando não há conversa).
- Painel, aba Status: as "Pendências ativas" da memória de trabalho aparecem como lista, um item por linha, com o
  título de cada item em negrito e a nota de revisão em cinza acima. A API continua com `texto` e ganhou `itens` e
  `nota`.
- Regra do projeto: passo de atualização que o `dgclaw atualizar` não faz sozinho vai numa subseção
  "Como atualizar" do CHANGELOG, escrita para o dono, e o roteiro `docs/ATUALIZAR.md` passou a ler essas
  subseções antes de aplicar. Um teste (`tests/changelog`) reprova frase dirigida ao modelo.
- `dgclaw atualizar`: atualiza o DG Claw sem perder nada do dono. Faz backup datado em
  `/var/backups/dgclaw/`, baixa a versão nova (`git pull --ff-only`), roda o instalador, reconstrói a
  imagem, recria o container de cada agente (`dgclaw agente recriar`) mantendo casa, cofre e rotinas,
  confere que nenhuma linha de configuração, chave, token ou arquivo de identidade sumiu ou mudou e agenda
  o reinício do Admin por último. `--simular` mostra o que faria e `--voltar <backup>` desfaz. Roteiro do
  Admin em `docs/ATUALIZAR.md`. O instalador agora anota `DGCLAW_REPO` e `DGCLAW_COMMIT` no `dgclaw.env`,
  edita esse arquivo linha a linha e não sobrescreve mais um `CLAUDE.md` ou `AGENTS.md` do Admin que foi
  personalizado (grava o modelo novo ao lado, como `.novo`).
- Modo escondido (botão 👁 no cabeçalho da conversa): troca por asteriscos nomes, empresas, valores,
  e-mails, telefones, documentos e chaves de todas as mensagens da tela, para o dono mostrar a conversa numa
  aula sem expor cliente. Um filtro automático age na hora e um modelo (Claude Haiku com `ANTHROPIC_API_KEY`, ou
  `gpt-4.1-mini` com `OPENAI_API_KEY`) aponta o resto pela rota `POST /api/v1/sigilo`. Mensagem ainda não
  analisada aparece como "escondendo…", nunca crua. Guia em `docs/MODO-ESCONDIDO.md`.
- A aba Sessões do painel agora funciona sozinha em cada agente (modo local): cada card é uma sessão
  paralela do runner do próprio agente. Dá para ver o que cada uma faz, ler a conversa, aprovar ou negar
  pedidos de permissão (só com login; chave de API não decide), mandar recado, anexar arquivo, arquivar,
  apagar, retomar na mesma conversa ou numa conversa nova, renomear, dar estrela e fazer handoff. Os cards
  que o agente abre com o `dgclaw-card` aparecem ali também, e tudo tem rota de API com chave. Sem
  `DGCLAW_PANEL_SESSOES_URL` o painel usa o modo local; com ela, continua usando o DG Telegram.
- O limite de cards abertos ao mesmo tempo sobe de 3 para 8 nas instalações novas
  (`RUNNER_MAX_SESSOES_EXTRAS` na unidade do runner).
- Modo foco (backend): lista curta por agente que o agente monta e o dono tica na tela. Rotas
  `/api/v1/foco/<agente>` (lista, itens, eventos com cursor e `docs.md`), evento `foco` no stream da
  conversa, gancho `foco-hook` (`promptHooks` do `runner.json`) que avisa o agente dos tiques do dono no
  começo do turno, e a skill `foco`. Contrato em `web/docs/MODO-FOCO.md`.
- Mesa de tarefas (tela `/mesa`): o dono vê numa tela só o que cada agente está fazendo, o que travou e o
  que espera por ele, e também cria, responde, conclui e reabre tarefas. O agente mexe nela pelo comando
  `dgclaw-mesa`, e o que espera pelo dono chega como aviso no celular.
- Quadro de avisos entre agentes (tela `/avisos`): os agentes deixam recados curtos uns para os outros
  (decisões, preferências do dono, entregas, aprendizados) e o dono lê tudo numa tela. Guia em
  `docs/QUADRO-DE-AVISOS.md`.
- Lembretes que insistem (tela `/lembretes`): o agente agenda o lembrete, o painel avisa na conversa e no
  celular, com botões Feito e Adiar, e repete até o dono responder. Dá para ativar os avisos no aparelho.
- Comandos de barra na conversa: digitar `/` abre a lista de comandos (`/compact`, `/clear`, `/context`) e das
  skills do agente, para todos os agentes.
- Anexar qualquer arquivo na conversa: o balão mostra um cartão com o arquivo, e o agente abre zips com o
  `dgclaw-abrir-zip`. Subir arquivo na raiz da pasta do agente cria a pasta `arquivos/` se ela não existir.
- Lousa: o agente desenha gráficos, tabelas e esquemas interativos direto na conversa. Todo texto feito para
  copiar vem numa caixinha com botão Copiar.
- Skill `lista-rapida`: o agente responde com uma síntese leve e um visual na conversa.
- Campo de senha na conversa: quando o agente precisa de uma chave, a tela mostra um campo de senha que
  grava direto no cofre, sem a chave passar pelo chat.
- Menu único: a conversa é a tela principal e o menu da esquerda leva às outras páginas, que agora têm o
  mesmo cabeçalho. A conversa ganhou os botões Painel, Mesa e Lembretes no topo.
- Abas Skills e Rotinas no painel de cada agente. Em Rotinas, o botão editar abre a conversa com o pedido
  pronto, e lembrete de uma vez aparece com a data completa.
- Skills de fábrica no agente: slides, sites, vídeos, transcrição com Groq, Gemini e visuais. Elas já
  nascem em `~/.claude/skills` de cada agente.
- Primeiro agente pela conversa com o Admin: animação durante a criação e uma mensagem com os próximos passos.
- `dgclaw dominio`: troca o endereço do painel por um domínio próprio, com conferência do DNS. O Admin tem a
  skill `trocar-dominio` para fazer isso por conversa.
- Quando o agente compacta a conversa, ele mesmo avisa ("Tô compactando a conversa pra voltar mais leve") e
  avisa de novo quando volta. O histórico não mostra mais as linhas de "rodou:".
- Seção "Onde você está e o que você consegue fazer" no prompt de todo agente e do Admin: eles passam a saber
  em que máquina estão, o que enxergam e o que podem pedir ou fazer por conta própria.
- Modo monitor de cards: `dgclaw-card abrir --monitor` abre um card vigiado pelo `dgclaw-monitor`, um vigia
  sem modelo que confere o card de tempos em tempos e só chama o agente quando o critério de entregue aparece
  ou quando algo trava. Guia em `docs/MODO-MONITOR.md`.
- Aviso de novidades depois de atualizar: na primeira conversa depois que o DG Claw é atualizado, o agente (e
  o Admin) conta ao dono, em poucas linhas, o que veio de novo e dá para usar. Cada agente avisa uma vez só,
  e agente criado depois da atualização não recebe aviso do que já nasceu com ele. Guia em `docs/NOVIDADES.md`.
- Aviso de versão nova: quando sai uma atualização do DG Claw no GitHub oficial, o painel mostra uma faixa
  discreta ("Nova versão disponível", com o resumo do que mudou, "Instalar" e "Agora não") e o Admin conta
  ao dono, no chat, que saiu versão nova e pergunta se ele quer instalar (o resumo fica só na faixa). Nada é baixado nem instalado sem o ok do
  dono: o `dgclaw atualizar` continua manual. A checagem é uma leitura pública do GitHub a cada 6 horas, sem
  token e sem enviar dados da instalação. `dgclaw atualizar --checar` confere na hora,
  `dgclaw atualizar --aviso desligar` desliga e `dgclaw status` mostra a situação. Guia em
  `docs/AVISO-DE-ATUALIZACAO.md`.
- Primeiro acesso por link: o instalador não pede mais senha. No fim mostra o link do painel e um link
  de primeiro acesso, de uso único e válido por 30 minutos, onde a pessoa cadastra a senha no navegador
  e já entra no chat do Admin. A senha nunca aparece no terminal. `--senha-stdin` e a pergunta
  interativa continuam funcionando, `sudo dgclaw primeiro-acesso` gera um link novo e
  `sudo dgclaw senha` troca a senha.
- Instalador `install.sh`, que mostra cada etapa em português, pode ser executado de novo sem
  estragar nada e tem o modo `--ensaio`, que lista o que faria sem mudar a máquina.
- Endereço HTTPS automático pelo Caddy: o nome do servidor na Hostinger (`hstgr.cloud`) quando ele
  aponta para a máquina, ou um endereço `sslip.io` baseado no IP. Domínio próprio entra com
  `--dominio`.
- O Admin, um agente de sistema que cuida da máquina e cria os outros agentes por conversa.
- Agentes de trabalho em containers com podman, cada um com a própria casa de arquivos, o próprio
  cofre e sem acesso aos vizinhos nem ao servidor. A imagem traz Claude Code, Codex, Node 22, Bun,
  ffmpeg e Python.
- Comando `dgclaw` (`agente criar|listar|parar|iniciar|reiniciar|reparar|remover`, `imagem`,
  `senha`, `status`). O `remover` move a casa do agente para uma pasta de aposentados, sem apagar.
- DG Claw Web: painel com login, chat com os agentes e seletor de agentes.
- Runner próprio, que mantém a sessão do agente viva, agora dentro deste repositório e com
  autenticação por Bearer (`RUNNER_TOKEN_FILE`) nas chamadas HTTP e no WebSocket.
- Chaves de API do painel, guardadas só como hash, para operar o painel sem tela.
- Cofre de chaves por agente, também operável por API, com reinício do agente quando o cofre pede.
- Codex como provedor, ao lado do Claude, com catálogo de provedores e o cartão "Modelo e
  autenticação" no Status, com login assistido.
- Skills `criar-agente` (para o Admin) e `canais` (ligar o Telegram pelo chat).
- `scripts/teste-isolamento.sh`, que prova que o container do agente não alcança o host nem redes
  privadas.
- `docs/SEGURANCA.md`, com o modelo de ameaça, e `docs/RISCO-DE-BLOQUEIO-DE-CONTA.md`.

### Alterado

- O botão 🦞 Painel saiu do cabeçalho da conversa: o menu lateral já leva ao painel do agente.
- A versão instalada passou a ser a do arquivo `VERSION` (1.0.0), em vez de `v1-<commit>`; o commit continua
  anotado à parte em `DGCLAW_COMMIT`. O `runner` foi de 0.1.0 para 1.0.0, igual ao painel.
- `dgclaw atualizar` passou a desfazer sozinho quando o instalador novo ou a conferência de configuração
  falham (antes parava e pedia o `--voltar`). `--sem-voltar-sozinho` traz o comportamento antigo.
- O login do painel usa hash scrypt, sessão que vence, limite de tentativas e proteção contra CSRF.
- O token do Telegram não passa mais pelos argumentos do `curl`; vai pela entrada padrão.
- O Gmail do agente nasce só com leitura e rascunho; o envio é liberado a pedido do dono, com aviso.
- Compartilhar arquivos nasce sem comando de publicar; sem configuração, o erro diz o que configurar.
- O README e o INSTALL.md passam a descrever a instalação em servidor com o instalador.

### Corrigido

- O menu ☰ fechava só no ✕ e não ao tocar fora dele: um resto de marcação dentro da folha de estilo da conversa
  derrubava a regra do fundo escuro. Um teste novo impede que isso volte a acontecer.
- Aviso amarelo (por exemplo o da cota de voz) fechado no ✕ descansa 48 horas antes de voltar. Números diferentes
  na mesma frase (92% e 93%) contam como o mesmo aviso.
- A faixa "não respondeu em 3 minutos" saiu: a resposta chega sozinha quando o agente mandar, e a conversa
  continua escutando.
- Fundo verde da conversa fica parado no puxão elástico do iPhone, sem faixa branca no fim da rolagem.
- App instalado no iPhone: a faixa branca embaixo da tela some (o fundo da página usa a cor da barra).
- Se o app abrir com uma página antiga guardada, sem o módulo de mídias, a conversa continua funcionando e a aba
  de arquivos pede para recarregar, em vez de a tela ficar em branco.
- Foto aberta no visor: o gesto de ampliar com os dedos não seleciona mais a imagem nem abre o menu de segurar.
- Atualizar o DG Claw não apaga mais as chaves do `web.env`.
- O instalador escolhe o motor do Admin (Claude ou Codex) pelo login que existe, não pelo programa instalado.
- Campos de texto com 16px ou mais no celular: o app instalado não dá mais zoom ao tocar num campo.
- Ubuntu 26.04 passa com aviso, e os problemas da instalação ao vivo de 17/10 foram acertados.

### Segurança

- Só o Caddy fica aberto para a internet (portas 80 e 443); painel, runner e serviços internos
  escutam em `127.0.0.1`.
- Os containers dos agentes não alcançam o servidor.

## [0.2.1] - 2026-08-04

Última versão do DG Claw como plugin do Claude Code, com o assistente `/dgclaw:setup`, em modo
local (no computador da pessoa) ou servidor (numa VPS Linux). A v1 substitui esse formato pelo
instalador, e o plugin não faz parte desta publicação.

[1.0.0]: https://github.com/DGatoM/DG-Claw/releases/tag/v1.0.0
