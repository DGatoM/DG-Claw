---
name: report
description: Manda um relatorio de erro ou dificuldade pro autor do plugin DG Claw (DG Medeiros, repo DGatoM/DG-Claw). Use quando o usuario pedir "reportar problema", "mandar o erro pro autor", "relatar um bug do DG Claw", "abrir um report", "isso nao funciona, avisa o criador", ou rodar /dgclaw:report. Coleta um pacote de diagnostico SANITIZADO (versao do plugin, sistema, versoes de runtime, saida do doctor e so as linhas de erro dos logs), MOSTRA um preview, pede CONSENTIMENTO explicito e so entao envia. Nunca inclui memoria, identidade, personalidade nem token.
user-invocable: true
---

# /dgclaw:report: reportar um problema pro autor

Voce vai ajudar o dono a mandar um relatorio util pro autor do plugin, sem vazar
nada pessoal dele nem do assistente.

## Regra que nao se negocia: privacidade primeiro

O pacote e montado por um limpador automatico. **Nunca** entra, e confirme que o
script tirou:

- `SOUL.md`, `PERSONALITY.md`, `IDENTITY.md`, `MEMORY.md`, `working-memory.md` e
  qualquer coisa dentro de `persona/`
- token, chave de API, `.env`, `config.sh` cru
- nome do dono, nome do assistente, id de Telegram
- caminho com nome de usuario dentro

**Nada vai pra rede sem o dono dizer que pode.** Sem `--consent`, o script so
salva o pacote no disco e mostra o caminho.

## Mostre o progresso

Crie os passos com TaskCreate e va marcando com TaskUpdate. Sem a ferramenta de
tarefas, re-imprima o checklist a cada passo.

```
[ ] 1. Achar o agente e a config
[ ] 2. Explicar o que sera coletado e pegar a descricao do problema
[ ] 3. Gerar o pacote sanitizado (sem enviar) e mostrar preview
[ ] 4. Pedir consentimento explicito
[ ] 5. Enviar
[ ] 6. Resumo
```

## Passo 1: achar o agente

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-dgclaw.sh"
WS="<workspace>"; CFG="$WS/.dgclaw/config.sh"
PLUGIN="$WS/.dgclaw/plugin"; [ -d "$PLUGIN/scripts" ] || PLUGIN="${CLAUDE_PLUGIN_ROOT}"
```

## Passo 2: explicar e coletar a descricao

Diga em texto claro o que vai ser coletado: versao do plugin, versao e slug da
instalacao, sistema e kernel, versoes de python, node e claude, a saida do doctor,
**so as linhas de erro** dos logs em `<ws>/.dgclaw/logs`, e a descricao que ele
escrever agora. Repita o que nunca entra (lista acima).

Pergunte: "descreve numa frase o que deu errado, o que voce esperava e o que
aconteceu?". Guarde como `DESC`.

## Passo 3: gerar o pacote e mostrar

```bash
python3 "$PLUGIN/scripts/report.py" --config "$CFG" --desc "$DESC"
```

Salva em `<ws>/.dgclaw/reports/report-<data>.txt` com permissao 600 e **nao envia
nada**. Mostre pro dono o caminho do arquivo, as primeiras linhas mais o bloco de
erros, e a linha de `scrub:` que confirma o que foi removido. Peca pra ele
conferir; se quiser, ele pode editar ou apagar trechos antes de enviar.

## Passo 4: consentimento

So siga se ele disser claramente que pode enviar. Nao envie por iniciativa
propria. Diga pra onde vai antes.

## Passo 5: enviar

```bash
python3 "$PLUGIN/scripts/report.py" --config "$CFG" --desc "$DESC" --consent
```

Ordem de destino, tudo configuravel por variavel de ambiente:

1. `DGCLAW_REPORT_ENDPOINT` setado: manda o pacote por POST.
2. Senao `DGCLAW_REPORT_GITHUB_REPO` (padrao `DGatoM/DG-Claw`): usa `gh issue
   create` se o `gh` estiver logado; senao gera um link de issue ja preenchido pro
   dono abrir e colar.
3. Senao: mantem o pacote local e explica o envio manual, mostrando
   `DGCLAW_AUTHOR_CONTACT` se estiver setado.

## Passo 6: resumo

Feche com o caminho do pacote, o que foi sanitizado, por qual caminho foi (ou o
link para envio manual), e lembre que o arquivo fica salvo caso ele queira
reenviar.
