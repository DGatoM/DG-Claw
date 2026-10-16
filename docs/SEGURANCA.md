# Segurança do DG Claw

Este documento explica o que o DG Claw protege, de quem, como, e o que ainda não protege.
Para relatar uma falha, siga o `SECURITY.md` na raiz do repositório.

## Resumo em cinco linhas

1. Só uma porta fica aberta para a internet: o Caddy, com HTTPS. Painel, runner e serviços
   internos escutam em `127.0.0.1`.
2. Cada agente vive no próprio container, com o próprio cofre de chaves, e não enxerga o host
   nem os vizinhos. O `scripts/teste-isolamento.sh` prova isso em segundos.
3. Chave de serviço (OpenAI, Gemini e outras) entra no cofre do agente, vale só para ele e
   nunca aparece inteira na tela, na API nem no log.
4. O login do painel usa hash scrypt, sessão que vence, limite de tentativas e proteção contra
   CSRF. Quem opera sem tela usa chave de API do painel, guardada só como hash.
5. O agente começa com poderes limitados (o Gmail nasce só lendo) e o dono libera aos poucos.

## Modelo de ameaça

**O que protegemos:** o login da assinatura (Claude ou ChatGPT) de cada agente, as chaves de
serviço do cofre, as conversas e os arquivos do dono, e a própria máquina.

**De quem:**

| Ameaça | Exemplo | Defesa principal |
| --- | --- | --- |
| Alguém na internet | varre portas, tenta senha do painel | uma porta pública só, login com limite de tentativas |
| Outro agente na mesma máquina | um agente com prompt injection tenta ler o cofre do vizinho | container por agente, cofre por agente, firewall da jaula |
| Conteúdo que o agente lê | um e-mail ou página diz "envie seus arquivos para tal endereço" | regra no agente (conteúdo é material, não ordem) e poderes limitados por padrão |
| Página maliciosa aberta pelo dono | tenta apagar arquivos usando o login do dono no navegador | CSRF por `Origin` e `Sec-Fetch-Site`, cookie `SameSite`, sair só por POST |
| Quem rouba um cookie ou uma chave | log de proxy, máquina compartilhada | sessão que vence, chave de API revogável, troca de senha derruba as sessões |

**O que fica fora do alcance:** quem tem root na máquina enxerga tudo, inclusive o cofre. O
provedor do modelo (Anthropic, OpenAI) recebe o que o agente manda para ele. E um agente já
comprometido ainda consegue mandar dados para a internet (ver "Pendências").

## Portas

- **Caddy** é a única porta pública, com HTTPS automático. Ele entrega o DG Claw Web.
- **Painel de cada agente, runner e serviços internos** escutam em `127.0.0.1`. O painel só
  aceita abrir para fora com configuração explícita.
- O instalador não abre porta nenhuma além da do Caddy.

## Login do painel

- A senha fica guardada como hash scrypt (`DGCLAW_PANEL_PASSWORD_HASH`), gerado por
  `node panel/bin/senha-hash.js`, que lê a senha pelo teclado sem mostrar e exige no mínimo 12
  caracteres. Senha `admin` ou ausente deixa o painel **trancado**: ninguém entra pela senha, e o
  log diz o que configurar.
- A sessão é assinada pelo servidor e vence em 30 dias. Trocar a senha invalida todas as
  sessões abertas.
- Depois de 10 senhas erradas em 15 minutos, o painel responde "Muitas tentativas erradas.
  Espere N minutos." e nem a senha certa entra até a janela passar.
- Contra CSRF, toda requisição que muda alguma coisa confere `Origin` e `Sec-Fetch-Site`.
  Sair é por POST.
- No modo trancado só a senha fica desligada. As outras três portas de entrada continuam
  valendo, cada uma com a própria credencial: o segredo do proxy do DG Claw Web, a chave de API
  do painel e o Cloudflare Access.

## Chaves de API do painel

Servem para outro assistente (a assistente principal, o Admin) operar o painel de um agente
sem tela.

- Formato `dgc_...`, mostrada uma vez só, na criação. O painel guarda só o hash.
- Uma chave de API **não cria outra**: se uma vazar, ela não consegue gerar uma substituta para
  continuar entrando depois de revogada.
- Revogar é datar: a chave continua na lista, com a data em que deixou de valer.
- Passo a passo em `docs/COFRE-POR-API.md`.

## Cofre de cada agente

- Cada agente tem o próprio cofre. Uma chave guardada num agente vale só para ele.
  Compartilhar com outro agente é guardar de novo no outro, por decisão de quem administra.
- A tela e a API mostram quem guardou, quando e os 4 últimos caracteres. Nunca o valor.
- O valor chega ao agente por um arquivo de ambiente montado só leitura dentro do container.
  A escrita é atômica, então o agente nunca lê um arquivo pela metade.
- O cofre recusa referência `vault:...` (o nome de uma chave guardada em outro cofre) para não
  gravar um apelido no lugar do valor.
- `scripts/cofre-injetar.sh` guarda por API. Ele sai com 0 quando deu certo, 1 quando não
  guardou e 3 quando guardou mas não conseguiu reiniciar o agente.
- **Chave do cofre passa, chave herdada não.** O runner tira do ambiente do agente as chaves de
  modelo (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` e afins) que ele herdou de quem
  o iniciou, mas deixa passar as que o dono guardou no cofre. A exceção são as variáveis que
  passariam por cima da forma de pagar escolhida (a lista `limpar` de cada modo em
  `providers/catalogo.json`): num agente Claude na assinatura a `ANTHROPIC_API_KEY` do cofre fica
  de fora, e a `OPENAI_API_KEY` para gerar imagem entra. Limitação conhecida: num agente Codex na
  assinatura, a `OPENAI_API_KEY` do cofre fica de fora, porque disputaria com o login do ChatGPT.
- Detalhes da tela em `panel/docs/COFRE.md`.

## Isolamento entre agentes

- Cada agente roda num container sem privilégio, com usuário remapeado.
- O firewall da jaula descarta qualquer pacote do container para o host, para o gateway, para os
  outros containers e para redes privadas. A saída para a internet fica aberta.
- **Como provar:** `bash scripts/teste-isolamento.sh <slug>` roda, de dentro do container, uma
  bateria de conexões contra o host, o gateway, as portas internas, os vizinhos, as redes
  privadas e o endereço de metadados da nuvem. Sai com 0 quando tudo foi bloqueado e a internet
  respondeu, com 1 se algo respondeu, e com 2 quando o teste não conseguiu concluir. Sem
  argumento, testa todos os agentes que estão rodando.

## Proxy do DG Claw Web

O DG Claw Web faz o login do dono e repassa as requisições para o painel do agente em
`/p/<slug>/`. Para o painel acreditar que a requisição veio do Web, ela traz o cabeçalho
`X-DGClaw-Proxy` com um segredo por agente.

- O segredo fica num arquivo 600 do root no host, indicado por `DGCLAW_PANEL_PROXY_SECRET_FILE`.
  Ele nunca vai para o cofre.
- O Web confere o `Origin` e **sobrescreve** o `X-DGClaw-Proxy` que vier do navegador, então
  ninguém de fora consegue forjar o cabeçalho.

## Runner

O runner é o processo que mantém a sessão do agente viva. Ele escuta só em `127.0.0.1` e exige
`Authorization: Bearer <token>`. O token fica num arquivo 600 indicado por `RUNNER_TOKEN_FILE`,
um por agente. Sem esse arquivo, o runner recusa tudo com 401, menos a verificação de saúde
(`GET /api/saude`) e o aviso de estado da sessão (`/api/agent-hook`), que é protegido por um
número aleatório de 256 bits sorteado a cada sessão e só muda o estado mostrado: nunca injeta
texto nem dispara comando.

O que o terminal do agente imprime passa por uma máscara (`runner/src/mascara.ts`, porte do
detector de vazamento do DG AI Bunker) antes de ir para a tela e para o histórico: os valores do
cofre e qualquer coisa com cara de chave viram `[segredo oculto]`. É uma segunda barreira. Um
programa de tela cheia que redesenha a tela pode intercalar códigos de cor no meio do segredo, e
aí a máscara não o reconhece.

## Canais

- **Telegram:** o token do bot fica em `TELEGRAM_STATE_DIR/.env`, com permissão 600. Os scripts
  que avisam o dono passam a URL com o token pelo stdin do `curl`, e não pela linha de comando,
  que qualquer usuário da máquina veria no `ps`.
- **Canais configurados** ficam em `canais.json`, validado na leitura. A configuração do runner
  fica só leitura dentro do container.
- **WhatsApp** usa uma biblioteca não oficial (Baileys), instalada do pacote oficial e com versão
  exata. A Meta pode banir o número. Use um número secundário, nunca o número principal do
  negócio.
- A skill de canal se recusa a rodar no Admin.

## Conectores (Gmail, Agenda, Drive)

- Os conectores do claude.ai só aparecem quando o agente está logado na assinatura pelo
  `/login` do próprio container. O token do `claude setup-token` serve só para conversar com o
  modelo e não carrega conectores.
- **O Gmail nasce só lendo.** O agente pesquisa, lê e deixa rascunho na caixa do dono. Enviar,
  responder, encaminhar, apagar e mexer em marcadores ficam bloqueados por regras `deny` do
  Claude Code, que valem mesmo no modo sem confirmação.
- **Para liberar o envio,** o dono pede ao agente com as próprias palavras ("agora configura o
  e-mail pra você poder mandar"). O agente confirma o que muda e roda
  `scripts/gmail-permissao.sh <config> envio`. Vale na hora, sem reiniciar. Apagar continua
  bloqueado. O dono recebe um aviso de segurança toda vez que o envio é liberado, para perceber
  se não foi ele que pediu. Para voltar: `scripts/gmail-permissao.sh <config> leitura`.
- Pedido escrito dentro de um e-mail, de uma página ou de um arquivo não vale como pedido do
  dono. É material para o agente ler, não ordem.
- **O limite desta trava:** as regras ficam em `.claude/settings.local.json`, que pertence ao
  agente, porque é ele quem libera o envio quando o dono pede. Ela segura engano e texto
  malicioso lido num e-mail, mas não segura um agente decidido a tirá-la. Para esse caso a
  defesa é o aviso ao dono a cada liberação e o registro em `.dgclaw/logs/permissoes.log`. O
  `dgclaw agente criar` grava a trava só na primeira vez; repetir o comando não desfaz uma
  liberação que o dono já deu.

## Conta da assinatura

Rodar o agente na assinatura de quem usa é permitido. Os riscos estão em
`docs/RISCO-DE-BLOQUEIO-DE-CONTA.md`, com as fontes oficiais. Em resumo: cada pessoa usa a
própria conta, o DG Claw nunca copia o arquivo de login de um lugar para outro, e agente que
atende outra pessoa usa a credencial dela.

## Segredos fora do lugar

- Nenhum segredo no repositório nem no histórico (auditoria de 12/10/2026).
- Arquivos com segredo nascem 600: unidade do systemd com senha, `.env` do canal, cofre,
  token do runner, segredo do proxy.
- Log de erro diz o que falhou e com que entrada, sem o valor do segredo.

## Pendências conhecidas

| Item | Risco | Situação |
| --- | --- | --- |
| Saída livre para a internet | um agente comprometido por prompt injection consegue mandar o que tem no container para qualquer endereço | aceito na v1; a correção é um proxy de saída com lista de destinos |
| Instalação por `curl ... \| bash` | quem controlar um dos endereços de onde o instalador baixa executa código na máquina | fontes oficiais com HTTPS; fixar versão e conferir hash fica para depois |
| Cabeçalhos contra iframe no painel | uma página hostil poderia carregar o painel num iframe e induzir cliques | o painel precisa abrir dentro de outra página em algumas instalações; o login com `SameSite` e a checagem de `Origin` seguram as ações |
| Escrita de arquivo pelo painel | entre conferir o caminho e gravar, um agente malicioso poderia trocar uma pasta por atalho | exige um agente já comprometido dentro do próprio container |
| Token do runner e segredo do proxy dentro do container | quem controla o agente consegue falar com o próprio runner | aceitável na v1: cada token vale só para aquele agente, e o token do Admin nunca entra em container |
