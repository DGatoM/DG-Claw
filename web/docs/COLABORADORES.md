# Colaboradores

Um **colaborador** é uma pessoa que você convida para conversar com **um** agente de trabalho do seu DG Claw. Ela recebe um e-mail com o link, o login e uma senha temporária, cria a própria senha no primeiro acesso e passa a ter a conversa daquele agente, e só ela.

Este documento tem duas partes: a primeira é para você, dono do DG Claw; a segunda, "API", é para o agente que opera o painel por você (o Admin, por exemplo).

## Para o dono

### O que o colaborador vê e o que não vê

| Vê | Não vê |
|---|---|
| A conversa do agente dele, com as mídias e os visuais daquele agente | O Admin e os outros agentes |
| A página **Conectar conta**, para ligar a conta de IA dele quando o agente ainda não tem uma conectada | O cofre, a Mesa, os lembretes, os avisos, a Segurança |
| O botão de reiniciar a sessão do agente dele | O painel de configuração do agente (`/p/<agente>/`) |
| O próprio nome e o botão **Sair** | A lista de colaboradores e a tela de convidar |

Isso vale no servidor, não só na tela: o endereço de qualquer outro agente ou página do dono responde "acesso não liberado". O Admin nunca pode ser compartilhado.

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

Quando o agente do colaborador ainda não tem a conta de IA conectada, o colaborador vê o aviso na conversa e conecta a conta dele pela página **Conectar conta**, que está no menu dele.

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

O servidor nega por padrão (`web/lib/escopo.js`). Para o colaborador passam só:

- os arquivos estáticos da tela;
- as páginas `/`, `/a/<agente dele>`, `/conectar` e `/trocar-senha`;
- `GET /api/v1/eu`, `POST /api/v1/eu/senha`, `GET /api/v1/agents` (só o agente dele) e `GET /api/v1/nao-lidas`;
- as rotas da conversa em `/api/v1/agents/<agente dele>/…`: `messages`, `stream`, `wait`, `send`, `permissao`, `pergunta`, `reiniciar`, `lido`, `nao-lido`, `vendo`, `upload`, `compartilhados`, `avatar`, `alertas` e `login`;
- as mídias que pertencem ao agente dele, menos arquivos ocultos da casa (como `.claude`) e qualquer coisa fora da casa do agente;
- `POST /api/v1/transcribe`, `POST /api/v1/tts` e `GET /api/v1/tts/cota`.

Regras que o servidor aplica por cima da lista:

- Comandos de barra não existem para ele: `/comando` e `/comandos` são negados, e um texto que começa com `/` segue como mensagem comum, dentro do envelope com `from="colaborador: …"`.
- Ele só responde a pedido de permissão ou pergunta do agente quando foi ele quem iniciou o turno; senão recebe "Essa confirmação é do dono do DG Claw".
- Ele só inicia o login da conta de IA (e manda o código) quando o agente está sem conta ou com o login vencido. Trocar uma conta que funciona é com o dono.
- O stream e as mensagens dele não trazem o modo foco nem os avisos técnicos do servidor.
- Um `[anexo: caminho]` digitado na conversa (pelo dono ou pelo colaborador) só vira mídia se o arquivo estiver na pasta `uploads/` do agente.
- Enquanto vale a senha temporária, a sessão dele dura no máximo até ela vencer. Na troca de senha, 5 erros da senha atual em 15 minutos bloqueiam por 15 minutos (`429` com `Retry-After`).

WebSocket e `/p/…` são sempre negados.

### Onde ficam os dados

`<DGCLAW_WEB_DATA>/colaboradores.json`, com permissão 600. Só o Web grava. Se você editar o arquivo à mão, o Web relê sozinho. Se o JSON estiver quebrado, ele registra no log o caminho e o motivo, trata como "nenhum colaborador" e **não** apaga nem regrava o arquivo: convidar fica recusado até você corrigir.
