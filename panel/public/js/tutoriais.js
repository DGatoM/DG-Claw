// tutoriais.js — a visita guiada das abas que o js/app.js desenha.
//
// POR QUE ESTE ARQUIVO EXISTE. O painel tem treze abas. Três delas (Apps, Pasta e
// Cofre) nasceram com tutorial próprio, porque cada uma desenha a si mesma e o
// botão mora dentro da página. As outras dez eram MUDAS: uma palavra no menu, um
// símbolo, e a única forma de descobrir o que "Operações" mostrava era clicar e
// adivinhar.
//
// O motor da visita guiada é o de `js/tutorial.js`, e ele não muda. O que vive
// aqui é só a LISTA DE PASSOS de cada aba, no mesmo contrato de sempre:
//
//   { chave, alvo, titulo, corpo, porque }
//
// `porque` é obrigatório por regra do repo. Passo sem o "por que" vira legenda, e
// legenda a pessoa já tinha no tooltip.
//
// QUEM LÊ ISTO NÃO É DESENVOLVEDOR e não é o Danilo: é a Marta, é o Paulo, o
// dono do agente, que abre a tela para saber se está tudo bem. Por isso nenhum
// passo diz "endpoint", "cron", "systemd" ou "sessão": diz o que a pessoa vê e o
// que ela faz com aquilo.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  O "COMO EU CALCULO" TEM QUE SER VERDADE, E FOI LIDO DO CÓDIGO.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Os números da faixa do Status foram conferidos em `renderDestaqueHumor`,
// `renderDestaqueCusto`, `renderDestaqueRotinas` e `renderDestaqueSessao`, no
// js/app.js, e as cores da aba Operações em `quadradosDeRotina` e
// `quadradosDeServico`, no lib/operacoes.js (01/10/2026), e o passo da memória de trabalho em
// `lib/wm-status.js` e `js/wm-status.js` (05/10/2026). Um tutorial que explica errado como a conta é feita é pior do que
// tutorial nenhum: ele ensina a pessoa a confiar no número errado. Ao mexer
// naquelas funções, volte aqui.

(function () {
  /**
   * Um passo que fala da tela inteira, e não de um pedaço dela.
   *
   * Ele é sempre o primeiro de cada aba, e é o único que responde a pergunta que
   * a pessoa realmente tem ao chegar: "para que serve esta tela?".
   */
  function tela(titulo, corpo, porque) {
    return { chave: 'tela', alvo: null, titulo, corpo, porque };
  }

  const PASSOS = {
    conversa: [
      tela(
        'Aqui você fala com ele',
        'Escreva embaixo e ele responde aqui em cima, como em qualquer conversa. Se ele também tiver Telegram, é a MESMA conversa: o que você mandar por lá aparece aqui, na ordem, e o contrário também.',
        'Uma conversa só, e não uma por lugar. Se fossem duas, ele lembraria de metade do que vocês combinaram, dependendo de onde você tivesse falado.',
      ),
      {
        chave: 'sinal',
        alvo: '#conversa-sinal',
        titulo: 'O que ele está fazendo agora',
        corpo: 'Esta linha diz se ele está parado esperando você, se está trabalhando neste instante, ou se algo o travou. Quando ele está trabalhando, aparece um botão de parar.',
        porque: 'Sem ela, uma resposta que demora e um agente travado são a mesma coisa na tela: silêncio. O botão de parar existe porque pedir para ele parar é mais educado do que fechar a página no meio.',
      },
      {
        chave: 'escrever',
        alvo: '#conversa-form',
        titulo: 'Escrever ou falar',
        corpo: 'Digite e aperte enviar. O botão do microfone grava a sua voz e transforma em texto na caixa de escrever, para você revisar antes de mandar.',
        porque: 'O texto transcrito não sai sozinho, de propósito: quem dita revisa e aperta enviar, igual a quem digita. Transcrição erra nome próprio, e mandar sem ler é como assinar sem conferir.',
      },
      {
        chave: 'faixa',
        alvo: '#conversa-faixa',
        titulo: 'O aviso quando ele não está bem',
        corpo: 'Quando ele para de responder ou alguma coisa não vai bem, aparece aqui em cima uma faixa com o motivo, o que fazer e o botão certo para aquele caso: reiniciar, reiniciar em modo de segurança, ou só esperar. Se o problema é de login da conta, não há botão: a faixa diz quem resolve.',
        porque: 'Cada defeito tem um remédio diferente, e um botão de "reiniciar" para tudo faria a pessoa reiniciar à toa o que só precisava de espera. O modo de segurança existe para o caso de ele travar sempre no mesmo ponto: ele volta sem a última conversa na cabeça (ela continua guardada), e por isso não trava de novo ali.',
      },
      {
        chave: 'canais',
        alvo: '#conversa-lista',
        titulo: 'De onde veio cada mensagem',
        corpo: 'Mensagem que passou pelo Telegram (ou, no futuro, pelo WhatsApp) ganha uma etiqueta pequena com o nome do canal, na sua mensagem e na resposta dele. Sem etiqueta, foi aqui pelo painel.',
        porque: 'É uma conversa só: o Telegram fala com a mesma cabeça dele que o painel. A etiqueta serve para você lembrar por onde disse cada coisa, sem precisar de duas telas.',
      },
      {
        chave: 'acordar',
        alvo: '#btn-reativar',
        titulo: 'Quando ele não acorda',
        corpo: 'Se o agente caiu, aparece aqui um botão de acordar. Ele levanta o agente e a conversa continua de onde parou.',
        porque: 'Antes deste botão, um agente caído virava uma tela que dizia que a conversa estava guardada e não dizia como voltar a usá-la. A saída existia, mas só para quem tinha acesso à máquina.',
      },
    ],

    status: [
      tela(
        'A página inicial',
        'A resposta rápida para "está tudo bem com ele?". Em cima, os números do mês; logo abaixo, uma linha dizendo se as operações do sistema estão funcionando; depois, se a memória de trabalho dele está em dia e o que ele sabe agora sobre você (a memória dele, para ler e corrigir); e embaixo, as rotinas que você pediu.',
        'É a tela para bater o olho uma vez por dia. Se a linha das operações estiver verde e a memória disser o que você espera, não há nada que exija você.',
      ),
      {
        chave: 'aviso-saude',
        alvo: '#status-faixa',
        titulo: 'O aviso de que ele não está respondendo',
        corpo: 'Esta faixa vermelha só aparece quando o sistema conferiu as respostas dele e viu que ele não consegue responder, por exemplo porque o login da conta dele na Anthropic venceu. Ela diz o motivo, o trecho exato que o sistema recebeu e o que precisa ser feito. Quando está tudo bem, ela não existe.',
        porque: 'Os números logo abaixo (custo, rotinas) ficam em zero com ele calado, e sozinhos parecem "tudo tranquilo". Este aviso evita que você leia silêncio como calma.',
      },
      {
        chave: 'modelo',
        alvo: '#prov-status',
        titulo: 'O modelo do agente e como ele é pago',
        corpo: 'A linha grande diz qual modelo de IA ele usa agora e de que jeito se paga: pela assinatura (um valor fixo por mês, no Claude ou no ChatGPT) ou pela API (você paga pelo que ele usar, com uma chave guardada no Cofre). Logo abaixo, "conferido" diz há quanto tempo o painel checou isso. Essa conferência não lê a configuração: o painel pergunta ao agente, e o agente pergunta ao próprio programa do Claude ou do Codex se ele está logado e de que jeito. Se a resposta não bater com o que foi escolhido, a linha fica amarela e diz o que fazer, por exemplo "configurado na API, mas a chave não está no Cofre".',
        porque: 'Escolher e estar valendo são coisas diferentes. Um agente pode estar configurado na assinatura e deslogado, e aí ele fica mudo sem ninguém perceber. Este cartão mostra a verdade que o programa confirma, e não só a intenção.',
      },
      {
        chave: 'modelo-trocar',
        alvo: '#prov-trocar',
        titulo: 'Trocar o modelo, o provedor ou a forma de pagar',
        corpo: 'Abre uma janela com três escolhas: o provedor (Claude ou Codex), o modelo e a forma de pagar, cada uma com uma explicação embaixo. Se você escolher pagar pela API e o Cofre ainda não tiver a chave, a janela pede a chave ali mesmo e a guarda no Cofre; ela não aparece mais depois. Ao confirmar, o agente reinicia: a conversa atual fecha e ele volta numa conversa nova, com a memória intacta. Quando ele não está logado na assinatura, aparece também o botão "Entrar com a assinatura", que mostra o link e o código, sem você abrir terminal.',
        porque: 'Trocar de modelo muda o custo e o jeito de pensar do agente, então a janela explica cada opção antes de você confirmar, e avisa do reinício. Sem esse aviso, a conversa em andamento pareceria ter sumido sem motivo.',
      },
      {
        chave: 'faixa',
        alvo: '#panel-status .faixa',
        titulo: 'Os números de cima',
        corpo: 'Custo do mês soma o que ele gastou desde o dia 1 e compara com o teto que você definiu. Suas rotinas conta as rotinas que você pediu a ele. Último sinal é há quanto tempo ele deu o último sinal de vida. Com a extensão de emoções instalada, aparece também o humor.',
        porque: 'São perguntas diferentes de propósito: quanto está custando, se ele está fazendo o que você pediu, e se está vivo. Um agente pode estar barato e parado há dois dias, e só o último número conta isso.',
      },
      {
        chave: 'custo',
        alvo: '#dest-custo',
        titulo: 'Custo do mês, e o que o percentual quer dizer',
        corpo: 'O valor é a soma de tudo o que ele consumiu no mês corrente. O percentual ao lado é esse valor dividido pelo teto que você configurou. Passando de 90%, o número fica vermelho.',
        porque: 'O vermelho chega em 90% e não em 100% porque um aviso que só aparece depois de estourar não é aviso, é notícia. E se você não configurou teto nenhum, ele mostra quantas vezes o agente trabalhou no mês, em vez de inventar um percentual sobre um número que não existe.',
      },
      {
        chave: 'rotinas',
        alvo: '#dest-rotinas',
        titulo: 'Suas rotinas, o número',
        corpo: 'Quantas rotinas você pediu a ele (por exemplo, "todo sábado às 9h me manda o resumo"). Embaixo, a hora da próxima, ou quantas falharam na última vez. As rotinas do próprio sistema não entram aqui: elas ficam na aba Operações.',
        porque: 'Antes este número misturava as suas rotinas com as da máquina, e contava execuções por um leitor antigo que dizia "nada rodou" com tudo rodando. As da máquina são da máquina; aqui fica só o que é seu.',
      },
      {
        chave: 'operacoes',
        alvo: '#home-operacoes',
        titulo: 'As operações do sistema, numa linha',
        corpo: 'Diz se as rotinas que mantêm ele de pé, lembrando e de olho nos custos estão funcionando. Verde quando a última execução de cada uma deu certo; quando alguma pede atenção, a linha diz qual.',
        porque: 'O detalhe mora na aba Operações, com uma fileira de quadradinhos por rotina. Aqui fica só a resposta, para você não precisar abrir outra aba quando está tudo bem.',
      },
      {
        chave: 'memoria-trabalho',
        alvo: '#wm-status',
        titulo: 'A memória de trabalho, em uma olhada',
        corpo: 'É o bloco de anotações do momento: o que ele está fazendo, o que ficou pendente e o que combinou com você há pouco. O selo diz se ela está em dia. "Atualizada" vem da linha "Agora" do arquivo, que ele reescreve a cada 30 minutos. "Ocupação do teto" é o tamanho do arquivo dividido pelo teto da remontagem (9.000 bytes no plugin de hoje; o número exato é lido do agente). "Remontagem das 7h" diz se a rotina que arruma a memória toda manhã rodou hoje. Embaixo, a linha de pendências que ele mesmo anotou, e o link para ler tudo na aba Memória.',
        porque: 'É a primeira coisa que ele lê ao começar uma conversa. Se ela está atrasada, ele chega com o dia de ontem na cabeça; se está ausente, chega sem lembrar de nada. Quando não dá para medir alguma coisa, o cartão diz "não consegui ver", em vez de mostrar um zero que pareceria verdade.',
      },
      {
        chave: 'cerebro',
        alvo: '#cerebro-grid',
        titulo: 'O que ele sabe agora',
        corpo: 'Um cartão por arquivo de memória que ele está usando: a memória de trabalho (o que está fazendo, as tarefas, o que sabe sobre você), a memória longa, o que ele separou por assunto e o diário mais recente. Cada cartão diz quando mudou e quem escreve. Clique para ler inteiro e, se precisar, corrigir à mão.',
        porque: 'A memória dele é texto, lido do disco na hora: é exatamente o que ele vai ler na próxima conversa. Se ele entendeu algo errado sobre você, é aqui que aparece primeiro, e corrigir aqui é corrigir na cabeça dele.',
      },
      {
        chave: 'pensamentos',
        alvo: '#thoughts-present',
        titulo: 'O que passa pela cabeça dele',
        corpo: 'Os pensamentos que ele anotou sozinho entre uma tarefa e outra, e os assuntos que ficaram remoendo. Quando o pensamento começa com um título em maiúsculas, ele aparece em destaque. Os longos aparecem cortados, com o botão "ler inteiro" para abrir o texto completo do jeito que ele escreveu.',
        porque: 'É o jeito de saber o que ele está pensando sem precisar perguntar. O texto é formatado (negrito, código, links clicáveis), mas nunca executa nada: o que ele escreveu é só mostrado.',
      },
      {
        chave: 'metas',
        alvo: '#goals-short',
        titulo: 'Metas',
        corpo: 'O que ele está perseguindo, escrito por ele mesmo a partir do que vocês combinaram.',
        porque: 'Está aqui para você conferir se o que ele acha que deve fazer é o que você quer que ele faça. Quando os dois começam a divergir, é nesta lista que aparece primeiro.',
      },
      {
        chave: 'suas-rotinas',
        alvo: '#home-rotinas',
        titulo: 'Suas rotinas, uma a uma',
        corpo: 'Cada rotina que você pediu, com quando roda, a próxima vez, a última vez e se ela deu certo. Para criar uma, é só pedir a ele na Conversa, do jeito que você pediria a uma pessoa.',
        porque: 'A lista vem do próprio sistema que dispara as rotinas, e não de um caderno: se aparece aqui, existe e vai rodar. Rotina que ele prometeu e não marcou aparece com um aviso, em vez de sumir calada.',
      },
    ],

    identity: [
      tela(
        'Quem ele é, e você pode mudar',
        'Os arquivos de texto que definem o agente: a alma e o jeito de falar, o papel dele, a personalidade, o que ele sabe sobre você, a ética e as leis. Clique em qualquer um para ler; os que podem ser mudados têm o botão Editar.',
        'Esta é a tela com mais poder do painel, e por isso ela é texto simples e não um formulário cheio de caixinhas: o que está escrito aqui é o que ele vai seguir, e você precisa conseguir ler a coisa inteira de uma vez.',
      ),
      {
        chave: 'arquivos',
        alvo: '#identity-files',
        titulo: 'Cada arquivo é uma parte dele',
        corpo: 'Abrir mostra o texto renderizado, fácil de ler. Editar troca por uma caixa de texto grande; Salvar grava no mesmo arquivo de onde ele lê, e a versão anterior fica guardada. A ética e as leis são só de leitura.',
        porque: 'Muda nas PRÓXIMAS conversas, e não na que está aberta: ele lê estes arquivos ao começar. Depois de salvar, o painel oferece avisar ele na hora. A ética e as leis ficam travadas de propósito: são as regras que protegem você e quem fala com ele, e nem um pedido seu muda isso.',
      },
    ],

    personality: [
      tela(
        'O jeito dele',
        'Os números que regulam o temperamento do agente, e o quanto ele toma iniciativa sozinho. Não é o que ele sabe: é como ele se comporta.',
        'Duas pessoas com a mesma instrução entregam coisas diferentes, e com agente é igual. É aqui que se escolhe entre um que pergunta antes e um que resolve e conta depois.',
      ),
      {
        chave: 'bigfive',
        alvo: '#big-five',
        titulo: 'Os cinco traços',
        corpo: 'Cada barra vai de 0 a 100 e mexe num aspecto do jeito dele: o quanto ele é aberto a ideia nova, organizado, comunicativo, condescendente e reativo a pressão.',
        porque: 'São os cinco traços que a psicologia usa para descrever personalidade, e estão aqui porque números explicam melhor que adjetivo. "Mais organizado" cada um entende de um jeito; sair de 40 para 70 é a mesma coisa para todo mundo.',
      },
      {
        chave: 'comportamento',
        alvo: '#proactivity-bars',
        titulo: 'O quanto ele age sozinho',
        corpo: 'Regula se ele espera você pedir ou se ele se antecipa, e com que frequência ele fala com você sem ser chamado.',
        porque: 'É o ajuste que muda mais a convivência no dia a dia. Alto demais, ele vira um colega que interrompe; baixo demais, ele vira uma ferramenta que só funciona quando lembrada.',
      },
    ],

    memory: [
      tela(
        'Toda a memória dele',
        'Todos os arquivos que ele guardou da convivência de vocês: a memória longa, os assuntos que ele separou e os diários de cada noite. Clique em qualquer um para ler no leitor, com letra grande e o texto formatado.',
        'A memória dele é texto, e não um banco de dados fechado. Você lê exatamente o que ele lembra sobre você, e corrige o que estiver errado, sem depender de ninguém. Os mais importantes também aparecem na página Status, no "O que ele sabe agora".',
      ),
      {
        chave: 'lista',
        alvo: '#memory-list',
        titulo: 'Um arquivo por assunto, um diário por noite',
        corpo: 'Abrir mostra o arquivo inteiro. O botão Editar abre uma caixa de texto grande; Salvar grava no arquivo de verdade. Se ele escrever no mesmo arquivo enquanto você edita, o painel NÃO grava por cima: ele avisa, e o seu texto continua no editor.',
        porque: 'Vale abrir de vez em quando: agente também entende errado, e uma informação torta guardada aqui vai ser repetida como verdade por meses. Cada edição guarda a versão anterior, então corrigir não tem risco de perder nada.',
      },
    ],

    costs: [
      tela(
        'Quanto ele custou',
        'O gasto do mês corrente, separado por tipo de trabalho e por rotina, mais a lista das últimas execuções, uma a uma, com o custo de cada uma.',
        'Agente custa por trabalho feito, não por mês fixo. Sem esta tela, a conta só aparece na fatura, quando já não dá para fazer nada a respeito.',
      ),
      {
        chave: 'resumo',
        alvo: '#costs-summary',
        titulo: 'Este mês',
        corpo: 'O total desde o dia 1 do mês corrente, contra o teto que você definiu. Vira o mês, zera.',
        porque: 'O corte é por mês de calendário, e não pelos últimos 30 dias, porque é assim que a sua fatura funciona. Comparar com um período que não é o da cobrança daria um número que não bate com lugar nenhum.',
      },
      {
        chave: 'categorias',
        alvo: '#costs-categories',
        titulo: 'Por categoria e por rotina',
        corpo: 'Onde o dinheiro foi. A primeira lista agrupa por tipo de trabalho; a segunda mostra quais rotinas automáticas mais pesaram no mês.',
        porque: 'Quase sempre o gasto se concentra em uma ou duas rotinas que rodam muitas vezes por dia. Achar qual é vale mais do que cortar o agente inteiro, e é esta lista que responde isso em dez segundos.',
      },
      {
        chave: 'execucoes',
        alvo: '#costs-executions',
        titulo: 'Execuções recentes',
        corpo: 'Uma linha por trabalho que ele fez na janela escolhida, com quando foi, quanto tempo levou e quanto custou. Mude a janela para olhar mais para trás.',
        porque: 'É onde se enxerga o caso isolado que não aparece no total: a execução que custou dez vezes as outras, quase sempre porque alguma coisa entrou em laço. O total do mês esconde isso; esta lista mostra.',
      },
    ],

    operations: [
      tela(
        'Está tudo funcionando?',
        'Cada rotina do sistema aparece uma vez, com o nome, de quanto em quanto tempo roda e uma fileira de quadradinhos das últimas execuções, como numa página de status. Tudo verde, está tudo funcionando. Em cima, uma frase diz isso por você.',
        'Antes eram duas abas, uma dizendo o que estava marcado e outra dizendo se rodou certo, e nem quem construiu sabia a diferença. Agora a resposta é uma só, e o que é técnico (os registros) fica numa vista separada, para quando alguém pedir.',
      ),
      {
        chave: 'resumo',
        alvo: '#op-resumo',
        titulo: 'A frase de cima',
        corpo: '"Tudo funcionando" quando a última execução de cada operação deu certo. Quando alguma não deu, a frase diz quantas e quais, e clicar no nome leva até a linha dela.',
        porque: 'A conta olha a ÚLTIMA vez de cada uma: uma falha de três dias atrás que já se resolveu aparece na fileira, mas não acende alarme. E o que ainda não rodou nenhuma vez fica de fora, em vez de contar como sucesso: verde só quando foi medido e deu certo.',
      },
      {
        chave: 'legenda',
        alvo: '#op-legenda',
        titulo: 'O que cada cor quer dizer',
        corpo: 'Verde rodou e deu certo. Vermelho falhou: o programa terminou com erro, ou o registro da própria rotina disse que falhou. Amarelo pede atenção: não rodou quando devia (listrado), foi cancelada, rodou com aviso, ou reiniciou. Cinza é sem dado.',
        porque: 'O vermelho também pega a rotina que terminou "sem erro" para o sistema mas anotou erro no registro dela: para o sistema foi sucesso, para você não foi. E o amarelo de "não rodou" é calculado pelo horário marcado, então uma rotina que parou de rodar aparece mesmo sem ter falhado.',
      },
      {
        chave: 'fileiras',
        alvo: '#op-grupos',
        titulo: 'Uma fileira por operação',
        corpo: 'O quadradinho mais recente fica à direita. Passe o mouse (ou toque na fileira, no celular) para ver a data, a hora e o resultado de cada um. Nas peças que ficam de pé o tempo todo, como o próprio agente, cada quadradinho é uma hora das últimas 48. Embaixo, a conta dos últimos 7 dias.',
        porque: 'As operações estão agrupadas pelo que fazem, e não pelo nome técnico: o que mantém ele de pé, o que cuida da memória, e o que vigia os custos. Você não precisa saber o que cada uma faz; precisa saber que, se o agente estiver estranho e houver vermelho aqui, as duas coisas provavelmente estão ligadas.',
      },
      {
        chave: 'registros',
        alvo: '#op-alternar',
        titulo: 'Situação e Registros',
        corpo: 'Situação é esta tela, com os quadradinhos. Registros mostra o texto que cada rotina escreve enquanto roda, e a sessão viva dele.',
        porque: 'O texto dos registros é técnico mesmo. Você não precisa entender: precisa saber que ele existe, para copiar e mandar para quem cuida do agente quando algo der errado.',
      },
      {
        chave: 'sessao',
        alvo: '#session-info',
        titulo: '"Sessão viva" quer dizer a cabeça dele ligada',
        corpo: 'Uma sessão é uma conversa contínua em que ele lembra do que foi dito antes. Esta caixa diz qual é a sessão registrada e quando ela foi atualizada.',
        porque: 'O nome é técnico, então vai a tradução: preenchido quer dizer que ele está de pé. Se está vazio há muito tempo e o agente não responde, é isso que você conta para quem cuida dele.',
      },
      {
        chave: 'logs',
        alvo: '#log-viewer',
        titulo: 'Os registros',
        corpo: 'O que cada rotina escreveu enquanto rodava. Escolha qual registro ver nos botões acima.',
        porque: 'É o lugar onde se descobre o motivo de uma falha. Quando um quadradinho fica vermelho, o registro daquela rotina costuma dizer por quê.',
      },
    ],

    como: [
      tela(
        'Como ele funciona por dentro',
        'O texto que explica as peças do agente (as camadas de memória, as rotinas e a sessão), com um mapa em cima mostrando as mesmas peças com os números dele neste instante.',
        'Para entender o que você vê nas outras abas sem precisar perguntar a ninguém. O mapa é vivo de propósito: um texto que explica a máquina em geral ajuda menos que o mesmo texto com a SUA máquina ao lado.',
      ),
      {
        chave: 'mapa',
        alvo: '#como-mapa',
        titulo: 'O mapa, com os números de agora',
        corpo: 'A sessão (se ele está de pé), o tamanho de cada camada da memória medido no disco, quantas operações do sistema estão verdes e quantas rotinas você pediu.',
        porque: 'Cada número aqui vem da mesma fonte da aba que o detalha: a memória vem dos arquivos, as operações vêm do diário do sistema, a sessão vem do selo do cabeçalho. Não há conta própria nesta tela, então ela nunca discorda das outras.',
      },
      {
        chave: 'texto',
        alvo: '#como-doc',
        titulo: 'O texto da radiografia',
        corpo: 'A explicação escrita, peça por peça. Ela vem junto com o plugin e é atualizada quando o plugin é atualizado.',
        porque: 'O texto mora no plugin, e não no painel, porque é o plugin que define como ele funciona. Se ele ainda não foi instalado neste agente, a tela diz isso em vez de mostrar uma página em branco.',
      },
    ],

    posts: [
      tela(
        'O que ele publicou',
        'Os posts que o agente publicou no Instagram, com data, tema e link. Filtre por data no campo acima.',
        'Só faz sentido com o poder de Instagram ligado. Sem ele, o agente trabalha igual e simplesmente não publica nada em lugar nenhum.',
      ),
      {
        chave: 'tabela',
        alvo: '#posts-table',
        titulo: 'Um post por linha',
        corpo: 'Cada linha traz quando saiu, o assunto, o tipo e o link para o post de verdade.',
        porque: 'O link leva ao post publicado, e não a uma cópia dentro do painel. O que vale é o que está no ar, e uma cópia local ficaria diferente do original no dia em que alguém editasse a legenda por fora.',
      },
    ],

    followers: [
      tela(
        'Com quem ele fala',
        'As pessoas que mais conversam com ele no Instagram, e o resumo de quantas são.',
        'Serve para você ver com quem o agente está gastando o tempo dele. Às vezes é uma pessoa só, mandando mensagem o dia inteiro, e isso é uma informação de negócio, não de sistema.',
      ),
    ],

    reunioes: [
      tela(
        'O que foi dito nas reuniões',
        'As reuniões que o agente acompanhou, com o que foi falado e o que ficou combinado. Busque por participante, assunto ou por qualquer palavra dita lá dentro.',
        'A busca varre o conteúdo inteiro, e não só o título. Você raramente lembra o nome da reunião; lembra que alguém falou de um preço, e é por essa palavra que dá para achar.',
      ),
    ],
  };

  /**
   * ONDE VAI CADA "?", e para qual passo ele abre.
   *
   * O mapa mora AQUI e não espalhado no index.html, pelo mesmo motivo que o balão
   * de cada aba mora no `EXPLICACAO_ABA` do js/app.js: fonte única. Escrever o "?"
   * no HTML também criaria dois lugares que precisam concordar sobre a chave do
   * passo, e um dia eles discordam em silêncio, com o "?" abrindo o passo errado.
   *
   * O seletor aponta para o elemento de CONTEÚDO da seção, e o botão é pendurado
   * no `.section-title` mais próximo acima dele. É assim porque os títulos são
   * texto solto e repetido ("Rotinas de hoje" aparece em duas abas diferentes),
   * enquanto o id do conteúdo é único na página.
   */
  // A linha das operações na home e os títulos de grupo da aba Operações são
  // desenhados por js/operacoes.js, que pendura o "?" deles por conta própria
  // (eles não têm um título fixo no HTML para este mapa achar).
  const SECOES = [
    { alvo: '#prov-status', aba: 'status', chave: 'modelo' },
    { alvo: '#wm-status', aba: 'status', chave: 'memoria-trabalho' },
    { alvo: '#cerebro-grid', aba: 'status', chave: 'cerebro' },
    { alvo: '#thoughts-present', aba: 'status', chave: 'pensamentos' },
    { alvo: '#goals-short', aba: 'status', chave: 'metas' },
    { alvo: '#home-rotinas', aba: 'status', chave: 'suas-rotinas' },
    { alvo: '#memory-list', aba: 'memory', chave: 'lista' },
    { alvo: '#identity-files', aba: 'identity', chave: 'arquivos' },
    { alvo: '#big-five', aba: 'personality', chave: 'bigfive' },
    { alvo: '#proactivity-bars', aba: 'personality', chave: 'comportamento' },
    { alvo: '#costs-summary', aba: 'costs', chave: 'resumo' },
    { alvo: '#costs-categories', aba: 'costs', chave: 'categorias' },
    { alvo: '#costs-top-crons', aba: 'costs', chave: 'categorias' },
    { alvo: '#costs-executions', aba: 'costs', chave: 'execucoes' },
    { alvo: '#log-viewer', aba: 'operations', chave: 'logs' },
    { alvo: '#session-info', aba: 'operations', chave: 'sessao' },
    { alvo: '#como-mapa', aba: 'como', chave: 'mapa' },
    { alvo: '#como-doc', aba: 'como', chave: 'texto' },
    { alvo: '#reunioes-list', aba: 'reunioes', chave: 'tela' },
    { alvo: '#posts-table', aba: 'posts', chave: 'tabela' },
    { alvo: '#followers-grid', aba: 'followers', chave: 'tela' },
  ];

  /** O `.section-title` que manda neste pedaço de conteúdo. */
  function tituloDaSecao(el) {
    // Sobe até o cartão e procura o título dentro dele; se o conteúdo não está
    // num cartão, pega o título irmão logo acima.
    const cartao = el.closest('.cartao');
    if (cartao) {
      const t = cartao.querySelector('.section-title');
      if (t) return t;
    }
    let irmao = el.previousElementSibling;
    while (irmao) {
      if (irmao.classList && irmao.classList.contains('section-title')) return irmao;
      irmao = irmao.previousElementSibling;
    }
    return null;
  }

  /**
   * Põe um "?" em cada seção mapeada.
   *
   * Roda no boot e de novo depois de cada carga de aba, porque parte do conteúdo
   * é desenhada por JavaScript e só existe depois que a aba abre. Pendurar duas
   * vezes no mesmo título é impossível: o `_ajuda` marca quem já recebeu.
   */
  function pendurarAjudas() {
    for (const s of SECOES) {
      const conteudo = document.querySelector(s.alvo);
      if (!conteudo) continue;
      const titulo = tituloDaSecao(conteudo);
      if (!titulo || titulo._ajuda) continue;
      titulo._ajuda = true;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'app-ajuda-secao';
      b.textContent = '?';
      b.setAttribute('aria-label', 'O que é esta seção');
      b.title = 'O que é esta seção, e como a conta é feita';
      b.addEventListener('click', () => abrir(s.aba, s.chave));
      titulo.appendChild(b);
    }
  }

  /** A lista de passos de uma aba, ou `null` se ela não tem tutorial próprio aqui. */
  function passosDa(aba) {
    return PASSOS[aba] || null;
  }

  /**
   * Abre a visita guiada da aba que está aberta.
   *
   * AS TRÊS ABAS QUE DESENHAM A SI MESMAS (Apps, Pasta e Cofre) têm o botão delas
   * dentro da própria página, e este daqui simplesmente CLICA nesse botão. É de
   * propósito que a ligação seja um clique e não uma chamada de função: assim o
   * cabeçalho não precisa saber o nome de nada que aquelas abas exportam, e a aba
   * Apps, que é de outra sessão, continua dona do tutorial dela sem que ninguém
   * precise combinar nada.
   */
  function abrir(aba, comecarEm) {
    const proprio = document.querySelector(`#panel-${aba} .app-tutorial-abrir`);
    if (proprio) { proprio.click(); return true; }
    const passos = passosDa(aba);
    if (!passos || !window.DGTutorial) return false;
    window.DGTutorial.abrir(passos, comecarEm);
    return true;
  }

  /** Esta aba tem tutorial, seja o próprio dela ou o daqui? */
  function tem(aba) {
    return !!(PASSOS[aba] || document.querySelector(`#panel-${aba} .app-tutorial-abrir`));
  }

  window.DGTutoriais = { abrir, tem, passosDa, pendurarAjudas };
})();
