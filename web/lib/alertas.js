// Estado dos lembretes de mensagem, isolado pelo workspace e pela conversa.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function marcar(m) {
  if (m.origin === 'dono') return m;
  const tag = /^\[(ENTREGA|PEDIDO)\](?:\s+|$)/.exec(m.text || '');
  return tag ? { ...m, text: m.text.slice(tag[0].length), alerta: tag[1].toLowerCase() } : m;
}

function criarAlertas(arquivo, conversa) {
  function ler() {
    try {
      const d = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (d.versao !== 1 || !Array.isArray(d.itens)) throw new Error('formato inválido');
      return d;
    } catch (e) {
      if (e.code === 'ENOENT') return { versao: 1, itens: [] };
      throw new Error(`Não consegui ler os alertas em ${arquivo}: ${e.message}. Preserve o arquivo e confira o backup.`);
    }
  }
  function salvar(d) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = arquivo + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
      fs.renameSync(tmp, arquivo);
    } catch (e) {
      throw new Error(`Não consegui guardar os alertas em ${arquivo}: ${e.message}. Confira espaço e permissões e tente novamente.`);
    }
  }
  function observar(mensagens) {
    const marcadas = mensagens.filter(m => m.alerta);
    if (!marcadas.length) return;
    const d = ler();
    let mudou = false;
    const porId = new Map(d.itens.filter(a => a.conversa === conversa).map(a => [a.id, a]));
    for (const m of marcadas) {
      const id = crypto.createHash('sha256').update(JSON.stringify([conversa, m.ep, m.origin, m.via])).digest('hex').slice(0, 24);
      const antigo = porId.get(id);
      if (!antigo) {
        const item = { id, conversa, tipo: m.alerta, mensagem: m, vistoEm: null };
        d.itens.push(item); porId.set(id, item); mudou = true;
      } else if (JSON.stringify(antigo.mensagem) !== JSON.stringify(m)) {
        antigo.mensagem = m; antigo.tipo = m.alerta; mudou = true;
      }
    }
    if (mudou) salvar(d);
  }
  function listar() {
    return ler().itens.filter(a => a.conversa === conversa && !a.vistoEm)
      .map(a => ({ id: a.id, mensagem_id: a.mensagem.id, tipo: a.tipo, ep: a.mensagem.ep }));
  }
  function mensagem(id) {
    return ler().itens.find(a => a.conversa === conversa && a.id === id)?.mensagem || null;
  }
  function reconhecer(id) {
    const d = ler(), a = d.itens.find(a => a.conversa === conversa && a.id === id);
    if (!a) return false;
    if (!a.vistoEm) { a.vistoEm = new Date().toISOString(); salvar(d); }
    return true;
  }
  return { observar, listar, mensagem, reconhecer };
}

module.exports = { marcar, criarAlertas };
