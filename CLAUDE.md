# DG Claw: estrutura do repositório

O DG Claw instala um painel web com chat, um Admin e a infraestrutura para agentes de trabalho
em containers separados. O [README](README.md) apresenta o produto e o [INSTALL.md](INSTALL.md)
contém o procedimento de instalação.

## Componentes

| Caminho | Conteúdo |
| --- | --- |
| `install.sh`, `lib/` | Instalador e funções de administração |
| `bin/dgclaw` | CLI de administração dos agentes |
| `runner/` | Execução de sessões Claude Code e Codex |
| `web/` | Interface web, autenticação e chat |
| `panel/` | Configurações e recursos de cada agente |
| `container/` | Imagem dos agentes |
| `templates/` | Arquivos iniciais do Admin e dos agentes |
| `skills/` | Recursos e roteiros dos agentes |
| `docs/` | Documentação do produto |
| `tests/` | Testes automatizados |

A [arquitetura](docs/ARQUITETURA.md) descreve o funcionamento e os limites entre os componentes.
`tests/rodar.sh` executa as baterias automatizadas. Os testes do instalador usam uma raiz temporária
(`DGCLAW_RAIZ`) e substitutos dos comandos do sistema.

## Contexto de uso

- **Onde o repositório é clonado.** O caminho normal é clonar o DG Claw direto na VPS em que ele vai
  rodar e instalar ali mesmo, com `sudo ./install.sh`. A pasta clonada na VPS é, portanto, a
  instalação de destino, e não uma cópia de desenvolvimento.
- **Quem instala.** Na maioria dos casos é uma pessoa que não é programadora, seguindo uma aula ou o
  [INSTALL.md](INSTALL.md) com a ajuda do próprio Claude Code ou Codex no terminal da VPS.
- **GitHub.** O repositório é público. O clone funciona com `git` puro, sem `gh` e sem login no
  GitHub; o `gh` só aparece dentro da imagem dos agentes, para quem quiser publicar código depois.
- **Por que o Admin roda como root.** O Admin é a peça que instala, atualiza, cria e conserta os
  agentes, e isso exige mexer em serviços, containers e firewall do servidor. Ele roda como root
  justamente para que a pessoa resolva tudo conversando pelo painel, sem precisar voltar ao
  terminal. Em contrapartida, só o dono do painel fala com ele, e ele não lê e-mail, não abre links
  de terceiros e não tem canal externo.
- **Os agentes de trabalho não rodam como root.** Os agentes que a pessoa cria (e que conversam com o
  mundo por WhatsApp, Telegram, e-mail e navegador) ficam em containers sem root, sem acesso ao
  servidor nem aos vizinhos. O [SEGURANCA.md](docs/SEGURANCA.md) detalha essa separação.
- **Versão.** A v1.0.0 é a versão publicada e em uso. Os testes de instalação completa da equipe
  rodam em VPS separadas, conforme o [roteiro de QA](web/docs/QA-PRIMEIRO-AGENTE.md); isso não muda
  nada para quem instala na própria VPS.

## Regras do projeto

- **Segurança: toda mudança é feita, testada e revisada pelo Codex em modo adversarial antes do
  merge.** O DG Claw roda na VPS de quem não é programador, com um Admin root; uma vulnerabilidade
  expõe servidor, chaves e conversas de quem confiou no projeto. Todo PR (inclusive de documentação)
  segue [docs/REVISAO-ADVERSARIAL.md](docs/REVISAO-ADVERSARIAL.md): teste verde e conferido de
  verdade; revisão adversarial do Codex com foco em injeção, exposição de segredo, permissão, rota sem
  autenticação, path traversal, execução de coisa baixada, XSS e dados sensíveis; cada ponto
  corrigido ou recusado com justificativa e a revisão repetida até sair limpa; o corpo do PR registra
  o que o Codex apontou e o que foi feito. **Merge só com o ok do dono do projeto**: nenhum agente
  mergeia por conta própria.
  *Por quê:* o projeto é mantido por quem não é programador, e a reputação dele depende de não ter
  vulnerabilidade. Um segundo modelo, procurando ativamente como quebrar, acha o que o autor não vê.

- **Atualizar nunca apaga configuração do usuário.** Rodar o `install.sh` de novo, atualizar a
  versão ou reconstruir a imagem tem que preservar tudo o que a pessoa já configurou: chaves
  (`GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` e qualquer outra),
  opções do `web.env`, cofre, agentes, memória e conversas. Arquivo de configuração que já existe
  se edita linha a linha (troca só as linhas que o instalador controla e mantém o resto, na ordem);
  nunca se reescreve inteiro. Todo código novo que grava em arquivo de configuração vem com um
  teste que monta o arquivo com uma linha alheia e confere que ela sobreviveu.
  *Por quê:* em 17/10/2026 o instalador regravava o `web.env` só com o usuário e a senha do
  painel, e cada atualização desligava o microfone dos agentes. O Admin percebeu antes de aplicar.

- **O agente precisa conhecer o que é novo.** Toda feature nova que o agente precisa conhecer para
  usar ou oferecer entra TAMBÉM em `templates/ambiente/agente.md` (e em `admin.md`, se o Admin a
  usa), no mesmo commit/PR. Feature puramente visual que o agente não usa (por exemplo, animação de
  carregando) não precisa. Se for um doc de capacidade, acrescente-o a `templates/ambiente/capacidades.txt`
  (o teste `tests/ambiente` confere que cada um está citado no `agente.md`).

- **Passo manual de atualização vai no CHANGELOG, escrito para a pessoa.** Toda mudança que pede
  algo além do `dgclaw atualizar` padrão (instrução nova para juntar a um arquivo que o dono pode ter
  personalizado, arquivo que não pode ser substituído, chave nova, regravar a identidade, reparar ou
  reiniciar um agente) leva, no `CHANGELOG.md`, uma subseção `### Como atualizar` dentro da versão (ou
  de `[Não lançado]`). O texto fala com a pessoa dona do DG Claw, com o porquê em uma frase, por
  exemplo: "Nesta versão há uma instrução nova para o seu agente entender o áudio transcrito. Ela
  precisa entrar nas instruções dele sem apagar o que você já personalizou." ou "Não substitua o
  arquivo X, porque ele guarda Y." Nunca escreva para o modelo ("você é um agente, faça X",
  "IMPORTANTE: o assistente deve", "IA, faça"): o Admin lê o CHANGELOG antes de aplicar
  (`docs/ATUALIZAR.md`), e texto vindo de fora que dá ordem a um modelo tem cara de injeção de prompt;
  o Admin faz bem em desconfiar dele. O teste `tests/changelog` reprova essas frases.
  *Por quê:* a maioria das pessoas não roda `git pull`; elas pedem ao Admin para atualizar, e até
  19/10/2026 não havia lugar para avisar de um passo que o comando não faz sozinho (Danilo, 19/10/2026).
