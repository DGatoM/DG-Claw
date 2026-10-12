'use strict';
// Microfone e voz. Só funcionam com chave no web.env:
//   ELEVENLABS_API_KEY (transcrever e falar) ou OPENAI_API_KEY (só transcrever).
// Sem chave a rota responde 503 com o motivo e a tela esconde os botões.

const ELEVEN = 'https://api.elevenlabs.io';
const TETO_TTS = 4500;

function criarVoz({ env, log }) {
  const temEleven = !!env.ELEVENLABS_API_KEY;
  const temOpenai = !!env.OPENAI_API_KEY;

  const semChaveFala = 'A voz do agente está desligada: falta ELEVENLABS_API_KEY no web.env (e uma voz em "voz" no registro do agente ou ELEVENLABS_VOICE_ID).';
  const semChaveMic = 'O microfone está desligado: falta ELEVENLABS_API_KEY ou OPENAI_API_KEY no web.env.';

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
    microfone: temEleven || temOpenai,
    vozDoAgente(agente) { return temEleven && !!(agente.voz || env.ELEVENLABS_VOICE_ID); },
    semChaveFala, semChaveMic,

    /** { texto } ou { erro, status } */
    async transcrever(dados, nomeArquivo, mime) {
      if (!(temEleven || temOpenai)) return { erro: semChaveMic, status: 503 };
      const fd = new FormData();
      fd.append('file', new Blob([dados], { type: mime || 'audio/mp4' }), nomeArquivo || 'audio.m4a');
      let r;
      if (temEleven) {
        fd.append('model_id', 'scribe_v1');
        r = await chama('transcrição (ElevenLabs)', `${ELEVEN}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: fd });
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

    /** { audio:Buffer } ou { erro, status } */
    async falar(agente, texto, vozPedida) {
      if (!this.vozDoAgente(agente) && !(temEleven && vozPedida)) return { erro: semChaveFala, status: 503 };
      const voz = vozPedida || agente.voz || env.ELEVENLABS_VOICE_ID;
      if (!/^[A-Za-z0-9]{10,40}$/.test(voz)) return { erro: `O id de voz ${JSON.stringify(String(voz).slice(0, 40))} não vale (letras e números, 10 a 40 caracteres).`, status: 400 };
      let limpo = String(texto || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_`#>~|]/g, '')
        .replace(/\s+/g, ' ').trim();
      if (!limpo) return { erro: 'Depois de tirar formatação e links não sobrou nada para falar.', status: 400 };
      const cortado = limpo.length > TETO_TTS;
      if (cortado) limpo = `${limpo.slice(0, TETO_TTS).trimEnd()}...`;
      const r = await chama('voz (ElevenLabs)', `${ELEVEN}/v1/text-to-speech/${voz}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: limpo, model_id: 'eleven_multilingual_v2' }),
      });
      if (r.erro) return r;
      return { audio: Buffer.from(await r.resposta.arrayBuffer()), chars: limpo.length, cortado };
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

module.exports = { criarVoz };
