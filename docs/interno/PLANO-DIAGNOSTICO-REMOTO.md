# Plano: diagnóstico remoto só-leitura (21/10/2026)

## Por que existe

O Danilo entrega agentes DG Claw para clientes, cada um na VPS do próprio cliente. Quando algo
quebra, ele quer saber o que está parado e por quê, **sem senha da VPS e sem poder operar nada**.
Depois da entrega a máquina é do cliente: a chave de suporte só lê metadados de saúde, e o
cliente revoga quando quiser.

## Onde fica

No `web/` (o DG Claw Web, `dgclaw-web.service`, root, `127.0.0.1:8300` atrás do Caddy). É a única
peça que enxerga a máquina inteira: serviços do host, o Admin, cada container, os runners e as
casas dos agentes (`home_host` do `/etc/dgclaw/agentes.json`). O Caddy já repassa tudo para o Web,
inclusive o cabeçalho `Authorization`, então a instalação padrão não precisa de mudança de rede.

O `panel/` (painel por agente, dentro do container) **não muda** neste PR.

## Contrato entre as duas partes

### Parte A (chaves, porteiro, tela, CLI)

- `web/lib/chaves-api.js`: loja de chaves do Web, no modelo de `panel/lib/chaves-api.js`
  (token `dgc_` + 32 bytes base64url, só o sha256 em disco, `timingSafeEqual` contra todas, revogar
  é datar, arquivo 600 com escrita atômica, relê quando muda). Diferenças: campo obrigatório
  `escopos` (array; hoje o único valor aceito é `"diagnostico"`), e `ultimoUsoEm` + `ultimoUsoIp`.
  Arquivo: `<pasta de dados do Web>/chaves-api.json`.
- Porteiro em `web/server.js` `tratar()`: se o pedido traz `Authorization: Bearer`, ele é julgado
  **só pela chave**, antes da sessão e da caixa:
  - chave válida com escopo `diagnostico` + `GET`/`HEAD` em `/api/v1/diagnostico` → chama
    `diagnostico.responder(req, res, url, { tipo: 'chave', id, nome })`;
  - qualquer outra rota ou método com Bearer → 403 com motivo em português (inclusive se houver
    cookie de sessão válido junto);
  - chave ausente, malformada, desconhecida ou revogada → 401 com motivo + como resolver;
  - limite de tentativas inválidas por IP (20 em 10 min) → 429 com motivo.
- Com sessão normal (o dono), `GET /api/v1/diagnostico` também responde (o dono vê o mesmo que o
  suporte vê).
- `GET /api/v1/diagnostico/docs.md` é público (só documentação).
- Gestão de chaves só por sessão de navegador (nenhuma chave gerencia chaves; a caixa do agente
  também não): `GET/POST/DELETE /api/v1/chaves-api`.
- Tela `/suporte` ("Suporte remoto"): mostra as chaves (nome, criada em, últimos 4, último acesso
  e IP, revogada em), cria (mostra o token uma vez com botão Copiar), revoga com confirmação, e
  mostra o diagnóstico atual renderizado ("isto é exatamente o que o suporte vê"). Texto claro de
  que a chave só lê saúde, não lê conversas nem memória, não opera nada, e que o cliente pode
  revogar quando quiser. Modo tutorial (`web/public/tour.js`). Link no menu.
- CLI no host: `dgclaw chave-api criar --escopo diagnostico --nome "<nome>"` | `listar` |
  `revogar <id>` (bash chamando `web/bin/chave-api.js`). `criar` imprime só o token no stdout.
- CHANGELOG ("Como atualizar", escrito pra pessoa) e INSTALL.

### Parte B (coletor)

- `web/lib/diagnostico/` com `criarDiagnostico(deps)` → `{ responder(req, res, url, quem), coletar() }`.
  `deps`: `{ config, registro, runner, log, exec, agora, ler }` com `exec`/`ler` injetáveis
  para teste.
- Documento `web/docs/DIAGNOSTICO-REMOTO.md` (fonte única do docs.md).
- Ferramenta do suporte `scripts/suporte/diagnostico-clientes.mjs`.

### Formato da resposta

```json
{
  "ok": true,
  "schema": 1,
  "gerado_em": "2026-10-21T12:00:00Z",
  "duracao_ms": 840,
  "versao": { "instalada": "1.0.0", "commit": "d61a138", "publicada": "1.0.1",
              "atualizacao_disponivel": true, "commits_a_frente": 4, "verificado_em": "..." },
  "resumo": { "estado": "quebrado", "frase": "1 item quebrado e 2 pedindo atenção.",
              "contagem": { "ok": 30, "atencao": 2, "quebrado": 1, "nao_medido": 3 } },
  "verificacoes": [
    { "id": "agente.tina.login", "grupo": "agente", "alvo": "tina", "nome": "Login do Claude da Tina",
      "estado": "quebrado", "ultimo_sinal": "2026-10-20T03:10:00Z",
      "motivo": "O login do Claude expirou em 20/10 às 00h10 e a Tina parou de responder.",
      "evidencia": { "horario": "...", "codigo_saida": null, "sinal": "runner:login-expirado", "ocorrencias": null },
      "o_que_fazer": "Abra a conversa da Tina no DG Claw e clique em Entrar de novo.",
      "prompt_sugerido": null }
  ]
}
```

Estados: `ok`, `atencao`, `quebrado`, `nao_medido`. `null` quer dizer "não medi" e nunca vira 0
nem `ok`. Resumo: `quebrado` se algum quebrado; senão `atencao` se algum atenção ou se tudo ficou
sem medida; senão `ok`.
