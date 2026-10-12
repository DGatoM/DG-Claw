---
name: doctor
description: Diagnostica e conserta um assistente DG Claw que nao sobe, ficou mudo no Telegram, perdeu a personalidade, parou de rodar as rotinas ou esta com o painel fora do ar. Use quando o usuario rodar /dgclaw:doctor, disser que "o bot nao responde", "o servico fica reiniciando", "ele voltou a responder generico", "o painel nao abre", "deu erro na instalacao", ou quiser so conferir se esta tudo certo.
user-invocable: true
---

# /dgclaw:doctor: diagnostico e conserto

**Se a pessoa chegou com uma queixa** ("ele parou", "nao responde", "deu problema"),
use a skill `/dgclaw:socorro`: ela carrega o `docs/EMERGENCIA.md` e conduz o
diagnostico na ordem certa (login vencido, sobrecarga, canal, sessao travada),
inclusive para agentes em runner ou container, que este doctor nao cobre. O doctor
e a checagem de ponta a ponta, e o socorro usa ele no meio do caminho.

Fale em portugues do Brasil e traduza tudo pra linguagem de gente. Primeiro
descubra o MODO do agente:

- **MODO LOCAL** (computador da pessoa; existe `.dgclaw/config.json` na pasta do
  agente) siga "Modo local" logo abaixo.
- **MODO SERVIDOR** (VPS com systemd; existe `.dgclaw/config.sh`) siga "Modo
  servidor" mais abaixo.

## Modo local

Na pasta do agente (procure `Agente*/.dgclaw/config.json` no home, se precisar):

```bash
cd "<pasta do agente>" && bun .dgclaw/scripts/doctor.ts
```

Ele valida o token (getMe), limpa sozinho o cache que deixa o canal mudo, detecta
409 (launcher aberto duas vezes), sessao fechada, hooks nao registrados e
pareamento pendente. Traduza cada `[FALTA]`:

- **token invalido ou ausente:** refazer o passo do BotFather do wizard.
- **sessao nao esta rodando:** abrir o launcher `Iniciar <Nome>`.
- **outro processo no mesmo token (409):** fechar TODAS as janelas do agente e
  abrir o launcher UMA vez.
- **[CONSERTADO] cache de autenticacao:** fechar e reabrir o launcher.
- **hooks nao registrados:** rodar o scaffold do wizard de novo (nao apaga nada:
  pareamento e memoria ficam).

Se tudo ficou `[ ok ]`: "esta tudo certo, manda uma mensagem pro bot".

## Modo servidor

O doctor do servidor checa as duas camadas de uma vez: a base (programas, bot,
servico, pareamento) e a camada de operacao 24/7 (identidade materializada,
rotinas, injecao na sessao viva, auto-recuperacao, painel, poderes e extensoes).

### Achar o agente

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-dgclaw.sh"
```

Cada linha e `slug|workspace|config|...`. Se houver mais de um agente, pergunte
qual. Guarde `WS` (workspace) e `CFG` (o `.dgclaw/config.sh`).

Depois do primeiro `/dgclaw:setup` os scripts tambem vivem numa copia estavel em
`<WS>/.dgclaw/plugin/scripts/`, que e a que os crons usam. Prefira ela:

```bash
PLUGIN="$WS/.dgclaw/plugin"; [ -d "$PLUGIN/scripts" ] || PLUGIN="${CLAUDE_PLUGIN_ROOT}"
```

### Rodar

```bash
sudo bash "$PLUGIN/scripts/doctor.sh" "$WS/.dgclaw/config.sh"
```

Ele imprime `[ ok ]`, `[aviso]`, `[FALTA]` e `[consertado]`, agrupados por
assunto, e ja conserta sozinho o que e sem risco (confianca do workspace,
settings locais, cache de autenticacao preso, vigia do canal ausente; num agente sem
Telegram e o contrario: o vigia do canal e retirado, porque ali ele so reinicia a sessao).

Se sobrou coisa faltando, rode de novo pedindo o conserto:

```bash
sudo bash "$PLUGIN/scripts/doctor.sh" "$WS/.dgclaw/config.sh" --fix
```

Com `--fix` ele tambem re-materializa a identidade, religa rotina parada,
reinstala as rotinas e o fix do canal, e limpa recado antigo esquecido em `/tmp`.
Ele reinicia o servico sozinho quando o conserto so vale depois do restart.

### Traduzir os problemas mais comuns

- **plugin telegram nao esta no config dir do servico:** a causa mais comum de bot
  mudo. Rode o `claude plugin install telegram@claude-plugins-official` no MESMO
  config dir que o servico usa (o doctor mostra o comando pronto). O servico usa o
  config dir padrao a menos que `DGCLAW_CLAUDE_CONFIG_DIR` esteja no `config.sh`.
- **servico no ar mas o canal nao conectou:** o bot esta mudo mesmo com o servico
  de pe. O vigia do canal reinicia em ate 2 minutos; na pressa,
  `systemctl restart dgclaw-<slug>`.
- **AGENT.md nao materializado:** e por isso que ele "voltou a responder generico".
  Rode com `--fix` e reinicie o servico.
- **rotina parada / ausente:** a memoria nao consolida a noite e ele para de ser
  proativo. `--fix` religa.
- **sessao viva fora do ar:** esperado se o dono desligou o bot pra poupar. As
  rotinas simplesmente nao fazem nada, e nada quebra.
- **camada DG Alive antiga (`.dg-alive/`):** o agente e da era anterior a fusao.
  Nao tente consertar em volta disso: as duas camadas disputam os mesmos arquivos. A
  migracao automatica do DG Alive antigo nao faz parte desta versao. Explique ao dono
  e combine com ele: guardar uma copia de `.dg-alive/` e seguir num workspace novo, ou
  copiar a memoria que ele quiser manter e so entao remover a pasta.
- **busca em conversas desligada:** o "lembra quando..." cai na busca simples. O
  indice nasce sozinho no build das 7h; na pressa, `--fix` cria agora. "Sem FTS5" e
  o Python da maquina sem o SQLite completo.
- **memoria semantica desligada / indice vazio / indice de outro modelo:** e a parte que
  acha "aquilo que ele falou em agosto" com outras palavras. Desligada, o agente ainda lembra
  pela busca em conversas (por palavra), entao nao e urgente. `--fix` instala o modelo local
  (uma vez, ~350 MB, sem chave e sem custo) e roda o primeiro reindex; indice vazio ou de
  outro modelo, ele so refaz o indice. Diga ao dono, em uma frase, se ela ficou LIGADA e com
  qual modelo (a linha do doctor diz). "Desligada de proposito" e escolha dele
  (`DGCLAW_EMBED_PROVIDER=off`): nao religue sem perguntar. Detalhes em
  `docs/MEMORIA-SEMANTICA.md`.
- **CLAUDE.md sem `@MEMORY.md` / MEMORY.md sem "Regras aprendidas":** agente instalado antes
  de 05/10/2026. Ele comeca a sessao sem as regras que o dono ja ensinou. `--fix` acrescenta a
  secao no fim do CLAUDE.md (com backup) e cria a secao no MEMORY.md; vale na proxima sessao.
- **a reflexao da noite nao escreve o diario ha N dias:** o recado sai, mas a sessao
  nao executa. Quase sempre e sessao travada ou login vencido: siga o
  `/dgclaw:socorro` (manual, secoes 3.3 e 3.6).
- **mesa de tarefas:** e opcional, so pra quem tem o app DG Telegram; "desligada" e o normal
  pra quem nao tem. Pela metade, chave recusada (401) ou sem resposta: diga ao dono o que a
  linha diz e o que fazer, e NUNCA mostre a chave (nem leia o config.sh em voz alta). CLAUDE.md
  sem a secao com a mesa ligada: `--fix` acrescenta. Detalhes em `docs/MESA-DE-TAREFAS.md`.
- **quadro de avisos:** anda junto com a mesa (mesma chave). "Hook nao ligado" quer dizer que o
  agente posta mas nao le os avisos dos outros: com o plugin habilitado no Claude isso nao
  acontece; instalado a mao, siga `docs/QUADRO-DE-AVISOS.md` (secao Ligar o hook). A sessao
  pega o hook sem reiniciar; so se o log nao mostrar "injetado" depois da proxima mensagem,
  reinicie o servico num momento ocioso, perguntando ao dono antes.
- **gancho de extensao com erro de sintaxe:** a extensao (por exemplo o DG Alive)
  nao vai rodar aquele pedaco. O nucleo continua de pe; conserte o arquivo
  apontado ou reinstale a extensao.

No fim, se tudo ficou certo, confirme numa frase e peca um "oi" pro bot. Se sobrou
item, liste em linguagem simples o que ainda falta e resolva um por um. Nunca
declare "tudo certo" com item faltando.
