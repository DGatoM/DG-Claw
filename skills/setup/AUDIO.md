# Áudio (transcrição) — passo compartilhado do wizard

> Chamado pelo `SERVIDOR.md` e pelo `LOCAL.md`. Conduza igual ao resto do
> wizard: explique em 1-2 frases, pergunte, execute, confirme.

## O que explicar pra pessoa (1-2 frases, sem jargão)

> "Seu assistente já **enxerga** imagem e lê documento sozinho — isso vem de
> fábrica, não precisa configurar nada. Só o **áudio** precisa de ajuda: o
> Claude não tem ouvido, então a gente pluga um serviço que vira a voz em texto.
> Sem isso, você manda um áudio e ele responde 'não consigo ouvir'."

Se a pessoa disser que não usa áudio, **pule** — dá pra ligar depois rodando
`/dgclaw:setup` de novo, ou editando o `config.sh`. Nada quebra sem isso.

## Pergunta (ofereça 3 caminhos, recomende o 1)

| # | Caminho | Custo real | Qualidade PT-BR | Setup |
|---|---|---|---|---|
| **1** | **Groq** (recomendado) | **grátis** na prática | ótima (melhor medida) | chave, 2 min |
| 2 | OpenAI / ElevenLabs / Gemini* | centavos a $18/mês | ótima | chave, 2 min |
| 3 | Local (faster-whisper) | **$0**, roda na máquina | boa | pesado, sem chave |

\* Gemini **só** com billing ativo — a chave grátis treina com o áudio. Ver Privacidade.

**Por que Groq é o default:** usa o Whisper large v3 turbo (mesma família do
estado da arte) e o free tier é generoso. Limites **oficiais** do plano free
(console.groq.com/docs/rate-limits, conferidos em 15/07/2026):

| | limite free |
|---|---|
| requests | 20/min · **2.000/dia** |
| áudio | 2h/hora · **8h/dia** |

Uso pessoal (dezenas de áudios/dia) não chega perto disso — a conta **não sai do
grátis**. Se estourar, é ~$0.04 por hora de áudio (~$2/mês pra 20 áudios de
5 min por dia). O teto real aqui é o de **8h de áudio/dia**, não o de requests.

**Medido de verdade** (mesmo áudio de 7 min, PT-BR, 15/07/2026):

| | Groq turbo | Gemini 2.5 Flash |
|---|---|---|
| tempo | **9,7s** | 26,2s |
| nome próprio | acertou | trocou por outro |
| "Claude" | acertou | escreveu "cloud" **6/6** |

O erro `Claude`→`cloud` é sistemático no Gemini e chato pra quem fala de IA o
dia todo. Mais um motivo do Groq ser o default.

Fale isso com honestidade: *"tem um caminho grátis e bom (Groq), um pago pra
quem já tem chave (OpenAI/ElevenLabs), e um 100% offline que não manda seu
áudio pra ninguém, mas é lento e come RAM."*

### ⚠️ Privacidade — leia ANTES de sugerir Gemini

Nota de voz é dado **pessoal**. Isso elimina uma opção que parece óbvia:

**NÃO ofereça chave gratuita do Gemini (AI Studio) pra transcrever áudio.** Os
termos da Gemini API (Unpaid Services, conferidos 15/07/2026) dizem literalmente:

> "Google uses the content you submit to the Services and any generated
> responses to provide, improve, and develop Google products and services and
> machine learning technologies"
>
> "**Do not submit sensitive, confidential, or personal information to the
> Unpaid Services.**"

E ainda: *"human reviewers may read, annotate, and process your API input and
output"*. Não existe opt-out no free tier. Mandar a nota de voz do dono pra lá
é ir contra a instrução explícita do fornecedor — e, no Brasil, problema de
LGPD. Fonte: https://ai.google.dev/gemini-api/terms

**Gemini só entra se a chave vier de um projeto com billing ativo** (aí vira
"Paid Services", e os termos garantem *"Google doesn't use your prompts... or
responses to improve our products"*). Cartão cadastrado em algum lugar não
basta: tem que ser um Cloud Project com billing ligado. Na dúvida, **não use**.

**Groq não tem esse problema** — a doc dela (console.groq.com/docs/your-data)
diz *"By default, Groq does not retain customer data for inference requests"* e
não usa Inputs/Outputs pra treinar/fine-tunar, **sem distinguir free de pago**.
É por isso que ela é o default: mais barata E mais limpa de privacidade.

Resumo pra falar com a pessoa: *"o caminho grátis do Groq não treina com seu
áudio; o caminho grátis do Google treina — então esse eu nem ofereço."*

### Quando recomendar o LOCAL em vez do Groq
Só se a pessoa levantar **privacidade** ("não quero meu áudio saindo da
máquina"). Aí seja honesta sobre o preço disso:
- Precisa de **~2 GB de RAM livre** (modelo `small`) e é lento em CPU: um áudio
  de 5 min leva de **2 a 5 min** pra transcrever numa VPS de 2 vCPU. Serve pra
  recado assíncrono, **irrita** em conversa.
- Em máquina fraca (<2 GB livres) cai pro modelo `base`, que erra mais em PT-BR.
- Modelo `tiny` **não** presta pra português — não ofereça.

## Executar — caminho 1 ou 2 (chave de API)

### ⚠️ ANTES de mandar o link: a aula de chave de API (não pule)

Muita gente que instala isso nunca criou uma chave de API. **Explique isto ANTES**,
com suas palavras — não deixe a pessoa descobrir sozinha num alerta em inglês:

> "Chave de API é igual a senha: ela dá acesso à sua conta e **gasta pelo seu
> cartão** se for uma conta paga. Nunca mostre pra ninguém, não manda por
> WhatsApp/e-mail, não cola em site nenhum e não põe em print. Se vazar, você
> apaga ela lá no painel e cria outra — isso é normal, não é problema.
>
> E o mais importante: **ela aparece UMA vez só.** Quando você clicar em criar,
> a chave vai aparecer na tela com um aviso em inglês dizendo que não será
> mostrada de novo. Copie na hora. Se fechar a janela sem copiar, não tem
> recuperação — é só apagar e criar outra."

Se a pessoa perder a chave, **não a faça sofrer**: mande criar outra, leva 30s.

### Passo a passo do Groq (o caminho recomendado)

Mande o link e vá narrando — testado, é rápido:

1. Abra **https://console.groq.com/keys**
2. Ele vai pedir login. **Pode entrar com o Gmail** (é o caminho mais fácil).
   Quem ainda não tem conta cria nessa mesma tela, com o mesmo login Google —
   não tem etapa de cartão nem de pagamento.
3. Já com login, ele cai **direto na página de API Keys**.
4. Clique no botão **`+ Create API Key`**.
5. Ele pede um **nome** pra chave (é só um apelido pra você saber pra que serve
   — sugira algo como "meu assistente").
6. A chave aparece (começa com `gsk_`). **Copie agora** — é aqui que vem o
   alerta em inglês dizendo que ela não será exibida de novo.

Peça pra colar a chave pra você e siga. Se a pessoa colar num lugar errado, ou
mandar print pro grupo da turma, mande **apagar e criar outra** — sem drama.

Outros providers (só se ela fizer questão):
- Gemini → https://aistudio.google.com/apikey (⚠️ **só com billing ativo** — ver Privacidade)
- OpenAI → https://platform.openai.com/api-keys (chave `sk-...`, exige crédito)
- ElevenLabs → https://elevenlabs.io/app/settings/api-keys (só vale se já paga TTS)

Grave no `config.sh` do agente (o mesmo do Passo 5 do SERVIDOR / Passo 3 do
LOCAL). `DGCLAW_TRANSCRIBE_PROVIDER` é o **interruptor** da feature: sem ele o
assistente nem sabe que tem ouvido.

```bash
# escolha UM par (provider + chave). Exemplo com Groq:
PROVIDER="groq"                 # groq | gemini | openai | elevenlabs | local
KEYLINE='export GROQ_API_KEY="gsk_..."'   # cole a chave da pessoa aqui

sudo tee -a "$WORKSPACE/.dgclaw/config.sh" >/dev/null <<EOF

# --- Transcricao de audio (STT) ---
export DGCLAW_TRANSCRIBE_PROVIDER="$PROVIDER"
export TRANSCRIBE_LANG="pt"
$KEYLINE
EOF
sudo chmod 600 "$WORKSPACE/.dgclaw/config.sh"
```
Var de chave por provider: `GROQ_API_KEY` · `GEMINI_API_KEY` · `OPENAI_API_KEY`
· `ELEVENLABS_API_KEY`.

## Executar — caminho 3 (local, sem chave)

```bash
pip install faster-whisper            # baixa ~40MB; o modelo vem no 1o uso
sudo tee -a "$WORKSPACE/.dgclaw/config.sh" >/dev/null <<'EOF'

# --- Transcricao de audio (STT) — 100% local, sem chave, sem enviar audio ---
export DGCLAW_TRANSCRIBE_PROVIDER="local"
export TRANSCRIBE_LANG="pt"
export TRANSCRIBE_LOCAL_MODEL="small"   # small = 2GB RAM. base = 1GB, erra mais.
EOF
sudo chmod 600 "$WORKSPACE/.dgclaw/config.sh"
```
Avise: **a primeira transcrição demora mais** (baixa o modelo, ~500MB).

## Dependência comum: ffmpeg

O `transcribe.py` **sempre** converte o áudio pra mp3 16kHz antes de mandar —
é o que garante que todo provider aceita (o Telegram entrega `ogg/opus`, que
nem todo serviço engole).

> **Por que isso não é paranoia — testado em 15/07/2026, com prova:** o Telegram
> entrega o arquivo com extensão **`.oga`**. A Groq valida por **extensão, não
> por conteúdo**: mandar o `.oga` cru dá **HTTP 400** (`file must be one of the
> following types: [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]` — repare que
> `.oga` não está na lista). O **mesmo arquivo, byte-a-byte**, renomeado pra
> `.ogg` passa com 200. Ou seja: quem "otimizar" a conversão fora do caminho
> quebra o áudio de todo mundo — e o erro vai parecer problema de codec, quando
> é só o nome do arquivo. Convertendo pra mp3, a armadilha some, e de quebra o
> arquivo encolhe (importa no teto de 25MB do Groq free e no base64 do Gemini).

Então ffmpeg é obrigatório nos 3 caminhos:

```bash
which ffmpeg || sudo apt install -y ffmpeg    # Linux
which ffmpeg || brew install ffmpeg           # macOS
```

## Testar de verdade (não pule)

Reinicie o serviço e **peça um áudio real**:

> "Manda um áudio de voz pro seu bot agora, qualquer coisa — 'testando, um dois
> três'."

Ele deve responder reconhecendo o conteúdo do áudio. Se disser que não consegue
ouvir, veja o Diagnóstico.

Teste direto (sem Telegram), se quiser isolar:
```bash
sudo -u "$AGENT_USER" bash -c 'source '"$WORKSPACE"'/.dgclaw/config.sh && \
  '"$PLUGIN_ROOT"'/scripts/transcribe.py /caminho/audio.oga'
```

## Diagnóstico (na ordem)

| Sintoma | Causa | Fix |
|---|---|---|
| "não consigo ouvir áudio" | `DGCLAW_TRANSCRIBE_PROVIDER` não está no config | grave a var e **reinicie o serviço** (a identidade só é montada no boot) |
| `ffmpeg nao encontrado` | falta ffmpeg | instale |
| `sem <X>_API_KEY` | chave não exportada ou provider errado | confira o par provider↔chave |
| `HTTP 401` | chave inválida/revogada | gere outra |
| `HTTP 403: error code: 1010` | Cloudflare da Groq barrando o cliente | o script já manda `User-Agent`; se voltar, é rede/proxy — teste com `curl` pra isolar |
| `HTTP 400 file must be one of...` | mandou `.oga` cru (sem converter) | é a armadilha da extensão — o script converte sozinho; se aparecer, alguém tirou o ffmpeg do caminho |
| `HTTP 429` | estourou o free tier | espere ou troque de provider |
| `faster-whisper nao instalado` | provider=local sem a lib | `pip install faster-whisper` |
| Transcreve mas vem resumido | só no Gemini: é LLM, não ASR | normal; o prompt já pede verbatim |

**Regra de ouro:** mudou o `config.sh` → **reinicie o serviço**. O bloco de
regras de áudio entra na identidade do agente só no start.

## Verdades que valem dizer

- **Imagem não precisa de nada disso.** O Claude enxerga nativo; o plugin já
  entrega o `image_path` e ele dá `Read`. Não venda chave pra "ver imagem".
- **Transcrição erra** nome próprio e termo técnico. O agente já é instruído a
  confirmar quando um erro mudaria a ação (um número, um "não").
- **Onde seu áudio vai:** caminhos 1 e 2 mandam pro servidor do provider.
  Só o caminho 3 mantém tudo na máquina. Diga isso, não deixe implícito.
