'use strict';
// Máscara de segredos para o que vai do transcript para a tela (comando e resultado da trilha).
// Porte dos padrões de runner/src/mascara.ts (que protege a saída do terminal). O Web não conhece as
// variáveis de ambiente do agente, então aqui valem só os padrões de chave e as atribuições com cara
// de segredo (NOME_DA_CHAVE=valor, Authorization: ..., token de bot do Telegram).
// É defesa em profundidade: um segredo fora desses formatos passa. Por isso a trilha só mostra
// trechos curtos e fica fechada por padrão.

const OCULTO = '[segredo oculto]';

const PADROES = [
  /sk-ant-api03-[A-Za-z0-9_-]{90,}/g,
  /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  /sk-proj-[A-Za-z0-9_-]{40,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{35}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /gho_[A-Za-z0-9]{36}/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|$)/g,
  /AKIA[A-Z0-9]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b[a-z][a-z0-9+.\-]{0,20}:\/\/[^\s:/?#@'"<>]+:[^\s@/?#'"<>]+@[^\s'"<>]+/gi,
  /dgc_[A-Za-z0-9_-]{16,}/g,                                                 // chave de API do DG Claw
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g,                    // JWT
  /\b(?:Set-)?Cookie:[ \t]*[^\r\n]+/gi,                                        // cabeçalho de cookie inteiro
];

// Dados de pessoas e identificadores longos. Ficam fora de PADROES porque a trilha mostra comandos e
// saídas, onde data, id e contagem têm 10 dígitos e precisam continuar legíveis. O diagnóstico remoto
// usa mascararDados, que vale para o que sai da máquina do cliente.
const PADROES_DADOS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,                      // e-mail
  /\+\d{1,3}[\s.-]?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g,                    // telefone com +
  /\(\d{2}\)\s?\d{4,5}-?\d{4}/g,                                               // (11) 99999-9999
  /\b\d{2}\s\d{4,5}-\d{4}\b/g,                                                // 11 99999-9999
  /\b\d{10,}\b/g,                                                            // 10+ dígitos seguidos
  /\b[0-9a-fA-F]{32,}\b/g,                                                    // hexadecimal longo (hash, token)
];

// NOME=valor, "nome": "valor", nome: valor, quando o nome sugere segredo. Mantém o nome, esconde o valor.
// Começa na palavra-chave (sem \w* antes dela): o prefixo do nome continua no texto e o custo deixa de crescer com o tamanho da linha.
const ATRIBUICAO = /((?:api[_-]?key|secret|token|passw(?:or)?d|senha|credential|auth)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&;|]+)/gi;

function mascarar(texto) {
  if (texto == null) return '';
  let r = String(texto);
  for (const p of PADROES) { p.lastIndex = 0; r = r.replace(p, OCULTO); }
  ATRIBUICAO.lastIndex = 0;
  r = r.replace(ATRIBUICAO, (_, nome, valor) => (valor === OCULTO ? nome + valor : nome + OCULTO));
  return r;
}

/** mascarar + e-mails, telefones e hexadecimais longos. */
function mascararDados(texto) {
  let r = mascarar(texto);
  for (const p of PADROES_DADOS) { p.lastIndex = 0; r = r.replace(p, OCULTO); }
  return r;
}

module.exports = { mascarar, mascararDados, OCULTO };
