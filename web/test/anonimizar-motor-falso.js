'use strict';
// Motor FALSO da anonimização, só para os testes do Web. Fala o protocolo de anonimizar/CONTRATO.md:
// uma requisição JSON por linha no stdin, uma resposta por linha no stdout.
// Nível pelo ambiente (DGCLAW_ANON_NIVEL: regex | leitores | completo). Gatilhos no conteúdo:
//   "EXPLODE" derruba o processo no meio do pedido; "TRAVA" nunca responde; "RECUSA" responde ok:false;
//   "ENVENENA" devolve um arquivo fora da pasta de saída.
// Detecta CPF (123.456.789-00) em qualquer nível e, no completo, "Maria Souza" e "Joao Silva" como PESSOA.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const NIVEL = process.env.DGCLAW_ANON_NIVEL || 'completo';
const FORMATOS = {
  regex: ['.txt', '.md', '.csv', '.json'],
  leitores: ['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.xlsx'],
  completo: ['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.xlsx'],
}[NIVEL];
const NOMES = ['Maria Souza', 'Joao Silva'];

function proximoMarcador(tabela, tipo) {
  let max = 0;
  for (const e of tabela) {
    const m = new RegExp(`^\\[${tipo}_(\\d+)\\]$`).exec(e.marcador);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `[${tipo}_${max + 1}]`;
}

function trocar(texto, tabela, novas, contagem) {
  const candidatos = [];
  for (const m of texto.matchAll(/\d{3}\.\d{3}\.\d{3}-\d{2}/g)) candidatos.push({ tipo: 'CPF', valor: m[0] });
  for (const m of texto.matchAll(/\d{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}/g)) candidatos.push({ tipo: 'CNPJ', valor: m[0] });
  if (NIVEL === 'completo') for (const n of NOMES) if (texto.includes(n)) candidatos.push({ tipo: 'PESSOA', valor: n });
  for (const c of candidatos) {
    let e = tabela.find((x) => x.valor === c.valor) || novas.find((x) => x.valor === c.valor);
    if (!e) {
      e = { tipo: c.tipo, valor: c.valor, marcador: proximoMarcador(tabela.concat(novas), c.tipo) };
      novas.push(e);
    }
    texto = texto.split(c.valor).join(e.marcador);
    contagem[c.tipo] = (contagem[c.tipo] || 0) + 1;
  }
  // tabela conhecida, inclusive valores que o detector não acharia sozinho
  for (const e of tabela) if (texto.includes(e.valor)) texto = texto.split(e.valor).join(e.marcador);
  return texto;
}

function responde(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (linha) => {
  const r = JSON.parse(linha);
  if (r.op === 'estado') {
    return responde({ ok: true, nivel: NIVEL, formatos: FORMATOS, modelo_carregado: false, rss_mb: process.pid, versao_modelo: NIVEL === 'completo' ? 'teste' : null });
  }
  if (r.op === 'anonimizar') {
    const ext = path.extname(r.entrada).toLowerCase();
    const texto = fs.readFileSync(r.entrada, 'utf8');
    if (texto.includes('EXPLODE')) process.exit(1);
    if (texto.includes('TRAVA')) return undefined;
    if (texto.includes('TROCA') && process.env.DGCLAW_ANON_TESTE_UPLOADS) {
      // simula o agente trocando uploads/ por um atalho enquanto o motor trabalha
      fs.renameSync(process.env.DGCLAW_ANON_TESTE_UPLOADS, process.env.DGCLAW_ANON_TESTE_UPLOADS + '.velho');
      fs.symlinkSync(process.env.DGCLAW_ANON_TESTE_FORA, process.env.DGCLAW_ANON_TESTE_UPLOADS);
    }
    if (texto.includes('RECUSA')) return responde({ ok: false, erro: 'Este arquivo está protegido por senha. Tire a senha e envie de novo.', codigo: 'senha' });
    const novas = []; const contagem = {};
    const anon = trocar(texto, r.tabela, novas, contagem);
    const saidas = [];
    const grava = (sufixo, conteudo) => {
      const cam = path.join(r.saida_dir, `${r.nome_base}.anon.${sufixo}`);
      fs.writeFileSync(cam, conteudo);
      saidas.push({ caminho: cam, formato: sufixo });
    };
    if (ext === '.docx') { grava('docx', anon); grava('md', anon); }
    else if (ext === '.xlsx') { grava('xlsx', anon); grava('csv', anon); }
    else if (ext === '.csv' || ext === '.json') grava(ext.slice(1), anon);
    else grava('md', anon);
    if (texto.includes('ENVENENA')) saidas.push({ caminho: '/etc/hostname', formato: 'txt' });
    const usados = new Set();
    for (const sd of saidas) { if (sd.caminho.startsWith(r.saida_dir)) for (const m of fs.readFileSync(sd.caminho, 'latin1').matchAll(/\[[A-Z]+_\d+\]/g)) usados.add(m[0]); }
    if (texto.includes('SEM_USADOS')) return responde({ ok: true, saidas, novas, contagem, avisos: [], nivel: NIVEL });
    return responde({ ok: true, saidas, novas, usados: Array.from(usados), contagem, avisos: [], nivel: NIVEL });
  }
  if (r.op === 'anonimizar_texto') {
    const novas = []; const contagem = {};
    const texto = trocar(r.texto, r.tabela, novas, contagem);
    return responde({ ok: true, texto, novas, contagem });
  }
  if (r.op === 'reverter') {
    if (/\.(html?|svg|xml)$/i.test(r.entrada)) return responde({ ok: false, erro: 'formato ativo', codigo: 'formato_ativo' });
    let texto = fs.readFileSync(r.entrada, 'utf8');
    let trocas = 0;
    for (const e of r.tabela) { const partes = texto.split(e.marcador); trocas += partes.length - 1; texto = partes.join(e.valor); }
    fs.writeFileSync(r.saida, texto);
    return responde({ ok: true, trocas, desconhecidos: [] });
  }
  return responde({ ok: false, erro: `op desconhecida: ${r.op}`, codigo: 'op' });
});
