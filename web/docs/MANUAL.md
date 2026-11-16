# Manual no painel

O manual do DG Claw são arquivos markdown em `docs/manual/` (o `README.md` é o índice). O Web só os lê e
mostra: nada aqui escreve em disco. O dono abre a tela em `/manual` (menu ☰ > Manual); o Admin lê os
arquivos direto da pasta e os agentes pedem pela API.

## Rotas

Todas são só de leitura (`GET` e `HEAD`; qualquer outro método responde 405).

| Rota | O que devolve |
| --- | --- |
| `GET /manual` e `GET /manual/<nome>` | A tela (exige login; sem sessão redireciona para `/login`). |
| `GET /api/v1/manual` | JSON `{ ok, indice: { titulo } \| null, paginas: [{ nome, titulo }] }`. O título é o primeiro `# ` do arquivo (sem ele, o próprio nome). |
| `GET /api/v1/manual/<nome>.md` | O markdown da página, em `text/markdown`. `README` devolve o índice. |
| `GET /api/v1/manual/docs.md` | O índice (`README.md`), **sem credencial**, como as outras `docs.md`. |

Os agentes chegam pela caixa: `dgclaw-api GET /api/v1/manual/docs.md`. A caixa libera o prefixo
`/api/v1/manual` e nenhum outro por causa do manual.

## Regras de segurança

- O nome só vale se casar com `^[a-z0-9-]+$` **e** constar da lista lida da pasta no momento do pedido
  (`excecoes.tsv` e arquivos com maiúscula não entram).
- O arquivo precisa ser regular e o caminho real dele ficar dentro da pasta do manual. Atalho para fora
  é recusado e registrado no log.
- Página inexistente: `404` com o nome pedido e o endereço da lista. Manual ausente na instalação: `503`
  dizendo qual pasta faltou e que a solução é atualizar o DG Claw.
- Colaborador: a tela e a lista seguem a regra geral (rota sem o slug do agente nasce fechada, ver
  `web/lib/escopo.js`). Só `docs.md` fica aberto, como toda documentação.

## Na tela

O markdown é renderizado no navegador (`web/public/manual.js`): todo HTML cru vira texto, links só
`http`/`https` ou páginas do manual (`x.md#ancora` vira `/manual/x#ancora`), links para outros documentos do
repositório mostram o caminho sem link, títulos têm âncora e tabelas rolam dentro delas. A busca filtra a lista
de páginas pelo título.
