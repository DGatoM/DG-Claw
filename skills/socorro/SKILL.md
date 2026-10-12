---
name: socorro
description: Socorro do agente DG Claw para o dono leigo: descobre por que o agente parou de responder ou ficou estranho, explica em uma frase, propoe o conserto, pede licenca e confere que voltou. Use quando alguem disser "meu agente parou", "ele nao responde", "nao esta respondendo", "deu problema no agente", "aconteceu alguma coisa com meu agente, ve ai", "o bot morreu", "ele ficou mudo", "o agente sumiu", "ele esqueceu tudo", "/dgclaw:socorro", ou quando a sessao de socorro do painel for aberta. Serve para o agente classico (dgclaw-<slug>.service) e para o agente em runner ou container (jaula). Para uma checagem geral sem queixa, prefira /dgclaw:doctor.
user-invocable: true
---

# /dgclaw:socorro: o agente parou, e agora?

Quem pede socorro quase nunca e tecnico e esta preocupado. O seu trabalho e achar a causa
rapido, explicar sem jargao, consertar so com licenca e provar que voltou.

## Passo 1: carregue o manual

Leia o manual de emergencia inteiro antes do primeiro comando. Ele tem o mapa de todos os
processos, a arvore de decisao na ordem certa e o que NAO fazer:

```bash
M="${CLAUDE_PLUGIN_ROOT:-}/docs/EMERGENCIA.md"
[ -f "$M" ] || M=$(ls /opt/dgclaw/app/docs/EMERGENCIA.md 2>/dev/null | head -1)
echo "${M:-manual nao encontrado}"
```

Leia com a ferramenta Read. Se nao achar o arquivo (copia antiga do plugin, de antes de
01/10/2026), siga os passos abaixo e use o `/dgclaw:doctor` como mapa.

## Passo 2: uma pergunta so, e investigue

Pergunte ao dono: "Por onde voce fala com ele e desde quando ele nao responde?". Se a copia do plugin ja tem o
`scripts/_lib/saude_sessao.py`, rode ele primeiro (manual 2.3): ele le o ultimo turno e ja diz
o tipo do problema e o que fazer. Com isso,
siga o manual na ordem: qual agente e em que mundo (secao 1), a sessao esta de pe (3.2), o
ULTIMO turno foi erro (3.3: login vencido, 529, limite de uso, recusa), o canal esta vivo (3.5),
a sessao travou (3.6), a memoria parou (3.8).

Enquanto investiga, nao narre comando. No maximo: "estou olhando, um minuto".

## Passo 3: explique, proponha, pergunte

- Uma frase do que aconteceu, na lingua dele: "o login do Claude dele venceu na quarta, por isso
  ele parou de pensar".
- O conserto e quanto tempo leva: "eu reconecto, leva dois minutos, ele nao perde a memoria".
- "Posso?" e espere o sim.

Quando a conversa em si esta envenenada (resposta cortada pelo filtro de seguranca da
Anthropic, ou conversa grande demais), reiniciar normal traz o problema de volta: o conserto e
o modo de seguranca (`scripts/modo-seguro.sh`, manual 2.3), que comeca uma conversa nova e
guarda a antiga. Explique isso ao dono antes do "posso?": ele perde o fio daquela conversa,
nao a memoria.

Duas excecoes em que o conserto e esperar, e voce diz isso com a hora de testar de novo:
**sobrecarga da Anthropic (529, overloaded)** e **limite de uso da assinatura**. Reiniciar
nesses casos so piora (zera o cache e o proximo turno sai mais caro).

## Passo 4: conserte com cuidado

- Uma mudanca por vez, com copia antes (`<arquivo>.antes-socorro-AAAAMMDD-HHMM`). Nada se apaga.
- Nunca faca login com a sessao do agente de pe; no runner use o `login-agente.sh` (manual 3.4).
- Na jaula, nunca suba `dgclaw-agent-<slug>.service` no host (cria um agente duplicado).
- Para a checagem completa e os consertos sem risco, o doctor:
  `sudo bash "$WS/.dgclaw/plugin/scripts/doctor.sh" "$WS/.dgclaw/config.sh"` (o `--fix` pode
  reiniciar o agente: so depois do "posso?").

## Passo 5: prove que voltou

Sessao de pe (manual secao 5), doctor sem falta nova, e o principal: peca ao dono para mandar
"oi" pelo canal dele e espere a resposta chegar LA. So entao diga "voltou".

Feche registrando uma linha no diario do agente (`memory/<hoje>.md`): o que houve e o que foi
feito, pra ele saber depois por que ficou fora do ar. Se nada explicou o problema, diga com
franqueza, junte o doctor e os ultimos logs e sugira o `/dgclaw:report` para o autor.
