# Saúde do servidor (sentinela): API do painel

A sentinela é o vigia leve do servidor. Uma vez por minuto ela confere o disco, a memória, os agentes e os
serviços, limpa o que for seguro limpar e avisa o dono (Telegram, e-mail, pulso externo, painel e Admin).
Estas rotas mostram no painel o que ela viu. O guia completo para o dono está em `docs/SENTINELA.md`, no
repositório.

Estas rotas são **só do dono, pelo painel** (sessão do navegador) e do Admin, no servidor. Agente em
container não as acessa: pela caixa do agente elas respondem 403. O Web **não mede nada e não escreve no
estado**: ele lê o arquivo `/var/lib/dgclaw/web/sentinela/estado.json`, que a sentinela (root) grava a cada
rodada, sem nenhum segredo (sem token, sem chat id, sem senha, sem endereço do pulso).

Toda leitura exige sessão. A escrita (`POST`) exige também o cabeçalho `Origin` do próprio painel.

## GET /api/v1/sentinela

Estado da última rodada. O Web confere o arquivo a cada pedido (um `stat`) e só o relê quando ele mudou.

Sentinela ainda não rodou (o arquivo não existe):

```json
{ "ok": true, "instalado": false, "motivo": "A sentinela ainda não rodou neste servidor: ..." }
```

Com estado:

```json
{
  "ok": true, "instalado": true, "idade_s": 42, "parada": false,
  "versao": 1, "atualizado_em": "2026-11-10T03:12:04-03:00", "servidor": "meudominio.com.br",
  "nivel_geral": "critico",
  "disco": [{ "ponto": "/", "usado_pct": 93.1, "livre_gb": 2.8, "total_gb": 40.0, "inodes_pct": 12.0, "nivel": "critico" }],
  "ram": { "usado_pct": 61.0, "disponivel_mb": 3100, "total_mb": 7950, "swap_pct": 4.0, "nivel": "ok" },
  "reserva": { "ligada": true, "existe": false, "tamanho_gb": 2.0, "liberada_em": "2026-11-10T03:11:58-03:00" },
  "agentes": [{ "slug": "luna", "nome": "Luna", "estado": "ok", "desde": null, "motivo": "" }],
  "servicos": [{ "nome": "dgclaw-web", "ativo": true }],
  "maiores_pastas": [{ "caminho": "/var/lib/containers", "gb": 9.8 }],
  "ultimas_acoes": [{ "em": "...", "tipo": "faxina", "descricao": "journal: liberou 820 MB", "liberou_mb": 820 }],
  "canais": { "telegram": true, "email": false, "pulso": true, "admin": true, "ultimo_envio_ok": "...", "ultima_falha": null },
  "aviso": { "seq": 17, "nivel": "critico", "titulo": "...", "corpo": "...", "em": "..." }
}
```

- `nivel_geral` e `nivel` (de cada medida): `ok`, `aviso`, `serio` ou `critico`.
- Agente: `estado` é `ok`, `caido` (não responde) ou `canal_caido` (o WhatsApp dele parou).
- `canais.*` só diz se o canal está configurado (verdadeiro ou falso), nunca o valor.
- `idade_s` é há quantos segundos o arquivo foi atualizado; `parada` fica `true` quando passa de 5 minutos
  (a sentinela deveria rodar a cada minuto: peça ao Admin para conferir o `dgclaw-sentinela.timer`).
- **Medida que não veio é `null`**, nunca `0`: `null` quer dizer "não medido".

Erros: `503` quando o arquivo existe e não dá para ler (o texto diz o caminho e o motivo); `401` sem sessão;
`403` pela caixa do agente.

## POST /api/v1/sentinela/testar

Manda um aviso de teste em cada canal configurado (Telegram, e-mail, pulso) e diz qual chegou e qual falhou.
Roda `python3 -I seguranca/sentinela/sentinela.py testar-avisos --json` no servidor, sem shell, com limite
de 60 segundos. Só um teste por vez. Corpo do pedido: nenhum.

```json
{ "ok": true, "codigo_saida": 0, "resultado": {
  "ok": true,
  "canais": { "telegram": { "configurado": true, "ok": true, "motivo": "" }, "email": {}, "pulso": {}, "admin": {} } } }
```

Em cada canal, `ok` é `true` (chegou), `false` (falhou, com o `motivo`) ou `null` (canal não configurado).
`codigo_saida`: 0 algum aviso chegou, 1 nenhum chegou, 2 nenhum canal está configurado.

Erros: `409` já há um teste rodando; `502` a sentinela não devolveu um resultado legível (o texto traz o
começo da mensagem de erro dela); `503` o motor não está instalado (atualize o DG Claw); `504` passou de 60
segundos.

## GET /api/v1/sentinela/docs.md

Este documento.

## Avisos no celular

Quando o `aviso.seq` do estado aumenta, o Web manda um aviso ao celular (veja `GET /api/v1/push/docs.md`),
com o título e até 300 caracteres do corpo; no nível crítico o aviso exige toque para sumir, e o toque leva a
`/seguranca#saude-servidor`. O último `seq` visto fica em `/var/lib/dgclaw/web/sentinela/push.json`. Na
primeira leitura o Web só guarda o número, sem mandar nada, para reiniciar o painel nunca disparar aviso
velho.

## Faixa e cartão

Também aparece uma faixa laranja quando a vigia parou de atualizar (`parada: true`): sem ela não sai nenhum alarme. Também é recolhível por 1 hora. Com `instalado: false` (instalação nova que ainda não rodou) não há faixa.

Em todas as telas aparece uma faixa quando o nível geral é `serio` ou `critico`, ou quando algum agente está
fora do ar: vermelha no crítico (não some), laranja no sério (pode ser recolhida por 1 hora neste aparelho).
O cartão "Saúde do servidor" fica na tela Segurança e tem o botão **Testar avisos**.
