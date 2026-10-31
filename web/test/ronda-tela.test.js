'use strict';
// Tela Segurança e janela vermelha: funções puras (fora do DOM), escape do texto vindo de fontes externas, níveis,
// sondagem do resultado do pedido e a ligação nas telas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/ronda-comum');
const T = require('../public/seguranca');
const A = require('../public/ronda-aviso');

const pub = (n) => fs.readFileSync(path.join(__dirname, '../public', n), 'utf8');
const AGORA = Date.parse('2026-10-31T16:30:00Z');   // 13h30 em Brasília
const achado = (extra) => Object.assign({
  id: 'UBUNTU-CVE-2026-98432', aliases: [], nivel: 2, severidade: 'HIGH', nome_simples: 'Falha no kernel Linux (rede TCP IPv4)',
  componente: 'kernel Linux', publicado_em: '2026-10-15T12:00:00Z', fonte_url: 'https://ubuntu.com/security/CVE-2026-98432',
  noticia_url: 'https://news.exemplo.org/a?b=1', onde: ['kernel 6.8.0-147 em execução'], o_que_faz: 'Um pacote malformado pode travar o servidor.',
  como_corrigir: 'Aplicar a mitigação do catálogo.', correcao: { tipo: 'acao-catalogo', acao_id: 'x', exige_reinicio: false, disponivel: true, executavel: true },
  estado: 'aberto', aplicado: null,
}, extra || {});
const memoria = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

test('topo: "Última ronda: hoje, 13h02. Próxima: 19h00." e variações de dia', () => {
  const r = { rodada_em: '2026-10-31T16:02:00Z', proxima_em: '2026-10-31T22:00:00Z' };
  assert.equal(R.resumoTopo(r, AGORA), 'Última ronda: hoje, 13h02. Próxima: 19h00.');
  assert.equal(R.resumoTopo({ rodada_em: '2026-10-30T16:02:00Z', proxima_em: '2026-11-02T09:00:00Z' }, AGORA), 'Última ronda: ontem, 13h02. Próxima: 02/11/2026, 06h00.');
  assert.equal(R.resumoTopo({ rodada_em: '2026-10-31T16:02:00Z', proxima_em: '2026-11-01T22:00:00Z' }, AGORA), 'Última ronda: hoje, 13h02. Próxima: amanhã, 19h00.');
  assert.match(R.resumoTopo({ nunca_rodou: true }, AGORA), /ainda não rodou.*sudo dgclaw seguranca rodar/);
  assert.equal(R.dataBr('2026-10-15T12:00:00Z'), '15/10/2026');
  assert.equal(R.dataBr('lixo'), 'data não informada');
});

test('faixa amarela: uma fonte, várias fontes, sem nome; completa não mostra nada', () => {
  assert.equal(R.textoParcial({ parcial: false }), '');
  assert.equal(R.textoParcial({ parcial: true, fontes_fora: ['Ubuntu'] }), 'Ronda parcial: a fonte Ubuntu ficou fora, então este resultado pode estar incompleto.');
  assert.equal(R.textoParcial({ parcial: true, fontes_fora: ['Ubuntu', 'OSV.dev', 'GitHub'] }), 'Ronda parcial: as fontes Ubuntu, OSV.dev e GitHub ficaram fora, então este resultado pode estar incompleto.');
  assert.match(R.textoParcial({ parcial: true, fontes_fora: [] }), /alguma fonte ficou fora/);
});

test('faixa vermelha do vigia e a frase fixa do dia sem novidade', () => {
  assert.equal(R.textoVigia({ vigia_alerta: null }), '');
  assert.match(R.textoVigia({ vigia_alerta: { quando: null, motivo: 'A ronda não rodou às 13h.' } }), /^A ronda automática falhou: A ronda não rodou às 13h\..*sudo dgclaw seguranca rodar/);
  assert.equal(R.FRASE_SEM_NOVIDADE, 'Nenhuma vulnerabilidade nova que afete o seu sistema nesta ronda.');
  assert.equal(R.TEXTO_NIVEL3, 'Nova vulnerabilidade de impacto leve/médio. Sugestão: corrija o quanto antes; a correção já está pronta, é só dar o ok.');
});

test('fatos da falha: data, gravidade em português, onde, o que faz, como corrigir, fonte e notícia com rel seguro', () => {
  const h = R.fatosHtml(achado());
  assert.match(h, /Publicada em<\/dt><dd>15\/10\/2026/);
  assert.match(h, /Gravidade<\/dt><dd>Alta/);
  assert.match(h, /Onde afeta<\/dt><dd>kernel 6\.8\.0-147 em execução/);
  assert.match(h, /O que faz/);
  assert.match(h, /Como corrigir/);
  assert.match(h, /href="https:\/\/ubuntu\.com\/security\/CVE-2026-98432" target="_blank" rel="noopener noreferrer"/);
  assert.match(h, /href="https:\/\/news\.exemplo\.org\/a\?b=1" target="_blank" rel="noopener noreferrer"/);
  assert.ok(!/Notícia/.test(R.fatosHtml(achado({ noticia_url: null }))));
  assert.equal(R.gravidadeRotulo('CRITICAL'), 'Crítica');
  assert.equal(R.gravidadeRotulo('desconhecida'), 'Não informada');
});

test('escape: texto de fonte externa nunca vira HTML, em nenhum card, janela ou lista', () => {
  const ruim = '<img src=x onerror=alert(1)>"\'&';
  const a = achado({ nome_simples: ruim, o_que_faz: ruim, como_corrigir: ruim, onde: [ruim], componente: ruim });
  const saidas = [
    T.cardAcaoHtml(a, AGORA), T.cardSemPressaHtml(achado({ nivel: 3, nome_simples: ruim, o_que_faz: ruim }), AGORA),
    T.cardAplicadoHtml(achado({ nivel: 1, estado: 'aplicado-sozinho', nome_simples: ruim, aplicado: { em: '2026-10-31T10:00:00Z', antes: ruim, depois: ruim, desfazer: true } }), AGORA),
    A.modalHtml(a, 1), T.tratadasHtml([{ id: ruim, componente: ruim, como: ruim }]),
    T.inventarioHtml({ kernel: ruim, componentes: 1, portas_publicas: [{ porta: 22, processo: ruim }], servicos_externos: [{ nome: ruim, via: ruim, versao: ruim }] }),
    T.emergenciaHtml({ disponivel: false, motivo: ruim, estado: { cortado: false } }, { fase: 'ocioso' }),
    T.planoHtml({ comandos: [ruim], avisos: [ruim] }),
  ];
  for (const s of saidas) {
    assert.ok(!s.includes('<img'), s.slice(0, 200));
    assert.ok(s.includes('&lt;img'));
  }
  assert.equal(R.linkHtml('javascript:alert(1)', 'x'), 'javascript:alert(1)');
  assert.ok(!R.linkHtml('javascript:alert(1)').includes('href'));
  assert.ok(!R.linkHtml('https://x.org/"><script>').includes('<script'));
});

test('nível 2: três botões, aviso de reinício e Agendar; sem correção pronta só resta Tirar do ar', () => {
  const h = T.cardAcaoHtml(achado(), AGORA);
  assert.match(h, /data-rp="aplicar"[^>]*>Aplicar correção/);
  assert.match(h, /data-rp="agendar-abre"[^>]*>Agendar/);
  assert.match(h, /data-rp="tirar-do-ar"[^>]*>Tirar do ar/);
  assert.match(h, /pode reiniciar um serviço/);
  assert.match(R.avisoReinicio(achado({ correcao: { tipo: 'apt', exige_reinicio: true, disponivel: true, executavel: false } })), /reinicia um serviço por alguns segundos/);
  const apt = T.cardAcaoHtml(achado({ correcao: { tipo: 'apt', exige_reinicio: true, disponivel: true, executavel: false } }), AGORA);
  assert.match(apt, /data-rp="pedir-admin"[^>]*>Pedir ao Admin/);
  assert.ok(!/data-rp="aplicar"/.test(apt) && !/data-rp="agendar-abre"/.test(apt), 'sem ação do catálogo não há Aplicar nem Agendar');
  assert.match(apt, /data-rp="tirar-do-ar"/);
  const sem = T.cardAcaoHtml(achado({ correcao: { tipo: 'nenhuma', disponivel: false } }), AGORA);
  assert.match(sem, /data-rp="aplicar" disabled/);
  assert.match(sem, /ainda não está pronta/);
  assert.ok(!/data-rp="tirar-do-ar" disabled/.test(sem));
  const feito = T.cardAcaoHtml(achado({ estado: 'aplicado-pelo-dono', aplicado: { em: '2026-10-31T10:00:00Z', antes: '1', depois: '0' } }), AGORA);
  assert.ok(!/data-rp="aplicar"/.test(feito));
  assert.match(feito, /Aplicado por você, hoje, 07h00\. Antes: 1\. Depois: 0\./);
});

test('nível 3: texto fixo e Corrigir agora; atualizar-dgclaw usa o pedido para o Admin', () => {
  const a = achado({ nivel: 3, severidade: 'LOW', id: 'GHSA-AAAA-1', correcao: { tipo: 'atualizar-dgclaw', disponivel: true } });
  const h = T.cardSemPressaHtml(a, AGORA);
  assert.ok(h.includes(R.TEXTO_NIVEL3));
  assert.match(h, /data-rp="pedir-admin"[^>]*>Pedir ao Admin/);
  assert.ok(!/data-rp="corrigir"/.test(h));
  assert.match(T.cardSemPressaHtml(achado({ nivel: 3 }), AGORA), /data-rp="corrigir"[^>]*>Corrigir agora/);
  assert.equal(R.ehAtualizarDgclaw(a), true);
  assert.equal(R.textoDoPedidoAoAdmin(a), R.textoDoPedidoAtualizar(a));
  const apt3 = achado({ nivel: 3, id: 'USN-1234-1', componente: 'openssl', correcao: { tipo: 'apt', disponivel: true, executavel: false } });
  assert.equal(R.textoDoPedidoAoAdmin(apt3), 'Quero aplicar a correção de segurança USN-1234-1 (atualização do pacote openssl). Analise antes e me diga se vai reiniciar algum serviço.');
  assert.equal(R.podeAplicar(apt3), false);
  assert.equal(R.podePedirAoAdmin(apt3), true);
  assert.equal(R.podePedirAoAdmin(achado()), false);
  assert.equal(R.ehAtualizarDgclaw(achado()), false);
  assert.equal(R.textoDoPedidoAtualizar(a), 'Quero instalar a atualização de segurança do DG Claw (achado GHSA-AAAA-1).');
  assert.match(T.cardSemPressaHtml({ ...a, correcao: { tipo: 'nenhuma', disponivel: false } }, AGORA), /data-rp="corrigir" disabled/);
});

test('nível 1: o que foi feito, quando e Desfazer só com caminho de volta', () => {
  const a = achado({ nivel: 1, estado: 'aplicado-sozinho', aplicado: { em: '2026-10-31T10:00:00Z', acao_id: 'x', antes: 'mptcp=1', depois: 'mptcp=0', desfazer: 'sysctl -w mptcp=1' } });
  const h = T.cardAplicadoHtml(a, AGORA);
  assert.match(h, /Aplicado sozinho, hoje, 07h00\. Antes: mptcp=1\. Depois: mptcp=0\./);
  assert.match(h, /data-rp="desfazer"/);
  assert.ok(!/data-rp="desfazer"/.test(T.cardAplicadoHtml(achado({ nivel: 1, estado: 'aplicado-sozinho', aplicado: { em: '2026-10-31T10:00:00Z', desfazer: null } }), AGORA)));
});

test('listas vazias dizem a frase certa', () => {
  assert.match(T.listaNivelHtml([], 1, AGORA), /Nada foi aplicado sozinho/);
  assert.match(T.listaNivelHtml([], 2, AGORA), /Nenhuma falha crítica/);
  assert.match(T.listaNivelHtml([], 3, AGORA), /Nada para corrigir sem pressa/);
  assert.match(T.tratadasHtml([]), /Nenhuma falha foi marcada/);
  assert.match(T.inventarioHtml(null), /ainda não registrou/);
  const inv = T.inventarioHtml({ kernel: '6.8.0', componentes: 3, portas_publicas: [{ porta: 443, processo: 'caddy' }], servicos_externos: [{ nome: 'Notion', via: 'MCP do agente luna', versao: '1.2.3' }] });
  assert.match(inv, /Kernel<\/b>: 6\.8\.0/);
  assert.match(inv, /443 \(caddy\)/);
  assert.match(inv, /Notion <small>via MCP do agente luna, versão 1\.2\.3/);
});

test('agendamento: datetime-local vira ISO; passado, vazio e formato torto são recusados', () => {
  const agora = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(R.agendaParaIso('2026-12-01T03:00', agora), new Date('2026-12-01T03:00').toISOString());
  assert.equal(R.agendaParaIso('2026-10-30T03:00', agora), null);
  assert.equal(R.agendaParaIso('', agora), null);
  assert.equal(R.agendaParaIso('amanhã', agora), null);
  assert.equal(R.agendaParaIso(undefined, agora), null);
});

test('janela vermelha: só nível 2 aberto, sem decisão e sem "lembrar depois" (30 min); volta depois do prazo', () => {
  const st = memoria();
  const ronda = { niveis: { 1: [], 2: [achado({ id: 'AAA-1' }), achado({ id: 'AAA-2' }), achado({ id: 'AAA-3', estado: 'agendado' }), achado({ id: 'AAA-4', estado: 'mitigado' })], 3: [achado({ id: 'AAA-5', nivel: 3 })] } };
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA, null).map((a) => a.id), ['AAA-1', 'AAA-2']);
  R.lembrarDepois(st, 'AAA-1', AGORA);
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA + 29 * 60 * 1000, null).map((a) => a.id), ['AAA-2']);
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA + 31 * 60 * 1000, null).map((a) => a.id), ['AAA-1', 'AAA-2']);
  R.marcaDecidido(st, 'AAA-2', AGORA);
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA + 31 * 60 * 1000, null).map((a) => a.id), ['AAA-1']);
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA + 25 * 3600 * 1000, null).map((a) => a.id), ['AAA-1', 'AAA-2'], 'decisão que não surtiu efeito em 24 h faz a janela voltar');
  assert.deepEqual(R.paraJanelaVermelha(ronda, memoria(), AGORA, { estado: { cortado: true } }), [], 'sistema fora do ar: a decisão já foi tomada');
  assert.deepEqual(R.paraJanelaVermelha({ nunca_rodou: true }, st, AGORA, null), []);
  assert.deepEqual(R.paraJanelaVermelha(ronda, { getItem() { throw new Error('sem acesso'); }, setItem() { throw new Error('sem acesso'); } }, AGORA, null).length, 2);
});

test('janela vermelha: HTML com os quatro botões, aviso e passos do tutorial que existem no HTML', () => {
  const hAdmin = A.modalHtml(achado({ correcao: { tipo: 'apt', disponivel: true, executavel: false } }), 1);
  assert.ok(hAdmin.includes('id="rpPedirAdmin"') && !hAdmin.includes('id="rpAplicar"') && !hAdmin.includes('id="rpAgendar"'), 'apt: só Pedir ao Admin');
  const h = A.modalHtml(achado(), 3);
  for (const id of ['rpAplicar', 'rpAgendar', 'rpTirar', 'rpLembrar']) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /Há mais 2 falhas críticas esperando depois desta\./);
  assert.match(A.textoIntro(2), /Há mais 1 falha crítica esperando depois desta\./);
  assert.ok(!A.textoIntro(1).includes('Há mais'));
  const alvos = A.passosDoModal(null).map((p) => p.alvo);
  for (const alvo of alvos) {
    const id = alvo.replace(/^[#.]/, '');
    assert.ok((h + hAdmin).includes(`id="${id}"`) || h.includes(`class="${id}"`), alvo);
  }
  for (const p of A.passosDoModal(null)) { assert.ok(p.oque && p.como && p.porque, p.alvo); }
});

test('emergência: explicação, Simular, bloqueio com motivo, confirmação dupla com código e frase', () => {
  const e = { disponivel: true, motivo: null, desatualizado: false, estado: { cortado: false }, plano: { comandos: ['systemctl stop caddy'], avisos: [] } };
  let h = T.emergenciaHtml(e, { fase: 'ocioso' });
  assert.match(h, /tira o sistema da internet/);
  assert.match(h, /Tailscale/);
  assert.match(h, /religa sozinho em 5 minutos/);
  assert.match(h, /id="btnSimular"/);
  assert.ok(!/id="btnTirarDoAr"[^>]* disabled/.test(h));
  assert.ok(!h.includes('systemctl stop caddy'), 'o plano só aparece depois de Simular');
  assert.match(T.emergenciaHtml(e, { fase: 'ocioso', verPlano: true }), /<code>systemctl stop caddy<\/code>/);
  const bloq = T.emergenciaHtml({ disponivel: false, motivo: 'o corte trancaria todo mundo fora: ligue o Tailscale', estado: { cortado: false } }, { fase: 'ocioso' });
  assert.match(bloq, /id="btnTirarDoAr"[^>]* disabled/);
  assert.match(bloq, /desligado por enquanto.*ligue o Tailscale/);
  const cod = T.emergenciaHtml(e, { fase: 'codigo', acao: 'cortar', codigo: 'K7M2PQ', expira_em: '2026-10-31T16:32:00Z', plano: e.plano });
  assert.match(cod, /id="rpCodigo">K7M2PQ</);
  assert.match(cod, /digite <b>TIRAR-DO-AR<\/b>/);
  assert.match(cod, /id="btnConfirmaEm" disabled/);
  assert.match(cod, /vale até 13h32/);
  const rel = T.emergenciaHtml({ ...e, estado: { cortado: true, desde: '2026-10-31T16:00:00Z', confirmado: false, religar_automatico_em: '2026-10-31T16:05:00Z' } }, { fase: 'codigo', acao: 'religar', codigo: 'ABC234' });
  assert.match(rel, /digite <b>RELIGAR<\/b>/);
  assert.match(T.emergenciaHtml({ ...e, estado: { cortado: true, desde: '2026-10-31T16:00:00Z', confirmado: false, religar_automatico_em: '2026-10-31T16:05:00Z' } }, { fase: 'ocioso' }), /fora do ar.*religa sozinho em hoje, 13h05/s);
  assert.match(T.emergenciaHtml({ ...e, estado: { cortado: true, desde: '2026-10-31T16:00:00Z' } }, { fase: 'ocioso' }), /id="btnReligar"/);
  assert.equal(T.fraseConfere('TIRAR-DO-AR', 'TIRAR-DO-AR'), true);
  assert.equal(T.fraseConfere('tirar-do-ar', 'TIRAR-DO-AR'), false);
  assert.equal(T.fraseConfere('TIRAR-DO-AR ', 'TIRAR-DO-AR'), false);
});

test('sondagem: pendente, depois feito; erro de API vira mensagem; passou de 2 min = mensagem de tempo', async () => {
  const respostas = [{ pendente: true }, { pendente: true }, { pendente: false, resultado: { ok: true, mensagem: 'Pronto.' }, dados: { codigo: 'K7M2PQ' } }];
  const progresso = [];
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => respostas.shift() });
  const r = await R.sondar('uuid', { fetchFn, dorme: async () => {}, rotulo: 'Aplicando', aoProgresso: (t) => progresso.push(t) });
  assert.deepEqual([r.ok, r.mensagem, r.dados.codigo], [true, 'Pronto.', 'K7M2PQ']);
  assert.deepEqual(progresso, ['Aplicando… (2 s)', 'Aplicando… (4 s)']);
  const erro = await R.sondar('uuid', { fetchFn: async () => ({ ok: false, status: 404, json: async () => ({ erro: 'Não há pedido x.' }) }), dorme: async () => {} });
  assert.deepEqual([erro.ok, erro.mensagem], [false, 'Não há pedido x.']);
  let t = 0;
  const lento = await R.sondar('uuid', { fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ pendente: true }) }), dorme: async () => { t += 30000; }, relogio: () => t });
  assert.equal(lento.ok, false);
  assert.match(lento.mensagem, /não respondeu em 2 minutos.*dgclaw-seguranca-pedidos\.path/);
  const rede = await R.sondar('uuid', { fetchFn: async () => { throw new Error('offline'); }, dorme: async () => {} });
  assert.match(rede.mensagem, /Não consegui falar com o servidor \(offline\)/);
});

test('pedirEEsperar: POST com corpo JSON e depois a sondagem; recusa do POST vira mensagem', async () => {
  const chamadas = [];
  const fetchFn = async (url, op) => {
    chamadas.push([op.method, url, op.body]);
    if (op.method === 'POST') return { ok: true, status: 202, json: async () => ({ pedido: 'u-1', tipo: 'aplicar' }) };
    return { ok: true, status: 200, json: async () => ({ pendente: false, resultado: { ok: true, mensagem: 'Feito.' } }) };
  };
  const r = await R.pedirEEsperar(fetchFn, R.urlAchado('AAA-1', 'agendar'), { quando: '2026-11-01T06:00:00.000Z' }, { dorme: async () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(chamadas[0], ['POST', '/api/v1/seguranca/ronda/AAA-1/agendar', '{"quando":"2026-11-01T06:00:00.000Z"}']);
  assert.deepEqual(chamadas[1].slice(0, 2), ['GET', '/api/v1/seguranca/pedidos/u-1']);
  const nega = await R.pedirEEsperar(async () => ({ ok: false, status: 409, json: async () => ({ erro: 'Já está como "aplicado".' }) }), R.urlAchado('AAA-1', 'aplicar'), {}, {});
  assert.deepEqual([nega.ok, nega.mensagem], [false, 'Já está como "aplicado".']);
});

test('tutorial: cada passo responde o que é / como é calculado / por que está aqui, e os alvos existem na página', () => {
  const html = pub('seguranca.html');
  const dinamicos = new Set();   // todos os alvos da página são estáticos
  for (const [chave, passos] of Object.entries(T.PASSOS)) {
    assert.ok(passos.length, chave);
    for (const p of passos) {
      assert.ok(p.titulo && p.oque && p.como && p.porque, `${chave}: ${p.alvo}`);
      if (dinamicos.has(p.alvo)) continue;
      assert.ok(html.includes(`id="${p.alvo.slice(1)}"`), `${p.alvo} não existe em seguranca.html`);
    }
  }
  assert.equal(T.passosPagina(null).length, Object.values(T.PASSOS).reduce((n, l) => n + l.length, 0));
  for (const secao of ['topo', 'acao', 'sempressa', 'aplicado', 'emergencia', 'tratadas', 'inventario']) {
    assert.ok(html.includes(`data-secao="${secao}"`), `falta o ? da seção ${secao}`);
    assert.ok(T.PASSOS[secao], secao);
  }
  assert.match(html, /<button type="button" class="rp-ajuda"/);
});

test('ligação nas telas: página, casca, menu, conversa, service worker e CSS de celular', () => {
  const html = pub('seguranca.html');
  for (const s of ['/tour.js', '/menu-lado.js', '/ronda-comum.js', '/casca.js', '/seguranca.js']) assert.ok(html.includes(`src="${s}"`), s);
  assert.match(html, /DGCasca\.monta\(\{ pagina: 'seguranca', titulo: 'Segurança', aoTutorial/);
  assert.ok(pub('casca.js').includes('/ronda-aviso.js'));
  assert.ok(pub('conversa.html').includes('/ronda-aviso.js') && pub('conversa.html').includes('/ronda-comum.js'));
  const sw = pub('sw.js');
  for (const a of ['/seguranca.js', '/seguranca.css', '/ronda-comum.js', '/ronda-aviso.js', '/ronda-aviso.css']) assert.ok(sw.includes(`'${a}'`), a);
  assert.ok(pub('seguranca-aviso.js').includes("getElementById('rpFundo')"), 'a janela de boletins espera a vermelha');
  const M = require('../public/menu-lado');
  assert.deepEqual(M.LINK_SEGURANCA, { nome: 'Segurança', ico: '🛡', href: '/seguranca' });
  assert.equal(M.chaveDoHref(M.comAgente(M.LINK_SEGURANCA.href, 'luna')), 'seguranca');
  const css = pub('seguranca.css');
  assert.match(css, /@media \(max-width:420px\)/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /min-height:3[4-9]px/);
});

test('nenhum arquivo da tela usa travessão no meio de frase nem monta HTML com texto cru da API', () => {
  for (const n of ['ronda-comum.js', 'seguranca.js', 'ronda-aviso.js', 'seguranca.html', 'seguranca.css']) {
    const t = pub(n);
    assert.ok(!/[—–]/.test(t), `${n} tem travessão`);
  }
  for (const n of ['seguranca.js', 'ronda-aviso.js']) assert.ok(!/\.innerHTML\s*=\s*[^;]*\+\s*(a|achado|e)\.(nome|motivo)/.test(pub(n)), n);
});

test('corte inconsistente: faixa de falha de proteção com o motivo, Reaplicar e Religar, e a janela vermelha continua', () => {
  const motivo = 'a tabela nft dgclaw-emergencia não está carregada';
  const e = { disponivel: true, estado: { cortado: true, inconsistente: true, motivo_inconsistente: motivo, desde: '2026-10-31T16:00:00Z' }, plano: { comandos: ['nft -f x'], avisos: [] } };
  const h = T.emergenciaHtml(e, { fase: 'ocioso' });
  assert.match(h, /id="rpEmInconsistente"[^>]*role="alert"/);
  assert.match(h, /O corte de emergência está marcado, mas o firewall não está carregado: o servidor pode estar exposto/);
  assert.ok(h.includes(motivo));
  assert.ok(!h.includes('O sistema está fora do ar'), 'não afirma que está isolado');
  assert.match(h, /data-acao="cortar" id="btnReaplicar"[^>]*>Reaplicar o corte</);
  assert.match(h, /data-acao="religar" id="btnReligar"[^>]*>Religar</);
  assert.ok(!h.includes('btnTirarDoAr'));

  const st = memoria();
  const ronda = { niveis: { 2: [achado({ id: 'AAA-1', estado: 'aberto' })] } };
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA, { estado: { cortado: true, inconsistente: true } }).map((a) => a.id), ['AAA-1'], 'alerta crítico segue visível');
  assert.deepEqual(R.paraJanelaVermelha(ronda, st, AGORA, { estado: { cortado: true, inconsistente: false } }), []);

  // o botão escolhido (e não o que o servidor sugere) decide a ação da confirmação
  const src = pub('seguranca.js');
  assert.match(src, /prepararEmergencia\(bt\.dataset\.acao\)/);
  assert.match(src, /acao: acaoEscolhida \|\| res\.dados\.acao/);
  const conf = T.emergenciaHtml(e, { fase: 'codigo', acao: 'cortar', codigo: 'K7M2PQ', plano: e.plano });
  assert.match(conf, /digite <b>TIRAR-DO-AR<\/b>/);
});
