// Envio seguro: as travas contra banimento, valem para QUALQUER conexao de WhatsApp
// (a ponte Baileys, a Z-API, a Evolution, a API oficial). Quem envia passa pelo `enviar()`
// daqui e entrega a funcao que faz o envio de verdade; o modulo decide se pode, espera o
// intervalo certo e, no primeiro erro, trava tudo ate o dono liberar.
//
// Por que existe: o que derruba um numero e comportamento de robo (muitas mensagens de uma vez,
// texto igual, ritmo fixo). Conversa de verdade, com poucas mensagens, tem risco muito baixo.
// Os valores padrao e as fontes que os calibraram estao em docs/CANAL-WHATSAPP.md.
//
// O que fica no disco (pasta `dir`, 700): estado.json (600) com, por envio, so a hora, um hash
// do destino e um hash do texto. Nunca o numero, nunca o texto. E o arquivo PARADO (a trava).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { falha, motivoErro } from './util.mjs';

export const PADRAO = Object.freeze({
  // Disparo = 2 pessoas diferentes dentro desta janela. Abaixo disso e conversa: sem espera.
  janela_disparo_min: 60,
  pessoas_disparo: 2,
  // Num disparo, intervalo aleatorio e unico entre uma mensagem e a seguinte.
  intervalo_min_s: 8,
  intervalo_max_s: 20,
  // Rodada = sequencia de disparo sem pausa maior que `pausa_rodada_min`.
  teto_rodada: 30,
  pausa_rodada_min: 30,
  // Teto de mensagens nas ultimas 24 h, por agente, quando se esta em disparo.
  teto_dia: 60,
  // O mesmo texto nao vai para 2 pessoas dentro desta janela (so vale de `texto_minimo` letras).
  repetido_horas: 24,
  texto_minimo: 15,
  // Numero recem-conectado: data (AAAA-MM-DD) em que comecou. Aplica o aquecimento por dias.
  numero_novo_desde: null,
  // Maior espera que o envio aceita fazer de uma vez; acima disso devolve RITMO com o tempo restante.
  espera_max_s: 25,
});

// Pisos que a configuracao nao ultrapassa (o dono pode ir mais devagar, nao mais rapido).
const PISO_INTERVALO_S = 3;
const TETO_DIA_MAX = 500;
const TETO_RODADA_MAX = 100;

// Aquecimento de numero novo: teto de mensagens por dia (todas, nao so disparo), por idade do numero.
const AQUECIMENTO = [
  { ate_dia: 3, teto: 10 },
  { ate_dia: 7, teto: 30 },
  { ate_dia: 14, teto: 60 },
];

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

// Uma fila por pasta e o conjunto de travas que ESTE processo segura (valem entre instancias do mesmo processo).
const ESPERA_APOS_INCERTO_MS = 5 * 60 * 1000;
const FILAS = new Map();
const SEGURANDO = new Set();

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function normalizarTexto(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Junta o padrao com o que o dono pos em envio.json. Valor invalido NAO vira padrao em silencio. */
export function lerConfig(arquivo) {
  let bruto = null;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { erro: `nao consegui ler ${arquivo} (${motivoErro(e)}); confira a permissao do arquivo` };
    }
  }
  const cfg = { ...PADRAO };
  if (bruto != null) {
    let o;
    try {
      o = JSON.parse(bruto);
    } catch (e) {
      return { erro: `${arquivo} nao e um JSON valido (${motivoErro(e)}); corrija ou apague o arquivo para usar os valores padrao` };
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { erro: `${arquivo} tem que ser um objeto JSON, como {"intervalo_min_s": 10}` };
    for (const [k, v] of Object.entries(o)) {
      if (!(k in PADRAO)) return { erro: `${arquivo} tem a chave desconhecida "${String(k).slice(0, 40)}"; as validas sao: ${Object.keys(PADRAO).join(', ')}` };
      cfg[k] = v;
    }
  }
  return validar(cfg, arquivo);
}

function validar(c, arquivo) {
  const onde = arquivo ? ` em ${arquivo}` : '';
  const inteiro = (k, min, max) => (Number.isFinite(c[k]) && c[k] >= min && c[k] <= max
    ? null : `"${k}"${onde} tem que ser um numero entre ${min} e ${max} (veio ${JSON.stringify(c[k])})`);
  const erros = [
    inteiro('janela_disparo_min', 1, 24 * 60),
    inteiro('pessoas_disparo', 2, 50),
    inteiro('intervalo_min_s', PISO_INTERVALO_S, 3600),
    inteiro('intervalo_max_s', PISO_INTERVALO_S, 3600),
    inteiro('teto_rodada', 1, TETO_RODADA_MAX),
    inteiro('pausa_rodada_min', 1, 24 * 60),
    inteiro('teto_dia', 1, TETO_DIA_MAX),
    inteiro('repetido_horas', 1, 24 * 30),
    inteiro('texto_minimo', 1, 1000),
    inteiro('espera_max_s', 1, 300),
  ].filter(Boolean);
  if (!erros.length && c.intervalo_min_s > c.intervalo_max_s) {
    erros.push(`"intervalo_min_s" (${c.intervalo_min_s}) nao pode ser maior que "intervalo_max_s" (${c.intervalo_max_s})${onde}`);
  }
  const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === String(d);
  if (c.numero_novo_desde != null && !dataValida(c.numero_novo_desde)) {
    erros.push(`"numero_novo_desde"${onde} tem que ser uma data AAAA-MM-DD ou null (veio ${JSON.stringify(c.numero_novo_desde)})`);
  }
  return erros.length ? { erro: erros[0] } : { config: c };
}

function tetoAquecimento(c, agora) {
  if (!c.numero_novo_desde) return null;
  const inicio = Date.parse(`${c.numero_novo_desde}T00:00:00Z`);
  if (!Number.isFinite(inicio)) return null;
  const dia = Math.floor((agora - inicio) / DIA) + 1;
  for (const f of AQUECIMENTO) if (dia <= f.ate_dia) return { dia, teto: f.teto };
  return null;
}

function fmtEspera(ms) {
  const s = Math.ceil(ms / 1000);
  return s >= 120 ? `${Math.ceil(s / 60)} minutos` : `${s} segundos`;
}

/**
 * @param {object} o
 * @param {string} o.dir         pasta de estado (criada 700)
 * @param {string} o.arqConfig   envio.json do dono (opcional, pode nao existir)
 * @param {() => Date} [o.agora]
 * @param {(ms:number) => Promise<void>} [o.dormir]
 * @param {() => number} [o.aleatorio]  0 a 1
 * @param {(msg:string) => void} [o.registrar]  log sem segredo e sem corpo de mensagem
 */
export function criarEnvioSeguro({ dir, arqConfig, limiteExecucaoMs = 100000, agora = () => new Date(), dormir, aleatorio = Math.random, registrar = () => {} }) {
  const esperar = dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const arqEstado = path.join(dir, 'estado.json');
  const arqParado = path.join(dir, 'PARADO');
  const arqTrava = path.join(dir, 'envio.lock');
  const arqPendente = path.join(dir, 'PENDENTE'); // marcador: ha (ou houve) um envio cujo resultado nao se sabe
  let parouNaMemoria = null; // a trava vale mesmo se o disco recusar o arquivo PARADO

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  /** Arquivo ausente e historico vazio. Arquivo que existe e nao le NAO e vazio: recusa o envio (nao zera os contadores). */
  function lerEstado() {
    let bruto;
    try {
      bruto = fs.readFileSync(arqEstado, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { versao: 1, envios: [] };
      return { erro: `nao consegui ler ${arqEstado} (${motivoErro(e)})` };
    }
    try {
      const o = JSON.parse(bruto);
      if (o && Array.isArray(o.envios)) return o;
    } catch { /* cai no erro abaixo */ }
    return { erro: `${arqEstado} esta corrompido` };
  }

  function gravarEstado(o) {
    const tmp = `${arqEstado}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
    fs.renameSync(tmp, arqEstado);
  }

  /** A trava: dura ate o dono apagar o arquivo (comando "canal whatsapp retomar"). */
  function travar(motivo) {
    const quando = agora().toISOString();
    const texto = String(motivo).replace(/[\r\n]+/g, ' ').slice(0, 500);
    try {
      fs.writeFileSync(arqParado, JSON.stringify({ quando, motivo: texto }) + '\n', { mode: 0o600 });
    } catch (e) {
      parouNaMemoria = texto;
      registrar(`envio: NAO consegui gravar a trava ${arqParado} (${motivoErro(e)}); pare os envios na mao`);
    }
    registrar(`envio: TRAVADO, ${texto}`);
  }

  function paradoMotivo() {
    if (parouNaMemoria) return `${parouNaMemoria} (o arquivo PARADO nao pode ser gravado; reinicie para destravar depois de resolver)`;
    let s;
    try { s = fs.readFileSync(arqParado, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      return `o arquivo ${arqParado} existe mas nao consegui le-lo (${motivoErro(e)})`;
    }
    try { const o = JSON.parse(s); return `${o.motivo} (desde ${o.quando})`; } catch { return s.trim() || 'sem motivo registrado'; }
  }

  /** Marcador de envio sem resultado conhecido. So significa "interrompido" quando NINGUEM segura a trava (dentro dela, e). */
  const pendente = () => fs.existsSync(arqPendente);
  const MOTIVO_PENDENTE = 'um envio anterior nao terminou com resultado conhecido (a mensagem pode ou nao ter saido); confira no celular antes de liberar';

  function liberar() {
    parouNaMemoria = null;
    try { fs.unlinkSync(arqPendente); } catch { /* nao havia */ }
    try { fs.unlinkSync(arqParado); return true; } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  // Exclusao entre processos (a ponte e o script do agente podem mandar ao mesmo tempo).
  // O arquivo guarda o pid de quem a segura. Ela so e tomada de volta quando esse processo morreu:
  // idade nunca basta, porque um envio legitimo pode demorar (a espera do intervalo vem antes do envio).
  const viva = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  const arqRetomada = `${arqTrava}.retomada`;
  const filaDoDir = () => {
    const chave = path.resolve(dir);
    if (!FILAS.has(chave)) FILAS.set(chave, Promise.resolve());
    return chave;
  };

  /** Cria o arquivo ja com o pid dentro (link atomico): ninguem ve a trava vazia. */
  function criarTrava() {
    const tmp = `${arqTrava}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    try {
      fs.linkSync(tmp, arqTrava);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ja removido */ }
    }
  }

  /** Tira a trava de um dono morto. So um processo por vez faz isso (trava curta da retomada), e confere de novo la dentro. */
  function retomarTravaMorta() {
    try {
      // Criada ja com o pid dentro (link atomico): ninguem le a trava auxiliar vazia e a toma por abandonada.
      const tmp = `${arqRetomada}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
      try { fs.linkSync(tmp, arqRetomada); } finally { try { fs.unlinkSync(tmp); } catch { /* ja removido */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A trava auxiliar guarda o pid; so e removida quando esse processo morreu (nunca por idade).
      try {
        const d = Number(fs.readFileSync(arqRetomada, 'utf8').trim());
        if (d !== process.pid && !viva(d)) fs.unlinkSync(arqRetomada);
      } catch { /* outro resolveu */ }
      return;
    }
    try {
      let dono = NaN;
      try { dono = Number(fs.readFileSync(arqTrava, 'utf8').trim()); } catch { return; }
      const nossaSobra = dono === process.pid && !SEGURANDO.has(arqTrava);
      if (nossaSobra || !viva(dono)) { try { fs.unlinkSync(arqTrava); } catch { /* ja sumiu */ } }
    } finally {
      try { fs.unlinkSync(arqRetomada); } catch { /* ja removida */ }
    }
  }

  async function comTrava(fn) {
    const limite = Date.now() + 45000;
    for (;;) {
      try {
        criarTrava();
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        retomarTravaMorta();
        if (Date.now() > limite) return falha('OCUPADO', 'outro envio esta em andamento ha mais de 45 segundos; espere ele terminar e tente de novo');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    SEGURANDO.add(arqTrava);
    try { return await fn(); } finally { SEGURANDO.delete(arqTrava); try { fs.unlinkSync(arqTrava); } catch { /* ja removida */ } }
  }

  /**
   * Passa pelas travas e envia. `executar` faz o envio real e devolve o resultado (ou lanca).
   * Devolve { ok:true, resultado, disparo, esperou_ms } ou { ok:false, codigo, erro }.
   */
  function enviar({ para, texto = '', executar, prazoMs = null, conferir = null }) {
    // `prazoMs`: depois dele quem pediu ja desistiu; entao nao se envia mais (nada de mensagem "fantasma").
    const ate = prazoMs ? Date.now() + prazoMs : null;
    // A fila e por pasta: duas instancias deste processo na mesma pasta tambem entram uma de cada vez.
    const chave = filaDoDir();
    const minha = FILAS.get(chave).then(() => comTrava(() => tentar({ para, texto, executar, ate, conferir })));
    FILAS.set(chave, minha.catch(() => {}));
    return minha;
  }

  const expirou = (ate) => ate != null && Date.now() > ate;
  const EXPIRADO = () => falha('EXPIRADO', 'o pedido esperou na fila alem do prazo e NAO foi enviado; tente de novo, uma mensagem de cada vez');

  async function tentar({ para, texto, executar, ate, conferir }) {
    if (expirou(ate)) return EXPIRADO();
    const parado = paradoMotivo() || (pendente() ? MOTIVO_PENDENTE : null);
    if (parado) {
      return falha('PARADO', `os envios estao travados: ${parado}. Nao tente de novo: avise o dono, que confere o numero no celular e libera com "dgclaw-agente canal whatsapp retomar"`);
    }
    const lc = arqConfig ? lerConfig(arqConfig) : validar({ ...PADRAO });
    if (lc.erro) return falha('CONFIG_INVALIDA', `${lc.erro}. Nada foi enviado`);
    const c = lc.config;

    const t = agora().getTime();
    const est = lerEstado();
    if (est.erro) {
      return falha('ESTADO_INVALIDO', `${est.erro}; sem o historico as travas de ritmo ficariam cegas. Nada foi enviado. O dono confere o arquivo (se estiver corrompido, apagar e recomecar o historico) e tenta de novo`);
    }
    const envios = est.envios.filter((e) => t - e.t < DIA * 30 && t - e.t >= -MIN);
    // Grupo chega como "grupo:<id>": conta como UM destinatario e nunca colide com um numero (o ID tem mais digitos que um telefone).
    const pessoa = String(para).startsWith('grupo:') ? sha(String(para)) : sha(String(para).replace(/\D/g, '') || String(para));
    const norm = normalizarTexto(texto);
    const hTexto = norm.length >= c.texto_minimo ? sha(norm) : null;

    // 1. O mesmo texto para duas pessoas
    if (hTexto) {
      const repetido = envios.find((e) => e.h === hTexto && e.p !== pessoa && t - e.t < c.repetido_horas * HORA);
      if (repetido) {
        return falha('TEXTO_REPETIDO', `esse mesmo texto ja foi para outra pessoa nas ultimas ${c.repetido_horas} horas; texto igual para varias pessoas e o que mais derruba um numero. Reescreva a mensagem para esta pessoa, com o nome dela e o que e dela`);
      }
    }

    // 2. Aquecimento de numero novo (vale para todas as mensagens)
    const aq = tetoAquecimento(c, t);
    const ult24 = envios.filter((e) => t - e.t < DIA);
    if (aq && ult24.length >= aq.teto) {
      return falha('AQUECIMENTO', `o numero esta no dia ${aq.dia} de aquecimento e o teto de hoje e ${aq.teto} mensagens; ja foram ${ult24.length}. Continue amanha`);
    }

    // 3. Disparo ou conversa?
    const janela = envios.filter((e) => t - e.t < c.janela_disparo_min * MIN);
    const pessoas = new Set(janela.map((e) => e.p));
    pessoas.add(pessoa);
    const disparo = pessoas.size >= c.pessoas_disparo;
    let esperouMs = 0;

    if (disparo) {
      if (ult24.length >= c.teto_dia) {
        return falha('TETO_DIA', `o teto de ${c.teto_dia} mensagens em 24 horas foi atingido. Continue amanha, ou o dono sobe "teto_dia" em ${arqConfig || 'envio.json'} sabendo do risco`);
      }
      // Rodada: os envios de disparo seguidos, sem pausa maior que a pausa da rodada.
      const disp = envios.filter((e) => e.d).sort((a, b) => b.t - a.t);
      let n = 0;
      let anterior = t;
      for (const e of disp) {
        if (anterior - e.t >= c.pausa_rodada_min * MIN) break;
        n += 1;
        anterior = e.t;
      }
      if (n >= c.teto_rodada) {
        const faltam = disp[0].t + c.pausa_rodada_min * MIN - t;
        return falha('PAUSA_DA_RODADA', `a rodada chegou a ${c.teto_rodada} mensagens; descanse ${fmtEspera(faltam)} antes de continuar. Nao e erro: e a pausa que protege o numero`);
      }
      // Intervalo aleatorio desde a ultima mensagem
      const ultimo = envios.reduce((m, e) => Math.max(m, e.t), 0);
      const alvo = (c.intervalo_min_s + aleatorio() * (c.intervalo_max_s - c.intervalo_min_s)) * 1000;
      const falta = ultimo ? alvo - (t - ultimo) : 0;
      if (falta > c.espera_max_s * 1000) {
        return falha('RITMO', `a mensagem anterior saiu ha pouco; espere ${fmtEspera(falta)} e mande a proxima. Uma mensagem por chamada, sem pressa`);
      }
      if (falta > 0) {
        if (ate != null && Date.now() + falta > ate) return EXPIRADO();
        esperouMs = Math.ceil(falta);
        await esperar(esperouMs);
      }
    }

    // 4. Depois da espera o mundo pode ter mudado: confere de novo trava, prazo e autorizacao do destino.
    const parado2 = paradoMotivo();
    if (parado2) return falha('PARADO', `os envios foram travados enquanto este esperava: ${parado2}. Nada foi enviado`);
    if (expirou(ate)) return EXPIRADO();
    if (conferir) { const negado = conferir(); if (negado) return negado; }

    // 5. Envia. Qualquer erro trava tudo: continuar tentando e como um robo em panico.
    let resultado;
    // Marca antes de chamar o WhatsApp: se o processo morrer ou o disco recusar a trava depois, o marcador segura os envios.
    try {
      fs.writeFileSync(arqPendente, new Date(t).toISOString() + '\n', { mode: 0o600 });
    } catch (e) {
      return falha('ESTADO_INVALIDO', `nao consegui gravar ${arqPendente} (${motivoErro(e)}); sem isso nao ha como travar com seguranca depois de um erro. Nada foi enviado. Confira o espaco em disco e as permissoes`);
    }
    try {
      // Um envio que nunca responde nao pode segurar a vez para sempre: passado o limite, o resultado e incerto,
      // o PENDENTE fica, tudo trava e a fila segue (o dono confere o numero no celular).
      let relogio;
      const limite = new Promise((_, rej) => {
        relogio = setTimeout(() => rej(new Error(`sem resposta em ${Math.round(limiteExecucaoMs / 1000)} segundos; resultado incerto`)), limiteExecucaoMs);
      });
      try {
        resultado = await Promise.race([executar(), limite]);
      } finally {
        clearTimeout(relogio);
      }
    } catch (e) {
      travar(`o envio falhou (${motivoErro(e)}); pode ser desconexao ou bloqueio do numero`);
      return falha('FALHA_ENVIO', `o envio falhou (${motivoErro(e)}) e os envios ficaram TRAVADOS por seguranca. A mensagem pode ou nao ter saido: nao repita. Avise o dono, que confere o numero no celular e libera com "dgclaw-agente canal whatsapp retomar"`);
    }
    const agoraMs = agora().getTime();
    envios.push({ t: agoraMs, p: pessoa, h: hTexto, d: disparo });
    try {
      gravarEstado({ versao: 1, envios: envios.filter((e) => agoraMs - e.t < DIA * 30) });
      // So agora o resultado esta conhecido E contado: o marcador pode sair. Qualquer falha antes disso o preserva.
      try { fs.unlinkSync(arqPendente); } catch { /* ja removido */ }
    } catch (e) {
      // A mensagem JA saiu. Sem historico as travas de ritmo ficariam cegas, entao trava o resto.
      travar(`nao consegui gravar o historico de envios em ${arqEstado} (${motivoErro(e)}); confira o espaco em disco e as permissoes`);
      return { ok: true, resultado, disparo, esperou_ms: esperouMs, aviso: 'a mensagem saiu, mas os envios ficaram travados porque o historico nao pode ser gravado' };
    }
    return { ok: true, resultado, disparo, esperou_ms: esperouMs };
  }

  /** Libera PARADO e PENDENTE pela MESMA exclusao dos envios: nunca com um envio no ar. */
  async function liberarComTrava() {
    return comTrava(async () => {
      // Um envio que estourou o limite pode ainda estar a caminho (o transporte nao se cancela): espera um tempo antes de liberar.
      try {
        const idade = Date.now() - fs.statSync(arqPendente).mtimeMs;
        if (idade < ESPERA_APOS_INCERTO_MS) {
          return falha('AINDA_PODE_ESTAR_ENVIANDO', `o ultimo envio ficou sem resposta ha ${Math.round(idade / 1000)} segundos e ainda pode estar a caminho. Espere ${Math.ceil((ESPERA_APOS_INCERTO_MS - idade) / 60000)} minuto(s), confira o celular e rode "retomar" de novo`);
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let achou = false;
      for (const f of [arqParado, arqPendente]) {
        try { fs.unlinkSync(f); achou = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      parouNaMemoria = null;
      return { ok: true, achou };
    });
  }

  return { enviar, travar, liberar, liberarComTrava, paradoMotivo, pendente };
}
