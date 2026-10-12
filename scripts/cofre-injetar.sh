#!/usr/bin/env bash
# cofre-injetar.sh — coloca chaves no cofre de UM agente, pela API do painel dele, sem ver a tela.
#
# USO
#   cofre-injetar.sh --painel <url-base> --chave-api-arquivo <arquivo> [--aplicar] NOME [NOME...]
#
#   --painel               endereço do painel do agente, com o prefixo se houver
#                          (ex.: https://painel.exemplo.com ou http://127.0.0.1:8300/agente/x/painel)
#   --chave-api-arquivo    arquivo que contém SÓ o token dgc_... da chave de API DAQUELE agente.
#                          Precisa estar em modo 600 (ninguém além do dono lê).
#   --aplicar              depois de guardar tudo, reinicia o agente para as chaves valerem.
#                          Vai só na ÚLTIMA chave: reiniciar uma vez por chave interromperia o agente à toa.
#   NOME                   nome da variável. O VALOR é lido da variável de ambiente de mesmo nome:
#
#       OPENAI_API_KEY="$(pbpaste)" cofre-injetar.sh --painel ... --chave-api-arquivo ... OPENAI_API_KEY
#
# O VALOR NUNCA PASSA POR ARGUMENTO nem por linha de comando: argv aparece no `ps` e no histórico
# do shell. O token da chave de API também não: quem fala com o painel é um python3 que lê os dois
# do ambiente e do arquivo, e a conversa com o painel não leva nada no argv de nenhum processo.
#
# SAÍDA: uma linha por chave, só com o nome, ok/erro e os 4 últimos caracteres. Nunca o valor.
# Sai com código diferente de zero se qualquer chave falhar.
set -euo pipefail

usar() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit "${1:-2}"
}

PAINEL=""
ARQUIVO_CHAVE=""
APLICAR=0
NOMES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --painel)              PAINEL="${2:-}"; shift 2 || usar ;;
    --chave-api-arquivo)   ARQUIVO_CHAVE="${2:-}"; shift 2 || usar ;;
    --aplicar)             APLICAR=1; shift ;;
    -h|--help)             usar 0 ;;
    --*)                   echo "Opção desconhecida: $1" >&2; usar ;;
    *)                     NOMES+=("$1"); shift ;;
  esac
done

if [ -z "$PAINEL" ] || [ -z "$ARQUIVO_CHAVE" ] || [ ${#NOMES[@]} -eq 0 ]; then
  echo "Faltou argumento: precisa de --painel, --chave-api-arquivo e pelo menos um NOME." >&2
  usar
fi
case "$PAINEL" in
  http://*|https://*) ;;
  *) echo "O endereço do painel precisa começar com http:// ou https:// (recebi: $PAINEL)." >&2; exit 2 ;;
esac
if [ ! -f "$ARQUIVO_CHAVE" ]; then
  echo "O arquivo da chave de API não existe: $ARQUIVO_CHAVE" >&2
  echo "Crie a chave na aba Cofre do painel (ou com 'node panel/bin/chave-api.js criar \"Admin\"') e guarde o token nesse arquivo com chmod 600." >&2
  exit 2
fi
MODO="$(stat -c '%a' "$ARQUIVO_CHAVE")"
if [ $(( 8#$MODO & 8#077 )) -ne 0 ]; then
  echo "O arquivo da chave de API ($ARQUIVO_CHAVE) está legível por outros usuários (modo $MODO). Recuso usar." >&2
  echo "Quem lê esse arquivo guarda chaves neste agente. Corrija com: chmod 600 $ARQUIVO_CHAVE" >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "Preciso do python3 instalado para falar com o painel sem pôr segredo em argumento." >&2; exit 2; }

for n in "${NOMES[@]}"; do
  if ! [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "$n erro: isto não é um nome de variável (só letras, números e sublinhado)." >&2
    exit 2
  fi
done

# Um python3 por chave, para o erro de uma não esconder o resultado das outras.
PY='
import json, os, sys, urllib.request, urllib.error

painel, arquivo, nome, aplicar = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

def sair(msg):
    print(nome + " erro: " + msg)
    sys.exit(1)

valor = os.environ.get(nome, "")
if not valor:
    sair("a variável de ambiente " + nome + " não está definida ou está vazia. Exporte o valor só para este comando, sem pô-lo na linha.")
if valor.startswith("vault:"):
    sair("o valor de " + nome + " no seu ambiente é uma referência de cofre (começa com vault:), e não a chave. "
         "Ela só vale atrás do proxy que a troca pela chave verdadeira, e dentro do agente não valeria nada. "
         "Exporte a chave verdadeira, lida da fonte onde ela fica guardada, só para este comando.")
try:
    token = open(arquivo, encoding="utf-8").read().strip()
except OSError as e:
    sair("não consegui ler o arquivo da chave de API (" + str(e.strerror) + ").")
if not token:
    sair("o arquivo da chave de API está vazio.")

corpo = {"envName": nome, "valor": valor}
if aplicar:
    corpo["aplicar"] = True
req = urllib.request.Request(
    painel.rstrip("/") + "/api/cofre",
    data=json.dumps(corpo).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    method="POST",
)
resposta, status = b"", 0
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        resposta, status = r.read(), r.status
except urllib.error.HTTPError as e:
    resposta, status = e.read(), e.code
except (urllib.error.URLError, TimeoutError, OSError) as e:
    sair("não alcancei o painel em " + painel + " (" + str(getattr(e, "reason", e)) + "). Confira se o painel está no ar e se o endereço está certo.")

try:
    dados = json.loads(resposta or b"{}")
except ValueError:
    dados = {}
if not isinstance(dados, dict):
    dados = {}

def sem_valor(texto):
    return str(texto).replace(valor, "***")

def explicacao():
    partes = [sem_valor(dados.get("error", "")), sem_valor(dados.get("howToFix", ""))]
    return " ".join(p for p in partes if p)

if status == 401:
    sair("o painel recusou a chave de API (401). Ela está errada, foi revogada ou é de outro agente.")
guardado_no_erro = dados.get("guardado") if isinstance(dados.get("guardado"), dict) else None
if status >= 400 and guardado_no_erro and guardado_no_erro.get("ok"):
    # Guardou, mas o reinicio falhou: a chave esta no cofre e ainda nao vale para o agente.
    print(nome + " guardada (final " + str(guardado_no_erro.get("ultimos4") or "????") + "), mas o agente NAO reiniciou: " + explicacao())
    sys.exit(3)
if status >= 400 or not (dados.get("ok") or dados.get("guardado")):
    sair(explicacao() or ("o painel respondeu " + str(status) + " sem explicar."))

guardado = dados.get("guardado") if isinstance(dados.get("guardado"), dict) else {}
final = dados.get("ultimos4") or guardado.get("ultimos4") or "????"
linha = nome + " ok (final " + str(final) + ")"
if aplicar:
    ap = dados.get("aplicado") if isinstance(dados.get("aplicado"), dict) else {}
    linha += " e o agente foi reiniciado" if ap.get("ok") else " mas o agente NÃO reiniciou"
print(linha)
'

FALHOU=0
REINICIO_FALHOU=0
TOTAL=${#NOMES[@]}
i=0
for n in "${NOMES[@]}"; do
  i=$((i + 1))
  APLICAR_ESTA=0
  if [ "$APLICAR" -eq 1 ] && [ "$i" -eq "$TOTAL" ]; then APLICAR_ESTA=1; fi
  RC=0
  python3 -I -c "$PY" "$PAINEL" "$ARQUIVO_CHAVE" "$n" "$APLICAR_ESTA" || RC=$?
  if [ "$RC" -eq 3 ]; then
    REINICIO_FALHOU=1
  elif [ "$RC" -ne 0 ]; then
    FALHOU=1
    if [ "$APLICAR_ESTA" -eq 1 ]; then REINICIO_FALHOU=1; fi
  fi
done

if [ "$REINICIO_FALHOU" -eq 1 ]; then
  echo "O agente NÃO foi reiniciado: as chaves guardadas ainda não valem para ele. Reinicie o agente (aba Cofre, \"aplicar e reiniciar\") ou peça a quem administra a máquina." >&2
fi
if [ "$FALHOU" -ne 0 ]; then
  echo "Alguma chave não foi guardada. As que aparecem como ok ficaram guardadas; as com erro, não." >&2
  exit 1
fi
if [ "$REINICIO_FALHOU" -eq 1 ]; then
  exit 3
fi
