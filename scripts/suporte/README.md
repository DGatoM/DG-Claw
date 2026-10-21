# Ferramentas de suporte

## diagnostico-clientes.mjs

Consulta o diagnóstico remoto (`GET /api/v1/diagnostico`) de todos os clientes ao mesmo tempo e mostra um
relatório curto: uma linha por cliente e, embaixo, só o que não está bem, com o motivo e o que fazer.
Não precisa instalar nada além do Node 18 ou mais novo. A fonte do formato da resposta é
`web/docs/DIAGNOSTICO-REMOTO.md`.

### Preparar

1. Cada cliente cria uma chave só de leitura na tela **Suporte remoto** do painel dele (ou com
   `sudo dgclaw chave-api criar --escopo diagnostico --nome "Suporte DG"`) e manda o token para você.
2. Crie o arquivo da sua lista, com permissão restrita (a ferramenta recusa o arquivo se outras pessoas
   puderem lê-lo):

   ```bash
   mkdir -p ~/.config/dgclaw-suporte
   cp clientes.exemplo.json ~/.config/dgclaw-suporte/clientes.json
   chmod 600 ~/.config/dgclaw-suporte/clientes.json
   ```

3. Preencha `nome`, `url` e `token` (ou `token_arquivo`, o caminho de um arquivo que só tem o token, também com
   `chmod 600`).

### Usar

```bash
node scripts/suporte/diagnostico-clientes.mjs                  # todos os clientes
node scripts/suporte/diagnostico-clientes.mjs --cliente "Lucro FC"
node scripts/suporte/diagnostico-clientes.mjs --detalhe        # com evidência (sinal e categorias de erro) e prompt para o cliente colar
node scripts/suporte/diagnostico-clientes.mjs --json > hoje.json
node scripts/suporte/diagnostico-clientes.mjs --arquivo /outro/caminho.json
```

Código de saída: `0` tudo ok, `1` algum cliente com atenção ou quebrado, `2` erro de consulta (rede, chave
recusada, limite de tentativas).

A ferramenta só envia a chave para endereços `https://`. Um `http://` é recusado antes de qualquer pedido; para
testar contra a própria máquina use `--permitir-http-local`, que libera só `127.0.0.1`, `localhost` e `[::1]`. Ela
também não segue redirecionamento (um 3xx vira erro explicado), para a chave não ir parar em outro endereço.

O token nunca é impresso. Chave recusada (401) quase sempre quer dizer que o cliente revogou a chave: peça uma nova.
