// mudanca.mjs: a mudanca do agente do computador pra VPS, num arquivo so, cifrado.
//
// Roda em bun ou em node (>=18), sem instalar nada. Existe porque o aluno pode estar no
// Windows, no Mac ou no Linux, e a unica coisa que da pra garantir nas tres maquinas e o
// motor de JavaScript que ja veio junto com o resto.
//
// Comandos:
//   empacotar <pasta-do-agente> <pasta-da-memoria-nativa|-> <saida.cofre> [--senha X]
//   listar    <arquivo.cofre> <senha>
//   abrir     <arquivo.cofre> <senha> <pasta-destino>
//   enviar    <arquivo> <token-do-bot> <chat-id>
//   baixar    <file-id> <token-do-bot> <destino>
//   achar     <token-do-bot>            (procura o ultimo arquivo mandado pro bot)
//
// O formato do cofre: "DGMUD1" + sal(16) + iv(12) + selo(16) + conteudo cifrado.
// A chave sai da senha por scrypt, e o conteudo e um JSON com todos os arquivos em base64,
// comprimido com gzip antes de cifrar. Nada de dependencia externa: e tudo biblioteca padrao.
//
// A senha NUNCA viaja junto com o arquivo. O arquivo vai pelo Telegram, a senha aparece na
// tela do computador do aluno, e ele leva as duas coisas pra VPS na mao.

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";

const MAGICO = "DGMUD1";
const LIMITE_ARQUIVO = 8 * 1024 * 1024;   // 8 MB por arquivo: acima disso e midia, nao memoria
const LIMITE_TOTAL = 45 * 1024 * 1024;    // o Telegram aceita 50 MB; paramos antes

// Pastas e arquivos que nao fazem parte da mudanca: cache, dependencia, lixo de sistema.
const IGNORAR = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".DS_Store",
  "Thumbs.db", ".pytest_cache", ".mypy_cache", "dist", "build",
]);

function morrer(msg) {
  console.error(`mudanca: ${msg}`);
  process.exit(1);
}

function senhaNova() {
  // 4 grupos de 4 caracteres sem ambiguidade visual: da pra ditar por telefone.
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += alfabeto[b[i] % alfabeto.length];
    if (i % 4 === 3 && i !== 15) s += "-";
  }
  return s;
}

function listarArquivos(raiz, prefixo = "") {
  const saida = [];
  let entradas;
  try {
    entradas = readdirSync(raiz, { withFileTypes: true });
  } catch (e) {
    throw new Error(`nao consegui ler a pasta ${raiz}: ${e.message}`);
  }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const cheio = join(raiz, e.name);
    const rel = prefixo ? `${prefixo}/${e.name}` : e.name;
    if (e.isDirectory()) {
      saida.push(...listarArquivos(cheio, rel));
    } else if (e.isFile()) {
      const st = statSync(cheio);
      if (st.size > LIMITE_ARQUIVO) {
        console.error(`  (fora: ${rel} tem ${(st.size / 1048576).toFixed(1)} MB, grande demais pra mudanca)`);
        continue;
      }
      saida.push({ rel, cheio, tamanho: st.size });
    }
  }
  return saida;
}

function cifrar(buf, senha) {
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const chave = scryptSync(senha, sal, 32);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  const corpo = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from(MAGICO), sal, iv, c.getAuthTag(), corpo]);
}

function decifrar(buf, senha) {
  const cabeca = buf.subarray(0, MAGICO.length).toString();
  if (cabeca !== MAGICO) {
    throw new Error("este arquivo nao e uma mudanca do DG Claw (ou chegou corrompido)");
  }
  let p = MAGICO.length;
  const sal = buf.subarray(p, (p += 16));
  const iv = buf.subarray(p, (p += 12));
  const selo = buf.subarray(p, (p += 16));
  const corpo = buf.subarray(p);
  const chave = scryptSync(senha, sal, 32);
  const d = createDecipheriv("aes-256-gcm", chave, iv);
  d.setAuthTag(selo);
  try {
    return Buffer.concat([d.update(corpo), d.final()]);
  } catch {
    throw new Error("a senha nao abre este arquivo (confira se copiou a linha inteira, com os tracos)");
  }
}

function pacote(caminho, senha) {
  const bruto = decifrar(readFileSync(caminho), senha);
  return JSON.parse(gunzipSync(bruto).toString("utf8"));
}

// ─── empacotar ───────────────────────────────────────────────────────────────
function cmdEmpacotar(args) {
  const [pastaAgente, pastaMemoria, saida] = args;
  if (!pastaAgente || !saida) {
    morrer("uso: empacotar <pasta-do-agente> <pasta-da-memoria-nativa|-> <saida.cofre> [--senha X]");
  }
  if (!existsSync(pastaAgente)) morrer(`a pasta do agente nao existe: ${pastaAgente}`);
  const i = args.indexOf("--senha");
  const senha = i >= 0 ? args[i + 1] : senhaNova();

  const partes = [{ rotulo: "agente", raiz: pastaAgente }];
  if (pastaMemoria && pastaMemoria !== "-") {
    if (existsSync(pastaMemoria)) {
      partes.push({ rotulo: "memoria-nativa", raiz: pastaMemoria });
    } else {
      console.error(`  (aviso: nao achei a memoria nativa em ${pastaMemoria}; sigo so com a pasta do agente)`);
    }
  }

  const arquivos = {};
  const inventario = [];
  let total = 0;
  for (const parte of partes) {
    for (const a of listarArquivos(parte.raiz)) {
      const chave = `${parte.rotulo}/${a.rel}`;
      const dados = readFileSync(a.cheio);
      total += dados.length;
      if (total > LIMITE_TOTAL) {
        morrer(`a mudanca passou de ${(LIMITE_TOTAL / 1048576).toFixed(0)} MB. ` +
               `Tire os arquivos grandes da pasta do agente (video, imagem, base de dados) e tente de novo.`);
      }
      arquivos[chave] = dados.toString("base64");
      inventario.push({ arquivo: chave, bytes: dados.length });
    }
  }
  if (inventario.length === 0) morrer(`nao achei nenhum arquivo pra levar em ${pastaAgente}`);

  const manifesto = {
    formato: 1,
    feito_em: new Date().toISOString(),
    origem: {
      sistema: process.platform,
      pasta_do_agente: pastaAgente,
      memoria_nativa: pastaMemoria && pastaMemoria !== "-" ? pastaMemoria : null,
    },
    arquivos: inventario.length,
    bytes: total,
    inventario,
  };
  const bruto = gzipSync(Buffer.from(JSON.stringify({ manifesto, arquivos }), "utf8"));
  const cofre = cifrar(bruto, senha);
  mkdirSync(dirname(saida) || ".", { recursive: true });
  writeFileSync(saida, cofre);

  console.log(JSON.stringify({
    ok: true,
    arquivo: saida,
    senha,
    arquivos: inventario.length,
    bytes_originais: total,
    bytes_cofre: cofre.length,
    impressao: createHash("sha256").update(cofre).digest("hex").slice(0, 16),
  }, null, 2));
}

// ─── listar / abrir ──────────────────────────────────────────────────────────
function cmdListar(args) {
  const [caminho, senha] = args;
  if (!caminho || !senha) morrer("uso: listar <arquivo.cofre> <senha>");
  const { manifesto } = pacote(caminho, senha);
  console.log(JSON.stringify(manifesto, null, 2));
}

function cmdAbrir(args) {
  const [caminho, senha, destino] = args;
  if (!caminho || !senha || !destino) morrer("uso: abrir <arquivo.cofre> <senha> <pasta-destino>");
  const { manifesto, arquivos } = pacote(caminho, senha);
  let escritos = 0;
  for (const [rel, b64] of Object.entries(arquivos)) {
    // Caminho de dentro do pacote nunca pode escapar da pasta de destino.
    const limpo = rel.split("/").filter((p) => p && p !== "." && p !== "..").join(sep);
    const alvo = join(destino, limpo);
    if (relative(destino, alvo).startsWith("..")) {
      console.error(`  (fora: ${rel} tentou sair da pasta de destino)`);
      continue;
    }
    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, Buffer.from(b64, "base64"));
    escritos++;
  }
  console.log(JSON.stringify({ ok: true, destino, escritos, manifesto }, null, 2));
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function tg(token, metodo, corpo) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, corpo);
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    throw new Error(`o Telegram recusou o ${metodo}: ${j.description || r.status}. ` +
      `Confira se o token do bot esta certo e se nao ha outra sessao usando o mesmo bot.`);
  }
  return j.result;
}

async function cmdEnviar(args) {
  const [caminho, token, chatId] = args;
  if (!caminho || !token || !chatId) morrer("uso: enviar <arquivo> <token-do-bot> <chat-id>");
  const dados = readFileSync(caminho);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", "Mudanca do seu agente. Guarde este arquivo ate o fim da instalacao na VPS.");
  form.append("document", new Blob([dados]), caminho.split(/[\\/]/).pop());
  const r = await tg(token, "sendDocument", { method: "POST", body: form });
  console.log(JSON.stringify({ ok: true, file_id: r.document?.file_id, message_id: r.message_id }, null, 2));
}

async function cmdBaixar(args) {
  const [fileId, token, destino] = args;
  if (!fileId || !token || !destino) morrer("uso: baixar <file-id> <token-do-bot> <destino>");
  const info = await tg(token, "getFile", { method: "POST", headers: { "content-type": "application/json" },
                                            body: JSON.stringify({ file_id: fileId }) });
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if (!r.ok) morrer(`nao consegui baixar o arquivo do Telegram (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(destino) || ".", { recursive: true });
  writeFileSync(destino, buf);
  console.log(JSON.stringify({ ok: true, destino, bytes: buf.length }, null, 2));
}

async function cmdAchar(args) {
  const [token] = args;
  if (!token) morrer("uso: achar <token-do-bot>");
  const ups = await tg(token, "getUpdates", { method: "POST", headers: { "content-type": "application/json" },
                                              body: JSON.stringify({ limit: 50, timeout: 0 }) });
  const docs = [];
  for (const u of ups) {
    const m = u.message || u.channel_post;
    if (m?.document) {
      docs.push({ file_id: m.document.file_id, nome: m.document.file_name,
                  bytes: m.document.file_size, de: m.from?.id, quando: m.date });
    }
  }
  console.log(JSON.stringify({ ok: true, encontrados: docs.length, documentos: docs.slice(-5) }, null, 2));
}

// ─── despacho ────────────────────────────────────────────────────────────────
const [cmd, ...resto] = process.argv.slice(2);
try {
  switch (cmd) {
    case "empacotar": cmdEmpacotar(resto); break;
    case "listar": cmdListar(resto); break;
    case "abrir": cmdAbrir(resto); break;
    case "enviar": await cmdEnviar(resto); break;
    case "baixar": await cmdBaixar(resto); break;
    case "achar": await cmdAchar(resto); break;
    default:
      console.error("mudanca.mjs: comandos: empacotar, listar, abrir, enviar, baixar, achar");
      process.exit(1);
  }
} catch (e) {
  morrer(e.message);
}
