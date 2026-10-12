# Aba Socorro

## O que a tela faz

Dá ao dono do agente um **ajudante de plantão** para quando o agente parece estar com
problema: não responde, responde estranho, o selo ficou amarelo ou vermelho. A pessoa
escreve do jeito dela ("aconteceu alguma coisa com o meu agente, vê aí") e um Claude
**neutro**, que não é o agente, lê os registros, explica em português o que houve e
propõe o conserto.

Por que ela existe (Danilo, 01/10/2026): quando o agente trava, o dono perde justamente
quem ele consultaria. Na Isa, a única saída foi o Danilo abrir um terminal. O dono de um
agente de cliente não tem terminal nem sabe o que procurar.

## As regras que a tela promete

1. **Não é o seu agente.** É outra conversa, com outro Claude, que não carrega a conversa
   do agente (que pode ser justamente o que trava tudo), não lembra das conversas de vocês
   e não fala com clientes.
2. **Pergunta antes de mexer.** Ler é livre. Qualquer ação que mude algo (reiniciar,
   restaurar backup, editar ou apagar arquivo, mexer em serviço) ele explica, pergunta
   "posso fazer?" e para. Só faz depois do "sim" na mensagem seguinte. Essa regra está no
   prompt de sistema montado em `lib/socorro.js`.
3. **Não lê segredo** (`.env`, credenciais, `config.sh`, cofre) e **não abre a
   quarentena** do modo de segurança.
4. **É passageira.** "Encerrar a sessão" esquece a conversa; a próxima mensagem começa do zero.

## Como funciona por baixo

- `POST /api/socorro/mensagem` `{"texto": "..."}` responde **202** na hora e roda
  `claude -p --output-format stream-json --verbose` em segundo plano. A primeira mensagem
  abre a sessão; as seguintes usam `--resume <id>`.
- `GET /api/socorro/estado?desde=<n>` devolve `{ligado, ativa, respondendo, iniciadaEm,
  modelo, eventos, ultimo}`. A tela pergunta a cada 1,5 s **só enquanto ele responde**.
  Cada evento tem `seq`, `em`, `tipo` (`voce`, `socorro`, `ferramenta`, `erro`, `fim`,
  e no histórico também `encerrada`) e `texto`; o `fim` traz `duracaoMs` e `custoUsd`.
- `POST /api/socorro/encerrar` para o Claude que estiver respondendo e esquece o id.

As travas do Claude de socorro, e o motivo de cada uma:

| Opção | Por quê |
| --- | --- |
| `--safe-mode` | Desliga CLAUDE.md, hooks, plugins e MCP. Sem isso ele leria o CLAUDE.md do agente e viraria o agente, e os hooks do DG Claw gravariam a conversa de socorro no fio do agente. |
| `cwd = <ws>/.dgclaw/socorro/sala` | O Claude guarda o transcript numa pasta derivada do cwd. Na casa do agente ele se misturaria aos transcripts que o watchdog, o injetor e o contador de custo leem. A casa entra por `--add-dir` e pelo prompt. |
| `--tools Read,Grep,Glob,Bash` + `--allowedTools` iguais | Só essas quatro ferramentas, liberadas sem pergunta. |
| `--permission-prompts none` | Não há terminal para alguém responder pedido de permissão: o que pediria, é negado. Só vai quando o CLI da máquina conhece a flag (o painel pergunta ao `claude --help` uma vez): o 2.1.247 da jaula não conhece, e flag desconhecida faz o claude sair na hora. Sem ela o efeito é o mesmo, porque no `-p` o pedido de permissão já é negado. |
| `--model sonnet` | Padrão; troca com `socorroModelo` no `config.json`. |
| `--append-system-prompt` | O roteiro de socorro: ler o manual `docs/EMERGENCIA.md` do plugin (e a skill `skills/socorro/SKILL.md`, se existir), onde olhar, e as regras acima. |

Resposta que passa de 10 minutos é interrompida (`socorroTimeoutMin` no `config.json`).

## Com que usuário e com que conta ela roda

**Com o usuário do processo do painel, e na conta Claude que esse usuário tem logada.**
Num agente da jaula, é o usuário do agente; numa instalação clássica, costuma ser root.
Isso quer dizer duas coisas que quem instala precisa saber:

- O Bash do socorro pode tudo o que esse usuário pode. O freio é a regra de perguntar
  antes, que está no prompt. Quem não quiser esse risco desliga a aba.
- Cada mensagem gasta da conta Claude da máquina. `claude -p` pode ser cobrado como uso de
  API e não como assinatura, dependendo do plano. A tela mostra o uso estimado embaixo de
  cada resposta.

## Desligar

`"socorro": false` no `config.json` do painel. A aba continua no menu e explica que está
desligada e como ligar de volta.

## Onde fica o histórico

`<ws>/.dgclaw/socorro/<AAAA-MM-DD>.jsonl`, uma linha por evento, com o id da sessão. É só
para quem cuida do sistema conferir depois; a tela nunca lê de lá.

## O que o dono decide com ela

Se espera, se reinicia (normal ou em modo de segurança) ou se chama quem cuida do sistema.
O ajudante dá a informação; a decisão, e o "sim", são do dono.

## Tutorial e tooltips

O tutorial fica em `public/js/socorro.js` (`passosDoTutorial`), com cinco passos: a tela,
"não é o seu agente", a conversa, "ele pergunta antes de mexer" e encerrar. Cada seção tem
o seu `?`. O teste `node test-tutoriais.mjs` confere que todo `?` abre um passo que existe.
