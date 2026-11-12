'use strict';
// Server-Sent Events: stream da conversa de um agente (eventos ola, msgs, atividade).

const TICK_MS = 700;
const PING_MS = 15000;
const DURACAO_MS = 50 * 60 * 1000;

function sse(res, evento, dados, id) {
  let s = `event: ${evento}\n`;
  if (id != null) s += `id: ${id}\n`;
  s += `data: ${JSON.stringify(dados)}\n\n`;
  res.write(s);
}

function chaveAtividade(a) {
  return [a.estado, a.acao, a.alerta, a.desde, a.detalhe].join('|');
}

/**
 * Abre o stream. `fontes` = { thread(agente), atividade(agente), versaoJs, foco?(agente) }.
 * `foco` é opcional: devolve a lista do modo foco; o evento `foco` sai no primeiro tique e
 * quando `lista.versao` muda. Se a fonte lançar, sai {agente, lista:null, erro} e o stream segue.
 * Cada conexão tem o seu relógio; o custo de cada tique é um stat do arquivo e um
 * cache de 2 s do runner, então não precisa de vigia compartilhado.
 */
function abrirStream({ req, res, agente, since, fontes, log, tickMs, valeAinda }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let ultimoId = since;
  const visto = new Map();
  let versaoVista = -1;
  let chaveAtiv = null;
  let versaoFoco = null;
  let erroFoco = null;
  let ultimoEnvio = Date.now();
  let ocupado = false;
  let fechado = false;
  const fim = Date.now() + DURACAO_MS;

  const encerra = () => {
    if (fechado) return;
    fechado = true;
    clearInterval(timer);
    try { res.end(); } catch (_) { /* conexão já caiu */ }
  };

  // Sessão que deixou de valer: avisa a tela e fecha, antes de qualquer outra mensagem sair.
  const sessaoCaiu = () => {
    if (!valeAinda || valeAinda()) return false;
    log('aviso', `Stream de ${agente.slug} fechado: a sessão de quem ouvia deixou de valer (expirou, saiu ou perdeu o acesso).`);
    try { sse(res, 'sessao_encerrada', { motivo: 'Sua sessão não vale mais. Entre de novo.' }); } catch (_) { /* conexão já caiu */ }
    encerra();
    return true;
  };

  async function tique(primeiro) {
    if (fechado || ocupado) return;
    ocupado = true;
    try {
      if (sessaoCaiu()) return;
      const t = await fontes.thread(agente);
      if (sessaoCaiu()) return;
      if (t.versao !== versaoVista || primeiro) {
        const atuais = t.msgs;
        const ids = new Set(atuais.map((m) => m.id));
        let novas; let sumidas = [];
        if (primeiro) {
          novas = atuais.filter((m) => m.ep > since);
        } else {
          novas = atuais.filter((m) => visto.get(m.id) !== JSON.stringify(m));
          sumidas = [...visto.keys()].filter((id) => !ids.has(id));
        }
        visto.clear(); atuais.forEach(m => visto.set(m.id, JSON.stringify(m)));
        versaoVista = t.versao;
        if (novas.length) ultimoId = novas.reduce((a, m) => Math.max(a, m.ep), ultimoId);
        if (primeiro || novas.length || sumidas.length) {
          sse(res, 'msgs', { novas, sumidas, avisos: t.avisos }, ultimoId);
          ultimoEnvio = Date.now();
        }
      }
      const ativ = await fontes.atividade(agente);
      if (sessaoCaiu()) return;
      const k = chaveAtividade(ativ);
      if (k !== chaveAtiv) {
        chaveAtiv = k;
        sse(res, 'atividade', { agentes: { [agente.slug]: ativ }, agora: Date.now() / 1000 });
        ultimoEnvio = Date.now();
      }
      if (fontes.foco) {
        try {
          const l = await fontes.foco(agente);
          erroFoco = null;
          if (l.versao !== versaoFoco) {
            versaoFoco = l.versao;
            sse(res, 'foco', { agente: agente.slug, lista: l });
            ultimoEnvio = Date.now();
          }
        } catch (e) {
          if (e.message !== erroFoco) {
            erroFoco = e.message; versaoFoco = null;
            log('aviso', `Stream de ${agente.slug}: não consegui ler a lista de foco (${e.message}).`);
            sse(res, 'foco', { agente: agente.slug, lista: null, erro: e.message });
            ultimoEnvio = Date.now();
          }
        }
      }
      if (Date.now() - ultimoEnvio >= PING_MS) {
        res.write(': ping\n\n');
        ultimoEnvio = Date.now();
      }
      if (Date.now() >= fim) encerra();
    } catch (e) {
      log('erro', `Stream de ${agente.slug}: falha ao atualizar (${e.message}). A tela reconecta sozinha.`);
      encerra();
    } finally {
      ocupado = false;
    }
  }

  const timer = setInterval(() => { tique(false); }, tickMs || TICK_MS);
  res.on('close', encerra);
  res.on('error', encerra);

  sse(res, 'ola', { agora: Date.now() / 1000, agente: agente.slug, versao_js: fontes.versaoJs() });
  tique(true);
  return encerra;
}

module.exports = { abrirStream, sse };
