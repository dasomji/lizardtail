#!/usr/bin/env python3
"""Disposable real systemd/Caddy lifecycle check; no Tailnet or database changes."""
import json, os, pathlib, subprocess, tempfile, urllib.request
repo=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='lt-smoke-') as td:
 root=pathlib.Path(td)
 env={**os.environ,'LIZARDTAIL_STATE_DIR':td+'/state','LIZARDTAIL_HOST_CONFIG':td+'/host.json'}
 (root/'host.json').write_text(json.dumps({'exposure':'none','portMin':23000,'portMax':23999,'caddy':os.path.expanduser('~/.local/bin/caddy')}))
 (root/'server.mjs').write_text("import http from 'node:http';http.createServer((q,r)=>r.end(process.env.ROLE+':'+process.env.LIZARDTAIL_INSTANCE)).listen(Number(process.env.PORT),'127.0.0.1');")
 svc=lambda role:{'command':['node','server.mjs'],'port':True,'env':{'PORT':'${port.'+role+'}','ROLE':role},'ready':{'path':'/'}}
 p={'version':1,'project':'smoke','services':{'api':svc('api'),'web':{**svc('web'),'dependsOn':['api']}},'endpoints':{'app':{'routes':[{'path':'/api/*','service':'api','stripPrefix':True},{'path':'/','service':'web'}]}}}
 (root/'lizardtail.project.json').write_text(json.dumps(p))
 def cli(*args):
  x=subprocess.run(['node',str(repo/'dist/index.js'),*args],cwd=root,env=env,text=True,capture_output=True,timeout=90)
  if x.returncode:raise RuntimeError(x.stderr+x.stdout)
  return json.loads(x.stdout) if x.stdout.strip() else None
 def get(url):return urllib.request.urlopen(url,timeout=3).read().decode()
 try:
  a=cli('up','--instance','one'); b=cli('up','--instance','two')
  assert get(a['urls']['app'])=='web:one'
  assert get(a['urls']['app']+'/api/test')=='api:one'
  assert get(b['urls']['app'])=='web:two'
  same=cli('up','--instance','one');assert same['urls']==a['urls']
  cli('down','--instance','one');assert get(b['urls']['app'])=='web:two'
  try:get(a['urls']['app'])
  except OSError:pass
  else:raise AssertionError('stopped instance still serves')
  resumed=cli('up','--instance','one');assert resumed['urls']==a['urls'];assert get(a['urls']['app'])=='web:one'
  print('PASS: two independent instances, API routing, idempotent up, independent stop, stable resume')
 finally:
  for n in ['one','two']:
   try:cli('down','--instance',n)
   except Exception as e:print('Cleanup:',e)
