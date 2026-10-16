// Escrita de arquivo pequena e segura, usada por vários pontos do runner.
import fs from "node:fs";
import path from "node:path";

/**
 * Grava um JSON por arquivo temporário + rename na MESMA pasta: quem lê nunca vê o
 * arquivo pela metade, e um corte de energia no meio não deixa um JSON truncado
 * no lugar do bom. O modo do arquivo que já existia é preservado (um
 * `.claude.json` 600 não pode virar 644); arquivo novo nasce com `modoNovo`.
 */
export function gravarJsonAtomico(arquivo: string, conteudo: unknown, modoNovo = 0o600): void {
  const pasta = path.dirname(arquivo);
  fs.mkdirSync(pasta, { recursive: true });
  let modo = modoNovo;
  try {
    modo = fs.statSync(arquivo).mode & 0o777;
  } catch {
    /* primeiro arquivo: vale o modo novo */
  }
  const tmp = path.join(pasta, `.${path.basename(arquivo)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(conteudo, null, 2) + "\n", { mode: modo });
    fs.chmodSync(tmp, modo);
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* o temporário já não existe: nada a limpar */
    }
    throw err;
  }
}
