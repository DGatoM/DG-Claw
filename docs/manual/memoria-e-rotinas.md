# Memória e rotinas

Esta página explica como o agente lembra do que o dono disse e como ele trabalha sem ninguém falando com ele: a memória em arquivos, a busca nas conversas antigas, o raio-X do cérebro no painel, as rotinas da noite e da manhã, os pokes, os lembretes e a agenda. Cada recurso diz o que é, como pedir ou onde clicar, o que precisa estar configurado, os limites e o que fazer quando dá erro.

Antes de tudo, uma regra que vale para o resto da página: a memória do agente é texto em arquivo. Não existe banco fechado. O painel lê os mesmos arquivos que o agente lê, e quando o dono salva uma correção, ela vai para o mesmo lugar de onde o agente lê.

## As camadas da memória

**O que é.** Cada agente guarda o que aprende em quatro lugares, dentro da casa dele.

| Camada | Arquivo | O que guarda | Quem escreve |
| --- | --- | --- | --- |
| Caderno do dia | `working-memory.md` | Objetivos do dono, tarefas em andamento, o que o agente sabe sobre ele e as últimas conversas | Uma rotina remonta todo dia às 7h; o agente acrescenta ao longo do dia |
| Ficha de longo prazo | `MEMORY.md` | O que vale para sempre: nome, preferências, pessoas, regras | O agente, na reflexão da noite |
| Quem é o dono | `CREATOR.md` | Quem é o dono para ele | Nasce na instalação; quem muda é o dono |
| Pastas por assunto e diário | `memory/` | Um diário por dia (`AAAA-MM-DD.md`) e arquivos por assunto (preferências, pessoas, projetos, pesquisas) | O agente, quando aprende algo |

**Como pedir.** "Anota que eu prefiro reunião de manhã." "Lembra quando eu falei do contrato do Paulo?" A skill `memory` busca no passado e gerencia a memória.
**Onde ver e corrigir.** Aba `aba:memory` do painel: todos os arquivos de memória, em texto que o dono lê e edita à mão. A aba `aba:status` mostra o cartão da memória de trabalho (se está em dia, o tamanho, o teto e se a remontagem das 7h rodou).
**Limites.** Depois de salvar uma correção, o painel oferece **Avisar ele agora**, porque o agente só relê o arquivo no começo da próxima conversa. Se o agente escreveu no arquivo enquanto o dono editava, o servidor recusa a gravação e deixa o texto do dono na caixa. A memória do dono fica dentro da casa do agente, e o colaborador convidado só lê.
**Se der erro.** Cartão de memória de trabalho vermelho ou amarelo: a remontagem das 7h não rodou. Veja a aba `aba:operations`. Mais em [../../panel/docs/CEREBRO.md](../../panel/docs/CEREBRO.md) e [../../panel/docs/MEMORIA-DE-TRABALHO.md](../../panel/docs/MEMORIA-DE-TRABALHO.md).

## O raio-X do cérebro

**O que é.** O Cérebro é a vista que o painel dá da memória: na aba `aba:status`, o bloco "O que ele sabe agora" traz um cartão por arquivo vivo da memória, com quando mudou ("há 2 h"), quem escreve e uma prévia. Clicar abre o arquivo inteiro no leitor, que também serve para editar. A aba `aba:como` mostra o texto "Como o agente funciona por dentro" com os números reais daquele agente ao lado.
**Limites.** O conteúdo dos arquivos é escapado antes de aparecer, então nenhuma marcação dentro deles se executa na tela. O texto da aba `aba:como` é o de [../RADIOGRAFIA.md](../RADIOGRAFIA.md), que foi escrito em 17/10 e fala só do Claude.
**Se der erro.** Aba sem texto: o painel avisa que o texto ainda não foi instalado naquele agente, sem mostrar tela em branco.

## Busca em conversas antigas

**O que é.** A busca que responde "lembra quando eu falei de...". Procura nas conversas antigas e nas anotações, pela palavra, e traz o trecho com a data. Roda no próprio servidor, sem internet e sem chave.
**Como pedir.** Pergunte do jeito natural ("o que eu falei sobre o contrato?"). A skill `memory` faz a busca.
**Precisa de.** Nada. O índice é atualizado por uma rotina a cada 15 minutos e de novo na remontagem das 7h.
**Limites.** Acha pela palavra, não pelo sentido. A mensagem que travou o agente e foi posta de lado pelo modo de segurança não volta por esse caminho.
**Se der erro.** Se a busca não acha algo que existe, o índice pode estar atrasado, no máximo um dia. Peça ao Admin para conferir a rotina na aba `aba:operations`.

## Memória semântica (busca por sentido)

**O que é.** Uma busca que acha pelo sentido: "quando eu marquei com o contabilista?" encontra o diário que diz "o contador Paulo marcou a reunião de quinta". Usa um modelo pequeno que roda na própria VPS, sem chave e sem enviar texto para fora.
**Estado.** Parcial. O código existe e as rotinas de reindexação (todo dia às 4h20) estão instaladas, mas o instalador do DG Claw v1 não baixa o modelo (333 MB). Sem o modelo, a reindexação só registra que está desligada. Quem quer o recurso pede ao Admin que rode `scripts/install-embedding-local.sh`. O texto de [../MEMORIA-SEMANTICA.md](../MEMORIA-SEMANTICA.md) diz que o modelo vem de fábrica no instalador; isso foi escrito para a versão antiga.
**Limites.** Só funciona nos agentes em Claude para o eco automático do passado (veja [provedores.md](provedores.md)).
**Se der erro.** O Admin roda `python3 scripts/memory_index/embedder.py status` dentro do agente, que diz qual modelo está valendo e por quê.

## Rotinas da noite e da manhã

**O que é.** Tarefas que o servidor faz sozinho, no horário, para o agente não esquecer o que aconteceu:

| Rotina | Quando | O que faz |
| --- | --- | --- |
| Reflexão | Todo dia às 23h30 | O agente relê o dia, escreve o diário, atualiza objetivos e tarefas e corrige o que achava do dono, se algo mudou |
| Remontagem do caderno | Todo dia às 7h | Sem IA nenhuma: o resumo de hoje vira "ontem" e o caderno fica pronto para o dia novo |
| Índice da busca | A cada 15 minutos | Atualiza a busca em conversas |
| Reindexação semântica | Todo dia às 4h20 | Atualiza a memória semântica (só com o modelo instalado) |
| Batimento | A cada 30 minutos | O agente confere se tem motivo para falar com o dono (uma pendência, um prazo, algo que prometeu). Sem motivo, fica quieto |
| Vigia | A cada 5 minutos | Confere se a sessão do agente continua de pé e a levanta de novo, esperando mais a cada tentativa. Se não volta, para de tentar e avisa |
| Compactação automática | A cada 30 minutos | Quando a conversa fica grande, pede ao agente que salve a memória e compacte |
| Verificação de recibo | A cada 15 minutos | Confere se os pokes chegaram e reenvia ou avisa |
| Custos | A cada 5 minutos e de hora em hora | Registra os tokens e avisa quando o gasto do mês passa de 50, 75, 90 e 100% do teto |

**Onde ver.** A aba `aba:operations` mostra cada rotina com uma fileira de quadrados das últimas execuções: verde deu certo, vermelho falhou, amarelo pede atenção, amarelo listrado é "não rodou quando devia" e cinza é "sem dado", que nunca conta como sucesso. Em cima, uma frase resume: "Tudo funcionando" ou "2 operações pedem atenção".
**Precisa de.** Nada, as rotinas são instaladas junto com o agente. O vigia e a compactação automática ficam desligados se `DGCLAW_AUTO_RECOVERY=off` estiver na configuração do agente.
**Limites.** No Codex, os pokes e o batimento funcionam; o que lê a conversa gravada pelo Claude (reflexão, caderno do dia e índice da busca) funciona só em parte, e a compactação automática ainda não funciona (veja [provedores.md](provedores.md)). O aviso de custo precisa de um teto em dólares na configuração do painel (`budgetUsd`); sem teto, o painel não inventa um. Avisos que as rotinas mandam ao dono só são entregues se houver Telegram ou outro transporte configurado: no DG Claw sozinho, só o painel mostra o problema.
**Se der erro.** A aba `aba:operations` mostra a rotina que falhou e o registro dela. Mais em [../../panel/docs/OPERACOES.md](../../panel/docs/OPERACOES.md) e [../SAUDE-E-MODO-SEGURO.md](../SAUDE-E-MODO-SEGURO.md).

## Pokes

**O que é.** Um poke é uma tarefa que uma rotina injeta na sessão viva do agente, em vez de abrir uma chamada nova à IA. A rotina prepara o que for determinístico e o agente executa lá dentro, na assinatura que o dono já paga. A reflexão, o batimento e a compactação automática são pokes.
**Como saber se deu certo.** O poke de texto termina com um recibo que o agente grava (`poke-ack.sh`); o comando de compactação deixa um marcador na conversa. A rotina `poke-verify` confere os dois a cada 15 minutos, reenvia o que faltou e avisa o dono se esgotar as tentativas.
**Limites.** A injeção só pega com a sessão ociosa; se o dono está no meio de um turno, o poke espera.
**Se der erro.** Mais em [../POKES.md](../POKES.md). O texto desse documento descreve o transporte por teclas de um modelo mais antigo; hoje o recado entra pelo runner.

## Lembretes

Os lembretes que insistem até o dono confirmar têm a página própria em [conversa-e-telas.md](conversa-e-telas.md) e a tela `/lembretes`. O Web os dispara sozinho, sem depender da sessão do agente.

## Agenda: compromissos do próprio agente

**O que é.** A skill `agenda` marca no servidor um compromisso do agente, como "todo dia às 9h me manda o resumo". Vira um timer do sistema, que sobrevive a reinício e dispara sozinho, com ninguém falando com o agente. Na hora, o agente recebe um recado escrito por ele mesmo e faz o trabalho.
**Como pedir.** "Todo dia às 9h me manda o resumo das tarefas." Para ser lembrado de algo, o certo é um lembrete; a agenda serve para trabalho do agente. A skill entende que "Chrome" e "crome" num áudio querem dizer "cron".
**Onde ver.** Aba `aba:rotinas`: as rotinas e lembretes que o agente marcou a pedido do dono, com a próxima hora e como foi a última vez. A lista se atualiza sozinha.
**Limites.** Os compromissos vivem no servidor, não na sessão: fechar a conversa não os cancela. Para o agente agendar algo "só durante o trabalho de agora", é outro mecanismo.
**Se der erro.** Se um compromisso não dispara, o Admin confere a unidade em `aba:operations` e roda `dgclaw agente reparar <slug>`.

## Custos

**O que é.** A aba `aba:costs` mostra quanto o agente custou no mês, por categoria e por rotina, contra o teto definido. A leitura vem do registro de tokens da sessão viva, que uma rotina atualiza a cada 5 minutos.
**Limites.** Só funciona nos agentes em Claude. Quanto da assinatura já foi usado aparece à parte, no uso das janelas (veja [conversa-e-telas.md](conversa-e-telas.md)). Em agente na API, o gasto de verdade também aparece no painel do provedor.
