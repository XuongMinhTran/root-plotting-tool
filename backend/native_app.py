"""Local, authenticated native ROOT service. Launch with ../root-cli, never app.py.

Native C++ has the permissions of the dedicated container. Each tab gets a
persistent worker process; no form state or ROOT globals are shared with /fit.
"""
import atexit
import hmac
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
TOKEN = os.environ.get('ROOT_CLI_TOKEN', '')
TIMEOUT = 45
MAX_SESSIONS = 4
IDLE_SECONDS = 3600
sessions = {}
registry_lock = threading.Lock()

class Session:
    def __init__(self):
        self.directory = tempfile.mkdtemp(prefix='root-cli-')
        env = {k: v for k, v in os.environ.items() if k != 'ROOT_CLI_TOKEN'}
        self.process = subprocess.Popen([sys.executable, '-u', str(Path(__file__).with_name('native_worker.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=self.directory, env=env, start_new_session=True)
        self.lock = threading.Lock()
        self.updated = time.monotonic()
        self.pending = b''
    def receive(self, timeout):
        deadline = time.monotonic() + timeout
        # Pipes are read incrementally: even an incomplete protocol line cannot bypass the deadline.
        while b'\n' not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], max(0, remaining))[0]:
                raise TimeoutError()
            part = os.read(self.process.stdout.fileno(), 65536)
            if not part:
                raise RuntimeError('The ROOT interpreter stopped. Start a new session; your commands and saved canvases are still in the page.')
            self.pending += part
            if len(self.pending) > 24 * 1024 * 1024:
                raise RuntimeError('The canvas response is too large to display. Start a new session and use fewer points or smaller histograms.')
        line, self.pending = self.pending.split(b'\n', 1)
        return json.loads(line)
    def close(self):
        try: os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: self.process.wait(timeout=3)
        except subprocess.TimeoutExpired: pass
        for pipe in (self.process.stdin, self.process.stdout):
            if pipe: pipe.close()
        shutil.rmtree(self.directory, ignore_errors=True)

@app.before_request
def authenticate():
    if request.method == 'OPTIONS': return '', 204
    if not TOKEN or len(TOKEN) < 32:
        return jsonify(error='Native service authentication is not configured.'), 503
    supplied = request.headers.get('Authorization', '').removeprefix('Bearer ')
    if not hmac.compare_digest(supplied, TOKEN):
        return jsonify(error='Native service authentication failed.'), 401

@app.after_request
def cors(response):
    # An unguessable Bearer key, not ambient cookies, authorizes every request.
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Cache-Control'] = 'no-store'
    return response

@app.errorhandler(413)
def too_large(_):
    return jsonify(error='This upload is too large. Use a file smaller than 20 MB.'), 413

@app.get('/health')
def health():
    return jsonify(status='ok', service='root-native-cli')

@app.post('/sessions')
def create_session():
    with registry_lock:
        if len(sessions) >= MAX_SESSIONS:
            return jsonify(error='Four ROOT sessions are already open. End one session or wait for an idle session to expire.'), 429
        session = Session()
        sid = secrets.token_urlsafe(24)
        sessions[sid] = session
    try:
        with session.lock:
            ready = session.receive(TIMEOUT)
        return jsonify(session=sid, root_version=ready['root_version'])
    except Exception:
        remove_session(sid)
        return jsonify(error='ROOT could not start. Your input is still here; try connecting again.'), 503

def remove_session(sid):
    with registry_lock:
        session = sessions.pop(sid, None)
    if session: session.close()

@app.delete('/sessions/<sid>')
def end_session(sid):
    remove_session(sid)
    return jsonify(status='closed')

@app.post('/sessions/<sid>/execute')
def execute(sid):
    with registry_lock:
        session = sessions.get(sid)
    if not session:
        return jsonify(error='This ROOT session has ended or expired. Start a new session; commands are never replayed automatically.', session_lost=True), 410
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get('code'), str) or not payload['code'].strip():
        return jsonify(error='Enter a ROOT/C++ command first.'), 400
    if len(payload['code'].encode()) > 1024 * 1024:
        return jsonify(error='Submit less than 1 MB of code at a time, or upload a macro file.'), 413
    if not session.lock.acquire(blocking=False):
        return jsonify(error='This session is still running a command. Wait for it to finish, or stop the session.'), 409
    try:
        session.updated = time.monotonic()
        session.process.stdin.write((json.dumps({'code': payload['code']}) + '\n').encode())
        session.process.stdin.flush()
        result = session.receive(TIMEOUT)
        session.updated = time.monotonic()
        return jsonify(result)
    except TimeoutError:
        remove_session(sid)
        return jsonify(error=f'This command exceeded {TIMEOUT} seconds, so the interpreter was stopped. Your commands and previous canvases are still here. Start a new session to continue.', session_lost=True), 408
    except Exception:
        remove_session(sid)
        return jsonify(error='The ROOT interpreter stopped while running this command. Your commands and previous canvases are still here. Start a new session to continue.', session_lost=True), 500
    finally:
        session.lock.release()

@app.route('/sessions/<sid>/files', methods=['GET', 'POST'])
def files(sid):
    with registry_lock:
        session = sessions.get(sid)
    if not session:
        return jsonify(error='Start a session before working with files.', session_lost=True), 410
    if not session.lock.acquire(blocking=False):
        return jsonify(error='Wait for the current command to finish before working with files.'), 409
    try:
        session.updated = time.monotonic()
        directory = Path(session.directory)
        if request.method == 'POST':
            upload = request.files.get('file')
            name = upload.filename if upload else ''
            if not name or name in ('.', '..') or '/' in name or '\\' in name or len(name) > 200:
                return jsonify(error='Use a file name without directory separators.'), 400
            target = directory / name
            if target.exists() or target.is_symlink():
                return jsonify(error='A file with this name already exists. Rename your upload to keep both files.'), 409
            upload.save(target)
        return jsonify(files=[{'name': p.name, 'size': p.stat().st_size} for p in sorted(directory.iterdir()) if p.is_file() and not p.is_symlink()])
    finally:
        session.lock.release()

@app.get('/sessions/<sid>/files/<name>')
def download_file(sid, name):
    with registry_lock:
        session = sessions.get(sid)
    if not session:
        return jsonify(error='This session has ended. Its temporary files are no longer available.', session_lost=True), 410
    target = Path(session.directory) / name
    if name in ('.', '..') or '/' in name or '\\' in name or target.is_symlink() or not target.is_file():
        return jsonify(error='This file is not available in the session working directory.'), 404
    session.updated = time.monotonic()
    return send_file(target, as_attachment=True, download_name=name)

def cleanup():
    while True:
        time.sleep(60)
        with registry_lock:
            expired = [sid for sid,s in sessions.items() if not s.lock.locked() and time.monotonic()-s.updated > IDLE_SECONDS]
        for sid in expired: remove_session(sid)

@atexit.register
def shutdown():
    for sid in list(sessions): remove_session(sid)

if __name__ == '__main__':
    if not TOKEN or len(TOKEN) < 32:
        raise SystemExit('Use ./root-cli to start this service with an access key.')
    threading.Thread(target=cleanup, daemon=True).start()
    app.run(host='0.0.0.0', port=8001, debug=False)
