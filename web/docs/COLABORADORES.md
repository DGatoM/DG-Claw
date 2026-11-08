# Colaboradores

Um **colaborador** é uma pessoa que você convida para conversar com **um** agente de trabalho do seu DG Claw. Ela recebe um e-mail com o link, o login e uma senha temporária, cria a própria senha no primeiro acesso e passa a usar aquele agente por inteiro, e só ele.

Este documento tem duas partes: a primeira é para você, dono do DG Claw; a segunda, "API", é para o agente que opera o painel por você (o Admin, por exemplo).

## Para o dono

### O que o colaborador vê e o que não vê

O colaborador usa **o agente inteiro**, igual a você usa: o menu à esquerda, a conversa, as Sessões, as páginas do painel dele (Rotinas, Memória, Pasta e as outras) para **ler**, e a página Conectar conta só para ver o aviso. Ele conversa com o agente e organiza as Sessões, mas não grava nada que vire instrução ou configuração permanente do agente, e não consegue **sair** desse agente.

| Vê e usa | Não vê |
|---|---|
| A conversa do agente, com as mídias e os visuais dele | O Admin e os outros agentes, e a lista deles |
| O painel do agente para leitura: sessões, rotinas, memória, arquivos, custos e o resto | As telas da caixa inteira: convidar colaborador, chaves de API do sistema, Segurança, Avisos, atualização |
| A página **Conectar conta**, que para ele só mostra o aviso de que o login é com o dono | A Mesa, os Lembretes e o uso da assinatura (são globais, de todos os agentes) |
| O botão de reiniciar a sessão do agente dele | |

Isso vale no servidor, não só na tela: o endereço de qualquer outro agente ou página da caixa responde "acesso não liberado".

**Dentro do agente dele, ficam só com você:**

| Fica com o dono | Por quê |
|---|---|
| O **cofre** do agente (as chaves de serviço) | São credenciais que você pôs. Na tela e na lousa o colaborador lê: "O cofre é só do dono do DG Claw." |
| As **chaves de API do painel** | Dão acesso ao painel, e nenhuma chave gerencia chaves. |
| O **login da conta de IA** do agente (ver o link, começar, mandar o código, cancelar, sair ou trocar a conta) | Quem paga a assinatura é você, e o link de login autentica a conta de quem o abre. O colaborador só fica sabendo, pelo aviso na conversa, que o agente está sem conta, e recebe "O agente precisa entrar numa conta, e isso é só do dono do DG Claw. Avise o dono." |
| **Gravar no painel** memória (`MEMORY.md` e outros), arquivos da casa, apps, custos, reinício e qualquer rota nova | O painel registra como se fosse você, e a memória e os arquivos viram instrução permanente do agente. Recebe "Isso muda o agente de forma permanente ... é só do dono do DG Claw". Em `/p/<agente>/` a escrita dele passa só por uma lista de permissão: transcrever áudio e, em Sessões, arquivar, desarquivar, renomear e marcar favorito. |
| As **credenciais dos canais** (token de bot do Telegram, WhatsApp) | Quem controla o canal fala em nome do agente com o mundo. Colar um token na conversa também é recusado para ele. |
| A **Tela** do agente (a página, o noVNC, o WebSocket e a senha) | O navegador da Tela roda como o agente e abre arquivos do servidor, como as credenciais da assinatura. Ele lê: "A Tela do agente dá acesso aos arquivos e às contas dele, por isso é só do dono do DG Claw." |
| **Mandar mensagem, instrução ou decisão pelo painel**: o chat do painel, a sessão de socorro e, em Sessões, criar, mandar recado, decidir pedido, retomar, passar o bastão, anexar e apagar | O painel não sabe quem é o colaborador e trataria a mensagem como sua. Ele conversa e confirma permissões só pela conversa do agente, onde cada mensagem e cada confirmação leva o nome dele. Em Sessões ele só acompanha, arquiva, renomeia e marca favorito. |

Cada agente tem **um** colaborador por vez, e cada pessoa acessa **um** agente só. As mensagens dele chegam ao agente marcadas como vindas de um colaborador (`colaborador: Nome (e-mail)`), para o agente saber que não é você.

### Como convidar

1. Abra o menu ☰ do agente e toque em **Convidar colaborador** (ou vá em `/colaboradores?agente=<agente>`).
2. Digite o e-mail da pessoa (será o login dela) e, se quiser, o nome. Toque em **Convidar**.
3. A tela mostra o resultado:
   - se o e-mail saiu, ou por que não saiu;
   - o **texto do convite**, com o link, o login e a senha temporária, e o botão **Copiar**. A senha temporária aparece só nessa hora. Se você sair da tela sem copiar, use **Mandar convite de novo**.
4. A pessoa abre o link, entra com a senha temporária e a tela pede uma senha nova (de 10 a 128 caracteres). Depois disso ela cai direto na conversa com o agente.

A senha temporária vale por 7 dias. Passado o prazo, o login dela avisa que a senha venceu e você manda o convite de novo.

### Mandar o convite de novo, revogar e a lista

- **Mandar convite de novo** gera outra senha temporária, derruba as sessões abertas da pessoa e a obriga a criar a senha de novo. Serve para senha esquecida ou vencida.
- **Revogar acesso** encerra tudo na hora: no próximo toque dela, a sessão cai. O registro continua na lista, com a data da revogação, e o agente fica livre para outro colaborador.
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

Quando o agente do colaborador está sem conta de IA, ele vê o aviso na conversa pedindo que avise o dono: o login da conta (link, código, cancelar) é só do dono, em qualquer momento.

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

Erros: `400` (e-mail inválido ou igual ao usuário do dono, agente é o Admin, nome inválido, falta o `agente`), `404` (agente inexistente), `409` (o agente já tem colaborador ativo, ou o e-mail já é colaborador ativo de outro agente), `500` (o arquivo `colaboradores.json` está ilegível ou não foi possível gravar; o motivo vem na resposta).

### `POST /api/v1/colaboradores/<id>/reenviar`

Gera uma senha temporária nova, exige a troca de senha no próximo acesso e derruba as sessões abertas da pessoa. Resposta `200` no mesmo formato do convite. Erros: `404` (id desconhecido), `409` (o acesso já foi revogado).

### `DELETE /api/v1/colaboradores/<id>`

Revoga o acesso: grava `revogado_em`, derruba as sessões e mantém o registro. Resposta `200` com `{ok, colaborador}`. Revogar duas vezes devolve `409`; id desconhecido, `404`.

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
- tudo em `/api/v1/agents/<agente dele>/**`, as ações de hoje e as futuras: `messages`, `stream`, `wait`, `send`, `permissao`, `pergunta`, `reiniciar`, `lido`, `nao-lido`, `vendo`, `upload`, `compartilhados`, `avatar`, `alertas` e `login`. As únicas negadas são `comando` e `comandos` (abaixo);
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
- O login da conta de IA é só do dono em todas as rotas (`/api/v1/agents/<agente>/login` com `codigo` e `oi`, e `/p/<agente>/api/provedor` inteiro, porque a leitura dele traz o link e o código do login), em qualquer método: `403`. A atividade que ele recebe diz só que falta conta, sem o texto do runner.
- Os arquivos que ele sobe vão para `uploads/<dia>/colaborador-<id>/`, com um prefixo aleatório no nome, e nunca para a pasta dos seus arquivos. Para todos (você inclusive), nomes de instrução ou configuração (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `SKILL.md`, `AGENT.md`, ou começando com ponto) ganham o prefixo `anexo-` ao serem gravados; o nome original aparece na resposta.
- Todo anexo (seu e dele) é gravado na casa do agente por um processo filho com o uid e o gid do dono da casa, não como root: as pastas são criadas uma a uma e o arquivo abre com `O_CREAT|O_EXCL|O_NOFOLLOW`. Se o agente trocar `uploads/<dia>` por um atalho para `/etc/cron.d`, o kernel recusa a gravação. Casa de root ou casa que é atalho é recusada com `500` e explicação, exceto a do Admin, que é do root por padrão e é gravada pelo próprio Web com as mesmas proteções (o colaborador nunca chega ao Admin). Em instalações antigas, a pasta `uploads/` criada como root passa sozinha ao dono do agente no primeiro anexo (`fchown` no descritor, sem seguir atalho); uma pasta do dia que ainda é do root não é tocada, e o anexo vai para `<dia>-2`.
- O convite vale para a **instância** do agente (o campo `instancia` do `agentes.json`, gravado pelo `dgclaw agente criar`; para agentes mais antigos, o uid e o inode da casa). Se o agente for removido e recriado com o mesmo nome, a sessão do colaborador cai e o login responde "Este convite era de um agente que foi removido. Peça um convite novo ao dono." Agente que sai do `agentes.json` (o `dgclaw agente remover`) também derruba as sessões e recusa o login, com a mesma mensagem; só o Web escreve o `colaboradores.json`. Convidar de novo revoga os convites de instância antiga. Convite sem `instancia` (gravado à mão) não vale: não loga e não mantém sessão. Convidar é recusado, com a explicação e o `dgclaw agente reparar <agente>`, quando o Web não consegue identificar a instância (sem o campo no registro e com a casa ilegível).
- O stream, o `wait` e qualquer pedido dele conferem a sessão de novo a cada passo: se ela expirou, saiu ou foi revogada, o stream avisa (`sessao_encerrada`) e fecha em menos de um segundo.
- O stream e as mensagens dele não trazem o modo foco nem os avisos técnicos do servidor.
- Um `[anexo: caminho]` digitado na conversa (pelo dono ou pelo colaborador) só vira mídia se o arquivo estiver na pasta `uploads/` do agente.
- Enquanto vale a senha temporária, a sessão dele dura no máximo até ela vencer. Na troca de senha, 5 erros da senha atual em 15 minutos bloqueiam por 15 minutos (`429` com `Retry-After`), e o pedido só vale se a sessão ainda é da mesma versão de senha em que nasceu.
- No login, os erros de senha contam por pessoa e por IP; um login certo de colaborador não zera os erros contra a senha do dono, e existe um teto de erros por IP, somando todos, que nenhum acerto zera.

### Onde ficam os dados

`<DGCLAW_WEB_DATA>/colaboradores.json`, com permissão 600. Só o Web grava. Se você editar o arquivo à mão, o Web relê sozinho. Se o JSON estiver quebrado, ele registra no log o caminho e o motivo, trata como "nenhum colaborador" e **não** apaga nem regrava o arquivo: convidar fica recusado até você corrigir.
