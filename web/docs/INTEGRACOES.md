# Integrações com defeito (faixa e Admin automático)

Cada agente anota o resultado de cada uso real de um sistema externo (WhatsApp, Instagram, uma chave
de IA e outros). O Web lê essas anotações, abre um **incidente** quando uma integração fica vermelha e
mostra uma faixa vermelha no alto das telas. Dali o dono pede ao Admin para verificar, adia o aviso
por 1 hora ou silencia a integração. Plano completo: `docs/PLANO-INTEGRACOES-E-VIGIA.md`.

Estas rotas são **só do dono, pelo painel** (sessão do navegador). Agente em container não as
acessa (a caixa do agente recebe 403) e colaborador também não: "só o dono vê as integrações de
todos os agentes". Toda mudança (POST) exige o cabeçalho `Origin` do próprio Web, como as outras rotas.

## GET /api/v1/integracoes

Relê o estado de todos os agentes e devolve o que está na faixa agora.

```json
{
  "ok": true,
  "faixa": [{
    "id": "<id do incidente, gerado no host>",
    "agente": "luna", "agenteNome": "Luna",
    "integracao": "whatsapp", "integracaoNome": "WhatsApp",
    "categoria": "desconectado", "categoriaTexto": "a conexão caiu e precisa ser refeita",
    "abertoEm": "2026-11-17T12:00:00.000Z"
  }],
  "pedido": "texto pronto para o Admin, ou null quando a faixa está vazia",
  "automatico": {"ligado": false},
  "silenciadas": [{"agente": "luna", "integracao": "instagram"}],
  "naoMedidos": [{"agente": "ana", "agenteNome": "Ana", "motivo": "o estado.json está com o JSON quebrado"}]
}
```

- Um incidente abre quando a integração está `vermelha` e teve **tentativa real** (ou, sem ela, algum evento) nos últimos 7 dias.
  Fecha quando a integração volta ao verde, some da lista ou o agente sai do registro.
  Amarelo ou "sem uso recente" não fecha o incidente, mas ele sai da faixa.
- Um incidente por agente e integração. O id é gerado no host. Recarregar a página ou reiniciar o Web
  não duplica nada (`<DGCLAW_WEB_DATA>/integracoes/incidentes.json`, modo 0600). Se esse arquivo
  existir mas estiver ilegível, o Web guarda uma cópia em `incidentes.json.corrompido` e deixa o
  pedido automático suspenso até o dono mexer no interruptor da tela Segurança.
- O pedido ao Admin lista no máximo 9 incidentes, para caber no campo da conversa; o resto aparece
  como "e mais N integrações com defeito" e continua na faixa.
- `categoria`: `credencial_recusada` ("a chave de acesso foi recusada"), `sem_saldo` ("o saldo ou
  crédito acabou"), `fora_do_ar` ("o sistema está fora do ar"), `desconectado` ("a conexão caiu e
  precisa ser refeita") ou `outra` ("falha sem classificação").
- `naoMedidos`: agentes cujo estado não pôde ser lido com segurança. Eles não abrem nem fecham incidente,
  e nunca aparecem como "verde".
- `integracaoNome` vem do catálogo (`templates/integracoes/catalogo.json`); id fora do catálogo sai como o próprio id.

## POST /api/v1/integracoes/lembrar

Adia por 1 hora tudo o que está na faixa agora. Responde `{"ok": true, "adiados": 2}`. Passada a hora, a
faixa volta sozinha se o defeito continua.

## POST /api/v1/integracoes/silenciar e /reativar

Corpo: `{"agente": "<slug>", "integracao": "<id>"}`. O slug precisa existir no registro (e não ser o
Admin) e os dois seguem o formato de letras minúsculas, números e hífen. Silenciada, a integração não
abre incidente, não aparece na faixa e não dispara o pedido automático. `/reativar` desfaz.
Erros: 400 (formato), 404 (agente fora do registro).

## POST /api/v1/integracoes/automatico

Corpo: `{"ligado": true, "entendoORisco": true}` ou `{"ligado": false}`. Para ligar, `entendoORisco`
é obrigatório; sem ele a resposta é 400 explicando o risco. Estado em `automatico.json` (modo 0600),
desligado de fábrica.

## O pedido ao Admin

Montado pelo Web só com frases fixas e, por incidente, quatro campos controlados: o slug do agente (do
registro do host), o id da integração (só se estiver no catálogo; senão a frase "uma integração própria
do agente"), a categoria (por tabela) e o id do incidente. Nenhum texto escrito pelo agente, nenhum
nome de agente e nada vindo do provedor entra no pedido. O pedido manda o Admin começar pelo
diagnóstico de leitura que já existe, trazer a proposta como `[PEDIDO]` e não aplicar nada antes do ok do dono.

- **Manual:** "Pedir ao Admin para verificar" abre a conversa do Admin com o texto escrito; quem envia é o dono.
- **Automático (desligado de fábrica):** ligado, ao **abrir** um incidente novo (não silenciado) o Web
  entrega o pedido ao Admin pelo runner (`submit` com espera de o Admin ficar livre). Limites: um pedido por
  incidente, um a cada 6 horas por agente e integração, cinco nas últimas 24 horas no total. Pedido
  barrado por limite fica no log (nível `info`) com o motivo. Se o runner falhar, o log `erro` explica e
  o pedido não conta como enviado (e não é repetido sozinho: use o botão manual).

**Risco aceito.** O Admin tem acesso total ao servidor, e uma frase não o restringe de verdade. Como o
agente consegue escrever eventos falsos, com o automático ligado ele consegue fazer o Admin olhar
uma integração que está boa, dentro dos limites acima e sem pôr nenhuma palavra sua no pedido. É o mesmo ato
que o dono faria clicando no botão. Por isso o automático nasce desligado, a tela Segurança mostra o
aviso e pede confirmação ao ligar, e esta documentação registra o risco.

## A leitura blindada do estado

O Web roda como root e o `estado.json` é escrito pelo agente. A leitura (`web/lib/integracoes-leitura.js`):

1. parte da casa do agente que está no registro do host (nunca de dado do agente) e recusa casa de root;
2. desce `.dgclaw`, `integracoes` e `estado.json` um componente por vez, cada um aberto relativo ao
   anterior (`/proc/self/fd/<fd>/<nome>`, o equivalente a `openat`) com `O_NOFOLLOW` e `O_NONBLOCK`:
   atalho plantado no meio não desvia e FIFO não trava;
3. confere em cada descritor (`fstat`) que as pastas são pastas e o arquivo é comum, todos do UID do
   agente, e que o arquivo está dentro da casa;
4. recusa tudo se o arquivo passar de 64 KiB (nunca lê só o fim), valida o esquema (no máximo 50
   itens, ids por formato, resultados pela lista fechada) e, em qualquer falha, devolve "não medido" com um
   motivo fixo, nunca uma lista verde. Arquivo ou pasta inexistente é lista vazia (medido).

O Web não lê `preferencias.json`: "Desligar no mapa", no painel do agente, só muda o desenho do mapa. O que cala alerta e pedido ao Admin é o "Silenciar" da faixa, guardado no host.

## GET /api/v1/integracoes/docs.md

Este documento.
