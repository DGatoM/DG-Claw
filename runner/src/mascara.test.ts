import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MascaraDeFluxo, OCULTO, mascarar, segredosConhecidos } from "./mascara.js";

// Valores montados na hora: nenhum segredo de verdade fica no arquivo.
const SEGREDO = "Xk9mQ2vL7pRt"; // 12 caracteres
const CHAVE_ANTHROPIC = "sk-" + "ant-api03-" + "A1b2C3d4E5".repeat(10);
const URL_COM_SENHA = ["postgres", "://", "usuario", ":", "senha123", "@host:5432/x"].join("");

/** Todas as formas de partir `texto` em 1, 2 ou 3 pedaços. */
function particoes(texto: string): string[][] {
  const todas: string[][] = [[texto]];
  for (let i = 1; i < texto.length; i++) {
    todas.push([texto.slice(0, i), texto.slice(i)]);
    for (let j = i + 1; j < texto.length; j++) {
      todas.push([texto.slice(0, i), texto.slice(i, j), texto.slice(j)]);
    }
  }
  return todas;
}

function rodar(pedacos: string[], conhecidos: string[]): string {
  const m = new MascaraDeFluxo(conhecidos);
  let saida = "";
  for (const p of pedacos) saida += m.passar(p);
  return saida + m.descarregar();
}

describe("segredosConhecidos", () => {
  it("ignora vazio, curto, ausente e repetido, e ordena do mais longo ao mais curto", () => {
    const env = {
      A: "12345678",
      B: "  abcdefghijkl  ",
      C: "curto",
      D: "",
      E: "   ",
      F: "12345678",
      G: undefined,
      H: "abcdefghijklmnopq",
    };
    const r = segredosConhecidos(["A", "B", "C", "D", "E", "F", "G", "H", "NAOEXISTE"], env);
    assert.deepEqual(r, ["abcdefghijklmnopq", "abcdefghijkl", "12345678"]);
  });

  it("lê process.env por padrão", () => {
    process.env.TESTE_MASCARA_X = "valor-de-teste-1";
    try {
      assert.deepEqual(segredosConhecidos(["TESTE_MASCARA_X"]), ["valor-de-teste-1"]);
    } finally {
      delete process.env.TESTE_MASCARA_X;
    }
  });
});

describe("mascarar", () => {
  it("troca o segredo conhecido no meio do texto", () => {
    assert.equal(mascarar(`antes ${SEGREDO} depois`, [SEGREDO]), `antes ${OCULTO} depois`);
  });

  it("casa o segredo quebrado por quebra de linha e indentação", () => {
    const quebrado = `${SEGREDO.slice(0, 5)}\n  ${SEGREDO.slice(5)}`;
    assert.equal(mascarar(`valor: ${quebrado}!`, [SEGREDO]), `valor: ${OCULTO}!`);
  });

  it("troca chave com cara de Anthropic mesmo sem conhecer", () => {
    assert.equal(mascarar(`ANTHROPIC=${CHAVE_ANTHROPIC} fim`), `ANTHROPIC=${OCULTO} fim`);
  });

  it("troca URL com senha embutida e token Bearer", () => {
    assert.equal(mascarar(`db ${URL_COM_SENHA} ok`), `db ${OCULTO} ok`);
    assert.equal(mascarar(`Authorization: Bearer ${"a".repeat(45)}`), `Authorization: ${OCULTO}`);
  });

  it("deixa texto sem segredo intacto, e o vazio também", () => {
    const texto = "nada aqui\x1b[31m vermelho\x1b[0m sk e ghp soltos\n";
    assert.equal(mascarar(texto, [SEGREDO]), texto);
    assert.equal(mascarar("", [SEGREDO]), "");
  });

  it("segredo com caracteres especiais de regex", () => {
    const especial = "a+b.c$d(e)[f]*?";
    assert.equal(mascarar(`x ${especial} y`, [especial]), `x ${OCULTO} y`);
    assert.equal(mascarar("x aXb.c$d(e)[f]*? y", [especial]), "x aXb.c$d(e)[f]*? y");
  });

  it("ignora segredo com menos de 8 caracteres e troca o mais longo antes do mais curto", () => {
    assert.equal(mascarar("abc1234 aqui", ["abc1234"]), "abc1234 aqui");
    const longo = "abcdefgh-longo";
    assert.equal(mascarar(`${longo} e abcdefgh`, ["abcdefgh", longo]), `${OCULTO} e ${OCULTO}`);
  });
});

describe("MascaraDeFluxo", () => {
  it("segredo partido em 2, 3 e em pedaços de 1 caractere", () => {
    const texto = `chave=${SEGREDO}\n`;
    const esperado = `chave=${OCULTO}\n`;
    assert.equal(rodar([texto.slice(0, 10), texto.slice(10)], [SEGREDO]), esperado);
    assert.equal(rodar([texto.slice(0, 8), texto.slice(8, 14), texto.slice(14)], [SEGREDO]), esperado);
    assert.equal(rodar(texto.split(""), [SEGREDO]), esperado);
  });

  it("todas as partições (2 e 3 pedaços) de um texto com segredo de 12 caracteres", () => {
    const texto = `ok ${SEGREDO} fim`;
    const esperado = mascarar(texto, [SEGREDO]);
    let total = 0;
    for (const pedacos of particoes(texto)) {
      const saida = rodar(pedacos, [SEGREDO]);
      assert.ok(!saida.includes(SEGREDO), `vazou em ${JSON.stringify(pedacos)}`);
      assert.equal(saida, esperado, `diferente em ${JSON.stringify(pedacos)}`);
      total++;
    }
    assert.ok(total > 100);
  });

  it("segredo no começo e no fim do texto, e segredo repetido", () => {
    for (const texto of [SEGREDO, `${SEGREDO} ${SEGREDO}`, `${SEGREDO}x`]) {
      for (const pedacos of particoes(texto)) {
        const saida = rodar(pedacos, [SEGREDO]);
        assert.equal(saida, mascarar(texto, [SEGREDO]), JSON.stringify(pedacos));
      }
    }
  });

  it("segredo cujo começo se repete dentro dele (sobreposição)", () => {
    const s = "abcabcabcabc";
    const texto = `x${s}y`;
    for (const pedacos of particoes(texto)) {
      assert.equal(rodar(pedacos, [s]), mascarar(texto, [s]), JSON.stringify(pedacos));
    }
  });

  it("segredo quebrado por quebra de linha e dividido em pedaços", () => {
    const texto = `v: ${SEGREDO.slice(0, 6)}\r\n  ${SEGREDO.slice(6)} ok`;
    for (const pedacos of particoes(texto)) {
      const saida = rodar(pedacos, [SEGREDO]);
      assert.equal(saida, mascarar(texto, [SEGREDO]), JSON.stringify(pedacos));
    }
  });

  it("chave por padrão partida em pedaços (Anthropic, Bearer e URL com senha)", () => {
    for (const texto of [`k ${CHAVE_ANTHROPIC} fim`, `h Bearer ${"b".repeat(48)} fim`, `u ${URL_COM_SENHA} fim`]) {
      const esperado = mascarar(texto);
      assert.ok(esperado.includes(OCULTO));
      // Da URL, só o começo (o nome do esquema, antes de "://") pode sair antes da hora: não é segredo.
      const inicio = texto.includes("://") ? texto.indexOf("://") + 2 : 1;
      for (let c = inicio; c < texto.length; c++) {
        assert.equal(rodar([texto.slice(0, c), texto.slice(c)], []), esperado, `corte ${c}`);
      }
      if (!texto.includes("://")) assert.equal(rodar(texto.split(""), []), esperado);
    }
  });

  it("texto comum sai na hora, sem retenção", () => {
    const m = new MascaraDeFluxo([SEGREDO]);
    assert.equal(m.passar("olá, tudo bem?\n"), "olá, tudo bem?\n");
    assert.equal(m.passar("compilando... pronto.\n"), "compilando... pronto.\n");
    assert.equal(m.descarregar(), "");
  });

  it("sem segredo nenhum também não retém texto comum", () => {
    const m = new MascaraDeFluxo([]);
    assert.equal(m.passar("linha 1\nlinha 2 "), "linha 1\nlinha 2 ");
  });

  it("retém só o começo suspeito e solta o resto", () => {
    const m = new MascaraDeFluxo([SEGREDO]);
    assert.equal(m.passar(`pronto ${SEGREDO.slice(0, 5)}`), "pronto ");
    assert.equal(m.passar(`${SEGREDO.slice(5)} fim`), `${OCULTO} fim`);
  });

  it("a retenção é limitada: falso começo de segredo não segura a tela para sempre", () => {
    const m = new MascaraDeFluxo([SEGREDO]);
    // "sk-" abre uma retenção possível de chave; sem fim, o teto (12 + 200) corta.
    const longo = "sk-" + "z".repeat(5000);
    const saida = m.passar(longo);
    const retido = longo.length - saida.length;
    assert.ok(retido <= SEGREDO.length + 200, `retido ${retido}`);
    assert.ok(saida.length >= longo.length - (SEGREDO.length + 200));
    assert.equal(saida + m.descarregar(), longo);
  });

  it("descarregar devolve o retido mascarado e zera", () => {
    const m = new MascaraDeFluxo([SEGREDO]);
    assert.equal(m.passar(SEGREDO.slice(0, 7)), "");
    assert.equal(m.descarregar(), SEGREDO.slice(0, 7));
    assert.equal(m.descarregar(), "");
    assert.equal(m.passar("seguinte"), "seguinte");
  });

  it("segredo completo no fim do pedaço nunca sai em claro", () => {
    const m = new MascaraDeFluxo([SEGREDO]);
    const s = m.passar(SEGREDO);
    assert.ok(!s.includes(SEGREDO));
    assert.equal(s + m.descarregar(), OCULTO);
  });
});
