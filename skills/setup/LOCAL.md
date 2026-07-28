# Wizard MODO LOCAL — agente no computador da pessoa (Windows/Mac/Linux desktop)

Filosofia: **camada fina sobre o Claude Code nativo.** O motor é todo nativo
(sessão `--channels` do plugin telegram, `--continue`, auto-compactação,
auto-memória, tarefas agendadas). O DG Claw agrega o que o nativo não tem:
check-up, persona pronta, hooks que preservam o fio do Telegram, painel,
launcher de 1 clique, doctor e TROUBLESHOOTING.

## Checklist — MOSTRE e vá marcando

Cole no começo e, a cada passo concluído, reescreva trocando `[ ]` por `[x]`,
dizendo em 1 linha qual é o próximo item.

```
INSTALAÇÃO DO AGENTE (MODO LOCAL) — progresso
[ ] 1. Check-up da máquina (tudo verde)
[ ] 2. Nome, personalidade e pasta do agente
[ ] 3. Bot do Telegram criado (token salvo)
[ ] 4. Primeira partida (launcher) + pareamento
[ ] 5. Teste de fogo (conversa de verdade)
[ ] 5a. Áudio: transcrição ligada (pulável)
[ ] 6. Canal de avisos (notify) funcionando
[ ] 7. Painel no navegador
[ ] 8. Checagem final (doctor) + os 3 gestos do dia a dia
```

## Passo 1 — Check-up da máquina  → marca [1]

Explique: "primeiro eu confiro se o seu computador tem tudo". Então:

**Se o Bun já existe** (`bun --version` responde):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/local/scripts/checkup.ts"
```

**Se o Bun NÃO existe ainda**, instale primeiro (é pré-requisito do canal
telegram de qualquer jeito):
- Windows (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"`
- macOS/Linux: `curl -fsSL https://bun.sh/install | bash`
- Depois de instalar, a pessoa precisa **fechar e reabrir o terminal** (senão
  o `bun` não é encontrado). Aí rode o checkup acima.

O checkup imprime um checklist ✅/❌ com a instrução exata de cada conserto
(Claude Code ≥ 2.1.80, login feito, plugin telegram instalado, internet).
Vá resolvendo item a item com a pessoa e **só siga quando terminar em
"TUDO VERDE"**. Itens comuns:
- plugin telegram faltando → a pessoa roda `/plugin install telegram@claude-plugins-official` e `/reload-plugins` nesta mesma sessão.
- Claude Code antigo → `claude update`.

## Passo 2 — Nome, personalidade e pasta  → marca [2]

Pergunte UM de cada vez:
1. Nome do agente (ex.: Luna, Tico, Jarvis…)
2. Personalidade em texto livre (tom, jeito, como trata a pessoa)
3. Como o agente deve chamar a pessoa (o "dono")

Grave a personalidade num arquivo temporário (use a tool Write — evita
problema de aspas no Windows) e materialize a pasta:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/local/scripts/scaffold.ts" \
  --dir "<home da pessoa>/Agente<Nome>" --name "<Nome>" --owner "<Dono>" \
  --personality-file "<arquivo temporário>" --port 8200
```

(default da pasta: `~/Agente<Nome>` — respeite se a pessoa preferir outro
lugar; porta 8200 salvo conflito.) O scaffold cria TUDO: CLAUDE.md (persona),
working-memory, TROUBLESHOOTING, hooks project-scoped em `.claude/settings.json`,
`.dgclaw/` (hooks Bun + painel + scripts) e o launcher do sistema
(`Iniciar <Nome>.command` no Mac / `Iniciar <Nome>.bat` no Windows).
Apague o arquivo temporário da personalidade depois.

Mostre à pessoa o que foi criado (2-3 linhas) e leia o CLAUDE.md gerado pra
confirmar que a personalidade entrou certa.

## Passo 3 — Bot do Telegram  → marca [3]

### 3.1 BotFather
Conduza: no Telegram, procurar **@BotFather** → `/newbot` → nome de exibição →
@username (precisa terminar em `bot`) → copiar o **token** (`123456789:AAH...`).

### 3.2 Salvar o token
Grave com a tool Write o arquivo `<pasta do agente>/.dgclaw/telegram/.env`:

```
TELEGRAM_BOT_TOKEN=<token colado>
```

(No Mac/Linux, ajuste a permissão: `chmod 600 <arquivo>`. No Windows, siga.)
Valide o token na hora:

```bash
cd "<pasta do agente>" && bun .dgclaw/scripts/doctor.ts
```

O doctor deve mostrar `token válido — bot @<username>` (os itens de sessão/
pareamento ainda vão faltar — normal, o bot nem ligou).

## Passo 4 — Primeira partida + pareamento  → marca [4]

1. Peça: **"abra a pasta do agente e dê dois cliques em `Iniciar <Nome>`"**
   (no Mac, o primeiro clique pode pedir permissão em Ajustes → Privacidade;
   no Windows, se o Defender/firewall perguntar, é Permitir acesso).
   Uma janela de terminal abre e fica rodando — explique: "essa janela É o
   <Nome> acordado; fechou a janela, ele dorme".
2. Peça: **"agora mande qualquer mensagem pro seu bot no Telegram"**. Ele vai
   responder com um código de pareamento — a pessoa NÃO precisa copiar nada.
3. Aprove o pareamento você mesmo: leia
   `<pasta do agente>/.dgclaw/telegram/access.json`; deve haver uma entrada em
   `pending`. Edite o arquivo: mova o `senderId` pendente pra lista
   `allowFrom` (como string), esvazie `pending` e mude `dmPolicy` pra
   `"allowlist"`. O canal relê o arquivo sozinho, sem reiniciar.
4. Confirme: "achei você (id <id>), travei o bot pra só você falar com ele".
   O 👀 de "recebi" já vem ligado (ackReaction).

## Passo 5 — Teste de fogo  → marca [5]

Peça pra pessoa mandar de novo um "oi" no Telegram — agora quem responde é o
agente, com a personalidade escolhida. Espere ela confirmar que a resposta
chegou (e que apareceu o 👀 na mensagem dela). Se não respondeu:
`bun .dgclaw/scripts/doctor.ts` na pasta do agente e siga o que ele mandar.

## Passo 5a — Áudio (transcrição)  → marca [5a]

O agente já enxerga imagem e lê documento de fábrica. Só o **áudio** precisa de
serviço. **Leia `AUDIO.md` nesta pasta e siga** — tem a pergunta pronta, os 3
caminhos (Groq grátis / chave paga / local offline) e o teste.

Diferenças do MODO LOCAL (o `AUDIO.md` é escrito pro servidor):

- **Não existe `config.sh`.** O launcher carrega um env opcional. Crie com Write
  (só um dos dois, conforme o sistema):

  **Mac/Linux** → `<pasta do agente>/.dgclaw/env.sh` (depois `chmod 600`):
  ```bash
  export DGCLAW_TRANSCRIBE_PROVIDER="groq"
  export TRANSCRIBE_LANG="pt"
  export GROQ_API_KEY="gsk_..."
  ```
  **Windows** → `<pasta do agente>\.dgclaw\env.bat`:
  ```bat
  set "DGCLAW_TRANSCRIBE_PROVIDER=groq"
  set "TRANSCRIBE_LANG=pt"
  set "GROQ_API_KEY=gsk_..."
  ```
- O script é `.dgclaw/scripts/transcribe.py` (já copiado no scaffold).
- **Reiniciar** = fechar a janela do agente e dar dois cliques em
  `Iniciar <Nome>` de novo.
- No Windows, `ffmpeg` não vem instalado: `winget install ffmpeg` (ou avise que
  sem ffmpeg o áudio não funciona e siga sem).

Pulável: quem não usa áudio liga depois. Nada quebra sem isso.

## Passo 6 — Canal de avisos (notify)  → marca [6]

Explique: "além da conversa, o <Nome> tem um canal de avisos que funciona até
de dentro de tarefas agendadas". Teste:

```bash
cd "<pasta do agente>" && bun .dgclaw/scripts/notify.ts "🎉 canal de avisos funcionando! — <Nome>"
```

A mensagem deve chegar no Telegram na hora. Depois, sugira o teste completo de
agendamento: a pessoa manda PRO BOT, pelo Telegram: *"me manda um oi por aqui
daqui a 2 minutos"* — o agente cria uma tarefa agendada nativa que termina
chamando o notify (o CLAUDE.md dele já ensina isso). Avise que tarefas
agendadas só rodam com o computador ligado.

## Passo 7 — Painel  → marca [7]

```bash
cd "<pasta do agente>" && bun .dgclaw/panel/panel.ts
```

(rode em segundo plano) e peça pra abrir **http://localhost:8200** no
navegador: status vivo/mudo, medidor de memória de trabalho, memória editável
e o fio da conversa. Pra parar/ligar depois: skill `/dgclaw:panel`.

## Passo 8 — Doctor final + os 3 gestos  → marca [8]

```bash
cd "<pasta do agente>" && bun .dgclaw/scripts/doctor.ts
```

Só declare pronto com **">> TUDO CERTO."**. Feche ensinando os 3 gestos do dia
a dia:

1. **Acordar**: dois cliques em `Iniciar <Nome>` (nunca duas vezes ao mesmo
   tempo!). Fechar a janela = dormir. A conversa nunca se perde.
2. **Falar**: pelo Telegram de qualquer lugar, OU digitando direto na janela
   do terminal — é a mesma conversa.
3. **Proatividade**: pedir em linguagem natural — "todo dia às 8h me manda um
   resumo da minha agenda" (tarefa agendada) ou "fica de olho em X a cada 10
   minutos" (`/loop` na conversa).

E a conversa franca de limitações (sem drama): computador desligado/dormindo =
agente dormindo; mensagem mandada com ele desligado se perde (é só reenviar);
se algo falhar, o `TROUBLESHOOTING.md` na pasta resolve 90% dos casos.
