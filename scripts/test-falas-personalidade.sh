#!/bin/bash
# test-falas-personalidade.sh — Prova que um agente novo nasce com FALAS escritas,
# e nao so com Big Five em numero.
#
# Por que isto virou aceite (Fase H do plano): numero nao tem som. Um motor novo
# le "humor 6/10" e inventa um humor que nao e o do agente; fala escrita ele
# imita. Foi o que segurou o jeito da Isa numa troca de modelo, e ate 11/08/2026
# o PERSONALITY.md.tmpl do DG Claw tinha zero exemplo.
#
# A segunda metade da bancada e a armadilha: o /api/personality do painel varre o
# arquivo INTEIRO com um regex atras de `| Traco | n/10`, e tambem pega titulo
# `### Coisa (n/10)`. Uma fala de exemplo escrita em tabela entraria na aba
# PERSONALIDADE como se fosse um traco medido. Por isso o teste nao olha so se as
# falas existem: ele roda o mesmo regex do painel e conta os tracos.
#
# Uso: bash scripts/test-falas-personalidade.sh

set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(cd "$AQUI/.." && pwd)"
FALHAS=0
ok()     { echo "✅ $1"; }
falhou() { echo "❌ $1" >&2; FALHAS=$((FALHAS + 1)); }

WS="$(mktemp -d /tmp/dgclaw-falas-XXXXXX)"
trap 'rm -rf "$WS"' EXIT
mkdir -p "$WS/.dgclaw" "$WS/memory" "$WS/planning"

# O seed de verdade, do jeito que o wizard chama no Passo 7.
bash "$PLUGIN/scripts/install-core.sh" seed-persona \
    --workspace "$WS" --name "Nina" --owner "Marta" \
    --humor 6 --proatividade 7 > "$WS/seed.log" 2>&1
P="$WS/PERSONALITY.md"

if [ -f "$P" ]; then
    ok "1. o seed criou o PERSONALITY.md"
else
    falhou "1. o seed nao criou o PERSONALITY.md: $(tail -3 "$WS/seed.log")"
    exit 1
fi

# ── 2. as falas nasceram ────────────────────────────────────────────────────
if grep -q "FALAS:INICIO" "$P" && grep -q "FALAS:FIM" "$P"; then
    ok "2. o bloco de falas veio com marcadores (o wizard sabe o que reescrever)"
else
    falhou "2. nao achei os marcadores FALAS:INICIO/FIM"
fi

# Cada fala e uma citacao (`> ...`) dentro do bloco. Cinco e o piso do plano.
FALAS=$(awk '/FALAS:INICIO/{d=1;next} /FALAS:FIM/{d=0} d && /^[[:space:]]*>/' "$P" | wc -l)
if [ "$FALAS" -ge 5 ] && [ "$FALAS" -le 8 ]; then
    ok "3. nasceu com $FALAS falas escritas (o plano pede de 5 a 8)"
else
    falhou "3. nasceu com $FALAS falas, fora da faixa de 5 a 8"
fi

# ── 4. as falas sao DESTE agente ────────────────────────────────────────────
# Placeholder cru vazando pro system prompt ja aconteceu antes neste projeto
# (o {{CRISIS_HOTLINE}} da LAWS). Uma fala com {{DONO}} no meio nao ensina voz
# nenhuma: ensina a escrever chave de template.
if ! grep -q "{{" "$P"; then
    ok "4. nenhum placeholder cru sobrou no arquivo"
else
    falhou "4. sobrou placeholder cru: $(grep -o '{{[A-Z_]*}}' "$P" | sort -u | tr '\n' ' ')"
fi
if awk '/FALAS:INICIO/{d=1} /FALAS:FIM/{d=0} d' "$P" | grep -q "Marta"; then
    ok "5. e as falas chamam a dona pelo nome dela (Marta), nao por 'o dono'"
else
    falhou "5. o nome da dona nao chegou nas falas"
fi

# ── 6. as situacoes que se repetem todo dia ─────────────────────────────────
# A lista importa mais que a redacao: sao os momentos em que um agente sem
# exemplo escorrega pro tom de fabrica do modelo (o "como um assistente de IA").
FALTANDO=""
for situacao in "recebo um pedido" "entrego o resultado" "nao sei\|não sei" "discordo" "errei" "conta própria\|conta propria" "recuso"; do
    grep -qi -- "$situacao" "$P" || FALTANDO="$FALTANDO [$situacao]"
done
if [ -z "$FALTANDO" ]; then
    ok "6. as sete situacoes do dia a dia estao cobertas"
else
    falhou "6. faltou situacao:$FALTANDO"
fi
if grep -qi "nunca escrevo" "$P"; then
    ok "7. e tem o contraste (o que ele NUNCA escreve), que e o que mais segura voz"
else
    falhou "7. faltou o bloco do 'o que eu nunca escrevo'"
fi

# ── 8. O GUARDA QUE DA NOME A ESTA BANCADA ──────────────────────────────────
# O mesmo regex do /api/personality do painel (panel/server.js). Se uma fala de
# exemplo virar linha de tabela, ela entra na aba PERSONALIDADE como traco medido.
TRACOS=$(node -e '
const fs = require("fs");
const t = fs.readFileSync(process.argv[1], "utf8");
const bf = {};
for (const m of t.matchAll(/\|\s*([\wçãéêáà]+(?:\s+[\wçãéêáà]+)*)\s*\|\s*(\d+)\/10/gi)) bf[m[1].trim().toLowerCase()] = +m[2];
for (const m of t.matchAll(/###\s+(.+?)\s*\((\d+)\/10\)/g)) bf[m[1].trim().toLowerCase()] = +m[2];
console.log(Object.keys(bf).length + ":" + Object.keys(bf).sort().join(","));
' "$P")
QUANTOS="${TRACOS%%:*}"
QUAIS="${TRACOS#*:}"
if [ "$QUANTOS" = "5" ]; then
    ok "8. o painel continua lendo exatamente 5 tracos ($QUAIS)"
else
    falhou "8. o painel leria $QUANTOS tracos em vez de 5: $QUAIS"
    falhou "8b. isso quer dizer que alguma fala de exemplo esta em formato de tabela"
fi

# ── 9. a tabela continua no lugar ───────────────────────────────────────────
if grep -q "^| Extroversão | 6/10" "$P" 2>/dev/null || grep -qE '^\| Extrovers.o \| [0-9]+/10' "$P"; then
    ok "9. a tabela dos Big Five sobreviveu ao acrescimo"
else
    falhou "9. a tabela dos Big Five sumiu ou mudou de formato"
fi

# ── 10. o perfil pronto troca as falas pelas dele ───────────────────────────
# Isto existe por causa de quem nasce SEM entrevista. Quem instala pela conversa
# tem o wizard reescrevendo o bloco; um agente nascido pela plataforma (entrega.ts
# / provision.ts chamam o seed direto) ficaria com as falas de fabrica pra sempre.
# E um gestor nao fala como um assistente pessoal.
WS2="$(mktemp -d /tmp/dgclaw-falas-perfil-XXXXXX)"
mkdir -p "$WS2/.dgclaw/plugin/templates/archetypes/exemplo" "$WS2/memory" "$WS2/planning"
cp -r "$PLUGIN/templates" "$WS2/.dgclaw/plugin/"
ADIR="$WS2/.dgclaw/plugin/templates/archetypes/exemplo"
printf '{"label":"Exemplo","suggestedBigFive":{"humor":3}}\n' > "$ADIR/manifest.json"
cat > "$ADIR/FALAS.md.tmpl" <<'FIM'
- **Quando entrego:**
  > Está no ar, {{DONO}}.
- **Quando travo:**
  > Travei e não saio sozinho.
FIM
bash "$PLUGIN/scripts/install-core.sh" seed-persona \
    --workspace "$WS2" --archetype exemplo --name "Otavio" --owner "Danilo" \
    > "$WS2/seed.log" 2>&1
P2="$WS2/PERSONALITY.md"
if grep -q "Travei e não saio sozinho" "$P2" 2>/dev/null; then
    ok "10. o perfil pronto substitui as falas de fabrica pelas dele"
else
    falhou "10. as falas do perfil nao entraram: $(tail -3 "$WS2/seed.log")"
fi
if ! grep -q "Peguei. Vou olhar isso agora" "$P2" 2>/dev/null; then
    ok "10b. e as de fabrica saem em vez de ficarem empilhadas com as novas"
else
    falhou "10b. as falas de fabrica continuaram no arquivo junto com as do perfil"
fi
# A tabela nao pode ir junto: e dela que o painel le os tracos.
if grep -qE '^\| Extrovers.o \| [0-9]+/10' "$P2" 2>/dev/null; then
    ok "10c. e a tabela dos Big Five continua intacta depois da troca"
else
    falhou "10c. a troca de falas levou a tabela junto"
fi

# ── 11. persona viva nao e atropelada ───────────────────────────────────────
# Rodar o seed de novo num agente que ja existe (idempotencia) nao pode reescrever
# a voz que o dono ajustou na mao. O `subst` ja protege o arquivo; a troca de falas
# tem que respeitar a mesma regra, senao ela vira uma porta dos fundos.
printf '# Personalidade de Otavio\n\n| Extroversão | 5/10 | x |\n\n<!-- FALAS:INICIO -->\n> Falo do meu jeito.\n<!-- FALAS:FIM -->\n' > "$P2"
bash "$PLUGIN/scripts/install-core.sh" seed-persona \
    --workspace "$WS2" --archetype exemplo --name "Otavio" --owner "Danilo" \
    > "$WS2/seed2.log" 2>&1
if grep -q "Falo do meu jeito" "$P2" && ! grep -q "Travei e não saio sozinho" "$P2"; then
    ok "11. rodar o seed de novo NAO reescreve a voz de um agente que ja existe"
else
    falhou "11. o segundo seed atropelou o PERSONALITY.md que ja estava la"
fi
rm -rf "$WS2"

echo ""
if [ "$FALHAS" -gt 0 ]; then
    echo "$FALHAS verificacao(oes) falharam." >&2
    exit 1
fi
echo "Falas na personalidade: tudo verde (agente novo nasce com voz escrita)."
