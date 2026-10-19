#!/usr/bin/env bash
# dgclaw titular buscar|apagar: acha o dado em todos os lugares do inventario, nao imprime o dado inteiro,
# apaga sem quebrar os transcripts, limpa indices e memoria, e grava um recibo sem o termo em claro.
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
CH="$HOME_A/.dgclaw/memory_index/chunks.db"
PH="[dado removido a pedido do titular]"
TERMOS=("Maria Souza" --termo 123.456.789-01 --termo maria@exemplo.com --termo "(11) 98765-4321")
hash_tudo() { (find "$HOME_A" "$LIB/web" "$RAIZ_LOG" -type f -not -name '*.db-*' -print0 | sort -z | xargs -0 sha256sum) | sha256sum; }
# onde_ainda_tem: lista os arquivos (fora os binarios e os dois bancos) que ainda contem algum dos termos
onde_ainda_tem() {
    grep -rlaE 'Maria Souza|123\.456\.789-01|12345678901|maria@exemplo\.com|98765-4321|11987654321' "$HOME_A" "$LIB/web" "$RAIZ_LOG" 2>/dev/null \
        | grep -v 'conversas.db\|chunks.db' | sort
}

echo "titular buscar (nivel pessoal tambem funciona)"
antes="$(hash_tudo)"
dgclaw titular buscar "${TERMOS[@]}" >"$TMP/b.txt" 2>&1
igual "buscar: sai com 0" 0 "$?"
igual "buscar: nenhum arquivo mudou" "$antes" "$(hash_tudo)"
afirma "buscar: acha nos transcripts" grep -qE "transcripts: [0-9]+ ocorrencia" "$TMP/b.txt"
afirma "buscar: acha no conversas.db (4 ocorrencias em 3 linhas)" grep -q "conversas.db: 4 ocorrencia(s) em 3 arquivo" "$TMP/b.txt"
afirma "buscar: acha nos embeddings" grep -q "embeddings (chunks.db): 2 ocorrencia(s) em 1 arquivo" "$TMP/b.txt"
afirma "buscar: acha na memoria" grep -qE "memoria: [0-9]+ ocorrencia" "$TMP/b.txt"
afirma "buscar: acha nos dados do Web" grep -q "dados do Web" "$TMP/b.txt"
afirma "buscar: acha nos logs do agente e do servidor" bash -c "grep -q ' logs: ' '$TMP/b.txt' && grep -q 'logs do servidor' '$TMP/b.txt'"
afirma "buscar: lista o anexo binario como pendente" grep -q "contrato.pdf.*anexo que contem o termo" "$TMP/b.txt"
afirma "buscar: lista o WhatsApp sem alterar" grep -q "dgclaw-agente canal whatsapp remover" "$TMP/b.txt"
afirma "buscar: conta os 3 transcripts (o em uso tambem e lido)" grep -q "transcripts: 18 ocorrencia(s) em 3 arquivo" "$TMP/b.txt"
nega "buscar nunca imprime o CPF inteiro" grep -q "123.456.789-01" "$TMP/b.txt"
nega "buscar nunca imprime o e-mail inteiro" grep -q "maria@exemplo.com" "$TMP/b.txt"
nega "buscar nunca imprime o nome inteiro" grep -q "Maria Souza" "$TMP/b.txt"
nega "buscar nao revela a outra pessoa da memoria" grep -q "Joao Pereira" "$TMP/b.txt"
afirma "buscar mostra um trecho mascarado" grep -q "trecho: .*«" "$TMP/b.txt"
nega "buscar nao cria recibo nem sal" test -e "$LIB/titulares"
dgclaw titular buscar "12345678901" >"$TMP/b2.txt" 2>&1
afirma "CPF sem pontuacao acha o CPF com pontuacao" grep -q "memoria: " "$TMP/b2.txt"
dgclaw titular buscar "11987654321" >"$TMP/b3.txt" 2>&1
afirma "telefone sem pontuacao acha (11) 98765-4321 na memoria" grep -q "memoria: " "$TMP/b3.txt"
afirma "telefone sem pontuacao acha o do Web" grep -q "dados do Web: 1 ocorrencia" "$TMP/b3.txt"
afirma "telefone com +55 acha o numero do WhatsApp" bash -c "dgclaw() { '$CLI' \"\$@\"; }; dgclaw titular buscar '+55 11 98765-4321' 2>&1 | grep -q 'whatsapp'"
dgclaw titular buscar "Joana Inexistente" >"$TMP/b4.txt" 2>&1
afirma "termo que ninguem tem: diz que nao achou" grep -q "Nada encontrado" "$TMP/b4.txt"
dgclaw titular buscar "Ma" >"$TMP/b5.txt" 2>&1
nega "termo curto demais e recusado" test "$?" -eq 0
afirma "a recusa explica" grep -q "curto demais" "$TMP/b5.txt"
dgclaw titular buscar >"$TMP/b6.txt" 2>&1
nega "sem termo e recusado" test "$?" -eq 0
nega "buscar sem --agente certo: agente inexistente" dgclaw titular buscar "Maria Souza" --agente nao-existe

echo "titular apagar: protecoes"
nivel_na_raiz empresa
nega "sem --confirmar nao apaga" dgclaw titular apagar "${TERMOS[@]}"
igual "sem --confirmar: nada mudou" "$antes" "$(hash_tudo)"
dgclaw --ensaio titular apagar "${TERMOS[@]}" >"$TMP/e.txt" 2>&1
igual "ensaio: sai com 0" 0 "$?"
igual "ensaio: nada mudou" "$antes" "$(hash_tudo)"
afirma "ensaio: avisa que so mostra" grep -q "nada sera alterado" "$TMP/e.txt"

echo "titular apagar --confirmar"
mtime_mem="$(stat -c %Y "$HOME_A/MEMORY.md")"
dgclaw titular apagar "${TERMOS[@]}" --confirmar >"$TMP/a.txt" 2>&1
rc=$?
igual "ha pendencias (arquivo em uso, anexo binario, WhatsApp): codigo 2" 2 "$rc"
afirma "diz o que ficou pendente" grep -q "pendente:" "$TMP/a.txt"
nega "a saida nunca tem o CPF inteiro" grep -q "123.456.789-01" "$TMP/a.txt"
igual "so ficaram com o dado: o transcript em uso, o anexo binario e o WhatsApp" \
    "$HOME_A/.claude/projects/-home-agente/ativo.jsonl
$HOME_A/.dgclaw/whatsapp/permitidos.json
$HOME_A/uploads/2020-01-01/contrato.pdf" "$(onde_ainda_tem)"
igual "transcript: 4 linhas, todas JSON" 4 "$(jq -c . "$TR/atual.jsonl" | wc -l | tr -d ' ')"
igual "transcript: corrente intacta" "null u1 u2 u3" "$(jq -r '.parentUuid // "null"' "$TR/atual.jsonl" | paste -sd' ')"
igual "transcript: dado trocado pelo marcador" "Ligue para $PH, CPF $PH" "$(sed -n 1p "$TR/atual.jsonl" | jq -r .message.content)"
igual "transcript: tambem a mensagem recente" "conversa recente sobre o projeto com $PH" "$(sed -n 4p "$TR/atual.jsonl" | jq -r .message.content)"
igual "transcript: modo preservado" 640 "$(stat -c %a "$TR/atual.jsonl")"
igual "transcript velho (200 dias) tambem foi limpo" 0 "$(grep -c 'Maria Souza' "$TR/velho.jsonl")"
igual "conversas.db: sobrou so a linha sem o dado" 1 "$(db_consulta "$DB" 'select count(*) from trechos')"
igual "conversas.db: a busca nao acha mais o nome" 0 "$(db_consulta "$DB" "select count(*) from trechos_fts where trechos_fts match 'Maria'")"
nega "conversas.db: o nome nao esta nem nos bytes do arquivo" bash -c "grep -qa 'Maria' '$DB'"
igual "chunks.db: so o chunk sem o dado ficou" 1 "$(db_consulta "$CH" 'select count(*) from chunks')"
nega "chunks.db: o CPF nao esta nos bytes do arquivo" bash -c "grep -qa '123.456' '$CH'"
igual "indice sabe o novo tamanho do transcript" "$(stat -c %s "$TR/atual.jsonl")" "$(db_consulta "$DB" "select tamanho from fontes")"
igual "MEMORY.md: dado trocado, linha da outra pessoa intacta" "1 1" "$(grep -cF "$PH" "$HOME_A/MEMORY.md") $(grep -c 'Joao Pereira' "$HOME_A/MEMORY.md")"
igual "MEMORY.md: data de modificacao preservada" "$mtime_mem" "$(stat -c %Y "$HOME_A/MEMORY.md")"
igual "working-memory trocada" "Hoje: ligar para $PH no $PH." "$(cat "$HOME_A/working-memory.md")"
igual "memoria diaria trocada" "Reuniao com $PH." "$(cat "$HOME_A/memory/2026-01-01.md")"
igual "anexo de texto editado" "$PH pediu desconto" "$(cat "$HOME_A/uploads/2020-01-01/notas.txt")"
afirma "anexo binario continua (sem --apagar-anexos)" test -e "$HOME_A/uploads/2020-01-01/contrato.pdf"
igual "Web: JSON continua valido e sem o dado" "Ligar para $PH $PH" "$(jq -r '.mesa[0] | "\(.titulo) \(.fone)"' "$LIB/web/mesa/tarefas.json")"
igual "log do agente limpo" "2026-10-01 pedido de $PH atendido" "$(sed -n 1p "$HOME_A/.dgclaw/logs/runner.log")"
igual "log do servidor limpo" "cliente $PH acessou" "$(cat "$RAIZ_LOG/admin-runner.log")"
igual "o resto do log continua" "linha sem nada" "$(sed -n 2p "$HOME_A/.dgclaw/logs/runner.log")"

echo "titular apagar: recibo e auditoria"
RECIBO="$(find "$LIB/titulares" -maxdepth 1 -name '*.json')"
igual "um recibo" 1 "$(echo "$RECIBO" | wc -l | tr -d ' ')"
afirma "nome do recibo: data-hash" bash -c "[[ '$(basename "$RECIBO")' =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{16}\.json$ ]]"
igual "recibo 600" 600 "$(stat -c %a "$RECIBO")"
igual "pasta dos recibos 700" 700 "$(stat -c %a "$LIB/titulares")"
nega "recibo sem o termo em claro" grep -qiE "maria|123\.456|exemplo\.com|98765" "$RECIBO"
afirma "recibo tem o HMAC e o que foi feito em cada lugar" jq -e '.hash_hmac_sha256 | test("^[0-9a-f]{64}$")' "$RECIBO"
afirma "recibo lista os lugares do agente" jq -e '.agentes.ana.transcripts.ocorrencias > 0 and .agentes.ana["conversas.db"].alterados == 3' "$RECIBO"
HASH="$(jq -r .hash_hmac_sha256 "$RECIBO")"
igual "recibo diz ate quando o dado sai dos backups (30 dias)" "$(date -u -d '+30 days' +%Y-%m-%d)" "$(jq -r .sai_dos_backups_ate "$RECIBO")"
afirma "a saida diz o prazo dos backups" grep -q "backup_retencao_dias = 30" "$TMP/a.txt"
nega "o sal nao e legivel por outros" test "$(stat -c %a "$LIB/titulares/.sal")" != 600
AUD="$RAIZ_LOG/auditoria.jsonl"
# shellcheck disable=SC2016 # $h e variavel do jq
afirma "auditoria titular_apagado com o hash" jq -e --arg h "$HASH" 'select(.evento=="titular_apagado") | .dados.hash == $h' "$AUD"
nega "a auditoria nao tem o termo" grep -qiE "maria|123\.456|exemplo\.com" "$AUD"

echo "titular apagar: segunda rodada e pendencias"
rm "$HOME_A/uploads/2020-01-01/contrato.pdf"
printf '{"versao":1,"numeros":[]}\n' >"$HOME_A/.dgclaw/whatsapp/permitidos.json"
touch -d '10 minutes ago' "$TR/ativo.jsonl"
dgclaw titular apagar "${TERMOS[@]}" --confirmar >"$TMP/a2.txt" 2>&1
igual "depois de resolver as pendencias: sai com 0" 0 "$?"
igual "agora nenhum arquivo tem o dado" "" "$(onde_ainda_tem)"
afirma "o transcript que estava em uso foi limpo" bash -c "! grep -q 'Maria Souza' '$TR/ativo.jsonl'"
dgclaw titular apagar "${TERMOS[@]}" --confirmar >"$TMP/a3.txt" 2>&1
afirma "terceira rodada: nada a fazer" grep -q "Nada encontrado" "$TMP/a3.txt"
igual "mesmo termo, mesmo recibo (hash estavel)" 1 "$(find "$LIB/titulares" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
igual "ordem dos termos nao muda o hash" "$HASH" "$(dgclaw titular apagar --termo "(11) 98765-4321" --termo maria@exemplo.com --termo 123.456.789-01 "Maria Souza" --confirmar >/dev/null 2>&1; jq -r .hash_hmac_sha256 "$(find "$LIB/titulares" -maxdepth 1 -name '*.json' | head -1)")"

echo "titular apagar --apagar-anexos"
printf '%%PDF contrato de Maria Souza \x00\x01' >"$HOME_A/uploads/recente/novo.pdf"
touch -d '3 days ago' "$HOME_A/uploads/recente/novo.pdf"
dgclaw titular apagar "Maria Souza" --confirmar >"$TMP/a4.txt" 2>&1
igual "anexo binario sem --apagar-anexos: codigo 2" 2 "$?"
afirma "o anexo ficou" test -e "$HOME_A/uploads/recente/novo.pdf"
dgclaw titular apagar "Maria Souza" --confirmar --apagar-anexos >"$TMP/a5.txt" 2>&1
igual "com --apagar-anexos: codigo 0" 0 "$?"
nega "o anexo binario foi removido" test -e "$HOME_A/uploads/recente/novo.pdf"
afirma "os outros anexos ficaram" test -e "$HOME_A/uploads/recente/foto.png"

echo "titular apagar: atalho plantado nao leva o root para fora"
printf 'Maria Souza fora da casa\n' >"$TMP/fora-memoria.md"
ln -sf "$TMP/fora-memoria.md" "$HOME_A/memory/atalho.md"
dgclaw titular apagar "Maria Souza" --confirmar >"$TMP/a6.txt" 2>&1
igual "arquivo de fora intacto" "Maria Souza fora da casa" "$(cat "$TMP/fora-memoria.md")"
afirma "o atalho e reportado" grep -q "atalho" "$TMP/a6.txt"
rm "$HOME_A/memory/atalho.md"

fim
