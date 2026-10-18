# Plano de resposta a incidente de segurança

Para quem administra uma instalação do DG Claw nos níveis `escritorio`, `empresa` ou `regulado`. Imprima, preencha os
contatos da última seção e deixe num lugar que não dependa do próprio servidor.

## 1. O que é um incidente

Incidente é qualquer fato que ponha em risco a confidencialidade, a integridade ou a disponibilidade de dados da
instalação, principalmente dados pessoais. Exemplos que já valem como incidente, mesmo sem prova de dano:

- alguém de fora entrou no painel, no servidor ou numa casa de agente, ou existe suspeita séria disso;
- a senha do painel, uma chave de API, o segredo de um bot ou um token foi exposto (publicado, enviado ao lugar
  errado, visto por quem não devia);
- um agente fez o que não devia com dado de terceiros (mandou mensagem ao destinatário errado, publicou arquivo);
- servidor, disco ou backup perdido, roubado ou apagado;
- um alerta do monitor (`dgclaw monitor`) que sugere invasão: cerca de rede que sumiu sozinha, serviço desconhecido,
  login que ninguém fez;
- a trilha de auditoria com a corrente de hashes quebrada.

Na dúvida, trate como incidente e descarte depois. Registrar um alarme falso custa uma página; ignorar um incidente
real custa o prazo legal.

## 2. Quem faz o quê

| Papel | Quem é | O que faz no incidente |
| --- | --- | --- |
| Controladora | a empresa dona dos dados | decide, comunica a ANPD e os titulares |
| Operador(a) | quem administra o DG Claw (TI interna ou contratada) | contém, preserva evidência, avisa a controladora em até 24 h |
| Encarregado(a) (DPO) | pessoa indicada pela controladora | recebe o aviso, conduz a comunicação à ANPD |

Os nomes e os telefones ficam na seção 8.

## 3. As primeiras 2 horas

Anote a hora de cada passo (relógio do servidor: `date -u`). O horário em que a empresa **soube** do incidente é o
que conta para o prazo.

### Até 15 minutos: não piorar

1. Anote quem avisou, o que viu e quando. Abra um arquivo de registro (modelo na seção 7).
2. **Não apague nada**, não reinicie o servidor e não rode `dgclaw retencao` nem `dgclaw titular`: eles alteram
   exatamente o que a investigação vai precisar. Pare o timer da retenção:
   `systemctl stop dgclaw-retencao.timer`.
3. Veja o estado: `dgclaw status` e `dgclaw monitor verificar`. Guarde a saída.

### Até 1 hora: conter

Escolha só o que o caso pede, do mais leve ao mais forte.

- **Parar um agente suspeito:** `dgclaw agente parar <slug>`. A casa dele fica intacta no disco (é a evidência).
- **Senha do painel exposta:** `dgclaw senha trocar` (a nova senha vem pelo STDIN). O comando reinicia o `dgclaw-web`.
  A troca de senha não encerra as sessões que já estão abertas; para derrubar todas:
  ```bash
  systemctl stop dgclaw-web
  mv /var/lib/dgclaw/web/sessoes.json /var/lib/dgclaw/web/sessoes.json.incidente
  systemctl start dgclaw-web
  ```
  Todo mundo precisará entrar de novo. O arquivo movido fica como evidência.
- **Link de primeiro acesso vazado:** `dgclaw primeiro-acesso` gera um novo, e o anterior deixa de valer.
- **Chave de API exposta (cofre de um agente):** revogue **no site do provedor** (Anthropic, OpenAI, o que for) e
  depois tire do cofre: `dgclaw agente cofre <slug> revogar NOME`. Guarde a nova chave com
  `printf %s "$CHAVE_NOVA" | dgclaw agente cofre <slug> guardar NOME --aplicar`. A chave nova nunca vai na linha de
  comando.
- **Segredo do bot de alerta ou URL de webhook exposta:** gere um novo no @BotFather (ou no serviço do webhook) e
  rode `dgclaw monitor configurar`.
- **Casa de agente que pode ter sido invadida por dentro** (o agente leu algo malicioso e agiu): pare o agente,
  preserve a casa (seção 4) e crie um agente novo com `dgclaw agente criar`. Migre só a memória que você revisou e
  confia. Depois `dgclaw agente remover <slug> --sim`: ele não apaga, move a casa para
  `/var/lib/dgclaw/aposentados/`, onde ela continua como evidência.
- **Servidor inteiro comprometido:** desligue a máquina pelo painel do provedor **sem apagar o disco**, tire um
  snapshot do disco no provedor e restaure a partir de um backup anterior ao incidente numa máquina nova
  (`docs/enterprise`, bloco de backup). Troque também o acesso SSH e as chaves do provedor de nuvem.

### Até 2 horas: entender o tamanho

Preencha o que for possível no registro (seção 7). Se ainda não der para responder, escreva "não sei ainda" e a hora
em que vai saber:

- que dados: conversas, memória, anexos, credenciais? De clientes, funcionários, menores de idade? Há dado sensível
  (saúde, origem racial, biometria, opinião política, religião, vida sexual) ou financeiro?
- de quantas pessoas (a estimativa serve);
- desde quando e até quando (do primeiro sinal ao instante em que a contenção funcionou);
- como entrou ou vazou (a causa provável) e se continua acontecendo.

Passou das 2 horas: avise a controladora **agora**, com o que sabe (seção 6). O aviso de 24 h é o limite, e quanto
antes a controladora souber, mais folga ela tem dentro dos 3 dias úteis.

## 4. Preservar a evidência

Faça cópias; **não mexa nos originais**. Crie uma pasta fora das casas dos agentes, só do root:

```bash
EV=/root/incidente-$(date -u +%Y%m%dT%H%M%SZ); mkdir -m 700 "$EV"
```

Guarde, nesta ordem (a mais volátil primeiro):

1. Estado em memória e rede: `ss -tunap > "$EV/rede.txt"`, `ps auxf > "$EV/processos.txt"`, `last -a > "$EV/logins.txt"`,
   `iptables -S > "$EV/iptables.txt"`, `podman ps -a > "$EV/containers.txt"`.
2. A trilha de auditoria e os logs: `cp -a /var/log/dgclaw "$EV/log-dgclaw"`. A trilha
   (`auditoria.jsonl`) é uma corrente de hashes; confira se está íntegra e guarde o resultado:
   ```bash
   node -e "const {criarAuditoria}=require('/opt/dgclaw/app/web/lib/auditoria'); const r=criarAuditoria({caminho:'/var/log/dgclaw/auditoria.jsonl'}).verificar(); console.log(JSON.stringify(r))" > "$EV/auditoria-verificada.json"
   ```
   Se vier `"ok":false`, o campo `quebradaEm` aponta a linha em que a corrente foi alterada: essa é uma informação
   central do incidente.
3. O journal do sistema do período: `journalctl --since "<data e hora>" > "$EV/journal.txt"`; e dos serviços:
   `journalctl -u dgclaw-web -u dgclaw-admin -u caddy > "$EV/servicos.txt"`.
4. O monitor: `cp -a /var/lib/dgclaw/monitor "$EV/monitor"` (mostra os alertas abertos e desde quando).
5. A casa do agente envolvido, sem desmontar nada: `tar -C /var/lib/dgclaw/agentes -cpf "$EV/agente-<slug>.tar" <slug>`.
   Os transcripts (`home/.claude/projects/**/*.jsonl`) mostram o que o agente leu e fez.
6. Versão e nível: `dgclaw versao > "$EV/versao.txt"` e `dgclaw nivel > "$EV/nivel.txt"`.
7. **Um backup anterior ao incidente**: marque-o para não expirar. A rotação do backup (`backup_retencao_dias`) apaga
   cópias velhas; copie a mais antiga que for confiável para fora do ciclo.
8. Fotografe ou salve a tela e o texto de qualquer alerta recebido (e-mail, Telegram, aviso do provedor).

Ao terminar, gere a lista de integridade: `(cd "$EV" && find . -type f -print0 | xargs -0 sha256sum > SHA256SUMS)` e
guarde uma cópia do `SHA256SUMS` fora do servidor. Quem recebe a pasta não deve poder dizer que algo mudou depois.

Depois de preservar, a contenção definitiva pode apagar chaves e recriar agentes. Religue o timer da retenção
(`systemctl start dgclaw-retencao.timer`) só quando a investigação acabar.

## 5. Revogar e trocar

Depois de conter, troque tudo que a pessoa ou o programa invasor pode ter visto. Marque na lista:

- [ ] senha do painel (`dgclaw senha trocar`) e sessões (seção 3);
- [ ] chaves de API de cada agente afetado (`dgclaw agente cofre ...`), revogadas **também no provedor**;
- [ ] segredo do bot de alertas e URLs de webhook e de ping (`dgclaw monitor configurar`);
- [ ] chaves SSH e senhas do provedor de nuvem;
- [ ] a chave do cofre cifrado e a senha do backup, se o disco foi exposto;
- [ ] login do Claude (`/login`) dos agentes afetados, e a organização fixada: `dgclaw nivel org <uuid>`;
- [ ] tokens do Telegram, WhatsApp e demais canais ligados aos agentes afetados (`dgclaw-agente canal ...`).

## 6. Comunicar

### 6.1 Do operador à controladora: em até 24 horas

Assim que houver **suspeita razoável** de que dado pessoal foi afetado, o operador avisa a controladora e o
encarregado por escrito (e-mail e uma mensagem). Não espere ter certeza nem a causa: avise com o que sabe e diga o que
ainda investiga. O limite interno é **24 horas** do momento em que o operador soube.

### 6.2 Da controladora à ANPD: em 3 dias úteis

O Regulamento de Comunicação de Incidente de Segurança da ANPD (Resolução CD/ANPD nº 15/2024) manda a controladora
comunicar à ANPD e aos titulares o incidente que possa acarretar risco ou dano relevante, **em 3 dias úteis contados
do conhecimento de que o incidente afetou dados pessoais**. Por isso as 24 horas acima: o prazo da controladora já
está correndo quando o operador demora.

O que a comunicação precisa trazer (resumo, confira o texto vigente): descrição do incidente e dos dados envolvidos,
número de titulares, riscos e medidas já tomadas, dados do encarregado, e o motivo se a comunicação aos titulares
ainda não foi feita. A ANPD recebe a comunicação pelo formulário que ela mantém no site dela (gov.br/anpd). O
regulamento permite completar as informações depois da primeira comunicação; confirme o prazo para isso no texto
atual. A controladora também deve manter o registro do incidente por prazo mínimo previsto no regulamento
(confirme: hoje, 5 anos).

### 6.3 Aos titulares

Quando houver risco ou dano relevante, a controladora avisa as pessoas afetadas em linguagem simples: o que
aconteceu, que dados, o que a empresa já fez, o que a pessoa pode fazer (trocar senha, desconfiar de contato
estranho) e como falar com o encarregado. Quem redige e envia é a controladora; o operador entrega os fatos.

## 7. Modelos

### 7.1 Mensagem do operador à controladora (envie por e-mail e confirme por telefone)

> **Assunto:** Incidente de segurança no DG Claw, aviso inicial (`<data e hora>`)
>
> Prezados, `<nome do encarregado>` e `<nome da diretoria>`,
>
> Às `<hora>` de `<data>` tomamos conhecimento de `<o que aconteceu, em uma ou duas frases>`.
>
> **O que sabemos até agora:** `<dados possivelmente afetados>`; `<estimativa de pessoas>`; período: `<de>` até `<até>`.
> **O que ainda investigamos:** `<causa, extensão, se continua>`.
> **O que já fizemos:** `<contenção: agente parado, senha trocada, chaves revogadas>`; evidências preservadas em
> `<local>` (lista de integridade anexa).
> **O que precisamos de vocês:** decisão sobre a comunicação à ANPD (prazo de 3 dias úteis a partir de
> `<data e hora do conhecimento>`) e aos titulares.
>
> Próxima atualização: `<hora>`. Contato direto: `<nome e telefone>`.

### 7.2 Registro interno do incidente (um arquivo por incidente)

| Campo | Preencher |
| --- | --- |
| Identificação do registro | `INC-AAAA-NN` |
| Quem detectou, como e quando (UTC) | |
| Quando a empresa soube (início dos prazos) | |
| Sistemas e agentes envolvidos | |
| Dados envolvidos e categorias de titulares | |
| Quantidade estimada de titulares | |
| Causa provável | |
| Medidas de contenção e hora de cada uma | |
| Evidências guardadas (pasta, `SHA256SUMS`) | |
| Aviso à controladora (hora, por quem) | |
| Comunicação à ANPD (data, protocolo) | |
| Comunicação aos titulares (data, canal) | |
| Medidas para não repetir | |
| Encerrado em (data) e por quem | |

## 8. Contatos (preencher agora, antes de precisar)

| Papel | Nome | Telefone (fora do horário) | E-mail |
| --- | --- | --- | --- |
| Operador(a) principal | | | |
| Operador(a) reserva | | | |
| Encarregado(a) (DPO) | | | |
| Diretoria da controladora | | | |
| Jurídico | | | |
| Suporte do provedor de nuvem | | | |
| Seguradora (se houver apólice cyber) | | | |
| Suporte do DG Claw | | | |

## 9. Depois do incidente

1. Reunião curta em até 7 dias com quem atuou: linha do tempo, o que funcionou, o que faltou.
2. Corrija a causa. Se o caso mostra que o nível de proteção era baixo para o tipo de dado, suba:
   `dgclaw nivel definir empresa` (ou `regulado`) e `dgclaw protecoes aplicar`.
3. Religue o que foi pausado (`systemctl start dgclaw-retencao.timer`) e confira `dgclaw status`.
4. Atualize este plano com o que aprendeu e treine quem faltou. Revise os contatos pelo menos duas vezes por ano.
5. Guarde o registro e as evidências pelo prazo que o jurídico definir; o prazo mínimo legal da ANPD está na seção 6.2.
