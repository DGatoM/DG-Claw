// Log do runner: uma linha por evento, com carimbo, nível e assunto.
//
// Deliberadamente sem dependência: este processo tem que subir numa VPS de
// cliente onde não existe nada da casa. E deliberadamente com `motivo` e
// `oQueFazer` separados na assinatura de `erro`, porque a regra do projeto é
// que log de falha diga o que falhou, com que entrada, e o que fazer a
// respeito. Um `catch` mudo aqui vira, três dias depois, "o agente não
// responde" sem uma linha para puxar.
import fs from "node:fs";
import path from "node:path";

const ARQUIVO = process.env.RUNNER_LOG?.trim() || null;

function escrever(nivel: string, assunto: string, msg: string): void {
  const linha = `[${new Date().toISOString()}] ${nivel.padEnd(5)} ${assunto.padEnd(8)} ${msg}`;
  // stdout sempre: no systemd é isto que o journalctl mostra.
  if (nivel === "ERRO") console.error(linha);
  else console.log(linha);
  if (!ARQUIVO) return;
  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.appendFileSync(ARQUIVO, linha + "\n");
  } catch {
    // Não há para onde reclamar de falha ao escrever log sem virar recursão.
    // O stdout acima já saiu, então nada se perde de verdade.
  }
}

export const log = {
  info: (assunto: string, msg: string) => escrever("INFO", assunto, msg),
  aviso: (assunto: string, msg: string) => escrever("AVISO", assunto, msg),
  /**
   * @param motivo o que falhou, com a entrada que causou
   * @param oQueFazer o comando ou a decisão que resolve; obrigatório de propósito
   */
  erro: (assunto: string, motivo: string, oQueFazer: string) =>
    escrever("ERRO", assunto, `${motivo} | O que fazer: ${oQueFazer}`),
  debug: (assunto: string, msg: string) => {
    if (process.env.RUNNER_DEBUG === "1") escrever("DEBUG", assunto, msg);
  },
  ARQUIVO,
};
