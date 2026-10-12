# DG Claw

Agentes de IA que trabalham para você 24 horas por dia, num servidor que é seu. Cada agente vive na
sua própria caixa separada, tem painel no navegador e conversa com você por um chat.

## O que é

O DG Claw instala, num servidor Linux seu, três coisas:

- o **DG Claw Web**, um painel no navegador com login e chat;
- o **Admin**, um agente de sistema que cuida da máquina e cria os outros agentes por conversa;
- a infraestrutura para os **agentes de trabalho**, cada um em um container separado, sem acesso aos
  arquivos dos outros nem ao servidor.

Você não cria agente por comando: abre o endereço, entra e conversa com o Admin. Ele pergunta pra que
você quer o agente, que nome e que jeito ele terá, e entrega o agente funcionando.

## Para quem é

Para quem quer ter agentes de IA próprios sem montar a infraestrutura na mão, mesmo sem saber
programar. O DG Claw usa a sua assinatura do Claude ou do Codex.

## Requisitos

- Um servidor (VPS) com **Ubuntu 22.04 ou 24.04**, acesso de administrador (root ou sudo), no mínimo
  **2 GB de RAM** e **15 GB livres** no disco.
- **Claude Code** ou **Codex** instalado e com login na sua assinatura, no próprio servidor. A página
  oficial do Claude Code explica a instalação: https://code.claude.com/docs/en/setup
- As portas 80 e 443 livres (o Caddy usa as duas para o endereço seguro do painel).

## O que a instalação muda na máquina

- **Pacotes** instalados pelo gerenciador do Ubuntu: podman, Caddy, Node 22, git, jq e ufw.
- **Caddy** passa a escutar nas portas 80 e 443 e entrega o painel por HTTPS, com certificado
  automático. O endereço é o nome do servidor na Hostinger (`hstgr.cloud`) quando ele aponta para a
  máquina, ou um endereço `sslip.io` baseado no IP. Domínio próprio entra com `--dominio`.
- **Firewall** (ufw) com entrada só nas portas 22, 80 e 443. Os containers dos agentes não alcançam
  o servidor.
- **Serviços** no systemd: `dgclaw-web` (o painel), `dgclaw-admin` (o Admin), `dgclaw-imagem` (constrói
  a imagem dos agentes) e `dgclaw-firewall`.
- **Pastas**: `/opt/dgclaw` (programa e casa do Admin), `/etc/dgclaw` (configuração, registro dos
  agentes e segredos, com permissão restrita), `/var/lib/dgclaw` (dados e casa de cada agente) e
  `/var/log/dgclaw` (registros).
- O comando `dgclaw` em `/usr/local/bin`.

O instalador mostra cada etapa em português e pode ser executado de novo sem estragar nada. Com
`--ensaio`, ele só lista o que faria, sem mudar a máquina.

## Instalação

**Pedindo ao Claude Code ou ao Codex.** No servidor, abra o assistente e escreva algo como:

> Baixei o projeto DG Claw do GitHub: https://github.com/DGatoM/DG-Claw. Lê o README e o INSTALL.md,
> me explica em poucas linhas o que vai ser instalado e, se eu disser que sim, instala.

O assistente clona o projeto, resume o que será feito, pergunta o **usuário** e a **senha** que você
quer para o painel (mínimo de 12 caracteres) e roda o instalador.

**À mão.** Com o login de administrador do servidor:

```
git clone https://github.com/DGatoM/DG-Claw
cd DG-Claw
less INSTALL.md
sudo ./install.sh --usuario <nome-que-voce-escolher>
```

O instalador pede a senha do painel na hora, sem mostrar o que você digita. A instalação leva de 5
a 10 minutos.

## Depois da instalação

1. O instalador termina mostrando o endereço do painel (algo como `https://srv1234567.hstgr.cloud`).
2. Abra o endereço no navegador e entre com o usuário e a senha que você escolheu.
3. Você cai no chat com o Admin, que já deixou a primeira mensagem. Responda e ele cria o seu
   primeiro agente. Para criar outros depois, peça: "cria um agente novo pra mim".

Esqueceu a senha? Peça ao Claude do servidor: "troca a senha do DG Claw".

## Como desfazer

Nada do DG Claw fica fora das pastas e dos serviços listados acima. Para tirar tudo, no servidor:

1. Pare e desligue os serviços:
   `sudo systemctl disable --now dgclaw-web dgclaw-admin dgclaw-imagem dgclaw-firewall`
2. Remova os containers dos agentes: `sudo podman rm -f $(sudo podman ps -a --format '{{.Names}}' | grep '^dgclaw-')`
3. Apague as unidades em `/etc/systemd/system/dgclaw-*.service` e rode `sudo systemctl daemon-reload`.
4. Se quiser perder também os dados dos agentes: apague `/opt/dgclaw`, `/etc/dgclaw`,
   `/var/lib/dgclaw` e `/var/log/dgclaw`. As casas dos agentes ficam em `/var/lib/dgclaw/agentes`, então
   copie de lá o que quiser guardar antes.
5. Os pacotes (Caddy, podman e os outros) e as regras do firewall continuam instalados; remova só se
   nenhum outro programa seu os usa.

## Segurança

- O painel só é acessível por HTTPS e com login. A senha é guardada como hash, nunca em texto.
- Cada agente roda em um container sem root, com a própria casa de arquivos, sem acesso aos outros
  agentes e sem alcançar o servidor.
- O Admin roda como root no servidor. Por isso só você fala com ele, e ele não lê e-mail, não abre
  links de terceiros e não tem canais externos. Os agentes que leem o mundo ficam nos containers.
- Chaves e senhas dos agentes ficam em arquivos com permissão restrita, nunca dentro do registro de
  agentes nem nos registros de funcionamento.

## Modo antigo

A versão anterior do DG Claw (plugin do Claude Code com o assistente `/dgclaw:setup`, em modo local ou
servidor) foi substituída por esta instalação. O caminho atual está em [INSTALL.md](INSTALL.md).

## Licença

MIT, veja [LICENSE](LICENSE).
