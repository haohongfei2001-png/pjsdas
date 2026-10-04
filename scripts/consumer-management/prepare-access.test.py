import contextlib, http.client, importlib.util, io, shutil, subprocess, sys, tempfile, threading, unittest
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
  status,headers,body=self.request();self.assertEqual(status,200);self.assertIn('开发测试由执行方完成',body);self.assertNotIn('<form',body);self.assertNotIn('<input',body);self.assertIn("form-action 'none'",headers['Content-Security-Policy']);self.assertEqual(headers['Cache-Control'],'no-store');self.assertEqual(self.request(path='/')[0],404)
 def test_exact_origin_csrf_host_and_no_side_effect(self):
  for headers in ({'Origin':'https://evil.test'},{'Host':'evil.test'},{'Sec-Fetch-Site':'cross-site'}):self.assertEqual(self.post('/database',{'password':'secret'},headers=headers)[0],403)
  self.assertFalse((self.workspace/'work/private-migration-access').exists())
 def test_password_collection_is_retired(self):
  secret='fixture-only-do-not-collect';logs=io.StringIO()
  with contextlib.redirect_stderr(logs):status,_,body=self.post('/database',{'password':secret})
  self.assertEqual(status,410);self.assertNotIn(secret,body+logs.getvalue());self.assertFalse((self.workspace/'work/private-migration-access').exists())
 def test_stale_test_account_form_cannot_collect_or_authorize(self):
  fields={'accountA':'A@example.test','accountB':'B@example.test','confirm':'yes'}
  logs=io.StringIO()
  with contextlib.redirect_stderr(logs):status,_,body=self.post('/permission',fields)
  self.assertEqual(status,410);self.assertNotIn(fields['accountA'],body+logs.getvalue());self.assertFalse((self.workspace/'work/private-handoff').exists())
 def test_direct_invocation_uses_checkout_not_ancestor_or_cwd(self):
  checkout=self.workspace/'checkout';script=checkout/'scripts/consumer-management/prepare-access.py';script.parent.mkdir(parents=True);shutil.copyfile(Path(m.__file__),script)
  process=subprocess.Popen([sys.executable,str(script)],cwd=self.workspace,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   url=process.stdout.readline().strip();self.assertTrue(url.startswith('http://127.0.0.1:'));self.assertTrue((checkout/'work').is_dir());self.assertFalse((self.workspace/'private-handoff').exists())
  finally:
   process.terminate();process.communicate(timeout=5)
if __name__=='__main__':unittest.main()
