#!/usr/bin/env python3
"""Read-only loopback delivery status. Never collects credentials or test identities."""
import argparse, json, os, secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
PROJECT='yyrzwpoxlxpafdlbkdtg'
STYLE='''*{box-sizing:border-box}body{margin:0;background:#f3f5f6;color:#182a32;font:16px/1.65 system-ui,sans-serif}main{max-width:830px;margin:auto;padding:36px 20px 64px}h1{font-size:30px;line-height:1.3;margin:8px 0 14px}h2{font-size:21px;margin-top:0}.tag{color:#24594b;font-size:13px;font-weight:700;letter-spacing:.1em}section{background:white;padding:25px;margin:22px 0;border-radius:16px;border:1px solid #dbe3e5}.muted,small{color:#4e656e}.row{display:flex;gap:12px;flex-wrap:wrap}a{color:#1b6350}a.button,button{display:inline-block;background:#235e50;color:white;border:0;border-radius:8px;padding:12px 18px;font-size:15px;text-decoration:none;cursor:pointer}a.secondary{background:#e8efed;color:#224b40}label{display:block;margin:12px 0 5px}input[type=password],input[type=email]{width:100%;padding:12px;border:1px solid #94aaa4;border-radius:8px;font:inherit}input[type=checkbox]{width:19px;height:19px;vertical-align:middle;flex-shrink:0}.check{display:flex;gap:10px;align-items:flex-start;margin:18px 0}.notice{padding:13px 16px;background:#eef5f1;border-left:3px solid #377a61;border-radius:4px}button:disabled{opacity:.5;cursor:default}code{font-size:13px;overflow-wrap:anywhere}details{margin-top:18px}#result{white-space:pre-line;min-height:26px}*:focus-visible{outline:3px solid #50a587;outline-offset:3px}@media(max-width:480px){main{padding:22px 14px}section{padding:19px}h1{font-size:26px}.row a{width:100%;text-align:center}}'''
def maintenance_completed(workspace):
    try:
        execution=json.loads((workspace/'outputs/production-eight-migration-execution.json').read_text())
        cleanup=json.loads((workspace/'outputs/temporary-maintenance-cleanup.json').read_text())
        return execution.get('project')==PROJECT and execution.get('stage')=='complete' and execution.get('productionMigrationsApplied')==8 and execution.get('failure') is None and cleanup.get('productionMigrationsApplied')==8 and cleanup.get('oldTokenRejectedHttpStatus')==401 and cleanup.get('localAccessCredentialFilesRemoved') is True and cleanup.get('permissionsRemainingFromThisSession') is False
    except (OSError,ValueError):return False

def make_server(workspace,port=0,existing_token=None):
    token=existing_token or secrets.token_urlsafe(32);route='/prepare/'+token
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def setup(self): super().setup();self.connection.settimeout(5)
        def send(self,status,body,kind='application/json'):
            data=body.encode();self.send_response(status);self.send_header('Content-Type',kind+'; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY');self.send_header('Content-Security-Policy',f"default-src 'none'; script-src 'none'; style-src 'nonce-{token}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");self.end_headers();self.wfile.write(data)
        def trusted(self): return self.headers.get('Host')==self.server.host_header
        def do_GET(self):
            if not self.trusted() or self.path!=route:return self.send(404,'{}')
            completed=maintenance_completed(workspace)
            maintenance_notice='生产迁移 8/8 已完成；实际备份恢复与临时授权清理均已核验。' if completed else '数据库维护由执行方负责；备份恢复通过后才升级，进度以最新核验记录为准。'
            database='<p class="notice">生产八项迁移已完成，真实备份已恢复验证，临时维护授权及凭据已撤销清理。</p><p>不需要你提供数据库密码、连接串或 SQL。现有数据和权限已回读验证；消费级功能仍关闭。</p>' if completed else '<p class="notice">不需要你提供或找回数据库密码。数据库备份、恢复验证和升级由执行方处理。</p><p>请以对话中的最新核验结果为准。不要生成或复制任何密钥。</p>'
            content=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TodayAction · 安装准备进度</title><style nonce="{token}">{STYLE}</style><main><div class="tag">TODAYACTION · 安装准备</div><h1>安装、登录、授权后使用</h1><p class="muted">开发测试由执行方完成。你无需准备测试邮箱、切换账号、查 UUID 或操作数据库。</p><p class="notice">普通用户商店安装仍待完成。{maintenance_notice}</p><section><h2>当前可用入口</h2><p>这是原账号持有的 TodayAction 开发版，尚不是公开商店安装入口。仅查看此页不会连接账号、授予权限或修改数据。</p><div class="row"><a class="button" target="_blank" rel="noreferrer noopener" href="https://chatgpt.com/plugins/plugin_asdk_app_6abfbe4dea888191ad2c6a28af430d32?directoryTab=personal">查看原插件</a><a class="button secondary" target="_blank" rel="noreferrer noopener" href="https://todayaction.com/?scoped_access=1">查看或撤回已有授权</a></div><p class="muted">原插件后台须使用原所属账号；不新建替代插件。</p></section><section><h2>数据库维护已交由开发侧</h2>{database}</section><section><h2>开发侧正在完成</h2><p>处理剩余审查问题，验证两个独立合成身份之间的隔离、重复请求、撤销和撤权；核对原插件的登录与工具目录，准备商店资料及演示。</p><p>测试不使用你的真实资料。代码和隔离环境测试通过，不等于真实宿主安装已经通过；真实安装结果将单独记录。</p></section><section><h2>只在必须本人处理时交给你</h2><p>发布者身份核验与必要登录、自己的数据授权，以及真实公开名称、联系方式、保留规则和最终发布确认。</p><p class="muted">如现有测试资源不足，我会先准备具体执行范围，再一次说明最小授权缺口。不会要求你准备两个邮箱或代跑验收。此页不接收任何密码、账号信息或权限确认。</p></section></main></html>'''
            self.send(200,content,'text/html')
        def do_POST(self):
            if not self.trusted() or self.headers.get('Origin')!=self.server.origin or self.headers.get('Sec-Fetch-Site') not in (None,'same-origin'):
                return self.send(403,'{"message":"请求来源不符，未保存。"}')
            # Stale tabs must not revive the retired credential or A/B approval flow.
            # Never read, echo or persist the submitted body.
            if self.path in (route+'/database',route+'/permission'):
                return self.send(410,'{"message":"录入已停用。开发侧负责数据库维护与测试；未读取或保存提交内容。"}')
            self.send(404,'{}')
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True;server.host_header=f'127.0.0.1:{server.server_port}';server.origin='http://'+server.host_header
    return server,server.origin+route,token
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',type=Path,default=Path(__file__).resolve().parents[2]);parser.add_argument('--resume-page',type=Path);args=parser.parse_args();os.umask(0o077)
    workspace=args.workspace.resolve();(workspace/'work').mkdir(exist_ok=True)
    page=json.loads(args.resume_page.read_text()) if args.resume_page else {}
    server,url,_=make_server(workspace,page.get("port",0),page.get("token"))
    print(url,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
