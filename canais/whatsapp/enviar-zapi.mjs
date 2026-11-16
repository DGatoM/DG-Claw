#!/usr/bin/env node
// enviar-zapi.mjs - o agente manda WhatsApp pela Z-API, SEMPRE com as travas contra banimento.
//
//   node enviar-zapi.mjs enviar --para +5511999999999 [--texto "..." | --texto-stdin]
//   node enviar-zapi.mjs status
//
// Saida: uma linha JSON. {"ok":true,"para":"+55...","id":"...","disparo":false,"esperou_ms":0}
//        ou {"ok":false,"codigo":"...","erro":"motivo em portugues, com o que fazer"}.
// Codigo de saida 0 quando enviou, 1 quando recusou ou falhou, 2 quando o comando foi mal usado.
// Chaves no ambiente: ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN (vem do cofre do agente).
// Estado e config ficam em ~/.dgclaw/whatsapp/envio/ e ~/.dgclaw/whatsapp/envio.json, os mesmos da ponte:
// ponte e Z-API contam como UM so remetente (mesmo ritmo, mesmo teto, mesma trava).
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { criarAdaptadorZapi } from './lib/adaptador-zapi.mjs';
import { criarEnvioSeguro } from './lib/envio-seguro.mjs';
import { LIMITE_TEXTO } from './lib/limites.mjs';
import { motivoNumeroInvalido, normalizar } from './lib/numeros.mjs';
import { falha, motivoErro } from './lib/util.mjs';

function lerArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--texto-stdin') a.textoStdin = true;
    else if (v === '--para' || v === '--texto') {
      if (i + 1 >= argv.length) return { erro: `${v} precisa de um valor` };
      a[v.slice(2)] = argv[++i];
    } else if (v.startsWith('--')) return { erro: `opcao desconhecida: ${v.slice(0, 30)}` };
    else a._.push(v);
  }
  return a;
}

async function lerStdin(entrada) {
  const partes = [];
  for await (const p of entrada) partes.push(p);
  return Buffer.concat(partes).toString('utf8');
}

/** Funcao testavel: devolve { codigoSaida, resposta }. */
export async function executar(argv, { env = process.env, home = os.homedir(), stdin = process.stdin, fetchImpl, agora, dormir, aleatorio } = {}) {
  const a = lerArgs(argv);
  if (a.erro) return { codigoSaida: 2, resposta: falha('USO_INVALIDO', `${a.erro}; uso: enviar --para <numero> --texto "..." | status`) };
  const dirBase = path.join(home, '.dgclaw', 'whatsapp');
  const registrar = (m) => process.stderr.write(`whatsapp-zapi: ${String(m).replace(/[\r\n]+/g, ' ')}\n`);
  const envio = criarEnvioSeguro({
    dir: path.join(dirBase, 'envio'), arqConfig: path.join(dirBase, 'envio.json'), agora, dormir, aleatorio, registrar,
  });
  const cmd = a._[0];

  if (cmd === 'status') {
    const p = envio.paradoMotivo();
    return { codigoSaida: 0, resposta: { ok: true, parado: !!p, motivo: p, pendente: envio.pendente() } };
  }
  if (cmd !== 'enviar') return { codigoSaida: 2, resposta: falha('USO_INVALIDO', 'use "enviar --para <numero> --texto ..." ou "status"') };

  const numero = normalizar(a.para);
  if (!numero) return { codigoSaida: 2, resposta: falha('PEDIDO_INVALIDO', motivoNumeroInvalido(a.para)) };
  const texto = a.textoStdin ? await lerStdin(stdin) : a.texto;
  if (typeof texto !== 'string' || !texto.trim()) return { codigoSaida: 2, resposta: falha('PEDIDO_INVALIDO', 'o texto esta vazio; use --texto "..." ou --texto-stdin') };
  if (texto.length > LIMITE_TEXTO) return { codigoSaida: 2, resposta: falha('PEDIDO_INVALIDO', `o texto tem ${texto.length} caracteres e o limite e ${LIMITE_TEXTO}; divida em mensagens menores`) };

  // A trava vem antes de qualquer outra coisa, ate das chaves: o motivo certo e o primeiro a aparecer.
  const parado = envio.paradoMotivo();
  if (parado) {
    return { codigoSaida: 1, resposta: falha('PARADO', `os envios estao travados: ${parado}. Nao tente de novo: avise o dono, que confere o numero no celular e libera com "dgclaw-agente canal whatsapp retomar"`) };
  }
  let adaptador;
  try {
    adaptador = criarAdaptadorZapi({ instancia: env.ZAPI_INSTANCE, token: env.ZAPI_TOKEN, clientToken: env.ZAPI_CLIENT_TOKEN, fetchImpl });
  } catch (e) {
    return { codigoSaida: 1, resposta: falha('SEM_CHAVE', motivoErro(e)) };
  }
  const r = await envio.enviar({ para: numero, texto, executar: () => adaptador.enviarTexto(numero, texto) });
  if (!r.ok) return { codigoSaida: 1, resposta: r };
  return { codigoSaida: 0, resposta: { ok: true, para: numero, id: r.resultado.id, disparo: r.disparo, esperou_ms: r.esperou_ms, ...(r.aviso ? { aviso: r.aviso } : {}) } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { codigoSaida, resposta } = await executar(process.argv.slice(2));
  process.stdout.write(JSON.stringify(resposta) + '\n');
  process.exit(codigoSaida);
}
