#!/usr/bin/env bash
# Bloco I, lado bash: dgclaw ferramenta (criar, listar, testar, credencial, abrir, chave, ficha, skill), a unidade do
# systemd e os ganchos. Raiz falsa; useradd, getent, chown, systemctl e systemd-creds de mentira.
set -uo pipefail
# shellcheck source=tests/enterprise/_bloco-d.sh
. "$(dirname "$0")/_bloco-d.sh"
ENT_STUBS_I="$(cd "$(dirname "$0")" && pwd)/stubs-i"
preparar
stubs_d
PATH="$ENT_STUBS_I:$PATH"; export PATH
# Nada aqui pode tocar na maquina de verdade: se algum destes comandos nao for o de mentira, o teste nem comeca.
for cmd in useradd getent chown; do
    [ "$(command -v "$cmd")" = "$ENT_STUBS_I/$cmd" ] || { echo "ABORTADO: $cmd nao e o stub de tests/enterprise/stubs-i"; exit 1; }
done
for cmd in systemctl systemd-creds; do
    case "$(command -v "$cmd")" in "$REPO"/tests/*) ;; *) echo "ABORTADO: $cmd nao e um stub de $REPO/tests"; exit 1 ;; esac
done
app_copia
cp -r "$REPO/ferramentas" "$TMP/app/"
mkdir -p "$TMP/app/web/lib" && cp "$REPO/web/lib/mascara.js" "$TMP/app/web/lib/"

UNIT="$DGCLAW_RAIZ/etc/systemd/system/dgclaw-ferramentas.service"
FERR="$ETC/ferramentas"
AUD="$DGCLAW_RAIZ/var/log/dgclaw/auditoria.jsonl"
RAM="$DGCLAW_RAIZ/run/dgclaw/ferramentas-cred"
AGENTES="$ETC/agentes.json"
chamou() { grep -q -- "$1" "$STUB_LOG"; }

echo "kit sensivel: nivel pessoal nao muda nada"
afirma "ganchos de instalar e aplicar nao fazem nada" bash -c "$(declare -f lib_d); REPO='$REPO'; lib_d ent_instalar_kit_sensivel && lib_d ent_aplicar_kit_sensivel"
afirma "gancho de status nao diz nada" bash -c "[ -z \"\$(DGCLAW_RAIZ='$DGCLAW_RAIZ' bash -c '. \"$REPO/lib/comum.sh\"; . \"$REPO/lib/agentes.sh\"; . \"$REPO/lib/protecoes.sh\"; for f in \"$REPO\"/lib/enterprise/*.sh; do . \"\$f\"; done; ent_status_kit_sensivel')\" ]"
afirma "nenhuma unidade, nenhuma pasta, nenhum usuario" bash -c "[ ! -e '$UNIT' ] && [ ! -e '$FERR' ] && ! grep -q useradd '$STUB_LOG'"
nega "criar recusa com a protecao desligada" "$CLI_COPIA" ferramenta criar carteira.resumo --agente ana --responsavel "Maria"
afirma "a recusa diz como ligar" bash -c "'$CLI_COPIA' ferramenta criar carteira.resumo --agente ana --responsavel Maria 2>&1 | grep -q 'dgclaw nivel ajustar kit_sensivel true'"
afirma "nada foi criado" test ! -e "$FERR"
afirma "listar funciona e diz que nao ha ferramentas" bash -c "'$CLI_COPIA' ferramenta listar 2>&1 | grep -q 'Nenhuma ferramenta'"
nega "subcomando que nao existe" "$CLI_COPIA" ferramenta voar
"$CLI_COPIA" ferramenta testar "$REPO/templates/ferramenta-sensivel/exemplo-carteira" >"$TMP/teste.txt" 2>&1
igual "testar o exemplo por caminho passa (base falsa, nenhum nome ou CPF na saida)" 0 "$?"
afirma "o teste diz que deu tudo certo" grep -q "tudo certo (7 casos)" "$TMP/teste.txt"
afirma "o teste nao deixou pasta temporaria para tras" bash -c "! ls /tmp | grep -q '^dgf-teste-'"

echo "kit sensivel: instalacao no nivel empresa"
nivel_na_raiz empresa
: >"$STUB_LOG"
lib_d ent_instalar_kit_sensivel >"$TMP/inst.txt" 2>&1
igual "instalar termina bem" 0 "$?"
afirma "criou o usuario do servico sem login" chamou "useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dgclaw-ferramentas"
afirma "a pasta das ferramentas existe com modo 750" test "$(stat -c %a "$FERR")" = 750
igual "chave de pseudonimo: 64 hexadecimais" 64 "$(tr -d '\n' <"$FERR/chave-pseudonimo" | wc -c)"
afirma "chave de pseudonimo 600" test "$(stat -c %a "$FERR/chave-pseudonimo")" = 600
CHAVE1="$(cat "$FERR/chave-pseudonimo")"
afirma "unidade escrita" test -f "$UNIT"
afirma "a unidade roda sem root e sem capacidades" bash -c "grep -q '^User=dgclaw-ferramentas' '$UNIT' && grep -q '^CapabilityBoundingSet=\$' '$UNIT' && grep -q '^NoNewPrivileges=yes' '$UNIT' && ! grep -q '^User=root' '$UNIT'"
afirma "a unidade abre as credenciais cifradas como root antes de subir" grep -q '^ExecStartPre=+-/opt/dgclaw/app/bin/dgclaw ferramenta abrir' "$UNIT"
afirma "a unidade endurece o sistema de arquivos" bash -c "grep -q '^ProtectSystem=strict' '$UNIT' && grep -q '^ProtectHome=yes' '$UNIT' && grep -q '^PrivateTmp=yes' '$UNIT'"
afirma "habilitou e reiniciou o servico" bash -c "grep -q 'systemctl enable dgclaw-ferramentas.service' '$STUB_LOG' && grep -q 'systemctl restart dgclaw-ferramentas.service' '$STUB_LOG'"
: >"$STUB_LOG"
lib_d ent_instalar_kit_sensivel >"$TMP/inst2.txt" 2>&1
igual "instalar de novo e seguro" 0 "$?"
igual "a chave nao foi trocada" "$CHAVE1" "$(cat "$FERR/chave-pseudonimo")"
afirma "nao criou o usuario outra vez" bash -c "! grep -q useradd '$STUB_LOG'"
afirma "a saida avisa que a chave ficou" grep -q "ja existe" "$TMP/inst2.txt"
afirma "protecoes aplicar chama o mesmo caminho" bash -c "'$CLI_COPIA' protecoes aplicar >/dev/null 2>&1; grep -q 'systemctl enable dgclaw-ferramentas.service' '$STUB_LOG'"

echo "kit sensivel: criar uma ferramenta"
nega "criar sem agente falha" "$CLI_COPIA" ferramenta criar carteira.resumo --responsavel "Maria"
nega "criar sem responsavel falha" "$CLI_COPIA" ferramenta criar carteira.resumo --agente ana
nega "nome com ../ falha" "$CLI_COPIA" ferramenta criar ../x --agente ana --responsavel Maria
nega "slug de agente torto falha" "$CLI_COPIA" ferramenta criar carteira.resumo --agente "Ana; rm" --responsavel Maria
afirma "nada foi criado pelas recusas" test ! -e "$FERR/carteira.resumo"
"$CLI_COPIA" ferramenta criar carteira.resumo --agente ana --agente marina --responsavel "Maria Souza, maria@empresa.com" >"$TMP/criar.txt" 2>&1
igual "criar termina bem" 0 "$?"
F="$FERR/carteira.resumo"
afirma "a pasta tem ferramenta.json, executor, teste e a base de teste" bash -c "[ -f '$F/ferramenta.json' ] && [ -f '$F/executor.py' ] && [ -f '$F/teste.json' ] && [ -f '$F/teste/gerar_base.py' ]"
igual "nome" "carteira.resumo" "$(jq -r .nome "$F/ferramenta.json")"
igual "agentes" "ana,marina" "$(jq -r '.agentes | join(",")' "$F/ferramenta.json")"
igual "responsavel" "Maria Souza, maria@empresa.com" "$(jq -r .responsavel "$F/ferramenta.json")"
afirma "finalidade e base legal ficam para preencher" bash -c "jq -r .finalidade '$F/ferramenta.json' | grep -q '^PREENCHER'"
afirma "a saida lista os proximos passos" grep -q "dgclaw ferramenta credencial carteira.resumo" "$TMP/criar.txt"
nega "criar de novo no mesmo nome falha" "$CLI_COPIA" ferramenta criar carteira.resumo --agente ana --responsavel Maria
afirma "foi para a auditoria sem inventar dado" bash -c "grep -q '\"evento\":\"ferramenta_criada\"' '$AUD'"
afirma "listar aponta o PREENCHER como defeito" bash -c "'$CLI_COPIA' ferramenta listar 2>&1 | grep -q 'ainda está com o texto PREENCHER'"
nega "testar recusa enquanto ha PREENCHER" "$CLI_COPIA" ferramenta testar carteira.resumo
jq '.finalidade = "Acompanhar a composicao da carteira" | .base_legal = "Legitimo interesse" | .descricao = "Resumo agregado da carteira"' "$F/ferramenta.json" >"$F/f.tmp" && mv "$F/f.tmp" "$F/ferramenta.json"
afirma "preenchido, a ferramenta lista sem defeito" bash -c "'$CLI_COPIA' ferramenta listar 2>&1 | grep -q 'agentes: ana, marina' && ! '$CLI_COPIA' ferramenta listar 2>&1 | grep -q 'COM DEFEITO'"
"$CLI_COPIA" ferramenta testar carteira.resumo >"$TMP/t2.txt" 2>&1
igual "testar pelo nome passa" 0 "$?"

echo "kit sensivel: credencial"
nivel_na_raiz pessoal '{"kit_sensivel": true}'
nega "credencial pelo teclado (sem stdin) e recusada" bash -c "'$CLI_COPIA' ferramenta credencial carteira.resumo < /dev/tty" 
printf 'BASE_SQLITE=/dados/carteira.db\nBASE_SENHA=senha-super-secreta-123\n# comentario\n' | "$CLI_COPIA" ferramenta credencial carteira.resumo >"$TMP/cred.txt" 2>&1
igual "credencial em claro termina bem (pessoal com o kit ligado: cofre_cifrado desligado)" 0 "$?"
afirma "credenciais.env 600" test "$(stat -c %a "$F/credenciais.env")" = 600
afirma "tem as duas chaves" bash -c "grep -q '^BASE_SENHA=senha-super-secreta-123' '$F/credenciais.env' && grep -q '^BASE_SQLITE=' '$F/credenciais.env'"
afirma "a senha nao foi para a tela" bash -c "! grep -q 'senha-super-secreta' '$TMP/cred.txt'"
nega "linha sem CHAVE=valor e recusada" bash -c "printf 'isto nao e chave\n' | '$CLI_COPIA' ferramenta credencial carteira.resumo"
nega "nome reservado e recusado" bash -c "printf 'DGCLAW_X=1\n' | '$CLI_COPIA' ferramenta credencial carteira.resumo"
nega "stdin vazio e recusado" bash -c "printf '' | '$CLI_COPIA' ferramenta credencial carteira.resumo"
afirma "as recusas nao tocaram na credencial" grep -q "senha-super-secreta-123" "$F/credenciais.env"
nega "credencial de ferramenta que nao existe" bash -c "printf 'A=1\n' | '$CLI_COPIA' ferramenta credencial nao.existe"

echo "kit sensivel: credencial cifrada (cofre_cifrado ligado)"
nivel_na_raiz empresa
printf 'BASE_SENHA=outra-senha-cifrada-456\n' | "$CLI_COPIA" ferramenta credencial carteira.resumo >"$TMP/cred2.txt" 2>&1
igual "credencial cifrada termina bem" 0 "$?"
afirma "ficou o .cred e saiu a copia em claro do disco" bash -c "[ -f '$F/credenciais.env.cred' ] && [ ! -e '$F/credenciais.env' ]"
afirma "a auditoria sabe quantas chaves, nao quais valores" bash -c "grep '\"evento\":\"ferramenta_credencial\"' '$AUD' | jq -e '.dados.chaves == 1' >/dev/null && ! grep -q 'senha' '$AUD'"
afirma "o .cred nao tem a senha em texto" bash -c "! grep -q 'outra-senha-cifrada-456' '$F/credenciais.env.cred'"
afirma "a copia em memoria tem a senha, 600" bash -c "grep -q 'outra-senha-cifrada-456' '$RAM/carteira.resumo/credenciais.env' && [ \"\$(stat -c %a '$RAM/carteira.resumo/credenciais.env')\" = 600 ] && [ \"\$(stat -c %a '$RAM/carteira.resumo')\" = 700 ]"
rm -rf "$RAM"
"$CLI_COPIA" ferramenta abrir >"$TMP/abrir.txt" 2>&1
igual "abrir (o que o boot do servico faz) termina bem" 0 "$?"
afirma "abrir refez a copia em memoria" grep -q "outra-senha-cifrada-456" "$RAM/carteira.resumo/credenciais.env"
STUB_CREDS_FALHA=1 "$CLI_COPIA" ferramenta abrir >"$TMP/abrir2.txt" 2>&1
afirma "se nao decifra, abrir avisa e diz o que fazer" grep -q "dgclaw ferramenta credencial carteira.resumo" "$TMP/abrir2.txt"

echo "kit sensivel: ficha e skill"
nivel_na_raiz empresa
"$CLI_COPIA" ferramenta ficha carteira.resumo >"$TMP/ficha.md" 2>&1
igual "ficha termina bem" 0 "$?"
afirma "a ficha traz finalidade, base legal, campos, retencao e responsavel" bash -c "grep -q 'Acompanhar a composicao da carteira' '$TMP/ficha.md' && grep -q 'Legitimo interesse' '$TMP/ficha.md' && grep -q 'faixa_etaria, plano, valor, competencia' '$TMP/ficha.md' && grep -q '30 dias' '$TMP/ficha.md' && grep -q 'maria@empresa.com' '$TMP/ficha.md'"
afirma "a ficha nao deixa campo sem preencher" bash -c "! grep -q '{{' '$TMP/ficha.md'"
CASA_ANA="$TMP/casa-ana"
mkdir -p "$CASA_ANA/.claude/skills"
printf '{"versao": 1, "agentes": [{"slug":"ana","nome":"Ana","tipo":"agente","runner":"http://127.0.0.1:4311","agente_id":"ana","chat_id":"c_ana","avatar":"A","cor":"#000","provedor":"claude","modelo":"","transcripts_dir":"/x","porta_painel":null,"proxy_segredo_arquivo":null,"runner_token_arquivo":"/x","home_host":"%s","home_container":"/home/ana"}]}\n' "$CASA_ANA" >"$AGENTES"
nega "skill para agente que nao esta na lista da ferramenta" "$CLI_COPIA" ferramenta skill carteira.resumo --agente joana
"$CLI_COPIA" ferramenta skill carteira.resumo --agente ana >"$TMP/skill.txt" 2>&1
igual "skill termina bem" 0 "$?"
S="$CASA_ANA/.claude/skills/carteira-resumo/SKILL.md"
afirma "a skill ensina a usar so a ferramenta" bash -c "grep -q 'dgclaw-ferramenta carteira.resumo --periodo <periodo> --agrupar_por <agrupar_por>' '$S' && grep -q '^name: carteira-resumo' '$S' && grep -q 'Nao pede ao usuario\\|Não pede ao usuário' '$S'"
afirma "a skill nao deixa campo sem preencher" bash -c "! grep -q '{{' '$S'"
afirma "a skill nao tem credencial nem caminho da base" bash -c "! grep -qi 'senha\\|BASE_SQLITE\\|/etc/dgclaw' '$S'"

echo "kit sensivel: sem travessao nos textos novos"
afirma "templates, docs e ajuda sem travessao no meio de frase" bash -c "! grep -n $'—\\|–' '$REPO/templates/skill-sensivel/SKILL.md' '$REPO/templates/skill-sensivel/FICHA.md' '$REPO/lib/enterprise/kit-sensivel.sh' '$REPO/bin/dgclaw-ferramenta' '$REPO/docs/enterprise/KIT-SENSIVEL.md' '$REPO/docs/enterprise/SKILL-SENSIVEL.md'"

fim
