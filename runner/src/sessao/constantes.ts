
/** Quanto da tela guardamos para quem chegar depois (o painel pede o buffer ao abrir). */
export const BUFFER_MAX = 200 * 1024;
/** O Stop dispara no fim de TODO turno, inclusive intermediário. Só vira
 *  "concluído" depois de tanto tempo quieto. Mesmo valor do Bunker. */
export const STOP_CONFIRM_MS = 6_000;
/** Há quanto tempo um subagente pode estar sem sinal e ainda segurar a suspensão do card: um SubagentStop perdido
 *  não pode manter o card acordado para sempre. */
export const SUBAGENTE_SEM_SINAL_MAX_MS = 2 * 60 * 60_000;
/** Teto de subagentes rastreados por sessão; com o mapa cheio, o de sinal mais antigo sai. */
export const SUBAGENTES_RASTREADOS_MAX = 64;
/** Rede de segurança do Stop perdido (17/10/2026: 33 min "working" com a fila presa). O silêncio do
 *  terminal só é o GATILHO para olhar o transcript; a prova de que o turno acabou é a última linha dele
 *  ser `system/turn_duration`. Silêncio sozinho não prova nada: medido no Claude Code real, um `sleep 50`
 *  deixa o PTY sem um byte por 50s com o turno em andamento. */
export const QUIETO_PARA_OLHAR_TRANSCRIPT_MS = 20_000;
export const CONFERE_TRANSCRIPT_A_CADA_MS = 5_000;
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
/** A escrita no emulador de tela é assíncrona: para levantar a suspensão por rascunho o terminal precisa estar quieto
 *  por este tempo, senão a leitura pegaria uma tela de alguns milissegundos atrás. */
export const QUIETO_PARA_LER_TELA_MS = 500;
/** A máscara de segredo retém o final do que pode ser começo de segredo. Passado este silêncio
 *  ela é descarregada, senão o fim da linha ficaria preso na tela. */
export const SILENCIO_DA_MASCARA_MS = 50;
/** Motor sem SessionStart (Codex): a tela quieta por este tempo é o "pronto". */
export const QUIETO_DE_BOOT_MS = 1_500;
/** Depois deste tempo sem rollout, o Codex provavelmente nem abriu a conversa. */
export const ROLLOUT_AUSENTE_MS = 60_000;
/** Claude: quando o boot-timer olha se o SessionStart chegou. Sem hook e sem a tela mostrar o prompt pronto, a
 *  fila continua presa até TETO_BOOT_SEM_SINAL_MS (um Claude travado também parece "quieto"). */
export const BOOT_TIMER_MS = 8_000;
export const TETO_BOOT_SEM_SINAL_MS = 30_000;
/** Claude: sem NENHUM hook na vida da sessão, só depois deste tempo desde o spawn ele é tratado como agente
 *  sem hooks registrados (sem recibo possível). Antes disso, "ainda não chegou" não é "não existe": o recibo é
 *  esperado e a vigia do Enter fica armada. */
export const PRAZO_SEM_HOOKS_MS = 60_000;

/** Mensagem que esperou na fila mais que isto chega ao agente com um aviso de atraso (ver avisoDeAtraso). */
export const AVISO_DE_FILA_APOS_MS = 20_000;

/** Um Enter vindo de fora (o dono, pelo terminal) segura a fila até o recibo dele chegar ou até este prazo. */
export const ENTER_MANUAL_SEGURA_FILA_MS = 15_000;
/** Quantos pedidos retidos (incertos) ficam guardados no arquivo; ao passar disso o mais antigo é descartado, com aviso. */
export const MAX_RETIDOS = 20;

/** Depois de uma escrita do dono no terminal, a tela só vale como prova de "caixa vazia" se o terminal desenhou algo depois
 *  dela. Uma tecla que não redesenha nada (uma seta numa caixa vazia) não pode segurar a fila para sempre: passado este
 *  tempo sem nenhum redesenho, a tela é aceita como está. */
export const REDESENHO_DEPOIS_DA_TECLA_MS = 2_000;
/** Codex: quantos turnos do rollout ficam guardados para conferir recibos. */
export const TURNOS_DO_CODEX_GUARDADOS = 50;

// Emulador de tela: quando a escrita nele lança (a fila interna do @xterm/headless passa de 50 milhões de unidades), ele é
// recriado vazio e a tela daquela sessão NÃO serve de prova (a digitação automática fica suspensa) até uma limpeza de tela
// INTEGRAL (ESC[2J ou ESC c, o RIS). Nem o ESC[3J (que no xterm limpa só o histórico de rolagem) nem uma quantidade de saída
// nova bastam: uma atualização parcial pode redesenhar o marcador e o rodapé sem redesenhar um rascunho que continua no CLI.

/** Envios diretos (POST /input com submit) que podem esperar a vez, por sessão, e a soma dos bytes deles. Acima disso a rota
 *  responde 429 ENVIOS_DEMAIS sem escrever nada: cada pedido em espera segura texto e contexto HTTP em memória. */
export const MAX_ENVIOS_DIRETOS_ESPERANDO = 8;
export const MAX_BYTES_DIRETOS_ESPERANDO = 1024 * 1024;
/** Controle de fluxo PTY -> emulador: acima de PENDENTE_PAUSA o PTY é pausado, e só volta a ler abaixo de PENDENTE_RETOMA. */
export const EMULADOR_PENDENTE_PAUSA = 4 * 1024 * 1024;
export const EMULADOR_PENDENTE_RETOMA = 1024 * 1024;
