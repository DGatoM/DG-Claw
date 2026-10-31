# Botão de emergência (tirar o servidor do ar)

Quando uma falha crítica está sendo explorada e a correção ainda não pode ser aplicada, o botão de emergência
tira o servidor da internet. O painel, os sites e tudo o que é público saem do ar. **O seu acesso de administração
pelo Tailscale continua entrando.** Se ninguém confirmar em 5 minutos, o servidor religa sozinho.

Tela: menu **Segurança**, bloco "Botão de emergência". Terminal: `sudo dgclaw emergencia ...`. Rotas para agentes:
`GET /api/v1/seguranca/ronda/docs.md`.

## O que ele faz, na ordem

1. **Confere se não vai te trancar para fora.** Só corta com o `nft` instalado e com um caminho de acesso garantido:
   o Tailscale logado (interface `tailscale0` de pé) ou ao menos um IP em `IPS_ADMIN`. Sem isso, o botão fica
   desligado e a tela diz o motivo.
2. **Guarda o estado de antes** (`nft list ruleset`, para diagnóstico, e os serviços ativos) em `/var/lib/dgclaw/emergencia/antes/`.
3. **Agenda o religar automático** (`systemd-run`, 5 minutos) antes de mudar qualquer coisa. Se o agendamento
   falha, nada é cortado.
4. **Para o proxy público** (`caddy`, e o `cloudflared` se existir) e carrega a tabela nft própria
   `inet dgclaw_emergencia`, com chains nos hooks `input`, `output` e `forward` em prioridade -10, ou seja, antes das
   regras do ufw (que não são mexidas). Ela derruba tudo na entrada, **inclusive as conexões que já estavam abertas**,
   e deixa passar só: o loopback, a interface do Tailscale, os `IPS_ADMIN` (por SSH, IPv4 e IPv6) e a rede dos
   agentes (`10.89.0.0/16`, para eles continuarem falando com o painel por dentro). Na saída, tudo segue normal;
   com `--isolar-saida` sobram só o DNS, o admin e a rede dos agentes, e o tráfego dos containers para a internet
   (`forward`) também é bloqueado. O IPv6 mantém a descoberta de vizinhos (NDP), senão o endereço de administração
   some da rede. Com `--isolar-saida`, a resposta de DNS (conexão estabelecida na porta 53) também passa.
5. **Você confirma** do seu aparelho (`sudo dgclaw emergencia confirmar`) e o religar automático é cancelado.
   O corte fica até você religar.

**O painel também sai do ar**, porque ele é servido pelo mesmo proxy. Por isso a confirmação e o religar são feitos
pelo servidor (SSH pelo Tailscale). A tela avisa isso antes de cortar.

## Duas confirmações

`preparar` gera um **código de uso único** (6 caracteres, vale 2 minutos, guardado só como hash em
`/var/lib/dgclaw/seguranca/emergencia-codigo`, permissão 600; 3 erros e ele é descartado) e mostra o plano.
`cortar` e `religar` exigem esse código. Na tela, além do código, você digita `TIRAR-DO-AR` (ou `RELIGAR`).

```
sudo dgclaw emergencia simular                 # só mostra o plano, não muda nada
sudo dgclaw emergencia preparar                # gera o código e mostra o plano
sudo dgclaw emergencia cortar --codigo K7M2PQ  # tira do ar (--isolar-saida também bloqueia a saída)
sudo dgclaw emergencia confirmar               # cancela o religar automático
sudo dgclaw emergencia preparar                # (de novo) código para religar
sudo dgclaw emergencia religar --codigo X4TN8B # volta ao normal e testa que tudo voltou
sudo dgclaw emergencia estado                  # cortado ou normal, e o que está parado
```

O religar apaga a tabela inteira (`nft delete table inet dgclaw_emergencia`, identidade fixa, sem número de regra),
religa os serviços e confere que o painel responde (`https://<seu domínio>/`). Se algo não voltar, o relatório diz o quê e o comando para ver o motivo.

## Uma operação de cada vez

`preparar`, `cortar`, `confirmar` e `religar` rodam sob uma trava (`flock -w 30` em
`/var/lib/dgclaw/emergencia/.trava`) e conferem o estado de novo depois de pegá-la. Se o religar manual e o
automático coincidirem, o que chegou depois espera, vê que já está religado, registra isso no log e sai com 0:
a tabela é apagada uma única vez.

## Ver o arquivo nft antes de cortar

`sudo dgclaw emergencia simular [--isolar-saida]` mostra o arquivo nft exato que seria carregado. O `cortar` grava
esse arquivo em `/var/lib/dgclaw/emergencia/emergencia.nft` e o valida com `nft -c -f` **antes** de agendar o
religar ou parar qualquer serviço: se o nft recusar, nada é mudado.

## Configuração

`/etc/dgclaw/emergencia.conf` (opcional; o arquivo é lido linha a linha, nunca executado). Padrões:

```
SERVICOS_PUBLICOS="caddy cloudflared"
INTERFACES_ADMIN="tailscale0"
IPS_ADMIN=""
REDES_INTERNAS="10.89.0.0/16"
PORTA_SSH=22
PRAZO_CONFIRMAR_MIN=5
URLS_TESTE_RELIGAR=""      # vazio = https://<DGCLAW_DOMINIO do dgclaw.env>/
```

## Para o painel

Cada comando regrava `/var/lib/dgclaw/web/seguranca/emergencia.json` (estado, se está disponível e o motivo, e o
plano), que a tela lê. O motor da ronda mantém esse arquivo fresco rodando `dgclaw emergencia estado` de tempos
em tempos. Os cliques da tela viram pedidos que o root executa (`docs/interno/CONTRATO-RONDA.md`).

## Testes

`bash tests/emergencia/rodar.sh`: raiz falsa (`DGCLAW_RAIZ`) e comandos de mentira (nft, systemctl, tailscale)
no PATH; não toca na máquina. O teste real do corte (conexão já aberta caindo, tráfego de container bloqueado em `--isolar-saida`) só em máquina descartável.
