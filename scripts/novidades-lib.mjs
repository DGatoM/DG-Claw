// Funções comuns ao gancho de novidades (novidades-hook.mjs) e ao aviso de nova versão
// (checar-atualizacao.mjs): a quebra do CHANGELOG em itens e a impressão digital de cada item.
// As duas pontas PRECISAM usar a mesma regra, senão o que o gancho considera "já visto" e o que o
// aviso considera "novo" deixam de bater. Sem efeitos colaterais ao importar.
import crypto from 'node:crypto';

export function digital(texto) {
  return crypto.createHash('sha1').update(texto).digest('hex').slice(0, 12);
}

/** Itens do CHANGELOG: cada "- " na margem, com as linhas de continuação coladas, e a seção de origem. */
export function itensDoChangelog(texto) {
  const itens = [];
  let secao = '';
  let atual = null;
  const fecha = () => {
    if (atual) itens.push({ secao: atual.secao, texto: atual.partes.join(' ').replace(/\s+/g, ' ').trim() });
    atual = null;
  };
  for (const linha of texto.split(/\r?\n/)) {
    const titulo = /^##\s+(.*)$/.exec(linha);
    if (titulo) { fecha(); secao = titulo[1].trim(); continue; }
    if (/^#{3,}\s/.test(linha)) { fecha(); continue; }
    if (/^-\s+/.test(linha)) { fecha(); atual = { secao, partes: [linha.replace(/^-\s+/, '')] }; continue; }
    if (atual && /^\s+\S/.test(linha)) { atual.partes.push(linha.trim()); continue; }
    fecha();
  }
  fecha();
  return itens.filter(i => i.texto);
}
