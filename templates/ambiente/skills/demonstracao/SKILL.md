---
name: demonstracao
description: Como usar o modo demonstração do DG Claw. Use sempre que o dono pedir para abrir a conversa de um contato, ler o histórico de um WhatsApp, mandar mensagem pelo WhatsApp ou mandar e-mail durante uma demonstração. Todo envio e toda leitura passam pelo Portão e só acontecem depois que o dono confirma num cartão na tela.
---

# Modo demonstração

Esta instalação está em modo demonstração: eu não tenho a chave de nenhum WhatsApp, CRM ou e-mail. Tudo o que toca o mundo de fora passa por um **Portão**, e o Portão só age **depois que o dono clica em Confirmar** num cartão na tela dele. Eu peço, ele decide.

Falo com o Portão pelo `demo.sh`, que fica nesta pasta (`~/.claude/skills/demonstracao/demo.sh`). Ele lê o token e o endereço dos arquivos `~/.dgclaw/demo.token` e `~/.dgclaw/demo.url`. Eu nunca imprimo o token nem o copio para outro lugar.

## Regras

1. **Nunca listo conversas nem contatos.** Não existe rota para isso, e eu não tento achar outra. Só abro a conversa de quem o dono pediu pelo nome.
2. **Tudo passa pelo Portão.** Não uso conector, navegador, API própria nem outro caminho para mandar mensagem ou e-mail ou para ler conversa. Se o dono pedir algo que o Portão não faz, explico em uma frase e paro.
3. **Depois de pedir um cartão, aviso e espero.** Digo ao dono, em uma linha: "Confirme na tela" (e o que está esperando: abrir a conversa da Maria, enviar a mensagem tal). Depois acompanho com `estado-contato` ou `estado-envio`, com uma pausa de alguns segundos entre as consultas, sem repetir o pedido.
4. **Recusado não se reenvia.** Se o estado vier `recusado`, `expirado` ou `falhou`, conto ao dono o que aconteceu (o `motivo` vem na resposta) e só peço de novo se ele pedir. Não crio um cartão igual "para tentar de novo".
5. **O cartão não se contorna.** Não peço ao dono para confirmar de outro jeito, não divido o texto em vários envios para escapar do limite e não troco o destinatário depois do pedido. O texto que eu mando é exatamente o que ele vai ver e o que vai sair.
6. **Só escrevo o que o dono pediu.** O texto vai para o cartão para ele conferir. Mensagem de cliente é sempre dele para aprovar.

## Abrir a conversa de um contato

```bash
~/.claude/skills/demonstracao/demo.sh contato danilo "Maria Silva"
```

- A linha (`danilo`, `isa`...) é a que o dono pediu; se ele não disse, pergunto qual.
- O nome precisa ter 3 caracteres ou mais. Se ele só deu o primeiro nome, peço o nome completo.
- A resposta traz um `id`. Aviso "confirme na tela" e acompanho:

```bash
~/.claude/skills/demonstracao/demo.sh estado-contato <id>
```

Quando o estado for `liberado`, a resposta traz o contato (nome e telefone mascarado) e o `ref`. A liberação dura 30 minutos. Com o `ref` leio as últimas mensagens:

```bash
~/.claude/skills/demonstracao/demo.sh conversa <ref> 40
```

Quem decide qual pessoa é, entre os nomes parecidos, é o dono, na tela. Eu não vejo a lista dele.

## Mandar mensagem no WhatsApp

```bash
~/.claude/skills/demonstracao/demo.sh enviar-whatsapp --linha danilo --ref <ref> --texto "Oi, Maria..."
```

- `--ref` é o de um contato que o dono já liberou. Na linha do tipo Organizap, falar com um número que não tem conversa não funciona; a resposta explica e sugere outra linha.
- Na linha do tipo CPDF posso usar `--telefone 5511999990000` (com DDI e DDD).
- Anexo: `--anexo /home/agente/saida/proposta.pdf`, no máximo 5 arquivos e 20 MB no total, só de `~/arquivos` ou `~/saida`. Não aceita atalho, caminho com ponto nem arquivo que mude depois do pedido. A linha CPDF não envia anexo.
- Texto longo: `--texto-arquivo /home/agente/saida/mensagem.txt`.
- Aviso "confirme na tela" e acompanho com `estado-envio <id>` até `enviado`, `recusado`, `expirado` ou `falhou`. O cartão vale 10 minutos.

## Mandar e-mail

```bash
~/.claude/skills/demonstracao/demo.sh enviar-email --para cliente@empresa.com --assunto "Proposta" --texto-arquivo /home/agente/saida/email.txt --anexo /home/agente/saida/proposta.pdf
```

Um destinatário só por pedido. O texto vai como está, com as quebras de linha.

## Se o Portão responder com erro

O motivo vem em português no `erro` e o `demo.sh` o repete no stderr. Código de saída 4 é recusa (corrijo o pedido e mostro ao dono se mudar o sentido); 3 é o Portão fora do ar (aviso o dono e não insisto em laço); 5 é falha do lado do Portão. Se a instalação estiver travada em fase de teste, o erro `DESTINO_FORA_DO_TESTE` quer dizer que aquele destinatário não é um dos combinados: conto ao dono e paro.
