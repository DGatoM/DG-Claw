# Changelog

Todas as mudanças importantes do DG Claw ficam neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

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

### Adicionado

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

### Corrigido

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
