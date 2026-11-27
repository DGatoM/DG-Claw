'use strict';
const dgUiText_trocar_senha_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgUiLabel_trocar_senha_js = (el, fonte, atributo, valores) => { if (globalThis.DGI18n) globalThis.DGI18n.rotulo(el, fonte, atributo, valores); else { const texto = fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m, k) => valores && Object.hasOwn(valores, k) ? String(valores[k]) : m); if (atributo) el.setAttribute(atributo, texto); else el.textContent = texto; } };
const dgTexto_trocar_senha = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
/* trocar-senha.js: a tela em que o colaborador troca a senha temporária pela dele (POST /api/v1/eu/senha).
   Sem a senha temporária pendente, a mesma tela troca a senha comum e pede também a atual. */
(function () {
  const $ = id => document.getElementById(id);
  let MIN = 10;
  const MAX = 128;
  let pendente = true;
  let dono = false; /* o dono troca a senha do painel pela rota /api/v1/dono/senha; sempre pede a atual */

  function mostraErro(texto, valores) {
    const e = $('erro');
    if (valores !== undefined) dgUiLabel_trocar_senha_js(e, texto, null, valores);
    else { dgUiLabel_trocar_senha_js(e, ''); e.textContent = texto || ''; }
    e.hidden = !texto;
  }

  async function chama(metodo, url, corpo) {
    let r;
    try {
      r = await fetch(url, {
        method: metodo, cache: 'no-store', credentials: 'same-origin',
        headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined,
      });
    } catch (e) {
      throw new Error(dgUiText_trocar_senha_js("Não consegui falar com o servidor (") + e.message + dgUiText_trocar_senha_js("). Confira a internet e tente de novo."));
    }
    if (r.status === 401) { location.href = '/login'; throw new Error(dgUiText_trocar_senha_js("Sua sessão acabou. Entre de novo.")); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || (dgUiText_trocar_senha_js('O servidor respondeu ') + r.status + dgUiText_trocar_senha_js('. Tente de novo; se repetir, avise o dono do ') + (typeof dsMarca !== 'undefined' ? dsMarca.nome : 'DG Claw') + '.'));
    return d;
  }

  async function inicia() {
    try {
      const eu = await chama('GET', '/api/v1/eu');
      dono = eu.papel !== 'colaborador';
      pendente = dono ? false : !!eu.trocar_senha;
    } catch (e) { mostraErro(e.message); return; }
    if (!pendente) {
      $('tsAtualBloco').hidden = false;
      $('tsAtual').required = true;
      dgUiLabel_trocar_senha_js($('tsSub'), "Para trocar a sua senha, digite a atual e escolha a nova.", null);
    }
    if (dono) {
      dgUiLabel_trocar_senha_js(document.querySelector('h1'), 'Trocar senha');
      dgUiLabel_trocar_senha_js($('tsEnviar'), 'Salvar');
      MIN = 12;
      $('tsNova').minLength = MIN;
      dgUiLabel_trocar_senha_js($('tsDica'), 'De {min} a {max} caracteres. Uma frase longa funciona bem. Ao salvar, as outras sessões abertas saem.', null, {min:MIN,max:MAX});
      dgUiLabel_trocar_senha_js($('tsSub'), 'Digite a senha atual e escolha a nova. Os outros aparelhos em que você está logado vão precisar entrar de novo.');
      $('tsVoltar').hidden = false;
    }
  }

  /* Cada erro diz qual é o problema e o que fazer, antes de ir ao servidor. */
  function confere(nova, conf, atual) {
    const tam = [...nova.normalize('NFKC')].length; // mesma conta do servidor
    if (!pendente && !atual) return { fonte: 'Digite a senha atual.', valores: {} };
    if (tam < MIN) return { fonte: 'A senha nova tem {tam} caracteres e precisa de pelo menos {min}. Use uma frase mais longa.', valores: {tam,min:MIN} };
    if (tam > MAX) return { fonte: 'A senha nova passa de {max} caracteres. Escolha uma mais curta.', valores: {max:MAX} };
    if (nova !== conf) return { fonte: 'A confirmação não é igual à senha nova. Digite as duas de novo.', valores: {} };
    return null;
  }

  $('tsForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    mostraErro('');
    const nova = $('tsNova').value, conf = $('tsConf').value, atual = $('tsAtual').value;
    const problema = confere(nova, conf, atual);
    if (problema) { mostraErro(problema.fonte, problema.valores); return; }
    const b = $('tsEnviar');
    b.disabled = true; dgUiLabel_trocar_senha_js(b, 'Salvando…');
    try {
      const corpo = { nova, confirmacao: conf };
      if (!pendente) corpo.atual = atual;
      const d = await chama('POST', dono ? '/api/v1/dono/senha' : '/api/v1/eu/senha', corpo);
      location.href = d.destino || '/';
    } catch (e) {
      mostraErro(e.message);
      b.disabled = false; dgUiLabel_trocar_senha_js(b, dono ? "Salvar" : "Salvar e entrar", null, {});
    }
  });

  const PASSOS = () => [
    ...(!pendente ? [{ alvo: '[data-tour="ts-atual"]', titulo: 'A senha atual',
      oque: 'O campo em que você digita a senha que usa hoje.',
      como: 'O servidor confere a senha atual antes de aceitar a nova. Erros seguidos bloqueiam novas tentativas por alguns minutos.',
      porque: 'Se alguém pegar o seu aparelho aberto, não consegue trocar a sua senha sem saber a atual.' }] : []),
    { alvo: '[data-tour="ts-cartao"]', titulo: 'Criar a sua senha',
      oque: 'A tela em que você troca a senha temporária do convite por uma senha só sua.',
      como: 'Você entrou com a senha que veio no convite. Ela serve uma vez só: depois de salvar a nova, a temporária deixa de valer e você entra direto na conversa com o seu agente.',
      porque: 'Quem mandou o convite (e o e-mail ou a mensagem onde ele chegou) conhece a temporária. A senha nova só você sabe.' },
    { alvo: '[data-tour="ts-nova"]', titulo: 'A senha nova',
      oque: 'O campo da senha que você vai usar daqui para a frente.',
      get como() { return dgUiText_trocar_senha_js("Precisa ter de ") + MIN + ' a ' + MAX + dgUiText_trocar_senha_js(" caracteres e ser diferente da temporária. Uma frase longa é fácil de lembrar e difícil de adivinhar."); },
      get porque() { return dgUiText_trocar_senha_js("O tamanho protege mais que símbolos esquisitos. Se esquecer, o dono do ") + (typeof dsMarca !== 'undefined' ? dsMarca.nome : 'DG Claw') + ' manda um convite novo.'; } },
    { alvo: '[data-tour="ts-conf"]', titulo: 'Repetir a senha',
      oque: 'O mesmo texto da senha nova, escrito de novo.',
      como: 'Se as duas não forem iguais, a tela avisa antes de enviar e nada é salvo.',
      porque: 'Senha digitada errada trancaria você do lado de fora sem você perceber.' },
    { alvo: '[data-tour="ts-enviar"]', titulo: 'Salvar e entrar',
      oque: 'O botão que grava a senha nova.',
      como: 'Se tudo estiver certo, você é levado para a conversa com o seu agente. Se algo estiver errado, o motivo aparece em vermelho acima dos campos.',
      porque: 'É o último passo antes de começar a usar.' },
  ];
  $('tsTutorial').addEventListener('click', () => {
    if (!window.DGTour) { mostraErro(dgUiText_trocar_senha_js("A visita guiada não carregou. Recarregue a página e tente de novo.")); return; }
    window.DGTour.inicia({ passos: PASSOS().filter(p => { const e = document.querySelector(p.alvo); return e && e.offsetParent !== null; }) });
  });

  inicia();
})();
