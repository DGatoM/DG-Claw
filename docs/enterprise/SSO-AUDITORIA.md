# Login único (SSO) e auditoria completa

Bloco G da versão enterprise. Este documento cobre três coisas que trabalham juntas: o login único por OIDC,
a trilha de auditoria completa (com tela, conferência e exportação) e o envio da trilha para fora da VPS.
O contrato geral está em `docs/enterprise/DESENHO.md`; aqui está o que cada parte faz, como configurar e como conferir.

No nível `pessoal` nada daqui existe: as rotas não respondem, nenhum arquivo é criado e o login é o de sempre.

| Chave da matriz | pessoal | escritório | empresa | regulado |
| --- | --- | --- | --- | --- |
| `sso` | nao | opcional | padrao | obrigatorio (travado) |
| `auditoria` | nao | basica | completa | externa (travado) |

## 1. Login único (SSO) por OIDC

### O que é e por que existe

A pessoa entra com a conta da empresa (Google Workspace, Microsoft Entra ID ou outro provedor OIDC) em vez de
uma senha do painel. Quem sai da empresa perde o acesso no mesmo instante, porque o provedor deixa de emitir o
login, e o TI controla as contas em um lugar só. O DG Claw não guarda senha de quem entra por SSO.

### O que o fluxo faz

Authorization code com PKCE (S256). `GET /sso/entrar` cria `state`, `nonce` e o verificador do PKCE, guarda os
três num cookie assinado de 10 minutos (`dgclaw_sso`, HttpOnly, SameSite=Lax, só para `/sso`) e manda a pessoa
ao provedor. `GET /sso/retorno` confere o `state` contra o cookie, troca o `code` pelo `id_token` (o segredo vai
no corpo do POST, nunca na URL) e valida o token com `node:crypto`, sem biblioteca de terceiros:

- assinatura RS256 ou ES256 pela chave do JWKS com o mesmo `kid` (qualquer outro algoritmo é recusado, inclusive `none` e HS256);
- `iss` igual ao emissor configurado, `aud` igual ao `client_id` (e `azp` quando há mais de uma audiência);
- `exp` no futuro e `iat` com folga de 2 minutos para relógio adiantado;
- `nonce` igual ao da tentativa;
- Entra: `tid` igual ao `tenant` configurado;
- Google: `email_verified` verdadeiro e `hd` dentro de `dominios_permitidos` (conta pessoal do Gmail não entra);
- todos: e-mail presente, `email_verified` não pode ser falso, e o domínio do e-mail precisa estar em `dominios_permitidos` quando a lista existe.

### Quem entra

O e-mail do token procura o usuário com o mesmo `email` no `usuarios.json`. **O SSO nunca cria usuário**: o TI
cadastra antes (`dgclaw usuario criar ... --email`, ou a tela Usuários). Quem não está cadastrado vê uma página
dizendo "peça ao administrador de TI para cadastrar o seu e-mail". Usuário desativado não entra. Se dois usuários
vivos têm o mesmo e-mail, ninguém entra por esse e-mail até o TI deixar um só.

### Segundo fator

O login por SSO conta como segundo fator **feito pelo provedor da empresa** (`fa2_em` = agora, `via: "sso"` na sessão).
Isso só vale se a empresa exige MFA no próprio provedor. Sem MFA lá, o SSO é tão forte quanto a senha da conta Google
ou Microsoft. Configure a exigência de MFA no Google Workspace ou no Entra antes de pôr o painel em modo `padrao` ou `obrigatorio`.

### Os três modos

| Modo | Tela de entrada | Senha |
| --- | --- | --- |
| `opcional` | botão "Entrar com X" ao lado do formulário | vale para todos |
| `padrao` | só o botão, em destaque; a senha fica atrás do link "Entrar com senha" | vale para todos |
| `obrigatorio` | só o botão; um link discreto leva à conta de emergência | **desligada para todos**, menos a conta de emergência |

Mudar o modo: `dgclaw nivel ajustar sso padrao` (nunca abaixo da trava do nível). Vale sem reiniciar o Web.

### Conta de emergência

No modo `obrigatorio`, se o provedor cair, ninguém entraria. Por isso o TI marca **uma** conta de emergência:
`dgclaw sso emergencia <usuario-ti>` (só uma por instalação, precisa ser TI e estar ativa). Ela entra com senha e
**sempre com segundo fator**: se a conta não tem 2FA ativo e o nível não o exige, o login dela é recusado com a explicação.
Cada tentativa vira o evento `login_emergencia_tentativa` na auditoria e uma linha de aviso no log do Web. O
`dgclaw status` e o `dgclaw sso status` avisam quando ela entrou nos últimos 30 dias. `dgclaw sso emergencia --remover <usuario>` tira a marca.

Sem conta de emergência e com o provedor fora do ar, o jeito de voltar é o do servidor: `dgclaw nivel ajustar sso padrao`
(se o nível deixar) ou corrigir o `sso.json`. O `dgclaw sso status` avisa que essa conta falta.

### Configurar

O arquivo é `/etc/dgclaw/sso.json` (600, root):

```json
{
  "provedor": "google",
  "client_id": "...",
  "client_secret": "...",
  "dominios_permitidos": ["empresa.com.br"]
}
```

Provedores:

- `google`: emissor fixo `https://accounts.google.com`; `dominios_permitidos` é obrigatório.
- `microsoft`: `tenant` é o ID do diretório (um GUID). `common` e `organizations` são recusados, porque o emissor do token muda de empresa para empresa e não dá para conferir.
- `oidc`: qualquer provedor (Keycloak, Okta, Auth0...). `emissor` é o endereço base que tem `/.well-known/openid-configuration`; precisa ser `https://`.

Campos opcionais: `nome` (texto do botão, "Entrar com <nome>"; padrão pelo provedor) e `redirect_uri` (endereço de retorno fixo; sem ele vale a origem do pedido mais `/sso/retorno`, o que depende de o proxy repassar o host certo).

Pela CLI, com o segredo **sempre por stdin ou arquivo, nunca na linha**:

```bash
printf %s "$SEGREDO" | dgclaw sso configurar --provedor google --client-id <id> \
    --dominios empresa.com.br --segredo-stdin
dgclaw sso testar       # busca a descoberta e o JWKS e diz o que achou
dgclaw sso status
```

Com terminal e sem `--segredo-*`, o comando pede o segredo sem eco. `--manter-segredo` reaproveita o segredo atual ao mudar outros campos.
No provedor, cadastre como endereço de retorno `https://<dominio-do-painel>/sso/retorno` (o `dgclaw sso configurar` imprime o endereço certo).
O teste (`dgclaw sso testar`) não faz login: confira o botão na tela de entrada com uma conta de teste.

### Códigos de erro na tela de entrada

A tela mostra uma frase em português para cada `?erro=sso_<codigo>`: `estado` (a tentativa expirou ou não é desta janela), `provedor`
(não consegui falar com o provedor), `token` (resposta que não consegui confirmar), `dominio`, `email`, `desativado`, `recusado`,
`ambiguo`, `config`, `obrigatorio` e `emergencia`. O detalhe técnico vai para o log do Web e para o evento `sso_falha` da auditoria
(sem token, sem segredo).

## 2. Auditoria completa (`auditoria` = completa)

### O que passa a ser registrado

Além dos eventos da básica (login, usuários, 2FA, comandos de administração):

| Evento | Quando | Dados |
| --- | --- | --- |
| `api_mutacao` | toda escrita na API do Web (POST, PUT, PATCH, DELETE) | método, rota, **nomes** dos parâmetros de query (nunca os valores), status, agente alvo, `credencial: "caixa-do-agente"` quando é o agente falando |
| `painel_aberto` | abertura bem-sucedida de `/p/<slug>/` | agente |
| `midia_baixada` | download explícito de mídia (`?baixar=1`) | id da mídia |
| `agente_comando` | cada comando de máquina que um agente roda (lido do transcript) | agente, ferramenta e **título já mascarado**; nunca a saída |
| `auditoria_exportada` | exportação pela tela, pela API ou pela CLI | formato, filtros, total |
| `nivel.definir`, `nivel.ajustar` | mudança de nível (já existia, vem da CLI) | de, para |
| `sso_falha`, `login_emergencia_tentativa`, `login_recusado_sso` | login único | motivo |

Quem faz: o campo `quem` é o usuário da sessão, `agente:<slug>` para a caixa e para os comandos, e o usuário do sistema para a CLI.
Fica de fora de propósito: senha, conteúdo de conversa, corpo de requisição e saída de comando. O registro prova o que foi feito,
não carrega o que o dono quer manter privado.

Uso de chave de API: o Web hoje não tem chaves de API de usuário; a credencial em uso é a **caixa do agente** (o agente falando com o Web). Ela aparece
como `credencial: "caixa-do-agente"` nas mutações. Se o serviço de controle ganhar chaves próprias, os eventos dele entram pela origem `controle`.

### A origem "controle"

Cada linha tem `origem`: `web` (o painel), `cli` (um comando no servidor) ou `controle` (o serviço de controle do bloco C).
A trilha aceita as três na mesma corrente. Quem escreve em Node passa `registrar(evento, dados, quem, 'controle')`; quem escreve em bash
exporta `DGCLAW_AUDITORIA_ORIGEM=controle` antes de chamar `auditar` (só letras minúsculas, números, traço e sublinhado). A tela, a API
e a exportação filtram por origem. Este bloco não implementa nada do controle: só garante que a trilha o aceita e o mostra.

### A corrente por mês

No nível completo em diante, na primeira gravação de um mês novo o `auditoria.jsonl` vira `auditoria-AAAA-MM.jsonl`
(o mês da última linha dele, em UTC) e começa outro `auditoria.jsonl`. A primeira linha do arquivo novo guarda em `ant` o
hash da última linha do mês anterior, então a corrente atravessa os arquivos sem emenda. O arquivo vivo mantém o nome
`auditoria.jsonl` de propósito: tudo que já lê a linha mais nova (testes, ferramentas, o bash) continua achando.
A trava é sempre `auditoria.jsonl.trava`, tanto no bash quanto no Node.

### Conferir

```bash
dgclaw auditoria verificar          # "Corrente íntegra: N linhas em K arquivos" ou "QUEBRADA na linha N (arquivo, linha M)"
dgclaw auditoria selo               # o hash da última linha: o que o selo por hora leva
```

A conferência recalcula o hash de cada linha e compara a cadeia inteira, de um arquivo para o outro. Linha alterada, apagada, reordenada ou arquivo
mensal apagado aparecem com o arquivo e o número da linha. O `dgclaw status` repete o resultado, e a tela `/auditoria` o mostra toda vez que abre.

Limite que fica: a corrente prova que nada foi mexido **no meio**. Cortar o fim da trilha só se descobre guardando o último hash fora da VPS, e é para isso que existe a auditoria externa (seção 3).

### Exportar

```bash
dgclaw auditoria exportar --de 2026-10-01 --ate 2026-10-31 --formato csv --saida /root/auditoria-outubro.csv
dgclaw auditoria exportar --evento login_falha --quem ana.silva > falhas.jsonl
```

Filtros: `--de`, `--ate` (AAAA-MM-DD, inclusivos, em UTC), `--evento`, `--quem`, `--origem`, `--q` (texto livre). `jsonl` devolve as linhas **exatamente como foram
escritas**, então continuam conferíveis; `csv` serve para planilha (célula que começaria com `=`, `+`, `-` ou `@` ganha um apóstrofo na frente, para a planilha não executá-la). Sem `--saida` vai para a tela.
A exportação também entra na auditoria.

No Web: tela `/auditoria` (só o TI) com filtros, paginação, a indicação "corrente íntegra" ou "corrente quebrada na linha N" e os botões de exportar.
API (também só TI): `GET /api/v1/auditoria` (filtros `de`, `ate`, `evento`, `quem`, `origem`, `q`, `pagina`, `por`), `GET /api/v1/auditoria/exportar?formato=jsonl|csv&...`
e `GET /api/v1/auditoria/externa`. Ninguém escreve na trilha pela API.

### Retenção: 5 anos, e por quê

A trilha é a prova de conformidade da empresa: é ela que responde, anos depois, "quem fez o quê e quando" numa auditoria ou num processo. Por isso o prazo dela é
separado de `retencao_dias` (que vale para conversas, anexos e logs e pode ser de 30 dias) e o padrão é de **5 anos (1825 dias)**, com mínimo de 365.

```bash
dgclaw auditoria retencao mostrar
dgclaw auditoria retencao definir 2555          # 7 anos
dgclaw auditoria retencao aplicar               # só mostra o que passou do prazo
dgclaw auditoria retencao aplicar --confirmar   # apaga os meses fechados mais antigos que o prazo
```

A poda apaga só meses **fechados** e contíguos a partir do mais antigo, nunca o arquivo vivo, e recusa se a corrente estiver quebrada. Antes de apagar,
grava `auditoria-poda.json` com o hash da última linha apagada: a conferência passa a esperar esse hash na primeira linha que sobrou, e a corrente continua conferível.
Exporte os meses para o arquivo morto da empresa antes de confirmar. O prazo fica em `/etc/dgclaw/auditoria.json`.

## 3. Auditoria externa (`auditoria` = externa, nível regulado)

### O que é

Cada linha da trilha também sai da VPS, para um destino da empresa. Quem vê a trilha só na VPS depende de a VPS não ter sido mexida;
com a cópia fora, mexer na VPS não apaga o que o destino já recebeu.

### Destino

Em `/etc/dgclaw/auditoria-externa.json` (600):

```json
{ "tipo": "http", "url": "https://siem.empresa.com/coletor", "token": "..." }
{ "tipo": "syslog", "host": "logs.empresa.com", "porta": 6514, "ca": "/etc/dgclaw/ca-logs.pem" }
```

- `http`: POST JSON com `Authorization: Bearer <token>` (opcional). Cada lote traz `eventos` (objetos, para o SIEM indexar) e `brutas` (as linhas exatamente como foram escritas, para conferir o hash).
- `syslog`: RFC 5425 (TLS), mensagens RFC 5424 com enquadramento por contagem de octetos; o corpo da mensagem é a linha original. TLS é obrigatório; `ca` aponta a autoridade quando o certificado do servidor é de uma autoridade própria. Syslog sem TLS não é aceito.

```bash
printf %s "$TOKEN" | dgclaw auditoria externa configurar --tipo http --url https://siem.empresa.com/coletor --token-stdin
dgclaw auditoria externa configurar --tipo syslog --host logs.empresa.com --ca /etc/dgclaw/ca-logs.pem
dgclaw auditoria externa testar     # manda uma mensagem de teste (tipo "teste"), que não entra na corrente
dgclaw auditoria externa status     # destino, pendentes, último envio, último selo, último erro
dgclaw auditoria externa enviar     # força uma rodada agora
```

O token entra por stdin ou arquivo, nunca por argumento, e não aparece em log, em status nem no estado.

### Fila e reenvio

A fila é a própria trilha: o estado (`auditoria-externa-estado.json`, na pasta de dados do Web) guarda o hash da última linha entregue, e o que vem
depois dela está pendente. Não existe cópia que possa se perder. O Web tenta a cada 30 segundos (lotes de 100 linhas). Se o destino falha, o ponto não anda e a
próxima rodada recomeça dali, sem perder nem repetir linha, inclusive atravessando a virada do mês. Se alguém reescrever a linha em que o envio parou, o
envio para, marca `corrente_alterada` e diz o que fazer, em vez de continuar a partir de um histórico que mudou.

**Alerta:** fila pendente há mais de 1 hora, ou corrente alterada atrás do ponto entregue, vira problema do monitor (`dgclaw monitor`), aparece no `dgclaw status` e na tela `/auditoria`.

### Selo e como a empresa confere

A cada hora, com tudo entregue, o hash da última linha também é enviado como **selo** (`tipo: "selo"` no HTTP; mensagem `SELO` no syslog).
Se o selo fica de fora (destino fora do ar), ele espera, porque cobriria linhas que o destino ainda não tem.

Para a empresa provar que o arquivo local não foi reescrito:

1. O destino guarda todos os selos com a hora em que chegaram (ele já guarda as linhas).
2. Quando quiser conferir, rode `dgclaw auditoria verificar` na VPS (a cadeia inteira tem que estar íntegra) e compare o hash de um selo antigo com a linha de mesmo `hash` na trilha local: o selo de ontem precisa aparecer na trilha de hoje, na mesma posição relativa às linhas que o destino recebeu.
3. Se a trilha local for reescrita depois, a cadeia passa a produzir hashes diferentes dos que o destino guardou, e o selo antigo deixa de ser encontrado. A diferença é a prova.
4. Cortar o fim da trilha local também aparece: o destino tem linhas e selos que a VPS não tem mais.

## 4. Decisões que o DESENHO não cobria

- **Rotação mantém o nome `auditoria.jsonl` para o arquivo vivo** e fecha o mês renomeando-o. O texto da especificação dizia "o arquivo vira auditoria-AAAA-MM.jsonl por mês"; o arquivo vivo com nome fixo evita quebrar quem lê `auditoria.jsonl`.
- **Nível básico não rotaciona.** Só completa e externa fecham meses.
- **A fila externa é o próprio arquivo de auditoria** mais um ponteiro por hash, não um segundo arquivo.
- **Uma conta de emergência por instalação**, e ela só entra com 2FA.
- **Os comandos de agente só são registrados a partir do momento em que a auditoria completa liga** (`desde` em `auditoria-comandos.json`), para o leitor de transcript não despejar o histórico antigo na trilha. Depois de um restart o leitor relê o transcript; o registro evita duplicata pelo instante e pelo id de cada comando.
- **Ver mídia na tela não conta como download**; só `?baixar=1`.
- **Abrir `/p/<slug>/` só conta quando deu certo** (status abaixo de 400), uma vez por abertura.
