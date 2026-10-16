# Aba Cofre

A tela onde o **dono do agente** guarda a chave de um serviço que se paga à
parte, para que o agente possa usá-lo. O caso que pediu a tela: dar ao Bento
(o agente do Paulo) uma chave da OpenAI para gerar capa de YouTube.

Antes dela, dar uma chave a um agente exigia alguém com acesso à máquina editando
um arquivo de configuração à mão.

## O que a tela faz

| Bloco | O que é |
| --- | --- |
| A chave é sua, e a conta também | O aviso de que quem gera a chave é o dono do agente, na conta dele, e que o gasto é cobrado dele pelo próprio serviço |
| Chaves guardadas | Uma linha por chave: serviço, nome, quatro últimos caracteres, quem cadastrou, quando, e se está ativa ou revogada |
| Guardar uma chave | Escolher o serviço preenche o nome certo e mostra o endereço onde gerar a chave. O campo da chave nasce escondido |
| Fazer a chave valer | Reinicia o agente, que é o que faz a chave passar a valer. Quando não há como reiniciar daqui, diz isso em vez de fingir que reiniciou |
| Quem pode guardar chaves aqui por API | As chaves de API deste agente: nome, quem criou, quando, último uso e revogar. O botão de criar mostra o token uma vez |
| Como a chave fica guardada | Como ela é cifrada, onde o texto puro aparece na hora do uso, e que ela vale só para este agente. Outro agente não a enxerga: para ele usar o mesmo serviço, o dono dele cadastra lá ou autoriza alguém (com uma chave de API daquele agente) a cadastrar |

## Guardar por API (sem a tela)

Outro assistente (a assistente principal ou o Admin) pode guardar chaves neste agente
usando uma **chave de API** do painel (`Authorization: Bearer dgc_...`). O passo a
passo, com exemplos que nunca põem o valor na linha de comando, está em
`docs/COFRE-POR-API.md`. O que muda na tela e na API:

- `POST /api/cofre` por chave de API registra `cadastradaPor` como
  `<nome da chave> (por API)` e `origem: 'api'`. Pela tela, `origem: 'tela'`. A tabela
  mostra a origem em cada linha.
- `POST /api/cofre` aceita `"aplicar": true`: guarda e, se deu certo, reinicia o
  agente na mesma chamada. A resposta traz as duas coisas (`aplicado`). Se o reinício
  falhar, a chave continua guardada e o status é de erro.
- `GET /api/cofre` continua sem valor nenhum. `tem(envName)` (em `lib/cofre.js`) diz
  só se existe uma chave ativa com aquele nome, sem abrir o arquivo cifrado.
- Uma chave de API **não** gerencia chaves de API (`/api/chaves-api*` responde 403).
  As chaves ficam em `<agentDir>/.dgclaw/panel/chaves-api.json` (modo 600, só o hash).
  Na máquina: `node panel/bin/chave-api.js criar|listar|revogar`.
- `CLAUDE_CODE_OAUTH_TOKEN` é a única variável `CLAUDE_*` aceita: é o token que o
  próprio Claude Code gera com `claude setup-token`, e substitui copiar o
  `.credentials.json` entre contêineres (a cópia derrubava o login quando um deles
  renovava o token). O resto do prefixo `CLAUDE_` continua recusado, porque muda o
  comportamento do binário. Na lista de serviços da tela ele aparece como "Claude
  (assinatura, token do setup-token)".

## De onde vem o dado

Tudo de `GET /api/cofre`, que devolve **metadado e nunca valor**. O valor não
passa por essa rota nem por nenhuma outra: ele mora cifrado em
`<agentDir>/.dgclaw/cofre/segredos/<NOME>.enc`, e o único código que o decifra é a
materialização, que escreve o arquivo de ambiente e devolve uma contagem.

**Não existe rota de leitura em claro, de propósito.** Se existisse, um dia
alguém a chamaria. Quem perdeu a chave gera outra no provedor.

## O que o dono decide com ela

Quais serviços pagos o agente dele pode usar, e quando parar de deixar. Revogar
tira a chave do cofre; cancelar a chave de verdade é no site do serviço, e a tela
diz isso.

## As decisões que não são óbvias

**Guardar e aplicar são dois botões.** Reiniciar o agente interrompe o que ele
estiver fazendo, então é decisão do dono e não efeito colateral de ter clicado em
guardar. O texto da tela repete três vezes, de jeitos diferentes, que guardar não
é o mesmo que valer: sem isso o modo de falha é um "não autorizado" três dias
depois, que ninguém liga a esta tela.

**O nome da variável passa por lista de PERMITIDOS.** Não é preciosismo: o cofre
escreve no ambiente de um processo que roda como root, e `NODE_OPTIONS`,
`LD_PRELOAD` e `BASH_ENV` transformariam essa tela em execução de código na
máquina. A régua e o motivo de cada recusa estão no cabeçalho de
`panel/lib/cofre.js`. Quando um nome legítimo for recusado, quem administra a
máquina libera aquele nome específico com `cofreNomesExtras` no `config.json`, que
o painel lê e nunca escreve.

**Substituir uma chave é permitido; a aba Pasta recusa sobrescrever e aqui não.**
Lá, escrever por cima apagaria trabalho do agente. Aqui, cadastrar de novo é
justamente o que se faz ao girar uma credencial, e recusar deixaria o agente sem
chave nenhuma no meio do caminho.

**A tabela vira cartão no celular.** As outras tabelas do painel rolam para o
lado; esta não pode, porque a pessoa precisa ler qual chave é antes de clicar em
revogar, e a coluna escondida fora da tela é sempre a que some.

## Como pendurar na unidade do agente

A tela guarda; quem entrega a chave ao agente é o
`panel/bin/cofre-materializar.js`, chamado uma vez por inicialização. Ele decifra
o cofre e escreve `/run/dgclaw/<slug>.env` (memória, modo 600), que some quando a
máquina desliga.

Na unidade do agente:

```ini
[Service]
ExecStartPre=/usr/bin/node /caminho/do/painel/bin/cofre-materializar.js
EnvironmentFile=/run/dgclaw/<slug>.env
ExecStopPost=/bin/rm -f /run/dgclaw/<slug>.env
Environment=DGCLAW_PANEL_CONFIG=/caminho/do/agente/.dgclaw/panel/config.json
```

Sem o `-` na frente do `ExecStartPre`: se o cofre não abrir, o agente **não sobe**,
e isso é de propósito. Subir sem as chaves só adia o erro para longe daqui.

### Dentro da jaula, isso vai num drop-in

No contêiner da jaula o agente é o único morador e a unidade dele se chama
`dgclaw-runner.service`, sem slug no nome. **Ela é escrita e reescrita pelo
`lib/instalar-vida.sh` da plataforma**, então as três linhas acrescentadas
direto no arquivo somem na próxima reinstalação, caladas. O lugar certo é um
drop-in, que sobrevive:

```
/etc/systemd/system/dgclaw-runner.service.d/cofre.conf
```

O painel de lá roda dentro do próprio contêiner, no mesmo systemd que o agente,
então ele reinicia a unidade direto, sem atravessar borda nenhuma.

### Qual unidade o cofre reinicia

Nesta ordem:

1. o que estiver em **`cofreUnidade`** no `config.json`, sem conferir nada: quem
   escreve ali é quem administra a máquina, e ele sabe mais do que o palpite;
2. `dgclaw-runner`, se `/etc/systemd/system/dgclaw-runner.service` existir (é o
   sinal de que estamos dentro de um contêiner da jaula);
3. `dgclaw-agent-<slug>` ou `dgclaw-<slug>`, **e só se estiverem habilitadas e
   ativas**.

O item 3 diz "habilitada e ativa" e não "existe" por causa de um caso concreto:
`dgclaw-agent-ana.service` e `dgclaw-agent-bento.service` continuam no disco
de uma VPS depois do corte de 02/09/2026, desabilitadas e paradas, porque os dois
agentes passaram a rodar em contêiner. Aceitar "o arquivo existe" faria o botão
de aplicar subir o runner velho, fora do contêiner, apontando para a casa antiga:
dois runners para o mesmo agente, o painel mostrando o errado, e nenhum erro em
lugar nenhum. Quando a unidade existe mas está parada, a tela diz exatamente isso
e não encosta nela.

### Reiniciar pisca o terminal, e a tela avisa

O restart mata o PTY do agente. A conversa **não se perde** (ele volta pelo
`--resume`, de onde parou), mas quem estiver com a aba Conversa aberta vê o
terminal piscar por alguns segundos. Está escrito na tela e no tutorial, porque
susto sem explicação vira chamado de suporte.

No agente de plugin, que sobe por `launch.sh` e lê `config.sh` em vez de
`EnvironmentFile=`, o `config.sh` ganha **uma linha**, e nunca o valor de um
segredo:

```sh
set -a; . /run/dgclaw/<slug>.env; set +a
```

O `config.sh` não recebe o valor direto porque é script de shell: valor com
`$(...)`, crase ou aspas dentro dele deixa de ser configuração e vira comando
rodando na inicialização do agente.

## Na v1: quem grava é o DG Claw Web

No DG Claw v1 o agente roda num container. Se o painel de dentro guardasse a chave, o agente conseguiria lê-la (a chave mestra ficaria na casa dele). Por isso, nesse layout, **quem guarda e reinicia é o DG Claw Web, no servidor**, e o painel de dentro só mostra.

- **De onde vem o dado.** O valor fica em `<casa>/cofre/cofre.env`, numa pasta que só o administrador da máquina lê. O painel de dentro recebe apenas os nomes, em `/run/dgclaw/config/cofre-nomes` (montado só para leitura; a variável `DGCLAW_COFRE_NOMES` liga esse modo). Quem cadastrou, quando e os 4 últimos caracteres ficam num registro do Web fora da casa do agente.
- **Por que o painel de dentro recusa.** Com `DGCLAW_COFRE_NOMES` definida, guardar, revogar, aplicar e materializar devolvem 409 com o caminho certo, e nada é gravado em disco (nem pasta de cofre, nem chave mestra). O `POST /api/provedor` com chave também devolve 409.
- **Como o dono usa.** Abrindo o painel pelo endereço do DG Claw (o do site, com o login), e não pela porta direta. A aba Cofre é a mesma: o Web responde `/p/<agente>/api/cofre` por conta própria.
- **Como a chave passa a valer.** O runner lê o cofre só quando parte. Guardar não reinicia; "aplicar e reiniciar" (ou `aplicar: true` no mesmo pedido) roda `systemctl restart dgclaw-runner` dentro do container.
- **Pelo servidor.** `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar NOME_API_KEY --aplicar`. O valor sempre vem pelo stdin. Detalhes das rotas e da linha de comando em `web/README.md`.

## Para quem for mexer

Leia antes as regras de segurança do cofre, as regras
escritas **antes** desta tela existir, com as 12 regras que o código
implementa. O cabeçalho de `panel/lib/cofre.js` diz qual linha de código é qual
regra.
