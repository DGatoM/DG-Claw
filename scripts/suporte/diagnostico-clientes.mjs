#!/usr/bin/env node
// Ferramenta de quem dá suporte: consulta o diagnóstico remoto (GET /api/v1/diagnostico) de todos os clientes
// de uma vez e imprime um relatório curto. Só lê. Sem dependências: Node 18 ou mais novo.
//
// Código de saída: 0 tudo ok, 1 algum cliente com atenção ou quebrado, 2 erro de consulta ou de configuração.
// O token nunca é impresso, nem em erro.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMPO_MS = 25000;
const ARQUIVO_PADRAO = path.join(os.homedir(), '.config', 'dgclaw-suporte', 'clientes.json');
const AJUDA = `Uso: diagnostico-clientes.mjs [opções]

Consulta o diagnóstico remoto de cada cliente e mostra o que está parado e o que fazer.

  --arquivo <caminho>   lista de clientes (padrão: ${ARQUIVO_PADRAO})
  --cliente <nome>      consulta só o cliente com esse nome (sem diferenciar maiúsculas)
  --detalhe             mostra também a evidência e o prompt_sugerido de cada item
  --json                imprime o JSON bruto combinado, sem relatório
  --ajuda               esta mensagem

Formato do arquivo (permissão 600):
  {"clientes":[{"nome":"Lucro FC","url":"https://dominio","token":"dgc_..."},
               {"nome":"Outro","url":"https://outro.com","token_arquivo":"/caminho/do/token"}]}

Saída: 0 tudo ok, 1 algum cliente com atenção ou quebrado, 2 erro de consulta.`;

function falha(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function lerArgumentos(argv) {
  const op = { arquivo: ARQUIVO_PADRAO, cliente: null, detalhe: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const valor = () => {
      if (i + 1 >= argv.length) falha(`A opção ${a} precisa de um valor. Exemplo: ${a} <valor>. Veja --ajuda.`);
      i += 1;
      return argv[i];
    };
    if (a === '--arquivo') op.arquivo = valor();
    else if (a === '--cliente') op.cliente = valor();
    else if (a === '--detalhe') op.detalhe = true;
    else if (a === '--json') op.json = true;
    else if (a === '--ajuda' || a === '-h' || a === '--help') { process.stdout.write(`${AJUDA}\n`); process.exit(0); }
    else falha(`Não conheço a opção "${a}". Veja --ajuda.`);
  }
  return op;
}

/** Recusa arquivo de segredo legível por grupo ou outros. */
function conferirPermissao(caminho, oQue) {
  let st;
  try { st = fs.statSync(caminho); } catch (e) {
    falha(`Não consegui abrir ${oQue} (${caminho}): ${e.code || e.message}. Confira o caminho${oQue === 'a lista de clientes' ? ' ou passe --arquivo <caminho>' : ''}.`);
  }
  if (st.mode & 0o077) {
    falha(`${oQue[0].toUpperCase()}${oQue.slice(1)} (${caminho}) está legível por outras pessoas (permissão ${(st.mode & 0o777).toString(8)}). Ele guarda tokens. Corrija com: chmod 600 ${caminho}`);
  }
}

function carregarClientes(caminho) {
  conferirPermissao(caminho, 'a lista de clientes');
  let json;
  try { json = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (e) {
    falha(`A lista de clientes (${caminho}) não é um JSON válido: ${e.message}. Veja o formato em clientes.exemplo.json.`);
  }
  if (!json || !Array.isArray(json.clientes) || !json.clientes.length) {
    falha(`A lista de clientes (${caminho}) precisa ter {"clientes":[...]} com pelo menos um cliente. Veja clientes.exemplo.json.`);
  }
  return json.clientes.map((c, i) => {
    const nome = typeof c.nome === 'string' && c.nome.trim() ? c.nome.trim() : null;
    if (!nome) falha(`O cliente número ${i + 1} da lista não tem "nome".`);
    let url;
    try { url = new URL(c.url); } catch (_) { falha(`O cliente "${nome}" tem uma "url" inválida. Use algo como https://dominio-do-cliente.`); }
    let token = typeof c.token === 'string' ? c.token.trim() : '';
    if (!token && typeof c.token_arquivo === 'string') {
      conferirPermissao(c.token_arquivo, `o arquivo de token de "${nome}"`);
      try { token = fs.readFileSync(c.token_arquivo, 'utf8').trim(); } catch (e) { falha(`Não consegui ler o arquivo de token de "${nome}": ${e.code || e.message}.`); }
    }
    if (!token) falha(`O cliente "${nome}" não tem "token" nem "token_arquivo".`);
    return { nome, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, token };
  });
}

/** O servidor do cliente escreve esses textos: tira cor e caracteres de controle antes de ir para o terminal. */
const limpa = (t) => String(t == null ? '' : t).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, ' ');

async function consultar(c) {
  const url = `${c.base}/api/v1/diagnostico`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TEMPO_MS) });
    const texto = await res.text();
    let corpo = null;
    try { corpo = JSON.parse(texto); } catch (_) { /* resposta que não é JSON é tratada abaixo */ }
    if (res.ok && corpo && corpo.schema) return { cliente: c.nome, url: c.base, status: res.status, resposta: corpo };
    return { cliente: c.nome, url: c.base, status: res.status, erro: explicarStatus(res.status, corpo) };
  } catch (e) {
    const causa = (e.cause && e.cause.code) || e.code || e.name;
    let oQueFazer = 'Confira se o endereço está certo e se a máquina do cliente está no ar.';
    if (e.name === 'TimeoutError' || causa === 'UND_ERR_CONNECT_TIMEOUT') oQueFazer = `A máquina não respondeu em ${TEMPO_MS / 1000} s. Ela pode estar desligada ou sem rede.`;
    else if (causa === 'ENOTFOUND') oQueFazer = 'O nome do site não existe no DNS. Confira a "url" ou se o domínio do cliente mudou.';
    else if (causa === 'ECONNREFUSED') oQueFazer = 'A máquina recusou a conexão. O Caddy ou a máquina inteira podem estar parados.';
    else if (/CERT|TLS|SSL/i.test(String(causa))) oQueFazer = 'O certificado do site não foi aceito. Confira o domínio do cliente.';
    return { cliente: c.nome, url: c.base, status: null, erro: `Não consegui falar com o cliente (${limpa(causa)}). ${oQueFazer}` };
  }
}

function explicarStatus(status, corpo) {
  const motivo = corpo && typeof corpo.erro === 'string' ? ` Motivo informado: ${limpa(corpo.erro)}` : '';
  if (status === 401) return `A chave foi recusada (401): ela foi revogada, está errada ou foi digitada com erro. Se o cliente revogou a chave, peça uma nova pela tela Suporte remoto.${motivo}`;
  if (status === 403) return `A chave não tem permissão para o diagnóstico (403). Crie outra com o escopo diagnostico.${motivo}`;
  if (status === 429) return `Tentativas demais com chave inválida a partir deste IP (429). Espere cerca de 10 minutos e confira a chave antes de tentar de novo.${motivo}`;
  if (status === 404) return 'O cliente não tem a rota de diagnóstico (404). A versão do DG Claw dele é anterior ao diagnóstico remoto: peça para atualizar.';
  if (status >= 500) return `O painel do cliente deu erro interno (${status}).${motivo} Tente de novo em um minuto; se repetir, o problema é do painel dele.`;
  return `Resposta inesperada do cliente (HTTP ${status}).${motivo}`;
}

const cor = process.stdout.isTTY && !process.env.NO_COLOR;
const pinta = (codigo, t) => (cor ? `\x1b[${codigo}m${t}\x1b[0m` : t);
const ICONE = { ok: pinta(32, '✔'), atencao: pinta(33, '▲'), quebrado: pinta(31, '✖'), nao_medido: pinta(90, '?'), erro: pinta(31, '✖') };

function imprimirCliente(r, detalhe) {
  if (r.erro) {
    console.log(`${ICONE.erro} ${r.cliente}  não consegui consultar`);
    console.log(`    ${r.erro}`);
    return;
  }
  const d = r.resposta;
  const v = d.versao || {};
  const versao = v.instalada ? `versão ${limpa(v.instalada)}${v.commit ? ` (${limpa(v.commit)})` : ''}` : 'versão desconhecida';
  const atualizacao = v.atualizacao_disponivel === true ? ' | atualização disponível' : '';
  console.log(`${ICONE[d.resumo.estado] || '?'} ${r.cliente}  ${limpa(d.resumo.frase)} | ${versao}${atualizacao}`);
  const itens = (d.verificacoes || []).filter((i) => i.estado !== 'ok');
  for (const i of itens) {
    console.log(`    ${ICONE[i.estado] || '?'} ${limpa(i.nome)} [${limpa(i.id)}]`);
    console.log(`        ${limpa(i.motivo)}`);
    if (i.estado === 'nao_medido' && !detalhe) continue;
    if (i.o_que_fazer) console.log(`        O que fazer: ${limpa(i.o_que_fazer)}`);
    if (detalhe) {
      const e = i.evidencia;
      if (e) {
        const partes = [e.horario ? `horário ${limpa(e.horario)}` : null, e.codigo_saida != null ? `código de saída ${limpa(e.codigo_saida)}` : null].filter(Boolean);
        if (partes.length) console.log(`        Evidência: ${partes.join(', ')}`);
        if (e.trecho) for (const l of String(e.trecho).split('\n')) console.log(`          | ${limpa(l)}`);
      }
      if (i.prompt_sugerido) console.log(`        Prompt para o cliente colar no Admin:\n          ${limpa(i.prompt_sugerido)}`);
    }
  }
}

async function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  let clientes = carregarClientes(op.arquivo);
  if (op.cliente) {
    const alvo = op.cliente.toLowerCase();
    clientes = clientes.filter((c) => c.nome.toLowerCase() === alvo);
    if (!clientes.length) falha(`Não há cliente chamado "${op.cliente}" na lista ${op.arquivo}.`);
  }
  const resultados = await Promise.all(clientes.map(consultar));
  if (op.json) {
    process.stdout.write(`${JSON.stringify(resultados, null, 2)}\n`);
  } else {
    for (const r of resultados) imprimirCliente(r, op.detalhe);
  }
  if (resultados.some((r) => r.erro)) process.exit(2);
  if (resultados.some((r) => r.resposta.resumo.estado !== 'ok')) process.exit(1);
  process.exit(0);
}

principal().catch((e) => falha(`Erro inesperado no script: ${e && e.stack ? e.stack : e}`));
