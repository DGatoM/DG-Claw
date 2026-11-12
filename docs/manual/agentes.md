# Agentes

Esta página cobre o que o dono faz com os agentes de trabalho: criar, parar, reparar e remover, dar identidade, acompanhar o trabalho pela Mesa, guardar chaves, deixar o agente usar um navegador, abrir sessões paralelas e convidar outra pessoa. No fim estão todas as skills e todos os poderes (powers). Cada recurso diz o que é, como pedir ou onde clicar, o que precisa estar configurado, os limites e o que fazer quando dá erro.

Quem cria e cuida dos agentes é o Admin, a sessão administradora do servidor. O dono pede em português na conversa `/a/admin`, e o Admin roda os comandos da CLI `dgclaw`. Os comandos estão listados em [referencia-admin.md](referencia-admin.md).

## Criar um agente

**O que é.** Cada agente de trabalho é uma máquina própria (um container sem root) com casa de arquivos, identidade, painel, conversa e cofre. Ele não enxerga o servidor, o Admin nem os outros agentes.
**Como pedir.** Na conversa com o Admin: "cria um agente para organizar a minha agenda". O Admin pergunta uma coisa por vez (nome, função, jeito de falar, como chamar o dono) e roda `dgclaw agente criar <slug> --nome "<Nome>"`. A primeira vez tem o formulário descrito em [conversa-e-telas.md](conversa-e-telas.md).
**Opções.** `--provedor claude|codex` (padrão `claude`), `--auth assinatura|api` (padrão `assinatura`), `--modelo`, `--papel`, `--jeito`, `--dono`, `--canal chat|telegram|whatsapp` (padrão `chat`), `--avatar` e `--cor`.
**Precisa de.** A imagem dos agentes pronta (`dgclaw imagem status`; na primeira criação ela é construída). Depois, a conta do provedor conectada em `/conectar`.
**Limites.** `--canal telegram` ou `whatsapp` só deixa anotada a intenção; ligar o canal é um passo à parte (veja [canais.md](canais.md)). Rodar o mesmo comando de novo continua de onde parou, sem duplicar nada.
**Se der erro.** O comando diz o que falhou e o que fazer. Se parar no meio, repita a mesma linha.

## Parar, iniciar, reiniciar, reparar, recriar e remover

| Pedido ao Admin | Comando | O que faz |
| --- | --- | --- |
| "lista meus agentes" | `dgclaw agente listar` | Mostra quem existe e quem está de pé |
| "para / liga / reinicia a Ana" | `dgclaw agente parar`, `dgclaw agente iniciar`, `dgclaw agente reiniciar` | Controla o container do agente |
| "o agente da Ana está com problema, conserta" | `dgclaw agente reparar <slug>` | Regrava a configuração e refaz a parte de dentro (runner, painel e rotinas) |
| (feito pela atualização) | `dgclaw agente recriar <slug>` | Troca o container pela imagem nova e mantém a casa, o cofre, as portas e as rotinas |
| "tira a Ana do ar" | `dgclaw agente remover <slug>` | Tira o agente do ar sem apagar: a casa vai para `/var/lib/dgclaw/aposentados/` |

**Limites.** `remover` pede confirmação e nunca apaga a casa do agente. `recriar` só age quando a imagem mudou (`--forcar` recria mesmo assim). Agente parado fica parado.
**Se der erro.** O primeiro passo é `dgclaw agente reparar <slug>`. Se o agente parece mudo ou estranho, a aba `aba:socorro` abre um ajudante de plantão (veja [Socorro](#socorro)).

## Identidade e personalidade

**O que é.** A identidade do agente fica em arquivos de texto na casa dele: `AGENT.md` (quem ele é), `IDENTITY.md`, `PERSONALITY.md`, `MEMORY.md`, entre outros. A aba `aba:identity` do painel mostra e edita esses arquivos; a aba `aba:personality` mostra os números que regulam o jeito dele e as metas.
**Como pedir.** "Muda o jeito da Ana falar para mais direto." O agente ou o Admin edita o arquivo. O dono também edita direto na aba. Depois de salvar, o painel oferece **Avisar ele agora**, porque o agente só relê o arquivo no começo da próxima conversa.
**Precisa de.** Nada.
**Limites.** Se o agente escreveu no mesmo arquivo enquanto o dono editava, o servidor recusa a gravação e deixa o texto do dono na caixa, com botões para copiar o texto ou carregar a versão do agente. Para regravar só a identidade sem reiniciar o agente, o Admin usa `dgclaw agente identidade <slug>`: vale na próxima sessão.
**Se der erro.** Mais em [../../panel/docs/CEREBRO.md](../../panel/docs/CEREBRO.md) e em [personalizar.md](personalizar.md).

## Mesa de tarefas

**O que é.** Uma tela só (`/mesa`) com o que cada agente está fazendo, quanto falta, o que travou e o que espera pelo dono. O agente cria e atualiza as tarefas; o dono acompanha e também pode criar, responder, concluir, cancelar e reabrir.
**Como pedir.** "O que você está fazendo?", "põe isso na mesa", "acompanha essa tarefa". Pelo lado do agente, o comando é `dgclaw-mesa` (`criar`, `atualizar`, `passo`, `pedir`, `travar`, `retomar`, `concluir`, `ver`). A skill `mesa` explica o uso.
**Precisa de.** Nada. A Mesa funciona sozinha em cada servidor, sem serviço externo.
**Limites.** Pedido rápido não vira tarefa. Os estados são `fazendo`, `travada`, `esperando_dono`, `concluida` e `cancelada`. Tarefa em `fazendo` sem atualização há 45 minutos aparece como "parada?". Tarefa que espera o dono avisa o aparelho dele. O agente só mexe nas próprias tarefas. Progresso não medido aparece vazio, nunca como zero.
**Se der erro.** Os erros da rota vêm em português com o motivo. Mais em [../../web/docs/MESA.md](../../web/docs/MESA.md) e [../MESA-DE-TAREFAS.md](../MESA-DE-TAREFAS.md).

## Quadro de avisos

**O que é.** Recados curtos entre os agentes: uma decisão do dono, uma preferência, uma entrega, um aprendizado, uma referência, um pedido ou o resumo do dia. O dono vê o quadro em `/avisos` e também pode postar e retirar avisos.
**Como pedir.** "Conta para a Marina que a reunião mudou." A skill `avisos` guia o agente. Os agentes não conversam entre si direto: o Web leva cada aviso e o entrega na casa de cada destinatário.
**Precisa de.** Nada, já vem ligado.
**Limites.** Até 280 caracteres e 2 linhas por aviso, no máximo 20 avisos por hora e 100 por dia por agente. O Admin não posta nem recebe. O autor é sempre o agente dono da caixa por onde o pedido chegou.
**Se der erro.** Mais em [../QUADRO-DE-AVISOS.md](../QUADRO-DE-AVISOS.md). No Codex a leitura automática dos avisos é parcial (veja [provedores.md](provedores.md)).

## Tela: o navegador do agente

**O que é.** Um navegador de verdade (Google Chrome em servidor amd64, Chromium em arm64) que o dono abre pelo painel. O dono faz o login dos sistemas com o próprio teclado, e o agente passa a trabalhar nesse mesmo navegador já logado. A senha do site não passa pela conversa.
**Como usar.** Item **Navegador** do menu do agente, ou a aba `aba:tela` do painel. Na primeira vez, a tela pede uma senha própria da Tela, de 6 a 8 caracteres. A skill `tela` ensina o agente a mandar o dono para lá quando um site pedir login, código de duas etapas ou captcha.
**Precisa de.** A imagem dos agentes com navegador (é a padrão).
**Limites.** O Admin não tem Tela. O colaborador não abre a Tela, porque ela dá acesso às contas do agente. Os logins ficam em `/home/agente/.tela-chrome` e acompanham a casa do agente.
**Se der erro.** O Admin confere com `dgclaw agente tela <slug>`, que diz o que está de pé e o que falta, e troca a senha com `dgclaw agente tela-senha <slug>`. Mais em [../TELA-DO-AGENTE.md](../TELA-DO-AGENTE.md) e [../../panel/docs/TELA.md](../../panel/docs/TELA.md).

## Sessões e cards (mini-Bunker)

**O que é.** Um card é uma sessão paralela, em Claude ou em Codex, que trabalha num pedido enquanto o agente segue conversando. A aba `aba:sessoes` lista os cards, mostra o que cada um faz, deixa ler a conversa, mandar recado, anexar arquivo, aprovar ou negar um pedido, arquivar, retomar, renomear e marcar com estrela. Um botão **Sessões** também fica no alto da conversa.
**Como pedir.** "Abre um card para montar a apresentação." O agente usa `dgclaw-card` (`abrir`, `mandar`, `esperar`, `ler`, `listar`, `estado`, `fechar`). Trabalhos longos vão para um card; o que se resolve em um minuto, não.
**Precisa de.** Nada. O agente pode abrir o card em outro motor ("abre um card no Codex"), usando a skill `cards`.
**Limites.** No máximo 8 cards abertos ao mesmo tempo. A sessão principal não pode ser arquivada nem apagada. Só a pessoa logada decide um pedido de permissão (chave de API recebe recusa, porque um agente não aprova o próprio pedido). O pedido de permissão só funciona nos cards em Claude.
**Se der erro.** Passou do limite de cards: arquive e apague um antigo. Mais em [../../panel/docs/SESSOES.md](../../panel/docs/SESSOES.md) e [../PROVEDORES.md](../PROVEDORES.md).

## Modo monitor

**O que é.** Vigia os cards de tarefas longas por você, sem gastar nada enquanto nada acontece. A cada 5 minutos o comando `dgclaw-monitor` confere os cards e só acorda o agente com uma mensagem quando um card para, termina, pede algo ou dá erro.
**Como pedir.** O agente liga sozinho ao abrir o card, com `dgclaw-card abrir --monitor --entregue "<como saber que terminou>"`. À mão: `dgclaw-monitor add <id> --entregue "..."`, `dgclaw-monitor list`, `dgclaw-monitor rm <id>`, `dgclaw-monitor run`.
**Limites.** O padrão é conferir a cada 10 minutos (`--cada` muda). Rodada sem evento não gasta modelo nenhum.
**Se der erro.** Quando chega a mensagem do modo monitor, o agente conta ao dono qual card parou, por quê, e pergunta se pode continuar. Mais em [../MODO-MONITOR.md](../MODO-MONITOR.md).

## Cofre e chaves

**O que é.** O cofre guarda as chaves dos serviços que o agente usa (gerar imagem, transcrever áudio, chave de API do provedor). Fica na aba `aba:cofre`. Cada agente tem o seu, e a chave de um não vale para outro. O dono vê quem guardou, quando e os quatro últimos caracteres, nunca o valor.
**Como pedir.** O agente mostra um cartão com campo de senha na conversa (veja [conversa-e-telas.md](conversa-e-telas.md)), ou o dono cola na aba. O Admin guarda por comando, com o valor pela entrada padrão: `dgclaw agente cofre <slug> guardar NOME --aplicar`. Também existem `revogar`, `listar` e `aplicar`.
**Chaves de API do painel.** A mesma aba cria chaves `dgc_...` para outro programa ou agente usar a API do painel. Uma chave de API não cria outra, e só se guarda o hash.
**Limites.** A chave é do dono e a conta também: o gasto é cobrado dele pelo serviço. Guardar reinicia o agente, a não ser que se peça o contrário. O colaborador não mexe no cofre.
**Se der erro.** Mais em [../../panel/docs/COFRE.md](../../panel/docs/COFRE.md) e [../COFRE-POR-API.md](../COFRE-POR-API.md).

## Socorro

**O que é.** A aba `aba:socorro` abre um ajudante de plantão para quando o agente não responde, responde estranho ou o selo ficou amarelo ou vermelho. É outro Claude, neutro, que lê os registros, explica em português o que houve e propõe o conserto. A skill `socorro` leva o mesmo roteiro para o Admin.
**Como pedir.** "Aconteceu alguma coisa com o meu agente, vê aí."
**Limites.** Ler é livre. Qualquer mudança (reiniciar, restaurar, editar, apagar) ele explica e espera o "sim" na mensagem seguinte. Não lê segredos. A sessão de socorro é passageira. Usa o Claude, então depende da conta Claude do servidor.
**Se der erro.** Mais em [../../panel/docs/SOCORRO.md](../../panel/docs/SOCORRO.md) e [../SAUDE-E-MODO-SEGURO.md](../SAUDE-E-MODO-SEGURO.md).

## Colaboradores

**O que é.** O dono convida uma pessoa para conversar com um agente de trabalho. Ela usa a conversa, as sessões e as páginas do painel (para ler), mas não o Admin, os outros agentes, o cofre, as chaves de API, a conta de IA, os canais nem a Tela.
**Como convidar.** Só o dono convida, pela tela `/colaboradores` (menu ☰, item **Convidar colaborador**, com o agente escolhido). Digite o e-mail da pessoa, toque em **Convidar** e mande o texto do convite (ou deixe o e-mail sair, se o SMTP estiver configurado). A senha temporária vale 7 dias e a pessoa cria a própria senha em `/trocar-senha` no primeiro acesso.
**O Admin não convida.** A rota `/api/v1/colaboradores` só aceita a sessão do dono no navegador: pedido que chega pela caixa de um agente (`dgclaw-api`) leva 403, e não achei no código outro jeito de o Admin chamar essa rota. O texto de instrução do Admin ainda sugere a API, mas vale o que está aqui: o Admin orienta o dono a usar a tela.
**Limites.** Um colaborador por agente e um agente por colaborador. O Admin nunca é compartilhado. As mensagens dele chegam ao agente marcadas como vindas de um colaborador. O dono revoga o acesso a qualquer momento e a sessão cai na hora.
**Se der erro.** E-mail não enviado: a tela mostra o motivo e o texto do convite para copiar. Mais em [../../web/docs/COLABORADORES.md](../../web/docs/COLABORADORES.md). A criação do colaborador pelo Admin (`dgclaw colaborador`) está em [em-desenvolvimento.md](em-desenvolvimento.md).

## Skills

Skill é um roteiro escrito (um arquivo `SKILL.md`) que o agente lê antes de fazer um trabalho. O dono pede em português e o agente escolhe a skill; para chamar uma delas direto, digite `/` na conversa (veja [conversa-e-telas.md](conversa-e-telas.md)). A aba `aba:skills` lista todas as que o agente tem. Quando o dono e o agente repetem um processo de 3 passos ou mais, a skill `aprender` oferece guardá-lo como skill própria, e só cria com o "sim" do dono.

A criação de um agente liga estas 14 skills à casa dele: `agenda`, `lembretes`, `aprender`, `avisos`, `memory`, `foco`, `avatar`, `report`, `slide-animado`, `site-animado`, `video-animado`, `groq-audio`, `gemini-gratuito` e `visuais-na-conversa`. O Admin recebe `criar-agente` e `trocar-dominio`. As demais estão no repositório (`/opt/dgclaw/app/skills/`), mas o instalador e a criação não as ligam a ninguém.

| Skill | Quem tem | O que faz |
| --- | --- | --- |
| `agenda` | agentes | Marca, lista e desmarca compromissos do próprio agente na máquina, em timers do sistema. Veja [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `aprender` | agentes | Guarda um processo repetido como skill do agente e a melhora quando o dono corrige |
| `avatar` | agentes | Gera ou troca a figura do agente no painel |
| `avisos` | agentes | Posta e consulta o quadro de avisos entre os agentes |
| `foco` | agentes | Monta a lista do modo foco |
| `gemini-gratuito` | agentes | Conecta a chave gratuita do Gemini e habilita a análise de vídeos |
| `groq-audio` | agentes | Conecta a chave gratuita da Groq para falar por áudio e transcrever |
| `lembretes` | agentes | Agenda lembretes que insistem até o dono confirmar |
| `memory` | agentes | Busca em conversas antigas e na memória, e gerencia a memória. Veja [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| `report` | agentes | Monta um relatório de erro para o autor, sem dados pessoais |
| `site-animado` | agentes | Cria sites de uma página, animados, em um arquivo `.html` |
| `slide-animado` | agentes | Cria apresentações animadas em um arquivo `.html`, com exportação para PDF |
| `video-animado` | agentes | Cria vídeos curtos (5 a 15 segundos) em MP4, a partir de uma composição HTML |
| `visuais-na-conversa` | agentes | Responde com um visual (a lousa) em vez de um textão |
| `criar-agente` | Admin | Conduz a criação de um agente novo, uma pergunta por vez, até o teste real |
| `trocar-dominio` | Admin | Troca o endereço do painel por um domínio do dono. Veja [personalizar.md](personalizar.md) |
| `canais` | no repositório | Conduz a ligação do Telegram e do WhatsApp. Veja [canais.md](canais.md) |
| `cards` | no repositório | Abre um card em outro provedor (por exemplo Codex) e lê a resposta |
| `mesa` | no repositório | Explica o uso da Mesa de tarefas ao agente |
| `tela` | no repositório | Explica ao agente como usar a Tela e quando chamar o dono |
| `socorro` | no repositório | Roteiro de socorro para o dono leigo: descobre, explica, propõe e confere |
| `lista-rapida` | no repositório | Resume os pedidos em lista curta e agrupada, com a lousa |
| `doctor` | no repositório | Diagnóstico e conserto de um assistente que não sobe. Pertence ao plugin antigo (veja nota abaixo) |
| `connect` | no repositório | Conecta Drive, Gmail e Agenda pelos conectores do Claude. Veja [canais.md](canais.md) |
| `importar` | no repositório | Recebe um agente que rodava no computador da pessoa (DG Claw Lite). Pertence ao plugin antigo |
| `panel` | no repositório | Sobe e explica o painel nos modos local e servidor. Pertence ao plugin antigo |
| `service` | no repositório | Liga, desliga e mostra logs do serviço do assistente. Pertence ao plugin antigo |
| `uninstall` | no repositório | Tira um assistente do ar com backup datado. Pertence ao plugin antigo |
| `instagram` | no repositório | Administra o Instagram do agente (poder `instagram`, abaixo) |
| `powers` | no repositório | Lista, instala e desativa poderes |

**Nota sobre as skills do plugin antigo.** `doctor`, `importar`, `panel`, `service`, `uninstall` e `powers` foram escritas para o assistente de um agente só, instalado sem containers, e chamam scripts e serviços que esse modelo usava. No DG Claw v1 o equivalente vem do Admin e da CLI `dgclaw`. Por isso, confira cada uma antes de oferecê-la a alguém.

**Se uma skill não funciona.** Conte ao Admin o que falhou e peça `dgclaw agente reparar <slug>`. Uma skill com o mesmo nome de um comando nativo perde a disputa na barra de comandos.

## Poderes (powers)

Poder é uma capacidade de trabalho que se liga ao agente. A fonte da verdade é o arquivo `.dgclaw/powers.json` na casa do agente: o painel e as rotinas leem dele. O `core` (memória, personalidade e operação) está sempre ligado.

| Poder | Estado | O que faz |
| --- | --- | --- |
| `instagram` | Parcial | Publica fotos e reels e responde comentários, com revisão visual e proteção contra instrução escondida em comentário. Liga as abas `aba:posts` e `aba:followers`. Precisa de token e conta Instagram Business. Cria timers de post (8h, 13h e 19h) e de comentários |
| `meetings` | Em desenvolvimento | Entraria em reuniões pelo Recall.ai. Fica travado. Veja [em-desenvolvimento.md](em-desenvolvimento.md) |
| `crm` | Em desenvolvimento | Ligaria o agente ao CRM do dono e ao WhatsApp. Fica travado. Veja [em-desenvolvimento.md](em-desenvolvimento.md) |
| `secretary` | Em desenvolvimento | Faria triagem de e-mail e briefing da agenda. Fica travado. Hoje, para ler Gmail e Agenda, use os conectores (veja [canais.md](canais.md)) |

**`instagram`: como pedir e limites.** Peça "ativa o Instagram" ao agente ou ao Admin. A instalação passa pelos scripts `scripts/powers.py` e `scripts/install-ig-timers.sh`, e as rotinas de post e de comentários rodam o Claude em modo sem terminal, que o Codex ainda não tem. Só a criação dos timers tem teste automático; não há teste do fluxo completo num agente em container. Por isso o estado é Parcial: confira o fluxo de ponta a ponta no seu servidor antes de contar com ele. Poder desativado preserva os dados (posts, seguidores e token) e as abas voltam a travar. A rota de reuniões responde "423 poder não instalado" enquanto `meetings` estiver desligado.
