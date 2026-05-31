# Fluxos pra apresentar na aula (leigos)

Material visual, pronto pra projetar. Cada bloco e quase um slide. Linguagem
simples, sem jargao. Use na ordem.

═══════════════════════════════════════════════════════════════════════════════
 SLIDE 1 — O QUE E (em uma frase)
═══════════════════════════════════════════════════════════════════════════════

        "Um assistente pessoal SEU, que vive no Telegram,
              lembra das suas coisas e nunca dorme."

         Voce fala com ele como fala com um amigo no zap.
              Ele responde, faz tarefas e te conhece
                     cada vez melhor.


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 2 — AS 4 PECAS (o "corpo" do assistente)
═══════════════════════════════════════════════════════════════════════════════

   +-------------------+        +----------------------------+
   |   BOCA & OUVIDO   |        |          CEREBRO           |
   |   Bot do Telegram |<------>|        Claude (IA)         |
   |  (voce fala aqui) |        |   pensa, decide, executa   |
   +-------------------+        +-------------+--------------+
                                              |
                                  consulta e  |  anota
                                              v
   +-------------------+        +----------------------------+
   |       CASA        |        |          MEMORIA           |
   |  VPS + "vigia"    |        |  arquivos que ele lembra   |
   |  (ligado 24h)     |        |  (curto e longo prazo)     |
   +-------------------+        +----------------------------+

   CEREBRO = a inteligencia (Claude)        CASA = um PC na internet, sempre ligado
   BOCA/OUVIDO = o bot do Telegram          MEMORIA = blocos de notas dele


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 3 — O QUE ACONTECE QUANDO VOCE MANDA UMA MENSAGEM
═══════════════════════════════════════════════════════════════════════════════

   VOCE                                                        VOCE
   (Telegram)                                              (recebe a resposta)
      |                                                           ^
      | "lembra daquele projeto do mercado?"                      |
      v                                                           |
  +--------+      +----------------+      +-----------------+     |
  |  BOT   | ---> |    CEREBRO     | ---> |  responde no    | ----+
  |Telegram|      | 1. le a msg    |      |    Telegram     |
  +--------+      | 2. olha memoria|      +-----------------+
                  | 3. decide/age  |
                  +-------+--------+
                          |
                          v
                  +----------------+
                  |    MEMORIA     |
                  | "ah sim, o     |
                  |  projeto era.."|
                  +----------------+

         Tudo em poucos segundos. Voce so ve a resposta chegar.


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 4 — MEMORIA: as 3 camadas (igual a gente)
═══════════════════════════════════════════════════════════════════════════════

   +-------------------------------------------------------------------+
   |  (1) CURTO PRAZO   ->  "o que ta rolando agora"                   |
   |      tarefas de hoje, o que voce acabou de pedir.                 |
   |      Ele anota e apaga conforme as coisas mudam.                  |
   +-------------------------------------------------------------------+
   |  (2) LONGO PRAZO   ->  "o que vale pra sempre"                    |
   |      seu nome, gostos, pessoas e projetos importantes.            |
   |      Nao some — nem se a conversa for zerada.                     |
   +-------------------------------------------------------------------+
   |  (3) MEMORIA QUE ACENDE SOZINHA  ->  lembra POR SEMELHANCA        |
   |      acha coisas relacionadas mesmo sem a palavra exata.          |
   +-------------------------------------------------------------------+

   Regra de ouro:  SE ELE NAO ANOTA, ELE ESQUECE.
   Por isso ele escreve na memoria sozinho, sem voce pedir.


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 5 — COMO UM FATO VIRA MEMORIA DURADOURA
═══════════════════════════════════════════════════════════════════════════════

   Voce diz algo                "anota que meu cachorro chama Rex"
        |
        v
   [ CURTO PRAZO ]  ----- ele percebe que isso vale pra sempre ----+
   (rascunho do dia)                                               |
                                                                   v
                                                          [ LONGO PRAZO ]
                                                          "Dono tem um cao: Rex"
                                                          (fica guardado pra sempre)

         No comeco de cada conversa, ele RELE essas notas.
              Por isso parece que ele "te conhece".


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 6 — A "MEMORIA QUE ACENDE SOZINHA" (o efeito mais legal)
═══════════════════════════════════════════════════════════════════════════════

   Pense num arquivo gigante de bilhetes antigos. Quando voce toca num
   assunto, um ajudante super-rapido procura os bilhetes PARECIDOS e
   cochicha no ouvido do assistente: "psst, lembra disso aqui".

   Voce: "como foi mesmo a conversa sobre o Zarvanito?"
            |
            v
   [ ajudante rapido ]  -- procura por SIGNIFICADO, nao por palavra exata --
            |
            |  acha um bilhete de 3 meses atras sobre o assunto
            v
   [ cochicha: "voces falaram disso em fevereiro: ..." ]
            |
            v
   Assistente ja responde sabendo do contexto antigo.

   (E opcional, mas e o que faz ele parecer que te conhece de verdade.)


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 7 — SESSAO x MEMORIA (a diferenca que confunde todo mundo)
═══════════════════════════════════════════════════════════════════════════════

   SESSAO  =  a CONVERSA de agora        MEMORIA =  o que ele APRENDEU
   (o "papo" que esta rolando)           (anotacoes que ficam guardadas)

   Linha do tempo de uma conversa:

   inicio ===========> conversa longa ==========> /reset ========> recomeca
                            |                         |
                  fica grande demais?         voce zera o papo
                            |                         |
                            v                         v
                  ele RESUME sozinho         a CONVERSA some...
                  (nao perde o fio)          ...mas a MEMORIA fica!

   +-----------------------------------------------------------------+
   |  /reset  zera a CONVERSA, mas NAO apaga a MEMORIA.              |
   |  Por isso a memoria em arquivo importa: e o que sobrevive.     |
   +-----------------------------------------------------------------+


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 8 — POR QUE ELE "NUNCA DORME" (a Casa)
═══════════════════════════════════════════════════════════════════════════════

   VPS = um computador na internet, ligado 24h (voce aluga)
                         |
                         v
              +---------------------+
              |   "vigia" (systemd) |   se o assistente cair,
              |   mantem ele de pe  |   o vigia liga de novo
              +---------------------+   automaticamente

         Por isso voce pode mandar mensagem as 3h da manha
              e ele responde — ele esta sempre acordado.


═══════════════════════════════════════════════════════════════════════════════
 SLIDE 9 — PRIVACIDADE (encerramento tranquilizador)
═══════════════════════════════════════════════════════════════════════════════

   - So VOCE fala com ele (lista de permissao bloqueia estranhos).
   - A memoria fica na SUA maquina, em arquivos seus.
   - Voce conecta so o que quiser (Google e opcional).

            E SEU. Privado. E melhora quanto mais voce usa.
