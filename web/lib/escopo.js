'use strict';
// Escopo do colaborador: o isolamento é no servidor e NEGA POR PADRÃO.
//
// avaliar(sessao, metodo, pathname) devolve { ok:true } ou { ok:false, status, motivo, redirecionar?, extra? }.
//   - Dono e caixa do agente (sessao.via === 'caixa'): sempre liberado; o comportamento deles não muda.
//   - Colaborador (sessao.papel === 'colaborador'): só passa o que estiver nas listas abaixo, e cada
//     item com slug confere que o slug DECODIFICADO é exatamente sessao.agente.
//
// ROTA NOVA: quem criar uma rota nova no server.js NÃO precisa mexer aqui para o dono, mas ela fica
// FECHADA para o colaborador (403) até alguém liberá-la nesta lista, de propósito. Libere só depois de
// pensar no que um colaborador faria com ela, e acrescente um caso em web/test/escopo.test.js.
//
// O pathname chega como o server.js o vê (new URL já resolveu "." e ".." e "%2e%2e"). As regexes abaixo
// são as mesmas do roteamento: caminho com barra dupla, maiúscula no lugar errado ou segmento a mais
// simplesmente não casa e cai na negação.

const TROCAR_SENHA_MOTIVO = 'Troque a senha temporária antes de continuar.';
const MOTIVO_PAINEL = 'O painel de configuração do agente é só do dono do DG Claw.';
const MOTIVO_GERAL = 'Este endereço não está liberado para colaboradores. Você tem acesso à conversa do seu agente e à página Conectar.';
const MOTIVO_OUTRO_AGENTE = 'Você só tem acesso ao agente para o qual foi convidado(a).';

// Arquivos estáticos de web/public que a casca precisa (nada de .html: as páginas passam pelas regras de página).
const RX_ESTATICO = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|gif|webp|svg|ico|webmanifest|woff2?|ttf|mp3|wav|mp4|webm)$/;

const ehEstatico = (p) => !p.includes('..') && RX_ESTATICO.test(p);

const RX_DOCS = /^\/api\/v1\/(?!colaboradores\/)[a-z-]+\/docs\.md$/;
const RX_AGENTE = /^\/api\/v1\/agents\/([^/]+)(?:\/([a-z-]+))?$/;
const RX_AGENTE_LOGIN = /^\/api\/v1\/agents\/([^/]+)\/login(?:\/(codigo|oi))?$/;
const RX_AGENTE_ALERTAS = /^\/api\/v1\/agents\/([^/]+)\/alertas(?:\/([a-f0-9]{24})\/(visto|mensagem))?$/;
const RX_MIDIA = /^\/api\/v1\/media\/[0-9a-f]{16}(?:\/(?:thumb|visual))?$/;
const RX_PAGINA_AGENTE = /^\/a\/([^/]+)\/?$/;

// ação -> métodos aceitos, para /api/v1/agents/<slug>/<ação>
const ACOES_AGENTE = {
  '': ['GET'], avatar: ['GET', 'HEAD'], messages: ['GET'], stream: ['GET'], wait: ['GET'], send: ['POST'],
  permissao: ['POST'], pergunta: ['POST'], reiniciar: ['POST'], lido: ['POST'], 'nao-lido': ['POST', 'DELETE'],
  vendo: ['POST'], upload: ['POST'], compartilhados: ['GET'],
  // Sem `comando` e sem `comandos`: colaborador não manda comando de barra (ver conversa.js, enviar).
};
const METODOS_LOGIN = { '': ['GET', 'POST', 'DELETE'], codigo: ['POST'], oi: ['POST'] };

function decodifica(parte) {
  try { return decodeURIComponent(parte); } catch (_) { return null; }
}

const nega = (status, motivo, extra) => Object.assign({ ok: false, status, motivo }, extra || {});
const LIBERA = { ok: true };

function avaliar(sessao, metodo, pathname) {
  if (!sessao) return nega(401, 'Você precisa entrar para continuar.');
  if (sessao.via === 'caixa' || sessao.papel !== 'colaborador') return LIBERA;

  const m = String(metodo || '').toUpperCase();
  const p = String(pathname || '');
  const meu = sessao.agente;
  const destino = `/a/${encodeURIComponent(meu)}`;
  const ehApi = p.startsWith('/api/');
  const leitura = m === 'GET' || m === 'HEAD';
  const meuSlug = (s) => { const d = decodifica(s); return d !== null && d === meu; };

  // Senha temporária pendente: só o que leva à troca.
  if (sessao.trocar_senha) {
    if (p === '/api/v1/eu' && m === 'GET') return LIBERA;
    if (p === '/api/v1/eu/senha' && m === 'POST') return LIBERA;
    if (p === '/trocar-senha' && leitura) return LIBERA;
    if (!ehApi && !p.startsWith('/p/') && leitura && ehEstatico(p)) return LIBERA;
    if (ehApi) return nega(403, TROCAR_SENHA_MOTIVO, { extra: { trocar_senha: true } });
    if (leitura) return nega(302, TROCAR_SENHA_MOTIVO, { redirecionar: '/trocar-senha' });
    return nega(403, TROCAR_SENHA_MOTIVO);
  }

  if (p.startsWith('/p/') || p === '/p') return nega(403, MOTIVO_PAINEL);

  if (ehApi) return avaliaApi(m, p, meuSlug);

  if (leitura) {
    if (p === '/') return LIBERA;
    if (p === '/conectar' || p === '/conectar/' || p === '/trocar-senha') return LIBERA;
    const pa = RX_PAGINA_AGENTE.exec(p);
    if (pa) return meuSlug(pa[1]) ? LIBERA : nega(302, MOTIVO_OUTRO_AGENTE, { redirecionar: destino });
    if (ehEstatico(p)) return LIBERA;
    return nega(302, MOTIVO_GERAL, { redirecionar: destino });
  }
  return nega(403, MOTIVO_GERAL);
}

function avaliaApi(m, p, meuSlug) {
  const motivoOutro = nega(403, MOTIVO_OUTRO_AGENTE);
  if (p === '/api/v1/eu') return m === 'GET' ? LIBERA : nega(405, 'Use GET para ver quem está logado.');
  if (p === '/api/v1/eu/senha') return m === 'POST' ? LIBERA : nega(405, 'Use POST para trocar a senha.');
  if (p === '/api/v1/agents') return m === 'GET' ? LIBERA : nega(405, 'Use GET para ver o seu agente.');
  if (p === '/api/v1/nao-lidas') return m === 'GET' ? LIBERA : nega(405, 'Use GET para ver as mensagens não lidas.');
  if (p === '/api/v1/transcribe') return m === 'POST' ? LIBERA : nega(405, 'Use POST com o áudio.');
  if (p === '/api/v1/tts') return m === 'POST' ? LIBERA : nega(405, 'Use POST com o texto.');
  if (p === '/api/v1/tts/cota') return m === 'GET' ? LIBERA : nega(405, 'Use GET para ver a cota de voz.');
  if (RX_DOCS.test(p)) return m === 'GET' ? LIBERA : nega(405, 'Use GET para ler a documentação.');

  if (RX_MIDIA.test(p)) {
    // O dono do arquivo é conferido na entrega (media.js), que responde 404 se a mídia não é deste agente.
    return m === 'GET' || m === 'HEAD' ? LIBERA : nega(405, 'Use GET para abrir a mídia.');
  }

  let r = RX_AGENTE_LOGIN.exec(p);
  if (r) {
    if (!meuSlug(r[1])) return motivoOutro;
    return (METODOS_LOGIN[r[2] || ''] || []).includes(m) ? LIBERA : nega(405, `Método inválido para ${p}.`);
  }
  r = RX_AGENTE_ALERTAS.exec(p);
  if (r) {
    if (!meuSlug(r[1])) return motivoOutro;
    const ok = !r[2] ? m === 'GET' : (r[3] === 'visto' ? m === 'POST' : m === 'GET');
    return ok ? LIBERA : nega(405, `Método inválido para ${p}.`);
  }
  r = RX_AGENTE.exec(p);
  if (r) {
    if (!meuSlug(r[1])) return motivoOutro;
    const acao = r[2] || '';
    if (!Object.prototype.hasOwnProperty.call(ACOES_AGENTE, acao)) return nega(403, MOTIVO_GERAL);
    return ACOES_AGENTE[acao].includes(m) ? LIBERA : nega(405, `Método inválido para ${p}.`);
  }
  return nega(403, MOTIVO_GERAL);
}

/** Atalho para o handler de WebSocket: colaborador nunca abre. Dono e caixa seguem a regra de sempre. */
function websocketLiberado(sessao) {
  if (!sessao) return nega(401, 'Você precisa entrar antes.');
  if (sessao.via === 'caixa' || sessao.papel !== 'colaborador') return LIBERA;
  return nega(403, 'O painel de configuração do agente é só do dono do DG Claw.');
}

module.exports = { avaliar, websocketLiberado, TROCAR_SENHA_MOTIVO, MOTIVO_PAINEL };
