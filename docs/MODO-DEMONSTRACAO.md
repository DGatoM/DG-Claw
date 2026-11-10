# Modo demonstração do DG Claw

Um agente para usar ao vivo em reuniões de venda, em painel próprio, sem nenhuma outra conversa na tela.
Este documento é o contrato das peças; `Como operar` está no fim.

## Princípios

1. **Painel separado por pessoa.** Cada demonstração é um segundo processo do `web/server.js`, com porta,
   `web.env`, pasta de dados e registro próprios. O registro só contém aquele agente, então o Admin e os
   outros agentes não existem para esse painel. O login continua sendo o de um usuário só.
2. **Chave fica fora do container.** O agente não recebe nenhuma credencial de WhatsApp, Organizap ou e-mail.
   Ele fala apenas com o Portão (rotas abaixo), usando um token que só abre o Portão.
3. **O bloqueio fica na ferramenta.** Envio e leitura de conversa só acontecem depois de um clique humano no
   painel. A rota de decisão exige o cookie de sessão e a checagem de origem, que o agente não tem. O prompt
   apenas explica o fluxo; a segurança não depende dele.
4. **`null` nunca vira verde.** Conexão não medida aparece como "não medida", nunca como conectada.

## Ativação

`DGCLAW_DEMO_CONFIG=/etc/dgclaw/demo/<instancia>/demo.json` no ambiente do processo. Sem essa variável, nada
deste modo existe: as rotas respondem 404 e o menu não muda. O arquivo é 600, do root:

```json
{
  "versao": 1,
  "instancia": "nova",
  "agente": "nova",
  "url_publica": "https://nova.dgmedeiros.com.br",
  "token_agente_sha256": "<sha256 hex do token do agente>",
  "linhas_whatsapp": [
    { "id": "danilo", "rotulo": "WhatsApp do Danilo", "tipo": "organizap", "base": "https://.../api/assistant", "chave_arquivo": "/etc/dgclaw/demo/nova/organizap.key" },
    { "id": "isa", "rotulo": "WhatsApp da Isa", "tipo": "cpdf", "base": "https://...", "chave_arquivo": "/etc/dgclaw/demo/nova/cpdf.key" }
  ],
  "email": { "tipo": "organizap", "base": "https://.../api/assistant", "chave_arquivo": "/etc/dgclaw/demo/nova/organizap.key", "rotulo": "E-mail" },
  "crm": { "url_saude": "http://127.0.0.1:4380/api/v1/saude", "url_publica": "https://crm-demo.dgmedeiros.com.br", "rotulo": "CRM" },
  "imagem": { "chave_arquivo": "/etc/dgclaw/demo/nova/openai.key", "rotulo": "Geração de imagens" },
  "destinos_de_teste": ["+55..."]
}
```

- `destinos_de_teste`: se existir e não for vazio, qualquer envio para fora dessa lista é recusado com
  `DESTINO_FORA_DO_TESTE`, mesmo com clique. É a trava usada durante os testes.
- Campo obrigatório ausente, arquivo de chave faltando ou permissão aberta demais: o processo registra o motivo,
  o modo fica desligado e a tela explica. Nunca sobe "meio ligado".

## Rotas do Portão (agente, `Authorization: Bearer <token>`)

Toda resposta é `{ "ok": true, ... }` ou `{ "ok": false, "codigo": "...", "erro": "<motivo em português e o que fazer>" }`.
Token comparado por sha256 em tempo constante. Limite: 60 pedidos por minuto (429).

| Método e rota | Corpo | O que faz |
| --- | --- | --- |
| `POST /api/demo/v1/contato` | `{linha, nome}` | Pede para abrir a conversa de um contato. `nome` com 3 caracteres ou mais. Cria um cartão de leitura. Devolve `{id, estado:"aguardando"}`. **Nunca devolve candidatos ao agente.** |
| `GET /api/demo/v1/contato/:id` | | `{estado}`; depois do clique, `{estado:"liberado", contato:{nome, telefone_mascarado, ref}}`. |
| `GET /api/demo/v1/contato/:ref/conversa?limite=60` | | Histórico da conversa liberada, as mensagens mais recentes em ordem. Só com `ref` liberada e dentro de 30 minutos. |
| `POST /api/demo/v1/envio` | `{canal:"whatsapp", linha, ref ou telefone, texto, anexos?:[...]}` ou `{canal:"email", para, assunto, texto, anexos?}` | Cria o cartão de confirmação. Devolve `{id, estado:"aguardando"}`. |
| `GET /api/demo/v1/envio/:id` | | `{estado: aguardando\|enviando\|enviado\|recusado\|expirado\|falhou, motivo?}` |

- Não existe rota de listar conversas ou contatos para o agente.
- Em uma linha `organizap`, `telefone` só é aceito se a conversa já existir; sem conversa, `SEM_CONVERSA_ABERTA`
  diz que esse WhatsApp só fala com quem já tem conversa e sugere outra linha. Em linha `cpdf`, `telefone` é aceito.
- `anexos` são caminhos dentro de `/home/agente/arquivos` ou `/home/agente/saida`. Caminho é traduzido para a casa
  no servidor, recusa atalho, componente com ponto e hardlink, e o arquivo é aberto com `O_NOFOLLOW` no envio. No máximo
  5 arquivos e 20 MB. O sha256 de cada anexo é calculado ao criar o cartão e conferido no envio: mudou, `ANEXO_MUDOU`.
- Texto até 4.000 caracteres (e-mail até 20.000). Cartão vale 10 minutos, depois `expirado`.
- Quando o provedor recusa (4xx/5xx), o agente recebe só o código (`PROVEDOR_RECUSOU`) e uma mensagem nossa com o status
  HTTP. A mensagem bruta do provedor, sem a chave e sem nada com cara de credencial, vai só para o log do painel e para a
  tela do dono.
- Um pedido que estava esperando o provedor quando um reset começou ou terminou é descartado com `RESET_EM_ANDAMENTO`:
  nenhum cartão do cliente anterior é recriado. A geração do reset é anotada antes de ler o corpo do pedido e conferida
  de novo depois dele, então um corpo entregue devagar durante um reset também é descartado.
- Cada cartão aceita uma decisão por vez: se duas chegam juntas, a segunda espera a primeira e então lê o estado já
  gravado (responde `CARTAO_JA_DECIDIDO`). Antes de liberar um contato, o cartão é relido, para uma recusa ou uma
  expiração ocorrida durante a busca dos candidatos nunca ser sobrescrita.

## Rotas da tela (cookie de sessão + origem, como as demais)

| Método e rota | O que faz |
| --- | --- |
| `GET /api/demo/cartoes` | Cartões abertos, com destinatário, número completo, canal, linha, texto e anexos. Nos de leitura, os candidatos (no máximo 5, nome e telefone mascarado), buscados no provedor com o nome pedido. |
| `POST /api/demo/cartoes/:id/decisao` | `{decisao:"confirmar"\|"recusar", candidato?}`. Confirmação é de uso único e o envio usa exatamente o conteúdo guardado no cartão. |
| `GET /api/demo/sistemas` | Status real de cada sistema (abaixo). |
| `POST /api/demo/reset` | `{confirmacao:"NOVO CLIENTE"}`. Executa o reset. |
| `GET /api/demo/reset/estado` | Andamento do reset. |

Toda decisão e todo envio vão para `<dataDir>/demo/auditoria.jsonl` (600): quando, quem, canal, destinatário, id e
sha256 do texto, sem o corpo e sem o número completo além dos quatro últimos dígitos. O corpo fica só no cartão, em
`<dataDir>/demo/cartoes/` (600), e o cartão sai junto no reset.

## Reset

Executado por `bin/dgclaw-demo-reset <slug> [--dados <dataDir>] [--semente <pasta>] [--arquivo <pasta>] [--so-politica]`, chamado pelo Web.

Ordem: trava (`flock`), para o container, move para `/var/lib/dgclaw/demo-arquivo/<slug>/<AAAAmmdd-HHMMSS>/`,
recoloca a semente, sobe o container, instala o bloqueio dos conectores do claude.ai (abaixo), espera o runner, confere e registra o resultado.

- **Move (nunca apaga):** `.claude/projects`, `.claude/todos`, `.claude/shell-snapshots`, `.claude/file-history`,
  `.claude/history.jsonl`, `memory/`, `MEMORY.md`, `working-memory.md`, `arquivos/`, `saida/`, `uploads/`, `crm/`, `data/`,
  `planning/`, os históricos de sessão do Claude Code (`.claude/session-env`, `plans`, `tasks`, `debug`) e do Codex
  (`sessions`, `archived_sessions`, `history.jsonl`, `log`, `shell_snapshots`, `memories` e os bancos `state_*`/`logs_*`
  de `.codex/` e de cada `.plataforma/codex-api/<id>/`, preservando `auth.json`), o índice local de memória, `.cache/`, o estado de sessão do runner, e no Web
  `<dataDir>/demo/cartoes`, `<dataDir>/mesa`, `<dataDir>/lembretes`, `<dataDir>/alertas`.
- **Não toca:** `AGENT.md`, `CLAUDE.md`, identidade, skills, login (`.claude/.credentials.json`) e cofre.
- **Arquivo** fica em pasta 700 do root, fora de `/var/lib/dgclaw/agentes/`, portanto fora do alcance do container.
- **Semente:** `/var/lib/dgclaw/demo-semente/<slug>/` (sem atalhos) é copiada para uma pasta nova dentro da casa e cada
  item é movido para o lugar dele; o reset nunca escreve através de um caminho que já existia na casa. O que ocupava o
  lugar (inclusive um atalho plantado) vai antes para `casa-substituido/` no arquivo. Cada pasta de topo da semente
  (`dados/`, `plano-b/`...) substitui a pasta inteira; só `.claude`, `.codex` e `.plataforma` são fundidos item a item,
  porque guardam login, skills e identidade.
- **Conferência:** o script só devolve sucesso se a casa não tiver transcript, rollout do Codex, histórico nem memória antiga,
  se cada pasta de topo da semente for exatamente a da semente, o runner responder
  e o arquivo conter o que saiu. Falha em qualquer etapa: sai diferente de 0, escreve o motivo e o painel mostra.
- O Web também zera a própria leitura da conversa em memória, para nada do cliente anterior continuar na tela.

## Página Sistemas conectados

O `demo.json` passa pela mesma validação do Portão (dono, permissão, versão, chaves). Se ela falha, nenhuma consulta externa
é feita e `GET /api/demo/sistemas` responde 503 com o motivo, que a tela mostra.

`/sistemas`, dentro do grupo do menu que reúne Mesa e Segurança, só no modo demonstração. Foto do agente no centro,
uma linha até cada sistema. Pulso de luz indo e voltando **somente** em conexão confirmada. Caída fica vermelha e parada,
com o motivo; não medida fica cinza e parada. Respeita `prefers-reduced-motion`. No celular vira lista.

Checagens no servidor, com cache de 20 segundos e prazo de 6 segundos cada:

| Sistema | Como mede | Conectado quando |
| --- | --- | --- |
| Agente | runner `GET /api/agents/<id>` | sessão viva |
| WhatsApp (por linha) | a rota de status/instância real do provedor | instância conectada e apta a enviar |
| E-mail | a rota real da conta de e-mail do provedor | conta conectada |
| CRM | `GET crm.url_saude` | 200 com `ok:true` |
| Geração de imagens | `GET https://api.openai.com/v1/models` com a chave | 200; 401 é caída; 403 é "não medida", com o motivo |

## O agente

A skill `demonstracao` (`templates/ambiente/skills/demonstracao/`) ensina o fluxo e traz `demo.sh`, que encapsula os
curls. As regras que entram na identidade: nunca listar conversas; sempre passar pelo Portão; depois de pedir o cartão,
dizer "confirme na tela" e esperar o estado.

### Bloqueio dos conectores do claude.ai

Com login de assinatura, o Claude Code oferece ao agente os conectores da conta (Gmail, Agenda, Drive, Docs, Figma,
Meta). Se ficassem abertos, o e-mail sairia sem passar pelo Portão. O bloqueio é um `managed-settings.json` (a camada de
configuração que o agente não consegue sobrescrever) instalado **dentro do container**, em
`/etc/claude-code/managed-settings.json`, dono `root:root`, modo 644. O modelo está em
`templates/demo/managed-settings.json` e o conteúdo exato é:

```json
{"env":{"ENABLE_CLAUDEAI_MCP_SERVERS":"false"},"permissions":{"deny":["mcp__claude_ai_Gmail","mcp__claude_ai_Google_Calendar","mcp__claude_ai_Google_Drive","mcp__claude_ai_Claude_Docs","mcp__claude_ai_Figma","mcp__claude_ai_Meta_MCP"]}}
```

O que realmente acontece:

- O `dgclaw-demo-reset` lê o nome do container no campo `container` do `agentes.json` e confere, antes de mexer em
  qualquer coisa, que o modelo tem o sha256 esperado (um modelo editado por engano é recusado).
- Depois de ligar o agente, instala o arquivo com `podman exec -i -u 0 <container>`, mandando o conteúdo por STDIN. Não
  usa `podman cp` porque ele quebra com "value too large for defined data type" quando o mapa de uid é alto.
- A conferência final reprova o reset se o arquivo não estiver no container com o mesmo sha256 do modelo e com dono
  `root:root` e modo 644. A mensagem diz o que faltou e o comando para corrigir.
- `sudo dgclaw-demo-reset <slug> --so-politica` só instala e confere o bloqueio, sem parar o agente nem mover nada.
  Use depois de recriar o container (por exemplo, `dgclaw agente atualizar`), porque o arquivo vive no container.
- O runner do Codex só leva ao agente os servidores MCP listados no `mcpConfig` dele (`runner/src/provedores/mcp-codex.ts`)
  e não liga conectores da conta, então não existe equivalente a bloquear nesse motor.

## Como operar

```bash
sudo dgclaw-demo-reset nova           # o mesmo que o botão Reset
systemctl status dgclaw-demo@nova     # painel da demonstração
```
