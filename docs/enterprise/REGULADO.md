# Nível regulado

Este documento descreve o que o nível `regulado` acrescenta ao `empresa`: o runtime reforçado (gVisor), a chave do disco
fora da VPS, o Admin desligável e o teste de restauração assinado. O contrato geral está em `DESENHO.md`; o container
endurecido, em `CONTAINER-ENDURECIDO.md`; o controle, em `CONTROLE.md`.

## O que muda em relação ao nível empresa

| Proteção | Empresa | Regulado | Onde está |
| --- | --- | --- | --- |
| `runtime` | runc | gvisor | `lib/enterprise/gvisor.sh` |
| `disco_cifrado` | auto (chave na máquina) | externo (chave fora da máquina) | `lib/enterprise/disco-externo.sh` |
| `admin_llm` | true | true, com a opção de desligar | `lib/enterprise/admin-llm.sh`, `web/lib/ent/admin-desligado.js` |
| `backup_retencao_dias` | 30 | 14 | já existia (bloco D) |
| `retencao_dias` | 90 | 30 | já existia (bloco F) |
| teste de restauração | semanal | mensal, com relatório assinado | `lib/enterprise/regulado.sh` |

Além disso o regulado herda, travados: login único obrigatório, auditoria externa, saída por proxy com bloqueio e kit sensível
(blocos E, G, H e I).

## 1. Runtime reforçado (gVisor)

### O que o gVisor faz

O `runsc` (gVisor) coloca um núcleo de usuário entre o agente e o núcleo do servidor. Uma falha de núcleo explorada de dentro
do container para no gVisor e não chega ao host. O custo é velocidade e compatibilidade.

### Pesquisa feita em 18/10/2026

- Instalação: https://gvisor.dev/docs/user_guide/install/ . Repositório apt oficial, chave em https://gvisor.dev/archive.key,
  pacote `runsc`. A página não publica o fingerprint da chave. O que está escrito no código
  (`GVISOR_FINGERPRINT` em `gvisor.sh`) é o da chave baixada nesse dia: `6F1DF85E3A71C24918E727D56FC6D554E32BD943`
  (The gVisor Authors). A página avisa que a chave foi trocada em 13/07/2021; se trocar de novo, a instalação para com uma
  mensagem que mostra as duas pontas.
- Compatibilidade: https://gvisor.dev/docs/user_guide/compatibility/ . A página não afirma que o systemd roda como PID 1 dentro
  do sandbox. Diz que há cgroups dentro do sandbox, mas sem imposição de limites entre processos do mesmo sandbox. Não fala de
  capacidades (capabilities). Lista limitações: sistemas de arquivos em bloco como ext4 não são nativos (montam no host e
  entram no sandbox), `iptables` é parcial e `io_uring` vem desligado.
- Driver de cgroup: https://gvisor.dev/docs/user_guide/systemd/ . É sobre o `runsc` pedir unidades ao systemd do host
  (`--systemd-cgroup`, precisa de systemd 244 ou mais novo e cgroup v2). Não é sobre rodar o systemd dentro do container.
- Podman: nenhuma página do gVisor trata do podman. O registro do runtime segue a documentação do `containers.conf`
  (`[engine.runtimes]`), feito em `/etc/containers/containers.conf.d/dgclaw-runsc.conf`.

### Conclusão e decisão

Não há garantia documentada de que a imagem dos agentes (systemd como PID 1, `--systemd always`, capacidades devolvidas pelo bloco D)
funcione sob o gVisor. Por isso o código não presume que funciona:

1. `ent_args_container_runtime` só põe `--runtime runsc` quando uma prova passou. A prova sobe um container descartável da mesma
   imagem, com as mesmas capacidades do agente, e confere: o systemd chegou a `running` ou `degraded`, o cron ficou ativo e um
   servidor HTTP escuta e responde nas portas 4300 (runner) e 8300 (painel). O resultado fica em
   `/var/lib/dgclaw/runtime-prova.json`, valendo para aquela imagem e aquela versão do `runsc`.
2. Se a prova falha, ou o `runsc` não está instalado, o agente nasce em runc, com aviso alto na tela, o evento `runtime.queda`
   na auditoria e uma marca em `/etc/dgclaw/runtime-sem-reforco/<agente>`. O `dgclaw status` e o monitor listam cada agente
   nessa situação, com o comando para consertar.
3. `dgclaw agente testar-runtime [<agente>]` refaz a prova a pedido. Com o nome de um agente, confere também que o container dele
   roda sob o runsc e que o runner, o painel e o cron respondem.
4. Depois de consertar, `dgclaw agente recriar <agente> --forcar` refaz o container (a casa fica) e a marca some.

### Teste manual na VPS real

- Rodar `dgclaw agente testar-runtime` e ler o resultado. Se o systemd não subir, o regulado fica em runc até alguém resolver;
  isso é uma decisão de risco do responsável, e não deve ser escondida do cliente.
- Conferir `podman inspect -f '{{.OCIRuntime}}' dgclaw-<agente>` (o código usa esse campo; confirmar que o podman da máquina o expõe).
- Ver se `sudo apt-get`, `dgclaw agente pacote` e as rotinas do agente funcionam sob o runsc.
- Ver se `--cgroup-manager` ou `--systemd-cgroup` pedem ajuste no `containers.conf` da máquina.
- Medir o consumo e o tempo de partida: o gVisor pesa mais que o runc.

## 2. Chave do disco fora da VPS

No modo `auto` a chave do volume (`/etc/dgclaw/disco.chave`) fica na própria máquina: protege contra snapshot e disco descartado,
mas não contra quem tem root com a máquina ligada. No modo `externo` ela sai da máquina por um de dois caminhos.

Pesquisa feita em 18/10/2026 (Clevis): https://github.com/latchset/clevis (páginas `clevis-luks-bind(1)` e `clevis-encrypt-tang(1)`).
O `clevis luks bind` acrescenta uma chave nova ao LUKS cifrada pelo pino (aqui, Tang); a senha antiga continua valendo. No pino
Tang, `thp` é o thumbprint de uma chave de assinatura confiável: informá-lo dispensa a pergunta de confiança no primeiro uso.
A opção `-y` aceitaria o anúncio às cegas, e o código nunca a usa.

### Tang

```
dgclaw disco chave externa tang http://tang.suaempresa.com.br
```

Sem `--thp` o comando mostra o thumbprint que o servidor anunciou e para. Quem cuida do Tang confere no servidor
(`tang-show-keys`) e repete com o valor: `--thp <thumbprint>`. O Clevis recusa o vínculo se o thumbprint não for de uma chave
do anúncio.

### Frase digitada

```
dgclaw disco chave externa manual
```

O TI digita a frase duas vezes (20 caracteres ou mais), sem eco. Depois de cada reinício: `dgclaw disco desbloquear`. Para
automação a frase pode vir pelo STDIN (nunca por argumento).

### Ordem segura e o único passo destrutivo

1. O método novo é adicionado a um slot novo do LUKS, autorizado pelo arquivo da chave local.
2. A abertura com ele é testada (`cryptsetup open --test-passphrase`), sem abrir de verdade.
3. Só com `--confirmar`: o teste se repete, a chave local sai do slot (`cryptsetup luksRemoveKey`) e o arquivo é apagado com `shred`.

Sem `--confirmar` o comando para no passo 2 e a chave local continua valendo. O comando explica o que o `--confirmar` faz antes de
fazer. Rodar de novo não duplica o slot.

### No boot

A unidade `dgclaw-disco.service` roda `dgclaw disco abrir --boot`. Se o Tang não responde (ou ninguém digitou a frase), o boot não
trava: o aviso vai para a tela e para a auditoria (`disco.trancado`) e a pasta dos agentes fica sem montar. Um drop-in no
`podman-restart.service` (`ConditionPathIsMountPoint`) impede os containers de subirem gravando no disco comum. O Web continua no ar
e mostra "dados trancados, aguardando desbloqueio" nas páginas e APIs que dependem dos agentes (`web/lib/ent/disco-trancado.js`).
O monitor (bloco F) alerta o problema `disco-trancado`.

### Riscos que sobram

- Tang fora do ar ou frase esquecida, com a chave local já removida, é dado perdido. Guarde a frase em dois lugares e faça uma cópia
  do cabeçalho do volume (`cryptsetup luksHeaderBackup`).
- Trocar o servidor Tang sem antes vincular o volume ao novo é o mesmo risco.
- O `clevis luks bind` foi pensado para dispositivos de bloco. O volume aqui é um arquivo (`dados.luks`). O `cryptsetup` aceita arquivo,
  mas o comportamento do Clevis com arquivo precisa ser confirmado na VPS real (ver a lista abaixo).

## 3. Admin desligável

```
dgclaw admin desligar     # admin_llm = false
dgclaw admin ligar        # desfaz
```

Desligar fecha a manutenção de emergência se estiver aberta, guarda a entrada do Admin em `agentes.json.admin-desligado`, grava
`admin_llm = false`, para o container do Admin e tira o reinício automático (`podman update --restart=no`), desabilita o Admin do
host (se existir) e tira o Admin do `agentes.json`. Só funciona com o Admin isolado (`admin_isolado`), porque o formulário do Web
cria agentes pelo serviço de controle.

Sem Admin, agentes novos nascem de dois jeitos: `dgclaw agente criar` no servidor e o formulário `/novo-agente` do Web (só para o TI).
O formulário grava o pedido no mesmo armazém do onboarding e pede `agente.criar` ao controle em nome do TI logado, que fica na
auditoria. Com o Admin desligado e nenhum agente, a lista vazia deixa de ser erro, e `/` leva ao formulário. O reinstalador
(`ent_instalar_admin_llm`) desliga de novo o Admin que o `install.sh` recadastrar.

Limite: o controle devolve a saída da criação só no fim, então a barra de progresso do formulário mostra "preparando" até terminar,
em vez de passar etapa por etapa.

## 4. Teste de restauração mensal

No regulado o timer `dgclaw-backup-teste.timer` roda no dia 1 de cada mês (nos outros níveis, semanalmente). Cada teste bem-sucedido
grava `/var/lib/dgclaw/backup/relatorios/teste-restauracao-<data>.json` (modo 600) e põe o `sha256` dele no evento
`backup.teste_restauracao` da auditoria (campo `relatorio_sha256`). Como a auditoria é encadeada por hash e, no regulado, enviada ao
coletor externo, mudar o relatório depois faz o `sha256sum` do arquivo deixar de bater com o evento.

## Limitações honestas

- gVisor e systemd: ver a seção 1. Pode ser que a imagem atual não rode sob o gVisor.
- Tang indisponível: a VPS sobe sem os dados dos agentes até alguém abrir o disco.
- O processamento das conversas continua nos servidores da Anthropic (Estados Unidos). O nível regulado limita o que sai do servidor
  (proxy com bloqueio, kit sensível), mas não muda onde o modelo roda. Isso é uma decisão jurídica do cliente.
- `runtime` não é travado na matriz: um ajuste pode voltar o regulado para runc. A prova de compatibilidade e o aviso no status existem
  justamente porque o gVisor pode não rodar na imagem.

## O que é humano (jurídico do setor)

- Confirmar se o órgão regulador do cliente aceita processamento fora do país e em qual condição.
- Contrato de operador com a Anthropic e cláusulas de retenção e de localização dos dados.
- Escolher e operar o servidor Tang (quem guarda, onde, quem troca a chave) ou quem sabe a frase do disco.
- Definir a retenção legal de cada tipo de dado (o padrão do regulado é 30 dias, mas há setores que exigem mais ou menos).
- Aceitar por escrito o risco de agentes em runc se o gVisor não passar na prova.
- Guardar os relatórios mensais de restauração para a fiscalização.

## Testes que só dão para fazer numa máquina real

1. `dgclaw nivel definir regulado` e `dgclaw protecoes aplicar` numa VPS de teste; criar um agente; `dgclaw status`.
2. `dgclaw agente testar-runtime` e `dgclaw agente testar-runtime <agente>` com o runsc de verdade (seção 1).
3. Conferir a receita do thumbprint (`jose fmt ... | jose jwk thp`) contra um Tang real: sem `--thp` o comando deve mostrar o mesmo
   valor do `tang-show-keys`.
4. `clevis luks bind` e `clevis luks pass -s <slot>` contra um volume que é arquivo (`dados.luks`); se o Clevis exigir dispositivo de bloco,
   anexar o arquivo a um loop (`losetup`) na unidade de boot.
5. Reiniciar a VPS com o Tang no ar (deve abrir sozinha) e com o Tang fora do ar (deve subir trancada, Web mostrando a mensagem,
   monitor alertando). Depois religar o Tang e rodar `dgclaw disco abrir`.
6. Modo manual: reiniciar, ver a tela de dados trancados, rodar `dgclaw disco desbloquear` e conferir que os containers sobem
   (`podman-restart.service`; se algum ficar parado, `dgclaw agente iniciar <agente>`).
7. `dgclaw admin desligar`, criar um agente pelo formulário `/novo-agente` no celular (abrir o painel do agente, entrar com a
   assinatura, voltar e tocar em "Já entrei. Pode testar."), e `dgclaw admin ligar`.
8. `dgclaw backup testar` no regulado e conferir o relatório e o evento na auditoria.
