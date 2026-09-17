"""Run inside the ROOT image: python3 -m unittest native_test.py."""
import io
import os
import unittest
from unittest.mock import patch
os.environ['ROOT_CLI_TOKEN'] = 'test-key-' + 'x'*40
import native_app as service

class NativeTests(unittest.TestCase):
    def setUp(self):
        self.client=service.app.test_client()
        self.headers={'Authorization':'Bearer '+service.TOKEN}
        self.ids=[]
    def tearDown(self):
        for sid in self.ids: service.remove_session(sid)
    def session(self):
        r=self.client.post('/sessions',headers=self.headers)
        self.assertEqual(r.status_code,200,r.json)
        self.ids.append(r.json['session']);return r.json['session']
    def run_code(self,sid,code):
        return self.client.post('/sessions/'+sid+'/execute',headers=self.headers,json={'code':code})
    def test_requires_key(self):
        self.assertEqual(self.client.post('/sessions').status_code,401)
        self.assertEqual(self.client.get('/health',headers=self.headers).json['service'],'root-native-cli')
    def test_persistent_native_cpp_and_session_isolation(self):
        a,b=self.session(),self.session()
        r=self.run_code(a,'double measurement = 2.5;\nstd::cout << measurement * 2 << std::endl;')
        self.assertTrue(r.json['ok'],r.json)
        self.assertIn('5',r.json['output'])
        r=self.run_code(a,'std::cout << measurement + 1 << std::endl;')
        self.assertIn('3.5',r.json['output'])
        self.assertFalse(self.run_code(b,'std::cout << measurement << std::endl;').json['ok'])
        self.assertTrue(self.run_code(b,'std::cout << 7 << std::endl;').json['ok'])
    def test_3d_and_multiple_canvases(self):
        sid=self.session()
        r=self.run_code(sid,'auto c = new TCanvas("surface_canvas", "3D", 900, 650);\nauto f = new TF2("surface", "sin(x)*cos(y)", -3, 3, -3, 3);\nf->Draw("surf1");')
        self.assertTrue(r.json['ok'],r.json)
        self.assertEqual(r.json['canvases'][0]['json']['_typename'],'TCanvas')
        r=self.run_code(sid,'auto c2 = new TCanvas("hist", "Histogram", 900, 600);\nauto h = new TH1D("h", "Sample", 20, -3, 3); h->FillRandom("gaus", 500); h->Draw();')
        self.assertTrue(r.json['ok'],r.json)
        self.assertEqual({c['name'] for c in r.json['canvases']},{'hist','surface_canvas'})
    def test_files_and_macro(self):
        sid=self.session();path='/sessions/'+sid+'/files'
        r=self.client.post(path,headers=self.headers,data={'file':(io.BytesIO(b'void example() { std::cout << "macro works" << std::endl; }'),'example.C')})
        self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(r.json['files'][0]['name'],'example.C')
        self.assertIn('macro works',self.run_code(sid,'.x example.C').json['output'])
        with self.client.get(path+'/example.C',headers=self.headers) as download:
            self.assertIn(b'macro works',download.data)
        r=self.client.post(path,headers=self.headers,data={'file':(io.BytesIO(b'x'),'../escape.C')})
        self.assertEqual(r.status_code,400)
        self.run_code(sid,'std::ofstream out("result.txt"); out << 42; out.close();')
        with self.client.get(path+'/result.txt',headers=self.headers) as download:
            self.assertEqual(download.data,b'42')
    def test_native_callable_is_sampled_for_browser(self):
        sid=self.session()
        r=self.run_code(sid,'auto custom = new TF1("custom", [](double *x, double *) { return x[0]*x[0]; }, -2, 2, 0); custom->Draw();')
        self.assertTrue(r.json['ok'],r.json)
        primitives=r.json['canvases'][0]['json']['fPrimitives']['arr']
        function=next(p for p in primitives if p.get('_typename')=='TF1')
        self.assertTrue(function['fSave'])
    def test_stop_and_timeout_do_not_affect_other_sessions(self):
        a,b=self.session(),self.session()
        self.client.delete('/sessions/'+a,headers=self.headers)
        self.assertEqual(self.run_code(a,'1+1').status_code,410)
        with patch.object(service,'TIMEOUT',.1):
            r=self.run_code(b,'while (true) {}')
        self.assertEqual(r.status_code,408,r.json)
        self.assertTrue(r.json['session_lost'])
        self.assertEqual(self.run_code(b,'1+1').status_code,410)

if __name__=='__main__':unittest.main()
