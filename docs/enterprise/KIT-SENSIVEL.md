# Kit "skill com dado sensível" (bloco I)

Proteção da matriz: `kit_sensivel` (liga sozinha em `empresa` e `regulado`, travada em `regulado`).
O padrão, o porquê e o passo a passo para criar uma ferramenta estão em `SKILL-SENSIVEL.md`. Este arquivo descreve as peças.

## O problema

Uma skill que lê o plano de saúde, a folha ou a carteira de clientes de uma empresa mexe com dado pessoal, e boa parte dele é
sensível (LGPD, art. 11). Se o agente tem a credencial do banco, a skill vira só uma sugestão: um funcionário curioso ou uma
instrução escondida num documento faz o agente consultar o banco direto. E tudo o que o script imprime no terminal vai para o
histórico da conversa, para o índice de busca e para o backup.

A solução é tirar a credencial e o dado bruto do alcance do agente. Ele aciona uma **operação com nome e parâmetros** e recebe
de volta um **resultado agregado, pseudonimizado e conferido**.

## As peças

```
 container do agente                  servidor (host)
┌──────────────────────┐   caixa   ┌──────────────┐  socket unix   ┌─────────────────────────┐
│ agente (Claude)      │─────────▶│ DG Claw Web  │───────────────▶│ dgclaw-ferramentas      │
│ dgclaw-ferramenta    │ arquivos │ rotas, nível │ /run/dgclaw-   │ usuário sem privilégio  │
│ sem credencial       │◀─────────│ auditoria    │ ferramentas/   │ esquema, executor,      │
└──────────────────────┘          └──────────────┘ ferramentas.sock│ verificador de saída    │
                                                                    └───────────┬─────────────┘
                                                              processo filho, ambiente limpo
                                                              credenciais.env só desta ferramenta
                                                                    ▼
                                                              base da empresa (rede)
```

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Serviço | `ferramentas/servidor.js` | Escuta o socket, uma linha JSON por pedido. Node 22 sem dependência. Recusa subir como root. |
| Núcleo | `ferramentas/nucleo.js` | Acha as ferramentas, confere o agente e os parâmetros, roda o executor, passa a saída pelo verificador. |
| Esquema | `ferramentas/esquema.js` | Valida `ferramenta.json` e os parâmetros à mão. Catálogo fechado: parâmetro que não está no esquema é recusado. |
| Verificador | `ferramentas/verificador.js` | Procura CPF, CNPJ, e-mail, telefone, data de nascimento, cartão e nomes da base na saída. |
| Biblioteca | `ferramentas/lib/dgclaw_ferramenta.py` | `pseudonimizar`, `agregar`, `resultado` para o executor em Python. |
| Teste sintético | `ferramentas/testar.js` | Roda o `teste.json` da ferramenta contra o núcleo, com base falsa. |
| Rotas | `web/lib/ent/ferramentas.js` | `GET /api/v1/ferramentas`, `POST /api/v1/ferramentas/<nome>`, auditoria e entrega de relatório. |
| Cliente do agente | `bin/dgclaw-ferramenta` | O comando que o agente usa dentro do container (fala pela caixa, `dgclaw-api`). |
| Entregas com prazo | `web/lib/entregas-expiram.js` | Apaga relatório e `.expira` quando o prazo passa. |
| CLI do host | `lib/enterprise/kit-sensivel.sh` | `dgclaw ferramenta criar\|listar\|testar\|credencial\|abrir\|chave\|ficha\|skill`, instalação e status. |
| Modelos | `templates/ferramenta-sensivel/`, `templates/skill-sensivel/` | O exemplo `carteira.resumo`, a skill e a ficha. |

## Uma ferramenta

Uma pasta em `/etc/dgclaw/ferramentas/<nome>/` (dono `dgclaw-ferramentas`, modo 750):

| Arquivo | Para quê |
| --- | --- |
| `ferramenta.json` | Nome, descrição, agentes que podem usar, esquema dos parâmetros, finalidade, base legal, campos usados, `retencao_dias`, responsável, `minimo_grupo` (padrão 10), `timeout_s` (padrão 20, máximo 25), `memoria_mb` (padrão 512), `gera_arquivo`. |
| `executor.py` ou `executor.js` | Lê a base e entrega o resultado. Roda num processo filho. |
| `credenciais.env` | `CHAVE=valor`, modo 600. Com `cofre_cifrado` ligado fica só o `credenciais.env.cred`. |
| `nomes-proibidos.txt` | Opcional: um nome por linha, que o verificador procura na saída. |
| `teste.json` e `teste/` | O teste sintético (base falsa, casos, executor malicioso). |

O nome pode ter um ponto (`carteira` ou `carteira.resumo`). O campo `nome` precisa ser igual ao nome da pasta. Os textos
`finalidade`, `base_legal`, `descricao` e `responsavel` não podem ficar com o `PREENCHER` que o `criar` deixa: a ferramenta
não carrega até alguém escrever o conteúdo real, porque ele alimenta o relatório de impacto.

### Parâmetros

Tipos: `texto` (exige `regex`, até 200 caracteres, sem quebra de linha), `inteiro`, `numero`, `booleano`, `enum`, `periodo`
(AAAA-MM) e `data` (AAAA-MM-DD, data real). Campo que o esquema não declara é recusado com o nome do campo e a lista dos
aceitos. Não existe consulta livre. No executor, o texto que veio do agente nunca entra em SQL por concatenação: a
coluna ou a tabela sai de uma lista fechada, o valor vai como parâmetro da consulta.

### O processo filho

- Ambiente **limpo**: só `PATH`, `HOME`/`TMPDIR` (a pasta temporária), `LANG`, `PYTHONPATH` (a biblioteca) e as chaves do
  `credenciais.env` daquela ferramenta, mais `DGCLAW_FERRAMENTA`, `DGCLAW_SAIDA_DIR`, `DGCLAW_MINIMO_GRUPO` e
  `DGCLAW_CHAVE_PSEUDONIMO`. Nenhuma variável do serviço ou do Web chega ao executor.
- Pasta temporária própria (`mkdtemp`, modo 700) **apagada no fim**, também quando o executor falha ou estoura o tempo.
- Tempo: `timeout_s`; ao estourar, o grupo de processos inteiro leva `SIGKILL` e a resposta é `tempo_esgotado`.
- Memória: `ulimit -v` para Python; `--max-old-space-size` para Node. Estouro vira `memoria_esgotada`.
- No máximo 4 execuções ao mesmo tempo; a quinta recebe `ocupado`.
- Saída: até 256 KB no stdout; relatório em arquivo até 2 MB, com extensão `.csv`, `.txt`, `.md`, `.json` ou `.html`.
- O que o executor escreve no stderr vai só para o log do servidor (cortado e com segredos mascarados). O agente nunca o vê.

### Protocolo do executor

Entrada pelo stdin: `{"ferramenta", "params", "minimo_grupo"}`. Saída: o resultado (objeto ou lista JSON) no **stdout** e
os metadados no **canal 3** (`{"registros_lidos": N, "nomes_proibidos": [...], "arquivo": "relatorio.csv"}`). A biblioteca
Python faz os dois com `resultado(...)`. Um executor em JavaScript escreve o mesmo no stdout e no descritor 3.
`registros_lidos` que o executor não informa vira `null` na auditoria (não medido), nunca zero.

## O verificador de saída

Roda no serviço, depois do executor e antes de devolver. Varre todo texto e todo número do resultado (chaves incluídas) e o
conteúdo do relatório em arquivo:

| Tipo | Regra |
| --- | --- |
| `cpf` | 11 dígitos, com ou sem pontuação, dígito verificador válido, não repetido |
| `cnpj` | 14 dígitos, com ou sem pontuação, dígito verificador válido |
| `email` | `algo@dominio.tld` |
| `telefone` | Com DDD válido e pontuação, `+55`, ou 11 dígitos crus de celular (10 dígitos crus não contam: quase sempre é uma soma) |
| `data_nascimento` | Data de dia completo (`dd/mm/aaaa` ou `aaaa-mm-dd`, data real) de um ano anterior ao atual |
| `cartao` | 13 a 19 dígitos que passam no Luhn |
| `nome` | Nome de `nomes_proibidos` (do executor, pelo canal 3) ou de `nomes-proibidos.txt`, sem diferenciar acento nem maiúscula, só palavra inteira, ignora nomes de menos de 4 letras |

Se achar qualquer um, **bloqueia a resposta inteira**: o agente recebe só "O resultado foi bloqueado porque continha dado
pessoal (tipo X)", a auditoria registra o motivo e os tipos, e **nada do dado** vai para a resposta, para o log ou para a
trilha. Uma ferramenta pode renunciar só à `data_nascimento` (`"permitir_tipos": ["data_nascimento"]`), quando datas de dia
completo são legítimas no resultado. CPF, CNPJ, e-mail, telefone, cartão e nomes nunca são liberáveis.

É uma rede contra erro do executor, não contra um executor mal-intencionado (quem o escreve é de confiança). Um relatório
que escreve o CPF com letras no meio passa.

## Rotas e quem pode usar

| Rota | Quem | Resposta |
| --- | --- | --- |
| `GET /api/v1/ferramentas` | agente comum, pela caixa | só as ferramentas em que o agente está listado (nome, descrição, esquema; sem ficha, sem credencial) |
| `POST /api/v1/ferramentas/<nome>` corpo `{"params": {...}}` | agente comum listado | 200 com o resultado; 400 parâmetro; 403 agente não listado; 404 ferramenta; 422 bloqueado; 429 ocupado; 502/504 falha do executor; 503 serviço fora ou auditoria indisponível |

O Admin, o navegador (inclusive o TI) e quem não tem sessão não usam estas rotas (403 ou 401). Com `kit_sensivel` desligado
o módulo não responde a nada e a rota cai no 404 de sempre. O serviço confere o agente de novo (defesa em profundidade): o Web
manda o `agente` da caixa, e a ferramenta só roda se ele estiver na lista dela.

### Auditoria (`ferramenta_usada`, origem `ferramentas`)

Gravada **no Web** (o serviço roda sem privilégio e não escreve na trilha). Campos: `agente`, `usuario_dono`, `ferramenta`,
`parametros` (texto mascarado e cortado), `registros_lidos`, `hash_resultado` (sha256 do resultado entregue; `null` quando
bloqueado, porque o hash de um CPF se quebra por força bruta), `duracao_ms`, `decisao` (`liberado`, `recusado`,
`bloqueado`), `motivo`, `tipos`, `arquivo`. **Se a trilha está ligada e a gravação falha, o resultado não é entregue**
(503 `auditoria_indisponivel`): sem registro de acesso, sem dado.

### Relatório com prazo

Quando a ferramenta declara `gera_arquivo: true` e o executor grava um arquivo, o Web o grava em
`<casa do agente>/.dgclaw/entregas/<AAAAMMDDTHHMMSS>-<nome>` (modo 600, dono da casa, pelo gravador seguro) junto de um
`<nome>.expira` com a data ISO (`retencao_dias` a partir de agora). A resposta ao agente traz o caminho e `expira_em`. O Web
varre as entregas a cada hora e apaga o relatório e o `.expira` vencidos; marca sem data válida mantém o relatório e avisa
no log; pasta `entregas` que é atalho não é varrida.

## Serviço no systemd

`dgclaw-ferramentas.service`: `User=dgclaw-ferramentas` (sem login), `RuntimeDirectory=dgclaw-ferramentas` (o socket fica em
`/run/dgclaw-ferramentas/ferramentas.sock`, modo 600), `CapabilityBoundingSet=` vazio, `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`, `PrivateDevices`, `SystemCallFilter=@system-service`, `MemoryMax=2G`. O `ExecStartPre=+-` roda
`dgclaw ferramenta abrir` como root para decifrar as credenciais para a memória (`/run/dgclaw/ferramentas-cred/<nome>/`, 700,
dono do serviço). `MemoryDenyWriteExecute` fica de fora porque o JIT do Node precisa dele. O executor precisa falar com o
banco da empresa, então `AF_INET` e `AF_INET6` ficam abertos; para limitar a rede a um endereço, use um drop-in com
`IPAddressDeny=any` e `IPAddressAllow=<banco>`.

O serviço **não lê** `/etc/dgclaw/protecoes.json` (é do root). Quem confere o nível é o Web. O instalador (`ent_instalar_kit_sensivel`)
e o `dgclaw protecoes aplicar` só montam o serviço com a proteção ligada; desligá-la tira as rotas do Web, mas não desinstala o serviço.

### Credencial

`printf 'BASE_URL=...\nBASE_SENHA=...\n' | dgclaw ferramenta credencial <nome>` (stdin, nunca argumento: argumento vai para o
histórico do shell). Com `cofre_cifrado` ligado o arquivo vira `credenciais.env.cred` (`systemd-creds`, `--name=dgclaw-ferramenta-<nome>`)
e a cópia em claro existe só em `/run`. Sem ele, fica em `credenciais.env` modo 600. O ideal é que a credencial seja de um usuário
**só de leitura** do banco, restrito a uma visão com os campos necessários.

## Limites (leia antes de prometer algo ao cliente)

- **Pseudonimizado ainda é dado pessoal** (LGPD). O HMAC com a chave da empresa evita que o nome ou o CPF apareçam, não anonimiza.
  Trocar a chave (`chave-pseudonimo`) muda todos os pseudônimos; por isso o `dgclaw ferramenta chave` nunca sobrescreve.
- **Agregado com grupo pequeno identifica.** O mínimo (10 por padrão) suprime o grupo, mas a diferença entre dois totais ou
  consultas sobrepostas pode revelar o número escondido. Isso não é detectado; revise o mínimo e os parâmetros que a ferramenta aceita.
- **O executor roda com o mesmo usuário do serviço.** Um executor enxerga as pastas das outras ferramentas. Quem precisa de
  separação entre ferramentas usa um serviço por ferramenta (`DynamicUser`).
- **O texto do resultado fica no histórico da conversa do agente**, sob a retenção geral (`retencao_dias`). O que a ferramenta
  devolve já é agregado; mesmo assim, não devolva mais do que a pergunta precisa.
- **Resposta em até 25 s.** O Web responde ao agente pela caixa, que espera 30 s. Ferramenta mais lenta precisa de relatório
  assíncrono, que este bloco não faz.
- A varredura das entregas roda como root numa pasta que o agente controla (mesma limitação do `retencao.py`): ela recusa atalho
  e confere a pasta, mas um agente malicioso poderia trocar a pasta entre a conferência e o `unlink`.

## Testes

- `web/test/ent-ferramentas.test.js`: verificador, esquema, núcleo com executor de verdade, exemplo, socket (28 testes).
- `web/test/ent-ferramentas-web.test.js`: rotas pela caixa, auditoria, relatório com prazo, níveis (12 testes).
- `tests/enterprise/kit-sensivel.test.sh`: CLI, unidade do systemd, credencial em claro e cifrada, ficha, skill. Os comandos de sistema
  (`useradd`, `getent`, `chown`, `systemctl`, `systemd-creds`) são stubs, e o teste aborta se algum deles não for o stub.
- `bin/test/dgclaw-ferramenta.test.sh`: o cliente do agente, com `dgclaw-api` de mentira.
- O teste sintético da ferramenta de exemplo roda também com `dgclaw ferramenta testar templates/ferramenta-sensivel/exemplo-carteira`.

### Só dá para provar numa máquina real (teste manual)

1. `dgclaw protecoes aplicar` num servidor `empresa`: o usuário `dgclaw-ferramentas` nasce, a unidade sobe, o socket aparece em
   `/run/dgclaw-ferramentas/` e o Web (root) abre o socket.
2. O hardening do systemd com Python e Node de verdade (`SystemCallFilter=@system-service`, `ProtectSystem=strict`): rodar
   `carteira.resumo` e conferir que não há `SIGSYS` no `journalctl -u dgclaw-ferramentas`.
3. `ulimit -v` com o driver real do banco (psycopg, pyodbc e afins reservam muita memória virtual): ajustar `memoria_mb`.
4. O `ExecStartPre=+-` abrindo as credenciais cifradas no boot, depois do disco e do cofre cifrados.
5. O fluxo inteiro pelo container: imagem reconstruída com o `dgclaw-ferramenta`, o agente chamando pela caixa, a resposta voltando
   dentro dos 30 s, o relatório aparecendo na pasta de entregas e sumindo no prazo.
6. `dgclaw atualizar` e o rollback preservam `/etc/dgclaw/ferramentas` (credenciais e chave de pseudônimo).
