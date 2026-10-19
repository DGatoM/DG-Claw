# Personalizações do meu DG Claw

Este arquivo é o caderno das mudanças que foram feitas no seu DG Claw a pedido seu. Ele fica fora do
programa, então a atualização oficial não o apaga, e entra no backup do Admin. É por ele que o
`dgclaw atualizar` descobre o que você personalizou, confere se a versão nova esbarra em alguma mudança e
diz como testar cada uma depois.

O Admin escreve uma entrada por personalização, no modelo abaixo. Para entender o procedimento completo,
leia `/opt/dgclaw/app/docs/PERSONALIZAR.md`.

Como preencher:

- **Arquivos:** caminhos a partir da raiz do repositório, entre crases. Mudanças feitas só pela casa de um
  agente ou pelas habilidades do Admin também entram, com os caminhos de lá. O comando ignora o que não é
  do repositório.
- **Situação:** `ativa`, `desfeita` ou `absorvida pela versão oficial em AAAA-MM-DD`.

O modelo de uma entrada (o que está dentro do bloco abaixo é só exemplo e não conta como registro):

```
## 2026-10-19 - Botão "Resumo do dia" na conversa
- Pedido: (o que você pediu, nas suas palavras)
- Arquivos: `web/public/conversa.js`, `web/public/conversa.css`
- Commit: abc1234
- Por quê: (o motivo, em uma frase)
- Como testar: (passo a passo curto que qualquer pessoa repete)
- Situação: ativa
```

As entradas reais começam logo abaixo desta linha, uma depois da outra.

