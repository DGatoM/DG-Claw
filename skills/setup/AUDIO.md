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
| **1** | **Groq** (recomendado) | **grátis** na prática | ótima | chave, 2 min |
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

Fale isso com honestidade: *"tem um caminho grátis e bom (Groq), um pago que
você já pode ter chave (Gemini/OpenAI), e um 100% offline que não manda seu
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

Onde pegar a chave (mande o link, deixe a pessoa colar):
- **Groq** → https://console.groq.com/keys (login Google, chave `gsk_...`)
- Gemini → https://aistudio.google.com/apikey (chave `AIza...`)
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

> Por que isso não é paranoia: o Telegram manda container **ogg** com codec
> **opus**. A doc do Groq lista `ogg` entre os formatos aceitos, mas **não diz
> o codec** — e a lista dela (igual à da OpenAI) não cita `opus`. Não dá pra
> saber pela doc se ogg/opus passa direto. Convertendo antes, a pergunta some:
> mp3 está em todas as listas. É 1s de CPU por áudio, e ainda derruba o tamanho
> (importa no teto de 25MB do Groq free e no base64 do Gemini).

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
