# bin/dgclaw: a linha de comando do DG Claw

`dgclaw` cria e cuida dos agentes (cada um numa maquina propria, em container), da
imagem deles, da senha do painel e responde "esta tudo de pe?". Quem chama: o Admin, o
DG Claw Web e a pessoa no terminal.

## Por que bash

E o mesmo idioma do instalador (`install.sh`) e das bibliotecas `lib/comum.sh` e
`lib/agentes.sh`, que os dois usam. Nao exige nada alem de `jq`, `podman` e systemd,
que o instalador ja coloca na maquina. Tudo o que a CLI faz e orquestrar esses tres
programas e escrever arquivos, e isso em bash fica curto e legivel. Quem precisar de
logica mais pesada chama um script Node do app (como a geracao do hash da senha).

## Subcomandos

| Comando | O que faz |
|---|---|
| `dgclaw agente criar <slug> --nome "<Nome>" [opcoes]` | cria um agente (faixa de uid, portas, casa, identidade, segredos, rede, container, firewall, rotinas, registro). Idempotente: rodar de novo continua de onde parou |
| `dgclaw agente listar [--json]` | agentes, estado do container e saude do runner |
| `dgclaw agente parar\|iniciar\|reiniciar <slug>` | `reiniciar` reinicia so o runner por dentro (e o que o cofre pede) |
| `dgclaw agente reparar <slug>` | refaz so a parte de dentro (rotinas, runner, painel, plugin do Telegram) |
| `dgclaw agente cofre <slug> guardar\|revogar\|listar\|aplicar [NOME] [opcoes]` | chaves de API do agente. O valor vem SEMPRE pelo STDIN. Sai 0 (deu certo), 1 (recusa, com o motivo) ou 2 (uso errado) |
| `dgclaw agente remover <slug> [--sim]` | tira do ar e MOVE a casa para `/var/lib/dgclaw/aposentados/`. Nunca apaga; a faixa de uid fica queimada |
| `dgclaw imagem status` | pronta, construindo ou falhou (com a cauda do log) |
| `dgclaw imagem construir [--agora]` | constroi a imagem em segundo plano, ou aqui com `--agora` |
| `dgclaw senha trocar` | nova senha do painel pelo STDIN (minimo 12 caracteres) |
| `dgclaw status` | tudo de pe? Sai com erro se algo essencial caiu |

`--ensaio` (antes ou depois do subcomando) mostra o que faria sem mudar nada.
`--ajuda` mostra exemplos de cada comando.

## Testes

```
bash tests/cli/rodar.sh
```

Usam `DGCLAW_RAIZ=<pasta temporaria>` e programas de mentira em `tests/cli/stubs/`
(podman, systemctl, ss, curl, iptables). Nao tocam na maquina. Com `DGCLAW_RAIZ`
definido a CLI nao aplica firewall nem roda o teste de isolamento, a menos que os
testes passem `DGCLAW_FIREWALL_CMD` / `DGCLAW_ISOLAMENTO_CMD`.
