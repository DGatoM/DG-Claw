# Modo escondido (o olhinho 👁)

Um botão no cabeçalho da conversa web. Ligado, ele troca por asteriscos os dados sensíveis de todas as
mensagens da tela: nome de pessoa e de empresa, valor em dinheiro, e-mail, telefone, CPF, CNPJ, chave de
API e id longo. Serve para o dono mostrar a tela numa aula ou palestra sem expor cliente.

## Como funciona

1. **Filtro automático, na tela, na hora.** E-mail, `R$` e "reais", CPF, CNPJ, telefone brasileiro, chave
   (`sk-...`, `ghp_...`), bloco de 32 caracteres ou mais e número de 12 dígitos ou mais. Não depende de
   servidor nem de modelo.
2. **Modelo de IA, para o resto.** A tela manda o texto das mensagens para `POST /api/v1/sigilo`. O modelo
   não reescreve nada: devolve só a lista dos trechos exatos a esconder (nomes e empresas, principalmente).
   Cada trecho apontado some em todo lugar da tela onde aparece (outras mensagens, citações, nomes de
   arquivo). Um nome achado numa mensagem some de todas.
3. **Falha fechada.** Enquanto uma mensagem não foi analisada, aparece "🔒 escondendo…" no lugar do texto.
   Se o modelo falhar naquela mensagem, ela continua coberta, com um aviso do que houve. O texto cru nunca é
   pintado, nem por um quadro, e recarregar a página com o modo ligado também não mostra nada cru (o estado
   fica guardado no aparelho e vale para todos os agentes).
4. **Revelar.** Tocar num texto escondido mostra só aquela mensagem, e aparece "🙈 esconder de novo".
5. **Mídia.** Foto, vídeo e miniatura de mensagem escondida ficam borrados. A prévia no Compartilhados e o
   visor também.

O modelo vem da primeira chave que existir no `web.env`: `ANTHROPIC_API_KEY` (Claude Haiku,
`claude-haiku-4-5`) ou `OPENAI_API_KEY` (`gpt-4.1-mini`). Sem nenhuma das duas, só o filtro automático
funciona, e a tela mostra um aviso fixo: "Só o filtro automático: nomes passam." Para ligar o completo, peça
ao Admin: "liga o modo escondido completo". Ele copia a chave do cofre para o `web.env` (e reinicia o Web).

## Variáveis (web.env)

| Variável | Para que serve |
|---|---|
| `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` | Liga o modelo. A Anthropic tem prioridade. |
| `DGCLAW_SIGILO_MODELO` | Troca o modelo. Mudar o modelo invalida o cache. |
| `DGCLAW_SIGILO_LIBERADOS` | Nomes que nunca são escondidos, separados por vírgula (o seu nome, por exemplo). |

Os nomes liberados também incluem, sem configurar nada, o campo `dono` e o `nome` e o `slug` de cada agente do
`agentes.json`, e plataformas comuns (DG Claw, Claude, Anthropic, OpenAI, ChatGPT, Telegram, WhatsApp, Google,
GitHub e outras). A comparação ignora maiúsculas.

## A rota

`POST /api/v1/sigilo`, só com login e com `Origin` do próprio site (como as outras rotas de escrita).

```bash
curl -s -X POST https://SEU-SITE/api/v1/sigilo \
  -H 'Content-Type: application/json' -H 'Origin: https://SEU-SITE' -b cookie.txt \
  -d '{"textos":["A Maria Souza pagou R$ 1.997","Bom dia"]}'
```

```json
{"ok":true,"trechos":[["Maria Souza","Maria"],[]],"avisos":[],"analisados":2,
 "modelo":"claude-haiku-4-5","so_regex":false}
```

- Até 600 textos por chamada. Entrada errada responde 400 com o motivo em português.
- `trechos` vem na mesma ordem. `null` quer dizer que o modelo falhou naquele texto (o motivo está em `avisos`).
- Sem chave: `trechos` vazios, `so_regex: true`, `modelo: null` e um aviso explicando como ligar.
- `GET /api/v1/sigilo/estado` diz qual modelo está ativo sem analisar nada. A API para agentes está em
  `GET /api/v1/sigilo/docs.md`.

Os lotes têm 12 textos, até 8 em paralelo. Lote que falha tenta mensagem por mensagem. Cada chamada tem
tempo limite, e o log diz o que falhou sem nunca registrar o texto das mensagens nem a chave.

## Cache

O resultado de cada texto fica em `<DGCLAW_WEB_DATA>/sigilo-cache.json` (permissão 600, gravado de forma
atômica). A chave do cache mistura o texto com o modelo e com o prompt, então trocar qualquer um dos dois
reanalisa tudo. Cache ilegível é registrado no log e recomeça vazio. Ligar o modo de novo não reprocessa o que
já foi visto.

## Limites conhecidos

- É uma defesa, não uma garantia. O modelo pode deixar passar um nome, e o filtro automático não conhece todo
  formato de dado. Confira a tela antes de gravar ou compartilhar.
- Só com o filtro automático (sem chave de modelo), nomes de pessoas e de empresas passam.
- O texto dentro de imagem, de PDF e de visual não é lido: a mídia fica borrada por inteiro, sem análise.
- O modelo recebe o texto das mensagens da tela, então o provedor escolhido passa a ver esse texto.
- O endereço dos links (`href`) e o texto alternativo das imagens não são alterados. O texto visível do link é.
- A faixa de atividade ("Ana está fazendo...") fica borrada enquanto o modo está ligado.

## Versão enterprise: sem enviar texto para fora

Nos níveis `escritorio`, `empresa` e `regulado` a proteção `sigilo_externo` fica desligada, e o modo escondido
**não manda texto da conversa para nenhum serviço**, mesmo que exista `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` no
`web.env`. Fica só o filtro automático da tela (e-mail, valor, CPF, telefone, chave), e a tela mostra o aviso de que
nomes de pessoas e empresas passam, porque escondê-los exige um modelo rodando neste servidor (esta versão ainda não
inclui). `GET /api/v1/sigilo/estado` devolve `bloqueado_por: "sigilo_externo"`. A leitura é feita a cada chamada, então
`dgclaw nivel ajustar sigilo_externo true` (permitido em `escritorio` e `empresa`; no `regulado` a chave é travada)
vale sem reiniciar o Web. No nível `pessoal` nada muda. Código: `web/lib/ent/sigilo.js`.
