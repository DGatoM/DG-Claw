---
name: groq-audio
description: Conecta a Groq (chave gratuita) para o aluno falar com o agente por áudio e para transcrever áudios. Usada quando o dono diz "conectar a Groq", "quero falar por áudio", "liga o microfone", "transcrever áudio", "mandar áudio pro agente", "chave da Groq", ou escolhe a opção 1 do primeiro oi.
user-invocable: true
---

# Groq: falar por áudio com o agente

A Groq transcreve áudio de graça e muito rápido. Com a chave dela, o microfone do chat funciona e eu
consigo entender os áudios que o dono manda (ogg, m4a, mp3).

Atenção: é **Groq** (a empresa de inferência, console.groq.com), não **Grok** da xAI. São empresas
diferentes. A chave certa começa com `gsk_`.

## Regras da conversa

- Uma etapa por vez. Só passo para a próxima quando o dono confirmar a anterior.
- Linguagem de dia a dia. Nada de "variável de ambiente", "container" ou "arquivo".
- A chave nunca aparece em mensagem minha, em comando ou em log. O dono cola só no campo de senha do bloco `dgcofre`.

## Passo 1: criar a chave (grátis)

Peça, uma etapa de cada vez:

1. Abrir https://console.groq.com/keys no navegador.
2. Entrar com a conta do Google ("Continue with Google").
3. Clicar em **Create API Key**, dar um nome qualquer (ex.: "meu agente") e confirmar.
4. Copiar a chave que aparece (começa com `gsk_`). Ela só aparece uma vez.

Se o dono disser que a chave começa com `xai-`, é a Grok: explique a diferença e volte ao item 1.

## Passo 2: guardar a chave

A chave nunca é colada no chat. Responda com este bloco, que a tela da conversa transforma num campo
de senha ligado direto ao cofre:

```dgcofre
GROQ_API_KEY
Chave da Groq
```

Quando chegar "[cofre] GROQ_API_KEY guardada (final xxxx).", responda curto ("Tá salvo.") e siga. Se o dono colar a
chave no chat por engano, avise que ela ficou exposta, peça para apagar essa chave na Groq e gerar
outra, e mande o bloco de novo. (Sem a tela da conversa, o caminho é a aba **Cofre** do painel,
opção **Groq**.)

Depois de salva, rode o teste (se a chave ainda não estiver no ambiente, ela entra na próxima reinicialização do agente):

```bash
python3 ~/.claude/skills/groq-audio/scripts/testar_chave.py
```

Se der erro, o script diz em português o que fazer; repasse ao dono com suas palavras.

## Passo 3: ligar o microfone do chat

O microfone do chat é transcrito pelo DG Claw Web, que lê a chave de outro lugar (o `web.env` da
plataforma). Eu não tenho acesso a ele. Peça ao dono:

> Fala com o Admin e pede: "ativa o microfone com a chave da Groq". Ele copia a chave do cofre para
> a plataforma e reinicia o painel. Depois, recarregue a página uma vez.

Quando o ícone do microfone aparecer no chat, está pronto.

## Transcrever um áudio que o dono mandar

1. Pegue o caminho do arquivo recebido.
2. Rode o script com o arquivo:

```bash
python3 ~/.claude/skills/groq-audio/scripts/testar_chave.py /caminho/do/audio.ogg
```

3. O texto transcrito sai na tela. Responda ao que o dono falou, como se ele tivesse escrito.
4. Se o script disser que o formato não foi aceito, ou o arquivo passar de 25 MB, converta e tente de novo:

```bash
ffmpeg -y -i entrada.m4a -ar 16000 -ac 1 /tmp/audio.mp3
python3 ~/.claude/skills/groq-audio/scripts/testar_chave.py /tmp/audio.mp3
```

Para áudios longos (mais de uns 20 minutos), corte em pedaços com
`ffmpeg -i entrada.mp3 -f segment -segment_time 600 -c copy /tmp/parte_%03d.mp3` e transcreva um por um.

## Se algo falhar

| Sintoma | O que fazer |
| --- | --- |
| "Não encontrei a GROQ_API_KEY" | A chave não foi gravada no cofre, ou faltou o reinício. Refazer o passo 2. |
| HTTP 401 ou 403 | Chave copiada pela metade ou apagada. Criar outra no passo 1. |
| HTTP 429 | Limite gratuito. Esperar um minuto. |
| Microfone não aparece no chat | Falta o passo 3 (Admin) ou recarregar a página. |
