#!/usr/bin/env bun
// notify.ts — manda uma mensagem ao dono no Telegram via Bot API sendMessage.
//
// É a ponte "qualquer coisa → Telegram" do DG Claw local: hooks, tarefas
// agendadas (CronCreate) e scripts avulsos usam isto pra falar com o dono SEM
// tocar no poller (getUpdates é exclusivo do canal; ENVIAR é livre, não dá 409).
//
// Uso:
//   bun .dgclaw/scripts/notify.ts "sua mensagem"
//   echo "mensagem" | bun .dgclaw/scripts/notify.ts
//
// Lê o token do .env do state dir do agente e o chat do dono do access.json.
// Escreva pra Telegram: SEM markdown (asteriscos viram lixo visual) — emojis e
// texto corrido.

import { sendToOwner, workspaceRoot } from "./lib";

async function main() {
  let text = process.argv.slice(2).join(" ").trim();
  if (!text && !process.stdin.isTTY) {
    text = (await Bun.stdin.text()).trim();
  }
  if (!text) {
    console.error('uso: bun notify.ts "mensagem" (ou via stdin)');
    process.exit(2);
  }
  const ws = workspaceRoot();
  const res = await sendToOwner(ws, text, 10_000);
  if (res.ok) {
    console.log("enviado ✓");
  } else {
    console.error(`falhou: ${res.error}`);
    process.exit(1);
  }
}

main();
