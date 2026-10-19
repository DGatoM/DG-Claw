'use strict';
// Vigia de atenção: olha o estado de cada agente a cada 5 s e manda aviso ao aparelho nas TRANSIÇÕES:
//   * entrou em "precisa de você"  -> "<Nome> precisa de você" (corpo = o resumo seguro do estado)
//   * trabalhava e ficou ocioso, com resposta nova do agente -> "<Nome> terminou" (corpo genérico, nunca o texto da resposta)
//
// Regras que mantêm o aviso útil em vez de chato:
//   * a primeira leitura de cada agente só grava o estado: reiniciar o Web nunca dispara nada;
//   * sem sinal do runner não é transição: vale o último estado que eu soube de fato;
//   * não avisa de uma conversa que a pessoa está olhando agora (o chat manda "vendo" a cada 20 s; < 45 s = olhando);
//   * no máximo 1 aviso por agente e por tipo a cada 60 s;
//   * respeita as preferências (precisa_de_voce / terminou).
// Não há botão de aprovar ou negar no aviso: aprovar uma permissão exige abrir a conversa já autenticada.
// O relógio e o intervalo são injetados para os testes andarem no tempo sem esperar.


const INTERVALO_MS = 5000;
const VISTO_RECENTE_MS = 45000;
const ANTI_SPAM_MS = 60000;
const FOLGA_RESPOSTA_MS = 2000;
const ESPERA_THREAD_MS = 3000;

// O corpo do "terminou" é sempre genérico (revisão adversarial do PR #58): a tela bloqueada do celular
// não pede login, e o mascarador só reconhece formatos conhecidos de chave, não uma senha ou um dado
// pessoal escrito em texto comum. O conteúdo fica na conversa, atrás da senha do painel.
const CORPO_TERMINOU = 'Respondeu na conversa';

function criarVigiaAtencao({ registro, estados, lerThread, push, prefs, relogio, log, intervaloMs }) {
  const agora = relogio || Date.now;
  const porAgente = new Map(); // slug -> { conhecido, trabalhouDesde, envio: { tipo: ms } }
  const vistos = new Map(); // slug -> ms do último "vendo"
  let timer = null;
  let emCurso = false;

  /** Chamado pelo POST /agents/<slug>/vendo. */
  function vendo(slug) { vistos.set(slug, agora()); }
  const olhando = (slug) => vistos.has(slug) && agora() - vistos.get(slug) < VISTO_RECENTE_MS;

  async function respostaNova(agente, desdeMs) {
    let espera;
    const limite = new Promise((resolve) => { espera = setTimeout(() => resolve(null), ESPERA_THREAD_MS); });
    try {
      const t = await Promise.race([Promise.resolve().then(() => lerThread(agente)), limite]);
      if (!t || !Array.isArray(t.msgs)) {
        log('aviso', `Aviso "terminou" de ${agente.nome}: a conversa não respondeu em ${ESPERA_THREAD_MS / 1000} s, então não sei se há resposta nova e não avisei.`);
        return null;
      }
      for (let i = t.msgs.length - 1; i >= 0; i -= 1) {
        const m = t.msgs[i];
        if (m.origin === 'agente' && !m.sistema && Number.isFinite(m.ep) && m.ep * 1000 >= desdeMs - FOLGA_RESPOSTA_MS) return m;
      }
      return null;
    } catch (e) {
      log('aviso', `Aviso "terminou" de ${agente.nome}: não consegui ler a conversa (${e.message}), então não avisei.`);
      return null;
    } finally { clearTimeout(espera); }
  }

  async function enviar(agente, tipo, aviso) {
    const mem = porAgente.get(agente.slug);
    if (!prefs.alguemQuer(tipo)) return;
    if (olhando(agente.slug)) return;
    const ultimo = mem.envio[tipo];
    if (ultimo !== undefined && agora() - ultimo < ANTI_SPAM_MS) return;
    mem.envio[tipo] = agora();
    try {
      const r = await push.enviar(aviso);
      if (!r.inscricoes) log('info', `Aviso "${tipo}" de ${agente.nome}: nenhum aparelho com avisos ativados. Ative em "Ativar avisos neste aparelho", no menu.`);
      else if (r.falhas && r.falhas.length) log('aviso', `Aviso "${tipo}" de ${agente.nome}: ${r.falhas.length} falha(s) ao entregar: ${r.falhas[0].motivo || 'sem motivo'}.`);
    } catch (e) {
      log('erro', `Aviso "${tipo}" de ${agente.nome} não saiu (${e.message}). Confira a tela de avisos do aparelho e o arquivo push/vapid.json na pasta de dados.`);
    }
  }

  async function olha(agente, base) {
    let mem = porAgente.get(agente.slug);
    if (!mem) { mem = { conhecido: null, trabalhouDesde: null, envio: {} }; porAgente.set(agente.slug, mem); }
    if (base.estado === 'sem_sinal') return;
    const anterior = mem.conhecido;
    mem.conhecido = base.estado;
    if (anterior === null) { // primeira leitura: só grava (e já marca o início do trabalho, se for o caso)
      if (base.estado !== 'ocioso') mem.trabalhouDesde = agora();
      return;
    }
    if (base.estado === 'trabalhando' || base.estado === 'precisa_de_voce') {
      if (mem.trabalhouDesde === null) mem.trabalhouDesde = agora();
    }
    if (base.estado === 'precisa_de_voce' && anterior !== 'precisa_de_voce') {
      await enviar(agente, 'precisa_de_voce', {
        titulo: `${agente.nome} precisa de você`,
        corpo: base.resumo || 'Abra a conversa para ver o que ele pede.',
        tag: `atencao-${agente.slug}`,
        url: `/a/${agente.slug}`,
        exigir_interacao: true,
      });
    } else if (base.estado === 'ocioso' && mem.trabalhouDesde !== null) {
      const desde = mem.trabalhouDesde;
      mem.trabalhouDesde = null;
      const resposta = await respostaNova(agente, desde);
      if (!resposta) return;
      await enviar(agente, 'terminou', {
        titulo: `${agente.nome} terminou`,
        corpo: CORPO_TERMINOU,
        tag: `fim-${agente.slug}`,
        url: `/a/${agente.slug}`,
      });
    }
  }

  async function tick() {
    if (emCurso) return;
    emCurso = true;
    try {
      const est = registro.estado();
      if (!est.ok) return;
      const bases = await Promise.all(est.agentes.map(async (a) => [a, await estados.doRunner(a)]));
      for (const [a, base] of bases) {
        try { await olha(a, base); } catch (e) {
          log('erro', `Vigia de atenção: falha inesperada ao olhar ${a.nome} (${e.message}). Os outros agentes seguem sendo vigiados.`);
        }
      }
    } finally { emCurso = false; }
  }

  function iniciar() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log('erro', `Vigia de atenção: ${e.message}`)); }, intervaloMs || INTERVALO_MS);
    timer.unref();
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, iniciar, parar, vendo };
}

module.exports = { criarVigiaAtencao, CORPO_TERMINOU, INTERVALO_MS, VISTO_RECENTE_MS, ANTI_SPAM_MS };
