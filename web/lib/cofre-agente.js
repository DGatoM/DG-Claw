'use strict';
// Cofre do agente gravado pelo DG Claw Web, no host (o painel de dentro do container só lê os nomes).
//
// Onde fica cada coisa (tudo no host; `<casa>` é a pasta do agente, a mesma do registro):
//   <casa>/cofre/cofre.env     as chaves, uma `NOME='valor'` por linha. Pasta 700 e arquivo 600 do
//                              root do container: o agente não lê, o runner recebe pelo systemd.
//   <casa>/config/cofre-nomes  só os NOMES (`NOME=`), 644, montado só leitura no container. É o que
//                              o painel de dentro usa para dizer "esta chave existe".
//   <dataDir>/cofre/<slug>.json  metadados (quem cadastrou, quando, últimos 4). Fora da casa, 600 do
//                              root: o agente não escreve nem lê. Sem o valor.
//
// O valor de uma chave NUNCA vai para log, mensagem de erro nem resposta: só os 4 últimos caracteres.
// A régua do que pode ser guardado é a do painel (`validarChave`), importada para não haver duas.
// A escrita segura (sem atalho, atômica, dono e modo preservados) fica em ./grava-seguro e é
// reexportada aqui: o token do Telegram usa a mesma.
//
// Nada aqui reinicia o agente por conta própria. Guardar e revogar só mexem em arquivo; quem faz a
// chave valer é `aplicar`, porque o runner lê o cofre.env na partida da unidade.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { gravaArquivoSeguro, ErroGravacao } = require('./grava-seguro');
const { validarChave, linhaDeAmbiente, recusa, PROVEDORES, NOME_FORMA_OK } = require('../../panel/lib/cofre');

const UNIDADE = 'dgclaw-runner';
const ARQUIVO_VISTO_DE_DENTRO = '/run/dgclaw/cofre/cofre.env';
const TIMEOUT_REINICIO_MS = 60000;
const RX_LINHA_CHAVE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Tira as aspas de um valor de `NOME=valor`, `NOME="valor"` ou `NOME='valor'`. */
function valorDaLinha(bruto) {
  const v = bruto.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) return v.slice(1, -1);
  return v;
}

/** Tira de um texto qualquer o que parece chave (stderr do podman, por exemplo). */
function limpa(texto) {
  return String(texto == null ? '' : texto).replace(/sk-[A-Za-z0-9_-]{8,}/g, '[chave]').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function dormir(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Reinício padrão: `systemctl restart dgclaw-runner` dentro do container do agente. */
function reiniciarPorPodman(agente) {
  const container = agente.container || `dgclaw-${agente.slug}`;
  return new Promise((resolve, reject) => {
    execFile('podman', ['exec', container, 'systemctl', 'restart', UNIDADE], { timeout: TIMEOUT_REINICIO_MS }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.container = container; reject(err); return; }
      resolve();
    });
  });
}

function criarCofreAgente({ config, log, reiniciar }) {
  const fazReiniciar = reiniciar || reiniciarPorPodman;
  const dirMeta = path.join(config.dataDir, 'cofre');
  const souProcesso = { uid: typeof process.getuid === 'function' ? process.getuid() : 0, gid: typeof process.getgid === 'function' ? process.getgid() : 0 };

  function semV1(agente) {
    return recusa(
      `O agente ${agente.nome} não está no layout da v1 (o registro não traz "cofre_arquivo"), então o DG Claw Web não sabe onde gravar a chave dele.`,
      409,
      'Esse agente guarda a chave de outro jeito. Se ele devia ser da v1, confira o registro de agentes (agentes.json) e crie o agente de novo pelo "dgclaw agente".',
    );
  }

  function caminhos(agente) {
    const casa = path.dirname(path.dirname(agente.cofre_arquivo));
    return { casa, cofre: agente.cofre_arquivo, nomes: path.join(casa, 'config', 'cofre-nomes') };
  }

  function recusaDeGravacao(e, oQue, agente) {
    log('erro', `Cofre de ${agente.slug}: não consegui ${oQue} (${e instanceof ErroGravacao ? e.code : (e.code || e.name)}): ${e.message}`);
    return recusa(`Não consegui ${oQue}: ${e.message}`, 500,
      'Nada foi alterado nesse arquivo. Confira se a pasta do agente existe e se o DG Claw Web roda como root (ver web/README.md).');
  }

  // ── leitura do cofre.env ────────────────────────────────────────────────
  /** { itens:[{tipo:'chave',nome,valor,bruta}|{tipo:'outra',bruta}] } ou { erro }. Arquivo ausente = vazio. */
  function lerCofreEnv(agente) {
    const { cofre } = caminhos(agente);
    let texto;
    try {
      texto = fs.readFileSync(cofre, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { itens: [] };
      log('erro', `Cofre de ${agente.slug}: não consegui ler ${cofre} (${e.code || e.name}).`);
      return { erro: recusa(`Não consegui ler o arquivo do cofre de ${agente.nome} (${e.code || e.name}).`, 500,
        'Confira se o arquivo existe e se o DG Claw Web roda como root.') };
    }
    const itens = [];
    let desconhecidas = 0;
    for (const bruta of texto.split(/\r?\n/)) {
      const t = bruta.trim();
      if (!t) continue;
      if (t.startsWith('#')) { itens.push({ tipo: 'outra', bruta: t }); continue; }
      const m = RX_LINHA_CHAVE.exec(bruta);
      if (m) {
        const nome = m[1];
        // Nome repetido: vale o último, como no systemd.
        const repetido = itens.findIndex((i) => i.tipo === 'chave' && i.nome === nome);
        if (repetido >= 0) itens.splice(repetido, 1);
        itens.push({ tipo: 'chave', nome, valor: valorDaLinha(m[2]), bruta: t });
      } else {
        desconhecidas += 1;
        itens.push({ tipo: 'outra', bruta: t });
      }
    }
    if (desconhecidas) log('aviso', `Cofre de ${agente.slug}: ${cofre} tem ${desconhecidas} linha(s) que não entendi como NOME=valor; mantive como estão (o conteúdo delas não vai para o log).`);
    return { itens };
  }

  /** Sempre em aspas simples. Valor antigo que não cabe nesse formato (aspa dentro) mantém a linha original. */
  function serializa(itens) {
    const linhas = itens.map((i) => {
      if (i.tipo !== 'chave') return i.bruta;
      try { return linhaDeAmbiente(i.nome, i.valor); } catch (_) { return i.bruta; }
    });
    return linhas.length ? `${linhas.join('\n')}\n` : '';
  }

  function gravaCofreENomes(agente, itens) {
    const { casa, cofre, nomes } = caminhos(agente);
    try {
      gravaArquivoSeguro(cofre, serializa(itens), { raiz: casa });
    } catch (e) { return recusaDeGravacao(e, 'gravar o cofre do agente', agente); }
    const lista = itens.filter((i) => i.tipo === 'chave').map((i) => `${i.nome}=\n`).join('');
    try {
      gravaArquivoSeguro(nomes, lista, { raiz: casa, modo: 0o644 });
    } catch (e) {
      const r = recusaDeGravacao(e, 'atualizar a lista de nomes das chaves (config/cofre-nomes)', agente);
      r.howToFix = 'O cofre do agente JÁ foi alterado. Só a lista de nomes que o painel de dentro mostra ficou desatualizada: confira a pasta config da casa do agente e repita a operação.';
      return r;
    }
    return null;
  }

  // ── metadados ───────────────────────────────────────────────────────────
  function arquivoMeta(slug) { return path.join(dirMeta, `${slug}.json`); }

  function lerMeta(agente) {
    const arq = arquivoMeta(agente.slug);
    let texto;
    try { texto = fs.readFileSync(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { chaves: [] };
      log('erro', `Cofre de ${agente.slug}: não consegui ler os metadados ${arq} (${e.code || e.name}).`);
      return { erro: recusa(`Não consegui ler os registros das chaves de ${agente.nome} (${e.code || e.name}).`, 500, 'Confira a pasta de dados do DG Claw Web.') };
    }
    try {
      const j = JSON.parse(texto);
      if (j && Array.isArray(j.chaves)) return { chaves: j.chaves };
    } catch (_) { /* cai no erro abaixo */ }
    log('erro', `Cofre de ${agente.slug}: ${arq} não é um JSON no formato esperado. Não o sobrescrevo para não perder o histórico.`);
    return { erro: recusa(`O registro das chaves de ${agente.nome} (${arq}) está corrompido.`, 500, 'Corrija ou renomeie esse arquivo; as chaves em si continuam no cofre do agente.') };
  }

  function preparaPastaMeta() {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dirMeta, { recursive: true, mode: 0o700 });
  }

  function gravaMeta(agente, chaves) {
    try {
      preparaPastaMeta();
      gravaArquivoSeguro(arquivoMeta(agente.slug), `${JSON.stringify({ versao: 1, chaves }, null, 2)}\n`, {
        raiz: config.dataDir, uid: souProcesso.uid, gid: souProcesso.gid, modo: 0o600,
        pasta: { modo: 0o700, uid: souProcesso.uid, gid: souProcesso.gid },
      });
      return null;
    } catch (e) {
      const r = recusaDeGravacao(e, 'anotar o registro da chave', agente);
      r.howToFix = 'A alteração no cofre do agente JÁ foi feita; só o registro de quem cadastrou e quando não foi anotado. Corrija a pasta de dados do DG Claw Web e repita.';
      return r;
    }
  }

  // ── trava ───────────────────────────────────────────────────────────────
  // As funções abaixo são síncronas, então dois pedidos DENTRO do Web já se enfileiram. A trava em
  // arquivo cobre o outro caso: a linha de comando (outro processo) gravando ao mesmo tempo.
  function comTrava(agente, fn) {
    try { preparaPastaMeta(); } catch (e) {
      return recusaDeGravacao(e, 'preparar a pasta de dados do cofre', agente);
    }
    const arq = path.join(dirMeta, `${agente.slug}.lock`);
    const limite = Date.now() + 5000;
    let fd = null;
    for (;;) {
      try { fd = fs.openSync(arq, 'wx', 0o600); break; } catch (e) {
        if (e.code !== 'EEXIST') return recusaDeGravacao(e, 'travar o cofre para gravar', agente);
        // Trava esquecida por um processo que morreu: passou de 30 s, é lixo.
        try { if (Date.now() - fs.statSync(arq).mtimeMs > 30000) { fs.unlinkSync(arq); continue; } } catch (_) { continue; }
        if (Date.now() > limite) {
          return recusa(`O cofre de ${agente.nome} está sendo alterado por outro pedido há mais de 5 s.`, 409, 'Espere um instante e tente de novo. Se persistir, apague o arquivo .lock dessa pasta de dados com o DG Claw Web parado.');
        }
        dormir(25);
      }
    }
    try { return fn(); } finally {
      try { fs.closeSync(fd); } catch (_) { /* já fechado */ }
      try { fs.unlinkSync(arq); } catch (_) { /* já removido */ }
    }
  }

  // ── a interface ─────────────────────────────────────────────────────────
  function nomeDoProvedor(id) { return (PROVEDORES.find((p) => p.id === id) || {}).nome || 'Outro serviço'; }

  /** Junta o que está no cofre.env com os metadados. Ativas primeiro, revogadas (histórico) depois. */
  function juntar(itens, meta) {
    const porNome = new Map(meta.map((m) => [m.envName, m]));
    const ativas = itens.filter((i) => i.tipo === 'chave').map((i) => {
      const m = porNome.get(i.nome);
      return {
        envName: i.nome,
        provedor: (m && m.provedor) || 'outro',
        ultimos4: (m && m.ultimos4) || i.valor.slice(-4),
        cadastradaPor: (m && m.cadastradaPor) || 'desconhecido',
        origem: (m && m.origem) || 'desconhecido',
        cadastradaEm: (m && m.cadastradaEm) || null,
        revogadaEm: null,
        trocadaEm: (m && m.trocadaEm) || null,
      };
    });
    const nomesAtivos = new Set(ativas.map((a) => a.envName));
    const revogadas = meta.filter((m) => m.revogadaEm && !nomesAtivos.has(m.envName)).map((m) => ({
      envName: m.envName, provedor: m.provedor || 'outro', ultimos4: m.ultimos4 || '', cadastradaPor: m.cadastradaPor || 'desconhecido',
      origem: m.origem || 'desconhecido', cadastradaEm: m.cadastradaEm || null, revogadaEm: m.revogadaEm, trocadaEm: m.trocadaEm || null,
    }));
    return [...ativas, ...revogadas];
  }

  function estado(agente) {
    if (!agente.cofre_arquivo) return semV1(agente);
    const env = lerCofreEnv(agente); if (env.erro) return env.erro;
    const meta = lerMeta(agente); if (meta.erro) return meta.erro;
    return {
      agente: { slug: agente.slug, nome: agente.nome, dono: agente.dono || 'Dono' },
      chaves: juntar(env.itens, meta.chaves).map((c) => Object.assign({ provedorNome: nomeDoProvedor(c.provedor), motor: 'host' }, c)),
      provedores: PROVEDORES,
      guarda: {
        motor: 'host',
        motorExplicacao: 'A chave fica num arquivo do servidor, fora da pasta do agente, que só o administrador da máquina lê. O agente recebe o valor quando é reiniciado.',
        emMemoria: false,
        emMemoriaExplicacao: 'A chave fica no disco do servidor, em arquivo restrito ao administrador. O agente só a recebe na memória dele quando reinicia.',
      },
      aplicar: { pode: true, unidade: UNIDADE, forma: 'web' },
      arquivoDeAmbiente: ARQUIVO_VISTO_DE_DENTRO,
    };
  }

  function listar(agente) {
    const e = estado(agente);
    if (e.erro) return e;
    return { chaves: e.chaves.map((c) => ({ envName: c.envName, ultimos4: c.ultimos4, provedor: c.provedor, cadastradaEm: c.cadastradaEm, revogadaEm: c.revogadaEm })) };
  }

  function guardar(agente, pedido) {
    if (!agente.cofre_arquivo) return semV1(agente);
    const v = validarChave(pedido);
    if (v.erro) return v;
    const { nome, valor, provedor } = v;
    const quem = String((pedido && pedido.quem) || 'Dono').slice(0, 80);
    const origem = pedido && ['cli', 'api'].includes(pedido.origem) ? pedido.origem : 'tela';
    return comTrava(agente, () => {
      const env = lerCofreEnv(agente); if (env.erro) return env.erro;
      const meta = lerMeta(agente); if (meta.erro) return meta.erro;
      const existente = env.itens.findIndex((i) => i.tipo === 'chave' && i.nome === nome);
      const item = { tipo: 'chave', nome, valor, bruta: '' };
      if (existente >= 0) env.itens[existente] = item; else env.itens.push(item);
      const falha = gravaCofreENomes(agente, env.itens);
      if (falha) return falha;

      const agora = new Date().toISOString();
      const registro = { envName: nome, provedor, ultimos4: valor.slice(-4), cadastradaPor: quem, origem, cadastradaEm: agora, revogadaEm: null };
      if (existente >= 0) registro.trocadaEm = agora;
      const i = meta.chaves.findIndex((m) => m.envName === nome);
      if (i >= 0) meta.chaves[i] = registro; else meta.chaves.push(registro);
      const falhaMeta = gravaMeta(agente, meta.chaves);
      if (falhaMeta) return falhaMeta;

      log('info', `Cofre de ${agente.slug}: chave ${nome} ${existente >= 0 ? 'trocada' : 'guardada'} por ${quem} (origem ${origem}).`);
      const trocada = existente >= 0;
      return {
        ok: true,
        envName: nome,
        ultimos4: registro.ultimos4,
        trocada,
        aviso: trocada
          ? 'A chave foi trocada, mas o agente ainda está usando a antiga: ele só lê o cofre quando inicia.'
          : 'A chave foi guardada, mas o agente ainda não a tem: ele só lê o cofre quando inicia.',
      };
    });
  }

  function revogar(agente, envNameBruto, quem) {
    if (!agente.cofre_arquivo) return semV1(agente);
    const nome = String(envNameBruto || '').trim().toUpperCase();
    if (!NOME_FORMA_OK.test(nome)) return recusa('Nome de variável inválido, então não mexi em nada.', 400);
    const por = String(quem || 'Dono').slice(0, 80);
    return comTrava(agente, () => {
      const env = lerCofreEnv(agente); if (env.erro) return env.erro;
      const meta = lerMeta(agente); if (meta.erro) return meta.erro;
      const noEnv = env.itens.findIndex((i) => i.tipo === 'chave' && i.nome === nome);
      const m = meta.chaves.find((x) => x.envName === nome);
      if (noEnv < 0 && !m) return recusa(`Não achei nenhuma chave chamada "${nome}" neste cofre.`, 404);
      if (noEnv < 0 && m.revogadaEm) return recusa(`A chave "${nome}" já tinha sido revogada em ${String(m.revogadaEm).slice(0, 10)}.`, 409);
      if (noEnv >= 0) {
        env.itens.splice(noEnv, 1);
        const falha = gravaCofreENomes(agente, env.itens);
        if (falha) return falha;
      }
      const agora = new Date().toISOString();
      if (m) { m.revogadaEm = agora; m.revogadaPor = por; }
      else {
        // Chave que veio de script antigo, sem registro: a revogação também precisa deixar data.
        meta.chaves.push({ envName: nome, provedor: 'outro', ultimos4: '', cadastradaPor: 'desconhecido', origem: 'desconhecido', cadastradaEm: null, revogadaEm: agora, revogadaPor: por });
      }
      const falhaMeta = gravaMeta(agente, meta.chaves);
      if (falhaMeta) return falhaMeta;
      log('info', `Cofre de ${agente.slug}: chave ${nome} revogada por ${por}.`);
      return {
        ok: true,
        envName: nome,
        aviso:
          'A chave saiu do cofre, mas o agente ainda tem a antiga em uso: ela some do ambiente dele quando ele reiniciar. ' +
          'Se a chave vazou, revogue também no painel do serviço, que é o único lugar onde ela deixa de funcionar de verdade.',
      };
    });
  }

  function motivoDoReinicio(agente, e) {
    const container = e.container || agente.container || `dgclaw-${agente.slug}`;
    const detalhe = limpa(e.stderr);
    if (e.code === 'ENOENT') {
      return recusa('O programa "podman" não foi encontrado neste servidor, então não consegui reiniciar o agente.', 500,
        `A chave FOI guardada. Instale o podman ou reinicie à mão: "podman exec ${container} systemctl restart ${UNIDADE}".`);
    }
    if (e.killed || e.signal === 'SIGTERM') {
      return recusa(`O reinício de ${agente.nome} passou de ${TIMEOUT_REINICIO_MS / 1000} s e foi interrompido.`, 504,
        `A chave FOI guardada. Veja o estado do agente ("podman exec ${container} systemctl status ${UNIDADE}") e tente aplicar de novo.`);
    }
    if (/no such container|no container with name|is not running|container state improper|can only create exec sessions on running/i.test(detalhe)) {
      return recusa(`O container de ${agente.nome} (${container}) não está rodando, então não há o que reiniciar.`, 409,
        `A chave FOI guardada e vale quando o agente subir. Ligue o container ("podman start ${container}") e ela entra sozinha.`);
    }
    return recusa(`Não consegui reiniciar ${agente.nome} (${e.message ? limpa(e.message) : 'erro desconhecido'}${detalhe ? `: ${detalhe}` : ''}).`, 502,
      `A chave FOI guardada. Confira o container com "podman ps" e o serviço com "podman exec ${container} systemctl status ${UNIDADE}".`);
  }

  async function aplicar(agente) {
    if (!agente.cofre_arquivo) return semV1(agente);
    const env = lerCofreEnv(agente); if (env.erro) return env.erro;
    const n = env.itens.filter((i) => i.tipo === 'chave').length;
    try {
      await fazReiniciar(agente);
    } catch (e) {
      const r = motivoDoReinicio(agente, e || {});
      log('erro', `Cofre de ${agente.slug}: reinício falhou: ${r.erro}`);
      return r;
    }
    log('info', `Cofre de ${agente.slug}: agente reiniciado para ler o cofre (${n} chave(s)).`);
    const quanto = n === 0 ? 'O cofre está vazio.' : (n === 1 ? 'A chave que está no cofre agora vale para ele.' : `As ${n} chaves que estão no cofre agora valem para ele.`);
    return { ok: true, unidade: UNIDADE, chaves: n, falhas: [], feito: `O agente foi reiniciado e leu o cofre. ${quanto}` };
  }

  return { estado, guardar, revogar, aplicar, listar };
}

module.exports = { criarCofreAgente, gravaArquivoSeguro, ErroGravacao };
