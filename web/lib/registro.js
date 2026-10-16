'use strict';
// Registro de agentes: lê o agentes.json e o relê quando o arquivo muda (mtime/tamanho).

const fs = require('node:fs');

const RX_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

function textoOuNull(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/** Valida e normaliza um agente. Devolve { agente } ou { erro }. */
function normaliza(bruto, indice) {
  if (!bruto || typeof bruto !== 'object') return { erro: `o item ${indice} da lista não é um objeto` };
  const slug = typeof bruto.slug === 'string' ? bruto.slug : '';
  if (!RX_SLUG.test(slug)) {
    return { erro: `o item ${indice} tem slug ${JSON.stringify(bruto.slug)}, que não vale (use minúsculas, números e hífen, até 32 caracteres, começando por letra ou número)` };
  }
  const runner = textoOuNull(bruto.runner);
  if (!runner || !/^https?:\/\//i.test(runner)) return { erro: `o agente ${slug} precisa de "runner" com a URL do runner (ex.: http://127.0.0.1:4300)` };
  const agenteId = textoOuNull(bruto.agente_id);
  if (!agenteId) return { erro: `o agente ${slug} precisa de "agente_id" (o id que o runner conhece)` };
  const porta = bruto.porta_painel == null ? null : Number(bruto.porta_painel);
  if (porta !== null && !(Number.isInteger(porta) && porta > 0 && porta < 65536)) {
    return { erro: `o agente ${slug} tem porta_painel ${JSON.stringify(bruto.porta_painel)}, que não é uma porta válida (ou deixe null)` };
  }
  const tipo = textoOuNull(bruto.tipo) || (slug === 'admin' ? 'admin' : 'agente');
  return {
    agente: {
      slug,
      nome: textoOuNull(bruto.nome) || slug,
      tipo,
      subtitulo: typeof bruto.subtitulo === 'string' ? bruto.subtitulo : '',
      runner: runner.replace(/\/+$/, ''),
      agente_id: agenteId,
      chat_id: textoOuNull(bruto.chat_id) || `c_${slug}`,
      avatar: textoOuNull(bruto.avatar) || '',
      cor: textoOuNull(bruto.cor) || '#4A5D78',
      provedor: textoOuNull(bruto.provedor) || '',
      modelo: textoOuNull(bruto.modelo) || '',
      voz: textoOuNull(bruto.voz),
      transcripts_dir: textoOuNull(bruto.transcripts_dir),
      porta_painel: porta,
      proxy_segredo_arquivo: textoOuNull(bruto.proxy_segredo_arquivo),
      runner_token_arquivo: textoOuNull(bruto.runner_token_arquivo) || textoOuNull(bruto.tokenArquivo),
      home_host: textoOuNull(bruto.home_host),
      home_container: textoOuNull(bruto.home_container) || textoOuNull(bruto.home_host),
      cofre_arquivo: textoOuNull(bruto.cofre_arquivo),
      container: textoOuNull(bruto.container),
      dono: textoOuNull(bruto.dono),
    },
  };
}

function criarRegistro({ caminho, log }) {
  let assinatura = null;       // "mtimeMs:size" ou "ausente"
  let estado = { ok: false, erro: 'o registro ainda não foi lido', agentes: [] };
  let ultimoErroLogado = null;

  function falha(motivo) {
    estado = { ok: false, erro: motivo, agentes: [] };
    if (ultimoErroLogado !== motivo) {
      ultimoErroLogado = motivo;
      log('erro', motivo);
    }
  }

  function recarrega() {
    let st;
    try {
      st = fs.statSync(caminho);
    } catch (e) {
      assinatura = 'ausente';
      falha(`Não achei o registro de agentes em ${caminho} (${e.code || e.name}). Rode o instalador do DG Claw para criá-lo ou aponte DGCLAW_AGENTES para o arquivo certo.`);
      return;
    }
    const nova = `${st.mtimeMs}:${st.size}`;
    if (nova === assinatura) return;
    assinatura = nova;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    } catch (e) {
      falha(`O registro de agentes ${caminho} não pôde ser lido como JSON (${e.message}). Corrija o arquivo; o Web o relê sozinho quando ele mudar.`);
      return;
    }
    if (!json || !Array.isArray(json.agentes)) {
      falha(`O registro de agentes ${caminho} precisa ter o formato {"versao":1,"agentes":[...]}. Recebi outra estrutura.`);
      return;
    }
    const vistos = new Set();
    const agentes = [];
    json.agentes.forEach((bruto, i) => {
      const r = normaliza(bruto, i);
      if (r.erro) { log('aviso', `Registro ${caminho}: ignorei um agente porque ${r.erro}.`); return; }
      if (vistos.has(r.agente.slug)) { log('aviso', `Registro ${caminho}: o slug ${r.agente.slug} aparece mais de uma vez; mantive o primeiro.`); return; }
      vistos.add(r.agente.slug);
      agentes.push(r.agente);
    });
    if (!agentes.length) {
      falha(`O registro de agentes ${caminho} não tem nenhum agente válido. Confira os avisos acima no log e o formato do arquivo.`);
      return;
    }
    // Admin primeiro; o resto na ordem do arquivo.
    agentes.sort((a, b) => (b.tipo === 'admin') - (a.tipo === 'admin'));
    estado = { ok: true, erro: null, agentes };
    ultimoErroLogado = null;
    log('info', `Registro de agentes carregado de ${caminho}: ${agentes.map((a) => a.slug).join(', ')}.`);
  }

  return {
    /** { ok, erro, agentes } já atualizado se o arquivo mudou. */
    estado() { recarrega(); return estado; },
    obter(slug) { recarrega(); return estado.ok ? estado.agentes.find((a) => a.slug === slug) || null : null; },
  };
}

module.exports = { criarRegistro, normaliza, RX_SLUG };
