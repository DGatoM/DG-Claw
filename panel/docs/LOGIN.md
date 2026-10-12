# Entrada no painel: senha, sessão e chaves de API

Este login é a única porta para um agente que roda como administrador da máquina.
Por isso o painel não tem senha padrão e não deixa nada passar calado.

## Como configurar a senha

Gere o hash (a senha é lida do terminal sem aparecer na tela, ou do stdin; nunca de
argumento, porque argumento aparece no `ps`). O mínimo é 12 caracteres.

```bash
node panel/bin/senha-hash.js
# imprime só a linha: scrypt$16384$8$1$<sal>$<hash>
```

Ponha a linha em `DGCLAW_PANEL_PASSWORD_HASH` no ambiente da unidade do painel e
reinicie. `DGCLAW_PANEL_PASSWORD` (texto) ainda funciona, por compatibilidade com
agentes já instalados; com menos de 12 caracteres o painel sobe e avisa no log.
O arquivo da unidade guarda a senha, então deve estar em modo 600.

Opcional: `DGCLAW_PANEL_USER`. Definido, a tela pede usuário e senha, e os dois
precisam bater.

## Modo trancado

Sem senha, ou com a senha `admin`, o painel sobe **trancado**: loga uma vez o que
falta, a tela de login mostra a explicação no lugar do formulário, o `POST /login`
recusa e toda rota `/api/` pedida sem outra credencial responde 503 (com `howToFix`).
Não existe senha padrão.

Trancado desliga só a senha. O segredo do proxy, a chave de API e o Cloudflare Access
continuam valendo, cada um com a própria credencial. É assim que o painel roda dentro
do container no DG Claw v1: sem senha própria, com o DG Claw Web fazendo o login do
dono e chegando pelo proxy. Sem nenhuma dessas três configurada, nada entra.

## Sessão e proteções

| Proteção | O que faz |
| --- | --- |
| Cookie de sessão | `v1.<expira>.<hmac>`: assinado, 30 dias, validade conferida no servidor. Trocar a senha derruba todas as sessões |
| Limite de tentativas | 10 erros em 15 minutos por IP viram 429 ("Muitas tentativas erradas. Espere N minutos."). Vale também para a senha certa durante o bloqueio |
| Cookie | `httpOnly`, `sameSite=lax`, `Secure` quando o pedido chegou por https (o Caddy local informa por `X-Forwarded-Proto`) |
| CSRF | POST/PUT/PATCH/DELETE por cookie com `Origin` de outro endereço, ou com `Sec-Fetch-Site: cross-site`, recebem 403. Atrás de um proxy que reescreve o `Host`, informe o endereço público em `DGCLAW_PANEL_ORIGINS` (separado por vírgula) |
| Sair | `POST /logout` apaga o cookie. O `GET /logout` só leva para a tela de login, sem efeito, para que uma página de fora não consiga deslogar o dono. O token é assinado e não fica guardado no servidor: para derrubar todas as sessões de uma vez, troque a senha |
| Cabeçalhos | `X-Content-Type-Options: nosniff` e `Referrer-Policy: same-origin`. Sem `X-Frame-Options`: o painel abre dentro de uma fachada |

## Chaves de API (Bearer)

`Authorization: Bearer dgc_...` vale em `/api/*`, menos em `/api/chaves-api*`. Criar,
listar e revogar: aba Cofre, `GET/POST/DELETE /api/chaves-api` (só por senha) ou
`node panel/bin/chave-api.js`. Detalhes em `panel/docs/COFRE.md` e
`docs/COFRE-POR-API.md`.

## Atrás do proxy do dono (DG Claw Web)

Se `DGCLAW_PANEL_PROXY_SECRET_FILE` (arquivo, preferido) ou `DGCLAW_PANEL_PROXY_SECRET`
estiver definida, o pedido com `X-DGClaw-Proxy: <segredo>` entra como o dono
(`X-DGClaw-Usuario` informa o nome, padrão "Dono"), sem checagem de Origin (o proxy a
faz) e com acesso a `/api/chaves-api*`. O arquivo do segredo tem de estar em modo
600, senão o painel não sobe. Segredo vazio nunca libera. Sem o cabeçalho certo, vale
o login normal.

## Cloudflare Access

Quando ligado, o JWT válido do Access entra sem senha. Internamente isso é um sinal
explícito (`req.dgclawAuth = 'cf-access'`), e não mais um cookie fabricado.
