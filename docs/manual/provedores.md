# Provedores

Provedor é o motor de IA por trás de um agente. O DG Claw usa dois programas oficiais, sem modificação: o `claude` (Claude Code, da Anthropic) e o `codex` (Codex CLI, da OpenAI). Cada agente escolhe um dos dois e uma forma de pagar. O arquivo `providers/catalogo.json` é a lista única que o painel, os scripts e o Admin leem.

| Provedor | Estado | O que é |
| --- | --- | --- |
| `claude` | Pronto | Claude Code. Modelos Claude Opus 5.5, Claude Sonnet 5.5 e Claude Haiku 5.5 (apelidos `opus`, `sonnet` e `haiku`). O padrão é o Opus |
| `codex` | Parcial | Codex CLI. Os modelos vêm da lista do próprio Codex, que muda toda semana. Faltam alguns recursos que o Claude tem (veja a tabela abaixo) |
| `gemini` | Em desenvolvimento | Gemini CLI. Está no catálogo, mas marcado como indisponível, e a janela de troca o mostra apagado com o motivo. Veja [em-desenvolvimento.md](em-desenvolvimento.md) |

Não confunda o provedor `gemini` com a skill `gemini-gratuito`: a skill só conecta uma chave gratuita do Google AI Studio para o agente analisar vídeos, e funciona com qualquer motor.

## Escolher e trocar o motor e a forma de pagar

**O que é.** Cada agente tem uma escolha de provedor, modelo e forma de pagar, mostrada no cartão "Modelo e autenticação" no topo da aba `aba:status` do painel (por exemplo, "Claude Opus 5.5, na assinatura").
**Como pedir.** Na criação, o Admin usa `--provedor` e `--auth`. Depois, o dono toca em **Trocar** no cartão e escolhe provedor, modelo e forma de pagar, ou pede ao Admin. Trocar fecha a conversa atual e o agente volta numa conversa nova, com a memória intacta.
**Formas de pagar.**

| Forma | Vale para | Como funciona |
| --- | --- | --- |
| Na assinatura | `claude` (plano Pro ou Max) e `codex` (ChatGPT Plus, Pro e similares) | Valor fixo por mês, dentro do limite do plano. O agente entra com a conta uma vez, pelo login assistido |
| Na assinatura, sem conectores | Só `claude` | Mesmo plano, por um código de acesso de longa duração (`CLAUDE_CODE_OAUTH_TOKEN`, gerado com `claude setup-token`). Serve para agentes sem Gmail, Agenda ou Drive |
| Na API | `claude` (`ANTHROPIC_API_KEY`) e `codex` (`OPENAI_API_KEY`) | Paga só pelo que usar, em tokens, direto na conta de desenvolvedor. A chave fica no cofre do agente |

**Login.** O login assistido está em `/conectar` e no cartão "entrar na conta" da conversa (veja [conversa-e-telas.md](conversa-e-telas.md)): o dono toca em **Gerar link de login**, entra com a conta e, no Claude, cola de volta o código que a página mostra; no Codex digita um código no navegador. O DG Claw nunca lê, copia nem guarda o arquivo de login de um agente para outro.
**Chave de API.** Ao trocar para a API, a janela pede a chave se o cofre não a tem. O painel confere a forma (a da Anthropic começa com `sk-ant-` e a da OpenAI com `sk-`), guarda no cofre e reinicia o agente. A chave não vai para o log nem volta em nenhuma resposta.
**Precisa de.** Uma conta no provedor escolhido. Cada pessoa usa a própria conta.
**Limites.** O cartão fica amarelo quando o que foi escolhido e o que o programa confirma não batem (por exemplo, "configurado na API, mas a chave não está no Cofre" ou "o agente não está logado na assinatura"), e o texto diz o que fazer.
**Se der erro.** Siga o texto do cartão. Se o agente ficou sem sinal, o Admin roda `dgclaw agente reparar <slug>`. Mais em [../../panel/docs/PROVEDOR-NA-TELA.md](../../panel/docs/PROVEDOR-NA-TELA.md), [../PROVEDORES.md](../PROVEDORES.md) e [../../web/docs/CONECTAR-CONTA.md](../../web/docs/CONECTAR-CONTA.md).

## O que muda entre Claude e Codex

O objetivo do projeto é que o agente no Codex tenha tudo o que o agente no Claude tem, exceto o que é produto exclusivo da Anthropic. O registro oficial disso, atualizado a cada mudança, é [../PARIDADE-CODEX.md](../PARIDADE-CODEX.md). Resumo do levantamento de 06/11/2026, que vale como referência e não foi refeito por mim:

| Recurso | No Claude | No Codex |
| --- | --- | --- |
| Conversa, anexos, visuais, voz, Mesa, lembretes, cofre, cards, modo monitor, ronda de segurança | Funciona | Funciona |
| WhatsApp | Funciona | Funciona (sem teste ao vivo) |
| Telegram | Funciona | Não existe: é exclusivo do Claude |
| Gmail, Agenda e Drive (conectores) | Funciona na assinatura | Não existe: é exclusivo do Claude |
| Pedido de permissão e pergunta de escolha na conversa | Funciona | Não funciona: o runner responde que o provedor não expõe isso, e o caminho é o terminal do agente |
| Aviso de compactação na conversa | Funciona | Não funciona |
| Busca de memória a cada mensagem, contexto de início, compactação automática, saúde e modo seguro | Funciona | Não funciona ainda |
| Custos por mensagem (aba `aba:costs`) | Funciona | Não funciona |
| Rotinas sem terminal (reflexão, posts e comentários do Instagram) | Funciona | Não funciona |
| Subagentes, busca na web, quadro de avisos, skills do DG Claw | Funciona | Parcial |
| Comandos `/dgclaw:*` | Funciona | Não existe: namespace do plugin do Claude |
| Medidor de uso da assinatura | Funciona | Funciona |

Na prática, o agente em Codex serve para conversar, trabalhar, usar a Mesa e os cards, e receber por WhatsApp. Quem precisa de Telegram, de Gmail ou de pedidos de permissão na conversa deve usar o Claude.

## Risco de bloqueio da conta

A análise completa, com as regras da Anthropic e da OpenAI citadas, está em [../RISCO-DE-BLOQUEIO-DE-CONTA.md](../RISCO-DE-BLOQUEIO-DE-CONTA.md). A conclusão da pesquisa de 12/10/2026, que precisa ser relida quando os termos mudarem:

- Rodar o programa oficial, sem modificação, logado na conta de quem usa, na própria VPS, não é proibido por regra escrita das duas empresas. Não achamos relato confiável de bloqueio por isso.
- O risco que sobra é de volume: muitas sessões ao mesmo tempo, 24 horas por dia, batem no limite do plano mais cedo e se afastam do uso comum e individual que os limites pressupõem. Para trabalho contínuo e pesado, a recomendação é a chave de API.
- Um agente que atende outra pessoa deve usar a credencial dessa pessoa (a assinatura dela ou uma chave de API dela). Atender cliente na sua assinatura é a situação proibida da tabela do documento. Teste com cliente só tem sentido por prazo curto, com data para acabar.
- O que bloqueou contas em 2026 foi tirar o login da assinatura de dentro do Claude Code para usar em outro programa. O DG Claw não faz isso.
- O WhatsApp tem um risco à parte, o do número banido (veja [canais.md](canais.md)).

## Uso da assinatura

O percentual gasto da janela de 5 horas e da janela semanal aparece no Status do painel e em ☰, item Uso das assinaturas. Está explicado em [conversa-e-telas.md](conversa-e-telas.md).
