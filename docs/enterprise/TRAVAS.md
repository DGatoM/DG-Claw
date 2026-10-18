# Travas de ação externa e HTTPS endurecido

Proteções `travas_externas` e `https_endurecido` (matriz: ligadas e travadas em escritório, empresa e regulado). Bloco E.
As políticas do Claude Code que carregam as travas do Gmail estão em `docs/enterprise/POLITICAS.md`; a credencial da empresa
em `docs/enterprise/CREDENCIAL.md`. No nível `pessoal` nada daqui age.

## O que uma trava resolve

O agente trabalha dentro do container e pode ser enganado por um texto (um e-mail, uma página, um comentário). Tudo o que ele
faz "em nome da empresa" para fora (mandar e-mail, publicar no Instagram, escrever para um terceiro no WhatsApp) passa por
uma trava que ele não consegue abrir sozinho. A conversa do agente com a própria pessoa não é "em nome da empresa" e fica livre.

| Canal | O que o agente pode | O que fica com uma pessoa |
| --- | --- | --- |
| Gmail | ler e criar rascunho | enviar, responder e encaminhar (a pessoa envia no Gmail, ou o TI libera por um tempo) |
| Instagram | pedir uma publicação ou uma resposta | aprovar no painel; só então o Web publica |
| WhatsApp | conversar com os números da lista do TI | decidir quem entra na lista |

## Gmail

- As regras `deny` das ferramentas de envio do conector do claude.ai vão para o **managed settings** do agente
  (`<casa>/politicas/managed-settings.json`, dono root do host, 644, montado só leitura em `/etc/claude-code`). Managed settings
  tem a prioridade mais alta do Claude Code: nem `settings.local.json`, que o agente edita, nem `--settings` mudam uma chave dele.
  A lista é a mesma de `scripts/gmail-permissao.sh` (o teste `tests/enterprise/politicas.test.sh` compara as duas).
- O `settings.local.json` da pasta do agente continua como era (`leitura` na criação); a trava de verdade é o managed settings.
- **Liberar o envio por um tempo** é a operação perigosa `travas.liberar` do controle (`docs/enterprise/CONTROLE.md`):
  o Admin pede, o TI aprova em `/aprovacoes` (com o 2FA de menos de 15 minutos), e o controle roda
  `dgclaw travas liberar <agente> --minutos N` (de 5 a 240). O comando:
  1. grava `/etc/dgclaw/travas/<agente>.json` (600, `liberado_ate`, `por`);
  2. regrava o managed settings sem o `deny` de enviar, responder e encaminhar (apagar e mexer na caixa continuam bloqueados);
  3. põe o `settings.local.json` do agente em `envio`, **rodando como o agente, dentro do container** (`podman exec -u agente`),
     porque o root do host nunca escreve numa pasta que o agente controla (armadilha 7);
  4. reinicia o runner do agente e agenda `dgclaw travas fechar <agente> --auto` com `systemd-run --on-active=Nmin`;
  5. audita `travas.liberada`.
- **Volta sozinha**: o timer exato (`dgclaw-travas-fecha-<agente>`) fecha no minuto. Como timer transitório some num reboot, o
  `dgclaw-travas.timer` roda `dgclaw travas conferir` de 5 em 5 minutos e fecha tudo o que venceu. Fechar à mão:
  `dgclaw travas fechar <agente>`. Ver: `dgclaw travas status` (e o `dgclaw status` avisa de envio liberado).
- Se o container está desligado na hora de liberar, o comando recusa (o `settings.local.json` não teria como acompanhar). Ao
  fechar com o container desligado, o managed settings já fecha (é o que vale) e o resto fica para o `conferir`.
- Agente Codex não tem conector do Gmail: não há o que travar nem liberar.

## Instagram

Hoje o token fica num arquivo do agente (`.instagram_token`, indicado no `.dgclaw/instagram.json`) e o `scripts/ig-publish.py`
chama a Graph API de dentro do container. Com `travas_externas`:

1. **`dgclaw acoes instagram configurar <agente>`** (no servidor, como root) move o token para
   `/etc/dgclaw/acoes-externas/<agente>/instagram.env` (pasta 700, arquivo 600, linhas `IG_TOKEN=` e `IG_CONTA=`). Com
   `cofre_cifrado` ligado fica só o `instagram.env.cred`, cifrado com `systemd-creds` (nome `dgclaw-acoes-instagram-<agente>`),
   pelo mesmo mecanismo do bloco D. Antes de apagar o arquivo do agente, confere que o cofre do host devolve o mesmo token.
   Recusa atalho no lugar do arquivo, `tokenPath` fora da casa do agente e `igAccountId` inválido. `dgclaw acoes instagram testar
   <agente>` confere que o token está lá (não chama a Graph API).
2. O container recebe `DGCLAW_TRAVAS=1` (gancho `ent_args_container_travas`; container antigo: `dgclaw agente recriar <slug> --sim`).
   Nesse modo o `ig-publish.py` **não chama a Graph API e não lê o token**: manda o pedido por `dgclaw-api POST /api/v1/acoes/instagram`
   e espera a decisão do TI consultando a aprovação (`--espera`, padrão 600 s). Saídas: 0 publicado; 1 recusado, vencido ou falhou;
   3 ainda esperando (o JSON traz o id; `ig-publish.py status --aprovacao <id>` consulta depois). O `validate` explica que o token
   fica no host. Sem `DGCLAW_TRAVAS` o script é o de sempre (nível pessoal).
3. **`POST /api/v1/acoes/instagram`** (`web/lib/ent/acoes-instagram.js`) só aceita o agente de trabalho pela caixa. Valida tudo
   (imagem em `https://` sem usuário e senha, porta 443 e nome de site; legenda de até 2200 caracteres; conta igual à configurada;
   campo desconhecido recusado) e cria uma aprovação do tipo `instagram` na fila genérica do bloco C. A frase que o TI lê leva a
   conta, o agente, o endereço da mídia e a **legenda inteira** (o tipo registra `descricaoMax: 2600`, o padrão da fila é 500). A
   legenda é texto do agente, mas é justamente o que o TI precisa ler: entra entre aspas, sem crase e sem caractere de controle.
   Pedido igual ainda pendente devolve o mesmo, sem encher a fila.
4. **Prévia da mídia**: a tela `/aprovacoes` mostra a imagem pela rota `GET /api/v1/acoes/instagram/<id>/previa` (só TI). O
   servidor busca a imagem (https, porta 443, sem redirecionamento, até 8 MB, só JPEG, PNG, WebP ou GIF, 15 s) depois de resolver
   o nome e **recusar endereço interno ou reservado** (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, IPv6 local),
   conectando no IP já conferido (sem janela para troca de DNS). A tela nunca usa o endereço do agente como `src`: a política de
   conteúdo não deixaria e o IP do TI não deve ir para um servidor que o agente escolheu.
5. **Aprovado**, o executor do host publica pela Graph API v21.0: `POST /{conta}/media` e `POST /{conta}/media_publish` com
   `access_token` **no corpo** (formulário), e o `GET` do endereço do post com `Authorization: Bearer`. Nenhuma chamada leva o token na
   URL (achado de severidade baixa da auditoria; o `ig-publish.py` antigo ainda usa a query string no `GET /me` e no permalink, e
   continua assim no nível pessoal). O token e o valor das chaves nunca vão para log, auditoria, resposta ou arquivo do pedido.
   Sem token no cofre do host na hora de executar, o pedido volta a "pendente" (nada foi tentado).
6. Responder comentário segue o mesmo caminho (`op: "responder"`, `POST /{comentario}/replies`).

Auditoria: `aprovacao_criada`, `aprovacao_aprovada`, `aprovacao_recusada`, `aprovacao_executada` e `aprovacao_falhou` (com a frase
e o hash dos parâmetros), mais `acoes.instagram.configurar` (sem o token).

## WhatsApp e outros canais

- **WhatsApp**: a ponte (`canais/whatsapp/ponte.mjs`) lê a lista de números do TI em `/run/dgclaw/config/whatsapp-permitidos.json`
  (a pasta `config` do agente, montada só leitura). **Existindo, ela manda**: a lista que o agente edita
  (`~/.dgclaw/whatsapp/permitidos.json`) é ignorada, e arquivo ilegível fecha tudo (não cai na do agente). O TI mexe com
  `dgclaw acoes whatsapp permitir|remover|listar <agente> [número]`. A primeira vez que `dgclaw protecoes aplicar` roda com a trava
  ligada, a lista do agente vira a do TI (confira com `listar`). Como a lista decide quem **recebe resposta** do agente, ela inclui o
  próprio funcionário: a conversa com ele continua. Desligar a trava apaga a lista do TI e a ponte volta a ler a do agente.
- **Fora desta versão**: Telegram e os demais canais (a skill `canais` e o `dgclaw-agente canal telegram`) mantêm o controle de acesso
  que já tinham (quem fala com o agente é decidido pelo dono do bot) e não ganharam trava própria. O Google Agenda e o Drive do
  claude.ai também não: convite de calendário com convidados e compartilhamento de arquivo do Drive saem pelas mesmas ferramentas
  de conector e poderiam entrar na lista de `deny` do managed settings. Fica como decisão do TI/da DG Medeiros (ver o relatório).

## HTTPS endurecido e cabeçalhos

- **Caddy**: com `https_endurecido`, o bloco do site no Caddyfile gerado (`bloco_caddy`, `lib/comum.sh`, gancho `ent_caddy_extra` em
  `lib/enterprise/https.sh`) ganha `header { Strict-Transport-Security "max-age=31536000; includeSubDomains"; ?X-Content-Type-Options
  "nosniff"; ?Referrer-Policy "same-origin"; ?Permissions-Policy "camera=(self), microphone=(self), ..."; -Server }`. O `?` quer
  dizer "só se o Web não mandou o dele" (a página do visual do chat manda `Referrer-Policy: no-referrer` e não pode ser enfraquecida).
  No instalador, `ent_instalar_https` reescreve o site depois do nível gravado; `dgclaw protecoes aplicar` reescreve só quando o
  Caddyfile está diferente do que a proteção pede, valida com `caddy validate` e **volta o arquivo ao que era** se o Caddy recusar.
  `dgclaw https cabecalhos` imprime as linhas para quem mantém o Caddyfile à mão (Caddyfile que não é do DG Claw não é tocado).
- **Política de conteúdo (CSP)** no Web (`web/lib/ent/seguranca-web.js`): páginas do Web recebem
  `default-src 'self'; script-src 'self' <hash de cada script inline>; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self';
  frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`, mais `Permissions-Policy` (câmera e microfone só do
  site: o chat grava voz) e, sobre HTTPS, `Strict-Transport-Security`.

  Levantamento feito antes (o que as páginas usam hoje):

  | Item | Onde | Como ficou |
  | --- | --- | --- |
  | `<script>` inline | `conversa`, `lembretes`, `mesa`, `avisos`, `aprovacoes`, `auditoria`, `conta`, `usuarios`, `protecoes` | **hash** sha256 de cada um, calculado na partida e recalculado quando o `.html` muda. Sem `'unsafe-inline'` em script |
  | `onerror=""` inline em imagem do chat | `conversa.js` | trocado por um ouvinte de captura (`data-erro="thumb\|ocultar"`) |
  | `<style>` e `style=""` | quase todas as páginas e o JavaScript | **`'unsafe-inline'` em estilo, aceito e registrado**: o risco que sobra é injeção de CSS, sem execução de script |
  | `eval`, `new Function`, `javascript:` | nenhum | o teste `ent-https.test.js` falha se aparecer |
  | iframes do visual/lousa (`docs/VISUAIS.md`) | `conversa.js` (`sandbox="allow-scripts"`, rota `/visual`) | a rota manda a política dela (`sandbox`, `connect-src 'none'`, CDNs `jsdelivr` e `cdnjs`), que vale no lugar desta; o pai só precisa de `frame-src 'self'` |
  | PDF em iframe, imagens, vídeo, áudio | `conversa.js` | do próprio site (`'self'`), `data:` e `blob:` para áudio gravado e prévias |
  | service worker do push | `sw.js` | `worker-src 'self'` |
  | fontes, CDN, fetch de outro site | nenhum | nada externo é carregado |
  | arquivos ativos (HTML/SVG enviados pelo agente) | `media.js` | já levam `sandbox; default-src 'none'`; a política deles vale |
  | painel do agente | `/p/<slug>/` (Express do container, via proxy) | **política própria**: `script-src 'self' 'unsafe-inline'`, porque o painel tem `<script>` com dados da página (`window.DGCLAW_BASE`) e `onclick=""`. É a mais firme que não o quebra. Fica registrado como limite aceito |

  Limite conhecido: o HTML de reserva da tela de login (`LOGIN_RESERVA` em `server.js`, usado só se o `login.html` sumir) tem um
  script inline sem hash e não roda sob a política. A tela de login de verdade (`login.html`, que o SSO usa) não tem script inline.
  Teste: `web/test/ent-https.test.js` confere o cabeçalho em `/login`, `/primeiro-acesso` e nas telas do TI (`/aprovacoes`,
  `/auditoria`, `/usuarios`, `/protecoes`, `/conta`), que o hash de todo script inline dos arquivos reais está na política, e
  procura manipulador inline e `eval` em `web/public`.
- **Cookie de sessão**: já era `HttpOnly` e `SameSite=Lax`, com `Secure` quando o pedido chega por HTTPS. Com `https_endurecido` e
  HTTPS, o nome vira **`__Host-dgclaw_sessao`** (o navegador só aceita com `Secure`, `Path=/` e sem `Domain`). Migração: o nome
  antigo continua valendo enquanto a sessão antiga durar (o servidor lê os dois, o `__Host-` tem a vez), e sair apaga os dois. Sobre
  HTTP puro (127.0.0.1 de teste) o nome fica o antigo, porque o navegador rejeitaria o `__Host-`.

## Testes

`tests/enterprise/travas.test.sh`, `politicas.test.sh`, `https.test.sh`, `credencial.test.sh`; `web/test/ent-acoes-instagram.test.js`,
`ent-https.test.js`, `ent-credencial.test.js`; `canais/whatsapp/test` (lista do TI); `scripts/_lib/test_ig_publish_travas.py`.

## O que só dá para provar numa máquina real (teste manual)

1. `claude` num container recriado lê `/etc/claude-code/managed-settings.json` (rodar `/status` no agente: a linha "Setting
   sources" tem que citar as managed settings) e recusa um login de outra organização (`forceLoginOrgUUID`).
2. Com o envio travado, o agente não recebe as ferramentas `send_message`, `reply` e `forward` do Gmail; depois de
   `dgclaw travas liberar`, ele recebe sem reiniciar o container; ao vencer, volta a perder.
3. O timer `dgclaw-travas-fecha-<agente>` aparece em `systemctl list-timers` e dispara; o `dgclaw-travas.timer` fecha o que sobrou
   depois de um reboot no meio da liberação.
4. `caddy validate` com o bloco de cabeçalhos, e os cabeçalhos chegando no navegador (`curl -sI https://<dominio>/login`).
5. Em navegador real, cada tela do Web carrega sem violação da CSP no console (conversa com lousa, voz, push, PDF, `/aprovacoes`,
   `/auditoria`, tela de login com o SSO) e o painel do agente em `/p/<slug>/`.
6. Publicação real de teste no Instagram por uma conta de teste: pedido, prévia, aprovação com 2FA, post no ar.
7. WhatsApp: com a lista do TI, um número fora dela não recebe resposta mesmo se o agente editar o arquivo dele.
