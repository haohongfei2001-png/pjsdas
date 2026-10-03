import contextlib, hashlib, http.client, importlib.util, io, json, os, re, tempfile, threading, unittest
from pathlib import Path
from urllib.parse import urlencode,urlsplit
spec=importlib.util.spec_from_file_location('handoff',Path(__file__).with_name('prepare-access.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class HandoffTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.workspace=Path(self.tmp.name);(self.workspace/'work').mkdir();self.server,self.url,self.token=m.make_server(self.workspace);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.route=urlsplit(self.url).path
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
 def request(self,method='GET',path=None,fields=None,headers=None):
  conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
  h={'Origin':self.server.origin,'Content-Type':'application/x-www-form-urlencoded'};h.update(headers or {})
  conn.request(method,path or self.route,urlencode(fields or {}) if method=='POST' else None,h);r=conn.getresponse();result=(r.status,dict(r.getheaders()),r.read().decode());conn.close();return result
 def post(self,suffix,fields,**kw):return self.request('POST',self.route+suffix,{'token':self.token,**fields},**kw)
 def test_prefilled_private_page(self):
  status,headers,body=self.request();self.assertEqual(status,200);self.assertIn(m.HOST,body);self.assertIn('type="password"',body);self.assertIn('frame-ancestors',headers['Content-Security-Policy']);self.assertEqual(headers['Cache-Control'],'no-store');self.assertNotIn('checked',body);self.assertEqual(self.request(path='/')[0],404)
 def test_exact_origin_csrf_host_and_no_side_effect(self):
  for headers in ({'Origin':'https://evil.test'},{'Host':'evil.test'},{'Sec-Fetch-Site':'cross-site'}):self.assertEqual(self.post('/database',{'password':'secret'},headers=headers)[0],403)
  self.assertEqual(self.request('POST',self.route+'/database',{'token':'wrong','password':'secret'})[0],403);self.assertFalse((self.workspace/'work/private-migration-access').exists())
 def test_secret_escaping_private_modes_and_no_overwrite(self):
  secret='fixture-only-a:b\\c$`?特殊';logs=io.StringIO()
  with contextlib.redirect_stderr(logs):status,_,body=self.post('/database',{'password':secret})
  self.assertEqual(status,200);self.assertNotIn(secret,body+logs.getvalue())
  folder=self.workspace/'work/private-migration-access';self.assertEqual(folder.stat().st_mode&0o777,0o700)
  for f in folder.iterdir():self.assertEqual(f.stat().st_mode&0o777,0o600)
  self.assertIn('a\\:b\\\\c', (folder/'pgpass').read_text());self.assertEqual(hashlib.sha256((folder/'supabase-ca.crt').read_bytes()).hexdigest(),m.CA_HASH)
  before={f.name:f.read_bytes() for f in folder.iterdir()};self.assertEqual(self.post('/database',{'password':'replacement'})[0],400);self.assertEqual(before,{f.name:f.read_bytes() for f in folder.iterdir()})
  self.assertNotIn(secret,self.request()[2])
 def test_reject_symlink_and_control_char(self):
  self.assertEqual(self.post('/database',{'password':'a\nb'})[0],400)
  target=self.workspace/'work/private-migration-access';target.symlink_to(self.workspace/'missing');self.assertEqual(self.post('/database',{'password':'fixture'})[0],400)
 def test_permission_exact_accounts_explicit_and_separate(self):
  fields={'accountA':'A@example.test','accountB':'B@example.test'}
  self.assertEqual(self.post('/permission',fields)[0],400);self.assertEqual(self.post('/permission',{**fields,'confirm':'yes','accountB':'a@example.test'})[0],400)
  self.assertEqual(self.post('/permission',{**fields,'confirm':'yes'})[0],200)
  record=json.loads((self.workspace/'work/private-handoff/controlled-test-approval.json').read_text());self.assertEqual(record['accountEmails'],['a@example.test','b@example.test']);self.assertEqual(record['scope'],m.SCOPE);self.assertFalse(record['applied']);self.assertTrue(record['firstPartyDomainConsentStillRequired']);self.assertFalse((self.workspace/'work/private-migration-access').exists())
  self.assertEqual(self.post('/permission',{**fields,'confirm':'yes'})[0],409)
if __name__=='__main__':unittest.main()
