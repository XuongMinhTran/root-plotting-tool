"""Serve the website and broker native ROOT sessions without browser service keys.

The private ROOT Bearer credential stays in this process. Browser ownership uses
an automatically issued HttpOnly cookie; every native session is owner-checked.
Run with ../root-cli locally, or behind a same-origin HTTPS reverse proxy.
"""
import errno
import http.client
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
import webbrowser
from urllib.parse import urlsplit

PREFIX = '/api/root'
MAX_BODY = 20 * 1024 * 1024
MAX_RESPONSE = 25 * 1024 * 1024
COOKIE = 'rootcli_browser'

class Gateway(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, site, native_url, token, site_origin=None):
        super().__init__(address, Handler)
        self.site = str(site)
        self.native_url = urlsplit(native_url)
        self.token = token
        port = self.server_address[1]
        self.origins = {site_origin.rstrip('/')} if site_origin else {f'http://127.0.0.1:{port}', f'http://localhost:{port}'}
        self.hosts = {urlsplit(origin).netloc for origin in self.origins}
        self.secure_cookie = bool(site_origin and site_origin.startswith('https://'))
        self.owners = {}  # public id -> (browser cookie, private ROOT id, last use)
        self.lock = threading.Lock()

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=args[2].site, **kwargs)

    def do_GET(self):
        if self.path.startswith(PREFIX): self.proxy()
        else: super().do_GET()
    def do_POST(self): self.proxy()
    def do_DELETE(self): self.proxy()
    def do_OPTIONS(self): self.error(403, 'Open the CLI from this website to start a session.')

    def error(self, status, message, **extra):
        self.send_bytes(status, json.dumps({'error': message, **extra}).encode(), 'application/json')

    def send_bytes(self, status, data, content_type, headers=None, cookie=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            flags = '; Secure' if self.server.secure_cookie else ''
            self.send_header('Set-Cookie', f'{COOKIE}={cookie}; HttpOnly; SameSite=Strict; Path={PREFIX}; Max-Age=86400{flags}')
        for name, value in (headers or {}).items():
            if value: self.send_header(name, value)
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def proxy(self):
        # A custom header prevents cross-site forms; cross-origin preflights are
        # rejected. Host validation also blocks DNS rebinding to a local service.
        if (self.headers.get('Host') not in self.server.hosts
                or self.headers.get('X-ROOT-CLI') != '1'
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                or (self.headers.get('Origin') and self.headers['Origin'] not in self.server.origins)):
            return self.error(403, 'Open the CLI from this website to start a session.')
        path = urlsplit(self.path).path
        if not path.startswith(PREFIX + '/'):
            return self.error(404, 'This operation is not available.')
        path = path[len(PREFIX):]
        create = path == '/sessions' and self.command == 'POST'
        health = path == '/health' and self.command == 'GET'
        match = re.fullmatch(r'/sessions/([A-Za-z0-9_-]+)(/(?:execute|files)(?:/[^/]+)?)?', path)
        if not (create or health or match):
            return self.error(404, 'This operation is not available.')
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            owner = cookie[COOKIE].value if COOKIE in cookie else ''
        except Exception:
            owner = ''
        issue_cookie = False
        if create and not re.fullmatch(r'[a-f0-9]{64}', owner):
            owner = secrets.token_hex(32)
            issue_cookie = True
        public_id = None
        if match:
            public_id = match[1]
            with self.server.lock:
                saved = self.server.owners.get(public_id)
                if not saved or not secrets.compare_digest(owner, saved[0]):
                    return self.error(410, 'This ROOT session is no longer available in this browser. Start a new session; your saved commands and canvases remain here.', session_lost=True)
                self.server.owners[public_id] = (*saved[:2], time.monotonic())
            path = '/sessions/' + saved[1] + (match[2] or '')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.error(400, 'This request could not be read. Please try again.')
        if length < 0 or length > MAX_BODY:
            return self.error(413, 'Use a file smaller than 20 MB.')
        body = self.rfile.read(length) if length else None
        native = self.server.native_url
        transport = http.client.HTTPSConnection if native.scheme == 'https' else http.client.HTTPConnection
        connection = transport(native.hostname, native.port, timeout=55)
        try:
            headers = {'Authorization': 'Bearer ' + self.server.token}
            if self.headers.get('Content-Type'): headers['Content-Type'] = self.headers['Content-Type']
            connection.request(self.command, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                return self.error(502, 'This result is too large to transfer. Use a smaller canvas or file.')
            if response.status in (401, 403, 503):
                return self.error(503, 'The backend is temporarily unavailable. Please try again shortly.')
            if create and response.status == 200:
                result = json.loads(data)
                public_id = secrets.token_urlsafe(24)
                with self.server.lock:
                    cutoff = time.monotonic() - 86400
                    self.server.owners = {k:v for k,v in self.server.owners.items() if v[2] >= cutoff}
                    self.server.owners[public_id] = (owner, result['session'], time.monotonic())
                result['session'] = public_id
                data = json.dumps(result).encode()
            if public_id and (response.status == 410 or (self.command == 'DELETE' and response.status == 200)):
                with self.server.lock: self.server.owners.pop(public_id, None)
            self.send_bytes(response.status, data, response.getheader('Content-Type') or 'application/json',
                            {'Content-Disposition': response.getheader('Content-Disposition')}, owner if issue_cookie else None)
        except (OSError, http.client.HTTPException, ValueError, KeyError):
            self.error(503, 'The backend is temporarily unavailable. Your input is still here; please try again shortly.')
        finally:
            connection.close()

def bind_gateway(address, site, native_url, token, site_origin=None, allow_fallback=False):
    try:
        return Gateway(address, site, native_url, token, site_origin)
    except OSError as exc:
        if not allow_fallback or exc.errno != errno.EADDRINUSE:
            raise
        return Gateway((address[0], 0), site, native_url, token, site_origin)


if __name__ == '__main__':
    token = os.environ.get('ROOT_CLI_TOKEN', '')
    if len(token) < 32:
        raise SystemExit('Operator setup: ROOT_CLI_TOKEN is required. Start with ./root-cli.')
    port = int(os.environ.get('ROOT_WEB_PORT', '8080'))
    site = Path(__file__).resolve().parent.parent / 'frontend'
    try:
        server = bind_gateway((os.environ.get('ROOT_WEB_BIND', '127.0.0.1'), port), site,
                     os.environ.get('ROOT_NATIVE_URL', 'http://127.0.0.1:8001'), token,
                     os.environ.get('ROOT_SITE_ORIGIN'),
                     allow_fallback='ROOT_WEB_PORT' not in os.environ and not os.environ.get('ROOT_SITE_ORIGIN'))
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            raise SystemExit(f'Website port {port} is already in use. Choose another with ROOT_WEB_PORT=8081 ./root-cli.')
        raise
    url = f'http://127.0.0.1:{server.server_port}/cli.html'
    print(f'Open {url}', flush=True)
    if os.environ.get('ROOT_WEB_OPEN') == '1':
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
