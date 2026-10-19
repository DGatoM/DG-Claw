'use strict';
// Bolinha de não lidas por agente. O "visto" fica NO SERVIDOR (não no aparelho), por usuário e por agente,
// para o celular e o computador do mesmo dono concordarem sobre o que já foi lido.
//
// visto_ep: o `ep` da última mensagem que estava na tela quando a conversa do agente esteve aberta e visível.
// Não lida = mensagem do próprio agente (origin 'agente'), que não seja aviso de sistema, com ep > visto_ep.
// Marca manual ("Marcar como não lida"): vive ao lado dos marcos, no mesmo arquivo, no campo `marcadas`
// ({ usuario: { slug: true } }). Arquivo antigo, só com `usuarios`, continua valendo e é lido sem a marca;
// `usuarios` não muda de formato, então quem voltar a uma versão anterior ainda lê os marcos.
// "Não sei" é null, nunca 0: thread que não respondeu não vira "nenhuma mensagem nova".

const path = require('node:path');
const fs = require('node:fs');
const { gravaArquivoSeguro } = require('./grava-seguro');

const TETO_CONTAGEM = 99;
const ESPERA_THREAD_MS = 1500;

const vazio = () => Object.create(null);

function criarNaoLidas({ arquivo, conversa, registro, log, relogio, lerThread }) {
  const ler = lerThread || ((agente) => conversa.thread(agente));
  const emAndamento = new Map(); // slug -> promessa da leitura em curso
  const agora = relogio || Date.now;
  const pasta = path.dirname(arquivo);
  let estado = null; // { usuario: { slug: visto_ep } } (sem protótipo), carregado na primeira necessidade
  let marcadas = vazio(); // { usuario: { slug: true } }
  let corrompidoPendente = false;

  const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Valida todos os níveis e devolve uma cópia sem protótipo. Lança Error com o motivo se algo destoa. */
  function normaliza(j) {
    if (!ehObjeto(j) || !ehObjeto(j.usuarios)) throw new Error('o conteúdo não tem o campo "usuarios" como objeto');
    const saida = vazio();
    for (const u of Object.keys(j.usuarios)) {
      if (!ehObjeto(j.usuarios[u])) throw new Error(`o usuário "${u}" não é um objeto de marcos`);
      saida[u] = vazio();
      for (const slug of Object.keys(j.usuarios[u])) {
        const v = j.usuarios[u][slug];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`o marco de "${u}"/"${slug}" não é um número maior ou igual a zero`);
        saida[u][slug] = v;
      }
    }
    return saida;
  }

  /** `marcadas` é opcional (arquivo antigo não tem). Valida e devolve uma cópia sem protótipo. */
  function normalizaMarcadas(j) {
    const saida = vazio();
    if (j === undefined) return saida;
    if (!ehObjeto(j)) throw new Error('o campo "marcadas" não é um objeto');
    for (const u of Object.keys(j)) {
      if (!ehObjeto(j[u])) throw new Error(`as marcas de "${u}" não são um objeto`);
      saida[u] = vazio();
      for (const slug of Object.keys(j[u])) {
        if (j[u][slug] !== true) throw new Error(`a marca de "${u}"/"${slug}" não é true`);
        saida[u][slug] = true;
      }
    }
    return saida;
  }

  const copia = (est) => {
    const c = vazio();
    for (const u of Object.keys(est)) { c[u] = vazio(); for (const s of Object.keys(est[u])) c[u][s] = est[u][s]; }
    return c;
  };

  function erro503(msg) { const e = new Error(msg); e.status = 503; log('erro', msg); return e; }

  /** Carrega uma vez. Só "arquivo não existe" vira vazio; qualquer outra falha de leitura lança 503 (e tenta de novo depois). */
  function carrega() {
    if (estado) return estado;
    let bruto;
    try {
      bruto = fs.readFileSync(arquivo, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { estado = vazio(); return estado; }
      throw erro503(`Não consegui ler ${arquivo} (${e.code || e.message}). Não criei nem gravei marcos para não apagar o que já estava guardado. Confira as permissões da pasta ${pasta} e tente de novo.`);
    }
    try {
      const j = JSON.parse(bruto);
      estado = normaliza(j);
      marcadas = normalizaMarcadas(j.marcadas);
    } catch (e) {
      log('erro', `O arquivo ${arquivo} está corrompido (${e.message}). Não apaguei: vou renomeá-lo para .corrompido-<hora> na próxima gravação e recomeçar sem marcos, então as bolinhas voltam a contar a partir de agora.`);
      estado = vazio();
      marcadas = vazio();
      corrompidoPendente = true;
    }
    return estado;
  }

  /** Grava o estado novo; só quando a gravação der certo ele passa a valer na memória. */
  function grava(novo, novasMarcadas) {
    const marcas = novasMarcadas || marcadas;
    if (corrompidoPendente) {
      const destino = `${arquivo}.corrompido-${agora()}`;
      try { fs.renameSync(arquivo, destino); } catch (e) {
        throw erro503(`Não consegui guardar o arquivo corrompido ${arquivo} como ${destino} (${e.code || e.message}). Nada foi gravado. Confira as permissões da pasta ${pasta}.`);
      }
      corrompidoPendente = false;
    }
    try {
      gravaArquivoSeguro(arquivo, `${JSON.stringify({ versao: 1, usuarios: novo, marcadas: marcas }, null, 2)}\n`, { raiz: pasta, modo: 0o600 });
    } catch (e) {
      throw erro503(`Não consegui gravar ${arquivo} (${e.message}). O que você leu continua na tela, mas a bolinha pode voltar a acender depois. Confira o espaço e as permissões da pasta ${pasta}.`);
    }
    estado = novo;
    marcadas = marcas;
  }

  const copiaMarcas = () => copia(marcadas);
  const temMarca = (usuario, slug) => Object.hasOwn(marcadas, usuario) && Object.hasOwn(marcadas[usuario], slug);

  // A leitura da thread é pesada e síncrona por dentro: GETs simultâneos dividem a mesma leitura por agente.
  // O teto de 1,5 s limita só a espera de quem chamou; a leitura continua e serve o próximo.
  function leituraCompartilhada(agente) {
    let p = emAndamento.get(agente.slug);
    if (!p) {
      p = Promise.resolve().then(() => ler(agente)).finally(() => emAndamento.delete(agente.slug));
      p.catch(() => {}); // o erro chega a quem espera pelo race; aqui só evita rejeição solta se ninguém esperar mais
      emAndamento.set(agente.slug, p);
    }
    return p;
  }

  async function threadComTeto(agente) {
    let timer;
    const espera = new Promise((resolve) => { timer = setTimeout(() => resolve('tempo'), ESPERA_THREAD_MS); });
    try {
      const t = await Promise.race([leituraCompartilhada(agente), espera]);
      if (t === 'tempo') return { erro: `A conversa de ${agente.nome} não respondeu em 1,5 s, então não sei quantas mensagens novas ela tem.` };
      if (!t || !Array.isArray(t.msgs)) return { erro: `Não consegui ler a conversa de ${agente.nome}, então não sei quantas mensagens novas ela tem.` };
      // thread() não rejeita: falha de leitura vem como vazio COM aviso. Vazio sem aviso é agente que nunca conversou.
      const avisos = Array.isArray(t.avisos) ? t.avisos : [];
      if (t.incompleta === true || (!t.msgs.length && avisos.length)) {
        return { erro: `Não consegui abrir a conversa de ${agente.nome} (${avisos[0] || 'sem detalhe'}), então não sei quantas mensagens novas ela tem.` };
      }
      return { msgs: t.msgs };
    } catch (e) {
      return { erro: `Não consegui ler a conversa de ${agente.nome} (${e.message}), então não sei quantas mensagens novas ela tem.` };
    } finally { clearTimeout(timer); }
  }

  /** { <slug>: { nao_lidas, mais?, visto_ep, ultima_ep, marco_novo?, erro? } } para o usuário. */
  async function contar(usuario) {
    const est = registro.estado();
    const agentes = est.ok ? est.agentes : [];
    carrega();
    const lidos = await Promise.all(agentes.map(async (a) => [a, await threadComTeto(a)]));
    // Estado lido só depois das esperas: um /lido que chegou no meio não pode se perder.
    const novo = copia(estado);
    const meus = novo[usuario] || (novo[usuario] = vazio());
    const saida = {};
    let mudou = false;
    for (const [a, r] of lidos) {
      const visto = Object.hasOwn(meus, a.slug) ? meus[a.slug] : null;
      if (r.erro) {
        log('aviso', `Bolinha de não lidas de ${a.nome}: ${r.erro} A lista segue sem a contagem dele.`);
        saida[a.slug] = { nao_lidas: null, visto_ep: visto, ultima_ep: null, erro: r.erro };
        continue;
      }
      let ultima = null; // laço, não Math.max(...): com ~150 mil mensagens o spread estoura a pilha
      for (const m of r.msgs) if (Number.isFinite(m.ep) && (ultima === null || m.ep > ultima)) ultima = m.ep;
      if (visto === null) {
        meus[a.slug] = ultima === null ? 0 : ultima;
        mudou = true;
        saida[a.slug] = { nao_lidas: 0, visto_ep: meus[a.slug], ultima_ep: ultima, marco_novo: true };
        continue;
      }
      let n = 0;
      for (const m of r.msgs) if (m.origin === 'agente' && !m.sistema && Number.isFinite(m.ep) && m.ep > visto) n += 1;
      const item = { nao_lidas: Math.min(n, TETO_CONTAGEM), visto_ep: visto, ultima_ep: ultima };
      if (n > TETO_CONTAGEM) item.mais = true;
      saida[a.slug] = item;
    }
    if (mudou) grava(novo);
    for (const slug of Object.keys(saida)) saida[slug].marcada_nao_lida = temMarca(usuario, slug);
    return saida;
  }

  /** Liga (ligada=true) ou desliga a marca manual. Devolve true se algo mudou. */
  function marcarNaoLida(usuario, slug, ligada) {
    carrega();
    if (temMarca(usuario, slug) === ligada) return false;
    const c = copiaMarcas();
    if (ligada) {
      if (!Object.hasOwn(c, usuario)) c[usuario] = vazio();
      c[usuario][slug] = true;
    } else {
      delete c[usuario][slug];
      if (!Object.keys(c[usuario]).length) delete c[usuario];
    }
    grava(estado, c);
    return true;
  }

  /** Avança o marco (nunca recua). `abriu` = a pessoa abriu a conversa agora: só isso limpa a marca manual
   *  (o "lido" automático da rolagem não limpa, senão desfaria a marca na hora). Devolve o visto_ep guardado. */
  function marcar(usuario, agente, ep, opcoes) {
    const abriu = !!(opcoes && opcoes.abriu);
    if (ep === null || ep === undefined) {
      // Abrir uma conversa sem mensagens: não há marco para avançar, só a marca para limpar.
      carrega();
      if (abriu) marcarNaoLida(usuario, agente, false);
      const meus0 = Object.hasOwn(estado, usuario) ? estado[usuario] : vazio();
      return Object.hasOwn(meus0, agente) ? meus0[agente] : null;
    }
    const limite = agora() / 1000 + 300;
    if (ep > limite) {
      const e = new Error(`O "ep" ${ep} está no futuro. Ele é em SEGUNDOS desde 1970 (não milissegundos): mande o ep da última mensagem que apareceu na tela.`);
      e.status = 400; throw e;
    }
    carrega();
    const meus = Object.hasOwn(estado, usuario) ? estado[usuario] : vazio();
    const atual = Object.hasOwn(meus, agente) ? meus[agente] : null;
    const novo = atual === null ? ep : Math.max(atual, ep);
    if (novo !== atual) {
      const c = copia(estado);
      if (!Object.hasOwn(c, usuario)) c[usuario] = vazio();
      c[usuario][agente] = novo;
      grava(c);
    }
    if (abriu) marcarNaoLida(usuario, agente, false);
    return novo;
  }

  return { contar, marcar, marcarNaoLida, temMarca: (usuario, slug) => { carrega(); return temMarca(usuario, slug); } };
}

module.exports = { criarNaoLidas, TETO_CONTAGEM };
