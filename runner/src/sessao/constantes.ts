
/** Quanto da tela guardamos para quem chegar depois (o painel pede o buffer ao abrir). */
export const BUFFER_MAX = 200 * 1024;
/** O Stop dispara no fim de TODO turno, inclusive intermediário. Só vira
 *  "concluído" depois de tanto tempo quieto. Mesmo valor do Bunker. */
export const STOP_CONFIRM_MS = 6_000;
/** Rede de segurança do Stop perdido (17/10/2026: 33 min "working" com a fila presa). O silêncio do
 *  terminal só é o GATILHO para olhar o transcript; a prova de que o turno acabou é a última linha dele
 *  ser `system/turn_duration`. Silêncio sozinho não prova nada: medido no Claude Code real, um `sleep 50`
 *  deixa o PTY sem um byte por 50s com o turno em andamento. */
export const QUIETO_PARA_OLHAR_TRANSCRIPT_MS = 20_000;
export const CONFERE_TRANSCRIPT_A_CADA_MS = 5_000;
/** Rede de segurança do PreCompact sem fim (19/11/2026: o CLI recusou um /compact com "Not enough messages to
 *  compact.", mandou o PreCompact e nunca mandou SessionStart nem Stop; o agente ficou "working" por horas com a
 *  fila presa). Passado este tempo em "hook:PreCompact" com o terminal quieto há COMPACT_QUIETO_REDE_MS, volta para
 *  idle. Só o Claude tem PreCompact; o Codex não passa por aqui. */
export const COMPACT_SEM_FIM_MS = 15 * 60_000;
export const COMPACT_QUIETO_REDE_MS = 2 * 60_000;
/** De quanto em quanto tempo, com o login expirado, olhamos se a credencial foi renovada (um `stat`). */
export const VIGIA_LOGIN_EXPIRADO_MS = 30_000;

/** Pausa entre as teclas da resposta de uma pergunta de escolha: o diálogo do Claude Code redesenha a cada tecla, e
 *  uma sequência despejada de uma vez perde teclas. Medido no Claude Code 2.1.304. */
export const PAUSA_TECLA_PERGUNTA_MS = 350;
/** Colagem: pedaços de 128 a cada 25ms, e o Enter só depois de drenar. */
export const PEDACO = 128;
export const INTERVALO_MS = 25;
/** Quantas vezes batemos no Enter se ele não virar turno. Quanto esperar pelo recibo
 *  depende do motor (Motor.reciboMs). Ver enviarComRecibo(). */
export const RECIBO_ENTER_TENTATIVAS = 3;
/** Depois das tentativas acima sem recibo, a vigia em segundo plano bate mais um Enter a cada um destes
 *  intervalos (5s, 10s, 20s e 40s depois do último: ~75s no total). Medido em produção: texto grande
 *  colado em pedaços às vezes demora mais que 3,6s para ser aceito. */
export const RECIBO_VIGIA_PASSOS_MS = [5_000, 10_000, 20_000, 40_000];
/** Um `--resume` que morre dentro desta janela morreu por causa da sessão, não
 *  do trabalho. Medido: `claude --resume <id>` de um id sem transcript no disco
 *  sai com código 1 em ~2s. */
export const RESUME_MORREU_CEDO_MS = 15_000;
/** Depois de subir um PTY, a fila só solta texto passado este tempo E com a tela
 *  quieta por QUIETO_ANTES_DE_DIGITAR_MS. O SessionStart de um `--resume` chega
 *  em ~1,4s, antes de o TUI acabar de desenhar o histórico: o texto digitado ali
 *  some e os três Enters batem numa caixa vazia (ensaio de 09/10/2026, sessão de
 *  bastidores acordando depois de suspensa). Só vale para os primeiros
 *  JANELA_DE_PRONTIDAO_MS do spawn; depois disso a fila solta como sempre. */
export const PRONTO_APOS_SPAWN_MS = 5_000;
export const QUIETO_ANTES_DE_DIGITAR_MS = 1_200;
export const JANELA_DE_PRONTIDAO_MS = 30_000;
/** A máscara de segredo retém o final do que pode ser começo de segredo. Passado este silêncio
 *  ela é descarregada, senão o fim da linha ficaria preso na tela. */
export const SILENCIO_DA_MASCARA_MS = 50;
/** Motor sem SessionStart (Codex): a tela quieta por este tempo é o "pronto". */
export const QUIETO_DE_BOOT_MS = 1_500;
/** Depois deste tempo sem rollout, o Codex provavelmente nem abriu a conversa. */
export const ROLLOUT_AUSENTE_MS = 60_000;

/** Mensagem que esperou na fila mais que isto chega ao agente com um aviso de atraso (ver avisoDeAtraso). */
export const AVISO_DE_FILA_APOS_MS = 20_000;
