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

/** Trava compartilhada pelos escritores do DG Claw no mesmo arquivo (runner, socorro, launch.sh e crons,
 *  pelo scripts/_lib/confiar-pastas.py): uma pasta `<arquivo>.dgclaw-trava`, que o mkdir cria ou recusa de
 *  forma atômica e que serve igual no Node e no Python. Leitura, alteração e gravação acontecem dentro dela,
 *  para um escritor não apagar o que o outro acabou de gravar. Trava com mais de 30 s é de processo morto e
 *  é retirada. Sem conseguir em ~3 s, lança: quem chama decide se é aviso ou erro. */
export function comTravaDeArquivo<T>(arquivo: string, fn: () => T): T {
  const trava = `${arquivo}.dgclaw-trava`;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const espera = new Int32Array(new SharedArrayBuffer(4));
  for (let tentativa = 0; ; tentativa++) {
    try {
      fs.mkdirSync(trava);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(trava).mtimeMs > 30_000) {
          fs.rmdirSync(trava);
          continue;
        }
      } catch {
        /* a trava sumiu entre o mkdir e o stat: tenta de novo */
      }
      if (tentativa >= 60) throw new Error(`a trava ${trava} está ocupada há mais de 3 s por outro escritor`);
      Atomics.wait(espera, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(trava);
    } catch {
      /* já retirada como velha por outro processo: nada a fazer */
    }
  }
}
