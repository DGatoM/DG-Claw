# Ficha da ferramenta {{nome}}

Insumo para o relatório de impacto à proteção de dados (RIPD) e para o registro das operações de tratamento da empresa.
Gerada de `ferramenta.json` por `dgclaw ferramenta ficha {{nome}}`. Revise com o jurídico antes de arquivar.

| Item | Conteúdo |
| --- | --- |
| Ferramenta | `{{nome}}` |
| O que faz | {{descricao}} |
| Finalidade | {{finalidade}} |
| Base legal | {{base_legal}} |
| Campos da base que a ferramenta lê | {{campos}} |
| Agentes autorizados | {{agentes}} |
| Responsável | {{responsavel}} |
| Retenção de relatório gerado | {{retencao}} dias na pasta de entregas do agente, depois apagado automaticamente |
| Grupo mínimo | {{minimo}} pessoas: grupos menores aparecem como "menos de {{minimo}}" |
| O que o agente recebe | Resultado agregado, conferido pelo verificador de saída (CPF, CNPJ, e-mail, telefone, data de nascimento, cartão e nomes da base são bloqueados) |
| O que o agente não recebe | O dado bruto, a base e a credencial do sistema da empresa |
| Registro de acesso | Cada uso entra na trilha de auditoria (`ferramenta_usada`): agente, dono, parâmetros, registros lidos, hash do resultado e decisão do verificador |

## Pontos de atenção

- Dado pseudonimizado continua sendo dado pessoal. Os pseudônimos usam uma chave da empresa e só valem dentro da ferramenta.
- Resultado agregado com grupo pequeno pode identificar pessoas. O mínimo acima precisa ser revisto se a base for pequena.
- O texto do resultado fica no histórico da conversa do agente, que segue a retenção geral do servidor (`retencao_dias`).
