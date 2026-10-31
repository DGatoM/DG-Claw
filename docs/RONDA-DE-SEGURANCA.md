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
o catálogo começa **vazio**: nesta versão a ronda avisa, mas não mexe em nada. Veja "O catálogo de ações".

Para a ronda não aplicar nada sozinha mesmo quando o catálogo tiver ações, ponha
`DGCLAW_RONDA_APLICAR_SOZINHA=0` no `dgclaw.env`. As falhas que seriam do nível 1 viram nível 2.

## Como o aviso chega

- **No painel**: a ronda grava `ronda.json` em `/var/lib/dgclaw/web/seguranca/`, e o painel mostra a lista por
  nível. Quando a ronda ficou parcial, o painel diz isso no topo e qual fonte caiu.
- **No chat com o Admin**: só quando aparece uma coincidência **nova** (uma falha que a ronda ainda não tinha
  mostrado, ou uma que ela corrigiu sozinha). O Admin recebe **um** recado por rodada, de texto fixo, só com os
  números das falhas e o nível. Ele lê `dgclaw seguranca resumo`, escreve o alerta para você e conversa sobre o
  que fazer. Dia sem nada novo: nenhuma IA é acionada, e o painel mostra a frase fixa "sem novidades".
- **Quando a própria ronda falha**: um vigia confere de hora em hora se a última rodada agendada terminou. Se
  não terminou, ele roda de novo uma vez. Se falhar de novo, avisa o Admin e põe um alerta no painel.

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

## Como desligar ou mudar os horários

Tudo no `/etc/dgclaw/dgclaw.env`; depois rode `sudo ./install.sh` de novo no clone (ou `sudo dgclaw atualizar`).

| Linha | Efeito |
| --- | --- |
| `DGCLAW_RONDA_SEGURANCA=0` | desliga a ronda, o vigia, o inventário, a fila de pedidos do painel e a atualização do estado do botão de emergência |
| `DGCLAW_RONDA_HORARIOS="06:30 18:45"` | horários das rodadas, no fuso do servidor (padrão `07:00 13:00 19:00`); cada rodada atrasa até 20 minutos de propósito |
| `DGCLAW_RONDA_APLICAR_SOZINHA=0` | a ronda avisa, mas nunca aplica nada sozinha |

O instalador respeita as linhas e **nunca** as cria nem as reescreve. Apague a linha para voltar ao padrão.

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
| `/var/lib/dgclaw/web/seguranca/ronda.json` | o resultado da última rodada (modo 640; o painel lê) |
| `/var/lib/dgclaw/seguranca/inventario.json` | o inventário desta instalação (modo 600) |
| `/var/lib/dgclaw/seguranca/rodadas/` | as últimas 30 rodadas |
| `/var/lib/dgclaw/seguranca/acoes/` | um registro por ação aplicada, com o jeito de desfazer |
| `/var/log/dgclaw/ronda.log` | o que a ronda fez |
