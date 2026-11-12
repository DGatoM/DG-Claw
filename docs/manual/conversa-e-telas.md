# Conversa e telas

Esta página mostra o que o dono encontra no navegador: as telas do DG Claw, a conversa com cada agente e tudo o que acontece dentro dela. Cada recurso tem cinco pontos: o que é, como pedir ou onde clicar, o que precisa estar configurado, os limites e o que fazer quando dá erro. O detalhe técnico continua nos documentos ligados em cada seção.

## As telas do DG Claw

O endereço do painel é o que o instalador mostrou no fim da instalação. Todas as telas abaixo pedem login, exceto `/login` e `/primeiro-acesso`.

| Tela | O que é | Como chegar |
| --- | --- | --- |
| `/login` | Entrada com usuário e senha | Qualquer endereço do painel sem sessão leva para cá |
| `/primeiro-acesso` | Cadastro da senha do dono, uma única vez | Link que o instalador mostra (vale 30 minutos e uma só vez) |
| `/a/<slug>` | A conversa com um agente. `/a/admin` é a conversa do Admin | Menu à esquerda ou fileira de avatares |
| `/mesa` | Mesa de tarefas: o que cada agente está fazendo | Botão Mesa no alto da conversa |
| `/lembretes` | Lembretes que insistem até o dono confirmar | Botão Lembretes no alto da conversa |
| `/avisos` | Quadro de avisos entre os agentes | Menu ☰, item Avisos |
| `/conectar` | Conectar ou reconectar a conta de IA de cada agente | Menu ☰, item Conectar conta |
| `/anonimizar` | Troca os dados pessoais dos documentos por marcadores | Botão Anonimizar na conversa ou menu ☰ |
| `/seguranca` | Ronda de segurança, boletins e botão de emergência | Menu ☰, item Segurança. Veja [seguranca.md](seguranca.md) |
| `/logs` | Histórico do que cada agente fez (mensagens, comandos, arquivos), só leitura e só para o dono | Menu ☰ do Admin, item Logs. Veja [LOGS.md](../../web/docs/LOGS.md) |
| `/manual` | Esta documentação, dentro do painel | Menu ☰, item Manual |
| `/colaboradores` | Convite para outra pessoa conversar com um agente | Menu ☰, item Convidar colaborador. Veja [agentes.md](agentes.md) |
| `/trocar-senha` | O colaborador troca a senha temporária | O colaborador cai aqui no primeiro acesso |

O painel de cada agente fica em `/p/<slug>/`, com as abas da tabela da seção [Painel do agente](#painel-do-agente).

Em toda tela existe o botão **Tutorial**, ao lado do título. Ele faz uma visita guiada: apaga o resto da tela e explica, parte por parte, o que é, como funciona e por que está ali. As seções com um `?` têm uma visita só delas. A visita é o jeito mais rápido de conhecer uma tela nova.

## Entrar no painel

**O que é.** A porta única do DG Claw. O instalador mostra o endereço, o usuário e um link de primeiro acesso.
**Como usar.** Abra o link em `/primeiro-acesso`, cadastre a senha (mínimo de 12 caracteres) e a partir daí entre por `/login`.
**Precisa de.** Nada além do endereço do painel.
**Limites.** Erros seguidos de senha bloqueiam a tentativa por um tempo, e a tela diz quantos segundos faltam. O link de primeiro acesso vale uma vez e por 30 minutos.
**Se der erro.** Link vencido ou perdido: no servidor, `sudo dgclaw primeiro-acesso` gera outro e o antigo deixa de valer. Senha esquecida: o Admin ou o terminal trocam com `dgclaw senha trocar`. Mais em [atualizar-e-backup.md](atualizar-e-backup.md) e em [referencia-admin.md](referencia-admin.md).

## A conversa

**O que é.** O chat do navegador, o canal principal de cada agente. O Telegram e o WhatsApp são opcionais (veja [canais.md](canais.md)) e caem na mesma conversa.
**Como usar.** Abra `/a/<slug>`, escreva e envie. A resposta aparece quando o agente a manda. O cabeçalho mostra "agente sem sinal" quando o serviço dele não responde.
**Precisa de.** O agente criado e a conta de IA dele conectada (veja [provedores.md](provedores.md)).
**Limites.** A conversa mostra o que o agente envia pelo chat. Um agente trabalhando em silêncio parece parado, por isso ele deve avisar quando começa algo demorado.
**Se der erro.** "Agente sem sinal": peça ao Admin `dgclaw agente reparar <slug>` (veja [agentes.md](agentes.md)). Pedido de login: a conversa abre o cartão para entrar na conta, descrito em [Conectar conta](#conectar-conta).
Mais em [../CONVERSA.md](../CONVERSA.md).

### Primeiro agente

**O que é.** Na primeira vez, o botão **Quero criar meu primeiro agente** abre uma conversa com o Admin. Um formulário reúne nome, função, tom, nome do dono e uma foto opcional. O Admin cria o agente e a tela acompanha cada etapa real: pedido recebido, criação, conexão da conta, teste.
**Limites.** A apresentação final só aparece depois que o agente responde de verdade ao teste.
**Se der erro.** A tela mostra a etapa que falhou e o Admin retoma o mesmo pedido. Passo a passo em [../../web/docs/PRIMEIRO-AGENTE.md](../../web/docs/PRIMEIRO-AGENTE.md).

### Trocar de agente, não lidas e selos

**O que é.** O menu à esquerda e a fileira de avatares mostram quem está trabalhando (três pontinhos), quem terminou e você não leu (bolinha vermelha) e quem precisa de você (círculo âmbar com "!"). O botão **não lida** marca a conversa atual como não lida.
**Precisa de.** Nada. O celular recebe aviso para "precisa de você" e "terminou" se os [avisos no aparelho](#avisos-no-aparelho) estiverem ligados.
**Limites.** Quando o serviço do agente não responde, o selo fica sem estado: ele nunca aparece como "ocioso" por engano.
Mais em [../../web/docs/ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md).

### Pedidos de permissão e perguntas do agente

**O que é.** Quando o agente precisa de uma permissão ou quer que o dono escolha entre opções, aparece um cartão na conversa. O agente fica esperando até o dono decidir.
**Limites.** Isso depende do motor: no Claude funciona; no Codex o pedido de permissão e a pergunta de escolha ainda não funcionam (veja [provedores.md](provedores.md)).
**Se der erro.** Cartão que não aparece: o selo "precisa de você" no menu mostra que o agente está esperando. Mais em [../../web/docs/TRILHA-E-PERMISSAO.md](../../web/docs/TRILHA-E-PERMISSAO.md).

### Mídias, links e arquivos (Compartilhados)

**O que é.** Tocar na foto ou no nome do agente abre a lista de tudo o que foi trocado na conversa, em abas de mídias, links e arquivos.
**Limites.** Carrega 20 itens por página; as miniaturas são geradas no servidor com o `ffmpeg` que o instalador deixa pronto. A lista fica guardada no aparelho por até 30 dias.
**Se der erro.** Miniatura que não aparece mostra um ícone e a causa. Mais em [../../web/docs/MIDIAS-CACHE.md](../../web/docs/MIDIAS-CACHE.md).

## Anexos

**O que é.** O clipe 📎 envia fotos, vídeos, áudios e PDFs, vários de uma vez. O arquivo chega à pasta do agente e o caminho vai no texto da mensagem.
**Limites.** Até 10 anexos por mensagem. O envio inteiro tem teto de 50 MB (valor `DGCLAW_WEB_MAX_UPLOAD_MB` do `web.env`). Mensagem com anexo nunca vira comando de barra.
**Se der erro.** A tela diz o tamanho enviado e o limite. Arquivo grande demais: divida em duas mensagens.

## Voz: falar e ouvir

**O que é.** O botão 🎤 grava um áudio que o painel transcreve e manda ao agente como texto. O botão 🔊 faz o agente responder em voz alta, e o 🔁 (conversa contínua) volta a gravar depois de cada resposta.
**Precisa de.** Uma chave no `web.env`. Para transcrever, vale `GROQ_API_KEY` (gratuita), `ELEVENLABS_API_KEY` ou `OPENAI_API_KEY`, nessa ordem de preferência: ElevenLabs, Groq, OpenAI. Para o agente falar, só `ELEVENLABS_API_KEY`, mais uma voz escolhida para o agente. O agente tem a skill `groq-audio`, que guia o dono para conectar a Groq ("quero falar por áudio").
**Limites.** A resposta é lida em pedaços (o primeiro de até 450 caracteres, os outros de até 1200, no máximo 40 pedaços). Tabelas, código e links não viram fala. O áudio transcrito chega ao agente marcado como `[áudio transcrito]`, e ele sabe que a transcrição pode ter erros.
**Se der erro.** Sem chave, a tela esconde os botões e a rota responde com o motivo ("falta GROQ_API_KEY..."). Peça ao Admin: "conecta a Groq para eu falar por áudio".
Mais em [../CONVERSA.md](../CONVERSA.md).

## Comandos de barra

**O que é.** Uma mensagem que começa com `/` é um comando para o motor do agente. Ao digitar `/` no começo do campo, abre a lista do que dá para usar: os comandos nativos que funcionam no modo do DG Claw e as skills do agente.
**Exemplos.** `/compact` resume a conversa e libera contexto, `/clear` começa uma conversa limpa, `/context` mostra o quanto da memória da sessão está ocupado, `/model sonnet` troca o modelo, e `/agenda me lembra amanhã às 9h` roda a skill `agenda`.
**Limites.** Os comandos que abrem menus ou telas no terminal (`/config`, `/memory`, `/resume` e parecidos) aparecem apagados na lista, com o motivo, e são recusados. Para mandar uma mensagem que começa com barra como texto comum, use duas barras (`//texto`). No Telegram os comandos nativos não rodam; no WhatsApp a barra é sempre texto.
**Se der erro.** Comando inexistente volta com sugestões de nomes parecidos; comando que não roda volta com o motivo e o que fazer.
Mais em [../../web/docs/COMANDOS-DE-BARRA.md](../../web/docs/COMANDOS-DE-BARRA.md).

## Visuais na conversa (a lousa)

**O que é.** O agente responde com um desenho dentro do balão: números que contam, comparações, linhas do tempo, passo a passo, gráficos simples e botões de escolha. É a lousa. A skill `visuais-na-conversa` ensina o agente a usar.
**Como pedir.** "Me explica isso na lousa" ou "manda a visão na lousa". Respostas com estrutura, números ou comparação vão para a lousa sem pedir.
**Limites.** Cada visual é um arquivo `vis-<assunto>.html` de até 2 MB, sem internet. Um botão do visual só pergunta algo ao agente depois que o dono toca em Enviar na barrinha de confirmação (até 500 caracteres). Texto para copiar vem numa caixa com botão **Copiar**.
**Se der erro.** Visual vazio ou com tarja de erro: peça ao agente que mande de novo com outro nome.
Mais em [../VISUAIS.md](../VISUAIS.md) e nos exemplos de [../VISUAIS-EXEMPLOS](../VISUAIS-EXEMPLOS).

## Campo de senha na conversa (cofre)

**O que é.** Quando o agente precisa de uma chave, a conversa mostra um cartão com campo de senha e o botão **Salvar no cofre**. O valor vai direto para o cofre do agente e não passa pela conversa, pelo histórico nem pelo modelo.
**Limites.** Salvar reinicia o agente para a chave valer; a conversa continua de onde parou. Só o dono usa esse cartão.
**Se der erro.** Mais em [../COFRE-NA-CONVERSA.md](../COFRE-NA-CONVERSA.md) e em [agentes.md](agentes.md).

## Modo escondido (o olhinho 👁)

**O que é.** O botão 👁 troca por asteriscos nomes, valores em dinheiro, e-mails, telefones, CPF, CNPJ e chaves de todas as mensagens da tela. Serve para mostrar o painel em uma aula sem expor clientes. Tocar num texto escondido revela só aquela mensagem.
**Precisa de.** O filtro automático (e-mail, valores, CPF e parecidos) funciona sem nada. Para esconder também nomes de pessoas e empresas, o `web.env` precisa de `ANTHROPIC_API_KEY` ou de `OPENAI_API_KEY`. Peça ao Admin: "liga o modo escondido completo".
**Limites.** Enquanto uma mensagem não foi analisada, ela fica coberta ("escondendo..."). Se a análise falhar, ela continua coberta, com o aviso do que houve. Fotos e vídeos de mensagens escondidas ficam borrados. O colaborador não tem o olhinho.
Mais em [../MODO-ESCONDIDO.md](../MODO-ESCONDIDO.md).

## Anonimizar documentos

**O que é.** Com a opção ligada para um agente, os documentos enviados pelo clipe chegam a ele sem os dados pessoais, trocados por marcadores como `[PESSOA_1]` e `[CPF_1]`. O dono lê tudo completo: o botão **Ver com dados reais** mostra o texto original na tela dele, e **Baixar versão final** devolve o arquivo com os dados reais no lugar dos marcadores.
**Como ligar.** Abra `/anonimizar`, escolha o agente e ligue. O detector completo de nomes é instalado pela própria tela, com um botão.
**Limites.** Só vale para o clipe da conversa do navegador, não para o que chega por WhatsApp, Telegram ou e-mail. Nenhum detector acha 100% dos nomes: em documento muito sensível, confira com **Ver tabela**. PDF escaneado é recusado. A versão final só volta para `.docx`, `.xlsx`, `.pptx`, `.md`, `.txt`, `.csv` e `.json`. A tabela fica cifrada no servidor, com a chave em `/etc/dgclaw/anonimizar.chave`: guarde essa chave junto com o backup, porque sem ela os dados reais não voltam.
**Se der erro.** Mais em [../ANONIMIZAR.md](../ANONIMIZAR.md) e em [../../web/docs/ANONIMIZAR.md](../../web/docs/ANONIMIZAR.md).

## Lembretes

**O que é.** Um lembrete que insiste. O agente agenda para o dono ("me lembra amanhã às 9h de ligar pro contador") e, na hora, o aviso toca de novo a cada poucos minutos até o dono tocar **Feito** ou **Adiar**. O aviso sai em três lugares ao mesmo tempo: uma faixa ⏰ no alto de qualquer conversa, uma notificação no aparelho e um recado ao agente (que avisa por Telegram ou WhatsApp, se tiver).
**Como pedir.** Diga ao agente, em conversa, o que e quando. A skill `lembretes` cuida do resto. A lista fica em `/lembretes`.
**Precisa de.** Nada além do Web ligado. Para o aviso chegar com a tela fechada, ative os [avisos no aparelho](#avisos-no-aparelho).
**Limites.** Repete a cada 5 minutos por padrão, no máximo 12 vezes (o teto pode ir até 60). Não depende de a sessão do agente estar aberta: o Web dispara sozinho e volta sozinho depois de um reinício. O fuso é o do servidor (`DGCLAW_WEB_TZ` muda).
**Se der erro.** O lembrete que perdeu a hora aparece como perdido na lista. Mais em [../../web/docs/LEMBRETES.md](../../web/docs/LEMBRETES.md). Para compromissos do próprio agente, e não do dono, veja [memoria-e-rotinas.md](memoria-e-rotinas.md).

## Avisos no aparelho

**O que é.** Notificações no celular e no computador, mesmo com a tela fechada, para lembretes, Mesa, modo foco e para "Fulano precisa de você" e "Fulano terminou".
**Como ligar.** Toque em **Ativar avisos neste aparelho**, no menu lateral ou na tela de lembretes. Cada aparelho ativa uma vez. Os dois tipos de aviso dos agentes podem ser desligados separadamente.
**Precisa de.** No Android e no computador, um navegador comum (Chrome, Edge, Firefox). No iPhone, o DG Claw precisa estar instalado na tela de início (iOS 16.4 ou mais novo); no Safari aberto como site o botão explica isso.
**Limites.** Não apague o par de chaves guardado em `push/vapid.json`: um par novo invalida todos os aparelhos e cada um precisa ativar de novo.
**Se der erro.** O botão **Enviar teste** mostra se o serviço de push recusou e por quê. Mais em [../../web/docs/AVISOS-NO-APARELHO.md](../../web/docs/AVISOS-NO-APARELHO.md).

## Modo foco

**O que é.** Uma lista curta do que o dono quer fechar agora, ao lado da conversa. O agente monta a lista e o dono marca os itens na tela. Na próxima mensagem, o agente fica sabendo o que foi marcado.
**Como pedir.** "Monta meu foco de hoje." A skill `foco` cuida do resto.
**Limites.** Até 50 itens por lista, de até 300 caracteres. Cada agente tem a sua lista. No celular a lista vira uma faixa recolhida no topo da conversa.
**Se der erro.** Se a gravação de uma marca falhar, o item volta ao estado anterior e a tela diz o motivo. Mais em [../../web/docs/MODO-FOCO.md](../../web/docs/MODO-FOCO.md).

## Alertas de entrega e de pedido

**O que é.** O agente começa a resposta com `[ENTREGA]` quando algo importante ficou pronto, ou com `[PEDIDO]` quando parou esperando uma decisão. A tela colore o balão e põe um ícone (✅ ou ⚠️) na pilha à direita. Tocar no ícone leva à mensagem e o retira.
**Limites.** Reconhecer um pedido não o autoriza: a resposta é dada na conversa. Não há expiração nem tela de gestão. Vale para os dois motores e para as respostas por DG Chat, Telegram e WhatsApp.
Mais em [../../web/docs/ALERTAS.md](../../web/docs/ALERTAS.md).

## Uso da assinatura

**O que é.** Mostra quanto da janela de 5 horas e da janela semanal da assinatura de cada agente já foi gasto. Fica no Status do painel do agente e no menu ☰, item Uso das assinaturas. As cores são verde abaixo de 70%, âmbar de 70% a 89% e vermelho a partir de 90%.
**Como o agente usa.** Antes de uma tarefa pesada ele consulta o próprio uso. Passou de 90% na janela de 5 horas, ele avisa o dono.
**Limites.** O número vem do próprio Claude Code (linha de status) ou do Codex (arquivo da conversa), a cada resposta. Antes da primeira resposta, o campo fica vazio, e vazio quer dizer "ainda não medido", nunca zero. Agente que paga por chave de API não tem janela.
Mais em [../../web/docs/USO-DA-ASSINATURA.md](../../web/docs/USO-DA-ASSINATURA.md).

## Conectar conta

**O que é.** A tela `/conectar` e o cartão "entrar na conta" da conversa ligam, ou religam, a conta de IA de cada agente. Há um cartão por agente, com o Admin primeiro. Quando algum agente está sem login, o painel abre sozinho o aviso "Faça o login nos seus agentes".
**Como usar.** Toque em **Gerar link de login**, abra a página, entre com a conta e cole o código de volta. No Codex não há código para colar: a página mostra um código para digitar no navegador.
**Limites.** Um login por vez. O link vale poucos minutos e só nasce quando você toca no botão.
**Se der erro.** Veja [provedores.md](provedores.md) e [../../web/docs/CONECTAR-CONTA.md](../../web/docs/CONECTAR-CONTA.md).

## Mesa de tarefas e Quadro de avisos

Estas duas telas são ferramentas dos agentes: explicadas em [agentes.md](agentes.md). A Mesa fica em `/mesa` e o quadro em `/avisos`.

## Painel do agente

Cada agente tem um painel em `/p/<slug>/` com abas. O colaborador convidado vê as abas só para ler, e nunca mexe no cofre, nas chaves de API, na conta de IA, nos canais nem na Tela (veja [agentes.md](agentes.md)).

| Aba | Para que serve | Mais |
| --- | --- | --- |
| `aba:conversa` | A conversa dentro do painel, a mesma de `/a/<slug>` | [../CONVERSA.md](../CONVERSA.md) |
| `aba:status` | Página inicial: números do mês, modelo e forma de pagar, memória de trabalho, rotinas | [../../panel/docs/PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `aba:memory` | Os arquivos de memória do agente, para ler e corrigir | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:operations` | As rotinas do sistema, com a fileira das últimas execuções, e a sessão viva | [../../panel/docs/OPERACOES.md](../../panel/docs/OPERACOES.md) |
| `aba:sessoes` | Sessões paralelas (cards) do agente | [agentes.md](agentes.md) |
| `aba:costs` | Custo do mês por categoria e rotina, contra o teto definido | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:como` | Texto "Como o agente funciona por dentro", com os números reais ao lado | [../RADIOGRAFIA.md](../RADIOGRAFIA.md) |
| `aba:identity` | Quem o agente é, em arquivos de texto editáveis | [agentes.md](agentes.md) |
| `aba:personality` | Os números que regulam o jeito dele e as metas | [agentes.md](agentes.md) |
| `aba:apps` | O que o agente produziu sozinho, etapa por etapa | [../../panel/docs/ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `aba:skills` | Lista das skills do agente e onde cada uma fica | [agentes.md](agentes.md) |
| `aba:rotinas` | Os compromissos que o agente marcou a pedido do dono | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aba:arquivos` | A pasta do agente (aba Pasta): ver, baixar e enviar arquivos | [../../panel/docs/PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `aba:tela` | O navegador do agente, para o dono fazer logins | [agentes.md](agentes.md) |
| `aba:socorro` | Ajudante de plantão para quando o agente para ou responde estranho | [agentes.md](agentes.md) |
| `aba:cofre` | As chaves de serviço do agente e as chaves de API do painel | [agentes.md](agentes.md) |
| `aba:posts` | Publicações no Instagram. Só com o poder `instagram` ligado | [agentes.md](agentes.md) |
| `aba:followers` | Seguidores e comentários no Instagram. Só com o poder `instagram` ligado | [agentes.md](agentes.md) |
| `aba:reunioes` | Reuniões acompanhadas. Em desenvolvimento, fica travada | [em-desenvolvimento.md](em-desenvolvimento.md) |

## O manual dentro do painel

**O que é.** Esta documentação, aberta no navegador em `/manual` (menu ☰, item **Manual**). A tela tem uma busca que filtra a lista de páginas pelo título. Os agentes leem o mesmo conteúdo por `GET /api/v1/manual/docs.md`, sem credencial, pela caixa (`dgclaw-api`).
**Limites.** A tela só lê: nada escreve no manual. Os links para documentos fora de `docs/manual/` aparecem como caminho, sem link clicável. O colaborador convidado não abre a tela do manual.
**Se der erro.** "Manual ausente": a instalação está sem a pasta `docs/manual/`, e a solução é atualizar o DG Claw. Mais em [../../web/docs/MANUAL.md](../../web/docs/MANUAL.md).
