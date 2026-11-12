'use strict';
// Leitor do histórico dos agentes (seção Logs do Admin). Sem HTTP: descobre os arquivos de sessão
// (Claude em <casa>/.claude/projects, Codex em <casa>/.codex/sessions), lê de trás para frente sem
// carregar o arquivo inteiro, junta tudo numa linha do tempo única e mascara o que sai.
//
// O Web é root e a casa do agente é do agente: tudo aqui trata o conteúdo da pasta como hostil.
//   - atalho (symlink) nunca é seguido; só entra arquivo regular com nome conhecido e um único nome (nlink 1);
//   - todo arquivo abre com O_NOFOLLOW|O_NONBLOCK, é conferido com fstat e o caminho real do descritor
//     (/proc/self/fd) precisa ficar dentro da raiz permitida;
//   - só a API assíncrona do fs (o Web é um processo só e serve o chat), em blocos de 64 KB;
//   - o texto do log nunca é de confiança: sai mascarado (limpa) e truncado, e a busca olha o texto já mascarado.
// Contrato e limites: web/docs/LOGS.md.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { mascarar, OCULTO } = require('./mascara');

const BLOCO = 64 * 1024;
const MAX_LINHA = 4 * 1024 * 1024;
const JANELA_HINT = 512 * 1024;
const FOLGA_MTIME = 5 * 60 * 1000;
const MAX_PROFUNDIDADE = 5;
const MAX_ARQUIVOS = 20000;
const MAX_FDS = 32;
const MAX_HINTS = 64;
// O relógio dos arquivos é grosso (alguns milissegundos) e o do processo não: arquivo mexido logo antes de o cursor nascer também se relê.
const MARGEM_TS_MS = 2000;
const MAX_RESULTADOS = 512;
const MAX_AVISOS = 50;
const MAX_ENTRADAS = 50000;
const MAX_PASTAS = 10000;
const PRAZO_DESCOBERTA_MS = 3000;
const BRUTO = 64 * 1024;
const TETO_TEXTO = 4096;
const TETO_COMANDO = 2048;
const TETO_RESULTADO = 4096;
const TETO_CURSOR = 8 * 1024;
const ORCAMENTO_BYTES = 64 * 1024 * 1024;
const ORCAMENTO_MS = 1500;

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RX_CLAUDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const RX_SUBAGENTE = /^agent-[A-Za-z0-9_-]{1,100}\.jsonl$/;
const RX_ROLLOUT = /^rollout-[A-Za-z0-9_.-]{1,160}\.jsonl$/;
const RX_UUID_FIM = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RX_CURSOR_TEXTO = /^[A-Za-z0-9_-]+$/;
const RX_SHELL_C = /^(?:-lc|-c)$/;
const RX_PATCH = /\*\*\* (?:Update|Add|Delete) File:[ \t]*([^\n]+)/;
const RX_ID_API = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IDS_API = 200;
const RX_ID_CURTO = /^[0-9a-f]{12}$/;
const TIPOS = ['mensagem', 'comando', 'arquivo', 'ferramenta', 'sistema'];
const CONTEXTO_INJETADO = ['<environment_context>', '<user_instructions>', '# AGENTS.md'];

/** Devolve uma função que cede o laço de eventos a cada ~8 ms de trabalho seguido (o Web serve o chat no mesmo processo). */
function criaCede(relogio) {
  let ultimo = relogio();
  return async function cede() {
    const t = relogio();
    if (t - ultimo < 8 && t >= ultimo) return;
    await new Promise((r) => setImmediate(r));
    ultimo = relogio();
  };
}

class ErroEntrada extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

class ErroArquivo extends Error {
  constructor(tipo, motivo) { super(motivo); this.tipo = tipo; this.motivo = motivo; }
}

// ── máscara ────────────────────────────────────────────────────────────────
// mascara.js cobre os formatos mais comuns; aqui entram os de outros fornecedores, cabeçalhos, flags de linha
// de comando e atribuições em português. É defesa em profundidade: segredo fora destes formatos passa.
// Padrões que rodam ANTES de mascarar() e da omissão de sequências longas: precisam ver o texto original (`-pSENHA` começa com
// um hífen, e a atribuição entre aspas de mascara.js fecha na primeira aspa, mesmo escapada, e deixaria o resto do valor).
// Valor entre aspas vai até a aspa de fechamento, consumindo `\"` como parte do valor; sem fechamento, até o fim da linha;
// sem aspas, até o próximo espaço. O argumento pode juntar pedaços adjacentes (`"a b"c'd e'`): cada pedaço começa por um
// caractere diferente (aspa dupla, aspa simples, barra de escape ou um caractere comum, sem barra), então o laço anda sempre para a frente, sem retrocesso.
// Depois de uma aspa de fechamento, `,` `}` e `]` encerram o valor (JSON em texto: `"senha":"x","outro":"y"` mantém o resto).
const DQ = String.raw`"(?:[^"\\\n]|\\[^\n])*\\?(?:"|(?=\n|$))`;
const SQ = String.raw`'(?:[^'\\\n]|\\[^\n])*\\?(?:'|(?=\n|$))`;
const ESC = String.raw`\\[^\n]`;                                  // barra mais qualquer caractere da linha (`primeira\ segunda`)
const FIM_JSON = String.raw`[,}\]](?<=[^"'][,}\]])`;        // vírgula, chave ou colchete só contam como valor se não vierem logo depois de aspa
// Argumento de shell (flags, curl -u, mysql -p): todos os pedaços adjacentes até o espaço não escapado, e `,` `}` `]` fazem parte
// do valor, mesmo logo depois de uma aspa (`"usuario:",segredo`). A exceção de JSON vale só na propriedade `"nome":"valor"` (separador `:`).
const VALOR = String.raw`(?:${DQ}|${SQ}|${ESC}|[^\s"'\\])+`;
const VALOR_ATRIBUICAO = String.raw`(?:${DQ}|${SQ}|${ESC}|[^\s"'\\&;|,}\]]|${FIM_JSON})+`;
const PRE = [
  // Atribuição com `=` é argumento de shell ou de variável de ambiente: todos os pedaços adjacentes até o espaço não escapado.
  [new RegExp(String.raw`((?:api[_-]?key|passw(?:or)?d|pwd|senha|secret|token|credential|chave|cookie|auth)[A-Za-z0-9_.-]{0,60}["']?[ \t]{0,20}=[ \t]{0,20})${VALOR}`, 'gi'), '$1' + OCULTO],
  // Com `:` é propriedade (JSON ou YAML): depois de uma aspa de fechamento, `,` `}` e `]` encerram o valor.
  [new RegExp(String.raw`((?:api[_-]?key|passw(?:or)?d|pwd|senha|secret|token|credential|chave|cookie|auth)[A-Za-z0-9_.-]{0,60}["']?[ \t]{0,20}:[ \t]{0,20})${VALOR_ATRIBUICAO}`, 'gi'), '$1' + OCULTO],
];

const EXTRAS = [
  [/sk-[A-Za-z0-9_-]{20,200}/g, OCULTO],
  [/sk_[a-z0-9]{20,200}/gi, OCULTO],
  [/\bgsk_[A-Za-z0-9]{10,200}/g, OCULTO],
  [/\bxai-[A-Za-z0-9]{10,200}/g, OCULTO],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,200}/g, OCULTO],
  [/\bgh[srpu]_[A-Za-z0-9]{20,200}/g, OCULTO],
  [/\beyJ[A-Za-z0-9_-]{5,200}\.[A-Za-z0-9_-]{5,200}\.[A-Za-z0-9_-]{5,200}/g, OCULTO],
  // Cabeçalho de autorização: o valor inteiro, até o fim da linha, sem teto próprio (o texto já tem o teto de 64 KB).
  // Depois de mascarar(), o valor pode chegar como "[segredo oculto] resto": o resto também sai.
  [/\b((?:Proxy-)?Authorization[ \t]{0,20}:[ \t]{0,20}|X-Api-Key[ \t]{0,20}:[ \t]{0,20})[^\n]+/gi, '$1' + OCULTO],
  // Cookie e Set-Cookie carregam vários pares separados por ';': o valor inteiro, até o fim da linha, sai escondido.
  [/\b((?:Set-)?Cookie[ \t]{0,20}:[ \t]{0,20})[^\n]+/gi, '$1' + OCULTO],
];

// ── comandos de shell com senha na linha ───────────────────────────────────
// curl (-u, -U, --user, --proxy-user), sshpass (-p), mysql* (-pSENHA) e htpasswd (-b) levam o segredo como argumento. Em vez de
// regex (que perde `-u a:b -U p:q`, continuação de linha e distância grande), um tokenizador linear percorre os argumentos de cada
// comando sem executar nada: aspas, escapes e `\`+quebra de linha contam como no shell, o comando acaba em `;` `|` `&` ou quebra de
// linha fora de aspas, e só os valores sensíveis são trocados (o resto do texto fica byte a byte).
const NOME_FLAG_SENSIVEL = String.raw`--(?:[a-z0-9_-]{0,30}?(?:password|passwd|passphrase|pwd|token|secret|senha|api[-_]?key|apikey)[a-z0-9_-]{0,30}|pass|auth)`;
// Acha duas coisas: uma palavra de comando (grupo 1) ou o começo de uma flag longa (grupo 2). Aspas e escapes entre as letras e em
// volta (`"curl"`, `c"ur"l`, `'--user'`, `--us"er"`) fazem parte do casamento: quem decide é o valor já desaspado (desaspar), e a
// flag longa só segue adiante se, depois de desaspada, for de segredo: --password, --passwd, --passphrase, --pwd, --token, --secret,
// --senha, --api-key, --api_key, --apikey, --pass, --auth e variações com prefixo ou sufixo (--access-token, --client-secret...).
// Flag longa não depende do nome do comando.
const ASPA_OPC = String.raw`["'\\]{0,2}`;
const intercala = (palavra) => palavra.split('').join(ASPA_OPC);
const PALAVRAS_RX = ['mysqlcheck', 'mysqlimport', 'mysqladmin', 'mysqldump', 'mysql', 'htpasswd', 'sshpass', 'curl'].map(intercala).join('|');
const RX_COMANDO = new RegExp(String.raw`(?<![A-Za-z0-9_.-])(?:(${PALAVRAS_RX})["']{0,2}(?=[ \t\r\n\\]|$)|(["']{0,2}--(?=[A-Za-z0-9_"'\\-])))`, 'gi');
const RX_FLAG_SENSIVEL = new RegExp(String.raw`^${NOME_FLAG_SENSIVEL}$`, 'i');
const PALAVRAS_DE_COMANDO = /^(?:curl|sshpass|htpasswd|mysql(?:dump|admin|import|check)?)$/i;

function ehEspaco(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
function ehFimDeComando(c) { return c === ';' || c === '|' || c === '&'; }

/** Fim do trecho entre aspas que abre em `i` (a aspa). Sem fechamento, vai até o fim da linha. `sem` guarda o que já se sabe que não fecha. */
function fimDaAspa(s, i, sem) {
  const q = s[i];
  const n = s.length;
  if (!sem[q]) {
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === q) return j + 1;
      if (q === '"' && c === '\\' && j + 1 < n) { j += 2; continue; }
      j++;
    }
    sem[q] = true;     // nenhuma aspa deste tipo fecha daqui para frente: as próximas não precisam procurar de novo
  }
  let j = i + 1;
  while (j < n && s[j] !== '\n') j++;
  return j;
}

/** Lê um argumento a partir de `i`: acaba em espaço, quebra de linha, `;`, `|` ou `&` fora de aspas e escapes (regra do shell). */
function lerArgumento(s, i, sem) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (ehEspaco(c) || ehFimDeComando(c)) break;
    if (c === '\\') {
      if (j + 1 >= n) { j++; break; }
      if (s[j + 1] === '\r' && s[j + 2] === '\n') { j += 3; continue; }
      j += 2;
      continue;
    }
    if (c === '"' || c === "'") { j = fimDaAspa(s, j, sem); continue; }
    if (c === '$' && s[j + 1] === '(') {
      const k = fimDeParenteses(s, j, n, sem);
      if (k >= 0) { j = k + 1; continue; }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k >= 0) { j = k + 1; continue; }
    }
    j++;
  }
  return j;
}

/** Índice do `)` que fecha o `$(` em `i`, contando parênteses; -1 se não fecha antes de `limite`. `sem.pf` lembra que já se procurou em vão. */
function fimDeParenteses(s, i, limite, sem) {
  if (sem.pf) return -1;
  let prof = 0;
  for (let k = i + 1; k < limite; k++) {
    const c = s[k];
    if (c === '(') prof++;
    else if (c === ')' && --prof === 0) return k;
  }
  sem.pf = true;
  return -1;
}

const PROF_SUBST_MAX = 3;
const SUBST_MAX = 16 * 1024;

/**
 * Substituições de comando dentro do argumento `s[i, fim)` (`$( ... )` e crases): o conteúdo é mascarado pelo mesmo tokenizador, em
 * recursão limitada (profundidade e tamanho). Passou do limite, o argumento inteiro sai escondido.
 */
function mascaraSubstituicoes(s, i, fim, sem, mascaras) {
  const prof = sem.prof || 0;
  let j = i;
  while (j < fim) {
    let x = -1;
    let y = -1;
    let prox = j + 1;
    if (s[j] === '$' && s[j + 1] === '(') {
      const k = fimDeParenteses(s, j, fim, sem);
      if (k >= 0) { x = j + 2; y = k; prox = k + 1; }
    } else if (s[j] === '`') {
      const k = s.indexOf('`', j + 1);
      if (k >= 0 && k < fim) { x = j + 1; y = k; prox = k + 1; }
    }
    if (x >= 0) {
      if (prof >= PROF_SUBST_MAX || y - x > SUBST_MAX) { mascaras.push([i, fim]); return; }
      for (const [a, b] of coletaMascaras(s.slice(x, y), prof + 1)) mascaras.push([a + x, b + x]);
    }
    j = prox;
  }
}

/**
 * Valor do argumento que vai de `i` a `fim` depois de interpretar aspas e escapes como o shell (sem executar expansões): `"-sSu"`,
 * `-"u"` e `--us"er"` viram `-sSu`, `-u` e `--user`. Devolve também, para cada caractere do valor, a posição original no texto, para
 * mascarar o pedaço certo. Só lê os primeiros MAX_DESASPAR caracteres: as regras olham o começo do argumento.
 */
const MAX_DESASPAR = 100;
function desaspar(s, i, fim) {
  let v = '';
  const pos = [];
  let j = i;
  while (j < fim && v.length < MAX_DESASPAR) {
    const c = s[j];
    if (c === '\\') {
      if (s[j + 1] === '\n') { j += 2; continue; }
      if (s[j + 1] === '\r' && s[j + 2] === '\n') { j += 3; continue; }
      if (j + 1 < fim) { v += s[j + 1]; pos.push(j + 1); j += 2; continue; }
      j++;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = j + 1;
      while (k < fim && v.length < MAX_DESASPAR) {
        const d = s[k];
        if (d === c) break;
        if (c === '"' && d === '\\' && k + 1 < fim) {
          const e = s[k + 1];
          if (e === '\n') { k += 2; continue; }
          if (e === '"' || e === '\\' || e === '$' || e === '`') { v += e; pos.push(k + 1); k += 2; continue; }
        }
        v += d; pos.push(k); k++;
      }
      j = k + 1;
      continue;
    }
    v += c; pos.push(j); j++;
  }
  return { v, pos, completo: j >= fim };
}

/** `--flag=valor` mascara o valor; `--flag` sozinha pede que o próximo argumento seja mascarado (flagLongaSensivel.espera). */
function flagLongaSensivel(a, fim, mascaras) {
  flagLongaSensivel.espera = false;
  const { v, pos } = a;
  const eq = v.indexOf('=');
  const nome = eq >= 0 ? v.slice(0, eq) : v;
  if (nome.length > 90 || !RX_FLAG_SENSIVEL.test(nome)) return false;
  if (eq >= 0) mascaras.push([pos[eq] + 1, fim]);
  else if (a.completo) flagLongaSensivel.espera = true;
  else return false;
  return true;
}

// Opções curtas do curl que levam argumento (o resto do grupo, ou o próximo argumento, é o valor delas).
const CURL_CURTAS_COM_VALOR = 'AbcCdDeEFHKmoPQrtTuUwXxyYz';
const CURL_CURTAS_SENSIVEIS = 'uUb';       // -u/-U: usuário:senha; -b: cookies

/**
 * Argumento curto do curl, possivelmente agrupado (`-sSu usuario:senha`, `-sSuusuario:senha`, `-uusuario:senha`), já desaspado: anda
 * letra por letra até a primeira opção que consome valor. Devolve true quando o valor sensível é o próximo argumento; o valor colado
 * já entra em `mascaras`. Opção que leva valor não sensível (`-H`, `-o`...) também encerra o grupo.
 */
function curlCurtas(a, fim, mascaras) {
  const { v, pos } = a;
  for (let j = 1; j < v.length; j++) {
    const c = v[j];
    if (!CURL_CURTAS_COM_VALOR.includes(c)) continue;
    const sensivel = CURL_CURTAS_SENSIVEIS.includes(c);
    if (j + 1 < v.length) { if (sensivel) mascaras.push([pos[j] + 1, fim]); return false; }
    return sensivel && a.completo;
  }
  return false;
}

function varreComando(s, pos, cmd, sem, mascaras) {
  const n = s.length;
  let i = pos;
  let espera = false;       // o próximo argumento é o valor da flag anterior
  let posicionais = 0;      // htpasswd: quantos argumentos depois do -b ainda são arquivo, usuário ou senha
  let htIni = -1;
  let htFim = -1;
  const fecha = () => { if (htIni >= 0) mascaras.push([htIni, htFim]); htIni = -1; };
  while (i < n) {
    // espaço e continuação de linha (`\` + quebra) entre argumentos
    for (;;) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
      if (c === '\\' && s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
      break;
    }
    if (i >= n) break;
    const c0 = s[i];
    if (c0 === '\n' || c0 === '\r' || ehFimDeComando(c0)) break;
    const fim = lerArgumento(s, i, sem);
    mascaraSubstituicoes(s, i, fim, sem, mascaras);
    // Todas as regras abaixo decidem pelo valor desaspado do argumento (a.v), nunca pelo texto cru.
    const a = desaspar(s, i, fim);
    const v = a.v;
    if (espera) { mascaras.push([i, fim]); espera = false; } else if (posicionais > 0 && v[0] !== '-') {
      if (htIni < 0) htIni = i;
      htFim = fim;
      posicionais--;
    } else if ((cmd === 'sshpass' || cmd === '') && a.completo && v.length <= 12 && PALAVRAS_DE_COMANDO.test(v)) {
      fecha();
      cmd = v.toLowerCase();       // `sshpass -p x curl -u ...`: passa a valer a regra do curl. Só o sshpass embrulha outro comando; em `curl -o mysql` a palavra é valor de opção
    } else if (v[0] === '-' && v[1] === '-' && flagLongaSensivel(a, fim, mascaras)) {
      espera = flagLongaSensivel.espera;
    } else if (v[0] === '-') {
      if (cmd === 'curl') {
        if (v[1] === '-') {
          const eq = v.indexOf('=');
          const nome = eq >= 0 ? v.slice(0, eq) : v;
          if (nome === '--user' || nome === '--proxy-user' || nome === '--oauth2-bearer' || nome === '--cookie') {
            if (eq >= 0) mascaras.push([a.pos[eq] + 1, fim]);
            else if (a.completo) espera = true;
          }
        } else {
          espera = curlCurtas(a, fim, mascaras);
        }
      } else if (cmd === 'sshpass') {
        if (v === '-p' && a.completo) espera = true;
        else if (v.length > 2 && v.startsWith('-p')) mascaras.push([a.pos[1] + 1, fim]);
      } else if (cmd === 'htpasswd') {
        if (a.completo && v.length <= 13 && /^-[A-Za-z]+$/.test(v) && v.includes('b')) posicionais = v.includes('n') ? 2 : 3;
      } else if (v.length > 2 && v.startsWith('-p')) {     // mysql*: -pSENHA, sem espaço (com espaço o -p só pede a senha no terminal)
        mascaras.push([a.pos[1] + 1, fim]);
      }
    }
    i = fim;
  }
  fecha();
  return i;
}

/** Intervalos `[ini, fim)` a esconder em `s`. `prof` conta quantas substituições de comando já foram abertas. */
function coletaMascaras(s, prof) {
  const mascaras = [];
  const sem = { prof };
  RX_COMANDO.lastIndex = 0;
  let m;
  while ((m = RX_COMANDO.exec(s)) !== null) {
    if (m[1]) {
      // palavra de comando (já sem aspas): os argumentos vêm depois dela
      const fim = varreComando(s, m.index + m[0].length, m[1].replace(/["'\\]/g, '').toLowerCase(), sem, mascaras);
      RX_COMANDO.lastIndex = Math.max(fim, m.index + m[0].length);
      continue;
    }
    // começo de flag longa: só segue se, desaspada, for flag de segredo; ela própria é o primeiro argumento
    const fimFlag = lerArgumento(s, m.index, sem);
    const { v } = desaspar(s, m.index, fimFlag);
    const nome = v.indexOf('=') >= 0 ? v.slice(0, v.indexOf('=')) : v;
    if (nome.length <= 90 && RX_FLAG_SENSIVEL.test(nome)) {
      const fim = varreComando(s, m.index, '', sem, mascaras);
      RX_COMANDO.lastIndex = Math.max(fim, m.index + m[0].length);
    } else {
      // argumento já lido por inteiro: a próxima busca começa depois dele, senão o mesmo trecho seria varrido de novo (custo quadrático)
      mascaraSubstituicoes(s, m.index, fimFlag, sem, mascaras);
      RX_COMANDO.lastIndex = Math.max(fimFlag, m.index + m[0].length);
    }
  }
  return mascaras;
}

/** Troca os intervalos por OCULTO. Com `cortado`, região sensível que ficou com aspa aberta vai até o fim do texto disponível. */
function aplicaMascaras(s, mascaras, cortado) {
  if (!mascaras.length) return s;
  if (cortado) for (const mk of mascaras) if (mk[1] < s.length && aspaAbertaNoFim(s, mk[0], mk[1])) mk[1] = s.length;
  mascaras.sort((x, y) => x[0] - y[0]);
  let saida = '';
  let ultimo = 0;
  for (const [a, b] of mascaras) {
    if (a < ultimo) { if (b > ultimo) ultimo = b; continue; }
    saida += s.slice(ultimo, a) + OCULTO;
    ultimo = b;
  }
  return saida + s.slice(ultimo);
}

/** O trecho `s[i, fim)` termina dentro de aspas abertas (o fechamento ficou depois do corte do texto). */
function aspaAbertaNoFim(s, i, fim) {
  let q = '';
  for (let j = i; j < fim; j++) {
    const c = s[j];
    if (c === '\\' && q !== "'") { j++; continue; }
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c;
  }
  return q !== '';
}

function mascaraComandos(s, cortado) {
  return aplicaMascaras(s, coletaMascaras(s, 0), cortado);
}

// Atribuição `NOME=valor` de segredo: o valor é lido como argumento de shell, então continuação de linha (`\` + quebra) e aspas
// que atravessam linhas entram por inteiro (as regexes de PRE param na quebra e deixariam o resto do segredo). Aspa sem
// fechamento vai até o fim da linha; sem aspas, até o próximo espaço não escapado.
const RX_ATRIBUICAO = /(?:api[_-]?key|passw(?:or)?d|pwd|senha|secret|token|credential|chave|cookie|auth)[A-Za-z0-9_.-]{0,60}["']?[ \t]{0,20}=[ \t]{0,20}/gi;

function lerValorAtribuicao(s, i, sem) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (ehEspaco(c)) break;
    if (c === '\\') {
      if (j + 1 >= n) { j++; break; }
      if (s[j + 1] === '\r' && s[j + 2] === '\n') { j += 3; continue; }
      j += 2;
      continue;
    }
    if (c === '"' || c === "'") { j = fimDaAspa(s, j, sem); continue; }
    j++;
  }
  return j;
}

function mascaraAtribuicoes(s, cortado) {
  const mascaras = [];
  const sem = {};
  RX_ATRIBUICAO.lastIndex = 0;
  let m;
  while ((m = RX_ATRIBUICAO.exec(s)) !== null) {
    const ini = m.index + m[0].length;
    const fim = lerValorAtribuicao(s, ini, sem);
    if (fim > ini) mascaras.push([ini, fim]);
    RX_ATRIBUICAO.lastIndex = Math.max(fim, ini);
  }
  return aplicaMascaras(s, mascaras, cortado);
}

// Os padrões de mascara.js (principalmente a atribuição NOME=valor) varrem cada trecho de letras e números até o fim
// para achar uma palavra-chave: numa sequência de 64 KB sem espaço isso vira conta quadrática, e o agente é quem escreve
// o texto. Sequência longa demais não é palavra nem segredo conhecido (um JWT ou uma chave em base64 também cai aqui):
// sai omitida por inteiro, o que protege o valor e mantém todos os padrões em tempo linear.
const RX_RESTO_MARCADOR = /\[segredo oculto\](?: oculto\])+/g;
const RX_SEQUENCIA_LONGA = /[A-Za-z0-9_.-]{129,}/g;

/** Corta em 64 KB e descarta também o último pedaço sem espaço, para não sobrar um segredo cortado no limite. */
function corteBruto(s) {
  if (s.length <= BRUTO) return s;
  let fim = BRUTO;
  while (fim > 0 && !/\s/.test(s[fim - 1])) fim--;
  return s.slice(0, fim);
}

// Comando que pode levar credencial: o texto inteiro, sem tokenizar, é testado. Casou, só o nome do programa sai (resposta e busca).
// Foi o que sobrou depois de várias rodadas mascarando variação por variação: o tokenizador acima fica como segunda camada.
const PROGRAMAS_COM_CREDENCIAL = ['curl', 'wget', 'http', 'httpie', 'mysql', 'mysqldump', 'mariadb', 'psql', 'pg_dump', 'mongo', 'mongosh', 'mongodump', 'redis-cli', 'sshpass', 'htpasswd', 'ftp', 'lftp', 'smbclient', 'rsync', 'scp', 'sftp', 'ssh', 'git', 'gh', 'docker', 'podman', 'npm', 'pip', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'openssl', 'gpg', 'op', 'vault'];
const RX_PROGRAMA_CREDENCIAL = new RegExp(`(?<![A-Za-z0-9_.-])(?:${PROGRAMAS_COM_CREDENCIAL.map((x) => x.replace(/[-_]/g, '[-_]')).join('|')})(?![A-Za-z0-9_-])`, 'i');
const RX_MARCADOR_CREDENCIAL = /pass|pwd|token|secret|senha|auth|bearer|apikey|api_key|api-key|credential|cookie|private|-u |--user|-p|:\/\/[^\s\/]*@/i;
const AVISO_ARGUMENTOS = ' [argumentos ocultos: comando que pode levar credencial]';

function comandoComCredencial(s) {
  return typeof s === 'string' && (RX_MARCADOR_CREDENCIAL.test(s) || RX_PROGRAMA_CREDENCIAL.test(s));
}

/** Texto de comando como pode sair: sem credencial possível passa inteiro (mascarado depois); com ela, só o programa. */
function comandoExibivel(s) {
  if (!comandoComCredencial(s)) return s;
  const primeiro = (/^\s*(\S+)/.exec(s) || [])[1] || '';
  const nome = primeiro.split('/').pop();
  return (/^[A-Za-z0-9_.+-]{1,60}$/.test(nome) ? nome : 'comando') + AVISO_ARGUMENTOS;
}

const LINHA_OCULTA = '[linha oculta: pode levar credencial]';

/** Linha que tem um programa da lista E um marcador de credencial (xtrace, eco de comando) sai inteira escondida. */
function ocultaLinhasComCredencial(s) {
  if (!RX_MARCADOR_CREDENCIAL.test(s) || !RX_PROGRAMA_CREDENCIAL.test(s)) return s;
  return s.split('\n').map((l) => (RX_MARCADOR_CREDENCIAL.test(l) && RX_PROGRAMA_CREDENCIAL.test(l) ? LINHA_OCULTA : l)).join('\n');
}

/** Tudo o que sai da API passa por aqui: limite de 64 KB, mascarar de mascara.js e depois os padrões extras. */
function limpa(texto, cortado, semLinhas) {
  if (texto == null) return '';
  const bruto = typeof texto === 'string' ? texto : String(texto);
  cortado = cortado || bruto.length > BRUTO;
  let r = corteBruto(bruto);
  if (!semLinhas) r = ocultaLinhasComCredencial(r);
  r = mascaraAtribuicoes(mascaraComandos(r, cortado), cortado);
  for (const [rx, sub] of PRE) { rx.lastIndex = 0; r = r.replace(rx, sub); }
  r = mascarar(r.replace(RX_SEQUENCIA_LONGA, '[trecho-longo-omitido]'));
  for (const [rx, sub] of EXTRAS) { rx.lastIndex = 0; r = r.replace(rx, sub); }
  // mascara.js reaplica o marcador sobre o próprio marcador (que tem um espaço) e deixa "oculto]" sobrando
  return r.replace(RX_RESTO_MARCADOR, OCULTO);
}

// Chaves de objeto com nome de segredo: o valor sai escondido por inteiro, em qualquer nível.
const RX_CHAVE_LONGA = /^[A-Za-z0-9_.+\/=-]+$/;
const RX_CHAVE_SENSIVEL = /api[_-]?key|passw(?:or)?d|pwd|senha|secret|token|authorization|(?:^|[^a-z])auth(?:[^a-z]|$)|cookie|chave|credential/i;
const PROF_MAX = 6;
const NOS_MAX = 2000;
const CARACTERES_MAX = 64 * 1024;
const CHAVE_MAX = 128;
const MARCADOR_GRANDE = '[entrada grande demais, omitida]';

/**
 * Antes de serializar um objeto vindo do log: orçamento GLOBAL por valor (no máximo 2000 nós e 64 KB de caracteres somados,
 * chaves incluídas, profundidade 6). Ao estourar, a travessia para e o que falta é trocado por um marcador, sem expor nada
 * adiante; assim o tempo é limitado seja qual for o formato (objetos largos, fundos ou JSON dentro de texto). Valor de chave
 * sensível sai escondido, cada texto é mascarado como texto puro (o JSON escapa as aspas e esconderia o padrão) e texto que
 * contém JSON válido (começa com `{` ou `[`) é percorrido do mesmo jeito. Só texto e número entram.
 */
function redige(v, est, prof) {
  if (est.cortou) return MARCADOR_GRANDE;
  if (++est.nos > NOS_MAX) { est.cortou = true; return MARCADOR_GRANDE; }
  if (typeof v === 'string') {
    const s = corteBruto(v);
    est.chars += s.length;
    if (est.chars > CARACTERES_MAX) { est.cortou = true; return MARCADOR_GRANDE; }
    const t = s.trimStart();
    if ((t[0] === '{' || t[0] === '[') && v.length <= BRUTO && prof < PROF_MAX) {
      let obj;
      try { obj = JSON.parse(s); } catch (_) { obj = undefined; }
      if (obj && typeof obj === 'object') return JSON.stringify(redige(obj, est, prof + 1));
    }
    return limpa(s, v.length > BRUTO);
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (!v || typeof v !== 'object') return '';
  if (prof >= PROF_MAX) return '[omitido: aninhamento fundo demais]';
  if (Array.isArray(v)) {
    const saida = [];
    for (const x of v) {
      if (est.cortou) { saida.push(MARCADOR_GRANDE); break; }
      saida.push(redige(x, est, prof + 1));
    }
    return saida;
  }
  const pares = [];
  for (const k of Object.keys(v)) {
    if (est.cortou) { pares.push(['…', MARCADOR_GRANDE]); break; }
    const nome = k.length > CHAVE_MAX ? k.slice(0, CHAVE_MAX) : k;
    est.chars += nome.length;
    if (est.chars > CARACTERES_MAX) { est.cortou = true; continue; }
    // nome com cara de segredo (sequência longa sem separador) não sai: teste linear, nunca a máscara inteira sobre cada chave
    const chave = nome.length >= 32 && RX_CHAVE_LONGA.test(nome) ? '[chave longa omitida]' : nome;
    pares.push([chave, RX_CHAVE_SENSIVEL.test(nome) ? OCULTO : redige(v[k], est, prof + 1)]);
  }
  return Object.fromEntries(pares);
}

const novoEstado = () => ({ nos: 0, chars: 0, cortou: false });

function serializa(valor) {
  if (valor == null) return '';
  try {
    if (typeof valor === 'string') {
      const t = valor.trimStart();
      if ((t[0] === '{' || t[0] === '[') && valor.length <= BRUTO) return redige(valor, novoEstado(), 0);
      return valor;
    }
    return JSON.stringify(redige(valor, novoEstado(), 0));
  } catch (_) { return '[objeto que não pude serializar]'; }
}

/** Corta em `max` caracteres sem partir um par substituto. */
function corta(texto, max) {
  const s = String(texto == null ? '' : texto);
  if (s.length <= max) return { texto: s, truncado: false };
  let fim = max;
  const c = s.charCodeAt(fim - 1);
  if (c >= 0xD800 && c <= 0xDBFF) fim -= 1;
  return { texto: s.slice(0, fim), truncado: true };
}

/** Mascara antes de truncar. Devolve { cheio (mascarado, até 64 KB), texto (teto), truncado }. */
function preparaTexto(bruto, teto) {
  const s = serializa(bruto);
  const cheio = limpa(s);
  const c = corta(cheio, teto);
  return { cheio, texto: c.texto, truncado: c.truncado || s.length > BRUTO };
}

const RX_ACENTOS = /[̀-ͯ]/g;
function normaliza(s) {
  return String(s).normalize('NFD').replace(RX_ACENTOS, '').toLowerCase();
}

/** Tira as barras do fim sem regex (uma regex de barras repetidas seria quadrática num texto que o requisitante controla). */
function semBarraFinal(s) {
  let fim = s.length;
  while (fim > 0 && s.charCodeAt(fim - 1) === 47) fim--;
  return s.slice(0, fim);
}

function caminhoRelativo(p, bases) {
  const s = String(p == null ? '' : p);
  if (!s) return '';
  for (const b of bases) {
    if (!b) continue;
    const base = semBarraFinal(b);
    if (s === base || s.startsWith(base + '/')) return '~' + s.slice(base.length);
  }
  if (s.startsWith('/')) return '…/' + s.split('/').filter(Boolean).slice(-3).join('/');
  return s;
}

// ── cursor ─────────────────────────────────────────────────────────────────
function codificaCursor(c) { return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url'); }

function inteiro(v, min) { return Number.isSafeInteger(v) && v >= min; }

/** Valida o cursor recebido. Hint inválido é descartado em silêncio; o resto inválido é erro 400. */
function decodificaCursor(texto) {
  if (texto == null || texto === '') return null;
  const ruim = (m) => new ErroEntrada(400, `O cursor "${String(texto).slice(0, 40)}" não vale (${m}). Peça a primeira página de novo, sem o parâmetro "cursor".`);
  if (typeof texto !== 'string' || texto.length > TETO_CURSOR || !RX_CURSOR_TEXTO.test(texto)) throw ruim('formato ou tamanho');
  let o;
  try { o = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8')); } catch (_) { throw ruim('não é JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw ruim('estrutura');
  const temChave = o.t !== undefined || o.f !== undefined || o.o !== undefined || o.i !== undefined;
  const r = { chave: null, h: {}, g: null, ts: null };
  if (temChave) {
    if (!(typeof o.t === 'number' && Number.isFinite(o.t)) || typeof o.f !== 'string' || !RX_ID_CURTO.test(o.f) || !inteiro(o.o, 0) || !inteiro(o.i, 0)) throw ruim('chave de posição');
    r.chave = { t: o.t, f: o.f, o: o.o, i: o.i };
  }
  if (o.g !== undefined) {
    if (!Array.isArray(o.g) || o.g.length !== 2 || !(typeof o.g[0] === 'number' && Number.isFinite(o.g[0])) || typeof o.g[1] !== 'string' || !RX_ID_CURTO.test(o.g[1])) throw ruim('posição global');
    r.g = { m: o.g[0], id: o.g[1] };
  }
  if (o.ts !== undefined) {
    if (!(typeof o.ts === 'number' && Number.isFinite(o.ts))) throw ruim('momento do cursor');
    r.ts = o.ts;
  }
  if (o.h !== undefined) {
    if (!o.h || typeof o.h !== 'object' || Array.isArray(o.h)) throw ruim('hints');
    let n = 0;
    for (const [k, v] of Object.entries(o.h)) {
      if (++n > MAX_HINTS) break;
      if (!RX_ID_CURTO.test(k) || !Array.isArray(v) || (v.length !== 2 && v.length !== 3)) continue;
      if (!(Number.isSafeInteger(v[0]) && v[0] >= -1) || !(typeof v[1] === 'number' && Number.isFinite(v[1]))) continue;
      r.h[k] = { o: v[0], teto: v[1], f: v[2] === 1 || v[2] === 2 ? v[2] : 0 };
    }
  }
  return r;
}

/** a vem depois de g na ordem dos arquivos (mtime decrescente, depois id)? */
function depoisDe(a, g) { return a.mtimeMs < g.m || (a.mtimeMs === g.m && a.id > g.id); }
/** posição x vem antes de y na mesma ordem (objetos { m, id })? */
function ordemAntes(x, y) { return x.m > y.m || (x.m === y.m && x.id < y.id); }

/** Dois cursores dizem a mesma coisa (mesma posição e mesmos hints)? `a` pode ser null (primeira página). */
function mesmoCursor(a, b) {
  const ca = a && a.chave; const cb = b && b.chave;
  if ((ca || null) && (cb || null)) { if (cmp(ca, cb) !== 0) return false; } else if ((ca || null) !== (cb || null)) return false;
  const ga = a && a.g; const gb = b && b.g;
  if ((ga || null) !== (gb || null) && !(ga && gb && ga.m === gb.m && ga.id === gb.id)) return false;
  const ha = (a && a.h) || {}; const hb = (b && b.h) || {};
  const ka = Object.keys(ha).sort(); const kb = Object.keys(hb).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => {
    if (k !== kb[i]) return false;
    const x = ha[k]; const y = hb[k];
    const ox = Array.isArray(x) ? x[0] : x.o; const tx = Array.isArray(x) ? x[1] : x.teto;
    return ox === y[0] && tx === y[1];
  });
}

function cmp(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.f !== b.f) return a.f < b.f ? -1 : 1;
  if (a.o !== b.o) return a.o < b.o ? -1 : 1;
  return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
}

// ── descoberta ─────────────────────────────────────────────────────────────
function idCurto(motor, rel) { return crypto.createHash('sha256').update(`${motor}/${rel}`).digest('hex').slice(0, 12); }

function fontesDoAgente(ag) {
  const r = [];
  if (ag.tipo === 'admin') {
    if (ag.transcripts_dir) r.push({ motor: 'claude', raiz: ag.transcripts_dir, permitida: ag.transcripts_dir, rotulo: 'transcripts_dir', projetoFixo: path.basename(ag.transcripts_dir) });
    else r.push({ motor: 'claude', semRaiz: 'o registro não informa transcripts_dir para o Admin' });
    if (ag.codex_home_host) r.push({ motor: 'codex', raiz: path.join(ag.codex_home_host, 'sessions'), permitida: ag.codex_home_host, rotulo: 'codex_home_host/sessions', api: ag.home_host || null });
    return r;
  }
  if (!ag.home_host) {
    return [{ motor: 'claude', semRaiz: 'o registro não informa home_host deste agente' }, { motor: 'codex', semRaiz: 'o registro não informa home_host deste agente' }];
  }
  r.push({ motor: 'claude', raiz: path.join(ag.home_host, '.claude', 'projects'), permitida: ag.home_host, rotulo: '.claude/projects' });
  r.push({ motor: 'codex', raiz: path.join(ag.home_host, '.codex', 'sessions'), permitida: ag.home_host, rotulo: '.codex/sessions', api: ag.home_host });
  return r;
}

function nomeValido(motor, nome) {
  return motor === 'claude' ? (RX_CLAUDE.test(nome) || RX_SUBAGENTE.test(nome)) : RX_ROLLOUT.test(nome);
}

function descreveArquivo(fonte, raizReal, abs, st) {
  const rel = (fonte.prefixo || '') + path.relative(raizReal, abs).split(path.sep).join('/');
  const nome = path.basename(abs);
  const segs = rel.split('/');
  let sessao = null;
  if (fonte.motor === 'claude') {
    if (RX_CLAUDE.test(nome)) sessao = nome.slice(0, -6).toLowerCase();
    else { const s = segs.find((x) => RX_UUID.test(x)); sessao = s ? s.toLowerCase() : null; }
  } else {
    const m = RX_UUID_FIM.exec(nome);
    sessao = m ? m[1].toLowerCase() : null;
  }
  const projeto = fonte.projetoFixo || (fonte.motor === 'claude' && segs.length >= 2 ? segs[0] : null);
  return {
    abs, raizReal, rel, nome, motor: fonte.motor, id: idCurto(fonte.motor, rel), bytes: st.size, mtimeMs: st.mtimeMs,
    subagente: fonte.motor === 'claude' && (RX_SUBAGENTE.test(nome) || segs.includes('subagents')),
    projeto, sessao, rotulo: `${fonte.motor}:${rel}`,
  };
}

/** Lista os arquivos de uma fonte, sem seguir atalho. Nunca lança: o que deu errado vira estado e aviso. */
async function descobreFonte(fonte, lim) {
  const saida = { motor: fonte.motor, estado: 'ok', motivo: null, arquivos: [], avisos: [], atalhos_ignorados: 0, avisosOmitidos: 0, entradas: 0, raizReal: null };
  if (fonte.semRaiz) { saida.estado = 'ausente'; saida.motivo = fonte.semRaiz; return saida; }
  let permReal;
  let raizReal;
  try { permReal = await fsp.realpath(fonte.permitida); } catch (e) {
    saida.estado = e.code === 'ENOENT' ? 'ausente' : 'ilegivel';
    saida.motivo = e.code === 'ENOENT' ? 'a pasta do agente não existe no servidor (nunca rodou neste motor)' : `não consegui abrir a pasta do agente (${e.code || e.message})`;
    return saida;
  }
  try { raizReal = await fsp.realpath(fonte.raiz); } catch (e) {
    if (e.code === 'ENOENT') { saida.estado = 'ausente'; saida.motivo = `nunca rodou neste motor (${fonte.rotulo} não existe)`; } else {
      saida.estado = 'ilegivel'; saida.motivo = `não consegui resolver ${fonte.rotulo} (${e.code || e.message})`;
    }
    return saida;
  }
  if (raizReal !== permReal && !raizReal.startsWith(permReal + path.sep)) {
    saida.estado = 'ilegivel';
    saida.motivo = `${fonte.rotulo} aponta para fora da pasta do agente; recusei por segurança`;
    return saida;
  }
  saida.raizReal = raizReal;
  const inicio = lim.relogio();
  const aviso = (a) => { if (saida.avisos.length < lim.maxAvisos) saida.avisos.push(a); else saida.avisosOmitidos++; };
  const pilha = [{ dir: raizReal, prof: 0 }];
  let parcial = null;     // motivo de ter parado antes de ver tudo
  let entradas = 0;
  while (pilha.length && !parcial) {
    const { dir, prof } = pilha.pop();
    let d;
    try { d = await fsp.opendir(dir); } catch (e) {
      const relDir = path.relative(raizReal, dir) || '.';
      if (dir === raizReal) { saida.estado = 'ilegivel'; saida.motivo = `não consegui listar ${fonte.rotulo} (${e.code || e.message})`; return saida; }
      aviso({ tipo: 'pasta_ilegivel', motivo: `não consegui listar a pasta (${e.code || e.message})`, arquivo: `${fonte.motor}:${relDir}` });
      continue;
    }
    try {
      for await (const ent of d) {
        if (saida.arquivos.length >= lim.maxArquivos) { parcial = `a pasta tem mais de ${lim.maxArquivos} arquivos de sessão; só os primeiros ${lim.maxArquivos} entraram na lista`; break; }
        if (++entradas > lim.maxEntradas) { parcial = `a pasta tem mais de ${lim.maxEntradas} entradas; parei de olhar por segurança e a lista pode estar incompleta`; break; }
        if (entradas % 64 === 0) {
          await lim.cede();
          if (lim.relogio() - inicio > lim.ms) { parcial = `a leitura da pasta passou de ${lim.ms} ms e parou; a lista pode estar incompleta`; break; }
        }
        const abs = path.join(dir, ent.name);
        let tipo = ent.isSymbolicLink() ? 'l' : ent.isDirectory() ? 'd' : ent.isFile() ? 'f' : null;
        let st = null;
        if (!tipo) {
          try { st = await fsp.lstat(abs); } catch (_) { continue; }
          tipo = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
        }
        if (tipo === 'l') { saida.atalhos_ignorados++; continue; }
        if (tipo === 'd') {
          if (prof + 1 > lim.maxProfundidade) continue;
          if (pilha.length >= lim.maxPastas) { parcial = `a pasta tem mais de ${lim.maxPastas} subpastas esperando leitura; parei de olhar por segurança e a lista pode estar incompleta`; break; }
          pilha.push({ dir: abs, prof: prof + 1 });
          continue;
        }
        if (!nomeValido(fonte.motor, ent.name)) continue;
        const rel = `${fonte.motor}:${fonte.prefixo || ''}${path.relative(raizReal, abs).split(path.sep).join('/')}`;
        if (tipo !== 'f') { aviso({ tipo: 'arquivo_recusado', motivo: 'não é um arquivo regular', arquivo: rel }); continue; }
        try { st = await fsp.lstat(abs); } catch (e) { aviso({ tipo: 'arquivo_ilegivel', motivo: `não consegui conferir o arquivo (${e.code || e.message})`, arquivo: rel }); continue; }
        if (!st.isFile()) { aviso({ tipo: 'arquivo_recusado', motivo: 'não é um arquivo regular', arquivo: rel }); continue; }
        if (st.nlink !== 1) { aviso({ tipo: 'arquivo_recusado', motivo: 'o arquivo tem mais de um nome no disco (hardlink); recusei por segurança', arquivo: rel }); continue; }
        saida.arquivos.push(descreveArquivo(fonte, raizReal, abs, st));
      }
    } catch (e) {
      aviso({ tipo: 'pasta_ilegivel', motivo: `a leitura da pasta parou (${e.code || e.message})`, arquivo: `${fonte.motor}:${path.relative(raizReal, dir) || '.'}` });
    } finally {
      await d.close().catch(() => {});
    }
  }
  saida.entradas = entradas;
  if (parcial) {
    saida.avisos.push({ tipo: 'limite', motivo: parcial, arquivo: fonte.motor });
    saida.estado = 'parcial';
    saida.motivo = parcial;
    return saida;
  }
  if (!saida.arquivos.length) {
    if (saida.avisos.length) {
      saida.estado = 'ilegivel';
      saida.motivo = `nenhum arquivo pôde ser lido: ${saida.avisos[0].motivo}${saida.avisos[0].arquivo ? ` (${saida.avisos[0].arquivo})` : ''}`;
    } else {
      saida.estado = 'vazia';
      saida.motivo = `${fonte.rotulo} existe, mas ainda não tem nenhuma sessão gravada`;
    }
  }
  return saida;
}

/**
 * Sessões do Codex autenticado por chave de API: uma pasta por sessão do runner em <casa>/.plataforma/codex-api/<id>/sessions
 * (runner/src/provedores/codex.ts, codexHomeDe). Entram na MESMA fonte do Codex, com os mesmos limites (arquivos, entradas e
 * prazo descontados do que a pasta da assinatura já gastou), realpath confinado à casa e sem seguir atalho; `<id>` vem de uma
 * regex fechada.
 */
async function descobreApi(casa, lim, gasto) {
  const r = { arquivos: [], avisos: [], avisosOmitidos: 0, atalhos_ignorados: 0, entradas: 0, parcial: null, estado: 'ausente', motivo: null };
  const base = path.join(casa, '.plataforma', 'codex-api');
  let permReal;
  let baseReal;
  try { permReal = await fsp.realpath(casa); } catch (e) { return r; }
  try { baseReal = await fsp.realpath(base); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') { r.estado = 'ilegivel'; r.motivo = `não consegui resolver .plataforma/codex-api (${e.code || e.message})`; }
    return r;
  }
  if (baseReal !== permReal && !baseReal.startsWith(permReal + path.sep)) {
    r.estado = 'ilegivel';
    r.motivo = '.plataforma/codex-api aponta para fora da pasta do agente; recusei por segurança';
    return r;
  }
  const ids = [];
  const entradasRestantes = lim.maxEntradas - gasto.entradas;
  let d;
  try { d = await fsp.opendir(baseReal); } catch (e) { r.estado = 'ilegivel'; r.motivo = `não consegui listar .plataforma/codex-api (${e.code || e.message})`; return r; }
  try {
    for await (const ent of d) {
      // orçamento e prazo no topo do laço, antes de qualquer `continue`: arquivo, atalho e nome inválido também custam
      if (++r.entradas > entradasRestantes) { r.parcial = `há entradas demais em .plataforma/codex-api (mais de ${lim.maxEntradas}); parei de olhar por segurança e a lista pode estar incompleta`; break; }
      if (r.entradas % 64 === 0) {
        await lim.cede();
        if (lim.relogio() - gasto.inicio > lim.ms) { r.parcial = `a leitura de .plataforma/codex-api passou de ${lim.ms} ms e parou; a lista pode estar incompleta`; break; }
      }
      if (ent.isSymbolicLink()) { r.atalhos_ignorados++; continue; }
      if (!ent.isDirectory() || !RX_ID_API.test(ent.name)) continue;
      if (ids.length >= MAX_IDS_API) { r.parcial = `há mais de ${MAX_IDS_API} pastas de sessão em .plataforma/codex-api; só as primeiras ${MAX_IDS_API} entraram na lista`; break; }
      ids.push(ent.name);
    }
  } catch (e) {
    r.estado = 'ilegivel'; r.motivo = `a leitura de .plataforma/codex-api parou (${e.code || e.message})`;
  } finally { await d.close().catch(() => {}); }
  ids.sort();
  let vazias = 0;
  let ilegiveis = 0;
  let primeiroMotivo = null;
  for (const id of ids) {
    const restante = { ...lim, maxArquivos: lim.maxArquivos - gasto.arquivos - r.arquivos.length, maxEntradas: lim.maxEntradas - gasto.entradas - r.entradas, ms: lim.ms - (lim.relogio() - gasto.inicio) };
    // o indicador de lista incompleta (r.parcial) não interrompe a leitura das pastas já coletadas: só o orçamento interrompe
    if (restante.maxArquivos <= 0 || restante.maxEntradas <= 0 || restante.ms <= 0) { r.parcial = r.parcial || 'os limites de leitura acabaram antes de chegar em todas as pastas de .plataforma/codex-api'; break; }
    const sub = await descobreFonte({ motor: 'codex', raiz: path.join(baseReal, id, 'sessions'), permitida: casa, rotulo: `.plataforma/codex-api/${id}/sessions`, prefixo: `api/${id}/` }, restante);
    r.arquivos.push(...sub.arquivos);
    r.avisos.push(...sub.avisos);
    r.avisosOmitidos += sub.avisosOmitidos;
    r.atalhos_ignorados += sub.atalhos_ignorados;
    r.entradas += sub.entradas;
    if (sub.estado === 'parcial') { r.parcial = r.parcial || sub.motivo; break; }
    if (sub.estado === 'ilegivel') { ilegiveis++; primeiroMotivo = primeiroMotivo || sub.motivo; r.avisos.push({ tipo: 'pasta_ilegivel', motivo: sub.motivo, arquivo: `codex:.plataforma/codex-api/${id}` }); }
    else if (sub.estado === 'vazia') vazias++;
  }
  if (r.arquivos.length) r.estado = 'ok';
  else if (r.estado !== 'ilegivel' && ilegiveis) { r.estado = 'ilegivel'; r.motivo = `nenhuma pasta de .plataforma/codex-api pôde ser lida: ${primeiroMotivo}`; }
  else if (r.estado !== 'ilegivel' && ids.length && vazias === ids.length) { r.estado = 'vazia'; r.motivo = '.plataforma/codex-api existe, mas ainda não tem nenhuma sessão gravada'; }
  return r;
}

/** Junta a pasta da assinatura com as da chave de API numa fonte só do motor Codex. */
function unePastasDoCodex(d, api, lim) {
  const arquivos = d.arquivos.concat(api.arquivos);
  const parcial = d.estado === 'parcial' ? d.motivo : api.parcial;
  const u = Object.assign({}, d, {
    arquivos,
    avisos: d.avisos.concat(api.avisos),
    avisosOmitidos: d.avisosOmitidos + api.avisosOmitidos,
    atalhos_ignorados: d.atalhos_ignorados + api.atalhos_ignorados,
    entradas: d.entradas + api.entradas,
  });
  if (api.parcial) u.avisos.push({ tipo: 'limite', motivo: api.parcial, arquivo: 'codex' });
  if (arquivos.length) {
    u.estado = parcial ? 'parcial' : 'ok';
    u.motivo = parcial || null;
    if (d.estado === 'ilegivel') u.avisos.push({ tipo: 'pasta_ilegivel', motivo: d.motivo, arquivo: 'codex:assinatura' });
    if (api.estado === 'ilegivel') u.avisos.push({ tipo: 'pasta_ilegivel', motivo: api.motivo, arquivo: 'codex:.plataforma/codex-api' });
  } else if (parcial) {
    u.estado = 'parcial'; u.motivo = parcial;
  } else if (d.estado === 'ilegivel' || api.estado === 'ilegivel') {
    u.estado = 'ilegivel'; u.motivo = d.estado === 'ilegivel' ? d.motivo : api.motivo;
  } else if (d.estado === 'vazia' || api.estado === 'vazia') {
    u.estado = 'vazia'; u.motivo = d.estado === 'vazia' ? d.motivo : api.motivo;
  } else {
    u.estado = 'ausente';
    u.motivo = `${d.motivo || 'nunca rodou neste motor'}; também não há sessões em .plataforma/codex-api`;
  }
  return u;
}

function resumoDaFonte(f) {
  const ok = f.estado === 'ok' || f.estado === 'parcial';
  return {
    motor: f.motor,
    estado: f.estado,
    motivo: f.motivo == null ? null : limpa(f.motivo),
    arquivos: ok || f.estado === 'vazia' ? f.arquivos.length : null,
    bytes: ok || f.estado === 'vazia' ? f.arquivos.reduce((s, a) => s + a.bytes, 0) : null,
    ultima_atividade: ok && f.arquivos.length ? Math.round(f.arquivos.reduce((m, a) => Math.max(m, a.mtimeMs), 0)) : null,
  };
}

// ── abrir com segurança ────────────────────────────────────────────────────
async function abrirSeguro(arq) {
  let fh;
  try {
    fh = await fsp.open(arq.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP') throw new ErroArquivo('arquivo_recusado', 'o arquivo virou um atalho; recusei por segurança');
    throw new ErroArquivo('arquivo_ilegivel', `não consegui abrir o arquivo (${e.code || e.message})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ErroArquivo('arquivo_recusado', 'não é um arquivo regular');
    if (st.nlink !== 1) throw new ErroArquivo('arquivo_recusado', 'o arquivo tem mais de um nome no disco (hardlink); recusei por segurança');
    let alvo;
    try { alvo = await fsp.readlink(`/proc/self/fd/${fh.fd}`); } catch (e) {
      throw new ErroArquivo('arquivo_recusado', `não consegui confirmar o caminho real do arquivo (/proc indisponível: ${e.code || e.message}); recusei por segurança`);
    }
    if (alvo.endsWith(' (deleted)')) alvo = alvo.slice(0, -10);
    if (!(alvo === arq.raizReal || alvo.startsWith(arq.raizReal + path.sep))) throw new ErroArquivo('arquivo_recusado', 'o caminho real do arquivo fica fora da pasta do agente; recusei por segurança');
    return { fh, size: st.size };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

// ── extração por motor ─────────────────────────────────────────────────────
const OPERACAO_ARQUIVO = { Read: 'ler', Write: 'escrever', Edit: 'editar', MultiEdit: 'editar', NotebookEdit: 'editar' };

/** Só string entra: objeto vindo do log (com toString hostil, por exemplo) nunca é convertido. */
const str = (v) => (typeof v === 'string' ? v : '');

function textoDeBlocos(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const partes = [];
  for (const b of c) {
    if (typeof b === 'string') partes.push(b);
    else if (b && typeof b.text === 'string') partes.push(b.text);
    else if (b && typeof b === 'object' && typeof b.type === 'string') partes.push(`[${b.type.slice(0, 30)}]`);
  }
  return partes.join('\n');
}

function resultadoDe(bruto, erro) {
  const p = preparaTexto(bruto, TETO_RESULTADO);
  return { erro: !!erro, texto: p.texto, truncado: p.truncado };
}

/** Elemento da lista como um argumento só: o que tem espaço ou caractere especial vai entre aspas simples, para o mascarador ler os mesmos limites da lista. */
function argumentoDeLista(e) {
  const v = str(e);
  if (v !== '' && /^[A-Za-z0-9_\/:.,=@%+-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function comandoDeLista(c) {
  if (Array.isArray(c)) {
    if (c.length >= 3 && typeof c[1] === 'string' && RX_SHELL_C.test(c[1])) return str(c[2]);
    return c.map(argumentoDeLista).join(' ');
  }
  return typeof c === 'string' ? c : '';
}

async function extraiClaude(j, leitor, soRes) {
  const tipoLinha = j.type;
  if (tipoLinha === 'system') {
    if (!soRes && j.subtype === 'compact_boundary') return [{ tipo: 'sistema', papel: 'sistema', titulo: 'Conversa compactada', texto: '' }];
    return [];
  }
  if (tipoLinha !== 'user' && tipoLinha !== 'assistant') return [];
  const msg = j.message;
  if (!msg || typeof msg !== 'object') return [];
  const papel = tipoLinha === 'assistant' ? 'agente' : (leitor.arq.subagente ? 'sistema' : 'pessoa');
  const c = msg.content;
  const out = [];
  const mensagem = (texto) => {
    if (typeof texto !== 'string' || !texto.trim()) return;
    out.push({ tipo: 'mensagem', papel, titulo: papel === 'pessoa' ? 'Mensagem da pessoa' : papel === 'agente' ? 'Resposta do agente' : 'Instrução recebida', texto });
  };
  if (typeof c === 'string') { if (!soRes) mensagem(c); return out; }
  if (!Array.isArray(c)) return [];
  let n = 0;
  for (const b of c) {
    // Uma linha pode trazer milhares de blocos: cede o laço e confere o prazo no meio dela (null = abandonada, será relida).
    await leitor.ctx.cede();
    if (++n % 16 === 0 && leitor.ctx.excedeu()) return null;
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') {
      if (typeof b.tool_use_id === 'string') leitor.guardaResultado(b.tool_use_id, resultadoDe(textoDeBlocos(b.content), b.is_error));
      continue;
    }
    if (soRes) continue;
    if (b.type === 'text') mensagem(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const entrada = b.input && typeof b.input === 'object' ? b.input : {};
      const resultado = typeof b.id === 'string' ? leitor.resultados.get(b.id) || null : null;
      if (b.name === 'Bash') {
        out.push({ tipo: 'comando', titulo: typeof entrada.description === 'string' && entrada.description ? entrada.description : 'Comando', comando: str(entrada.command), descricao: str(entrada.description), resultado });
      } else if (OPERACAO_ARQUIVO[b.name]) {
        const caminho = [entrada.file_path, entrada.notebook_path, entrada.path].find((v) => typeof v === 'string' && v) || '';
        out.push({ tipo: 'arquivo', titulo: `${OPERACAO_ARQUIVO[b.name] === 'ler' ? 'Leu' : OPERACAO_ARQUIVO[b.name] === 'escrever' ? 'Escreveu' : 'Editou'} um arquivo`, caminho, operacao: OPERACAO_ARQUIVO[b.name], ferramenta: b.name, resultado });
      } else {
        out.push({ tipo: 'ferramenta', titulo: b.name, ferramenta: b.name, entrada, resultado });
      }
    }
  }
  return out;
}

function ehContextoInjetado(texto) {
  const t = String(texto).trimStart();
  return CONTEXTO_INJETADO.some((p) => t.startsWith(p)) || t.startsWith('<plataforma');
}

function itemCodex(item, out) {
  switch (item && item.type) {
    case 'UserMessage': { const t = textoDeBlocos(item.content); if (t.trim()) out.push({ tipo: 'mensagem', papel: 'pessoa', titulo: 'Mensagem da pessoa', texto: t }); break; }
    case 'AgentMessage': { const t = textoDeBlocos(item.content); if (t.trim()) out.push({ tipo: 'mensagem', papel: 'agente', titulo: 'Resposta do agente', texto: t }); break; }
    case 'CommandExecution': {
      const erro = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      out.push({ tipo: 'comando', titulo: 'Comando', comando: comandoDeLista(item.command), resultado: resultadoDe(item.aggregated_output, erro) });
      break;
    }
    case 'McpToolCall': {
      const nome = [item.server, item.tool].filter((x) => typeof x === 'string' && x).join('/') || 'ferramenta MCP';
      const erro = item.status !== undefined && item.status !== 'completed';
      const res = item.result ? resultadoDe(textoDeBlocos(item.result.content), erro) : (item.error ? resultadoDe(item.error, true) : null);
      out.push({ tipo: 'ferramenta', titulo: nome, ferramenta: nome, entrada: item.arguments, resultado: res });
      break;
    }
    case 'FileChange': {
      let caminho = [item.path, item.file_path].find((v) => typeof v === 'string' && v) || '';
      if (!caminho && Array.isArray(item.changes) && item.changes[0]) caminho = str(item.changes[0].path);
      if (!caminho && item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes)) caminho = Object.keys(item.changes)[0] || '';
      out.push({ tipo: 'arquivo', titulo: 'Alterou um arquivo', caminho, operacao: 'alterar', ferramenta: 'FileChange', resultado: null });
      break;
    }
    default: break;
  }
}

function saidaDeFuncao(o) {
  if (typeof o === 'string') {
    try {
      const j = JSON.parse(o);
      if (j && typeof j === 'object' && typeof j.output === 'string') {
        const cod = j.metadata && j.metadata.exit_code;
        return resultadoDe(j.output, typeof cod === 'number' && cod !== 0);
      }
    } catch (_) { /* texto puro */ }
    return resultadoDe(o, false);
  }
  return resultadoDe(textoDeBlocos(o), false);
}

const NOMES_SHELL = new Set(['shell', 'local_shell', 'exec_command', 'container.exec', 'shell_command']);

const JANELA_MSG_MS = 5000;
const JANELA_FERRAMENTA_MS = 3000;
/** Hash do texto bruto e completo (antes da máscara e de qualquer corte): é só ele que fica no mapa de pares. */
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
/** Comparação sem normalização nenhuma: `cliente  A` e `cliente A` são comandos diferentes, e um texto só é igual a outro por inteiro. */
const chaveComando = (t) => (t ? `cmd:${sha(t)}` : null);
const chaveTexto = (t) => (t ? `txt:${sha(t)}` : null);

/**
 * O Codex grava a mesma ação em duas famílias de registro (event_msg/item_completed e response_item), às vezes no mesmo
 * arquivo. Cada linha é decidida pelos campos estruturais (type e payload.type), nunca por busca de texto, e a marca `ded`
 * diz como achar o par na outra família (ver LeitorArquivo._dedup).
 */
function extraiCodex(j, leitor) {
  const p = j.payload;
  if (!p || typeof p !== 'object') return [];
  const out = [];
  if (j.type === 'event_msg' && p.type === 'item_completed') {
    itemCodex(p.item, out);
    for (const r of out) {
      const id = str(p.item && p.item.id) || null;
      const t = Number.isFinite(p.started_at_ms) ? p.started_at_ms : null;
      if (r.tipo === 'mensagem') r.ded = { fam: 'ic', cls: `msg:${r.papel}`, key: chaveTexto(r.texto), t: null, id: null };
      else if (r.tipo === 'comando') r.ded = { fam: 'ic', cls: 'exec', key: r.comando ? chaveComando(r.comando) : null, t, id };
      else if (id) r.ded = { fam: 'ic', cls: 'tool', key: null, t, id };   // ferramenta e arquivo: só o id identifica, sem id ficam os dois
    }
    return out;
  }
  if (j.type !== 'response_item') return [];
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    if (typeof p.call_id === 'string') leitor.guardaResultado(p.call_id, saidaDeFuncao(p.output));
    return [];
  }
  if (p.type === 'message') {
    const t = textoDeBlocos(p.content);
    if (!t.trim()) return [];
    if (p.role === 'assistant') out.push({ tipo: 'mensagem', papel: 'agente', titulo: 'Resposta do agente', texto: t });
    else if (p.role === 'user' && !ehContextoInjetado(t)) out.push({ tipo: 'mensagem', papel: 'pessoa', titulo: 'Mensagem da pessoa', texto: t });
    for (const r of out) r.ded = { fam: 'ri', cls: `msg:${r.papel}`, key: chaveTexto(r.texto), t: null, id: null };
    return out;
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const nome = typeof p.name === 'string' ? p.name : 'ferramenta';
    const resultado = typeof p.call_id === 'string' ? leitor.resultados.get(p.call_id) || null : null;
    const id = str(p.call_id) || null;
    let args = p.type === 'function_call' ? p.arguments : p.input;
    if (typeof args === 'string' && p.type === 'function_call') { try { args = JSON.parse(args); } catch (_) { /* fica texto */ } }
    if (nome === 'apply_patch') {
      const txt = typeof args === 'string' ? args : serializa(args && (args.input || args.patch));
      const m = RX_PATCH.exec(txt.length > BRUTO ? txt.slice(0, BRUTO) : txt);
      out.push({ tipo: 'arquivo', titulo: 'Alterou um arquivo', caminho: m ? m[1].trim() : '', operacao: 'alterar', ferramenta: nome, resultado, ded: id ? { fam: 'ri', cls: 'tool', key: null, t: null, id } : undefined });
    } else if (NOMES_SHELL.has(nome) || nome === 'exec') {
      const cmd = args && typeof args === 'object' ? (comandoDeLista(args.command) || (str(args.cmd))) : (typeof args === 'string' ? args : '');
      // `exec` embrulha JavaScript com chamadas que não se comparam com segurança a um item: só o id pareia, senão ficam os dois.
      const real = nome === 'exec' ? null : cmd;
      out.push({ tipo: 'comando', titulo: 'Comando', comando: cmd, resultado, ded: real || id ? { fam: 'ri', cls: 'exec', key: real ? chaveComando(real) : null, t: null, id } : undefined });
    } else {
      out.push({ tipo: 'ferramenta', titulo: nome, ferramenta: nome, entrada: args, resultado });
    }
  }
  return out;
}

// ── evento final ───────────────────────────────────────────────────────────
async function montaEvento(item, arq, bases, ctx) {
  const { r, key, ts, suspeito } = item;
  const detalhes = {};
  let truncado = false;
  const busca = [];
  const ehComando = r.tipo === 'comando';
  const titulo = corta(limpa(ehComando ? comandoExibivel(r.titulo) : r.titulo), 200).texto;
  busca.push(titulo);
  let texto = '';
  if (r.texto) {
    await ctx.cede();
    const p = preparaTexto(r.texto, TETO_TEXTO);
    texto = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  if (r.comando != null && r.comando !== '') {
    await ctx.cede();
    const p = preparaTexto(comandoExibivel(r.comando), TETO_COMANDO);
    detalhes.comando = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  if (typeof r.descricao === 'string' && r.descricao) { detalhes.descricao = corta(limpa(ehComando ? comandoExibivel(r.descricao) : r.descricao), 300).texto; busca.push(detalhes.descricao); }
  if (r.caminho) { detalhes.caminho = limpa(caminhoRelativo(r.caminho, bases)); busca.push(detalhes.caminho); }
  if (r.operacao) detalhes.operacao = r.operacao;
  if (r.ferramenta) detalhes.ferramenta = corta(limpa(r.ferramenta), 120).texto;
  if (r.entrada !== undefined && r.entrada !== null && r.entrada !== '') {
    await ctx.cede();
    const p = preparaTexto(r.entrada, TETO_COMANDO);
    detalhes.entrada = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  const ev = {
    id: `${key.f}:${key.o}${key.i ? '.' + key.i : ''}`,
    horario: new Date(ts).toISOString(),
    t: ts,
    sessao: arq.sessao,
    motor: arq.motor,
    subagente: arq.subagente,
    projeto: arq.projeto ? limpa(arq.projeto) : null,
    tipo: r.tipo,
  };
  if (r.papel) ev.papel = r.papel;
  ev.titulo = titulo;
  ev.texto = texto;
  ev.detalhes = detalhes;
  if (r.resultado !== undefined && (r.tipo === 'comando' || r.tipo === 'arquivo' || r.tipo === 'ferramenta')) {
    ev.resultado = r.resultado;
    if (r.resultado) { busca.push(r.resultado.texto); truncado = truncado || r.resultado.truncado; }
  }
  if (truncado) ev.truncado = true;
  if (suspeito) ev.horario_suspeito = true;
  await ctx.cede();
  return { ev, busca: normaliza(busca.join('\n')) };
}

// ── leitor de um arquivo, de trás para frente ──────────────────────────────
class LeitorArquivo {
  constructor(arq, ctx, hint) {
    this.arq = arq;
    this.ctx = ctx;
    this.hint = hint || null;
    this.fh = null;
    this.size = 0;
    this.estado = 'novo';     // novo | aberto | suspenso | fim
    this.fmt = 0;           // Codex: 0 nenhuma linha lida, 1 viu registro de conversa, 2 só linhas desconhecidas
    this.vistos = [];       // pares possíveis entre as duas famílias do Codex (ver _dedup)
    this.resultados = new Map();
    this.fila = [];
    this.cabeca = null;
    this.teto = arq.mtimeMs + FOLGA_MTIME;
    this.pend = Buffer.alloc(0);
    this.pos = 0;
    this.pulando = false;
    this.contaGigante = false;
    this.pausado = false;
    this.soResultadoAcima = Infinity;
    this.ultimaLida = null;
    this.retomada = null;
  }

  guardaResultado(id, res) {
    if (this.resultados.has(id)) this.resultados.delete(id);
    this.resultados.set(id, res);
    if (this.resultados.size > MAX_RESULTADOS) this.resultados.delete(this.resultados.keys().next().value);
  }

  aviso(tipo, motivo) { this.ctx.avisa({ tipo, motivo, arquivo: this.arq.rotulo }); }

  async _le(buf, n, pos) {
    const { bytesRead } = await this.fh.read(buf, 0, n, pos);
    this.ctx.lidos += bytesRead;
    return bytesRead;
  }

  async _abre() {
    const a = await abrirSeguro(this.arq);
    this.fh = a.fh;
    this.size = a.size;
    this.ctx.fdsAbertos++;
  }

  /** Primeira abertura: aplica o hint (se for válido) ou começa pelo fim do arquivo. */
  async iniciar() {
    try {
      if (this.hint && this.hint.o === -1) { this.estado = 'fim'; return; }
      await this._abre();
      this.estado = 'aberto';
      if (this.estado === 'fim') return;
      let topo = this.size;
      const h = this.hint;
      if (h && h.o >= 0 && h.o <= this.size) {
        this.fmt = h.f || 0;
        let valido = h.o === 0;
        if (!valido) {
          const b = Buffer.alloc(1);
          valido = (await this._le(b, 1, h.o - 1)) === 1 && b[0] === 10;
        }
        if (valido) {
          topo = Math.min(this.size, h.o + JANELA_HINT);
          this.soResultadoAcima = h.o;
          this.teto = Math.min(this.teto, h.teto);
        }
      }
      await this._completaTopo(topo);
    } catch (e) { this._falhou(e); }
  }

  /** Move o topo da leitura para uma fronteira de linha (depois de um \n). Resto parcial no fim do arquivo é descartado. */
  async _completaTopo(topo) {
    this.pos = topo;
    this.pend = Buffer.alloc(0);
    if (topo === 0) return;
    const b = Buffer.alloc(1);
    await this._le(b, 1, topo - 1);
    if (b[0] === 10) return;
    if (topo >= this.size) { this.pulando = true; return; }   // última linha sem \n: está sendo escrita
    // topo no meio de uma linha: anda para frente até o próximo \n
    let p = topo;
    const bloco = Buffer.allocUnsafe(BLOCO);
    const limite = topo + MAX_LINHA;
    while (p < this.size && p < limite) {
      const n = Math.min(BLOCO, this.size - p);
      const lidos = await this._le(bloco, n, p);
      if (lidos <= 0) break;
      const i = bloco.subarray(0, lidos).indexOf(10);
      if (i >= 0) { this.pos = p + i + 1; return; }
      p += lidos;
    }
    if (p >= this.size) { this.pos = this.size; this.pulando = true; return; }
    this.pos = topo; this.pulando = true;
  }

  /** Próxima linha de trás para frente: { off, fim, buf } ou null (acabou, ou o orçamento estourou: ver this.pausado). */
  async _proxLinha() {
    for (;;) {
      if (!this.pulando) {
        const fimLinha = this.pend.length - 1;
        if (fimLinha >= 0) {
          const j = fimLinha === 0 ? -1 : this.pend.lastIndexOf(10, fimLinha - 1);
          if (j >= 0) {
            const l = { off: this.pos + j + 1, fim: this.pos + fimLinha + 1, buf: this.pend.subarray(j + 1, fimLinha) };
            this.pend = this.pend.subarray(0, j + 1);
            return l;
          }
          if (this.pos === 0) {
            const l = { off: 0, fim: fimLinha + 1, buf: this.pend.subarray(0, fimLinha) };
            this.pend = Buffer.alloc(0);
            return l;
          }
          if (this.pend.length > MAX_LINHA + 1) {
            this.pulando = true;
            this.contaGigante = true;
            this.pend = Buffer.alloc(0);
            continue;
          }
        }
      }
      if (this.pos === 0) {
        if (this.pulando && this.contaGigante) this.ctx.contagens.linhas_gigantes++;
        this.pulando = false; this.contaGigante = false; this.pend = Buffer.alloc(0);
        return null;
      }
      if (this.ctx.excedeu()) { this.pausado = true; return null; }
      const n = Math.min(BLOCO, this.pos);
      const ini = this.pos - n;
      const b = Buffer.allocUnsafe(n);
      const lidos = await this._le(b, n, ini);
      if (lidos < n) throw new ErroArquivo('arquivo_ilegivel', 'o arquivo encolheu durante a leitura (alguém o reescreveu)');
      this.pos = ini;
      if (this.pulando) {
        const idx = b.lastIndexOf(10);
        if (idx >= 0) {
          this.pend = b.subarray(0, idx + 1);
          this.pulando = false;
          if (this.contaGigante) { this.ctx.contagens.linhas_gigantes++; this.contaGigante = false; }
        }
        continue;
      }
      this.pend = this.pend.length ? Buffer.concat([b, this.pend]) : b;
    }
  }

  /** Preenche this.cabeca com o próximo evento (ou null se acabou ou pausou). */
  async avancar() {
    this.cabeca = null;
    if (this.estado === 'novo') await this.iniciar();
    try {
      for (;;) {
        if (this.fila.length) { this.cabeca = this.fila.shift(); return; }
        if (this.estado === 'suspenso') await this._retoma();
        if (this.estado !== 'aberto') return;
        const l = await this._proxLinha();
        if (!l) { if (!this.pausado) this._fimDaLeitura(); return; }
        this.ultimaLida = { off: l.off, fim: l.fim, tetoAntes: this.teto };
        await this.ctx.cede();
        await this._processa(l);
        if (this.pausado) return;
      }
    } catch (e) { this._falhou(e); }
  }

  async _processa(l) {
    const soRes = l.off > this.soResultadoAcima;
    if (!l.buf.length) return;
    let j;
    try { j = JSON.parse(l.buf.toString('utf8')); } catch (_) { if (!soRes) this.ctx.contagens.linhas_ilegiveis++; return; }
    if (!j || typeof j !== 'object') { if (!soRes) this.ctx.contagens.linhas_ilegiveis++; return; }
    if (this.arq.motor === 'codex') {
      if (j.type === 'response_item' || (j.type === 'event_msg' && j.payload && j.payload.type === 'item_completed')) this.fmt = 1;
      else if (this.fmt === 0) this.fmt = 2;
    }
    let rasc;
    try { rasc = this.arq.motor === 'claude' ? await extraiClaude(j, this, soRes) : extraiCodex(j, this); } catch (_) {
      // Registro com campo de tipo inesperado: conta como linha ilegível e a leitura segue.
      if (!soRes) this.ctx.contagens.linhas_ilegiveis++;
      return;
    }
    if (rasc === null) { this.pausado = true; return; }
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
    // Linhas da janela de resultados também entram na conta dos pares, para a decisão ser a mesma em qualquer página.
    if (this.arq.motor === 'codex' && rasc.length && Number.isFinite(ts)) rasc = this._dedup(rasc, ts);
    if (soRes || !rasc.length) return;
    if (!Number.isFinite(ts)) { this.ctx.contagens.sem_horario += rasc.length; return; }
    const tOrdem = Math.min(ts, this.teto);
    this.teto = tOrdem;
    if (tOrdem < this.ctx.desde) { this._encerra(); return; }
    if (ts > this.ctx.ate) return;
    const suspeito = ts > this.arq.mtimeMs + FOLGA_MTIME;
    const novos = [];
    rasc.forEach((r, i) => {
      const key = { t: tOrdem, f: this.arq.id, o: l.off, i };
      if (this.ctx.cursorChave && cmp(key, this.ctx.cursorChave) >= 0) return;
      if (this.ctx.tipos && !this.ctx.tipos.has(r.tipo)) return;
      novos.push({ key, r, ts, suspeito, arq: this.arq });
    });
    novos.reverse();
    this.fila.push(...novos);
  }

  /**
   * Par entre famílias: a primeira linha vista (na leitura de trás para frente) fica e a segunda, da outra família, é
   * descartada, mas só com correspondência inequívoca: o mesmo id (call_id igual ao id do item) ou a mesma classe com o
   * mesmo conteúdo normalizado dentro da janela (mensagens: papel e texto, 5 s; comandos: o texto do comando, 3 s), um para
   * um. Conteúdo ausente ou que não se compara (por exemplo um `exec` com várias chamadas, ou ferramenta sem id) mantém os dois
   * eventos: num log de auditoria sobra repetição, nunca falta ação. No máximo 512 candidatos na memória.
   */
  _dedup(rasc, ts) {
    const out = [];
    for (const r of rasc) {
      const d = r.ded;
      if (!d) { out.push(r); continue; }
      const t = d.t == null ? ts : d.t;
      const janela = d.cls.startsWith('msg:') ? JANELA_MSG_MS : JANELA_FERRAMENTA_MS;
      let achou = null;
      for (let k = this.vistos.length - 1; k >= Math.max(0, this.vistos.length - 128); k--) {
        const e = this.vistos[k];
        if (e.usado || e.fam === d.fam) continue;
        // Só há duplicata com correspondência inequívoca: mesmo id, ou mesma classe e mesmo conteúdo dentro da janela.
        if ((e.id && d.id && e.id === d.id) || (e.cls === d.cls && e.key !== null && d.key !== null && e.key === d.key && Math.abs(e.t - t) <= janela)) { achou = e; break; }
      }
      if (achou) { achou.usado = true; continue; }
      this.vistos.push({ fam: d.fam, cls: d.cls, key: d.key, t, id: d.id, usado: false });
      if (this.vistos.length > MAX_RESULTADOS) this.vistos.shift();
      out.push(r);
    }
    return out;
  }

  /** Hint para o próximo pedido: a última linha lida (relida e filtrada pela chave) e o teto de antes dela. */
  hintAtual() {
    if (this.estado === 'fim' && !this.fila.length && !this.cabeca) return [-1, 0];
    if (this.ultimaLida) return [this.ultimaLida.off, this.ultimaLida.tetoAntes, this.fmt];
    if (this.hint && this.hint.o >= -1) return [this.hint.o, this.hint.teto, this.hint.f || 0];
    return null;
  }

  async suspender() {
    if (this.estado !== 'aberto') return;
    this.retomada = { topo: this.ultimaLida ? this.ultimaLida.off : this.pos, teto: this.teto, soRes: this.soResultadoAcima };
    await this.fechaFd();
    this.estado = 'suspenso';
  }

  async _retoma() {
    try {
      await this._abre();
      this.estado = 'aberto';
      const r = this.retomada;
      this.pos = r.topo; this.pend = Buffer.alloc(0); this.pulando = false; this.contaGigante = false;
      this.teto = r.teto; this.soResultadoAcima = r.soRes;
    } catch (e) { this._falhou(e); }
  }

  /** Fecha o descritor. Quem chama depois do primeiro pedido espera o mesmo fechamento (não volta antes dele terminar). */
  fechaFd() {
    if (this.fechando) return this.fechando;
    if (!this.fh) return Promise.resolve();
    const fh = this.fh;
    this.fh = null;
    this.ctx.fdsAbertos--;
    this.fechando = fh.close().catch(() => {}).then(() => { this.fechando = null; });
    return this.fechando;
  }

  /** Leu o arquivo até o começo: só agora dá para dizer que o formato não foi reconhecido (janela sem registro é inconclusiva). */
  _fimDaLeitura() {
    if (this.arq.motor === 'codex' && this.fmt === 2) {
      this.aviso('formato_desconhecido', 'formato não reconhecido: li o arquivo inteiro e não achei registros de conversa (item_completed ou response_item)');
    }
    this._encerra();
  }

  _encerra() { this.estado = 'fim'; this.fila = []; this.fechaFd(); }

  _falhou(e) {
    if (e instanceof ErroArquivo) this.aviso(e.tipo, e.motivo);
    else this.aviso('arquivo_ilegivel', `falha ao ler o arquivo (${e && (e.code || e.message)})`);
    this._encerra();
  }
}

// ── pedido ─────────────────────────────────────────────────────────────────
function novoCtx(opc) {
  const ctx = {
    lidos: 0,
    inicio: opc.relogio(),
    maxBytes: opc.maxBytes,
    maxMs: opc.maxMs,
    relogio: opc.relogio,
    fdsAbertos: 0,
    contagens: { linhas_ilegiveis: 0, linhas_gigantes: 0, sem_horario: 0, atalhos_ignorados: 0 },
    avisos: [],
    omitidos: 0,
    maxAvisos: opc.maxAvisos || MAX_AVISOS,
    vistos: new Set(),
    cede: criaCede(opc.relogio),
    desde: -Infinity,
    ate: Infinity,
    tipos: null,
    cursorChave: null,
    excedeu() { return ctx.lidos >= ctx.maxBytes || ctx.relogio() - ctx.inicio >= ctx.maxMs; },
    avisa(a) {
      const k = `${a.tipo}|${a.arquivo || ''}|${a.motivo}`;
      if (ctx.vistos.has(k)) return;
      ctx.vistos.add(k);
      if (ctx.avisos.length < ctx.maxAvisos || a.tipo === 'limite') ctx.avisos.push({ tipo: a.tipo, motivo: limpa(a.motivo), ...(a.arquivo ? { arquivo: limpa(a.arquivo) } : {}) });
      else ctx.omitidos++;
    },
    /** Lista final de avisos: os guardados e, se passou do teto, uma linha dizendo quantos ficaram de fora. */
    avisosFinais() {
      if (!ctx.omitidos) return ctx.avisos;
      return ctx.avisos.concat([{ tipo: 'avisos_omitidos', motivo: `mais ${ctx.omitidos} aviso(s) parecidos foram omitidos para a resposta não crescer sem limite` }]);
    },
  };
  return ctx;
}

function criarLeitor({ log, agora, orcamento } = {}) {
  const relogio = typeof agora === 'function' ? agora : () => Date.now();
  const o = orcamento || {};
  const lim = {
    maxArquivos: o.maxArquivos || MAX_ARQUIVOS, maxProfundidade: o.maxProfundidade || MAX_PROFUNDIDADE,
    maxEntradas: o.maxEntradas || MAX_ENTRADAS, maxPastas: o.maxPastas || MAX_PASTAS, maxAvisos: o.maxAvisos || MAX_AVISOS,
    ms: o.descobertaMs || PRAZO_DESCOBERTA_MS, relogio, cede: criaCede(relogio),
  };
  const aviso = log || (() => {});

  async function descobre(ag, ctx) {
    const fontes = [];
    const lista = fontesDoAgente(ag);
    // Admin sem codex_home_host (usa o Claude): só entra uma fonte do Codex se houver sessão por chave de API na casa dele.
    const semCodex = ag.tipo === 'admin' && ag.home_host && !lista.some((f) => f.motor === 'codex');
    if (semCodex) lista.push({ motor: 'codex', semRaiz: 'nunca rodou neste motor', api: ag.home_host, opcional: true });
    for (const f of lista) {
      const inicio = lim.relogio();
      let d = await descobreFonte(f, lim);
      if (f.motor === 'codex' && f.api) {
        const api = await descobreApi(f.api, lim, { arquivos: d.arquivos.length, entradas: d.entradas, inicio });
        d = unePastasDoCodex(d, api, lim);
        if (f.opcional && d.estado === 'ausente') continue;
      }
      for (const a of d.avisos) ctx.avisa(a);
      ctx.contagens.atalhos_ignorados += d.atalhos_ignorados;
      ctx.omitidos += d.avisosOmitidos;
      fontes.push(d);
    }
    // Nada para ler em nenhuma fonte: os motivos vão também nos avisos (a tela nunca diz "sem ações" nesse caso).
    if (!fontes.some((d) => (d.estado === 'ok' || d.estado === 'parcial') && d.arquivos.length)) {
      for (const d of fontes) ctx.avisa({ tipo: `fonte_${d.estado}`, motivo: d.motivo, arquivo: d.motor });
    }
    return fontes;
  }

  const ctxSimples = () => novoCtx({ relogio, maxBytes: Infinity, maxMs: Infinity, maxAvisos: lim.maxAvisos });

  async function resumoDasFontes(ag) {
    const ctx = ctxSimples();
    const fontes = await descobre(ag, ctx);
    return { fontes: fontes.map(resumoDaFonte), avisos: ctx.avisosFinais(), contagens: ctx.contagens };
  }

  async function sessoes(ag, { limite, cursor }) {
    const ctx = ctxSimples();
    const fontes = await descobre(ag, ctx);
    const todas = fontes.flatMap((f) => f.arquivos).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    let ini = 0;
    if (cursor) {
      if (!cursor.chave) throw new ErroEntrada(400, 'O cursor das sessões não tem posição. Peça a primeira página de novo, sem o parâmetro "cursor".');
      ini = todas.findIndex((a) => a.mtimeMs < cursor.chave.t || (a.mtimeMs === cursor.chave.t && a.id > cursor.chave.f));
      if (ini < 0) ini = todas.length;
    }
    const pagina = todas.slice(ini, ini + limite);
    const mais = ini + limite < todas.length;
    const ultimo = pagina[pagina.length - 1];
    return {
      sessoes: pagina.map((a) => ({ id: a.id, sessao: a.sessao, motor: a.motor, projeto: a.projeto ? limpa(a.projeto) : null, subagente: a.subagente, bytes: a.bytes, atualizado: new Date(a.mtimeMs).toISOString() })),
      proximo: mais && ultimo ? codificaCursor({ t: ultimo.mtimeMs, f: ultimo.id, o: 0, i: 0 }) : null,
      fontes: fontes.map(resumoDaFonte),
      avisos: ctx.avisosFinais(),
      contagens: ctx.contagens,
    };
  }

  /** filtros: { desde, ate (ms|null), tipos (Set|null), q (texto|null), sessao (string|null), limite, cursor } */
  async function eventos(ag, f) {
    const ctx = novoCtx({ relogio, maxBytes: o.maxBytes || ORCAMENTO_BYTES, maxMs: o.maxMs || ORCAMENTO_MS, maxAvisos: lim.maxAvisos });
    if (f.desde != null) ctx.desde = f.desde;
    if (f.ate != null) ctx.ate = f.ate;
    ctx.tipos = f.tipos || null;
    ctx.cursorChave = f.cursor && f.cursor.chave ? f.cursor.chave : null;
    const hints = f.cursor ? f.cursor.h : {};
    const q = f.q ? normaliza(f.q) : null;
    const bases = [ag.home_host, ag.home_container, ag.codex_home_host];

    const fontes = await descobre(ag, ctx);
    // O prazo de leitura só começa depois da descoberta: uma descoberta lenta não pode deixar a leitura vencida de saída.
    if (typeof o.aposDescoberta === 'function') o.aposDescoberta();
    ctx.inicio = relogio();
    let arqs = fontes.flatMap((x) => x.arquivos);
    if (f.sessao) {
      const alvo = String(f.sessao).toLowerCase();
      arqs = arqs.filter((a) => a.id === alvo || a.sessao === alvo);
      if (!arqs.length) throw new ErroEntrada(404, `Não achei a sessão "${String(f.sessao).slice(0, 40)}" neste agente. Veja as sessões em /api/v1/logs/agentes/${ag.slug}/sessoes.`);
    }
    arqs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    if (ctx.desde > -Infinity) arqs = arqs.filter((a) => a.mtimeMs + FOLGA_MTIME >= ctx.desde);
    const arqsOrdem = arqs.slice();
    // Posição global do cursor: arquivo já aberto numa página anterior e sem hint é arquivo esgotado e não se reabre,
    // a menos que tenha crescido (ou aparecido) depois do nascimento do cursor: aí se relê, e a chave estrita descarta o que já saiu.
    const gIn = f.cursor && f.cursor.g ? f.cursor.g : null;
    const tsIn = f.cursor && f.cursor.ts != null ? f.cursor.ts : null;
    if (gIn) {
      arqs = arqs.filter((a) => depoisDe(a, gIn) || !!hints[a.id] || (tsIn != null && a.mtimeMs >= tsIn - MARGEM_TS_MS));
    }
    let gNovo = gIn;

    const todos = [];        // leitores já criados; o finally os fecha mesmo se algo lançar no meio
    let R;
    try {
      R = await (async () => {
      const pendentes = arqs.slice();
      const abertos = [];      // leitores com cabeça
      const emitidos = [];
      let ultimaChave = null;
      let parcial = false;
      let mais = false;
      let acabou = false;

      const topoAtual = () => {
        let m = null;
        for (const r of abertos) if (r.cabeca && (!m || cmp(r.cabeca.key, m) > 0)) m = r.cabeca.key;
        return m;
      };

      async function limitaFds() {
        while (ctx.fdsAbertos > MAX_FDS) {
          let alvo = null;
          for (const r of abertos) if (r.estado === 'aberto' && r.cabeca && (!alvo || cmp(r.cabeca.key, alvo.cabeca.key) < 0)) alvo = r;
          if (!alvo) return;
          await alvo.suspender();
        }
      }

      async function abrePendentes() {
        while (pendentes.length && !ctx.excedeu()) {
          const topo = topoAtual();
          const prox = pendentes[0];
          if (topo && prox.mtimeMs + FOLGA_MTIME < topo.t) return;
          pendentes.shift();
          if (!gNovo || depoisDe(prox, gNovo)) gNovo = { m: prox.mtimeMs, id: prox.id };
          const l = new LeitorArquivo(prox, ctx, hints[prox.id]);
          todos.push(l);
          await l.avancar();
          if (l.cabeca) abertos.push(l);
          await limitaFds();
        }
      }

      for (;;) {
        if (ctx.excedeu()) { parcial = true; break; }
        // Página cheia: para sem olhar adiante (olhar adiante leria o arquivo todo quando o resto não tem ação).
        if (emitidos.length >= f.limite) { mais = abertos.length > 0 || pendentes.length > 0; break; }
        // Quem teve a cabeça consumida só avança agora, quando a leitura é de fato necessária.
        for (const r of abertos.slice()) {
          if (!r.cabeca) {
            await r.avancar();
            if (!r.cabeca && !r.pausado) abertos.splice(abertos.indexOf(r), 1);
          }
          if (ctx.excedeu()) break;
        }
        await limitaFds();
        if (ctx.excedeu()) { parcial = true; break; }
        await abrePendentes();
        if (ctx.excedeu()) { parcial = true; break; }
        const prontos = abertos.filter((r) => r.cabeca);
        if (!prontos.length) {
          if (abertos.length || pendentes.length) continue;
          acabou = true;
          break;
        }
        let melhor = prontos[0];
        for (const r of prontos) if (cmp(r.cabeca.key, melhor.cabeca.key) > 0) melhor = r;
        const item = melhor.cabeca;
        ultimaChave = item.key;
        melhor.cabeca = null;
        let montado = null;
        try { montado = await montaEvento(item, item.arq, bases, ctx); } catch (e) {
          // Registro malformado (campo de tipo inesperado): conta como linha ilegível e a leitura segue.
          ctx.contagens.linhas_ilegiveis++;
          aviso('aviso', `Logs: registro malformado ignorado em ${item.arq.rotulo} (${e && e.message ? String(e.message).slice(0, 80) : 'erro'}).`);
        }
        if (montado && (!q || montado.busca.includes(q))) emitidos.push(montado.ev);
        await ctx.cede();
      }

      return { emitidos, ultimaChave, parcial, mais, acabou };
      })();
    } finally {
      for (const l of todos) await l.fechaFd();
    }
    const { emitidos, ultimaChave, parcial, mais, acabou } = R;

    // h guarda só os arquivos lidos pela metade (nunca os esgotados); g marca até onde a lista ordenada já foi aberta.
    const h = {};
    const perdidos = [];
    const andamento = [];
    for (const l of todos) {
      const exausto = l.estado === 'fim' && !l.fila.length && !l.cabeca;
      if (exausto) continue;
      const hint = l.hintAtual();
      if (hint && hint[0] >= 0) andamento.push({ l, hint }); else perdidos.push(l);
    }
    andamento.sort((a, b) => (b.l.arq.bytes - b.hint[0]) - (a.l.arq.bytes - a.hint[0]));   // mais progresso já feito primeiro
    for (const x of andamento.slice(0, MAX_HINTS)) h[x.l.arq.id] = x.hint;
    for (const x of andamento.slice(MAX_HINTS)) perdidos.push(x.l);
    let gFinal = gNovo;
    if (perdidos.length) {
      // Quem ficou sem hint será relido do fim: g volta para antes do mais antigo deles, para nenhum ser tratado como esgotado.
      const idx = Math.min(...perdidos.map((l) => arqsOrdem.indexOf(l.arq)).filter((i) => i >= 0));
      const prev = Number.isFinite(idx) && idx > 0 ? arqsOrdem[idx - 1] : null;
      const cand = prev ? { m: prev.mtimeMs, id: prev.id } : null;
      if (!cand) gFinal = null; else if (!gFinal || ordemAntes(cand, gFinal)) gFinal = cand;
      if (andamento.length > MAX_HINTS) ctx.avisa({ tipo: 'hints_omitidos', motivo: `${andamento.length - MAX_HINTS} arquivo(s) lidos pela metade não couberam no cursor e serão relidos do fim; a busca continua certa, só um pouco mais lenta` });
    }

    const temMais = mais || parcial;
    let proximo = null;
    let semProgresso = false;
    if (temMais) {
      const c = ultimaChave || ctx.cursorChave;
      const base = c ? { t: c.t, f: c.f, o: c.o, i: c.i } : {};
      const g = gFinal ? { g: [gFinal.m, gFinal.id] } : {};
      proximo = codificaCursor(Object.assign(base, g, { ts: Date.now(), h }));
      if (proximo.length > TETO_CURSOR) proximo = codificaCursor(Object.assign({}, base, g, { ts: Date.now() }));
      // Resposta parcial precisa andar: evento novo ou cursor diferente do recebido. Senão o cliente repetiria o pedido para sempre.
      if (parcial && !mais && !emitidos.length && mesmoCursor(f.cursor, { chave: c, h, g: gFinal })) {
        proximo = null;
        semProgresso = true;
        ctx.avisa({ tipo: 'sem_progresso', motivo: 'A busca não conseguiu avançar dentro do prazo (arquivos muito grandes ou o servidor ocupado), então parei em vez de repetir o mesmo pedido. Estreite o período ou o tipo nos filtros, ou tente de novo mais tarde.' });
      }
    }
    if (!acabou && !temMais) aviso('aviso', 'Logs: a busca terminou sem motivo conhecido.');
    return {
      eventos: emitidos,
      proximo,
      parcial: (parcial && !mais) || semProgresso,
      lidos_bytes: ctx.lidos,
      fontes: fontes.map(resumoDaFonte),
      avisos: ctx.avisosFinais(),
      contagens: ctx.contagens,
    };
  }

  /** Fontes de um agente que não deu tempo de verificar: o estado diz isso, nunca "ausente" nem lista vazia. */
  function fontesNaoVerificadas(ag, motivo) {
    return fontesDoAgente(ag).map((f) => ({ motor: f.motor, estado: 'nao_verificada', motivo, arquivos: null, bytes: null, ultima_atividade: null }));
  }

  return { resumoDasFontes, sessoes, eventos, fontesNaoVerificadas };
}

/** Toda regex deste módulo, com sementes de entradas hostis (começos de casamento): o teste de auditoria as roda em 64 KB. */
const REGEX_AUDITAVEIS = [
  { nome: 'RX_COMANDO', rx: RX_COMANDO, sementes: ['curl ', 'curl -u ', 'sshpass -p ', 'htpasswd -b ', 'mysql -p', 'curl\\\n', '--password ', '--password=', '--api-key ', '--pass ', '--auth=', '--access-token '] },
  { nome: 'RX_FLAG_SENSIVEL', rx: RX_FLAG_SENSIVEL, sementes: ['--password', '--a-', '--pass'] },
  { nome: 'PALAVRAS_DE_COMANDO', rx: PALAVRAS_DE_COMANDO, sementes: ['curl', 'mysql'] },
  ...PRE.map(([rx], i) => ({ nome: `PRE[${i}]`, rx, sementes: ['mysql -p', 'sshpass -p ', 'htpasswd -b ', 'htpasswd -nb ', 'curl --user=', 'curl -u', 'curl --proxy-user ', '--access-token=', '--pass ', '--password=', '--password=a\\ ', 'senha=a\\ ', '--token ', 'curl -u ', 'curl x -u ', 'token=', 'chave:', 'senha="', "pwd='", 'cookie: '] })),
  ...EXTRAS.map(([rx], i) => ({ nome: `EXTRAS[${i}]`, rx, sementes: ['sk-', 'sk_', 'gsk_', 'xai-', 'xoxb-', 'ghp_', 'eyJ', 'eyJaaaaaa.', 'eyJaaaaaa.bbbbbb.', 'Authorization: ', 'Proxy-Authorization:', 'X-Api-Key: ', 'Cookie: ', 'Set-Cookie:'] })),
  { nome: 'RX_RESTO_MARCADOR', rx: RX_RESTO_MARCADOR, sementes: ['[segredo oculto]', '[segredo oculto] oculto]'] },
  { nome: 'RX_SEQUENCIA_LONGA', rx: RX_SEQUENCIA_LONGA, sementes: ['a', 'a-', 'A1.'] },
  { nome: 'RX_CHAVE_LONGA', rx: RX_CHAVE_LONGA, sementes: ['a', 'a/'] },
  { nome: 'RX_CHAVE_SENSIVEL', rx: RX_CHAVE_SENSIVEL, sementes: ['api', 'api_', 'pass', 'passwor', 'secre', 'toke'] },
  { nome: 'RX_ACENTOS', rx: RX_ACENTOS, sementes: ['a'] },
  { nome: 'RX_PATCH', rx: RX_PATCH, sementes: ['*** Add File:', '*** Update File: ', '*** Delete File:\t'] },
  { nome: 'RX_CURSOR_TEXTO', rx: RX_CURSOR_TEXTO, sementes: ['a', 'a-'] },
  { nome: 'RX_SHELL_C', rx: RX_SHELL_C, sementes: ['-lc', '-c'] },
  { nome: 'RX_CLAUDE', rx: RX_CLAUDE, sementes: ['11111111-1111-1111-1111-111111111111', '1'] },
  { nome: 'RX_SUBAGENTE', rx: RX_SUBAGENTE, sementes: ['agent-', 'agent-a'] },
  { nome: 'RX_ROLLOUT', rx: RX_ROLLOUT, sementes: ['rollout-', 'rollout-a.'] },
  { nome: 'RX_UUID_FIM', rx: RX_UUID_FIM, sementes: ['11111111-1111-1111-1111-111111111111', '1'] },
  { nome: 'RX_UUID', rx: RX_UUID, sementes: ['11111111-1111-1111-1111-111111111111', '1'] },
  { nome: 'RX_ID_CURTO', rx: RX_ID_CURTO, sementes: ['a', '1'] },
];

/** Só a camada do tokenizador e das regexes, sem a ocultação de linhas: é o que os testes da camada antiga exercitam. */
const limpaCamadaAntiga = (texto) => limpa(texto, false, true);

module.exports = {
  limpaCamadaAntiga, mascaraComandos, comandoDeLista, comandoExibivel, REGEX_AUDITAVEIS, semBarraFinal,
  criarLeitor, limpa, serializa, corta, normaliza, caminhoRelativo, codificaCursor, decodificaCursor, cmp, fontesDoAgente, descobreFonte,
  abrirSeguro, ErroEntrada, ErroArquivo, TIPOS, RX_ID_CURTO, RX_UUID, MAX_LINHA,
};
