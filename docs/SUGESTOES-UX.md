# DG Claw: sugestões de usabilidade (consolidado)

Data: 18/10/2026. Nada aqui foi aplicado no código. O Danilo escolhe o que entra.

## 1. Como foi feita

Duas avaliações independentes, feitas como uma pessoa leiga (aluna de curso de IA) faria: só leitura, sem enviar, criar, aprovar ou salvar nada. Uma cobriu o web (Conversa, Mesa, Lembretes, Avisos, Sessões, menu lateral e as visitas guiadas). A outra cobriu as 13 abas do painel do agente. As duas rodaram numa VPS de teste, com o agente Tina, em 1440 e em 390 de largura. Os relatórios de origem e os prints ficam em `/root/claude/qa-dgclaw-padrao/ux/` (`web.md`, `painel.md`). Este documento junta os dois, tira as duplicatas, separa os defeitos das sugestões de gosto e coloca tudo numa ordem de prioridade.

Legenda de esforço: P (pequeno, texto ou ajuste de CSS), M (médio, mexe em uma tela), G (grande, mexe em várias telas ou na estrutura).

---

## 2. Defeitos encontrados no caminho

Estes são bugs ou contradições, não questão de gosto. Valem a correção mesmo que nenhuma sugestão de texto seja aceita.

| # | Tela | O que acontece | Suspeita de causa |
| --- | --- | --- | --- |
| D1 | Painel, Socorro | A página abre completamente em branco: só o cabeçalho "Socorro" e "Ativo 12:39". Sem título, texto, botão nem mensagem de erro. A aba "Como funciona" manda a pessoa para o socorro quando algo dá errado. | O terminal de socorro não carrega e a tela não mostra o motivo (nenhum estado de erro). |
| D2 | Painel, Operações, Custos, Personalidade, Memória, Identidade, Como funciona | O botão "?" da seção não abre nada visível. Em Status, Cofre e Pasta ele abre o passo certo. | A visita da aba não encontra o passo da seção, e o "?" fica sem destino. |
| D3 | Painel, Aplicativos e Socorro | O botão "Tutorial" do cabeçalho não abre visita nenhuma. Nas outras abas abre. | Essas duas abas não têm visita escrita. |
| D4 | Web, Conversa e Sessões (e tutoriais em geral) | A numeração pula. No computador: "Passo 8 de 20" vai direto para "Passo 10 de 20". Em Sessões: "Passo 4 de 5" aparece logo depois do 2. | O passo que aponta para um elemento que só existe no celular (ou só no computador) some, mas o total e o contador não são recalculados. |
| D5 | Web, Conversa, tutorial | O texto manda apertar a "seta verde" para enviar. Na tela os botões de enviar e de microfone são azuis. | Texto antigo, escrito antes da mudança de cor. |
| D6 | Web, Sessões | O cartão tem bolinha vermelha ao lado do nome e o texto verde "Concluído". A visita diz que a bolinha vermelha significa "espera uma decisão sua", e o cartão não espera nada. | A bolinha usa um estado diferente do rótulo (cor e texto saem de fontes distintas). |
| D7 | Web, Sessões | O grupo "Ativas (1)" lista uma sessão "Concluído", e "Concluídas (1)" mostra a mesma. Os dois números contam a mesma sessão. | A regra de "ativa" inclui sessões abertas que já terminaram. |
| D8 | Web, Sessões e Lembretes (e selo "Ativo 12:39" do painel) | Horas diferentes na mesma instalação: Lembretes mostra "Fuso: UTC" e "15:38", Sessões mostra 12:49 (hora de Brasília). | Uma tela usa o fuso do servidor, outra o do aparelho. |
| D9 | Painel, Personalidade | O cartão "Big Five" aparece em branco. Em "Comportamento", Iniciativa, Humor, Curiosidade e Teimosia mostram "0/10" com barras vazias. O subtítulo fala em "nove números", e a visita diz que cada barra vai de 0 a 100. | Valor não medido sendo desenhado como zero, e escalas diferentes entre tela e texto (10 contra 100). |
| D10 | Painel, Status | "Último sinal: nenhuma sessão viva registrada até agora" aparece ao lado do selo verde "Ativo". | O selo e o cartão leem fontes diferentes. |
| D11 | Painel, Status e Operações | O alerta "1 operação pede atenção: Esta tela" e, dentro de Operações, "o sistema não conhece a unidade dgclaw-panel-tina.service". O próprio painel é contado como operação com problema, mesmo com a pessoa lendo a tela. | A checagem do serviço do painel procura um nome de unidade que não existe nessa instalação. |
| D12 | Painel, Operações | Cada linha diz "a última vez que rodou foi há 3 min" e, logo abaixo, "sem histórico para mostrar". O resumo diz "1 de 17 funcionando, 15 ainda sem dado". | Mistura de "rodou, mas ainda sem 7 dias de histórico" com "nunca rodou", no mesmo texto. |
| D13 | Painel, Status | Os cartões de memória mostram JSON cru (`{ "atualizado": "2026-10-17", "pessoas": [ ...`) e comentário HTML solto (`<!-- O momento em que Tina ganhou vida ... -->`). | O cartão exibe o arquivo sem tratar o formato. |
| D14 | Web, Sessões | A última fala da sessão no cartão é cortada no meio da palavra no computador ("...nesta caixa nov") e termina em reticências no celular. | Corte por número de caracteres, não por palavra. |
| D15 | Web, Lembretes | Com os avisos bloqueados no navegador, o botão verde "Ativar avisos neste aparelho" continua verde e clicável, mas o clique não adianta. O botão "Mandar aviso de teste" some apagado sem dizer por quê. | O estado "bloqueado" não desativa o botão nem mostra motivo. |
| D16 | Web, Mesa | O campo de data de fechamento mostra "mm/dd/yyyy" (inglês, mês primeiro). | Campo de data usando o idioma do navegador de teste. Forçar o formato dd/mm/aaaa. |
| D17 | Web, menu lateral | Ícone da Conversa é um pontinho quase invisível e o da Personalidade parece quebrado. Os outros têm tamanhos e estilos diferentes. | Família de ícones misturada. |
| D18 | Painel, Status | O cartão "Metas" mostra "goals: 13h atrás" em inglês e em vermelho, mas não há problema: apenas não existem metas de curto prazo. | Cor de alerta aplicada a um estado normal. |

Total: 18 defeitos.

---

## 3. Temas que se repetem (padronização)

Cada tema aparece em várias telas. A proposta é uma regra única para cada um, para decidir uma vez e aplicar em todo lugar.

### T1. Três botões "Tutorial" por tela
Aparecem um na lateral (embaixo do nome do agente), um no cabeçalho e, em Sessões, Cofre e Pasta, um terceiro ao lado do título. Na Conversa os dois primeiros abrem a mesma visita de 20 passos. Em outras telas abrem coisas diferentes.
**Regra:** um único botão "Tutorial" por tela, no cabeçalho, ao lado do título. O da lateral sai (o menu vira o primeiro passo da visita da tela, ou ganha o nome "Tour do menu" se for mantido).

### T2. Visitas longas e cheias de jargão
Passos de 60 a 120 palavras, com três blocos ("O que é", "Como funciona", "Por que está aqui"). No celular o cartão ocupa metade da tela. Aparecem palavras como servidor, runner, injetado, turno livre, plugin, token, cifrada, "regrava o quadro na casa do agente", "dgclaw-card", "chave de API", "fuso do servidor".
**Regra:** cada passo tem no máximo 40 palavras no total. O "Por que está aqui" tem uma frase e some quando a razão é óbvia. O detalhe técnico vai para um "Saiba mais" recolhido. Cada visita é revisada contra a lista de palavras proibidas do glossário abaixo.

### T3. Visita única de 20 passos na Conversa
A pessoa nova abandona antes do passo 10.
**Regra:** nenhuma visita passa de 8 passos. A Conversa se divide em três: "Conversar" (barra, comandos, voz), "Atalhos do topo" (Painel, Mesa, Sessões, Lembretes num passo só) e "Recursos extras" (modo escondido, mídias, instalar o app).

### T4. Explicação fixa na tela e "?" que repete a mesma coisa
O texto de cada seção fica sempre aberto, e o "?" abre uma visita que diz o mesmo com mais palavras. Em outras abas o "?" nem abre nada (D2).
**Regra:** a seção tem uma frase fixa de uma linha. O "?" abre o passo da própria seção, e toda seção que tem "?" tem passo. Sem passo, sem botão.

### T5. Termos técnicos, em inglês e nomes que mudam
Skills, Rotinas, Operações, runner, working memory, MEMORY.md, Big Five, "card" e "sessão", "motor", "modelo padrão", "pasta", "gaveta do agente".
**Regra:** um nome por coisa, em português, igual no menu, no título, na visita e na conversa. Nome de arquivo ou de unidade técnica só aparece em "ver detalhes". O glossário abaixo é a fonte única.

### T6. Nomes internos e histórias de desenvolvimento vazando para o aluno
O passo da Pasta fala do que "só o Danilo alcança". O passo do Cofre conta que "em agosto de 2026 descobriu-se que um cofre antigo entregava quase todas as chaves". "Dono" aparece como papel do usuário (Mesa).
**Regra:** nenhum nome de pessoa da equipe e nenhuma história do desenvolvimento nos textos do produto. O usuário é sempre "você". Revisar todos os textos com uma busca por "Danilo", "Admin" (quando não for o agente), "dono" e datas de 2026.

### T7. Ícones sem rótulo no celular
No topo da Conversa, cinco ícones soltos (🦞 📋 🖥 ⏰ 👁). "🖥 Sessões" vira só o ícone ao lado do "Tutorial". Os "?" têm cerca de 24 px.
**Regra:** todo botão de ação no celular tem ícone e texto curto (ou o ícone vem com um balãozinho ao tocar). Alvo de toque mínimo de 32 px. O botão 🖥 Sessões não repete o item que já está no menu.

### T8. Números sem explicação
"0 paradas", "0 travadas", "Ocupação do teto 51% de 9.000 bytes", "$0.0971", "$13.69", "0/10", "Passo 8 de 20", "Ativo 12:39".
**Regra:** todo número vem com a unidade e uma frase de contexto na própria tela ("US$ 13,69 de uso este mês, já incluído na assinatura"). Dinheiro com vírgula e "US$". Se o dado não foi medido, o texto é "ainda sem medida", nunca 0.

### T9. Telas vazias que assustam ou ficam mudas
Operações ("15 sem histórico"), Personalidade (0/10), Aplicativos, Identidade, Rotinas, Socorro.
**Regra:** todo estado vazio diz o que é normal ("instalação nova, isso aparece depois do primeiro dia") e oferece um botão que leva à Conversa com o pedido já escrito.

### T10. Duas portas para o mesmo lugar
"Avisos" é aba da Mesa e item do menu. "Painel" no topo abre o que o menu chama de Status. "Mesa", "Mesa de tarefas" e "Tarefas". A mesma frase de Sessões dita quatro vezes.
**Regra:** um lugar, um nome, um caminho principal. Atalho no topo só se o nome for idêntico ao do menu.

### Glossário sugerido

| Termo atual | Nome sugerido |
| --- | --- |
| Skills | Habilidades |
| Rotinas (as que a pessoa pede) | Tarefas automáticas |
| Operações | Funcionamento (ou "Saúde do agente") |
| Rotinas do sistema (em Operações) | Verificações internas |
| runner | (cortar; se for preciso: "o programa que mantém as sessões abertas") |
| working memory, working-memory.md | Anotações do dia |
| MEMORY.md, "a memória longa" | Memória de longo prazo |
| relationships.json | Pessoas que ele conhece |
| skills-candidatas.md | Receitas que podem virar habilidades |
| Ocupação do teto, bytes | Espaço usado (em %) |
| Big Five | Traços de personalidade |
| condescendente / reativo a pressão | gentil / sensível ao estresse |
| Card (sessão) | Sessão |
| Motor do card | Qual IA vai trabalhar |
| Claude (modelo padrão), na assinatura | Usa o Claude da sua assinatura |
| Cofre (chaves) | Cofre de chaves |
| chave de API (para outro assistente) | Chave de acesso para outro assistente (avançado) |
| setup-token | (cortar da lista; explicar no passo) |
| Admin (o agente) | Admin (manter, mas explicar na primeira vez: "o agente que cuida do servidor") |
| Dono (na Mesa) | Você |
| paradas (Mesa) | sem novidade |
| travadas (Mesa) | com problema |
| Pasta do agente, gaveta do agente | Pasta do agente (sempre) |
| Insistir | Repetir |
| agendador | (cortar; se for preciso: "o relógio do sistema") |
| injetado, turno livre, casa do agente | (cortar) |
| Registros (em Operações) | Registros técnicos (para enviar a quem ajuda) |
| Recado entregue / Chegou para... | Já pode ler / Foi avisado na hora |

---

## 4. Lista priorizada

Os defeitos da seção 2 devem ser corrigidos primeiro, qualquer que seja a ordem abaixo. A coluna "Ref" aponta o defeito, o tema ou o item de origem.

### ALTA (atrapalha usar)

| # | Prio | Tela | O que está | Sugestão concreta | Esforço |
| --- | --- | --- | --- | --- | --- |
| 1 | ALTA | Painel, Socorro | Página em branco (D1) | Título "Socorro" e texto: "Se o seu agente parar de responder, é aqui que a gente resolve. Abra o socorro e escreva: 'aconteceu alguma coisa com o meu agente, vê aí'." Botão "Abrir socorro". Se o terminal não carregar, mostrar o motivo e o que fazer. | M |
| 2 | ALTA | Todas | Três botões "Tutorial" por tela (T1) | Um só "Tutorial" no cabeçalho. O da lateral sai ou vira "Tour do menu". | P |
| 3 | ALTA | Todas as visitas | Passos de 60 a 120 palavras com jargão (T2) | Máximo de 40 palavras por passo, "Por que está aqui" em uma frase, detalhe em "Saiba mais". Revisar todos os textos contra o glossário. | G |
| 4 | ALTA | Painel, 6 abas e Aplicativos/Socorro | "?" e "Tutorial" que não abrem nada (D2, D3) | Escrever o passo de cada "?" e as visitas de Aplicativos e Socorro. Onde não houver passo, esconder o botão. | M |
| 5 | ALTA | Menu lateral | 17 itens em fila única: "Cofre (chaves)", "Operações", "Rotinas", "Skills", "Socorro" | Agrupar em três blocos: "Conversa e trabalho" (Conversa, Mesa de tarefas, Sessões, Lembretes, Avisos), "Conhecer o agente" (Status, Memória, Identidade, Personalidade, Como funciona) e "Ajustes" (Habilidades, Tarefas automáticas, Cofre de chaves, Pasta do agente, Aplicativos, Funcionamento, Custos, Socorro). Uma linha de apoio ao passar o mouse. | M |
| 6 | ALTA | Conversa, topo no celular | Cinco ícones sem texto: "🦞 📋 🖥 ⏰ 👁" | Ícone com rótulo curto embaixo: "Painel", "Mesa", "Sessões", "Lembretes", "Esconder". Trocar a lagosta por um ícone de painel de controle. | M |
| 7 | ALTA | Conversa, topo | "👁 mostrando" | Desligado: "👁 Esconder dados". Ligado: "👁 Dados escondidos". Tooltip: "Esconde nomes, valores e contatos para você mostrar a tela." | P |
| 8 | ALTA | Conversa, lista ao digitar "/" | 12 comandos cinzas repetindo "Abre uma tela de configuração no terminal. Configure pelo painel do agente..." | Mostrar só o que funciona aqui (/compact, /clear, /context, /cost e as habilidades). Juntar o resto num bloco recolhido "Só no terminal", com a frase uma única vez. | M |
| 9 | ALTA | Sessões | Bolinha vermelha com "Concluído" verde, "Ativas (1)" com uma sessão concluída, "Ativo 12:39" solto (D6, D7, D8) | Verde para concluído, vermelho só para "esperando você". "Ativas" mostra só as abertas (trabalhando ou esperando). Trocar "Ativo 12:39" por "Atualizado às 12:39". Mesmo fuso em todas as telas. | M |
| 10 | ALTA | Sessões | A mesma ideia dita quatro vezes e "card" ao lado de "sessão" (T10, T5) | Um título ("Sessões"), uma frase ("Conversas que andam em paralelo com a principal. Veja o que cada uma faz, aprove pedidos e crie sessões novas."), um "Tutorial". Usar só "sessão" nos botões e campos ("Pedido para a sessão"). | P |
| 11 | ALTA | Mesa | Cinco controles sem rótulo: "Admin", "Tina", "Hoje", "Todos", "mm/dd/yyyy" (M2, D16) | Colocar "Agentes:" antes de Admin e Tina, "Fechadas em:" antes de Hoje, Todos e a data. Data em dd/mm/aaaa. | P |
| 12 | ALTA | Mesa e Avisos | "Avisos" é aba da Mesa e também item do menu (M1, A13) | Manter uma porta só. Se a aba da Mesa é a mesma tela do menu, tirar uma das duas e usar o mesmo nome nos dois lugares. | M |
| 13 | ALTA | Lembretes | "Daqui a quantos minutos", "Insistir de quantos em quantos minutos", "Máximo de avisos por vez" e "Daqui a N minutos" | Rótulos: "Avisar daqui a" (30 min), "Repetir a cada" (5 min), "Parar de repetir depois de" (12 avisos). Opções de "Quando": "Daqui a alguns minutos", "Uma vez, em data e hora", "Todo dia", "Toda semana", "A cada alguns dias". | P |
| 14 | ALTA | Lembretes | O primeiro cartão é "Avisos neste aparelho", em tom de erro (D15) | Colocar "Novo lembrete" primeiro. Se o navegador bloqueou, o botão "Ativar" fica apagado com o motivo ao lado ("O navegador bloqueou. Toque no cadeado ao lado do endereço, depois Notificações, depois Permitir."). O teste só aparece quando os avisos estiverem ligados. | P |
| 15 | ALTA | Lembretes | "Fuso: UTC. Última conferência do agendador: 18/10/2026 15:38 (confere a cada 15 s)." (D8) | Mostrar a hora do aparelho. Texto: "Os horários seguem o fuso de Brasília." Cortar "agendador" e "15 s". | P |
| 16 | ALTA | Avisos | A tela abre com o formulário "POSTAR" e sem exemplo (A1) | Frase de abertura: "Recados curtos que todos os seus agentes leem, por exemplo: 'a gente trata o cliente por você'." Lista primeiro, formulário recolhido atrás de "+ Novo aviso". | P |
| 17 | ALTA | Painel, Personalidade | Cartão em branco e "0/10" (D9) | Quando não há valor: "Ainda não definido. Peça na Conversa: 'ajusta a minha personalidade'." Usar a mesma escala na tela e na visita. | P |
| 18 | ALTA | Painel, Operações e Status | "1 de 17 funcionando, 15 ainda sem dado" e "o sistema não conhece a unidade dgclaw-panel-tina.service" (D11, D12) | Texto no topo: "Instalação nova: as verificações ainda não rodaram o suficiente para mostrar histórico. Isso é normal no primeiro dia." Não contar o painel como operação com problema. Cada linha: "Roda a cada 5 min. Última vez: há 3 min." | M |
| 19 | ALTA | Painel, Operações | Nomes como "O vigia da sessão", "O batimento", "O fichário das conversas", "O pulso do meio-dia" | Uma frase de explicação embaixo de cada ("Confere de 5 em 5 minutos se ele está ligado"). Nome técnico da unidade só em "detalhes". | M |
| 20 | ALTA | Painel, Cofre | O bloco "Quem pode guardar chaves aqui por API" vem aberto no meio da tela | Recolher como "Avançado: deixar outro assistente guardar chaves", começando fechado. | P |
| 21 | ALTA | Painel, Cofre | Guardar a chave não vale até clicar em "aplicar e reiniciar o agente", e o aviso só aparece depois | Depois de guardar, aviso no topo: "Chave guardada. Falta clicar em Aplicar para valer." com o botão ali. Dizer "Reiniciar interrompe o que ele estiver fazendo" junto ao botão. | M |
| 22 | ALTA | Painel, Cofre | Botão "revogar" sem aviso do efeito | Na confirmação: "Isto tira a chave do cofre. Para parar a cobrança, cancele a chave também no site do serviço." | P |
| 23 | ALTA | Painel, Skills | Descrições escritas para o agente: "Marca, lista e desmarca compromissos de verdade do agente NA MAQUINA... Use SEMPRE que o dono pedir..." | Mostrar só a primeira frase ("Marca tarefas para ele fazer sozinho na hora certa."). O resto fica em "Ver tudo". Caminho de pasta fora do cabeçalho. | M |
| 24 | ALTA | Painel, Custos | Coluna "TAG" com `req_011Cg9w...` em 140 linhas e "sem teto de gastos configurado" sem dizer como definir | Esconder a coluna. Texto: "Quer um limite? Peça na Conversa: 'me avisa se passar de US$ 20 no mês'." | P |
| 25 | ALTA | Painel, Status | JSON e comentário HTML crus, "Último sinal --" ao lado de "Ativo" (D10, D13) | Mostrar "Pessoas: Danilo (meu criador)" em vez do JSON e esconder comentários. "Último sinal: agora", ou "ainda sem registro (normal logo após ligar)". | M |
| 26 | ALTA | Painel, Aplicativos | "Quem instala é ele mesmo, escrevendo o arquivo .dgclaw/apps.json no espaço dele." | "Aqui ficam os mini aplicativos que ele cria para você (um quadro de tarefas, um painel...). Peça na Conversa: 'cria um aplicativo para...'." | P |
| 27 | ALTA | Painel, visitas de Pasta e Cofre | Frase com o nome do Danilo e a história de agosto de 2026 (T6) | Pasta: "Antes, para mandar um arquivo ao agente era preciso mexer no servidor. Agora é só clicar em Subir arquivo." Cofre: "Cada agente tem o próprio cofre: um agente não enxerga a chave do outro." | P |
| 28 | ALTA | Conversa, barra de digitação | Microfone azul grande e "Enviar" azul menor; o tutorial fala em "seta verde" (D5) | "Enviar" como o botão principal (maior, verde). Microfone secundário. Nos textos: "toque na seta de enviar". | P |

### MEDIA (incomoda)

| # | Prio | Tela | O que está | Sugestão concreta | Esforço |
| --- | --- | --- | --- | --- | --- |
| 29 | MEDIA | Conversa, visita | 20 passos (T3) | Dividir em três visitas de até 8 passos. Juntar Painel, Mesa, Sessões e Lembretes num passo só: "Os atalhos do topo: Painel, Mesa, Sessões e Lembretes. Cada um abre na mesma janela." | M |
| 30 | MEDIA | Conversa, menu | "Claude (modelo padrão), na assinatura" e seletor "trocar de agente ▾" discreto | Texto "Usa o Claude da sua assinatura" (ou "Usa o Codex (ChatGPT)"). O botão mostra "Tina ▾". Tirar a repetição da linha da lista (e o corte "na assi..." no celular). | P |
| 31 | MEDIA | Conversa, botões ✅ e ? | Dois ícones soltos sobre a conversa | Mostrar o número ("✅ 1") e, ao tocar, um balão: "1 entrega pronta". | P |
| 32 | MEDIA | Conversa, nomes | "Painel" abre Status; "Mesa" e "Mesa de tarefas" são o mesmo lugar | Chamar de "Status" ou "Painel do agente" (com tooltip "Status, memória e gastos da Tina") e usar "Mesa de tarefas" nos dois lugares. | P |
| 33 | MEDIA | Conversa, visita | Passos 3, 5, 17 e 20 com 70 a 110 palavras e detalhes como "//", "20 por vez, até 60 itens ou 30 dias" | Passo 5: "Digite / para ver os comandos. Toque num deles e envie. Os apagados só funcionam no terminal." Passo 17: "Esconde nomes, valores, e-mails, telefones e chaves da tela, para você mostrar numa aula. Toque num texto escondido para ver só aquele. Confira antes de gravar: não é garantia." Passo 20: "Aqui ficam as fotos, links e arquivos desta conversa. Toque para abrir." | P |
| 34 | MEDIA | Mesa | "0 paradas" e "0 travadas" sem explicação | "0 sem novidade" (tooltip: "Em andamento e sem atualização há mais de 45 minutos") e "0 com problema". | P |
| 35 | MEDIA | Mesa, visita | "em nome do dono", "Dono, 05/10 15h42", "O servidor conta a mesa inteira" | "em seu nome", "Você, 05/10 15h42", "A conta inclui todos os agentes." Cortar "Um endereço terminando em #nome-da-aba" e o passo do registro "pelo servidor": "Veja tudo o que mudou na tarefa: quem mexeu e quando." | P |
| 36 | MEDIA | Mesa | Dois "?" soltos, longe do que explicam | Um "Como funciona" no canto, ou o "?" colado ao grupo que explica. | P |
| 37 | MEDIA | Sessões | "Motor do card: Claude (o da conversa principal) / Codex" | "Qual IA vai trabalhar: Claude (a mesma da conversa) ou Codex (ChatGPT)". | P |
| 38 | MEDIA | Sessões | "Fechadas" e "Arquivadas" sem número, e a diferença entre Concluídas, Paradas, Fechadas e Arquivadas não é clara | Contagem em todos os grupos e uma legenda: "Fechadas: dormindo, acordam com um recado. Arquivadas: guardadas." | P |
| 39 | MEDIA | Sessões | "Concluído · agente · há 8 min" | "Concluída · criada pela Tina · há 8 min". | P |
| 40 | MEDIA | Sessões, celular | Duas camadas de cabeçalho; a lista só começa a 70% da tela | Reduzir a um título e uma linha. | M |
| 41 | MEDIA | Sessões, cartão | Fala cortada no meio da palavra (D14) | Cortar em palavra inteira, com "…", em duas linhas no máximo. | P |
| 42 | MEDIA | Sessões, visita | "comando dgclaw-card", "chave de API", "O estado vem do runner deste agente..." | "As sessões que o próprio agente abre também aparecem aqui." Passo 2, no lugar do "Por que": "Assim você vê quantas sessões precisam de você." | P |
| 43 | MEDIA | Lembretes | "De qual agente" e "Também avisar pelo agente (Telegram, WhatsApp)" | "Quem vai te lembrar" (Tina já marcada). "Também me avisar no Telegram ou no WhatsApp (se estiverem conectados)". | P |
| 44 | MEDIA | Lembretes, visita | "O navegador guarda uma inscrição deste aparelho no servidor...", "fuso do servidor", "A próxima vez é calculada pelo servidor" | Passo 2: "Com isso o aviso chega no seu celular, mesmo com a tela fechada, com os botões Feito e Adiar." Passo 4: "Pausar segura o lembrete. Ao retomar, ele volta a contar de agora." | P |
| 45 | MEDIA | Avisos, formulário | "Tipo" já marcado como "decisão", "Para: Escolher agentes" sem lista, "Assunto (opcional)", campo de texto vazio | "Tipo" começa em "Escolha o tipo" com um exemplo de cada. Lista de agentes visível, e escondida quando há um só. "Título (opcional)". Texto com exemplo: "Ex.: Daqui em diante, mande os orçamentos em PDF." | M |
| 46 | MEDIA | Avisos, filtros | Cartão enorme "FILTROS" antes da lista | Uma linha pequena acima da lista, só quando houver avisos. "Ver retirados" vira "Mostrar avisos já retirados". | P |
| 47 | MEDIA | Avisos, visita | "regrava o quadro na casa de cada agente", "runner", "turno livre", "injetado" | "O DG Claw guarda o aviso e entrega a cada agente." "Os agentes leem o aviso na próxima conversa. Se você escolher agentes, eles recebem um recado na hora." "Chegou para...: o agente já pode ler. Recado entregue: o agente também foi avisado na hora." | P |
| 48 | MEDIA | Painel, Status | "Ocupação do teto 51% de 9.000 bytes" e "Tamanho 4.537 caracteres 4.592 bytes" | Um cartão só: "Espaço usado 51%" com a barra e "Quando passa de 90%, ele resume sozinho". | P |
| 49 | MEDIA | Painel, Status e Memória | Nomes de arquivo (`working-memory.md`, `MEMORY.md`, `memory/relationships.json`) e "MEMÓRIA DE TRABALHO (WORKING MEMORY)" | "Anotações do dia", "Memória de longo prazo", "Pessoas que ele conhece", "Receitas que podem virar habilidades", "Diário de 17/10". Nome do arquivo num "ver arquivo". Uma linha de descrição embaixo de cada. | M |
| 50 | MEDIA | Painel, Status e Memória | Os mesmos quatro arquivos aparecem nas duas abas; "Suas rotinas" aparece três vezes no Status | No Status, só um resumo com "ver tudo na Memória" e "ver Tarefas automáticas". Tirar a seção longa do fim. | M |
| 51 | MEDIA | Painel, Status e Custos | "CUSTO DO MÊS $13.69, 141 execuções no mês" | "US$ 13,69 de uso este mês (já incluído na assinatura)". Se for cobrança por uso, dizer isso. | P |
| 52 | MEDIA | Painel, Skills | 24 cartões longos, sem busca; seis skills parecidas de site, slide e vídeo; sem instrução de uso | Busca no topo, grupos (Vídeo, Site e slides, Memória e rotina, Sistema) e a linha: "Para usar, é só pedir na Conversa, por exemplo: 'faz um site animado sobre X'." Cartões recolhidos em uma linha. | M |
| 53 | MEDIA | Painel, Rotinas | A tela vazia não mostra o que dá para pedir; o título se confunde com Operações | Três exemplos clicáveis ("todo dia às 8h me lembra das tarefas", "toda sexta me manda o resumo da semana", "a cada hora confere se o site está no ar") e botão "Pedir uma tarefa automática". Títulos: "Tarefas que você pediu" e, em Funcionamento, "Verificações internas". | M |
| 54 | MEDIA | Painel, Identidade | Frase seca sem botão | Botão "Pedir para ele se apresentar" que abre a Conversa com o texto pronto. | P |
| 55 | MEDIA | Painel, Personalidade | "Big Five", "condescendente", "reativo a pressão", sem como mudar | "Traços de personalidade (os cinco grandes)", "gentil", "sensível ao estresse". Linha fixa: "Para ajustar, peça na Conversa." | P |
| 56 | MEDIA | Painel, Custos | 140 linhas sem paginação, dois blocos com o mesmo dado, "ROTINA dm-tina-channels", "TURNOS" e "DURAÇÃO" vazios | Mostrar 10 e "ver mais". Juntar "Rotinas que mais custam" com a categoria. "Conversas pelo canal (mensagens)" no lugar de "dm-tina-channels". Esconder colunas vazias. | M |
| 57 | MEDIA | Painel, Cofre | Cinco parágrafos em "Como a chave fica guardada", com a 1ª e a 2ª frases quase iguais | Três frases: "Sua chave fica protegida. Só este agente a usa. Se o agente for refeito do zero, cadastre a chave de novo." | P |
| 58 | MEDIA | Painel, Como funciona | Nove itens longos sem índice, "Working memory", "MEMORY.md", "o vigia (item 7)", e manda para o socorro | Lista de tópicos no topo com links, itens recolhidos. Trocar os termos em inglês pelas analogias já escritas ("O caderno do dia", "A ficha de longo prazo"). "Identidade: ainda não preenchida (ver Identidade)." | M |
| 59 | MEDIA | Painel, nomes | "Pasta", "Pasta do agente", "gaveta do agente"; "Memória", "working memory", "caderno do dia"; "Rotinas", "operações", "rotinas do sistema" (T5) | Um nome por coisa, conforme o glossário, aplicado em menu, título e visita. | M |
| 60 | MEDIA | Painel, celular | Botões "?" com cerca de 24 px e páginas longas (Status 4.390 px, Custos, Skills) | Alvo de 32 px. Recolher seções e paginar listas. | M |
| 61 | MEDIA | Painel, Status | "Metas" em vermelho e em inglês (D18) | "Metas: nenhuma por enquanto", sem vermelho. | P |

### BAIXA (polimento)

| # | Prio | Tela | O que está | Sugestão concreta | Esforço |
| --- | --- | --- | --- | --- | --- |
| 62 | BAIXA | Web, menu | Ícones de tamanhos e estilos diferentes; Conversa destacada como botão estando nela (D17) | Uma família de ícones. A linha da página atual é "você está aqui", sem aspecto de botão. | P |
| 63 | BAIXA | Conversa, menu | Bolinha "pronto" sem contexto | "pronto para conversar". | P |
| 64 | BAIXA | Conversa | "🔇 ler: não" e "🔁 contínua: não" | "Ler as respostas em voz alta: desligado" e "Voltar a gravar sozinho ao terminar: desligado". | P |
| 65 | BAIXA | Visitas | Cartões de exemplo sem identificação, e passos de Configurações e Conectar conta com "A tela confere sozinha", "/login" | Selo "Exemplo" no cartão. Conectar: "Toque em Conectar, entre com a sua conta e cole o código." | P |
| 66 | BAIXA | Visitas | O "Por que está aqui" repete a mesma ideia em quase todo passo | Cortar quando for óbvio. | P |
| 67 | BAIXA | Mesa | "mostrar agentes sem tarefa (2)" com cara de botão principal | "Ver agentes sem tarefa (2)" em texto simples. | P |
| 68 | BAIXA | Lembretes | Filtros "Todos os agentes" e "Todos os estados" antes de existir lembrete | Mostrar os filtros só quando houver lembretes. | P |
| 69 | BAIXA | Avisos, visita | "não tem limite de frequência", "Retirar" sem explicação | Cortar a primeira. Acrescentar: "Retirar é como arquivar: você pode ver depois." | P |
| 70 | BAIXA | Painel, Cofre | "CADASTRADA POR admin 17/10/2026, 14:07 pela tela", "mostrar o que colei", opção "Claude (assinatura, token do setup-token)", e o "?" que repete o texto logo abaixo | "Guardada por você em 17/10 às 14:07", "ver o que colei", "Claude (assinatura)". Tirar o "?" repetido. | P |
| 71 | BAIXA | Painel, Pasta | Estado vazio "a pasta é criada no primeiro envio" e "o arquivo vai para a pasta aberta acima" | "Ainda não tem arquivos. Quando o agente criar algo, aparece aqui. Você também pode subir um." Botão "Subir para a Pasta do agente". | P |
| 72 | BAIXA | Painel, Operações | Etiqueta "ESSENCIAL" sem significado, aba "Registros", fileiras de quadradinhos vazias | "Essencial: o agente não funciona sem isto". "Registros técnicos (para enviar a quem ajuda)". Frase: "Quadradinhos vazios são normais no começo." | P |
| 73 | BAIXA | Painel, Status | "Em dia / Atualizada há 4 min" repetido no cartão; texto de memória cortado | Dizer uma vez. Trocar o corte por "ver mais". | P |
| 74 | BAIXA | Painel, Identidade e Personalidade | "as leis", "esta é a tela com mais poder do painel" numa tela vazia; subtítulo promete arquivos que não aparecem | "regras que não mudam"; cortar a frase de poder; subtítulo "quem ele é e como fala". | P |
| 75 | BAIXA | Painel, Aplicativos e Skills | Subtítulo "o que ele já produziu, etapa por etapa" que não bate com Aplicativos; visita de Skills com "cabeçalho quebrado" | Subtítulo "os mini aplicativos que ele criou para você". Cortar o detalhe da visita de Skills. | P |
| 76 | BAIXA | Painel, Como funciona | Rodapé "Texto do repositório do painel, atualizado há 23 h" | Cortar. | P |

Total na lista: 76 itens (28 ALTA, 33 MEDIA, 15 BAIXA).

---

## 5. O que está bom e deve ficar

- A visita guiada com holofote e o resto apagado, o contador "Passo N de M" e os botões "Fechar / Anterior / Próximo / Entendi".
- A fórmula "O que é / Como funciona / Por que está aqui", que dá o motivo antes de pedir ação (só precisa ficar curta).
- O cartão de exemplo marcado como demonstração nas telas vazias (por exemplo "Roteiro do reels de exemplo", com "Precisa de você: Gancho A ou B?").
- Os números da Mesa escritos com palavras ("0 esperando você, 0 travadas...") e "Sem medida" em vez de 0% quando não houve medição.
- Os textos de tela vazia que ensinam duas saídas ("Crie o primeiro no formulário acima, ou peça ao agente na conversa") e dão exemplo entre aspas (Rotinas, Status).
- Em Lembretes, "O que lembrar" com "ex.: ligar pro contador", e a mensagem de bloqueio do navegador que diz o caminho exato (cadeado, Notificações, Permitir).
- Em Sessões, o formulário curto com a dica "Quem ler não viu a sua conversa: diga o que é e onde fica", a gaveta de baixo no celular e "terminou e espera o próximo pedido".
- Em Avisos, o contador "0/280", o "(opcional)" nos campos extras e "Nenhum aviso nos últimos 7 dias."
- Os balões de arquivo e vídeo na Conversa, o placeholder "Escrever para Tina", os tooltips em bom português e "Instalar o app, como colocar na tela inicial".
- Na lista de comandos, "/compact: Resume a conversa para liberar contexto" e "/clear: Começa uma conversa limpa (a anterior fica no disco)", que explicam o efeito.
- A frase-pergunta que abre cada aba do painel ("como ele está agora", "quanto ele custou este mês").
- A honestidade dos dados: "não consegui ver" em vez de zero no Status, e o Cofre que avisa que a chave não volta a aparecer.
- Cofre: "A chave é sua, e a conta também", os últimos 4 caracteres, e a escolha do serviço preenchendo o nome e mostrando o link para gerar a chave.
- A aba "Como funciona", com a analogia do funcionário novo. É o melhor texto do painel e serve de tom para as outras abas.
- O semáforo de cores em Operações, a frase de resumo no topo e o agrupamento "Mantém ele de pé / Memória / Vigilância e custos".
- "Claude (modelo padrão), na assinatura" com o botão "Trocar" claro (só trocar o texto, conforme o item 30).
- No celular: nenhuma rolagem horizontal nas 13 abas, tabelas que viram cartões e o botão de menu que funciona.
