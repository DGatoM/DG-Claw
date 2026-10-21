'use strict';
// Preferências dos avisos de atenção no aparelho, por usuário: { precisa_de_voce, terminou }.
// Padrão: os dois ligados. Arquivo em <dados>/push/preferencias.json (modo 600).
// Os avisos vão para todos os aparelhos inscritos (a inscrição não é por usuário), então um tipo é enviado
// quando ALGUM usuário o tem ligado. Hoje o painel tem um login só; a regra existe para não calar o dono
// por causa de um segundo login que desligou o aviso.

const fs = require('node:fs');
const path = require('node:path');
const { gravaArquivoSeguro } = require('./grava-seguro');

const TIPOS = ['precisa_de_voce', 'terminou'];

function criarPrefsAtencao({ arquivo, log }) {
  const pasta = path.dirname(arquivo);
  let dados = null; // { <usuario>: { precisa_de_voce, terminou } }

  function erro503(msg) { const e = new Error(msg); e.status = 503; log('erro', msg); return e; }

  function carrega() {
    if (dados) return dados;
    let bruto;
    try { bruto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') { dados = {}; return dados; }
      throw erro503(`Não consegui ler ${arquivo} (${e.code || e.message}). Não gravei nada para não apagar suas preferências. Confira as permissões da pasta ${pasta}.`);
    }
    // Valida o documento inteiro numa variável temporária e só então troca o cache (revisão adversarial
    // do PR #58): um usuário malformado no meio deixava `dados` pela metade, e a gravação seguinte
    // apagava as escolhas que vinham depois dele.
    let novo;
    try {
      const j = JSON.parse(bruto);
      if (!j || typeof j !== 'object' || Array.isArray(j) || !j.usuarios || typeof j.usuarios !== 'object' || Array.isArray(j.usuarios)) throw new Error('falta o campo "usuarios"');
      novo = {};
      for (const u of Object.keys(j.usuarios)) {
        const prefs = j.usuarios[u];
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error(`as preferências de "${u}" não são um objeto`);
        novo[u] = {};
        for (const t of TIPOS) if (typeof prefs[t] === 'boolean') novo[u][t] = prefs[t];
      }
    } catch (e) {
      throw erro503(`O arquivo ${arquivo} está ilegível (${e.message}). Não o apaguei: conserte-o ou renomeie-o e as preferências voltam ao padrão (tudo ligado).`);
    }
    dados = novo;
    return dados;
  }

  function de(usuario) {
    const d = carrega();
    const meu = Object.hasOwn(d, usuario) ? d[usuario] : {};
    return { precisa_de_voce: meu.precisa_de_voce !== false, terminou: meu.terminou !== false };
  }

  /** `parcial` só com as chaves booleanas conhecidas; qualquer outra coisa lança 400 dizendo o que mandar. */
  function grava(usuario, parcial) {
    if (!parcial || typeof parcial !== 'object' || Array.isArray(parcial)) {
      const e = new Error('Mande um objeto como {"precisa_de_voce": true, "terminou": false}.'); e.status = 400; throw e;
    }
    const novas = {};
    for (const k of Object.keys(parcial)) {
      if (!TIPOS.includes(k)) { const e = new Error(`A preferência "${k}" não existe. As que existem: ${TIPOS.join(', ')}.`); e.status = 400; throw e; }
      if (typeof parcial[k] !== 'boolean') { const e = new Error(`"${k}" precisa ser true ou false. Recebi: ${JSON.stringify(parcial[k])}.`); e.status = 400; throw e; }
      novas[k] = parcial[k];
    }
    const d = carrega();
    const copia = {};
    for (const u of Object.keys(d)) copia[u] = { ...d[u] };
    copia[usuario] = { ...(copia[usuario] || {}), ...novas };
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      gravaArquivoSeguro(arquivo, `${JSON.stringify({ versao: 1, usuarios: copia }, null, 2)}\n`, { raiz: pasta, modo: 0o600 });
    } catch (e) {
      throw erro503(`Não consegui gravar ${arquivo} (${e.message}). A preferência não mudou. Confira o espaço e as permissões da pasta ${pasta}.`);
    }
    dados = copia;
    return de(usuario);
  }

  /** O vigia pergunta: alguém quer este tipo de aviso? Se o arquivo não pôde ser lido, o aviso NÃO sai:
   *  sem saber o que a pessoa escolheu, mandar seria religar por conta própria um aviso que ela pode ter
   *  desligado. O motivo já foi para o log pelo erro503 (revisão adversarial do PR #58). */
  function alguemQuer(tipo) {
    let d;
    try { d = carrega(); } catch (e) { return false; }
    const usuarios = Object.keys(d);
    if (!usuarios.length) return true;
    return usuarios.some((u) => d[u][tipo] !== false);
  }

  return { de, grava, alguemQuer };
}

module.exports = { criarPrefsAtencao, TIPOS };
