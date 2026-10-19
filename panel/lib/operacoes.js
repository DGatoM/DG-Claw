'use strict';
/**
 * operacoes.js: a aba Operações, com uma fileira de quadradinhos por operação.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POR QUE ESTE ARQUIVO EXISTE (01/10/2026)                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * O painel tinha duas abas para a mesma pergunta: "Operações" (o que está
 * marcado) e "Pulso" (se rodou certo). Quem mandou construir as
 * duas não sabia dizer a diferença. Agora é uma aba só, desenhada como uma
 * página de status: cada operação aparece UMA vez, com o nome, a cadência e uma
 * fileira de quadradinhos das últimas execuções. Verde rodou e deu certo,
 * vermelho falhou, amarelo pede atenção (não rodou quando devia, foi cancelada,
 * ou o registro dela disse que algo saiu torto), cinza é sem dado.
 *
 * DE ONDE VEM CADA QUADRADINHO. Do diário do systemd (o journal), que guarda
 * uma linha por fim de execução de cada unidade, com o resultado. É a única fonte
 * que cobre TODAS as rotinas: o ledger do pulso só tem o que cada script decidiu
 * anotar, e várias rotinas (vigia, arrumação da conversa, recibo dos recados,
 * aviso de orçamento, medidor de consumo) não anotam nada lá.
 *
 *   MESSAGE_ID 39f53479...  "Finished X"       JOB_RESULT=done   rodou e terminou bem
 *   MESSAGE_ID be02cf68...  "Failed to start X" JOB_RESULT=failed falhou
 *   MESSAGE_ID 7d4958e8...  "Starting X"        começo da execução (para medir a duração)
 *   MESSAGE_ID 9d1aaa27...  "Stopped X"         serviço contínuo parou
 *   MESSAGE_ID d9b373ed...  "X: Failed with result ..."  serviço contínuo caiu
 *
 * ARMADILHA QUE CUSTOU UMA FALHA INVISÍVEL: a primeira validação desta fonte
 * pedia só o 39f53479. Execução que FALHA não sai com esse id, sai com o
 * be02cf68. Filtrando só o primeiro, toda falha some e a fileira fica verde com a
 * rotina quebrada, que é exatamente o tipo de alarme que esta tela existe para
 * não ser. Conferido no diário desta máquina em 01/10/2026: os "Failed to start"
 * de uma rotina marcada vinham todos com o be02cf68.
 *
 * O LEDGER ENTRA COMO SEGUNDA OPINIÃO. Um script pode terminar com código 0 e
 * mesmo assim ter anotado `erro` no ledger (ele pegou a exceção, registrou e saiu
 * "limpo"). Para o systemd foi sucesso; para quem lê, falhou. Então, se o job
 * terminou bem mas o ledger diz erro naquele intervalo, o quadradinho é VERMELHO
 * com o detalhe do ledger. Se diz aviso, é amarelo.
 *
 * AMARELO DE "NÃO RODOU QUANDO DEVIA" é inferido da cadência do timer:
 *   - timer de intervalo ("a cada 30 min"): um buraco maior que duas vezes o
 *     intervalo entre duas execuções vira um quadradinho amarelo no meio;
 *   - timer de calendário que eu entendo ("todo dia às 23:30", "de segunda a
 *     sexta às 9h"): cada horário esperado sem execução por perto vira amarelo.
 *   Horário de calendário que eu não entendo NÃO gera amarelo nenhum: inventar
 *   atraso de uma rotina cujo horário eu não sei ler seria acusar sem prova.
 *   Também não acuso nada antes da primeira execução que o diário conhece: o
 *   diário pode ter sido rodado, e a rotina pode ter sido instalada ontem.
 *
 * NULL NUNCA VIRA VERDE. Sem diário (sem permissão, sem journalctl), a operação
 * aparece com a fileira cinza e o motivo escrito, e o resumo do topo diz que não
 * conseguiu ler, em vez de "tudo funcionando".
 *
 * As rotinas MARCADAS PELO DONO (dgclaw-<slug>-self-*) ficam FORA da lista do
 * sistema: elas são do usuário e aparecem na aba Status (ver `rotinasDoUsuario`).
 *
 * O "o que é / pra que serve" de cada operação NÃO mora aqui: vem do CATALOGO do
 * scripts/pulso-status.py, através do /api/pulso (lib/pulso.js). Este arquivo só
 * decide o AGRUPAMENTO por propósito, que é coisa desta tela.
 *
 * O journalctl de sete dias leva perto de meio segundo e devolve milhares de
 * linhas, então o resultado fica em cache por 45 s e chamadas simultâneas
 * dividem a mesma leitura.
 */

const path = require('path');
const rotinasLib = require('./rotinas');
const { ID, CACHE_MS, DIAS, GRUPOS, GRUPO_PODERES, GRUPO_OUTRAS } = require('./operacoes-constantes');
const { duracaoMs, horariosEsperados, intervaloDoTimer, haQuanto, listaHumana, corDoLedger } = require('./operacoes-tempo');
const { executarPadrao, lerDiario, lerLedger, quadradosDeRotina, quadradosDeServico } = require('./operacoes-quadrados');

function buildOperacoes(config, deps = {}) {
  const SLUG = config.agentSlug || 'agente';
  const AGENT_DIR = config.agentDir;
  const PULSO_DIR = config.pulsoDir || path.join(AGENT_DIR, '.dgclaw', 'logs', 'pulso');
  const executar = deps.executar || executarPadrao;
  const listarRotinas = deps.listarRotinas || (() => rotinasLib.listar(SLUG, AGENT_DIR));
  const pulsoStatus = deps.pulsoStatus || (async () => null);
  const servicoDoCanal = deps.servicoDoCanal || (() => '');
  const relogio = deps.agora || (() => Date.now());

  const PREFIXO = `dgclaw-${SLUG}-`;
  const PREFIXO_SELF = `dgclaw-${SLUG}-self-`;

  /** Estado agora de um serviço contínuo (ativo? desde quando?). Nunca lança. */
  async function estadoDoServico(unit) {
    const r = await executar('systemctl', ['show', unit, '--no-pager', '-p', 'ActiveState,ActiveEnterTimestamp,LoadState,Description'], { timeout: 6000 });
    if (!r.ok && !r.stdout) return { ativo: null, desde: null, existe: null };
    const mapa = {};
    for (const l of r.stdout.split('\n')) {
      const k = l.indexOf('=');
      if (k > 0) mapa[l.slice(0, k)] = l.slice(k + 1);
    }
    if (mapa.LoadState === 'not-found') return { ativo: null, desde: null, existe: false };
    const desde = Date.parse((mapa.ActiveEnterTimestamp || '').replace(/^[A-Z][a-z]{2}\s+/, '').replace(/ (-?\d{2})$/, ' $100'));
    return {
      ativo: mapa.ActiveState ? mapa.ActiveState === 'active' : null,
      desde: Number.isFinite(desde) && desde > 0 ? desde : null,
      existe: true,
      estado: mapa.ActiveState || '',
      descricao: mapa.Description || '',
    };
  }

  /** O nome que a tela mostra: o "o que é" do catálogo sem o ponto final; senão a descrição do systemd. */
  function nomeAmigavel(oQueE, descricao, chave) {
    if (oQueE) return oQueE.replace(/\.\s*$/, '');
    if (descricao) {
      const d = descricao.replace(/^DG Claw\s+/i, '').replace(/\s*\(timer\)/i, '').replace(new RegExp(`:\\s*${SLUG}\\s*$`), '').trim();
      if (d) return d.charAt(0).toUpperCase() + d.slice(1);
    }
    return chave;
  }

  function grupoDe(chave, grupoPulso) {
    for (const g of GRUPOS) if (g.membros.includes(chave)) return g;
    if (grupoPulso && !['runtime', 'vida', 'outro'].includes(grupoPulso)) return GRUPO_PODERES;
    return GRUPO_OUTRAS;
  }

  let _cache = null; // { em, promessa }

  async function calcular() {
    const agora = relogio();
    const desde = agora - DIAS * 86400000;

    let rot = { rotinas: [], erro: null };
    try { rot = (await listarRotinas()) || rot; } catch (e) {
      rot = { rotinas: [], erro: `não consegui ler as rotinas no systemd: ${e.message}` };
    }
    let pul = null;
    try { pul = await pulsoStatus(); } catch (e) {
      console.warn(`[operacoes] o pulso-status nao respondeu (${e.message}). Sigo sem o catalogo de explicacoes.`);
    }
    const processos = (pul && Array.isArray(pul.processos)) ? pul.processos : [];
    const porUnit = new Map();
    for (const p of processos) if (p.unit) porUnit.set(p.unit, p);

    // ── a lista de operações do SISTEMA ──
    const ops = [];
    const vistas = new Set();
    const adicionar = (o) => { if (!vistas.has(o.unit)) { vistas.add(o.unit); ops.push(o); } };

    // Serviços contínuos que o pulso conhece (o agente em si e o painel).
    for (const p of processos) {
      if (p.kind !== 'servico' || !p.unit) continue;
      if (p.unit.startsWith(PREFIXO_SELF)) continue;
      adicionar({ tipo: 'servico', unit: p.unit, chave: p.nome, proc: p });
    }
    // Sem pulso, ainda assim o agente e o painel entram, pelo nome conhecido.
    if (!processos.length) {
      const canal = servicoDoCanal() || `dgclaw-${SLUG}.service`;
      adicionar({ tipo: 'servico', unit: canal, chave: 'canal (runtime)', proc: null });
      adicionar({ tipo: 'servico', unit: `dgclaw-panel-${SLUG}.service`, chave: 'painel', proc: null });
    }
    // Rotinas (timers) do sistema: as do systemd, com o catálogo do pulso por cima.
    for (const r of (rot.rotinas || [])) {
      if (r.tipo !== 'vida') continue;
      const chave = r.unit.replace(/\.timer$/, '').slice(PREFIXO.length);
      adicionar({ tipo: 'rotina', unit: r.unit, chave, rotina: r, proc: porUnit.get(r.unit) || null });
    }
    // Timers de poderes que o pulso conhece e que não seguem o prefixo do agente.
    for (const p of processos) {
      if (p.kind !== 'timer' || !p.unit || vistas.has(p.unit) || p.unit.startsWith(PREFIXO_SELF)) continue;
      const chave = p.unit.replace(/\.timer$/, '').replace(PREFIXO, '');
      adicionar({ tipo: 'rotina', unit: p.unit, chave, rotina: null, proc: p });
    }

    // ── as rotinas do USUÁRIO (marcadas por ele, via agente) ──
    const doUsuario = (rot.rotinas || []).filter((r) => r.tipo === 'marcada');

    // ── uma leitura só do diário, para tudo ──
    const servicos = new Set();
    for (const o of ops) servicos.add(o.tipo === 'rotina' ? o.unit.replace(/\.timer$/, '.service') : o.unit);
    for (const r of doUsuario) servicos.add(r.unit.replace(/\.timer$/, '.service'));
    const diario = servicos.size
      ? await lerDiario(executar, [`${PREFIXO}*.service`, ...[...servicos].filter((u) => !u.startsWith(PREFIXO))], desde)
      : { eventos: [], motivo: null };
    const porServico = new Map();
    for (const e of diario.eventos) {
      if (!porServico.has(e.unit)) porServico.set(e.unit, []);
      porServico.get(e.unit).push(e);
    }
    const ledger = lerLedger(PULSO_DIR, desde);

    // ── monta cada operação ──
    const montarRotina = (unit, chave, r, proc) => {
      const svc = unit.replace(/\.timer$/, '.service');
      const ativo = r ? !!r.ativo : (proc ? proc.resumo !== 'sem-sinal' : null);
      const horario = r ? r.horario : '';
      const ultimaAntes = r && r.ultima ? Date.parse(r.ultima) : null;
      let q = { quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 }, ultimaExecucao: null };
      if (!diario.motivo) {
        q = quadradosDeRotina({ eventos: porServico.get(svc) || [], ledger, chave, horario, desde, agora, ativo, ultimaAntes });
      }
      return { svc, ativo, q };
    };

    const resultado = [];
    for (const o of ops) {
      const proc = o.proc;
      const oQueE = proc ? proc.oQueE || '' : '';
      const praQueServe = proc ? proc.praQueServe || '' : '';
      const g = grupoDe(o.chave, proc && proc.grupo);
      const base = {
        id: o.unit.replace(/\.(timer|service)$/, ''),
        unit: o.unit,
        chave: o.chave,
        grupo: g.id,
        nome: nomeAmigavel(oQueE, o.rotina ? o.rotina.descricao : '', o.chave),
        oQueE, praQueServe,
        crit: proc ? proc.crit || null : (o.chave === 'canal (runtime)' ? 'alta' : null),
        tipo: o.tipo,
      };
      if (o.tipo === 'servico') {
        const st = await estadoDoServico(o.unit);
        // Sem catálogo (pulso-status antigo instalado no agente), o nome vem da
        // descrição que o systemd tem da unidade, que é melhor que o id cru.
        if (!oQueE && st.descricao) base.nome = nomeAmigavel('', st.descricao, o.chave);
        const q = diario.motivo
          ? { quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 } }
          : quadradosDeServico({ eventos: porServico.get(o.unit) || [], agora, ativoAgora: st.ativo, ativoDesde: st.desde });
        let estado;
        let frase;
        if (st.existe === false) {
          estado = 'atencao';
          frase = `o sistema não conhece a unidade "${o.unit}": ou ela nunca foi instalada, ou tem outro nome`;
        } else if (st.ativo === true) {
          const ult = q.quadrados[q.quadrados.length - 1];
          estado = ult && ult.cor === 'vermelho' ? 'falha' : (ult && ult.cor === 'amarelo' ? 'atencao' : 'ok');
          frase = st.desde ? `de pé desde ${new Date(st.desde).toISOString()}` : 'de pé';
          if (estado !== 'ok') frase = `de pé agora, mas ${ult.titulo.toLowerCase()}`;
        } else if (st.ativo === false) {
          estado = 'falha';
          frase = `parado agora (o sistema diz "${st.estado || 'inativo'}")`;
        } else {
          estado = 'sem-dado';
          frase = 'não consegui perguntar ao sistema como ele está';
        }
        resultado.push({ ...base, cadencia: 'fica de pé o tempo todo', ativoDesde: st.desde ? new Date(st.desde).toISOString() : null,
          proxima: null, ultima: null, estado, frase, quadrados: q.quadrados, semana: q.semana, porHora: true });
        continue;
      }
      const r = o.rotina;
      // Timer que só o pulso conhece (de poder, ou que o systemd não listou): antes
      // de qualquer cor, conferir se ele existe. "Não existe" e "está desligado" são
      // problemas diferentes, e a frase precisa dizer qual dos dois é.
      if (!r) {
        const st = await estadoDoServico(o.unit);
        if (st.existe === false) {
          resultado.push({ ...base, cadencia: (proc && proc.cadencia) || '', proxima: null, ultima: null,
            estado: 'atencao', frase: `o sistema não conhece a rotina "${o.unit}": ela não foi instalada, então não roda`,
            quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 } });
          continue;
        }
        if (!oQueE && st.descricao) base.nome = nomeAmigavel('', st.descricao, o.chave);
      }
      const { ativo, q } = montarRotina(o.unit, o.chave, r, proc);
      const cadencia = (r && r.quando) || (proc && proc.cadencia) || '';
      let estado;
      let frase;
      const ult = q.quadrados[q.quadrados.length - 1];
      if (ativo === false) {
        estado = 'atencao';
        frase = 'o horário dela está desligado no sistema, então ela não vai rodar sozinha';
      } else if (diario.motivo) {
        estado = 'sem-dado';
        frase = 'sem histórico: não consegui ler o diário do sistema';
      } else if (!ult) {
        estado = 'sem-dado';
        // O diário pode vir vazio mesmo com a rotina rodando (o sistema tem a data da
        // última vez, mas não guardou o histórico). Dizer "não rodou nos últimos 7 dias"
        // ao lado de "a última vez foi há 3 min" é uma frase falsa, e ainda pintava a
        // operação de amarelo (vistoria de 08/10/2026). Última vez recente e sem
        // histórico é "sem dado", dito como tal; só vira atenção se a última vez for
        // mais velha que a janela.
        const ultimaMs = r && r.ultima ? Date.parse(r.ultima) : NaN;
        if (Number.isFinite(ultimaMs) && agora - ultimaMs <= DIAS * 86400000) {
          frase = `sem histórico para mostrar (a última vez que rodou foi ${haQuanto(ultimaMs, agora)})`;
        } else if (Number.isFinite(ultimaMs)) {
          frase = `não rodou nos últimos ${DIAS} dias (a última vez foi ${haQuanto(ultimaMs, agora)})`;
          estado = 'atencao';
        } else {
          frase = 'ainda não rodou nenhuma vez';
        }
      } else {
        estado = ult.cor === 'verde' ? 'ok' : (ult.cor === 'vermelho' ? 'falha' : 'atencao');
        const quando = q.ultimaExecucao ? haQuanto(q.ultimaExecucao.fim, agora) : '';
        frase = estado === 'ok' ? `rodou ${quando} e deu certo` : ult.titulo;
      }
      resultado.push({
        ...base,
        cadencia,
        proxima: r ? r.proxima : (proc && proc.proxima) || null,
        ultima: q.ultimaExecucao ? new Date(q.ultimaExecucao.fim).toISOString() : (r ? r.ultima : null),
        estado, frase, quadrados: q.quadrados, semana: q.semana,
      });
    }

    // ── os grupos, na ordem da tela ──
    const ordem = [...GRUPOS, GRUPO_PODERES, GRUPO_OUTRAS];
    const grupos = ordem
      .map((g) => ({ id: g.id, titulo: g.titulo, explica: g.explica, operacoes: resultado.filter((o) => o.grupo === g.id) }))
      .filter((g) => g.operacoes.length);

    // ── o resumo do topo ──
    const atencao = resultado.filter((o) => o.estado === 'falha' || o.estado === 'atencao');
    const medidas = resultado.filter((o) => o.estado !== 'sem-dado');
    let resumo;
    if (diario.motivo) {
      resumo = { estado: 'indisponivel', frase: 'Não consegui ler o histórico das operações', motivo: diario.motivo };
    } else if (atencao.length) {
      const nomes = atencao.map((o) => o.nome);
      resumo = {
        estado: 'atencao',
        frase: atencao.length === 1
          ? `1 operação pede atenção: ${nomes[0]}`
          : `${atencao.length} operações pedem atenção: ${listaHumana(nomes)}`,
      };
    } else if (!medidas.length) {
      resumo = { estado: 'sem-dado', frase: 'Ainda não há o que medir: nenhuma operação rodou até agora' };
    } else {
      resumo = { estado: 'ok', frase: 'Tudo funcionando' };
    }
    Object.assign(resumo, {
      total: resultado.length,
      verdes: resultado.filter((o) => o.estado === 'ok').length,
      atencao: atencao.map((o) => o.id),
      semDado: resultado.filter((o) => o.estado === 'sem-dado').length,
    });

    // ── as rotinas do usuário, com a última execução ──
    const usuario = doUsuario.map((r) => {
      const chave = r.unit.replace(/\.timer$/, '').slice(PREFIXO.length);
      const { ativo, q } = montarRotina(r.unit, chave, r, null);
      const ult = q.quadrados[q.quadrados.length - 1] || null;
      return {
        id: r.unit.replace(/\.timer$/, ''),
        unit: r.unit,
        nome: r.nome,
        descricao: r.descricao || '',
        recado: r.recado || null,
        quando: r.quando || r.horario || '',
        proxima: r.proxima || null,
        ultima: q.ultimaExecucao ? new Date(q.ultimaExecucao.fim).toISOString() : (r.ultima || null),
        ativo,
        // null = não medido (sem diário ou nunca rodou). Nunca vira "deu certo".
        ultimoResultado: diario.motivo || !ult ? null : (ult.cor === 'verde' ? 'ok' : (ult.cor === 'vermelho' ? 'falha' : 'atencao')),
        ultimoTitulo: ult ? ult.titulo : null,
        ultimoDetalhe: ult ? ult.detalhe || '' : '',
        quadrados: q.quadrados.slice(-14),
      };
    });

    return {
      geradoEm: new Date(agora).toISOString(),
      janela: { desde: new Date(desde).toISOString(), ate: new Date(agora).toISOString(), dias: DIAS },
      historico: { disponivel: !diario.motivo, motivo: diario.motivo },
      resumo,
      grupos,
      rotinasDoUsuario: usuario,
      inconsistencias: rot.inconsistencias || [],
      erroRotinas: rot.erro || null,
    };
  }

  /**
   * O diagnóstico de saúde vence o "de pé" do agente (vistoria de 08/10/2026).
   *
   * O cartão "O agente em si" mede o PROCESSO, e processo de pé com o login da Anthropic
   * vencido ficava verde, "de pé o tempo todo", ao lado do selo vermelho "Inativo". Quando o
   * diagnóstico (lib/saude.js, o mesmo do /api/saude, com o cache de 20 s dele) diz
   * "inativo", este cartão passa a dizer que o processo está de pé mas ele não responde, e
   * o resumo do topo é refeito. Roda DEPOIS do cache de 45 s do retrato, para o diagnóstico
   * nunca ficar velho, e devolve cópia: o objeto em cache não é alterado.
   */
  async function comDiagnostico(r) {
    if (!deps.diagnostico || !r || !Array.isArray(r.grupos)) return r;
    let d = null;
    try { d = await deps.diagnostico(); } catch (e) {
      console.error('[operacoes] não consegui o diagnóstico de saúde para o cartão do agente:', e.message);
      return r;
    }
    if (!d || d.estado !== 'inativo') return r;
    const canal = servicoDoCanal() || `dgclaw-${SLUG}.service`;
    let achou = false;
    const grupos = r.grupos.map((g) => ({
      ...g,
      operacoes: g.operacoes.map((o) => {
        if (o.tipo !== 'servico' || (o.unit !== canal && o.chave !== 'canal (runtime)')) return o;
        achou = true;
        const frase = `o processo está de pé, mas ele não consegue responder: ${d.frase || 'o diagnóstico de saúde diz que ele está inativo'}`;
        const qs = (o.quadrados || []).slice();
        if (qs.length) qs[qs.length - 1] = { ...qs[qs.length - 1], cor: 'vermelho', titulo: 'De pé, mas sem conseguir responder', detalhe: d.frase || '' };
        return { ...o, estado: 'falha', frase, cadencia: 'o processo está de pé', quadrados: qs, diagnostico: { estado: d.estado, tipo: d.tipo || null } };
      }),
    }));
    if (!achou) return r;
    // Sem diário, o resumo já diz que não leu o histórico: esse aviso é mais grave e fica.
    if (r.resumo && r.resumo.estado === 'indisponivel') return { ...r, grupos };
    const todas = grupos.flatMap((g) => g.operacoes);
    const atencao = todas.filter((o) => o.estado === 'falha' || o.estado === 'atencao');
    const nomes = atencao.map((o) => o.nome);
    const resumo = {
      ...r.resumo,
      estado: 'atencao',
      frase: atencao.length === 1 ? `1 operação pede atenção: ${nomes[0]}` : `${atencao.length} operações pedem atenção: ${listaHumana(nomes)}`,
      verdes: todas.filter((o) => o.estado === 'ok').length,
      atencao: atencao.map((o) => o.id),
    };
    delete resumo.motivo;
    return { ...r, grupos, resumo };
  }

  /** O retrato, com cache curto. `forcar` pula o cache mas nunca abaixo de 5 s. */
  function retrato(opcoes = {}) {
    return retratoEmCache(opcoes).then(comDiagnostico);
  }

  function retratoEmCache({ forcar } = {}) {
    const agora = Date.now();
    if (_cache && (agora - _cache.em < CACHE_MS) && !(forcar && agora - _cache.em > 5000)) return _cache.promessa;
    const promessa = calcular().catch((e) => {
      console.error('[operacoes] falha ao montar a aba Operacoes:', e);
      return {
        geradoEm: new Date().toISOString(),
        historico: { disponivel: false, motivo: `o painel quebrou ao montar esta tela: ${e.message}` },
        resumo: { estado: 'indisponivel', frase: 'Não consegui montar as operações', motivo: e.message, total: 0, verdes: 0, atencao: [], semDado: 0 },
        grupos: [], rotinasDoUsuario: [], inconsistencias: [],
      };
    });
    _cache = { em: agora, promessa };
    return promessa;
  }

  return { retrato };
}

module.exports = {
  buildOperacoes,
  // exportados para o test-operacoes.mjs
  _interno: { duracaoMs, horariosEsperados, intervaloDoTimer, quadradosDeRotina, quadradosDeServico, corDoLedger, ID, GRUPOS },
};

