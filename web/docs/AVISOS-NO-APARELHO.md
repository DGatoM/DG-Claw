# Avisos no aparelho (web push)

O DG Claw Web manda avisos para o celular e o computador do dono mesmo com a tela
fechada. É o Web Push padrão (VAPID + `aes128gcm`, RFC 8291 e 8292), feito só com
`node:crypto`, sem biblioteca nova. Quem usa hoje: os [lembretes](LEMBRETES.md), a Mesa, o Foco e o
[vigia de atenção dos agentes](ESTADO-DOS-AGENTES.md) ("Fulano precisa de você" e "Fulano terminou"). Qualquer
frente pode usar (veja "Para quem constrói uma frente nova").

- **Android e computador:** funciona no navegador (Chrome, Edge, Firefox) depois de ativar.
- **iPhone:** só com o DG Claw **instalado na tela de início** (iOS 16.4 ou mais novo). No
  Safari aberto como site, o botão explica isso em vez de falhar calado.
- A inscrição só nasce de um toque do dono: é o botão **Ativar avisos neste aparelho**, no
  menu lateral e na tela de lembretes. Cada aparelho ativa uma vez.

## Rotas

Todas com a sessão do login. Escritas exigem `Origin` do próprio Web, como o resto da API.

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/push/chave` | `{"ok":true,"chave_publica":"<base64url>"}`: a chave VAPID que o navegador usa no `pushManager.subscribe` |
| `POST /api/v1/push/inscricoes` | grava a inscrição do aparelho. Corpo: o `PushSubscription.toJSON()` (`endpoint` + `keys.p256dh` + `keys.auth`) e `aparelho` opcional (nome, até 60 caracteres). 201 nova, 200 atualizada |
| `GET /api/v1/push/inscricoes` | lista: `id`, `aparelho`, `servico` (só o host), `criada_em`, `ultimo_ok_em`, `ultima_falha`. Nunca o endpoint inteiro nem as chaves |
| `POST /api/v1/push/inscricoes/confere` | `{"endpoint":"..."}` devolve `{"ok":true,"inscrito":true,"id":"ins_..."}` |
| `POST /api/v1/push/inscricoes/remover` | `{"endpoint":"..."}` ou `{"id":"ins_..."}`. 404 se não existe |
| `POST /api/v1/push/teste` | manda um aviso de teste. Com `{"endpoint":"..."}` só para esse aparelho; sem corpo, para todos. 409 se não há aparelho inscrito, 502 se o serviço de push recusou (com o status e o motivo) |
| `GET /api/v1/push/preferencias` | `{"ok":true,"preferencias":{"precisa_de_voce":true,"terminou":true}}`: quais avisos dos agentes o dono quer (padrão: os dois) |
| `POST /api/v1/push/preferencias` | `{"terminou":false}`: muda um ou os dois. Outro campo ou valor que não seja `true`/`false`: 400 com o motivo. Guardado em `push/preferencias.json` (600) |
| `GET /api/v1/push/docs.md` | este documento |

O endpoint da inscrição só é aceito se for `https://` num serviço de push conhecido
(`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`, `*.push.services.mozilla.com`). Outro host volta 400: assim
ninguém usa o Web para fazer pedidos a um endereço qualquer.

## Onde fica cada coisa

Em `<DGCLAW_WEB_DATA>/push/` (padrão `/var/lib/dgclaw/web/push/`), pasta 0700, arquivos 0600:

- `vapid.json`: o par de chaves VAPID. O instalador gera na instalação (e o Web gera na
  primeira partida, se faltar). **Não apague**: um par novo invalida todas as inscrições e
  cada aparelho precisa ativar de novo. Entra no backup.
- `inscricoes.json`: uma entrada por aparelho. Quando o serviço de push responde 404 ou 410
  (inscrição morta), ela sai sozinha. Outro erro vai para o log com status e motivo, e para
  `ultima_falha`.

Arquivo ilegível nunca é trocado por um vazio: a rota responde 503 com o caminho e o que
fazer, e o envio devolve a falha em vez de fingir que mandou.

## O aviso que chega

O service worker (`web/public/sw.js`) recebe o JSON e mostra:

| Campo | O que faz |
| --- | --- |
| `titulo` | título da notificação |
| `corpo` | texto |
| `tag` | aviso novo com a mesma tag **substitui** o anterior e toca de novo (`renotify`), em vez de empilhar |
| `url` | o que abrir ao tocar (só caminho do próprio Web, ex.: `/a/luna#lembrete-oc_...`) |
| `imagem` | opcional, caminho do próprio Web. Android e Chrome mostram; o iPhone ignora |
| `acoes` | opcional, até 2 botões: `[{"acao":"feito","titulo":"✅ Feito","post":"/api/v1/lembretes/oc_x/feito"}]`. Tocar no botão faz o `POST` (com a sessão do aparelho) sem abrir a tela; se o `POST` falhar, abre a `url` para o dono resolver lá |
| `exigir_interacao` | `true` deixa a notificação na tela até alguém tocar (onde o sistema aceita) |

## Para quem constrói uma frente nova

```js
const r = await push.enviar({
  titulo: '⏰ Hora do lembrete', corpo: 'ligar pro contador', tag: 'lembrete-oc_123',
  url: '/a/luna', acoes: [{ acao: 'feito', titulo: '✅ Feito', post: '/api/v1/...' }],
});
// r = { inscricoes: 2, ok: 1, removidas: 1, falhas: [{ id: 'ins_..', servico: 'fcm.googleapis.com', status: 400, motivo: '...' }] }
```

`enviar` nunca lança por falha de entrega: devolve o resultado, para a frente guardar
(`inscricoes: 0` quer dizer que nenhum aparelho está ativado). Lança só se o arquivo de
chaves estiver ilegível, com a causa em português. O `push` é criado uma vez no
`server.js` e passado às frentes que precisam.
