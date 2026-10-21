'use strict';
// Microfone e voz. Só funcionam com chave no web.env:
//   ELEVENLABS_API_KEY (transcrever e falar), GROQ_API_KEY (só transcrever, plano grátis)
//   ou OPENAI_API_KEY (só transcrever). Na transcrição a ordem é ElevenLabs, Groq, OpenAI.
// Sem chave a rota responde 503 com o motivo e a tela esconde os botões.

const ELEVEN = 'https://api.elevenlabs.io';
const TTS_MAX_CHARS = 1200;     // tamanho máximo de cada pedaço de voz (a resposta inteira é lida, em pedaços)
const TTS_PRIMEIRO_CHARS = 450; // o 1º pedaço é menor: a voz começa a tocar mais cedo
const TTS_MAX_PARTES = 40;      // trava contra texto absurdo (cota de custo da ElevenLabs)

/** Tira o que é para o olho e não para o ouvido. Preserva as quebras de parágrafo (o fatiamento precisa delas). */
function limparParaTts(texto) {
  return String(texto || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[ \t]*\|.*$/gm, '')          // linha de tabela não é fala
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Quebra o texto já limpo em pedaços para a voz, sem cortar frase no meio: junta parágrafos e frases
 * enquanto couberem, frase grande demais quebra no último espaço e, sem espaço, no meio. O 1º pedaço usa
 * o limite menor. Determinístico: a tela pede cada pedaço pelo índice e precisa que o texto dê sempre os mesmos.
 */
function fatiarParaTts(textoLimpo, limite = TTS_MAX_CHARS, primeiro = TTS_PRIMEIRO_CHARS) {
  const atomos = []; // { t, fimPar }
  for (const par of String(textoLimpo || '').split(/\n\s*\n/)) {
    const frases = par.trim().split(/(?<=[.!?…])\s+/).map((f) => f.trim()).filter(Boolean);
    frases.forEach((frase, i) => {
      let f = frase;
      for (;;) {
        const teto = atomos.length ? limite : primeiro;
        if (f.length <= teto) break;
        let corte = f.lastIndexOf(' ', teto);
        if (corte < teto / 2) corte = teto;
        atomos.push({ t: f.slice(0, corte).trim(), fimPar: false });
        f = f.slice(corte).trim();
      }
      atomos.push({ t: f, fimPar: i === frases.length - 1 });
    });
  }
  const pedacos = [];
  let atual = '';
  for (const { t, fimPar } of atomos) {
    const teto = pedacos.length ? limite : primeiro;
    const junto = atual ? `${atual} ${t}` : t;
    if (atual && junto.length > teto) { pedacos.push(atual); atual = t; } else atual = junto;
    if (fimPar && atual) atual += '\n';
  }
  if (atual.trim()) pedacos.push(atual);
  return pedacos.map((p) => p.trim()).filter(Boolean);
}

function criarVoz({ env, log }) {
  const temEleven = !!env.ELEVENLABS_API_KEY;
  const temOpenai = !!env.OPENAI_API_KEY;
  const temGroq = !!env.GROQ_API_KEY;

  const semChaveFala = 'A voz do agente está desligada: falta ELEVENLABS_API_KEY no web.env (e uma voz em "voz" no registro do agente ou ELEVENLABS_VOICE_ID).';
  const semChaveMic = 'O microfone está desligado: falta GROQ_API_KEY (grátis), ELEVENLABS_API_KEY ou OPENAI_API_KEY no web.env.';

  async function chama(nome, url, init) {
    let r;
    try {
      r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(60000) }, init));
    } catch (e) {
      log('erro', `${nome}: não consegui falar com o serviço (${e.name}: ${e.message}).`);
      return { erro: `Não consegui falar com o serviço de ${nome} (${e.name === 'TimeoutError' ? 'demorou demais' : e.message}). Tente de novo em instantes.`, status: 502 };
    }
    if (!r.ok) {
      let detalhe = '';
      try { detalhe = (await r.text()).slice(0, 200).replace(/\s+/g, ' '); } catch (_) { /* sem corpo */ }
      log('erro', `${nome}: o serviço respondeu HTTP ${r.status}${detalhe ? ` (${detalhe})` : ''}.`);
      const status = r.status === 401 || r.status === 403 ? 502 : (r.status === 402 || r.status === 429 ? 429 : 502);
      const dica = r.status === 401 || r.status === 403 ? ' A chave do web.env foi recusada: confira se está certa.' : (r.status === 402 || r.status === 429 ? ' Talvez o limite ou o crédito da conta tenha acabado.' : '');
      return { erro: `O serviço de ${nome} recusou o pedido (HTTP ${r.status}).${dica}`, status };
    }
    return { resposta: r };
  }

  return {
    microfone: temEleven || temGroq || temOpenai,
    vozDoAgente(agente) { return temEleven && !!(agente.voz || env.ELEVENLABS_VOICE_ID); },
    semChaveFala, semChaveMic,

    /** { texto } ou { erro, status } */
    async transcrever(dados, nomeArquivo, mime) {
      if (!(temEleven || temGroq || temOpenai)) return { erro: semChaveMic, status: 503 };
      const fd = new FormData();
      fd.append('file', new Blob([dados], { type: mime || 'audio/mp4' }), nomeArquivo || 'audio.m4a');
      let r;
      if (temEleven) {
        fd.append('model_id', 'scribe_v1');
        r = await chama('transcrição (ElevenLabs)', `${ELEVEN}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: fd });
      } else if (temGroq) {
        // O Cloudflare da Groq bloqueia o User-Agent padrão do fetch, por isso o próprio.
        fd.append('model', 'whisper-large-v3-turbo');
        fd.append('language', 'pt');
        r = await chama('transcrição (Groq)', 'https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'User-Agent': 'DGClaw/1.0' }, body: fd });
      } else {
        fd.append('model', 'whisper-1');
        fd.append('language', 'pt');
        r = await chama('transcrição (OpenAI)', 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd });
      }
      if (r.erro) return r;
      let j;
      try { j = await r.resposta.json(); } catch (_) { return { erro: 'O serviço de transcrição respondeu algo que não é JSON.', status: 502 }; }
      const texto = typeof j.text === 'string' ? j.text.trim() : '';
      if (!texto) return { erro: 'Não ouvi nenhuma fala nesse áudio. Grave de novo, mais perto do microfone.', status: 422 };
      return { texto };
    },

    /** { audio:Buffer, chars, partes, parte } ou { erro, status }. `parte` (0 a partes-1) é o pedaço pedido. */
    async falar(agente, texto, vozPedida, parte = 0) {
      if (!this.vozDoAgente(agente) && !(temEleven && vozPedida)) return { erro: semChaveFala, status: 503 };
      const voz = vozPedida || agente.voz || env.ELEVENLABS_VOICE_ID;
      if (!/^[A-Za-z0-9]{10,40}$/.test(voz)) return { erro: `O id de voz ${JSON.stringify(String(voz).slice(0, 40))} não vale (letras e números, 10 a 40 caracteres).`, status: 400 };
      const limpo = limparParaTts(texto);
      if (!limpo) return { erro: 'Depois de tirar formatação, tabelas e links não sobrou nada para falar.', status: 400 };
      const pedacos = fatiarParaTts(limpo);
      if (pedacos.length > TTS_MAX_PARTES) {
        return { erro: `O texto rende ${pedacos.length} pedaços de voz e o limite é ${TTS_MAX_PARTES} (para não estourar a cota da ElevenLabs). Mande um trecho menor.`, status: 413 };
      }
      if (!Number.isInteger(parte) || parte < 0 || parte >= pedacos.length) {
        return { erro: `O texto tem ${pedacos.length} pedaço(s) de voz, numerados de 0 a ${pedacos.length - 1}. Pediu o ${JSON.stringify(parte)}.`, status: 400 };
      }
      const pedaco = pedacos[parte];
      const r = await chama('voz (ElevenLabs)', `${ELEVEN}/v1/text-to-speech/${voz}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: pedaco, model_id: 'eleven_multilingual_v2' }),
      });
      if (r.erro) return r;
      return { audio: Buffer.from(await r.resposta.arrayBuffer()), chars: pedaco.length, partes: pedacos.length, parte };
    },

    async cota() {
      if (!temEleven) return { erro: semChaveFala, status: 503 };
      const r = await chama('cota de voz (ElevenLabs)', `${ELEVEN}/v1/user/subscription`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
      if (r.erro) return r;
      let j;
      try { j = await r.resposta.json(); } catch (_) { return { erro: 'O serviço de voz respondeu a cota num formato inesperado.', status: 502 }; }
      const usado = Number(j.character_count); const limite = Number(j.character_limit);
      if (!Number.isFinite(usado) || !Number.isFinite(limite) || limite <= 0) return { erro: 'O serviço de voz não informou a cota (campos character_count e character_limit ausentes).', status: 502 };
      return { usado, limite, pct: Math.round((usado / limite) * 1000) / 10 };
    },
  };
}

module.exports = { criarVoz, limparParaTts, fatiarParaTts, TTS_MAX_CHARS, TTS_PRIMEIRO_CHARS, TTS_MAX_PARTES };
