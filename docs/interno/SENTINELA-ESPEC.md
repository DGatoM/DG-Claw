# Sentinela do servidor: especificação de construção (frentes 1 e 2)

Pedido do Danilo, 10/11/2026 08h00, depois que o disco da VPS principal lotou de madrugada e ele ficou
trancado fora: "Se essa IA vai atender clientes, ela não pode de forma alguma ficar fora do ar. O sistema
tem que avisar todo mundo com muita antecedência."

Este documento é o contrato para quem implementa. Decisões já tomadas; não reabrir sem motivo forte
(se achar um, anote no relatório final em vez de mudar o desenho).

## Visão geral

Uma peça nova, a **sentinela**, separada da ronda de segurança (a ronda é pesada, usa rede e roda 3 vezes ao
dia; a sentinela tem de ser leve e rodar a cada minuto mesmo com o servidor sufocado).

- `seguranca/sentinela/sentinela.py`: Python **só da biblioteca padrão**, roda como root com `python3 -I`.
- `seguranca/sentinela/faxina.json`: catálogo **fechado** do que pode ser limpo sozinho (vai com o DG Claw,
  só muda por versão nova).
- Unidades systemd `dgclaw-sentinela.service` (oneshot) + `dgclaw-sentinela.timer` (a cada 1 minuto).
- CLI: `dgclaw sentinela <subcomando>` em `bin/dgclaw` (delegando ao Python, no mesmo estilo de `seguranca_main`).
- Painel: o Web lê o arquivo de estado, mostra faixa em todas as telas, um cartão "Saúde do servidor" e
  manda push no celular.

Todos os caminhos aceitam o prefixo `DGCLAW_RAIZ` (mesmo padrão de `seguranca/ronda/ronda.py`: funções `raiz()`
e `P()`), para os testes rodarem numa raiz falsa sem root.

## Caminhos

| Caminho | O que é | Permissão |
| --- | --- | --- |
| `/etc/dgclaw/sentinela.conf` | configuração (lida linha a linha, NUNCA executada com `source`) | 600 root |
| `/var/lib/dgclaw/sentinela/estado.json` | estado interno completo (contadores, últimos avisos) | 600 |
| `/var/lib/dgclaw/sentinela/historico.jsonl` | uma linha por ação automática (faxina, reserva, alívio de RAM) e por aviso enviado | 600 |
| `/var/lib/dgclaw/web/sentinela/estado.json` | visão para o painel, **sem segredo nenhum** (sem token, sem chat id, sem senha, sem URL do pulso) | 640, pasta 750 |
| `/var/lib/dgclaw/reserva/balao.bin` | arquivo de reserva de disco (o "balão de ar") | 600, pasta 700 |
| `/var/log/dgclaw/sentinela.log` | log só de eventos (mudança de nível, ação, aviso, falha de envio). Rodada sem novidade não escreve nada | 640 |

## Configuração (`/etc/dgclaw/sentinela.conf`)

Formato `CHAVE=valor` (aspas opcionais), comentário com `#`. Chave desconhecida: ignora e loga uma vez por
rodada de mudança. Valor inválido: usa o padrão E loga o motivo com a linha (nunca o valor se a chave for
segredo). Padrões:

```
NOME_SERVIDOR=                 # vazio = DGCLAW_DOMINIO do dgclaw.env, senão o hostname
DISCO_AVISO=75
DISCO_SERIO=85
DISCO_CRITICO=92
DISCO_EXTREMO=97               # a partir daqui a reserva é liberada sozinha
RAM_AVISO=85
RAM_SERIO=92
RAM_CRITICO=96
RESERVA_GB=2                   # 0 desliga a reserva
FAXINA_AUTOMATICA=1
ALIVIO_RAM_AUTOMATICO=1
REPETIR_AVISO_MIN=360
REPETIR_SERIO_MIN=60
REPETIR_CRITICO_MIN=10
AGENTE_CAIDO_RODADAS=2
TELEGRAM_TOKEN=
TELEGRAM_CHATS=                # ids separados por vírgula (dono e pessoas de confiança)
EMAIL_SMTP_HOST=
EMAIL_SMTP_PORTA=587           # 587 = STARTTLS, 465 = SSL
EMAIL_USUARIO=
EMAIL_SENHA=
EMAIL_DE=
EMAIL_PARA=                    # separados por vírgula
PULSO_URL=                     # ex.: https://hc-ping.com/<uuid> (healthchecks.io)
```

Validações: limiares inteiros 1-99 e em ordem crescente (aviso < sério < crítico < extremo), senão todos
voltam ao padrão com log. `TELEGRAM_TOKEN` no formato `^\d{5,20}:[A-Za-z0-9_-]{30,60}$`. Chat ids
`^-?\d{1,20}$`. `PULSO_URL` e qualquer URL: `https://`, sem usuário/senha na URL. E-mails com regex simples.

Segredos (`TELEGRAM_TOKEN`, `EMAIL_SENHA`, `PULSO_URL`) **nunca** vão para log, estado do painel, saída
`--json`, mensagem de erro nem `ps` (nada de segredo em argumento de comando). Em log, o token aparece como
`<token do Telegram>` e a URL do pulso só como o host.

### `sentinela.py configurar`

Lê pares `CHAVE=valor` da **entrada padrão** (nunca de argumento, para não vazar em `ps` e no histórico do
shell). Valida cada um, e edita o arquivo **linha a linha**: troca só as linhas das chaves recebidas, mantém
todas as outras na ordem (inclusive linhas alheias e comentários), acrescenta no fim as que não existiam.
Grava em arquivo temporário na mesma pasta + `fsync` + `rename`, permissão 600. `CHAVE=` vazio apaga o valor.
Regra do projeto: teste obrigatório montando o arquivo com uma linha alheia e conferindo que ela sobreviveu.

## A rodada (`sentinela.py rodar`, chamada pelo timer)

Trava com `fcntl.flock` não bloqueante em `/var/lib/dgclaw/sentinela/.trava`; se outra rodada está viva, sai 0
sem fazer nada. Tempo total máximo 45 s (o timer é de 60 s): cada passo externo tem timeout.

Ordem (importa, porque o disco pode estar em 100%):

1. **Medir o disco** (`os.statvfs`) dos pontos `/`, `/var/lib/dgclaw`, `/var/lib/containers`, `/var/log`,
   `/tmp`, `/home` que existirem, sem repetir o mesmo `st_dev`. Mesma conta do `df`:
   `usado = f_blocks - f_bfree`; `pct = usado / (usado + f_bavail)`. Também inodes (`f_files`, `f_ffree`)
   e livre em GB. O nível do disco é o pior entre os pontos (inodes contam igual).
2. **Se algum ponto passou de `DISCO_EXTREMO`** e a reserva existe naquele sistema de arquivos: **apagar a
   reserva antes de qualquer escrita** (é o que devolve fôlego para o resto funcionar). Registrar depois.
3. **Medir a RAM**: `/proc/meminfo`, `pct = (MemTotal - MemAvailable) / MemTotal`, mais swap usado.
4. **Ver os agentes e os serviços** (passo "Agentes" abaixo).
5. Calcular os níveis, comparar com o estado anterior, decidir ações e avisos.
6. **Ações automáticas** (faxina, alívio de RAM, recriar reserva).
7. **Avisos** (canais abaixo).
8. **Pulso externo**.
9. Gravar o estado interno, o estado do painel e o histórico. **Toda escrita é protegida**: se falhar
   (ENOSPC ou outra), o aviso por Telegram/e-mail já saiu no passo 7, então a rodada loga em stderr (vai
   para o journal) e sai com código 0 mesmo assim, para o timer continuar. Nunca deixar uma falha de escrita
   impedir os avisos. O aviso daquela rodada precisa dizer "não consegui gravar o estado: disco cheio".

### Níveis e histerese

Para disco e RAM: `ok` < `aviso` < `serio` < `critico`. Subir é na hora para disco; para RAM só depois de
**2 rodadas seguidas** acima do limiar (pico de um minuto não conta). Descer exige ficar **3 pontos
percentuais abaixo** do limiar do nível atual (ex.: em `serio` com limiar 85, só volta a `aviso` abaixo de 82).
O `nivel_geral` é o pior entre disco, RAM, agentes e serviços (agente ou serviço caído = `critico`).

### Agentes e serviços

- Agentes: `/etc/dgclaw/agentes.json`, itens com `tipo == "agente"`. Cada um tem `runner` no formato
  `host:porta`. Rodada: `GET http://127.0.0.1:<porta>/api/saude` com timeout de 3 s (aceitar só host
  127.0.0.1/localhost; outro host no registro = não consulta e marca `motivo: registro com endereço fora da
  máquina`). Falhou `AGENTE_CAIDO_RODADAS` rodadas seguidas: o agente vira `caido`; aí, uma vez, rodar
  `podman inspect -f '{{.State.Status}}' dgclaw-<slug>` (timeout 10 s) para o motivo: "container parado",
  "container não existe", "container ligado mas o programa do agente não responde".
- A cada 5 rodadas, para cada container ligado, conferir o canal do WhatsApp:
  `podman exec dgclaw-<slug> systemctl is-enabled dgclaw-whatsapp.service` e, se `enabled`,
  `... is-active ...` (timeout 10 s cada). Habilitado e não ativo = agente `canal_caido`, motivo "o WhatsApp
  do agente parou: os clientes não recebem resposta". Também conta como crítico.
- Serviços do servidor: `systemctl is-active dgclaw-web dgclaw-admin caddy` (os que existirem com
  `systemctl cat`; o que não existe não entra). Inativo 2 rodadas seguidas = crítico, motivo com o nome.
- A sentinela **não reinicia agente nem serviço** sozinha (reiniciar no meio de uma conversa de cliente é
  decisão do dono e o runner já tem `--restart unless-stopped`). Ela avisa com o comando exato:
  `sudo dgclaw agente reiniciar <slug>` / `sudo systemctl restart <serviço>` / "peça ao Admin".
  (Conferir o nome real do subcomando de reiniciar agente em `bin/dgclaw` e usar o que existe.)

### Ações automáticas

**Faxina** (`FAXINA_AUTOMATICA=1`): quando o disco sobe para `serio` ou mais, e de novo a cada 6 horas
enquanto continuar em `serio`/`critico`. Executa os itens do catálogo `faxina.json` em ordem, mede quanto
liberou (livre depois - livre antes, por item) e registra no histórico. Cada item tem timeout.

Itens do catálogo (fechado; cada item é `{id, descricao, tipo, ...}`, só tipos conhecidos pelo código, nenhum
aceita comando livre):

| id | tipo | o que faz |
| --- | --- | --- |
| `journal` | `journal-vacuum` | `journalctl --vacuum-size=500M` |
| `apt` | `apt-clean` | `apt-get clean` |
| `imagens-soltas` | `podman-prune-dangling` | `podman image prune -f` (só imagens sem nome; **nunca** `-a`, nunca prune de container, volume ou rede) |
| `tmp-velhos` | `apagar-velhos` | arquivos **regulares** em `/tmp` e `/var/tmp`, mais velhos que 3 dias (mtime), sem atravessar outro sistema de arquivos; pula `systemd-private-*`, `.X11-unix`, `.ICE-unix`, sockets e qualquer coisa que não seja arquivo regular |
| `logs-girados` | `apagar-velhos` | em `/var/log`, arquivos regulares `*.gz`, `*.[0-9]`, `*.old` mais velhos que 7 dias |
| `cache-agentes` | `cache-agente` | dentro de cada casa de agente `/var/lib/dgclaw/agentes/<slug>/home`: `.cache/pip`, `.npm/_cacache`, `.cache/google-chrome/*/Cache`, `.cache/google-chrome/*/Code Cache`, `.cache/chromium/*/Cache`, `.cache/chromium/*/Code Cache` |

**Segurança do `cache-agente` (crítico).** A casa do agente é controlada por um agente que conversa com
estranhos; ele pode trocar `.cache/pip` por um link simbólico para `/etc`. A remoção tem de ser à prova disso:

- Abrir a casa e descer componente por componente com `os.open(..., O_RDONLY | O_DIRECTORY | O_NOFOLLOW)` e
  `dir_fd` (nunca montar o caminho como texto e apagar). Se qualquer componente for link simbólico ou não for
  pasta, pular o item e logar "pulei <slug>/<caminho>: é um link simbólico".
- Apagar com `shutil.rmtree(nome, dir_fd=fd_do_pai)` e conferir `shutil.rmtree.avoids_symlink_attacks` no
  começo; se for `False`, o item `cache-agente` não roda (log explicando).
- O mesmo vale para `apagar-velhos`: `os.walk(..., followlinks=False)`, `os.lstat` antes de apagar, só
  `stat.S_ISREG`, e conferir `st_dev` igual ao da raiz.
- Teste obrigatório: casa falsa com `.cache/pip` como link para uma pasta "de fora" com um arquivo; depois da
  faxina o arquivo de fora tem de continuar lá.

**Reserva de disco** (`RESERVA_GB > 0`):

- Tamanho: `RESERVA_GB`, mas no máximo 5% do disco do ponto `/var/lib/dgclaw` (disco de 40 GB = 2 GB; de 20 GB
  = 1 GB).
- Criar com `os.posix_fallocate` (bloco real reservado, não arquivo esparso) só se, depois de criada, o uso
  ficar abaixo de `DISCO_AVISO`. Quando o disco volta abaixo de `DISCO_AVISO - 5` por 30 minutos seguidos,
  a reserva liberada é recriada sozinha (com registro e aviso "reserva recriada").
- Liberada sozinha a partir de `DISCO_EXTREMO` (passo 2 da rodada). Também manualmente:
  `dgclaw sentinela reserva liberar`.
- O aviso de liberação diz: "Liberei a reserva de emergência de X GB. Isso compra tempo, não resolve: libere
  espaço agora".

**Alívio de RAM** (`ALIVIO_RAM_AUTOMATICO=1`): RAM em `critico` por 3 rodadas seguidas.

1. Se `dgclaw-ronda.service` está ativo: `systemctl stop dgclaw-ronda.service` (o vigia da ronda roda de novo
   depois, no modo econômico).
2. Se continuar crítico na rodada seguinte: achar o container de agente que mais usa memória
   (`podman stats --no-stream --format json`, timeout 20 s) e fechar **só o navegador** dele:
   `podman exec dgclaw-<slug> systemctl stop dgclaw-tela-chrome.service`. No máximo uma vez a cada 30 minutos
   por agente. **Nunca** parar o runner, o WhatsApp, o painel do agente, o Web, o Admin nem o Caddy.
3. Aviso dizendo o que foi feito: "Fechei o navegador do agente X para liberar memória. A conversa dele
   continua de pé; o navegador volta quando ele precisar."

### Proteção do que não pode morrer (instalador)

Para o dono nunca ficar trancado fora:

- `dgclaw-web.service` ganha `OOMScoreAdjust=-500` (o instalador já escreve essa unidade).
- Drop-in `/etc/systemd/system/ssh.service.d/90-dgclaw-oom.conf` com `[Service]\nOOMScoreAdjust=-900`
  (se a unidade `ssh.service` não existir e `sshd.service` existir, usar essa; se nenhuma, pular com info).
- Drop-in `/etc/systemd/system/caddy.service.d/90-dgclaw-oom.conf` com `OOMScoreAdjust=-500`.
- `dgclaw-sentinela.service`: `OOMScoreAdjust=-900`, `MemoryMax=96M`, `Nice=-5`, `TimeoutStartSec=55`,
  `Type=oneshot`, `User=root`.
- Teto do journal: `/etc/systemd/journald.conf.d/90-dgclaw.conf` com `[Journal]\nSystemMaxUse=1G`, **só se o
  arquivo não existir** e nenhum outro arquivo em `journald.conf.d/` já definir `SystemMaxUse`
  (nunca reescrever configuração da pessoa).
- `/etc/dgclaw/sentinela.conf` é criado **só se não existir**, com os padrões comentados. Nunca reescrito.

## Avisos

### Cadência

- Mudança de nível para cima (qualquer dimensão): aviso na hora.
- Enquanto continuar fora do `ok`: repete a cada `REPETIR_<NIVEL>_MIN` do nível atual. Repetição diz
  "continua" e quanto tempo faz ("há 40 min").
- Voltou ao `ok`: um aviso "✅ Resolvido" com quanto tempo durou.
- Agente caído: aviso na hora, repete a cada `REPETIR_CRITICO_MIN`, e "✅ voltou" quando responder de novo.
- Ação automática (faxina, reserva, alívio): entra no texto do aviso daquela rodada (não manda mensagem
  separada se já vai sair um aviso).
- Um aviso por rodada no máximo, juntando tudo o que mudou.

### Texto (fixo, português simples, sem markdown, emojis como marcadores)

```
🔴 CRÍTICO · <NOME_SERVIDOR> · 10/11 03:12
💾 Disco em 93% (2,8 GB livres de 40 GB)
O servidor para de funcionar quando o disco enche. Os agentes param de responder.

Maiores pastas:
• /var/lib/dgclaw/agentes/luna/home: 14,2 GB
• /var/lib/containers: 9,8 GB
• /var/log: 3,1 GB

O que eu já fiz: limpei caches e logs antigos (liberou 1,4 GB).
O que fazer agora: peça ao Admin no painel "faz a faxina do disco", ou no servidor rode
sudo dgclaw sentinela levantar
```

Emojis por nível: `🟡 AVISO`, `🟠 SÉRIO`, `🔴 CRÍTICO`, `✅ RESOLVIDO`. Agente: `🔴 AGENTE FORA DO AR · Luna`
com o motivo e o comando. RAM: `🧠 Memória em 94% (480 MB livres de 8 GB)` e os 5 processos que mais usam
(soma de RSS por nome, como em `vigia_ram.py`).

**Maiores pastas**: `du -x -s` (com `nice -n 19 ionice -c3`, timeout 20 s no total) nas casas de cada agente,
`/var/lib/containers`, `/var/log`, `/tmp`, `/var/tmp`, `/root`, `/home`, `/opt`. Resultado em cache por 30
minutos. Timeout = escreve "não deu tempo de medir as pastas".

### Canais (todos independentes; um falhar não impede os outros)

1. **Telegram direto** (não depende do Web nem do Admin): `POST https://api.telegram.org/bot<token>/sendMessage`
   com `chat_id` e `text`, **sem** `parse_mode`, timeout 10 s, para cada chat de `TELEGRAM_CHATS`.
   Para testes, a base pode ser trocada por `DGCLAW_SENTINELA_TELEGRAM_API`, aceita só se for `https://` ou
   `http://127.0.0.1:<porta>`.
2. **E-mail** (opcional): `smtplib`, STARTTLS na 587 ou SSL na 465, timeout 15 s, assunto = primeira linha do
   aviso. Para testes, host `127.0.0.1` com porta qualquer e sem TLS só se `DGCLAW_SENTINELA_TESTE=1`.
3. **Painel**: o aviso entra no estado do painel (campo `aviso`, abaixo); o Web mostra a faixa e manda push.
4. **Admin**: quando o nível geral sobe para `serio` ou `critico`, ou um agente cai, um recado de texto fixo
   para o Admin (`POST http://127.0.0.1:<porta>/api/agents/admin/input` com `{"text":..., "injectWhenIdle":
   true}` e o token de `/etc/dgclaw/runner/admin.token`, igual a `avisa_admin` do `ronda.py`: só 127.0.0.1).
   Só na transição, não nas repetições. Texto: "[sentinela] <resumo de uma linha>. Rode `dgclaw sentinela
   estado` para ver o detalhe e ofereça ao dono a faxina guiada (`dgclaw sentinela levantar`)." Sem texto
   vindo de fora.

Falha de envio: loga o canal, o status e o motivo (sem segredo), grava em `canais.ultima_falha` do estado do
painel, e tenta de novo na rodada seguinte (o aviso fica pendente até sair em pelo menos um canal externo).

### Pulso externo

Toda rodada termina com um pulso, se `PULSO_URL` estiver configurado:

- Nada crítico: `GET <PULSO_URL>` (timeout 10 s).
- Nível geral `critico` ou agente caído: `POST <PULSO_URL>/fail` com o resumo de uma linha no corpo.
- Voltou: o próximo `GET` normal já fecha o alerta no serviço.

Com o healthchecks.io configurado com período de 2 minutos e tolerância de 3, se a VPS travar, desligar, perder
rede ou a sentinela parar de rodar, o serviço externo avisa por e-mail/Telegram em uns 5 minutos. Isso não
depende de nada da VPS funcionar. O doc do dono explica o passo a passo de criar a conta e o check.

## Estado para o painel (`/var/lib/dgclaw/web/sentinela/estado.json`)

```json
{
  "versao": 1,
  "atualizado_em": "2026-11-10T03:12:04-03:00",
  "servidor": "meudominio.com.br",
  "nivel_geral": "critico",
  "disco": [{"ponto": "/", "usado_pct": 93.1, "livre_gb": 2.8, "total_gb": 40.0, "inodes_pct": 12.0, "nivel": "critico"}],
  "ram": {"usado_pct": 61.0, "disponivel_mb": 3100, "total_mb": 7950, "swap_pct": 4.0, "nivel": "ok"},
  "reserva": {"ligada": true, "existe": false, "tamanho_gb": 2.0, "liberada_em": "2026-11-10T03:11:58-03:00"},
  "agentes": [{"slug": "luna", "nome": "Luna", "estado": "ok", "desde": null, "motivo": ""}],
  "servicos": [{"nome": "dgclaw-web", "ativo": true}],
  "maiores_pastas": [{"caminho": "/var/lib/containers", "gb": 9.8}],
  "ultimas_acoes": [{"em": "...", "tipo": "faxina", "descricao": "journal: liberou 820 MB", "liberou_mb": 820}],
  "canais": {"telegram": true, "email": false, "pulso": true, "admin": true,
             "ultimo_envio_ok": "...", "ultima_falha": null},
  "aviso": {"seq": 17, "nivel": "critico", "titulo": "🔴 CRÍTICO · disco em 93%", "corpo": "...", "em": "..."}
}
```

`aviso.seq` cresce a cada aviso emitido (inclusive repetições e "resolvido"). É assim que o Web sabe quando
mandar push, sem ter cadência própria. `canais.*` só diz se está configurado (booleano), nunca o valor.

## CLI (`dgclaw sentinela ...`, todas como root)

| Subcomando | O que faz |
| --- | --- |
| `estado [--json]` | lê o estado do painel e imprime em português (ou JSON) |
| `rodar` | uma rodada agora (o que o timer chama) |
| `levantar [--json]` | lista as 20 maiores pastas (`du -x` com `nice`/`ionice`, profundidade 3, a partir de `/`, timeout 120 s) e marca, para cada uma, se está no catálogo de faxina; não apaga nada |
| `faxinar [--executar] [--json]` | sem `--executar` só simula e mostra quanto cada item liberaria (estimativa com `du`); com `--executar` roda o catálogo e mostra quanto liberou |
| `reserva estado\|liberar\|recriar` | a reserva de disco |
| `testar-avisos [--json]` | manda um aviso de teste em cada canal configurado e diz qual chegou e qual falhou (com motivo) |
| `configurar` | lê `CHAVE=valor` da entrada padrão (ver acima) |
| `ajuda` | uso |

Toda falha diz o que falhou, com que entrada, e o que fazer (padrão de erro do Danilo). Código de saída != 0
quando o pedido não foi feito.

## Web (painel)

- `web/lib/sentinela.js`: lê o estado do painel a cada 30 s (só relê se o `mtime` mudou). Arquivo ausente =
  `{instalado: false}` (a sentinela ainda não rodou), nunca erro mudo. Arquivo ilegível = loga com o caminho e
  o motivo e a rota responde 503 com o motivo.
- Push: quando `aviso.seq` aumenta (comparar com o último guardado em `<DGCLAW_WEB_DATA>/sentinela/push.json`;
  na primeira leitura só guarda, não manda), `push.enviar({titulo, corpo (até 300 caracteres), tag:
  'sentinela', url: '/seguranca#saude-servidor', exigir_interacao: nivel === 'critico'})`. Resultado da entrega
  vai para o log (sem endpoint).
- Rotas (todas com sessão, como o resto da API; leitura sem `Origin`, escrita com `Origin`):
  - `GET /api/v1/sentinela`: o estado do painel.
  - `POST /api/v1/sentinela/testar`: roda `python3 -I <app>/seguranca/sentinela/sentinela.py testar-avisos --json`
    (`execFile`, sem shell, timeout 60 s) e devolve o resultado.
  - `GET /api/v1/sentinela/docs.md`: o doc da API, seguindo o padrão das outras rotas `docs.md` do `server.js`.
- **Faixa em todas as telas** quando `nivel_geral` for `serio` ou `critico` ou houver agente caído:
  seguir o padrão de `web/public/atualizacao-faixa.js`/`.css`. Vermelha no crítico, laranja no sério; frase
  curta ("Disco do servidor em 93%: os agentes podem parar. Ver o que fazer") com link para o cartão. Não some
  ao fechar enquanto for crítico; no sério pode ser recolhida por 1 hora.
- **Cartão "Saúde do servidor"** na tela Segurança (id `saude-servidor`): barras de disco por ponto e de RAM
  com a cor do nível, reserva (ligada/existe/liberada em), agentes (ok/caído com motivo), serviços, maiores
  pastas, últimas ações automáticas, canais configurados (Telegram/e-mail/pulso/Admin: "ligado" ou "não
  configurado: peça ao Admin para configurar") e um botão **Testar avisos**. Celular: sem rolagem
  horizontal, barras empilhadas, alvo de toque de ~32 px.
- **Modo tutorial** no cartão (padrão `docs/TUTORIAL-MODE.md` do DG Social, já usado no DG Claw: procure o
  `tutoriais.js` do Web): cada passo responde o que é / como é calculado / por que está aqui.
- Testes em `web/test/sentinela.test.js` (node --test): arquivo ausente, ilegível, push só quando `seq`
  aumenta, rota exige sessão, `testar` usa `execFile` sem shell.

## Admin e agentes

- `templates/ambiente/admin.md`: seção curta "Sentinela do servidor": o que é, comandos, como guiar o dono a
  configurar o Telegram (criar bot no BotFather, pegar o chat id, `printf 'TELEGRAM_TOKEN=...\nTELEGRAM_CHATS=...\n'
  | sudo dgclaw sentinela configurar`, sem nunca ecoar o token na conversa), o healthchecks.io e o e-mail; como
  conduzir a faxina guiada (`levantar`, mostrar ao dono, apagar só com o ok dele, nunca código, banco, `.env`,
  conversas, memória); e que o recado `[sentinela]` vem da própria máquina.
- `templates/ambiente/agente.md`: uma linha: o servidor tem uma sentinela de disco e memória; se o dono
  perguntar, quem cuida é o Admin.
- Se criar doc de capacidade, registrar em `templates/ambiente/capacidades.txt` (o teste `tests/ambiente`
  confere).

## Documentação

- `docs/SENTINELA.md` (para o dono, linguagem simples): o que vigia, os níveis, o que faz sozinha, os canais,
  **passo a passo do pulso externo no healthchecks.io** (criar conta grátis, criar o check com período 2 min e
  tolerância 3 min, ligar a integração de Telegram ou e-mail lá, colar a URL de ping) e a alternativa Uptime
  Kuma em outra máquina; mais um monitor externo de HTTP (UptimeRobot ou o próprio healthchecks) apontado para
  `https://<domínio>/api/saude`, que é pública e não exige login.
- Ponteiro no índice de docs que o repositório usa (ver `tests/docs-em-dia`, que confere o manual contra o
  inventário de scripts: rodar e acertar).
- `CHANGELOG.md` em `[Não lançado]`: entrada "Adicionado" + `### Como atualizar (sentinela)` escrita para a
  pessoa dona, explicando que depois de atualizar ela precisa pedir ao Admin para ligar os avisos por Telegram
  e o pulso externo, porque sem isso os alarmes só aparecem no painel. Nada de frase dirigida a modelo (o teste
  `tests/changelog` reprova).

## Testes (`tests/sentinela/`, registrados em `tests/rodar.sh`)

Raiz falsa (`DGCLAW_RAIZ`), sem root, sem rede de verdade. Medições falsas por variável só aceita com
`DGCLAW_SENTINELA_TESTE=1`: `DGCLAW_SENTINELA_FALSO` aponta para um JSON com `disco`, `ram`, `runners`
(slug → ok/falha), `servicos`, `podman` (respostas de inspect/stats/exec). Telegram, SMTP e pulso falsos em
servidores locais (`http.server`/`smtpd`-like simples em thread) que gravam o que receberam.

Casos mínimos:

1. Níveis e histerese do disco (75/85/92) e da RAM (2 rodadas para subir; 3 pontos para descer).
2. Cadência: aviso na subida, repetição só depois de `REPETIR_*`, "resolvido" ao voltar; um aviso por rodada.
3. Disco acima do extremo com escrita falhando (pasta de estado sem permissão ou ENOSPC simulado): a reserva é
   apagada, o Telegram falso recebe o aviso, a rodada sai 0.
4. Faxina com link simbólico na casa do agente: nada fora da casa é apagado. `apagar-velhos` não apaga
   arquivo novo, nem não regular, nem de outro `st_dev` (simular com st_dev falso se preciso).
5. Agente caído depois de 2 rodadas, motivo pelo podman falso, "voltou" ao responder. WhatsApp habilitado e
   parado = crítico.
6. Pulso: `GET` no normal, `POST /fail` no crítico.
7. `configurar`: linha alheia e comentário sobrevivem, ordem mantida, chave nova no fim, valor inválido recusado
   com motivo, permissão 600.
8. Nenhum segredo (token, senha, URL do pulso) aparece no log, no estado do painel, na saída `--json` nem nas
   mensagens de erro.
9. Alívio de RAM: para a ronda primeiro, depois só o navegador do maior container, nunca mais de uma vez em
   30 min por agente, nunca outra unidade.
10. Instalador (`tests/instalador`): as unidades são escritas com os campos acima; `sentinela.conf` existente
    com linha alheia não é tocado; drop-in do journald não é criado se já existe `SystemMaxUse`.
