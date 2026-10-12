# O raio-X do cérebro, o leitor de memória e a aba "Como funciona"

O pedido do Danilo (01/10/2026): "um raio-X do cérebro dele, eu conseguir ver
todos os arquivos que ele está usando ali referentes à atividade do usuário:
pesquisa, tarefas, preferências... sempre renderizado em markdown correto,
bonito, e o usuário pode clicar e editar à mão, e fica salvo como principal para
a próxima rodada o agente puxar".

A memória do agente é **texto em arquivo**, não um banco fechado. A tela lê os
mesmos arquivos que ele lê, e quando o dono salva, grava no mesmo lugar de onde
ele lê. Nenhuma cópia, nenhum rascunho do painel para sincronizar depois.

## "O que ele sabe agora" (aba Status)

Substituiu o antigo cartão "Memória de curto prazo". Logo acima dele, o cartão "Memória de trabalho
(working memory)" diz se ela está em dia, o tamanho, o teto e se a remontagem
das 7h rodou (ver `MEMORIA-DE-TRABALHO.md`). Um cartão por arquivo vivo
da memória:

| Cartão | Arquivo | Quem escreve |
| --- | --- | --- |
| Memória de trabalho | `working-memory.md` | uma rotina remonta toda manhã às 7h; ele acrescenta ao longo do dia; o batimento reescreve a linha "Agora" |
| Memória longa | `MEMORY.md` | ele, na reflexão da noite |
| Quem é você, para ele | `CREATOR.md` | nasceu na instalação; quem muda é o dono |
| um por assunto | `memory/*.md`, `memory/*.json` (preferências, pessoas, projetos, pesquisas...) | ele, quando aprende algo |
| Diário de DD/MM | o `memory/AAAA-MM-DD.md` mais recente | a reflexão da noite |

Cada cartão mostra quando o arquivo mudou ("há 2 h"), quem escreve, e uma
prévia já renderizada. Quando a última mudança foi do dono pelo painel, o
cartão diz "a última mudança foi sua" (o painel confere pela versão gravada no
registro de edições).

O cartão da memória de trabalho é largo e mostra as seções que importam,
separadas: **Objetivos do dono**, **Tarefas em andamento**, **O que ele sabe
sobre você**, **Últimas conversas** (as quatro que a frente C criou no gerador
em 01/10/2026; o título no arquivo leva o nome do dono, "## Objetivos do
Paulo", e o casamento é pelo começo, sem acento). Enquanto um agente não
tiver essas seções, entram as que já existem (Agora, Pendências, Na minha
cabeça, Metas, Quero falar, Instruções), e o cartão diz quais das novas ainda
faltam, em vez de fingir que estão vazias.

Clicar num cartão abre o arquivo inteiro no leitor.

## O leitor (e editor) de memória

`panel/public/js/leitor.js`. **Um componente só**, usado pelo raio-X, pela aba
Memória e pela aba Identidade. Antes cada aba tinha a sua caixa, em letra de
código de 13px (o Danilo: "ruim, feia, pequenininha"), e a Identidade abria em
letra de 8px com o tutorial prometendo "edite ali mesmo" sem botão de editar.

- **Leitura**: corpo de 16px, entrelinha 1.6, linha de no máximo ~72
  caracteres. JSON aparece formatado, num bloco legível.
- **Editar**: troca por uma caixa de texto grande, monoespaçada de 15px, que
  ocupa a janela (no celular, a janela inteira; os botões ficam em cima, onde o
  teclado não cobre).
- **Salvar** grava no arquivo de verdade. **Cancelar** volta sem gravar. Fechar
  com alteração não salva pergunta antes.
- Depois de salvar: "Ele lê este arquivo no começo da próxima conversa. Se
  quiser que valha já nesta, avise ele", com o botão **Avisar ele agora**, que
  manda uma linha pela Conversa ("Editei à mão, pelo painel, o arquivo X.
  Releia..."). A mensagem aparece na Conversa como sua.
- **Conflito**: se ele escreveu no arquivo enquanto o dono editava, o servidor
  recusa e o texto do dono **fica no editor**, com os botões "Copiar o meu
  texto" e "Carregar a versão dele".

O texto é renderizado pelo `public/js/markdown.js`, o renderizador único do
painel (o mesmo da aba Apps e da página de compartilhar roteiro). Em 01/10/2026
ele passou a entender lista com níveis, lista numerada, lista de tarefa (`- [ ]`
/ `- [x]`), riscado (`~~x~~`), linha divisória, citação de várias linhas e
títulos até `######`, e deixou de aplicar negrito dentro de código. Continua
escapando TUDO antes de virar HTML (nenhuma tag do arquivo sobrevive) e só
aceita link `http`/`https`.

## O que pode ser editado

Lista de **permissão** (`EDITAVEIS` em `panel/lib/memoria.js`):
`working-memory.md`, `MEMORY.md`, `memory/**` (`.md`, `.json`, `.txt`), `SOUL.md`,
`PERSONALITY.md`, `IDENTITY.md`, `CREATOR.md`.

Ficam de fora, de propósito, e o leitor diz o motivo no lugar do botão:
`LAWS.md` e `ETHICS.md` (as regras de segurança dele, imutáveis por desenho; o
próprio arquivo pede `chmod 444`), `AGENT.md` e `CLAUDE.md` (a atualização do
plugin reescreve, a edição se perderia), e arquivo marcado como somente leitura
no sistema.

## As travas da gravação

1. **Lista de permissão e o sanitizador da leitura.** Nada fora do agentDir,
   nada em pasta começada por ponto (`.dgclaw/`, `.claude/`...), nada em pasta de
   segredo (`cofre`, `creds`, `segredos`, `secrets`), nada com extensão de chave
   (`.chave`, `.key`, `.pem`, `.enc`...), nada dos `blockedFiles` do config, e
   link simbólico resolvido (`realpath`) antes de decidir.
2. **Versão lida.** O PUT leva a versão (hash do conteúdo) que o editor abriu.
   Se o arquivo de agora é outro, a resposta é **409** e nada é gravado. Isso
   importa de verdade: o batimento reescreve o "## Agora" da memória de trabalho
   a cada meia hora.
3. **Gravação atômica.** Temporário na mesma pasta + `rename`. Quem ler no meio
   lê o velho inteiro ou o novo inteiro.
4. **Dono e permissão do arquivo preservados.** O painel roda como root dentro
   do container e o agente roda como outro usuário: o temporário recebe o dono e
   as permissões do original antes do `rename`, senão o agente perderia o direito
   de escrever na própria memória.
5. **Cópia de antes e registro.** A versão anterior vai para
   `<agentDir>/.dgclaw/backups/memoria/<caminho com / trocado por __>.<carimbo>`
   (as 20 últimas de cada arquivo), e cada edição é anotada em
   `<agentDir>/.dgclaw/logs/edicoes-memoria.jsonl` (`ts`, `path`, bytes, versões,
   onde ficou a cópia; nunca o conteúdo).

Para desfazer uma edição à mão: copiar a cópia de `.dgclaw/backups/memoria/` por
cima do arquivo (é texto puro).

### A brecha que a vistoria achou e que fechou junto

A vistoria de 01/10/2026 (`docs/VISTORIA-2026-10-01.md`, seção 4) achou que a
rota antiga `/api/memory/file` entregava `.dgclaw/cofre.chave` (a chave mestra
do cofre), os segredos cifrados, o `.dgclaw/run/<slug>.env` e os transcripts:
o sanitizador só barrava arquivo cujo NOME começasse com ponto, e ninguém
olhava a PASTA. O `lib/sanitize.js` agora recusa qualquer segmento começado por
ponto, pastas de segredo e extensões de chave, resolve link simbólico e tem teto
de 2 MB. Vale para a rota antiga e para as novas. O `panel/test-memoria-editar.mjs`
confere isso na função E por HTTP, com o painel de verdade numa porta local.

## Como o agente fica sabendo da edição

- **`working-memory.md` e `MEMORY.md`**: o hook `hooks/session-context.sh` os
  reinjeta no começo de toda sessão e logo depois de toda compactação. Da
  `MEMORY.md` entram só as linhas de lista (`- ...`): fato escrito fora de lista
  fica no arquivo, mas não é reinjetado sozinho.
- **`memory/`**: ele lê quando precisa do assunto.
- **Identidade (`SOUL`, `IDENTITY`, `PERSONALITY`, `CREATOR`)**: lida ao começar
  uma sessão.

Ou seja: a edição vale **na próxima rodada** sem fazer nada. Para valer na
conversa que já está aberta, o botão **Avisar ele agora** do leitor.

**Atenção com a memória de trabalho:** ela é remontada toda manhã por
`scripts/build-working-memory.py`. As seções de instruções e de recados para o
dono são preservadas; as outras podem ser reescritas por ele com o tempo. O
leitor mostra esse aviso em cima do arquivo.

## A aba "Como funciona"

Renderiza o `docs/RADIOGRAFIA.md` do plugin (procurado primeiro em
`<agentDir>/.dgclaw/plugin/docs/RADIOGRAFIA.md`, depois em `../docs/` ao lado do
painel). Ausente, a tela diz que o texto chega com a próxima atualização do
plugin.

Em cima, um **mapa vivo** com os números de verdade deste agente, cada um da
mesma fonte da aba que o detalha: a sessão (o `diagnostico` do `/api/saude`), o
tamanho de cada camada de memória (as `camadas` do `/api/cerebro`, medidas no
disco), quantas operações do sistema estão verdes (`/api/operacoes`) e quantas
rotinas o dono pediu (`/api/rotinas/usuario`). Sem conta própria: a tela nunca
discorda das outras.

## As rotas

`GET /api/cerebro`

```json
{ "cartoes": [ { "path": "working-memory.md", "titulo": "Memória de trabalho", "explica": "...",
    "tipo": "md|json|texto", "atualizadoEm": "ISO", "tamanho": 5667, "editavel": true, "motivoNaoEditavel": null,
    "autoria": { "quem": "agente|rotina|dono", "frase": "...", "voceEditouEm": "ISO|null", "voceFoiOUltimo": false },
    "previa": "markdown", "cortado": true,
    "destaques": [ { "titulo": "Objetivos do dono", "tituloNoArquivo": "Objetivos do Paulo", "markdown": "...", "cortado": false, "vazia": false } ],
    "faltamSecoesNovas": [], "diarios": 25 } ],
  "camadas": [ { "id": "trabalho|longa|assuntos|diarios|identidade", "titulo": "...", "explica": "...", "arquivos": 1, "bytes": 5667 } ],
  "geradoEm": "ISO" }
```

`destaques`/`faltamSecoesNovas` só no cartão da memória de trabalho; `diarios`
só no do diário. `bytes: null` quando a camada não existe (não medido, não zero).

`GET /api/memoria/arquivo?path=<relativo>` → `{ path, titulo, tipo, conteudo,
versao, atualizadoEm, tamanho, editavel, motivoNaoEditavel, aviso, autoria }`.
Erros: `400` caminho inválido, `403` recusado (com o motivo), `404` não existe,
`413` maior que 2 MB.

`PUT /api/memoria/arquivo` com `{ path, conteudo, versaoLida }` →
`{ ok: true, versao, atualizadoEm, backup }` (ou `semMudanca: true`). Erros, todos
com `error` + `howToFix`: `400` (faltou a versão, JSON inválido, byte nulo), `403`
(fora da lista, recusado pelo sanitizador, somente leitura), `404`, `409` (mudou
desde a leitura; traz `versaoAtual` e `atualizadoEm`), `413` (mais de 1 MB),
`500` (não deu para guardar a cópia ou gravar; o original fica intacto).

`GET /api/radiografia` → `{ ausente: false, markdown, origem, atualizadoEm }` ou
`{ ausente: true, mensagem }`.

## Arquivos

- `panel/lib/memoria.js`: o raio-X, a leitura e a gravação com as travas.
- `panel/lib/sanitize.js`: o que nunca abre.
- `panel/lib/rotas-painel.js`: as rotas.
- `panel/public/js/leitor.js`, `panel/public/js/cerebro.js`, `panel/public/css/leitura.css`: a tela.
- `panel/test-memoria-editar.mjs`: as recusas, o 409, a cópia, a gravação atômica, e o cofre fechado por HTTP.
