
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
/** De quanto em quanto tempo, com o login expirado, olhamos se a credencial foi renovada (um `stat`). */
export const VIGIA_LOGIN_EXPIRADO_MS = 30_000;
/** Colagem: pedaços de 128 a cada 25ms, e o Enter só depois de drenar. */
export const PEDACO = 128;
export const INTERVALO_MS = 25;
/** Quantas vezes batemos no Enter se ele não virar turno. Quanto esperar pelo recibo
 *  depende do motor (Motor.reciboMs). Ver enviarComRecibo(). */
export const RECIBO_ENTER_TENTATIVAS = 3;
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
