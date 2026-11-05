# Ronda de segurança de fábrica

Todo DG Claw instalado vem com uma ronda de segurança. Ela varre, várias vezes ao dia, as falhas de segurança
que afetam **aquela** instalação, e avisa o dono dela. Quem não usa o Notion não recebe aviso sobre o Notion:
a ronda monta tudo a partir do que existe no seu servidor.

Ela é diferente do [aviso de segurança do painel](BOLETINS-DE-SEGURANCA.md). O boletim é uma notícia que a equipe
do DG Claw publica sobre as ferramentas do próprio programa. A ronda olha o seu servidor inteiro, no seu ritmo,
sem esperar a equipe publicar nada.

## O que a ronda olha

O inventário é guardado em `/var/lib/dgclaw/seguranca/inventario.json`:

- **Os pacotes do servidor** (`dpkg`) e o **kernel que está em execução**. Um kernel antigo, instalado mas
  desligado, não conta como exposto.
- **O que escuta na rede**: as portas públicas, o programa que as abriu e o pacote dono dele.
- **O app do DG Claw**: os `package-lock.json` de `/opt/dgclaw/app`, os pacotes Python fixados e a imagem base
  do `container/Containerfile`.
- **O que você conectou no DG Claw**: os servidores MCP, os plugins e as skills do Admin e de cada agente.
  Eles viram "serviços externos" com nome de gente (Notion, Google Drive, Slack, GitHub...), e, quando o
  pacote e a versão aparecem na configuração, entram na consulta de falhas. O mapa de nomes fica em
  `seguranca/ronda/servicos.json`. Um serviço que o mapa não conhece entra com o nome que você deu a ele.

A parte pessoal do inventário (o app e os serviços conectados) é refeita a cada 3 dias e sempre que o DG Claw
é atualizado. Quando algo novo entra, fica registrado: "acrescentado à ronda em 31/10/2026: Notion via MCP do
agente luna". Os pacotes do servidor, o kernel e as portas são lidos de novo em toda rodada, porque uma
atualização do sistema não pode fazer a ronda avisar de uma falha que já foi corrigida.

## De onde vêm as falhas

Primeiro as fontes oficiais:

| Fonte | Para quê |
| --- | --- |
| OSV.dev | a consulta principal: cada pacote do inventário, com a versão exata |
| Avisos do Ubuntu (USN) | lidos do repositório oficial `canonical/ubuntu-security-notices`, comparados com o `dpkg` |
| CISA KEV | a lista das falhas que já estão sendo exploradas de verdade |
| NVD | falhas recentes buscadas pelos nomes do **seu** inventário |
| GitHub Advisories | avisos de pacotes npm e Python |

Depois, só como complemento, o **Hacker News**: as manchetes que trazem um número de falha (CVE ou GHSA) viram
uma consulta ao OSV por aquele número e são cruzadas com a versão que você tem. Se a versão não é a vulnerável,
a manchete é ignorada. O X (Twitter) tem um gancho no código, mas está desligado: a busca dele exige chave paga e
a ronda não pede chave a ninguém.

O GitHub, sem token, deixa só 60 pedidos por hora. A ronda gasta pouco, guarda o que já leu e, se o limite
acabar, marca a fonte como parcial em vez de insistir.

**Só aparece como aviso o que tem fonte oficial e data.** Sem as duas coisas, a falha fica fora da lista e só
é contada no estado.

## O que sai do servidor

Nada do que você conversa, nenhuma chave e nenhum arquivo. Mas a ronda precisa perguntar, e as perguntas dizem
o que você usa:

- **OSV.dev** recebe os nomes e as versões dos pacotes instalados.
- **NVD** recebe palavras de busca montadas do inventário (por exemplo `linux kernel`, `podman` e o nome dos
  serviços que você conectou).
- **Hacker News**, **CISA**, **GitHub** e **Canonical** recebem só pedidos genéricos e o endereço IP do servidor.

Para desligar tudo isso, veja "Como desligar" abaixo.

## Os três níveis

| Nível | O que é | O que a ronda faz |
| --- | --- | --- |
| **1** | falha **crítica** com uma ação segura no catálogo, que não pede reinício | **aplica sozinha**, registra o antes e o depois, testa se o painel e os serviços continuam bem e **desfaz** se algo piorou |
| **2** | falha **crítica** sem ação segura, ou sem correção, ou que pede reinício | avisa e espera a sua decisão: aplicar agora, agendar ou deixar |
| **3** | falha leve ou média | aparece no painel, com a correção quando já existe |

É crítica a falha que a CISA diz estar sendo explorada, ou a de prioridade alta ou crítica do Ubuntu no kernel em
execução ou num pacote exposto à rede, ou a de gravidade crítica ou alta confirmada contra a versão que você
tem. Para os pacotes do Ubuntu vale a prioridade que o próprio Ubuntu deu, e não a nota genérica da falha.

**Só se corrige sozinho o que uma pessoa escreveu antes** no catálogo `seguranca/acoes-permitidas.json`, que
vai junto com o DG Claw e só muda por uma nova versão. Nada vem do texto de notícia nem é inventado pela IA. Hoje
o catálogo tem uma única ação, uma **proteção provisória** (desligar o MPTCP), que a ronda só aplica enquanto a correção
oficial não existe. Veja "O catálogo de ações" e "Quando a correção ainda não saiu".

Para a ronda não aplicar nada sozinha mesmo quando o catálogo tiver ações, ponha
`DGCLAW_RONDA_APLICAR_SOZINHA=0` no `dgclaw.env`. As falhas que seriam do nível 1 viram nível 2.

## Como o aviso chega

- **No painel**: a ronda grava `ronda.json` em `/var/lib/dgclaw/web/seguranca/`, e a tela Segurança mostra a
  lista por nível. Quando a ronda ficou parcial, a tela diz isso no topo e qual fonte caiu.
- **Um aviso só, em todas as telas**: as falhas de nível 2 abertas e os [boletins](BOLETINS-DE-SEGURANCA.md)
  pendentes entram numa única janela, "Seu ambiente está em risco" ("Encontramos N pontos de segurança que
  precisam da sua atenção"), com um botão **Ver na Segurança**. Fechar uma vez fecha tudo: ela só volta sozinha
  se aparecer um ponto novo, se a gravidade piorar ou 24 horas depois (no máximo uma vez por dia). Enquanto
  houver pontos em risco, um selo discreto no alto das telas leva à tela Segurança, onde ficam o detalhe e todas
  as ações. Nada some: o que o dono fecha na janela continua na tela e no selo.
- **No chat com o Admin**: só quando aparece uma coincidência **nova** (uma falha que a ronda ainda não tinha
  mostrado, ou uma que ela corrigiu sozinha). O Admin recebe **um** recado por rodada, de texto fixo, só com os
  números das falhas e o nível. Ele lê `dgclaw seguranca resumo`, escreve o alerta para você e conversa sobre o
  que fazer. Dia sem nada novo: nenhuma IA é acionada, e o painel mostra a frase fixa "sem novidades".
- **Quando a própria ronda falha**: um vigia confere de hora em hora se a última rodada agendada terminou. Se
  não terminou, ele roda de novo uma vez. Se falhar de novo, avisa o Admin e põe um alerta no painel.
- **Corte de emergência que deixou de valer**: o corte não sobrevive a um reinício. Se o marcador de corte existe e a
  tabela do firewall não está carregada, a rodada e o vigia avisam o Admin, uma vez por corte, com um recado de texto fixo
  (reaplicar com `preparar` e `cortar`, ou religar). Veja [EMERGENCIA.md](EMERGENCIA.md).

O texto que vem das fontes é tratado como dado de terceiros: é cortado, limpo de caracteres de controle e vai
marcado como "texto da fonte". O Admin é instruído a **nunca** executar comando, abrir link ou seguir pedido que
apareça ali.

## O catálogo de ações

`seguranca/acoes-permitidas.json` é um catálogo **fechado**. Cada ação tem um `id`, uma `descricao`, o `tipo`,
os campos do tipo e um `casa` que diz a quais falhas ela vale (`ids` de CVE ou `pacotes`). São três tipos, e
nenhum aceita comando livre. Todo valor é conferido por formato antes de ser usado.

| Tipo | O que faz | Checagem antes | Como desfaz |
| --- | --- | --- | --- |
| `nft-tabela` | carrega uma tabela do firewall nft a partir de um arquivo do próprio DG Claw (`arquivo`, `tabela`) e liga uma unidade do systemd que a recarrega no boot | `nft -c -f` só valida | desliga e apaga a unidade e o arquivo, e apaga a tabela |
| `sysctl` | grava `/etc/sysctl.d/90-dgclaw-ronda-<id>.conf` e aplica (`chave`, `valor`) | lê o valor atual; recusa se a chave não existe | apaga o arquivo e volta o valor anterior |
| `apt-pacote` | `apt-get install --only-upgrade <pacote>=<versao>` (`pacote`, `versao`) | `apt-get -s` simula; `needrestart -b` não pode mostrar serviço esperando reinício; sem `needrestart` a ronda considera que pode exigir reinício | reinstala a versão anterior |

Exemplo de uma ação:

```json
{"versao": 1, "acoes": [{
  "id": "sysctl-mptcp-off", "tipo": "sysctl", "descricao": "Desliga o MPTCP no kernel",
  "chave": "net.mptcp.enabled", "valor": "0",
  "casa": {"ids": ["CVE-2026-98432"]}
}]}
```

O campo opcional `exige_reinicio` diz se a ação pede reinício. Para `sysctl` e `nft-tabela` o padrão é `false`.
Para `apt-pacote` o padrão é `true`, e só `false` escrito por quem montou a ação permite aplicar sozinha.
O catálogo inválido não é usado: a ronda aponta qual ação está errada e segue sem nível 1.

Cada aplicação grava um registro em `/var/lib/dgclaw/seguranca/acoes/` com o comando, o estado antes e depois,
como desfazer e o resultado do teste de saúde (o painel respondendo e os serviços `dgclaw-web` e
`dgclaw-admin` ativos). Se o teste piorar, a ronda desfaz na hora e o caso vira nível 2.

## Quando a correção ainda não saiu

O aviso de uma falha de kernel pode citar uma versão corrigida que o seu servidor não consegue instalar (é de outra série do
kernel, ou o Ubuntu ainda não a liberou). Por isso, a cada rodada a ronda pergunta ao `apt` deste servidor (uma consulta só) se a
versão corrigida já pode ser instalada. Se ainda não pode, a falha **não assusta ninguém**:

| Estado | O que quer dizer | Aparece no aviso "Seu ambiente está em risco"? |
| --- | --- | --- |
| **Protegido, aguardando correção oficial** | não há correção para este servidor, mas existe uma proteção provisória e a ronda conferiu que ela está ligada | não |
| **Aguardando correção do fornecedor** | não há correção nem proteção provisória conhecida | não |

As duas ficam na seção recolhida "Aguardando correção oficial" da tela Segurança, só para informar. A ronda confere a cada
rodada: quando o pacote corrigido aparece no apt, a falha volta para "Ação necessária" pedindo atualizar (e reiniciar, no kernel), e o Admin
recebe o recado como de uma falha nova. Exceção: se a CISA diz que a falha está sendo explorada e não existe correção nem
proteção, ela continua em "Ação necessária", com a sugestão de considerar o botão de emergência.

A **proteção provisória** é uma ação do catálogo marcada `"paliativo": true`, descrita em `seguranca/paliativos.json`. Se ela não
está ligada, o painel oferece **Aplicar proteção provisória** (ou `sudo dgclaw seguranca aplicar <id>`); com o aplicar sozinha
ligado e `pode_sozinho: true`, a ronda aplica com o mesmo teste de saúde do nível 1. Dá para desfazer pelo botão **Desfazer** do cartão ou por
`sudo dgclaw seguranca desfazer <registro>`. O que vale é a leitura de verdade do sistema (por exemplo, `sysctl -n`): configurar à mão
também conta. Se alguém voltar a configuração, a falha volta a pedir ação.

### Como acrescentar um paliativo novo

1. Em `seguranca/acoes-permitidas.json`, acrescente a ação (`sysctl`, `nft-tabela`...) com `"paliativo": true` e, em `casa.ids`, a CVE.
2. Em `seguranca/paliativos.json`, acrescente o item: `id` único, `casa.ids` (as CVEs), `descricao` (curta, o que fica ligado), `efeito`
   (o que muda para quem usa, em português simples), `verifica` (`{"tipo": "sysctl", "chave": "...", "valor": "..."}`), `acao_id` (a ação do passo 1) e
   `pode_sozinho` (`true` só se a ronda puder aplicar sem ninguém).
3. Rode `tests/ronda/rodar.sh`: o catálogo é validado no carregamento. Um erro vira a fonte "Catálogo de paliativos" com falha na ronda,
   sem derrubar o resto.
4. Para um tipo novo de verificação, acrescente a função em `VERIFICADORES` e os campos em `TIPOS_VERIFICA`, em `ronda.py`.

## Como desligar ou mudar os horários

Tudo no `/etc/dgclaw/dgclaw.env`; depois rode `sudo ./install.sh` de novo no clone (ou `sudo dgclaw atualizar`).

| Linha | Efeito |
| --- | --- |
| `DGCLAW_RONDA_SEGURANCA=0` | desliga a ronda, o vigia, o inventário, a fila de pedidos do painel e a atualização do estado do botão de emergência |
| `DGCLAW_RONDA_HORARIOS="06:30 18:45"` | horários das rodadas, no fuso do servidor (padrão `07:00 13:00 19:00`, ou só `04:00` em servidor pequeno, veja "Servidor pequeno e memória"); cada rodada atrasa até 20 minutos de propósito |
| `DGCLAW_RONDA_APLICAR_SOZINHA=0` | a ronda avisa, mas nunca aplica nada sozinha |

O instalador respeita as linhas e **nunca** as cria nem as reescreve. Apague a linha para voltar ao padrão.

## Servidor pequeno e memória

A ronda lê milhares de registros de falhas e, em servidor de 4 GB, não pode tirar memória dos agentes. Por isso ela tem
quatro proteções, todas automáticas:

- **Lê um registro por vez e guarda só o resumo.** Cada detalhe baixado é reduzido ao que a ronda usa (o pacote desta
  instalação, a faixa corrigida e a prioridade) antes de o próximo chegar. No teste de bancada (`tests/ronda/bancada_memoria.py`,
  3000 falhas com registros do tamanho dos reais) o pico caiu de cerca de 2,7 GB para menos de 60 MB.
- **Teto de memória do processo:** 400 MB (300 MB no modo econômico). Se passar, a ronda para de ler detalhes, termina
  e sai **parcial**, dizendo "parei de ler detalhes ao chegar a X MB de memória (teto da ronda: T MB); N ficaram para a
  próxima rodada". Para mudar: `DGCLAW_RONDA_TETO_MB=500` no `dgclaw.env`.
- **Modo econômico** (menos leituras ao mesmo tempo e teto menor): liga sozinho quando o servidor tem até 4,5 GiB de
  memória. `DGCLAW_RONDA_ECONOMICA=1` força, `=0` desliga. Nele a ronda roda **uma vez por dia, às 04:00**, a não ser que
  você defina `DGCLAW_RONDA_HORARIOS` (o instalador avisa o horário que escolheu). A tela de status da fonte OSV mostra
  "modo econômico".
- **Limites do systemd** nas unidades da ronda, do vigia e do inventário (`MemoryHigh=450M`, `MemoryMax=600M`,
  `OOMScoreAdjust=1000`, `CPUQuota=50%`, prioridade mais baixa de CPU e disco). Se o sistema precisar matar alguém por
  falta de memória, mata a ronda, nunca um agente. As ações pedidas por você no painel (aplicar, desfazer, emergência) não
  levam esses limites, para não morrerem no meio.

**O vigia e o oom-kill.** O vigia confere de hora em hora se a rodada agendada terminou. Se não terminou, ele pergunta ao
systemd como ela acabou (`systemctl show dgclaw-ronda.service -p Result`). Se foi `oom-kill`, grava o motivo ("a rodada
passou do teto de memória da fábrica e o sistema a encerrou para proteger os agentes") e marca a ronda como parcial.
Em servidor normal, ele refaz a rodada uma vez, já no modo econômico. Em servidor pequeno (modo econômico) ele **só
confere**: registra o motivo, avisa o Admin e deixa a rodada do dia seguinte tentar de novo, porque repetir na hora
repetiria o mesmo pico. A trava da ronda continua valendo: se outra operação estiver rodando, o vigia espera a próxima hora.

Cada rodada registra o pico de memória no log (`memoria_pico_mb=`) e no `ronda.json` (`memoria_pico_mb`).

## Como um agente opera

O que se faz clicando no painel se faz também pela linha de comando, no servidor (Admin ou terminal como root):

```text
sudo dgclaw seguranca estado [--json]       última rodada, próxima, parcial?, quantos por nível
sudo dgclaw seguranca resumo [--json] [--todos]   os achados novos (ou todos), já limpos
sudo dgclaw seguranca rodar [--sem-avisar]  faz uma rodada agora
sudo dgclaw seguranca aplicar <id>          aplica a ação do catálogo (só com o sim do dono)
sudo dgclaw seguranca desfazer <registro>   volta atrás numa ação aplicada
sudo dgclaw seguranca inventario [--json] [--refazer]
sudo dgclaw seguranca pedido-todos          executa a fila de pedidos do painel (é o que o systemd chama)
```

O painel não é root. Quando você clica em "Aplicar", "Agendar" ou nos botões de emergência, ele deixa um pedido
em `/var/lib/dgclaw/web/seguranca/pedidos/`; uma unidade do systemd (`dgclaw-seguranca-pedidos.path`) o entrega ao
`dgclaw seguranca pedido-todos`, que **valida tudo de novo** (o achado existe, a ação está no catálogo e casa com ele,
o horário é válido, o código de emergência confere) e só então executa. O resultado volta em
`pedidos/feitos/<uuid>.json`. Nunca existe comando livre num pedido. O formato dos arquivos está em
`docs/interno/CONTRATO-RONDA.md`, e as rotas da API do painel que leem e pedem estas mesmas coisas ficam no
`docs.md` da API de segurança.

## Quando a ronda sai parcial

Se alguma fonte não responde (ou o limite do GitHub acaba), a rodada termina assim mesmo e diz, no painel e no
recado, **qual** fonte ficou de fora e por quê. Ela nunca parece limpa quando não é.

- Uma falha que sumiu da lista numa rodada parcial **não** é dada como corrigida: o sumiço pode ser da fonte.
- Se o OSV.dev (a fonte que confirma se a falha atinge você) ou mais da metade das fontes ficam fora, a rodada
  conta como falha: o vigia roda de novo e avisa se continuar assim.
- Para ver o motivo: `sudo dgclaw seguranca estado`, ou o log em `/var/log/dgclaw/ronda.log`.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `seguranca/ronda/ronda.py` | o motor (Python, só biblioteca padrão) |
| `seguranca/ronda/config.json` | janelas, tetos e nomes amigáveis |
| `seguranca/ronda/servicos.json` | o mapa de nomes e pacotes para serviços (Notion, Slack...) |
| `seguranca/acoes-permitidas.json` | o catálogo fechado de ações |
| `seguranca/paliativos.json` | as proteções provisórias e como conferir se estão ligadas |
| `/var/lib/dgclaw/web/seguranca/ronda.json` | o resultado da última rodada (modo 640; o painel lê) |
| `/var/lib/dgclaw/seguranca/inventario.json` | o inventário desta instalação (modo 600) |
| `/var/lib/dgclaw/seguranca/rodadas/` | as últimas 30 rodadas |
| `/var/lib/dgclaw/seguranca/acoes/` | um registro por ação aplicada, com o jeito de desfazer |
| `/var/log/dgclaw/ronda.log` | o que a ronda fez |
