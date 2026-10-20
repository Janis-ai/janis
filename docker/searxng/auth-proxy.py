#!/usr/bin/env python3
# Token-checking reverse proxy in front of SearXNG — Cloud Run IAM invoker
# isn't enforced on this project, so auth happens at the container edge.
# Public port ($PORT, default 8080) requires `Authorization: Bearer
# $SEARCH_TOKEN`; upstream SearXNG binds localhost:8081 only.
import http.server
import os
import urllib.request

TOKEN = os.environ.get('SEARCH_TOKEN', '')
UPSTREAM = 'http://127.0.0.1:8081'
PORT = int(os.environ.get('PORT', '8080'))
HOP = {'host', 'content-length', 'authorization', 'connection', 'keep-alive'}

if not TOKEN:
    print('SEARCH_TOKEN unset — proxy will 403 everything', flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, body):
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        if not TOKEN or self.headers.get('authorization') != f'Bearer {TOKEN}':
            self._send(403, b'{"error":"forbidden"}')
            return
        length = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in HOP:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() not in HOP | {'transfer-encoding'}:
                        self.send_header(k, v)
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self._send(502, b'{"error":"upstream unavailable"}')

    do_GET = do_POST = do_PUT = do_HEAD = _handle

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
