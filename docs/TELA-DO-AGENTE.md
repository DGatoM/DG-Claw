# A Tela do agente

Todo agente com a imagem com navegador ganha uma **Tela**: um Google Chrome de verdade, numa tela
virtual, que o dono abre pelo painel (botão **Tela**) e usa como se fosse o navegador dele. O
agente usa o mesmo Chrome, já logado, nas automações.

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
   Google Chrome        janela em :1, perfil ~/.tela-chrome, CDP em 127.0.0.1:9222
```

As unidades systemd estão em `container/units/`:

| Unidade | O que faz |
| --- | --- |
| `dgclaw-tela.service` | Xvfb `:1` (1440x900x24, sem escutar TCP) e fluxbox. |
| `dgclaw-tela-vnc.service` | x11vnc em `localhost:5901`. Só sobe se `/home/agente/.dgclaw/tela/vnc.senha` existir. |
| `dgclaw-tela-web.service` | noVNC/websockify em `127.0.0.1:6080`. |
| `dgclaw-tela-chrome.service` | Chrome com o perfil persistente e o CDP em `127.0.0.1:9222`. |
| `dgclaw-tela-senha.path` e `.service` | Observam o arquivo da senha e reiniciam o x11vnc quando ele muda. |

Existem **duas senhas**, e as duas são necessárias para ver a Tela: o **login do painel** (quem
chega no proxy) e a **senha da Tela** (a do VNC, guardada no `rfbauth`).

## A senha da Tela

- **Nasce na criação.** O `dgclaw agente criar` gera uma senha aleatória de 8 caracteres (sem
  caracteres ambíguos como 0, O, 1, I e l) para cada agente e mostra **uma vez**, num bloco no fim:
  "anote a senha da Tela". Rodar o `criar` de novo não gera outra nem mostra de novo.
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

## Variáveis do painel

O painel que roda dentro do agente lê estas variáveis (no `painel.env`). Os valores entre parênteses
são os esperados na imagem do DG Claw.

| Variável | O que é |
| --- | --- |
| `DGCLAW_TELA_NOVNC` | Onde está o noVNC dentro do agente (`http://127.0.0.1:6080`). |
| `DGCLAW_TELA_SENHA_ARQUIVO` | Onde o painel grava o rfbauth (`/home/agente/.dgclaw/tela/vnc.senha`). |
| `DGCLAW_TELA_URL_EXTERNA` | Endereço alternativo da Tela, para fachadas que não repassam WebSocket (ver abaixo). |
| `DGCLAW_TELA_CDP` | Endereço do CDP do Chrome (`http://127.0.0.1:9222`). |

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
- O Chrome roda com `--no-sandbox`, porque no podman com `uidmap` o sandbox do Chrome não sobe. O
  isolamento real é o do container, que já separa o agente do servidor.
- O dono é quem faz os logins. O agente nunca digita senha de sistema e não guarda a de ninguém.

## Como ligar numa instalação existente

1. Construa a imagem com navegador (`COM_NAVEGADOR=1`; o `install.sh` constrói sem, e isso não muda):
   ```
   podman build --ignorefile container/ignore --build-arg COM_NAVEGADOR=1 \
     -t localhost/dgclaw-agente:<versao>-navegador -f container/Containerfile .
   ```
   Só amd64: o Google Chrome não tem pacote para outra arquitetura.
2. Aponte `DGCLAW_IMAGEM` (em `/etc/dgclaw/dgclaw.env`) para essa imagem.
3. **Recrie o agente** que vai ganhar a Tela. Um container existente continua na imagem antiga.
   A casa dele é preservada ao remover (`dgclaw agente remover`, que só move), então crie de novo
   com o mesmo nome e a mesma casa. Para um agente já existente sem senha da Tela,
   `printf '%s\n' "Senha8ch" | dgclaw agente tela-senha <slug>` grava a primeira.
4. Dê mais memória, se precisar: `podman update --memory 3g dgclaw-<slug>`.

## Agentes da VPS (jaula)

Os agentes da VPS do Danilo, em `/srv/agents-jaula`, usam o `Containerfile.tela` próprio e guardam o
rfbauth em `/home/agente/.plataforma/segredos/vnc.senha`. O painel aceita esse caminho por
`DGCLAW_TELA_SENHA_ARQUIVO`. As unidades de lá têm nomes sem o prefixo `dgclaw-` (`tela-vnc.service`
e companhia). Quem migrar um agente da jaula para a imagem do DG Claw troca o caminho para
`/home/agente/.dgclaw/tela/vnc.senha`.
