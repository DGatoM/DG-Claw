# Saída controlada para a internet

Protege contra um agente enganado (por exemplo por um e-mail com instrução escondida) que tenta mandar dados da
empresa para um endereço desconhecido. A proteção se chama `saida` na matriz de proteções e tem três modos.

| Modo | O que acontece | Nível padrão |
| --- | --- | --- |
| `livre` | Nada disso existe. O agente sai pela internet como sempre saiu. | pessoal |
| `registro` | O agente recebe um proxy no ambiente. O proxy deixa tudo passar e anota o destino. A saída direta continua aberta. | escritório, empresa |
| `bloqueio` | A cerca de rede recusa toda saída do agente que não seja para o proxy, e o proxy só deixa passar a lista do agente. | regulado (travado) |

Um agente pode ficar num modo mais firme que o da instalação (`dgclaw saida modo ana bloqueio`), nunca num mais solto.

## Como funciona

- O serviço `dgclaw-saida` (`saida/servidor.js`, Node 22 sem dependência) roda como o usuário `dgclaw-saida`, sem
  privilégio, com o hardening do systemd descrito mais abaixo.
- Ele escuta no gateway da rede de cada agente: `10.89.<N>.1:3128`. Quem pediu é descoberto pelo endereço em que a
  conexão chegou, nunca por cabeçalho. Uma conexão cuja origem não é a rede do agente é recusada e anotada.
- HTTPS passa como túnel (`CONNECT`), sem abrir o TLS: o proxy só enxerga o nome do host e a porta. HTTP simples passa
  pelo mesmo proxy.
- A lista de um agente é a lista base do provedor (`config/saida-base.json`) mais `/etc/dgclaw/saida/<agente>.json`.
  A comparação é por nome de host, normalizado: minúsculas, sem ponto final, IDN em punycode. Curinga só no começo
  (`*.empresa.com.br` cobre `api.empresa.com.br` e `a.b.empresa.com.br`, mas não `empresa.com.br` nem `malempresa.com.br`).
  IP literal só passa se estiver na lista.
- O DNS é resolvido pelo proxy. No modo bloqueio o container nem precisa de DNS para fora. O proxy conecta no IP que ele
  mesmo validou (não resolve de novo depois), e recusa se QUALQUER endereço do nome cair em rede privada, loopback,
  link-local (inclui o `169.254.169.254` dos metadados da nuvem), CGNAT, multicast ou reservado, em IPv4 ou IPv6
  (inclusive IPv4 disfarçado em IPv6). Isso vale nos três casos: nome permitido que passou a apontar para dentro da VPS
  (DNS rebinding), IP literal na lista e modo registro.
- A lista é relida quando o arquivo muda, sem reiniciar. A mudança de modo reaplica a cerca de rede.

### Lista base por provedor

`config/saida-base.json`. Claude Code, conforme a seção "Network access requirements" de
https://code.claude.com/docs/en/network-config (consultada em 18/10/2026): `api.anthropic.com`, `claude.ai`, `claude.com`,
`platform.claude.com`, `mcp-proxy.anthropic.com`, `downloads.claude.ai`, `storage.googleapis.com`, `registry.npmjs.org`,
`github.com`, `raw.githubusercontent.com` e `code.claude.com`. Ficam de fora de propósito os dois hosts de telemetria
opcional (`http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com`) e os de recursos que o agente
não usa (Claude no Chrome, artefatos). Se o TI quiser o agente também em algum deles, é só `dgclaw saida permitir`.

Codex: a documentação pública da OpenAI não lista os endereços de rede do CLI (consultada em 18/10/2026), então a
lista é a mínima conhecida (`api.openai.com`, `auth.openai.com`, `chatgpt.com`, `registry.npmjs.org`) e
**precisa ser confirmada numa VPS real** com o relatório antes de ligar o bloqueio num agente Codex.

O que a lista base não cobre, o TI acrescenta por agente: os canais (Telegram usa `api.telegram.org`; WhatsApp usa
`web.whatsapp.com` e `*.whatsapp.net`), os repositórios de pacotes que o agente usa (`apt`, `pip`, `npm`) e os sistemas da
própria empresa.

## Comandos

```
dgclaw saida                                  resumo: o modo da instalação e o que vale para cada agente
dgclaw saida mostrar <agente>                 modo, lista base e lista do agente
dgclaw saida permitir <agente> <dominio>      libera um destino (aceita *.empresa.com.br); vale na hora
dgclaw saida remover <agente> <dominio>       tira da lista do agente (a lista base não se edita)
dgclaw saida modo <agente> <registro|bloqueio>   endurece um agente e reaplica a cerca
dgclaw saida relatorio <agente> [--dias 7]    destinos mais acessados, com bytes e se estão na lista
```

Todas as mudanças vão para a auditoria (`saida.permitir`, `saida.remover`, `saida.modo`). No nível `pessoal`, tudo
isto recusa com a explicação de como ligar (`dgclaw nivel ajustar saida registro`).

### Receita para chegar ao bloqueio sem derrubar o agente

1. Deixe o agente alguns dias em `registro` (é o padrão dos níveis escritório e empresa).
2. `dgclaw saida relatorio ana --dias 7`: a coluna "na lista" mostra o que o agente usa e ainda não está liberado.
3. `dgclaw saida permitir ana <destino>` para cada um que fizer sentido.
4. `dgclaw saida modo ana bloqueio`. O comando lembra de conferir o relatório antes.

## Registro

`/var/log/dgclaw/saida/<agente>.jsonl`, uma linha por conexão:

```json
{"ts":"2026-10-18T14:03:11.402Z","host":"api.anthropic.com","porta":443,"decisao":"permitido","bytes_up":5120,"bytes_down":88231,"duracao":2410}
```

`decisao` é `permitido`, `recusado` ou `erro` (permitido, mas a conexão não abriu). Quando não é `permitido` a linha
traz também `motivo` (`fora-da-lista`, `destino-interno`, `dns-falhou`, `origem`, `pedido-invalido`,
`muitas-conexoes`, `conexao-falhou`). Nunca vai URL, caminho, parâmetro nem cabeçalho: o teste do proxy confere que
um caminho com parâmetros de consulta não aparece no arquivo. Host que não dá para ler vira `(invalido)`.

A retenção segue `retencao_dias`: o próprio proxy tira as linhas velhas ao subir e a cada 6 horas (0 = sem prazo).

## A cerca de rede (lib/enterprise/firewall-saida.sh)

Depois de tudo o que `lib/firewall.sh` faz, o script monta a cadeia `DGCLAW-SAIDA` em duas tabelas:

- **filter**, ligada ao `INPUT` na posição 1: `-s 10.89.N.0/24 -d 10.89.N.1/32 -p tcp --dport 3128 -j ACCEPT` para cada agente
  em registro ou bloqueio. Fica na frente da cadeia `DGCLAW_HOST` (que derruba tudo o que vai para a própria
  máquina), senão o agente nunca alcançaria o proxy.
- **mangle**, ligada ao `FORWARD` na posição 2: `-s 10.89.N.0/24 -j DROP` para cada agente em bloqueio.

Ordem, a armadilha 4 do DESENHO: o salto da mangle fica **depois** do `DGCLAW_EGRESS`, que continua na posição 1, e nenhuma
regra de `DGCLAW_EGRESS`, `DGCLAW_HOST` ou da filter muda. A mangle é a camada que decide porque o netavark reescreve a
ordem da filter a cada container que sobe. Se `lib/firewall.sh` rodar de novo e recolocar o `DGCLAW_HOST` na frente, o
script da saída (chamado no fim do próprio `firewall.sh`) devolve o nosso salto ao topo. Se a cerca base não estiver
aplicada, o script recusa e diz para rodar `systemctl restart dgclaw-firewall`, em vez de inserir na posição errada.

IPv6 já está fechado pela cerca do bloco D (`DGCLAW_V6`). Sem `/etc/dgclaw/protecoes.json` (nível pessoal) o script
sai sem chamar o `iptables`; com o arquivo e a saída `livre`, ele só desfaz o que sobrou de um nível mais alto.

## O container

No `agente criar` (e no `agente recriar`), os modos registro e bloqueio acrescentam ao `podman create`
`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` e `https_proxy` apontando para `http://10.89.N.1:3128`, e `NO_PROXY` /
`no_proxy` com `localhost,127.0.0.1,::1`. O `--http-proxy=false` de hoje continua (ele cuida do proxy do HOST).
Container criado antes de ligar a saída não tem essas variáveis: `dgclaw protecoes aplicar` e `dgclaw status` avisam,
e a correção é `dgclaw agente recriar <agente> --sim` (a casa fica).

### Prova no `agente criar`

Depois de `scripts/teste-isolamento.sh`, o `agente criar` roda `scripts/enterprise/teste-saida.sh`, de dentro do
container, e **o agente para se falhar**. No modo bloqueio: destino permitido passa pelo proxy; destino fora da lista leva
403 do próprio proxy; conexão direta a `1.1.1.1:443` sem proxy não conecta; no gateway só a porta do proxy responde (a 22
não). No modo registro, só confere que o proxy responde. Sem resposta do proxy o resultado é inconclusivo, nunca "ok".
O `scripts/teste-isolamento.sh` aprendeu a usar o proxy do agente na prova de internet e a não tratar a variável de proxy
do DG Claw como aviso.

## O serviço

A unidade `dgclaw-saida.service` é escrita por `dgclaw protecoes aplicar` (e pelo instalador com `--nivel`). Roda como
`dgclaw-saida` (usuário de sistema, sem home e sem login) com `NoNewPrivileges`, `CapabilityBoundingSet=` vazio,
`ProtectSystem=strict`, `PrivateDevices`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, filtro de chamadas de
sistema e as demais proteções de kernel. A pasta de configuração (`/etc/dgclaw/saida`, modo 2750, grupo `dgclaw-saida`) é
só leitura para ele. O registro vai em `/var/log/dgclaw/saida`, que a unidade enxerga como `/opt/dgclaw/saida-log` (um
`BindPaths`), porque `/var/log/dgclaw` é 750 de root e o serviço não atravessa a pasta.

O proxy não lê o `protecoes.json` (600, root). A CLI grava `/etc/dgclaw/saida/geral.json` (modo da instalação,
`retencao_dias` e os agentes com número de rede e provedor) a cada `dgclaw saida ...`, `agente criar`, `agente remover` e
`protecoes aplicar`. Se o proxy não consegue ler um arquivo, ele diz qual e o que fazer no log
(`journalctl -u dgclaw-saida`), e na dúvida vale o mais fechado.

## Limites, ditos com honestidade

- **No modo registro, programa que ignora a variável de proxy sai direto e não aparece no registro.** Só o bloqueio
  fecha esse caminho. Registro serve para descobrir e para auditar o comportamento normal, não para barrar.
- O túnel HTTPS não é aberto: o proxy vê o nome do host, não o conteúdo. Um host permitido que aceita qualquer conteúdo
  (`github.com`, `storage.googleapis.com`) serve de rota de saída para um agente comprometido. A lista base os inclui
  porque o Claude Code os usa para plugins e atualização; um TI que não precisa disso pode tirá-los do arquivo
  `config/saida-base.json` (edição local, que o `dgclaw atualizar` repõe) e acompanhar o relatório.
- A comparação é pelo nome pedido no `CONNECT`. Domain fronting (nome permitido no TLS, outro no cabeçalho `Host`
  de dentro do túnel) não é detectado sem abrir o TLS.
- Só TCP passa pelo proxy. UDP (inclusive QUIC) no bloqueio é barrado pela cerca; ferramentas que só falam UDP não funcionam.
- Ferramentas que não respeitam `HTTPS_PROXY` (alguns binários estáticos, `ssh`, `git` por SSH) não saem no bloqueio.
  É o comportamento desejado, mas pode surpreender: `git` por HTTPS respeita a variável.
- No bloqueio o `apt` do `dgclaw agente pacote` depende de o repositório estar na lista do agente.
- O agente que roda como `root` dentro do container (rotinas de sistema) usa o mesmo proxy porque a variável vale para o
  container inteiro.

## O que só se prova numa VPS real

Os testes automáticos usam stubs (iptables com estado, destinos falsos, resolvedor injetado). Ficam para a máquina real:

1. `iptables`/`nft` de verdade aceitam a regra `-p tcp --dport 3128` sem `-m tcp`, e a ordem final nas duas tabelas é a
   dos testes (`iptables -t mangle -S FORWARD` e `iptables -S INPUT`) depois de criar três agentes seguidos (o netavark
   reescrevendo a filter no meio).
2. O proxy consegue escutar em `10.89.N.1` logo depois de `podman network create` (ele tenta de novo a cada 3 s) e
   reabre sozinho depois de um reboot, antes de qualquer agente falar.
3. A unidade sobe com todo o hardening (`systemd-analyze security dgclaw-saida`), o `BindPaths` para
   `/opt/dgclaw/saida-log` funciona e o serviço consegue ler `/etc/dgclaw/saida` (o `/etc/dgclaw` precisa ser atravessável
   por outros, 755 como o instalador cria).
4. De dentro de um agente real em bloqueio: `curl https://api.anthropic.com` passa, um domínio fora da lista leva 403,
   `curl --noproxy '*' https://1.1.1.1` trava, e o Claude Code (e o Codex) fazem login e uma conversa completa só com a
   lista base. Anotar o que faltou na lista base do Codex.
5. O que o Claude Code faz na primeira execução e na atualização (plugins, `downloads.claude.ai`) com o proxy.
6. `agente recriar` num agente antigo traz as variáveis de proxy; `dgclaw status` para de avisar.
7. Canais: Telegram e WhatsApp do agente funcionam no bloqueio depois de liberados na lista.
8. A retenção do registro (`retencao_dias`) e a permissão do arquivo (640, grupo `dgclaw-saida`).
9. Uma conversa longa (resposta em streaming) por 10 minutos: o túnel não deve cortar (o proxy corta conexão ociosa
   depois de 10 minutos).
