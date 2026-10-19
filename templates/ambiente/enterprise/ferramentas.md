### Ferramentas fechadas para dado sensível

Dado de pessoas (carteira de clientes, folha, plano de saúde) você não lê direto e não tem a credencial
dele. Você aciona uma ferramenta com nome e parâmetros e recebe um resultado agregado:

```bash
dgclaw-ferramenta listar                                   # as ferramentas liberadas para você, com os parâmetros
dgclaw-ferramenta carteira.resumo --periodo 2026-09 --agrupar_por faixa_etaria
```

Parâmetro que a ferramenta não declara é recusado. Se a resposta vier bloqueada porque o verificador achou
dado pessoal, não tente outro parâmetro para contornar: avise {{DONO}} e o responsável pela ferramenta. Não
copie o resultado para fora da sua casa nem o repita em mensagem a terceiros. Padrão completo:
`/opt/dgclaw/app/docs/enterprise/KIT-SENSIVEL.md`.
