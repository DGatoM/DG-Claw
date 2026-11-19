# Entrega de VPS de cliente: checklist e smoke test

Este guia é para a equipe que entrega uma VPS pronta ao cliente. Ele vem depois do
[projeto de cliente](PROJETO-DE-CLIENTE.md), que explica o padrão e o acesso de suporte, e antes da
chave na mão do cliente. A ideia é chegar na entrega com tudo azeitado: rodar o script, resolver o que
ele acusar e fazer à mão o que não dá para automatizar.

## Como usar

No servidor do cliente, como root:

```bash
sudo bash scripts/smoke-entrega.sh <agente>
```

O script automatiza os passos 1, 3, 7 e 8, e parte dos passos 5 e 6 (o microfone e os nomes do cofre; o
perfil da Tela e a configuração do `yt-dlp`). Ele **não** cruza as skills com o cofre e **não** baixa nada do
YouTube: esses dois ficam à mão, com os comandos nos passos 5 e 6.

- Cada item imprime `OK`, `AVISO`, `FALHA`, `INCONCLUSIVO` ou `PENDENTE`, com a causa e o que fazer.
  `INCONCLUSIVO` quer dizer que a leitura deu erro e o script não sabe: não é `OK` nem `FALHA`, e
  não significa "zero eventos". `PENDENTE` é o que o dono confirma depois.
- O código de saída é diferente de zero se houver `FALHA`. `AVISO`, `INCONCLUSIVO` e `PENDENTE` não
  reprovam, mas cada um precisa ser resolvido (o inconclusivo, conferido à mão) ou justificado antes da
  entrega.
- O relatório só tem mensagens fixas. Nenhum texto vindo do container (caminho, nome escolhido pelo agente,
  saída de comando) entra nele: só contagens validadas e o que o servidor já conhece. Toda leitura de dentro
  do container tem limite de bytes; resposta grande demais ou fora do formato é `INCONCLUSIVO`. Se um comando
  do container sai com erro, o item não interpreta a saída e diz o código.
- No fim sai a lista "conferir à mão", que é a parte deste guia que o script não alcança.
- O script nunca mostra o valor de uma chave do cofre, só os nomes.
- Rode de novo depois de cada correção. Os itens que dependem de uma correção da 1.1.1 aparecem como
  `AVISO` com a marca "(a partir da 1.1.1)" até a VPS ser atualizada.

Os números abaixo são os mesmos que o script imprime entre colchetes.

## Os passos

### 1. Versão do Ubuntu (automático)

- **Conferir:** `cat /etc/os-release`. O script lê `ID` e `VERSION_ID`.
- **Esperado:** Ubuntu 24.04 (ou 22.04). No 26.04 o instalador já avisa que o DG Claw foi testado no
  24.04; o script repete o aviso. Qualquer outro sistema é `FALHA`.
- **Se falhar:** recrie a VPS com Ubuntu 24.04.

### 2. Chave SSH da equipe na criação da VPS (à mão)

- **Conferir:** no painel da Hostinger, a chave da equipe aparece na lista de chaves da VPS, e
  `ssh root@<servidor>` com a nossa chave entra sem pedir senha.
- **Esperado:** a chave foi colocada na própria criação ou recriação da VPS. Chave anexada depois, com a
  VPS já criada, não entra no `authorized_keys`.
- **Se a chave permanente da equipe não funcionar:** não recrie a VPS. Entre pelo acesso temporário do
  suporte (`dgclaw suporte ligar`, veja o [projeto de cliente](PROJETO-DE-CLIENTE.md#2-o-fluxo-passo-a-passo)).
- **Na entrega, confira as duas saídas:** (1) o suporte temporário foi revogado: `sudo dgclaw suporte status`
  diz "suporte: desligado"; (2) a chave permanente da equipe **não** autoriza mais o root. Confira a
  configuração efetiva do `sshd` para o root e para a origem de suporte, com
  `sudo sshd -T -C user=root,host=<host>,addr=<ip de suporte> | grep -iE 'authorizedkeys|permitrootlogin'`,
  porque o `sshd -T` sem `-C` não aplica as regras `Match`. Para cada arquivo listado, `ssh-keygen -lf <arquivo>`
  mostra as impressões digitais. Se houver `authorizedkeyscommand`, confira a chave também na fonte que ele
  consulta (o `ssh-keygen` não o lê). Se ela aparecer em algum lugar, remova a linha, porque o `desligar` não
  mexe nas chaves que não são do suporte. Por fim, teste de uma conexão nova, a partir da origem de suporte que
  antes era aceita, só com essa chave
  (`ssh -o IdentitiesOnly=yes -o IdentityAgent=none -i <chave da equipe> root@<servidor>`): ela precisa
  ser recusada.

### 3. Limites do container e do runner (automático)

O script confere, para `dgclaw-<agente>`:

| Item | Como confere | Esperado |
| --- | --- | --- |
| Processos | `pids.max` do cgroup do container, lido no servidor (`podman inspect -f '{{.State.CgroupPath}}'`, caminho validado, arquivo em `/sys/fs/cgroup<caminho>`), e `PidsLimit` do `podman inspect` | 4096 ou mais. Menos que isso, ou `max` (sem limite), é `FALHA`. Caminho ou arquivo ilegível é `INCONCLUSIVO` |
| Memória | `memory.max` do mesmo cgroup e `MemTotal` do servidor | `max` (sem limite) é `FALHA`: configure `DGCLAW_CONTAINER_MEMORIA` (a partir da 1.1.1) com um valor que caiba na RAM da VPS, deixando folga para o sistema e o Admin. Valor numérico igual ou maior que o `MemTotal` do servidor é `AVISO`: o teto não protege o servidor. Com 2 GB e a VPS com mais RAM, `AVISO` com o comando `podman update --memory <N>g` |
| CPU | `cpu.max` do mesmo cgroup (quota dividida pelo período; `max` é sem limite) e `nproc` | Mais de 1 quando a VPS tem mais núcleos. Senão, `AVISO` com `podman update --cpus <N>`. Arquivo ilegível é `INCONCLUSIVO` |
| `TasksMax` do runner | `systemctl show -p TasksMax` dentro do container | 2400 ou mais. Menos que isso é `FALHA` |
| `OOMPolicy` do runner | `systemctl show -p OOMPolicy` dentro do container, validado contra a lista `continue`, `stop`, `kill` | `continue` (a partir da 1.1.1; antes disso sai `AVISO`). Valor fora da lista é `AVISO`, sem repetir o que veio |
| Reinícios do runner | `NRestarts` da unidade `dgclaw-runner` | 0. Mais que isso é `FALHA` |
| Falta de memória (OOM) | `journalctl` do runner e `journalctl _TRANSPORT=kernel --since "7 days ago"` (o `-k` olharia só o boot atual), últimos 7 dias | Nenhuma linha de "out of memory" ou "oom-kill". Qualquer uma é `FALHA`. Se o `journalctl` der erro ou a saída passar de 1 MiB sem nenhuma ocorrência no trecho lido, é `INCONCLUSIVO`, que é diferente de "zero eventos". Se já achou OOM antes do corte de 1 MiB, é `FALHA`, com a nota de que a contagem é parcial Se uma fonte mostra OOM e a outra ficou ilegível, é `FALHA`, e a mensagem diz qual fonte falhou. Se o journal do kernel guarda menos de 7 dias, o relatório diz a cobertura real |

Atenção: `podman update` vale até o container ser recriado (`dgclaw agente recriar`). Se a VPS é grande,
suba o limite, confira com o smoke e avise o time para repetir isso depois de qualquer recriação.

**Recriar o agente sem perder nada.** O `dgclaw agente recriar <agente>` pode recriar o container na hora,
então ele não é uma simples listagem. Antes dele, peça ao Admin para conferir o que existe só na camada
gravável do container. Decida com o dono antes de qualquer perda e só então rode o `recriar`, sempre **sem** `--forcar`: sem a opção, se houver
algo só dentro do container (pacotes instalados à mão, arquivos fora da casa), ele para e não recria.
Quando a correção pedir imagem nova, rode `dgclaw imagem construir --agora` e confira que terminou com
sucesso antes de recriar.

### 4. Card de teste, nos dois motores (à mão)

1. No painel do agente, abra uma sessão paralela (um card).
2. Mande um pedido curto, por exemplo: "responda apenas com a palavra ok".
3. Confirme que o card respondeu o primeiro turno e que, ao clicar nele, a conversa aparece.
4. Feche o card.
5. Repita com o outro motor. O agente de teste de cada motor (Claude e Codex) precisa passar. O DG Claw
   promete o mesmo comportamento nos dois ([PARIDADE-CODEX.md](PARIDADE-CODEX.md)).

- **Esperado:** resposta no primeiro turno, sem card parado com o pedido na caixa.
- **Se falhar:** veja o item 3 (limites) e o item 11 (sessão principal).

### 5. Cofre (microfone automático, skills à mão)

- **Microfone (automático):** o serviço Web lê a chave do próprio arquivo de ambiente (`/etc/dgclaw/web.env`).
  O script lê o arquivo como texto (nunca o executa) e só confere se a **última** atribuição de
  pelo menos uma entre `ELEVENLABS_API_KEY`, `GROQ_API_KEY` e `OPENAI_API_KEY` tem valor. Aspas vazias contam
  como vazio. Se nenhuma das três tem valor (inclusive uma atribuição antiga com valor seguida de uma vazia),
  é `FALHA`. Ele só diz os nomes que têm valor e nunca imprime o valor. Arquivo ilegível, ou maior que 1 MiB (leitura cortada), é `INCONCLUSIVO`.
- **Nomes do cofre (automático):** o script roda `dgclaw agente cofre <agente> listar --json` e mostra só o
  nome de cada chave ativa. Ele não afirma que as chaves das skills estão lá.
- **Skills contra o cofre (à mão):** liste os nomes com `dgclaw agente cofre <agente> listar` e confira contra
  o que as skills do cliente citam. Para ver o que uma skill cita, como o usuário `agente`:
  `podman exec --user agente dgclaw-<agente> grep -rhoE '\b[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)\b' <pasta de skills>/<skill>`,
  com a pasta efetiva identificada no [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão)
  (`/home/agente/.claude/skills`, `/home/agente/.agents/skills` ou `/home/agente/.codex/skills`). Só marque a
  conferência se o `grep` leu a pasta com sucesso (código de saída 0 ou 1; 2 é pasta ilegível ou inexistente). Os nomes aceitam sublinhados internos (por exemplo `TELEGRAM_BOT_TOKEN`).
- **Esperado:** toda chave que uma skill do cliente cita (por exemplo `ELEVENLABS_API_KEY` ou
  `GEMINI_API_KEY`) está no cofre. O WhatsApp não usa chave no cofre: o pareamento é feito no painel,
  confira à mão.
- **Se faltar:** `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar <NOME> --aplicar`.
- **À mão:** toda chave provisória da equipe precisa ter sido trocada pela do cliente: rode
  `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar <NOME> --aplicar` (guardar de novo com o
  mesmo nome substitui) e confira que o comando terminou sem erro. Se a skill cita uma chave que o cliente não vai usar, pode ignorar.
  O painel usa uma cópia da mesma credencial em `/etc/dgclaw/web.env`, que o cofre não atualiza. Troque
  ou remova nesse arquivo só a linha da chave provisória (`ELEVENLABS_API_KEY`, `GROQ_API_KEY` ou
  `OPENAI_API_KEY`), preservando as outras, rode `sudo systemctl restart dgclaw-web` e teste o microfone
  do chat com a credencial do cliente. A credencial provisória é exclusiva desta instalação, e o item só
  fecha depois de você revogá-la no provedor: trocar no cofre e no `web.env` não invalida cópias que o agente
  ou um backup anterior à entrega ainda guardem.

### 6. YouTube e yt-dlp (login à mão)

1. **À mão:** abra a Tela do agente (veja [TELA-DO-AGENTE.md](TELA-DO-AGENTE.md)) e entre no YouTube pelo
   navegador dela com uma **conta dedicada ao agente**, deixando a sessão aberta. A senha da Tela se troca
   com `dgclaw agente tela-senha <agente>`.
2. **Confira o login:** a partir da 1.1.1, olhe o item de diagnóstico `agente.<agente>.youtube`. Antes disso,
   primeiro olhe na Tela qual conta do YouTube está logada e confirme que é a conta dedicada ao agente
   (o vídeo público baixa mesmo com a sessão expirada, então o download sozinho não prova o login). Depois
   faça à mão um download curto de verdade, numa pasta privada nova dentro do container, com a mesma chamada
   isolada que o agente usa, como usuário `agente`:
   `D="$(podman exec --user agente dgclaw-<agente> mktemp -d /tmp/yt-entrega.XXXXXX)"` e, antes de usar `$D`,
   confira que o `mktemp` terminou com sucesso e que o caminho é exatamente uma pasta direto sob `/tmp`, com o
   prefixo fixo e sufixo só de letras e números: `[[ "$D" =~ ^/tmp/yt-entrega\.[A-Za-z0-9]{6,}$ ]]`. Se a
   conferência falhar, pare: não baixe, não renderize e não apague nada.
   `podman exec --user agente dgclaw-<agente> yt-dlp --ignore-config --no-plugin-dirs --js-runtimes node --cookies-from-browser "chrome+basictext:/home/agente/.tela-chrome/Default" --no-playlist -f "worst/worstvideo" --max-filesize 5M -P "$D" -- 'https://www.youtube.com/watch?v=jNQXAC9IJRQ'`.
   Esperado: um arquivo com conteúdo na pasta (`podman exec --user agente dgclaw-<agente> ls -l "$D"`).
   Depois apague só essa pasta, já validada: `podman exec --user agente dgclaw-<agente> rm -rf -- "$D"`.
- **Esperado:** `yt-dlp` no PATH em `/usr/local/bin` (a partir da 1.1.1; antes, em `/opt/venv/bin`, e o
  script avisa sem repetir o caminho). Não existe mais configuração global de cookies. O script confere:
  (a) que o `/etc/yt-dlp.conf` do container tem a diretiva ativa (não comentada) `--js-runtimes node`;
  (b) que o perfil da Tela, `/home/agente/.tela-chrome`, existe; (c) o login e o download saem como
  `PENDENTE`: o script não baixa nada nem mede o login.
- **Se pedir login ou "não é um robô":** refaça o login na Tela com a conta do agente. Para ver o erro
  completo, repita o comando à mão acima com `-v`.

### 7. Chrome headless roda (automático)

- **Conferir:** o script roda um render curto do Chrome headless com prazo (`timeout`) num perfil
  descartável de uma pasta privada (`mktemp -d`, apagada no fim) e olha o código de saída.
- **Esperado:** o Chrome headless termina com código 0. Código diferente é `FALHA`.
- **Em render de verdade** (carrossel, vídeo), use o `dgclaw-pesado --timeout` (a partir da 1.1.1), que
  encerra o que sobrar. Antes dele, envolva o comando em `timeout`.
- **Processo sobrando:** o script não conta processos. Depois de um render de verdade, olhe à mão se ficou
  Chrome para trás e veja quem o chamou sem prazo.

### 8. ffmpeg (automático)

- **Conferir:** `command -v ffmpeg` no servidor e `podman exec -u agente dgclaw-<agente> command -v ffmpeg`
  (o script usa `sh -c`).
- **Esperado:** presente nos dois. No servidor, ele gera as miniaturas do painel; no container, o agente
  usa para áudio, vídeo e carrossel.
- **Se faltar no servidor:** `apt-get install -y ffmpeg`. **No container:** `dgclaw imagem construir --agora`,
  confira que terminou com sucesso e depois recrie o agente como descrito no passo 3 (olhe antes, só em
  leitura, e decida com o dono antes de qualquer perda).

### 9. Login do dono pelo celular (à mão)

1. Abra o painel no celular (largura 390) e entre com o usuário. Teste com a primeira letra em maiúscula,
   como o teclado faz sozinho: o login precisa aceitar.
2. Entregue a senha provisória ao cliente por canal seguro, nunca por e-mail comum nem por grupo.
3. **No fim da entrega, o próprio cliente troca a senha**, num terminal privado dele, com
   `sudo dgclaw senha trocar` (o comando pede a senha nova duas vezes, sem mostrar o que se digita, e ela
   precisa ter 12 caracteres ou mais) ou pelo painel em `/trocar-senha` (a partir da 1.1.1). Depois, ele
   confirma que a senha antiga não entra mais. A equipe não fica sabendo a senha final.
- **Esperado:** entra sem erro de "usuário não encontrado", sem rolagem horizontal e com o teclado do
  celular sem atrapalhar o campo. A senha antiga deixa de valer depois da troca.

### 10. Skills do cliente na pasta certa (à mão)

Hoje é passo manual. Para cada skill do cliente:

1. Conferir que ela está na pasta de descoberta do motor instalado: `<casa do agente>/.claude/skills/<skill>/`
   no Claude, e `.agents/skills/<skill>/` ou `.codex/skills/<skill>/` no Codex (caminhos em
   [PARIDADE-CODEX.md](PARIDADE-CODEX.md)). Depois, num card de teste desse motor, peça ao agente que
   localize a skill pelo nome e diga em que pasta ela está.
2. Conferir o dono: `ls -ld` na pasta e nos arquivos deve mostrar o dono do agente, e não `root`. Se estiver
   `root`, corrija **dentro do container, como `agente`**, só na pasta da skill identificada, por exemplo
   `podman exec --user agente dgclaw-<agente> chown -R agente: /home/agente/.claude/skills/<skill>`
   (como `agente`, só dá para mexer no que já é dele; o que é de `root` pede ajuste da origem da cópia).
   Nada de `chown -R` como root no host, e não toque nos links das skills oficiais: o ajuste vale só para a
   pasta personalizada, com `-h` quando houver link dentro dela.
3. Conferir que `CLAUDE_PLUGIN_ROOT` resolve: abra a skill e veja os caminhos que ela usa. Antes de rodar
   o `setup-check.sh` dela (quando tiver), leia o script e confira que é a versão esperada, porque o agente
   tem `sudo` sem senha no container e o script enxerga o cofre e a sessão do navegador. Se não der para
   conferir, rode num container descartável sem os dados do cliente. Só então rode como o agente.
- **Esperado:** nenhum caminho aponta para fora da casa, nenhum arquivo é de `root`, e o `setup-check`
  não acusa nada ausente.

### 11. Reparar e conferir a sessão principal (à mão)

- **Fazer:** rode `dgclaw agente reparar <agente>` e confira que termina sem erro e que a conversa
  principal responde (abra o painel do agente e mande um pedido curto).
- **Esperado:** o comando termina sem erro e a sessão principal responde, com o terminal vivo e em estado
  normal.
- **Se falhar:** `podman exec dgclaw-<agente> journalctl -u dgclaw-runner --no-pager | tail -n 50` e,
  se preciso, `dgclaw agente reiniciar <agente>`. Veja [SESSAO-PRINCIPAL.md](SESSAO-PRINCIPAL.md).

### 12. Texto personalizado nas skills do cliente (à mão)

- **Conferir:** abra as skills que levam texto do cliente (assinatura, nome do programa, encerramento fixo)
  e procure o que não pertence a ele, dentro do container e sem trazer o texto das linhas para o terminal:
  `podman exec --user agente dgclaw-<agente> grep -rlE '<nome de outro cliente>|<nome do modelo>' <pasta de skills>/<skill>`,
  com a pasta efetiva identificada no [passo 10](#10-skills-do-cliente-na-pasta-certa-à-mão)
  (`.claude/skills`, `.agents/skills` ou `.codex/skills`, dentro de `/home/agente`). Só marque a conferência se
  o `grep` leu a pasta com sucesso (código de saída 0 ou 1; 2 é pasta ilegível ou inexistente). O comando lista
  só os arquivos com ocorrência; com `-rc`, a contagem por arquivo. Para ver a linha, abra o
  arquivo achado.
- **Esperado:** nenhum nome de outro cliente e nenhum nome do modelo de onde a skill foi copiada. Leia a
  assinatura e o encerramento com o olho: o `grep` só acha o que você lembrou de procurar.

## Antes de entregar

- [ ] `scripts/smoke-entrega.sh <agente>` sai com 0 e nenhum `AVISO` ficou sem resposta
- [ ] Os passos 2 (inclusive suporte temporário revogado e chave permanente da equipe recusada
      numa conexão nova), 4, 5 (skills contra o cofre e chave do cliente), 6 (login do YouTube), 9 (inclusive a
      senha trocada pelo próprio cliente), 10, 11 e 12 estão feitos e marcados
- [ ] Nenhum `INCONCLUSIVO` ficou sem conferência à mão e o `PENDENTE` do YouTube foi confirmado (Tela e diagnóstico)
- [ ] O checklist de entrega do [projeto de cliente](PROJETO-DE-CLIENTE.md#4-checklist-de-onboarding)
      (suporte desligado, senha de root trocada) também está completo
