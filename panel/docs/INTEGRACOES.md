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
- `preferencias.json`: o que o dono desligou na tela (`{"desligadas":["id"]}`). Só muda o mapa: não cala o alerta nem o pedido ao Admin (isso é o "Silenciar" da faixa, guardado no host).

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

Id fora do formato: HTTP 400 com `error` e `howToFix`. `desligar` de um id que o mapa não conhece:
HTTP 404. Lista que passaria de 64 KiB: HTTP 413, e o arquivo anterior fica intacto. `ligar` aceita
qualquer id que esteja na lista, mesmo que ele tenha sumido do mapa. `preferencias.json` ilegível:
HTTP 409, sem sobrescrever.

## A tela (aba Integrações)

A aba fica no grupo Ferramentas do painel, com o ícone `link`. Ela é desenhada por
`public/js/integracoes.js` e `public/css/integracoes.css`, e consome só a rota `GET /api/integracoes`
(e as de ligar e desligar). Quem decide a cor é o servidor; a tela apenas desenha.

- **Topo:** a frase-resumo ("Ligado em 6 sistemas · 1 com defeito", ou o convite quando ainda não há
  nenhum sistema) e o alternador **Estado real** / **Modo aula**. O modo aula mostra só os nós em
  verde e nunca pinta de verde o que não está. O botão Tutorial é o do cabeçalho do painel.
- **O mapa:** a foto do agente no centro (sem foto, a inicial sobre o acento) e um nó por integração,
  em constelação. Cada nó é um círculo com o ícone do sprite, o nome e, menor, a palavra do estado.
  A ligação é uma linha reta do centro ao nó, de 1,5 px. Os nós ficam a distâncias um pouco
  diferentes: o raio varia até 12% para cada lado por um hash do id (o desenho não muda a cada
  visita) e os ângulos são distribuídos igualmente, a partir do topo, com um pequeno desvio também
  por hash. Cabem 12 nós no primeiro anel; acima disso, o resto vai para um segundo anel.
- **Cores (só tokens do design system):** verde `--cor-sucesso`, amarelo `--cor-aviso`, vermelho
  `--cor-perigo`; desligado e sem uso recente usam `--cor-texto-2`. Desligado tem linha tracejada e
  não tem pulso. Tema claro e escuro funcionam sem regra extra.
- **O pulso:** um ponto com brilho leve anda pela reta. Verde: do nó ao centro e de volta, a cada
  2,6 s. Amarelo: mais lento, 4 s. Vermelho: o ponto sai do nó, para no meio da linha e some, e a
  linha pisca devagar. Cada nó tem uma defasagem própria. Sem pulso quando desligado ou sem uso
  recente. O movimento pausa com a aba do navegador escondida e some com "reduzir movimento" (ficam
  só a cor e a palavra).
- **O cartão:** tocar num nó (ou Enter e Espaço com o teclado) abre ao lado, no computador, ou
  embaixo, no celular: nome, palavra, "Última vez que funcionou", "Último problema" (a explicação em
  português e quando), "Quais skills usam" e o botão **Desligar no mapa** / **Ligar no mapa**, que chama
  `POST /api/integracoes/<id>/desligar` ou `/ligar` e recarrega.
- **Celular (até 600 px):** o desenho some. Abaixo da foto do agente, os nós viram uma lista com a
  bolinha colorida, o ícone, o nome e a palavra, sem rolagem para o lado e com alvos de toque de
  44 px.
- **Quando não dá para medir:** com `"medido": false` a tela mostra o motivo que a API mandou num
  aviso, e nunca o mapa. Erro de rede mostra a causa e o que fazer.
- **Atualização:** a tela se recarrega a cada 30 segundos enquanto está à vista, e só refaz o
  desenho se algo mudou.
- **Segurança:** todo texto da API entra por `textContent` ou `setAttribute`, nunca por HTML montado
  com dado. A classe de cor sai de uma tabela do código indexada pelo `estado`, e o ícone, de uma
  lista do código (nome fora dela vira `link`). O teste `panel/test-integracoes-tela.mjs` confere
  o layout, as duas tabelas e a ausência de HTML montado.
- **Tutorial:** o tour da página mais o "?" do mapa, do resumo e do cartão (em
  `public/js/tutoriais.js`), cada passo dizendo o que é, como a cor é calculada e por que está ali.
