# Instalar o DG Claw

O resultado é um painel com endereço HTTPS e usuário, aberto na conversa com o Admin. A senha você cadastra
no navegador, pelo link de primeiro acesso que o instalador mostra no fim.
A instalação inicial prepara esse acesso. O primeiro agente, áudio e canais são configurados depois,
pelo painel.

## Antes de começar

Uma VPS Ubuntu 24.04 ou 22.04 (o 26.04 também instala, com um aviso de que foi testado menos), com acesso root, 2 GB de memória e 15 GB livres. As portas 80 e 443
precisam estar disponíveis. Claude Code ou Codex deve estar instalado e conectado à sua assinatura
no root da VPS. `--provedor claude` ou `--provedor codex` define o motor do Admin. Sem opção,
o instalador mantém a escolha anterior; em uma máquina nova, procura primeiro um login (Claude,
depois Codex) e só então o programa instalado. O Admin reutiliza o acesso do motor escolhido no root, sem copiá-lo aos agentes.

No terminal do Claude Code, você pode pedir:

> Baixa, analisa e instala o DG Claw: https://github.com/DGatoM/DG-Claw

Com o projeto já aberto, o pedido pode ser apenas **“instala”**. Este documento contém o procedimento
completo. O Claude roda `sudo ./install.sh --usuario <nome> --com-imagem` sem senha nenhuma, e a pessoa cadastra a
senha no navegador. O Claude não pede a senha no chat nem a passa por stdin.

## Etapas da instalação

Esta lista permite acompanhar o trabalho e marcar cada etapa concluída. O instalador também mostra
o andamento em português, com explicações e mensagens de conclusão.

1. **Analisar as dependências.** Conferência do Ubuntu, memória, disco, portas e login do motor escolhido.
   Se algo faltar, a mensagem explica como resolver antes de continuar.
2. **Baixar o programa.** Na primeira instalação: `git clone https://github.com/DGatoM/DG-Claw`
   e `cd DG-Claw`. Quem recebeu o pacote compactado pode abrir a pasta extraída.
3. **Definir o acesso.** Escolha um usuário para o painel. O comando é
   `sudo ./install.sh --usuario <seu-usuario> --com-imagem`, sem senha. O instalador gera um link de primeiro
   acesso, de uso único e válido por 30 minutos, onde você cadastra a senha no navegador (pelo menos
   12 caracteres, separada da conta Claude). Quem prefere definir a senha no terminal pode digitá-la
   quando o instalador perguntar (só aparece se o terminal for interativo; Enter pula). Para
   automação existe `--senha-stdin`, que lê a senha pela entrada padrão, nunca por argumento.
   Repetir o instalador em uma máquina que já tem senha mantém a atual. `--novo-primeiro-acesso`
   força um link novo.
4. **Instalar as bibliotecas.** Node.js executa o painel; npm instala e compila o programa do Admin;
   Caddy fornece o endereço seguro. Podman prepara a separação dos futuros agentes e ufw protege
   as portas do servidor. A instalação aproveita os componentes que já estão disponíveis.
   Áudio e navegador ficam para depois. A imagem dos agentes começa a ser construída em segundo plano (`--com-imagem`).
5. **Configurar o endereço e a proteção.** O nome da VPS na Hostinger é usado quando aponta para
   ela. Caso contrário, o instalador tenta um endereço sslip.io baseado no IP. Um domínio próprio
   pode ser informado com `--dominio painel.exemplo.com`, já apontando para o servidor.
   O Caddy solicita o certificado HTTPS e o firewall libera SSH, HTTP e HTTPS.
6. **Ligar o painel e o Admin.** O painel guarda somente o hash da senha, e o link de primeiro acesso guarda só o hash do código. O Admin é uma sessão
   normal do Claude Code ou Codex, com poderes de administrador para cuidar desta VPS. Ele reutiliza a
   autenticação que já existe no root. Nenhuma credencial do root é copiada para os novos agentes.
7. **Testar o runtime.** O instalador verifica o HTTPS, o painel e o serviço que executa o Admin,
   e envia a mensagem de boas-vindas. O acesso aparece ao final com endereço, usuário e link de primeiro acesso. A senha nunca é mostrada.
   O primeiro agente terá um teste próprio: a apresentação só termina quando ele responder.

A duração depende da rede e dos pacotes já instalados. `--ensaio` mostra as mudanças previstas sem
aplicá-las. O comando padrão leva `--com-imagem`, que começa a construir a imagem dos futuros agentes em segundo
plano enquanto você cadastra a senha e conhece o painel (leva de 10 a 20 minutos na primeira vez).
Acompanhe com `dgclaw imagem status`. Sem essa opção, o Admin faz essa preparação quando você cria o
primeiro agente, e a espera acontece nessa hora.

## Abrir o painel

O final mostra **“Seu DG Claw está instalado e configurado em … Clique aqui para acessar”**,
seguido do usuário e do link de primeiro acesso. Abra esse link no navegador, cadastre a senha e você já
entra no chat do Admin. O link vale 30 minutos e só funciona uma vez; se expirar, gere outro com
`sudo dgclaw primeiro-acesso`. Para trocar a senha depois, use `sudo dgclaw senha`.
Daqui pra frente é pelo painel.

No Admin, toque em **Quero criar meu primeiro agente**. O Admin pergunta o nome e o formulário
reúne função, tom e foto opcional. Você pode subir uma foto ou gerar um avatar ilustrado no navegador.
Depois, o Admin prepara o agente, orienta a conexão da sua assinatura e testa uma resposta real.
A caixa abre, apresenta seu agente e leva à conversa dele.

O botão **Tutorial** explica cada etapa. Telegram, outras conexões e áudio podem ser configurados
com o agente quando você precisar. O acesso à assinatura de cada agente é feito no painel dele.

## Se algo precisar de atenção

- **Motor sem login no root:** entre no Claude Code ou Codex, conforme a escolha, no root da VPS
  e repita a instalação.
- **Terminal não acha o `claude`:** a pasta `~/.local/bin` não está no PATH. Rode
  `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc` e tente de novo.
- **Porta ocupada:** a mensagem identifica o conflito. Confira o serviço existente antes de pará-lo.
- **HTTPS não abriu:** confira se o domínio aponta para a VPS e se 80/443 estão liberadas no provedor.
- **Criação demorando:** a primeira criação também prepara a imagem dos agentes. O Admin acompanha
  a preparação; o formulário mantém suas escolhas.

A [arquitetura](docs/ARQUITETURA.md) descreve os componentes. O [README](README.md) lista os serviços,
as pastas e o procedimento para desfazer a instalação.
