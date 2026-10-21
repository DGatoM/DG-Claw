'use strict';
// Versão instalada e aviso de atualização. Reaproveita a leitura do web/lib/atualizacao.js, que já confere cada campo.

const path = require('node:path');
const U = require('./util');

const { R } = U;
const RX_VERSAO = /^[0-9A-Za-z._+-]{1,40}$/;
const RX_SHA = /^[0-9a-f]{7,40}$/;
const DOIS_DIAS_MS = 48 * 3600 * 1000;

function tarefaDeVersao(ctx) {
  const { config, agora, lerEnv, atualizacao, log } = ctx;
  return {
    sufixo: null, id: 'versao', nome: 'Versão do DG Claw',
    async fn() {
      const arquivoEnv = path.join(path.dirname(config.agentesPath), 'dgclaw.env');
      const env = lerEnv(arquivoEnv);
      const l = atualizacao.lerEstado();
      const est = l.estado || null;
      const v = env.vars && env.vars.DGCLAW_VERSAO;
      const c = env.vars && env.vars.DGCLAW_COMMIT;
      const instalada = (v && RX_VERSAO.test(v) ? v : null) || (est && est.instalado && est.instalado.versao) || null;
      const commitCompleto = (c && RX_SHA.test(c) ? c : null) || (est && est.instalado && est.instalado.commit) || null;
      const commit = commitCompleto ? commitCompleto.slice(0, 7) : null;
      const bloco = { instalada, commit, publicada: null, atualizacao_disponivel: null, commits_a_frente: null, verificado_em: null };
      const semMedida = (motivo, extra) => Object.assign(R('nao_medido', motivo, { evidencia: { horario: null, codigo_saida: null, trecho: instalada ? `instalada ${instalada}${commit ? ` (${commit})` : ''}` : null } }), extra || {}, { bloco });
      if (!instalada) log('aviso', `Diagnóstico: não achei DGCLAW_VERSAO em ${arquivoEnv} (${env.erro || 'a linha não existe'}) nem no estado do aviso de atualização.`);

      if (l.erro) {
        log('aviso', `Diagnóstico: ${l.erro}`);
        return semMedida('O arquivo do aviso de atualização está ilegível ou corrompido, então não sei se saiu versão nova.');
      }
      if (l.ausente) return semMedida('O aviso de atualização ainda não verificou o GitHub nenhuma vez (o arquivo estado.json não existe). Rode "sudo dgclaw atualizar --checar" para verificar agora.');
      bloco.verificado_em = est.verificado_em;
      if (est.desligado) return semMedida('O aviso automático de versão nova está desligado, então não sei se há atualização.', { ultimo_sinal: est.verificado_em });
      bloco.publicada = est.publicado ? est.publicado.versao : null;
      bloco.atualizacao_disponivel = est.disponivel;
      bloco.commits_a_frente = est.commits_a_frente;
      const verificadoMs = Date.parse(est.verificado_em);
      const base = { ultimo_sinal: est.verificado_em, evidencia: { horario: est.verificado_em, codigo_saida: null, trecho: `instalada ${instalada || 'desconhecida'}${commit ? ` (${commit})` : ''}, publicada ${bloco.publicada || 'desconhecida'}` }, bloco };
      if (est.disponivel) {
        const mesma = bloco.publicada && bloco.publicada === instalada;
        const n = est.commits_a_frente;
        return Object.assign(R('atencao', `Há atualização do DG Claw: ${mesma ? `mudanças novas dentro da versão ${instalada}` : `a versão ${bloco.publicada || 'nova'} saiu e esta máquina está na ${instalada || 'versão desconhecida'}`}${n ? ` (${n} mudança${n === 1 ? '' : 's'} à frente)` : ''}.`), base, {
          o_que_fazer: 'Atualize pela conversa do Admin. A atualização faz backup antes, e o passo a passo está em docs/ATUALIZAR.md.',
          prompt_sugerido: 'Oi, Admin. O diagnóstico do meu DG Claw mostrou que saiu uma versão nova. Quero atualizar. Siga o roteiro do docs/ATUALIZAR.md: confira o que é personalizado, faça o backup, rode `dgclaw atualizar` e confira que nada meu sumiu. No fim, me conte o que mudou e se está tudo funcionando.',
        });
      }
      if (est.erro) {
        return Object.assign(R('atencao', 'A última procura por versão nova falhou, então a informação pode estar velha.'), base, {
          o_que_fazer: 'Cole o prompt na conversa do Admin para ele rodar a verificação de novo.',
          prompt_sugerido: U.promptAdmin('a procura automática por versão nova do DG Claw falhou na última vez.', '`dgclaw atualizar --checar`', 'dgclaw atualizar --checar'),
        });
      }
      if (Number.isFinite(verificadoMs) && agora() - verificadoMs > DOIS_DIAS_MS) {
        return Object.assign(R('atencao', `A procura por versão nova não roda há ${U.duracaoCurta(agora() - verificadoMs)}.`), base, {
          o_que_fazer: 'Cole o prompt na conversa do Admin para ele conferir o timer de verificação.',
          prompt_sugerido: U.promptAdmin('a procura automática por versão nova do DG Claw não roda há mais de dois dias.', '`systemctl status dgclaw-checar-atualizacao.timer`', 'dgclaw atualizar --checar'),
        });
      }
      return Object.assign(R('ok', null), base);
    },
  };
}

module.exports = { tarefaDeVersao };
