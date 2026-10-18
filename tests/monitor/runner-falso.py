#!/usr/bin/env python3
"""Runner falso para os testes do dgclaw-monitor.

Le o roteiro de $CTRL (JSON, relido a cada requisicao, entao o teste muda o mundo entre rodadas):
  {"sessoes": [...], "resume": "ok"|"falha", "input": "ok"|"falha", "conversa": {"<id>": [{"role","text"}]}}
Grava cada requisicao em $LOG (uma linha JSON: metodo, url, corpo, auth). A porta escolhida vai para $PORTA_ARQ.
"""
import http.server
import json
import os
import re

CTRL, LOG, PORTA_ARQ = os.environ["CTRL"], os.environ["LOG"], os.environ["PORTA_ARQ"]
TOKEN = os.environ["RUNNER_BEARER"]


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _resp(self, codigo, obj):
        b = json.dumps(obj).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _tratar(self, metodo):
        n = int(self.headers.get("Content-Length") or 0)
        corpo = self.rfile.read(n).decode() if n else ""
        auth = self.headers.get("Authorization")
        with open(LOG, "a") as f:
            f.write(json.dumps({"metodo": metodo, "url": self.path, "corpo": corpo, "auth": auth}) + "\n")
        if auth != "Bearer " + TOKEN:
            return self._resp(401, {"success": False, "error": "token errado", "code": "TOKEN_ERRADO"})
        with open(CTRL) as f:
            c = json.load(f)
        caminho = self.path.split("?")[0]
        if metodo == "GET" and caminho == "/api/agents":
            return self._resp(200, {"success": True, "data": c["sessoes"]})
        if metodo == "POST" and caminho == "/api/sessoes":
            return self._resp(201, {"success": True, "data": {"id": c.get("novo_id", "card-novo")}})
        m = re.fullmatch(r"/api/agents/([^/]+)/conversation", caminho)
        if metodo == "GET" and m:
            return self._resp(200, {"success": True, "data": c.get("conversa", {}).get(m.group(1), [])})
        m = re.fullmatch(r"/api/agents/([^/]+)/resume", caminho)
        if metodo == "POST" and m:
            if c.get("resume") == "falha":
                return self._resp(503, {"success": False, "error": "sem capacidade para acordar", "code": "SEM_CAPACIDADE"})
            return self._resp(200, {"success": True, "data": {}})
        m = re.fullmatch(r"/api/agents/([^/]+)/input", caminho)
        if metodo == "POST" and m:
            if c.get("input") == "falha":
                return self._resp(409, {"success": False, "error": "sem login", "code": "SEM_LOGIN"})
            return self._resp(202, {"success": True, "data": {"enfileirado": True}})
        return self._resp(404, {"success": False, "error": "rota nao existe no falso", "code": "ROTA_INEXISTENTE"})

    def do_GET(self):
        self._tratar("GET")

    def do_POST(self):
        self._tratar("POST")


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(PORTA_ARQ, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
