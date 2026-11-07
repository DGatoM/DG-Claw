# Anonimizar documentos

Com esta opção ligada, os documentos que você manda a um agente chegam a ele sem os dados pessoais. O
agente (e o modelo de IA na nuvem por trás dele) trabalha com marcadores como `[PESSOA_1]` e `[CPF_1]`, e
você continua lendo tudo completo.

## O que faz

1. Você liga a opção para um agente, na tela **Anonimizar** (menu ☰).
2. Quando você manda um documento pelo clipe da conversa, o DG Claw lê o arquivo, troca os dados pessoais
   por marcadores e entrega ao agente só a cópia anonimizada, com o nome `doc-<código>.anon.<tipo>`. O
   original não entra na pasta do agente, e o nome original do arquivo também não (nome de arquivo é dado
   pessoal).
3. O mesmo dado vira sempre o mesmo marcador, em todos os documentos daquele agente: "Maria Souza" é
   `[PESSOA_1]` hoje e amanhã.
4. Nas respostas do agente que trazem marcadores, o botão **Ver com dados reais** troca o texto na sua tela
   (só na sua tela). Nos arquivos que o agente devolve, o botão **Baixar versão final** entrega o arquivo com
   os dados reais no lugar dos marcadores.

O que é trocado: nomes de pessoas, empresas e endereços (com o detector completo), CPF, CNPJ, RG, PIS, CNH,
título de eleitor, CEP, telefone, e-mail, cartão, conta, agência e chave Pix. Valores em dinheiro e datas
entram se você marcar essas opções.

## O que não faz

- **Só vale para o clipe da conversa web.** O que chega por WhatsApp, Telegram ou e-mail ainda não passa pelo
  filtro.
- **O que você digita só é trocado se você ligar "Aplicar também no que eu digito"**, e apenas para dados
  que já apareceram em algum documento daquele agente. O filtro não procura nomes novos no que você escreve.
- **Não é perfeito.** Nenhum detector acha 100% dos nomes. Para documento muito sensível, confira o resultado
  com **Ver tabela** e leia a cópia anonimizada antes de confiar.
- **PDF não volta.** Para baixar a versão final, o arquivo que o agente devolve precisa ser `.docx`, `.xlsx`,
  `.pptx`, `.md`, `.txt`, `.csv` ou `.json`. Arquivos `.html` e `.svg` não voltam. Peça isso ao agente quando o resultado for ser baixado.
- **PDF escaneado (foto de página)** não tem texto para ler e é recusado. Imagem, áudio e vídeo também não
  passam pelo filtro; o que fazer com eles é uma opção sua (bloquear ou enviar assim mesmo).

## Onde ficam os dados

- A **tabela** (marcador e dado real) e a **lista de documentos** ficam no servidor, na pasta de dados do
  painel (`/var/lib/dgclaw/web/anonimizar/<agente>/`), cifradas com AES-256-GCM. A chave fica em
  `/etc/dgclaw/anonimizar.chave`, com leitura só para o root, e é criada no primeiro uso. **Guarde a chave
  junto com o seu backup**: sem ela a tabela não abre, e sem a tabela não há como voltar os dados reais.
- O agente nunca lê a tabela. Ela fica fora da pasta dele.
- O original do documento fica numa pasta temporária só durante a troca e é apagado em seguida, mesmo se der erro.
- Apagar um documento na lista tira da tabela os marcadores que nenhum outro documento usa. Depois disso, um
  arquivo antigo que ainda tenha esse marcador não volta mais aos dados reais.

## O detector de nomes

Sem instalar nada, o filtro troca o que tem formato fixo (CPF, CNPJ, telefone, e-mail) em arquivos de texto.
Para o resto há duas etapas opcionais, instaladas pelo botão na tela Anonimizar (a instalação roda sozinha no
servidor, e a tela mostra o andamento):

| Etapa | O que traz | Espaço e memória |
|---|---|---|
| **Leitores** | Abre PDF, Word (`.docx`) e Excel (`.xlsx`) | cerca de 30 MB |
| **Completo** | Reconhece nomes de pessoas, empresas e endereços | cerca de 2 GB de disco e uns 2,5 GB de memória livre na hora de rodar |

O modelo do detector completo só fica na memória enquanto você usa: depois de 10 minutos sem documento novo
ele é descarregado. Numa VPS de 4 GB isso cabe, mas feche o que puder antes do primeiro uso.

**Sem o detector completo**, o padrão é **bloquear** o envio, porque nomes e endereços passariam sem troca. Se
você preferir, na opção "Sem o detector de nomes" escolha trocar só os números.

## Opções de cada agente

| Opção | Efeito |
|---|---|
| Anonimizar documentos | Liga e desliga para aquele agente. |
| Trocar valores em dinheiro | `R$ 1.500,00` vira `[VALOR_1]`. |
| Trocar datas | `12/03/1985` vira `[DATA_1]`. |
| Trocar nomes de empresas | Precisa do detector completo para achar o nome; o CNPJ é sempre trocado. |
| Aplicar também no que eu digito | Troca, nas suas mensagens, só os dados já vistos em algum documento. |
| Sem o detector de nomes | Bloquear o envio (padrão) ou trocar só os números. |
| Se não der para anonimizar | Bloquear o envio (padrão) ou enviar assim mesmo, sem anonimizar. |

## Como baixar a versão final

Na conversa, embaixo de cada arquivo que o agente mandou aparece **Baixar versão final**. O arquivo baixado
tem `-final` no nome e traz seus dados reais: guarde-o como você guardaria o original. Para o agente gerar
algo que volte bem, peça o resultado em `.docx`, `.xlsx`, `.md` ou `.txt`.

## Se algo der errado

Toda recusa diz o que houve e o que fazer, e nunca entrega nada ao agente por engano:

- **"O detector de nomes não está instalado"**: instale o completo na tela, ou mude a opção.
- **"O motor demorou mais de 180 segundos"**: o documento é grande demais para esta máquina; divida o arquivo.
- **"O motor parou no meio do pedido"**: provavelmente faltou memória. Tente de novo, ou instale só os leitores.
- **"PDF sem texto"**: o PDF é uma imagem. Rode um OCR antes, ou envie o texto.

Documentação técnica da API: `web/docs/ANONIMIZAR.md`.
