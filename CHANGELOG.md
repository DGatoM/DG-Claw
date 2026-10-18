# Changelog

Todas as mudanças importantes do DG Claw ficam neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- `dgclaw atualizar`: atualiza o DG Claw sem perder nada do dono. Faz backup datado em
  `/var/backups/dgclaw/`, baixa a versão nova (`git pull --ff-only`), roda o instalador, reconstrói a
  imagem, recria o container de cada agente (`dgclaw agente recriar`) mantendo casa, cofre e rotinas,
  confere que nenhuma linha de configuração, chave, token ou arquivo de identidade sumiu ou mudou e agenda
  o reinício do Admin por último. `--simular` mostra o que faria e `--voltar <backup>` desfaz. Roteiro do
  Admin em `docs/ATUALIZAR.md`. O instalador agora anota `DGCLAW_REPO` e `DGCLAW_COMMIT` no `dgclaw.env`,
  edita esse arquivo linha a linha e não sobrescreve mais um `CLAUDE.md` ou `AGENTS.md` do Admin que foi
  personalizado (grava o modelo novo ao lado, como `.novo`).
- Modo escondido (botão 👁 no cabeçalho da conversa): troca por asteriscos nomes, empresas, valores,
  e-mails, telefones, documentos e chaves de todas as mensagens da tela, para o dono mostrar a conversa numa
  aula sem expor cliente. Um filtro automático age na hora e um modelo (Claude Haiku com `ANTHROPIC_API_KEY`, ou
  `gpt-4.1-mini` com `OPENAI_API_KEY`) aponta o resto pela rota `POST /api/v1/sigilo`. Mensagem ainda não
  analisada aparece como "escondendo…", nunca crua. Guia em `docs/MODO-ESCONDIDO.md`.
- A aba Sessões do painel agora funciona sozinha em cada agente (modo local): cada card é uma sessão
  paralela do runner do próprio agente. Dá para ver o que cada uma faz, ler a conversa, aprovar ou negar
  pedidos de permissão (só com login; chave de API não decide), mandar recado, anexar arquivo, arquivar,
  apagar, retomar na mesma conversa ou numa conversa nova, renomear, dar estrela e fazer handoff. Os cards
  que o agente abre com o `dgclaw-card` aparecem ali também, e tudo tem rota de API com chave. Sem
  `DGCLAW_PANEL_SESSOES_URL` o painel usa o modo local; com ela, continua usando o DG Telegram.
- O limite de cards abertos ao mesmo tempo sobe de 3 para 8 nas instalações novas
  (`RUNNER_MAX_SESSOES_EXTRAS` na unidade do runner).
- Modo foco (backend): lista curta por agente que o agente monta e o dono tica na tela. Rotas
  `/api/v1/foco/<agente>` (lista, itens, eventos com cursor e `docs.md`), evento `foco` no stream da
  conversa, gancho `foco-hook` (`promptHooks` do `runner.json`) que avisa o agente dos tiques do dono no
  começo do turno, e a skill `foco`. Contrato em `web/docs/MODO-FOCO.md`.

## [1.0.0] - 2026-10-17

A v1 troca o plugin do Claude Code por uma plataforma completa: um instalador, um painel web com
chat e agentes que rodam isolados em containers.

### Adicionado

- Primeiro acesso por link: o instalador não pede mais senha. No fim mostra o link do painel e um link
  de primeiro acesso, de uso único e válido por 30 minutos, onde a pessoa cadastra a senha no navegador
  e já entra no chat do Admin. A senha nunca aparece no terminal. `--senha-stdin` e a pergunta
  interativa continuam funcionando, `sudo dgclaw primeiro-acesso` gera um link novo e
  `sudo dgclaw senha` troca a senha.
- Instalador `install.sh`, que mostra cada etapa em português, pode ser executado de novo sem
  estragar nada e tem o modo `--ensaio`, que lista o que faria sem mudar a máquina.
- Endereço HTTPS automático pelo Caddy: o nome do servidor na Hostinger (`hstgr.cloud`) quando ele
  aponta para a máquina, ou um endereço `sslip.io` baseado no IP. Domínio próprio entra com
  `--dominio`.
- O Admin, um agente de sistema que cuida da máquina e cria os outros agentes por conversa.
- Agentes de trabalho em containers com podman, cada um com a própria casa de arquivos, o próprio
  cofre e sem acesso aos vizinhos nem ao servidor. A imagem traz Claude Code, Codex, Node 22, Bun,
  ffmpeg e Python.
- Comando `dgclaw` (`agente criar|listar|parar|iniciar|reiniciar|reparar|remover`, `imagem`,
  `senha`, `status`). O `remover` move a casa do agente para uma pasta de aposentados, sem apagar.
- DG Claw Web: painel com login, chat com os agentes e seletor de agentes.
- Runner próprio, que mantém a sessão do agente viva, agora dentro deste repositório e com
  autenticação por Bearer (`RUNNER_TOKEN_FILE`) nas chamadas HTTP e no WebSocket.
- Chaves de API do painel, guardadas só como hash, para operar o painel sem tela.
- Cofre de chaves por agente, também operável por API, com reinício do agente quando o cofre pede.
- Codex como provedor, ao lado do Claude, com catálogo de provedores e o cartão "Modelo e
  autenticação" no Status, com login assistido.
- Skills `criar-agente` (para o Admin) e `canais` (ligar o Telegram pelo chat).
- `scripts/teste-isolamento.sh`, que prova que o container do agente não alcança o host nem redes
  privadas.
- `docs/SEGURANCA.md`, com o modelo de ameaça, e `docs/RISCO-DE-BLOQUEIO-DE-CONTA.md`.

### Alterado

- O login do painel usa hash scrypt, sessão que vence, limite de tentativas e proteção contra CSRF.
- O token do Telegram não passa mais pelos argumentos do `curl`; vai pela entrada padrão.
- O Gmail do agente nasce só com leitura e rascunho; o envio é liberado a pedido do dono, com aviso.
- Compartilhar arquivos nasce sem comando de publicar; sem configuração, o erro diz o que configurar.
- O README e o INSTALL.md passam a descrever a instalação em servidor com o instalador.

### Segurança

- Só o Caddy fica aberto para a internet (portas 80 e 443); painel, runner e serviços internos
  escutam em `127.0.0.1`.
- Os containers dos agentes não alcançam o servidor.

## [0.2.1] - 2026-08-04

Última versão do DG Claw como plugin do Claude Code, com o assistente `/dgclaw:setup`, em modo
local (no computador da pessoa) ou servidor (numa VPS Linux). A v1 substitui esse formato pelo
instalador, e o plugin não faz parte desta publicação.

[1.0.0]: https://github.com/DGatoM/DG-Claw/releases/tag/v1.0.0
