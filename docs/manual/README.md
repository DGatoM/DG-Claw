# Manual do DG Claw

Este manual diz, com os pés no chão, o que o DG Claw faz hoje, onde pedir cada coisa e o quanto cada afirmação foi conferida. Ele foi escrito para o dono do DG Claw, que não precisa ser programador, e também para o Admin ler antes de agir. O conteúdo detalhado fica nos documentos que cada página aponta.

## Como ler a tabela "O que o DG Claw faz hoje"

- **Estado.** `Pronto` quer dizer que o recurso está no código da `main` e tem teste automático que cobre o que a linha afirma. `Parcial` quer dizer que existe, mas com um limite que a linha declara (só um dos motores, sem teste ao vivo, depende de um passo manual). `Em desenvolvimento` quer dizer que não está liberado, mesmo que haja código ou documento: não conte com ele.
- **Onde pedir.** O lugar onde o dono clica ou a frase que ele diz ao agente ou ao Admin.
- **Como foi verificado.** `teste` com o arquivo que cobre o recurso, ou `lido no código` quando não achei teste e conferi só lendo. Nunca escrevi "testado" para o que só li. Um teste que existe mas não roda no `tests/rodar.sh` vem marcado como "fora da bateria".
- **Página.** Onde o recurso está explicado.

Os caminhos de teste são relativos à raiz do repositório.

## O que o DG Claw faz hoje

### Conversa e telas

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Entrar no painel e criar a primeira senha | Pronto | `/login`, `/primeiro-acesso` | teste: `web/test/auth.test.js`, `web/test/primeiro-acesso.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Conversa com o agente (chat do navegador) | Pronto | `/a/<slug>` | teste: `web/test/api.test.js`, `web/test/thread.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Primeiro agente pelo Admin | Pronto | Botão "Quero criar meu primeiro agente" | teste: `web/test/onboarding.test.js`, `web/test/primeiro-acesso.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Selos de estado, "não lida" e menu de agentes | Pronto | Menu à esquerda | teste: `web/test/estados.test.js`, `web/test/nao-lidas.test.js`, `web/test/vigia-atencao.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Pedido de permissão e pergunta de escolha na conversa | Parcial (só no Claude) | Cartão que aparece na conversa | teste: `web/test/trilha.test.js`, `web/test/pergunta.test.js`; limite do Codex lido em `runner/src/sessao.ts` | [conversa-e-telas.md](conversa-e-telas.md) |
| Mídias, links e arquivos (Compartilhados) | Pronto | Foto ou nome do agente | teste: `web/test/compartilhados.test.js`, `web/test/midias-cache.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Anexos (até 10 por mensagem, 50 MB) | Pronto | Clipe 📎 | teste: `web/test/grava-anexo.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Voz: gravar, transcrever e ouvir | Pronto, com chave | Botões 🎤, 🔊 e 🔁 | teste: `web/test/voz-groq.test.js`, `web/test/voz-fatiar.test.js`, `web/test/voz-fila.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Comandos de barra | Pronto | Digitar `/` na conversa | teste: `web/test/comandos.test.js`, `web/test/barra.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Lousa (visuais na conversa) | Pronto | "Me explica isso na lousa" | teste: `web/test/visuais.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Campo de senha na conversa (cofre) | Pronto | O agente mostra o cartão | teste: `web/test/campo-cofre.test.js`, `web/test/cofre-agente.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Modo escondido (👁) | Pronto | Botão 👁 | teste: `web/test/sigilo.test.js`, `web/test/sigilo-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Anonimizar documentos | Pronto | `/anonimizar` | teste: `web/test/anonimizar.test.js`, `web/test/anonimizar-tela.test.js`, `tests/anonimizar/rodar.sh` | [conversa-e-telas.md](conversa-e-telas.md) |
| Lembretes que insistem | Pronto | `/lembretes` ou "me lembra de..." | teste: `web/test/lembretes.test.js`, `web/test/lembretes-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Avisos no aparelho (web push) | Pronto | "Ativar avisos neste aparelho" | teste: `web/test/push.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Modo foco | Pronto | "Monta meu foco de hoje" | teste: `web/test/foco.test.js`, `web/test/foco-hook.test.js`, `web/test/foco-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Alertas de entrega e de pedido | Pronto | Pilha à direita da conversa | teste: `web/test/alertas.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Uso da assinatura | Pronto | Status do painel, ☰ Uso das assinaturas | teste: `web/test/uso.test.js`, `runner/src/uso.test.ts` | [conversa-e-telas.md](conversa-e-telas.md) |
| Conectar conta de IA | Pronto | `/conectar` | teste: `web/test/conectar-rota.test.js`, `web/test/conectar-puro.test.js`, `web/test/login-conversa.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |
| Tutorial (visita guiada) em cada tela | Parcial (sem teste automático) | Botão Tutorial | lido no código (`web/public/tour.js`); só há teste de telas que citam o Tutorial | [conversa-e-telas.md](conversa-e-telas.md) |
| Painel do agente: Status, Operações, Skills, Pasta | Pronto | `/p/<slug>/` | teste: `panel/test-operacoes.mjs`, `panel/test-skills.mjs`, `panel/test-arquivos-sem-pasta.mjs`, `panel/test-wm-status.mjs` | [conversa-e-telas.md](conversa-e-telas.md) |
| Painel do agente: aba Apps | Parcial (sem teste automático) | `aba:apps` | lido no código (`panel/lib/apps.js`) | [conversa-e-telas.md](conversa-e-telas.md) |
| Manual dentro do painel | Pronto | `/manual`, menu ☰ Manual | teste: `web/test/manual.test.js`, `web/test/manual-tela.test.js` | [conversa-e-telas.md](conversa-e-telas.md) |

### Agentes

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Criar, listar, parar, reiniciar, reparar, recriar e remover agentes | Pronto | Admin: "cria um agente" | teste: `tests/cli/criar.sh`, `tests/cli/gestao.sh`, `tests/cli/recriar.sh` | [agentes.md](agentes.md) |
| Identidade e personalidade (editar e regravar) | Pronto | `aba:identity`, `aba:personality` | teste: `tests/cli/criar.sh`, `tests/ambiente/rodar.sh`, `panel/test-memoria-editar.mjs` | [agentes.md](agentes.md) |
| Mesa de tarefas | Pronto | `/mesa` | teste: `web/test/mesa.test.js`, `web/test/mesa-tela.test.js`, `bin/test/dgclaw-mesa.test.sh` | [agentes.md](agentes.md) |
| Quadro de avisos entre agentes | Pronto | `/avisos` | teste: `web/test/avisos.test.js`, `web/test/avisos-tela.test.js`, `web/test/avisos-ponta.test.js`; o gancho `hooks/avisos.py`, que injetaria os avisos a cada mensagem, não achei ligado na criação do agente (a leitura pela API existe) | [agentes.md](agentes.md) |
| Tela (navegador do agente) | Pronto | Menu "Navegador", `aba:tela` | teste: `tests/tela/rodar.sh`, `tests/cli/tela.sh`, `panel/test-tela.mjs` | [agentes.md](agentes.md) |
| Sessões e cards (mini-Bunker) | Pronto | `aba:sessoes`, "abre um card" | teste: `panel/test-sessoes-local.mjs`, `bin/test/dgclaw-card.test.sh`, `runner/src/sessoes-modo.test.ts` | [agentes.md](agentes.md) |
| Modo monitor dos cards | Pronto | O agente liga sozinho | teste: `tests/monitor/rodar.sh` | [agentes.md](agentes.md) |
| Cofre e chaves de API do painel | Pronto | `aba:cofre`, `dgclaw agente cofre` | teste: `panel/test-cofre.mjs`, `panel/test-chaves-api.mjs`, `tests/cli/cofre.sh` | [agentes.md](agentes.md) |
| Socorro (ajudante de plantão) | Parcial (só Claude) | `aba:socorro` | teste: `panel/test-saude.mjs`; uso exclusivo do Claude lido em `panel/lib/socorro.js` | [agentes.md](agentes.md) |
| Colaborador convidado pelo dono | Pronto | `/colaboradores` | teste: `web/test/colaboradores.test.js`, `web/test/colaboradores-revisao.test.js` | [agentes.md](agentes.md) |
| Colaborador criado pelo Admin (`dgclaw colaborador`) | Em desenvolvimento | Ainda não existe | não verificado: o comando não existe na CLI desta branch | [em-desenvolvimento.md](em-desenvolvimento.md) |
| 14 skills ligadas ao agente na criação | Parcial (sem teste automático) | Pedir em português ou `/` na conversa | lido no código (`bin/dgclaw`, laço de skills); `lista-rapida` e `foco` têm teste próprio | [agentes.md](agentes.md) |
| Skills no repositório sem ligação automática (`canais`, `cards`, `mesa`, `tela`, `socorro`, `lista-rapida` e as do plugin antigo) | Parcial | Conferir antes de prometer | lido no código; `scripts/_lib/test_lista_rapida.py` cobre só a lista rápida | [agentes.md](agentes.md) |
| Poder `instagram` | Parcial | "Ativa o Instagram" | teste só dos timers: `scripts/_lib/test_install_ig_timers.py`; resto lido no código | [agentes.md](agentes.md) |
| Poderes `meetings`, `crm` e `secretary` | Em desenvolvimento | Travados | lido no código (`panel/lib/poderes.js`, `powers/*/POWER.md`) | [em-desenvolvimento.md](em-desenvolvimento.md) |

### Canais

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Chat do painel (DG Chat) | Pronto | `/a/<slug>` | teste: `scripts/dgchat-mcp/test-server.mjs` | [canais.md](canais.md) |
| Telegram | Pronto (só Claude) | "Quero falar com você no Telegram" | teste: `bin/test/dgclaw-agente.test.sh`, `runner/src/canais.test.ts`, `web/test/token-telegram.test.js` | [canais.md](canais.md) |
| `whatsapp` | Parcial | "Conecta meu WhatsApp" | teste com WhatsApp falso: `canais/whatsapp/test/ponte.test.mjs`, `bin/test/dgclaw-agente.test.sh`; sem teste ao vivo | [canais.md](canais.md) |
| Gmail, Agenda e Drive pelos conectores do Claude | Parcial (só Claude na assinatura) | "Resume os meus últimos e-mails" | teste da trava de envio: `scripts/test-gmail-permissao.sh` (fora da bateria); conectores lidos em `docs/GMAIL-NO-AGENTE.md` | [canais.md](canais.md) |

### Provedores

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| `claude` (Claude Code) | Pronto | Admin: `--provedor claude` | teste: `runner/src/claude-motor.test.ts`, `runner/src/sessao-claude.test.ts` | [provedores.md](provedores.md) |
| `codex` (Codex CLI) | Parcial | Admin: `--provedor codex` | teste: `runner/src/codex-motor.test.ts`, `runner/src/sessao-codex.test.ts`; lacunas em [../PARIDADE-CODEX.md](../PARIDADE-CODEX.md) | [provedores.md](provedores.md) |
| `gemini` (Gemini CLI) | Em desenvolvimento | Aparece apagado na troca de provedor | lido no código (`providers/catalogo.json`, `"disponivel": false`) | [provedores.md](provedores.md) |
| Trocar provedor, modelo e forma de pagar | Pronto | Status, botão Trocar | teste: `panel/test-provedor.mjs`, `runner/src/servidor-provedor.test.ts` | [provedores.md](provedores.md) |
| Login assistido e chave de API | Pronto | `/conectar`, aba Cofre | teste: `runner/src/login.test.ts`, `web/test/conectar-rota.test.js` | [provedores.md](provedores.md) |

### Memória e rotinas

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Memória em arquivos e leitor/editor no painel | Pronto | `aba:memory` | teste: `panel/test-memoria-editar.mjs`, `panel/test-wm-status.mjs` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Caderno do dia (`working-memory.md`) | Pronto | Remontagem às 7h | teste fora da bateria: `scripts/test_build_working_memory.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Busca em conversas antigas | Pronto | "Lembra quando eu falei de..." | teste fora da bateria: `scripts/memory_index/test_conversas_fts.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Memória semântica (busca por sentido) | Parcial | Pedir ao Admin que instale o modelo | lido no código (`scripts/install-embedding-local.sh`, `scripts/install-timers.sh`) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Raio-X do cérebro (`aba:status`, `aba:como`) | Pronto | `aba:status` | teste: `panel/test-memoria-editar.mjs` (rota `/api/cerebro`) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Reflexão da noite, batimento, vigia e pokes | Parcial (completo só no Claude) | Automático | teste parcial: `scripts/_lib/test_inject_ociosidade.py`, `scripts/test_auto_compact_assentar.py` (fora da bateria); horários lidos em `scripts/install-timers.sh` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Rotinas e agenda do agente | Pronto | "Todo dia às 9h me manda o resumo" | teste: `scripts/_lib/test_rotina_usuario.py`, `scripts/_lib/test_rotina_e_sessao_morta.py` | [memoria-e-rotinas.md](memoria-e-rotinas.md) |
| Custos e teto | Parcial (só Claude) | `aba:costs` | teste: `panel/test-teto-gastos.mjs`; limite do Codex lido em [../PARIDADE-CODEX.md](../PARIDADE-CODEX.md) | [memoria-e-rotinas.md](memoria-e-rotinas.md) |

### Segurança

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Ronda de segurança | Pronto | `/seguranca` | teste: `tests/ronda/rodar.sh`, `web/test/ronda-painel.test.js` | [seguranca.md](seguranca.md) |
| Sentinela do servidor | Pronto | `/seguranca` (cartão Saúde do servidor), `dgclaw sentinela` | teste: `tests/sentinela/rodar.sh`, `web/test/sentinela.test.js` | [seguranca.md](seguranca.md) |
| Boletins de segurança | Pronto | `/seguranca` | teste: `tests/boletins/rodar.sh`, `web/test/seguranca.test.js` | [seguranca.md](seguranca.md) |
| Botão de emergência | Pronto | `/seguranca`, `dgclaw emergencia` | teste: `tests/emergencia/rodar.sh` | [seguranca.md](seguranca.md) |
| Saúde do agente e modo de segurança | Parcial (só Claude) | Selo do agente, `aba:socorro` | teste: `scripts/_lib/test_saude_sessao.py`, `scripts/_lib/test_reinicio.py`, `scripts/_lib/test_quarentena.py`, `panel/test-saude.mjs` | [seguranca.md](seguranca.md) |
| Isolamento entre agentes e firewall | Pronto | Automático na criação | teste em raiz falsa: `tests/instalador/rodar.sh`; a prova real é no servidor, como diz [../ARQUITETURA.md](../ARQUITETURA.md) | [seguranca.md](seguranca.md) |
| Revisão adversarial das mudanças | Pronto | Processo do projeto | teste: `tests/revisao-adversarial/rodar.sh` | [seguranca.md](seguranca.md) |
| Face ID (`/cadeado`) | Em desenvolvimento | Ainda não existe | não verificado: não há tela nem rota no código desta branch | [em-desenvolvimento.md](em-desenvolvimento.md) |

### Atualização e backup

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Atualizar o DG Claw | Pronto | Admin: "atualiza o DG Claw" | teste: `tests/cli/atualizar.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Backup e restauração | Pronto | `dgclaw backup`, `dgclaw restaurar` | teste: `tests/cli/backup.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Aviso de versão nova | Pronto | Faixa no painel | teste: `tests/aviso-atualizacao/rodar.sh`, `web/test/atualizacao.test.js` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Novidades depois de atualizar | Pronto | Automático | teste: `tests/novidades/rodar.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |
| Instalação e instalação remota | Pronto | `install.sh`, `dgclaw instalacao-remota` | teste: `tests/instalador/rodar.sh`, `tests/cli/instalacao-remota.sh` | [atualizar-e-backup.md](atualizar-e-backup.md) |

### Personalização

| Recurso | Estado | Onde pedir | Como foi verificado | Página |
| --- | --- | --- | --- | --- |
| Registro de personalizações que sobrevive à atualização | Pronto | Admin: "personaliza isso" | teste: `tests/cli/personalizacoes.sh` | [personalizar.md](personalizar.md) |
| Trocar o endereço do painel por domínio próprio | Pronto | Admin: "quero meu domínio" | teste: `tests/cli/dominio.sh` | [personalizar.md](personalizar.md) |
| Troca da página do painel | Em desenvolvimento | Ainda não existe | não verificado | [em-desenvolvimento.md](em-desenvolvimento.md) |

## Índice das páginas

| Página | O que traz |
| --- | --- |
| [conversa-e-telas.md](conversa-e-telas.md) | As telas, a conversa, anexos, voz, comandos de barra, lousa, modo escondido, Anonimizar, lembretes, avisos, foco, alertas, uso da assinatura e as abas do painel |
| [agentes.md](agentes.md) | Criar e cuidar dos agentes, identidade, Mesa, quadro de avisos, Tela, sessões, modo monitor, cofre, socorro, colaboradores, skills e poderes |
| [canais.md](canais.md) | Chat do painel, Telegram, `whatsapp` e Gmail |
| [provedores.md](provedores.md) | `claude`, `codex` e `gemini`, login, chave de API, paridade e risco de bloqueio da conta |
| [memoria-e-rotinas.md](memoria-e-rotinas.md) | Memória, busca, raio-X do cérebro, rotinas da noite, pokes, lembretes, agenda e custos |
| [seguranca.md](seguranca.md) | Ronda, sentinela do servidor, boletins, emergência, saúde e isolamento |
| [atualizar-e-backup.md](atualizar-e-backup.md) | Atualização, backup, restauração e avisos de versão |
| [personalizar.md](personalizar.md) | Como mudar o DG Claw sem perder a mudança na próxima atualização |
| [o-que-nao-faz.md](o-que-nao-faz.md) | O que o DG Claw não faz, para ninguém prometer demais |
| [em-desenvolvimento.md](em-desenvolvimento.md) | O que ainda não está liberado |
| [referencia-admin.md](referencia-admin.md) | Rotas, comandos e opções, para o Admin e para quem opera por API |
| [pendencias.md](pendencias.md) | O que está divergente entre documentos e código, ou ainda sem resposta |
