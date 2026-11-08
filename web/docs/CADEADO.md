# Face ID: o cadeado do DG Claw

O Face ID é uma trava opcional do painel web. Com ela ligada num aparelho, a tela trava sozinha depois de alguns
minutos sem uso e só volta com o rosto, a digital ou o código do aparelho (uma passkey, o padrão WebAuthn).
Quem não ligar não percebe nada. O nome muda conforme o aparelho: Face ID no iPhone, Touch ID no Mac, biometria
nos outros.

Este documento serve para a pessoa e para o agente que a ajuda. As rotas ficam em `GET /api/v1/cadeado/docs.md`.

## Como funciona

- **É por aparelho.** Ao ligar, o servidor grava no navegador o cookie `dgclaw_aparelho` (HttpOnly, SameSite=Lax,
  `Secure` quando o painel está em HTTPS, válido por mais de um ano). No servidor fica só o hash desse valor, junto
  da passkey. A sessão só trava quando o pedido traz esse cookie ligado a uma passkey da mesma pessoa. O computador
  de quem não ligou, ou um navegador novo, não trava.
- **Vale para o dono e para cada colaborador.** Cada um tem as próprias passkeys e o próprio tempo de trava, e não
  enxerga as dos outros. Se o dono revoga um colaborador, as passkeys dele são apagadas.
- **O Face ID nunca faz login.** Ele só destrava uma sessão que já entrou com a senha, e a passkey tem de ser da
  pessoa dessa sessão. Quem não está logado não consegue nada com ele.
- **A senha é a saída.** Na tela travada, "Entrar com a senha" encerra a sessão e leva ao login; entrar com a senha
  cria uma sessão já destravada. Serve para aparelho sem biometria, Face ID falhando ou passkey apagada.
- **O tempo conta uso de verdade.** A tela avisa o servidor quando a pessoa toca, digita ou rola, no máximo uma
  vez por minuto. O que roda em segundo plano (atualizar a conversa, o stream) não conta. O padrão é 15 minutos; a
  pessoa escolhe de 1 a 120.

## O que trava

O servidor decide, em todas as telas. Com a sessão travada:

| Pedido | Resposta |
| --- | --- |
| Página (HTML) | redireciona para `/cadeado?next=<página>` |
| `/api/...` | `423` com `{ "ok": false, "erro": "...", "travado": true }` |
| `/p/<agente>/...` | redireciona se for página, `423` se for chamada |
| WebSocket | recusado com `423` |
| Stream da conversa | para e manda `event: travado` |

Passam mesmo travada: `GET /cadeado`, os arquivos estáticos (CSS, JS, ícones), `GET /api/v1/cadeado/estado`,
`GET /api/v1/cadeado/verificar/opcoes`, `POST /api/v1/cadeado/verificar`, `/sair` e `/login`. A caixa dos agentes
(o `dgclaw-api` dentro do container) e os pedidos internos nunca travam, e não alcançam as rotas do Face ID.

## Verificação no servidor

Tudo é conferido no servidor, nada é confiado à tela: desafio aleatório de uso único (2 minutos, preso à sessão e
ao tipo), `type`, `challenge`, `origin` igual ao endereço do painel, `rpIdHash`, flags de presença (UP) e de
verificação do usuário (UV), assinatura (ES256 ou RS256 com RSA de 2048 bits ou mais) e contador (que não pode
voltar). Passkey sincronizada pela conta (backup eligible) é aceita. Cada sessão tem no máximo 8 desafios abertos e
10 tentativas recusadas em 10 minutos (por IP, 20); passado disso a resposta é `429`.

## Rotas (`/api/v1/cadeado`)

Todas pedem a sessão de quem entrou pelo painel. A escrita segue a checagem de `Origin` de sempre. Erros voltam em
português, com `{ "ok": false, "erro": "...", "motivo": "..." }` e o status certo.

| Rota | O que faz |
| --- | --- |
| `GET /estado` | `ativo` (este aparelho tem Face ID), `travado`, `trava_min`, `resta_s`, `passkeys`, `neste_aparelho`, `host`, `https`, `ambiente_erro`, `aviso` |
| `POST /uso` | a tela avisa que houve uso (no máximo 1 por minuto); sessão travada recebe `423` |
| `GET /cadastro/opcoes` | opções para criar a passkey (`publicKey`, em base64url) |
| `POST /cadastro` | `{ "nome": "iPhone da Maria", "credencial": {...} }`; grava a passkey e o cookie do aparelho |
| `GET /verificar/opcoes` | desafio para destravar |
| `POST /verificar` | `{ "credencial": {...} }`; destrava a sessão |
| `GET /passkeys` | os aparelhos da pessoa (sem chave nem identificador interno) |
| `PATCH /passkeys/<id>` | `{ "nome": "..." }`, até 60 caracteres |
| `DELETE /passkeys/<id>` | remove o aparelho |
| `PUT /ajustes` | `{ "trava_min": 15 }`, inteiro de 1 a 120 |
| `GET /docs.md` | este documento |

Remover uma passkey, mudar o tempo e cadastrar exigem a sessão destravada. O cadastro pede, no navegador,
`navigator.credentials.create()`, e a verificação `navigator.credentials.get()`; só a tela do painel faz isso.
Um agente não consegue ligar o Face ID por API, porque falta o aparelho: ele ajuda a pessoa a chegar na tela
**Face ID** do menu.

## Quando o Face ID não liga

- **O endereço não tem HTTPS.** O navegador só libera passkeys em endereço seguro (ou em `localhost`). Abra o painel
  pelo endereço com `https://`. Se o painel ainda está num endereço de IP, é preciso um domínio com HTTPS (veja a
  skill `trocar-dominio`). A tela Face ID explica isso quando acontece.
- **O navegador não tem WebAuthn ou o aparelho não tem biometria pronta.** A tela explica o motivo. A senha
  continua valendo: o Face ID nunca substitui a senha.
- **Mudou o endereço do painel.** A passkey fica presa ao endereço em que foi criada (o `rpId`). Depois de trocar
  de domínio, o Face ID precisa ser ligado de novo em cada aparelho. A tela Face ID mostra o endereço atual.

## Arquivos e falhas

- `passkeys.json` e `cadeado-sessoes.json` ficam na pasta de dados do Web (`DGCLAW_WEB_DATA`), com permissão 600 e
  escrita atômica. O primeiro guarda as passkeys (só a chave pública), os tempos de trava e o hash do aparelho; o
  segundo, o último uso de cada sessão (por hash do token, nunca o token).
- **Se `passkeys.json` estiver ilegível, o cadeado fecha**: continua ligado nos aparelhos que já tinham o cookie, só
  a senha destrava, e o arquivo nunca é regravado. O log e a tela dizem o caminho e o motivo. Conserte ou apague o
  arquivo e reinicie o painel (apagar remove todas as passkeys; cada pessoa liga de novo).
- Depois de reiniciar o painel, as sessões destravadas continuam (o estado está no disco). Sessão que ficou sem
  registro nasce travada nos aparelhos com Face ID.

## Para o agente que ajuda a pessoa

1. Explique em uma frase o que é: uma trava opcional com o rosto ou a digital, ligada aparelho por aparelho.
2. Mande a pessoa abrir **Face ID** no menu ☰ e tocar em "Ligar neste aparelho". Ela precisa estar no celular ou
   no computador em que quer a trava.
3. Se a tela mostrar um aviso de HTTPS, de navegador ou de biometria, leia o aviso com ela e resolva o que ele pede.
4. Nunca peça a senha da pessoa para "testar", e não tente contornar a trava de uma sessão: a saída é a senha dela.
