#!/usr/bin/env python3
"""Static server for the Season 2 mockups.

Plain `python3 -m http.server` omits the charset parameter on Content-Type,
so Chromium decodes the shared JS files as windows-1252 and garbles the
German strings in TMS_DATA. This handler pins charset=utf-8 for all text
types. Run:  python3 mockups/season2/serve.py   (serves on 0.0.0.0:4321)
"""
import http.server
import os

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml; charset=utf-8',
    }

    def log_message(self, fmt, *args):
        pass  # keep nohup log quiet; errors still surface via stderr

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    http.server.ThreadingHTTPServer(('0.0.0.0', 4321), Handler).serve_forever()
