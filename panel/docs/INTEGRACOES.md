# Integrações do agente (API do painel)

O mapa de integrações mostra em quais sistemas o agente está ligado (WhatsApp, Instagram,
transcrição de áudio, OpenRouter e outros) e se cada um está funcionando. Esta página descreve
o dado e as rotas. O plano completo está em `docs/PLANO-INTEGRACOES-E-VIGIA.md`.

## De onde vem o dado

Os programas que falam com um sistema externo anotam o resultado de cada uso real, pelo comando
`dgclaw-integracao registrar <id> <resultado> [--origem uso|canal]`. O comando grava em
`<pasta do agente>/.dgclaw/integracoes/`:

- `eventos.jsonl`: uma linha por evento (`em`, `id`, `resultado`, `origem`). Nunca há texto livre.
- `estado.json`: o estado calculado de cada integração. É a fonte desta rota.
- `preferencias.json`: o que o dono desligou na tela (`{"desligadas":["id"]}`).

Resultados aceitos: `ok`, `credencial_recusada`, `sem_saldo`, `limite`, `fora_do_ar`,
`desconectado`, `rede`, `incerto`, `vencendo`, `erro`. O `id` segue `^[a-z0-9][a-z0-9-]{0,31}$`.

Uma integração entra no mapa quando aparece o primeiro evento dela e sai depois de 30 dias sem
evento. O catálogo (`templates/integracoes/catalogo.json`) só dá o nome e o ícone dos ids
conhecidos; id fora do catálogo aparece com o próprio id e o ícone `link`. O cabeçalho das skills
(`integracoes: instagram, openai`) só anota quais skills usam uma integração que já está no mapa.

## Os estados

| Estado | Palavra | Quando |
| --- | --- | --- |
| `verde` | Funcionando | o evento mais recente é `ok` |
| `amarelo` | Atenção | último evento é `rede`, `limite`, `incerto`, `vencendo` ou `erro`, ou houve uma falha grave ainda não confirmada |
| `vermelho` | Com defeito | duas falhas graves com pelo menos 2 minutos de diferença e sem `ok` depois, ou um `desconectado` |
| `desligado` | Desligado | o dono desligou na tela |
| `sem_uso_recente` | Sem uso recente | nenhum evento há mais de 7 dias (nunca aparece como verde) |

## Rotas

Todas exigem a sessão do painel (ou chave de API). As de escrita seguem a mesma proteção contra
pedido vindo de outro site que as demais.

### `GET /api/integracoes`

```json
{
  "ok": true,
  "agente": { "nome": "Meu agente", "slug": "meu-agente" },
  "integracoes": [
    {
      "id": "instagram",
      "nome": "Instagram",
      "icone": "camera",
      "estado": "vermelho",
      "palavra": "Com defeito",
      "ultimoEvento": "2026-11-17T12:00:00Z",
      "ultimoOk": "2026-11-10T09:00:00Z",
      "ultimaFalha": "2026-11-17T12:00:00Z",
      "ultimaFalhaResultado": "credencial_recusada",
      "ultimaFalhaExplica": "A senha de acesso (chave) foi recusada pelo sistema.",
      "skills": ["publicar-instagram"]
    }
  ],
  "medido": true
}
```

- Sem `estado.json` ainda: `"integracoes": []` e `"medido": true`.
- `estado.json` ilegível, acima de 64 KiB ou fora do formato: `"medido": false` e um `motivo` em
  português. Nunca vem uma lista verde nesse caso.

### `POST /api/integracoes/<id>/desligar` e `POST /api/integracoes/<id>/ligar`

Grava ou tira o `id` de `preferencias.json`. Resposta:

```json
{ "ok": true, "id": "instagram", "desligada": true }
```

Id fora do formato: HTTP 400 com `error` e `howToFix`.
