---
name: socorro
description: Socorro do agente DG Claw para o dono leigo: descobre por que o agente parou de responder ou ficou estranho, explica em uma frase, propõe o conserto, pede licença e confere que voltou. Use quando alguém disser "meu agente parou", "ele não responde", "não está respondendo", "deu problema no agente", "aconteceu alguma coisa com meu agente, vê aí", "o bot morreu", "ele ficou mudo", "o agente sumiu", "ele esqueceu tudo", "/dgclaw:socorro", ou quando a sessão de socorro do painel for aberta. Serve para a instalação v1 (cada agente num container, o Admin no servidor). Para uma checagem geral sem queixa, prefira rodar `dgclaw status`.
user-invocable: true
---

# /dgclaw:socorro: o agente parou, e agora?

Quem pede socorro quase nunca é técnico e está preocupado. O seu trabalho é achar a causa
rápido, explicar sem jargão, consertar só com licença e provar que voltou.

## Passo 1: carregue o manual

Leia o manual de emergência inteiro antes do primeiro comando. Ele tem o mapa de todas as
peças, a árvore de decisão na ordem certa e o que NÃO fazer:

```bash
M="${CLAUDE_PLUGIN_ROOT:-}/docs/EMERGENCIA.md"
[ -f "$M" ] || M=/opt/dgclaw/app/docs/EMERGENCIA.md
[ -f "$M" ] && echo "$M" || echo "manual não encontrado"
```

O app fica em `/opt/dgclaw/app`, tanto no servidor quanto dentro do container do agente.
Leia o arquivo com a ferramenta Read. Se não achar, siga os passos abaixo e use
`dgclaw status` e `dgclaw agente listar` como mapa.

## Passo 2: uma pergunta só, e investigue

Pergunte ao dono: "Por onde você fala com ele e desde quando ele não responde?". Depois siga o
manual na ordem: qual é o agente (seção 1), o mapa das peças (seção 2), o site abre (3.1), o
container e o runner estão de pé (3.2), o ÚLTIMO turno foi erro (3.3: login vencido,
sobrecarga, limite de uso, recusa), o canal está vivo (3.5), a conversa está envenenada (3.6),
a sessão travou (3.7), a memória parou (3.9). Para o último turno, o `saude_sessao.py` já diz o
tipo do problema e o que fazer (manual 2.3).

Enquanto investiga, não narre comando. No máximo: "estou olhando, um minuto".

## Passo 3: explique, proponha, pergunte

- Uma frase do que aconteceu, na língua dele: "o login do Claude dele venceu na quarta, por isso
  ele parou de pensar".
- O conserto e quanto tempo leva: "eu reconecto, leva dois minutos, ele não perde a memória".
- "Posso?" e espere o sim.

Quando a conversa em si está envenenada (resposta cortada pelo filtro de segurança da
Anthropic, ou conversa grande demais), reiniciar normal traz o problema de volta: o conserto é
o modo de segurança (botão na faixa de aviso do painel, ou `scripts/modo-seguro.sh`, manual
3.6), que começa uma conversa nova e guarda a antiga. Explique isso ao dono antes do "posso?":
ele perde o fio daquela conversa, não a memória.

Duas exceções em que o conserto é esperar, e você diz isso com a hora de testar de novo:
**sobrecarga da Anthropic (529, overloaded)** e **limite de uso da assinatura**. Reiniciar
nesses casos só piora (zera o cache e o próximo turno sai mais caro).

## Passo 4: conserte com cuidado

- Uma mudança por vez, com cópia antes (`<arquivo>.antes-socorro-AAAAMMDD-HHMM`). Nada se apaga.
- Nunca faça login com a sessão do agente de pé: pare o runner antes (manual 3.4).
- Nunca remova o container do agente para "limpar" (`podman rm`, `dgclaw agente remover`): para
  desligar, `dgclaw agente parar <slug>`. Para reiniciar só o runner, `dgclaw agente reiniciar <slug>`.
- Para refazer a parte de dentro de um agente (tarefas agendadas, runner e painel): `dgclaw agente reparar <slug>`.

## Passo 5: prove que voltou

`dgclaw agente listar` mostrando `running` e `ok`, `/api/saude` do runner em `idle` (manual
seção 5), e o principal: peça ao dono para mandar "oi" pelo canal dele e espere a resposta
chegar LÁ. Só então diga "voltou".

Feche registrando uma linha no diário do agente (`memory/<hoje>.md`, que na casa dele fica em
`/var/lib/dgclaw/agentes/<slug>/home/memory/`): o que houve e o que foi feito, para ele saber
depois por que ficou fora do ar. Se nada explicou o problema, diga com franqueza, junte a saída
de `dgclaw status` e os últimos logs e entregue a quem cuida do servidor.
