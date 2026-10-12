# Risco de bloqueio de conta: o DG Claw pode fazer a Anthropic ou a OpenAI bloquear a sua conta?

Pesquisa feita em 12/10/2026, com as fontes oficiais lidas nessa data. Termos de uso mudam:
releia as duas páginas da seção "Fontes" antes de mudar o jeito como o DG Claw autentica.

## A resposta curta

Do jeito que o DG Claw roda, **não há regra da Anthropic nem da OpenAI que proíba**, e não
encontramos nenhum relato confiável de conta bloqueada por isso. O DG Claw usa o programa oficial
(Claude Code ou Codex), sem modificação, logado na conta da própria pessoa, numa máquina dela. O
que ele faz é digitar no terminal desse programa, como a pessoa digitaria.

As contas bloqueadas que viraram notícia em 2026 caíram por outra coisa: ferramentas que
**tiravam o login da assinatura de dentro do Claude Code** e o usavam num programa delas
(OpenCode, OpenClaw, Cline, Roo). O DG Claw nunca faz isso.

O risco que sobra é de **volume**, não de regra: muitas sessões em paralelo, 24 horas por dia,
batem no limite do plano mais cedo e se afastam do "uso comum, individual" que a Anthropic diz
que os limites pressupõem.

## O que a regra diz, com as palavras dela

**Anthropic, página "Legal and compliance" do Claude Code** (fonte 1):

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
> and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
> other native Anthropic applications."

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, or Max plan credentials on behalf of
> their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials
> or session tokens."

> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their
> own Claude subscription, including where a platform hosts Claude Code."

> "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code
> and the Agent SDK."

E, para quem oferece o Claude Code dentro de um produto: o binário não pode ser modificado, e
"Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each
end user must authenticate with their own Anthropic API key, Claude subscription plan
credentials..."

**OpenAI, página de autenticação do Codex** (fonte 2):

> "API keys are still the recommended default for automation."

> "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs."

> "treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it, paste
> it into tickets, or share it in chat."

A OpenAI **recomenda** chave de API para automação, mas não proíbe o login do ChatGPT no Codex
rodando sem tela: a mesma página ensina a fazer login numa máquina remota.

## Permitido, zona cinza e proibido

| Situação | Onde fica | Por quê |
| --- | --- | --- |
| Rodar o Claude Code ou o Codex oficial, sem modificação, logado na **sua** conta, na **sua** VPS | Permitido | Fonte 1, última citação: a regra diz com todas as letras que isso não está restrito, mesmo quando uma plataforma hospeda o Claude Code |
| Painel, Telegram ou WhatsApp digitando no terminal desse programa (tmux, PTY) | Permitido na prática | Nenhuma fonte oficial fala de tmux ou de injeção de texto. O programa recebe o texto como se fosse a pessoa digitando, e quem paga e responde pelo uso é a própria pessoa |
| Usar chave de API em vez de assinatura | Permitido, e é o caminho recomendado para automação | Fontes 1 e 2 |
| Várias sessões em paralelo, 24 horas por dia, na mesma assinatura | Zona cinza | Os limites dos planos "pressupõem uso comum, individual". Não é violação escrita, mas bate no limite semanal e foi o perfil que a Anthropic citou ao criar esses limites (julho de 2025) |
| Rodar com o login do ChatGPT em automação contínua no Codex | Zona cinza | A OpenAI recomenda chave de API para isso e não proíbe. Há relatos de contas do ChatGPT bloqueadas sem motivo declarado, nenhum ligado com prova ao Codex |
| Copiar o arquivo de login (`.credentials.json`, `auth.json`) de uma máquina ou de um agente para outro | Evitar | A Anthropic proíbe guardar ou intermediar credencial de assinatura em produto de terceiro. A OpenAI aceita copiar para a sua própria máquina remota, mas pede tratar como senha |
| Um agente que atende **outra pessoa** (cliente) rodando na **sua** assinatura | Proibido | "Each end user must authenticate with their own" credencial. Atender cliente com a sua assinatura é intermediar uso em nome dele |
| Tirar o login da assinatura de dentro do Claude Code e usar em outro programa | Proibido | Foi o que bloqueou OpenCode, OpenClaw, Cline e Roo em 2026 |
| Compartilhar a mesma conta entre pessoas, ou revender acesso | Proibido | Termos de consumidor da Anthropic: não compartilhar login nem credencial |
| Modificar o binário do Claude Code | Proibido | Fonte 1 |

## O que o DG Claw faz para ficar do lado seguro

Estas regras valem para o código e para a documentação do DG Claw. Quem mudar alguma delas
precisa reler as fontes antes.

1. **Roda sempre o programa oficial, sem modificação.** Nada de remendo no binário, nada de
   cliente próprio falando direto com a API usando o login da assinatura.
2. **O login acontece pelo fluxo da própria Anthropic ou da OpenAI**, com a pessoa na frente
   (o `/login` do Claude Code, o `codex login`). O DG Claw nunca lê, copia, guarda ou transporta o
   arquivo de login de um agente para outro, nem para o cofre.
3. **Cada pessoa usa a própria conta.** O aluno instala o DG Claw na VPS dele e faz login na
   assinatura dele. O DG Claw não oferece "use a minha conta" para terceiros.
4. **Agente que atende outra pessoa usa a credencial dessa pessoa**: a assinatura dela ou uma
   chave de API dela, guardada no cofre do agente. Isso já é regra do cofre (a chave é do dono do
   agente, e a fatura é dele).
5. **Para trabalho contínuo e pesado, a recomendação é chave de API.** O seletor de modelo do
   painel deixa trocar "na assinatura" por "na API" sem reinstalar nada.
6. **Poucas sessões simultâneas na assinatura.** O padrão do DG Claw é um agente principal e as
   sessões extras sob demanda. Quem quiser dez sessões trabalhando o dia inteiro deve usar chave de
   API nessas sessões.

### Período de teste com cliente: risco aceito, com data para acabar

Quem instala um agente para um cliente costuma testar antes de o cliente contratar, e o caminho
mais curto é rodar o teste na própria assinatura. Pela regra 4 isso já é o caso proibido da tabela
("agente que atende outra pessoa na sua assinatura"). Se você decidir aceitar esse risco, faça
assim:

- **Só durante o teste**, com data combinada para acabar.
- **No dia em que o cliente fechar**, o agente passa para a credencial dele: a assinatura do
  próprio cliente (com o `/login` feito por ele no container do agente) ou uma chave de API dele no
  cofre. O seletor de modelo do painel faz a troca sem reinstalar.
- **Volume baixo enquanto durar**: uma sessão por agente, sem sessões extras trabalhando o dia
  inteiro.

O risco é seu e é temporário. Não serve como modelo de operação permanente.

## Como o DG Claw digita no terminal, e por que isso não é o problema

O DG Claw mantém o Claude Code (ou o Codex) aberto num terminal e escreve nele o que chega pelo
chat, pelo Telegram ou pelo WhatsApp. Para o programa, é idêntico a alguém digitando. Não há
chamada à API por fora, não há login reaproveitado, não há mudança no programa. A própria
Anthropic documenta o modo programático (`claude -p`) e o Agent SDK, o que mostra que usar o
Claude Code de forma automatizada, com a conta de quem usa, faz parte do produto.

O que a Anthropic reprime é o caminho inverso: outro programa se passando pelo Claude Code com o
login da assinatura.

## Fontes

1. Anthropic, Claude Code, "Legal and compliance".
   https://code.claude.com/docs/en/legal-and-compliance (lida em 12/10/2026, citações conferidas)
2. OpenAI, Codex, autenticação. https://developers.openai.com/codex/auth, que redireciona para
   https://learn.chatgpt.com/docs/auth (lida em 12/10/2026, citações conferidas)
3. Anthropic, Consumer Terms of Service. https://www.anthropic.com/legal/consumer-terms
   (proibição de compartilhar login e credencial; uso automatizado só com chave de API "or where we
   otherwise explicitly permit it")
4. Anthropic, Claude Code, modo programático. https://code.claude.com/docs/en/headless
5. Limites semanais do Claude Code, julho de 2025 (motivo citado: uso contínuo em segundo plano e
   compartilhamento ou revenda de conta).
   https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/
6. Bloqueio de ferramentas de terceiros que usavam o login da assinatura (2026, imprensa):
   https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now
   e https://www.aol.com/news/anthropic-says-claude-subscriptions-no-022529261.html
7. OpenAI, Codex em modo não interativo. https://learn.chatgpt.com/docs/non-interactive-mode
8. Relatos de contas do ChatGPT bloqueadas sem motivo declarado (fórum da OpenAI), sem ligação
   comprovada com o Codex:
   https://community.openai.com/t/codex-chatgpt-pro-account-banned-with-no-warning-no-explanation-18-month-subscriber/1381906

## O que não deu para confirmar

- O texto integral da política de uso da OpenAI (o site recusou a leitura automática em
  12/10/2026). A página do Codex, que é a que importa aqui, foi lida.
- Qualquer posição oficial sobre sessões paralelas na mesma assinatura. O que existe é a frase do
  "uso comum, individual" e o limite semanal.
- Relato confiável de conta bloqueada por automação **dentro** do Claude Code oficial com a conta
  do próprio dono. Procuramos em fóruns, no GitHub do Claude Code e na imprensa e não achamos.
