# Instalar o DG Claw

Este é o passo a passo da instalação. Foi escrito para a pessoa que vai instalar, e o Claude Code ou o
Codex dela pode ler o mesmo texto e acompanhar. Cada mudança no servidor é explicada antes de acontecer.

**Objetivo.** Ter o DG Claw funcionando num servidor Ubuntu seu: painel no navegador, com login, e o
Admin pronto para conversar.

**Pronto quando.** O instalador termina mostrando o endereço do painel e o comando `dgclaw status`
mostra tudo ok.

## Antes de começar

- Servidor Ubuntu 22.04 ou 24.04, com 2 GB de RAM e 15 GB livres, e acesso de administrador.
- Claude Code ou Codex instalado e logado no próprio servidor.
- Portas 80 e 443 livres. O README lista tudo o que a instalação muda na máquina.

Para ver antes o que será feito, sem mudar nada: `sudo ./install.sh --ensaio --usuario <nome>`.

## Passo 1: baixar o projeto

Se a pasta ainda não existe:

```
git clone https://github.com/DGatoM/DG-Claw
cd DG-Claw
```

## Passo 2: ler o README e conferir os requisitos

O README explica o que é o DG Claw, o que ele instala e como desfazer. Vale conferir a memória e o
disco: `free -h` e `df -h /`. O instalador também confere sozinho e para com uma explicação se algo
faltar.

## Passo 3: escolher o usuário e a senha do painel

Você precisa de um **usuário** (por exemplo, o seu nome) e de uma **senha de pelo menos 12
caracteres**. O assistente pergunta os dois a você. A senha só serve para entrar no painel do DG Claw.

A senha vai para o instalador pela entrada padrão, assim ela não aparece na lista de processos do
servidor nem no histórico de comandos:

```
printf '%s\n' "$SENHA" | sudo ./install.sh --usuario <nome>
```

Se preferir, rode o comando você mesmo, sem a parte do `printf`:
`sudo ./install.sh --usuario <nome>`. O instalador pede a senha na hora e não mostra o que você digita.

## Passo 4: rodar o instalador e acompanhar

A instalação leva de 5 a 10 minutos e mostra cada etapa em português:

1. Confere a máquina (sistema, memória, disco, portas).
2. Instala os pacotes: podman, Caddy, Node 22, git, jq e ufw.
3. Escolhe o endereço: o nome do servidor na Hostinger (`hstgr.cloud`) se ele aponta para a máquina,
   senão um endereço `sslip.io` baseado no IP. Para usar domínio próprio, acrescente `--dominio <nome>`.
4. Configura o Caddy para servir o painel por HTTPS.
5. Liga o firewall com as portas 22, 80 e 443.
6. Sobe o painel (DG Claw Web) como serviço, com sua senha guardada em hash.
7. Sobe o Admin, que usa o mesmo login do Claude Code ou do Codex que você já tem no servidor.
8. Começa a construir, em segundo plano, a imagem usada pelos agentes.
9. Roda um teste de isolamento e um teste de ponta a ponta, e mostra o endereço.

Rodar o instalador de novo é seguro: ele confere o que já existe e não apaga nada.

## Passo 5: abrir o endereço

Abra o endereço mostrado no final, entre com o usuário e a senha, e converse com o Admin. Ele cria o
seu primeiro agente. Para conferir pelo terminal: `dgclaw status`.

## Problemas comuns

- **Porta 80 ou 443 ocupada.** Outro programa (Apache, Nginx) usa a porta. O instalador diz qual. Pare
  esse programa ou instale em outro servidor, porque o painel precisa das duas portas.
- **Pouca memória.** Com menos de 2 GB o instalador para com um aviso. Aumentar o plano do servidor
  resolve.
- **Domínio que não resolve.** Se você passou `--dominio`, o nome precisa apontar para o IP do
  servidor antes da instalação; o certificado HTTPS depende disso. Sem `--dominio`, o instalador usa
  um endereço que já funciona.
- **Claude Code sem login.** O Admin precisa do mesmo login que você usa no servidor. Rode `claude`,
  entre na sua conta e depois rode o instalador de novo.
- **A imagem dos agentes ainda não terminou.** Ela leva alguns minutos. `dgclaw imagem status` mostra
  como está, e o Admin espera por ela antes de criar o primeiro agente.

## Como desfazer

A lista de serviços a parar e de pastas a remover está na seção "Como desfazer" do README.
