"""Browser regression with simulated Immich and temporary taxonomy; no production writes."""
import os, json, socket, subprocess, tempfile, time, urllib.request, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright
ROOT = Path(os.environ['SPLIT_ROOT'])
ID = '11111111-1111-4111-8111-111111111111'
class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/api/api-keys/me': body = {'name': 'Browser test'}
        elif self.path.startswith('/api/people?'): body = {'people': [{'id': ID, 'name': 'Test Person', 'birthDate': '1980-01-01'}], 'hasNextPage': False}
        elif self.path == '/api/people/' + ID: body = {'id': ID, 'name': 'Test Person', 'birthDate': '1980-01-01'}
        elif self.path.endswith('/statistics'): body = {'assets': 0}
        else: body = {}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(body).encode())
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', '0')))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'assets': {'items': [], 'total': 0, 'nextPage': None}}).encode())
def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]
mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
ports = {app: free_port() for app in ('person', 'tag')}; processes = []; report = {}
with tempfile.TemporaryDirectory() as tmp:
    try:
        for app, port in ports.items():
            env = {k: v for k, v in os.environ.items() if not k.startswith(('IMMICH_', 'TAG_', 'DB_'))}
            env.update(PORT=str(port), TAG_TAXONOMY_PATH=str(Path(tmp) / 'tags.json'))
            if app == 'person': env.update(IMMICH_URL=f'http://127.0.0.1:{mock.server_port}', IMMICH_API_KEY='test-key')
            processes.append(subprocess.Popen(['node', 'server.mjs'], cwd=ROOT / app, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for port in ports.values():
            for attempt in range(100):
                try: urllib.request.urlopen(f'http://127.0.0.1:{port}'); break
                except Exception:
                    if attempt == 99: raise
                    time.sleep(.05)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
            base = f'http://127.0.0.1:{ports["tag"]}'
            page.goto(base); page.locator('[data-tag-id="dog"] button').wait_for()
            assert page.locator('[data-tag-id]').count() == 350
            assert page.locator('#tagSaveBtn').is_enabled()
            page.locator('[data-tag-id="dog"] button').click()
            page.locator('#tagThresholdInput').fill('0.555'); page.locator('#tagApplyBtn').click(); page.locator('#tagSaveBtn').click()
            page.wait_for_function("document.querySelector('#tagSaveBtn').disabled")
            page.locator('[data-folder="KI"] > button').click()
            page.once('dialog', lambda dialog: dialog.accept('QA Test')); page.locator('#tagAddFolderBtn').click()
            page.once('dialog', lambda dialog: dialog.accept('QA Tag')); page.locator('#tagAddBtn').click()
            assert page.locator('[data-tag-id]').count() == 351
            page.locator('#tagCopyBtn').click(); assert page.locator('[data-tag-id]').count() == 352
            page.once('dialog', lambda dialog: dialog.accept()); page.locator('#tagDeleteBtn').click()
            page.locator('[data-folder="KI/QA Test"] > button').click(); page.locator('#folderCopyBtn').click()
            assert page.locator('[data-tag-id]').count() == 352
            page.once('dialog', lambda dialog: dialog.accept()); page.locator('#folderDeleteBtn').click()
            page.locator('#tagSearch').fill('QA')
            page.locator('[data-tag-id="qa_tag"]').drag_to(page.locator('[data-folder="KI"]'))
            page.locator('[data-tag-id="qa_tag"] button').click()
            assert page.locator('#tagPathInput').input_value() == 'KI/QA Tag'
            page.once('dialog', lambda dialog: dialog.accept()); page.locator('#tagDeleteBtn').click()
            page.locator('[data-folder="KI/QA Test"] > button').click()
            page.once('dialog', lambda dialog: dialog.accept()); page.locator('#folderDeleteBtn').click()
            page.locator('#tagSaveBtn').click(); page.wait_for_function("document.querySelector('#tagSaveBtn').disabled")
            saved = json.load(urllib.request.urlopen(base + '/tag-api/tags'))['document']
            assert len(saved['concepts']) == 350
            assert next(c for c in saved['concepts'] if c['id'] == 'dog')['threshold'] == .555
            assert (Path(tmp) / 'tags.json.bak').exists()
            page.reload(); page.locator('[data-tag-id="dog"] button').click()
            assert page.locator('#tagThresholdInput').input_value() == '0.555'
            page.locator('#tagSearch').fill('dog'); assert page.locator('[data-tag-id]').count() < 350
            page.screenshot(path=str(ROOT / 'tag-browser.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            page.screenshot(path=str(ROOT / 'tag-mobile.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert not errors, errors
            report['tag'] = {'initial_concepts': 350, 'final_concepts': 350, 'tested': ['legacy repair warning', 'threshold edit', 'save and backup', 'category create/copy/delete', 'tag create/copy/delete', 'drag and drop', 'search', 'reload persistence', 'mobile overflow'], 'page_errors': errors[:]}
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.goto(f'http://127.0.0.1:{ports["person"]}'); page.locator('[data-person]').first.wait_for()
            assert page.locator('#tagsTab').count() == 0
            page.locator('#unnamedTab').click(); page.locator('#reviewTab').click(); page.locator('[data-person]').first.click()
            page.locator('#selectedPersonName').wait_for(); assert page.locator('#selectedPersonName').inner_text() == 'Test Person'
            page.locator('#clusterViewBtn').click(); page.locator('#clusterError:not(.hidden)').wait_for()
            page.locator('#timelineViewBtn').click(); page.locator('#backBtn').click(); assert page.locator('#chooser').is_visible()
            assert not errors, errors
            report['person'] = {'tested': ['chooser', 'unnamed tab', 'timeline', 'cluster unavailable notice', 'back navigation', 'no tags tab'], 'page_errors': errors[:]}
            page.screenshot(path=str(ROOT / 'person-browser.png'), full_page=True)
            browser.close()
    finally:
        for process in processes:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill()
        mock.shutdown()
(ROOT / 'browser-report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
