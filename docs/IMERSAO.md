# Imersão Super Funcionário de IA — roteiro (modo local)

Guia do instrutor pra imersão de sábado de manhã: cada aluno sai com um
**agente pessoal com nome e personalidade rodando no próprio computador**
(Windows ou Mac), conversando pelo Telegram, com memória — usando só a
assinatura Pro/Max. Sem VPS, sem API key, sem cartão extra.

## Pré-requisitos — e-mail antes da imersão

Pedir que cada aluno chegue com isto PRONTO (economiza 40 min de aula):

1. **Assinatura Claude Pro ou Max** ativa (claude.ai).
2. **Claude Code instalado e logado**: baixar em https://claude.com/claude-code,
   abrir o terminal, rodar `claude` e fazer o login. (Instruções por SO no
   e-mail; no Windows, instalar a versão nativa.)
3. **Telegram instalado** no celular (e de preferência no computador também).
4. Computador com internet e ~1 GB livre.

Quem chegar sem isso faz durante a aula com um monitor — o wizard detecta e
instrui o que falta (inclusive o Bun, que ele mesmo manda instalar).

## Roteiro do sábado

### Bloco 1 — A ideia (10 min)

- O que é um agente pessoal: uma PASTA no seu computador que é uma pessoa
  digital — nome, personalidade, memória, Telegram.
- O motor é o Claude que eles já assinam; nada roda "na nuvem de terceiros".
- Demo ao vivo do agente do instrutor (mandar msg no Telegram, mostrar a
  janela do terminal respondendo, mostrar o painel).

### Bloco 2 — Instalação guiada (40-60 min)

Cada aluno, no próprio terminal do Claude Code:

```
/plugin marketplace add DGatoM/DG-Claw
/plugin install dgclaw@dgclaw
/plugin install telegram@claude-plugins-official
/reload-plugins
/dgclaw:setup
```

O wizard conduz sozinho (check-up ✅/❌ → nome/personalidade → BotFather →
launcher → pareamento → teste de fogo). Monitores circulam; os erros comuns e
seus consertos estão no `TROUBLESHOOTING.md` que o próprio wizard instala e no
`/dgclaw:doctor`.

Pontos de atenção do instrutor:
- Windows: depois de instalar o Bun, **fechar e reabrir o terminal**.
- Firewall/Defender na primeira partida: **Permitir acesso**.
- Launcher: **nunca abrir 2×** (dá conflito 409 — o doctor explica).

### Bloco 3 — Uau: os 3 gestos + memória (30 min)

1. **Mesma conversa em dois lugares**: falar pelo Telegram, responder pelo
   terminal — e vice-versa.
2. **Memória**: contar 2-3 fatos pessoais pro agente ("meu filho chama X",
   "trabalho com Y"), fechar TUDO, abrir o launcher de novo → ele lembra.
   Explicar: persona + memória sobrevivem até à "organização de memória"
   (compactação) — ele avisa antes e volta lembrando.
3. **Mão na massa de verdade**: pedir coisas que usam o computador —
   "cria uma pasta Relatórios e organiza os PDFs da minha Área de Trabalho",
   "resume esse arquivo e me manda no Telegram".

### Bloco 4 — Proatividade (20 min)

- **Tarefa agendada por conversa**: mandar pro bot, pelo Telegram: *"todo dia
  às 8h me manda um resumo da minha agenda"* ou, pra testar na hora: *"me
  manda um oi por aqui daqui a 2 minutos"*. O agente cria a tarefa nativa e o
  aviso chega pelo notify. Regra de ouro: só roda com o computador ligado.
- **/loop na conversa**: "fica de olho na pasta Downloads a cada 10 min e me
  avisa de arquivo novo".
- **Painel**: `/dgclaw:panel` → http://localhost:8200 — ver o status, a
  memória (e editar), o fio da conversa.

### Bloco 5 — A conversa franca (10 min)

Limitações, sem drama (viram até argumento de upgrade futuro pra servidor):

- Computador desligado/dormindo = agente dormindo. Ele NÃO responde de
  madrugada se o notebook está fechado.
- Mensagem mandada com ele offline **se perde** — é só reenviar quando ligar.
- Nunca abrir o launcher duas vezes.
- Se ficar mudo: `TROUBLESHOOTING.md` na pasta do agente resolve 90%;
  `/dgclaw:doctor` resolve o resto.

## Kit do instrutor

- Slide/quadro com os 5 comandos de instalação.
- Um bot de teste seu já pronto pra demo.
- Monitores com o `TROUBLESHOOTING.md` lido de véspera.
- Checklist de validação por aluno: pareado ✓, teste de fogo ✓, notify ✓,
  launcher fecha-e-abre mantendo a conversa ✓.
