#!/usr/bin/env python3
"""Real git/SQLite/systemd cleanup lifecycle with mocked GitHub metadata."""
import json,os,pathlib,sqlite3,subprocess,tempfile
repo=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='lt-finish-') as td:
 t=pathlib.Path(td);main=t/'main';feature=t/'feature';remote=t/'remote.git';merger=t/'merger';bindir=t/'bin';bindir.mkdir();fail=t/'fail-migration';metadata=t/'pr.json'
 env={**os.environ,'PATH':str(bindir)+':'+os.environ['PATH'],'LIZARDTAIL_STATE_DIR':str(t/'state'),'LIZARDTAIL_HOST_CONFIG':str(t/'host.json')}
 (t/'host.json').write_text(json.dumps({'exposure':'none','portMin':26000,'portMax':26999,'caddy':os.path.expanduser('~/.local/bin/caddy')}))
 def run(cmd,cwd=None,ok=True):
  p=subprocess.run(cmd,cwd=cwd,env=env,text=True,capture_output=True,timeout=120)
  if ok and p.returncode:raise RuntimeError(p.stderr+p.stdout)
  return p
 def git(*args,cwd=main):return run(['git',*args],cwd).stdout.strip()
 def cli(command,root=main,instance='main',ok=True):
  p=run(['node',str(repo/'dist/index.js'),*command,'--project-dir',str(root),'--instance',instance],ok=ok)
  return p
 main.mkdir();git('init','-b','main');git('config','user.name','Lizardtail test');git('config','user.email','lizardtail-test@example.invalid')
 db=sqlite3.connect(main/'source.sqlite');db.execute('CREATE TABLE sample (value text)');db.execute("INSERT INTO sample VALUES ('main-data')");db.commit();db.close()
 (main/'server.cjs').write_text("require('http').createServer((q,r)=>r.end('ready')).listen(Number(process.env.PORT),'127.0.0.1')")
 manifest={'version':1,'project':'finish-smoke','database':{'kind':'sqlite','source':'source.sqlite','migrate':['python3','-c',f'import pathlib,sys;sys.exit(1 if pathlib.Path({str(fail)!r}).exists() else 0)']},'services':{'web':{'command':['node','server.cjs'],'port':True,'env':{'PORT':'${port.web}'}}},'endpoints':{'app':{'routes':[{'path':'/','service':'web'}]}}}
 (main/'lizardtail.project.json').write_text(json.dumps(manifest));git('add','.');git('commit','-m','fixture');git('clone','--bare',str(main),str(remote),cwd=t);git('remote','add','origin',str(remote));git('worktree','add','-b','feature',str(feature));(feature/'change.txt').write_text('merged feature');git('add','change.txt',cwd=feature);git('commit','-m','feature',cwd=feature);head=git('rev-parse','HEAD',cwd=feature)
 gh=bindir/'gh';gh.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nprint(json.dumps({"defaultBranchRef":{"name":"main"}}) if sys.argv[1]=="repo" else Path('+repr(str(metadata))+').read_text())\n');gh.chmod(0o755)
 def meta(state,merge=''):metadata.write_text(json.dumps({'state':state,'headRefOid':head,'baseRefName':'main','mergeCommit':{'oid':merge},'url':'https://example.invalid/pull/1'}))
 try:
  cli(['up']);cli(['up'],feature,'feature');reg=json.loads((t/'state/registry.json').read_text())['instances'];mp=next(p for p in reg.values()if p['instance']=='main');fp=next(p for p in reg.values()if p['instance']=='feature');fdb=pathlib.Path(fp['dir'])/'database.sqlite'
  c=sqlite3.connect(fdb);c.execute("UPDATE sample SET value='feature-data'");c.commit();c.close()
  meta('OPEN');assert cli(['finish','--pr','1'],feature,'feature',False).returncode!=0;assert fdb.exists()
  git('worktree','add','-b','integrate',str(merger));git('merge','--no-ff','feature','-m','merged',cwd=merger);merge=git('rev-parse','HEAD',cwd=merger);git('push','origin','HEAD:main',cwd=merger);meta('MERGED',merge)
  original=git('rev-parse','HEAD');pid=run(['systemctl','--user','show',mp['unit'],'--property=MainPID','--value']).stdout.strip()
  git('commit','--allow-empty','-m','local divergence');result=cli(['finish','--pr','1'],feature,'feature',False)
  assert result.returncode!=0 and 'cannot fast-forward' in result.stderr
  assert run(['systemctl','--user','show',mp['unit'],'--property=MainPID','--value']).stdout.strip()==pid and pid!='0';assert fdb.exists()
  git('branch','-m','main','saved-divergent-main');git('switch','-c','main',original)
  fail.touch();assert cli(['finish','--pr','1'],feature,'feature',False).returncode!=0;assert fdb.exists();assert list(pathlib.Path(mp['dir']).glob('backup-*.sqlite'))
  fail.unlink();cli(['finish','--pr','1'],feature,'feature');assert not fdb.exists();assert json.loads((pathlib.Path(fp['dir'])/'finish.json').read_text())['stage']=='cleaned'
  c=sqlite3.connect(pathlib.Path(mp['dir'])/'database.sqlite');assert c.execute('SELECT value FROM sample').fetchone()[0]=='main-data';c.close();assert cli(['up'],feature,'feature',False).returncode!=0
  print('PASS: divergent main keeps preview running; unmerged cleanup refused, failed main migration preserves feature data + backup, merged cleanup removes feature only, main rows retained, finished instance cannot restart')
 finally:
  for root,instance in [(feature,'feature'),(main,'main')]:cli(['down'],root,instance,False)
