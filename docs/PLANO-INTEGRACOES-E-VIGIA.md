# Plano: aba Integrações e vigia de saúde das integrações

Status: **aprovado para construção em 17/11/2026**, com as decisões da seção 6. Revisado pelo
Codex (gpt-6.2-astra) na mesma data; a seção 7 registra o que ele apontou e o que mudou.

## 1. O pedido

1. **Integrações**, uma tela visual por agente: a foto do agente no meio, o nome embaixo, e uma
   linha ligando cada sistema em que ele está conectado (WhatsApp, Instagram, banco, nota fiscal,
   CRM e outros). Cada linha tem um pulso de luz: verde quando funciona, amarelo quando pede
   atenção, vermelho com defeito e apagado quando está desligado. Serve também de vitrine em aula.
2. **Vigia de saúde** das integrações: uma conferência barata das conexões. Quando algo
   importante quebra, aparece um alerta grande no sistema, em linguagem de leigo, com o botão
   "pedir ao Admin para verificar". Opcionalmente, o próprio sistema leva o erro ao Admin, que
   investiga e devolve relatório e sugestão; o dono só aprova.
3. Sem serviço que cobra por chamada (serverless). Leve, barato e confiável.

## 2. O que já existe e o que falta

| Peça que já existe | O que ela cobre | Onde |
| --- | --- | --- |
| Aba **Operações** (juntou Operações e Pulso em 01/10/2026) | Rotinas e serviços do systemd do agente, sete dias de quadradinhos, frase-resumo. Pega rotina que falhou e voltou | `panel/lib/operacoes.js`, `panel/docs/OPERACOES.md` |
| `pulso-status.py` + ledger do pulso | Componentes descobertos por `powers.json` e timers, com o registro de cada rotina | `scripts/pulso-status.py` |
| Selo de **saúde da resposta** | Login vencido, recusa do filtro, limite, sobrecarga, sessão caída | `panel/lib/saude.js` |
| **Diagnóstico remoto** | Leitura de host e agentes, com motivo de cada item parado | `web/docs/DIAGNOSTICO-REMOTO.md` |
| Atalho **Pedir ao Admin** da tela Segurança | Abre a conversa do Admin com o pedido já escrito; quem envia é o dono | `web/public/seguranca.js`, `web/public/atualizacao-faixa.js` |
| Vigia do Telegram e estado do WhatsApp | `channel-watchdog.sh` grava o estado do canal; a ponte do WhatsApp grava `conectado`, `reconectando`, `deslogado` | `scripts/channel-watchdog.sh`, `docs/CANAL-WHATSAPP.md` |
| Aviso de saldo da OpenRouter | Um serviço só, avisando pelo `notify-owner.sh` | `scripts/openrouter-credit-alert.py` |
| Publicação no Instagram | Já distingue recusa confirmada de resultado incerto | `scripts/ig-publish.py` |
| Aba **Skills** | Lista as skills lendo o frontmatter | `panel/lib/skills.js` |

**O que falta:**

1. Ninguém junta, por integração, se o uso real está dando certo. A Operações vê a rotina; ela
   não vê que o Instagram recusou a chave dentro de uma rotina que terminou "bem".
2. Não há uma visão "este agente está ligado nestes sistemas".
3. O alarme fica dentro do painel do agente. Não existe aviso grande no Web.
4. O atalho para o Admin existe só na tela Segurança.

## 3. Arquitetura

### 3.1 A ideia em uma frase

Os programas que já falam com cada sistema passam a **anotar o resultado** num registro local
do agente (custo zero, sem chamada extra). O painel do agente desenha o mapa a partir desse
registro. O Web lê o mesmo registro com leitura blindada e abre a faixa quando uma integração em
uso quebrou. Nada de timer novo, nada de serverless.

### 3.2 O registro (`dgclaw-integracao registrar`)

Um comando novo no container, `dgclaw-integracao registrar <id> <resultado>`, usado **pelos
programas que fazem a chamada** (e não só pelo modelo, que pode esquecer):

- `<id>`: `^[a-z0-9][a-z0-9-]{0,31}$`. Sistema conhecido usa o id do catálogo; sistema próprio
  do cliente usa o nome que o agente escolher, no mesmo formato.
- `<resultado>`: um valor de uma lista fechada: `ok`, `credencial_recusada`, `sem_saldo`,
  `limite`, `fora_do_ar`, `rede`, `incerto`, `vencendo`, `erro`. **Não há campo de texto livre**:
  resposta do provedor, URL, cabeçalho, telefone e corpo HTTP nunca entram no registro.
- Grava, com trava de arquivo (`flock`), uma linha em `~/.dgclaw/integracoes/eventos.jsonl`
  (`{em, id, resultado, origem}`, com `origem` também de lista fechada: `uso`, `canal`) e
  recalcula `~/.dgclaw/integracoes/estado.json` por troca atômica. O arquivo de eventos é
  aparado (últimos 30 dias, no máximo 5.000 linhas).
- Limite de 50 ids distintos por agente; o 51º é recusado com motivo.

Instrumentação inicial, nos programas que já existem:

| Programa | Id | Como |
| --- | --- | --- |
| `scripts/ig-publish.py` | `instagram` | depois de cada publicação ou validação: `ok`, `credencial_recusada`, `incerto` |
| `scripts/transcribe.py` | `groq` | depois de cada transcrição |
| ponte do WhatsApp | `whatsapp` | na mudança de estado da ponte (`origem: canal`) |
| `channel-watchdog.sh` | `telegram` | na mudança do estado do canal (`origem: canal`) |
| `openrouter-credit-alert.py` | `openrouter` | `ok`, `vencendo` (saldo baixo) ou `sem_saldo` |

Skills de cliente (CRM, banco, nota fiscal) chamam o mesmo comando; as instruções do agente
ensinam isso (seção 3.7).

### 3.3 O que aparece no mapa

**Não existe lista de integrações de fábrica.** Uma integração entra no mapa na primeira vez que
aparece um evento dela, e a partir daí fica lá sozinha. Ou seja, só entra o que o agente usou de
verdade ou o canal que está ligado de fato.

- O **catálogo** (`templates/integracoes/catalogo.json`) não decide o que aparece. Ele só dá,
  para ids conhecidos, o nome bonito e o ícone do sprite. Id desconhecido aparece com o próprio
  id como rótulo e o ícone genérico `link`.
- O **frontmatter** das skills (`integracoes: instagram, openai`) só anota "quais skills usam"
  uma integração que já está no mapa. Ele **não** cria nó (senão uma skill instalada de fábrica,
  como a `groq-audio`, faria aparecer um sistema que o dono nunca configurou).
- Uma integração sem evento há mais de 30 dias sai do mapa (o dono pode tirá-la antes).

### 3.4 As cores e as transições

O estado de cada integração vem **só dos eventos dela**:

| Estado | Regra |
| --- | --- |
| verde | o evento mais recente é `ok` |
| amarelo | o mais recente é `rede`, `limite`, `incerto`, `vencendo` ou `erro`, ou houve um único `credencial_recusada`/`sem_saldo`/`fora_do_ar` ainda não confirmado |
| vermelho | duas observações **distintas** (horários diferentes, a pelo menos 2 minutos uma da outra) de `credencial_recusada`, `sem_saldo` ou `fora_do_ar`, sem `ok` depois delas |
| apagado | o dono desligou a integração na tela, ou o canal está desligado. Aparece escrito "desligado" |
| sem medida recente | nenhum evento há mais de 7 dias. Cinza, escrito "sem uso recente". Nunca verde |

- Um `ok` volta para verde: é a operação real dando certo.
- Cada cor tem também uma palavra ao lado (Funcionando, Atenção, Com defeito, Desligado, Sem uso
  recente). Com movimento reduzido ou no celular, a palavra garante a leitura sem o pulso.
- Vários vermelhos ao mesmo tempo não viram "sem internet": a faixa agrupa em "várias
  integrações estão com defeito" e o detalhe mostra cada uma.

### 3.5 A faixa vermelha no Web

- **Quem vê:** só o dono autenticado do Web. Colaborador não vê (ele pode ter acesso a um agente
  só, e a faixa falaria dos outros).
- **Quando abre:** integração **vermelha** que teve **tentativa real** (evento de origem `uso` ou
  `canal`, com sucesso ou falha) nos últimos 7 dias. A cada tentativa nova a elegibilidade é
  reavaliada, então uma integração que quebrou parada e voltou a ser usada abre a faixa nessa
  hora.
- **Incidente persistido no host** (`<DGCLAW_WEB_DATA>/integracoes/incidentes.json`, modo 0600):
  um incidente por agente e integração, com id gerado no host. Recarregar a página, reiniciar o
  Web ou o fim do "lembrar em 1 hora" recompõem a faixa sem duplicar nada. O incidente fecha
  quando a integração volta ao verde.
- **Botões:** "Pedir ao Admin para verificar", "Ver detalhes" (abre o painel do agente na aba
  Integrações) e "Lembrar em 1 hora". O dono pode silenciar a faixa de uma integração.

**Leitura blindada.** O Web roda como root e o `estado.json` é escrito pelo agente. O Web:

1. deriva a casa do agente do próprio registro do host, nunca de dado do agente;
2. abre um caminho relativo fixo (`.dgclaw/integracoes/estado.json`) sem seguir atalho
   (`O_NOFOLLOW` em cada componente, ou o mesmo leitor seguro do diagnóstico), confere pelo
   descritor aberto que é arquivo comum e do dono esperado;
3. recusa o arquivo inteiro acima de 64 KB, valida o esquema (ids pelo formato, resultados pela
   lista fechada, no máximo 50 itens) e, em qualquer falha, mostra "não foi possível medir" em vez
   de verde.

Toda escrita na tela usa `textContent`. Ícone e classe vêm de tabelas do próprio código.

### 3.6 O caminho até o Admin

**Manual (sempre disponível):** "Pedir ao Admin para verificar" reaproveita o atalho que já existe
na tela Segurança (`DGAtualizacaoFaixa.instalar`): abre a conversa do Admin com o pedido escrito, e
quem envia é o dono.

**Automático (interruptor, desligado de fábrica):** guardado no host, só o dono muda. Ligado, o
Web envia o pedido sozinho, pelo runner do Admin, quando um incidente abre.

**O texto do pedido é montado pelo Web só com frases fixas** e quatro campos controlados: o slug
do agente (do registro do host), o id da integração (pelo formato; id fora do catálogo vira
"uma integração própria do agente"), a categoria (lista fechada, traduzida por tabela) e o id do
incidente. Nada escrito pelo agente ou vindo do provedor entra no texto. O pedido diz para
**investigar e propor**, e para não aplicar nada antes do ok do dono. A resposta volta como
`[PEDIDO]`, e o dono aprova na conversa.

Limites do automático: um pedido por incidente, no máximo um a cada 6 horas por integração e no
máximo 5 por dia no total. Como o agente consegue escrever eventos falsos, o pior que ele obtém é
fazer o Admin investigar um defeito inexistente, com texto fixo, dentro desses limites. Isso fica
escrito na documentação.

### 3.7 Paridade e instruções

- O registro, o estado, o mapa e a faixa não dependem do motor.
- O leitor do frontmatter lê também `.agents/skills` (onde o Codex procura skills).
- `templates/ambiente/agente.md` ensina a chamar `dgclaw-integracao registrar` depois de usar um
  sistema externo; `admin.md` explica o pedido que chega e o que fazer com ele. Vale para Claude e
  Codex.
- A prova nos dois motores (descoberta, registro, Admin ocupado, `[PEDIDO]` recebido) entra no PR.

### 3.8 Conferência ativa (depois, uma de cada vez)

Fica **fora da primeira entrega**. Cada conferência ativa só entra depois de homologada: endpoint
confirmado como gratuito, credencial específica, destino HTTPS fixo no código, sem redirecionamento,
tempo e tamanho de resposta limitados, orçamento numérico por dia compartilhado com o botão
"conferir agora". Ela roda no batimento que já existe (30 minutos), sem turno de IA, e nunca por
URL, variável ou comando vindos de arquivo do cliente. A conferência só usa chave que esteja no
ambiente de quem roda; o cofre inteiro não é carregado em outro processo.

Candidatas, em ordem: data de vencimento já conhecida do token do Instagram (sem chamada); limite
da própria chave da OpenRouter (`/key`); assinatura da ElevenLabs. Pluggy e emissores fiscais ficam
só na passiva.

## 4. A tela Integrações

- No painel do agente, aba nova **Integrações**. **Constelação, no estilo do logo e dos gráficos
  do DG Claw:** a foto do agente no centro com o nome embaixo; cada sistema num nó, ligado por uma
  **linha reta**, no traço e nas cores do DG Claw (tokens `--cor-*`, tema claro e escuro). Os nós
  ficam a **distâncias um pouco diferentes** do centro (raio variando por uma semente fixa do id,
  para o desenho não mudar a cada visita) e em ângulos distribuídos. O pulso é um ponto de luz
  que anda pela reta.
- **Ícones do sprite do DG Claw** (`web/public/ds/icones.svg`), nunca emoji, por tabela do código:
  WhatsApp `message`, Telegram `send`, Instagram `camera`, e-mail `mail`, banco `vault`, nota
  fiscal `file-text`, CRM `users`, agenda `calendar`, voz `volume`, IA `sparkle`, desconhecido
  `link`. Ícone que faltar entra no sprite pelo processo do `docs/DESIGN-SYSTEM.md`.
- Tocar num nó abre o cartão: estado em português, última vez que funcionou, último problema
  (pela categoria), quais skills usam, e o botão de desligar.
- **Modo aula:** mostra só as integrações que estão funcionando. Nunca pinta de verde o que não
  está.
- Celular: os nós viram uma lista com a bolinha e a palavra do estado, embaixo da foto.
- API: `GET /api/integracoes`, `POST /api/integracoes/<id>/desligar` e `/ligar`. Documentação em
  `/docs` e para agentes. Tutorial da tela.

## 5. Fases

Prazos em horas de agente, sem contar as rodadas da revisão adversarial.

| Fase | Entrega | Agente |
| --- | --- | --- |
| 1 | `dgclaw-integracao registrar`, estado e eventos, catálogo de nomes e ícones, instrumentação dos 5 programas, `GET /api/integracoes` no painel | 1 h |
| 2 | Aba Integrações (constelação, cartão, modo aula, celular, tutorial) | 1 h |
| 3 | Web: leitura blindada, incidentes no host, faixa do dono, pedir ao Admin manual e automático (desligado) | 1,5 h |
| 4 | Instruções do agente e do Admin, CHANGELOG com "Como atualizar", prova nos dois motores | 30 min |
| 5 | Conferências ativas homologadas, uma por PR | depois |

As fases 1 a 4 vão num PR só, revisado pelo Codex em modo adversarial, com a revisão de
credenciais, e **sem merge até o ok do dono**.

## 6. Decisões do dono (17/11/2026)

1. **Pode construir** o vigia e a tela de Integrações.
2. **"Chamar o Admin sozinho" vem desligado de fábrica.** O cliente liga se quiser.
3. **Sem lista de integrações de fábrica.** Entra o que o agente integrar de verdade, e cada
   integração nova é anexada sozinha ao mapa.
4. **Layout:** ícones do DG Claw e linhas retas, com os nós a distâncias um pouco diferentes.
5. Antes de construir, revisão do plano pelo Codex.

## 7. O que a revisão do Codex mudou

| Ponto | Mudança |
| --- | --- |
| Texto livre do provedor ia para o Admin root | O pedido é montado pelo Web só com frases fixas e campos de lista fechada |
| O quadro de avisos não entrega ao Admin; faixa visível a colaborador | Pedido manual pelo atalho da tela Segurança; automático pelo runner do Admin, só pelo dono; faixa só para o dono |
| `estado.json` lido como root sem cuidado | Leitura blindada (3.5) |
| `integracoes.json` escolhendo URL e chave | Cortado: integração própria entra por evento e fica passiva |
| `registrar` forjando estado | Lista fechada, limites, e os limites do pedido automático documentados |
| Detalhe livre vazando pelo relatório do pulso | Nada de texto livre no registro |
| Histerese incoerente com intervalos de 6 h | Sem sonda periódica na primeira entrega; vermelho exige duas observações distintas |
| Faixa dos 7 dias podia nunca abrir | Elegibilidade reavaliada a cada tentativa real, incidente persistido |
| Ledger não cria linha na Operações | Promessa cortada; a fonte da tela é o `estado.json` |
| Frontmatter recriando lista de fábrica | Frontmatter só anota; quem cria o nó é o evento |
| Timer de 1 minuto | Cortado; eventos na hora, conferência ativa futura no batimento |
| Sondas sem prova de gratuidade | Viraram fase 5, homologadas uma a uma |
| "Sem internet" sem prova | "Várias integrações com defeito" |
| Paridade | `.agents/skills` no leitor e prova nos dois motores |
| Só a cor no celular | Palavra do estado sempre ao lado |
