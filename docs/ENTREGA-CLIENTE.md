# Entrega de VPS de cliente: checklist e smoke test

Este guia é para a equipe que entrega uma VPS pronta ao cliente. Ele vem depois do
[projeto de cliente](PROJETO-DE-CLIENTE.md), que explica o padrão e o acesso de suporte, e antes da
chave na mão do cliente. A ideia é chegar na entrega com tudo azeitado: rodar o script, resolver o que
ele acusar e fazer à mão o que não dá para automatizar.

## Como usar

No servidor do cliente, como root:

```bash
sudo bash scripts/smoke-entrega.sh <agente>
sudo bash scripts/smoke-entrega.sh <agente> --video <url de um vídeo curto do YouTube>
```

- Cada item imprime `OK`, `AVISO` ou `FALHA`, com a causa e o que fazer.
- O código de saída é diferente de zero se houver `FALHA`. `AVISO` não reprova, mas cada um precisa ser
  resolvido ou justificado antes da entrega.
- No fim sai a lista "conferir à mão", que é a parte deste guia que o script não alcança.
- O item 11 roda `dgclaw agente reparar <agente>` e reinicia o runner do agente. Use `--sem-reparar`
  para pular esse passo (e então faça o item 11 à mão).
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
- **Se falhar:** recrie a VPS com a chave marcada. Lembre que essa chave do painel é permanente e sai
  logo depois da instalação, como diz o [projeto de cliente](PROJETO-DE-CLIENTE.md#2-o-fluxo-passo-a-passo).

### 3. Limites do container e do runner (automático)

O script confere, para `dgclaw-<agente>`:

| Item | Como confere | Esperado |
| --- | --- | --- |
| Processos | `podman exec dgclaw-<agente> cat /sys/fs/cgroup/pids.max` e `podman inspect` (PidsLimit) | 4096 ou mais. Menos que isso é `FALHA` |
| Memória | `podman inspect -f '{{.HostConfig.Memory}}'` e `MemTotal` do servidor | Mais de 2 GB quando a VPS tem mais RAM. Senão, `AVISO` com o comando `podman update --memory <N>g` |
| CPU | `podman inspect -f '{{.HostConfig.NanoCpus}}'` e `nproc` | Mais de 1 quando a VPS tem mais núcleos. Senão, `AVISO` com `podman update --cpus <N>` |
| `TasksMax` do runner | `systemctl show -p TasksMax` dentro do container | 2400 ou mais. Menos que isso é `FALHA` |
| `OOMPolicy` do runner | `systemctl show -p OOMPolicy` dentro do container | `continue` (a partir da 1.1.1; antes disso sai `AVISO`) |
| Reinícios do runner | `NRestarts` da unidade `dgclaw-runner` | 0. Mais que isso é `FALHA` |
| Falta de memória (OOM) | `journalctl` do runner e do kernel, últimos 7 dias | Nenhuma linha de "out of memory" ou "oom-kill". Qualquer uma é `FALHA` |

Atenção: `podman update` vale até o container ser recriado (`dgclaw agente recriar`). Se a VPS é grande,
suba o limite, confira com o smoke e avise o time para repetir isso depois de qualquer recriação.

### 4. Card de teste, nos dois motores (à mão)

1. No painel do agente, abra uma sessão paralela (um card).
2. Mande um pedido curto, por exemplo: "responda apenas com a palavra ok".
3. Confirme que o card respondeu o primeiro turno e que, ao clicar nele, a conversa aparece.
4. Feche o card.
5. Repita com o outro motor. O agente de teste de cada motor (Claude e Codex) precisa passar. O DG Claw
   promete o mesmo comportamento nos dois ([PARIDADE-CODEX.md](PARIDADE-CODEX.md)).

- **Esperado:** resposta no primeiro turno, sem card parado com o pedido na caixa.
- **Se falhar:** veja o item 3 (limites) e o item 11 (sessão principal).

### 5. Cofre (automático, com parte à mão)

- **Conferir:** `dgclaw agente cofre <agente> listar`. O script usa a versão `--json` e lê só o nome de
  cada chave ativa. Ele cruza esses nomes com as chaves citadas nas skills instaladas
  (`<casa do agente>/.claude/skills/*`).
- **Esperado:** `GROQ_API_KEY` está no cofre (sem ela, o microfone e o áudio do agente não funcionam). Toda
  chave que uma skill instalada cita (por exemplo `ELEVENLABS_API_KEY` ou `GEMINI_API_KEY`) também está lá. O
  WhatsApp não usa chave no cofre: o pareamento é feito no painel, confira à mão.
- **Se faltar:** `printf %s "$CHAVE" | dgclaw agente cofre <agente> guardar <NOME>`.
- **À mão:** o script não distingue chave da equipe de chave do cliente. Antes da entrega, toda chave
  provisória da equipe precisa ter sido trocada pela do cliente (guardar de novo com o mesmo nome
  substitui). Se a skill cita uma chave que o cliente não vai usar, o `AVISO` pode ser ignorado.

### 6. YouTube e yt-dlp (automático, com login à mão)

1. **À mão:** abra a Tela do agente (veja [TELA-DO-AGENTE.md](TELA-DO-AGENTE.md)), entre no YouTube pelo
   navegador dela com a conta do cliente e deixe a sessão aberta. A senha da Tela se troca com
   `dgclaw agente tela-senha <agente>`.
2. Rode o smoke com `--video <url>`: ele baixa um vídeo curto com o `yt-dlp` dentro do container e apaga o
   arquivo em seguida.
- **Esperado:** `yt-dlp` no PATH em `/usr/local/bin` e lendo os cookies da Tela pelo arquivo
  `~/.config/yt-dlp/config` do agente (os dois a partir da 1.1.1). Na versão atual o `yt-dlp` fica em
  `/opt/venv/bin` e o script avisa.
- **Checagem manual equivalente (antes da 1.1.1):** `podman exec -u agente dgclaw-<agente> yt-dlp --cookies-from-browser chrome:/home/agente/.tela-chrome -F <url>`.
  Se listar os formatos sem pedir "confirme que você não é um robô", o login da Tela está valendo.
- **Se falhar com "not a bot" ou pedido de login:** refaça o login na Tela com a conta do cliente.

### 7. Render headless sem sobrar Chrome (automático)

- **Conferir:** o script conta `pgrep -c chrome` dentro do container, roda um render curto do Chrome
  headless com prazo (`timeout`), espera alguns segundos e conta de novo.
- **Esperado:** a contagem depois é igual à de antes. O Chrome da Tela continua vivo, e por isso fica nas
  duas contas.
- **Em render de verdade** (carrossel, vídeo), use o `dgclaw-pesado --timeout` (a partir da 1.1.1), que
  encerra o que sobrar. Antes dele, envolva o comando em `timeout`.
- **Se sobrar processo:** `FALHA`. Mate o que ficou (`podman exec dgclaw-<agente> pkill -f <trecho>`) e veja
  quem chamou o Chrome sem prazo.

### 8. ffmpeg (automático)

- **Conferir:** `command -v ffmpeg` no servidor e `podman exec -u agente dgclaw-<agente> command -v ffmpeg`
  (o script usa `sh -c`).
- **Esperado:** presente nos dois. No servidor, ele gera as miniaturas do painel; no container, o agente
  usa para áudio, vídeo e carrossel.
- **Se faltar no servidor:** `apt-get install -y ffmpeg`. **No container:** `dgclaw imagem construir` e
  depois `dgclaw agente recriar <agente> --forcar`.

### 9. Login do dono pelo celular (à mão)

1. Abra o painel no celular (largura 390) e entre com o usuário. Teste com a primeira letra em maiúscula,
   como o teclado faz sozinho: o login precisa aceitar.
2. Troque a senha pelo painel em `/trocar-senha` (a partir da 1.1.1; antes disso, o cliente usa a senha do
   primeiro acesso).
3. Entregue a senha ao cliente por canal seguro, nunca por e-mail comum nem por grupo.
- **Esperado:** entra sem erro de "usuário não encontrado", sem rolagem horizontal e com o teclado do
  celular sem atrapalhar o campo.

### 10. Skills do cliente na pasta certa (à mão)

Hoje é passo manual. Para cada skill do cliente:

1. Conferir que ela está em `<casa do agente>/.claude/skills/<skill>/`.
2. Conferir o dono: `ls -ld` na pasta e nos arquivos deve mostrar o dono do agente, e não `root`. Se estiver
   `root`, corrija com `chown -R` usando o dono da própria casa do agente.
3. Conferir que `CLAUDE_PLUGIN_ROOT` resolve: abra a skill, veja os caminhos que ela usa e rode o
   `setup-check.sh` dela (quando tiver) como o agente.
- **Esperado:** nenhum caminho aponta para fora da casa, nenhum arquivo é de `root`, e o `setup-check`
  não acusa nada ausente.

### 11. Sessão principal de pé depois de reparar e reiniciar (automático)

- **O que o script faz:** `dgclaw agente reparar <agente>`, reinicia o `dgclaw-runner` dentro do container,
  espera o runner responder em `/api/saude` e procura o processo da sessão principal (`claude` ou `codex`).
- **Esperado:** `OK` nos três. Se o runner não responde, é `FALHA`; se só a sessão não aparece no prazo, é
  `AVISO`: confira o estado dela no painel do agente.
- **Se falhar:** `podman exec dgclaw-<agente> journalctl -u dgclaw-runner --no-pager | tail -n 50` e,
  se preciso, `dgclaw agente reiniciar <agente>`. Veja [SESSAO-PRINCIPAL.md](SESSAO-PRINCIPAL.md).

### 12. Texto personalizado nas skills do cliente (à mão)

- **Conferir:** abra as skills que levam texto do cliente (assinatura, nome do programa, encerramento fixo)
  e procure o que não pertence a ele: `grep -rniE '<nome de outro cliente>|<nome do modelo>' <pasta da skill>`.
- **Esperado:** nenhum nome de outro cliente e nenhum nome do modelo de onde a skill foi copiada. Leia a
  assinatura e o encerramento com o olho: o `grep` só acha o que você lembrou de procurar.

## Antes de entregar

- [ ] `scripts/smoke-entrega.sh <agente>` sai com 0 e nenhum `AVISO` ficou sem resposta
- [ ] Os passos 2, 4, 5 (chave do cliente), 6 (login), 9, 10 e 12 estão feitos e marcados
- [ ] O checklist de entrega do [projeto de cliente](PROJETO-DE-CLIENTE.md#4-checklist-de-onboarding)
      (suporte desligado, senha de root trocada) também está completo
