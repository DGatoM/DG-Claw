#!/usr/bin/env python3
"""Testa a sentinela do servidor (seguranca/sentinela/sentinela.py) numa raiz falsa (DGCLAW_RAIZ), sem root e sem rede.

Medições falsas (disco, memória, runners, serviços, podman) vão num JSON apontado por DGCLAW_SENTINELA_FALSO, que só vale
com DGCLAW_SENTINELA_TESTE=1. Telegram, pulso, Admin e SMTP são servidores locais que gravam o que receberam. Nenhum comando
de verdade (podman, systemctl, journalctl, apt-get) roda: com o JSON falso ligado o sentinela só os registra.

Uso: python3 -I tests/sentinela/test_sentinela.py [parte-do-nome-do-caso]
"""
import importlib.util
import json
import os
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(AQUI))
SENTINELA = os.path.join(REPO, "seguranca", "sentinela", "sentinela.py")
T0 = 1_800_000_000
TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_12345"
SENHA = "SenhaSecretaDoEmail#99"
FALHAS = []


def confere(ok, msg):
    print(("  ok     " if ok else "  FALHOU ") + msg)
    if not ok:
        FALHAS.append(msg)


def carrega_modulo(raiz):
    os.environ["DGCLAW_RAIZ"] = raiz
    os.environ["DGCLAW_SENTINELA_TESTE"] = "1"
    spec = importlib.util.spec_from_file_location("sentinela_sob_teste", SENTINELA)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# --- servidores falsos ---------------------------------------------------------------------------

class Gravador:
    def __init__(self, status=200):
        self.pedidos = []
        self.status = status
        g = self

        class H(BaseHTTPRequestHandler):
            def _tratar(self):
                n = int(self.headers.get("Content-Length") or 0)
                corpo = self.rfile.read(n).decode("utf-8", "replace") if n else ""
                g.pedidos.append({"metodo": self.command, "caminho": self.path, "corpo": corpo, "auth": self.headers.get("Authorization", "")})
                self.send_response(g.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true,"description":"Unauthorized"}')

            do_GET = do_POST = _tratar

            def log_message(self, *a):
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.porta = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.porta}"

    def parar(self):
        self.srv.shutdown()
        self.srv.server_close()


class Smtp:
    def __init__(self):
        self.mensagens = []
        s = self

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                w = lambda t: (self.wfile.write((t + "\r\n").encode()), self.wfile.flush())
                w("220 teste")
                dados = False
                buf = []
                while True:
                    linha = self.rfile.readline()
                    if not linha:
                        return
                    t = linha.decode("utf-8", "replace").rstrip("\r\n")
                    if dados:
                        if t == ".":
                            s.mensagens.append("\n".join(buf))
                            dados, buf = False, []
                            w("250 ok")
                        else:
                            buf.append(t)
                        continue
                    u = t.upper()
                    if u.startswith(("EHLO", "HELO")):
                        w("250 teste")
                    elif u.startswith(("MAIL", "RCPT", "RSET", "NOOP")):
                        w("250 ok")
                    elif u == "DATA":
                        dados = True
                        w("354 vai")
                    elif u == "QUIT":
                        w("221 tchau")
                        return
                    else:
                        w("502 nao")

        class S(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.srv = S(("127.0.0.1", 0), H)
        self.porta = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def parar(self):
        self.srv.shutdown()
        self.srv.server_close()


# --- cenário -------------------------------------------------------------------------------------

class Cenario:
    def __init__(self, conf="", tg=None, pulso=None, admin=None):
        self.tmp = tempfile.mkdtemp(prefix="sentinela-teste-")
        self.raiz = self.tmp + "/raiz"
        os.makedirs(self.raiz + "/etc/dgclaw/runner")
        os.makedirs(self.raiz + "/var/lib/dgclaw")
        self.falso_arq = self.tmp + "/falso.json"
        self.agora = T0
        self.tg, self.pulso, self.admin = tg, pulso, admin
        self.extra_env = {}
        linhas = ["RESERVA_GB=0"] + ([conf] if conf else [])
        if tg:
            linhas += [f"TELEGRAM_TOKEN={TOKEN}", "TELEGRAM_CHATS=111,222"]
        if pulso:
            linhas.append(f"PULSO_URL={pulso.url}/ping")
        self.escreve("etc/dgclaw/sentinela.conf", "\n".join(linhas) + "\n", 0o600)
        if admin:
            self.escreve("etc/dgclaw/runner/admin.token", "tokenadmin1234567890\n", 0o600)
        self.falso({})

    def escreve(self, rel, texto, modo=0o644):
        p = f"{self.raiz}/{rel}"
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(texto)
        os.chmod(p, modo)
        return p

    def falso(self, dados):
        self.dados = dados
        with open(self.falso_arq, "w", encoding="utf-8") as f:
            json.dump(dados, f)

    def agentes(self, *slugs):
        reg = {"versao": 1, "agentes": [{"slug": "admin", "nome": "Admin", "tipo": "admin", "runner": "http://127.0.0.1:4301"}] +
               [{"slug": s, "nome": s.capitalize(), "tipo": "agente", "runner": f"http://127.0.0.1:{4311 + i}", "container": f"dgclaw-{s}"} for i, s in enumerate(slugs)]}
        self.escreve("etc/dgclaw/agentes.json", json.dumps(reg))

    def env(self):
        e = {"PATH": os.environ["PATH"], "DGCLAW_RAIZ": self.raiz, "DGCLAW_SENTINELA_TESTE": "1", "DGCLAW_SENTINELA_FALSO": self.falso_arq,
             "DGCLAW_SENTINELA_AGORA": str(self.agora)}
        if self.tg:
            e["DGCLAW_SENTINELA_TELEGRAM_API"] = self.tg.url
        if self.admin:
            e["DGCLAW_ADMIN_URL"] = self.admin.url
        e.update(self.extra_env)
        return e

    def rodar(self, *args, entrada=None, passo=60, **env):
        self.agora += passo
        e = self.env()
        e.update(env)
        return subprocess.run([sys.executable, "-I", SENTINELA, *(args or ("rodar",))], input=entrada, capture_output=True, text=True, env=e, timeout=90)

    def painel(self):
        with open(self.raiz + "/var/lib/dgclaw/web/sentinela/estado.json", encoding="utf-8") as f:
            return json.load(f)

    def interno(self):
        with open(self.raiz + "/var/lib/dgclaw/sentinela/estado.json", encoding="utf-8") as f:
            return json.load(f)

    def le(self, rel):
        try:
            with open(f"{self.raiz}/{rel}", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""

    def comandos(self):
        return [l for l in self.le("var/lib/dgclaw/sentinela/comandos-teste.log").splitlines() if l]

    def textos_tg(self):
        import urllib.parse
        return [urllib.parse.parse_qs(p["corpo"])["text"][0] for p in self.tg.pedidos if p["caminho"].endswith("/sendMessage")]

    def limpar(self):
        subprocess.run(["rm", "-rf", "--", self.tmp])


def disco(pct, total=40.0, ponto="/", inodes=5.0):
    return {"ponto": ponto, "usado_pct": pct, "total_gb": total, "inodes_pct": inodes}


def ram(pct):
    return {"usado_pct": pct, "total_mb": 8000, "disponivel_mb": int(8000 * (100 - pct) / 100), "swap_pct": 1, "processos": [["node", 900], ["chrome", 700]]}


# --- casos ---------------------------------------------------------------------------------------

def caso_1_niveis_e_histerese():
    print("1. níveis e histerese do disco e da RAM")
    c = Cenario()
    m = carrega_modulo(c.raiz)
    lim = [75, 85, 92]
    confere([m.nivel_de(p, lim) for p in (74, 75, 84.9, 85, 91.9, 92, 99)] == [0, 1, 1, 2, 2, 3, 3], "limiares 75/85/92 dão ok/aviso/sério/crítico")
    confere(m.com_histerese(83, lim, 2) == 2, "em sério (85), 83% ainda não desce (precisa ficar abaixo de 82)")
    confere(m.com_histerese(81.9, lim, 2) == 1, "abaixo de 82% desce para aviso")
    confere(m.com_histerese(70, lim, 3) == 0, "de crítico, 70% desce direto até ok (abaixo de 72)")
    confere(m.com_histerese(90, lim, 3) == 3, "em crítico (92), 90% continua crítico")
    # pela rodada completa: o disco sobe na hora
    c.falso({"disco": [disco(80)], "ram": ram(10)})
    c.rodar()
    confere(c.painel()["nivel_geral"] == "aviso", "disco em 80% é aviso na primeira rodada")
    c.falso({"disco": [disco(84)], "ram": ram(10)})
    c.rodar()
    confere(c.painel()["disco"][0]["nivel"] == "aviso", "84% ainda é aviso")
    c.falso({"disco": [disco(88)], "ram": ram(10)})
    c.rodar()
    confere(c.painel()["nivel_geral"] == "serio", "88% é sério")
    c.falso({"disco": [disco(83)], "ram": ram(10)})
    c.rodar()
    confere(c.painel()["nivel_geral"] == "serio", "83% segue sério (histerese de 3 pontos)")
    # RAM: precisa de 2 rodadas seguidas acima do limiar
    c.falso({"disco": [disco(10)], "ram": ram(90)})
    c.rodar()
    confere(c.painel()["ram"]["nivel"] == "ok", "RAM em 90% na primeira rodada ainda é ok (pico de um minuto não conta)")
    c.rodar()
    confere(c.painel()["ram"]["nivel"] == "aviso", "RAM em 90% na segunda rodada seguida vira aviso")
    c.falso({"disco": [disco(10)], "ram": ram(60)})
    c.rodar()
    confere(c.painel()["ram"]["nivel"] == "ok", "RAM cai para 60% e volta a ok")
    c.falso({"disco": [disco(10)], "ram": ram(88)})
    c.rodar()
    c.falso({"disco": [disco(10)], "ram": ram(60)})
    c.rodar()
    confere(c.painel()["ram"]["nivel"] == "ok", "um pico isolado de RAM não vira nível nenhum")
    c.limpar()


def caso_2_cadencia_e_um_aviso_por_rodada():
    print("2. cadência dos avisos: subida, repetição, resolvido, um aviso por rodada")
    tg = Gravador()
    c = Cenario(tg=tg)
    c.falso({"disco": [disco(80)], "ram": ram(10)})
    c.rodar()
    confere(len(c.textos_tg()) == 2, "subida para aviso: uma mensagem para cada chat configurado (2)")
    confere(c.textos_tg()[0].startswith("🟡 AVISO"), "o texto começa com o emoji e o nível")
    confere("Disco em 80%" in c.textos_tg()[0], "o texto diz o disco")
    c.rodar()
    c.rodar()
    confere(len(c.textos_tg()) == 2, "minutos depois, sem mudança: nada novo")
    c.rodar(passo=361 * 60)
    confere(len(c.textos_tg()) == 4 and "Continua há" in c.textos_tg()[2], "passado REPETIR_AVISO_MIN (360 min): repete dizendo 'Continua há'")
    c.falso({"disco": [disco(50)], "ram": ram(10)})
    c.rodar()
    ultimo = c.textos_tg()[-1]
    confere(len(c.textos_tg()) == 6 and ultimo.startswith("✅ RESOLVIDO") and "durou" in ultimo, "ao voltar ao ok sai um '✅ RESOLVIDO' com a duração")
    c.rodar()
    confere(len(c.textos_tg()) == 6, "depois de resolvido, silêncio")
    # disco e RAM juntos na mesma rodada: uma mensagem só (por chat)
    antes = len(c.textos_tg())
    c.falso({"disco": [disco(80)], "ram": ram(90)})
    c.rodar()
    c.rodar()
    depois = c.textos_tg()[antes:]
    confere(len(depois) == 4, "disco e memória subindo em rodadas diferentes: uma mensagem por rodada (2 rodadas x 2 chats)")
    confere(any("Memória em 90%" in t for t in depois), "a mensagem da segunda rodada traz a memória")
    c.limpar()
    tg.parar()
    # e-mail
    tg2, smtp = Gravador(), Smtp()
    c = Cenario(conf=f"EMAIL_SMTP_HOST=127.0.0.1\nEMAIL_SMTP_PORTA={smtp.porta}\nEMAIL_DE=sentinela@exemplo.com.br\nEMAIL_PARA=dono@exemplo.com.br\nEMAIL_SENHA={SENHA}", tg=tg2)
    c.falso({"disco": [disco(80)], "ram": ram(10)})
    r = c.rodar()
    confere(len(smtp.mensagens) == 1 and "Subject:" in smtp.mensagens[0] and "dono@exemplo.com.br" in smtp.mensagens[0],
            "o e-mail sai pelo SMTP local, para o dono, com assunto")
    confere(r.returncode == 0, "a rodada sai 0")
    c.limpar()
    tg2.parar()
    smtp.parar()


def caso_3_disco_extremo_com_escrita_falhando():
    print("3. disco acima do extremo e escrita falhando: reserva some, Telegram recebe, sai 0")
    tg = Gravador()
    c = Cenario(tg=tg)
    reserva = c.raiz + "/var/lib/dgclaw/reserva/balao.bin"
    os.makedirs(os.path.dirname(reserva))
    with open(reserva, "wb") as f:
        f.write(b"\0" * 4 * 1024 * 1024)
    c.falso({"disco": [disco(98)], "ram": ram(10)})
    r = c.rodar(DGCLAW_SENTINELA_FALHA_ESCRITA="1")
    confere(r.returncode == 0, f"a rodada sai 0 mesmo sem conseguir gravar (saiu {r.returncode})")
    confere(not os.path.exists(reserva), "a reserva foi apagada")
    textos = c.textos_tg()
    confere(len(textos) == 2, "o Telegram recebeu o aviso mesmo com a escrita falhando")
    confere(bool(textos) and "liberei a reserva de emergência" in textos[0] and "compra tempo, não resolve" in textos[0], "o aviso diz que liberou a reserva e que isso só compra tempo")
    confere(bool(textos) and "Não consegui gravar o estado: disco cheio" in textos[0], "o aviso diz que não conseguiu gravar o estado (disco cheio)")
    confere("não consegui gravar" in r.stderr, "o motivo vai para o stderr (journal)")
    confere(not os.path.exists(c.raiz + "/var/lib/dgclaw/web/sentinela/estado.json"), "nada foi gravado (a falha de escrita era de verdade na simulação)")
    c.limpar()
    tg.parar()


def caso_4_faxina_a_prova_de_link_simbolico():
    print("4. faxina: link simbólico, arquivo novo, não regular e outro st_dev")
    tg = Gravador()
    c = Cenario(tg=tg)
    m = carrega_modulo(c.raiz)
    fora = c.tmp + "/fora"
    os.makedirs(fora + "/dentro")
    with open(fora + "/segredo.txt", "w") as f:
        f.write("nao apague")
    casa = c.raiz + "/var/lib/dgclaw/agentes/luna/home"
    os.makedirs(casa + "/.cache")
    os.symlink(fora, casa + "/.cache/pip")
    os.makedirs(casa + "/.npm/_cacache")
    with open(casa + "/.npm/_cacache/lixo", "w") as f:
        f.write("x" * 100)
    os.makedirs(casa + "/.cache/google-chrome/Default/Cache")
    with open(casa + "/.cache/google-chrome/Default/Cache/data", "w") as f:
        f.write("y")
    # casa do vizinho inteira como link: nada dentro dela pode ser tocado
    os.makedirs(c.raiz + "/var/lib/dgclaw/agentes", exist_ok=True)
    os.makedirs(fora + "/casa-outra/home/.npm/_cacache")
    with open(fora + "/casa-outra/home/.npm/_cacache/arquivo", "w") as f:
        f.write("z")
    os.symlink(fora + "/casa-outra", c.raiz + "/var/lib/dgclaw/agentes/maria")
    item = {"base": "/var/lib/dgclaw/agentes", "casa": "home",
            "caminhos": [".cache/pip", ".npm/_cacache", ".cache/google-chrome/*/Cache", ".cache/google-chrome/*/Code Cache"]}
    m.limpar_cache_agentes(item)
    confere(os.path.exists(fora + "/segredo.txt"), "o arquivo de fora, atrás do link .cache/pip, continua lá")
    confere(os.path.islink(casa + "/.cache/pip"), "o próprio link não foi seguido nem trocado")
    confere(not os.path.exists(casa + "/.npm/_cacache"), "o cache de verdade (.npm/_cacache) foi apagado")
    confere(not os.path.exists(casa + "/.cache/google-chrome/Default/Cache"), "o curinga do navegador (*/Cache) foi apagado")
    confere(os.path.exists(fora + "/casa-outra/home/.npm/_cacache/arquivo"), "a casa que é link simbólico inteira não foi tocada")
    log = "\n".join(m._EVENTOS)
    confere("pulei luna/.cache/pip: é um link simbólico" in log, "o log diz 'pulei luna/.cache/pip: é um link simbólico'")
    # apagar-velhos
    tmpd = c.raiz + "/tmp"
    os.makedirs(tmpd + "/systemd-private-x")
    os.makedirs(tmpd + "/sub")
    velho = T0 - 10 * 86400
    for rel in ("velho.txt", "sub/velho2.txt", "systemd-private-x/velho3.txt", "outro-dev.txt"):
        with open(f"{tmpd}/{rel}", "w") as f:
            f.write("a")
        os.utime(f"{tmpd}/{rel}", (velho, velho))
    with open(tmpd + "/novo.txt", "w") as f:
        f.write("b")
    os.utime(tmpd + "/novo.txt", (T0, T0))
    os.mkfifo(tmpd + "/fifo")
    os.utime(tmpd + "/fifo", (velho, velho))
    with open(fora + "/alvo-do-link", "w") as f:
        f.write("c")
    os.utime(fora + "/alvo-do-link", (velho, velho))
    os.symlink(fora + "/alvo-do-link", tmpd + "/link")
    os.symlink(fora, tmpd + "/pasta-link")
    dev_real = m._dev

    def dev_falso(st):
        return -7 if getattr(st, "st_ino", None) == os.lstat(tmpd + "/outro-dev.txt").st_ino else dev_real(st)

    m._dev = dev_falso
    total, qtd = m.apagar_velhos(["/tmp"], ["*"], 3, ["systemd-private-*", ".X11-unix", ".ICE-unix"], agora_ts=T0)
    m._dev = dev_real
    confere(not os.path.exists(tmpd + "/velho.txt") and not os.path.exists(tmpd + "/sub/velho2.txt"), "arquivos regulares velhos foram apagados (inclusive em subpasta)")
    confere(os.path.exists(tmpd + "/novo.txt"), "arquivo novo ficou")
    confere(os.path.exists(tmpd + "/fifo"), "arquivo que não é regular (fifo) ficou")
    confere(os.path.islink(tmpd + "/link") and os.path.exists(fora + "/alvo-do-link"), "link simbólico não foi seguido nem apagado como arquivo")
    confere(os.path.exists(fora + "/segredo.txt"), "o link para pasta não foi atravessado")
    confere(os.path.exists(tmpd + "/systemd-private-x/velho3.txt"), "systemd-private-* é pulado")
    confere(os.path.exists(tmpd + "/outro-dev.txt"), "arquivo de outro sistema de arquivos (st_dev diferente) ficou")
    # catálogo inteiro pelo caminho real da rodada: comandos só registrados, nunca executados
    c.falso({})
    r = c.rodar("faxinar", "--executar", "--json")
    confere(r.returncode == 0, f"faxinar --executar sai 0 ({r.stderr.strip()[:120]})")
    try:
        itens = [i["id"] for i in json.loads(r.stdout)["itens"]]
    except (ValueError, KeyError):
        itens = []
    confere(itens == ["journal", "apt", "imagens-soltas", "tmp-velhos", "logs-girados", "cache-agentes"], "roda os 6 itens do catálogo na ordem")
    cm = c.comandos()
    confere("journalctl --vacuum-size=500M" in cm and "apt-get clean" in cm and "podman image prune -f" in cm, "journal, apt e imagens soltas pelos comandos fixos")
    confere(not any("prune" in x and ("-a" in x.split() or "container" in x or "volume" in x or "network" in x) for x in cm), "nunca prune -a, de container, volume ou rede")
    c.limpar()
    tg.parar()


def caso_5_agente_caido_e_whatsapp():
    print("5. agente caído depois de 2 rodadas, motivo pelo podman, voltou; WhatsApp parado é crítico")
    tg, adm = Gravador(), Gravador()
    c = Cenario(tg=tg, admin=adm)
    c.agentes("luna")
    c.falso({"disco": [disco(10)], "ram": ram(10), "runners": {"luna": "falha"}, "podman": {"inspect": {"luna": "exited"}}})
    c.rodar()
    confere(len(c.textos_tg()) == 0, "uma rodada de falha ainda não avisa")
    c.rodar()
    t = c.textos_tg()
    confere(len(t) == 2 and "AGENTE FORA DO AR · Luna" in t[0], "na segunda rodada seguida o agente é dado como caído")
    confere("container parado" in t[0] and "sudo dgclaw agente reiniciar luna" in t[0], "o aviso traz o motivo (podman) e o comando exato")
    confere(any("podman inspect -f {{.State.Status}} dgclaw-luna" in x for x in c.comandos()), "o motivo veio de podman inspect")
    confere(len(adm.pedidos) == 1 and "[sentinela]" in adm.pedidos[0]["corpo"] and "dgclaw sentinela levantar" in adm.pedidos[0]["corpo"], "o Admin recebe um recado de texto fixo")
    confere("tokenadmin" not in c.le("var/log/dgclaw/sentinela.log"), "o token do Admin não vai para o log")
    confere(c.painel()["agentes"][0]["estado"] == "caido" and c.painel()["nivel_geral"] == "critico", "agente caído é crítico no painel")
    c.falso({"disco": [disco(10)], "ram": ram(10), "runners": {"luna": "ok"}})
    c.rodar()
    t = c.textos_tg()
    confere(len(t) == 4 and "voltou a responder" in t[-1], "ao responder de novo sai o aviso 'voltou'")
    confere(len(adm.pedidos) == 1, "o Admin não é incomodado na volta")
    c.limpar()
    # WhatsApp: a conferência acontece a cada 5 rodadas
    c = Cenario(tg=tg)
    c.agentes("luna")
    c.falso({"disco": [disco(10)], "ram": ram(10), "podman": {"exec": {"luna": {"enabled": "enabled", "active": "inactive"}}}})
    for _ in range(4):
        c.rodar()
    antes = len(c.textos_tg())
    c.rodar()
    novos = c.textos_tg()[antes:]
    confere(len(novos) == 2 and "WhatsApp" in novos[0], "WhatsApp habilitado e parado: aviso na quinta rodada")
    confere(c.painel()["agentes"][0]["estado"] == "canal_caido" and c.painel()["nivel_geral"] == "critico", "canal caído conta como crítico")
    cm = c.comandos()
    confere("podman exec dgclaw-luna systemctl is-enabled dgclaw-whatsapp.service" in cm and "podman exec dgclaw-luna systemctl is-active dgclaw-whatsapp.service" in cm, "confere is-enabled e depois is-active")
    c.limpar()
    tg.parar()
    adm.parar()


def caso_6_pulso():
    print("6. pulso externo: GET no normal, POST /fail no crítico")
    pu = Gravador()
    c = Cenario(pulso=pu)
    c.falso({"disco": [disco(10)], "ram": ram(10)})
    c.rodar()
    confere(len(pu.pedidos) == 1 and pu.pedidos[0]["metodo"] == "GET" and pu.pedidos[0]["caminho"] == "/ping", "rodada normal: GET na URL do pulso")
    c.falso({"disco": [disco(95)], "ram": ram(10)})
    c.rodar()
    ultimo = pu.pedidos[-1]
    confere(ultimo["metodo"] == "POST" and ultimo["caminho"] == "/ping/fail" and "disco em 95%" in ultimo["corpo"], "disco crítico: POST em /fail com o resumo de uma linha")
    c.falso({"disco": [disco(10)], "ram": ram(10)})
    c.rodar()
    confere(pu.pedidos[-1]["metodo"] == "GET", "voltou ao normal: volta o GET")
    c.limpar()
    pu.parar()


def caso_7_configurar():
    print("7. configurar: edita linha a linha")
    c = Cenario()
    conf = c.raiz + "/etc/dgclaw/sentinela.conf"
    original = "# comentário da Marta\nLINHA_DA_MARTA=oi\nRESERVA_GB=0\n\nDISCO_AVISO=70\n"
    with open(conf, "w") as f:
        f.write(original)
    os.chmod(conf, 0o644)
    r = c.rodar("configurar", entrada=f"DISCO_AVISO=72\nTELEGRAM_CHATS=-100123,456\nTELEGRAM_TOKEN={TOKEN}\n")
    linhas = open(conf).read().splitlines()
    confere(r.returncode == 0, f"configurar sai 0 ({r.stderr.strip()[:150]})")
    confere(linhas[:5] == ["# comentário da Marta", "LINHA_DA_MARTA=oi", "RESERVA_GB=0", "", "DISCO_AVISO=72"], "comentário, linha alheia e ordem sobreviveram; só DISCO_AVISO mudou")
    confere(linhas[5:] == ["TELEGRAM_CHATS=-100123,456", f"TELEGRAM_TOKEN={TOKEN}"], "chaves novas entram no fim")
    confere(stat.S_IMODE(os.stat(conf).st_mode) == 0o600, "permissão 600")
    confere(TOKEN not in r.stdout + r.stderr, "a saída do configurar não ecoa o token")
    antes = open(conf).read()
    r = c.rodar("configurar", entrada="TELEGRAM_TOKEN=nao-e-token\n")
    confere(r.returncode == 1 and "TELEGRAM_TOKEN" in r.stderr and "formato" in r.stderr and "O que fazer" in r.stderr, "valor inválido é recusado com motivo e o que fazer")
    confere(open(conf).read() == antes, "valor inválido não grava nada")
    r = c.rodar("configurar", entrada="DISCO_AVISO=95\n")
    confere(r.returncode == 1 and "ordem" in r.stderr and open(conf).read() == antes, "limiar fora de ordem é recusado sem gravar")
    r = c.rodar("configurar", entrada="CHAVE_INEXISTENTE=1\n")
    confere(r.returncode == 1 and "CHAVE_INEXISTENTE" in r.stderr, "chave desconhecida é recusada")
    r = c.rodar("configurar", entrada="PULSO_URL=http://exemplo.com/x\n", DGCLAW_SENTINELA_TESTE="0")
    confere(r.returncode == 1 and "https" in r.stderr, "URL do pulso sem https é recusada")
    r = c.rodar("configurar", entrada="PULSO_URL=https://user:pass@hc-ping.com/abc\n", DGCLAW_SENTINELA_TESTE="0")
    confere(r.returncode == 1 and "pass@" not in r.stderr, "URL com usuário e senha é recusada sem repetir o valor")
    r = c.rodar("configurar", entrada="TELEGRAM_CHATS=\n")
    confere(r.returncode == 0 and "TELEGRAM_CHATS=" in open(conf).read().splitlines(), "CHAVE= vazio apaga o valor (a linha fica vazia)")
    c.limpar()


def caso_8_nenhum_segredo_vaza():
    print("8. nenhum segredo no log, no estado, no JSON nem nos erros")
    tg, pu, smtp = Gravador(status=401), Gravador(), Smtp()
    c = Cenario(conf=f"EMAIL_SMTP_HOST=127.0.0.1\nEMAIL_SMTP_PORTA={smtp.porta}\nEMAIL_DE=a@exemplo.com.br\nEMAIL_PARA=b@exemplo.com.br\nEMAIL_SENHA={SENHA}", tg=tg, pulso=pu)
    segredos = [TOKEN, SENHA, pu.url + "/ping", "/ping"]
    c.falso({"disco": [disco(95)], "ram": ram(10)})
    saidas = []
    for _ in range(3):
        r = c.rodar()
        saidas.append(r.stdout + r.stderr)
    r = c.rodar("testar-avisos", "--json")
    saidas.append(r.stdout + r.stderr)
    r2 = c.rodar("estado", "--json")
    saidas.append(r2.stdout + r2.stderr)
    saidas.append(c.rodar("estado").stdout)
    try:
        dados = json.loads(r.stdout)
    except ValueError:
        dados = {}
    confere(set(dados.get("canais", {})) == {"telegram", "email", "pulso", "admin"} and "ok" in dados, "testar-avisos --json segue o contrato {ok, canais{telegram,email,pulso,admin}}")
    confere(dados.get("canais", {}).get("telegram", {}).get("ok") is False and dados.get("canais", {}).get("telegram", {}).get("motivo"), "o Telegram que recusou (401) aparece como falha, com motivo")
    confere(dados.get("canais", {}).get("pulso", {}).get("ok") is True, "o pulso falso respondeu")
    for rel in ("var/log/dgclaw/sentinela.log", "var/lib/dgclaw/sentinela/estado.json", "var/lib/dgclaw/sentinela/historico.jsonl", "var/lib/dgclaw/web/sentinela/estado.json"):
        texto = c.le(rel)
        confere(bool(texto) or "log" in rel or "historico" in rel, f"{rel} existe")
        confere(not any(s in texto for s in segredos if s != "/ping"), f"{rel} não tem token, senha nem URL do pulso")
    confere(not any(s in "".join(saidas) for s in (TOKEN, SENHA, pu.url)), "nenhuma saída (stdout/stderr, --json) tem segredo")
    confere(c.painel()["canais"]["telegram"] is True and c.painel()["canais"]["pulso"] is True, "o painel só diz que o canal está ligado (booleano)")
    p = c.painel()
    confere("111,222" not in json.dumps(p) and "hc-ping" not in json.dumps(p), "o painel não leva chat id nem endereço do pulso")
    confere("falha ao avisar pelo canal telegram" in c.le("var/log/dgclaw/sentinela.log"), "a falha de envio fica no log, sem segredo")
    # erro: configurar com token inválido não repete o valor
    r = c.rodar("configurar", entrada="TELEGRAM_TOKEN=999999:segredo-invalido-123\n")
    confere("segredo-invalido-123" not in r.stdout + r.stderr, "erro de configurar não repete o valor do segredo")
    # comando nunca leva segredo
    confere(not any(s in "\n".join(c.comandos()) for s in (TOKEN, SENHA)), "nenhum comando externo leva segredo no argumento")
    c.limpar()
    tg.parar()
    pu.parar()
    smtp.parar()


def caso_9_alivio_de_ram():
    print("9. alívio de RAM: ronda primeiro, depois só o navegador do maior container, 1 vez a cada 30 min")
    c = Cenario()
    c.agentes("luna", "akaki")
    dados = {"disco": [disco(10)], "ram": ram(98), "servicos": {"dgclaw-ronda.service": True},
             "podman": {"stats": [{"name": "dgclaw-akaki", "mem_percent": "8.1%"}, {"name": "dgclaw-luna", "mem_percent": "41.5%"}, {"name": "outro-container", "mem_percent": "80%"}]}}
    c.falso(dados)
    for _ in range(4):
        c.rodar()
    cm = c.comandos()
    confere(cm.count("systemctl stop dgclaw-ronda.service") == 1, "primeiro, a ronda é parada (uma vez)")
    confere(not any("tela-chrome" in x for x in cm), "ainda não mexeu em navegador nenhum")
    c.rodar()
    cm = c.comandos()
    alvo = "podman exec dgclaw-luna systemctl stop dgclaw-tela-chrome.service"
    confere(cm.count(alvo) == 1, "na rodada seguinte fecha só o navegador do container que mais usa memória (luna)")
    for _ in range(3):
        c.rodar()
    confere(c.comandos().count(alvo) == 1, "não repete antes de 30 minutos")
    c.rodar(passo=31 * 60)
    confere(c.comandos().count(alvo) == 2, "passados 30 minutos pode fechar de novo")
    paradas = [x for x in c.comandos() if " stop " in x]
    permitidas = {"systemctl stop dgclaw-ronda.service", alvo}
    confere(all(x in permitidas for x in paradas), "nenhuma outra unidade é parada (nem runner, WhatsApp, painel, Web, Admin ou Caddy)")
    confere(not any(" restart" in x or "podman stop" in x or "podman rm" in x or "kill" in x for x in c.comandos()), "a sentinela nunca reinicia nem derruba agente ou serviço")
    textos = c.le("var/log/dgclaw/sentinela.log")
    confere("fechei o navegador de luna" in textos, "o log registra o que foi feito")
    c.limpar()
    # desligado por configuração
    c = Cenario(conf="ALIVIO_RAM_AUTOMATICO=0")
    c.agentes("luna")
    c.falso(dados)
    for _ in range(7):
        c.rodar()
    confere(not any(" stop " in x for x in c.comandos()), "ALIVIO_RAM_AUTOMATICO=0 não para nada")
    c.limpar()


def caso_9b_pastas_ignoram_montagem_remota():
    print("9b. levantar e maiores pastas: montagem remota (rclone, nfs) é pulada; nada é medido duas vezes")
    c = Cenario()
    for d in ("mnt", "var/log", "root/onedrive", "opt", "linkado-real"):
        os.makedirs(f"{c.raiz}/{d}", exist_ok=True)
    os.symlink(c.raiz + "/opt", c.raiz + "/atalho-opt")
    c.escreve("proc/mounts", "/dev/sda1 / ext4 rw 0 0\nrclone: /mnt fuse.rclone rw 0 0\nnfsserver:/x /root/onedrive nfs4 rw 0 0\nproc /proc proc rw 0 0\n")
    m = carrega_modulo(c.raiz)
    confere(sorted(m.montagens_remotas()) == ["/mnt", "/root/onedrive"], "/proc/mounts falso: fuse.rclone e nfs4 contam como remotos, ext4 e proc não")
    c.falso({"pastas": {c.raiz + "/var/log": 3 * 1024 ** 3, c.raiz + "/opt": 1024 ** 3}})
    r = c.rodar("levantar", "--json")
    confere(r.returncode == 0, f"levantar sai 0 ({r.stderr.strip()[:120]})")
    cm = c.comandos()
    du = [x for x in cm if " du " in f" {x} "]
    confere(du and not any(x.endswith(" " + c.raiz + "/mnt") for x in du), "nenhum du roda na montagem remota /mnt")
    confere(all(x.count(" -- ") == 1 and x.split(" -- ")[1].count("/") >= 1 and len(x.split(" -- ")[1].split()) == 1 for x in du), "um du por pasta (nunca vários caminhos nem o / inteiro)")
    confere(not any(x.endswith(" -- " + c.raiz) or x.endswith(" -- /") for x in du), "nunca roda du em / de uma vez")
    confere(any(x.endswith(" -- " + c.raiz + "/var") for x in du) and all("-x" in x.split() for x in du), "mede pasta por pasta, sempre com -x")
    confere(not any(x.endswith(" -- " + c.raiz + "/atalho-opt") for x in du), "link simbólico para pasta já medida não é medido de novo")
    try:
        puladas = json.loads(r.stdout)["puladas"]
    except (ValueError, KeyError):
        puladas = []
    confere(any("/mnt" in p and "montagem remota" in p for p in puladas), "a saída diz que pulou /mnt por ser montagem remota")
    # maiores pastas do aviso: /root é medida com a montagem remota excluída
    os.truncate(c.raiz + "/var/lib/dgclaw/sentinela/comandos-teste.log", 0)
    c.falso({"disco": [disco(88)], "ram": ram(10), "pastas": {c.raiz + "/root": 5 * 1024 ** 3}})
    c.rodar()
    du = [x for x in c.comandos() if " du " in f" {x} "]
    confere(any(x.endswith(" -- " + c.raiz + "/root") and "--exclude=/root/onedrive" in x for x in du), "ao medir /root, a montagem remota dentro dele fica de fora (--exclude)")
    confere(not any(x.endswith(" -- " + c.raiz + "/root/onedrive") for x in du), "a montagem remota não é medida sozinha")
    # pasta dentro de outra do mesmo disco: só a de fora
    alvos, puladas = m.filtra_alvos([c.raiz + "/var", c.raiz + "/var/log"], [])
    confere(alvos == [c.raiz + "/var"] and any("já está dentro" in p for p in puladas), "pasta dentro de outra pasta medida (mesmo disco) não é somada duas vezes")
    c.limpar()


def main():
    filtro = sys.argv[1] if len(sys.argv) > 1 else ""
    for nome, fn in sorted(globals().items()):
        if nome.startswith("caso_") and filtro in nome:
            fn()
    print()
    if FALHAS:
        print(f"{len(FALHAS)} verificação(ões) falharam:")
        for f in FALHAS:
            print(f"  - {f}")
        return 1
    print("Todos os casos da sentinela passaram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
