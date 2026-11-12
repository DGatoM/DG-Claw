# Colaboradores

Um **colaborador** é uma pessoa que você convida para conversar com **um** agente de trabalho do seu DG Claw. Ela recebe um e-mail com o link, o login e uma senha temporária, cria a própria senha no primeiro acesso e passa a usar aquele agente por inteiro, e só ele.

Este documento tem duas partes: a primeira é para você, dono do DG Claw; a segunda, "API", é para o agente que opera o painel por você (o Admin, por exemplo).

## Para o dono

### O que o colaborador vê e o que não vê

O colaborador usa **o agente inteiro**, igual a você usa: o menu à esquerda, a conversa, as Sessões, as páginas do painel dele (Rotinas, Memória, Pasta e as outras) para **ler**, e a página Conectar conta, onde ele conecta a conta de IA do agente dele quando o agente ainda não tem nenhuma. Ele conversa com o agente e organiza as Sessões, mas não grava nada que vire instrução ou configuração permanente do agente, e não consegue **sair** desse agente.

| Vê e usa | Não vê |
|---|---|
| A conversa do agente, com as mídias e os visuais dele | O Admin e os outros agentes, e a lista deles |
| O painel do agente para leitura: sessões, rotinas, memória, arquivos, custos e o resto | As telas da caixa inteira: convidar colaborador, chaves de API do sistema, Segurança, Avisos, atualização |
| A página **Conectar conta**, só com o cartão do agente dele (ver "Se o agente ainda não tem IA conectada") | A Mesa, os Lembretes e o uso da assinatura (são globais, de todos os agentes) |
| O botão de reiniciar a sessão do agente dele | |

Isso vale no servidor, não só na tela: o endereço de qualquer outro agente ou página da caixa responde "acesso não liberado".

**Dentro do agente dele, ficam só com você:**

| Fica com o dono | Por quê |
|---|---|
| O **cofre** do agente (as chaves de serviço) | São credenciais que você pôs. Na tela e na lousa o colaborador lê: "O cofre é só do dono do DG Claw." |
| As **chaves de API do painel** | Dão acesso ao painel, e nenhuma chave gerencia chaves. |
| A **conta de IA já conectada** do agente (trocar, desconectar, reconectar um login expirado, mesmo que a conta tenha sido ele quem conectou) e o painel de provedor do agente (`/p/<agente>/api/provedor`) | Quem paga a assinatura é você, e o link de login autentica a conta de quem o abre. Só quando o agente está **sem conta** o colaborador pode conectar a dele (próxima seção); com a conta conectada ele vê só "Este agente já está conectado." |
| **Gravar no painel** memória (`MEMORY.md` e outros), arquivos da casa, apps, custos, reinício e qualquer rota nova | O painel registra como se fosse você, e a memória e os arquivos viram instrução permanente do agente. Recebe "Isso muda o agente de forma permanente ... é só do dono do DG Claw". Em `/p/<agente>/` a escrita dele passa só por uma lista de permissão: transcrever áudio e, em Sessões, arquivar, desarquivar, renomear e marcar favorito. |
| As **credenciais dos canais** (token de bot do Telegram, WhatsApp) | Quem controla o canal fala em nome do agente com o mundo. Colar um token na conversa também é recusado para ele. |
| A **Tela** do agente (a página, o noVNC, o WebSocket e a senha) | O navegador da Tela roda como o agente e abre arquivos do servidor, como as credenciais da assinatura. Ele lê: "A Tela do agente dá acesso aos arquivos e às contas dele, por isso é só do dono do DG Claw." |
| **Mandar mensagem, instrução ou decisão pelo painel**: o chat do painel, a sessão de socorro e, em Sessões, criar, mandar recado, decidir pedido, retomar, passar o bastão, anexar e apagar | O painel não sabe quem é o colaborador e trataria a mensagem como sua. Ele conversa e confirma permissões só pela conversa do agente, onde cada mensagem e cada confirmação leva o nome dele. Em Sessões ele só acompanha, arquiva, renomeia e marca favorito. |

Um agente pode ter **vários** colaboradores ao mesmo tempo, e cada pessoa acessa **um** agente só. As mensagens de cada um chegam ao agente marcadas como vindas de um colaborador (`colaborador: Nome (e-mail)`), para o agente saber quem falou e que não é você.

### Como convidar

1. Abra o menu ☰ do agente e toque em **Convidar colaborador** (ou vá em `/colaboradores?agente=<agente>`).
2. Digite o e-mail da pessoa (será o login dela) e, se quiser, o nome. Toque em **Convidar**.
3. A tela mostra um cartão para cada colaborador do agente, com o formulário para convidar mais uma pessoa logo abaixo. Depois de convidar, ela mostra o resultado:
   - se o e-mail saiu, ou por que não saiu;
   - o **texto do convite**, com o link, o login e a senha temporária, e o botão **Copiar**. A senha temporária aparece só nessa hora. Se você sair da tela sem copiar, use **Mandar convite de novo**.
4. A pessoa abre o link, entra com a senha temporária e a tela pede uma senha nova (de 10 a 128 caracteres). Depois disso ela cai direto na conversa com o agente.

A senha temporária vale por 7 dias. Passado o prazo, o login dela avisa que a senha venceu e você manda o convite de novo.

### Mandar o convite de novo, revogar e a lista

- **Mandar convite de novo** gera outra senha temporária, derruba as sessões abertas da pessoa e a obriga a criar a senha de novo. Serve para senha esquecida ou vencida. Os outros colaboradores do mesmo agente não são afetados.
- **Revogar acesso** encerra tudo na hora: no próximo toque dela, a sessão cai. O registro continua na lista, com a data da revogação, e as outras pessoas do mesmo agente continuam com o acesso.
- A lista de baixo mostra todos os colaboradores de todos os agentes, inclusive os revogados.

### E-mail (opcional)

Sem configurar nada, o convite sai pelo texto da tela e você manda por WhatsApp. Para o DG Claw mandar o e-mail sozinho, coloque estas linhas no `/etc/dgclaw/web.env` (uma linha por vez, sem apagar as outras) e reinicie o painel:

| Variável | O que é |
|---|---|
| `DGCLAW_SMTP_HOST` | Endereço do servidor de e-mail. Sem ele, o envio fica desligado. |
| `DGCLAW_SMTP_PORTA` | `465` abre a conexão já criptografada; `587` exige STARTTLS. Padrão: `587`. |
| `DGCLAW_SMTP_USUARIO` | O login do servidor de e-mail. |
| `DGCLAW_SMTP_SENHA` | A senha desse login. |
| `DGCLAW_SMTP_REMETENTE` | De quem o e-mail parece vir, por exemplo `DG Claw <voce@exemplo.com>`. |

Exemplo com uma conta do Gmail, que exige uma **senha de app** (ative a verificação em duas etapas na conta Google e crie a senha de app em "Segurança"):

```
DGCLAW_SMTP_HOST=smtp.gmail.com
DGCLAW_SMTP_PORTA=587
DGCLAW_SMTP_USUARIO=voce@gmail.com
DGCLAW_SMTP_SENHA=senha-de-app-de-16-letras
DGCLAW_SMTP_REMETENTE=DG Claw <voce@gmail.com>
```

O DG Claw confere o certificado do servidor e só manda a senha por conexão criptografada. A senha do e-mail nunca aparece em tela nem em log.

### Quando o e-mail não sai

A tela mostra o motivo que o servidor de e-mail deu (por exemplo, "535 Authentication failed", que quer dizer usuário ou senha errados). O convite já foi criado: copie o texto da tela e mande por WhatsApp. Para tentar o e-mail de novo depois de arrumar a configuração, use **Mandar convite de novo**. O log do Web (`journalctl -u dgclaw-web`) tem uma linha com o servidor, a porta e a resposta recebida.

### Se o agente ainda não tem IA conectada

Um agente sem conta de IA não responde. Quando isso acontece, o colaborador pode conectar a conta dele mesmo, em **Conectar conta** (menu ☰): o cartão do agente dele tem o botão **Gerar link de login**, e o passo a passo é o de sempre (abrir o link, entrar na conta, colar o código). A conta conectada passa a ser a que o agente usa, e é paga por essa pessoa.

As regras, todas conferidas no servidor (na dúvida, ele recusa):

- **Só com o agente sem conta de verdade.** O servidor pergunta ao agente, na hora, se a conta está conectada. Se o agente usa chave de API, se a conta já está conectada, ou se o agente não responde com clareza, o colaborador não consegue começar, mandar código ou cancelar. Com a conta conectada, o cartão dele mostra só "Este agente já está conectado.", sem botão.
- **Uma pessoa por vez.** Quem começa o login segura o agente por até 15 minutos. Enquanto isso, quem tentar (o dono inclusive) recebe um aviso de que outra pessoa está conectando, e não vê o link nem o código dela. O dono pode **Cancelar** o login do colaborador para tomar a vez.
- **Login expirado é sempre do dono.** O colaborador só inicia um login quando a conferência feita na hora prova que o agente não tem credencial nenhuma. Com credencial presente, mesmo vencida e mesmo que ele a tenha conectado antes (o servidor guarda quem conectou em `conta-agentes.json`), o pedido recebe `403` e o cartão dele diz para pedir ao dono reconectar em Conectar conta. O registro de quem conectou não prova que a credencial atual é a mesma, porque o dono pode tê-la trocado pelo terminal.
- **Troca de provedor não rouba a autoria.** Enquanto o dono muda o provedor pelo painel, a fila do login do colaborador fica trancada até a resposta terminar, e cada tentativa guarda o provedor em que começou: se a conta aparece com outro provedor, nenhuma autoria é registrada e o log avisa o dono.
- **Só a ausência comprovada de conta libera.** O runner informa `conferido.motivo`; só `sem_credencial` (o CLI respondeu claramente que ninguém está logado) conta como "sem conta". Tempo esgotado, resposta ilegível, método diferente e runner antigo (sem o campo) são dúvida, e o servidor recusa. Antes de iniciar e antes de mandar o código, o servidor reconfere **sem nenhum cache**: pede ao runner `GET /api/provedor?fresco=1` (que refaz a conferência do CLI e responde `fresco:true`) e lê o estado direto. Runner que não responde `fresco:true` (versão antiga) é dúvida: recusa e manda o colaborador avisar o dono para atualizar. Sinais contraditórios (agente sem login, mas conferência dizendo conectado) também são dúvida.
- **A tentativa do colaborador é gravada antes de começar** (`conta-agentes.json`, chave `<agente>:pendente`). Se não der para gravar, o login não começa (503). Ao revogar, o servidor reconcilia com o runner sem cache: conta conectada e tentativa dele grava a autoria com `revogado:true` e avisa o dono; estado que não dá para confirmar também avisa ("confira a conta do agente"). Cancelar o login no runner não prova que não há conta.
- **Quando o dono começa um login** (pela página ou pelo painel do agente), a autoria de qualquer colaborador sobre a conta daquele agente é apagada na hora, em gravação durável: se não der para apagar, o login do dono não começa (503, pela página e pelo painel). A reserva só se resolve quando a tentativa conclui de verdade; enquanto o login está em andamento ela continua, mesmo que a credencial antiga ainda esteja conectada. O painel do agente respeita a reserva do colaborador (409).
- **Revogar o colaborador (ou reenviar o convite) cancela o login que ele deixou em andamento** no agente. Se o cancelamento falhar, a resposta traz `avisos`, o agente entra em `contas_de_ia`, e se a conta entrar depois ela fica registrada como de colaborador revogado.
- **Revogar o colaborador não desconecta a conta.** Se ele tinha conectado a conta do agente, o comando `dgclaw colaborador revogar` e o log do Web avisam que a conta continua conectada. Se você quiser trocar, entre com a sua conta em **Conectar conta**.
- O link de login e o código nunca vão para log nem para o aviso da conversa.

### Convidar pelo servidor: `dgclaw colaborador`

Quem tem acesso ao servidor (o Admin, por exemplo) convida sem passar pela tela:

```
sudo dgclaw colaborador criar <agente> <email> [--nome "Nome"] [--json]
sudo dgclaw colaborador listar [agente] [--json]
sudo dgclaw colaborador reenviar <id-ou-email> [--json]
sudo dgclaw colaborador revogar <id-ou-email> [--json]
```

`criar` e `reenviar` imprimem o texto do convite pronto para copiar (endereço, login e a senha temporária, que vale 7 dias). O Admin nunca é compartilhado. O link usa o domínio do DG Claw (`DGCLAW_DOMINIO` do `dgclaw.env`); sem domínio, o link é o endereço local, só abre no servidor, e o comando avisa.

O comando fala com o painel por um socket local, `admin.sock`, na pasta de dados do Web (veja "Socket do servidor" abaixo). Se ele disser que não consegue falar com o Web, confira `systemctl status dgclaw-web`; depois de atualizar o DG Claw, o Web precisa ser reiniciado (`sudo systemctl restart dgclaw-web`) para o socket existir.

---

## API

Tudo o que a tela faz passa por estas rotas, com a sessão do dono (cookie do login) e `Origin` igual ao do painel nas escritas. **Só o dono** usa: a caixa de um agente de trabalho e o colaborador recebem `403`. Erros vêm como `{ok:false, erro:"motivo em português"}`.

Nenhuma resposta traz o hash da senha.

### `GET /api/v1/colaboradores`

Lista todos os colaboradores, os revogados também, do mais novo para o mais antigo. `?agente=<slug>` filtra por agente.

```json
{"ok": true, "colaboradores": [{
  "id": "…", "email": "maria@x.com", "nome": "Maria", "agente": "ana",
  "estado": "aguardando_primeiro_acesso",
  "trocar_senha": true, "temporaria_expira": 1790000000000,
  "criado_em": 1789000000000, "criado_por": "dono", "revogado_em": null, "ultimo_login": null
}]}
```

`estado` é `aguardando_primeiro_acesso`, `ativo`, `temporaria_vencida` ou `revogado`. Datas em milissegundos desde 1970.

### `POST /api/v1/colaboradores`

Corpo: `{"agente": "ana", "email": "maria@x.com", "nome": "Maria"}`. O `nome` é opcional, com até 80 caracteres e sem `<` nem `>`. O e-mail é guardado em minúsculas.

Resposta `201`:

```json
{"ok": true,
 "colaborador": {"id": "…", "email": "maria@x.com", "estado": "aguardando_primeiro_acesso", "…": "…"},
 "convite": {
   "link": "https://painel.exemplo.com/login?usuario=maria%40x.com",
   "usuario": "maria@x.com",
   "senha_temporaria": "Ab3dEf5hJk7m",
   "expira": 1790000000000,
   "email_enviado": true,
   "email_motivo": null,
   "texto": "Olá, Maria! …"
 }}
```

A `senha_temporaria` aparece só nesta resposta (e na do reenvio). O `texto` é a mensagem pronta para copiar e mandar por outro meio. Com o e-mail desligado ou com falha, `email_enviado` é `false` e `email_motivo` explica.

Erros: `400` (e-mail inválido ou igual ao usuário do dono, agente é o Admin, nome inválido, falta o `agente`), `404` (agente inexistente), `409` (o e-mail já é colaborador ativo de um agente, este ou outro), `500` (o arquivo `colaboradores.json` está ilegível ou não foi possível gravar; o motivo vem na resposta).

### `POST /api/v1/colaboradores/<id>/reenviar`

Gera uma senha temporária nova, exige a troca de senha no próximo acesso e derruba as sessões abertas da pessoa. Resposta `200` no mesmo formato do convite. Erros: `404` (id desconhecido), `409` (o acesso já foi revogado).

### `DELETE /api/v1/colaboradores/<id>`

Revoga o acesso: grava `revogado_em`, derruba as sessões e mantém o registro. Resposta `200` com `{ok, colaborador}`. A resposta traz também `contas_de_ia`: os agentes cuja conta de IA esse colaborador conectou (ela continua conectada; quem decide trocar é o dono). Revogar duas vezes devolve `409`; id desconhecido, `404`.

### `GET /api/v1/colaboradores/docs.md`

Este documento.

### `GET /api/v1/eu`

Vale para qualquer sessão: `{ok, usuario, papel, agente, nome, trocar_senha}`. O dono recebe `papel: "dono"` e `agente: null`.

### `POST /api/v1/eu/senha`

Só o colaborador troca a própria senha (o dono recebe `403` e é mandado para `sudo dgclaw senha`). Corpo: `{"atual": "…", "nova": "…", "confirmacao": "…"}`. A `atual` só é exigida depois que a senha temporária já foi trocada. A `nova` tem de 10 a 128 caracteres, é diferente da atual (ou da temporária) e igual à `confirmacao`.

Resposta `200`: `{"ok": true, "destino": "/a/ana"}`, e um cookie novo substitui o da sessão (as outras sessões da pessoa caem). Erros: `400` (regra da senha), `403` (senha atual errada), `429` (muitas senhas sendo processadas ao mesmo tempo).

### Enquanto a senha temporária está pendente

A sessão só alcança `GET /api/v1/eu`, `POST /api/v1/eu/senha`, a página `/trocar-senha` e os arquivos da tela. Qualquer outra rota de API responde `403` com `{ok:false, erro:"Troque a senha temporária antes de continuar.", trocar_senha:true}`, e as páginas levam para `/trocar-senha`.

### O que o colaborador alcança

O servidor aplica uma regra só (`web/lib/escopo.js`): **tudo que tem o slug do agente dele passa; o que é de outro agente ou da caixa inteira é negado; uma rota nova sem slug nasce fechada.** Para o colaborador passam:

- os arquivos estáticos da tela;
- as páginas `/`, `/a/<agente dele>`, `/conectar` e `/trocar-senha`;
- `GET /api/v1/eu`, `POST /api/v1/eu/senha`, `GET /api/v1/agents` (só o agente dele) e `GET /api/v1/nao-lidas` (só o dele);
- tudo em `/api/v1/agents/<agente dele>/**`, as ações de hoje e as futuras: `messages`, `stream`, `wait`, `send`, `permissao`, `pergunta`, `reiniciar`, `lido`, `nao-lido`, `vendo`, `upload`, `compartilhados`, `avatar`, `alertas` e `login` (que passa até o handler, ver abaixo). As únicas negadas são `comando` e `comandos` (abaixo);
- o painel inteiro do agente dele, `/p/<agente dele>/**`, com as exceções fechadas da tabela acima;
- nenhum WebSocket: o único do painel é o da Tela, que é só do dono;
- as mídias que pertencem ao agente dele, menos arquivos ocultos da casa (como `.claude`) e qualquer coisa fora da casa do agente;
- `POST /api/v1/transcribe`, `POST /api/v1/tts` e `GET /api/v1/tts/cota`.

**Negados** (são da caixa inteira ou de todos os agentes): `/colaboradores` e `/api/v1/colaboradores*`, `/seguranca`, `/avisos`, atualização, onboarding, push, sigilo, `/mesa`, `/lembretes`, o modo foco, o uso da assinatura e o estado dos agentes. As rotas de lembretes, tarefas (Mesa), foco, uso e estados aceitam o agente como parâmetro, mas gravam e leem de todos os agentes e avisam o aparelho do dono, e por isso ficam fechadas para o colaborador. O painel do agente dele já tem as rotinas e as sessões dele.

Cada exceção fechada dentro de `/p/<agente dele>/` é conferida no Web, antes do proxy (o painel confia no Web). Para o colaborador, o Web recusa em `/p/` e em `/api/` qualquer caminho com `%2f`, `%2e`, `%5c`, `%25`, barra dupla, `/./` ou `/../`, e em `/p/` também letras e números escritos em `%XX`. Os prefixos fechados são comparados sem diferenciar maiúsculas e tolerando a barra final, porque o painel roteia assim.

Regras que o servidor aplica por cima:

- O Web manda ao painel, em todo pedido, os cabeçalhos `X-DGClaw-Papel` (`dono` ou `colaborador`) e `X-DGClaw-Colaborador` (o id, só para colaborador), e apaga os que o navegador mandar. O painel ainda não os usa.
- Repetir um envio com o mesmo `cliente_id` devolve a resposta guardada e nunca muda quem é o autor do turno; o `cliente_id` de uma pessoa não vale para a outra.
- Comandos de barra não existem para ele: `/comando` e `/comandos` são negados, e um texto que começa com `/` segue como mensagem comum, dentro do envelope com `from="colaborador: …"`.
- Ele só responde a pedido de permissão ou pergunta do agente se a pendência foi aberta por um turno que **ele** iniciou, e precisa mandar o `tool_use_id` dela. Uma mensagem que só entrou na fila (o agente estava ocupado ou esperando confirmação) não inicia turno, e uma mensagem do dono na fila tira dele a confirmação. Senão recebe "Essa confirmação é do dono do DG Claw".
- Além da memória do Web, a autoria é provada pela transcrição da sessão, que é o que o runner de fato executou. Cada mensagem do colaborador leva no envelope `colaborador_id="…"`, gravado só pelo servidor (o texto dele não consegue fechar nem forjar o envelope). A pendência é dele somente se a última mensagem de usuário antes dela é um envelope com o id dele e nenhuma outra mensagem de usuário (do dono pelo painel, Telegram, canal ou rotina) aparece depois. Qualquer dúvida, como transcrição ilegível ou agente em Codex, deixa a pendência com o dono.
- O texto, a legenda e o nome de arquivo dele não podem ter caracteres de controle (todos os de código abaixo de 32 menos a quebra de linha e o tab, o Enter `\r`, ESC, DEL e os de 128 a 159), porque o terminal do agente os entenderia como teclas apertadas. O envio é recusado com `400` dizendo qual caractere e em que posição. O dono tem a mesma regra, com o `\r` virando quebra de linha.
- A sessão dele é conferida de novo depois de o corpo do pedido chegar inteiro e antes de qualquer ação (`send`, `upload`, `permissao`, `pergunta`, login e demais). Quem foi revogado, ou teve o convite reenviado, enquanto mandava um corpo lento recebe `401` e nada é feito.
- O login da conta de IA do agente dele (`GET`, `POST` e `DELETE` em `/api/v1/agents/<agente>/login`, mais `login/codigo` e `login/oi`) chega ao handler, que decide em `web/lib/conta-colaborador.js`: só com o agente sem conta de verdade, uma pessoa por vez (reserva de 15 minutos por agente) e com resposta em lista de campos permitidos. `/p/<agente>/api/provedor` inteiro continua `403` em qualquer método. Detalhes em `web/docs/CONECTAR-CONTA.md`. A atividade que ele recebe diz que falta conta e que ele pode conectar em Conectar conta (ou, no login expirado, que o dono precisa reconectar), sem o texto do runner.
- Os arquivos que ele sobe vão para `uploads/<dia>/colaborador-<id>/`, com um prefixo aleatório no nome, e nunca para a pasta dos seus arquivos. Para todos (você inclusive), nomes de instrução ou configuração (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `SKILL.md`, `AGENT.md`, ou começando com ponto) ganham o prefixo `anexo-` ao serem gravados; o nome original aparece na resposta.
- Todo anexo (seu e dele) é gravado na casa do agente por um processo filho com o uid e o gid do dono da casa, não como root: as pastas são criadas uma a uma e o arquivo abre com `O_CREAT|O_EXCL|O_NOFOLLOW`. Se o agente trocar `uploads/<dia>` por um atalho para `/etc/cron.d`, o kernel recusa a gravação. Casa de root ou casa que é atalho é recusada com `500` e explicação, exceto a do Admin, que é do root por padrão e é gravada pelo próprio Web com as mesmas proteções (o colaborador nunca chega ao Admin). Em instalações antigas, a pasta `uploads/` criada como root passa sozinha ao dono do agente no primeiro anexo (`fchown` no descritor, sem seguir atalho); uma pasta do dia que ainda é do root não é tocada, e o anexo vai para `<dia>-2`.
- O convite vale para a **instância** do agente (o campo `instancia` do `agentes.json`, gravado pelo `dgclaw agente criar`; para agentes mais antigos, o uid e o inode da casa). Se o agente for removido e recriado com o mesmo nome, a sessão do colaborador cai e o login responde "Este convite era de um agente que foi removido. Peça um convite novo ao dono." Agente que sai do `agentes.json` (o `dgclaw agente remover`) também derruba as sessões e recusa o login, com a mesma mensagem; só o Web escreve o `colaboradores.json`. Convidar de novo revoga os convites de instância antiga. Convite sem `instancia` (gravado à mão) não vale: não loga e não mantém sessão. Convidar é recusado, com a explicação e o `dgclaw agente reparar <agente>`, quando o Web não consegue identificar a instância (sem o campo no registro e com a casa ilegível).
- O stream, o `wait` e qualquer pedido dele conferem a sessão de novo a cada passo: se ela expirou, saiu ou foi revogada, o stream avisa (`sessao_encerrada`) e fecha em menos de um segundo.
- O stream e as mensagens dele não trazem o modo foco nem os avisos técnicos do servidor.
- Um `[anexo: caminho]` digitado na conversa (pelo dono ou pelo colaborador) só vira mídia se o arquivo estiver na pasta `uploads/` do agente.
- Enquanto vale a senha temporária, a sessão dele dura no máximo até ela vencer. Na troca de senha, 5 erros da senha atual em 15 minutos bloqueiam por 15 minutos (`429` com `Retry-After`), e o pedido só vale se a sessão ainda é da mesma versão de senha em que nasceu.
- No login, os erros de senha contam por pessoa e por IP; um login certo de colaborador não zera os erros contra a senha do dono, e existe um teto de erros por IP, somando todos, que nenhum acerto zera.

### Socket do servidor (`admin.sock`)

Além da porta HTTP, o Web escuta em um socket Unix local, `<DGCLAW_WEB_DATA>/admin.sock` (a pasta é 700 e o socket é 600, do root). Ele é o canal do comando `dgclaw colaborador` e atende **somente** `/api/v1/colaboradores` e `/api/v1/colaboradores/*`, com as mesmas regras e as mesmas respostas desta API; qualquer outra rota responde `404` explicando. Quem chega por ali é tratado como o dono (sem cookie), e `criado_por` fica `"admin"`. O link do convite não pode vir do cabeçalho `Host` (não há navegador): vale o campo opcional `base` do corpo (`https://painel.exemplo.com`), senão `DGCLAW_DOMINIO` do ambiente do Web, senão a primeira origem `https` de `DGCLAW_WEB_ORIGENS`, senão o endereço local e um campo `aviso` na resposta. Se o socket não puder ser criado, o Web continua de pé e o log explica. O caminho HTTP segue fechado: sem sessão `401`, caixa de agente e colaborador `403`.

### Onde ficam os dados

`<DGCLAW_WEB_DATA>/colaboradores.json`, com permissão 600. Só o Web grava. Se você editar o arquivo à mão, o Web relê sozinho. Se o JSON estiver quebrado, ele registra no log o caminho e o motivo, trata como "nenhum colaborador" e **não** apaga nem regrava o arquivo: convidar fica recusado até você corrigir.

`<DGCLAW_WEB_DATA>/conta-agentes.json` (600, só o Web grava) guarda, por agente e instância, quem conectou a conta de IA atual: `{ por: "colaborador" | "dono", colaborador_id, email, em }`. Sem registro, a conta é tratada como do dono. Arquivo ilegível: o Web registra no log, trata toda conta como do dono e não o regrava.
