# A Tela do agente

Todo agente com a imagem com navegador ganha uma **Tela**: um navegador de verdade (Google Chrome em
servidor amd64, Chromium em arm64), numa tela virtual, que o dono abre e usa como se fosse o navegador
dele. A Tela é **interativa**: o dono digita e clica direto nela (noVNC, sem modo só de leitura). O agente
usa o mesmo navegador, já logado, nas automações.

**Como o dono chega nela.** Pelo item **Navegador** do menu de cada agente, na própria
conversa (abre em outra aba o painel do agente já na aba Tela, pelo endereço `<painel>/#aba=tela`), ou pela aba Tela
do painel. O Admin não tem o item: ele não tem navegador. Ao entrar, se a senha da Tela ainda não foi
definida, a aba abre direto no formulário "Defina a senha da tela" (de 6 a 8 caracteres) e, depois de
gravar, a tela abre sozinha.

## Para que serve

- **O dono faz os logins dos sistemas.** Site com usuário, senha, 2FA ou captcha: o dono entra
  pela Tela, com o teclado dele. A senha não passa pela conversa nem fica em arquivo do agente.
- **O agente trabalha logado.** Depois do login, as automações conectam nesse Chrome e usam a sessão
  que já existe.
- **Tudo viaja junto.** Os logins ficam no perfil `/home/agente/.tela-chrome`, que está na casa do
  agente. Quando a casa é transferida ao cliente, os logins vão com ela.
- Site com anti-robô recusa Chrome headless. Por isso a Tela é um Chrome com janela, não headless.

## Arquitetura

```
 dono (navegador)
   |  HTTPS + login do painel
   v
 painel / web do DG Claw  --- proxy autenticado: <base>/tela/websockify
   |  (a web/ do DG Claw já repassa WebSocket em /p/<agente>/)
   v
 container do agente
   websockify (noVNC)   127.0.0.1:6080   <- só localhost
   x11vnc               127.0.0.1:5901   <- só localhost, -rfbauth
   Xvfb :1 + fluxbox    tela 1440x900
   Navegador            janela em :1, perfil ~/.tela-chrome, CDP em 127.0.0.1:9222
                        (Google Chrome em amd64; Chromium do Playwright nas outras arquiteturas)
```

As unidades systemd estão em `container/units/`:

| Unidade | O que faz |
| --- | --- |
| `dgclaw-tela.service` | Xvfb `:1` (1440x900x24, sem escutar TCP) e fluxbox. |
| `dgclaw-tela-vnc.service` | x11vnc em `localhost:5901`, com `-xkb` para o teclado. Só sobe se `/home/agente/.dgclaw/tela/vnc.senha` existir. |
| `dgclaw-tela-web.service` | noVNC/websockify em `127.0.0.1:6080`. |
| `dgclaw-tela-chrome.service` | Chama o lançador `dgclaw-tela-navegador`, que abre o navegador com o perfil persistente e o CDP em `127.0.0.1:9222`. |
| `dgclaw-tela-senha.path` e `.service` | Observam o arquivo da senha e reiniciam o x11vnc quando ele muda. |

Existem **duas senhas**, e as duas são necessárias para ver a Tela: o **login do painel** (quem
chega no proxy) e a **senha da Tela** (a do VNC, guardada no `rfbauth`).

## A senha da Tela

- **Nasce na criação.** O `dgclaw agente criar` gera uma senha aleatória de 8 caracteres (sem
  caracteres ambíguos como 0, O, 1, I e l) para cada agente e mostra **uma vez**, num bloco no fim:
  "anote a senha da Tela". Rodar o `criar` de novo não gera outra nem mostra de novo.
- **Agente sem senha.** O `dgclaw agente recriar`, o `reparar` e o `atualizar` **não inventam senha**:
  uma senha escondida seria uma senha que ninguém conhece. Se o agente tem a Tela e a casa dele ainda não
  tem o arquivo da senha, eles imprimem uma linha dizendo que a senha ainda não foi definida e como
  definir (aba Tela do painel, ou `printf '%s\n' "Senha8ch" | dgclaw agente tela-senha <slug>`). O
  `atualizar` junta essas linhas no resumo final, uma por agente ("Tela sem senha: ..."). Enquanto não
  houver senha, a aba Tela do painel abre no formulário para o dono definir.
- **Troca.** O dono troca no painel, aba Tela, ou por API (`PUT <base>/api/tela/senha`). Quem
  administra o servidor troca com `printf '%s\n' "NovaSenha" | dgclaw agente tela-senha <slug>`.
  A senha nova vale na hora e a anterior deixa de abrir.
- **Limite de 8 caracteres.** O VNC só usa os 8 primeiros. Por isso a regra é de 6 a 8 caracteres
  ASCII, e mais que isso é recusado com o motivo (em vez de truncar sem avisar).
- **Só como rfbauth.** O arquivo `home/.dgclaw/tela/vnc.senha` (modo 600, pasta 700, dono do agente)
  guarda 8 bytes cifrados no formato do x11vnc. A senha em texto puro nunca é gravada, nunca vai
  para log e nunca passa por argumento de comando (sempre pelo STDIN). O gravador é
  `panel/bin/tela-senha.js --arquivo <caminho>`.
- **O x11vnc acompanha.** `dgclaw-tela-senha.path` observa o arquivo (`PathChanged`) e reinicia
  `dgclaw-tela-vnc.service`. Isso vale tanto para a troca quanto para a primeira gravação, quando o
  x11vnc ainda não tinha subido por falta do arquivo. Foi descoberto em produção que o x11vnc sobe
  mesmo sem o arquivo de senha, e isso deixaria a tela aberta; por isso a unidade tem
  `ConditionPathExists` e o `-localhost`.

## O navegador da Tela: Google Chrome ou Chromium

O `dgclaw-tela-chrome.service` não chama o Chrome direto: chama o lançador `bin/dgclaw-tela-navegador`
(instalado em `/usr/local/bin`), que escolhe o navegador:

1. **Google Chrome estável**, se `google-chrome-stable` existir (imagem amd64);
2. senão, o **Chromium do Playwright** (`/opt/playwright/chromium-*/chrome-linux*/chrome`), que já faz
   parte da imagem com navegador e existe para arm64, rodando **com janela** (não headless) no `:1`.

Os dois sobem com as mesmas flags (perfil `~/.tela-chrome`, CDP só em `127.0.0.1:9222`, `--no-sandbox`
dentro do container, flags econômicas). Se não houver nenhum dos dois, o lançador sai com o código 78 e
uma mensagem dizendo o que fazer, e a unidade não fica reiniciando em laço.

**arm64.** O Google Chrome só tem pacote para amd64. Antes, o `Containerfile` abortava a construção da
imagem com `COM_NAVEGADOR=1` nessa arquitetura, e quem instalava em arm64 ficava sem imagem nenhuma. Agora
ele instala a Tela inteira (Xvfb, fluxbox, x11vnc, noVNC e websockify) e usa o Chromium. Para o dono é a
mesma Tela; a diferença é que **alguns sites com proteção contra robôs podem tratar o Chromium de outro
jeito** que o Chrome (pedir captcha a mais, por exemplo). A aba Tela mostra um aviso discreto quando esse
é o caso. Não deu para provar a construção em arm64 sem uma máquina arm64; o que está coberto por teste é
a estrutura do `Containerfile` e a execução do trecho de instalação com o `dpkg` respondendo `arm64`.

## Teclado

O x11vnc roda com `-xkb`: ele usa a extensão XKEYBOARD do Xvfb para remapear as teclas que o mapa
americano da tela virtual não tem, que é o caso das letras com acento e do `ç` quando o dono digita
direto pelo noVNC. O pacote `x11-xkb-utils` está na lista de instalação da Tela (já vinha como dependência
do Xvfb). O noVNC também reconecta sozinho, com 2 segundos de atraso, quando o x11vnc reinicia depois de
uma troca de senha. Se uma tecla ainda sair errada no seu teclado, avise: o ajuste seguinte é fixar o
layout com `setxkbmap br` na unidade da tela virtual.

## Não aparece a Tela? Confira assim

A aba Tela já mostra a conferência (caixa "Situação" e, embaixo, o que fazer). Do servidor, a mesma
conferência sai com:

```bash
dgclaw agente tela <slug>
```

Uma linha por item, `ok` ou `FALTA` com o que fazer, saída 0 quando está tudo bem, 1 quando algo falta e 2 quando o
agente está desligado. A API `GET <painel>/api/tela` devolve o mesmo em `problemas` (`codigo`, `texto`,
`como_resolver`). As causas, na ordem em que costumam aparecer:

| Causa | O que a conferência diz | O que fazer |
| --- | --- | --- |
| A imagem do agente não tem a Tela | `sem-navegador` | Reconstruir a imagem (`dgclaw imagem construir --agora`) e `dgclaw agente recriar <slug> --forcar`. |
| Senha da Tela nunca definida (o caso mais comum em agente de antes da Tela) | `senha-nao-definida` | Definir na aba Tela do painel, ou `printf '%s\n' "Senha8ch" \| dgclaw agente tela-senha <slug>`. |
| O x11vnc está parado, mesmo com a senha | `vnc-parado` | Esperar uns segundos (ele religa depois de trocar a senha); se continuar, `podman exec dgclaw-<slug> systemctl restart dgclaw-tela-vnc`. |
| O noVNC (websockify) não responde | `websockify-parado` | `systemctl restart dgclaw-tela-web` dentro do agente. |
| O navegador não responde no CDP | `cdp-parado` | `systemctl restart dgclaw-tela-chrome` dentro do agente. |
| Servidor arm64 | `navegador-alternativo` (aviso, não é erro) | Nada a fazer: a Tela usa o Chromium. |

Em todos os casos o log da unidade diz o resto: `podman exec dgclaw-<slug> journalctl -u dgclaw-tela-<parte> -n 30`.

## Variáveis do painel

O painel que roda dentro do agente lê estas variáveis (no `painel.env`). Os valores entre parênteses
são os esperados na imagem do DG Claw.

| Variável | O que é |
| --- | --- |
| `DGCLAW_TELA_NOVNC` | Onde está o noVNC dentro do agente (`http://127.0.0.1:6080`). |
| `DGCLAW_TELA_SENHA_ARQUIVO` | Onde o painel grava o rfbauth (`/home/agente/.dgclaw/tela/vnc.senha`). |
| `DGCLAW_TELA_URL_EXTERNA` | Endereço alternativo da Tela, para fachadas que não repassam WebSocket (ver abaixo). |
| `DGCLAW_TELA_CDP` | Endereço do CDP do navegador (`http://127.0.0.1:9222`). |
| `DGCLAW_TELA_VNC` | Onde o x11vnc escuta, só para a conferência (`127.0.0.1:5901`). |
| `DGCLAW_TELA_UNIDADE` | Arquivo que prova que a imagem tem a Tela ligada, só para a conferência. |
| `DGCLAW_TELA_CHROME` | Caminho do Google Chrome, só para a conferência dizer qual navegador está em uso. |

## Fachadas sem WebSocket: a decisão

O noVNC precisa de WebSocket de ponta a ponta. A web do DG Claw (`/p/<agente>/`) repassa WebSocket,
então a Tela abre normalmente no proxy do painel.

Na VPS do Danilo a fachada dos clientes é outra: o **agents-web** (Next, rota
`/api/meus/agentes/<id>/painel`), que **não repassa WebSocket**. Ali o painel detecta que a sonda
não abriu e oferece o endereço `tela-<slug>.dgmedeiros.com.br`, protegido por **Cloudflare Access**
mais a senha da Tela. Esse endereço é configurado em `DGCLAW_TELA_URL_EXTERNA`. A decisão é
ficar com esse subdomínio e não mexer na fachada.

## Como o agente usa (CDP)

O agente conecta no Chrome da Tela por `playwright connect_over_cdp('http://127.0.0.1:9222')`,
reaproveita `browser.contexts[0]` (onde estão os logins), abre uma página nova e fecha **só a página**,
nunca o navegador. Antes de usar, confere `curl -s 127.0.0.1:9222/json/version`. Quando trava em um
login, pede ao dono que entre pela Tela e nunca pede a senha na conversa. O roteiro completo é a
skill `skills/tela/SKILL.md` (`/dgclaw:tela`), e o `CLAUDE.md` do agente aponta para ela.

## Memória

O Chrome pesa. Com a Tela ligada, conte de 1 a 2 GB só para o navegador e as abas, além do runner,
do painel e do Claude Code. O `--memory 2g` que o `dgclaw agente criar` aplica hoje pode apertar; para
um agente com Tela, 3 GB é um ponto de partida mais seguro (`podman update --memory 3g
dgclaw-<slug>`). **Meça antes de padronizar:** `podman stats dgclaw-<slug>` com os sites reais abertos.
As flags do Chrome já são econômicas: sem GPU, sem `/dev/shm`, no máximo 4 processos de renderização.

## Segurança

- **Nunca exponha 5901, 6080 nem 9222** fora do container. O x11vnc usa `-localhost`, o websockify
  escuta só em `127.0.0.1:6080` e o CDP em `127.0.0.1:9222`. O container também só publica as portas do
  runner e do painel, em `127.0.0.1`.
- Quem chega de fora passa pelo proxy autenticado do painel (login) e ainda precisa da senha da Tela.
- O CDP dá controle total do Chrome logado. Por isso só o próprio agente o alcança.
- Uma bateria de testes (`tests/tela/rodar.sh`) falha se alguma unidade perder o `-localhost`, o `-rfbauth`,
  o bind em `127.0.0.1` do noVNC e do CDP, ou o `ConditionPathExists` do VNC.
- O navegador roda com `--no-sandbox`, porque no podman com `uidmap` o sandbox do Chrome não sobe. O
  isolamento real é o do container, que já separa o agente do servidor.
- O dono é quem faz os logins. O agente nunca digita senha de sistema e não guarda a de ninguém.

## Como ligar numa instalação existente

O `install.sh` já constrói a imagem com `COM_NAVEGADOR=1` (o padrão desde 17/10/2026), então a
Tela vem na imagem de todo agente. Um agente criado antes desta versão ganha a Tela assim:

1. Atualize o DG Claw, para que a imagem nova seja construída (em arm64 a Tela usa o Chromium; ver
   acima). A instalação padrão, sem flags, prepara o painel e o Admin e **adia a imagem para a criação do
   primeiro agente**; nessa hora a imagem é construída com `COM_NAVEGADOR=1`, ou seja, com a Tela, antes de
   o agente ficar pronto, e o `dgclaw agente criar` gera e mostra a senha da Tela uma vez.
2. `dgclaw agente recriar <slug>`: troca o container pelo da imagem atual sem tocar na casa.
3. Defina a primeira senha da Tela. Pode ser pelo painel (a aba Tela abre direto em "Defina a senha da
   tela" quando ainda não há senha) ou pelo terminal:
   `printf '%s\n' "Senha8ch" | dgclaw agente tela-senha <slug>`. Enquanto não houver senha, o
   x11vnc não sobe.
4. Dê mais memória, se precisar: `podman update --memory 3g dgclaw-<slug>`. O Chrome pesa, e o
   padrão de 2 GB pode apertar.

## Agentes da VPS (jaula)

Os agentes da VPS do Danilo, em `/srv/agents-jaula`, usam o `Containerfile.tela` próprio e guardam o
rfbauth em `/home/agente/.plataforma/segredos/vnc.senha`. O painel aceita esse caminho por
`DGCLAW_TELA_SENHA_ARQUIVO`. As unidades de lá têm nomes sem o prefixo `dgclaw-` (`tela-vnc.service`
e companhia). Quem migrar um agente da jaula para a imagem do DG Claw troca o caminho para
`/home/agente/.dgclaw/tela/vnc.senha`.
