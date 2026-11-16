#!/usr/bin/env python3
"""API da Anthropic de mentira para o teste de acesso efetivo: na primeira chamada pede ao Claude Code que leia o arquivo
ALVO (ferramenta Read) e, depois do resultado, termina. Uso: fake-anthropic.py <porta> <alvo> <log>."""
import json, sys, http.server, threading
ALVO = sys.argv[2]; LOG = sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); body = json.loads(self.rfile.read(n) or b'{}')
        with open(LOG, 'a') as f: f.write(json.dumps(body)[:200000] + '\n')
        msgs = body.get('messages', [])
        last = msgs[-1] if msgs else {}
        tem_resultado = isinstance(last.get('content'), list) and any(c.get('type') == 'tool_result' for c in last['content'])
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
        def ev(t, d): self.wfile.write(f'event: {t}\ndata: {json.dumps(d)}\n\n'.encode())
        ev('message_start', {'type': 'message_start', 'message': {'id': 'm1', 'type': 'message', 'role': 'assistant', 'model': body.get('model', 'x'), 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 1, 'output_tokens': 1}}})
        if not tem_resultado and body.get('tools'):
            ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'tu1', 'name': 'Read', 'input': {}}})
            ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'file_path': ALVO})}})
            ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
            ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 1}})
        else:
            ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'ok'}})
            ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
            ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}})
        ev('message_stop', {'type': 'message_stop'}); self.wfile.flush()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
