# Idiomas da interface

O Web e o painel compartilham o catálogo Português (Brasil) / English. O seletor
**Idioma / Language** aparece no login e no cabeçalho das telas. A escolha vale
para este navegador e esta origem e fica em um cookie de apresentação por um ano.
Outro navegador pode escolher outro idioma. O cookie não autentica nem autoriza
ninguém.

## Padrão por instalação

O padrão continua sendo português. Para iniciar uma instalação em inglês,
acrescente **somente** esta linha ao `/etc/dgclaw/web.env` existente:

```dotenv
DGCLAW_WEB_IDIOMA=en
```

Depois, reinicie somente o serviço Web conforme o procedimento de administração
da instalação. Não substitua o arquivo inteiro: ele contém outras configurações.
`pt-BR` e `en` são os únicos valores aceitos. Valor inválido gera aviso no log e
mantém português. Uma escolha explícita no seletor prevalece sobre esse padrão.
Apagar o cookie `dgclaw_idioma` volta ao padrão da instalação.

Atrás do Web, o proxy envia ao painel o idioma efetivo como preferência de
apresentação. No painel independente, a mesma variável pode ser configurada no
ambiente do processo. Os HTMLs localizados não são guardados em cache compartilhado.

## Conteúdo e limites

A troca é feita na página, sem recarregar: campos digitados, senha em preenchimento,
conversa aberta, grupos do menu, foco e contagens não são reiniciados. Se o navegador
recusar o cookie, o seletor avisa e a alteração vale apenas para a página atual.
Datas e números apresentados usam o locale escolhido; o fuso horário e os valores
enviados às APIs continuam sendo os mesmos.

Somente textos do produto entram no catálogo. Nomes de pessoas e agentes, conversas,
arquivos, memória, conteúdo dos aplicativos, mensagens vindas do provedor e a marca
personalizada permanecem no idioma original. A frase e o slogan de fábrica do login
têm tradução. Mudar a interface não muda os prompts, a identidade nem o idioma de
resposta dos agentes. Esse último pertence à configuração de cada agente.

A cobertura inclui as telas Web, as abas do painel, mensagens próprias de interface,
visitas guiadas, erros e orientações HTTP, e os 13 capítulos do manual do usuário.
Os catálogos por domínio ficam em `web/i18n/*.json`; o bundle público é gerado a
partir deles. Não há serviço externo de tradução nem tradução de dados da pessoa.

O manual mantém os mesmos endereços e âncoras nos dois idiomas. Cada tradução
registra o SHA-256 da fonte portuguesa em `docs/manual/en/fontes.json`. Se a fonte
mudar, faltar tradução ou houver um atalho para fora da pasta, a leitura em inglês
mostra um aviso e o documento português atual. Atualize o hash somente depois de
revisar a tradução: recalcular o manifesto sozinho esconderia uma tradução antiga.

Comandos, nomes de arquivos e campos da API conservam sua grafia original. A CLI,
os logs operacionais e a referência técnica da API continuam no idioma da fonte.
Detalhes recebidos de processos, do sistema e dos provedores são preservados.
Uma mudança nova do produto deve trazer seus textos de interface para o catálogo;
fonte ainda não catalogada permanece visível, em vez de gerar uma tela vazia.

## Atualizações e contribuição

O catálogo e o código de renderização acompanham a versão do projeto. Preferências
e o padrão ficam fora do código; nenhum comando desta mudança regrava o `web.env`.
Até a contribuição ser incorporada pelo mantenedor, o commit precisa ser mantido
na branch de personalizações e reconciliado com as atualizações do projeto.
Não há garantia de ausência de conflitos antes da incorporação no projeto original.

### Acrescentar ou corrigir uma tradução

```sh
node scripts/idiomas.mjs --adicionar "Texto em português" "English text"
node scripts/idiomas.mjs --compilar
node scripts/idiomas.mjs --verificar
node --test web/test/idioma.test.js
```

O comando devolve a chave. No HTML próprio do produto, marque o texto
com `<!--dg-i18n:chave-->Texto em português<!--/dg-i18n-->`. Para atributos use
`data-dg-i18n-title`, `data-dg-i18n-aria-label`, `data-dg-i18n-placeholder` ou
`data-dg-i18n-alt`, mantendo o atributo português como fallback. O título usa
`<title data-dg-i18n="chave">...</title>`. O teste detecta referência inexistente,
hash incompatível e fallback HTML desatualizado; não troque só o texto mantendo
a chave antiga.

No JavaScript de interface, use `DGI18n.t(fonte)` na renderização e
`DGI18n.frase(fonte, { valor })` para interpolação nomeada. Escape normalmente
qualquer valor que vá para HTML. Para rótulos que já existem e precisam mudar
sem reconstruir seus elementos, use `DGI18n.rotulo(elemento, fonte, atributo)`
ou `DGI18n.fragmento(fonte, { valor })`. Este último gera texto escapado e mantém
os parâmetros separados da fonte para a troca ao vivo.
Nunca passe mensagens, documentos ou outros dados da pessoa como fonte de tradução.
Não localize constantes de protocolo, nomes de rotas, slugs, chaves JSON ou comandos.

Elementos com `data-dg-i18n-ignore`, histórico `#wrap`, campos editáveis e blocos de
código não são percorridos. Não há varredura por palavras, MutationObserver global,
tradução automática externa, `eval`, escrita de prompt ou alteração de autenticação.
Os dados da marca são interpolados depois de traduzir o template de fábrica.

No servidor, `web/lib/idioma-contexto.js` isola cada requisição com
`AsyncLocalStorage`. A identidade da mensagem própria fica em `WeakMap`, associada
ao objeto e à propriedade, sem procurar strings iguais em nomes ou dados externos.
`descricao(fonte, parâmetros)` cria essa descrição privada; `objeto({ erro:
descricao(...) })` mantém o campo `erro` como string PT primitiva e guarda sua
identidade separadamente. `criarErro(Tipo, argumentos)` faz o mesmo com erros,
preservando o tipo, os demais campos e `Error.message` em português.

Somente a saída HTTP usa `replacer`: `H.enviaJson` e o serializador JSON do Express
traduzem os campos com identidade própria, inclusive objetos aninhados. Um
`JSON.stringify` normal, usado para persistência ou logs, conserva o conteúdo PT.
Mensagens externas não ganham identidade por coincidirem com um texto do catálogo.

Ao encaminhar uma mensagem própria, use `campo(objeto, 'erro')` ou
`campo(excecao, 'message')` apenas na construção da saída de interface. Nas decisões
internas, continue lendo os campos normais, que são strings. Parâmetros comuns
ficam literais; somente descrições privadas explicitamente encadeadas são traduzidas.
Nunca crie uma descrição usando o texto recebido de um provedor ou de uma pessoa
como fonte. `texto()` destina-se à apresentação imediata de fontes próprias.

Para copiar mensagens próprias, use `atribuir(destino, ...fontes)` ou
`objeto({ ...espalhar(origem) })`. A última propriedade prevalece: uma sobrescrita
externa, mesmo com texto idêntico, perde a tradução anterior. Para alterar um campo
de mensagem existente, use `definir(objeto, chave, valor)`. Isso também remove a
identidade ao receber um dado comum. `mensagem()` é compatibilidade para diagnósticos
PT, sem registro ou tradução implícita. Os gravadores isolados continuam sem
dependência do catálogo e devolvem seus diagnósticos no idioma original.

### Provas

`web/test/idioma.test.js` cobre configuração, cookie, catálogo, placeholders,
renderização, tamanho HTTP, assets públicos e ausência de liberação de API.
`web/test/proxy.test.js` cobre a passagem da preferência sem passar o cookie de
sessão do Web. `web/test/idioma-contexto.test.js` cobre identidade, cópias,
sobrescritas, persistência PT e requisições simultâneas. A regressão
`web/test/idioma-identidade-http.test.js` reproduz o nome de agente idêntico a um
aviso do registro e confere que ele permanece literal dentro de um erro do proxy.
`qa/idiomas.cjs` exercita o DOM e o cartão de conta com Claude e Codex,
sem conectar uma conta nem iniciar inferência. Ele usa jsdom 26.1.0 como ferramenta
opcional de QA; não adiciona dependência de produção:

```sh
npm install --prefix /tmp/dgclaw-i18n-qa --ignore-scripts jsdom@26.1.0
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/idiomas.cjs
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/painel-idiomas.cjs
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/idiomas-atualizacao.cjs
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/seguranca-idiomas.cjs
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/integracoes-idiomas.cjs
NODE_PATH=/tmp/dgclaw-i18n-qa/node_modules node qa/apps-idiomas.cjs
```

O QA cobre troca PT/EN, marca, nome do agente, rascunho, primeiro acesso fictício,
controles da conversa sem substituir mensagens ou áudio, decisões de permissão
e o campo multipart `arquivo` em inglês. Os testes HTTP cobrem erros de login e
recusa de APIs sem sessão. HTML renderizado e teste de DOM não provam login real
de uma instalação, conta conectada nem resposta de agente.

## Conexões da configuração

Entrada: `DGCLAW_WEB_IDIOMA` e cookie validado em `web/lib/idioma.js`.
Saída: renderização Web, proxy do painel e rótulos em `web/public/ds/idioma.js`.
A superfície é o seletor; falha de persistência aparece nele e idioma de ambiente
inválido aparece no log. A próxima navegação relê a preferência persistida.
Não há demanda comercial nem decisão automática nova: idioma é apresentação;
o fluxo IA e humano continua usando o conteúdo e as permissões existentes.
