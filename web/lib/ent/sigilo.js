'use strict';
// Modo escondido e a proteção `sigilo_externo` (bloco F da versão enterprise).
//
// Com `sigilo_externo` desligado (todos os níveis enterprise), o modo escondido NÃO manda texto da
// conversa para serviço nenhum: web/lib/sigilo.js consulta `externoPermitido` antes de cada pedido e,
// se a resposta for não, devolve só o mascaramento local (o filtro automático da tela) e a mensagem
// abaixo. No nível pessoal a chave vale `true` e nada muda.
//
// Este arquivo também é um módulo da pasta web/lib/ent/ (nome + criar) sem rotas próprias: o carregador
// exige o formato, e assim o bloco aparece na lista "Módulos enterprise" do log.

const MENSAGEM_BLOQUEIO =
  'Esta instalação não envia texto da conversa para serviços externos (proteção sigilo_externo desligada no nível ' +
  'de proteção atual), então só o filtro automático está escondendo: e-mail, valor, CPF, telefone e chave. ' +
  'Nomes de pessoas e empresas passam. Escondê-los exige um modelo rodando neste servidor, que esta versão ainda ' +
  'não inclui. Para permitir o envio de propósito: dgclaw nivel ajustar sigilo_externo true (só nos níveis em que a ' +
  'chave não é travada).';

/**
 * O modo escondido pode mandar texto para um serviço externo agora?
 * Sem leitor de proteções (testes antigos, uso fora do Web) vale o comportamento de sempre: sim.
 * Chave ausente da matriz ou ilegível: o leitor lança, e a resposta é NÃO, porque na dúvida o texto não sai.
 */
function externoPermitido(protecoes, log) {
  if (!protecoes || typeof protecoes.valor !== 'function') return true;
  try {
    return protecoes.valor('sigilo_externo') !== false;
  } catch (e) {
    if (log) log('erro', `Modo escondido: não consegui ler a proteção sigilo_externo (${e.message}). Por segurança nenhum texto sai deste servidor até isso ser corrigido; confira config/protecoes-matriz.json e /etc/dgclaw/protecoes.json.`);
    return false;
  }
}

module.exports = {
  nome: 'sigilo',
  ordem: 90,
  criar() { return {}; },
  externoPermitido,
  MENSAGEM_BLOQUEIO,
};
