# Respostas diretas e avisos de rotina

Respostas ao dono aparecem abertas. Avisos de rotina continuam recolhidos.
O leitor reconhece a chegada da mensagem por `queue-operation` com
`operation: enqueue`, sem esperar o `attachment` do tipo `queued_command`,
que pode ser escrito depois da resposta. A mesma entrada não aparece duas vezes.

Pokes recebidos na fila não substituem a origem da conversa em andamento.
Retomadas após compactação restauram a origem de conversa. Registros `remove`
e `api-request-blob` são ecos, não novas entradas do dono. Uma cópia antiga da
mesma mensagem também não reclassifica um turno posterior de rotina.

No SSE, `novas` também pode trazer uma versão atualizada de um ID conhecido.
O cliente substitui essa mensagem, preservando ordem, contagem e ID. Assim uma
classificação corrigida não fica presa na tela até recarregar a página.

A fixture `web/test/fixtures/fila-durante-resposta.jsonl` preserva ordem, tipos e
horários do caso de 16/10, com conteúdo e identificação pessoal removidos.
Os testes conferem a leitura parcial antes do attachment, deduplicação, origem
das seis respostas e substituição pelo stream.
