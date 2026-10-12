#!/usr/bin/env node
// qa-conversa.mjs — O aceite de navegador da aba Conversa (Fase B).
//
// Roda contra um painel JÁ NO AR, apontado por --url, e prova a tela de verdade:
// a aba abre por padrão, a conversa aparece, o sinal de vida diz alguma coisa, e a
// caixa de escrever alcança o polegar no celular.
//
// Uso:
//   node qa-conversa.mjs --url http://127.0.0.1:8399 --senha <senha> [--escrever]
//
// --escrever manda uma mensagem DE VERDADE para o agente vivo e espera a resposta.
// Fica fora do padrão de propósito: um aceite que fala com o agente a cada execução
// gasta um turno da assinatura e coloca ruído na conversa da pessoa.
//
// Armadilhas que este arquivo já paga (não desfazer):
//   - `isVisible()` do Playwright responde NA HORA, sem esperar. Para provar que algo
//     APARECEU, sempre `waitFor`.
//   - Chromium sempre com `--no-proxy-server`: esta VPS tem proxy no ambiente e o
//     navegador tentaria sair por ele até para falar com o 127.0.0.1.
//   - No celular quem limita é a ALTURA (svh), não a largura: por isso a medida do
//     aceite é "a caixa de escrever está dentro da janela", não "cabe na largura".
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const arg = (nome, padrao = null) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : padrao;
};
const tem = (nome) => process.argv.includes(`--${nome}`);

const URL_BASE = (arg("url") || "http://127.0.0.1:8399").replace(/\/+$/, "");
const SENHA = arg("senha") || process.env.DGCLAW_PANEL_PASSWORD || "";
const SAIDA = arg("saida") || path.join(process.cwd(), "qa", "conversa");
const ESCREVER = tem("escrever");

const itens = [];
const ok = (nome, detalhe = "") => { itens.push({ nome, ok: true, detalhe }); console.log(`  ✅ ${nome}${detalhe ? " — " + detalhe : ""}`); };
const falhou = (nome, detalhe) => { itens.push({ nome, ok: false, detalhe }); console.log(`  ❌ ${nome} — ${detalhe}`); };

async function entrar(pagina) {
  await pagina.goto(`${URL_BASE}/login.html`, { waitUntil: "domcontentloaded" });
  await pagina.fill('input[type="password"]', SENHA);
  await Promise.all([
    pagina.waitForURL((u) => !String(u).includes("login"), { timeout: 20000 }),
    pagina.click('button[type="submit"], input[type="submit"]'),
  ]);
}

async function medir(navegador, largura, altura, rotulo) {
  console.log(`\n── ${rotulo} (${largura}x${altura}) ──`);
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(String(e)));
  pagina.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });

  await entrar(pagina);

  // 1. A aba Conversa abre por padrão, sem ninguém clicar.
  //    O seletor é escopado em `main`: o Next e afins põem no corpo da página um
  //    anunciador invisível, e um seletor solto pega ele e lê texto vazio.
  const painel = pagina.locator("main #panel-conversa.active");
  try {
    await painel.waitFor({ state: "visible", timeout: 15000 });
    ok(`${rotulo}: a aba Conversa abre por padrão`);
  } catch {
    falhou(`${rotulo}: a aba Conversa abre por padrão`, "o painel-conversa não estava ativo");
  }

  // 2. A conversa carregou (bolhas ou o texto de conversa vazia, nunca "carregando").
  try {
    await pagina.waitForFunction(
      () => {
        const l = document.querySelector("#conversa-lista");
        if (!l) return false;
        if (l.querySelector(".bolha")) return true;
        const v = l.querySelector(".conversa-vazia");
        return !!v && !/carregando/i.test(v.textContent || "");
      },
      { timeout: 25000 },
    );
    const quantas = await pagina.locator("#conversa-lista .bolha").count();
    ok(`${rotulo}: a conversa carregou`, `${quantas} mensagem(ns)`);
  } catch {
    falhou(`${rotulo}: a conversa carregou`, "ficou em 'carregando' depois de 25s");
  }

  // 3. O sinal de vida diz alguma coisa, e não é o texto de boot.
  const frase = (await pagina.locator("#sinal-frase").textContent().catch(() => "")) || "";
  if (frase.trim() && !/carregando/i.test(frase)) ok(`${rotulo}: o sinal de vida fala`, frase.trim());
  else falhou(`${rotulo}: o sinal de vida fala`, `frase = ${JSON.stringify(frase)}`);

  // 4. Dá para escrever.
  const campo = pagina.locator("#conversa-texto");
  const desligado = await campo.isDisabled().catch(() => true);
  if (!desligado) ok(`${rotulo}: a caixa de escrever está liberada`);
  else falhou(`${rotulo}: a caixa de escrever está liberada`, "veio desabilitada (o agente está fora do ar?)");

  // 5. A caixa de escrever está DENTRO da janela. É a medida que importa no celular:
  //    com 100vh em vez de svh ela fica abaixo da borda, onde o polegar não alcança.
  const caixa = await campo.boundingBox();
  if (caixa && caixa.y + caixa.height <= altura + 1) {
    ok(`${rotulo}: a caixa de escrever alcança o polegar`, `fundo em ${Math.round(caixa.y + caixa.height)}px de ${altura}px`);
  } else {
    falhou(`${rotulo}: a caixa de escrever alcança o polegar`,
      caixa ? `fundo em ${Math.round(caixa.y + caixa.height)}px, fora dos ${altura}px` : "não achei a caixa");
  }

  // 6. Nada de rolagem horizontal.
  const largo = await pagina.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (!largo) ok(`${rotulo}: sem rolagem horizontal`);
  else falhou(`${rotulo}: sem rolagem horizontal`, "a página passa da largura da janela");

  // O retrato vem ANTES do teste da gaveta: a gaveta desliza em .26s e a foto pegava
  // ela no meio do caminho, o que faz um layout correto parecer quebrado.
  fs.mkdirSync(SAIDA, { recursive: true });
  await pagina.screenshot({ path: path.join(SAIDA, `conversa-${largura}.png`), fullPage: false });

  // 7. No celular, a gaveta do menu abre e fecha.
  if (largura <= 860) {
    try {
      await pagina.click("#btn-menu");
      await pagina.waitForFunction(() => document.body.classList.contains("menu-aberto"), { timeout: 5000 });
      // O véu ocupa a tela inteira, mas o CENTRO dele fica DEBAIXO da gaveta (284px de
      // largura, z-index maior). Um click sem posição mira o centro e o Playwright
      // espera para sempre por um elemento que nunca vai receber o toque. O dedo da
      // pessoa também toca no que sobrou à direita, então é ali que o teste toca.
      await pagina.click("#veu", { position: { x: largura - 30, y: 200 } });
      await pagina.waitForFunction(() => !document.body.classList.contains("menu-aberto"), { timeout: 5000 });
      ok(`${rotulo}: a gaveta do menu abre e fecha`);
    } catch (e) {
      falhou(`${rotulo}: a gaveta do menu abre e fecha`, String(e).slice(0, 120));
    }
  }

  if (erros.length) falhou(`${rotulo}: sem erro de JavaScript`, erros.slice(0, 2).join(" | ").slice(0, 220));
  else ok(`${rotulo}: sem erro de JavaScript`);

  return { pagina, ctx };
}

const navegador = await chromium.launch({
  headless: true,
  executablePath: "/usr/local/bin/chromium",
  args: ["--no-sandbox", "--no-proxy-server", "--disable-dev-shm-usage"],
});

try {
  const grande = await medir(navegador, 1440, 900, "1440");

  if (ESCREVER) {
    console.log("\n── escrevendo de verdade ──");
    const { pagina } = grande;
    const marca = `qa-conversa ${Date.now().toString(36)}`;
    const antes = await pagina.locator("#conversa-lista .bolha").count();
    await pagina.fill("#conversa-texto", `Teste automático do painel (${marca}). Responde só: ok.`);
    await pagina.click("#btn-enviar");
    try {
      // A bolha da pessoa só nasce quando o servidor confirma a entrega: esperar por
      // ela É o aceite de "a mensagem entrou na sessão".
      await pagina.waitForFunction(
        (n) => document.querySelectorAll("#conversa-lista .bolha").length > n,
        antes, { timeout: 45000 },
      );
      ok("a mensagem entrou na conversa");
      await pagina.waitForFunction(
        (n) => {
          const b = document.querySelectorAll("#conversa-lista .bolha");
          return b.length > n + 1 && b[b.length - 1].classList.contains("de-agente");
        },
        antes, { timeout: 120000 },
      );
      ok("o agente respondeu");
    } catch (e) {
      falhou("a conversa fecha o ciclo", String(e).slice(0, 160));
    }
    await pagina.screenshot({ path: path.join(SAIDA, "conversa-ciclo.png") });
  }
  await grande.ctx.close();

  const pequeno = await medir(navegador, 390, 844, "390");
  await pequeno.ctx.close();
} finally {
  await navegador.close();
}

const reprovados = itens.filter((i) => !i.ok);
console.log(`\n${itens.length - reprovados.length}/${itens.length} verdes. Imagens em ${SAIDA}`);
if (reprovados.length) {
  console.log("REPROVADO:");
  for (const r of reprovados) console.log(`  - ${r.nome}: ${r.detalhe}`);
  process.exit(1);
}
console.log("APROVADO");
