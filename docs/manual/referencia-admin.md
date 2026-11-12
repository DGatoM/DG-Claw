# Referência para o Admin e para os agentes

Esta página é a camada técnica do manual. Ela lista, um por um, os comandos e as rotas do DG Claw, diz para
que cada um serve, quem pode chamá-lo e onde está o documento de detalhe. Quem lê é o Admin, um agente que
opera o sistema ou uma pessoa que precisa do endereço exato. As páginas para o dono ficam nos outros arquivos
desta pasta.

Os itens entre os marcadores `inventario:inicio` e `inventario:fim` são conferidos contra o código por
`bash tests/docs-em-dia/rodar.sh`. Se uma rota ou um comando nasce, muda de nome ou some, o teste reprova até
esta lista ser corrigida.

## Quem pode chamar

| Sigla | Quem é | Como entra |
| --- | --- | --- |
| Dono | A pessoa dona do DG Claw, logada no navegador | Cookie de sessão do login (`/login`). Em `/p/<slug>/` o Web repassa ao painel do agente com um segredo próprio |
| Colab | Um colaborador convidado para **um** agente | Cookie de sessão de colaborador. O Web só deixa passar o agente dele (`web/lib/escopo.js`) |
| Caixa | Um agente de trabalho, de dentro do container | `dgclaw-api`, que deixa um pedido na pasta `~/.dgclaw/caixa/` ([CAIXA-DO-AGENTE.md](../CAIXA-DO-AGENTE.md)). Só as rotas liberadas com `caixa.permitir` |
| Chave | Outro assistente (o Admin, por exemplo) operando o painel de **um** agente | `Authorization: Bearer dgc_...`, criada na aba Cofre daquele agente ([COFRE-POR-API.md](../COFRE-POR-API.md)) |
| Root | Quem roda como root no servidor: o Admin ou o dono no terminal | `sudo dgclaw ...` |
| Público | Qualquer um que alcance o endereço | Sem login |

Regras que valem para tudo:

- As rotas do Web (`/api/v1/...`) exigem a sessão do dono. No código não existe credencial de máquina para o
  Web: o Admin não tem caixa nem chave para elas. As exceções estão na coluna "Quem" de cada linha.
- Uma chave de API do painel não cria, lista nem revoga chaves de API, e não troca a senha da Tela.
- Rota nova do Web que não leva o `slug` do agente no caminho nasce fechada para o colaborador (403) até
  alguém liberá-la em `web/lib/escopo.js`.
- Todo erro volta com o motivo em português e o status certo. `null` quer dizer "não medido", nunca zero.

<!-- inventario:inicio -->

## Comandos do servidor (`dgclaw`)

Rodam como root: `sudo dgclaw <comando>`. A opção `--ensaio` vale em qualquer um e mostra o que seria feito sem
mudar nada. Quem: Root. Detalhe geral em [ATUALIZAR.md](../ATUALIZAR.md) e no `dgclaw --ajuda`. A exceção é o `dgclaw emergencia`, que ignora o `--ensaio` e age de verdade: para ver o plano sem mudar nada, use `dgclaw emergencia simular`.

### Agentes

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw agente criar` | Cria um agente de trabalho: máquina própria, painel e conversa. Aceita `--nome`, `--provedor`, `--auth`, `--modelo`, `--papel`, `--jeito`, `--dono`, `--canal`, `--avatar`, `--cor`. Rodar de novo continua de onde parou | [ARQUITETURA.md](../ARQUITETURA.md) |
| `dgclaw agente listar` | Lista os agentes e diz se estão de pé (`--json` para máquina) | [ARQUITETURA.md](../ARQUITETURA.md) |
| `dgclaw agente parar` | Para o agente. Pede o `slug` | [ARQUITETURA.md](../ARQUITETURA.md) |
| `dgclaw agente iniciar` | Liga um agente parado | [ARQUITETURA.md](../ARQUITETURA.md) |
| `dgclaw agente reiniciar` | Desliga e liga de novo. Serve para um agente travado; não use para atualizar | [ATUALIZAR.md](../ATUALIZAR.md) |
| `dgclaw agente reparar` | Regrava o `config.sh` e refaz a parte de dentro (runner, painel e rotinas) | [ATUALIZAR.md](../ATUALIZAR.md) |
| `dgclaw agente recriar` | Troca o container pelo da imagem nova e mantém casa, cofre, portas e rotinas. `--forcar` recria mesmo com a imagem igual | [ATUALIZAR.md](../ATUALIZAR.md) |
| `dgclaw agente identidade` | Regrava só o `identidade.md`; vale na próxima sessão | [PERSONALIZAR.md](../PERSONALIZAR.md) |
| `dgclaw agente cofre` | Guarda, revoga, lista ou aplica chaves de API do agente (`guardar`, `revogar`, `listar`, `aplicar`). O valor vem sempre pelo STDIN | [COFRE-POR-API.md](../COFRE-POR-API.md) |
| `dgclaw agente tela` | Confere a Tela do agente e diz, linha a linha, o que falta | [TELA-DO-AGENTE.md](../TELA-DO-AGENTE.md) |
| `dgclaw agente tela-senha` | Troca a senha da Tela (6 a 8 caracteres ASCII, pelo STDIN) | [TELA-DO-AGENTE.md](../TELA-DO-AGENTE.md) |
| `dgclaw agente remover` | Tira o agente do ar sem apagar: a casa vai para `/var/lib/dgclaw/aposentados/`. Pede confirmação, ou `--sim` | [ATUALIZAR.md](../ATUALIZAR.md) |

### Colaboradores: convidar quem vai usar um agente

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw colaborador criar` | Cria o acesso de uma pessoa a um agente (`<agente> <email>`) e mostra o convite pronto para copiar, com endereço, login e senha temporária | [agentes.md](agentes.md) |
| `dgclaw colaborador listar` | Lista os colaboradores e os agentes a que cada um tem acesso | [agentes.md](agentes.md) |
| `dgclaw colaborador reenviar` | Gera uma senha temporária nova e mostra o convite de novo | [agentes.md](agentes.md) |
| `dgclaw colaborador revogar` | Tira o acesso e derruba as sessões da pessoa. Se ela conectou a conta de IA do agente, a conta continua conectada e o comando avisa | [agentes.md](agentes.md) |
| `dgclaw colaborador ajuda` | Mostra o uso do comando | [agentes.md](agentes.md) |

### Painel: domínio, senha e primeiro acesso

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw dominio mostrar` | Mostra o domínio atual do painel e o IP público da VPS | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw dominio trocar` | Passa o painel para um domínio próprio. Confere o DNS antes e não muda nada se não apontar (`--sem-conferir-dns` pula a conferência) | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw senha trocar` | Troca a senha do painel (mínimo de 12 caracteres, nova senha pelo STDIN) e reinicia o Web | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw primeiro-acesso` | Gera um link novo de primeiro acesso (uso único, vale 30 minutos); o anterior deixa de valer | [SEGURANCA.md](../SEGURANCA.md) |
| `dgclaw instalacao-remota` | Para a equipe que instalou na VPS de outra pessoa: troca a senha por uma forte e mostra a mensagem de entrega uma única vez. Não rode numa instalação feita pelo próprio dono | [INSTALL.md](../../INSTALL.md) |

### Imagem, estado e versão

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw imagem status` | Diz se a imagem dos agentes está pronta, construindo ou falhou (`--exigir-pronta` sai com erro se não estiver) | [ATUALIZAR.md](../ATUALIZAR.md) |
| `dgclaw imagem construir` | Constrói a imagem em segundo plano, ou na hora com `--agora` | [ATUALIZAR.md](../ATUALIZAR.md) |
| `dgclaw status` | Confere se tudo o que é essencial está de pé; sai com erro se algo caiu | [atualizar-e-backup.md](atualizar-e-backup.md) |
| `dgclaw versao` | Mostra a versão e o commit instalados | [atualizar-e-backup.md](atualizar-e-backup.md) |

### Atualizar, backup e restaurar

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw atualizar` | Baixa a versão nova, faz backup, reinstala e recria os agentes. Opções: `--simular`, `--repo`, `--forcar-local`, `--sem-baixar`, `--sem-backup-agentes`, `--sem-voltar-sozinho`, `--ok-do-dono`, `--segundo-plano`, `--checar`, `--aviso ligar` ou `desligar`, `--voltar <pasta>` | [ATUALIZAR.md](../ATUALIZAR.md), [AVISO-DE-ATUALIZACAO.md](../AVISO-DE-ATUALIZACAO.md) |
| `dgclaw backup` | Faz um backup conferido em `/var/backups/dgclaw/<data>-manual`. Opções: `--sem-casas` (deixa de fora a memória e as conversas dos agentes) e `--simular` | [BACKUP.md](../BACKUP.md) |
| `dgclaw backup listar` | Lista os backups: data, motivo, versão, tamanho e se as casas dos agentes entraram | [BACKUP.md](../BACKUP.md) |
| `dgclaw restaurar` | Devolve configuração, dados e Admin de um backup, depois de guardar o estado de agora. `--simular` e `--mesmo-assim` | [BACKUP.md](../BACKUP.md) |
| `dgclaw personalizacoes levantar` | Lista o que foi personalizado no programa (registro, clone, cópias do instalador, conversas do Admin) | [PERSONALIZAR.md](../PERSONALIZAR.md) |
| `dgclaw personalizacoes conferir` | Confere o registro contra a versão nova e diz se algo cruza; não muda nada | [PERSONALIZAR.md](../PERSONALIZAR.md) |
| `dgclaw personalizacoes concluir` | Marca o levantamento pendente como concluído | [PERSONALIZAR.md](../PERSONALIZAR.md) |

### Ronda de segurança

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw seguranca ajuda` | Mostra a ajuda da ronda | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca estado` | Última rodada, próxima, se ficou parcial e quantos achados por nível (`--json`) | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca resumo` | Os achados novos, já limpos para ler (`--todos` traz todos) | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca rodar` | Faz uma rodada agora (`--sem-avisar` não manda recado ao Admin) | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca aplicar` | Aplica a ação do catálogo para um achado. Só com o sim do dono | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca desfazer` | Volta atrás numa ação aplicada, pelo número do registro | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca inventario` | O que a ronda sabe desta instalação (`--json`, `--refazer`) | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca pedido` | Executa um pedido do painel guardado em arquivo. É a unidade do systemd que chama; não é para uso manual | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |
| `dgclaw seguranca pedido-todos` | Executa a fila de pedidos do painel. Também é chamado pelo systemd | [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md) |

### Botão de emergência

Tira o servidor da internet e mantém só o acesso pelo Tailscale. Se ninguém confirmar em 5 minutos, religa sozinho.
A ordem é `simular`, `preparar`, `cortar --codigo <c>`, `confirmar`, e `religar --codigo <c>` quando passar.

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw emergencia estado` | Diz se está cortado ou normal, e o que está parado | [EMERGENCIA.md](../EMERGENCIA.md) |
| `dgclaw emergencia simular` | Mostra o plano e o arquivo do firewall, sem mudar nada | [EMERGENCIA.md](../EMERGENCIA.md) |
| `dgclaw emergencia preparar` | Gera o código de uso único (vale 2 minutos) e mostra o plano | [EMERGENCIA.md](../EMERGENCIA.md) |
| `dgclaw emergencia cortar` | Tira o servidor do ar. Exige o código; `--isolar-saida` também bloqueia a saída | [EMERGENCIA.md](../EMERGENCIA.md) |
| `dgclaw emergencia confirmar` | Cancela o religar automático | [EMERGENCIA.md](../EMERGENCIA.md) |
| `dgclaw emergencia religar` | Volta ao normal e testa que tudo voltou. Exige um código novo | [EMERGENCIA.md](../EMERGENCIA.md) |

## Comandos de dentro do agente

Rodam no container, como o usuário `agente`.

### `dgclaw-agente` (canais)

Quem: o agente de trabalho, a pedido do dono. O Admin recebe recusa (código de saída 2): ele não tem canal externo.

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw-agente canal status` | Mostra quais canais estão ligados | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram token` | Guarda o token do bot (pelo STDIN) | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram conferir` | Confere o token e mostra o `@` do bot | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram parear` | Pareia o dono com o bot (`--confirmar <chat_id>`) | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram ligar` | Liga o canal Telegram | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal telegram desligar` | Desliga o canal (`--apagar` remove a conexão) | [canais da skill](../../skills/canais/SKILL.md) |
| `dgclaw-agente canal whatsapp parear` | Pareia um número secundário e imprime só o código | [CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp permitir` | Libera o número do dono na lista de permitidos | [CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp remover` | Tira um número da lista de permitidos | [CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp ligar` | Liga a ponte do WhatsApp | [CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) |
| `dgclaw-agente canal whatsapp desligar` | Desliga a ponte (`--apagar` remove o pareamento) | [CANAL-WHATSAPP.md](../CANAL-WHATSAPP.md) |

### `dgclaw-card` (sessões paralelas)

Quem: o agente de trabalho (e o Admin), falando com o próprio runner em `127.0.0.1`. O token nunca vai na linha de comando.

| Comando | Para que serve | Detalhe |
| --- | --- | --- |
| `dgclaw-card ajuda` | Mostra o uso do comando | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card abrir` | Abre um card (sessão paralela, em outro provedor se quiser) e entrega o pedido. `--monitor` liga o vigia | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card mandar` | Manda uma mensagem a um card aberto | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card estado` | Diz em que estado o card está | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card esperar` | Espera o card responder (padrão 900 segundos) | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card ler` | Lê as últimas mensagens do card | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card listar` | Lista os cards criados por este caminho | [MODO-MONITOR.md](../MODO-MONITOR.md) |
| `dgclaw-card fechar` | Fecha o card | [MODO-MONITOR.md](../MODO-MONITOR.md) |

## Rotas do Web

Servidas pelo DG Claw Web. Quem: Dono, salvo o que a coluna disser. Colab só passa onde está escrito.

### Entrar, sair e conta

| Rota | Para que serve | Quem | Detalhe |
| --- | --- | --- | --- |
| `/api/login-estado` | Diz se o login está liberado ou trancado e por quê, para a tela de login | Público | [SEGURANCA.md](../SEGURANCA.md) |
| `/api/primeiro-acesso` | Recebe a senha nova do primeiro acesso (POST, com o código do link) | Público, com o código de uso único | [SEGURANCA.md](../SEGURANCA.md) |
| `/sair` | Encerra a sessão e volta ao `/login` | Dono, Colab | [SEGURANCA.md](../SEGURANCA.md) |
| `/api/saude` | Resposta de vida do Web: quantos agentes existem, se a lista de agentes está legível e se o login está trancado | Público | [SEGURANCA.md](../SEGURANCA.md) |
| `/api/v1/eu` | Diz quem está logado, o papel (dono ou colaborador) e se precisa trocar a senha | Dono, Colab | [COLABORADORES.md](../../web/docs/COLABORADORES.md) |
| `/api/v1/eu/senha` | O colaborador troca a própria senha (POST) | Colab | [COLABORADORES.md](../../web/docs/COLABORADORES.md) |
| `/api/v1/colaboradores` | Lista, convida (POST), reenvia convite e revoga acesso de colaboradores | **Só a sessão do dono**. Colab e Caixa recebem 403 | [COLABORADORES.md](../../web/docs/COLABORADORES.md) |
| `/api/v1/login` | Documentação do login da conta de IA dentro da conversa (`/api/v1/agents/<slug>/login`: ver, começar, mandar código, cancelar) | Dono. Colab recebe 403 | [LOGIN-NA-CONVERSA.md](../../web/docs/LOGIN-NA-CONVERSA.md) |
| `/api/v1/conectar` | Documentação da página Conectar conta | Dono, Colab (só leitura do aviso) | [CONECTAR-CONTA.md](../../web/docs/CONECTAR-CONTA.md) |
| `/api/v1/modal-login` | Guarda a escolha sobre o aviso "Faça o login nos seus agentes" (`/api/v1/modal-login/preferencia`) | Dono | [CONECTAR-CONTA.md](../../web/docs/CONECTAR-CONTA.md) |

### Conversa com os agentes

| Rota | Para que serve | Quem | Detalhe |
| --- | --- | --- | --- |
| `/api/v1/agents` | Lista os agentes (o colaborador vê só o dele) | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/messages` | Lê as mensagens da conversa | Dono, Colab (só o agente dele) | Sem documento próprio |
| `/api/v1/agents/:slug/send` | Manda mensagem ao agente | Dono, Colab | [CONVERSA.md](../CONVERSA.md) |
| `/api/v1/agents/:slug/stream` | Acompanha a conversa ao vivo | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/wait` | Espera a resposta do agente | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/upload` | Anexa um arquivo | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/permissao` | Responde a um pedido de permissão do agente | Dono, Colab (com o nome dele registrado) | [TRILHA-E-PERMISSAO.md](../../web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/agents/:slug/pergunta` | Responde a uma pergunta de escolha do agente | Dono, Colab | [TRILHA-E-PERMISSAO.md](../../web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/agents/:slug/reiniciar` | Reinicia a sessão do agente | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/avatar` | Foto do agente | Dono, Colab | Sem documento próprio |
| `/api/v1/agents/:slug/compartilhados` | Acervo de mídias e arquivos da conversa | Dono, Colab | [MIDIAS-CACHE.md](../../web/docs/MIDIAS-CACHE.md) |
| `/api/v1/agents/:slug/lido` | Marca a conversa como lida até uma mensagem | Dono, Colab | [ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/nao-lido` | Marca (POST) ou desmarca (DELETE) a conversa como não lida | Dono, Colab | [ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/vendo` | Avisa que a pessoa está olhando a conversa, para não notificar à toa | Dono, Colab | [ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/agents/:slug/comandos` | Catálogo de comandos de barra do agente | Dono. Colab recebe 403 | [COMANDOS-DE-BARRA.md](../../web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/agents/:slug/comando` | Executa um comando de barra | Dono. Colab recebe 403 | [COMANDOS-DE-BARRA.md](../../web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/agents/:slug/alertas` | Alertas da conversa (listar, reconhecer em `/visto`, ler a mensagem de origem) | Dono, Colab | [ALERTAS.md](../../web/docs/ALERTAS.md) |
| `/api/v1/alertas` | Documentação dos alertas da conversa | Dono, Colab | [ALERTAS.md](../../web/docs/ALERTAS.md) |
| `/api/v1/comandos` | Documentação dos comandos de barra | Dono, Colab | [COMANDOS-DE-BARRA.md](../../web/docs/COMANDOS-DE-BARRA.md) |
| `/api/v1/trilha` | Documentação da trilha de ações e das permissões | Dono, Colab | [TRILHA-E-PERMISSAO.md](../../web/docs/TRILHA-E-PERMISSAO.md) |
| `/api/v1/nao-lidas` | Quantas mensagens não lidas cada agente tem | Dono, Colab (só o dele) | [ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/estados` | Estado de cada agente (trabalhando, precisa de você, terminou, ocioso, sem sinal) | Dono. Caixa recebe 403 | [ESTADO-DOS-AGENTES.md](../../web/docs/ESTADO-DOS-AGENTES.md) |
| `/api/v1/compartilhados` | Documentação do acervo de mídias | Dono, Colab | [MIDIAS-CACHE.md](../../web/docs/MIDIAS-CACHE.md) |
| `/api/v1/media` | Entrega uma mídia da conversa (`/api/v1/media/:id`, miniatura, e `/visual` para os visuais) | Dono, Colab (só mídia do agente dele) | [MIDIAS-CACHE.md](../../web/docs/MIDIAS-CACHE.md) |
| `/api/v1/transcribe` | Transcreve um áudio (POST) | Dono, Colab | Sem documento próprio (citado em [COLABORADORES.md](../../web/docs/COLABORADORES.md)) |
| `/api/v1/tts` | Lê um texto em voz alta (POST); `/api/v1/tts/cota` mostra a cota de voz | Dono, Colab | [CONVERSA.md](../CONVERSA.md) |
| `/api/v1/sigilo` | Pede ao modelo a lista de trechos a esconder no modo escondido (POST); `/api/v1/sigilo/estado` diz se o modelo está ligado | Dono | [MODO-ESCONDIDO.md](../MODO-ESCONDIDO.md), [SIGILO.md](../../web/docs/SIGILO.md) |

### Funções da caixa inteira

| Rota | Para que serve | Quem | Detalhe |
| --- | --- | --- | --- |
| `/api/v1/lembretes` | Lembretes (listar, criar, editar, pausar, retomar, apagar; `/disparar` manda um agora; confirmar ou adiar uma ocorrência) | Dono, Caixa (cada agente mexe nos próprios) | [LEMBRETES.md](../../web/docs/LEMBRETES.md) |
| `/api/v1/foco` | Modo foco: a lista de itens de cada agente (ler, trocar, acrescentar, ticar, apagar) e os eventos de mudança | Dono, Caixa | [MODO-FOCO.md](../../web/docs/MODO-FOCO.md) |
| `/api/v1/tarefas` | Mesa de tarefas | Dono (todas), Caixa (cria para si, altera as próprias) | [MESA.md](../../web/docs/MESA.md) |
| `/api/v1/uso` | Quanto da assinatura de cada agente já foi usado (`null` é "não medido") | Dono, Caixa (só o próprio agente) | [USO-DA-ASSINATURA.md](../../web/docs/USO-DA-ASSINATURA.md) |
| `/api/v1/avisos` | Quadro de avisos entre os agentes e o dono (postar, ler, retirar); `/injecao` mostra o texto que entra na conversa do agente e `/preferencias` as preferências do dono que estão valendo | Dono, Caixa | [QUADRO-DE-AVISOS.md](../QUADRO-DE-AVISOS.md) |
| `/api/v1/caixa` | Documentação da caixa do agente | Dono, Colab | [CAIXA-DO-AGENTE.md](../CAIXA-DO-AGENTE.md) |
| `/api/v1/cofre` | Documentação do cofre na conversa (o cofre em si é do painel de cada agente) | Dono, Caixa (só a documentação) | [COFRE-NA-CONVERSA.md](../COFRE-NA-CONVERSA.md) |
| `/api/v1/anonimizar` | Anonimização de documentos: `/estado`, `/testar`, `/detector/instalar`, e por agente a configuração, a tabela, os documentos e `/final/:id` | Dono. A documentação é pública | [ANONIMIZAR.md](../../web/docs/ANONIMIZAR.md) |
| `/api/v1/push` | Avisos no aparelho: chave, inscrições, preferências e teste | Dono | [AVISOS-NO-APARELHO.md](../../web/docs/AVISOS-NO-APARELHO.md) |
| `/api/v1/onboarding` | Pedido do primeiro agente feito pelo Admin: acompanhar (GET) e criar (POST); `/animacao-vista` e `/cartao-dispensado` | Dono | [PRIMEIRO-AGENTE.md](../../web/docs/PRIMEIRO-AGENTE.md) |
| `/api/v1/manual` | Páginas deste manual em texto (`/api/v1/manual/:nome.md`); o índice público é `/api/v1/manual/docs.md` | Dono, Caixa. Só o índice é público | [README do manual](README.md) |
| `/manual` | Tela de leitura do manual | Dono | [README do manual](README.md) |

### Atualização e segurança

| Rota | Para que serve | Quem | Detalhe |
| --- | --- | --- | --- |
| `/api/v1/atualizacao` | Diz se há versão nova e o resumo do que mudou; `/descansar` (POST com o commit publicado) dispensa a faixa até sair outra | Dono. Caixa recebe 403 | [ATUALIZACAO.md](../../web/docs/ATUALIZACAO.md) |
| `/api/v1/seguranca` | Avisos de segurança do DG Claw: `/boletins`, e por id `/adiar` e `/dispensar` | Dono. Caixa recebe 403 | [SEGURANCA-BOLETINS.md](../../web/docs/SEGURANCA-BOLETINS.md) |
| `/api/v1/seguranca/ronda` | Resultado da ronda e os pedidos de aplicar, agendar e desfazer (`/ronda/:id/aplicar`) | Dono | [RONDA-PAINEL.md](../../web/docs/RONDA-PAINEL.md) |
| `/api/v1/seguranca/emergencia` | Estado do botão de emergência e os pedidos `preparar`, `cortar` e `religar` | Dono | [RONDA-PAINEL.md](../../web/docs/RONDA-PAINEL.md) |

### Entrada de páginas

Telas servidas pelo Web. Todas pedem login, salvo `/login` e `/primeiro-acesso`.

| Endereço | Para que serve | Quem |
| --- | --- | --- |
| `/login` | Tela de entrada | Público |
| `/primeiro-acesso` | Tela para cadastrar a senha pelo link de uso único | Público, com o código |
| `/trocar-senha` | Troca da senha temporária do colaborador | Colab |
| `/seguranca` | Tela Segurança: avisos, ronda e botão de emergência | Dono |
| `/p/:slug` | Repassa ao painel do agente (`/p/<slug>/`), com o segredo do proxy | Dono, Colab (só o agente dele, com escrita limitada) |

## Rotas do painel de cada agente

Cada agente tem um painel próprio. O Dono chega por `/p/<slug>/`; o Admin e outros assistentes chegam com uma
**Chave** (`dgc_...`) do agente. Quem: Dono e Chave, salvo o que a linha disser. O colaborador só lê, e fica
sem o cofre, as chaves de API, a conta de IA, a Tela, as credenciais de canal, o chat e o socorro
([COLABORADORES.md](../../web/docs/COLABORADORES.md)).

### Núcleo, saúde e socorro

| Rota | Para que serve | Detalhe |
| --- | --- | --- |
| `GET /` | Abre a página inicial do painel (também `GET /index.html`) | Sem documento próprio |
| `GET /login.html` | Tela de login do painel quando se entra direto nele | [SEGURANCA.md](../SEGURANCA.md) |
| `POST /login` | Entra no painel pela senha | [SEGURANCA.md](../SEGURANCA.md) |
| `POST /logout` | Sai do painel; `GET /logout` só leva à tela de login | [SEGURANCA.md](../SEGURANCA.md) |
| `GET /api/agents` | O agente desta máquina para o seletor do menu | Sem documento próprio |
| `GET /api/config` | Configuração do painel e quais blocos acender | Sem documento próprio |
| `GET /api/overview` | Resumo de humor, sessão, posts do dia e pendências para a aba Status | Sem documento próprio |
| `GET /api/powers` | Lista dos poderes (powers) e se estão instalados | Sem documento próprio |
| `GET /api/emotions` | Estado das emoções; vazio se a extensão DG Alive não estiver instalada | Sem documento próprio |
| `GET /api/thoughts` | Pensamentos (presente, passado recente e futuro), metas e proatividade do agente | Sem documento próprio |
| `GET /api/saude` | Diagnóstico da resposta do agente (`ativo`, `atencao`, `inativo`, `indeterminado`) | [SAUDE-E-MODO-SEGURO.md](../SAUDE-E-MODO-SEGURO.md) |
| `POST /api/saude/reiniciar` | Reinicia o agente, normal ou em modo de segurança | [SAUDE-E-MODO-SEGURO.md](../SAUDE-E-MODO-SEGURO.md) (a tela do botão; a rota não está listada) |
| `GET /api/socorro/estado` | Estado da sessão de socorro | [SOCORRO.md](../../panel/docs/SOCORRO.md) |
| `POST /api/socorro/mensagem` | Fala com o Claude de socorro | [SOCORRO.md](../../panel/docs/SOCORRO.md) |
| `POST /api/socorro/encerrar` | Encerra a sessão de socorro | [SOCORRO.md](../../panel/docs/SOCORRO.md) |
| `GET /api/pulso` | Saúde operacional dos componentes do agente | [OPERACOES.md](../../panel/docs/OPERACOES.md) |

### Conversa e sessões

| Rota | Para que serve | Detalhe |
| --- | --- | --- |
| `GET /api/chat/mensagens` | Lê as mensagens da aba Conversa | Sem documento próprio |
| `POST /api/chat/mensagem` | Manda uma mensagem ao agente | Sem documento próprio |
| `POST /api/chat/parar` | Interrompe o turno em andamento | Sem documento próprio |
| `POST /api/chat/reativar` | Reativa a sessão parada | Sem documento próprio |
| `POST /api/chat/transcrever` | Transcreve um áudio (o colaborador também pode) | Sem documento próprio |
| `/api/sessoes` | Lista, cria e comanda as sessões do agente. Aceita qualquer método; os caminhos que levam o código de uma sessão servem para arquivar, apagar, decidir, recado, tecla, retomar, handoff, anexo e outros | [SESSOES.md](../../panel/docs/SESSOES.md) |
| `GET /api/sessoes-config` | Configuração da aba Sessões | [SESSOES.md](../../panel/docs/SESSOES.md) |
| `GET /api/costs/overview` | Custos: visão geral | Sem documento próprio |
| `GET /api/costs/executions` | Custos: lista de execuções | Sem documento próprio |
| `GET /api/costs/execution/:sessionId` | Custos: detalhe de uma execução | Sem documento próprio |
| `POST /api/costs/analyze` | Pede a análise dos custos | Sem documento próprio |

### Memória, rotinas e operações

| Rota | Para que serve | Detalhe |
| --- | --- | --- |
| `GET /api/memory` | Lista os arquivos de memória | Sem documento próprio |
| `GET /api/memory/file` | Lê um arquivo de memória (com teto de tamanho) | Sem documento próprio |
| `GET /api/memoria/arquivo` | Lê um arquivo da memória pelo leitor do painel | [CEREBRO.md](../../panel/docs/CEREBRO.md) |
| `PUT /api/memoria/arquivo` | Edita um arquivo de memória. Vira instrução permanente; só o Dono e a Chave | [CEREBRO.md](../../panel/docs/CEREBRO.md) |
| `GET /api/working-memory` | A memória de trabalho do agente | [MEMORIA-DE-TRABALHO.md](../../panel/docs/MEMORIA-DE-TRABALHO.md) |
| `GET /api/working-memory/status` | Saúde da memória de trabalho para o cartão do Status | [MEMORIA-DE-TRABALHO.md](../../panel/docs/MEMORIA-DE-TRABALHO.md) |
| `GET /api/personality` | A personalidade do agente | Sem documento próprio |
| `GET /api/personality/changelog` | Histórico de mudanças da personalidade | Sem documento próprio |
| `GET /api/identity` | Os arquivos de identidade que o leitor abre | Sem documento próprio |
| `GET /api/diary` | O diário do agente | Sem documento próprio |
| `GET /api/cerebro` | Raio-X da memória: os arquivos que o agente lê, reunidos numa tela | [CEREBRO.md](../../panel/docs/CEREBRO.md) |
| `GET /api/radiografia` | O texto "Como o seu agente funciona por dentro" (a radiografia), lido da cópia instalada | [RADIOGRAFIA.md](../RADIOGRAFIA.md) |
| `GET /api/operacoes` | Operações do sistema, em quadradinhos | [OPERACOES.md](../../panel/docs/OPERACOES.md) |
| `GET /api/operations/crons` | Lista as rotinas fixas | Sem documento próprio |
| `GET /api/operations/logs` | Lê os logs do agente | Sem documento próprio |
| `GET /api/operations/session` | Estado da sessão para a aba Operações | Sem documento próprio |
| `GET /api/rotinas` | A agenda: timers que existem no systemd agora | Sem documento próprio |
| `GET /api/rotinas/usuario` | As rotinas criadas pelo dono ou pelo agente | [OPERACOES.md](../../panel/docs/OPERACOES.md) |
| `GET /api/skills` | As skills do agente, lidas do disco | Sem documento próprio |

### Arquivos e apps

| Rota | Para que serve | Detalhe |
| --- | --- | --- |
| `GET /api/arquivos` | Lista a pasta do agente | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `PUT /api/arquivos` | Grava um arquivo de texto (até 2 MB) | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `DELETE /api/arquivos` | Apaga um arquivo ou pasta | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/arquivos/conteudo` | Lê o conteúdo de um arquivo | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/arquivos/baixar` | Baixa um arquivo | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `POST /api/arquivos/upload` | Envia um arquivo para a pasta | [PASTA-E-ASSETS.md](../../panel/docs/PASTA-E-ASSETS.md) |
| `GET /api/apps` | Lista os apps do agente | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos` | Lista os conteúdos de um app | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug` | Detalhe de um conteúdo | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/assets` | Lista os assets de um conteúdo | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/asset/:nome` | Abre um asset | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `GET /api/apps/:app/conteudos/:slug/arquivo/:nome` | Abre um arquivo do conteúdo | [ABA-APPS.md](../../panel/docs/ABA-APPS.md) |
| `POST /api/apps/:app/conteudos/:slug/compartilhar` | Publica o roteiro de um conteúdo como um arquivo HTML único e devolve o link para mandar a quem não tem senha | Sem documento próprio |

### Cofre, chaves de API, conta de IA e Tela

| Rota | Para que serve | Quem | Detalhe |
| --- | --- | --- | --- |
| `GET /api/cofre` | Lista as chaves guardadas (quem guardou, quando, 4 últimos caracteres; nunca o valor) | Dono, Chave | [COFRE.md](../../panel/docs/COFRE.md) |
| `POST /api/cofre` | Guarda uma chave; com `aplicar: true` reinicia o agente na mesma chamada | Dono, Chave | [COFRE-POR-API.md](../COFRE-POR-API.md) |
| `DELETE /api/cofre` | Revoga uma chave guardada | Dono, Chave | [COFRE.md](../../panel/docs/COFRE.md) |
| `POST /api/cofre/aplicar` | Reinicia o agente para ele usar o cofre | Dono, Chave | [COFRE-POR-API.md](../COFRE-POR-API.md) |
| `GET /api/chaves-api` | Lista as chaves de API do painel | **Só o Dono com sessão**. Chave recebe 403 | [COFRE.md](../../panel/docs/COFRE.md) |
| `POST /api/chaves-api` | Cria uma chave de API (o valor aparece só na resposta) | **Só o Dono com sessão** | [COFRE.md](../../panel/docs/COFRE.md) |
| `DELETE /api/chaves-api` | Revoga uma chave de API (datando, sem apagar o registro) | **Só o Dono com sessão** | [COFRE.md](../../panel/docs/COFRE.md) |
| `GET /api/provedor` | Provedor, modelo e forma de pagamento do agente | Dono, Chave. Colab recebe 403 | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor` | Muda o provedor, o modelo ou a forma de pagamento | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/provedor/login` | Estado do login da conta de IA, com link e código | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor/login` | Começa o login da conta | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `POST /api/provedor/login/codigo` | Entrega o código que a conta devolveu | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `DELETE /api/provedor/login` | Cancela o login em andamento | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/uso` | Uso da assinatura deste agente (janela de 5 horas e semanal) | Dono, Chave | [PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md) |
| `GET /api/tela` | Estado da Tela do agente (o navegador remoto) | Dono. Colab recebe 403 | [TELA.md](../../panel/docs/TELA.md) |
| `PUT /api/tela/senha` | Troca a senha da Tela | **Só o Dono com sessão**. Chave recebe 403 | [TELA.md](../../panel/docs/TELA.md) |
| `GET /tela/novnc/*` | Arquivos do cliente noVNC da Tela | Dono | [TELA.md](../../panel/docs/TELA.md) |
| `WS /tela/websockify` | Canal de vídeo da Tela. Chave não abre | **Só o Dono com sessão** | [TELA.md](../../panel/docs/TELA.md) |

### Poderes: Instagram e reuniões

Exigem o poder instalado; sem ele a aba aparece com cadeado e a rota responde 423.

| Rota | Para que serve | Detalhe |
| --- | --- | --- |
| `GET /api/posts` | Posts do Instagram (poder `instagram`) | [POWER.md](../../powers/instagram/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/posts/stats` | Números dos posts | [POWER.md](../../powers/instagram/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/comments/recent` | Comentários recentes | [POWER.md](../../powers/instagram/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/followers/top` | Seguidores que mais interagem | [POWER.md](../../powers/instagram/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/followers/stats` | Números dos seguidores | [POWER.md](../../powers/instagram/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/reunioes` | Lista as reuniões gravadas (poder `meetings`) | [POWER.md](../../powers/meetings/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/reunioes/:id` | Detalhe de uma reunião | [POWER.md](../../powers/meetings/POWER.md) (descreve o poder; as rotas não têm documento) |
| `GET /api/reunioes/:id/audio.wav` | O áudio da reunião | [POWER.md](../../powers/meetings/POWER.md) (descreve o poder; as rotas não têm documento) |

<!-- inventario:fim -->

## O que ainda não está aqui

Itens que o código tem e ainda não têm documento próprio estão em [pendencias.md](pendencias.md). As funções
que ainda não chegaram à `main` estão em [em-desenvolvimento.md](em-desenvolvimento.md).
