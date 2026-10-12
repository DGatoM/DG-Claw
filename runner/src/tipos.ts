// Tipos do agente, copiados de @agent-panel/shared (dg-ai-bunker, packages/shared/src/types.ts).
//
// O runner nasceu dentro do monorepo do Bunker e importava estes tipos do pacote
// compartilhado. No DG Claw ele roda sozinho, na VPS do aluno, onde não existe
// Bunker nem monorepo: por isso os tipos que ele usa moram aqui. Só tipos, nada de
// código. Se o Bunker mudar o formato de AgentConfig ou AgentState, este arquivo
// precisa acompanhar à mão.

// -- Agent Status Machine --
export type AgentStatus =
  | "spawning"
  | "working"
  | "waiting_input"
  | "idle"
  | "completed"
  | "errored"
  | "stopped"
  | "resumable";

export type AgentProviderType = "claude-code" | "openclaw" | "local-cli" | "codex-cli";

export type UserLevel = "beginner" | "intermediate" | "advanced";

// -- Agent --
export interface AgentConfig {
  name: string;
  cwd: string;
  initialPrompt: string;
  provider: AgentProviderType;
  model?: string;
  allowedTools?: string[];
  /**
   * Quanto o agente pode fazer sozinho. Vai SEMPRE explícito na linha de comando
   * do CLI (antes era omitido, e aí o agente herdava o settings.json global da
   * máquina, o que fazia o modo escrito no card ser mentira).
   *
   * - `auto`              o modelo decide o que precisa de autorização. Pergunta
   *                       o que tem que perguntar e não pergunta em excesso.
   *                       É o padrão dos cards do painel.
   * - `default`           pergunta tudo que não estiver nas regras de allow.
   *                       É o modo das sessões filhas do agente gestor: o valor
   *                       delas está em PARAR e pedir, porque é o prompt de
   *                       permissão que dispara o escalonamento.
   * - `acceptEdits`       edita arquivo sem perguntar, o resto pergunta.
   * - `bypassPermissions` não pergunta nada. Perigoso para agente que executa
   *                       tarefa; aceitável para agente informacional.
   *
   * Equivalência no Codex (o painel é agnóstico de CLI, ver `codexApprovalArgs`):
   * auto → `-a on-request`, default → `-a untrusted`, bypass →
   * `--dangerously-bypass-approvals-and-sandbox`.
   */
  permissionMode?: "auto" | "default" | "acceptEdits" | "bypassPermissions";
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  tags?: string[];
  /**
   * A estrela: este card é dos prioritários.
   *
   * Existe porque o painel passa dos cinquenta cards abertos, e todos são
   * importantes de alguma forma. O que faltava era separar "importante" de "é
   * este aqui que eu preciso lembrar hoje", e essa separação estava só na
   * cabeça do dono, que é onde ela se perde.
   *
   * Fica na config, e não no estado, por dois motivos: sobrevive ao restart do
   * servidor (o estado não), e o handoff copia a config inteira para a
   * sucessora, então a estrela atravessa a troca de sessão sem ninguém precisar
   * marcar de novo — que é metade do valor de ter marcado.
   */
  favorito?: boolean;
  projectId?: string;
  /**
   * Isolamento git: spawnar o agente dentro de uma worktree própria
   * (pasta irmã + branch session/<slug>) em vez da pasta do projeto.
   * Ignorado silenciosamente se o cwd não for um repo git.
   */
  isolateWorktree?: boolean;
  /**
   * A que "mundo" o card pertence. Ausente = card comum do painel (o caso dos
   * 57 de hoje).
   *
   * - `fin`     Área Financeira: card protegido pela segunda senha. Nasce SÓ via
   *             POST /api/fin/spawn (o WS spawn_agent rejeita), roda no workspace
   *             financeiro, recebe env Pluggy/fin.db e morre quando a área
   *             tranca. Nunca persiste no data/agents.json.
   * - `manager` Agente gestor de um projeto (Fase 1): conversa pelo DG Chat,
   *             cria tarefa, spawna filhas e escala decisão pro dono.
   * - `child`   Sessão filha spawnada por um gestor pra executar uma tarefa.
   *             Nasce em permissionMode "auto" (nunca bypass): o classificador do
   *             Claude Code libera o seguro, e as listas ask/deny da plataforma
   *             garantem que o que é decisão continue PARANDO e virando
   *             escalonamento. Ver manager-api.ts.
   * - `user`    Agente entregue a um terceiro (Fase 3), atrás de login próprio.
   */
  area?: "fin" | "manager" | "child" | "user";
  /**
   * O nome deste card foi escrito pelo DONO, na tela, e não deve ser trocado por
   * nada automático.
   *
   * Existe porque renomear um card no painel respondia "renomeado" e não durava:
   * o TUI do Claude reescreve o título da janela (OSC-0) a cada poucos segundos
   * com o nome da SESSÃO, e o card adotava esse título de volta. Do lado de fora
   * parecia que a renomeação tinha sido ignorada, sem erro nenhum.
   *
   * Marcado pelo `POST /api/agents/<id>/rename` e pelo `/rename` digitado dentro
   * do card: os dois são gesto deliberado de quem manda. O que fica de fora é só
   * a adoção automática do título; o rastreamento por título (que é quem
   * reencontra o .jsonl certo depois de um `/resume`) continua rodando igual.
   */
  nomeFixado?: boolean;
  /**
   * Argumentos extras concatenados na linha de comando do CLI, depois dos que o
   * Bunker monta. É por aqui que a Fase 1 passa `--append-system-prompt-file`
   * (a REGRA ZERO do canal). Só vale pros providers PTY.
   */
  extraArgs?: string[];
  /**
   * Variáveis de ambiente aplicadas POR CIMA do env montado pelo vault. Chaves
   * em BLOCKED_HOST_KEYS continuam recusadas (o card nunca recebe chave de LLM
   * em texto claro, isso é papel do proxy com placeholder `vault:`).
   */
  envExtra?: Record<string, string>;
  /**
   * A LISTA do que este card pode receber do cofre, por `envName`.
   *
   * Ausente = o card recebe o cofre inteiro, que é o comportamento de sempre e o
   * certo para card de trabalho (o gestor precisa da chave do projeto que ele
   * está tocando, e é o dono quem senta nele).
   *
   * Presente = SÓ o que está na lista entra. Lista vazia = nada entra.
   *
   * Existe por um problema medido em 18/08/2026: 77 dos 79 segredos do cofre não
   * têm `projectPath`, e por isso caíam no ambiente de TODO card. Um agente
   * entregue a um terceiro (`area: "user"`, um agente que roda fora do painel do
   * dono) nascia enxergando a string de conexão do banco, as chaves das
   * plataformas de pagamento, os tokens de rede social e as credenciais
   * contábeis. Nenhum deles precisa de nada disso, e o dono do agente não é o
   * dono das chaves.
   *
   * A regra que fica: agente de terceiro nasce com a lista, e ganha uma chave de
   * cada vez, quando o poder que precisa dela for ligado.
   */
  cofre?: string[];
  /**
   * Caminho de um arquivo `--mcp-config` (ou o JSON inline) com os servidores MCP
   * exclusivos deste card. É assim que o MCP `dgchat` entra na sessão: o
   * settings.json do usuário NÃO aceita `mcpServers`.
   *
   * NUNCA acompanhado de `--strict-mcp-config`: isso derrubaria os MCPs globais
   * (playwright-heygen e afins) de todo card.
   */
  mcpConfig?: string;
  /**
   * Regras que entram em `permissions.allow` do settings deste card (o mesmo
   * arquivo que já leva os hooks). Formato do Claude Code: `mcp__<servidor>` libera
   * o servidor MCP inteiro, `mcp__<servidor>__<tool>` libera uma tool só.
   *
   * Existe por um motivo concreto: a tool que ENTREGA a resposta do agente ao dono
   * dele não pode pedir autorização, senão toda resposta para esperando alguém
   * apertar "1" e a pessoa do outro lado vê uma janela muda. Os servidores
   * declarados em `mcpConfig` já são liberados por derivação; isto é o caminho
   * explícito, para quando se quer liberar uma tool específica e nada mais.
   *
   * Card comum não tem isto, e o settings dele continua saindo só com `hooks`.
   */
  allowTools?: string[];
  /**
   * Regras que entram em `permissions.ask` do settings deste card: ferramentas que
   * **têm que parar e perguntar**, mesmo que alguma outra camada as tenha liberado.
   *
   * Existe por um defeito achado no aceite da Fase 1.5 (06/08/2026), e é o oposto
   * do `allowTools`. O `--settings` do card SOMA ao `settings.json` do usuário, que
   * nesta máquina tem 118 regras de `allow` (entre elas `Bash(bash:*)`,
   * `Bash(curl:*)`, `Bash(node -e:*)`, `Bash(systemctl:*)`). Uma sessão filha, que
   * só existe para PARAR e pedir autorização, herdava tudo isso e não parava
   * nunca: o hook `Notification(permission_prompt)` não disparava, o card jamais
   * entrava em `waiting_input`, e o escalonamento inteiro deixava de existir **em
   * silêncio**, com tudo aparentando funcionar.
   *
   * No Claude Code a precedência é `deny` > `ask` > `allow`, então uma regra aqui
   * vence o allowlist pessoal de quem é dono da máquina sem precisar cortar a
   * herança (isso continua sendo assunto da jaula da Fase 3). `ask: ["Bash"]` é o
   * caso de uso: toda linha de shell pergunta, enquanto as ferramentas nativas de
   * arquivo (Read/Glob/Grep/Edit) seguem liberadas por `allowTools`.
   *
   * Card comum não tem isto e o settings dele não ganha o bloco.
   */
  askTools?: string[];
  /**
   * Regras que entram em `permissions.deny` do settings deste card: o que não
   * acontece nem com autorização. `deny` é o topo da precedência no Claude Code,
   * então vence o `ask`, o `allow` do card e as 118 regras herdadas do dono da
   * máquina.
   *
   * Existe porque `ask` sozinho não dá para escolher (10/08/2026). Enquanto
   * `askTools` era `["Bash"]` inteiro, uma sessão filha parava em `ls` e em `cat`:
   * 24 paradas em 16 minutos numa investigação só de leitura, cada uma virando um
   * escalonamento para o gestor decidir. Estreitar o `ask` para o que é decisão de
   * verdade só é seguro se o que é catastrófico estiver em `deny`, porque abaixo
   * do `ask` mora o allowlist herdado, que nesta máquina inclui `Bash(systemctl:*)`,
   * `Bash(crontab:*)`, `Bash(kill:*)` e `Bash(chown:*)`.
   *
   * A divisão que vale: `deny` é o que não tem uso legítimo para uma sessão de
   * execução confinada a uma pasta de projeto; `ask` é o que tem uso legítimo mas
   * é decisão de alguém; `allow` é a leitura barata que não merece interrupção.
   *
   * Card comum não tem isto e o settings dele não ganha o bloco.
   */
  denyTools?: string[];
  /**
   * Comandos extras registrados no hook `Stop` deste card, ao lado do handler de
   * status que o Bunker já escreve. Cada item é a linha de comando inteira, como
   * o Claude Code a executará.
   *
   * É por aqui que entra a trava do DG Chat
   * (`apps/agents-server/hooks/stop-force-reply.py`), que devolve o turno ao
   * agente quando ele tenta encerrar sem ter entregue a resposta pela tool do
   * canal. Sem ela, o modo de falha mais comum do canal (escrever a resposta como
   * texto e achar que respondeu) deixa a pessoa olhando para uma janela muda.
   *
   * Os comandos do mesmo evento rodam em paralelo, então não há como garantir
   * ordem entre a trava e o handler de status: enquanto a trava segura o turno, o
   * card pode piscar "Tarefa concluída" antes de voltar para "trabalhando". É
   * cosmético e conhecido.
   *
   * Card comum não tem isto e o `Stop` dele continua com um comando só.
   */
  stopHooks?: string[];
  /**
   * A pasta do PROJETO a que este card pertence, quando ela não é o `cwd`.
   *
   * Existe por causa do card do gestor (Fase 1.6a). O board agrupa por pasta, e o
   * `cwd` do gestor é o workspace dele (`/home/agente`), não a pasta do
   * projeto que ele gere: ele nasce assim de propósito, porque é do `cwd` que o
   * Claude Code descobre a skill e o `CLAUDE.md` dele, e porque o transcript fica
   * numa pasta só dele em vez de misturado com as dezenas de sessões que já
   * existem na pasta do projeto. Sem este campo o gestor cairia num grupo próprio,
   * longe das sessões que ele mesmo abriu.
   *
   * Quem lê agrupa por `projectCwd ?? cwd` — ver `projetoDoCard()` no `apps/web`.
   * As sessões filhas não precisam disto: elas já nascem com o `cwd` na pasta do
   * projeto.
   */
  projectCwd?: string;
  /** Gestor dono desta sessão filha (só em `area: "child"`). */
  managerId?: string;
  /** Tarefa do agents-server que originou esta sessão filha. */
  taskId?: string;
}

/** Info da worktree associada a um agente isolado (espelho do WorktreeRecord do servidor). */
export interface AgentWorktreeInfo {
  id: string;
  /** Pasta original do repo (a que o vault conhece). */
  projectPath: string;
  /** Pasta irmã onde o agente realmente roda. */
  worktreePath: string;
  branch: string;
}

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  sessionId: string | null;

  currentTask: string | null;
  currentTool: string | null;
  todoItems: TodoItem[];
  lastMessage: string | null;

  pendingPermission: PermissionRequest | null;

  createdAt: number;
  /** Última ativação/envio; renomear e telemetria não alteram esta ordem. */
  lastActivatedAt?: number;
  /**
   * Quando o DONO digitou neste card pela última vez (Enter no terminal do
   * painel, ou a tecla que responde um pedido de permissão).
   *
   * É um sinal diferente de `lastActivatedAt` e de `updatedAt`, e a diferença é
   * o ponto: os dois medem o agente se mexendo, e o agente se mexe sozinho a
   * noite inteira. Este mede a PESSOA. Só quem escreve aqui é o teclado do
   * painel (`terminal_input` do WebSocket); entrega automática, cutucão em
   * lote, handoff e a rota de digitar por API entram como `sistema` e não
   * encostam neste campo. Ausente = ninguém digitou neste card desde que o
   * campo passou a existir, e ausente NUNCA vira zero nem vira "hoje".
   */
  ultimaEntradaDoDono?: number;
  updatedAt: number;
  costUsd: number;
  turns: number;
  toolCallsCount: number;
  messagesCount: number;

  error: string | null;
  /** When true, hook has set idle/waiting_input — PTY output won't flip back to working */
  hookLatched?: boolean;
  /** Tracks whether this agent has ever received a hook callback */
  hookActive?: boolean;
  /** Debug: what signal triggered the last status change */
  statusReason?: string;
  /** Transient: current phase of an in-progress automated handoff (botão 🤝). */
  handoffPhase?: string | null;
  /** Set when a handoff has spawned its successor — lets the UI open it. */
  handoffNewAgentId?: string | null;
  /** Presente quando o agente roda isolado numa worktree git. */
  worktree?: AgentWorktreeInfo | null;
  /**
   * Sessão anterior preservada quando um revive gera sessionId novo.
   * Proteção contra perda de vínculo com o histórico (incidente 2026-06-12):
   * permite restaurar a conversa antiga via POST /api/agents/:id/restore-session.
   */
  previousSessionId?: string | null;
}

export interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  description: string;
  timestamp: number;
}
