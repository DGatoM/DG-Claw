# DG Claw Enterprise: desenho técnico

Este documento é o contrato de construção da versão enterprise. Quem escreve código nesta branch
lê ele inteiro antes. A justificativa de cada escolha está em
`/root/claude/projetos/dgclaw-oficial-auditoria/relatorio-plano-enterprise.md` (fora do repositório) e
resumida em `docs/ENTERPRISE-MERGE.md`.

## 1. Regra de ouro: quem já usa o DG Claw não percebe nada

- Sem o arquivo `/etc/dgclaw/protecoes.json`, o nível é **`pessoal`** e o comportamento é idêntico ao
  do `main`. Todo recurso enterprise consulta o nível antes de agir.
- Código novo mora em arquivo novo sempre que possível. Nos arquivos que já existem entra só um
  **gancho** pequeno, que não faz nada no nível `pessoal`. Isso deixa o rebase em `main` barato.
- Os testes que já existem continuam passando sem mudança. Cada recurso novo traz testes próprios,
  inclusive um que prova que no nível `pessoal` nada muda.

## 2. Níveis e matriz

Níveis: `pessoal` (padrão silencioso, o DG Claw de hoje), `escritorio`, `empresa`, `regulado`.

A matriz fica em **`config/protecoes-matriz.json`**, fonte única lida pelo bash (`jq`) e pelo Node.
Cada chave tem o valor por nível e diz se o valor é travado (não desliga naquele nível):

```json
{
  "versao": 1,
  "chaves": {
    "2fa": {
      "descricao": "Segundo fator (TOTP) no login",
      "porque": "Fecha o maior buraco: senha vazada",
      "valores": ["nao", "ti", "todos"],
      "nivel": {"pessoal": "nao", "escritorio": "ti", "empresa": "todos", "regulado": "todos"},
      "travado": {"escritorio": true, "empresa": true, "regulado": true}
    }
  }
}
```

`travado` quer dizer: dá para subir o valor (por exemplo `ti` para `todos`), mas não descer abaixo do
padrão do nível. Para chaves booleanas, travado quer dizer "não desliga".

O arquivo da instalação, `/etc/dgclaw/protecoes.json` (600, root):

```json
{"versao": 1, "nivel": "escritorio", "ajustes": {"2fa": "todos"}, "org_uuid": "", "atualizado_em": "..."}
```

Valor efetivo = ajuste (se permitido pela trava) senão padrão do nível. Leitores:
`lib/protecoes.sh` (`protecao_nivel`, `protecao_valor <chave>`, `protecao_ligada <chave>`) e
`web/lib/protecoes.js` (`criarProtecoes({ caminho })` com `nivel()`, `valor(chave)`, `ligada(chave)`,
`resumo()` para a tela). Ajuste inválido ou abaixo da trava é ignorado com aviso no log que diz qual
chave, qual valor e por quê.

### Campos da matriz além dos do exemplo

Acrescentados na construção da fundação, lidos igual por `lib/protecoes.sh` e `web/lib/protecoes.js`:

- `tipo`: `bool`, `enum` ou `numero`. Em `enum`, `valores` vem do mais fraco para o mais forte.
- `forte` (bool): qual valor protege. Padrão `true`; é `false` em `admin_llm` e `sigilo_externo`. A trava
  de uma chave bool impede trocar o valor pelo oposto de `forte`.
- `min` (número): menor valor aceito (`retencao_dias` aceita 0, que quer dizer "sem prazo").
- `parametro` (número): `sessao_horas` e `backup_retencao_dias` são ajustes, não liga/desliga. A tela mostra
  "parâmetro" e não os conta entre as proteções ligadas. `desligado_em`: valor numérico que equivale a
  desligado (`retencao_dias`: 0).
- `descricao`, `como`, `porque`: os textos da tela Proteções, em português simples.

O resumo do Web (`resumo()`) devolve, por chave, `valor`, `padrao`, `ajustado`, `travado`, `ligada` (regra
literal: bool true, enum fora de nao/livre/runc, número maior que zero) e `protegendo` (se a chave está
protegendo de fato: true, false, ou null para parâmetro). A tela usa `protegendo`.

### Chaves

| Chave | Valores | pessoal | escritorio | empresa | regulado |
| --- | --- | --- | --- | --- | --- |
| `multiusuario` | bool | false | true (T) | true (T) | true (T) |
| `2fa` | nao, ti, todos | nao | ti (T) | todos (T) | todos (T) |
| `sessao_horas` | número | 720 | 168 | 72 | 12 |
| `auditoria` | nao, basica, completa, externa | nao | basica (T) | completa (T) | externa (T) |
| `admin_isolado` | bool | false | true (T) | true (T) | true (T) |
| `admin_llm` | bool | true | true | true | true (desliga) |
| `container_endurecido` | bool | false | true (T) | true (T) | true (T) |
| `runtime` | runc, gvisor | runc | runc | runc | gvisor |
| `cofre_cifrado` | bool | false | true (T) | true (T) | true (T) |
| `disco_cifrado` | nao, auto, externo | nao | auto (T) | auto (T) | externo (T) |
| `backup` | bool | false | true (T) | true (T) | true (T) |
| `backup_retencao_dias` | número | 30 | 30 | 30 | 14 |
| `travas_externas` | bool | false | true (T) | true (T) | true (T) |
| `https_endurecido` | bool | false | true (T) | true (T) | true (T) |
| `retencao_dias` | número, 0 = sem prazo | 0 | 180 | 90 | 30 |
| `monitoramento` | bool | false | true (T) | true (T) | true (T) |
| `politicas_claude` | bool | false | true (T) | true (T) | true (T) |
| `credencial_empresa` | bool (sem modo `token`; setor usa `api`) | false | true (T) | true (T) | true (T) |
| `sigilo_externo` | bool (modo escondido pode mandar texto para fora) | true | false | false | false (T) |
| `sso` | nao, opcional, padrao, obrigatorio | nao | opcional | padrao | obrigatorio (T) |
| `saida` | livre, registro, bloqueio | livre | registro | registro | bloqueio (T) |
| `kit_sensivel` | bool | false | false | true | true (T) |

(T) = travado naquele nível.

## 3. Pontos de extensão (os únicos lugares onde arquivo antigo muda)

### CLI (`bin/dgclaw`)

- Depois dos `source` de `lib/comum.sh` e `lib/agentes.sh`, carrega `lib/protecoes.sh` e todo
  `lib/enterprise/*.sh` (ordem alfabética).
- No `case` do `main`, comandos desconhecidos passam por `ent_despachar "$cmd" "$@"`, que procura uma
  função `ent_cmd_<cmd>` (traço vira sublinhado). Se não existir, a mensagem de erro de hoje continua.
- `criar_container` chama `ent_args_container` (array `args` por nome) antes do `podman create`. No
  nível `pessoal` a função não acrescenta nada.
- `agente_criar` chama `ent_depois_de_criar "$C_SLUG"` no fim. `status_geral` chama `ent_status`.
- Toda ação administrativa chama `auditar <evento> <json>` (de `lib/enterprise/auditoria.sh`), que no
  nível `pessoal` não grava nada.

### Instalador (`install.sh`)

- Opção `--nivel <pessoal|escritorio|empresa|regulado>`. Sem ela, a instalação nova continua sem
  `protecoes.json` (= `pessoal`) e a reinstalação preserva o arquivo que já existe.
- Uma etapa `ent_instalar` no fim do `main`, que roda as funções `ent_instalar_*` definidas em
  `lib/enterprise/instalar-*.sh`. No nível `pessoal` nenhuma roda.
- `ENSAIO=1` e `DGCLAW_RAIZ` continuam valendo em tudo o que for novo.

### Web (`web/server.js`)

- `const ent = criarEnterprise({ config, registro, auth, log, ... })` de `web/lib/ent/index.js`.
- `ent.antes(req, res, url, sessao)` roda antes do roteamento da API e das páginas. Devolve `true`
  quando já respondeu (rota enterprise ou recusa por papel).
- `ent.podeVerAgente(sessao, slug)` é a única regra de acesso a agente. Todo lugar do server que
  recebe um slug (chat `/a/`, painel `/p/`, API de agente, mesa, lembretes, avisos, mídia, stream)
  passa por ela. No nível `pessoal` ela devolve sempre `true`.
- Cada bloco registra as próprias rotas num arquivo `web/lib/ent/<bloco>.js`.

## 4. Convenções da branch

- As do `CLAUDE.md`: português do Brasil, bash com `set -euo pipefail`, `shellcheck` limpo, erro que
  diz o que falhou, com que entrada e o que fazer; sem `|| true` mudo e sem `catch {}` vazio; segredo
  fora de argv e de log; arquivo de segredo com 600.
- Texto para pessoas sem travessão no meio da frase.
- Testes: bash em `tests/enterprise/*.sh` (raiz falsa com `DGCLAW_RAIZ`, stubs como em `tests/cli`),
  Node em `web/test/ent-*.test.js`. `tests/rodar.sh` ganha a parte `enterprise`.
- Commits pequenos, por tema, com os arquivos nomeados um a um.
- Nada é executado na máquina de verdade: nada de `podman`, `cryptsetup`, `systemctl` reais nos
  testes. Tudo com stub.

## 5. Armadilhas conhecidas (da auditoria)

1. O painel escuta em `0.0.0.0` dentro do container de propósito (`bin/dgclaw`, `gerar_painel_env`):
   é o que faz o `--publish 127.0.0.1` funcionar. Não mudar.
2. Tirar o `sudo NOPASSWD:ALL` quebra skills e rotinas que usam `sudo`. As rotinas sobem com
   `User=root` e são reescritas para `User=agente` por `sed` em `bin/dgclaw` (`vida_script`). O
   endurecimento precisa manter isso funcionando e listar o que ficou sem sudo.
3. `--cap-drop` mexe com o systemd como PID 1 (`--systemd always`). O CI não sobe podman: o que
   depende de máquina real vai para a lista de testes manuais em `docs/ENTERPRISE-MERGE.md`.
4. A cerca de rede reinsere regras na tabela mangle por causa do netavark (`lib/firewall.sh`). Proxy
   de saída e cerca IPv6 preservam essa ordem, e a regra que barra o host libera o caminho do agente
   até o proxy.
5. Atualizar já apagou chaves do `web.env` (commit `f527ba3`). `dgclaw atualizar` e o rollback
   preservam `/etc/dgclaw`, `web.env`, os cofres e as unidades com segredo.
6. O chat lê o histórico direto dos transcripts (`web/lib/conversa.js`). Apagar transcript apaga a
   conversa da tela. O `conversas.db` (`scripts/memory_index/conversas_fts.py`) copia tudo sem prazo.
7. Serviço root que lê pasta controlada por LLM usa o padrão da caixa (`web/lib/caixa-agente.js`:
   `lstat`, `O_NOFOLLOW`, `grava-seguro`). Tela de confirmação mostra ação estruturada gerada pelo
   serviço, nunca texto do Admin.
8. Termos da Anthropic: proibido "remove, disable, or restrict any authentication method built into"
   o Claude Code. Bloquear o modo `token` é limpar variável do nosso lado e não oferecer a opção no
   painel. Fixar a organização é `forceLoginOrgUUID` (recurso oficial) em managed settings.
9. `panel/lib/cofre.js` já tem `systemd-creds` pronto: reaproveitar a lógica no cofre da v1.
10. `scripts/uninstall.sh` é da arquitetura antiga.
11. O nome `trilha` já existe no Web (`web/lib/trilha.js`, comandos na conversa). A trilha de
    auditoria se chama **`auditoria`** em todo o código.
