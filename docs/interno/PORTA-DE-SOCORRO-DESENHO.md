# Porta de socorro: desenho de segurança (frente 3, para aprovação)

Status: **proposta, aguardando o ok do Danilo. Nada disto está implementado.**

## O problema

Em 10/11/2026 o disco da VPS principal chegou a 399 de 400 GB. O Danilo ficou sem conseguir entrar por
nenhum caminho, e o cofre do Bunker voltou trancado. Num cliente com a IA atendendo no WhatsApp, isso
quer dizer clientes sem resposta até alguém perceber e conseguir entrar.

A sentinela (frentes 1 e 2) diminui muito a chance de chegar nesse ponto: avisa a partir de 75%, limpa
o que é reconstruível sozinha e guarda uma reserva de disco que ela solta perto dos 97%. A porta de
socorro serve para quando, mesmo assim, ninguém consegue entrar: uma pessoa de confiança, de fora,
olha o que está acontecendo e destrava o servidor com um pequeno conjunto de ações.

## A regra principal

**A porta não é um terminal.** Ela não executa comando digitado, não recebe arquivo, não aceita
caminho escrito à mão e não mexe em nada fora de uma lista fechada de ações escrita no código. Quem
roubar a chave consegue, no pior caso, fazer só o que a lista permite, e cada ação fica registrada e é
avisada ao dono na hora.

## Duas portas possíveis (decisão do Danilo)

### Opção A (recomendada para começar): pelo Telegram, sem nenhuma porta aberta

Um robô de Telegram que roda dentro da VPS e **busca** as mensagens no Telegram (a VPS liga para fora;
ninguém liga para dentro). Não abre porta nenhuma no servidor, então não há o que um robô da internet
encontrar e atacar.

- Só respondem os chats cadastrados (o dono e as pessoas de confiança, pelo id do chat).
- Ver o estado (disco, memória, agentes) é com um toque: `/estado`.
- Toda ação que muda algo (liberar reserva, faxina, apagar uma pasta, reiniciar) pede **o código de 6
  dígitos do aplicativo autenticador** da pessoa (Google Authenticator, Authy, 1Password). Quem invadir
  o Telegram de alguém ainda não tem o celular com o autenticador.
- Botões na própria conversa: "Liberar reserva", "Faxina", "Ver maiores pastas", "Apagar esta",
  "Reiniciar agente X".
- **Limite:** depende de o servidor ainda ter rede e de o processo estar vivo. Se a VPS travou de vez,
  nenhuma porta resolve: aí o que vale é o pulso externo (que avisa em minutos) e o console da
  hospedagem.

### Opção B: uma telinha web própria, numa porta separada

Uma página mínima em `https://<domínio>:8442`, servida por um processo próprio (não pelo Caddy, para
continuar no ar se o Caddy morrer). É a mesma lista de ações, com login.

- Porta **fechada de fábrica**. Abre só quando o dono liga (`sudo dgclaw socorro ligar`) e pode ficar
  limitada a uma lista de IPs ou só ao Tailscale.
- Mais exposta que a opção A: qualquer pessoa na internet consegue bater na porta. Por isso leva as
  travas de tentativa descritas abaixo.

Proposta: fazer a **A primeiro** (menos superfície, chega no celular, aproveita o Telegram que a
sentinela já usa para avisar) e a **B como opcional**, para quem não usa Telegram.

## Autenticação

| Peça | Como funciona |
| --- | --- |
| Quem pode | Uma lista de pessoas com nome ("Danilo", "Fernando"). Cada uma tem a sua chave, o seu autenticador e, na opção A, o seu chat do Telegram. Revogar uma pessoa é datar a revogação; o registro fica. |
| Chave (opção B) | 32 bytes aleatórios mostrados **uma vez** na criação. No disco fica só o hash (SHA-256 com um segredo do servidor). |
| Segundo fator | Código TOTP de 6 dígitos (o padrão dos aplicativos autenticadores). Cada código vale uma vez: o servidor guarda o último usado por pessoa e recusa repetição. |
| Quem cadastra | **Só pelo terminal do servidor, como root:** `sudo dgclaw socorro pessoa adicionar --nome "Fernando"`. A porta não cadastra ninguém, não troca chave e não lista chave. Nenhuma chave gerencia chaves. |
| Sessão (opção B) | Depois do login, uma sessão de 10 minutos, só em memória, cookie `HttpOnly; Secure; SameSite=Strict`, presa ao IP. Ação que apaga ou reinicia pede um código TOTP **novo** na hora. |
| Confirmação extra (opcional) | Para apagar ou reiniciar o servidor inteiro, a ação pode exigir também o "ok" do dono no Telegram dele. Ligável por configuração. |

## Limite de tentativas

- 5 falhas em 15 minutos vindas do mesmo IP (ou do mesmo chat): esse IP fica bloqueado por 1 hora.
- 20 falhas em 1 hora no total: a porta **se fecha sozinha** por 1 hora e avisa o dono (Telegram e
  e-mail da sentinela). Isso segura ataque distribuído.
- Comparação de chave e código em tempo constante. Resposta de erro igual para "chave errada" e "código
  errado", para não ensinar ao atacante qual das duas acertou.
- Pedido com mais de 8 KB é recusado sem ler o resto.

## A lista fechada de ações

| Ação | O que faz | Pede código novo? |
| --- | --- | --- |
| Ver estado | Disco, memória, carga, serviços, agentes. Mede na hora, não depende da sentinela | não |
| Ver maiores pastas | `du` com tempo limite; cada pasta da resposta ganha um número que vale 10 minutos | não |
| Liberar reserva | Apaga o balão de disco da sentinela | sim |
| Faxina | Roda o catálogo fechado da sentinela (`faxina.json`) e diz quanto liberou | sim |
| Apagar uma pasta da lista | Só um número que veio do "ver maiores pastas", e só se a pasta estiver dentro das **áreas apagáveis** (abaixo) | sim |
| Fechar o navegador de um agente | Para `dgclaw-tela-chrome` dentro do container dele | sim |
| Reiniciar | Só da lista: um agente, `dgclaw-web`, `dgclaw-admin`, `caddy` | sim |
| Reiniciar o servidor inteiro | Com código novo e confirmação escrita ("REINICIAR") | sim, e opcionalmente ok do dono |

**Áreas apagáveis (configuráveis, com padrão conservador):** downloads e caches das casas dos agentes,
`/tmp`, `/var/tmp`, logs girados. **Nunca apagáveis, mesmo que a configuração diga o contrário:**
`/etc`, `/usr`, `/boot`, `/bin`, `/lib`, `/var/lib/dgclaw/web`, `/var/lib/dgclaw/seguranca`,
o cofre e os segredos dos agentes, as conversas (`.claude/projects`), a memória dos agentes, bancos de
dados (`.db`, `.sqlite`), `.env`, `.git`. A remoção usa a mesma técnica à prova de link simbólico da
faxina da sentinela (descer pasta por pasta sem seguir link e apagar pelo descritor), porque a casa do
agente é controlada por um agente que conversa com estranhos.

## Separação de privilégio

São **dois processos**, para que um defeito na parte que fala com a internet não vire acesso de root:

1. **Porteiro** (usuário próprio, sem root): fala com o Telegram ou serve a telinha, confere chave,
   código e limite de tentativas, e manda para o executor só um pedido curto em JSON
   (`{"pessoa": "fernando", "acao": "apagar", "item": 7}`) por um socket local.
2. **Executor** (root): aceita só esse formato, só ações da lista e só números de item que ele mesmo
   gerou. Não recebe caminho, comando nem texto livre. Registra tudo.

Endurecimento do systemd no porteiro: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
`PrivateTmp`, `RestrictAddressFamilies` só com rede e socket local, `MemoryMax`.

## Sobreviver quando o resto está sufocado

- `MemoryMin=64M` nos dois processos: o kernel reserva essa memória para eles mesmo com o servidor
  apertado. `OOMScoreAdjust=-1000`: eles são os últimos a morrer por falta de memória.
- Biblioteca padrão do Python, sem dependência baixada: nada para quebrar numa atualização.
- Registro gravado num arquivo **pré-alocado** de 20 MB (escreve dentro do espaço já reservado). E o
  executor roda como root, que pode usar os 5% do disco que o sistema guarda só para o root.
- Não dependem do Web, do Admin, do Caddy nem do Bunker.

## Registro e aviso

Cada tentativa (certa ou errada) e cada ação vira uma linha: quando, quem, de onde (IP ou chat), qual
ação, qual item, o resultado e o espaço livre antes e depois. Toda ação que muda algo é avisada na hora
ao dono pelos canais da sentinela: "Fernando liberou 3,2 GB apagando a pasta de downloads da Luna pela
porta de socorro, 03:41". Assim, se alguém usar a chave de outra pessoa, o dono fica sabendo no mesmo
minuto.

## O que fica de fora de propósito

- Terminal, comando livre, envio de arquivo, editar configuração: não existem na porta.
- Ler conteúdo de arquivo: a porta mostra nome e tamanho de pasta, nunca o que está dentro.
- Cadastrar pessoa ou trocar chave pela própria porta.

## O último recurso continua sendo da hospedagem

Se o servidor travar por completo (sem rede, kernel parado), nenhuma porta de dentro dele responde. Para
esse caso o caminho é o console da hospedagem (na Hostinger, o terminal pelo navegador e o botão de
reiniciar). O pulso externo da sentinela é o que garante que alguém fica sabendo em minutos.

## O que preciso do Danilo

1. Opção A (Telegram), B (telinha web) ou as duas?
2. Quem entra na lista de confiança de fábrica? (Proposta: só o dono; ele acrescenta pessoas pelo terminal.)
3. Reiniciar o servidor inteiro pela porta: liberado com código, ou exige também o ok do dono no Telegram?
4. Apagar pasta pela porta: liberado só nas áreas apagáveis padrão, ou o dono pode ampliar a lista?

Prazo em ritmo de agente depois do ok: opção A em cerca de 1 a 2 horas, opção B mais 1 hora, com testes e
revisão adversarial.
