# Web fora do root: inventário (bloco C, seção 5)

**Conclusão: ainda não dá para tirar o root do `dgclaw-web` com segurança neste bloco.** O Web continua rodando como
root, mas, no `admin_isolado`, dentro de um sandbox do systemd (drop-in `20-enterprise-controle.conf`, descrito em
`CONTROLE.md`). Este documento lista tudo o que exige privilégio hoje, o que já foi para o controle, o que falta e a
receita para o dia em que der.

## O que o Web faz que exige root hoje

| # | O quê | Onde | Privilégio de que precisa | Destino |
| --- | --- | --- | --- | --- |
| 1 | Reiniciar o runner depois de guardar uma chave no cofre: `podman exec <container> systemctl restart dgclaw-runner` | `web/lib/cofre-agente.js` (`reiniciarPorPodman`) | acesso ao podman rootful | **Controle**: a operação equivalente existe (`agente.reiniciar`). Falta trocar a chamada em `cofre-agente.js` (o ponto de injeção `reiniciar` já existe) para falar com o socket. |
| 2 | Criar o primeiro agente do onboarding e reiniciar o do teste: `dgclaw agente criar` e `dgclaw agente reiniciar` | `web/bin/onboarding.js` | root (podman, firewall, `/etc/dgclaw`, `/var/lib/dgclaw`) | **Controle**: `agente.criar` e `agente.reiniciar` existem. Falta trocar o `spawn` por uma chamada ao socket (e a etapa seguir com `tarefa.ver`, porque criar leva minutos). |
| 3 | Gravar o token do Telegram na casa do agente, como o uid dele | `web/lib/token-telegram.js` (`spawn` com `uid`/`gid`) | `CAP_SETUID` e `CAP_SETGID` | Fica no Web. Com não-root precisa dessas duas capacidades. |
| 4 | Gravar na casa do agente (caixa, retratos, uploads), com dono e modo do agente | `web/lib/caixa-agente.js`, `grava-seguro.js` (`chown`, `fchown`) | `CAP_CHOWN`, `CAP_FOWNER` | Fica no Web. |
| 5 | Ler e listar a casa do agente (700, uid mapeado de 1.000.000 em diante): transcripts, mídia, retratos, pedidos da caixa | `conversa.js`, `thread.js`, `media.js`, `caixa-agente.js`, `proxy.js` | `CAP_DAC_OVERRIDE` (ou `CAP_DAC_READ_SEARCH` só para leitura) | Fica no Web. |
| 6 | Ler segredos de root: `agentes.json` (640), `runner/*.token`, `proxy/*.segredo`, `protecoes.json` (600), `web.env` (600) | `registro.js`, `runner.js`, `proxy.js`, `protecoes.js`, `config.js` | `CAP_DAC_OVERRIDE`, ou mudar dono/grupo desses arquivos para o usuário do Web | Fica no Web. |
| 7 | Escrever em `/etc/dgclaw/web.env` (senha do painel, chaves de voz) | `primeiro-acesso.js`, `bin/cofre.js` | escrita em `/etc/dgclaw` | Fica no Web (`ReadWritePaths=/etc/dgclaw`). |
| 8 | Cifrar e decifrar o cofre com `systemd-creds` (chave do host) | `web/lib/ent/cofre-cifrado.js` | acesso à chave `/var/lib/systemd/credential.secret` (0400 root) | Fica no Web (nível `escritorio` em diante). Com não-root precisaria passar pelo controle ou ter a chave legível. |
| 9 | Gravar a auditoria em `/var/log/dgclaw` | `web/lib/auditoria.js` | escrita na pasta | Fica no Web (usuário dono da pasta). |
| 10 | `systemctl is-active dgclaw-imagem` | `web/lib/onboarding.js` | nenhum (leitura) | Funciona como qualquer usuário. |
| 11 | `ffmpeg` para converter áudio | `web/lib/media.js` | nenhum | Funciona como qualquer usuário. |
| 12 | Escutar em `127.0.0.1:8300` | `server.js` | nenhum (porta alta) | Funciona como qualquer usuário. |

Itens 3 a 6 e 8 são o motivo de o Web ser root: ele atravessa as casas de vários uids e lê segredos de root. Dá para
trocar root por `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_CHOWN`, `CAP_SETUID` e `CAP_SETGID`, mas **uma capacidade
dessas já é praticamente root sobre os arquivos**: o ganho de segurança de um Web "não-root" com `CAP_DAC_OVERRIDE`
é pequeno, e o risco de quebrar em produção é real (o item 8 e o `podman` do item 1 só dá para validar numa máquina de verdade).

## O que foi feito neste bloco

- O controle ganhou as operações privilegiadas que o Web dispara (`agente.reiniciar`, `agente.criar`, `agente.reparar`).
- Com `admin_isolado` ligado o Web recebe um sandbox do systemd (`PrivateTmp`, `ProtectHome=read-only`,
  `ProtectKernelTunables`, `ProtectSystem=full` com `ReadWritePaths=/etc/dgclaw`, `UMask=0077`). Não usa
  `NoNewPrivileges` nem filtros de chamada de sistema pelo mesmo motivo do controle: o Web chama `podman exec`.
- O Admin deixou de ser uma sessão root que o Web alcança: o que o Web ainda faz como root é código determinístico.

## O que falta para o Web rodar como `dgclaw-web`

1. Trocar o `reiniciarPorPodman` de `cofre-agente.js` por uma chamada ao socket do controle (`agente.reiniciar`).
2. Trocar o `spawn` de `web/bin/onboarding.js` por chamadas ao controle (`agente.criar` com `tarefa.ver`, `agente.reiniciar`).
3. Decidir o item 8 (cofre cifrado): o Web não-root precisa ler a chave do host; o caminho limpo é o controle devolver
   o cofre já decifrado em `/run/dgclaw/cofres`, que é o que o bloco D já faz em tmpfs.
4. Criar o usuário `dgclaw-web` e entregar a ele (dono/grupo) `agentes.json`, `web.env`, `protecoes.json`, os tokens do
   runner e os segredos do painel; hoje eles são do root.
5. Mudar o socket do controle para `0660` com o grupo do Web (`DGCLAW_CONTROLE_GRUPO`, já suportado pelo `servidor.js`).
6. Unidade final:

   ```
   User=dgclaw-web
   AmbientCapabilities=CAP_DAC_OVERRIDE CAP_FOWNER CAP_CHOWN CAP_SETUID CAP_SETGID
   CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_FOWNER CAP_CHOWN CAP_SETUID CAP_SETGID
   NoNewPrivileges=yes
   ProtectSystem=strict
   ReadWritePaths=/etc/dgclaw /var/lib/dgclaw/web /var/lib/dgclaw/agentes /var/log/dgclaw /run/dgclaw
   ```

7. Testar numa máquina real tudo o que a tabela acima chama de "Fica no Web" (login, trocar senha, cofre, Telegram,
   caixa, mídia, onboarding), com `ProtectSystem=strict`.

Só no `admin_isolado`: o nível `pessoal` não muda.
