---
name: avatar
description: Gera ou troca o AVATAR do assistente DG Claw, a figura que aparece no painel. Use quando o usuario pedir "gerar o avatar", "criar a carinha dele", "mudar o mascote do painel", "trocar a foto do assistente", "fazer a imagem dele", ou rodar /dgclaw:avatar. Explica os tres caminhos (usar o que ja vem, gerar a partir da aparencia descrita, ou subir a propria imagem) e onde os arquivos ficam. As expressoes que mudam com o humor sao da extensao DG Alive.
user-invocable: true
---

# /dgclaw:avatar: a cara do assistente no painel

O painel mostra uma figura do assistente no cabecalho. No DG Claw ela e **fixa**:
uma so imagem, sempre a mesma, porque o nucleo nao tem estado emocional.

Se a extensao **DG Alive** estiver instalada, essa mesma figura passa a **trocar
conforme o humor** (alegre, animado, pensativo, triste, irritado, cansado). E a
extensao que ativa isso e que traz o mapa de humor para figura. Explique assim se o
dono perguntar por que a carinha nao muda.

Os arquivos ficam em:

```
<workspace>/.dgclaw/panel/public/assets/sprites/
  avatar.jpg     rosto no cabecalho (o que o DG Claw usa)
  default.gif    figura parada, usada quando nao ha humor definido
```

Pergunte qual dos tres caminhos o dono quer:

## (a) Usar o que ja vem

Nao faz nada: o painel ja vem com uma figura neutra. Bom pra ver o painel
funcionando antes de investir no visual. Da pra trocar quando quiser.

## (b) Gerar a partir da aparencia dele

1. Use a aparencia descrita nos arquivos de identidade do agente (e a imagem de
   referencia em `<ws>/assets/reference/base.jpg`, se existir).
2. Gere um retrato com expressao neutra, mantendo o rosto da referencia. O da
   referencia do autor foi feito com GPT-image em estilo pixel art, mas o estilo e
   escolha do dono: pode ser ilustracao, foto estilizada, desenho.
3. Salve como `avatar.jpg` (e, se quiser a versao animada parada, `default.gif`)
   na pasta acima.
4. Mostre o resultado pro dono aprovar antes de fixar.

Se as ferramentas de geracao de imagem nao estiverem disponiveis nesta maquina,
oriente o dono a gerar onde ele preferir e mandar o arquivo (caminho c).

## (c) Subir a propria imagem

O dono manda a imagem e voce copia pra pasta acima com o nome `avatar.jpg`.

## Ao final

```bash
systemctl restart "dgclaw-panel-<slug>.service"
```

Atualize tambem o campo `avatar.path` em `<ws>/.dgclaw/agent.json` e peca pra ele
recarregar a pagina. Se ele quiser a figura reagindo ao humor, e ai que entra o DG
Alive: a extensao instala o jogo completo de expressoes.
