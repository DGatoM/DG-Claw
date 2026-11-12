'use strict';
// O que o painel já mostrou do modal "Faça o login nos seus agentes", por usuário:
//   { vistos: [<id do agente>], nao_mostrar_mais: true|false }
// "vistos" são os agentes sem login que o modal já apresentou; ele não volta por causa deles. "nao_mostrar_mais"
// é o botão do modal: nenhum agente, nem um criado depois, reabre o modal. Guardado no servidor para valer em
// qualquer aparelho e navegador. Arquivo em <dados>/modal-login.json (modo 600).

const fs = require('node:fs');
const path = require('node:path');
const { gravaArquivoSeguro } = require('./grava-seguro');

const MAX_VISTOS = 200;
const ID_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function criarModalLoginPrefs({ arquivo, log }) {
  const pasta = path.dirname(arquivo);
  let dados = null;

  function erro(msg, status) { const e = new Error(msg); e.status = status; if (status >= 500) log('erro', msg); return e; }

  function carrega() {
    if (dados) return dados;
    let bruto;
    try { bruto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') { dados = {}; return dados; }
      throw erro(`Não consegui ler ${arquivo} (${e.code || e.message}). Não gravei nada para não apagar sua escolha. Confira as permissões da pasta ${pasta}.`, 503);
    }
    let novo;
    try {
      const j = JSON.parse(bruto);
      if (!j || typeof j.usuarios !== 'object' || j.usuarios === null || Array.isArray(j.usuarios)) throw new Error('falta o campo "usuarios"');
      novo = {};
      for (const u of Object.keys(j.usuarios)) {
        const p = j.usuarios[u];
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`a escolha de "${u}" não é um objeto`);
        novo[u] = { vistos: (Array.isArray(p.vistos) ? p.vistos : []).filter((x) => typeof x === 'string' && ID_OK.test(x)).slice(0, MAX_VISTOS), nao_mostrar_mais: p.nao_mostrar_mais === true };
      }
    } catch (e) {
      throw erro(`O arquivo ${arquivo} está ilegível (${e.message}). Não o apaguei: conserte-o ou renomeie-o e o modal volta a aparecer uma vez.`, 503);
    }
    dados = novo;
    return dados;
  }

  function de(usuario) {
    const d = carrega();
    const m = Object.hasOwn(d, usuario) ? d[usuario] : null;
    return { vistos: m ? [...m.vistos] : [], nao_mostrar_mais: m ? m.nao_mostrar_mais : false };
  }

  /** corpo: { vistos?: [ids], nao_mostrar_mais?: true }. Os ids se juntam aos já vistos; a dispensa só liga (não há "desfazer"). */
  function grava(usuario, corpo) {
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro('Mande um objeto como {"vistos": ["sofia"], "nao_mostrar_mais": true}.', 400);
    const atual = de(usuario);
    if (corpo.vistos !== undefined) {
      if (!Array.isArray(corpo.vistos) || corpo.vistos.some((x) => typeof x !== 'string' || !ID_OK.test(x))) throw erro(`"vistos" precisa ser uma lista de ids de agente (letras, números, - e _). Recebi: ${JSON.stringify(corpo.vistos).slice(0, 80)}.`, 400);
      for (const id of corpo.vistos) if (!atual.vistos.includes(id)) atual.vistos.push(id);
      if (atual.vistos.length > MAX_VISTOS) atual.vistos = atual.vistos.slice(-MAX_VISTOS);
    }
    if (corpo.nao_mostrar_mais !== undefined) {
      if (corpo.nao_mostrar_mais !== true) throw erro('"nao_mostrar_mais" só aceita true. Para voltar a ver o aviso, use a página Conectar conta.', 400);
      atual.nao_mostrar_mais = true;
    }
    const d = carrega();
    const copia = {};
    for (const u of Object.keys(d)) copia[u] = { ...d[u] };
    copia[usuario] = atual;
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      gravaArquivoSeguro(arquivo, `${JSON.stringify({ versao: 1, usuarios: copia }, null, 2)}\n`, { raiz: pasta, modo: 0o600 });
    } catch (e) {
      throw erro(`Não consegui gravar ${arquivo} (${e.message}). A escolha não foi guardada. Confira o espaço e as permissões da pasta ${pasta}.`, 503);
    }
    dados = copia;
    return de(usuario);
  }

  return { de, grava };
}

module.exports = { criarModalLoginPrefs };
