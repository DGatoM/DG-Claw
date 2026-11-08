# Bateria de acurácia do motor de anonimização

Mede o quanto o motor acerta em documentos 100% fictícios (nenhum dado real; CPF, CNPJ e PIS são gerados por algoritmo).

- `fontes/` e `fontes-validacao/`: os textos-fonte. `[[TIPO:trecho]]` é o que deve virar marcador; `[[!:trecho]]` é uma armadilha (não deve ser marcado).
- `gerar_corpus.py`: monta os documentos (txt, docx, pdf, xlsx) e o gabarito (`gabarito.json`, `gabarito-validacao.json`). Os binários são gerados na hora, não ficam no git.
- `avaliar.py`: roda cada documento pelo motor real e escreve o relatório em Markdown.
- `RESULTADO.md`: a última medição, com antes e depois das melhorias.

Como rodar (precisa de um Python com pypdf, python-docx, openpyxl e reportlab; para o nível completo, também torch, gliner2 e o modelo):

    python3 anonimizar/avaliacao/avaliar.py --python <venv>/bin/python --base <base com modelo/> --rodadas 3 --saida resultado.md
    python3 anonimizar/avaliacao/avaliar.py --nivel regex --python <venv>/bin/python      # sem o detector de nomes
    python3 anonimizar/avaliacao/avaliar.py --conjunto validacao ...                       # os documentos que não foram usados para ajustar regras
    python3 anonimizar/avaliacao/avaliar.py --motor-dir <outra cópia do repo>/anonimizar   # compara versões

Definições: o trecho conta como "pego" quando todas as suas palavras sumiram da saída e viraram marcador (a coluna "tipo certo" exige o tipo
esperado). Falso positivo é marcador onde o gabarito não manda marcar; as armadilhas são contadas à parte. Títulos como "Dr." e "Sr." ficam
fora do trecho (não são dado pessoal).
