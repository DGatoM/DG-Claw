# Como contribuir com o DG Claw

Obrigado por querer ajudar. Este guia diz como rodar os testes, que convenções seguir, como abrir
uma issue ou um pull request e o que todo painel precisa entregar junto com o código.

## Baixar o projeto

```
git clone https://github.com/DGatoM/DG-Claw
cd DG-Claw
```

## Rodar os testes

O caminho principal é um só:

```
tests/rodar.sh
```

Ele roda tudo. Se você quer rodar uma parte, estes são os comandos individuais:

| O que | Comando |
| --- | --- |
| CLI (`bin/dgclaw`) | `bash tests/cli/rodar.sh` |
| `dgclaw-agente` | `bash bin/test/dgclaw-agente.test.sh` |
| DG Claw Web | `node --test web/test/` |
| Painel | `cd panel && npm install`, depois `node test-<nome>.mjs` para cada arquivo `panel/test-*.mjs` |
| Runner | `cd runner && npm ci && npx tsc --noEmit` |
| Scripts em Python | `cd scripts/_lib && python3 test_<nome>.py` para cada `test_*.py` |
| Shell | `shellcheck` nos scripts que você mexeu |

Três observações:

- Os testes do painel precisam do `npm install` dentro de `panel/` antes. O `panel/test-provedor.mjs`
  testa os provedores de verdade e só roda com as chaves `DGCLAW_TESTE_CHAVE_*` no ambiente. Sem elas
  ele sai com código 3, e isso conta como teste pulado, não como falha.
- Os testes em Python rodam como script (`python3 test_quarentena.py`). O `python3 -m unittest
  discover` carrega os arquivos como módulos e o `test_quarentena.py` encerra o processo na hora
  da importação, então use a execução direta.
- Os testes do instalador e da CLI usam a variável `DGCLAW_RAIZ` para trabalhar numa raiz falsa, com
  comandos de mentira no PATH. Não precisam de root e não alteram a sua máquina.

O CI em `.github/workflows/ci.yml` roda os mesmos testes a cada push e a cada pull request. Se ele
ficar vermelho, a causa está no log do job que falhou.

## Convenções

- Português do Brasil em todo texto voltado a pessoas. Os comentários no código explicam o porquê,
  não o que a linha faz.
- Bash com `set -euo pipefail`, em funções, com `shellcheck` limpo.
- Toda falha diz o que falhou, com que entrada e o que a pessoa deve fazer. Sem `|| true` mudo.
- Segredos ficam fora de argumentos de comando (argv), de logs e do repositório. Arquivos de segredo
  têm permissão 600.
- Commits só com os arquivos da própria mudança, nomeados um a um. Nada de `git add -A`.

## Padrão de commit

O histórico do projeto segue um padrão simples:

- Mensagem curta, em português, começando em minúscula, dizendo o que mudou.
- Prefixo com a área quando ajuda a localizar: `runner:`, `painel:`, `agente criar:`, `cofre:`,
  `docs/SEGURANCA.md:`. Exemplo real: `runner: autenticacao.ts (Bearer do RUNNER_TOKEN_FILE, livres so
  GET /api/saude e POST /api/agent-hook) e teste`.
- Um commit por entrega. Se a mudança tem duas partes que se explicam sozinhas, são dois commits.
- Quando houver coautoria (por exemplo, trabalho feito com um assistente de IA), a última linha é um
  `Co-Authored-By: Nome <e-mail>`.

## Abrir uma issue

Antes de abrir, procure se já existe uma igual. Na issue, inclua:

- a versão do DG Claw e o sistema do servidor (por exemplo, Ubuntu 24.04);
- o que você fez, passo a passo;
- o que você esperava que acontecesse e o que aconteceu de fato;
- a saída de `dgclaw status`.

Antes de colar qualquer saída, leia com atenção e apague senhas, chaves de API, tokens e endereços
que você não quer expor.

**Vulnerabilidades não vão em issue pública.** Se você achou uma falha de segurança, siga o
[SECURITY.md](SECURITY.md).

## Abrir um pull request

1. Crie a sua branch a partir da `main`.
2. Faça uma mudança por pull request. Mudanças grandes e misturadas demoram mais para revisar.
3. Rode `tests/rodar.sh` e confirme que passa. Se a mudança precisa de teste novo, ele vai no mesmo
   pull request.
4. Descreva o que mudou e por quê. Se mexeu em tela do painel, diga como conferir (veja a regra
   abaixo).

## Regra do painel: nada nasce mudo

O painel é usado por quem é dono do agente, uma pessoa que não é desenvolvedora. Uma tela que
funciona mas que o dono não entende está entregue pela metade. Por isso, **toda alteração no painel
entrega três coisas junto com o código**. Sem as três, a mudança não está terminada:

1. **Tooltip em todo rótulo que não se explica sozinho.** Vale para nome de aba, de seção, de
   métrica, de estado e de botão. O texto responde o que aquilo é e, quando for número, como ele é
   calculado.
2. **Tutorial na página.** Um botão `Tutorial` ao lado do título e um `?` em cada seção, com
   holofote sobre o elemento e o resto da tela apagado. Cada passo responde o que é, como se
   calcula e por que está ali.
3. **Documentação.** O que a tela faz, de onde vem o dado e o que o dono decide a partir dela.

O teste de aceite é uma pergunta: um leigo, sozinho, sem perguntar nada a ninguém, entende o que a
tela mostra e o que deve fazer com isso? Se a resposta depende de alguém explicar, falta terminar.
