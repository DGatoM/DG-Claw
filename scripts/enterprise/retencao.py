#!/usr/bin/env python3
"""retencao.py (DG Claw Enterprise): aplica o prazo de retencao (protecao `retencao_dias`).

Chamado por `dgclaw retencao aplicar` (lib/enterprise/retencao.sh) e pelo timer diario.
So biblioteca padrao do Python 3.

O que faz, por agente (e pelo Admin):
  - transcripts .jsonl do Claude Code e rollouts do Codex: arquivo cuja ultima modificacao e mais
    velha que o prazo vai embora; arquivo ainda em uso mas com mensagens velhas tem o TEXTO dessas
    mensagens trocado por "[removido pela política de retenção]" (nenhuma linha some, a corrente
    parentUuid e o --resume continuam inteiros);
  - conversas.db: apaga as linhas de conversa mais velhas que o prazo e reconstroi o indice de busca;
  - anexos (uploads/) e entregas (.dgclaw/entregas/): arquivo mais velho que o prazo e apagado;
  - miniaturas do Web (/var/lib/dgclaw/web/miniaturas, cache refeito sob demanda): idem;
  - logs do agente (.dgclaw/logs/) e do servidor (/var/log/dgclaw/*.log): idem. A trilha de
    auditoria (auditoria.jsonl) nunca entra: apagar prova de auditoria e o contrario do objetivo.

O que NAO faz de proposito:
  - memoria (MEMORY.md, working-memory.md, memory/): e o que o agente sabe; revisao manual
    periodica (docs/enterprise/DADOS-PESSOAIS.md) e exclusao por titular (`dgclaw titular`);
  - chunks.db (embeddings): nasce dessa memoria, e o proprio reindex ja tira do indice o que sumiu
    do disco; apagar por data so faria o reindex recriar tudo na madrugada seguinte;
  - dados vivos do Web (mesa, lembretes, avisos): sao estado de trabalho, nao historico.

Saida: texto em portugues; `--resumo-json ARQ` grava os numeros para a auditoria.
Codigos: 0 ok (arquivo em uso e pulado, e normal), 1 houve erro (dito na saida).
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dados_comum as dc  # noqa: E402


def parse_ts(ts):
    if not isinstance(ts, str):
        return None
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


class Totais:
    def __init__(self):
        self.arquivos = 0
        self.mensagens = 0
        self.linhas_db = 0
        self.bytes = 0
        self.pulados = []
        self.erros = []

    def como_dict(self):
        return {"arquivos": self.arquivos, "mensagens_redigidas": self.mensagens, "linhas_db": self.linhas_db,
                "bytes": self.bytes, "pulados": self.pulados, "erros": self.erros}


class Retencao:
    def __init__(self, dias, ensaio):
        self.dias = dias
        self.ensaio = ensaio
        self.agora = dc.agora()
        self.corte_epoch = self.agora - dias * 86400
        self.corte = datetime.fromtimestamp(self.corte_epoch, timezone.utc)
        self.corte_dia = self.corte.strftime("%Y-%m-%d")
        self.t = Totais()
        self.verbo = "a apagar" if ensaio else "apagado(s)"

    def dizer(self, texto):
        print(("[ensaio] " if self.ensaio else "") + texto)

    def protegido(self, slug, passo, fn):
        """Um passo que falha nao derruba os outros: o erro vai para o relatorio e o comando termina com 1."""
        try:
            fn()
        except dc.ErroDados as e:
            self.t.erros.append(f"{slug}: {passo}: {e}")
        except OSError as e:
            self.t.erros.append(f"{slug}: {passo}: {e} (entrada: {getattr(e, 'filename', '')}). "
                                "O que fazer: confira a permissao e o espaco em disco e rode de novo.")

    # --- arquivos antigos (anexos, logs) ------------------------------------------------------
    def apagar_velhos(self, rotulo, slug, raiz, filtro=None):
        atalhos = []
        n = b = 0
        for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
            if filtro and not filtro(nome):
                continue
            if st.st_mtime < self.corte_epoch:
                n += 1
                b += st.st_size
                if not self.ensaio:
                    os.unlink(nome, dir_fd=dfd)
        if n and not self.ensaio:
            dc.remover_vazias(raiz)
        for a in atalhos:
            self.t.pulados.append(f"{slug}: {a} e um atalho; nao segui")
        self.t.arquivos += n
        self.t.bytes += b
        if n:
            self.dizer(f"  {rotulo}: {n} arquivo(s) {self.verbo} ({dc.formatar_bytes(b)})")

    # --- transcripts ----------------------------------------------------------------------------
    def transcripts(self, alvo):
        db = dc.db_conversas(alvo)
        lidas = dc.posicoes_lidas(db)
        corte = self.corte
        atalhos = []
        apagados = redigidos = msgs = 0
        b = 0

        def trans(linha):
            try:
                obj = json.loads(linha)
            except ValueError:
                return linha
            d = parse_ts(obj.get("timestamp")) if isinstance(obj, dict) else None
            if d is None or d >= corte:
                return linha
            novo = dc.mapear_strings(obj, lambda s: s if (not s or s == dc.PLACEHOLDER_RETENCAO) else dc.PLACEHOLDER_RETENCAO)
            return linha if novo == obj else dc.serializar_linha(novo)

        for raiz in dc.raizes_transcripts(alvo):
            for dfd, nome, caminho, st in dc.varrer(raiz, atalhos):
                if not dc.eh_transcript(nome):
                    continue
                if st.st_mtime < self.corte_epoch:
                    apagados += 1
                    b += st.st_size
                    if not self.ensaio:
                        os.unlink(nome, dir_fd=dfd)
                    continue
                chave = alvo.no_agente(caminho)
                r = dc.reescrever_linhas(dfd, nome, caminho, trans, ensaio=self.ensaio, posicoes=[lidas[chave]] if chave in lidas else ())
                if r.pulado:
                    self.t.pulados.append(f"{alvo.slug}: {caminho}: {r.pulado}")
                    continue
                if r.mudou:
                    redigidos += 1
                    msgs += r.mudou
                    if not self.ensaio and chave in lidas:
                        dc.corrigir_fontes(db, chave, r, lidas[chave])
        for a in atalhos:
            self.t.pulados.append(f"{alvo.slug}: {a} e um atalho; nao segui")
        self.t.arquivos += apagados
        self.t.mensagens += msgs
        self.t.bytes += b
        if apagados or redigidos:
            self.dizer(f"  transcripts: {apagados} arquivo(s) {self.verbo} ({dc.formatar_bytes(b)}); "
                       f"{redigidos} arquivo(s) em uso com {msgs} mensagem(ns) velha(s) trocada(s) pelo marcador")

    # --- conversas.db -----------------------------------------------------------------------------
    def conversas_db(self, alvo):
        db = dc.db_conversas(alvo)
        if not db.is_file():
            return
        with dc.trava_do_indice(db.with_suffix(".reindex.lock")):
            con = dc.abrir_db(db, somente_leitura=self.ensaio)
            try:
                if not dc.tem_tabela(con, "trechos"):
                    raise dc.erro("o conversas.db nao tem a tabela `trechos`", str(db),
                                  "confira se e o indice de conversas do DG Claw; se estiver corrompido, apague e rode: conversas_fts.py reindex --do-zero")
                onde = "tipo='conversa' AND dia IS NOT NULL AND dia != '' AND dia < ?"
                n = con.execute(f"SELECT COUNT(*) FROM trechos WHERE {onde}", (self.corte_dia,)).fetchone()[0]
                if n and not self.ensaio:
                    con.execute(f"DELETE FROM trechos WHERE {onde}", (self.corte_dia,))
                    dc.compactar_db(con)
            finally:
                dc.fechar_db(con, db)
        self.t.linhas_db += n
        if n:
            self.dizer(f"  conversas.db: {n} linha(s) de conversa {self.verbo} (indice de busca refeito)")

    # --- por agente ---------------------------------------------------------------------------------
    def agente(self, alvo):
        self.dizer(f"agente {alvo.slug}:")
        self.protegido(alvo.slug, "transcripts", lambda: self.transcripts(alvo))
        self.protegido(alvo.slug, "conversas.db", lambda: self.conversas_db(alvo))
        for rotulo, partes in (("anexos", ("uploads",)), ("entregas", (".dgclaw", "entregas")), ("logs", (".dgclaw", "logs"))):
            def passo(rotulo=rotulo, partes=partes):
                raiz = dc.sob_casa(alvo.home, *partes)
                if raiz and raiz.is_dir():
                    self.apagar_velhos(rotulo, alvo.slug, raiz)
            self.protegido(alvo.slug, rotulo, passo)

    def miniaturas(self, web_data):
        """Miniaturas de foto e video do chat (cache do Web, refeito sob demanda): sem isto, a miniatura
        de um anexo ja apagado ficaria para sempre."""
        def passo():
            raiz = Path(web_data) / "miniaturas"
            if raiz.is_dir() and not raiz.is_symlink():
                self.apagar_velhos("miniaturas do Web", "servidor", raiz)
        self.protegido("servidor", "miniaturas do Web", passo)

    def logs_do_servidor(self, pasta):
        def passo():
            raiz = Path(pasta)
            if raiz.is_dir() and not raiz.is_symlink():
                # a trilha de auditoria (e a trava dela) nunca e apagada por idade
                self.apagar_velhos("logs do servidor", "servidor", raiz, filtro=lambda n: ".log" in n and not n.startswith("auditoria"))
        self.protegido("servidor", "logs do servidor", passo)


def main():
    ap = argparse.ArgumentParser(description="Aplica o prazo de retencao do DG Claw Enterprise")
    ap.add_argument("--agentes-json", required=True)
    ap.add_argument("--dias", type=int, required=True)
    ap.add_argument("--agente")
    ap.add_argument("--ensaio", action="store_true")
    ap.add_argument("--log-dir", help="pasta dos logs do servidor (/var/log/dgclaw)")
    ap.add_argument("--web-data", help="pasta de dados do Web (/var/lib/dgclaw/web), para as miniaturas")
    ap.add_argument("--resumo-json", help="arquivo onde gravar os numeros")
    a = ap.parse_args()
    if a.dias <= 0:
        print("Retencao desligada (retencao_dias = 0): nada a fazer.")
        return 0
    try:
        alvos = dc.carregar_alvos(a.agentes_json, a.agente)
    except dc.ErroDados as e:
        print(f"Nao deu certo: {e}", file=sys.stderr)
        return 1
    ret = Retencao(a.dias, a.ensaio)
    ret.dizer(f"Retencao de {a.dias} dia(s): o que for mais velho que {ret.corte_dia} sai.")
    for alvo in alvos:
        ret.agente(alvo)
    if not a.agente:
        if a.log_dir:
            ret.logs_do_servidor(a.log_dir)
        if a.web_data:
            ret.miniaturas(a.web_data)
    t = ret.t
    for p in t.pulados:
        print(f"  pulado: {p}")
    for e in t.erros:
        print(f"Nao deu certo: {e}", file=sys.stderr)
    ret.dizer(f"Resumo: {t.arquivos} arquivo(s), {t.mensagens} mensagem(ns) trocada(s) pelo marcador, "
              f"{t.linhas_db} linha(s) de banco, {dc.formatar_bytes(t.bytes)} liberados"
              f"{f', {len(t.pulados)} pulado(s)' if t.pulados else ''}.")
    if a.resumo_json:
        resumo = t.como_dict()
        resumo.update({"dias": a.dias, "corte": ret.corte_dia, "ensaio": a.ensaio, "agentes": len(alvos)})
        Path(a.resumo_json).write_text(json.dumps(resumo), encoding="utf-8")
    return 1 if t.erros else 0


if __name__ == "__main__":
    sys.exit(main())
