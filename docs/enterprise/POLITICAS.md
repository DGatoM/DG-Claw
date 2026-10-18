# Políticas gerenciadas do Claude Code (managed settings)

Proteção `politicas_claude` (matriz: ligada e travada em escritório, empresa e regulado), mais o `deny` das travas externas
(`travas_externas`, ver `docs/enterprise/TRAVAS.md`). Código: `lib/enterprise/politicas.sh`. No nível `pessoal` nada daqui age.

## O que é

O Claude Code lê, no Linux, um arquivo de **managed settings** em `/etc/claude-code/managed-settings.json`. Ele fica acima de
todo o resto: nem `~/.claude/settings.json`, nem `.claude/settings.local.json` (que o agente edita), nem `--settings` mudam uma
chave dele. O DG Claw escreve esse arquivo **no host**, por agente, e o container o enxerga só leitura:

| Peça | Valor |
| --- | --- |
| Arquivo no host | `<casa>/politicas/managed-settings.json`, dono root do host, 644 (a pasta é 755) |
| Montagem no container | `<casa>/politicas` em `/etc/claude-code`, `:ro` (gancho `ent_args_container_politicas`) |
| Reaplicar | `dgclaw protecoes aplicar` (`ent_aplicar_politicas`): regrava, e reinicia o runner só dos agentes cujo arquivo mudou |
| Container criado antes da proteção | não tem a montagem: o `aplicar` e o `dgclaw status` avisam e dão o comando `dgclaw agente recriar <slug> --sim` (não recriamos sozinhos: derrubaria o agente e levaria o que ele instalou fora da casa) |

Fontes conferidas em 18/10/2026: `https://code.claude.com/docs/en/managed-settings` ("Linux and WSL:
`/etc/claude-code/managed-settings.json`"; o diretório `managed-settings.d/` também é lido) e
`https://code.claude.com/docs/en/authentication` (seção "Restrict login to your organization"). Releia antes de cada contrato:
a documentação muda.

## O que o arquivo leva

```json
{
  "forceLoginMethod": "claudeai",
  "forceLoginOrgUUID": "<org_uuid do protecoes.json>",
  "cleanupPeriodDays": 180,
  "permissions": { "deny": ["mcp__claude_ai_Gmail__send_message", "..."] }
}
```

| Chave | Quando entra | Por quê |
| --- | --- | --- |
| `forceLoginOrgUUID` | `politicas_claude` ligada, `org_uuid` definido e agente que entra por assinatura | o login em outra organização (a conta pessoal Pro ou Max) é recusado na partida. Define com `dgclaw nivel org <uuid>` |
| `forceLoginMethod` | `politicas_claude` ligada e agente que entra por assinatura | `"claudeai"` |
| `cleanupPeriodDays` | `politicas_claude` ligada e `retencao_dias` > 0 | o Claude Code apaga as conversas dele depois desse prazo, no mesmo número da retenção do DG Claw |
| `permissions.deny` | `travas_externas` ligada | as ferramentas de envio do Gmail (`send_message`, `reply`, `forward` e variações) e as que alteram a caixa. Tirar o envio por um tempo é a liberação temporária (`dgclaw travas liberar`) |

Sem `org_uuid` o arquivo não leva `forceLoginOrgUUID`, o `dgclaw status` e o `dgclaw protecoes aplicar` avisam que **o login
pessoal não está bloqueado**.

### Agente de setor (chave de API) não leva `forceLogin*`

A documentação oficial diz que, com `forceLoginOrgUUID` ou com `forceLoginMethod` definido, o Claude Code **bloqueia
`ANTHROPIC_API_KEY` na partida** (a chave de ambiente não tem como provar a organização). Como o agente de setor usa justamente a
chave de API da empresa, o arquivo dele não leva nenhuma das duas chaves (`uso: setor` no `agentes.json`, ou forma de pagar `api`
no `runner.json`). Ele ainda leva `cleanupPeriodDays` e o `deny` do Gmail. O trecho do plano que previa `forceLoginMethod:
"console"` para chave de API não funciona por isso. A organização do agente de setor é a da própria chave.

### O que não fazemos

Não desligamos nenhum método de login do binário (armadilha 8 do DESENHO; os termos da Anthropic proíbem remover, desligar ou
restringir método de autenticação do Claude Code). Fixar a organização é o recurso oficial.

## Codex

Conferido em 18/10/2026 em `https://learn.chatgpt.com/docs/enterprise/managed-configuration`: no Linux o Codex lê
`/etc/codex/requirements.toml` (e `/etc/codex/managed_config.toml`). Para agente Codex o DG Claw escreve
`<casa>/politicas-codex/requirements.toml` com `allowed_login_methods = ["chatgpt"]` (assinatura) ou `["api"]` (setor), montado só
leitura em `/etc/codex`. **Limitações**: o Codex não tem `forceLoginOrgUUID` equivalente na nossa configuração (o
`allowed_chatgpt_workspaces` pede um id de workspace do ChatGPT que o `protecoes.json` não guarda); não tem conector do Gmail do
claude.ai, então a trava do e-mail não se aplica; e a chave de retenção do Claude Code não existe lá (a retenção do DG Claw cobre os
transcripts do Codex pelo `retencao_dias`). O arquivo é gerado com a documentação acima; a leitura pelo binário do Codex da imagem
fica na lista de teste manual.

## Teste

`tests/enterprise/politicas.test.sh` (arquivo por nível, uso e forma de pagar; montagem só leitura; `deny` igual ao do
`gmail-permissao.sh`; reinício só de quem mudou; container sem a montagem; Codex; baixar o nível apaga o arquivo) e
`tests/enterprise/travas.test.sh`.

Manual (precisa do Claude Code de verdade): rodar `/status` dentro do agente e conferir que a fonte das configurações cita as
managed settings, tentar `claude auth login` com uma conta de outra organização (deve recusar) e confirmar que a chave de API
de um agente de setor continua funcionando.
