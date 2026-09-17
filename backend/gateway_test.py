"""Regression checks for transparent backend authentication and session ownership."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

from web_gateway import Gateway, bind_gateway

TOKEN = 'private-service-key-' + 'x'*40

class PrivateService(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self): self.handle_request()
    def do_POST(self): self.handle_request()
    def do_DELETE(self): self.handle_request()
    def handle_request(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.server.requests.append((self.command,self.path,self.headers.get('Authorization'),body))
        if self.server.fail_auth:
            status,data=401,{'error':'internal service credential failed'}
        elif self.path=='/sessions':
            status,data=200,{'session':'private-'+str(len(self.server.requests)), 'root_version':'test'}
        elif self.path.endswith('/execute'):
            status,data=200,{'ok':True,'output':'2','canvases':[]}
        else: status,data=200,{'files':[]}
        encoded=json.dumps(data).encode()
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(encoded)));self.end_headers();self.wfile.write(encoded)

class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native=ThreadingHTTPServer(('127.0.0.1',0),PrivateService)
        cls.native.requests=[];cls.native.fail_auth=False
        cls.web=Gateway(('127.0.0.1',0),Path(__file__).resolve().parent.parent/'frontend',f'http://127.0.0.1:{cls.native.server_port}',TOKEN)
        for server in (cls.native,cls.web):threading.Thread(target=server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        for server in (cls.web,cls.native):server.shutdown();server.server_close()
    def request(self,path='/api/root/sessions',method='POST',cookie=None,headers=None,body=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.web.server_port)
        hdr={'X-ROOT-CLI':'1',**(headers or {})}
        if cookie:hdr['Cookie']=cookie
        conn.request(method,path,body=body,headers=hdr)
        response=conn.getresponse();data=response.read();status=response.status;out=dict(response.getheaders());conn.close()
        return status,data,out
    def create(self):
        status,data,headers=self.request()
        self.assertEqual(status,200,data)
        self.assertNotIn(TOKEN.encode(),data)
        self.assertNotIn(b'private-',data)
        self.assertIn('HttpOnly',headers['Set-Cookie'])
        self.assertIn('SameSite=Strict',headers['Set-Cookie'])
        return json.loads(data)['session'],headers['Set-Cookie'].split(';',1)[0]
    def test_browser_needs_no_service_key(self):
        sid,cookie=self.create()
        status,data,_=self.request('/api/root/sessions/'+sid+'/execute',cookie=cookie,headers={'Content-Type':'application/json'},body=b'{"code":"1+1"}')
        self.assertEqual(status,200,data)
        self.assertTrue(json.loads(data)['ok'])
        method,path,auth,body=self.native.requests[-1]
        self.assertEqual(auth,'Bearer '+TOKEN)
        self.assertIn('/sessions/private-',path)
        self.assertEqual(body,b'{"code":"1+1"}')
    def test_other_browser_cannot_use_session(self):
        sid,owner=self.create();_,other=self.create()
        for cookie in (None,other):
            status,data,_=self.request('/api/root/sessions/'+sid+'/files','GET',cookie=cookie)
            self.assertEqual(status,410)
            self.assertTrue(json.loads(data)['session_lost'])
        self.assertEqual(self.request('/api/root/sessions/'+sid+'/files','GET',cookie=owner)[0],200)
    def test_reject_cross_origin_and_simple_requests(self):
        for headers in ({'Origin':'https://another.example'},{'X-ROOT-CLI':''},{'Host':'rebind.example'},{'Sec-Fetch-Site':'cross-site'}):
            status,data,response_headers=self.request(headers=headers)
            self.assertEqual(status,403)
            self.assertNotIn('Access-Control-Allow-Origin',response_headers)
    def test_backend_auth_failure_is_not_user_setup(self):
        self.native.fail_auth=True
        try:
            status,data,_=self.request()
            self.assertEqual(status,503)
            self.assertIn(b'temporarily unavailable',data)
            self.assertNotIn(b'credential',data)
        finally:self.native.fail_auth=False
    def test_session_close_removes_ownership(self):
        sid,cookie=self.create();path='/api/root/sessions/'+sid
        self.assertEqual(self.request(path,'DELETE',cookie=cookie)[0],200)
        self.assertEqual(self.request(path+'/execute',cookie=cookie)[0],410)
    def test_website_has_no_connection_setup(self):
        status,data,_=self.request('/cli.html','GET')
        self.assertEqual(status,200)
        self.assertNotIn(b'cli-token',data)
        self.assertNotIn(b'connection-dialog',data)

    def test_busy_default_port_uses_available_port(self):
        server = bind_gateway(self.web.server_address, self.web.site,
                              'http://127.0.0.1:8001', TOKEN, allow_fallback=True)
        try:
            self.assertNotEqual(server.server_port, self.web.server_port)
            self.assertIn(f'http://127.0.0.1:{server.server_port}', server.origins)
        finally:
            server.server_close()

    def test_explicit_port_does_not_silently_change(self):
        with self.assertRaises(OSError):
            bind_gateway(self.web.server_address, self.web.site,
                         'http://127.0.0.1:8001', TOKEN)

if __name__=='__main__':unittest.main()
