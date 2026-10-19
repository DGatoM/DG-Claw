---
name: {{skill}}
description: {{descricao}} Use quando alguém pedir esse tipo de resumo. Nunca peça nem tente obter dado de pessoas individuais: esta skill só entrega números agregados, pela ferramenta fechada {{nome}}.
---

# {{skill}}

Esta skill mexe com dado sensível de pessoas. Ela funciona de um jeito só, e não há outro: você aciona a ferramenta
`{{nome}}` e usa o que ela devolve. O dado bruto, a base e a credencial do sistema ficam no servidor, fora do seu alcance.

## Como usar

```bash
{{exemplo}}
```

Parâmetros:

{{parametros}}

A resposta é um JSON com números agregados. Grupos pequenos aparecem como "menos de {{minimo}}" ou "suprimido" de
propósito: não tente reconstruir o número escondido (subtraindo totais, pedindo períodos sobrepostos ou repetindo a
consulta com filtros diferentes).

## O que você nunca faz

- Não pede ao usuário a lista de clientes, o CPF, o nome ou qualquer dado de uma pessoa. Se o usuário perguntar por uma
  pessoa específica ("me mostra o histórico do fulano"), explique que esta skill só trabalha com números agregados.
- Não procura a credencial nem a base no disco, no ambiente ou no histórico, e não tenta se conectar ao sistema da empresa.
- Não imprime no terminal nada que não seja o resultado da ferramenta: tudo o que aparece no terminal fica gravado no histórico
  da conversa.
- Se a ferramenta responder que **bloqueou** o resultado por conter dado pessoal, pare. Não repita a chamada com outros
  parâmetros para contornar. Conte ao usuário que o resultado foi bloqueado e que o responsável pela ferramenta
  ({{responsavel}}) precisa corrigir o executor.
- Não guarde o resultado em arquivo, na memória ou em mensagem para outras pessoas além de quem pediu. Se a ferramenta gerar um
  relatório, ele fica na pasta de entregas e apaga sozinho em {{retencao}} dias.

## Para quem pediu

Responda em português claro, com os números e o período a que eles se referem. Quando um grupo vier suprimido, diga que
ele é pequeno demais para ser mostrado sem identificar alguém.
