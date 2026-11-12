'use strict';
/* avisos-aparelho.js: liga e desliga os avisos (web push) neste aparelho. Sem dependências.
   Expõe window.DGClawAvisos = { suportado, estado, ativar, desativar, testar, preferencias, salvarPreferencia }.
   Quem desenha o botão chama estas funções; nada aqui mexe na tela.
   Toda função que pode falhar devolve { ok:false, erro:"frase em português com o que fazer" }.
   Contrato das rotas: web/docs/AVISOS-NO-APARELHO.md. */
(function () {
  const TEXTO_IPHONE = 'No iPhone, os avisos só funcionam com o DG Claw instalado na tela de início: toque em Compartilhar, Adicionar à Tela de Início, abra por lá e ative de novo.';

  const ehIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalado = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const iphoneSemInstalar = () => ehIos() && !instalado();

  function suportado() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function chaveParaBytes(b64url) {
    const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function mesmaChave(a, b) {
    if (!a || a.byteLength !== b.length) return false;
    const va = new Uint8Array(a);
    return b.every((x, i) => x === va[i]);
  }

  /** Chama a API do Web e devolve { ok, status, json }. Falha de rede vira { ok:false, erro }. */
  async function chamar(metodo, caminho, corpo) {
    let resp;
    try {
      resp = await fetch(caminho, {
        method: metodo,
        credentials: 'same-origin',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) {
      return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.' };
    }
    let json = null;
    try { json = await resp.json(); } catch (e) { console.warn('avisos: a resposta de ' + caminho + ' não veio em JSON:', e.message); }
    if (!resp.ok) {
      const motivo = json && json.erro ? json.erro : 'O servidor respondeu ' + resp.status + ' em ' + caminho + '.';
      return { ok: false, status: resp.status, erro: motivo, json };
    }
    return { ok: true, status: resp.status, json: json || {} };
  }

  async function registroDoSw() {
    return (await navigator.serviceWorker.getRegistration('/sw.js')) || navigator.serviceWorker.register('/sw.js');
  }

  async function assinaturaAtual() {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    return reg ? reg.pushManager.getSubscription() : null;
  }

  /** 'ativo' | 'inativo' | 'negado' | 'sem-suporte' | 'iphone-precisa-instalar' */
  async function estado() {
    if (iphoneSemInstalar()) return 'iphone-precisa-instalar';
    if (!suportado()) return 'sem-suporte';
    if (Notification.permission === 'denied') return 'negado';
    if (Notification.permission !== 'granted') return 'inativo';
    let sub;
    try { sub = await assinaturaAtual(); } catch (e) {
      console.warn('avisos: não consegui ler a inscrição deste aparelho:', e.message);
      return 'inativo';
    }
    if (!sub) return 'inativo';
    const r = await chamar('POST', '/api/v1/push/inscricoes/confere', { endpoint: sub.endpoint });
    if (!r.ok) {
      console.warn('avisos: não consegui conferir a inscrição no servidor, confio na do aparelho:', r.erro);
      return 'ativo';
    }
    return r.json.inscrito ? 'ativo' : 'inativo';
  }

  function nomeDoAparelho() {
    const ua = navigator.userAgent;
    const sistema = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Aparelho';
    const navegador = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return (sistema + (navegador ? ' ' + navegador : '')).slice(0, 60);
  }

  async function ativar(nomeAparelho) {
    if (iphoneSemInstalar()) return { ok: false, erro: TEXTO_IPHONE };
    if (!suportado()) return { ok: false, erro: 'Este navegador não aceita avisos. Use o Chrome, o Edge ou o Firefox no computador ou no Android, ou instale o DG Claw na tela de início do iPhone.' };
    if (Notification.permission === 'denied') {
      return { ok: false, erro: 'Os avisos estão bloqueados para este site. Libere nas configurações do navegador (ícone de cadeado ao lado do endereço, Notificações, Permitir) e ative de novo.' };
    }
    let permissao;
    try { permissao = await Notification.requestPermission(); } catch (e) {
      return { ok: false, erro: 'O navegador não conseguiu pedir a permissão de avisos (' + e.message + '). Tente de novo.' };
    }
    if (permissao !== 'granted') {
      return { ok: false, erro: 'A permissão de avisos não foi concedida. Toque em Ativar de novo e escolha Permitir quando o navegador perguntar.' };
    }
    const k = await chamar('GET', '/api/v1/push/chave');
    if (!k.ok) return { ok: false, erro: k.erro };
    const chave = chaveParaBytes(k.json.chave_publica);
    let sub;
    try {
      const reg = await registroDoSw();
      await navigator.serviceWorker.ready;
      sub = await reg.pushManager.getSubscription();
      if (sub && !mesmaChave(sub.options && sub.options.applicationServerKey, chave)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
    } catch (e) {
      return { ok: false, erro: 'Não consegui registrar este aparelho no serviço de avisos do navegador (' + e.message + '). Atualize a página e tente de novo; se continuar, confira se o navegador está atualizado.' };
    }
    const corpo = Object.assign({}, sub.toJSON(), { aparelho: (nomeAparelho || nomeDoAparelho()).slice(0, 60) });
    const r = await chamar('POST', '/api/v1/push/inscricoes', corpo);
    if (!r.ok) return { ok: false, erro: r.erro };
    return { ok: true, id: r.json.id, nova: !!r.json.nova };
  }

  async function desativar() {
    if (!suportado()) return { ok: true };
    let sub;
    try { sub = await assinaturaAtual(); } catch (e) {
      return { ok: false, erro: 'Não consegui ler a inscrição deste aparelho (' + e.message + '). Recarregue a página e tente de novo.' };
    }
    if (!sub) return { ok: true };
    const endpoint = sub.endpoint;
    const r = await chamar('POST', '/api/v1/push/inscricoes/remover', { endpoint });
    if (!r.ok && r.status !== 404) return { ok: false, erro: r.erro };
    try { await sub.unsubscribe(); } catch (e) {
      return { ok: false, erro: 'O servidor já esqueceu este aparelho, mas o navegador não conseguiu cancelar a inscrição (' + e.message + '). Limpe a permissão de notificações do site nas configurações do navegador.' };
    }
    return { ok: true };
  }

  async function testar() {
    let endpoint;
    try { const sub = await assinaturaAtual(); endpoint = sub ? sub.endpoint : undefined; } catch (e) {
      console.warn('avisos: teste para todos os aparelhos, não consegui ler o deste:', e.message);
    }
    const r = await chamar('POST', '/api/v1/push/teste', endpoint ? { endpoint } : {});
    if (!r.ok) return { ok: false, erro: r.erro };
    return { ok: true, enviados: r.json.enviados };
  }

  /** O que o dono quer receber no aparelho: { precisa_de_voce, terminou } (padrão: os dois ligados). */
  async function preferencias() {
    const r = await chamar('GET', '/api/v1/push/preferencias');
    if (!r.ok) return { ok: false, erro: r.erro };
    return { ok: true, preferencias: r.json.preferencias };
  }

  /** Liga ou desliga um tipo de aviso: salvarPreferencia('terminou', false). Vale para todos os aparelhos. */
  async function salvarPreferencia(tipo, ligado) {
    const r = await chamar('POST', '/api/v1/push/preferencias', { [tipo]: !!ligado });
    if (!r.ok) return { ok: false, erro: r.erro };
    return { ok: true, preferencias: r.json.preferencias };
  }

  window.DGClawAvisos = { suportado, estado, ativar, desativar, testar, preferencias, salvarPreferencia };
})();
