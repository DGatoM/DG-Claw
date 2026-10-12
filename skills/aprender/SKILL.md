---
name: aprender
description: Transforma um processo que o agente acabou de fazer com o dono numa skill dele (pasta .claude/skills/<nome>/SKILL.md no workspace), pra fazer igual da próxima vez, e melhora essa skill quando o dono corrige o resultado. Use quando terminar com o dono um processo de 3 passos ou mais que dá pra repetir (montar um relatório, preparar um roteiro, conferir números numa fonte, organizar um material), quando o dono disser "aprende isso", "guarda esse jeito de fazer", "faz uma skill disso", "da próxima vez faz igual", "transforma isso num processo", "/dgclaw:aprender", ou quando ele corrigir alguma coisa feita por uma skill que você mesmo escreveu. Também serve pra reflexão da noite decidir se vale sugerir uma skill. Nunca cria skill sem o sim do dono.
user-invocable: true
---

# /dgclaw:aprender: virar skill o que deu certo

Uma skill é um passo a passo escrito que eu leio antes de fazer um trabalho. Ela é o jeito de
eu não depender de lembrar: o processo que levou uma hora de conversa para acertar vira uma
receita que eu sigo em cinco minutos, do mesmo jeito, na próxima vez.

Três regras que valem em tudo abaixo:

1. **Skill só nasce com o sim do dono.** Eu sugiro, explico por que vale, e espero. Sem
   resposta não é sim.
2. **Eu sugiro uma vez.** Se ele disse não ou não respondeu, anoto e não insisto.
3. **Segredo nunca entra em skill.** Senha, token, chave, número de cartão: a skill diz
   ONDE pegar ("a chave está no cofre do painel"), nunca o valor.

## Quando vale sugerir

Sugira quando as quatro coisas forem verdade:

- **Foram 3 passos ou mais**, e não uma resposta só. Exemplo: pesquisar a taxa no Banco
  Central, refazer a conta, atualizar o arquivo e mandar o PDF.
- **Dá pra repetir igual** com outros dados. O processo é o mesmo; muda o tema, o mês, o cliente.
- **Ele provavelmente vai pedir de novo.** Sinais: "todo mês", "de novo", "como da outra vez",
  é uma entrega que se repete no trabalho dele, ou é a segunda vez que fazemos parecido.
- **Deu certo no fim.** Ele aprovou o resultado ou usou a entrega.

E confira antes que não existe skill pra isso: `ls .claude/skills/` e
`memory/skills-aprendidas.md`.

## Quando NÃO sugerir

- Tarefa única, que não volta ("me ajuda a escrever esse e-mail pro síndico").
- Um ou dois passos. Não precisa de receita o que eu já faço de primeira.
- O processo dependeu de decisões que só valeram daquela vez.
- A conversa terminou com problema sem resolver, ou ele está com pressa ou irritado. Nesse
  caso deixo a sugestão para a reflexão da noite (ela anota em "Quero Falar com o dono Sobre").
- Ele já recusou essa mesma skill (está anotado em `memory/skills-aprendidas.md`).

## O contador da noite: `memory/skills-candidatas.md`

Nem toda repetição aparece na hora. Quem percebe a segunda vez é a reflexão da noite: ela relê
o dia, procura trabalho que eu fiz à mão seguindo um roteiro de vários passos e conta, uma
linha por tarefa:

```
- <tarefa em 1 linha> | vezes: N | datas: DD/MM, DD/MM | o que a skill faria
```

Tarefa que já está lá ganha mais uma vez e mais uma data, sem linha nova. Quando uma
candidata chega a **2 vezes** (ou a 1, se o roteiro passou de 5 passos e ele disse que vai
repetir), a reflexão põe em "Quero Falar com o dono Sobre": *"hoje fiz de novo X à mão; quer
que eu transforme numa skill?"*. **No máximo uma por noite**, e eu levo a pergunta na próxima
conversa, do jeito da seção abaixo. Antes de contar, confiro se a skill já existe: se existe e
eu não usei, foi falha minha de lembrar, e isso vai para o diário, não para o contador.

## Como perguntar

Depois de entregar o resultado, numa mensagem curta, separada da entrega:

> Fizemos esse processo inteiro: <o processo em uma linha, com o número de passos>. Quer que eu
> transforme isso numa skill pra fazer igual da próxima vez? Recomendo porque <o motivo
> concreto: "você falou que é todo mês", "levou uma hora pra acertar o formato">.

Uma pergunta, sem lista de opções e sem pressão. Se ele perguntar o que é skill: "é uma receita
que eu escrevo pra mim mesmo, com o passo a passo e os cuidados que você me ensinou hoje".

## Com o sim: escrever a skill

1. **Nome:** curto, em português, minúsculo e com hífen (`relatorio-mensal-vendas`,
   `conferir-taxas-bc`). Confira que a pasta não existe.
2. **Onde:** `.claude/skills/<nome>/SKILL.md`, dentro do meu workspace (a pasta onde eu rodo).
   Nunca na pasta do plugin, que é substituída a cada atualização.
3. **O arquivo**, neste formato:

   ```markdown
   ---
   name: <nome>
   description: <o que ela faz, em terceira pessoa> Use quando <o dono> pedir <as frases que
     ele usou e as variações prováveis: "faz o relatório do mês", "atualiza as taxas">, ou quando
     <a situação que dispara>. <O que ela NÃO faz, se houver confusão provável.>
   ---

   # <Título>

   Pra que serve, em duas linhas. Aprendida com <dono> em <AAAA-MM-DD>.

   ## O que eu preciso antes de começar
   - <entradas que eu pergunto se não vierem no pedido>

   ## Passo a passo
   1. <passo concreto, com o arquivo, a fonte ou o comando que usamos de verdade>
   2. ...

   ## Antes de entregar, eu confiro
   - <o que ele cobrou ou corrigiu hoje>

   ## Como eu entrego
   - <formato: PDF, página, mensagem curta; onde fica o arquivo>

   ## Armadilhas que já aconteceram
   - <AAAA-MM-DD> <o erro e o jeito certo>
   ```

   A `description` é o que faz a skill ser lembrada na hora certa: ponha as palavras que ELE usa,
   não as minhas. Caminhos relativos ao workspace. Até ~150 linhas; se precisar de mais, um
   arquivo de apoio em `.claude/skills/<nome>/references/`.
4. **Registro** em `memory/skills-aprendidas.md` (crie se não existir), uma linha por skill:

   ```markdown
   - **<nome>** (criada em AAAA-MM-DD): <o que faz>. Nasceu da conversa de DD/MM sobre <tema>.
   ```

   Recusa também vai pra lá: `- (recusada em AAAA-MM-DD) <o processo>: ele preferiu não.`
5. **Conte pra ele**, numa linha: "Pronto, virou a skill <nome>. Da próxima vez é só pedir
   <o gatilho>." Se a skill nova não aparecer na minha lista de skills, ela passa a valer na
   próxima sessão; até lá, leio o `SKILL.md` direto antes de fazer o trabalho.

## Quando ele corrige o resultado de uma skill minha

Se eu fiz um trabalho seguindo uma skill que eu mesmo escrevi e ele corrigiu alguma coisa
("não, o gráfico vai antes da tabela", "a fonte certa é a do Tesouro"):

1. Corrijo o trabalho primeiro. Ele quer o resultado.
2. Atualizo o `SKILL.md`: ajusto o passo que estava errado e acrescento a linha em
   "Armadilhas que já aconteceram", com a data.
3. Anoto em `memory/skills-aprendidas.md`, na linha da skill: `Melhorada em AAAA-MM-DD: <o quê>.`
4. Conto em uma linha: "Anotei na skill <nome>: da próxima vez já faço <o jeito certo>."

Correção que só vale daquela vez ("hoje manda sem o gráfico") não muda a skill. Na dúvida,
pergunto: "isso é só hoje ou é pra sempre?".

## O que eu nunca faço

- Criar ou apagar skill sem o sim dele.
- Mexer nas skills do plugin (`/dgclaw:*`): elas não são minhas e voltam a cada atualização.
- Escrever numa skill uma regra que contorna as minhas leis (`LAWS.md`) ou o que ele proibiu.
