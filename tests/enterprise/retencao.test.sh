#!/usr/bin/env bash
# dgclaw retencao aplicar: transcripts (apaga e troca o texto sem quebrar a corrente), conversas.db,
# anexos, logs, auditoria preservada, nivel pessoal intacto. Casa de agente sintetica, raiz falsa.
set -uo pipefail
# shellcheck source=tests/enterprise/_comum.sh
. "$(dirname "$0")/_comum.sh"
# shellcheck source=tests/enterprise/_dados.sh
. "$(dirname "$0")/_dados.sh"
preparar
export DGCLAW_QUEM=testador
RAIZ_LOG="$DGCLAW_RAIZ/var/log/dgclaw"
montar_agente
DB="$HOME_A/.dgclaw/memory_index/conversas.db"
PH="[removido pela política de retenção]"
hash_arvore() { (cd "$HOME_A" && find . -type f -not -name '*.db*' -print0 | sort -z | xargs -0 sha256sum; sha256sum "$RAIZ_LOG"/* 2>/dev/null) | sha256sum; }

echo "retencao: nivel pessoal nao faz nada"
antes="$(hash_arvore)"
dgclaw retencao aplicar >"$TMP/o.txt" 2>&1
igual "pessoal: sai com 0 e diz que esta desligada" 0 "$?"
afirma "pessoal: mensagem explica como ligar" grep -q "retencao_dias" "$TMP/o.txt"
igual "pessoal: nenhum arquivo mudou" "$antes" "$(hash_arvore)"

echo "retencao: ensaio (empresa, 90 dias)"
nivel_na_raiz empresa
antes="$(hash_arvore)"
dgclaw --ensaio retencao aplicar >"$TMP/o.txt" 2>&1
igual "ensaio: sai com 0" 0 "$?"
afirma "ensaio: diz o que apagaria" grep -q "a apagar" "$TMP/o.txt"
afirma "ensaio: diz o que trocaria" grep -q "trocada" "$TMP/o.txt"
igual "ensaio: nenhum arquivo mudou" "$antes" "$(hash_arvore)"
igual "ensaio: conversas.db intacto (4 linhas)" 4 "$(db_consulta "$DB" 'select count(*) from trechos')"

echo "retencao: aplicar"
mtime_antes="$(stat -c %Y "$TR/atual.jsonl")"
dgclaw retencao aplicar >"$TMP/o.txt" 2>&1
igual "aplicar: sai com 0" 0 "$?"
nega "transcript velho (mtime de 200 dias) foi apagado" test -e "$TR/velho.jsonl"
afirma "transcript em uso (mudou ha 1 minuto) ficou" test -e "$TR/ativo.jsonl"
afirma "o em uso e reportado como pulado" grep -q "ativo.jsonl.*em uso" "$TMP/o.txt"
igual "transcript em uso nao foi tocado" 0 "$(grep -cF "$PH" "$TR/ativo.jsonl")"
igual "transcript misto: continua com 4 linhas" 4 "$(wc -l <"$TR/atual.jsonl" | tr -d ' ')"
igual "transcript misto: todas as linhas continuam JSON valido" 4 "$(jq -c . "$TR/atual.jsonl" | wc -l | tr -d ' ')"
igual "corrente parentUuid intacta" "null u1 u2 u3" "$(jq -r '.parentUuid // "null"' "$TR/atual.jsonl" | paste -sd' ')"
igual "uuid intactos" "u1 u2 u3 u4" "$(jq -r .uuid "$TR/atual.jsonl" | paste -sd' ')"
igual "timestamp e type intactos" "user assistant user user" "$(jq -r .type "$TR/atual.jsonl" | paste -sd' ')"
igual "texto velho vira o marcador" "$PH" "$(sed -n 1p "$TR/atual.jsonl" | jq -r .message.content)"
igual "bloco de texto velho vira o marcador, tipo mantido" "text $PH" "$(sed -n 2p "$TR/atual.jsonl" | jq -r '.message.content[0] | "\(.type) \(.text)"')"
igual "entrada de ferramenta velha e limpa, id e nome mantidos" "tool_use t1 Bash $PH" "$(sed -n 2p "$TR/atual.jsonl" | jq -r '.message.content[1] | "\(.type) \(.id) \(.name) \(.input.command)"')"
igual "resultado de ferramenta velho: tool_use_id mantido" "t1 $PH" "$(sed -n 3p "$TR/atual.jsonl" | jq -r '.message.content[0] | "\(.tool_use_id) \(.content)"')"
igual "mensagem recente intacta" "conversa recente sobre o projeto com Maria Souza" "$(sed -n 4p "$TR/atual.jsonl" | jq -r .message.content)"
afirma "o dado pessoal velho sumiu do arquivo" bash -c "! grep -q '123.456.789-01' '$TR/atual.jsonl'"
igual "modo do arquivo preservado" 640 "$(stat -c %a "$TR/atual.jsonl")"
igual "data de modificacao preservada" "$mtime_antes" "$(stat -c %Y "$TR/atual.jsonl")"
nega "nenhum temporario sobrou" bash -c "ls -a '$TR' | grep -q dgclaw-novo"

echo "retencao: conversas.db"
igual "linhas de conversa velhas sairam" 1 "$(db_consulta "$DB" "select count(*) from trechos where tipo='conversa'")"
igual "a conversa recente ficou" "conversa recente sobre o projeto com Maria Souza" "$(db_consulta "$DB" "select texto from trechos where tipo='conversa'")"
igual "memoria nao e apagada por idade" 1 "$(db_consulta "$DB" "select count(*) from trechos where tipo='memoria'")"
igual "indice de busca refeito: o dado velho nao e mais achado" 0 "$(db_consulta "$DB" "select count(*) from trechos_fts where trechos_fts match '\"123\"'")"
igual "indice de busca refeito: o recente e achado" 2 "$(db_consulta "$DB" "select count(*) from trechos_fts where trechos_fts match 'Maria'")"
afirma "o dado velho nao esta mais nem nas paginas livres do arquivo" bash -c "! grep -qa 'assunto antigo' '$DB'"
igual "posicao lida acompanhou a reescrita do transcript" "$(head -n 2 "$TR/atual.jsonl" | wc -c | tr -d ' ')" "$(db_consulta "$DB" "select posicao from fontes")"
igual "inode do indice acompanhou" "$(stat -c %i "$TR/atual.jsonl")" "$(db_consulta "$DB" "select inode from fontes")"
igual "tamanho do indice acompanhou" "$(stat -c %s "$TR/atual.jsonl")" "$(db_consulta "$DB" "select tamanho from fontes")"
igual "chunks.db (derivado da memoria) nao e tocado" 2 "$(db_consulta "$HOME_A/.dgclaw/memory_index/chunks.db" 'select count(*) from chunks')"
afirma "-wal/-shm que sobrarem tem o dono e o modo do banco" bash -c "for f in '$DB'-wal '$DB'-shm; do [ ! -e \$f ] || [ \$(stat -c %a \$f) = \$(stat -c %a '$DB') ]; done"

echo "retencao: anexos, logs, memoria e auditoria"
nega "anexo velho foi apagado (pdf)" test -e "$HOME_A/uploads/2020-01-01/contrato.pdf"
nega "anexo velho foi apagado (txt)" test -e "$HOME_A/uploads/2020-01-01/notas.txt"
nega "a pasta de data que ficou vazia saiu" test -e "$HOME_A/uploads/2020-01-01"
afirma "anexo recente ficou" test -e "$HOME_A/uploads/recente/foto.png"
nega "log velho do agente apagado" test -e "$HOME_A/.dgclaw/logs/antigo.log"
afirma "log do runner (modificado agora) ficou" test -e "$HOME_A/.dgclaw/logs/runner.log"
nega "log velho do servidor apagado" test -e "$RAIZ_LOG/antigo.log"
afirma "log recente do servidor ficou" test -e "$RAIZ_LOG/web.log"
nega "miniatura velha do Web apagada" test -e "$LIB/web/miniaturas/velha.jpg"
afirma "miniatura recente ficou" test -e "$LIB/web/miniaturas/nova.jpg"
afirma "a trilha de auditoria nunca e apagada por idade" test -e "$RAIZ_LOG/auditoria.jsonl"
igual "MEMORY.md nao e tocada" 1 "$(grep -c '123.456.789-01' "$HOME_A/MEMORY.md")"
igual "memoria diaria nao e tocada" 1 "$(grep -c 'Maria Souza' "$HOME_A/memory/2026-01-01.md")"
afirma "a auditoria registrou retencao_aplicada com os numeros" bash -c "jq -e 'select(.evento==\"retencao_aplicada\") | .dados.dias == 90 and .dados.arquivos >= 5 and .dados.mensagens_redigidas == 3' '$RAIZ_LOG/auditoria.jsonl'"

echo "retencao: segunda rodada nao muda mais nada"
dgclaw retencao aplicar >"$TMP/o2.txt" 2>&1
afirma "segunda rodada: 0 arquivos, 0 mensagens, 0 linhas" grep -q "Resumo: 0 arquivo(s), 0 mensagem(ns) trocada(s) pelo marcador, 0 linha(s) de banco" "$TMP/o2.txt"

echo "retencao: --agente nao mexe nos logs do servidor"
touch -d '300 days ago' "$RAIZ_LOG/web.log"
dgclaw retencao aplicar --agente ana >"$TMP/o3.txt" 2>&1
igual "--agente: ok" 0 "$?"
afirma "--agente: log do servidor continua" test -e "$RAIZ_LOG/web.log"
dgclaw retencao aplicar >"$TMP/o3.txt" 2>&1
nega "sem --agente: o log velho do servidor sai" test -e "$RAIZ_LOG/web.log"
dgclaw retencao aplicar --agente inexistente >"$TMP/o3.txt" 2>&1
nega "agente que nao existe e recusado" test "$?" -eq 0
afirma "a recusa diz o que fazer" grep -q "O que fazer\|dgclaw agente" "$TMP/o3.txt"

echo "retencao: atalho plantado pelo agente nao leva o root para fora da casa"
mkdir -p "$TMP/fora"
FORA="$TMP/fora/segredo.jsonl"
printf '{"type":"user","uuid":"x","timestamp":"%s","message":{"content":"segredo de fora"}}\n' "$(dias_atras 300)" >"$FORA"
touch -d '10 minutes ago' "$FORA"
ln -s "$FORA" "$TR/atalho.jsonl"
antes_fora="$(sha256sum "$FORA")"
dgclaw retencao aplicar >"$TMP/o4.txt" 2>&1
igual "arquivo de fora intacto" "$antes_fora" "$(sha256sum "$FORA")"
afirma "o atalho e reportado" grep -q "atalho.jsonl e um atalho" "$TMP/o4.txt"
rm "$TR/atalho.jsonl"
mkdir -p "$TMP/fora/uploads"
printf 'x' >"$TMP/fora/uploads/velho.bin"; touch -d '400 days ago' "$TMP/fora/uploads/velho.bin"
ln -s "$TMP/fora/uploads" "$HOME_A/uploads/pasta-atalho"
dgclaw retencao aplicar >"$TMP/o4.txt" 2>&1
afirma "pasta de fora via atalho nao foi percorrida" test -e "$TMP/fora/uploads/velho.bin"
rm "$HOME_A/uploads/pasta-atalho"

echo "retencao: timer e logrotate (hooks de instalar e aplicar)"
ETCLR="$DGCLAW_RAIZ/etc/logrotate.d/dgclaw-enterprise"
UNID="$DGCLAW_RAIZ/etc/systemd/system"
lib ent_instalar_retencao >"$TMP/o5.txt" 2>&1
afirma "timer diario criado" test -f "$UNID/dgclaw-retencao.timer"
afirma "servico chama dgclaw retencao aplicar" grep -q "ExecStart=/usr/local/bin/dgclaw retencao aplicar" "$UNID/dgclaw-retencao.service"
afirma "logrotate cobre /var/log/dgclaw/*.log e o log do runner" bash -c "grep -q '/var/log/dgclaw/\*.log' '$ETCLR' && grep -q 'agentes/\*/home/.dgclaw/logs/\*.log' '$ETCLR'"
afirma "logrotate com o mesmo prazo (90)" bash -c "grep -q 'maxage 90' '$ETCLR' && grep -q 'rotate 90' '$ETCLR'"
afirma "logrotate nao cobre a auditoria (so os .log)" bash -c "! grep -v '^#' '$ETCLR' | grep -q auditoria"
afirma "logrotate aceita a configuracao (logrotate -d)" bash -c "command -v logrotate >/dev/null && logrotate -d '$ETCLR' >/dev/null 2>&1 || ! command -v logrotate >/dev/null"
afirma "ligou o timer" grep -q "systemctl enable --now dgclaw-retencao.timer" "$STUB_LOG"
nivel_na_raiz empresa '{"retencao_dias": 0}'
nivel_na_raiz empresa
lib protecao_ajustar retencao_dias 45 >/dev/null 2>&1
lib ent_aplicar_retencao >"$TMP/o5.txt" 2>&1
afirma "aplicar com 45 dias reescreve o logrotate" grep -q "maxage 45" "$ETCLR"
nivel_na_raiz pessoal
lib ent_aplicar_retencao >"$TMP/o5.txt" 2>&1
nega "prazo 0: logrotate removido" test -e "$ETCLR"
nega "prazo 0: timer removido" test -e "$UNID/dgclaw-retencao.timer"

fim
