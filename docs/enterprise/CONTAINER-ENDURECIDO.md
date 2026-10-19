# Container endurecido, cofre cifrado, disco cifrado e backup (bloco D)

Este documento descreve o que o bloco D liga em cada nível de proteção, o que deixa de funcionar e o que fazer
em cada caso. Nada disso age no nível `pessoal`: sem `/etc/dgclaw/protecoes.json` o DG Claw se comporta como
sempre se comportou.

| Proteção | Chave da matriz | Arquivo principal |
| --- | --- | --- |
| Container endurecido | `container_endurecido` | `lib/enterprise/container.sh`, `lib/enterprise/firewall6.sh` |
| Cofre cifrado | `cofre_cifrado` | `lib/enterprise/cofre-cifrado.sh`, `web/lib/ent/cofre-cifrado.js` |
| Disco cifrado | `disco_cifrado` (`auto`; `externo` é da Fase 3) | `lib/enterprise/disco.sh` |
| Backup | `backup`, `backup_retencao_dias` | `lib/enterprise/backup.sh` |

## 1. Container endurecido

O `podman create` ganha, só quando `container_endurecido` está ligado:

- `--cap-drop=ALL` e de volta só `CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP,
  NET_BIND_SERVICE, SYS_CHROOT, AUDIT_WRITE`. O porquê de cada uma está no comentário de `ENT_CONT_CAPS` em
  `lib/enterprise/container.sh`. Ficam de fora `MKNOD`, `SETFCAP` e `NET_RAW` (que o podman daria por padrão).
- `--security-opt no-new-privileges`
- `--ulimit nofile=4096:8192` (o `--pids-limit 1024` já existia)

Cerca IPv6: `lib/firewall.sh` chama `lib/enterprise/firewall6.sh` no fim. Ele barra, no `ip6tables`, todo IPv6 que
entra ou sai das pontes das redes `dgclaw-*` e põe `net.ipv6.conf.<ponte>.disable_ipv6=1`. Não mexe nas regras
IPv4 nem na ordem da tabela mangle.

Cota de disco: a casa do agente é um diretório do host montado dentro do container, e `--storage-opt size=` só
limita a camada gravável do container, não a casa. Por isso a cota depende do disco cifrado (ver a seção 3).

### O que deixa de funcionar sem o `sudo`

Com `no-new-privileges` o `sudo` do agente (`NOPASSWD:ALL`) deixa de funcionar: o bit setuid é ignorado. É o
efeito desejado (o agente não vira root de dentro e o cofre fica fora do alcance dele), mas quebra quem usava
`sudo`. Levantamento (`grep -rn "sudo " skills scripts templates container bin`):

| Quem usa sudo | O que era | Passa a acontecer | O que fazer |
| --- | --- | --- | --- |
| `skills/video-animado` (`renderizar.py`, `SKILL.md`) | `sudo -E ... playwright install --with-deps chromium` e `sudo apt-get install -y ffmpeg` quando falta | Falha com "sudo: effective uid is not 0" | Chromium e ffmpeg já vêm na imagem (`COM_NAVEGADOR=1` é o padrão). Faltando algo, o dono roda `dgclaw agente pacote <slug> <pacote>` |
| `skills/service` (`SKILL.md`) | `sudo systemctl restart/stop/start dgclaw-<slug>` | Falha | Esse roteiro é da arquitetura antiga (serviço no host). No container o dono usa `dgclaw agente reiniciar <slug>` |
| `bin/dgclaw-agente` (`canal whatsapp ligar/desligar`) | `sudo -n systemctl enable/start dgclaw-whatsapp` | Falha ao ligar ou desligar o canal pelo agente | O dono roda `podman exec dgclaw-<slug> systemctl enable --now dgclaw-whatsapp` |
| `scripts/persona-cron-mgr.py` | Grava `.service`/`.timer` em `/etc/systemd/system` e roda `systemctl` com `sudo -n` | O agente não consegue criar rotina nova (rotinas já instaladas continuam rodando) | O dono cria a rotina com `dgclaw agente reparar <slug>` (reinstala as rotinas) ou pede ao agente para usar `crontab -e` (o cron do container não precisa de sudo) |
| `scripts/watchdog.py`, `scripts/_lib/reinicio.py` (modo clássico) | `systemctl restart` com `sudo -n` quando não é root | O reinício automático pelo vigia falha e é registrado como `erro` no Pulso | No container o modo Bunker/runner (HTTP) já é o usado e não precisa de sudo; no modo clássico o dono reinicia com `dgclaw agente reiniciar <slug>` |
| `scripts/doctor.sh`, `scripts/install-*.sh`, `skills/uninstall`, `skills/panel`, `skills/doctor` | Roteiros da arquitetura antiga (plugin no host) escritos com `sudo` | Só valem fora do container | Não se aplicam ao agente da v1 |

As rotinas continuam subindo como `User=agente` (a troca de `User=root` por `User=agente` em `vida_script` não
foi mexida). Quem precisa instalar pacote: `dgclaw agente pacote <slug> <pacote...>`, que valida os nomes (regex
de pacote Debian), roda `podman exec -u 0 <container> apt-get install -y -- <pacotes>` com os argumentos em array e
audita (`agente.pacote`). Só funciona com `container_endurecido` ligado; no nível pessoal o agente ainda tem sudo.

### Agentes que já existiam

O container de um agente criado antes não ganha as opções novas sozinho. `dgclaw protecoes aplicar` lista quais
estão defasados, e `dgclaw agente recriar <slug> --forcar` refaz o container. O `--forcar` é necessário:
sem ele o comando do `main` responde "nada a recriar" quando o container já usa a imagem atual, que é justamente o
caso de quem acabou de subir o nível. A casa do agente (memória, conversas,
arquivos) é uma pasta do host e fica. Perde-se o que ficava só na camada do container: pacotes instalados com
`apt`, o que ele instalou em `/opt`, e as rotinas (que o próprio comando reinstala, como o `reparar`).

## 2. Cofre cifrado

Com `cofre_cifrado` ligado:

- No disco fica só `<casa>/cofre/cofre.env.cred`, cifrado com `systemd-creds encrypt
  --name=dgclaw-cofre-<slug> --with-key=auto` (chave do host; TPM2 se houver). O valor entra pelo stdin, nunca
  por argumento.
- A cópia em claro vive em `/run/dgclaw/cofres/<slug>/cofre.env` (tmpfs, pasta 700, arquivo 600, dono é o root do
  container). O container monta essa pasta em `/run/dgclaw/cofre` no lugar de `<casa>/cofre`. No `podman create`
  o gancho `ent_args_container_cofre_cifrado` não acrescenta um segundo `--volume`: percorre o array e reescreve o
  elemento `<casa>/cofre:/run/dgclaw/cofre:ro`.
- Quem abre a cópia em memória: a unidade `dgclaw-cofre.service` (no boot, depois do disco cifrado e antes de
  qualquer container) e o gancho `ent_antes_de_iniciar_cofre`, a cada `dgclaw agente iniciar`.
- O Web (`web/lib/cofre-agente.js`, com a lógica em `web/lib/ent/cofre-cifrado.js`) grava e revoga chaves já
  cifrando: o texto em claro nunca vai ao disco. Se o `.cred` não decifra, o Web recusa a operação (não grava por
  cima, para não perder as chaves).
- `dgclaw cofre migrar` cifra os cofres que estão em claro, confere por sha256 que o `.cred` devolve o mesmo
  conteúdo e só então apaga o claro. `dgclaw cofre abrir [slug]` reabre a cópia em memória. `dgclaw cofre status`
  mostra o estado de cada agente.

## 3. Disco cifrado

Numa VPS normalmente não há disco sobrando, então o volume é um arquivo: `/var/lib/dgclaw-cofre/dados.luks`
(LUKS2, esparso), aberto como `dgclaw-dados` e montado em `/var/lib/dgclaw/agentes`, o mesmo caminho de sempre.

- `dgclaw disco cifrar [--tamanho 40G]`: cria a chave aleatória de 64 bytes em `/etc/dgclaw/disco.chave` (400),
  formata, para os agentes que estão ligados, copia com `rsync -aHAX --numeric-ids`, confere (contagem de itens e
  sha256 de uma amostra de até 200 arquivos), troca a montagem e guarda a pasta antiga em
  `agentes.antes-de-cifrar` (nunca apaga; ela está SEM cifra e o dono apaga depois de conferir). Falha antes da
  troca desfaz tudo e religa os agentes; o arquivo e a chave recém-criados são removidos.
- `dgclaw disco abrir` (usado pela unidade `dgclaw-disco.service`, antes de web, admin, firewall, cofre e
  containers) e `dgclaw disco status`.
- **Honestidade, repetida na saída dos comandos:** no modo `auto` a chave fica na própria máquina. Protege contra
  snapshot do disco, disco descartado e backup do provedor. Não protege contra quem tem root com a máquina ligada.
- O modo `externo` (Fase 3) troca só a origem da chave: a função `disco_obter_chave` devolve o caminho de um
  arquivo com a chave; hoje o `externo` responde que é da Fase 3.
- No instalador, `ent_instalar_disco` só avisa quando a máquina já tem agentes (cifrar move dados). Numa máquina
  nova, sem agentes, cifra direto com 70% do espaço livre.

### Cota por agente (só o desenho, não implementado)

Cada casa nova poderia ganhar um arquivo-imagem ext4 de tamanho fixo (padrão 10G, `--cota` no criar), criado
dentro do volume cifrado e montado em `<casa>` antes de o container subir. Pontos que pedem decisão antes de
construir: o `mount` de dezenas de imagens no boot (uma unidade por agente, ordenada depois do disco cifrado), o
que fazer com a casa de um agente que já existe (copiar para a imagem, com o agente parado) e o `fsck` quando a
máquina cai. Ficaria atrás de `DGCLAW_COTA_AGENTE`.

## 4. Backup cifrado fora da VPS

Ferramenta: restic, instalada pelo `ent_instalar_backup`. Configuração em `/etc/dgclaw/backup.env` (600), lida
pelo restic do ambiente (nunca por argumento ou log).

- `dgclaw backup configurar --repositorio <url> [--credenciais <arquivo>] [--senha-arquivo <arquivo>]`: testa com
  `restic snapshots` e, se o repositório não existe, faz `restic init`. A chave do repositório (48 bytes em
  base64) é gerada na primeira vez e mostrada uma vez só. **Sem ela não há restauração; a empresa precisa
  guardá-la fora da VPS.** Credenciais do bucket vêm de um arquivo `NOME=valor` (nomes `AWS_*`, `B2_*`, `AZURE_*`,
  `GOOGLE_*`, `OS_*`, `RCLONE_*`, `ST_*`) ou são pedidas no terminal.
- `dgclaw backup agora`: copia cada banco `.db` com `sqlite3 .backup` (sem o sqlite3, avisa do risco), grava o
  manifesto, roda `restic backup` de `/etc/dgclaw`, `/var/lib/dgclaw` (com o disco cifrado aberto, o conteúdo
  dele), `/opt/dgclaw/admin`, `VERSION` e as unidades `dgclaw*` do systemd, excluindo `node_modules`, `.cache`,
  `.npm`, `agentes.antes-de-cifrar` e `restauracoes`. Depois `restic forget --keep-daily <backup_retencao_dias>
  --prune`.
- `dgclaw backup listar`, `dgclaw backup status`.
- `dgclaw backup testar`: restaura o snapshot mais novo numa pasta temporária (só o manifesto e os arquivos da
  amostra) e confere o sha256. A amostra é `web.env`, `agentes.json` e, por agente, um transcript e um arquivo de
  memória; **o manifesto guarda o hash da cópia que foi para o snapshot, não do original**, porque o transcript
  muda a cada mensagem e daria falso alarme.
- `dgclaw restaurar <snapshot|latest> [--destino <pasta>] [--agente <slug>] [--confirmar]`: nunca sobrescreve
  sem `--destino` ou `--confirmar`. Sem os dois, restaura numa pasta ao lado (`/var/lib/dgclaw/restauracoes/...`).
  Por cima do que está em uso só com `--confirmar` e com os agentes parados.
- Estado em `/var/lib/dgclaw/backup/ultimo-backup.json` e `ultimo-teste.json`, no formato `{ok, quando, snapshot,
  erro}`, para o monitoramento do bloco F. Falha de backup sai com código 1 e a mensagem diz o que fazer.
- Auditoria: `backup.ok`, `backup.falha`, `backup.restauracao`, `backup.teste_restauracao` (e `backup.configurar`).
- Timers: `dgclaw-backup.timer` diário às 03:30 com `RandomizedDelaySec=30min`; `dgclaw-backup-teste.timer`
  semanal (mensal no nível `regulado`), ambos com `Persistent=true`.

## 5. Imagem por digest

O `FROM ubuntu:24.04` do `container/Containerfile` ainda não está preso a um digest: o ambiente em que este bloco
foi escrito não alcança `hub.docker.com`. O script `scripts/enterprise/fixar-digest-ubuntu.sh --aplicar` faz isso
(consulta o digest do manifest list oficial e reescreve os `FROM`); é o mesmo comando para atualizar depois.

## 6. Testes que só uma máquina real prova

- `podman create` com `--cap-drop=ALL` e a lista de capacidades: o systemd como PID 1 sobe? O runner, o painel, o
  cron e o `ExecStartPre=+` do cofre-nomes funcionam? O `runuser` do `dgclaw agente criar` (plugin do Telegram)
  funciona sem `AUDIT_WRITE` extra? `ping` de dentro?
- `no-new-privileges`: `sudo` falha de dentro; `dgclaw agente pacote` instala pacote de verdade; as rotinas
  continuam disparando pelos timers.
- Cerca IPv6: `ip6tables -S DGCLAW_V6`, `ping6` de dentro do container falha, e as regras v4 e a tabela mangle
  continuam como antes (`iptables -t mangle -S FORWARD`).
- `systemd-creds` de verdade: `dgclaw cofre migrar`, reiniciar a máquina, `dgclaw-cofre.service` abre a cópia em
  memória antes dos containers, o agente sobe com as chaves. Com e sem TPM2.
- Disco: `dgclaw disco cifrar` com agentes ligados numa VPS real; reiniciar e ver `dgclaw-disco.service` abrir o
  volume antes do Web; `fsck` e espaço (arquivo esparso).
- Backup: `restic` contra um bucket S3 ou B2 de verdade, `dgclaw backup testar` e `dgclaw restaurar --destino`.
- `dgclaw agente recriar` num agente com rotinas e canal ligado.
