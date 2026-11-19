# Aviso da equipe: agente fora do ar com os avisos retidos

## O que é

Alguns agentes de cliente rodam com `DGCLAW_AVISOS_RETIDOS=1` no arquivo `.dgclaw/config.sh` da casa deles. Com
isso, o `notify-owner.sh` de dentro do container não entrega aviso pela conversa, para que o aviso não caia na
conversa do cliente. Em contrapartida, quando o agente para de responder (conta sem login, limite do plano,
sessão caída, container parado), ninguém do lado do dono ficava sabendo. Em um caso real, um agente passou 22 horas
sem login.

O vigia da saúde retida (`web/lib/vigia-saude-retida.js`) roda no painel, no servidor, e cobre esse buraco. Ele lê o
`saude.json` que o watchdog do agente já grava e avisa por canais que **não passam pela conversa do agente**.

## Quando dispara

A cada 5 minutos (a primeira rodada sai uns 30 segundos depois de o painel subir), para cada agente que tem
`DGCLAW_AVISOS_RETIDOS=1` no `config.sh` (linha ativa, não comentada; o arquivo nunca é executado, só lido):

| Situação | O que acontece |
| --- | --- |
| Saúde em `atencao` ou `inativo` | Aviso "parou de responder", com o motivo (login, limite, sessão caída, etc.) |
| Saúde `ativo`, mas sem conferência há mais de 30 minutos | Aviso "parou de responder" com o motivo "o vigia da sessão dentro do container não confere há X, o container pode estar parado" |
| Estava fora e voltou ao normal | Aviso "voltou", com a duração e o motivo (só se o aviso de queda foi entregue) |
| Continua fora | Nada (um aviso só por queda) |
| `saude.json` ausente, ilegível ou indeterminado | Nada, só uma linha no log na primeira vez |

Agente sem retenção é ignorado: o `notify-owner.sh` dele já entrega o aviso.

Só o estado e o tipo do `saude.json` entram na decisão, e ambos são conferidos contra as listas conhecidas do
vigia. Os textos livres do arquivo (que é escrito de dentro do container) nunca entram no aviso.

## Os canais

O aviso conta como entregue se qualquer canal entregar. Se nenhum entregar, o vigia tenta de novo na rodada
seguinte (a falha completa vai ao log uma vez só).

1. **Aparelho do dono (Web Push).** Funciona sozinho, para quem já ativou os avisos no aparelho (menu, "Ativar
   avisos neste aparelho"). O título é "<Nome> parou de responder" ou "<Nome> voltou ao normal".
2. **Comando da equipe (opcional).** Se existir a variável `DGCLAW_EQUIPE_AVISO_CMD` no `/etc/dgclaw/web.env`, o
   painel executa esse comando com `bash -c`. O texto do aviso vai no stdin e na variável de ambiente
   `DGCLAW_AVISO_TEXTO`; também chegam `DGCLAW_AVISO_AGENTE` (o nome curto do agente) e `DGCLAW_AVISO_TIPO`
   (`caiu` ou `voltou`). Nada é colocado dentro da string do comando. Código de saída 0 = entregue; o comando (com tudo o que ele
   abriu) é encerrado se passar de 30 segundos.
3. **Log do painel.** Sempre sai uma linha com o texto completo e por onde foi entregue (`journalctl -u dgclaw-web`).

## Como configurar o comando da equipe

O comando roda como o usuário do painel (root, numa instalação normal) e recebe um ambiente mínimo: só `PATH`,
`HOME`, `LANG`, `LC_ALL`, `TZ` e as três variáveis `DGCLAW_AVISO_*`. Ele não enxerga o resto do `web.env` (hash da
senha, SMTP). Por isso a credencial do canal fica num arquivo do próprio script, legível só pelo root, e nunca dentro
do container de um agente.

Exemplo genérico: um script que lê o texto do stdin e o manda para um webhook seu.

A URL do webhook nunca vai na linha de comando (qualquer usuário do servidor a veria no `ps`). Ela fica num arquivo
de configuração do `curl`, `/etc/dgclaw/aviso-equipe.curl` (dono root, modo 600), com uma linha só:

```
url = "https://exemplo.invalid/seu-webhook"
```

E o script, que só sai com 0 quando o webhook responde 2xx (um redirecionamento 3xx não conta como entregue):

```bash
# /usr/local/sbin/aviso-equipe.sh  (dono root, modo 700)
#!/bin/bash
set -euo pipefail
codigo="$(curl -sS --max-time 20 --config /etc/dgclaw/aviso-equipe.curl -X POST --data-binary @- -o /dev/null -w '%{http_code}')"
[[ "$codigo" =~ ^2[0-9][0-9]$ ]]
```

O painel não guarda nem mostra o erro do comando (ele pode conter a URL). Se o aviso falhar, o log diz só o código de
saída; para ver o erro, rode o script à mão como root.

E a linha no `/etc/dgclaw/web.env`, acrescentada sem apagar as outras:

```
DGCLAW_EQUIPE_AVISO_CMD=/usr/local/sbin/aviso-equipe.sh
```

Use só um comando em que você confia: ele roda no servidor, fora dos containers.

Para reiniciar: `sudo systemctl restart dgclaw-web`.

## Como testar

Num agente de teste, ponha `DGCLAW_AVISOS_RETIDOS=1` no `.dgclaw/config.sh` e simule a queda gravando o
`saude.json` com `{"estado":"atencao","tipo":"login","desde":null,"verificadoEm":"<agora em ISO>"}`. Na rodada
seguinte (até 5 minutos) o aviso sai. Ponha o estado de volta em `ativo` para ver o "voltou". O watchdog regrava o
arquivo a cada 5 minutos, então teste num agente parado ou desligue o watchdog dele antes. Para testar só o comando:
`printf 'teste' | DGCLAW_AVISO_TEXTO=teste DGCLAW_AVISO_AGENTE=agente-teste DGCLAW_AVISO_TIPO=caiu bash -c "$DGCLAW_EQUIPE_AVISO_CMD"`.

## Onde fica o estado e como zerar

`<dados do painel>/vigia-saude/estado.json` (pasta 700, arquivo 600; no padrão,
`/var/lib/dgclaw/web/vigia-saude/estado.json`). Guarda, por agente, se está fora, o tipo, desde quando e se o aviso
de queda foi entregue. É ele que impede o aviso repetido quando o painel reinicia.

Para zerar (o próximo aviso sai como se fosse a primeira vez; um agente que já está fora será avisado de novo):
pare o painel, apague esse arquivo e inicie o painel. Se o arquivo ficar ilegível, o painel segue só em memória, não o
sobrescreve e escreve no log o caminho e o que fazer.

## Limite no Codex

O vigia depende do `saude.json`, e no Codex o `saude.json` hoje funciona só em parte
([PARIDADE-CODEX.md](PARIDADE-CODEX.md)). O tipo "vigia parado" (container parado ou vigia sem conferir) funciona
nos dois motores.
