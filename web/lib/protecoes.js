'use strict';
// Leitor das proteções enterprise: o nível da instalação e o valor efetivo de cada chave.
//
// Lê o mesmo par de arquivos que lib/protecoes.sh (a regra tem de ser igual nos dois):
//   - a matriz   config/protecoes-matriz.json  (padrão por nível, tipo, trava);
//   - a escolha  /etc/dgclaw/protecoes.json    ({ nivel, ajustes, org_uuid, atualizado_em }).
// Sem o arquivo da escolha o nível é `pessoal` e nenhum recurso enterprise age.
// Valor efetivo = ajuste (se o tipo estiver certo e não descer abaixo da trava) senão o padrão do nível.
// O arquivo é relido quando o mtime ou o tamanho mudam: `dgclaw nivel ajustar` vale sem reiniciar o Web.

const fs = require('node:fs');
const path = require('node:path');

const NIVEIS = ['pessoal', 'escritorio', 'empresa', 'regulado'];
const CAMINHO_PADRAO = '/etc/dgclaw/protecoes.json';
const MATRIZ_PADRAO = path.join(__dirname, '..', '..', 'config', 'protecoes-matriz.json');
const DESLIGADOS = new Set(['nao', 'livre', 'runc']);

/** Quanto maior, mais protegido. bool usa `forte` (padrão true); enum, a posição em `valores`. */
function forca(c, v) {
  if (c.tipo === 'bool') return v === (Object.hasOwn(c, 'forte') ? c.forte : true) ? 1 : 0;
  if (c.tipo === 'enum') return c.valores.indexOf(v);
  return 0;
}

function tipoOk(c, v) {
  if (c.tipo === 'bool') return typeof v === 'boolean';
  if (c.tipo === 'enum') return c.valores.includes(v);
  return typeof v === 'number' && Number.isInteger(v) && v >= (c.min == null ? 0 : c.min);
}

/** Por que o ajuste não vale naquele nível; null se vale. */
function motivoDoAjuste(c, nivel, v) {
  if (!tipoOk(c, v)) return 'o valor não é do tipo certo para esta chave';
  if (c.travado && c.travado[nivel] === true && forca(c, v) < forca(c, c.nivel[nivel])) {
    return `fica abaixo da trava do nível ${nivel} (o mínimo é ${JSON.stringify(c.nivel[nivel])})`;
  }
  return null;
}

function carregarMatriz(matriz) {
  if (matriz && typeof matriz === 'object') return matriz;
  const caminho = typeof matriz === 'string' ? matriz : MATRIZ_PADRAO;
  let texto;
  try {
    texto = fs.readFileSync(caminho, 'utf8');
  } catch (e) {
    throw new Error(`Não consegui ler a matriz de proteções em ${caminho} (${e.code || e.message}). Reinstale o DG Claw: o instalador copia a pasta config/.`);
  }
  try {
    return JSON.parse(texto);
  } catch (e) {
    throw new Error(`A matriz de proteções em ${caminho} não é um JSON válido (${e.message}). Restaure o arquivo do repositório.`);
  }
}

function criarProtecoes(opcoes) {
  const o = opcoes || {};
  const caminho = o.caminho || CAMINHO_PADRAO;
  const log = o.log || (() => {});
  const matriz = carregarMatriz(o.matriz);
  if (!matriz.chaves || typeof matriz.chaves !== 'object') {
    throw new Error('A matriz de proteções não tem o campo "chaves". Restaure config/protecoes-matriz.json do repositório.');
  }

  let cache = { marca: null, nivel: 'pessoal', ajustes: {}, org_uuid: '', atualizado_em: '', efetivos: null };

  function ler() {
    let st = null;
    try {
      st = fs.statSync(caminho);
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Não consegui ler ${caminho} (${e.code || e.message}); trato a instalação como nível pessoal. Confira a permissão do arquivo.`);
    }
    const marca = st ? `${st.mtimeMs}:${st.size}` : 'ausente';
    if (cache.marca === marca) return cache;

    const novo = { marca, nivel: 'pessoal', ajustes: {}, org_uuid: '', atualizado_em: '', efetivos: null };
    if (st) {
      let dados = null;
      try {
        dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
        if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new Error('o conteúdo não é um objeto JSON');
      } catch (e) {
        log('aviso', `${caminho} não é um JSON válido (${e.message}); trato a instalação como nível pessoal. Corrija o arquivo ou regrave com: dgclaw nivel definir <nível>.`);
        dados = null;
      }
      if (dados) {
        const n = dados.nivel == null ? 'pessoal' : dados.nivel;
        if (NIVEIS.includes(n)) novo.nivel = n;
        else log('aviso', `O nível "${String(n).slice(0, 40)}" em ${caminho} não existe (use: ${NIVEIS.join(', ')}); trato como pessoal.`);
        if (dados.ajustes && typeof dados.ajustes === 'object' && !Array.isArray(dados.ajustes)) novo.ajustes = dados.ajustes;
        novo.org_uuid = typeof dados.org_uuid === 'string' ? dados.org_uuid : '';
        novo.atualizado_em = typeof dados.atualizado_em === 'string' ? dados.atualizado_em : '';
      }
    }
    // Calcula os valores uma vez por versão do arquivo, e avisa de cada ajuste ignorado uma vez só.
    novo.efetivos = {};
    for (const [chave, c] of Object.entries(matriz.chaves)) {
      const padrao = c.nivel[novo.nivel];
      let valor = padrao;
      let ajustado = false;
      if (Object.hasOwn(novo.ajustes, chave)) {
        const v = novo.ajustes[chave];
        const motivo = motivoDoAjuste(c, novo.nivel, v);
        if (motivo) log('aviso', `Ajuste ignorado: ${chave} = ${JSON.stringify(v)} em ${caminho} (${motivo}). Vale o padrão do nível ${novo.nivel}: ${JSON.stringify(padrao)}.`);
        else { valor = v; ajustado = true; }
      }
      novo.efetivos[chave] = { valor, padrao, ajustado };
    }
    for (const chave of Object.keys(novo.ajustes)) {
      if (!matriz.chaves[chave]) log('aviso', `Ajuste ignorado: a chave "${String(chave).slice(0, 40)}" em ${caminho} não existe na matriz. Veja as chaves com: dgclaw nivel.`);
    }
    cache = novo;
    return cache;
  }

  function efetivo(chave) {
    const e = ler().efetivos[chave];
    if (!e) throw new Error(`A proteção "${String(chave).slice(0, 40)}" não existe na matriz. Confira o nome em config/protecoes-matriz.json.`);
    return e;
  }

  function ligadaValor(c, valor) {
    if (c.tipo === 'bool') return valor === true;
    if (c.tipo === 'enum') return !DESLIGADOS.has(valor);
    return typeof valor === 'number' && valor > 0;
  }

  return {
    nivel: () => ler().nivel,
    orgUuid: () => ler().org_uuid,
    valor: (chave) => efetivo(chave).valor,
    ligada: (chave) => ligadaValor(matriz.chaves[chave] || {}, efetivo(chave).valor),
    /** Tudo o que a tela precisa: o nível e, para cada chave, o valor efetivo, o padrão, a trava e os três textos. */
    resumo() {
      const l = ler();
      return {
        nivel: l.nivel,
        niveis: NIVEIS.slice(),
        org_uuid: l.org_uuid,
        atualizado_em: l.atualizado_em,
        chaves: Object.entries(matriz.chaves).map(([chave, c]) => {
          const e = l.efetivos[chave];
          return {
            chave,
            tipo: c.tipo,
            valores: c.valores || null,
            valor: e.valor,
            padrao: e.padrao,
            ajustado: e.ajustado,
            travado: !!(c.travado && c.travado[l.nivel] === true),
            ligada: ligadaValor(c, e.valor),
            descricao: c.descricao,
            como: c.como,
            porque: c.porque,
          };
        }),
      };
    },
  };
}

module.exports = { criarProtecoes, NIVEIS, forca, tipoOk, motivoDoAjuste };
