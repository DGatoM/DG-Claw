#!/usr/bin/env bash
# shellcheck disable=SC2034 # as variaveis daqui sao usadas pelos testes que carregam este arquivo
# Casa de agente sintetica para os testes de retencao e de titular: transcripts do Claude Code,
# conversas.db (esquema real do conversas_fts.py), memoria, anexos, logs e um log do servidor.
# Carregado depois de tests/enterprise/_comum.sh e de `preparar`.

dias_atras() { date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%S.000Z; }

# montar_agente: cria o agente "ana" em $LIB/agentes/ana e registra no agentes.json da raiz falsa.
# O titular de mentira: Maria Souza, CPF 123.456.789-01, maria@exemplo.com, telefone (11) 98765-4321.
montar_agente() {
    CASA="$LIB/agentes/ana"; HOME_A="$CASA/home"; TR="$HOME_A/.claude/projects/-home-agente"
    mkdir -p "$TR" "$HOME_A/memory" "$HOME_A/uploads/2020-01-01" "$HOME_A/uploads/recente" \
             "$HOME_A/.dgclaw/logs" "$HOME_A/.dgclaw/memory_index" "$HOME_A/.dgclaw/whatsapp" "$LIB/web/mesa" "$LIB/web/miniaturas" "$RAIZ_LOG"
    jq -n --arg h "$HOME_A" --arg t "$TR" \
        '{versao: 1, agentes: [{slug: "ana", nome: "Ana", tipo: "agente", home_host: $h, home_container: "/home/agente", transcripts_dir: $t, provedor: "claude"}]}' \
        >"$ETC/agentes.json"
    HOME_A="$HOME_A" TR="$TR" REPO="$REPO" LIB="$LIB" python3 - <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
home = Path(os.environ["HOME_A"]); tr = Path(os.environ["TR"])
def ts(d): return (datetime.now(timezone.utc) - timedelta(days=d)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def reg(**k): return json.dumps(k, ensure_ascii=False, separators=(",", ":"))
linhas = [
    reg(parentUuid=None, isSidechain=False, cwd="/home/agente", sessionId="s1", type="user", uuid="u1", timestamp=ts(200),
        message={"role": "user", "content": "Ligue para Maria Souza, CPF 123.456.789-01"}),
    reg(parentUuid="u1", type="assistant", uuid="u2", timestamp=ts(200),
        message={"role": "assistant", "content": [{"type": "text", "text": "Ok, vou ligar para Maria Souza."},
                 {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "echo maria@exemplo.com"}}]}),
    reg(parentUuid="u2", type="user", uuid="u3", timestamp=ts(199),
        message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "maria@exemplo.com"}]}),
    reg(parentUuid="u3", type="user", uuid="u4", timestamp=ts(1),
        message={"role": "user", "content": "conversa recente sobre o projeto com Maria Souza"}),
]
dados = ("\n".join(linhas) + "\n").encode()
(tr / "atual.jsonl").write_bytes(dados)
(tr / "ativo.jsonl").write_bytes(dados)
(tr / "velho.jsonl").write_bytes(dados)
(home / "MEMORY.md").write_text("# Memoria\n- Maria Souza (CPF 123.456.789-01) prefere contato por e-mail: maria@exemplo.com\n- Outra pessoa: Joao Pereira\n", encoding="utf-8")
(home / "working-memory.md").write_text("Hoje: ligar para Maria Souza no (11) 98765-4321.\n", encoding="utf-8")
(home / "memory" / "2026-01-01.md").write_text("Reuniao com Maria Souza.\n", encoding="utf-8")
(home / "uploads" / "2020-01-01" / "contrato.pdf").write_bytes(b"%PDF-1.4 contrato de Maria Souza \x00\x01\x02")
(home / "uploads" / "2020-01-01" / "notas.txt").write_text("Maria Souza pediu desconto\n", encoding="utf-8")
(home / "uploads" / "recente" / "foto.png").write_bytes(b"\x89PNG sem nada")
(home / ".dgclaw" / "logs" / "runner.log").write_text("2026-10-01 pedido de maria@exemplo.com atendido\nlinha sem nada\n", encoding="utf-8")
(home / ".dgclaw" / "logs" / "antigo.log").write_text("log velho\n", encoding="utf-8")
(home / ".dgclaw" / "whatsapp" / "permitidos.json").write_text('{"versao":1,"numeros":["+5511987654321"]}\n', encoding="utf-8")

sys.path.insert(0, os.path.join(os.environ["REPO"], "scripts", "memory_index"))
import conversas_fts as c
con = c.conectar(home)
def trecho(fonte, tipo, dia, texto):
    con.execute("INSERT INTO trechos(fonte, tipo, ts, dia, canal, papel, nome, texto, ref, impressao) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (fonte, tipo, dia, dia, "painel", "dono", "Ana", texto, "", c.impressao(tipo, fonte, dia, texto)))
f = "/home/agente/.claude/projects/-home-agente/atual.jsonl"
trecho(f, "conversa", ts(200)[:10], "Ligue para Maria Souza, CPF 123.456.789-01")
trecho(f, "conversa", ts(200)[:10], "assunto antigo sem dado pessoal")
trecho(f, "conversa", ts(1)[:10], "conversa recente sobre o projeto com Maria Souza")
trecho("/home/agente/memory/2026-01-01.md", "memoria", "2026-01-01", "Reuniao com Maria Souza.")
lido = len((linhas[0] + "\n" + linhas[1] + "\n").encode())
st = os.stat(tr / "atual.jsonl")
con.execute("INSERT INTO fontes(caminho, tipo, tamanho, posicao, mtime, inode) VALUES (?,?,?,?,?,?)", (f, "transcript", st.st_size, lido, st.st_mtime, st.st_ino))
con.commit(); con.close()

import sqlite3
ch = sqlite3.connect(home / ".dgclaw" / "memory_index" / "chunks.db")
ch.executescript("CREATE TABLE chunks(id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT, source_type TEXT, date TEXT, chunk_idx INTEGER, content TEXT, content_hash TEXT, embedding BLOB, embedded_at TEXT);")
ch.execute("INSERT INTO chunks(source_path, source_type, chunk_idx, content, content_hash, embedding, embedded_at) VALUES (?,?,?,?,?,?,?)", ("/home/agente/MEMORY.md", "memory", 0, "Maria Souza (CPF 123.456.789-01) prefere e-mail", "h1", b"\x00\x00\x80?", "2026-10-01"))
ch.execute("INSERT INTO chunks(source_path, source_type, chunk_idx, content, content_hash, embedding, embedded_at) VALUES (?,?,?,?,?,?,?)", ("/home/agente/MEMORY.md", "memory", 1, "Joao Pereira gosta de cafe", "h2", b"\x00\x00\x80?", "2026-10-01"))
ch.commit(); ch.close()
PY
    # datas: o que e velho de verdade e o que acabou de ser escrito
    touch -d '200 days ago' "$TR/velho.jsonl" "$HOME_A/uploads/2020-01-01/contrato.pdf" "$HOME_A/uploads/2020-01-01/notas.txt" "$HOME_A/.dgclaw/logs/antigo.log"
    touch -d '10 minutes ago' "$TR/atual.jsonl" "$HOME_A/MEMORY.md" "$HOME_A/working-memory.md" "$HOME_A/memory/2026-01-01.md" "$HOME_A/.dgclaw/logs/runner.log"
    touch -d '3 days ago' "$HOME_A/uploads/recente/foto.png"
    touch -d '1 minute ago' "$TR/ativo.jsonl"
    chmod 640 "$TR/atual.jsonl"
    printf '{"mesa":[{"titulo":"Ligar para Maria Souza","fone":"(11) 98765-4321"}]}\n' >"$LIB/web/mesa/tarefas.json"
    printf 'jpg' >"$LIB/web/miniaturas/velha.jpg"; printf 'jpg' >"$LIB/web/miniaturas/nova.jpg"
    touch -d '200 days ago' "$LIB/web/miniaturas/velha.jpg"
    printf 'servidor ligado\n' >"$RAIZ_LOG/web.log"
    printf 'cliente maria@exemplo.com acessou\n' >"$RAIZ_LOG/admin-runner.log"
    printf 'velho\n' >"$RAIZ_LOG/antigo.log"
: >"$RAIZ_LOG/auditoria.jsonl"
    touch -d '200 days ago' "$RAIZ_LOG/antigo.log" "$RAIZ_LOG/auditoria.jsonl"
    touch -d '10 minutes ago' "$LIB/web/mesa/tarefas.json" "$RAIZ_LOG/admin-runner.log" "$RAIZ_LOG/web.log"
}

# db_consulta <arquivo> <sql>: uma consulta no sqlite pelo Python (nao depende do cliente sqlite3).
db_consulta() {
    python3 -c 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True); print(c.execute(sys.argv[2]).fetchone()[0])' "$1" "$2"
}
