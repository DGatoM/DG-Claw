# Imagem do agente (container)

Imagem `localhost/dgclaw-agente`: uma "VPS pequena" para cada agente (systemd, cron, sudo), com as
ferramentas que os agentes de verdade usam, o runner e o plugin DG Claw já dentro.

## O que tem na imagem e por quê

A lista nasceu do levantamento do que os agentes já em produção chamam no dia a dia.

| Item | Por que está aí |
| --- | --- |
| Ubuntu 24.04, systemd, cron, sudo, usuário `agente` (uid 1001) | O agente é uma máquina: cria timer, instala o que precisa, e o cron sobe junto com o boot. O root de dentro é um uid alto sem nome no host (mapa de uid do podman). |
| Locale pt_BR e en_US, fuso `America/Sao_Paulo` | Datas e acentos certos; alguns scripts pedem en_US. |
| Node 22 (NodeSource, com chave) | Roda o runner, o painel e as ferramentas globais. |
| Claude Code, Codex CLI | Os dois provedores do agente, com versão fixada por `ARG`. A credencial não vem na imagem. |
| Bun | O plugin oficial do Telegram roda em Bun. O plugin em si não vai na imagem (a casa `/home/agente` é montada do host e esconderia a instalação); quem instala é o `dgclaw agente criar`. |
| ffmpeg, poppler-utils | Áudio de voz, vídeo, quadros de conferência e PDFs recebidos. |
| fonts-liberation, fonts-noto-color-emoji, fontconfig | Imagens, PDFs e capturas de tela saem sem quadradinhos. |
| gh (repositório oficial, com chave) | Push e pull request. |
| git, curl, wget, jq, ripgrep, sqlite3, unzip, zip, xz-utils, rsync, file, less, nano, vim-tiny, procps, iproute2, dnsutils, openssh-client, gawk, bc, tini | Ferramentas básicas que os scripts dos agentes e dos alunos assumem. |
| `/opt/venv` no PATH | Python com Pillow, requests, numpy, pyyaml, openpyxl, pymupdf, playwright (só o pacote) e yt-dlp. O venv evita o bloqueio PEP 668 do Ubuntu: o agente roda `pip install` normal. |
| yt-dlp pelo pip | É o jeito que recebe atualização; o do apt envelhece rápido. |

Nenhum compilador fica na imagem final: o `node-pty` do runner compila num estágio à parte
(`runner-build`) e só o resultado é copiado.

### Versões fixadas

Claude Code 2.1.296, Codex CLI 0.162.1, Bun 1.4.3 (todos por `ARG`, no topo do estágio `base`).
Python: Pillow 12.3.0, requests 2.34.2, numpy 2.5.4, pyyaml 6.0.3, openpyxl 3.1.5, pymupdf 1.28.2,
playwright 1.63.0, yt-dlp 2026.8.19. Node 22 e o gh seguem o repositório oficial no dia do build.

## Como construir

Da raiz do repositório:

```
podman build --ignorefile container/ignore \
  -t localhost/dgclaw-agente:<versao> -t localhost/dgclaw-agente:latest \
  --build-arg DGCLAW_VERSAO=<versao> \
  -f container/Containerfile .
```

**O argumento `--ignorefile container/ignore` é necessário.** O podman só lê `.containerignore` e
`.dockerignore` da raiz do contexto, e este repo não tem um (a lista de exclusão vive em `container/`).
Ela tira `.git`, todo `node_modules`, `tests`, `qa`, `lite`, `local`, `panel-redesign` e `*.log` da
imagem. A pasta `runner/` não pode ser excluída, porque o estágio de build precisa do código dela.

Perfil com navegador (Chromium do Playwright, bibliotecas do sistema e Xvfb), para quem faz captura de
tela, QA de página ou automação logada:

```
podman build --ignorefile container/ignore --build-arg COM_NAVEGADOR=1 \
  -t localhost/dgclaw-agente:<versao>-navegador -f container/Containerfile .
```

Estágios: `runner-build` (compila o runner), `base` (a máquina inteira, sem o código do DG Claw) e
`final` (o padrão). `--target base` constrói sem precisar do `runner/`.

Se o build rodar atrás de proxy no host, o proxy do ambiente aponta para `127.0.0.1` do host e some
dentro do build. Use `--network=host` no `podman build` nesse caso.

### Tamanho medido

Perfil padrão (sem navegador): cerca de **2,2 GB** descomprimido em disco (2.214.999.287 bytes na
medição de 12/10/2026, com um runner de teste no lugar do real). Os maiores blocos são as ferramentas
npm globais (Claude Code, Codex, Bun, perto de 800 MB) e o ffmpeg com suas bibliotecas. O perfil com
navegador soma de 500 a 600 MB.

## As duas unidades (dentro da imagem, já habilitadas)

Ficam em `container/units/` e são copiadas para `/etc/systemd/system/` com `systemctl enable` no build
(só cria os links). O `ConditionPathExists` de cada uma segura a subida até o agente ter configuração.

- `dgclaw-runner.service`: usuário `agente`, roda `node /opt/dgclaw/app/runner/dist/index.js` na porta
  4300. Lê `runner.json` de `/etc/dgclaw-runner/runner.json` (montagem somente leitura do host),
  guarda o estado em `/home/agente/.plataforma/runner-state.json` e o token em
  `/run/dgclaw/segredos/runner.token`. Carrega o cofre de `/run/dgclaw/cofre/cofre.env` (o `-` deixa subir
  sem o arquivo). Limpa do ambiente as variáveis do Claude Code (`UnsetEnvironment`), para o claude que o
  runner abre não se achar filho de outra sessão. `Restart=always`, `RestartSec=3`.
- `dgclaw-painel.service`: usuário `agente`, roda `node server.js` em `/opt/dgclaw/app/panel`, porta 8300.
  Lê `/run/dgclaw/config/painel.env`; sem esse arquivo, não sobe. `Restart=always`, `RestartSec=3`.

## Montagens que o `dgclaw agente criar` faz

| Dentro do container | Vem de | Modo |
| --- | --- | --- |
| `/home/agente` | a casa do agente no host | leitura e escrita |
| `/run/dgclaw/segredos/` | pasta de segredos do agente (token do runner, segredo do proxy) | somente leitura |
| `/run/dgclaw/cofre/` (contém `cofre.env`) | pasta do cofre | somente leitura |
| `/run/dgclaw/config/` (contém `painel.env`) | pasta de configuração do painel | somente leitura |
| `/etc/dgclaw-runner/` (contém `runner.json`) | pasta do host | somente leitura |

Cofre e config são pastas, e não arquivos soltos, porque a montagem de um arquivo prende o inode antigo
quando o painel reescreve o arquivo por "escrever tmp e renomear".

`/etc/dgclaw-runner` já existe vazia na imagem (755, root) para servir de ponto de montagem.

**Nota sobre `--tmpfs /run`.** O container é criado com `--tmpfs /run`, e as montagens acima caem
dentro de `/run/dgclaw`. Isso só funciona se o podman montar o pai (o tmpfs) antes dos filhos; o libpod
ordena as montagens pela profundidade do destino, então deve funcionar, mas **não foi testado aqui**.
Precisa ser conferido no primeiro teste numa VPS limpa (o card 1 faz). Se as montagens sumirem, a saída
é mover os destinos para fora de `/run` e ajustar as unidades.

## No PATH e no ambiente do agente

- `bun` fica em `/usr/bin` (instalado pelo npm global), logo no PATH do agente e das unidades.
- `/opt/venv/bin` e `~/.local/bin` entram no PATH pela imagem (`ENV PATH`) e por
  `/etc/profile.d/agente.sh`.
- `/etc/profile.d/agente.sh` também define `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `TZ`,
  `PLAYWRIGHT_BROWSERS_PATH`, `DGCLAW_RUNNER_URL=http://127.0.0.1:4300` e
  `RUNNER_TOKEN_FILE=/run/dgclaw/segredos/runner.token` (só o caminho; o valor nunca vai na imagem).
- `dgclaw-agente`, a CLI que roda DENTRO do container, tem o link
  `/usr/local/bin/dgclaw-agente -> /opt/dgclaw/app/bin/dgclaw-agente`, criado no build. O link fica
  pendente (aponta para nada) enquanto o repo não trouxer `bin/dgclaw-agente`; o build não falha por
  isso. O `bin/dgclaw`, que é do host, não entra no PATH de dentro.
