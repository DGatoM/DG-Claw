# DG Claw Enterprise: guia para mover a branch para o original

Este guia é para o Danilo e para quem fizer o merge da branch `enterprise-main` no `main`. Ele vive em `docs/ENTERPRISE-MERGE.md` (o `DESENHO.md` aponta para esse caminho).

Fonte: o worktree `/root/claude/projetos/dgclaw-oficial-wt-ent-main` (branch `enterprise-main`, 87 commits e 300 arquivos acima do `origin/main`, com os blocos A a J), atualizado em 18/10/2026. A branch já foi rebaseada em cima do `origin/main` em `cc4cda5` e reconciliada com o que o `main` trouxe (`dgclaw atualizar`, `agente recriar`, casca única das telas, ajuda, texto do `identidade.md`). A seção 7.2 conta os conflitos que apareceram nesse rebase e como foram resolvidos. Se o `main` andar, rebaseie de novo e confira os mesmos pontos.

## 1. Em uma tela

- A branch `enterprise` acrescenta ao DG Claw quatro níveis de proteção (`pessoal`, `escritorio`, `empresa`, `regulado`), uma matriz de 22 proteções e tudo o que cada uma liga: vários usuários com 2FA, Admin sem root, container endurecido, cofre e disco cifrados, backup fora da VPS, travas de ação externa, HTTPS endurecido, LGPD, login único, auditoria encadeada, saída controlada para a internet, kit de dado sensível e o nível regulado.
- **Ela não está no produto.** Nenhum cliente nem aluno roda esse código. Só entra no `main` quando o Danilo mandar e depois de cumprir as pendências da seção 8.
- **No nível pessoal nada muda.** Sem o arquivo `/etc/dgclaw/protecoes.json` o nível é `pessoal` e o comportamento é o do `main`. Cada recurso consulta o nível antes de agir, e o código novo fica em arquivos novos (`lib/enterprise/`, `web/lib/ent/`, `controle/`, `saida/`, `ferramentas/`). Nos arquivos antigos entrou só um gancho pequeno.
- Os testes que provam isso:
  - `tests/enterprise/ganchos.test.sh`: a linha do `podman create` no nível pessoal é idêntica ao golden `tests/enterprise/golden/podman-create-pessoal.txt`, e "no pessoal a CLI não cria arquivo de auditoria".
  - `web/test/ent-usuarios.test.js` ("nível pessoal: nada muda. Sem arquivo de usuários, sem rotas novas, login de um usuário só"), `ent-cofre-cifrado.test.js` ("pessoal: nada muda"), `ent-disco-trancado.test.js` ("nível pessoal (disco_cifrado = nao): nada muda") e a seção "nível pessoal: nada muda" de `ent-controle.test.js`.
  - Quase todo `tests/enterprise/*.test.sh` e `web/test/ent-*.test.js` tem um caso `pessoal` (rotas respondem 404, nenhuma pasta nasce, nenhum comando age).
  - Os testes antigos continuam como eram. Os únicos arquivos de teste antigos que a branch alterou foram acréscimos: `canais/whatsapp/test/ponte.test.mjs`, `panel/test-provedor.mjs`, `scripts/test-teste-isolamento.sh`, `web/test/ajuda.js` (esse tem linhas trocadas, não só acrescentadas) e `tests/rodar.sh`.

## 2. O que foi construído, por bloco

Os comandos `dgclaw` abaixo existem em `lib/enterprise/*.sh` (cada um é uma função `ent_cmd_<comando>`). Todos têm linha na ajuda (`dgclaw --ajuda`), e um teste em `tests/enterprise/ganchos.test.sh` falha se uma `ent_cmd_` ficar sem ela.

### A. Fundação

- Matriz `config/protecoes-matriz.json` (22 chaves), lida pelo bash (`lib/protecoes.sh`) e pelo Node (`web/lib/protecoes.js`) com a mesma regra. Valor efetivo é o ajuste do dono, se a trava deixar, senão o padrão do nível. Ajuste abaixo da trava é ignorado com aviso.
- Trilha de auditoria encadeada por hash, escrita igual por bash (`lib/enterprise/auditoria.sh`) e por Node (`web/lib/auditoria.js`).
- Pontos de extensão: despachante `ent_despachar` na CLI, ganchos por prefixo (`ent_args_container_*`, `ent_depois_de_criar_*`, `ent_status_*`, `ent_aplicar_*`, `ent_instalar_*`), `web/lib/ent/index.js` no Web com `ent.antes` e `ent.podeVerAgente`.
- Instalador com `--nivel`, `dgclaw versao`, ganchos no `dgclaw atualizar` do `main` (auditoria, backup protegido, retenção; ver seção 5), tela `/protecoes` com tutorial.
- CI de segurança (gitleaks, CodeQL, Trivy, SBOM), Dependabot, CODEOWNERS, modelo de PR e `scripts/enterprise/proteger-main.sh`.
- Comandos: `dgclaw nivel [mostrar]`, `nivel definir <nivel>`, `nivel ajustar <chave> <valor>`, `nivel org <uuid>`, `protecoes aplicar`, `versao`. O `dgclaw atualizar` é o do `main`; o enterprise entra por ganchos em `lib/enterprise/atualizar.sh`.
- Doc: `docs/enterprise/DESENHO.md`.

### B. Multiusuário

- Usuários com papel `ti` ou `funcionario` (o funcionário vê só os agentes liberados e nunca o Admin), 2FA TOTP (RFC 6238) com 10 códigos de reserva, sessões que o usuário e o TI encerram, bloqueio da conta depois de 10 falhas, eventos de login na auditoria.
- A regra única de acesso é `podeVerAgente(sessao, slug)` (`web/lib/ent/usuarios.js`), aplicada em toda rota que recebe um slug.
- Telas `/usuarios`, `/conta`, `/login/2fa`; API `/api/v1/usuarios` e `/api/v1/eu`.
- Comandos de socorro: `dgclaw usuario listar|criar|desativar|link|zerar-2fa`.
- Doc: `web/docs/USUARIOS.md`.

### C. Controle, Admin em container, aprovações

- Serviço de controle (`controle/servidor.js`, socket `/run/dgclaw/controle.sock`, sem nenhum modelo de linguagem) com catálogo fechado de operações em três classes: leitura, reversíveis, perigosas (só executam com aprovação).
- Fila de aprovações genérica (`web/lib/ent/aprovacoes.js`, tela `/aprovacoes`): 2FA feito há menos de 15 minutos para aprovar, pedido vale 24 horas, aviso no celular, auditoria. Outros blocos registram tipos nela (o Instagram do bloco E usa).
- O Admin vira um agente em container, sem root e sem sudo, que só faz pedidos ao controle pelo `bin/dgclaw-controle`. Manutenção de emergência liga o Admin antigo por 5 a 60 minutos e fecha sozinha.
- Comandos: `dgclaw admin isolar|host|status`, `dgclaw admin manutencao abrir <5 a 60> [--por]|fechar|status`; dentro do container do Admin, `dgclaw-controle`.
- Docs: `docs/enterprise/CONTROLE.md` e `docs/enterprise/WEB-SEM-ROOT.md` (o Web ainda roda como root, ver seção 5).

### D. Container, cofre, disco e backup

- Container endurecido: `--cap-drop=ALL` com 11 capacidades devolvidas, `no-new-privileges`, `--ulimit nofile`, cerca IPv6 (`lib/enterprise/firewall6.sh`). Sem sudo para o agente.
- Cofre cifrado com `systemd-creds`; cópia em claro só em `/run/dgclaw/cofres` (tmpfs).
- Disco cifrado LUKS2 em arquivo (`/var/lib/dgclaw-cofre/dados.luks`), com desbloqueio no boot.
- Backup cifrado com restic, teste de restauração por timer, restauração que nunca sobrescreve sem `--destino` ou `--confirmar`.
- Comandos: `dgclaw agente pacote <slug> <pacote...>`, `dgclaw agente recriar <slug> [--forcar]` (é o do `main`; o enterprise só audita, por `ent_depois_de_recriar_auditoria`), `dgclaw cofre status|migrar|abrir`, `dgclaw disco status|cifrar [--tamanho 40G]|abrir`, `dgclaw backup configurar|agora|listar|testar|status`, `dgclaw restaurar <snapshot|latest> [--destino] [--agente] [--confirmar]`.
- Doc: `docs/enterprise/CONTAINER-ENDURECIDO.md`.

### E. Travas, HTTPS, políticas e credencial

- Managed settings do Claude Code por agente (`<casa>/politicas/managed-settings.json`, montado só leitura em `/etc/claude-code`): `forceLoginOrgUUID`, `forceLoginMethod`, `cleanupPeriodDays` e o `deny` das ferramentas de envio do Gmail. Para o Codex, `requirements.toml` em `/etc/codex`.
- Travas de ação externa: Gmail sem enviar (liberação temporária por aprovação do TI), Instagram publicado só depois da aprovação do TI (token fica no host, prévia da mídia com defesa contra SSRF), lista de números do WhatsApp mantida pelo TI.
- HTTPS endurecido: cabeçalhos no Caddy (HSTS e outros), CSP no Web com hash dos scripts inline, cookie `__Host-dgclaw_sessao`.
- Credencial da empresa: todo agente nasce com `uso` (`pessoa` ou `setor`); o modo `token` some do painel e o Web recusa gravá-lo.
- Comandos: `dgclaw travas liberar <slug> --minutos 5..240|fechar|conferir|status`, `dgclaw acoes instagram configurar|testar <agente>`, `dgclaw acoes whatsapp permitir|remover|listar <agente> [número]`, `dgclaw https cabecalhos`, `dgclaw agente uso <slug> pessoa --usuario <login>|setor`, `dgclaw agente criar --uso pessoa|setor [--usuario]`.
- Docs: `docs/enterprise/TRAVAS.md`, `POLITICAS.md`, `CREDENCIAL.md`.

### F. LGPD e monitor

- Retenção por prazo (`retencao_dias`): apaga transcripts, anexos e logs velhos e troca o texto de mensagens velhas por um marcador sem quebrar a corrente do `--resume`. Timer diário às 3h30 e `logrotate`.
- Exclusão por titular, com recibo que guarda só o HMAC do termo.
- Monitor de disco, certificado, cerca de rede, serviços, backup e memória, com alerta por webhook, Telegram e ping externo.
- Modo escondido do chat sem enviar texto para fora quando `sigilo_externo` está desligado.
- Comandos: `dgclaw retencao aplicar [--agente]` (com `--ensaio` só lista), `dgclaw titular buscar|apagar <termo>... [--confirmar] [--apagar-anexos]`, `dgclaw monitor verificar|configurar|testar`.
- Docs: `docs/enterprise/DADOS-PESSOAIS.md` (inventário de onde ficam os dados) e `docs/enterprise/INCIDENTE.md` (plano de resposta a incidente). O monitor não tem doc próprio, só o código em `lib/enterprise/monitor.sh`.

### G. Login único e auditoria

- SSO por OIDC (Google, Microsoft Entra, OIDC genérico), com PKCE e validação própria do token (`web/lib/sso-oidc.js`). Modos `opcional`, `padrao` e `obrigatorio`; no obrigatório, a senha local só vale para a conta de emergência do TI, sempre com 2FA. O SSO nunca cria usuário.
- Auditoria completa: toda mutação da API, painel aberto, mídia baixada, comandos dos agentes, exportações. Rotação por mês com a corrente atravessando os arquivos, retenção de 5 anos. Tela `/auditoria` e API só para o TI.
- Auditoria externa (nível regulado): entrega a coletor HTTP ou syslog sobre TLS, com selo por hora e alerta no monitor se a fila passar de 1 hora.
- Comandos: `dgclaw sso configurar|testar|emergencia|status`, `dgclaw auditoria verificar|selo|exportar|retencao mostrar|definir|aplicar`, `dgclaw auditoria externa configurar|testar|status|enviar`.
- Doc: `docs/enterprise/SSO-AUDITORIA.md`.

### H. Saída controlada

- Proxy por agente (`saida/servidor.js`, usuário sem privilégio) no gateway de cada rede (`10.89.N.1:3128`). Modo `registro` anota o destino; modo `bloqueio` deixa passar só a lista do agente mais a base do provedor (`config/saida-base.json`), e a cerca `DGCLAW-SAIDA` fecha o resto sem mexer na ordem da tabela mangle.
- Prova de dentro do container no `agente criar` (`scripts/enterprise/teste-saida.sh`); o agente para se ela falhar.
- Comandos: `dgclaw saida [mostrar <agente>]`, `saida permitir|remover <agente> <dominio>`, `saida modo <agente> <registro|bloqueio>`, `saida relatorio <agente> [--dias 7]`.
- Doc: `docs/enterprise/SAIDA.md`.

### I. Kit de dado sensível

- O agente aciona uma ferramenta fechada (`dgclaw-ferramenta`) e recebe só resultado agregado, pseudonimizado e conferido por um verificador (CPF, CNPJ, e-mail, telefone, data de nascimento, cartão e nomes da base bloqueiam a resposta inteira). A credencial fica no host.
- Serviço `dgclaw-ferramentas` (`ferramentas/`, usuário sem privilégio), executor em processo filho de ambiente limpo, registro `ferramenta_usada` na auditoria (sem registro, sem dado), relatório com prazo. Exemplo `carteira.resumo` com base sintética.
- Comandos: `dgclaw ferramenta criar|listar|testar|credencial|abrir|chave|ficha|skill`.
- Docs: `docs/enterprise/KIT-SENSIVEL.md` e `docs/enterprise/SKILL-SENSIVEL.md`.

### J. Regulado

- Runtime gVisor (`runsc`) com fingerprint da chave conferido no código; o agente só nasce sob o `runsc` depois de uma prova (systemd, cron, portas 4300 e 8300). Se a prova falha, cai para runc com aviso, evento `runtime.queda` e lista no `dgclaw status`.
- Chave do disco fora da VPS por Tang (Clevis) ou frase digitada, na ordem segura (adiciona, testa, e só com `--confirmar` tira a chave local). Sem a chave, a VPS sobe com os dados trancados e o Web explica.
- Admin desligável e formulário `/novo-agente` que cria pelo controle. Relatório mensal do teste de restauração com o `sha256` na auditoria.
- Comandos: `dgclaw agente testar-runtime [<agente>]`, `dgclaw disco chave externa tang <url> [--thp <thumbprint>] [--confirmar]`, `dgclaw disco chave externa manual`, `dgclaw disco desbloquear`, `dgclaw admin desligar|ligar`.
- Doc: `docs/enterprise/REGULADO.md`.

## 3. Matriz de proteções

Fonte: `config/protecoes-matriz.json` (versão 1). Na coluna "Travada em", `esc`, `emp` e `reg` são os níveis em que o valor não desce abaixo do padrão. Valores de proteções do tipo número não têm trava; `sessao_horas` e `backup_retencao_dias` são parâmetros, não liga/desliga.

| Chave | O que liga | pessoal | escritorio | empresa | regulado | Travada em |
| --- | --- | --- | --- | --- | --- | --- |
| `multiusuario` | Vários logins com papel | false | true | true | true | esc, emp, reg |
| `2fa` | Segundo fator TOTP (`nao`, `ti`, `todos`) | nao | ti | todos | todos | esc, emp, reg |
| `sessao_horas` | Duração do login, em horas | 720 | 168 | 72 | 12 | não |
| `auditoria` | Trilha encadeada (`nao`, `basica`, `completa`, `externa`) | nao | basica | completa | externa | esc, emp, reg |
| `admin_isolado` | Admin em container, via controle | false | true | true | true | esc, emp, reg |
| `admin_llm` | Admin conversa por modelo de linguagem (desligar deixa só comandos fixos) | true | true | true | true | não |
| `container_endurecido` | Capacidades reduzidas, `no-new-privileges`, ulimit | false | true | true | true | esc, emp, reg |
| `runtime` | `runc` ou `gvisor` | runc | runc | runc | gvisor | não |
| `cofre_cifrado` | Cofre dos agentes cifrado com `systemd-creds` | false | true | true | true | esc, emp, reg |
| `disco_cifrado` | Volume LUKS (`nao`, `auto`, `externo`) | nao | auto | auto | externo | esc, emp, reg |
| `backup` | Backup diário cifrado (restic) | false | true | true | true | esc, emp, reg |
| `backup_retencao_dias` | Dias de cópias guardadas | 30 | 30 | 30 | 14 | não |
| `travas_externas` | Gmail sem envio, Instagram por aprovação, WhatsApp por lista do TI | false | true | true | true | esc, emp, reg |
| `https_endurecido` | Cabeçalhos no Caddy, CSP, cookie `__Host-` | false | true | true | true | esc, emp, reg |
| `retencao_dias` | Dias de conversas guardadas (0 = sem prazo) | 0 | 180 | 90 | 30 | não |
| `monitoramento` | Monitor e alertas | false | true | true | true | esc, emp, reg |
| `politicas_claude` | Managed settings do Claude Code | false | true | true | true | esc, emp, reg |
| `credencial_empresa` | Agentes na conta da empresa, sem modo `token` | false | true | true | true | esc, emp, reg |
| `sigilo_externo` | Modo escondido pode mandar texto para fora | true | false | false | false | reg |
| `sso` | Login único (`nao`, `opcional`, `padrao`, `obrigatorio`) | nao | opcional | padrao | obrigatorio | reg |
| `saida` | Internet dos agentes (`livre`, `registro`, `bloqueio`) | livre | registro | registro | bloqueio | reg |
| `kit_sensivel` | Ferramentas fechadas para dado sensível | false | false | true | true | reg |

Observações:
- `sigilo_externo` e `admin_llm` têm o valor "protetor" invertido: em `sigilo_externo` o seguro é `false`; em `admin_llm` desligar é a opção mais restritiva e nunca é obrigatória.
- `runtime` não é travado: um ajuste pode devolver o regulado para `runc` (ver seção 5).
- Mudar o nível: `dgclaw nivel definir <nivel>` e depois `dgclaw protecoes aplicar`. Subir um valor: `dgclaw nivel ajustar <chave> <valor>`.

## 4. Migrações e mudanças de comportamento fora do nível pessoal

| O que muda | Onde | Efeito para quem já tem a instalação |
| --- | --- | --- |
| `--uso pessoa|setor` obrigatório no `dgclaw agente criar` | `credencial_empresa` (`lib/enterprise/credencial.sh`) | Script ou skill que cria agente sem `--uso` passa a ser recusado. `pessoa` exige `--auth assinatura` e, com multiusuário, `--usuario <login existente>`. `setor` exige `--auth api`. O teste da saída (`scripts/enterprise/teste-saida.sh`) já cria com `--uso setor`. Agentes antigos aparecem como "sem uso definido" até `dgclaw agente uso <slug> ...` |
| Modo `token` (`claude setup-token`) some do painel do agente | `panel/lib/provedores.js`, `web/lib/cofre-rotas.js` | Agente que usava `CLAUDE_CODE_OAUTH_TOKEN` precisa trocar de forma de pagar. O Web responde 403 com o motivo |
| Cookie de sessão vira `__Host-dgclaw_sessao` | `https_endurecido`, só sobre HTTPS | O nome antigo continua valendo enquanto a sessão antiga durar; sair apaga os dois. Sobre HTTP puro o nome fica o antigo |
| Podman create ganha opções novas | `tests/enterprise/golden/podman-create-escritorio.txt` | Agente criado antes não ganha as opções. `dgclaw protecoes aplicar` e `dgclaw status` listam os defasados e dão o comando de recriar (`dgclaw agente recriar <slug> --forcar`; a casa fica; perde-se o que foi instalado fora dela com `apt` ou em `/opt`) |
| Agente sem `sudo` | `no-new-privileges` (bloco D) | Quebram: `sudo` das skills `video-animado` e `service`, canal WhatsApp ligar/desligar pelo agente, criar rotina nova (`persona-cron-mgr.py`), reinício pelo `watchdog` clássico. Substitutos: `dgclaw agente pacote`, `dgclaw agente reparar`, `dgclaw agente reiniciar`. A tabela completa está em `CONTAINER-ENDURECIDO.md` |
| Admin isolado | `admin_isolado` | `dgclaw admin isolar` cria o agente `admin` em container, copia a memória do Admin do host para `admin-anterior/` na casa nova e desliga `dgclaw-admin.service`. O histórico de conversa do Claude em `/root/.claude` não é levado. A conta do Claude do Admin passa a ser o assento do próprio TI. Voltar (`dgclaw admin host`) só funciona onde a proteção não é travada; nos outros níveis, a saída é `dgclaw nivel definir pessoal` ou a manutenção de emergência |
| Web com sandbox do systemd | drop-in `dgclaw-web.service.d/20-enterprise-controle.conf` | `ProtectSystem=full` com `ReadWritePaths=/etc/dgclaw`, `PrivateTmp`, `ProtectHome=read-only`. Não usa `NoNewPrivileges` porque o Web chama `podman exec` |
| Auditoria mensal | `auditoria` completa ou externa | Na primeira gravação de um mês novo, `auditoria.jsonl` vira `auditoria-AAAA-MM.jsonl` e começa outro. O arquivo vivo mantém o nome `auditoria.jsonl`. Quem lê a trilha por fora precisa ler todos os arquivos. O nível básico não rotaciona |
| Disco cifrado move dados | `dgclaw disco cifrar` | Copia `/var/lib/dgclaw/agentes` para um volume LUKS, confere e guarda a pasta antiga em `agentes.antes-de-cifrar` (sem cifra, e o dono apaga depois). Numa máquina com agentes, o instalador só avisa, não cifra sozinho |
| Cofre cifrado | `dgclaw cofre migrar` | O `cofre.env` em claro some do disco depois de conferido por sha256. Unidade `dgclaw-cofre.service` abre a cópia em memória no boot |
| Retenção apaga dados | `retencao_dias` > 0 | Timer diário apaga transcripts e anexos velhos, o que apaga a conversa da tela do chat (o chat lê direto dos transcripts). Mensagens velhas em arquivos em uso viram `[removido pela política de retenção]` |
| Saída controlada | `saida` registro ou bloqueio | O agente recebe `HTTP_PROXY` e afins. No bloqueio, `ssh`, `git` por SSH e binários que ignoram a variável de proxy não saem. Agente novo é testado no `agente criar` e para se o teste falhar |
| Instagram | `travas_externas` | `ig-publish.py` do agente não chama mais a Graph API: pede a publicação e espera o TI aprovar. Antes, `dgclaw acoes instagram configurar <agente>` move o token para o host |
| Modo escondido | `sigilo_externo` = false | Só o filtro local age; o modelo externo não recebe texto |
| Comandos dos agentes na trilha | `auditoria` completa | Os comandos dos agentes só são registrados a partir do instante em que a auditoria completa liga |

## 5. Riscos conhecidos e limites

Cada item vem dos docs da branch, salvo os marcados como "achado na leitura" (conferidos no código, não em máquina real).

- **O Web ainda roda como root.** `docs/enterprise/WEB-SEM-ROOT.md` explica por quê: ele atravessa as casas de vários uids e lê segredos de root. Trocar root por `CAP_DAC_OVERRIDE` e companhia dá pouco ganho e risco real de quebrar. O sandbox do systemd no `admin_isolado` é o que existe hoje. O caminho (7 passos) está no doc.
- **`forceLoginOrgUUID` e `forceLoginMethod` bloqueiam `ANTHROPIC_API_KEY`** (documentação oficial do Claude Code, conferida em 18/10/2026). Por isso o agente de setor (chave de API) fica sem trava de organização: o managed settings dele leva só `cleanupPeriodDays` e o `deny` do Gmail. A organização do agente de setor é a da própria chave. Sem `org_uuid` no `protecoes.json` (`dgclaw nivel org <uuid>`), o login pessoal Pro ou Max também não fica bloqueado nos agentes de pessoa; o `dgclaw status` e o `protecoes aplicar` avisam.
- **Lista de rede do Codex a confirmar.** A OpenAI não publica os endereços do CLI. A lista base (`api.openai.com`, `auth.openai.com`, `chatgpt.com`, `registry.npmjs.org`) é o mínimo conhecido. Confirmar numa VPS real antes de ligar o bloqueio em agente Codex. O `requirements.toml` do Codex também só foi gerado pela documentação, sem teste com o binário.
- **O runtime gVisor não é travado no regulado e a compatibilidade com a imagem é desconhecida.** A documentação do gVisor não afirma que o systemd roda como PID 1 no sandbox. O código só usa `--runtime runsc` depois da prova e cai para runc com aviso. Aceitar o risco de agentes em runc é uma decisão humana por escrito (seção 8).
- **O modo `registro` da saída não barra nada** e programa que ignora o proxy sai direto. Só o bloqueio fecha isso. `github.com` e `storage.googleapis.com` na lista base servem de rota de saída para um agente comprometido. Domain fronting não é detectado.
- **Disco no modo `auto` guarda a chave na própria máquina.** Protege contra snapshot e disco descartado, não contra quem tem root com a máquina ligada. O modo `externo` (Tang ou frase) resolve, e com a chave local removida, Tang fora do ar ou frase perdida é dado perdido.
- **O processamento do modelo continua nos EUA.** Nenhum plano da Anthropic processa no Brasil. A frase de venda correta é "armazenamento no Brasil, processamento pelo modelo nos EUA, sob DPA e sem treinamento". Nunca prometer "seus dados ficam no Brasil".
- **Pseudonimizado ainda é dado pessoal, e agregado de grupo pequeno identifica** (kit sensível). O executor roda com o mesmo usuário do serviço e enxerga as pastas das outras ferramentas; resposta limitada a 25 segundos.
- **Auditoria:** a corrente prova que nada foi mexido no meio. Cortar o fim só se descobre com a auditoria externa. A trilha não deve guardar dado pessoal e a exclusão por titular não a altera.
- **Exclusão por titular não alcança** backups existentes (até expirarem), provedores de IA, `journalctl`, cópias feitas por fora e variações do nome que o termo não casa.
- **Bloqueio de conta fica em memória** (reiniciar o Web zera), WebSocket e SSE já abertos não caem quando o acesso do usuário muda, push do dono é global e `dgclaw senha` não muda a senha de quem já tem hash no `usuarios.json` (usar `dgclaw usuario link`). Pela caixa, `podeVerAgente` devolve true, então um agente ainda enxerga tarefas de outro na Mesa e nos lembretes; avaliar se em empresa isso deve mudar.
- **CSP:** `style-src 'unsafe-inline'` aceito e registrado; o painel do agente (`/p/<slug>/`) tem política própria com `'unsafe-inline'` em script; o HTML de reserva do login (`LOGIN_RESERVA`) tem script inline sem hash.
- **Cota de disco por agente** só existe como desenho (`CONTAINER-ENDURECIDO.md`, seção 3).
- **Telegram e demais canais, Google Agenda e Drive do claude.ai** não ganharam trava própria no bloco E. É decisão do TI ou da DG Medeiros.
- **`dgclaw atualizar` é o do `main` (`lib/atualizar.sh`) e o enterprise entra por ganchos.** O `main` chama `atualizar_gancho <prefixo>`, que roda as funções de `lib/enterprise/atualizar.sh`: `ent_antes_de_atualizar_auditoria` (grava `atualizar.inicio`), `ent_preparar_backup_atualizar_protecao` (tira dados protegidos do backup), `ent_depois_de_atualizar_auditoria` (grava `atualizar.sucesso`, `atualizar.falha` ou `atualizar.rollback`) e `ent_depois_de_atualizar_retencao` (aplica `backup_retencao_dias`). No nível `pessoal` todos se calam. O `ent_admin_unidades` já é usado pelo `main` para reiniciar o Admin pela unidade certa.
- **O que se perdeu com a troca pelo `atualizar` do `main`** (a versão enterprise tinha, o `main` não tem): rollback automático quando a conferência de saúde falha (agora só `dgclaw atualizar --voltar`, manual), `--ref`, `--origem` e `--sem-rollback`. Quem precisar de um commit específico faz `git checkout` na pasta do código antes de atualizar.
- **Backup do `atualizar` acima do pessoal.** O backup do `main` grava `/etc/dgclaw` e `/var/lib/dgclaw` em `.tar.gz` (600) em `/var/backups/dgclaw/`. Acima de `pessoal`, o gancho de backup exclui: dos arquivos de `/etc/dgclaw`, `disco.chave`, `backup.env`, `alertas.env`, `auditoria-externa.json` e `acoes-externas`; do `/var/lib/dgclaw`, `web/sessoes.json`, `backup`, `restauracoes`, `titulares`, `agentes.antes-de-cifrar*` e as casas dos agentes (`ATU_SEM_HOMES=1`). A atualização não mexe nesses dados, então o `--voltar` não precisa deles. As casas dos agentes ficam com o restic (`dgclaw backup`); se o backup externo não estiver configurado, o gancho avisa. A retenção `backup_retencao_dias` apaga as pastas antigas de `/var/backups/dgclaw`, guardando sempre as duas mais novas. **O `web.env` continua dentro do backup** (decisão pendente, seção 8). A decisão está em `docs/enterprise/DESENHO.md`, seção "Backup do dgclaw atualizar".
- **O `atualizar` do `main` não recria o container do Admin isolado.** Ele reinicia as unidades certas, mas o container do Admin em modo isolado só ganha a imagem nova se alguém recriar. Decisão pendente (seção 8).
- **`dgclaw agente recriar` é o do `main`.** Só recria quando a imagem mudou, então depois de subir o nível é preciso `--forcar`. Todas as mensagens e docs enterprise já mandam usar `--forcar`; o enterprise acrescenta apenas a auditoria `agente.recriar` pelo gancho `ent_depois_de_recriar_`.
- **Dois controles de versão.** O `main` grava `DGCLAW_VERSAO` e `DGCLAW_COMMIT` no `dgclaw.env`; a branch grava `/etc/dgclaw/versao` a partir do arquivo `VERSION`. Convivem, mas convém escolher um dono.
- **Telas enterprise no padrão do `main`.** As telas novas (`aprovacoes`, `auditoria`, `conta`, `usuarios`, `protecoes`, `novo-agente`, `login-2fa`) usam a casca única e o "sem zoom" do `main`; `web/test/ent-casca.test.js` confere.
- **O agente conhece o próprio nível.** Os trechos de `templates/ambiente/enterprise/*.md` (`admin-isolado`, `container`, `ferramentas`, `travas`) entram no `identidade.md` de cada agente só nos níveis em que a proteção existe. `dgclaw protecoes aplicar` regrava o `identidade.md` quando o nível muda. No pessoal o arquivo sai byte a byte como antes.
- **`.gitleaksignore` leva uma impressão digital que muda a cada rebase.** Ela é `commit:arquivo:regra:linha` e o hash do commit muda quando a branch é reescrita. Depois de cada rebase, rode o gitleaks e troque o hash pelo novo (hoje `941d27a...` para `web/test/ent-credencial.test.js:generic-api-key:14`). Não é segredo, é código de teste inventado.

## 6. Teste manual em máquina real

Os testes automáticos usam raiz falsa, `podman`, `systemctl`, `iptables`, `cryptsetup` e `restic` de mentira. Tudo abaixo só se prova numa máquina real. As listas vieram de `specs/testes-manuais.md` e dos docs; onde o bloco não tinha lista, o item está marcado "(derivado do texto do doc)".

### A. Fundação
- [ ] `dgclaw atualizar` real (apt, `npm ci`, certificado). O rollback não desfaz apt, firewall, Caddyfile nem imagens.
- [ ] Primeira rodada do `seguranca.yml` (job de imagem com `COM_NAVEGADOR=1`, limite de 60 minutos). O gitleaks pede licença se o repositório virar organização.
- [ ] Os nomes dos checks do `proteger-main.sh` (`panel web runner python shell cli enterprise gitleaks`) batendo com os jobs do CI no dia do merge.

### B. Multiusuário
- [ ] Nível `escritorio` real: entrar com o usuário do `web.env`; ativar 2FA com aplicativo real (a chave sai em grupos de 4 e como `otpauth://`; não há QR por falta de biblioteca); conferir a hora do celular.
- [ ] Link de senha de funcionário novo (HTTPS com Caddy), no celular e no desktop.
- [ ] Funcionário em `/a/` e `/p/` (WebSocket real), com agente liberado e não liberado.
- [ ] `dgclaw usuario` como root real; concorrência da trava entre a CLI e o Web.
- [ ] Telas `/conta`, `/usuarios`, `/login/2fa` em 390 px.
- [ ] Reiniciar o Web com sessões abertas.
- [ ] Se o Admin em container mudar o `tipo` no registro, revisar `agentesDeTrabalho()` e `podeVerAgente()` em `web/lib/ent/usuarios.js` (o Admin só fica escondido do funcionário por causa de `tipo: "admin"` ou `papel: "admin"`).

### C. Controle, Admin em container, aprovações
- [ ] `dgclaw admin isolar` numa instalação nova de nível `escritorio`: o container sobe, o runner responde, o Admin aparece primeiro na lista do TI e some para o funcionário.
- [ ] Entrar na conta do Claude pelo painel do Admin e pedir "liste os agentes": `agentes.listar` responde pela caixa.
- [ ] Pedir "crie o agente ana": a tarefa termina e o agente existe. Pedir "remova a ana": fica pendente; aprovar no celular com e sem 2FA recente; a casa vai para aposentados.
- [ ] Subir e parar agentes com o sandbox do `dgclaw-controle.service` (`ProtectKernelTunables=yes`). Se `podman start` falhar com erro de sysctl, tirar essa linha e registrar.
- [ ] Reiniciar o `dgclaw-web` com o drop-in (`ProtectSystem=full`): login, trocar a senha do painel (grava em `/etc/dgclaw/web.env`), guardar chave no cofre e aplicar (`podman exec`), criar o primeiro agente pelo painel.
- [ ] `manutencao.abrir` por 5 minutos: a faixa aparece, o Admin antigo responde, fecha sozinho e o registro some.
- [ ] Reiniciar a máquina com a manutenção aberta: ao subir, o controle fecha a vencida.
- [ ] `dgclaw admin host` no nível `pessoal`: o Admin antigo volta e funciona como antes.
- [ ] Web sem root (`WEB-SEM-ROOT.md`): quando o dia chegar, testar tudo o que a tabela do doc chama de "Fica no Web" (login, trocar senha, cofre, Telegram, caixa, mídia, onboarding) com `ProtectSystem=strict`.

### D. Container, cofre, disco e backup
- [ ] `podman create` com `--cap-drop=ALL` e as 11 capacidades: o systemd como PID 1 sobe? Runner, painel, cron e o `ExecStartPre=+` do cofre-nomes funcionam? O `runuser` do `agente criar` (plugin do Telegram) funciona sem `AUDIT_WRITE` extra? `ping` de dentro?
- [ ] `no-new-privileges`: o `sudo` falha de dentro; `dgclaw agente pacote` instala pacote de verdade; as rotinas continuam disparando pelos timers.
- [ ] Cerca IPv6: `ip6tables -S DGCLAW_V6`, `ping6` de dentro falha, as regras v4 e `iptables -t mangle -S FORWARD` ficam como antes.
- [ ] `systemd-creds` real, com e sem TPM2: `dgclaw cofre migrar`, reiniciar, `dgclaw-cofre.service` abre a cópia em memória antes dos containers, o agente sobe com as chaves.
- [ ] Disco: `dgclaw disco cifrar` com agentes ligados numa VPS real; reiniciar e ver `dgclaw-disco.service` abrir o volume antes do Web; `fsck` e espaço (arquivo esparso).
- [ ] Backup: `restic` contra bucket S3 ou B2 de verdade; `dgclaw backup testar` e `dgclaw restaurar --destino`; conferir que `restore --include` se comporta como o stub supõe.
- [ ] `dgclaw agente recriar` num agente com rotinas e canal ligado (perde o que foi instalado na camada do container).
- [ ] Decidir se algum dos usos de `sudo` que quebraram vira comando de host: canal WhatsApp ligar/desligar pelo agente, criar rotina nova, reinício do watchdog clássico, skills `service` e `video-animado`.
- [ ] Digest do `ubuntu:24.04` ainda não fixado (ver seção 7).

### E. Travas, HTTPS, políticas e credencial
- [ ] O `claude` num container recriado lê `/etc/claude-code/managed-settings.json` (`/status` no agente cita as managed settings) e recusa login de outra organização (`forceLoginOrgUUID`).
- [ ] Com o envio travado, o agente não recebe `send_message`, `reply` e `forward` do Gmail; depois de `dgclaw travas liberar` ele recebe sem reiniciar o container; ao vencer, volta a perder.
- [ ] O timer `dgclaw-travas-fecha-<agente>` aparece em `systemctl list-timers` e dispara; o `dgclaw-travas.timer` fecha o que sobrou depois de um reboot no meio da liberação.
- [ ] `caddy validate` com o bloco de cabeçalhos e os cabeçalhos chegando no navegador (`curl -sI https://<dominio>/login`).
- [ ] Em navegador real, cada tela do Web carrega sem violação da CSP no console (conversa com lousa, voz, push, PDF, `/aprovacoes`, `/auditoria`, login com SSO) e o painel do agente em `/p/<slug>/`.
- [ ] Publicação real de teste no Instagram por conta de teste: pedido, prévia, aprovação com 2FA, post no ar.
- [ ] WhatsApp: com a lista do TI, um número fora dela não recebe resposta mesmo se o agente editar o arquivo dele.
- [ ] Rodar `/status` dentro do agente e conferir a fonte das configurações; tentar `claude auth login` com conta de outra organização (deve recusar); confirmar que a chave de API de um agente de setor continua funcionando.
- [ ] O binário do Codex da imagem lê `/etc/codex/requirements.toml`.

### F. LGPD e monitor
- [ ] `logrotate -d /etc/logrotate.d/dgclaw-enterprise`: `runner.log` em pasta não-root, sem `su`.
- [ ] `--resume` do Claude Code depois que a retenção redige mensagens antigas (blocos `thinking` com `signature` antiga).
- [ ] `retencao` e `titular` como root sobre casa real (uid mapeado): dono preservado e o reindex segue gravando.
- [ ] Timers reais (retenção, monitor) e alertas reais (webhook, Telegram, ping) com `dgclaw monitor testar`.
- [ ] `openssl` contra domínio real, cerca sumindo e sendo reaplicada, `df` no volume cifrado.
- [ ] Decisões registradas: `chunks.db` (embeddings) fora da retenção por idade, só exclusão por titular; recibo do titular com HMAC e sal.
- [ ] Preencher a seção 8 do `INCIDENTE.md` (contatos) antes do primeiro cliente.

### G. Login único e auditoria (derivado do texto do doc, o `SSO-AUDITORIA.md` não tem lista própria)
- [ ] SSO com Google Workspace e com Microsoft Entra reais: botão na tela de entrada, retorno em `https://<dominio>/sso/retorno`, usuário não cadastrado, usuário desativado.
- [ ] MFA exigido no provedor antes de pôr o painel em `padrao` ou `obrigatorio` (o SSO conta como segundo fator feito pelo provedor).
- [ ] Redirect atrás do Caddy: sem `redirect_uri` fixo vale a origem do pedido, que depende de o proxy repassar o host certo.
- [ ] Modo `obrigatorio` com o provedor fora do ar: a conta de emergência entra com senha e 2FA; `dgclaw status` avisa do uso.
- [ ] Auditoria externa contra coletor HTTP e contra syslog TLS reais: lote, reenvio após falha, selo por hora, alerta de fila acima de 1 hora.
- [ ] Virada de mês da corrente (`auditoria-AAAA-MM.jsonl`) e `dgclaw auditoria verificar` atravessando os arquivos.

### H. Saída controlada
- [ ] `iptables` ou `nft` de verdade aceitam a regra `-p tcp --dport 3128` sem `-m tcp`; a ordem final das tabelas filter e mangle é a dos testes (`iptables -t mangle -S FORWARD`, `iptables -S INPUT`) depois de criar três agentes seguidos (o netavark reescrevendo a filter no meio).
- [ ] O proxy escuta em `10.89.N.1` logo depois de `podman network create` (tenta de novo a cada 3 s) e reabre sozinho depois de um reboot.
- [ ] A unidade sobe com todo o hardening (`systemd-analyze security dgclaw-saida`), o `BindPaths` para `/opt/dgclaw/saida-log` funciona e o serviço lê `/etc/dgclaw/saida` (o `/etc/dgclaw` precisa ser 755).
- [ ] De dentro de um agente em bloqueio: `curl https://api.anthropic.com` passa, domínio fora da lista leva 403, `curl --noproxy '*' https://1.1.1.1` trava, e o Claude Code e o Codex fazem login e uma conversa completa só com a lista base. Anotar o que faltar na lista do Codex.
- [ ] O que o Claude Code faz na primeira execução e na atualização (plugins, `downloads.claude.ai`) com o proxy.
- [ ] `agente recriar` num agente antigo traz as variáveis de proxy e o `dgclaw status` para de avisar.
- [ ] Telegram e WhatsApp do agente funcionam no bloqueio depois de liberados.
- [ ] Retenção do registro da saída e permissão do arquivo (640, grupo `dgclaw-saida`).
- [ ] Conversa longa com resposta em streaming por 10 minutos: o túnel não corta (o proxy fecha conexão ociosa depois de 10 minutos).

### I. Kit de dado sensível
- [ ] `dgclaw protecoes aplicar` num servidor `empresa`: nasce o usuário `dgclaw-ferramentas`, a unidade sobe, o socket aparece em `/run/dgclaw-ferramentas/` e o Web (root) abre o socket.
- [ ] Hardening do systemd com Python e Node de verdade (`SystemCallFilter=@system-service`, `ProtectSystem=strict`): rodar `carteira.resumo` e conferir que não há `SIGSYS` em `journalctl -u dgclaw-ferramentas`.
- [ ] `ulimit -v` com o driver real do banco (psycopg, pyodbc e afins reservam muita memória virtual): ajustar `memoria_mb`.
- [ ] O `ExecStartPre=+-` abrindo as credenciais cifradas no boot, depois do disco e do cofre.
- [ ] O fluxo inteiro pelo container: imagem reconstruída com o `dgclaw-ferramenta`, o agente chamando pela caixa, resposta dentro dos 30 s, relatório aparecendo em entregas e sumindo no prazo.
- [ ] `dgclaw atualizar` e o `--voltar` preservam `/etc/dgclaw/ferramentas` (credenciais e chave de pseudônimo).

### J. Regulado
- [ ] `dgclaw nivel definir regulado` e `dgclaw protecoes aplicar` numa VPS de teste; criar um agente; `dgclaw status`.
- [ ] `dgclaw agente testar-runtime` e `dgclaw agente testar-runtime <agente>` com o `runsc` de verdade; `podman inspect -f '{{.OCIRuntime}}' dgclaw-<agente>` (confirmar que o podman da máquina expõe o campo); `sudo apt-get`, `dgclaw agente pacote` e as rotinas sob o `runsc`; ajuste de `--cgroup-manager` ou `--systemd-cgroup` no `containers.conf`; consumo e tempo de partida.
- [ ] Receita do thumbprint (`jose fmt ... | jose jwk thp`) contra um Tang real: sem `--thp` o comando mostra o mesmo valor do `tang-show-keys`.
- [ ] `clevis luks bind` e `clevis luks pass -s <slot>` contra um volume que é arquivo (`dados.luks`); se o Clevis exigir dispositivo de bloco, anexar o arquivo a um loop (`losetup`) na unidade de boot.
- [ ] Reiniciar a VPS com o Tang no ar (abre sozinha) e com o Tang fora do ar (sobe trancada, Web mostra a mensagem, monitor alerta). Religar o Tang e rodar `dgclaw disco abrir`.
- [ ] Modo manual: reiniciar, ver a tela de dados trancados, `dgclaw disco desbloquear` e conferir que os containers sobem (`podman-restart.service`; se algum ficar parado, `dgclaw agente iniciar <agente>`).
- [ ] `dgclaw admin desligar`; criar agente pelo formulário `/novo-agente` no celular (abrir o painel do agente, entrar com a assinatura, voltar e tocar em "Já entrei. Pode testar."); `dgclaw admin ligar`.
- [ ] `dgclaw backup testar` no regulado e conferir o relatório em `/var/lib/dgclaw/backup/relatorios/` e o evento na auditoria.

## 7. Passo a passo do merge

### 7.1 Antes de começar

1. Congele a branch: nenhum commit novo na `enterprise-main` durante o merge. Trabalhe numa cópia (`git worktree add ../dgclaw-merge enterprise-main`), nunca direto no worktree da branch.
2. `git fetch origin` e anote o commit do `origin/main`. A branch está rebaseada em `cc4cda5`, que traz o `dgclaw atualizar`, o modo monitor, a casca única e o aviso de novidades. Se o `origin/main` já passou disso, rebaseie de novo (7.2).
3. Como a branch já está sobre o `main`, o merge no `main` deve ser avanço simples (`git merge --ff-only enterprise-main`) ou um pull request sem conflito. Só rebaseie se o `main` tiver andado.

### 7.2 Conflitos que apareceram no rebase de 18/10/2026 e como foram resolvidos

O rebase sobre `cc4cda5` foi feito uma vez, commit a commit. Num rebase futuro os conflitos devem reaparecer nos mesmos pontos, porque são os mesmos arquivos que as duas pontas mexem. Para não resolver o mesmo conflito em vários commits, ligue o `rerere` (ele lembra a resolução): `git -c rerere.enabled=true rebase origin/main`. Os arquivos:

| Arquivo | O que conflitou | Como foi resolvido |
| --- | --- | --- |
| `bin/dgclaw` | (1) o `source` de `lib/atualizar.sh` do `main` contra o `source` de `lib/protecoes.sh` e `lib/enterprise/*.sh`; (2) o texto da `ajuda` (seção de atualizar do `main` contra "Protecao e versao" e as seções novas da branch); (3) o `case` de `agente` (o `main` acrescentou `recriar` e `identidade`); (4) o `case` final (`atualizar) atualizar_main` contra o despachante `ent_despachar`) | Em (1), os dois `source`. Em (2), as duas seções, com as linhas `dgclaw atualizar [--ref ...]` da branch apagadas. Em (3), o texto do `main` (`recriar`, `identidade`) com o `ent_despachar "agente-$sub"` da branch. Em (4), `atualizar) atualizar_main` e depois o `*)` com `ent_despachar`. A função `agente_main` ficou do `main`, com a chamada `ent_rodar_ganchos ent_depois_de_recriar_ "$slug"` |
| `install.sh` | `atualizar_identidades()` do `main` e `ent_instalar()` da branch no mesmo ponto | As duas funções ficaram. `ent_instalar` roda depois de tudo que cria agentes e usuário, e `atualizar_identidades` continua onde o `main` pôs |
| `web/server.js` | A rota `/`: o `main` usa `agenteInicial(req)` (último agente do cookie `dgclaw_agente`, senão o primeiro que não é Admin); a branch escolhia o primeiro que `ent.podeVerAgente` libera | `agenteInicial(req, sessao)` do `main` agora filtra a lista por `ent.podeVerAgente(sessao, a.slug)`, e a página "Nenhum agente liberado" da branch aparece quando a lista filtrada fica vazia. O cookie nunca aponta para um agente que o funcionário não vê |
| `tests/rodar.sh` | Cabeçalho das partes, lista do `shellcheck` e a linha da parte `ambiente` contra a da `enterprise` | Parte enterprise numerada 13 (`novidades` 11, `monitor` 12, `ambiente` como no `main`) e as duas listas de `shellcheck` unidas (as do `main` mais `lib/enterprise/*.sh`, `tests/enterprise/*.sh` e as pastas `stubs*`) |
| `CHANGELOG.md` | Regiões onde as duas pontas acrescentaram entradas no mesmo ponto | Resolvido com `specs/junta-conflito.py` (7.3), depois conferido à mão, com a reconciliação registrada em entrada própria |
| `.github/pull_request_template.md` | Os dois lados criaram o arquivo | Um modelo só, com os itens do `main` e os da branch ("No nível pessoal nada muda"; "Sem segredo, chave ou caminho de máquina"; "Fora do que o teste cobre") |

Além do texto, houve conflito de **comportamento** que a reconciliação resolveu (detalhes na seção 5):

1. **`dgclaw atualizar`** ficou o do `main`, com os ganchos enterprise. `ent_cmd_atualizar` foi removido e `tests/enterprise/atualizar.test.sh` foi reescrito contra o fluxo do `main` (raiz falsa, sem git e sem rede).
2. **`dgclaw agente recriar`** ficou o do `main`; `ent_cmd_agente_recriar` foi removido, `--sim` virou `--forcar` em mensagens, docs e testes, e a auditoria entrou como `ent_depois_de_recriar_auditoria`.
3. **Backup do `atualizar`**: decidido por gancho (seção 5), com o `web.env` ainda dentro (pendência).
4. **`templates/ambiente`**: o `main` exige que o que o agente precisa conhecer esteja nesses modelos. Os trechos enterprise ficam em `templates/ambiente/enterprise/*.md` e entram no `identidade.md` por `lib/enterprise/ambiente.sh`. `bash tests/ambiente/rodar.sh` confere.
5. **Telas novas e a casca única**: as telas enterprise usam a casca, o tutorial com Pular e o "sem zoom" do `main`. `web/test/ent-casca.test.js` e `web/test/casca.test.js` conferem.

Pontos que podem dar conflito de texto num rebase futuro, se o `main` mexer neles: a linha do `const ent = criarEnterprise({ ... })` em `web/server.js` (qualquer dependência nova passada ao `criarEnterprise` pede conferência), `lib/comum.sh` (gancho `ent_caddy_extra` em `bloco_caddy`), `container/Containerfile` e `panel/lib/provedores.js`. Hoje esses três últimos mesclam sozinhos.

### 7.3 Conflitos de CHANGELOG

O arquivo `specs/junta-conflito.py` (na pasta de auditoria `/root/claude/projetos/dgclaw-oficial-auditoria/`, fora do repositório) resolve conflito do tipo "manter os dois lados". Ideia: para cada bloco `<<<<<<< ... ======= ... >>>>>>>`, ele concatena o lado de cima (HEAD) e o lado de baixo, nessa ordem, e remove as três linhas de marcador (usa uma expressão regular com `re.S` e reescreve o arquivo no lugar). Uso: `python3 junta-conflito.py CHANGELOG.md`. Serve para o CHANGELOG, onde as entradas são independentes; **não use** em `bin/dgclaw`, `install.sh`, `web/server.js` nem `tests/rodar.sh`, onde manter os dois lados quebra a sintaxe ou duplica comportamento. Depois de rodar, abra o arquivo e confira à mão: o `main` e a branch têm entradas sobre `atualizar` (a da branch vira redundante, apague) e os comentários `<!-- bloco E -->`, `<!-- fim bloco E -->` e `<!-- Bloco H ... -->` da branch podem sair. Se algum dia for refazer o rebase commit a commit, rode o script a cada parada do conflito de CHANGELOG, `git add CHANGELOG.md` e `git rebase --continue`.

### 7.4 Testes depois da integração

Rode nesta ordem, todos precisam passar:

```
bash tests/rodar.sh
bash tests/enterprise/rodar.sh
node --test web/test/
bash tests/ambiente/rodar.sh        # do main
node --test web/test/ent-casca.test.js
```

Detalhes:
- `tests/rodar.sh` roda tudo, inclusive a parte `enterprise` (13). Não pule o `shellcheck`: a lista de arquivos foi mesclada à mão.
- `tests/enterprise/rodar.sh` roda `tests/enterprise/*.test.sh` (raiz falsa em `DGCLAW_RAIZ`, stubs no PATH, nada toca a máquina).
- `node --test web/test/` inclui `web/test/ent-*.test.js`, `casca.test.js` e `ent-casca.test.js`.
- **Rode a suíte enterprise também como usuário sem privilégio**, porque o CI roda assim e a sessão do Danilo costuma ser root. Copie o repositório para um clone em `/tmp` que o usuário leia e rode com `setpriv --reuid=65534 --regid=65534 --clear-groups bash tests/enterprise/rodar.sh`, e o mesmo com `node --test web/test/`. Os testes enterprise anunciam o que pulam quando não são root (por exemplo o `systemd-creds` de mentira e a RAM temporária nos testes Node).
- Golden do `podman create`: `tests/enterprise/golden/podman-create-pessoal.txt` e `podman-create-escritorio.txt`. Se o `main` mudar o `criar_container`, o golden do pessoal pode falhar. Antes de atualizar o golden, confirme que o `main` puro gera a nova linha igual (é a prova de que o nível pessoal não mudou). Só então regrave o golden do escritório.
- CI: depois do push, os jobs são `panel web runner python shell cli enterprise` (em `ci.yml`) e `gitleaks` (em `seguranca.yml`). Os mesmos nomes entram em `proteger-main.sh`.

### 7.5 Como ativar por cliente

- Instalação nova, já no nível: `sudo ./install.sh --usuario <nome> --nivel escritorio` (ou `empresa`, `regulado`). Sem `--nivel`, o nível é `pessoal` e não existe `protecoes.json`.
- Reinstalação preserva o nível que já existe. `--nivel pessoal` **não rebaixa** uma instalação que já esteja acima (o instalador avisa).
- Instalação que já existe: `dgclaw nivel definir <nivel>` e em seguida `dgclaw protecoes aplicar`. O `definir` também serve para voltar a `pessoal`.
- Ajuste fino: `dgclaw nivel ajustar <chave> <valor>` (sobe, nunca desce abaixo da trava). Fixar a organização do Claude: `dgclaw nivel org <uuid>`.
- Containers criados antes não ganham as opções novas sozinhos: `dgclaw protecoes aplicar` lista os defasados.
- Cada nível exige configurar o que depende de fora: backup (`dgclaw backup configurar --repositorio ...`), disco (`dgclaw disco cifrar`), monitor (`dgclaw monitor configurar`), SSO (`dgclaw sso configurar`), auditoria externa no regulado (`dgclaw auditoria externa configurar`), Admin (`dgclaw admin isolar`).

### 7.6 No dia do merge (decisão humana)

Os dois scripts estão em `scripts/enterprise/`. **Nenhum deles deve rodar sem o Danilo mandar.**

1. `bash scripts/enterprise/proteger-main.sh` (sem argumento só mostra o que enviaria). Com `--aplicar`, liga a proteção da branch `main` no GitHub: toda mudança entra por pull request, os checks `panel web runner python shell cli enterprise gitleaks` precisam estar verdes e a branch do PR atualizada com a `main`, conversa de revisão resolvida, sem force-push e sem apagar a `main`, valendo também para administradores (`enforce_admins`). Opções: `--repo DONO/NOME` (padrão `DGatoM/DG-Claw`), `--branch`, `--revisores N` (padrão 0). Precisa do `gh` logado como admin do repositório. **Rode só depois do merge**: com a proteção ligada, nem o dono empurra direto na `main`. Se os nomes dos checks não baterem com os jobs do CI, o GitHub recusa ou os PRs ficam esperando um check que não existe.
2. `bash scripts/enterprise/fixar-digest-ubuntu.sh` mostra o digest do manifest list oficial de `ubuntu:24.04` no Docker Hub. Com `--aplicar`, reescreve as linhas `FROM ubuntu:24.04` do `container/Containerfile` para `ubuntu:24.04@sha256:...`. Precisa de rede até `hub.docker.com` (o ambiente onde a branch foi escrita não alcança, por isso ainda não foi aplicado). Depois: `dgclaw imagem construir`, testar um agente novo e commitar o `Containerfile`. Repetir o comando é também o jeito de atualizar o Ubuntu para pegar correções de segurança. Fixar o digest muda a imagem de todos os agentes novos, por isso é decisão humana.

## 8. Pendências humanas

Nada disto o código resolve.

- **Jurídico.** Revisar o `docs/enterprise/INCIDENTE.md`, o inventário de `DADOS-PESSOAIS.md` e as fichas do kit sensível (`dgclaw ferramenta ficha`); definir a retenção legal de cada tipo de dado (o padrão do regulado, 30 dias, pode ser pouco ou demais por setor); confirmar se o órgão regulador do cliente aceita processamento fora do país; contrato de operador com a Anthropic com cláusulas de retenção e localização; nomear o encarregado (DPO) e preencher os contatos da seção 8 do plano de incidente.
- **Pentest.** Fazer um teste de invasão independente antes do primeiro cliente de nível `empresa` ou `regulado`. O ponto mais sensível é o conjunto controle, aprovações e Admin isolado, mais o proxy de saída e o kit sensível. Os docs não trazem pentest feito.
- **Commercial Terms e e-mail ao time de vendas da Anthropic.** A DG Medeiros precisa aceitar os Commercial Terms (organização comercial: plano Team ou conta de API). Mandar e-mail descrevendo o arranjo (VPS da empresa, um assento por pessoa, agente persistente acionado por painel web, rotinas automáticas) e pedir confirmação por escrito; guardar a resposta. Na mesma mensagem, perguntar se a lógica que limpa variáveis de autenticação por modo (`providers/catalogo.json`) cabe na regra de não restringir métodos de autenticação. Agente ligado 24 horas no assento do funcionário é zona cinza até essa resposta. Releia "Legal and compliance" e "Authentication" do Claude Code antes de cada contrato.
- **Piloto.** O primeiro contrato deve ser piloto de 60 a 90 dias, no nível `escritorio`, sem dado sensível. Recomendação de plano: Team com assento Premium para quem tem agente ligado o dia todo (escritório); Enterprise para empresa e regulado.
- **Digest do `ubuntu:24.04`.** Rodar `fixar-digest-ubuntu.sh --aplicar` numa máquina com acesso ao Docker Hub (seção 7.6).
- **`proteger-main.sh --aplicar`** depois do merge (seção 7.6).
- **Decisões em aberto**, todas citadas nos docs:
  - runtime gVisor: aceitar por escrito o risco de agentes em runc se a prova falhar, ou travar `runtime` em `gvisor` no regulado (hoje um ajuste devolve o regulado para `runc`);
  - quem opera o servidor Tang (ou quem sabe a frase do disco) e onde ficam as cópias do cabeçalho LUKS;
  - cota de disco por agente: construir ou não (`CONTAINER-ENDURECIDO.md`, seção 3);
  - trava para Telegram, Google Agenda e Drive (convite com convidados, compartilhamento de arquivo): entram ou não na lista de `deny`;
  - avaliar se, em empresa, um agente deve enxergar tarefas e lembretes de outro pela caixa;
  - tirar o root do Web (7 passos de `WEB-SEM-ROOT.md`) ou aceitar o sandbox como suficiente;
  - `web.env` no backup do `atualizar` acima do pessoal: tirar ou manter (hoje fica dentro, seção 5);
  - recriar o container do Admin isolado no `atualizar`, que o `main` não faz (seção 5);
  - qual controle de versão fica (seção 5);
  - se devolver ao `atualizar` o rollback automático e as opções `--ref`, `--origem` e `--sem-rollback` que a troca pelo do `main` perdeu;
  - o que fazer com os usos de `sudo` que o agente perde (seção 6, bloco D);
  - guardar a chave do repositório restic fora da VPS (ela é mostrada uma vez só na primeira configuração; sem ela não há restauração) e a frase do disco em dois lugares.

- **Limpeza na VPS de desenvolvimento** (não é do produto, só desta máquina): remover o usuário de sistema `dgclaw-saida` (uid 987), criado por engano por um teste, e a cadeia `ip6tables` `DGCLAW_V6`, inerte (só tem `RETURN`), deixada por um teste antigo. Nenhum dos dois entra no produto nem em instalação de cliente.
