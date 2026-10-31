# Contrato: resultado da ronda de fábrica (DG Claw), versão 1

Arquivo: `/var/lib/dgclaw/web/seguranca/ronda.json` (escrito pelo root, atômico, legível pelo DG Claw Web).
Escreve: `seguranca/ronda/ronda.py` (motor). Lê: `web/lib/ronda-painel.js` (painel e API).

```json
{
  "versao": 1,
  "rodada_em": "2026-10-31T10:00:00Z",
  "proxima_em": "2026-10-31T16:00:00Z",
  "parcial": false,
  "fontes": [{"nome": "OSV.dev", "ok": true, "motivo": null}],
  "inventario": {
    "componentes": 1234, "kernel": "6.8.0-147-generic",
    "portas_publicas": [{"porta": 443, "processo": "caddy", "pacote": "caddy"}],
    "servicos_externos": [{"nome": "Notion", "via": "MCP do agente luna", "pacote": "@notionhq/notion-mcp-server", "versao": "1.2.3"}],
    "reinventariado_em": "2026-10-30T10:00:00Z"
  },
  "achados": [{
    "id": "UBUNTU-CVE-2026-98432", "aliases": ["CVE-2026-98432"],
    "nivel": 2,                        // 1 aplicada sozinha | 2 crítica que pede decisão | 3 leve/média
    "severidade": "HIGH",              // CRITICAL | HIGH | MEDIUM | LOW | desconhecida
    "nome_simples": "Falha no kernel Linux (rede TCP IPv4)",
    "componente": "kernel Linux",
    "publicado_em": "2026-10-15T00:00:00Z",
    "fonte_url": "https://ubuntu.com/security/CVE-2026-98432",   // obrigatório, https
    "noticia_url": null,
    "onde": ["kernel 6.8.0-147 em execução"],
    "o_que_faz": "texto curto do resumo oficial (dado externo, não confiável)",
    "como_corrigir": "texto curto",
    "correcao": {"tipo": "acao-catalogo", "acao_id": "sysctl-mptcp-off", "exige_reinicio": false, "disponivel": true},
                                       // tipo: acao-catalogo | atualizar-dgclaw | apt | nenhuma
    "estado": "aberto",                // aberto | aplicado-sozinho | aplicado-pelo-dono | mitigado | agendado
    "aplicado": null,                  // {"em", "acao_id", "antes", "depois", "desfazer"} quando aplicado
    "primeira_vez_em": "2026-10-31T10:00:00Z"
  }],
  "ja_tratadas": [{"id": "GHSA-...", "componente": "Pillow", "como": "corrigido na versão instalada"}]
}
```

Pedidos do dono (o Web não é root e não executa nada): o Web grava um arquivo em
`/var/lib/dgclaw/web/seguranca/pedidos/<uuid>.json` com
`{"tipo": "aplicar"|"agendar"|"emergencia-cortar"|"emergencia-religar", "id": "<achado>", "quando": "<ISO>|null", "codigo": "<codigo de confirmacao>|null", "pedido_em", "por": "<usuario do painel>"}`.
Uma unidade systemd `.path` (root) vê o arquivo e roda `dgclaw seguranca pedido <arquivo>`, que valida TUDO de novo
(achado existe em ronda.json, ação está no catálogo `seguranca/acoes-permitidas.json`, código de emergência confere e não expirou),
executa, grava o resultado em `pedidos/feitos/<uuid>.json` (`{"ok", "mensagem", "feito_em"}`) e apaga o pedido.
Nunca há comando livre no pedido.

## Acréscimos do painel (opcionais, versão 1)

Tipos de pedido novos, além de `aplicar`, `agendar`, `emergencia-cortar` e `emergencia-religar`:

- `"emergencia-preparar"`: o root roda `dgclaw emergencia preparar --json` e grava a saída em `dados` do resultado.
- `"desfazer"`: `id` é o do achado com `estado: "aplicado-sozinho"` e `aplicado.desfazer` preenchido.

`codigo` (já previsto) vale para `emergencia-cortar` e `emergencia-religar`; o executor roda
`dgclaw emergencia cortar --codigo <codigo>` / `religar --codigo <codigo>` (a frase TIRAR-DO-AR / RELIGAR é conferida pelo Web, antes de gravar o pedido).
`por` vai ao script como `EMERGENCIA_QUEM=<por>` (só `[A-Za-z0-9._@-]`) para ficar no log.

Resultado do pedido (`pedidos/feitos/<uuid>.json`), campo novo opcional: `"dados": {...}` (objeto). Para
`emergencia-preparar` é a saída de `dgclaw emergencia preparar --json`:
`{"acao": "cortar"|"religar", "codigo", "expira_em", "valido_s", "plano": {...}}`.
`ok: false` leva a `mensagem` com o erro do script (stderr), em português.

Estado da emergência para a tela: `/var/lib/dgclaw/web/seguranca/emergencia.json`, gravado por `lib/emergencia.sh`
a cada `estado`, `simular`, `preparar`, `cortar`, `confirmar` e `religar`:
`{"versao":1,"atualizado_em","disponivel":bool,"motivo":"","avisos":[],"estado":{"cortado",...},"plano":{...}}`.
O motor precisa agendar `dgclaw emergencia estado` (timer de 10 min e depois de cada ronda) para a tela não ver estado velho.

`ronda.json` campos opcionais lidos pela tela: `vigia_alerta` (`{"quando","motivo"}` ou null) e `achado.decisao` (`"ciente"` etc., ignorado se ausente).

## Acréscimos do motor (opcionais, versão 1)

- `ronda.json`: `vigia_alerta` está sempre presente (`null` ou `{"quando", "motivo", "esperada_para"}`); `ultima_falha` (`{"em", "motivo"}`) aparece quando a última rodada não terminou bem;
  `inventario.acrescentados` é a lista de frases "acrescentado à ronda em DD/MM/AAAA: Notion via MCP do agente luna" (as 10 mais recentes);
  achado com KEV leva `explorada_ativamente: true`; achado `agendado` leva `agendado_para` (ISO).
- `achado.aplicado` leva também `registro` (nome do arquivo em `/var/lib/dgclaw/seguranca/acoes/`), `por` e `exige_reinicio_agora`; `desfazer` é o texto de como voltar atrás.
- `achado.correcao.exige_reinicio` só existe quando o motor sabe (`acao-catalogo`, e `apt` de kernel); ausente quer dizer "não sabido", nunca `false` por padrão.
- `pedidos/feitos/<uuid>.json` leva `dados` só nos pedidos que devolvem um objeto (`emergencia-preparar`).
- Pedido: `por` só aceita `[A-Za-z0-9._@-]` (até 64); fora disso o pedido é recusado.
- `ja_tratadas[].registro` (opcional): presente quando a ação foi aplicada pela ronda ou pelo dono; o pedido `desfazer` com o `id` dele continua valendo depois que o achado saiu da lista de `achados`.
