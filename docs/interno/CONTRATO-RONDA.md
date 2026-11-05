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
    "correcao": {"tipo": "acao-catalogo", "acao_id": "sysctl-mptcp-off", "exige_reinicio": false, "disponivel": true, "executavel": true},
                                       // tipo: acao-catalogo | atualizar-dgclaw | apt | nenhuma
                                       // disponivel: o fabricante já publicou a correção
                                       // executavel: true só para acao-catalogo válida no catálogo (o executor recusa o resto)
    "estado": "aberto",                // aberto | aplicado-sozinho | aplicado-pelo-dono | mitigado | agendado
                                       // | protegido-aguardando | aguardando-fornecedor (veja "Sem correção instalável")
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

## Contrato de id dos achados

O id de um achado é sempre em **MAIÚSCULAS** em tudo o que o motor grava: `ronda.json` (`id` e `aliases`), o estado, os
recados e os pedidos. O OSV e o GitHub escrevem `GHSA-aaaa-bbbb-cccc` em minúsculas; o motor converte ao gravar.
O painel (`web/lib/ronda-painel.js`) aceita maiúsculas e minúsculas na entrada (arquivo e rotas da API), normaliza para
maiúsculas antes de comparar ou de gravar o pedido, e o executor compara em maiúsculas. Formato: letras, números, ponto,
hífen e sublinhado, de 3 a 61 caracteres. Os boletins (`boletins.json`) têm contrato próprio, só com maiúsculas.

## `correcao.executavel`

`correcao.disponivel` diz que existe correção publicada; `correcao.executavel` diz que o painel pode mandar o root
aplicá-la ou agendá-la. Só vale `true` quando o motor casou uma `acao-catalogo` válida (é a única que `acao_do_achado`
aceita). Para `apt` sem ação no catálogo, `atualizar-dgclaw` e `nenhuma`, vale `false`: a API responde `409` em
`aplicar` e `agendar`, e a tela troca os botões por "Pedir ao Admin", que abre a conversa do Admin com o pedido escrito
("Quero aplicar a correção de segurança <id> (atualização do pacote <pacote>). Analise antes e me diga se vai reiniciar
algum serviço."). `ronda.json` antigo, sem o campo, vale como `false`.

## Acréscimos do painel (opcionais, versão 1)

Tipos de pedido novos, além de `aplicar`, `agendar`, `emergencia-cortar` e `emergencia-religar`:

- `"emergencia-preparar"`: o root roda `dgclaw emergencia preparar --json` e grava a saída em `dados` do resultado.
- `"desfazer"`: `id` é o do achado com `estado: "aplicado-sozinho"` ou `"protegido-aguardando"` e `aplicado.desfazer` preenchido.

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
  `memoria_pico_mb` (inteiro, MB) é o pico de memória do processo da rodada; `vigia_alerta` pode vir de um vigia em modo econômico, que não refaz a rodada;
  `inventario.acrescentados` é a lista de frases "acrescentado à ronda em DD/MM/AAAA: Notion via MCP do agente luna" (as 10 mais recentes);
  achado com KEV leva `explorada_ativamente: true`; achado `agendado` leva `agendado_para` (ISO).
- `achado.aplicado` leva também `registro` (nome do arquivo em `/var/lib/dgclaw/seguranca/acoes/`), `por` e `exige_reinicio_agora`; `desfazer` é o texto de como voltar atrás.
- `achado.correcao.exige_reinicio` só existe quando o motor sabe (`acao-catalogo`, e `apt` de kernel); ausente quer dizer "não sabido", nunca `false` por padrão.
- `pedidos/feitos/<uuid>.json` leva `dados` só nos pedidos que devolvem um objeto (`emergencia-preparar`).
- Pedido: `por` só aceita `[A-Za-z0-9._@-]` (até 64); fora disso o pedido é recusado.
- `ja_tratadas[].registro` (opcional): presente quando a ação foi aplicada pela ronda ou pelo dono; o pedido `desfazer` com o `id` dele continua valendo depois que o achado saiu da lista de `achados`.

## Sem correção instalável: estados novos e `paliativo` (opcionais, versão 1)

Aditivo: `ronda.json` antigo continua válido, e quem não conhece os estados novos os trata como `aberto`.

**O apt decide se a correção existe.** A versão corrigida que o aviso cita pode ser de outra série de kernel (o aviso diz
`7.0.0-31.31` num servidor 24.04 que só vê `6.8.0-147`). A cada rodada o motor faz UMA consulta `apt-cache policy` (em lotes de
200 nomes) e compara o `Candidate` com a versão corrigida (`cmp_dpkg`):

- kernel: vale o maior candidato entre os metapacotes de kernel instalados (os de source `linux-meta*`, como
  `linux-image-virtual`), guardados em `inventario.json` como `metapacotes_kernel`. Os binários `linux-modules-<abi>` não servem,
  porque o ABI vai no nome e o candidato deles nunca muda. Versão de metapacote no formato antigo (`5.15.0.91.88`) é
  normalizada para `5.15.0-91.88` antes de comparar.
- outros pacotes do Ubuntu: os candidatos dos binários do afetado (`afetados[].binarios`).
- resultado `True` (instalável), `False` (o apt oferece, mas versão menor) ou `None` (sem `apt-cache`, erro, `Candidate: (none)`,
  nenhum metapacote). `None` mantém o comportamento antigo: confia no aviso. Só `False` muda algo.

Com `False`, a correção vira `{"tipo": "nenhuma", "disponivel": false, "executavel": false, "versao_no_aviso": "7.0.0-31.31"}`;
`versao_no_aviso` (opcional) é só para o texto.

**Estados novos de `estado`** (para achados de nível 2 e 3 que hoje seriam `aberto`):

| Estado | Quando | Pede alguma coisa? |
| --- | --- | --- |
| `protegido-aguardando` | sem correção instalável e existe um paliativo do catálogo **verificado agora** | não |
| `aguardando-fornecedor` | sem correção instalável e nenhum paliativo conhecido | não |

Exceção: achado `explorada_ativamente` (KEV) sem correção e sem paliativo verificado nem oferecido fica `aberto`, com o texto
dizendo que vale considerar o botão de emergência ou falar com o Admin. Achado de pacote do próprio DG Claw com correção na origem
segue como antes (a equipe do DG Claw avisa por boletim).

**Campo opcional `paliativo`**, presente sempre que um paliativo do catálogo `seguranca/paliativos.json` casa com o achado:
`{"id", "descricao", "efeito", "verificado": bool, "verificado_em": ISO|null, "acao_id": str|null}`.
`verificado` é a leitura de verdade do sistema nesta rodada (por exemplo `sysctl -n`), não importa quem configurou.

Regras da rodada:

1. correção instalável (apt `True`/`None`, ação do catálogo que não é paliativo, `atualizar-dgclaw`): `aberto`, como sempre. Se houver
   paliativo verificado, o texto diz que a proteção provisória está ativa enquanto isso.
2. sem correção instalável e paliativo verificado: `protegido-aguardando`.
3. sem correção instalável, paliativo casado e **não** verificado, com `acao_id`: `aberto`, com
   `correcao = {"tipo": "acao-catalogo", "acao_id", "exige_reinicio": false, "disponivel": true, "executavel": true, "paliativo": true}`
   (o painel oferece Aplicar). Com `DGCLAW_RONDA_APLICAR_SOZINHA` ligado e `pode_sozinho: true`, a ronda aplica na hora, com o mesmo
   teste de saúde do nível 1, e o achado sai `protegido-aguardando` com `aplicado` preenchido (dá para desfazer).
4. sem correção instalável e sem paliativo: `aguardando-fornecedor` (ou `aberto` se KEV).

**Paliativo nunca é tratamento.** Aplicado (sozinho ou pelo dono), o registro interno fica `aberto` e o achado é reavaliado a
cada rodada. Quando o pacote corrigido chega ao apt, volta a `aberto` pedindo atualizar (e reiniciar, no kernel), com `avisado_em`
zerado: o Admin recebe o recado e o aviso do painel trata como ponto novo. Quando a proteção deixa de ser verificada (alguém voltou
o `sysctl`), volta a `aberto` com a oferta de Aplicar. A ação de catálogo com `"paliativo": true` não é devolvida como correção
definitiva por `acao_do_catalogo`.

`protegido-aguardando` e `aguardando-fornecedor` ficam fora do recado ao Admin (`novos`) e fora da contagem por nível de
`dgclaw seguranca estado` (que mostra `aguardando_correcao: {"total", "protegidos"}` à parte). O pedido `desfazer` e a rota
`POST /ronda/<id>/desfazer` aceitam `protegido-aguardando` com `aplicado.desfazer` preenchido.
