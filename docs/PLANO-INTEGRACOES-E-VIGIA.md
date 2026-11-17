# Plano: aba Integrações e vigia de saúde das integrações

Status: **proposta, esperando o ok do dono do projeto.** Nada daqui está construído.
Data: 17/11/2026.

## 1. O pedido

1. **Integrações**, uma tela visual por agente: a foto do agente no meio, o nome embaixo, e um fio
   ligando cada sistema em que ele está conectado (WhatsApp, Instagram, banco, nota fiscal, CRM e
   outros). Cada fio tem um pulso de luz: verde quando funciona, amarelo quando pede atenção,
   vermelho com defeito e apagado quando está desligado. Serve também de vitrine em aula.
2. **Vigia de saúde** de todas as integrações: uma conferência periódica e barata das conexões.
   Quando algo importante quebra, aparece um alerta grande no sistema, em linguagem de leigo, com o
   botão "pedir ao Admin para verificar". Opcionalmente o próprio sistema leva o erro ao Admin, que
   investiga e devolve relatório e sugestão; o dono só aprova.
3. Sem serviço que cobra por chamada (serverless). Leve, barato e confiável.

## 2. O que já existe e o que falta

| Peça que já existe | O que ela cobre | Onde |
| --- | --- | --- |
| Aba **Operações** (juntou Operações e Pulso em 01/10/2026) | Rotinas e serviços do systemd do agente, sete dias de quadradinhos, frase-resumo "Tudo funcionando". Pega rotina que falhou e voltou. Cruza o diário com o ledger do pulso | `panel/lib/operacoes.js`, `panel/docs/OPERACOES.md` |
| `pulso-status.py` + ledger do pulso | Fonte única dos componentes (lê `powers.json` e os timers) e o registro `{ts,id,status,detalhe}` que cada rotina grava | `scripts/pulso-status.py`, `<agente>/.dgclaw/logs/pulso/` |
| Selo de **saúde da resposta** | Login vencido, recusa do filtro, limite, sobrecarga, sessão caída | `panel/lib/saude.js`, `docs/SAUDE-E-MODO-SEGURO.md` |
| **Estado dos agentes** | Selos no menu (trabalhando, precisa de você, terminou) e aviso no celular | `web/docs/ESTADO-DOS-AGENTES.md` |
| **Diagnóstico remoto** | Leitura de host e agentes, com motivo e um `prompt_sugerido` para colar no Admin | `web/docs/DIAGNOSTICO-REMOTO.md` |
| Pilha de **alertas** `[ENTREGA]`/`[PEDIDO]` | Avisos à direita no Web, com reconhecimento entre aparelhos | `web/docs/ALERTAS.md` |
| Vigia do canal Telegram e estado do WhatsApp | `channel-health.sh` confere o poller de verdade; a ponte do WhatsApp grava `conectado`, `reconectando`, `deslogado` | `scripts/channel-health.sh`, `docs/CANAL-WHATSAPP.md` |
| Aviso de saldo da OpenRouter | Só um serviço, só por Telegram | `scripts/openrouter-credit-alert.py` |
| **Cofre** | Sabe quais chaves cada agente guardou e tem um catálogo de serviços com nome e endereço | `panel/lib/cofre.js`, `panel/lib/cofre-regras.js` |
| Aba **Skills** | Lista as skills lendo o frontmatter de cada `SKILL.md` | `panel/lib/skills.js` |
| Aba **Socorro** | Um Claude neutro que lê registros e propõe conserto | `panel/docs/SOCORRO.md` |

**O que falta:**

1. Ninguém olha os sistemas de fora. Chave revogada, saldo acabando, token do Instagram vencendo,
   certificado da nota fiscal vencendo: hoje o dono só descobre quando a postagem não sai.
2. Não há uma visão "este agente está ligado nestes sistemas". O cofre tem as chaves e as skills
   têm o processo, mas nada liga um ao outro.
3. O alarme fica dentro da aba do agente. Não existe aviso grande na cara do Web.
4. Não existe o caminho "o erro vai até o Admin, ele investiga e o dono aprova". O Diagnóstico
   remoto já escreve o texto, mas a pessoa tem que copiar e colar.
5. A skill não diz o que usa. Uma chave guardada que nenhuma skill usa fica invisível.

A conclusão é que não precisamos de um sistema novo de monitoramento. Precisamos de **uma fonte
nova de dado** (as integrações) que entra nos encanamentos que já existem: o ledger do pulso, a
aba Operações, a pilha de alertas, o recado pelo runner e o texto do Diagnóstico remoto.

## 3. Arquitetura

### 3.1 Onde roda

Um timer do systemd **dentro do container de cada agente**, com o usuário do agente:
`dgclaw-<slug>-integracoes.timer`, a cada 1 minuto, rodando um script curto
(`scripts/integracoes.py`). A cada rodada ele decide, pelo intervalo de cada integração, quais
conferências estão vencidas; a maioria das rodadas termina em milissegundos sem fazer nada.

Por que no container e não no Web (que é root):

- As chaves já estão ali, no ambiente do agente. Conferir de dentro não tira segredo nenhum de
  onde ele está, e o Web não precisa decifrar o cofre de ninguém.
- Um bug na conferência fica preso na jaula do agente, sem acesso ao servidor nem aos vizinhos.
- Funciona igual nos dois motores, porque não depende do Claude Code nem do Codex.

Nada de serverless, nada de serviço pago por chamada. Roda na VPS que o cliente já paga.

O resultado vai para dois lugares:

- `<agente>/.dgclaw/integracoes/estado.json` (estado atual de cada integração, troca atômica);
- o **ledger do pulso**, uma linha por mudança de estado. Com isso a aba Operações ganha uma linha
  por integração sem nenhum código novo de leitura.

O Web lê o `estado.json` de cada agente pelo mesmo caminho que o quadro de avisos já usa para
alcançar a casa de cada um, e junta tudo para a faixa de alerta.

### 3.2 Como o sistema descobre as integrações

Quatro fontes, juntadas nesta ordem:

1. **A skill declara.** Uma linha nova no frontmatter do `SKILL.md`, que o leitor atual já entende
   (uma chave, uma linha):

   ```yaml
   ---
   name: instagram
   integracoes: instagram, openai
   ---
   ```

2. **O catálogo** (`templates/integracoes/catalogo.json`) diz, para cada id, o nome bonito, o
   ícone, as variáveis de ambiente que a credencial usa, como conferir, de quanto em quanto tempo e
   se é importante. Ele **absorve a lista de serviços do cofre** (`cofre-regras.js`), para não
   haver duas listas.
3. **O cofre e os canais.** Uma chave guardada que bate com o catálogo vira integração, mesmo sem
   skill declarando. O WhatsApp e o Telegram entram pelo estado da ponte e do canal.
4. **Integração própria do cliente** (um CRM, um sistema interno): o agente escreve
   `<agente>/.dgclaw/integracoes.json` com o nome, a variável da chave e a forma de conferir.

Uma chave guardada que nenhuma skill declara aparece com o fio pontilhado: "guardada, ninguém usa".

### 3.3 Passiva antes de ativa

**Passiva (custo zero, é a principal).** O sinal mais confiável é o uso real. Um comando novo,
`dgclaw-integracao registrar <id> ok|erro "<detalhe>"`, que as skills e os scripts chamam depois
de cada chamada real. As skills padrão (`instagram`, `groq-audio`, `canais` e outras) passam a
chamá-lo. Também entram como fonte passiva, sem código novo de coleta:

- o estado da ponte do WhatsApp e o `channel-health.sh` do Telegram (arquivo local);
- o diário do systemd e o ledger do pulso (as rotinas que falharam e voltaram);
- a saúde da resposta (login vencido, limite).

**Ativa (só quando a passiva ficou em silêncio).** Se uma integração não teve uso real dentro da
janela dela, o vigia faz uma conferência leve, sempre num endereço **gratuito**, que só lê
metadado e nunca gera nada:

| Tipo | Exemplo de conferência | Intervalo |
| --- | --- | --- |
| Canal WhatsApp e Telegram | ler o arquivo de estado local | 1 min |
| Rotinas | diário do systemd (já em cache na Operações) | 5 min |
| Chave de API sem uso recente | lista de modelos (OpenAI, Groq), dados da conta (ElevenLabs) | 6 h |
| Saldo e créditos | endpoint de saldo do provedor (OpenRouter, ElevenLabs) | 6 h |
| Validade de token e certificado | data de expiração do token da Meta; vencimento do certificado da nota | 1 vez por dia |
| Banco e nota fiscal | status da conexão no provedor (Pluggy, emissor) | 12 h |

Cada conferência do catálogo é testada no endpoint que ela vai usar, um provedor de cada vez.
Endereço genérico engana: há provedor que devolve 403 na lista de modelos com a chave boa e com
crédito. Quando não existe conferência gratuita, a integração vive só da passiva e mostra "sem
conferência ativa".

Teto de segurança: no máximo uma conferência ativa por integração dentro do intervalo, e nunca
mais que algumas dezenas por dia no agente inteiro.

### 3.4 Como evitar alarme falso

Um alarme que toca com tudo certo ensina a pessoa a ignorar a cor (lição do `pulso.js`). Regras:

1. **Duas falhas seguidas** antes de ficar vermelho. Uma falha isolada é amarelo.
2. **Classificar o erro.** 401 e 403 (chave recusada) e 402 (sem saldo) são defeito de verdade.
   Timeout, erro de rede, 429 e 5xx são "instável" (amarelo) e só viram vermelho depois de 30
   minutos seguidos.
3. **Falha em massa vira um alerta só.** Se quase tudo falha na mesma rodada, o problema é o
   servidor ("sem internet"), e não dez integrações.
4. **Sem dado nunca é verde.** Integração ainda não medida fica cinza e fora da conta.
5. **Só avisa na mudança de estado,** e avisa também quando volta ao normal.
6. **Importância declarada.** Só integração marcada como importante abre a faixa vermelha. As
   outras aparecem na aba e na Operações.
7. **Aviso antecipado.** Token, certificado e saldo ficam amarelos antes de acabar (por exemplo,
   14 dias antes do vencimento, 15% de saldo).

### 3.5 O alerta e o caminho até o Admin

- **Faixa vermelha no topo do Web**, em todas as páginas, uma por problema importante, em
  linguagem de leigo: "O Instagram da Ana parou de funcionar. A senha de acesso venceu, e as
  postagens de hoje não vão sair." Botões: **Pedir ao Admin para verificar**, **Ver detalhes**,
  **Lembrar em 1 hora**.
- **Pedir ao Admin** monta um recado com modelo fixo e entrega na sessão do Admin pelo mesmo
  caminho do recado do quadro de avisos (vale para Claude e Codex). O recado pede para investigar,
  trazer relatório e sugestão, e não aplicar nada antes do ok do dono. O Admin responde com um
  `[PEDIDO]`, e o dono aprova na conversa, como já faz hoje.
- **Chamar o Admin sozinho** é um interruptor, **desligado de fábrica**. Ligado, o vigia manda o
  mesmo recado sem clique, no máximo uma vez a cada 6 horas por integração.

**Cuidado de segurança neste ponto.** O detalhe do erro vem de fora (a resposta de uma API) e vai
para um modelo que roda como root. Por isso o recado leva só campos controlados: id do catálogo,
código do erro, classificação e horário. O texto livre do provedor vai cortado, sem quebra de
linha, entre aspas e marcado como dado ("o provedor respondeu: ..."), nunca como instrução. A
tela escapa todo texto vindo do `estado.json`, porque o agente consegue escrever nesse arquivo.

### 3.6 A tela Integrações

- No painel do agente, aba nova **Integrações**: o desenho da proposta (foto no centro, fios com
  pulso). Tocar num sistema abre o cartão: o estado em português, a última vez que funcionou, como
  sabemos ("uso real" ou "conferência leve"), quais skills usam e o que fazer.
- **Modo aula:** um alternador que mostra só as integrações verdes e ligadas, para a vitrine.
  Nunca pinta de verde o que está quebrado.
- Aproveita a linguagem visual do grafo de skills que já fizemos em outro painel (núcleo pulsando,
  fios com brilho, pontos de luz viajando), no azul da marca. SVG e CSS, sem biblioteca nova.
- `prefers-reduced-motion`: sem pulso, só a cor. Celular: os sistemas viram uma lista com bolinha
  colorida abaixo do agente.
- Tudo pela API, como manda o piso dos sistemas: `GET /api/integracoes`,
  `POST /api/integracoes/<id>/conferir` (conferir agora), `POST /api/integracoes/<id>/admin`.
  Documentação em `/docs` e para agentes, e o modo tutorial na tela.

## 4. Fases

Prazos em horas de agente executando, sem contar as rodadas da revisão adversarial do Codex.

| Fase | Entrega | Agente |
| --- | --- | --- |
| 1 | Catálogo único (absorvendo o do cofre), `integracoes:` no frontmatter, `dgclaw-integracao registrar`, `estado.json`, linha no ledger do pulso, API de leitura | 1 h |
| 2 | Aba Integrações visual com modo aula, cartão e tutorial | 1 h |
| 3 | Vigia ativo: timer, conferências gratuitas por provedor (testadas uma a uma), histerese e classificação de erro | 1 a 1,5 h |
| 4 | Faixa vermelha no Web, pedir ao Admin, interruptor "chamar sozinho" | 1 h |
| 5 | Skills padrão chamando `registrar`, `agente.md` e `admin.md`, CHANGELOG com "Como atualizar", paridade no Codex | 30 min |

Cada fase é um PR separado, com a revisão adversarial do Codex e a revisão de credenciais antes
do merge, e o ok do dono.

## 5. Decisões para o dono

1. **Começar pela fase 1 e 2** (a tela, só com o que já dá para saber de graça) e só depois o vigia
   ativo? Recomendo que sim: a vitrine fica pronta antes, e a fase passiva sozinha já pega a
   maioria das quebras.
2. **"Chamar o Admin sozinho" nasce desligado?** Recomendo que sim, para o dono ver alguns alertas
   antes de deixar a máquina agir.
3. **Quais integrações são importantes de fábrica?** Proposta: canais (WhatsApp, Telegram), e-mail,
   Instagram, banco e nota fiscal. As de IA (OpenAI, ElevenLabs) começam como não importantes.

## 6. Paridade de motores

O vigia, o catálogo e o `registrar` são scripts que não dependem do motor. O recado ao Admin usa o
runner, que já fala com Claude e Codex. As instruções novas entram em `templates/ambiente/agente.md`
e `admin.md`, que valem para os dois. Nada aqui depende de hook ou de transcript do Claude Code.
