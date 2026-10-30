# Tela: o navegador do agente dentro do painel

A aba **Tela** abre, dentro do painel, o navegador que o agente usa (um Google Chrome rodando num monitor virtual, dentro do container). O dono entra nos sistemas que o agente vai usar e faz o login com as próprias mãos. Depois o agente usa esse mesmo navegador, já logado, por CDP. A senha do dono nunca passa pela conversa.

## Como as peças se ligam

```
navegador do dono ──> painel (/tela/novnc/*  e  WebSocket /tela/websockify)
                          │  só com login do painel
                          ▼
                  websockify + noVNC (127.0.0.1:6080) ──> x11vnc (localhost:5901, pede a senha da tela) ──> Xvfb :1 + Chrome
```

- O painel **nunca** expõe a porta 6080 sem login. Os arquivos do noVNC e o WebSocket passam pela mesma porta de entrada das outras rotas.
- A segunda senha é a do próprio VNC. O noVNC pede, o x11vnc confere. O painel só grava o arquivo da senha (`rfbauth`) e não guarda a senha em lugar nenhum.
- Quem reinicia o x11vnc depois da troca de senha **não** é o painel: uma unidade `.path` do container observa o arquivo.

## Variáveis de ambiente (todas opcionais)

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `DGCLAW_TELA_NOVNC` | `127.0.0.1:6080` | Onde estão o websockify e os arquivos do noVNC. |
| `DGCLAW_TELA_SENHA_ARQUIVO` | `/home/agente/.dgclaw/tela/vnc.senha` | O arquivo `rfbauth` do x11vnc. |
| `DGCLAW_TELA_URL_EXTERNA` | vazio | Endereço alternativo (`http(s)://`), para quando a fachada não deixa o WebSocket passar. A tela mostra o link. |
| `DGCLAW_TELA_CDP` | `127.0.0.1:9222` | Só para o status: o Chrome respondeu em `/json/version`? |

## Rotas

Todas atrás do mesmo login das outras rotas (cookie de sessão, ou o segredo do proxy do DG Claw Web). Chave de API (`Bearer`) **lê** o status, mas **não** abre a tela nem troca a senha.

### `GET /api/tela`

```json
{ "ok": true, "instalada": true, "senha_definida": true, "cdp": true,
  "url_externa": null, "caminho_websockify": "/p/ana/tela/websockify" }
```

- `instalada`: o websockify respondeu.
- `senha_definida`: o arquivo da senha existe e tem 8 bytes.
- `cdp`: o Chrome respondeu em `/json/version`.
- `url_externa`: `null` quando não configurada.

### `PUT /api/tela/senha`

Corpo `{ "senha": "abc123" }`. De 6 a 8 caracteres ASCII imprimíveis. Mais de 8 é **recusado** (400) em vez de cortado, porque o VNC só usa os 8 primeiros. Resposta `{ "ok": true, "aviso": "quem estava vendo a tela foi desconectado" }`.

- `400`: senha fora das regras (o `error` diz qual e o `howToFix` o que fazer).
- `401`: sem login.
- `403`: chave de API. Troque pela aba Tela ou pela máquina.
- `429`: mais de 10 trocas em um minuto.
- `500`: não consegui gravar o arquivo (a mensagem diz o caminho e a causa).

### `GET /tela/novnc/*` e `WS /tela/websockify`

O cliente noVNC e o WebSocket. A página da aba monta a URL do noVNC a partir de `location.pathname`, por isso funciona na raiz, com `DGCLAW_PANEL_BASE` e atrás do `/p/<agente>/` do DG Claw Web. O pedido de WebSocket com cookie precisa de `Origin` da mesma origem. Recusas saem com status e motivo em português: 401 (sem login), 403 (outro site), 404 (outro caminho), 502 (a tela não respondeu), 503 (`DGCLAW_TELA_NOVNC` inválida).

## Gravar a senha pela máquina

```
printf '%s\n' "$SENHA" | node panel/bin/tela-senha.js --arquivo /home/agente/.dgclaw/tela/vnc.senha
```

A senha vem do STDIN (nunca de argumento, que aparece em `ps`). Mesmas regras do painel. Sai com 0 se gravou, 1 se a senha foi recusada ou a gravação falhou, 2 se o uso estava errado. O arquivo é escrito de forma atômica, com modo 600, e a pasta nasce com 700.

O formato do arquivo é o do x11vnc: a senha completada com zeros até 8 bytes, cifrada em DES-ECB com a chave fixa do VNC (`23 82 107 6 35 78 88 7`, cada byte com os bits invertidos). O DES está escrito em `lib/tela-senha.js` porque o Node 22 desta imagem não traz DES.
