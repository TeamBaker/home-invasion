#!/usr/bin/env python3
"""Static server for HOME INVASION + scan upload.

GET/HEAD behave exactly like `python3 -m http.server` (serves the current directory).
POST /upload: JSON body (<= MAX_BYTES) is written to scans/scan-<UTC timestamp>.json.

Usage: python3 server.py [port]   (default 8091)
"""
import json
import os
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 64 * 1024 * 1024
SCAN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scans')


class Handler(SimpleHTTPRequestHandler):
    def _reply(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split('?', 1)[0] != '/upload':
            return self._reply(404, {'ok': False, 'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            return self._reply(411, {'ok': False, 'error': 'Content-Length required'})
        if length < 0:
            return self._reply(400, {'ok': False, 'error': 'bad Content-Length'})
        if length > MAX_BYTES:
            self.close_connection = True
            return self._reply(413, {'ok': False, 'error': 'body too large (max %d bytes)' % MAX_BYTES})
        raw = self.rfile.read(length)
        try:
            json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as e:
            return self._reply(400, {'ok': False, 'error': 'malformed JSON: %s' % e})
        os.makedirs(SCAN_DIR, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        name = 'scan-%s.json' % stamp
        with open(os.path.join(SCAN_DIR, name), 'wb') as f:
            f.write(raw)
        self._reply(200, {'ok': True, 'file': name, 'bytes': len(raw)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    httpd = ThreadingHTTPServer(('', port), Handler)
    print('Serving HTTP on port %d (POST /upload -> %s) ...' % (port, SCAN_DIR))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nKeyboard interrupt received, exiting.')


if __name__ == '__main__':
    main()
