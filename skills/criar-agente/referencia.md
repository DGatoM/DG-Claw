# Criar agente: detalhes

Complemento da skill `criar-agente`. O que está aqui o Admin consulta quando precisa.

## Parâmetros de `dgclaw agente criar`

| Parâmetro | Valores | De onde vem |
|---|---|---|
| `<slug>` | minúsculas, sem acento, hífen | gerado do nome (passo 2) |
| `--nome` | texto | passo 2 |
| `--provedor` | `claude` ou `codex` | passo 4 (padrão: o do Admin) |
| `--auth` | `assinatura` ou `api` | passo 4 (padrão: `assinatura`) |
| `--papel` | frase curta | passo 1 |
| `--jeito` | frase curta | passo 3 |
| `--dono` | nome do dono | passo 3 |
| `--canal` | `chat`, `telegram` ou `whatsapp` | passo 5 |

## Onde ficam as coisas

O registro dos agentes é `/etc/dgclaw/agentes.json`. Ele lista, para cada agente, o endereço local
do runner, o arquivo do token e a pasta da casa. O registro não guarda nenhum segredo, só os caminhos.
O token de cada agente fica em arquivo próprio com permissão restrita.

## Teste real, em detalhe

- O envio é `POST <runner>/api/agents/<slug>/input` com `{"text":"...","submit":true}`.
- A leitura é `GET <runner>/api/agents/<slug>/conversation`.
- Resposta 401 quer dizer token errado ou arquivo errado: o Admin confere o caminho no registro.
- `GET <runner>/api/saude` responde sem token e serve para saber se o agente está de pé.

## Quando a imagem demora

A primeira construção da imagem leva alguns minutos e acontece em segundo plano. O Admin confere com
`dgclaw imagem status`. Enquanto não termina, nenhum agente novo pode ser criado.
