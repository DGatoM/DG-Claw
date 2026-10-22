# Caixa de cofre na conversa

Como o agente pede uma chave (senha, token de API) ao dono sem que o valor passe pela conversa.
Vale no DG Claw Web. A mesma ideia existe no outro app da DG, com os mesmos textos.

## Duas portas, a mesma caixa

1. **Bloco `dgcofre` (principal).** Na resposta, um bloco de código de linguagem `dgcofre`: o nome da
   variável na 1ª linha e um rótulo opcional na 2ª. O agente não escreve arquivo nenhum.

   ````
   ```dgcofre
   HOSTINGER_API_TOKEN
   Token da API da Hostinger
   ```
   ````

2. **Peça `dv-cofre` na lousa (secundária).** Para quando a chave faz parte de um visual maior, como um
   passo a passo de configuração:

   ```html
   <div class="dv-cofre" data-cofre="HOSTINGER_API_TOKEN"
        data-rotulo="Token da API da Hostinger"
        data-ajuda="hPanel > Perfil > API > Criar token"></div>
   ```

   `data-cofre` é obrigatório (`^[A-Z_][A-Z0-9_]{1,63}$`). `data-rotulo` (até 80 caracteres) e
   `data-ajuda` (até 200) são texto puro. Em JavaScript, `dgvis.cofre(nome, {rotulo, ajuda})` faz o
   mesmo pedido. Pode haver várias peças no mesmo visual; abre uma caixa por vez. O visual é código não
   confiável: ele recebe só "guardada" ou "não guardada" por nome, nunca o final da chave. O final aparece
   apenas no cartão desenhado pelo app, fora do iframe, e no aviso que o agente recebe.

As duas abrem o mesmo cartão, com o mesmo texto e a mesma rota (`POST /p/<agente>/api/cofre`, a que a
aba Cofre também usa). O nome ainda passa pela lista de nomes permitidos do cofre (`panel/lib/cofre.js`);
nome recusado volta com o motivo.

## O que o dono vê

Um cartão com o rótulo, o nome da variável, a ajuda, um campo de senha (com botão de mostrar) e o
botão **Salvar no cofre**. Se a chave já existe, o cartão diz "Já tem uma guardada (final 9z8y). Salvar de
novo substitui." Linha fixa: "O valor vai direto para o cofre. Não entra na conversa nem chega à
\<agente\>. Salvar reinicia a \<agente\> para a chave valer; a conversa continua de onde parou."

## O que o agente recebe

Depois de guardar, uma mensagem do dono com o texto exato:

```
[cofre] HOSTINGER_API_TOKEN guardada (final 1a2b).
```

Só o nome e os 4 últimos caracteres, nunca o valor. Quem monta e entrega a mensagem é o servidor, não o
navegador: o cartão manda `avisar:true` no pedido de guardar, e o servidor entrega em segundo plano (até 5
tentativas, 3 s entre elas, porque salvar reinicia o agente). A aba Cofre e a API não mandam `avisar`, e
então ninguém é avisado. Na conversa a mensagem aparece com a etiqueta "do cofre".
Quando o reinício não deu certo, o aviso acrescenta "O agente ainda não reiniciou para usar a chave."
Responda curto ("Tá salvo.") e siga: a chave já está no seu ambiente como variável.

## Regras para o agente

- Nunca peça para o dono colar a chave no chat. Se ele colar por engano, diga que ela ficou exposta,
  que deve revogar e gerar outra, e mande o bloco `dgcofre`.
- Não repita nem registre o valor, mesmo que ele apareça. Use a variável de ambiente.
- Para a chave de um serviço, diga em uma frase onde ela é gerada (a `data-ajuda` serve para isso).

## Garantias

- O campo é desenhado pelo app, fora do iframe da lousa. O código do visual nunca encosta no valor,
  que também não passa pelo `localStorage`, por log nem pela conversa.
- O visual só PEDE (`postMessage`); quem abre a caixa e quem grava é o toque do dono.
- O pedido que vem do iframe nunca recebe foco automático nem rouba o teclado do compositor (no máximo
  o `#chat` rola para o cartão aparecer). O cartão, nas duas portas, só grava depois de um gesto confiável do
  dono dentro dele (`pointerdown` ou `touchstart` com `isTrusted`). O botão Salvar fica desligado, com a dica
  "Toque no campo e cole a chave", e Enter no campo não grava; além disso o toque tem de ter sido no próprio
  campo, para o valor ter sido colocado depois do gesto. Foco dado por script não conta, e quem navega só por
  teclado precisa tocar ou clicar uma vez no campo.
- Atalhos da conversa, ditado e o Esc da tela cheia não recebem o que se digita ou cola no campo.
- A gravação exige a sessão de login do dono: chave de API do painel não grava por aqui.
