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

- Um servidor (VPS) com **Ubuntu 24.04** (o 22.04 também serve; o 26.04 instala com um aviso,
  porque foi testado menos), acesso de administrador (root ou sudo), no mínimo
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
- **Serviços** no systemd: `dgclaw-web` (o painel), `dgclaw-admin` (o Admin), `dgclaw-imagem` (disponível para construir
  a imagem na primeira criação) e `dgclaw-firewall`.
- **Pastas**: `/opt/dgclaw` (programa e casa do Admin), `/etc/dgclaw` (configuração, registro dos
  agentes e segredos, com permissão restrita), `/var/lib/dgclaw` (dados e casa de cada agente) e
  `/var/log/dgclaw` (registros).
- O comando `dgclaw` em `/usr/local/bin`.

O instalador mostra cada etapa em português e pode ser executado de novo sem estragar nada. Com
`--ensaio`, ele só lista o que faria, sem mudar a máquina.

## Instalação

O procedimento de instalação está em [INSTALAR.md](INSTALAR.md). No Claude Code da VPS, você pode escrever:

> Baixa, analisa e instala o DG Claw: https://github.com/DGatoM/DG-Claw

Se a pasta do projeto já estiver aberta, basta pedir **“instala”**. Você escolhe o usuário
do painel e acompanha as etapas da instalação.

Para instalar manualmente, são três comandos:

```sh
git clone https://github.com/DGatoM/DG-Claw
cd DG-Claw
sudo ./install.sh --usuario admin --com-imagem
```

O instalador não pede senha. Ao terminar, mostra o link do painel, o usuário e um link de primeiro
acesso (uso único, vale 30 minutos), onde você cadastra a senha no navegador e já entra no chat do Admin.
A senha nunca aparece no terminal. `sudo dgclaw primeiro-acesso` gera um link novo e `sudo dgclaw senha`
troca a senha. O Admin usa o motor escolhido na instalação, Claude Code ou Codex, e reaproveita o login
correspondente que já existe no root desta VPS. A opção `--provedor claude` ou `--provedor codex`
define a escolha; sem opção, a configuração anterior é preservada e, em instalação nova,
o instalador procura primeiro um login (Claude, depois Codex) e só então o programa instalado.

## Seu primeiro agente

Abra o painel e toque em **Quero criar meu primeiro agente**. Escolha nome, função, tom e uma foto
opcional. O Admin prepara o agente e orienta a conexão da sua assinatura. Depois de uma resposta
real de teste, a caixa abre e revela o cartão do agente. Toque nele para conversar.

A instalação inicial prepara o painel e o Admin. A imagem dos agentes é construída na primeira
criação. Áudio, Telegram e outras conexões podem ser configurados depois, pelo painel.

O botão **Tutorial** explica cada parte. A apresentação também funciona no celular e com
**Reduzir Movimento** ativado. A arquitetura completa está em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

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
servidor) foi substituída por esta instalação. O caminho atual está em [INSTALAR.md](INSTALAR.md).

## Licença

MIT, veja [LICENSE](LICENSE).
