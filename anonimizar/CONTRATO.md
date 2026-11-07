# Anonimizar documentos: contrato entre o Web (Node) e o motor (Python)

Este arquivo é a fonte do combinado entre as duas metades. Mudou aqui, muda nas duas.

## O que a feature faz

O dono liga "Anonimizar documentos" para um agente. Daí em diante, todo documento enviado pelo clipe
da conversa web daquele agente passa antes pelo motor, que troca dados pessoais por marcadores
estáveis (`[PESSOA_1]`, `[CPF_1]`...). O agente e o modelo de nuvem só recebem a versão com
marcadores. A tabela de correspondência fica no servidor, cifrada, fora da casa do agente. Quando o
agente devolve um arquivo, o dono vê o botão "Baixar versão final", que troca os marcadores de volta
pelos dados reais. Nas mensagens do agente com marcadores aparece "Ver com dados reais".

## Peças e caminhos

| Peça | Caminho no repo | Instalado em |
| --- | --- | --- |
| Motor Python | `anonimizar/motor.py` (+ módulos em `anonimizar/`) | `/opt/dgclaw/app/anonimizar/` |
| Instalador opcional do motor | `lib/anonimizar-instalar.sh` | roda pela unidade `dgclaw-anonimizar-instalar.service` |
| Ambiente Python do motor | criado pelo instalador opcional | `/opt/dgclaw/anonimizar/venv` |
| Modelo GLiNER2 (revisão fixa) | baixado pelo instalador opcional | `/opt/dgclaw/anonimizar/modelo` |
| Estado da instalação | gravado pelo instalador opcional | `/opt/dgclaw/anonimizar/estado.json` |
| Lado Web | `web/lib/anonimizar.js` + rotas em `web/server.js` | |
| Tabela cifrada e registro | gravados pelo Web | `<DGCLAW_WEB_DATA>/anonimizar/<slug>/` (0700) |

Variáveis de ambiente (para testes): `DGCLAW_ANON_BASE` (padrão `/opt/dgclaw/anonimizar`),
`DGCLAW_ANON_PYTHON` (padrão `<base>/venv/bin/python`, e `python3` do sistema se o venv não
existir), `DGCLAW_ANON_NER=falso` (motor usa um detector de nomes falso e determinístico, só para
testes: marca como PESSOA qualquer sequência de duas ou mais palavras capitalizadas da lista
fixa em `anonimizar/ner_falso.py`).

## Níveis do motor

- `regex`: só biblioteca padrão do Python. Sempre disponível. Lê `.txt .md .csv .json`.
- `leitores`: o venv tem `pypdf`, `python-docx`, `openpyxl`. Lê também `.pdf .docx .xlsx`.
- `completo`: `leitores` + `torch` CPU + `gliner2` + modelo. Detecta PESSOA, ENDERECO, EMPRESA.

## Protocolo

Processo: `<python> -I <app>/anonimizar/motor.py servir`. Uma requisição JSON por linha no stdin,
uma resposta JSON por linha no stdout, na mesma ordem. Nada além de JSON no stdout (log vai para o
stderr, sem nenhum valor detectado nele). O Web mantém um processo vivo e o encerra depois de 10
minutos sem uso (o modelo ocupa ~1,5 a 2 GB). Toda resposta tem `ok`; erro é
`{"ok":false,"erro":"<motivo em português, com o que fazer>","codigo":"<curto>"}`.

Tipos de dado (o `tipo` do marcador): `PESSOA EMPRESA ENDERECO CPF CNPJ RG PIS CNH TITULO CEP
TELEFONE EMAIL CARTAO CONTA AGENCIA PIX VALOR DATA`. Marcador: `[<TIPO>_<n>]`, n a partir de 1,
numerado por agente (a tabela é do agente inteiro, então o mesmo valor vira o mesmo marcador em
todos os documentos dele).

### `{"op":"estado"}`
`{"ok":true,"nivel":"regex|leitores|completo","formatos":[".txt",...],"modelo_carregado":bool,"rss_mb":int,"versao_modelo":"<revisao>|null"}`

### `{"op":"anonimizar","entrada":"<arquivo>","saida_dir":"<pasta>","nome_base":"doc-<id>","tabela":[{"tipo":"PESSOA","valor":"Maria Souza","marcador":"[PESSOA_1]"},...],"opcoes":{"valores":bool,"datas":bool,"empresas":bool}}`
- Lê o arquivo, detecta, troca, grava em `saida_dir`:
  - `.pdf` e `.txt .md .csv .json`: `<nome_base>.anon.md` (texto extraído; csv vira `.anon.csv`, json vira `.anon.json`).
  - `.docx`: `<nome_base>.anon.docx` preservando a formatação (troca por parágrafo, juntando runs quando o valor está quebrado entre eles) **e** `<nome_base>.anon.md`.
  - `.xlsx`: `<nome_base>.anon.xlsx` com as células trocadas (fórmulas preservadas) **e** `<nome_base>.anon.csv` por aba.
- Reusa os marcadores da `tabela` recebida para valores já conhecidos (comparação normalizada:
  sem acento, minúsculas, espaços colapsados; CPF/CNPJ/telefone só dígitos). Nome parcial ("Maria")
  que é parte de um nome completo já conhecido ou achado no mesmo documento ("Maria Souza") vira o
  mesmo marcador.
- Texto de entrada que já parece marcador (`[PESSOA_3]`) é neutralizado (`［PESSOA_3］`, colchetes de
  largura total) antes de qualquer coisa, para que um documento não consiga plantar marcador.
- Resposta: `{"ok":true,"saidas":[{"caminho":"...","formato":"md"}],"novas":[{"tipo","valor","marcador"}],"usados":["[PESSOA_1]",...],"contagem":{"PESSOA":3,...},"avisos":["..."],"nivel":"..."}`.
  `usados` lista TODOS os marcadores presentes em qualquer parte de qualquer saída (inclusive
  cabeçalho, rodapé, comentário, metadado e relacionamento), novos ou reaproveitados. O Web guarda
  essa lista no registro do documento e só ela decide o que vira lápide ao apagar.
- Valores não textuais também passam pelo filtro: número em célula de planilha e em JSON (CPF ou
  CNPJ guardado como número, inclusive sem o zero à esquerda), literal dentro de fórmula, metadado
  (`docProps/*`), comentário, hyperlink, relacionamento externo e nome de aba.
- Verificação final obrigatória: depois de gravar, o motor relê TODAS as partes de TODAS as saídas
  (no Office, cada arquivo do zip descompactado) e procura cada valor detectado, normalizado. Se
  algum sobrou, a operação falha fechada (`codigo:"sobrou_dado"`) e nada fica em `saida_dir`.
  `novas` traz só as entradas que não estavam na tabela; o Web junta e grava cifrado.
- Falha fechada: PDF sem texto (escaneado), formato que o nível atual não lê, arquivo protegido por
  senha, docx/xlsx com mais de 200 MB descompactados (bomba de zip), ou erro do modelo: `ok:false`,
  e nada é gravado em `saida_dir`.

### `{"op":"anonimizar_texto","texto":"...","tabela":[...],"opcoes":{...}}`
`{"ok":true,"texto":"<com marcadores>","novas":[...],"contagem":{...}}` (tela de teste e legenda).

### `{"op":"reverter","entrada":"<arquivo>","saida":"<arquivo>","tabela":[...]}`
Troca marcadores pelos valores em `.txt .md .csv .json .docx .xlsx .pptx`, SÓ em texto visível:
nunca dentro de URL, atributo, relacionamento, destino de link ou de imagem (no md, nem em
`](...)` nem em URL solta; no Office, só nós de texto). Marcador num desses lugares fica como está.
`.html .htm .svg .xml` e outros formatos ativos: `ok:false`, `codigo:"formato_ativo"`. Marcador
desconhecido fica como está. `{"ok":true,"trocas":int,"desconhecidos":["[PESSOA_9]"]}`. PDF:
`ok:false`, `codigo:"pdf"`, com o motivo ("peça ao agente o resultado em .docx ou .md").
Também `{"op":"reverter_texto","texto":"...","tabela":[...]}` -> `{"ok":true,"texto":"...","trocas":int}`.

## Regras que as duas metades seguem

1. O original nunca entra na casa do agente. O Web grava o upload num temporário em
   `<DGCLAW_WEB_DATA>/anonimizar/tmp/` (0700), chama o motor, copia só as saídas para
   `<home_host>/uploads/<dia>/` e apaga o temporário em `finally`.
2. Nome de arquivo também é dado pessoal: o agente vê `doc-<id>.anon.<ext>`; o nome original fica
   no registro cifrado.
3. A tabela e o registro são gravados cifrados (AES-256-GCM) com a chave em
   `/etc/dgclaw/anonimizar.chave` (0600, criada no primeiro uso; caminho configurável por
   `DGCLAW_ANON_CHAVE` para testes). Nunca em log, nunca em resposta de API que não seja a de
   reverter.
4. Falha fechada sempre: se o motor falhar, o documento não vai para o agente e o dono recebe o
   motivo e o que fazer.
5. Só o dono, com sessão e `Origin` do próprio site, chama as rotas de reverter e de tabela.
