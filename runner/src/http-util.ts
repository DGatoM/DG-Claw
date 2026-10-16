// Pedaços de HTTP que o servidor e as rotas de provedor dividem.
import http from "node:http";

export const CORPO_MAX = 5 * 1024 * 1024;

export function json(res: http.ServerResponse, corpo: unknown, status = 200): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(texto);
}

export async function lerCorpo(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let dados = "";
    req.on("data", (pedaco: Buffer) => {
      dados += pedaco.toString();
      if (dados.length > CORPO_MAX) {
        reject(new Error(`corpo acima de ${CORPO_MAX} bytes`));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!dados.trim()) return resolve({});
      try {
        const o = JSON.parse(dados) as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("o corpo precisa ser um objeto JSON");
        resolve(o as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`corpo não é JSON válido: ${err instanceof Error ? err.message : err}`));
      }
    });
    req.on("error", reject);
  });
}

/** Erro no formato de sempre: o que falhou, como resolver, e um código que o painel testa. */
export function erro(res: http.ServerResponse, status: number, code: string, error: string, howToFix: string): void {
  json(res, { success: false, error, howToFix, code }, status);
}
