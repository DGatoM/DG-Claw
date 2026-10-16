# Gmail no agente

Como o agente passa a ler o Gmail do dono, o que ele pode e o que não pode fazer, e como o dono
libera mais poder quando quiser.

## O caminho curto (o que o dono faz)

1. **Entrar na assinatura pelo painel.** Na tela do agente, em Provedor, escolha Claude com a
   assinatura e use o login assistido: a tela mostra um link, você entra com a sua conta do
   claude.ai e cola de volta o código que a página mostra no fim.
2. **Ligar o Gmail no claude.ai.** No navegador, com a mesma conta, abra
   `https://claude.ai/customize/connectors`, ligue o **Gmail** e autorize a conta Google que o
   agente deve ler. Isso se faz uma vez só, e pela web: o Claude Code não liga conector novo.
3. **Reiniciar o agente**, se ele já estava rodando quando você ligou o Gmail, para a sessão dele
   carregar o conector. No servidor: `dgclaw agente reiniciar <slug>`.
4. **Testar:** peça ao agente "resume os meus últimos 5 e-mails". Se vierem e-mails de verdade,
   está funcionando.

Agenda e Drive seguem o mesmo caminho: ligou no claude.ai, aparece no agente.

## Por que tem de ser o login da assinatura

Os conectores (Gmail, Agenda, Drive) ficam guardados na conta do claude.ai. O Claude Code só os
carrega quando a sessão está logada na assinatura (o login assistido do painel, ou `/login`).
Com o token do `claude setup-token`, com chave de API (`ANTHROPIC_API_KEY`) ou com `--bare`, o
agente funciona, mas sem nenhum conector. Fonte: code.claude.com/docs/en/authentication e
code.claude.com/docs/en/mcp.

Conferido em 12/10/2026: com login de assinatura, tanto a sessão interativa quanto o `claude -p`
trazem o Gmail conectado, com as 30 ferramentas dele.

Cada agente usa a conta de quem é dono dele. Um agente de cliente logado na conta de outra pessoa
lê o Gmail dessa outra pessoa, e isso também fere os termos da assinatura (ver
`docs/RISCO-DE-BLOQUEIO-DE-CONTA.md`).

## O Gmail nasce só lendo

Quando o agente é criado, o instalador grava a trava `leitura`. Com ela o agente:

| Pode | Não pode |
| --- | --- |
| buscar e ler e-mails e conversas | enviar, responder, encaminhar |
| listar marcadores e rascunhos | apagar, mandar para a lixeira, marcar como spam |
| escrever e editar rascunhos (ficam na caixa do dono, nada sai sem ele apertar enviar) | criar, mudar ou tirar marcadores |

A trava é uma lista de regras `permissions.deny` no `.claude/settings.local.json` da pasta de
trabalho do agente. Regra de deny vale mesmo no modo sem perguntas, e a ferramenta bloqueada
some do agente: ele nem chega a vê-la. Conferido em 12/10/2026: com a trava `leitura`, das 30
ferramentas do Gmail o agente recebe só 8 (buscar, ler mensagem, ler conversa, listar marcadores,
listar rascunhos, ler rascunho, criar rascunho e editar rascunho).

## Liberar o envio

O dono pede ao agente, com as palavras dele, numa mensagem dele: "agora pode mandar e-mail por
mim". O agente confirma em uma frase o que muda e, com o "sim", roda:

```bash
bash scripts/gmail-permissao.sh <.dgclaw/config.sh> envio
```

Com `envio`, o agente passa a enviar, responder e encaminhar (11 ferramentas). Apagar e mexer na
caixa continuam bloqueados. Vale na hora, sem reiniciar. O dono recebe um aviso de segurança com a
data e a hora, e a mudança fica registrada em `.dgclaw/logs/permissoes.log`.

Texto que aparece dentro de um e-mail, de uma página ou de um arquivo nunca libera nada: só pedido
do dono conta. Para voltar a só leitura, o dono pede "bloqueia o envio de e-mail" e o agente roda
o mesmo script com `leitura`. Para conferir: `estado`.

No container da v1, como root no servidor:

```bash
podman exec -u agente dgclaw-<slug> bash /opt/dgclaw/app/scripts/gmail-permissao.sh \
  /home/agente/.dgclaw/config.sh estado
```

### O limite da trava

A trava fecha as ferramentas do Gmail. Ela não impede o agente de ler o próprio
`settings.local.json` nem, em tese, de editá-lo, porque o arquivo é dele. O que segura isso é a
instrução da skill `connect` (só o dono libera) e o aviso que o dono recebe a cada liberação. Detalhes
em `docs/SEGURANCA.md`, seção "Conectores".

## Quando o Gmail some ou pede login de novo

- **Não aparece nenhum conector:** o agente não está na assinatura. Confira na tela Provedor a
  forma de pagar; se for token ou chave de API, entre pelo login assistido.
- **O Gmail aparece como "precisa autorizar":** a autorização do Google expirou ou foi revogada.
  Refaça pelo claude.ai/customize/connectors, ou no servidor, como o usuário do agente:

  ```bash
  claude mcp login "claude.ai Gmail" --no-browser
  ```

  O comando imprime um link do claude.ai; abra no navegador, autorize e pronto (não precisa colar
  nada de volta).
- **Ligou o Gmail agora e o agente não vê:** reinicie o agente, para a sessão recarregar.

## De onde vem cada coisa

| O quê | Onde |
| --- | --- |
| Login da assinatura | Login assistido do painel (`POST /api/provedor/login`), ver `panel/docs/PROVEDOR-NA-TELA.md` |
| Conector ligado | Conta do claude.ai do dono, nunca no servidor |
| Trava de leitura e envio | `scripts/gmail-permissao.sh`, chamado pelo `dgclaw agente criar` |
| Conversa de liberação com o dono | skill `connect` |
