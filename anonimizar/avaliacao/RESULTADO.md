# Resultado da bateria de acurácia (medido em 07/11/2026)

Tudo com dados **fictícios**. Motor real, GLiNER2 (`fastino/gliner2-privacy-filter-PII-multi`, revisão `1cb4166094dc58fa8d836429f060d6c95f62b495`),
opções valores, datas e empresas ligadas, 3 rodadas por medição (tabela vazia e processo novo em cada uma). Como rodar: `LEIA-ME.md`.

## Resumo

| | Antes | Depois |
|---|---|---|
| **Recall geral, 20 documentos, nível completo** (todos os tipos, qualquer tipo de marcador) | 92,7% (266 de 287) | **98,3% (283 de 288)** |
| Recall com o tipo certo | 92,0% | 97,9% |
| **Recall nos 5 documentos de validação** (não usados para ajustar regra) | 83,0% (73 de 88) | **95,5% (84 de 88)** |
| Falso positivo fora das armadilhas | 3 | 0 |
| Armadilhas marcadas (78 no corpus principal) | 11 (14,1%) | 3 (3,8%) |
| Armadilhas marcadas na validação (20) | 5 (25%) | 3 (15%) |
| Estabilidade entre as 3 rodadas | 0 documentos diferentes | 0 documentos diferentes |
| Nível regex (sem modelo): recall geral | 59,9% | 61,5% (os números de documento e contato ficam em 100%; nomes, empresas e endereços não existem nesse nível) |

O corpus: 20 documentos (13 em texto puro, 3 docx, 3 PDF e 1 xlsx: contratos, nota fiscal, planilha de clientes, e-mail, laudo, ficha cadastral, WhatsApp, procuração,
recibo, cobrança, currículo, ata, petição, orçamento, ficha de RH, extrato, mensagem informal, comprovantes de PIX e um relatório só de armadilhas), 288 trechos a marcar e 78 armadilhas. A validação:
5 documentos novos (compra e venda de veículo, e-mail trabalhista em docx, ficha de paciente em PDF, grupo de WhatsApp, planilha de
funcionários), 88 trechos e 20 armadilhas.

Aviso sobre o "antes": a primeira medição (gabarito ainda com defeitos meus: nomes soltos sem anotar, título junto do nome) deu 91,2% e 13 falsos positivos
fora das armadilhas. Corrigi o gabarito **antes** de mexer no motor (nome solto passou a ser anotado, "Dr./Sr./Dona" saiu do trecho porque título não é
dado pessoal, uma data de WhatsApp que faltava, um e-mail que faltava) e a tabela abaixo usa o gabarito corrigido nas duas colunas.

## Por tipo, nível completo (20 documentos)

| Tipo | Esperado (antes → depois) | Recall antes | Recall depois | Tipo certo depois | Escapou antes → depois |
|---|---|---|---|---|---|
| AGENCIA | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CARTAO | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CEP | 7 → 7 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CNPJ | 9 → 9 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CONTA | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CPF | 18 → 18 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| DATA | 40 → 40 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMAIL | 22 → 22 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMPRESA | 20 → 20 | 85.0% | 85.0% | 85.0% | 3 → 3 |
| ENDERECO | 19 → 19 | 47.4% | 100.0% | 100.0% | 10 → 0 |
| PESSOA | 71 → 72 | 95.8% | 97.2% | 95.8% | 3 → 2 |
| PIS | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| PIX | 2 → 2 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| RG | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| TELEFONE | 26 → 26 | 80.8% | 100.0% | 100.0% | 5 → 0 |
| VALOR | 33 → 33 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| **Total** | 287 → 288 | 92.7% | 98.3% | 97.9% | 21 → 5 |

## Por tipo, nível regex (sem o detector de nomes)

| Tipo | Esperado (antes → depois) | Recall antes | Recall depois | Tipo certo depois | Escapou antes → depois |
|---|---|---|---|---|---|
| AGENCIA | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CARTAO | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CEP | 7 → 7 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CNPJ | 9 → 9 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CONTA | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CPF | 18 → 18 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| DATA | 40 → 40 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMAIL | 22 → 22 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMPRESA | 20 → 20 | 0.0% | 0.0% | 0.0% | 20 → 20 |
| ENDERECO | 19 → 19 | 0.0% | 0.0% | 0.0% | 19 → 19 |
| PESSOA | 71 → 72 | 0.0% | 0.0% | 0.0% | 71 → 72 |
| PIS | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| PIX | 2 → 2 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| RG | 6 → 6 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| TELEFONE | 26 → 26 | 80.8% | 100.0% | 100.0% | 5 → 0 |
| VALOR | 33 → 33 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| **Total** | 287 → 288 | 59.9% | 61.5% | 61.5% | 115 → 111 |

## Por tipo, validação (5 documentos novos, nível completo)

| Tipo | Esperado (antes → depois) | Recall antes | Recall depois | Tipo certo depois | Escapou antes → depois |
|---|---|---|---|---|---|
| AGENCIA | 5 → 5 | 40.0% | 40.0% | 40.0% | 3 → 3 |
| CEP | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CNPJ | 2 → 2 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| CONTA | 5 → 5 | 40.0% | 100.0% | 100.0% | 3 → 0 |
| CPF | 7 → 7 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| DATA | 12 → 12 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMAIL | 3 → 3 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| EMPRESA | 3 → 3 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| ENDERECO | 8 → 8 | 12.5% | 100.0% | 100.0% | 7 → 0 |
| PESSOA | 23 → 23 | 95.7% | 95.7% | 95.7% | 1 → 1 |
| PIS | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| RG | 1 → 1 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| TELEFONE | 9 → 9 | 88.9% | 100.0% | 100.0% | 1 → 0 |
| VALOR | 8 → 8 | 100.0% | 100.0% | 100.0% | 0 → 0 |
| **Total** | 88 → 88 | 83.0% | 95.5% | 95.5% | 15 → 4 |

## Tempo e memória (nível completo, 1 processo por rodada)

- Pico de RSS do processo: **3,3 GB** (3316 a 3318 MB; o piso de 2500 MB de MemAvailable do carregamento é justo). No nível regex: 75 MB.
- Tempo por documento: **média 1,65 s**, mínimo 0,5 s, máximo 14 s (o primeiro documento de cada processo paga a carga do modelo, cerca de 12 s). Corpus
  de 20 documentos: 33 s no total, contra 1,6 s no nível regex.
- A validação mostrou o mesmo perfil: 3,8 s por documento, 19 s no total (5 documentos, uma carga de modelo).

## Os 10 escapes mais importantes (antes), e o que aconteceu

1. **Endereço cortado no número da casa (10 de 19 endereços do corpus, 7 de 8 na validação).** O modelo devolvia "Rua X, 88" e deixava "centro, Florianópolis/SC"
   à mostra (bairro e cidade identificam onde a pessoa mora). **Corrigido** (regra, abaixo).
2. **Telefone sem separador ou de central (5 casos):** `+5511987654321`, `21987651234` numa coluna "Telefone", `3233-4455` ("Fixo:"), `0800 123 4567`, `4004-0001`. **Corrigido.**
3. **Telefone `+55 31 99123-4567` marcado como CARTAO** (passava no Luhn e a prioridade do cartão ganhava). Dado trocado do mesmo jeito, mas com o tipo errado. **Corrigido.**
4. **Número guardado como texto na planilha** (`445566-7` na coluna "Conta"): o motor trocava na planilha e esquecia o CSV; a verificação final barrou o documento
   inteiro (`sobrou_dado`). Era um defeito meu de consistência, achado só na validação. **Corrigido** (mesma regra na planilha e no CSV).
5. **Parte do nome** ("Maria Aparecida" para "MARIA APARECIDA DOS SANTOS FERREIRA"): intacto. **Corrigido** (pedaços do nome viram o mesmo marcador).
6. **Apelidos** ("Nanda" para Fernanda, "Zeca", "Pitbull"): o modelo não reconhece nem a consistência liga ao nome completo. **Aberto.**
7. **Nome fantasia de empresa cortado** ("Casa & Cia Móveis Planejados" sai sem "Planejados"; "Marcenaria Oliveira & Filhos ME" cortada no "&"). **Aberto.**
8. **Empresa sem sufixo dentro de frase longa** ("Condomínio Solar das Palmeiras" intacto no documento, mas marcado quando a frase vem sozinha: o resultado do modelo
   depende do contexto). **Aberto.**
9. **Agência em coluna de planilha** (`0012`, `0345`, `0678` na coluna "Banco/Agência"; só na validação): número curto sem palavra "agência" ao lado não é reconhecido. **Aberto.**
10. **Primeiro nome confundido com empresa** ("Bia" virou EMPRESA): trocado do mesmo jeito, só o tipo sai errado. **Aberto.**

## Falsos positivos que sobraram

Corpus principal, depois: `Toyota Corolla` (marca/produto, EMPRESA), `3ª Vara Cível` e `Santos` (vara e comarca viram marcador numa petição), 3 armadilhas no total.
Validação: `Renault Kwid 2021` (EMPRESA), `Marginal Tietê` (ENDERECO), `Gatorade` (EMPRESA).
Antes havia ainda INSS, Banco do Brasil, Microsoft, Samsung, Nubank, Coca-Cola (marcas e instituições marcadas como EMPRESA), "LOCADORA", "CNPJ" (palavra de
contrato marcada como empresa) e um endereço de site. O nome das armadilhas que sobraram é o que um gabarito de marcas nunca vai cobrir: lista
fechada não resolve marca nova (Renault, Gatorade).

## Melhorias aplicadas (baratas)

Todas em `anonimizar/`; o `test_motor.py` passa (48 testes, com e sem os leitores) e ganhou testes para cada regra nova.

1. **Endereço brasileiro por padrão** (`ner_gliner.py`): via + número, complementos conhecidos (apto, bloco, sala, quadra, "3º andar", bairro, centro, vila...) e,
   quando há "Cidade/UF" no fim, os trechos de bairro no meio. Resolveu 10 de 10 (corpus) e 7 de 7 (validação) endereços cortados, sem falso positivo novo.
2. **Telefone** (`detectores.py`): `+55` sem separadores, números de central (0800, 0300, 4004, 4003, 3003) e mais palavras de contexto (fixo, comercial, residencial, móvel,
   atendimento, central, SAC); o `+` na frente impede que o número vire cartão.
3. **Número guardado como texto na planilha** usa o título da coluna como contexto (celular, conta, CPF) e vale no xlsx e no CSV gerado (`documentos.py`).
4. **Pedaços do nome com mais de uma palavra** viram o marcador do nome completo, desde que sejam de um único nome (`tabela.py`); vale também para nomes que já estão na
   tabela, desde o primeiro documento.
5. **Lista de exceções do detector de nomes** (`excecoes.py`): papéis de contrato (LOCADORA, CONTRATANTE...), palavras de documento (CNPJ, CPF), instituições e grandes
   marcas conhecidas (INSS, bancos, big techs, bebidas, montadoras) e endereço de site não viram marcador. Comparação por nome inteiro: "Banco do Brasil" cai,
   "Banco do Brasil Seguros Ltda" não. É uma lista editável.
6. **Não mexi** no limiar nem nos rótulos do GLiNER2 (limiar 0,5 mantido): baixar o limiar para pegar "Zeca" e "Nanda" arrisca mais falso positivo e eu não medi isso.

Honestidade sobre a validação: as regras 1, 2, 4 e 5 foram escritas olhando o corpus principal. Na validação (documentos escritos depois), apareceram dois
defeitos meus, corrigidos **depois** de ver o resultado: (a) o CSV da planilha não aplicava a regra 3 (a verificação final barrou o documento) e (b) a regra 1
não reconhecia "ap." com ponto. Os números da validação acima já incluem as duas correções; o resultado antes delas foi 65 de 88 por causa do documento recusado.

## Melhorias propostas

**Baratas (não aplicadas):**
- Agência e conta em coluna de planilha: usar o título da coluna ("Agência", "Banco/Agência", "Conta") também para números curtos (3 a 6 dígitos). Pega os 3 escapes da validação.
- Reconhecer "apelido do nome": quando o nome completo está no documento e um apelido entre aspas ou parênteses aparece junto (`Diego "Dedé" Nascimento`, `Dona Dores`),
  tratar o apelido como o mesmo marcador nas outras ocorrências (hoje "Dedé" só é trocado onde o modelo o detecta).
- Quando o modelo marca uma empresa, estender o trecho para as palavras com inicial maiúscula coladas nele ("Casa & Cia Móveis" + "Planejados"), com cuidado para não engolir a frase.
- Rótulos alternativos do GLiNER2 para empresa ("company", "organization", "corporation") com o maior trecho vencendo; testar com a bateria.
- Testar o limiar 0,35 a 0,45 só para PESSOA, medindo o falso positivo na bateria antes de aplicar.
- Passo de consistência que una o nome solto ao nome completo quando as letras batem, para o caso em que o modelo dá o tipo errado a um primeiro nome ("Bia" como EMPRESA).

**Caras:**
- Modelo maior ou ajuste fino do GLiNER2 com exemplos brasileiros (endereços, apelidos, nomes fantasia): melhora o recall de PESSOA e EMPRESA, custa treino, avaliação e RAM.
- Um segundo detector (por exemplo um modelo de NER em português) votando com o primeiro: reduz o falso positivo de marcas, dobra o tempo e a memória.
- Resolução de correferência ("a locadora", "ela", "a Nanda" = Fernanda): só com modelo de linguagem; fora do alcance de um motor de 3 GB.
- OCR para PDF escaneado (fora do escopo desta medição: o motor recusa o PDF sem texto).

## Limites da medição

- Documentos curtos e escritos por mim: o recall real em documentos longos e bagunçados será menor, principalmente para PESSOA, EMPRESA e apelidos.
- Um trecho conta como pego quando **todas** as palavras dele viram marcador; o marcador pode ter pegado palavras a mais (anotado como "passou do trecho").
- O alinhamento é por tokens; em PDF a extração pode trocar quebras de linha, o que não afeta a medida.
- As armadilhas são decisões minhas ("marca não é dado pessoal"); quem prefere mascarar toda marca pode editar `excecoes.py`.
