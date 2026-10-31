# Boletins de segurança do DG Claw

Quando é descoberta uma falha de segurança numa das ferramentas que o DG Claw usa, a equipe publica um
**boletim** no repositório oficial. O DG Claw instalado percebe sozinho e avisa o dono: uma janela
"Aviso de segurança" no painel, um selo discreto que fica no alto das telas até o assunto se resolver, e um
recado ao Admin, que conta ao dono no chat.

**Nada é baixado nem instalado sem o ok do dono.** O aviso só informa. Quem atualiza continua sendo o Admin,
com o sim explícito do dono, pelo roteiro de [ATUALIZAR.md](ATUALIZAR.md).

## De onde vem o aviso

1. Uma ronda de segurança acompanha as fontes oficiais (avisos do GitHub, das distribuições Linux, dos
   projetos que o DG Claw usa) e prepara o boletim.
2. O boletim só é publicado depois que o Danilo aprova, por um pull request, e **depois que a correção
   entrou na `main`**. O boletim vai no arquivo `seguranca/boletins.json` do repositório.
3. Todo boletim tem uma **fonte oficial** (o registro da falha feito por quem mantém a ferramenta). Sem
   fonte, o boletim é descartado: nada de alerta sem prova.

O formato do arquivo está em `docs/interno/CONTRATO-BOLETINS.md`.

## Como o servidor percebe

A cada hora (e 5 minutos depois de ligar o servidor) um timer roda `scripts/checar-boletins.mjs`. Ele lê
`https://raw.githubusercontent.com/DGatoM/DG-Claw/main/seguranca/boletins.json`, uma leitura pública, sem
token e sem conta. **O que sai do servidor é só o IP, como em qualquer acesso.** Nenhum dado da instalação
(domínio, nome do dono, agentes, conversas, chaves) é enviado.

Um boletim está **pendente** quando está no arquivo publicado e **não** está no `seguranca/boletins.json` da
versão instalada (`/opt/dgclaw/app/seguranca/boletins.json`). Como o boletim só é publicado depois que a
correção entrou na `main`, ter o boletim na versão instalada quer dizer ter a correção: ao atualizar, o aviso
some sozinho.

Tudo que volta da rede é tratado como dado não confiável: cada campo é conferido (formato do id, valores
permitidos, tamanho, sem caractere de controle, links só `https://`) antes de ser guardado, e conferido de novo
antes de aparecer na tela. A tela escapa todo texto.

## O que o dono vê

- **A janela "Aviso de segurança"**, uma por vez (a mais grave primeiro), em tom de notícia: o que foi
  encontrado, a data, a gravidade, o link da fonte oficial, o que muda no sistema e os detalhes.
- **Atualizar**: leva ao chat do Admin com o pedido já escrito no campo. O dono só envia. A janela fica
  escondida por 24 horas para não reaparecer por cima do chat.
- **Lembrar depois**: esconde a janela por 24 horas. O selo "Aviso de segurança pendente" continua e reabre a
  janela quando o dono quiser. O aviso só some de vez quando o sistema é atualizado.
- **Entendi**: nos avisos em que a correção ainda não saiu. Quando a ação é só aguardar, o aviso sai da frente
  de vez; quando é parar um serviço, ele só é adiado por 24 horas.
- O **"?"** da janela e o passo do selo na visita guiada da conversa explicam cada parte.

O recado ao Admin tem **texto fixo**, com só o id e a gravidade do boletim (conferidos por regex e lista de
valores). Nenhum texto escrito por terceiros chega ao Admin. Ele manda o Admin contar ao dono, recomendar a
atualização e **nunca rodar `dgclaw atualizar` sem o sim explícito do dono**. Sai um recado por id.

## Como desligar

Ponha a linha `DGCLAW_BOLETINS_SEGURANCA=0` em `/etc/dgclaw/dgclaw.env` e rode `sudo ./install.sh` de novo (ou
`sudo systemctl disable --now dgclaw-checar-boletins.timer`). Apague a linha para ligar. O instalador respeita a
linha e nunca a cria nem a reescreve. Sem a linha, o aviso fica ligado.

## Quando a checagem falha

A falha não apaga o que já estava guardado: os avisos pendentes continuam valendo e o motivo fica registrado em
`/var/lib/dgclaw/web/atualizacao/boletins.json` (campo `erro`) e em `/var/log/dgclaw/checar-boletins.log`.
Para refazer na hora: `sudo systemctl start dgclaw-checar-boletins.service` (a saída diz o que falhou).

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| `seguranca/boletins.json` | os boletins publicados (escrito pela ronda, via pull request) |
| `/var/lib/dgclaw/web/atualizacao/boletins.json` | os pendentes desta instalação (escrito pela checagem, modo 600) |
| `/var/lib/dgclaw/web/atualizacao/boletins-adiados.json` | o que o dono adiou ou dispensou |
| `/var/lib/dgclaw/web/atualizacao/boletins-avisados.json` | os ids sobre os quais o Admin já foi avisado |
| `/var/log/dgclaw/checar-boletins.log` | o que a checagem fez, inclusive os boletins descartados e por quê |

## Como um agente opera

O painel consome a própria API, então o que se faz clicando se faz por ela (sessão do dono, ou o Admin no
servidor). Agente em container não acessa estas rotas. O contrato completo está em
`web/docs/SEGURANCA-BOLETINS.md` e é servido em `GET /api/v1/seguranca/docs.md`.

- `GET /api/v1/seguranca/boletins`: os pendentes, com `mostrar_modal` e `adiado_ate`.
- `POST /api/v1/seguranca/boletins/<id>/adiar`: esconde a janela por 24 horas.
- `POST /api/v1/seguranca/boletins/<id>/dispensar`: esconde de vez, só nos avisos de ação `aguardar`.
