# Controle do servidor e Admin isolado (bloco C)

Proteção da matriz: `admin_isolado` (liga sozinha em `escritorio`, `empresa` e `regulado`, e é travada nesses níveis).

## O problema

No DG Claw de sempre o Admin é um Claude Code que roda como root no servidor, em `bypassPermissions`, e executa
`sudo dgclaw ...` direto no shell. Tudo o que ele lê (um log, um arquivo colado no chat, a saída de um comando)
pode conter uma instrução escondida. Se ele a seguir, vira root na máquina da empresa.

A decisão do desenho é esta: **nenhum modelo de linguagem roda no servidor com poder.** O Admin passa a ser um
agente em container, igual aos outros, sem root e sem sudo. Para mexer na máquina ele só faz **pedidos** a um
serviço determinístico (o controle), que executa uma lista fechada de operações. O que é perigoso espera uma
pessoa do TI aprovar no painel.

## As peças

```
 container do Admin                 servidor (host)
┌────────────────────┐   caixa    ┌──────────────┐  socket unix   ┌────────────────────┐
│ Admin (Claude)     │──────────▶│ DG Claw Web  │───────────────▶│ dgclaw-controle    │
│ dgclaw-controle    │ arquivos  │ (root)       │ /run/dgclaw/    │ (root, sem LLM)    │
│ sem root, sem sudo │◀──────────│ rotas, fila  │ controle.sock   │ catálogo fechado   │
└────────────────────┘           │ de aprovações│                 │ chama bin/dgclaw   │
                                 └──────▲───────┘                 └────────────────────┘
                                        │ navegador (TI, com 2FA)
```

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Serviço de controle | `controle/servidor.js` | Escuta o socket, valida, confere a aprovação, executa e audita. Node 22 sem dependências. |
| Catálogo | `controle/catalogo.js` | A lista fechada de operações, com o esquema de cada parâmetro, a frase de confirmação e o argv. |
| Fila de aprovações | `web/lib/ent/aprovacoes.js` | Genérica: qualquer bloco registra um tipo. Página `/aprovacoes`, API, 2FA recente, prazo, auditoria, push. |
| Armazenamento | `web/lib/aprovacoes-arquivo.js` | Um arquivo por pedido, com trava. O Web e o controle usam o mesmo. |
| Rotas do Admin | `web/lib/ent/controle-rotas.js` | `POST /api/v1/controle/<operação>` pela caixa (só o agente com `papel: "admin"`) e pelo navegador (só TI). |
| Cliente do Admin | `bin/dgclaw-controle` | O comando que o Admin usa dentro do container. |
| CLI do host | `lib/enterprise/admin-isolado.sh` | `dgclaw admin isolar`, `host`, `status`, `manutencao`. |
| Identidade do Admin | `templates/admin-isolado/` | `CLAUDE.md`, `AGENTS.md` e a skill `criar-agente` do Admin sem root. |

## Operações por classe

O catálogo é fechado. Parâmetro que não está no esquema é recusado. Slug precisa casar `^[a-z0-9][a-z0-9-]{1,30}$`
(`../`, `;`, espaço, maiúscula e acento não passam), e `admin` e `admin-manutencao` são reservados. Texto livre
(nome, papel, jeito) só existe onde é só texto, não tem quebra de linha e vai para o `execFile` como um item do argv.

**Leitura** (executa na hora)

| Operação | O que faz |
| --- | --- |
| `agentes.listar` | Lê o registro: slug, nome, tipo, papel, provedor, container. Nenhum campo de segredo. |
| `agente.status` | Estado do container e do runner (`dgclaw agente listar --json`), de um agente ou de todos. |
| `agente.log` | Últimas N linhas (1 a 200) do log do runner, com segredos mascarados. |
| `status.geral` | `dgclaw status`. O código de saída vem como dado, não como erro. |
| `imagem.status` | `dgclaw imagem status`. |
| `nivel.mostrar` | `dgclaw nivel mostrar`. |
| `cofre.nomes` | Só os NOMES das chaves do cofre de um agente. Nunca o valor. |
| `pedido.ver` | Estado de um pedido de aprovação. |
| `tarefa.ver` | Estado de uma operação demorada. **Acréscimo ao desenho** (ver "Decisões"). |

**Reversíveis** (executam direto e vão para a auditoria)

`agente.criar`, `agente.iniciar`, `agente.parar`, `agente.reiniciar`, `agente.reparar`, `imagem.construir` e
`agente.pacote` (usa o `dgclaw agente pacote` do bloco D). As que levam mais que alguns segundos
(`agente.criar`, `iniciar`, `parar`, `reiniciar`, `reparar`, `pacote` e as perigosas `remover` e `dominio.trocar`)
são **demoradas**: respondem na hora com um identificador de tarefa e rodam em segundo plano. Acompanha-se com
`dgclaw-controle tarefa <id>`; o `dgclaw-controle` já espera sozinho até 20 s (ajustável com `--espera`).

**Perigosas** (só executam com aprovação)

| Operação | Frase que o TI lê |
| --- | --- |
| `agente.remover` | Remover o agente `x`. A casa dele vai para aposentados. |
| `dominio.trocar` | Trocar o endereço do painel para `x`. O painel muda de endereço e um certificado novo é pedido. |
| `nivel.ajustar` | Ajustar a proteção `x` para `y`. |
| `manutencao.abrir` | Abrir a manutenção de emergência por N minutos (de 5 a 60). |
| `travas.liberar` | Liberar as travas de ações externas do agente `x` por N minutos. Para o bloco E: o comando `dgclaw travas liberar` é dele. Até existir, a CLI responde que o comando não existe. |

Não existe operação de cofre pelo Admin. A chave de serviço é colada pelo TI no painel e nunca passa pelo modelo.

## Fluxo de uma operação perigosa

1. O Admin roda `dgclaw-controle agente.remover --agente ana`.
2. O Web valida os parâmetros com o mesmo catálogo, cria um pedido do tipo `controle` e responde `202` com
   `{pendente: true, aprovacao: <id>}`. O comando diz, em português, que **não executou** e onde o TI aprova.
   Pedir o mesmo de novo, da mesma pessoa, devolve o pedido que já existe (a fila do TI não enche).
3. O TI recebe o aviso no celular (se o aparelho estiver inscrito) e vê o contador "Aprovações" no menu.
4. Em `/aprovacoes` ele lê a **frase gerada pelo sistema** (não texto escrito pelo modelo) e os parâmetros exatos.
5. **Aprovar** exige sessão de navegador do TI e o 2FA confirmado há menos de 15 minutos. Se passou do prazo, a
   tela pede o código do aplicativo autenticador (`POST /api/v1/eu/reautenticar`) e repete a aprovação.
   **Recusar** não pede 2FA. A caixa (qualquer agente) nunca aprova nem recusa.
6. O Web chama o controle com `{op, params, quem, aprovacao: {id, aprovado_por, aprovado_em}}`. O controle **confere
   tudo de novo**, sem confiar no Web: o pedido existe, é do tipo `controle`, estado `aprovada`, mesma operação,
   mesmo hash dos parâmetros, não usado, não vencido, e quem aprovou bate com o registro. Marca `usada_em` na mesma
   trava e só então executa. Cada aprovação vale uma vez.
7. O pedido vira `executada` (ou `falhou`, com o motivo). O Admin acompanha com `dgclaw-controle pedido <id>`.

Um pedido vale 24 horas. Depois disso vira `expirada` e o agente precisa pedir de novo.

Estados: `pendente`, `aprovada`, `recusada`, `expirada`, `executada`, `falhou`. Arquivo:
`/var/lib/dgclaw/web/aprovacoes/<id>.json` (pasta 700, arquivo 600). Cabeçalho de `web/lib/ent/aprovacoes.js` tem o
contrato dos campos e **como outro bloco registra um tipo** (`ctx.aprovacoes.registrarTipo` e `.pedir`).

## Rotas

| Rota | Quem | O que faz |
| --- | --- | --- |
| `POST /api/v1/controle/<operação>` | Admin (caixa) e TI (navegador) | Corpo `{"params": {...}}`. Leitura e reversível executam; perigosa vira pedido (`202`). |
| `GET /api/v1/controle/docs.md` e `/ops` | Admin e TI | O catálogo, em markdown e em JSON (saem do mesmo código). |
| `GET /api/v1/controle/manutencao` | Admin e TI | Estado da manutenção de emergência (alimenta o aviso do chat). |
| `GET /aprovacoes` | TI | A página. |
| `GET /api/v1/aprovacoes[?estado=]`, `/resumo`, `/<id>` | TI | Lista, contador do menu, um pedido. |
| `GET /api/v1/aprovacoes/<id>` | o agente que pediu | Estado do próprio pedido, sem os parâmetros. Outro agente recebe 404. |
| `POST /api/v1/aprovacoes/<id>/aprovar` e `/recusar` | TI em navegador | Nunca pela caixa. Aprovar com 2FA velho devolve `403 {reautenticar: true}`. |

Funcionário recebe 403 em todas. No nível `pessoal` nenhuma responde (404) e nenhuma pasta é criada.

## Auditoria

Toda chamada ao controle grava na trilha comum (`origem: "controle"`): `controle_op` (com quem, operação, classe,
parâmetros mascarados, aprovação e resultado), `controle_recusado` (parâmetro inválido, sem aprovação, aprovação
inválida) e `controle_tarefa_fim`. A fila grava `aprovacao_criada`, `aprovacao_aprovada`, `aprovacao_recusada`,
`aprovacao_expirada`, `aprovacao_executada` e `aprovacao_falhou` (com o hash dos parâmetros, sem os parâmetros).
A manutenção grava `manutencao_aberta` e `manutencao_fechada`; isolar e voltar gravam `admin.isolar` e `admin.host`.

## O Admin em container

`dgclaw admin isolar` (e o instalador, quando `admin_isolado` está ligado e a imagem dos agentes já está pronta):

1. liga a proteção `admin_isolado`, se ainda não estiver;
2. instala `dgclaw-controle.service`, a unidade de manutenção e o sandbox do Web (ver abaixo);
3. guarda o registro do Admin do host em `/etc/dgclaw/admin-host.json`;
4. cria o agente `admin` pelo mesmo caminho do `dgclaw agente criar` (porta e uid próprios, cofre, firewall, teste de
   isolamento), com `tipo: "admin"` e `papel: "admin"` no `agentes.json`;
5. escreve a identidade nova (`templates/admin-isolado/`) e copia a memória e as instruções do Admin do host para
   `admin-anterior/` na casa do novo Admin (a pasta original `/opt/dgclaw/admin` fica intacta; o histórico de conversa
   do Claude em `/root/.claude` não é levado);
6. desliga e desabilita `dgclaw-admin.service`.

A conta do Claude do Admin é o assento do próprio TI: depois de isolar, ele abre o painel do Admin e usa **Entrar com a
assinatura**, como em qualquer agente.

O Web continua tratando o Admin como o primeiro da lista e **só para o TI**: o funcionário nunca o vê, tanto com
`tipo: "admin"` quanto com um agente comum de `papel: "admin"` (`agentesDeTrabalho()` e `podeVerAgente()` em
`web/lib/ent/usuarios.js`, com teste).

`dgclaw status`, o monitor e o `atualizar` passaram a perguntar a `ent_admin_unidades` quais serviços do Admin devem
estar de pé: `dgclaw-admin` no modo host, `dgclaw-controle` no isolado.

## Manutenção de emergência

Se o Admin isolado não consegue resolver algo (e só um root resolveria), o TI aprova `manutencao.abrir` (5 a 60
minutos). Isso:

- liga `dgclaw-admin-manutencao.service` (o Admin antigo, root no host) e registra o agente `admin-manutencao`
  (`tipo: "admin"`, sem papel, então não usa a caixa nem o controle e funcionário não o vê);
- agenda `systemd-run --on-active=<N>min dgclaw admin manutencao fechar --auto`, que para a unidade, tira o registro
  e apaga o estado. Usamos o `dgclaw` no lugar de só `systemctl stop` para o fechamento também limpar o registro e auditar;
- grava `manutencao_aberta` e `manutencao_fechada`;
- mostra uma faixa vermelha no topo das páginas do TI enquanto estiver aberta (`web/public/ent-controle.js`);
- o serviço de controle, ao subir, fecha uma manutenção vencida que tenha ficado para trás (queda de energia).

Fechar antes do prazo: `dgclaw admin manutencao fechar`. A unidade não é habilitada no boot e não tem `[Install]`.

## Como voltar ao modo host

`dgclaw admin host` devolve o registro do Admin do host, para o container (a casa fica, para um novo `isolar`),
religa `dgclaw-admin.service`, desliga o controle e desliga a proteção. **Só funciona onde a proteção não é travada**
(no `pessoal`; nos outros níveis o comando recusa antes de mudar qualquer coisa, e o caminho de emergência é a
manutenção). Para sair do isolado num nível travado, primeiro `dgclaw nivel definir pessoal`.

## Unidades do systemd, linha a linha

`dgclaw-controle.service` (root, `ExecStart=/usr/bin/node /opt/dgclaw/app/controle/servidor.js`):

| Linha | Por quê |
| --- | --- |
| `PrivateTmp=yes` | O `/tmp` do controle é só dele. |
| `ProtectHome=read-only` | O controle nunca grava em `/home` nem `/root` (as casas dos agentes ficam em `/var/lib/dgclaw`). |
| `ProtectKernelTunables=yes` | `/proc/sys` e `/sys` só leitura. O podman rootful ajusta o kernel por dentro do namespace do container, não por esse mount. |
| `ProtectControlGroups=no` | De propósito: o podman cria um cgroup por container. |
| `UMask=0077` | Arquivo novo nasce 600. |

Ficam de fora, com motivo: `NoNewPrivileges`, `CapabilityBoundingSet`, `SystemCallFilter`, `RestrictSUIDSGID`,
`RestrictNamespaces`, `RestrictRealtime`, `LockPersonality`, `MemoryDenyWriteExecute`, `ProtectKernelModules` e
`ProtectClock`. Filtros de segurança (seccomp, capacidades, `no_new_privs`) são herdados pelos filhos e pelos
containers que o controle inicia, e quebrariam o `sudo` dentro dos agentes (armadilha 2 do `DESENHO.md`), o `apt`
e o runc. `ProtectSystem` também fica de fora: o `dgclaw` grava em `/etc/dgclaw`, `/etc/caddy`, `/etc/systemd/system` e
`/var`, e a lista de `ReadWritePaths` ficaria grande e frágil.

Socket: `/run/dgclaw/controle.sock`, pasta 750, socket 600 (o Web é root). Se um dia o Web deixar de ser root, o grupo
dele entra em `DGCLAW_CONTROLE_GRUPO` e o socket passa a 660 com esse grupo.

O Web ganha o drop-in `dgclaw-web.service.d/20-enterprise-controle.conf` (`PrivateTmp`, `ProtectHome=read-only`,
`ProtectKernelTunables`, `ProtectSystem=full`, `ReadWritePaths=/etc/dgclaw`, `UMask=0077`). Veja `WEB-SEM-ROOT.md`.

## Decisões que o desenho não cobria

- **Operações demoradas viram tarefas.** A caixa do agente desiste de uma chamada em 30 s, e criar um agente leva
  minutos. Por isso `tarefa.ver` entrou no catálogo (leitura) e o `dgclaw-controle` acompanha a tarefa sozinho.
  As tarefas ficam na memória do controle (as últimas 100).
- **O Admin em container mantém `tipo: "admin"`** e ganha `papel: "admin"`. A caixa passou a aceitar também o agente
  com `papel: "admin"` (`caixa-agente.js`), porque ela só atendia `tipo: "agente"`.
- **O fechamento da manutenção chama `dgclaw admin manutencao fechar --auto`**, não só `systemctl stop`.
- **Pedido repetido não duplica:** o mesmo pedido pendente, da mesma pessoa, devolve o existente.
- **`ent_instalar_admin_isolado`** isola na hora só se a imagem dos agentes já está pronta; senão avisa e deixa o
  Admin do host de pé até alguém rodar `dgclaw admin isolar`. A construção da imagem leva de 10 a 20 minutos.

## O que só se prova numa máquina real

Lista de teste manual (os testes automáticos usam raiz falsa, podman e systemctl de mentira):

1. `dgclaw admin isolar` numa instalação nova de nível `escritorio`: o container sobe, o runner responde, o Admin
   aparece primeiro na lista do TI e some para o funcionário.
2. Entrar na conta do Claude pelo painel do Admin e mandar "liste os agentes": o `dgclaw-controle agentes.listar`
   responde pela caixa.
3. Pedir "crie o agente ana": a tarefa termina e o agente existe. Pedir "remova a ana": fica pendente; aprovar no
   celular, com e sem 2FA recente; conferir que a casa foi para aposentados.
4. Subir e parar agentes com o sandbox do `dgclaw-controle.service` ligado (`ProtectKernelTunables=yes`): se `podman start`
   falhar com erro de sysctl, tirar essa linha e registrar aqui.
5. Reiniciar o `dgclaw-web` com o drop-in (`ProtectSystem=full`): login, trocar a senha do painel (grava em
   `/etc/dgclaw/web.env`), guardar uma chave no cofre e aplicar (`podman exec`), criar o primeiro agente pelo painel.
6. `manutencao.abrir` por 5 minutos: a faixa aparece, o Admin antigo responde, fecha sozinho e o registro some.
7. Reiniciar a máquina com a manutenção aberta: ao subir, o controle fecha a vencida.
8. `dgclaw admin host` no nível `pessoal`: o Admin antigo volta e funciona como antes.

## Limitações conhecidas

- O formulário do **primeiro agente** (a skill `criar-agente` do Admin do host, que roda `web/bin/onboarding.js` como
  root) não existe no Admin isolado. Ele usa a skill nova, que cria por `dgclaw-controle agente.criar` e confere por
  `agente.status`. O teste real com o runner do agente novo (token do runner) é do host e fica fora do Admin isolado.
- O monitor (`dgclaw monitor`) olha o container dos agentes de trabalho; o container do Admin aparece no `dgclaw status`
  (`ent_status_admin`), mas não gera alerta próprio.
- `travas.liberar` espera o comando do bloco E.
