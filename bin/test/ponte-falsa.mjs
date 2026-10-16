// Ponte FALSA do WhatsApp, so para o teste do dgclaw-agente. Nao conecta em nada.
//   --parear <digitos>: grava estado.json e o arquivo "codigo" (ABCD-1234) e fica viva uns segundos.
//                       Com PONTE_FALSA_MODO=falha grava estado "erro" com motivo e sai com 1.
//   --logout:           anota um marcador em $PONTE_FALSA_LOG.
import fs from "node:fs";
import path from "node:path";

const pasta = path.join(process.env.HOME, ".dgclaw", "whatsapp");
const estado = (o) => fs.writeFileSync(path.join(pasta, "estado.json"),
  JSON.stringify({ versao: 1, desde: new Date().toISOString(), numero_bot: null, motivo: null, ...o }) + "\n", { mode: 0o600 });

const [, , modo, arg] = process.argv;
if (modo === "--parear") {
  fs.mkdirSync(pasta, { recursive: true });
  if (process.env.PONTE_FALSA_MODO === "falha") {
    estado({ estado: "erro", motivo: "o WhatsApp recusou o numero (teste)" });
    console.error("ponte falsa: falhei de proposito");
    process.exit(1);
  }
  estado({ estado: "codigo_pronto" });
  fs.writeFileSync(path.join(pasta, "codigo"), "ABCD-1234\n", { mode: 0o600 });
  fs.appendFileSync(process.env.PONTE_FALSA_LOG || "/dev/null", `parear ${arg}\n`);
  setTimeout(() => process.exit(0), 4000);
} else if (modo === "--logout") {
  fs.appendFileSync(process.env.PONTE_FALSA_LOG, "logout\n");
} else {
  console.error("ponte falsa: modo desconhecido " + modo);
  process.exit(1);
}
