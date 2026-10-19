'use strict';
// Armazenamento dos usuários do Web: <dataDir>/usuarios.json (600). Só é lido quando o multiusuário está
// ligado (web/lib/ent/usuarios.js). A CLI (lib/enterprise/usuarios.sh) mexe no mesmo arquivo com jq e a mesma trava.
//
// Forma: { versao: 1, usuarios: [ { usuario, nome, email, papel: 'ti' | 'funcionario', agentes: [slug],
//   hash, totp: { segredo, ativo, ativado_em, codigos_reserva: [sha256], ultimo_passo }, link: { token_sha256, expira, usado_em },
//   origem, criado_em, desativado_em, ultimo_login } ] }
//
// Trava: `mkdir <arquivo>.trava` (a mesma ideia da auditoria). Trava com mais de 30 s é de processo que morreu.
// Gravação atômica pelo grava-seguro (temporário na mesma pasta, fsync, rename), sempre com modo 600.

const fs = require('node:fs');
const path = require('node:path');
const { gravaArquivoSeguro } = require('./grava-seguro');

const PAPEIS = ['ti', 'funcionario'];
const RX_USUARIO = /^[a-z0-9][a-z0-9._@-]{1,63}$/;
const TRAVA_VELHA_MS = 30 * 1000;
const ESPERA_MAX_MS = 10 * 1000;
const DORME = new Int32Array(new SharedArrayBuffer(4));

class ErroUsuarios extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.name = 'ErroUsuarios';
    this.status = status || 500;
  }
}

const chave = (nome) => String(nome == null ? '' : nome).trim().toLowerCase();

/** Preenche o que falta de um registro, sem inventar dado: o que não existe vira vazio, nunca "zero". */
function normaliza(u) {
  const t = u.totp && typeof u.totp === 'object' ? u.totp : {};
  return Object.assign({}, u, {
    usuario: String(u.usuario),
    nome: typeof u.nome === 'string' ? u.nome : String(u.usuario),
    email: typeof u.email === 'string' ? u.email : '',
    papel: PAPEIS.includes(u.papel) ? u.papel : 'funcionario',
    agentes: Array.isArray(u.agentes) ? u.agentes.filter((s) => typeof s === 'string') : [],
    hash: typeof u.hash === 'string' ? u.hash : '',
    totp: {
      segredo: typeof t.segredo === 'string' ? t.segredo : '',
      ativo: t.ativo === true,
      ativado_em: t.ativado_em == null ? null : t.ativado_em,
      codigos_reserva: Array.isArray(t.codigos_reserva) ? t.codigos_reserva : [],
      ultimo_passo: Number.isInteger(t.ultimo_passo) ? t.ultimo_passo : null,
    },
    criado_em: u.criado_em == null ? null : u.criado_em,
    desativado_em: u.desativado_em == null ? null : u.desativado_em,
    ultimo_login: u.ultimo_login == null ? null : u.ultimo_login,
  });
}

function criarArquivoUsuarios({ dataDir, log, semente }) {
  const caminho = path.join(dataDir, 'usuarios.json');
  const trava = `${caminho}.trava`;
  let cache = { marca: null, dados: null };

  function marcaDoArquivo() {
    try {
      const st = fs.statSync(caminho);
      return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
      if (e.code === 'ENOENT') return 'ausente';
      throw new ErroUsuarios(`Não consegui ler ${caminho} (${e.code || e.message}). Confira a permissão da pasta ${dataDir}; sem esse arquivo ninguém entra no painel.`, 503);
    }
  }

  function lerDisco() {
    let texto;
    try { texto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
      throw new ErroUsuarios(`Não consegui ler ${caminho} (${e.code || e.message}). Confira a permissão do arquivo.`, 503);
    }
    let j;
    try { j = JSON.parse(texto); } catch (e) {
      throw new ErroUsuarios(`${caminho} não é um JSON válido (${e.message}). Restaure a última cópia boa do arquivo ou corrija-o à mão; enquanto isso ninguém entra no painel. Socorro: dgclaw usuario listar.`, 503);
    }
    if (!j || typeof j !== 'object' || !Array.isArray(j.usuarios)) {
      throw new ErroUsuarios(`${caminho} não tem a lista "usuarios". Restaure a última cópia boa do arquivo.`, 503);
    }
    return { versao: 1, usuarios: j.usuarios.filter((u) => u && typeof u.usuario === 'string' && u.usuario).map(normaliza) };
  }

  /** Os dados atuais (relidos quando o arquivo muda). Cria o arquivo com a `semente` na primeira partida. */
  function ler() {
    let marca = marcaDoArquivo();
    if (marca === 'ausente') {
      const dados = { versao: 1, usuarios: semente ? semente() : [] };
      comTrava(() => {
        if (marcaDoArquivo() === 'ausente') gravar(dados);
      });
      marca = marcaDoArquivo();
    }
    if (cache.marca !== marca) cache = { marca, dados: lerDisco() };
    return cache.dados;
  }

  function gravar(dados) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    gravaArquivoSeguro(caminho, JSON.stringify({ versao: 1, usuarios: dados.usuarios }, null, 2) + '\n', { raiz: dataDir, modo: 0o600 });
    cache = { marca: null, dados: null };
  }

  function comTrava(fn) {
    const limite = Date.now() + ESPERA_MAX_MS;
    for (;;) {
      try { fs.mkdirSync(trava); break; } catch (e) {
        if (e.code !== 'EEXIST') throw new ErroUsuarios(`Não consegui criar a trava ${trava} (${e.code || e.message}). Confira a permissão da pasta ${dataDir}.`, 503);
      }
      let idade = 0;
      try { idade = Date.now() - fs.statSync(trava).mtimeMs; } catch (_) { continue; }
      if (idade > TRAVA_VELHA_MS) {
        log('aviso', `A trava ${trava} tinha ${Math.round(idade / 1000)} s (mais de 30); o processo que a criou provavelmente morreu. Estou removendo e seguindo.`);
        try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      if (Date.now() > limite) throw new ErroUsuarios(`Não consegui a trava dos usuários (${trava}) em ${ESPERA_MAX_MS / 1000} s: outro processo a segura. Tente de novo; se nada estiver rodando, apague a pasta ${trava}.`, 503);
      Atomics.wait(DORME, 0, 0, 20);
    }
    try { return fn(); } finally {
      try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') log('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}). Apague a pasta se ela ficar para trás.`); }
    }
  }

  return {
    caminho,
    ler,
    lista: () => ler().usuarios,
    buscar(nome) {
      const k = chave(nome);
      return k ? ler().usuarios.find((u) => chave(u.usuario) === k) || null : null;
    },
    /**
     * Muda o arquivo sob trava: `fn(dados)` recebe uma cópia fresca, muda o que precisa e devolve o resultado.
     * Se `fn` lançar, nada é gravado; se devolver um objeto com `semMudanca: true`, também não. Devolve o que `fn` devolveu.
     */
    atualizar(fn) {
      return comTrava(() => {
        if (marcaDoArquivo() === 'ausente') gravar({ versao: 1, usuarios: semente ? semente() : [] });
        const dados = lerDisco();
        const r = fn(dados);
        if (!(r && r.semMudanca === true)) gravar(dados);
        return r;
      });
    },
  };
}

module.exports = { criarArquivoUsuarios, ErroUsuarios, normaliza, chave, PAPEIS, RX_USUARIO };
