# A aba Operações (uma página de status)

Desde 01/10/2026 as antigas abas **Operações** e **Pulso** são uma aba só,
chamada Operações. O Danilo, que mandou construir as duas, não sabia dizer a
diferença entre elas (uma mostrava o que estava marcado; a outra, se rodou
certo). Se quem construiu precisa perguntar, o dono do agente não tem chance.

## O que a tela mostra

Duas vistas, escolhidas no alternador do topo:

- **Situação** (abre por padrão): cada operação do sistema aparece uma vez, com
  o nome, de quanto em quanto tempo roda ("a cada 30 minutos", "todo dia às
  23:30") e uma **fileira de quadradinhos** das últimas execuções, como numa
  página de status. O mais recente fica à direita.
- **Registros**: o leitor de log de cada rotina e a "Sessão viva". É a parte
  técnica, que serve para copiar e mandar para quem cuida do agente.

Em cima de tudo, uma frase-resumo: **"Tudo funcionando"**, ou **"2 operações
pedem atenção: X e Y"** (clicar no nome leva até a linha).

### As cores

| Cor | Quer dizer |
| --- | --- |
| verde | rodou e deu certo |
| vermelho | falhou: o programa terminou com erro, ou o registro da própria rotina (o ledger do pulso) diz `erro` naquele horário. Em serviço contínuo: caiu, ou ficou fora do ar naquela hora |
| amarelo | pede atenção: foi cancelada, rodou com aviso no registro, ou (serviço contínuo) reiniciou naquela hora |
| amarelo listrado | não rodou quando devia (a cadência passou sem execução) |
| cinza | sem dado. Cinza **nunca** conta como sucesso |

Passar o mouse num quadradinho mostra data, hora, resultado e duração. No
celular, tocar na fileira mostra o mesmo texto embaixo dela; com o teclado, as
setas andam de um quadradinho para o outro.

### Os grupos

As operações são agrupadas pelo que fazem, em linguagem de quem não é técnico
(a tabela `GRUPOS` em `panel/lib/operacoes.js`):

- **Mantém ele de pé**: o agente em si (a sessão), o vigia da sessão, o vigia do
  canal, o batimento, o recibo dos recados, o painel.
- **Memória**: a reflexão da noite, o conferente dela, a remontagem da memória
  de trabalho, o fichário das conversas, a arrumação da conversa.
- **Vigilância e custos**: o aviso de orçamento, o medidor de consumo, o
  conferente das rotinas, os três pulsos do dia.
- **Poderes instalados** e **Outras rotinas do sistema**, quando existirem.

O nome de cada operação ("A reflexão da noite") e o balão dela ("o que é / pra
que serve") **não** são escritos no painel: vêm do `CATALOGO` do
`scripts/pulso-status.py`, através do `/api/pulso`. Fonte única. Para mudar o
texto, mude lá.

### A frase do topo, e como a conta é feita

Olha a **última** execução de cada operação. Uma falha de três dias atrás que
já se resolveu aparece na fileira, mas não acende alarme. O que ainda não rodou
nenhuma vez fica de fora (conta como "sem dado"), em vez de contar como
sucesso. Se o diário do sistema não pôde ser lido, a frase diz **"Não consegui
ler o histórico das operações"** com o motivo, e nunca "Tudo funcionando".

## De onde vem o dado

**O diário do systemd (journal)**, que guarda uma linha por evento de cada
unidade. Uma leitura só, de sete dias, para todas as unidades do agente:

```
journalctl -o json --since=@<7 dias atrás> -u 'dgclaw-<slug>-*.service' -u <sessão viva> -u dgclaw-panel-<slug>.service \
  MESSAGE_ID=39f53479...  (Finished: terminou bem)
  MESSAGE_ID=be02cf68...  (Failed to start: falhou)
  MESSAGE_ID=7d4958e8...  (Starting: para medir a duração)
  MESSAGE_ID=9d1aaa27...  (Stopped: serviço contínuo parou)
  MESSAGE_ID=d9b373ed...  (Failed with result: serviço contínuo caiu)
```

**Armadilha que custava uma falha invisível:** a execução que falha NÃO sai com
o id de sucesso (39f53479), sai com o be02cf68. Um filtro só pelo primeiro
pinta de verde uma rotina quebrada. Conferido no diário desta VPS em 01/10/2026
com as rotinas marcadas de um agente, que falham todo dia.

Por que o diário e não só o ledger do pulso: o ledger só tem o que cada script
decidiu anotar, e várias rotinas (vigia, arrumação da conversa, recibo dos
recados, aviso de orçamento, medidor de consumo) não anotam nada lá. O diário
cobre todas.

**O ledger entra como segunda opinião** (`<agentDir>/.dgclaw/logs/pulso/<data>.jsonl`,
nos dois formatos: `{ts,id,status,detalhe}` e o antigo `{timestamp,component,status,detail}`).
Um script pode pegar a exceção, anotar `erro` e sair "limpo": para o systemd foi
sucesso; para o dono, falhou. Então job `done` com `erro` no ledger dentro do
intervalo da execução vira vermelho, com o detalhe do ledger. O id `pulso-report`
do ledger casa com as unidades `pulso-report-1/2/3` (por prefixo).

**O amarelo de "não rodou quando devia"** é calculado pela cadência do timer:

- intervalo (`OnUnitActiveUSec=30min`): um buraco maior que duas vezes o
  intervalo entre duas execuções vira um quadradinho; parada há mais de duas
  vezes o intervalo, o último quadradinho é "está atrasada";
- calendário que o painel entende (`*-*-* 23:30`, `Mon..Fri *-*-* 09:00`,
  `*-*-05 10:00`, `daily`, `weekly`, `hourly`, com ou sem o fuso no fim): cada
  horário sem execução nos 40 minutos seguintes vira amarelo.

Limites, de propósito: horário de calendário que o painel não entende não gera
amarelo nenhum (acusar atraso sem saber ler o horário seria acusar sem prova), e
nenhum horário anterior à primeira execução que o diário conhece é cobrado (a
rotina pode ter sido instalada ontem, ou o diário pode ter sido rodado).

**Serviço contínuo** (o agente em si, o painel) não tem execução: fica de pé.
Cada quadradinho é uma hora das últimas 48, reconstruída a partir do estado de
agora (`systemctl show`) e dos eventos de subir, parar e cair.

**As rotinas marcadas pelo dono** (`dgclaw-<slug>-self-*`) ficam fora desta aba:
elas são do usuário e aparecem na Status, em "Suas rotinas".

**Agente clássico, fora de container**: o nome da unidade da sessão viva vem do
`servicoDoCanal()` do `lib/pulso.js` (config `canalService`, env
`DGCLAW_SERVICE` ou o `config.sh` do agente). Na jaula ela é
`dgclaw-runner.service`; no clássico, `dgclaw-<slug>.service`.

## Custo

O journalctl de sete dias leva perto de meio segundo e devolve milhares de
linhas. O resultado fica em cache por **45 s**, chamadas simultâneas dividem a
mesma leitura, e o "atualizar" da tela pula o cache (nunca mais de uma vez a
cada 5 s). Tudo é assíncrono (`execFile`): o painel não para enquanto o systemd
responde. A agenda (`lib/rotinas.js`) também deixou de usar `execFileSync`: era
um `systemctl show` síncrono por timer, travando o painel inteiro (vistoria de
01/10/2026, 2.2); agora é uma chamada só, assíncrona, com cache de 30 s.

## As rotas

`GET /api/operacoes[?atualizar=1]`

```json
{
  "geradoEm": "ISO",
  "janela": { "desde": "ISO", "ate": "ISO", "dias": 7 },
  "historico": { "disponivel": true, "motivo": null },
  "resumo": { "estado": "ok|atencao|sem-dado|indisponivel", "frase": "Tudo funcionando",
              "motivo": "só quando indisponivel", "total": 15, "verdes": 15, "atencao": ["<id>"], "semDado": 0 },
  "grupos": [ { "id": "de-pe", "titulo": "Mantém ele de pé", "explica": "...", "operacoes": [
    { "id": "dgclaw-bento-heartbeat", "unit": "dgclaw-bento-heartbeat.timer", "chave": "heartbeat",
      "grupo": "de-pe", "nome": "O batimento", "oQueE": "...", "praQueServe": "...", "crit": "media",
      "tipo": "rotina|servico", "cadencia": "a cada 30 minutos", "proxima": "ISO|null", "ultima": "ISO|null",
      "estado": "ok|falha|atencao|sem-dado", "frase": "rodou há 4 min e deu certo",
      "porHora": true,
      "quadrados": [ { "em": "ISO", "ate": "ISO", "cor": "verde|vermelho|amarelo|cinza",
                       "titulo": "Rodou e deu certo", "detalhe": "", "duracao": "2 s", "falta": false } ],
      "semana": { "rodadas": 329, "falhas": 0, "avisos": 0, "faltas": 0 } } ] } ],
  "rotinasDoUsuario": 2,
  "inconsistencias": [], "erroRotinas": null
}
```

`porHora` só existe em serviço contínuo. `semana.rodadas` é `null` quando não
medido (sem diário), nunca zero.

`GET /api/rotinas/usuario[?atualizar=1]`: as rotinas que o DONO pediu.

```json
{ "rotinas": [ { "id": "...", "unit": "dgclaw-ana-self-resumo-do-dia.timer", "nome": "resumo-do-dia",
    "descricao": "...", "recado": "o texto que ele recebe quando dispara", "quando": "todo dia às 09:00",
    "proxima": "ISO", "ultima": "ISO", "ativo": true,
    "ultimoResultado": "ok|falha|atencao|null", "ultimoTitulo": "...", "ultimoDetalhe": "", "quadrados": [] } ],
  "inconsistencias": [ { "nome": "...", "motivo": "está no manifesto, mas não existe timer" } ],
  "historico": { "disponivel": true, "motivo": null }, "erro": null, "geradoEm": "ISO" }
```

`ultimoResultado: null` quer dizer não medido (nunca rodou, ou sem diário). Não
vira "deu certo".

O `GET /api/pulso` continua existindo, igual, para quem já o usa (o
`pulso-report.sh`, por exemplo). Ele só saiu da tela.

## O que o dono decide com esta tela

Quase sempre, nada: tudo verde, segue a vida. Com vermelho ou amarelo, e o
agente estranho, as duas coisas provavelmente estão ligadas, e o dono já tem a
informação certa para pedir ajuda: qual operação, quando, e o que o registro
dela diz (vista Registros).

## Arquivos

- `panel/lib/operacoes.js`: a leitura do diário, o cruzamento com o ledger, as
  cores, os grupos e o resumo.
- `panel/lib/rotas-painel.js`: as rotas.
- `panel/public/js/operacoes.js` e `panel/public/css/operacoes.css`: a tela.
- `panel/test-operacoes.mjs`: confere as cores nos casos que já enganaram.
