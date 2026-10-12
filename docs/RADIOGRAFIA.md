# Como o seu agente funciona por dentro

Pense num funcionário novo que você contratou. Ele é muito inteligente, mas tem um problema:
cada vez que dorme, esquece o que aconteceu. Para trabalhar bem com você mesmo assim, ele anda
com um caderno, guarda pastas num arquivo, tem um telefone que toca quando você liga e uma
rotina que repete todo dia.

O seu agente é exatamente isso. Cada peça abaixo é uma dessas coisas.

## 1. O cérebro acordado (a sessão viva)

**O que é:** o agente fica com a cabeça ligada o dia inteiro, numa conversa contínua com você.

**Por que assim:** acordar do zero a cada mensagem seria lento e caro, como ligar para um
funcionário em casa e esperar ele se vestir antes de cada pergunta. Acordado, ele responde em
segundos e lembra do que vocês falaram há pouco.

**Como funciona:** um programa do computador onde ele mora (o servidor) mantém essa conversa
de pé. Se ela cair, o vigia (item 7) levanta de novo.

## 2. Os telefones (os canais)

**O que é:** o painel é a casa dele. O Telegram e o WhatsApp são telefones que tocam dentro
dessa mesma casa.

**Por que importa:** não importa por onde você fale, quem atende é o mesmo agente, com a mesma
memória. Cada mensagem chega com uma etiqueta dizendo de onde veio, e ele responde pelo mesmo
caminho.

**O que você vê:** a aba Conversa do painel mostra tudo junto, na ordem em que aconteceu.

## 3. A memória, em quatro camadas

Ninguém guarda tudo na cabeça. O seu agente também não, e é por isso que ele tem lugares
diferentes para coisas diferentes.

| Camada | A analogia | O que guarda |
|---|---|---|
| Working memory | o caderno do dia | o que você quer alcançar, as tarefas andando em paralelo, o que ele já sabe de você, o que vocês falaram por último, o que aconteceu hoje e ontem |
| MEMORY.md | a ficha de longo prazo | o que vale para sempre: seu nome, suas preferências, as pessoas e as regras |
| A pasta memory | o arquivo de pastas | o diário de cada dia e as pastas por assunto |
| A busca em conversas | o fichário com índice | qualquer coisa que vocês já conversaram, achada pela palavra |

**O caderno do dia** é a primeira coisa que ele lê quando a conversa começa. No topo ficam
quatro coisas sobre você, e só sobre você: seus objetivos, suas frentes de trabalho (com o
próximo passo e de quem é a vez), o que ele aprendeu do seu jeito, com a data em que aprendeu,
e as suas últimas mensagens. É assim que ele chega sabendo onde vocês pararam.

**A busca em conversas** é o que responde quando você diz "lembra quando eu falei de...". Ela
procura nas conversas antigas e nas anotações, e traz o trecho com a data. Funciona no próprio
servidor, sem internet e sem chave nenhuma. Quando você escreve, ela também pode soprar no
ouvido dele até três lembranças que tenham a ver com o assunto.

## 4. O sono (a consolidação da madrugada)

**Por que existe:** um caderno que só cresce vira bagunça. Todo mundo precisa de um momento
para arrumar as ideias, e o agente usa a noite para isso.

**Como funciona, em dois tempos:**

- **23h30, a reflexão:** ele relê o dia inteiro, escreve o diário, atualiza seus objetivos e
  tarefas, corrige o que achava de você se algo mudou, e deixa um resumo do dia no caderno.
  Se percebeu que vocês fizeram um processo que vai se repetir, anota para te perguntar se
  vale virar uma receita (item 5).
- **7h, a remontagem:** sem inteligência artificial nenhuma, o servidor vira a página: o resumo
  de hoje passa a ser "ontem", e o caderno fica pronto para o dia novo.

**Como você confere:** se existe o diário de ontem na pasta memory, o sono funcionou. É a prova
que vale, mais do que qualquer luz verde.

## 5. As receitas (as skills)

**O que é:** uma skill é um passo a passo escrito que ele lê antes de fazer um trabalho.

**Por que importa:** quando vocês levam uma hora para acertar um relatório, ele te pergunta se
quer transformar aquilo numa receita. Com o seu sim, ele escreve, e da próxima vez faz igual
em minutos. Se você corrigir alguma coisa depois, ele melhora a receita e te conta. Ele nunca
cria uma receita sem você concordar.

## 6. As rotinas (as do sistema e as suas)

**As do sistema** são as tarefas que o servidor faz sozinho, no horário: o sono da noite, a
remontagem da manhã, o índice da busca, o medidor de custo. A aba Operações mostra cada uma,
quando rodou e se deu certo.

**As suas** são os compromissos que você pede para ele: "todo dia às 9h me manda o resumo". Ele
marca no próprio servidor, e na hora certa recebe um recado escrito por ele mesmo e faz o
trabalho, mesmo sem ninguém falando com ele.

## 7. O batimento, o vigia e o modo de segurança

**O batimento** acontece a cada 30 minutos: o agente confere se tem motivo para falar com você
(uma pendência, um prazo, algo que prometeu). Sem motivo, fica quieto. É o que faz ele ser
proativo sem ser chato.

**O vigia** olha de 5 em 5 minutos se o cérebro acordado continua de pé. Se caiu, levanta de
novo, esperando um pouco mais a cada tentativa para não entrar num ciclo de reinícios. Se
mesmo assim não volta, ele para de tentar e avisa, porque aí tem uma causa que precisa de gente
olhando.

**O modo de segurança** é para quando o problema está na própria conversa: um trecho que o
filtro de segurança da Anthropic bloqueia, ou uma conversa que ficou grande demais. Nesses casos,
reiniciar do jeito normal traria o problema de volta junto com a conversa. O modo de segurança
começa uma conversa nova, guarda a antiga e põe de lado a mensagem que travou. O caderno, a
ficha e as pastas continuam intactos: ele perde só o fio daquela conversa, e te avisa que voltou.

## 8. A compactação

**O problema:** a cabeça dele tem tamanho. Uma conversa que dura semanas uma hora não cabe.

**A solução:** quando a conversa fica grande, ele salva o que importa no caderno e resume o
resto, como quem passa a limpo um caderno cheio. Ele continua sendo o mesmo, com a mesma
memória; só fica mais leve para pensar.

## 9. O custo

**De onde vem:** o agente usa a sua assinatura do Claude. Cada mensagem que ele lê e escreve
consome um pouco dela.

**Onde ver:** a aba Custos mostra o gasto do dia e do mês. Você define um teto, e ele avisa
quando passa de 50, 75, 90 e 100 por cento.

**O que mais pesa:** conversa muito longa (ele relê o contexto a cada mensagem) e trabalho
pesado como pesquisa grande. A compactação e o sono existem também para manter isso sob
controle.

## Quando algo dá errado

Se ele parar de responder, abra o Claude Code no servidor (ou a sessão de socorro do painel) e
diga: "aconteceu alguma coisa com meu agente, vê aí". Existe um manual de emergência que o
Claude lê e segue: ele descobre a causa, te explica em uma frase, pergunta se pode consertar e
confere com você que voltou.
