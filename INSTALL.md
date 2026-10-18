# Instalar o DG Claw

O resultado é um painel com endereço HTTPS e usuário, aberto na conversa com o Admin. A senha você
cadastra no navegador, pelo link de primeiro acesso que o instalador mostra no fim. A instalação
inicial prepara esse acesso. O primeiro agente, o áudio e os canais são configurados depois, pelo painel.

## Antes de começar

- Uma VPS Ubuntu 24.04 ou 22.04 (o 26.04 também instala, com um aviso de que foi testado menos), com
  acesso root, pelo menos 2 GB de memória e 15 GB livres.
- As portas 80 e 443 disponíveis.
- Claude Code ou Codex instalado e conectado à sua assinatura, no root da VPS. O Admin reutiliza esse
  login, sem copiá-lo aos agentes; a assinatura é necessária para o Admin conversar.
- `--provedor claude` ou `--provedor codex` define o motor do Admin. Sem a opção, o instalador mantém a
  escolha anterior; numa máquina nova, procura primeiro um login (Claude, depois Codex) e só então o
  programa instalado.

## Os três comandos

O repositório é público. Rode no terminal da própria VPS onde o DG Claw vai funcionar:

```sh
git clone https://github.com/DGatoM/DG-Claw
cd DG-Claw
sudo ./install.sh --usuario admin --com-imagem
```

Troque `admin` pelo usuário que você quer para o painel. O instalador não pede senha. No fim ele mostra
o **link do painel**, o **usuário**, um **link de primeiro acesso** e a frase **"Daqui pra frente é
pelo painel"**. A senha nunca aparece no terminal.

Se você prefere pedir ao Claude Code, escreva no terminal da VPS:

> Baixa, analisa e instala o DG Claw: https://github.com/DGatoM/DG-Claw

Com o projeto já aberto, basta **"instala"**. O Claude roda o comando acima sem senha nenhuma e mostra
os dois links no fim. Ele não pergunta a senha no chat nem a passa por stdin.

## O que o instalador faz

O instalador mostra o andamento em português, com explicações e mensagens de conclusão. Os passos:

1. **Analisar as dependências.** Confere Ubuntu, memória, disco, portas e login do motor escolhido. Se
   algo faltar, a mensagem explica como resolver antes de continuar.
2. **Definir o acesso.** Gera o link de primeiro acesso, de uso único e válido por 30 minutos. A senha
   (pelo menos 12 caracteres, separada da sua conta Claude) é cadastrada no navegador. Quem prefere
   definir a senha no terminal pode digitá-la quando o instalador perguntar (só aparece em terminal
   interativo; Enter pula). Para automação existe `--senha-stdin`, que lê a senha pela entrada padrão,
   nunca por argumento.
3. **Instalar as bibliotecas.** Node.js executa o painel; npm instala e compila o programa do Admin;
   Caddy fornece o endereço seguro; Podman prepara a separação dos futuros agentes; o ufw protege as
   portas do servidor. Componentes que já existem são aproveitados. A imagem dos agentes começa a ser
   construída em segundo plano (`--com-imagem`).
4. **Configurar o endereço e a proteção.** Usa o nome da VPS na Hostinger quando ele aponta para ela;
   caso contrário, tenta um endereço sslip.io baseado no IP. Um domínio próprio entra com
   `--dominio painel.exemplo.com`, já apontando para o servidor. O Caddy pede o certificado HTTPS e o
   firewall libera SSH, HTTP e HTTPS.
5. **Ligar o painel e o Admin.** O painel guarda só o hash da senha, e o link de primeiro acesso guarda
   só o hash do código. O Admin é uma sessão normal do Claude Code ou Codex, com poderes de
   administrador para cuidar desta VPS. Nenhuma credencial do root é copiada para os novos agentes.
6. **Testar.** Verifica o HTTPS, o painel e o serviço do Admin, e envia a mensagem de boas-vindas.

A duração depende da rede e dos pacotes já instalados. `--ensaio` mostra as mudanças previstas sem
aplicá-las. Com `--com-imagem`, a imagem dos futuros agentes é construída enquanto você cadastra a senha
e conhece o painel (de 10 a 20 minutos na primeira vez); acompanhe com `dgclaw imagem status`. Sem essa
opção, o Admin faz a preparação quando você cria o primeiro agente, e a espera acontece nessa hora.

## Primeiro acesso

Abra o **link de primeiro acesso** no navegador, cadastre a senha e você já entra no chat do **Admin**.
O link vale 30 minutos e funciona uma única vez. Se expirar, gere outro com `sudo dgclaw primeiro-acesso`
(ou `sudo ./install.sh --novo-primeiro-acesso`; a senha antiga vale até o link ser usado). Para trocar a
senha depois, use `sudo dgclaw senha`. Rodar o instalador de novo numa máquina que já tem senha mantém a
atual, porque só o hash fica guardado.

## Primeiro agente

No card do **Admin**:

1. Toque em **Quero criar meu primeiro agente** e diga o nome dele.
2. Preencha a função e o tom da conversa. Se quiser, suba uma foto ou gere um avatar ilustrado no
   navegador.
3. Toque em **Criar meu agente**. O Admin prepara o agente e a tela acompanha as etapas reais.
4. Quando aparecer **Conectar minha assinatura**, abra o painel do agente e use **Entrar com a
   assinatura**, na aba Status. Volte ao Admin e toque em **Já entrei. Pode testar.**
5. Depois que o agente responder ao teste, a caixa abre e aparece a badge com o nome e a foto dele (ou
   um avatar neutro). Toque nela para começar a conversa.

O botão **Tutorial** e os `?` explicam cada parte. Telegram, outras conexões e áudio podem ser
configurados com o agente quando você precisar. No iPhone com **Reduzir Movimento**, a apresentação é
curta e mantém o cartão de boas-vindas. Se uma etapa falhar, o Admin continua na mesma conversa para
explicar e resolver: não repita a instalação nem crie outro agente para contornar a falha. O contrato
do fluxo e a origem dos estados estão em [web/docs/PRIMEIRO-AGENTE.md](web/docs/PRIMEIRO-AGENTE.md).

## Se algo precisar de atenção

- **Motor sem login no root:** entre no Claude Code ou Codex, conforme a escolha, no root da VPS e
  repita a instalação.
- **Terminal não acha o `claude`:** a pasta `~/.local/bin` não está no PATH. Rode
  `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc` e tente de novo.
- **Porta ocupada:** a mensagem identifica o conflito. Confira o serviço existente antes de pará-lo.
- **HTTPS não abriu:** confira se o domínio aponta para a VPS e se 80/443 estão liberadas no provedor.
- **Criação do agente demorando:** a primeira criação também prepara a imagem dos agentes. O Admin
  acompanha a preparação; o formulário mantém suas escolhas.

## Atualizar

Para atualizar um DG Claw já instalado, peça ao Admin: **"atualiza o DG Claw"**. Ele segue o roteiro
[docs/ATUALIZAR.md](docs/ATUALIZAR.md) e usa `sudo dgclaw atualizar`, que faz um backup datado em
`/var/backups/dgclaw/`, baixa a versão nova, reinstala, recria a máquina de cada agente e confere que
chaves, senha, memória, conversas, cofres e rotinas continuam como estavam. `sudo dgclaw atualizar --simular`
mostra tudo sem mudar nada, e `sudo dgclaw atualizar --voltar <pasta-do-backup>` desfaz.

A [arquitetura](docs/ARQUITETURA.md) descreve os componentes. O [README](README.md) lista os serviços,
as pastas e o procedimento para desfazer a instalação.
