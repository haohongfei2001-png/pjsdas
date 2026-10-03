#!/usr/bin/env python3
"""Private loopback handoff. Stores user input; never executes SQL or changes access."""
import argparse, json, os, re, secrets, threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
PROJECT='yyrzwpoxlxpafdlbkdtg'
HOST=f'db.{PROJECT}.supabase.co'
CA_HASH='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7'
SCOPE={'accounts':'exactly-two-user-controlled-dedicated-identities','domain':'business-v7','client':'verified-existing-TodayAction-client-only','flags':['PJSDAS_CONSUMER_ONBOARDING','PJSDAS_CONSUMER_SCOPED_MANAGEMENT'],'audience':'allowlist-beta-for-these-two-only','otherUsersChanged':False,'backendConsentInsertion':False,'oauthChanges':False,'publicPublishing':False,'newPaidServices':False}
STYLE='''*{box-sizing:border-box}body{margin:0;background:#f3f5f6;color:#182a32;font:16px/1.65 system-ui,sans-serif}main{max-width:830px;margin:auto;padding:36px 20px 64px}h1{font-size:30px;line-height:1.3;margin:8px 0 14px}h2{font-size:21px;margin-top:0}.tag{color:#24594b;font-size:13px;font-weight:700;letter-spacing:.1em}section{background:white;padding:25px;margin:22px 0;border-radius:16px;border:1px solid #dbe3e5}.muted,small{color:#4e656e}.row{display:flex;gap:12px;flex-wrap:wrap}a{color:#1b6350}a.button,button{display:inline-block;background:#235e50;color:white;border:0;border-radius:8px;padding:12px 18px;font-size:15px;text-decoration:none;cursor:pointer}a.secondary{background:#e8efed;color:#224b40}label{display:block;margin:12px 0 5px}input[type=password],input[type=email]{width:100%;padding:12px;border:1px solid #94aaa4;border-radius:8px;font:inherit}input[type=checkbox]{width:19px;height:19px;vertical-align:middle;flex-shrink:0}.check{display:flex;gap:10px;align-items:flex-start;margin:18px 0}.notice{padding:13px 16px;background:#eef5f1;border-left:3px solid #377a61;border-radius:4px}button:disabled{opacity:.5;cursor:default}code{font-size:13px;overflow-wrap:anywhere}details{margin-top:18px}#result{white-space:pre-line;min-height:26px}*:focus-visible{outline:3px solid #50a587;outline-offset:3px}@media(max-width:480px){main{padding:22px 14px}section{padding:19px}h1{font-size:26px}.row a{width:100%;text-align:center}}'''
SCRIPT='''document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;const result=document.getElementById('result');result.textContent='正在安全保存…';try{const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form)),credentials:'omit',redirect:'error'});const data=await response.json();result.textContent=data.message;if(response.ok){form.reset();if(form.dataset.kind==='database')form.hidden=true;}else button.disabled=false;}catch{result.textContent='未确认保存成功。请返回任务让我检查，不要重复输入或发送密码。';}finally{form.querySelectorAll('input[type=password]').forEach(x=>x.value='');}}));'''
def private_dir(path):
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    s=path.lstat()
    if path.is_symlink() or s.st_uid!=os.getuid() or s.st_mode&0o077: raise ValueError('PRIVATE_DIRECTORY_INVALID')
def write_private(path,text):
    with path.open('x',encoding='utf8') as f:
        os.chmod(path,0o600);f.write(text);f.flush();os.fsync(f.fileno())
def save_permission(workspace,fields):
    if fields.get('confirm')!='yes': raise ValueError('CONSENT_REQUIRED')
    emails=[fields.get('accountA','').strip().lower(),fields.get('accountB','').strip().lower()]
    if len(set(emails))!=2 or any(len(x)>254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',x) for x in emails): raise ValueError('TWO_DISTINCT_EMAILS_REQUIRED')
    folder=workspace/'work/private-handoff';private_dir(folder)
    record={'project':PROJECT,'accountEmails':emails,'scope':SCOPE,'confirmedAt':datetime.now(timezone.utc).isoformat(),'source':'explicit-user-submit-on-private-preparation-page','applied':False,'requiresServerIdentityAndOriginalClientVerification':True,'firstPartyDomainConsentStillRequired':True}
    write_private(folder/'controlled-test-approval.json',json.dumps(record,ensure_ascii=False,indent=2)+'\n')
def make_server(workspace,port=0,existing_token=None):
    token=existing_token or secrets.token_urlsafe(32);route='/prepare/'+token
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def setup(self): super().setup();self.connection.settimeout(5)
        def send(self,status,body,kind='application/json'):
            data=body.encode();self.send_response(status);self.send_header('Content-Type',kind+'; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY');self.send_header('Content-Security-Policy',f"default-src 'none'; script-src 'nonce-{token}'; style-src 'nonce-{token}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");self.end_headers();self.wfile.write(data)
        def trusted(self): return self.headers.get('Host')==self.server.host_header
        def do_GET(self):
            if not self.trusted() or self.path!=route:return self.send(404,'{}')
            configured=(workspace/'work/private-migration-access/pg_service.conf').exists()
            approved=(workspace/'work/private-handoff/controlled-test-approval.json').exists()
            database='<p class="notice">不需要你提供或找回数据库密码。执行方已核查现有部署和管理连接，正在准备限定原项目的短期维护授权；尚未生成任何凭据。</p><p>数据库维护由执行方负责：先备份、实际隔离恢复、核验权限，再按原批准范围升级。密码不重置，不购买服务。</p><p><a class="button secondary" target="_blank" rel="noreferrer noopener" href="https://supabase.com/dashboard/account/tokens">查看原账号维护授权草稿</a></p><small>这里只提供第一方入口。具体范围预填并审阅后，由你确认新增访问；不要复制或发送任何密钥。</small>'
            approval='<p class="notice">本次具体测试许可已记录，尚未执行。账号与原插件仍须核实。</p>' if approved else f'''<form action="{route}/permission" data-kind="permission" method="post"><input type="hidden" name="token" value="{token}"><label for="a">专用测试账号 A 的登录邮箱</label><input id="a" name="accountA" type="email" autocomplete="off" required><label for="b">专用测试账号 B 的登录邮箱</label><input id="b" name="accountB" type="email" autocomplete="off" required><label class="check"><input name="confirm" type="checkbox" value="yes" required><span>我控制上述两个专用测试身份，允许仅为这两个账号和核实后的原 TodayAction 插件开启业务 v7 受控测试准入及必要开关。其他用户不变；本人分别登录并确认领域授权。</span></label><button>确认这项具体测试范围</button></form>'''
            content=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TodayAction · 本人准备</title><style nonce="{token}">{STYLE}</style><main><div class="tag">TODAYACTION · 受控测试</div><h1>只完成必须由你本人完成的准备</h1><p class="muted">项目、地址、证书和测试范围已准备。无需 SQL、参数或截图。</p><p class="notice">尚未开放普通用户使用。生产迁移 0/8；备份恢复通过后才升级。此页仅收取必要输入，不修改线上。</p><section><h2>1 · 数据库维护由执行方完成</h2><p>已核对原项目 <strong>pjsdas-auth</strong>，无需你处理连接配置。</p>{database}<details><summary>已填好的连接信息</summary><p><code>{PROJECT}</code><br><code>{HOST}:5432 / postgres</code><br>证书与主机名校验保持开启；沿用现有本机网络代理。</p></details></section><section><h2>2 · 使用原插件所属账号登录</h2><p>在宿主选中<strong>已有 TodayAction 开发版</strong>。如果看不到原插件，先核对登录账号，不要创建替代插件。</p><div class="row"><a class="button" target="_blank" rel="noreferrer noopener" href="https://chatgpt.com/plugins">打开插件入口</a><a class="button secondary" target="_blank" rel="noreferrer noopener" href="https://supabase.com/dashboard/project/{PROJECT}?showConnect=true&amp;method=session">打开原数据库项目</a></div><small>这是宿主插件入口；原插件的专属安装链接仍待后台核实，不能把这一步标作安装通过。</small></section><section><h2>3 · 一次确认受控测试范围</h2><p>使用两个专用身份验证账号隔离，不挪用现有 owner 的真实工作区。此确认不直接授予业务权限；具体业务授权仍在原网站由本人确认。</p>{approval}<p class="muted">仅业务 v7；不开放公众，不更改 OAuth，不启用其他领域，不新增费用。账号尚未注册时，本人完成注册和相应条款确认。</p></section><p id="result" role="status" aria-live="polite"></p><p class="muted">提交后回到对话告诉我“已完成本人准备”即可。接下来由我检查、备份恢复、逐项升级并完成原插件实测。</p></main><script nonce="{token}">{SCRIPT}</script></html>'''
            self.send(200,content,'text/html')
        def do_POST(self):
            if not self.trusted() or self.headers.get('Origin')!=self.server.origin or self.headers.get('Sec-Fetch-Site') not in (None,'same-origin') or self.headers.get('Content-Type','').split(';')[0]!='application/x-www-form-urlencoded':return self.send(403,'{"message":"请求来源不符，未保存。"}')
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=16384:raise ValueError('SIZE')
                data=parse_qs(self.rfile.read(size).decode('utf8'),keep_blank_values=True,strict_parsing=True)
                if any(len(v)!=1 for v in data.values()):raise ValueError('DUPLICATE')
                fields={k:v[0] for k,v in data.items()}
                if not secrets.compare_digest(fields.get('token',''),token):return self.send(403,'{"message":"页面已失效，未保存。"}')
                with self.server.write_lock:
                    if self.path==route+'/database':return self.send(410,'{"message":"数据库密码录入已停用。不需要提供或重置密码。"}')
                    elif self.path==route+'/permission' and set(fields)=={'token','accountA','accountB','confirm'}:save_permission(workspace,fields)
                    else:raise ValueError('INVALID_FORM')
                self.send(200,'{"message":"已安全记录。未执行线上迁移或授权。请回到对话告知已完成本人准备。"}')
            except FileExistsError:self.send(409,'{"message":"已有记录，未覆盖。请返回任务让我检查。"}')
            except (ValueError,OSError,UnicodeError):self.send(400,'{"message":"未保存。请检查必填内容；已有配置不会覆盖，密码和输入不会回显。"}')
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True;server.write_lock=threading.Lock();server.host_header=f'127.0.0.1:{server.server_port}';server.origin='http://'+server.host_header
    return server,server.origin+route,token
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',type=Path,default=Path(__file__).resolve().parents[4]);parser.add_argument('--resume-page',type=Path);args=parser.parse_args();os.umask(0o077)
    workspace=args.workspace.resolve();(workspace/'work').mkdir(exist_ok=True)
    page=json.loads(args.resume_page.read_text()) if args.resume_page else {}
    server,url,_=make_server(workspace,page.get("port",0),page.get("token"))
    print(url,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
