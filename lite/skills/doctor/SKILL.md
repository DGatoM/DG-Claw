---
name: doctor
description: Diagnostico e faxina de memoria do agente pessoal criado pelo DG Claw Lite. Confere se os arquivos e as secoes vitais do agente estao no lugar, mede e arruma a bagunca acumulada na memoria (redundancia, contradicao, arquivos inchados) sempre perguntando ao dono antes de mudar, e gera um relatorio tecnico sem nenhum dado pessoal pra pedir socorro a quem entregou o plugin. Use quando a pessoa rodar /dgclaw-lite:doctor, ou disser "meu agente nao esta funcionando", "ele esta estranho", "ele esta lento", "ele esta esquecendo das coisas", "roda o diagnostico", "faz um diagnostico do agente", "a memoria dele esta baguncada", "arruma a memoria dele", "limpa a memoria dele". Vale tambem quando o pedido chega PELO TELEGRAM, na conversa do proprio agente ("roda seu diagnostico", "faz um check-up em voce").
user-invocable: true
---

# /dgclaw-lite:doctor — check-up do agente

Você faz um check-up completo do agente pessoal desta pasta: confere se ele
está inteiro, arruma a memória bagunçada **junto com o dono** e, no fim, gera um
relatório técnico que ele pode mandar pra quem entregou o plugin.

Fale em português do Brasil, tom acolhedor de quem está ajudando — nada de
jargão. **Você não instala nada e não roda script nenhum**: tudo aqui é ler e
escrever arquivos. Os únicos comandos externos permitidos são `claude --version`
e, no item A7, `python --version`.

**Antes de começar**, diga em 2 linhas o que vai acontecer e pergunte:

> "Me conta rapidinho: o que te fez chamar o diagnóstico? (ex.: 'ele parou de
> responder no Telegram', 'ele esqueceu uma coisa que eu contei', 'ele está
> lento')"

Guarde a resposta **nas palavras dela** — vai pro relatório no fim.

Descubra também **qual é a pasta do agente**: se você já está rodando dentro
dela (tem um `CLAUDE.md` e um `working-memory.md` aqui), é essa. Se não,
pergunte o caminho.

Depois rode as três partes **em sequência**, contando o que achou em cada uma.

---

## Parte A — Saúde do plugin

Verifique os 7 itens abaixo sozinho e **mostre o resultado** como checklist,
com ✅ ou ❌ em cada linha. Não peça permissão pra ler arquivos — só leia.

**A1. Os arquivos da pasta existem?**
`CLAUDE.md`, `working-memory.md`, `TROUBLESHOOTING.md` e a pasta `memoria/`
(com o sumário `memoria/MEMORY.md` dentro).
Faltou algum? Diga qual e ofereça recriar a partir de
`${CLAUDE_PLUGIN_ROOT}/templates/` (o `.tmpl` correspondente).

**A2. O `CLAUDE.md` ainda tem as seções vitais?**
Procure por estas quatro:

- `Canal Telegram — REGRA ZERO`
- `Memória`
- `Manutenção diária`
- `Voltando de uma compactação`

Se alguma sumiu (acontece: alguém editou o arquivo e apagou sem querer),
explique em 1 linha o que aquela seção faz e ofereça restaurá-la a partir de
`${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md.tmpl`. **Restaure só a seção que
falta, preservando a personalidade e o resto do que a pessoa escreveu** — nunca
sobrescreva o `CLAUDE.md` inteiro.

**A3. O livro de memória está na pasta — e o ponteiro está no lugar?**

O desenho certo é: **o livro mora em `<pasta do agente>/memoria/`** (sumário
`memoria/MEMORY.md` + as seções `familia.md`, `trabalho.md`…), e o arquivo de
auto-memória nativa `~/.claude/projects/<slug>/memory/MEMORY.md` é **só um
ponteiro** de 3 linhas apontando pra lá. O `<slug>` é o caminho da pasta do
agente com os separadores virando traços — procure a entrada correspondente
dentro de `~/.claude/projects/`.

Confira e marque:

- O ponteiro nativo existe? E é **só ponteiro** (curto, apontando pra
  `memoria/`, sem memória escrita dentro)? Se não existir, ofereça criá-lo. Se
  tiver virado depósito de memória, marque ❌ e trate na migração abaixo.
- **Migração (versões antigas do plugin).** Achou o livro no **local antigo**
  (seções e sumário dentro de `~/.claude/projects/<slug>/memory/`) e a pasta
  `memoria/` vazia ou inexistente? Explique em 2 linhas o que mudou ("agora o
  livro fica visível na sua pasta, você pode abrir e ler") e **ofereça mover**:
  copie sumário e seções pra `<pasta>/memoria/`, confira que chegaram inteiros,
  apague os originais e deixe no lugar o ponteiro de 3 linhas. Só mova com o
  "pode" do dono.

**A4. O sumário `memoria/MEMORY.md` está sendo sumário?**
Ele existe? E é um **índice** (uma linha por assunto apontando pro arquivo) ou
virou um documentão com o conteúdo dentro? Se virou documentão, marque ❌ — a
Parte B conserta.

**A5. Os transcripts existem?**
Confira se há uma pasta deste projeto em `~/.claude/projects/` (no Windows,
`C:\Users\<nome>\.claude\projects\`) com arquivos `.jsonl`. É onde mora o
histórico literal da conversa. Se não achar nada, marque ❌ e explique sem
drama: o histórico bruto é apagado pelo sistema depois de um tempo — por isso
existe o diário.

**A6. Se o bot anda mudo, os suspeitos de sempre:**
Só levante estes se o sintoma relatado for silêncio/queda. Pergunte, um por vez:

- A janela do agente está aberta? (fechou = ele dorme)
- O comando tinha o pedaço `--channels plugin:telegram@claude-plugins-official`?
- Tem **duas** janelas abertas ao mesmo tempo? (é o erro 409, bot mudo)
- Ficou o cache travado em `~/.claude/mcp-needs-auth-cache.json` depois de
  reiniciar o computador?

Pra cada "sim" suspeito, aponte o conserto que está no `TROUBLESHOOTING.md` da
pasta (item correspondente) em vez de reexplicar tudo aqui.

**A7. O áudio está ligado do jeito certo?**
Só vale se existir `<pasta>/audio.json` — sem ele, marque ✅ e diga que é o
padrão (ele avisa honesto que não escuta e pede por texto). Existindo, leia o
`provider` e confira **a via que ele escolheu**:

- **`groq`** — tem `groq_api_key` e ela começa com `gsk_`? Vazia ou torta, ❌:
  o conserto é criar outra chave em console.groq.com/keys (leva 30s) e regravar
  o arquivo. Chave certa mas ele continua sem transcrever? Quase sempre é chave
  revogada — vale criar uma nova antes de qualquer outra coisa.
- **`local`** — o `transcrever.py` está na pasta e o `python --version`
  responde? Faltou o script, recrie rodando só o **Passo 5a** do
  `/dgclaw-lite:setup`; a biblioteca é que falhou, o conserto é
  `pip install faster-whisper` (com autorização do dono).
- **`off`** — ✅, está desligado de propósito.

Não deu pra consertar na hora? Grave `"provider": "off"` e avise: ele volta a
pedir por texto, e o resto do agente continua funcionando normalmente.

Feche a Parte A com o checklist ✅/❌ e uma frase do tipo: "estrutura ok, o
problema deve ser memória" ou "achei X, vamos consertar".

---

## Parte B — Higiene de memória

É aqui que mora o problema mais comum: memória que cresceu bagunçada. Vá com
calma e **nunca apague nada sem aprovação**.

**B1. Meça os arquivos.** Conte as linhas de cada arquivo de memória: o
`working-memory.md` da pasta, o sumário `memoria/MEMORY.md` e cada seção de
`memoria/`. Mostre uma tabelinha simples. Referências de "inchado":

| Arquivo | Sinal de inchaço |
|---|---|
| `working-memory.md` | mais de ~100 linhas |
| `memoria/MEMORY.md` (sumário) | mais de ~40 linhas, **ou** com conteúdo em vez de índice |
| qualquer seção (`memoria/familia.md`…) | mais de ~200 linhas |
| `diario/*.md` | **isento** — é histórico, cresce mesmo, não mexa |

**B1b. A data da última manutenção.** Confira a linha "Última manutenção de
memória" no topo do `working-memory.md`:

- **Não existe?** Recrie (com a data de hoje, ao final desta faxina).
- **Tem mais de 7 dias?** Os lembretes automáticos não estão acontecendo —
  confira se a seção "Manutenção diária" sumiu do `CLAUDE.md` (Parte A2) e
  faça a manutenção completa como parte desta faxina.

**B2. Leia procurando bagunça.** Com os arquivos abertos, cace duas coisas:

- **Redundância** — o mesmo fato escrito em 2 ou 3 lugares diferentes.
- **Contradição** — dois fatos que não podem ser verdade ao mesmo tempo.

**B3. Pergunte antes de decidir.** Para cada contradição encontrada, pergunte ao
dono **uma por vez**, mostrando os dois lados nas palavras dele:

> "Achei uma contradição: numa memória está escrito que você gosta de resumo em
> lista, e em outra que você prefere texto corrido. Qual das duas eu mantenho?"

Espere a resposta antes de ir pra próxima. **Nunca escolha sozinho.** Se a
pessoa disser "tanto faz", tudo bem — junte as duas numa frase só e siga.

Redundância pura (o mesmo fato repetido, sem conflito) você pode consolidar sem
perguntar, mas **avise** o que juntou.

**B4. Arrume, com as respostas na mão:**

- **dedupe**: um fato mora em um lugar só;
- **working-memory → seção**: o que já virou permanente sai do caderninho e vai
  pra seção certa do livro, em `memoria/`;
- **sumário → seção**: conteúdo que está no `memoria/MEMORY.md` desce pra uma
  seção; o sumário volta a ser só índice;
- **seção gigante → duas**: divida por assunto e registre as duas no sumário;
- **atualize o sumário** no fim, sempre.

**B5. Mostre o antes/depois** em linhas por arquivo:

```
working-memory.md     142 → 38 linhas
memoria/MEMORY.md      96 → 22 linhas (voltou a ser índice)
memoria/trabalho.md   210 → 120 linhas (+ clientes.md, 84 linhas)
```

---

## Parte C — Relatório de diagnóstico

Escreva o arquivo `<pasta do agente>/diagnostico-AAAA-MM-DD.md` (data de hoje)
com a tool Write.

**REGRA ABSOLUTA: só dados técnicos.** Nada de conteúdo pessoal — nenhuma
memória, nenhum nome de pessoa, nenhum fato do dono, nenhum trecho de conversa.
Números e nomes de arquivo, só. Se estiver na dúvida se uma informação é
pessoal, ela é: deixe de fora.

Conteúdo do arquivo:

1. **Cabeçalho** — data de hoje; versão do plugin (leia o `version` de
   `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`); sistema operacional;
   versão do Claude Code (`claude --version`).
2. **Parte A** — o checklist dos 7 itens com ✅/❌, uma linha cada.
3. **Parte B** — as métricas: linhas por arquivo (antes → depois), quantas
   redundâncias e quantas contradições foram achadas, e quantas foram
   resolvidas.
4. **Sintoma relatado** — 1 linha, nas palavras do dono, como ele contou no
   começo.
5. **Consertado / pendente** — o que o doctor arrumou e o que ficou em aberto.

Feche a conversa dizendo, com estas palavras:

> "Salvei o relatório em `diagnostico-AAAA-MM-DD.md`, na pasta do seu agente.
> Se precisar de ajuda, é só mandar esse arquivo pra quem te deu o plugin — ele
> não contém nada pessoal seu, pode abrir e conferir antes de enviar."

E dê o resumo final em 2-3 linhas: o que estava errado, o que você arrumou e o
que a pessoa precisa fazer (se precisar de algo).

---

## Se o pedido veio pelo Telegram

Mesma coisa, com dois ajustes:

- **Telegram não renderiza markdown**: nada de asteriscos, cerquilhas ou
  tabelas. Mande texto corrido, com quebras de linha e no máximo emojis. O
  checklist vira "✅ arquivos ok / ❌ sumário inchado", uma linha por vez.
- **Não despeje tudo de uma vez.** Mande o resultado da Parte A, depois as
  perguntas da Parte B (uma por mensagem, esperando a resposta), depois o
  resumo. O relatório continua sendo um arquivo salvo na pasta — avise o nome
  dele e onde está.
