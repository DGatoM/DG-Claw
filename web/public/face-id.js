'use strict';
/* face-id.js: a tela "Face ID" (/face-id): ligar o cadeado neste aparelho, ver e remover os aparelhos cadastrados e
   escolher o tempo de trava. Vale para o dono e para cada colaborador, cada um com as próprias passkeys.

   Usa as rotas de /api/v1/cadeado (contrato em web/docs/CADEADO.md) e as funções do trava.js (window.DGTrava), que
   precisa estar carregado antes. As funções que só montam texto e HTML ficam fora do DOM e têm teste em
   web/test/face-id-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGFaceId = m;
})(this, function (raiz) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUTOS = [1, 5, 10, 15, 20, 30, 60, 120];
  const OPCOES_VALIDADE_MS = 70000;   // o desafio vale 120 s no servidor; renovo bem antes

  /* Nome sugerido para o aparelho, a partir do navegador. */
  function nomeSugerido(ua) {
    ua = ua || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Celular Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Computador com Windows';
    if (/Linux/.test(ua)) return 'Computador com Linux';
    return 'Este aparelho';
  }

  /* As explicações que a tela mostra quando o Face ID não pode ser ligado aqui. `a` = {
       seguro (isSecureContext), temApi (WebAuthn existe), plataforma (true, false ou null = não medido),
       rotulo ('Face ID', 'Touch ID' ou 'biometria'), host, ambienteErro (texto do servidor ou null) }.
     Devolve { notas: [{titulo, texto}], podeLigar }. Sem nota, nada a explicar. */
  function notasDoAmbiente(a) {
    const notas = [];
    let podeLigar = true;
    const r = a.rotulo || 'biometria';
    if (!a.seguro) {
      podeLigar = false;
      notas.push({
        titulo: 'Este endereço não usa HTTPS',
        texto: 'O navegador só libera o ' + r + ' em endereço seguro (https://), e você abriu o DG Claw por ' + (a.host || 'este endereço') + '. Como resolver: abra o painel pelo endereço que começa com https:// (o instalador mostrou esse link no fim da instalação). Se o painel ainda não tem um endereço com HTTPS, peça ao Admin para conferir o certificado ou para trocar o endereço por um domínio seu. Enquanto isso, a sua senha continua valendo normalmente.',
      });
    } else if (a.ambienteErro) {
      podeLigar = false;
      notas.push({ titulo: 'O servidor não aceitou este endereço', texto: a.ambienteErro + ' A sua senha continua valendo normalmente.' });
    }
    if (!a.temApi) {
      podeLigar = false;
      notas.push({
        titulo: 'Este navegador não tem ' + r + ' para sites',
        texto: 'Ele não oferece passkeys (WebAuthn). Para usar o ' + r + ', abra o DG Claw no Safari (iPhone e Mac), no Chrome ou no Edge, atualizados. A sua senha continua valendo normalmente.',
      });
    } else if (a.plataforma === false) {
      podeLigar = false;
      notas.push({
        titulo: 'Este aparelho não tem biometria pronta para o navegador',
        texto: 'Não achei Face ID, Touch ID, digital nem código de tela configurado neste aparelho. Configure um deles nos Ajustes do aparelho e volte aqui. A sua senha continua valendo normalmente, e é por ela que você entra neste aparelho enquanto isso.',
      });
    }
    return { notas, podeLigar };
  }

  /* "há 3 min", "ontem" ou a data. */
  function quando(isoTexto, agora) {
    const t = Date.parse(isoTexto);
    if (!isFinite(t)) return 'nunca';
    const dif = (agora == null ? Date.now() : agora) - t;
    if (dif < 60000) return 'agora há pouco';
    if (dif < 3600000) return 'há ' + Math.floor(dif / 60000) + ' min';
    if (dif < 86400000) return 'há ' + Math.floor(dif / 3600000) + ' h';
    const d = new Date(t);
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function itemHtml(p, agora, editando) {
    const id = esc(p.id);
    const aqui = p.este_aparelho ? '<span class="fi-aqui">este aparelho</span>' : '';
    const detalhe = 'cadastrado ' + esc(quando(p.criada_em, agora)) + ', usado ' + esc(quando(p.ultimo_uso, agora)) +
      (p.sincronizada ? ', sincronizado pela sua conta' : '');
    if (editando) {
      return '<div class="fi-item" data-id="' + id + '"><label class="fi-campo">Novo nome<input type="text" maxlength="60" value="' + esc(p.nome) + '" data-nome autocomplete="off"></label>' +
        '<div class="fi-acoes"><button type="button" class="fi-btn pri" data-acao="salvar-nome">Salvar</button><button type="button" class="fi-btn" data-acao="cancelar-nome">Cancelar</button></div></div>';
    }
    return '<div class="fi-item" data-id="' + id + '"><div class="fi-quem"><b>' + esc(p.nome) + aqui + '</b><small>' + detalhe + '</small></div>' +
      '<div class="fi-acoes"><button type="button" class="fi-btn" data-acao="renomear">Renomear</button><button type="button" class="fi-btn perigo" data-acao="remover">Remover</button></div></div>';
  }
  function listaHtml(passkeys, agora, editandoId) {
    if (!passkeys.length) return '<p class="fi-vazio">Nenhum aparelho com Face ID ainda. Use o botão "Ligar neste aparelho" acima.</p>';
    return passkeys.map((p) => itemHtml(p, agora, p.id === editandoId)).join('');
  }

  function opcoesMinutos(atual) {
    const lista = MINUTOS.includes(atual) ? MINUTOS : MINUTOS.concat([atual]).sort((x, y) => x - y);
    return lista.map((n) => '<option value="' + n + '"' + (n === atual ? ' selected' : '') + '>' + n + (n === 1 ? ' minuto' : ' minutos') + '</option>').join('');
  }

  function passosPagina(r) {
    return [
      { alvo: '#cabecalho', titulo: 'Face ID', oque: 'A tela onde você liga a trava com ' + r + ' neste aparelho. Com ela ligada, o DG Claw trava sozinho depois de um tempo sem uso e só volta com o seu rosto, a sua digital ou o código do aparelho.', como: 'Cada pessoa liga no próprio aparelho e vê só os aparelhos dela. Quem não ligar não percebe nada.', porque: 'Se você deixar o celular desbloqueado em cima da mesa, ninguém lê as suas conversas com os agentes.' },
      PASSOS.aparelho, PASSOS.lista, PASSOS.tempo, PASSOS.endereco,
    ];
  }
  const PASSOS = {
    aparelho: { alvo: '[data-tour="fid-aparelho"]', titulo: 'Neste aparelho', oque: 'Mostra se o Face ID está ligado aqui e deixa ligar. Se o aparelho ou o endereço não permitem, a tela explica o motivo e o que fazer.', como: 'Toque em "Ligar neste aparelho" e confirme com o rosto, a digital ou o código do aparelho. Se você já tem uma passkey deste endereço (criada em outro aparelho ou sincronizada pelo iCloud), o botão principal vira "Usar minha passkey neste aparelho": ele usa a que já existe, sem criar outra. O DG Claw guarda só a chave pública da passkey; o seu rosto e a sua digital nunca saem do aparelho.', porque: 'O cadeado é por aparelho: ligar aqui não trava o seu computador nem o celular de outra pessoa.' },
    lista: { alvo: '[data-tour="fid-lista"]', titulo: 'Aparelhos cadastrados', oque: 'Os aparelhos em que você ligou o Face ID, com a data do cadastro e do último uso.', como: 'Renomeie para reconhecer cada um. Ao remover um aparelho, as sessões abertas nele são encerradas na hora (voltam ao login, e a conversa e a Tela que estavam abertas nele caem). A sessão que você está usando só continua se for do mesmo aparelho que você removeu; nesse caso ela fica sem o cadeado. A senha continua valendo em qualquer aparelho.', porque: 'É por aqui que você tira o acesso de um aparelho perdido ou vendido, mesmo que ele estivesse com a sessão aberta.' },
    tempo: { alvo: '[data-tour="fid-tempo"]', titulo: 'Tempo de trava', oque: 'Quantos minutos sem usar o DG Claw até a tela travar. O padrão é 15.', como: 'Escolha de 1 a 120 minutos e toque em Salvar. Só conta como uso o que você faz na tela (tocar, digitar, rolar), não o que roda em segundo plano.', porque: 'Tempo curto protege mais; tempo longo incomoda menos. Você decide o equilíbrio.' },
    endereco: { alvo: '[data-tour="fid-endereco"]', titulo: 'Endereço do painel', oque: 'O endereço pelo qual você abriu o painel agora.', como: 'A passkey é criada para esse endereço. Se o painel passar a ter outro endereço, ligue o Face ID de novo em cada aparelho.', porque: 'É uma regra do navegador, que protege você de sites falsos pedindo o seu Face ID.' },
  };

  /* Qual botão é o principal. Já existe passkey para este endereço e este aparelho ainda não está ligado (a passkey pode ter vindo
     do iCloud ou de outro aparelho): o principal é usar a que já existe, e criar uma nova fica como segunda opção. */
  function botoesDaTela(a) {
    const vincular = !a.ligado && !!a.temPasskeyAqui;
    return { vincular, ligarPrincipal: !vincular, ligarTexto: vincular ? 'Criar uma passkey nova' : (a.ligado ? 'Ligar de novo neste aparelho' : 'Ligar o ' + a.rotulo + ' neste aparelho') };
  }

  if (!raiz.document) return { botoesDaTela, nomeSugerido, notasDoAmbiente, quando, itemHtml, listaHtml, opcoesMinutos, passosPagina, PASSOS, MINUTOS };

  /* ── Parte com DOM ──────────────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const T = raiz.DGTrava;
  let estado = null; let passkeys = []; let editando = null; let opcoes = null; let opcoesEm = 0; let ocupado = false;
  let opcoesAp = null; let opcoesApEm = 0; let forcaVincular = false;

  function msg(id, texto, tipo) {
    const e = $(id);
    if (!e) return;
    e.textContent = texto || '';
    e.className = 'fi-msg' + (tipo ? ' ' + tipo : '');
    e.hidden = !texto;
  }

  async function chamar(metodo, url, corpo) {
    let r;
    try {
      r = await fetch(url, { method: metodo, cache: 'no-store', credentials: 'same-origin', headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined });
    } catch (e) {
      return { ok: false, status: 0, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a internet e tente de novo.' };
    }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) return { ok: false, status: r.status, erro: (d && d.erro) || ('O servidor respondeu ' + r.status + '.'), json: d };
    return { ok: true, status: r.status, json: d };
  }

  const rotulo = () => (T ? T.rotulo() : 'biometria');
  const texto = (el, t) => { if (el) el.textContent = t; };

  async function plataformaPronta() {
    if (!window.PublicKeyCredential || typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return null;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) {
      console.warn('face-id: não consegui saber se o aparelho tem biometria:', e.message);
      return null;
    }
  }

  async function pinta() {
    const r = rotulo();
    texto($('fiTituloAparelho'), 'Neste aparelho');
    const plataforma = await plataformaPronta();
    const amb = notasDoAmbiente({ seguro: window.isSecureContext !== false, temApi: !!(window.PublicKeyCredential && navigator.credentials), plataforma, rotulo: r, host: location.host, ambienteErro: estado && estado.ambiente_erro });
    $('fiNotas').innerHTML = amb.notas.map((n) => '<div class="fi-nota" role="note"><b>' + esc(n.titulo) + '</b>' + esc(n.texto) + '</div>').join('');
    const ligado = !!(estado && estado.neste_aparelho);
    let status;
    if (estado && estado.aviso) status = 'O arquivo das passkeys no servidor está ilegível, então o Face ID está indisponível. Entre com a senha e peça ao Admin para conferir o arquivo passkeys.json. Detalhe: ' + estado.aviso;
    else if (ligado) status = 'O ' + r + ' está ligado neste aparelho. A tela trava depois de ' + estado.trava_min + ' min sem uso.';
    else status = 'O ' + r + ' não está ligado neste aparelho.';
    texto($('fiStatus'), status);
    const temAqui = forcaVincular || passkeys.some((p) => p.rp_id === (estado && estado.host));
    const bt = botoesDaTela({ ligado, temPasskeyAqui: temAqui, rotulo: r });
    $('fiVincular').hidden = !bt.vincular || !amb.podeLigar;
    $('fiVincular').disabled = ocupado || !!(estado && estado.aviso);
    $('fiLigar').textContent = bt.ligarTexto;
    $('fiLigar').className = 'fi-btn' + (bt.ligarPrincipal ? ' pri' : '');
    $('fiLigar').disabled = !amb.podeLigar || ocupado || !!(estado && estado.aviso);
    $('fiCampoNome').hidden = !amb.podeLigar;
    if (!$('fiNome').value) $('fiNome').value = nomeSugerido(navigator.userAgent);
    texto($('fiHost'), estado && estado.host ? 'Você abriu o painel por ' + estado.host + '. É para esse endereço que a passkey é criada.' : 'Você abriu o painel por ' + location.host + '.');
    $('fiItens').innerHTML = listaHtml(passkeys, Date.now(), editando);
    $('fiMinutos').innerHTML = opcoesMinutos(estado ? estado.trava_min : 15);
    if (amb.podeLigar) { preBuscaOpcoes(); if (bt.vincular) preBuscaOpcoesAparelho(); }
  }

  async function carrega() {
    const r = await chamar('GET', '/api/v1/cadeado/passkeys');
    if (!r.ok) {
      if (r.status === 423) return;     // a tela do cadeado cobre tudo; ao destravar a página recarrega
      msg('fiMsgGeral', 'Não consegui carregar o Face ID: ' + r.erro, 'erro');
      $('fiItens').innerHTML = '<p class="fi-vazio">Não carregou.</p>';
      return;
    }
    msg('fiMsgGeral', '');
    estado = r.json.estado; passkeys = r.json.passkeys;
    await pinta();
  }

  /* No iPhone o navegador só abre o Face ID de dentro do toque: as opções (o desafio) são buscadas antes. */
  async function preBuscaOpcoes() {
    if (opcoes && Date.now() - opcoesEm < OPCOES_VALIDADE_MS) return;
    const r = await chamar('GET', '/api/v1/cadeado/cadastro/opcoes');
    if (!r.ok) { opcoes = null; if (r.status !== 423) msg('fiMsgAparelho', r.erro, 'erro'); return; }
    opcoes = r.json.publicKey; opcoesEm = Date.now();
  }

  async function preBuscaOpcoesAparelho() {
    if (opcoesAp && Date.now() - opcoesApEm < OPCOES_VALIDADE_MS) return;
    const r = await chamar('GET', '/api/v1/cadeado/aparelho/opcoes');
    if (!r.ok) { opcoesAp = null; if (r.status !== 423 && r.status !== 404) msg('fiMsgAparelho', r.erro, 'erro'); return; }
    opcoesAp = r.json.publicKey; opcoesApEm = Date.now();
  }

  /* Liga ESTE aparelho a uma passkey que a pessoa já tem (sem criar outra): confirma com ela e o servidor guarda o aparelho. */
  function vincular() {
    if (ocupado) return;
    if (!T || !T.temApi()) { msg('fiMsgAparelho', 'Este navegador não tem ' + rotulo() + ' para sites.', 'erro'); return; }
    if (!opcoesAp || Date.now() - opcoesApEm > OPCOES_VALIDADE_MS + 40000) {
      msg('fiMsgAparelho', 'Ainda estou preparando o pedido ao servidor. Toque de novo em um instante.', 'erro');
      preBuscaOpcoesAparelho();
      return;
    }
    ocupado = true;
    $('fiVincular').disabled = true; $('fiLigar').disabled = true;
    msg('fiMsgAparelho', 'Aguardando ' + T.comArtigo() + '…', '');
    const op = opcoesAp; opcoesAp = null;
    navigator.credentials.get({ publicKey: T.publicKeyGet(op) }).then((cred) => {
      if (!cred) throw new Error('O aparelho não devolveu a passkey.');
      return chamar('POST', '/api/v1/cadeado/aparelho', { credencial: T.credParaJson(cred) });
    }).then((r) => {
      if (!r.ok) { const e = new Error(r.erro); e.servidor = true; throw e; }
      forcaVincular = false;
      msg('fiMsgAparelho', 'Pronto: a sua passkey agora vale neste aparelho. Ele trava depois de ' + r.json.estado.trava_min + ' min sem uso, e a senha continua valendo.', 'ok');
    }).catch((e) => {
      msg('fiMsgAparelho', e.servidor ? 'O servidor recusou: ' + e.message : T.traduz(e, 'destravar'), 'erro');
    }).then(async () => { ocupado = false; await carrega(); });
  }

  function ligar() {
    if (ocupado) return;
    if (!T || !T.temApi()) { msg('fiMsgAparelho', 'Este navegador não tem ' + rotulo() + ' para sites.', 'erro'); return; }
    if (!opcoes || Date.now() - opcoesEm > OPCOES_VALIDADE_MS + 40000) {
      msg('fiMsgAparelho', 'Ainda estou preparando o pedido ao servidor. Toque de novo em um instante.', 'erro');
      preBuscaOpcoes();
      return;
    }
    ocupado = true;
    $('fiLigar').disabled = true;
    msg('fiMsgAparelho', 'Aguardando ' + T.comArtigo() + '…', '');
    const op = opcoes; opcoes = null;   // desafio de uso único
    navigator.credentials.create({ publicKey: T.publicKeyCreate(op) }).then((cred) => {
      if (!cred) throw new Error('O aparelho não devolveu a passkey.');
      return chamar('POST', '/api/v1/cadeado/cadastro', { nome: $('fiNome').value.trim() || nomeSugerido(navigator.userAgent), credencial: T.credParaJson(cred) });
    }).then(async (r) => {
      if (!r.ok) { const e = new Error(r.erro); e.servidor = true; throw e; }
      msg('fiMsgAparelho', 'Pronto: o ' + rotulo() + ' está ligado neste aparelho. Ele trava depois de ' + r.json.estado.trava_min + ' min sem uso, e a senha continua valendo.', 'ok');
    }).catch((e) => {
      if (!e.servidor && e.name === 'InvalidStateError') {
        // O aparelho já tem uma passkey deste endereço (por exemplo, sincronizada pelo iCloud): o caminho é usá-la, não criar outra.
        forcaVincular = true;
        msg('fiMsgAparelho', 'Este aparelho já tem uma passkey do DG Claw (talvez sincronizada pela sua conta). Toque em "Usar minha passkey neste aparelho" em vez de criar outra.', 'erro');
      } else {
        msg('fiMsgAparelho', e.servidor ? 'O servidor recusou: ' + e.message : T.traduz(e, 'cadastrar'), 'erro');
      }
    }).then(async () => { ocupado = false; await carrega(); });
  }

  async function aoClicarLista(ev) {
    const b = ev.target.closest('[data-acao]');
    if (!b) return;
    const item = b.closest('[data-id]');
    const id = item.dataset.id;
    const acao = b.dataset.acao;
    if (acao === 'renomear') { editando = id; await pinta(); const campo = document.querySelector('[data-nome]'); if (campo) campo.select(); return; }
    if (acao === 'cancelar-nome') { editando = null; await pinta(); return; }
    if (acao === 'salvar-nome') {
      const nome = item.querySelector('[data-nome]').value.trim();
      if (!nome) { msg('fiMsgLista', 'Digite um nome para o aparelho.', 'erro'); return; }
      b.disabled = true;
      const r = await chamar('PATCH', '/api/v1/cadeado/passkeys/' + encodeURIComponent(id), { nome });
      b.disabled = false;
      if (!r.ok) { msg('fiMsgLista', r.erro, 'erro'); return; }
      editando = null; msg('fiMsgLista', 'Nome salvo.', 'ok'); await carrega(); return;
    }
    if (acao === 'remover') {
      if (b.dataset.confirma !== '1') { b.dataset.confirma = '1'; b.textContent = 'Toque de novo para remover'; return; }
      b.disabled = true;
      const r = await chamar('DELETE', '/api/v1/cadeado/passkeys/' + encodeURIComponent(id));
      if (!r.ok) { b.disabled = false; msg('fiMsgLista', r.erro, 'erro'); return; }
      msg('fiMsgLista', 'Aparelho removido.' + (r.json.sessoes_encerradas ? ' As sessões abertas nele foram encerradas e voltam ao login.' : ' Nele o Face ID deixa de existir e só a senha vale.'), 'ok');
      await carrega();
    }
  }

  async function salvarTempo() {
    const n = Number($('fiMinutos').value);
    $('fiSalvarTempo').disabled = true;
    const r = await chamar('PUT', '/api/v1/cadeado/ajustes', { trava_min: n });
    $('fiSalvarTempo').disabled = false;
    if (!r.ok) { msg('fiMsgTempo', r.erro, 'erro'); return; }
    msg('fiMsgTempo', 'Salvo: a tela trava depois de ' + n + (n === 1 ? ' minuto' : ' minutos') + ' sem uso.', 'ok');
    await carrega();
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    msg('fiMsgGeral', 'A visita guiada não carregou. Recarregue a página e tente de novo.', 'erro');
  }
  function tutorial() { comTour(() => raiz.DGTour.inicia({ passos: passosPagina(rotulo()) })); }
  function ajuda(chave) { comTour(() => raiz.DGTour.inicia({ passos: [PASSOS[chave]] })); }

  function inicia() {
    document.querySelectorAll('[data-fi-ajuda]').forEach((b) => { b.onclick = () => ajuda(b.dataset.fiAjuda); });
    $('fiLigar').onclick = ligar;
    $('fiVincular').onclick = vincular;
    $('fiSalvarTempo').onclick = salvarTempo;
    $('fiItens').addEventListener('click', aoClicarLista);
    setInterval(() => { if (document.visibilityState === 'visible' && !ocupado && !$('fiLigar').disabled) preBuscaOpcoes(); }, 35000);
    carrega();
  }
  if (!T) console.error('face-id: o trava.js não carregou, então a tela não consegue ligar o Face ID. Recarregue a página.');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia); else inicia();

  return { tutorial, botoesDaTela, nomeSugerido, notasDoAmbiente, quando, itemHtml, listaHtml, opcoesMinutos, passosPagina, PASSOS, MINUTOS };
});
