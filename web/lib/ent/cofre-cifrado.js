'use strict';
// Cofre cifrado em repouso (proteção `cofre_cifrado`). A lógica de guardar e ler o cofre cifrado fica aqui;
// web/lib/cofre-agente.js só chama os dois ganchos (`ativo`, `ler`, `gravar`) e não sabe de systemd-creds.
//
// Onde fica cada coisa quando a proteção está ligada (o lado bash é lib/enterprise/cofre-cifrado.sh):
//   <casa>/cofre/cofre.env.cred          o cofre cifrado com `systemd-creds encrypt --name=dgclaw-cofre-<slug>`
//                                        (chave do host; TPM2 se houver). É a única cópia no disco.
//   /run/dgclaw/cofres/<slug>/cofre.env  a cópia em claro, só em RAM (tmpfs), pasta 700 e arquivo 600 do root
//                                        mapeado do container. É essa pasta que o container monta em
//                                        /run/dgclaw/cofre (o runner e o cofre-nomes.sh leem de lá).
// O valor das chaves entra no systemd-creds sempre pelo stdin, nunca por argumento, e não vai para mensagem.
// Com a proteção desligada nada daqui roda: `ativo()` devolve false.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gravaArquivoSeguro } = require('../grava-seguro');
const { criarProtecoes } = require('../protecoes');

const RAM_PADRAO = '/run/dgclaw/cofres';
const SLUG_OK = /^[a-z0-9][a-z0-9-]{1,30}$/;

class ErroCofreCifrado extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroCofreCifrado';
    this.code = codigo || 'COFRE_CIFRADO';
  }
}

/** Mensagem curta do que o systemd-creds disse, sem nunca repetir o que entrou pelo stdin. */
function motivoDoComando(e) {
  if (e && e.code === 'ENOENT') return 'o programa systemd-creds não existe nesta máquina';
  const saida = e && e.stderr ? String(e.stderr).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return saida || (e && e.message ? String(e.message).split('\n')[0].slice(0, 200) : 'erro desconhecido');
}

function criarCofreCifrado({ config, log, protecoes, comando, ramDir } = {}) {
  const lg = log || (() => {});
  const caminhoProtecoes = config && config.protecoesPath;
  // Criado só quando precisa: sem o protecoes.json (nível pessoal) nem a matriz é lida.
  let prot = protecoes || null;
  const creds = comando || process.env.DGCLAW_SYSTEMD_CREDS || 'systemd-creds';
  const ram = ramDir || (config && config.cofresRamDir) || process.env.DGCLAW_COFRES_RAM || RAM_PADRAO;

  const nomeCred = (slug) => `dgclaw-cofre-${slug}`;
  const casaDe = (agente) => path.dirname(path.dirname(agente.cofre_arquivo));
  const arquivoCred = (agente) => `${agente.cofre_arquivo}.cred`;
  const pastaRam = (agente) => path.join(ram, agente.slug);
  const arquivoRam = (agente) => path.join(pastaRam(agente), 'cofre.env');

  function conferirSlug(agente) {
    if (!SLUG_OK.test(String(agente.slug || ''))) {
      throw new ErroCofreCifrado(`O nome curto do agente (${JSON.stringify(String(agente.slug).slice(0, 40))}) não serve para nomear o cofre cifrado.`, 'SLUG_INVALIDO');
    }
  }

  function cifrar(agente, texto) {
    try {
      return execFileSync(creds, ['encrypt', `--name=${nomeCred(agente.slug)}`, '--with-key=auto', '-', '-'],
        { input: texto, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new ErroCofreCifrado(`Não consegui cifrar o cofre de ${agente.slug}: ${motivoDoComando(e)}. Nada foi alterado no cofre.`, 'CIFRAR');
    }
  }

  function decifrar(agente, blob) {
    try {
      return execFileSync(creds, ['decrypt', `--name=${nomeCred(agente.slug)}`, '-', '-'],
        { input: blob, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8');
    } catch (e) {
      throw new ErroCofreCifrado(`Não consegui decifrar ${arquivoCred(agente)}: ${motivoDoComando(e)}. As chaves continuam no arquivo; não gravei nada para não perdê-las.`, 'DECIFRAR');
    }
  }

  /** Cria /run/dgclaw/cofres/<slug> (700) com o dono da pasta do cofre na casa (o root do container). */
  function prepararPastaRam(agente) {
    const pastaCofre = path.dirname(agente.cofre_arquivo);
    let dono;
    try { dono = fs.statSync(pastaCofre); } catch (e) {
      throw new ErroCofreCifrado(`Não achei a pasta do cofre ${pastaCofre} (${e.code || e.name}).`, 'SEM_PASTA');
    }
    try {
      fs.mkdirSync(ram, { recursive: true, mode: 0o700 });
      fs.mkdirSync(pastaRam(agente), { recursive: true, mode: 0o700 });
      fs.chownSync(pastaRam(agente), dono.uid, dono.gid);
      fs.chmodSync(pastaRam(agente), 0o700);
    } catch (e) {
      throw new ErroCofreCifrado(`Não consegui preparar ${pastaRam(agente)} em memória (${e.code || e.name}). Confira se o Web roda como root.`, 'RAM');
    }
    return dono;
  }

  function gravarRam(agente, texto) {
    const dono = prepararPastaRam(agente);
    gravaArquivoSeguro(arquivoRam(agente), texto, { raiz: pastaRam(agente), uid: dono.uid, gid: dono.gid, modo: 0o600 });
  }

  return {
    ativo() {
      if (!prot) {
        if (!caminhoProtecoes || !fs.existsSync(caminhoProtecoes)) return false;
        prot = criarProtecoes({ caminho: caminhoProtecoes, log: lg });
      }
      return prot.ligada('cofre_cifrado');
    },

    /** Texto do cofre (RAM, senão decifra o .cred), ou null se não há cofre cifrado ainda (lê o claro do disco). */
    ler(agente) {
      conferirSlug(agente);
      try { return fs.readFileSync(arquivoRam(agente), 'utf8'); } catch (e) {
        if (e.code !== 'ENOENT') throw new ErroCofreCifrado(`Não consegui ler a cópia em memória do cofre de ${agente.slug} (${e.code || e.name}).`, 'LER_RAM');
      }
      let blob;
      try { blob = fs.readFileSync(arquivoCred(agente)); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new ErroCofreCifrado(`Não consegui ler ${arquivoCred(agente)} (${e.code || e.name}).`, 'LER_CRED');
      }
      const texto = decifrar(agente, blob);
      // A máquina reiniciou e a cópia em RAM ainda não foi aberta: reabre, para o container achar o arquivo.
      try { gravarRam(agente, texto); } catch (e) { lg('aviso', `Cofre de ${agente.slug}: decifrei, mas não consegui recriar a cópia em memória: ${e.message}`); }
      return texto;
    },

    /** Cifra, grava o .cred, atualiza a cópia em RAM e apaga o claro do disco. Lança ErroCofreCifrado se algo falha. */
    gravar(agente, texto) {
      conferirSlug(agente);
      const blob = cifrar(agente, texto);
      gravaArquivoSeguro(arquivoCred(agente), blob, { raiz: casaDe(agente), modo: 0o600 });
      gravarRam(agente, texto);
      try { fs.rmSync(agente.cofre_arquivo, { force: true }); } catch (e) {
        throw new ErroCofreCifrado(`O cofre foi cifrado, mas não consegui apagar o arquivo em claro ${agente.cofre_arquivo} (${e.code || e.name}). Apague-o à mão: ele ainda tem as chaves em texto.`, 'APAGAR_CLARO');
      }
    },

    arquivoRam,
    arquivoCred,
  };
}

module.exports = {
  nome: 'cofre-cifrado',
  ordem: 90,
  // Nada de rota ou regra de acesso: o módulo existe pelo criarCofreCifrado, que o cofre-agente usa.
  criar() { return {}; },
  criarCofreCifrado,
  ErroCofreCifrado,
};
