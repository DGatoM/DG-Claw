# Mídias, links e arquivos

Toque na foto ou no nome do agente. A lista guardada no aparelho aparece primeiro;
as novidades chegam em segundo plano, sem refazer a lista a cada abertura.

O IndexedDB guarda somente metadados por conta, agente e aba. São até 600 itens
por aba por 30 dias; o restante continua acessível pelo cursor. Sair limpa o
cache da conta. Se o navegador não permitir IndexedDB, a lista funciona com
cache em memória e avisa que não será persistida. Erros de rede conservam os
itens já carregados; erro de autenticação retira o conteúdo daquela aba.

A carga inicial vem em páginas de 20, até 60 itens ou 30 dias. Role ou use
Carregar anteriores para continuar. Fotos e vídeos usam JPEGs de até 320 pixels
com lazy-load. O servidor gera e guarda miniaturas por versão do arquivo com
ffmpeg no host, instalado pelo `install.sh`, duas de cada vez. Falha de geração mostra o ícone e uma resposta
explicativa; nunca devolve o original na rota de miniatura.

## API para agentes

Requer a mesma sessão autenticada das outras APIs do Web.

`GET /api/v1/agents/<id>/compartilhados?tipo=midias|links|docs&limite=20`

Resposta: `itens`, `proximo` (cursor opaco ou null), `recente` (checkpoint),
`total:null`, `parcial:true` e `avisos`. Cada item tem chave estável, epoch,
mensagem de origem e metadados da mídia ou URL. A fonte é a conversa que o
leitor do agente disponibiliza, tanto Claude quanto Codex.

- Histórico: repetir com `cursor=<proximo>` até null.
- Novidades: `desde=<recente>`. Se houver proximo, usar `desde` e `cursor`
  juntos até terminar o delta; só então guardar o checkpoint da primeira página.
- Origem: `?mensagem=<msg_id>` devolve a mensagem e a sequência disponível até
  o presente. A tela usa a mesma API para rolar e destacar a origem.
- Limite de 1 a 60. Cursores vinculados ao agente e ao tipo, com desempate por
  chave. Cursor inválido ou de outro escopo retorna 400. Sem sessão: 401.

Não há download de mídia completa para montar a grade. `/api/v1/media/<id>/thumb`
serve apenas a miniatura; `/api/v1/media/<id>` é usado ao abrir o arquivo.

O botão ? mostra o tutorial do painel, e o tutorial da conversa inclui essa
seção. O painel usa rolagem própria, alvos de toque de 44 px e nenhuma animação
obrigatória, inclusive com Reduzir Movimento.
