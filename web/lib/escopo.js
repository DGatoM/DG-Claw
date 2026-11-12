'use strict';
// Escopo do colaborador: o isolamento é no servidor e NEGA POR PADRÃO.
//
// REGRA: tudo que tem o slug do agente dele passa; o que é de outro agente ou da caixa inteira é negado;
// rota nova SEM slug nasce fechada.
//
// avaliar(sessao, metodo, pathname, urlCrua) devolve { ok:true } ou { ok:false, status, motivo, redirecionar?, extra? }.
//   - Dono e caixa do agente (sessao.via === 'caixa'): sempre liberado; o comportamento deles não muda.
//   - Colaborador (sessao.papel === 'colaborador'): passa o agente dele inteiro e nada além disso.
//
// O que passa para o colaborador:
//   - /a/<dele> e /p/<dele>/** (o painel do agente: sessões, rotinas, memória, arquivos...),
//     menos as exceções fechadas abaixo;
//   - /api/v1/agents/<dele>/** (todas as ações, as de hoje e as futuras), menos /comando e /comandos. Inclui
//     /login, /login/codigo e /login/oi: o portão real é o handler (conta-colaborador.js), que recusa na dúvida;
//   - mídia (a entrega confere que o arquivo é do agente dele), arquivos estáticos, /, /conectar, /trocar-senha,
//     /api/v1/eu, /api/v1/eu/senha, /api/v1/agents (só o dele, filtrado no handler), /api/v1/nao-lidas (idem),
//     transcribe, tts e as documentações;
//   - WebSocket: nenhum (o único do painel é o da Tela, que é fechada).
//
// Dentro de /p/<dele>/ ficam FECHADOS (o dono é quem mexe em credencial e em conta):
//   - o cofre do agente (/api/cofre): são as credenciais que o dono pôs;
//   - as chaves de API do painel (/api/chaves-api): dão acesso ao painel e nenhuma chave gerencia chaves;
//   - /api/provedor* inteiro, até a leitura (traz o link e o código do login, sem nenhuma regra de quem pode). O colaborador
//     conecta a conta de IA só pelo Web, em /api/v1/agents/<dele>/login*, onde web/lib/conta-colaborador.js decide no servidor
//     (agente sem conta de verdade, uma pessoa por vez, resposta com lista de campos permitidos);
//   - TODA escrita no painel fora da lista de permissão de escritaLiberada(): memória, arquivos, apps, custos, reinício
//     e rota nova. O painel registra a escrita como do dono, e memória e arquivos viram instrução permanente;
//   - credencial de canal (token de bot de Telegram, WhatsApp): qualquer escrita em /api/canais, /api/telegram etc.;
//   - a Tela inteira (/api/tela*, /tela/*, WebSocket): o Chrome remoto roda como o agente e abre file:// nas credenciais dele;
//   - tudo que manda texto ou comando a uma sessão, decide pendência ou abre e encerra sessão com instrução pelo painel
//     (/api/chat/* menos transcrever, /api/socorro/*, e em /api/sessoes: criar, recado, decidir, tecla, retomar,
//     handoff, anexo e apagar). O painel não sabe quem é o colaborador e mandaria como se fosse o dono, ou aprovaria
//     sem autoria: o colaborador conversa e confirma só pelas rotas do Web (/send, /permissao, /pergunta), que têm
//     identidade e conferem o turno.
//
// ROTA NOVA: no server.js, uma rota que não leva o slug do agente no caminho fica FECHADA para o colaborador (403)
// até alguém liberá-la aqui, de propósito. Libere só depois de pensar no que um colaborador faria com ela e de
// garantir que o handler filtra a saída para o agente dele; acrescente o caso em web/test/escopo.test.js.
// Rota nova que leva o slug (/api/v1/agents/<slug>/x, /p/<slug>/x) já passa: confira que ela é do agente do slug.
//
// A conferência fica aqui, no Web, porque é a fronteira de confiança (o painel confia no Web). Para /p/ e /api/ o
// colaborador não passa com %2f, %2e, %5c, %25, barra dupla, /./ ou /../ no caminho CRU (o que o proxy repassa), e os
// prefixos fechados são comparados sem diferenciar maiúsculas e tolerando barra final, como o Express do painel roteia.

const TROCAR_SENHA_MOTIVO = 'Troque a senha temporária antes de continuar.';
const MOTIVO_PAINEL = 'Este endereço do painel é só do dono do DG Claw.';
const MOTIVO_COFRE = 'O cofre é só do dono do DG Claw.';
const MOTIVO_CHAVES_API = 'As chaves de API do painel são só do dono do DG Claw.';
const MOTIVO_CONTA_IA = 'A conta de IA se conecta pela página Conectar conta, não pelo painel do agente. Se o agente já tem conta, só o dono do DG Claw mexe nela.';
const MOTIVO_PERMANENTE = 'Isso muda o agente de forma permanente (instruções, memória, arquivos, configuração ou rotinas) e é só do dono do DG Claw.';
const MOTIVO_CANAL = 'As credenciais dos canais (Telegram, WhatsApp) são só do dono do DG Claw.';
const MOTIVO_TELA = 'A Tela do agente dá acesso aos arquivos e às contas dele, por isso é só do dono do DG Claw.';
const MOTIVO_ENVIO = 'Mandar mensagem, instrução ou decisão ao agente pelo painel é só do dono do DG Claw. Converse pela conversa do agente: ali as suas mensagens e confirmações têm o seu nome.';
const MOTIVO_DESVIO = 'Este endereço tem caracteres que não são aceitos para colaboradores. Você só tem acesso ao seu agente.';
const MOTIVO_GERAL = 'Este endereço não está liberado para colaboradores. Você tem acesso ao seu agente inteiro, pelo menu dele.';
const MOTIVO_OUTRO_AGENTE = 'Você só tem acesso ao agente para o qual foi convidado(a).';
const MOTIVO_COMANDO = 'Comandos de barra não existem para colaboradores. Escreva a mensagem normalmente.';

// Arquivos estáticos de web/public que a casca precisa (nada de .html: as páginas passam pelas regras de página).
const RX_ESTATICO = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|gif|webp|svg|ico|webmanifest|woff2?|ttf|mp3|wav|mp4|webm)$/;

const ehEstatico = (p) => !p.includes('..') && RX_ESTATICO.test(p);

const RX_DOCS = /^\/api\/v1\/(?!colaboradores\/|logs\/)[a-z-]+\/docs\.md$/;
const RX_AGENTE = /^\/api\/v1\/agents\/([^/]+)(?:\/([^/]*))?(?:\/.*)?$/;
const RX_MIDIA = /^\/api\/v1\/media\/[0-9a-f]{16}(?:\/(?:thumb|visual))?$/;
const RX_PAGINA_AGENTE = /^\/a\/([^/]+)\/?$/;
const RX_PAINEL = /^\/p\/([^/]+)(\/.*)?$/;

// Caminho cru com cara de desvio: barra codificada, ponto codificado, contrabarra, % duplo, NUL, barra dupla, /./ e /../.
const RX_DESVIO = /%(?:2f|2e|5c|25|00)|\\|\/\/|\/\.{1,2}(?:\/|$)/i;

/** Em /p/ nenhum caractere comum (letra, número, . _ - ~ / \ %) pode vir codificado: o painel não precisa e é por aí que o desvio entra. */
function temEscapeSuspeito(bruto) {
  const escapes = bruto.match(/%[0-9a-fA-F]{0,2}/g) || [];
  for (const e of escapes) {
    if (e.length !== 3) return true;
    const c = String.fromCharCode(parseInt(e.slice(1), 16));
    if (/[A-Za-z0-9._~\-/\\%\x00-\x1f]/.test(c)) return true;
  }
  return false;
}

const prefixo = (resto, base) => resto === base || resto.startsWith(`${base}/`);

function decodifica(parte) {
  try { return decodeURIComponent(parte); } catch (_) { return null; }
}

const nega = (status, motivo, extra) => Object.assign({ ok: false, status, motivo }, extra || {});
const LIBERA = { ok: true };

/** `urlCrua` é o req.url como chegou (é ele que o proxy repassa ao painel); sem ele vale o pathname. */
function avaliar(sessao, metodo, pathname, urlCrua) {
  if (!sessao) return nega(401, 'Você precisa entrar para continuar.');
  if (sessao.via === 'caixa' || sessao.papel !== 'colaborador') return LIBERA;

  const m = String(metodo || '').toUpperCase();
  const p = String(pathname || '');
  const bruto = String(urlCrua == null ? p : urlCrua).split('?')[0].split('#')[0];
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

  const ehPainel = p.startsWith('/p/') || p === '/p' || bruto.startsWith('/p/') || bruto === '/p';
  if (ehPainel) return avaliaPainel(m, p, bruto, meuSlug);

  if (ehApi || bruto.startsWith('/api/')) {
    if (RX_DESVIO.test(bruto)) return nega(403, MOTIVO_DESVIO);
    return avaliaApi(m, p, meuSlug);
  }

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

/**
 * Escrita que o colaborador pode fazer no painel (`resto` já em minúsculas e sem barra final). Lista final:
 *   POST /api/chat/transcrever (ditado do microfone, nada é gravado)
 *   POST /api/sessoes/<id>/(arquivar|desarquivar|renomear|favorito) (organizar a lista de sessões)
 */
function escritaLiberada(m, resto) {
  if (m === 'POST' && resto === '/api/chat/transcrever') return true;
  return m === 'POST' && /^\/api\/sessoes\/[^/]+\/(?:arquivar|desarquivar|renomear|favorito)$/.test(resto);
}

/** /p/<slug>/**: o painel do agente. Passa tudo do slug dele, menos o que é credencial ou conta (ver o topo do arquivo). */
function avaliaPainel(m, p, bruto, meuSlug) {
  if (RX_DESVIO.test(bruto) || temEscapeSuspeito(bruto)) return nega(403, MOTIVO_DESVIO);
  const r = RX_PAINEL.exec(bruto);
  if (!r) return nega(403, MOTIVO_GERAL);
  if (!meuSlug(r[1])) return nega(403, MOTIVO_OUTRO_AGENTE);
  // O Express do painel roteia sem olhar maiúscula e aceita barra final.
  const resto = (r[2] || '').toLowerCase().replace(/\/+$/, '');
  const leitura = m === 'GET' || m === 'HEAD';
  if (prefixo(resto, '/api/cofre')) return nega(403, MOTIVO_COFRE, { extra: { error: MOTIVO_COFRE, howToFix: 'Peça ao dono para cadastrar ou trocar a chave.' } });
  if (prefixo(resto, '/api/chaves-api')) return nega(403, MOTIVO_CHAVES_API, { extra: { error: MOTIVO_CHAVES_API } });
  // /api/provedor inteiro, até a leitura: o GET devolve o link e o código do login em andamento.
  if (prefixo(resto, '/api/provedor')) return nega(403, MOTIVO_CONTA_IA, { extra: { error: MOTIVO_CONTA_IA, howToFix: 'Avise o dono do DG Claw.' } });
  // A Tela (navegador remoto) roda como o agente e abre file:// nas credenciais dele: página, noVNC, WebSocket e senha.
  if (prefixo(resto, '/api/tela') || prefixo(resto, '/tela')) return nega(403, MOTIVO_TELA, { extra: { error: MOTIVO_TELA } });
  if (!leitura && ['/api/canais', '/api/canal', '/api/telegram', '/api/whatsapp'].some((b) => prefixo(resto, b))) {
    return nega(403, MOTIVO_CANAL, { extra: { error: MOTIVO_CANAL } });
  }
  if (!leitura) {
    const segs = resto.split('/');   // ['', 'api', 'sessoes', <id>, <ação>]
    const emSessoes = segs[1] === 'api' && segs[2] === 'sessoes';
    const AES_FECHADAS = ['recado', 'decidir', 'tecla', 'retomar', 'handoff', 'anexo', 'apagar'];
    if ((prefixo(resto, '/api/chat') && resto !== '/api/chat/transcrever') || prefixo(resto, '/api/socorro')
      || (emSessoes && (segs.length === 3 || AES_FECHADAS.includes(segs[4])))) {
      return nega(403, MOTIVO_ENVIO, { extra: { error: MOTIVO_ENVIO } });
    }
    // Lista de permissão: o que o colaborador grava no painel é só o que ele precisa para usar o agente. Tudo o mais
    // (memória, arquivos da casa, apps, custos, reinício) muda o agente de forma permanente ou gasta o que é do dono,
    // e uma rota nova do painel nasce fechada até alguém pôr aqui.
    if (!escritaLiberada(m, resto)) return nega(403, MOTIVO_PERMANENTE, { extra: { error: MOTIVO_PERMANENTE } });
  }
  return LIBERA;
}

function avaliaApi(m, p, meuSlug) {
  const metodo = (ok, texto) => (ok ? LIBERA : nega(405, texto));
  if (p === '/api/v1/eu') return metodo(m === 'GET', 'Use GET para ver quem está logado.');
  if (p === '/api/v1/eu/senha') return metodo(m === 'POST', 'Use POST para trocar a senha.');
  if (p === '/api/v1/agents') return metodo(m === 'GET', 'Use GET para ver o seu agente.');
  if (p === '/api/v1/nao-lidas') return metodo(m === 'GET', 'Use GET para ver as mensagens não lidas.');
  if (p === '/api/v1/transcribe') return metodo(m === 'POST', 'Use POST com o áudio.');
  if (p === '/api/v1/tts') return metodo(m === 'POST', 'Use POST com o texto.');
  if (p === '/api/v1/tts/cota') return metodo(m === 'GET', 'Use GET para ver a cota de voz.');
  if (RX_DOCS.test(p)) return metodo(m === 'GET', 'Use GET para ler a documentação.');

  // O dono do arquivo é conferido na entrega (media.js), que responde 404 se a mídia não é deste agente.
  if (RX_MIDIA.test(p)) return metodo(m === 'GET' || m === 'HEAD', 'Use GET para abrir a mídia.');

  const r = RX_AGENTE.exec(p);
  if (r) {
    if (!meuSlug(r[1])) return nega(403, MOTIVO_OUTRO_AGENTE);
    const acao = r[2] || '';
    // Comando de barra chegaria ao agente sem dizer quem mandou (ver conversa.js, enviar).
    if (acao === 'comando' || acao === 'comandos') return nega(403, MOTIVO_COMANDO);
    // Login da conta de IA: passa até o handler, que só deixa o colaborador agir quando o agente está sem conta de verdade
    // (web/lib/conta-colaborador.js). O painel (/p/<dele>/api/provedor*) continua fechado, ver avaliaPainel().
    // O agente em si (editar, apagar) não é do colaborador; só a leitura.
    if (acao === '') return metodo(m === 'GET', 'Use GET para ver o seu agente.');
    return LIBERA;
  }
  return nega(403, MOTIVO_GERAL);
}

/**
 * Atalho para o handler de WebSocket. Dono e caixa seguem a regra de sempre; o colaborador abre só /p/<dele>/**
 * (a Tela usa /p/<dele>/tela/websockify), com as mesmas travas do painel.
 */
function websocketLiberado(sessao, pathname, urlCrua) {
  if (!sessao) return nega(401, 'Você precisa entrar antes.');
  if (sessao.via === 'caixa' || sessao.papel !== 'colaborador') return LIBERA;
  if (sessao.trocar_senha) return nega(403, TROCAR_SENHA_MOTIVO);
  const p = String(pathname == null ? '' : pathname);
  const bruto = String(urlCrua == null ? p : urlCrua).split('?')[0].split('#')[0];
  if (!(p.startsWith('/p/') || bruto.startsWith('/p/'))) return nega(403, 'Só o painel do seu agente aceita WebSocket.');
  const meuSlug = (s) => { const d = decodifica(s); return d !== null && d === sessao.agente; };
  return avaliaPainel('GET', p, bruto, meuSlug);
}

module.exports = { avaliar, websocketLiberado, TROCAR_SENHA_MOTIVO, MOTIVO_PAINEL, MOTIVO_COFRE };
