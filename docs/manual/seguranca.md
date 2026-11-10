# Segurança

Esta página mostra o que o DG Claw faz para proteger o seu servidor, as suas chaves e as suas conversas, onde
você mexe em cada proteção e o que ela não cobre. O texto técnico completo está em [SEGURANCA.md](../SEGURANCA.md);
aqui fica o que o dono precisa saber para decidir e para pedir as coisas certas ao Admin.

Para relatar uma falha de segurança, siga o [SECURITY.md](../../SECURITY.md) do repositório.

## O que você precisa saber em cinco linhas

1. Para o DG Claw, só o Caddy (portas 80 e 443, com HTTPS) atende a internet. O painel, o runner e os serviços internos
   escutam apenas dentro do servidor. O firewall deixa aberta também a porta 22, do SSH, para você não perder o acesso.
2. Cada agente de trabalho vive no próprio container, com o próprio cofre, e não enxerga o servidor nem os outros agentes.
3. As chaves que você guarda no cofre valem só para o agente em que você as guardou e nunca aparecem inteiras
   na tela, na API ou no registro.
4. O DG Claw avisa sozinho quando sai versão nova, falha nas ferramentas dele ou falha no seu servidor.
5. O agente começa com poderes limitados (o Gmail nasce só lendo) e você libera aos poucos.

## Isolamento dos agentes

**O que é.** Cada agente roda num container sem privilégio de root. O firewall do servidor descarta qualquer
pacote que o container mande para o próprio servidor, para o gateway, para os outros containers e para redes
privadas. A saída para a internet continua aberta, porque o agente precisa falar com o provedor de IA e com os
sites que você mandar ele usar.

**Como conferir.** Peça ao Admin: "roda o teste de isolamento dos meus agentes". Ele roda
`bash scripts/teste-isolamento.sh <slug>` (ou sem o nome, para testar todos). O teste tenta, de dentro do
container, alcançar o servidor, os vizinhos e o endereço de metadados da nuvem. Sai com 0 quando tudo foi
bloqueado e a internet respondeu, 1 se algo respondeu e 2 quando não conseguiu concluir.

**Limites.**

- Dentro do próprio container o agente tem poderes de administrador (`sudo` sem senha). É o container que contém
  o estrago, não o agente.
- A saída livre para a internet quer dizer que um agente enganado por um texto malicioso poderia mandar o que
  tem no container para fora. Por isso o agente trata e-mails, páginas e arquivos como material de leitura, nunca
  como ordem, e começa com poucos poderes.
- Quem tem root no servidor enxerga tudo, inclusive o cofre.

**Se der erro.** O teste de isolamento que responder "algo respondeu" é problema real: peça ao Admin para rodar
`sudo dgclaw agente reparar <slug>` e depois repetir o teste. Se continuar, relate pelo
[SECURITY.md](../../SECURITY.md).

## O Admin roda como root, e por quê

**O que é.** O Admin é o agente que instala, atualiza, cria e conserta os outros agentes. Isso exige mexer em
serviços, containers e firewall do servidor, por isso ele roda como root (a unidade `dgclaw-admin` do systemd
usa `User=root`). A vantagem é que você resolve quase tudo conversando pelo painel, sem voltar ao terminal.

**As travas que existem em volta dele.**

- Só o dono fala com ele, pelo chat do painel. O Admin trata como dado qualquer coisa que venha de outro caminho.
- Ele não tem canal externo: o comando `dgclaw-agente` recusa rodar no Admin. Telegram e WhatsApp são dos agentes de trabalho.
- Ele fala só com o dono e trata como dado o que vier de outro caminho (e-mail, página, mensagem de canal). A regra do projeto é que o Admin não lê e-mail nem abre links de terceiros.
- O Admin não pode ser compartilhado com colaborador.
- Mexer na base do DG Claw (instalador, `bin/dgclaw`, `runner/`) é permitido, mas ele avisa o dono do risco para as
  próximas atualizações. Continuam fora, mesmo a pedido: o cofre e os segredos, o firewall, a autenticação do painel,
  o isolamento dos containers e os ganchos de segurança. Veja [personalizar.md](personalizar.md).

**Limite.** Um Admin com root é tão confiável quanto a conversa que você tem com ele. Não cole nele texto de
origem desconhecida pedindo que execute algo.

## Firewall e portas

**O que é.** O instalador liga o firewall (`ufw`) com três portas abertas: 22 (SSH), 80 e 443 (o Caddy, para o HTTPS
automático). Os serviços do DG Claw ficam em `127.0.0.1`. A cerca dos containers é refeita a cada boot e toda vez que um agente nasce (`lib/firewall.sh`).

**O que fazer quando dá erro.** Se o painel não abrir depois de trocar o domínio, o problema quase sempre é o
firewall do provedor da VPS bloqueando as portas 80 e 443. Veja [atualizar-e-backup.md](atualizar-e-backup.md).

## Cofre das chaves

**O que é.** Cada agente tem um cofre próprio para as chaves de serviço (OpenAI, Gemini, ElevenLabs e outras). A
tela e a API mostram quem guardou, quando e os 4 últimos caracteres. Nunca o valor.

**Como pedir ou onde clicar.** Na aba **Cofre** do painel do agente, ou pedindo ao agente na conversa
([COFRE-NA-CONVERSA.md](../COFRE-NA-CONVERSA.md)). O Admin guarda por comando com `dgclaw agente cofre` ou pela
API ([COFRE-POR-API.md](../COFRE-POR-API.md)). O agente só passa a usar a chave nova depois de reiniciar: a tela e os comandos têm a opção de aplicar (reiniciar) na mesma hora.

**Limites.**

- Uma chave guardada num agente vale só para ele. Para outro agente usar, guarde de novo nele.
- O agente precisa do valor para usar a chave, então um agente com `sudo` dentro do container consegue lê-lo. O cofre
  evita o vazamento acidental, não um agente comprometido. Defina um limite de gasto no provedor de cada chave.
- O colaborador nunca vê nem mexe no cofre.
- No agente Codex na assinatura, a `OPENAI_API_KEY` do cofre fica de fora, porque disputaria com o login do ChatGPT.

**Se der erro.** O cofre recusa nomes que começam com `vault:` (apelido de chave de outro cofre). Guarde o valor
de verdade.

## Entrar no painel

**O que é.** O login do dono usa senha com hash scrypt, nunca em texto. A sessão vence em 30 dias.

**Como funciona na prática.**

- **Primeiro acesso:** o instalador entrega um link de uso único, válido por 30 minutos (`/primeiro-acesso`). Você
  cadastra a senha ali (mínimo de 12 caracteres). Link perdido: peça ao Admin `sudo dgclaw primeiro-acesso`.
- **Trocar a senha:** `sudo dgclaw senha trocar` (a senha nova vai pelo teclado, sem aparecer). Trocar a senha
  derruba as sessões abertas.
- **Tentativas erradas:** 5 erros em 15 minutos para a mesma conta e o mesmo endereço, ou 20 erros em 15 minutos
  para o mesmo endereço somando todas as contas, bloqueiam novas tentativas até a janela passar. Nem a senha certa
  entra durante o bloqueio, e a tela diz quantos segundos esperar.
- **Colaboradores:** pessoas convidadas por você para um agente só. Entram por `/login` com a senha temporária,
  trocam a senha em `/trocar-senha` e enxergam apenas o agente delas. Detalhes em
  [COLABORADORES.md](../../web/docs/COLABORADORES.md) e na tela `/colaboradores`.
- **Chaves de API do painel** (`dgc_...`): servem para o Admin operar o painel de um agente. Aparecem uma vez só, ficam
  guardadas como hash, e uma chave nunca cria outra.
- **Contra páginas maliciosas:** pedidos que mudam algo conferem a origem. Sair é só por POST.

**Se der erro.** Painel "trancado" quer dizer senha ausente ou fraca: use o link de primeiro acesso ou
`sudo dgclaw senha trocar`. Bloqueio por tentativas: espere o tempo que a tela mostrar.

## Ronda de segurança

**O que é.** Todo DG Claw vem com uma ronda que, algumas vezes por dia, procura falhas de segurança que afetam
**a sua** instalação (pacotes do servidor, o kernel em uso, portas abertas, o próprio DG Claw e os serviços que você
conectou, como Notion ou Google Drive). O resultado aparece na tela `/seguranca` (menu **Segurança**).

**Os três níveis.**

| Nível | O que é | O que acontece |
| --- | --- | --- |
| 1 | Falha crítica com uma ação segura no catálogo, que não pede reinício | A ronda aplica, testa se o painel continua bem e desfaz se algo piorou |
| 2 | Falha crítica sem ação segura, sem correção, ou que pede reinício | Avisa e espera a sua decisão: aplicar, agendar ou deixar |
| 3 | Falha leve ou média | Aparece no painel, com a correção quando já existe |

**Como pedir.** "Admin, como está a ronda de segurança?" Ele roda `sudo dgclaw seguranca estado` e
`sudo dgclaw seguranca resumo`. Para fazer uma rodada na hora: `sudo dgclaw seguranca rodar`.

**Quando a correção ainda não saiu.** A falha não assusta: fica na seção "Aguardando correção oficial" da tela
Segurança. Se existe uma proteção provisória conhecida, o painel oferece **Aplicar proteção provisória**.

**O que sai do servidor.** Nenhuma conversa, chave ou arquivo. As fontes de falhas recebem os nomes e as versões dos
pacotes instalados e o endereço IP do servidor.

**Limites.** Só se corrige sozinho o que uma pessoa escreveu antes no catálogo do DG Claw; nada vem de texto de
notícia nem é inventado pela IA. Para a ronda nunca aplicar nada sozinha, ponha `DGCLAW_RONDA_APLICAR_SOZINHA=0`
no `/etc/dgclaw/dgclaw.env`. Para desligar: `DGCLAW_RONDA_SEGURANCA=0`.

**Se der erro.** Ronda "parcial" quer dizer que uma fonte não respondeu. A tela diz qual. Ela nunca parece limpa
quando não é. Mais em [RONDA-DE-SEGURANCA.md](../RONDA-DE-SEGURANCA.md).

## Sentinela do servidor

**O que é.** Uma vigia que olha, a cada minuto, o disco, a memória, os agentes e os serviços do servidor, e avisa você
antes de alguma coisa parar. Disco cheio derruba tudo, e foi o que motivou a sentinela. Ela aparece no cartão **Saúde do
servidor** da tela Segurança e numa faixa no alto das telas quando a coisa fica séria.

**O que ela faz sozinha.** Limpa só o que o catálogo fechado permite (logs antigos, caches, imagens soltas), guarda uma
reserva de disco que libera sozinha no último momento e, se a memória acaba, fecha o navegador do agente que mais gasta.
Ela nunca reinicia agente nem serviço: ela avisa e diz o comando.

**Como receber os avisos.** Sem Telegram ou e-mail configurados, os alarmes só aparecem no painel. Peça ao Admin:
"configura os avisos da sentinela no Telegram". O passo a passo, inclusive do monitor externo que avisa se o servidor
inteiro cair, está em [SENTINELA.md](../SENTINELA.md).

**Como pedir.** "Admin, como está a saúde do servidor?" Ele roda `sudo dgclaw sentinela estado`. Para ver o que está
ocupando espaço: `sudo dgclaw sentinela levantar`. Quem apaga o que não é do catálogo é você, com o Admin, caso a caso.

## Boletins de segurança

**O que é.** Quando a equipe do DG Claw descobre uma falha numa das ferramentas que o programa usa, publica um
boletim no repositório oficial. O seu servidor percebe sozinho (consulta pública a cada hora, sem mandar dados seus) e
mostra o aviso **"Seu ambiente está em risco"**, junto com um selo no alto das telas até o assunto se resolver.

**O que você faz.** Abra a tela Segurança, leia o aviso e clique em **Atualizar**: o painel abre o chat do Admin com
o pedido já escrito. Os botões **Lembrar depois** e **Entendi** adiam ou dispensam, conforme o caso.

**Limites.** O aviso só informa. Nada é baixado ou instalado sem o seu ok. Para desligar a checagem:
`DGCLAW_BOLETINS_SEGURANCA=0` no `dgclaw.env`. Detalhes em [BOLETINS-DE-SEGURANCA.md](../BOLETINS-DE-SEGURANCA.md).

## Botão de emergência

**O que é.** Tira o servidor da internet quando uma falha crítica está sendo explorada e a correção ainda não pode
ser aplicada. O painel e os sites saem do ar. O seu acesso de administração pelo Tailscale continua. Se ninguém
confirmar em 5 minutos, o servidor religa sozinho.

**Onde clicar.** Tela `/seguranca`, bloco "Botão de emergência". No terminal, o caminho é
`sudo dgclaw emergencia` e a ordem é: `simular`, `preparar` (gera um código de uso único que vale 2 minutos),
`cortar --codigo <código>`, `confirmar` e, quando passar, `religar --codigo <código>`. A tela pede o código e a frase
`TIRAR-DO-AR`.

**O que precisa estar configurado.** O Tailscale logado (ou ao menos um IP em `IPS_ADMIN`) e o `nft` instalado. Sem
um caminho de acesso garantido, o botão fica desligado e a tela diz o motivo, para você não se trancar para fora.

**Limites.**

- O painel também sai do ar durante o corte. Para confirmar e religar, entre no servidor por SSH pelo Tailscale.
- O corte não sobrevive a um reinício do servidor. Depois de reiniciar, a tela mostra "Falha de proteção"; rode
  `preparar` e `cortar` de novo, ou `religar`.

**Se der erro.** `sudo dgclaw emergencia estado` diz se está cortado, normal ou inconsistente. Guia completo em
[EMERGENCIA.md](../EMERGENCIA.md).

## Saúde do agente e modo de segurança

**O que é.** O painel mede se o agente está **respondendo**, não só de pé. O selo no cabeçalho fica verde, amarelo
ou vermelho e a frase diz o motivo (resposta cortada pelo filtro da Anthropic, conversa grande demais, login vencido,
limite de uso, sobrecarga).

**O que fazer.** Selo amarelo: normalmente basta esperar alguns minutos. Selo vermelho: use o botão da faixa na aba
Conversa (**Reiniciar** ou **Reiniciar em modo de segurança**). O modo de segurança volta o agente numa conversa
nova, guarda em quarentena a mensagem que travou e não reenvia essa mensagem. Sem entender o que houve: abra a aba
**Socorro**, que abre um Claude neutro que lê os registros, explica e pergunta antes de mexer (a skill `socorro`).

**Limites.** Para o aviso de login vencido não há botão: quem cuida do servidor precisa refazer o login da conta do
agente, pela página `/conectar`. Mais em [SAUDE-E-MODO-SEGURO.md](../SAUDE-E-MODO-SEGURO.md).

## Sigilo: modo escondido e anonimizar documentos

- **Modo escondido** (o olhinho no cabeçalho da conversa): troca por asteriscos nomes, valores, e-mails, telefones,
  CPF, CNPJ e chaves, para você mostrar a tela numa aula sem expor cliente. O filtro automático funciona sempre; o
  completo (nomes e empresas) precisa de uma `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` no `web.env`. Peça ao Admin:
  "liga o modo escondido completo". Em caso de falha do modelo, a mensagem continua coberta. Detalhes em
  [MODO-ESCONDIDO.md](../MODO-ESCONDIDO.md).
- **Anonimizar documentos** (tela `/anonimizar`): o agente recebe o documento com marcadores como `[PESSOA_1]` e
  `[CPF_1]`, e você continua lendo tudo completo. Só vale para o clipe da conversa web; o que chega por WhatsApp,
  Telegram ou e-mail não passa pelo filtro, e nenhum detector acha 100% dos nomes. Detalhes em
  [ANONIMIZAR.md](../ANONIMIZAR.md).

## Conectores e canais

- **Gmail, Agenda e Drive:** só aparecem quando o agente está logado na assinatura pelo `/login` do container. O
  Gmail nasce só lendo (pesquisa, lê e deixa rascunho). Enviar, responder, encaminhar e apagar ficam bloqueados.
  Para liberar o envio, peça ao agente com as suas palavras; você recebe um aviso a cada liberação. Apagar continua
  bloqueado. Veja [GMAIL-NO-AGENTE.md](../GMAIL-NO-AGENTE.md).
- **WhatsApp:** usa uma biblioteca não oficial, e a Meta pode banir o número. Use um número secundário, nunca o
  principal do negócio. Só os números da lista de permitidos conversam com o agente.
- **Texto que vem de fora** (e-mail, página, arquivo, mensagem de canal) é material para o agente ler, nunca ordem.

## O que a segurança do DG Claw não faz

A lista completa está em [o-que-nao-faz.md](o-que-nao-faz.md). Os pontos que mais importam aqui:

- Não protege contra quem tem root no servidor.
- O provedor do modelo (Anthropic, OpenAI) recebe o que o agente manda para ele.
- Um agente enganado ainda consegue mandar dados para a internet; por isso os poderes começam limitados.

## Onde está cada coisa para o Admin

As rotas e os comandos desta página estão em [referencia-admin.md](referencia-admin.md).
